import { lstat, readFile, readdir, writeFile, rename, unlink, link, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkProject, CompileError } from './compiler.js';
import { invalidJson, locateDiagnostics } from './catalog-diagnostics.js';
import { assertPoText, parsePo, poError, quotePo } from './po.js';
const own = (value, key) => Object.hasOwn(value, key);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function localeName(locale) {
    try {
        if (!locale || Intl.getCanonicalLocales(locale)[0] !== locale)
            throw new Error();
    }
    catch {
        poError('INVALID_LOCALE', `Use a canonical BCP 47 locale, such as en, fr or pt-BR, instead of ${JSON.stringify(locale)}.`);
    }
}
async function fileStamp(file) {
    try {
        const stat = await lstat(file, { bigint: true });
        if (!stat.isFile())
            poError('CATALOG_READ_ERROR', 'Expected a regular catalog file; symbolic links are not supported by translation import/export.', file);
        return { stamp: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'), mode: Number(stat.mode & 511n) };
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
}
async function load(options) {
    localeName(options.baseLocale);
    localeName(options.locale);
    if (options.locale === options.baseLocale)
        poError('PO_BASE_LOCALE', 'Choose a target locale different from the base locale. Edit source messages in the base JSON catalog.');
    const directory = resolve(options.root ?? '.', options.catalogs ?? 'messages');
    const catalogs = Object.create(null);
    const sources = new Map();
    let names;
    try {
        names = (await readdir(directory)).filter(file => file.endsWith('.json')).sort(compare);
    }
    catch (error) {
        poError('CATALOG_READ_ERROR', error.message, directory);
    }
    for (const name of names) {
        const locale = name.slice(0, -5), file = resolve(directory, name);
        const before = await fileStamp(file);
        if (!before)
            poError('CATALOG_CHANGED', 'Catalog changed while reading. Retry the command.', file);
        let text;
        try {
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(file));
        }
        catch (error) {
            poError('CATALOG_READ_ERROR', error.message, file);
        }
        if ((await fileStamp(file))?.stamp !== before.stamp)
            poError('CATALOG_CHANGED', 'Catalog changed while reading. Retry the command.', file);
        sources.set(locale, { file, text, ...before });
        try {
            catalogs[locale] = JSON.parse(text);
        }
        catch (error) {
            throw invalidJson(error, locale, { file, text });
        }
    }
    if (!own(catalogs, options.baseLocale))
        poError('BASE_LOCALE_MISSING', `No catalog for base locale ${JSON.stringify(options.baseLocale)}.`, directory);
    return { directory, catalogs, sources, names };
}
function indexCatalog(catalog, locale) {
    const index = new Map();
    function visit(value, path) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new CompileError([{ code: 'INVALID_CATALOG', message: 'Expected an object containing strings or nested catalogs.', locale, messageId: path.join('.') }]);
        for (const [key, entry] of Object.entries(value)) {
            const next = [...path, key], id = next.join('.');
            if (!key)
                throw new CompileError([{ code: 'INVALID_KEY', message: 'Message keys must not be empty.', locale, messageId: id }]);
            if (typeof entry !== 'string') {
                visit(entry, next);
                continue;
            }
            if (index.has(id))
                throw new CompileError([{ code: 'DUPLICATE_KEY', message: `Nested and flat keys both resolve to ${JSON.stringify(id)}.`, locale, messageId: id }]);
            index.set(id, { text: entry, path: next });
        }
    }
    visit(catalog, []);
    return index;
}
/** Export stable IDs as msgctxt and preserve the entire ICU message in msgid/msgstr. */
export async function exportPo(options) {
    const input = await load(options);
    const checked = checkProject({ ...options, catalogs: input.catalogs, missing: 'fallback' });
    if (!checked.ok)
        throw new CompileError(locateDiagnostics(checked.errors, input.sources));
    const base = indexCatalog(input.catalogs[options.baseLocale], options.baseLocale);
    const target = indexCatalog(input.catalogs[options.locale] ?? {}, options.locale);
    const lines = [
        '# ICU MessageFormat: translate text; retain argument and rich-text slot names.',
        '# msgctxt is a stable message ID. Do not change it.',
        '# An empty msgstr is untranslated. Add #. fasti18n:empty for intentional empty text.',
        'msgid ""', 'msgstr ""',
        ...[`Language: ${options.locale}\n`, 'MIME-Version: 1.0\n', 'Content-Type: text/plain; charset=UTF-8\n', 'Content-Transfer-Encoding: 8bit\n', 'X-Fasti18n-Format: 1\n', `X-Source-Language: ${options.baseLocale}\n`].map(quotePo),
    ];
    for (const [id, source] of [...base].sort(([a], [b]) => compare(a, b))) {
        const translation = target.get(id);
        for (const text of [id, source.text, translation?.text ?? ''])
            assertPoText(text, { locale: options.locale, messageId: id });
        lines.push('');
        if (translation?.text === '')
            lines.push('#. fasti18n:empty');
        lines.push(`msgctxt ${quotePo(id)}`, `msgid ${quotePo(source.text)}`, `msgstr ${quotePo(translation?.text ?? '')}`);
    }
    return { po: lines.join('\n') + '\n', locale: options.locale, messageCount: base.size, translatedCount: target.size };
}
function setMessage(catalog, id, path, text) {
    // Prefer the existing target path, then the base layout. A conflicting parent
    // string can coexist with a new flat dotted key without changing old entries.
    let node = catalog;
    let usable = true;
    for (const key of path.slice(0, -1)) {
        if (!own(node, key))
            break;
        if (typeof node[key] === 'string') {
            usable = false;
            break;
        }
        node = node[key];
    }
    // Preflight the complete existing path before creating any new containers.
    node = catalog;
    if (usable)
        for (let i = 0; i < path.length; i++) {
            const key = path[i];
            if (!own(node, key))
                break;
            if (i === path.length - 1) {
                if (typeof node[key] !== 'string')
                    usable = false;
            }
            else
                node = node[key];
        }
    if (!usable)
        path = [id];
    node = catalog;
    for (const key of path.slice(0, -1)) {
        if (!own(node, key))
            Object.defineProperty(node, key, { value: Object.create(null), enumerable: true, configurable: true, writable: true });
        node = node[key];
    }
    const key = path.at(-1);
    if (own(node, key) && typeof node[key] !== 'string')
        poError('CATALOG_LAYOUT_CONFLICT', `Adding ${JSON.stringify(id)} would replace a nested catalog. Convert that subtree to flat dotted keys, then retry.`, undefined, undefined, id);
    Object.defineProperty(node, key, { value: text, enumerable: true, configurable: true, writable: true });
}
/** Merge reviewed translations, validate the entire proposed project, then atomically replace one catalog. */
export async function importPo(options) {
    const input = await load(options);
    const from = resolve(options.root ?? '.', options.from);
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(from));
    }
    catch (error) {
        poError('PO_READ_ERROR', `Cannot read UTF-8 PO input: ${error.message}`, from);
    }
    const po = parsePo(text, from);
    const language = po.headers.get('language');
    if (language !== options.locale)
        poError('PO_LOCALE_MISMATCH', `PO Language is ${JSON.stringify(language ?? '')}; expected ${JSON.stringify(options.locale)}.`, from);
    if (!/^text\/plain\s*;\s*charset\s*=\s*"?utf-8"?\s*$/i.test(po.headers.get('content-type') ?? ''))
        poError('PO_ENCODING', 'PO Content-Type must declare text/plain; charset=UTF-8.', from);
    const version = po.headers.get('x-fasti18n-format');
    if (version !== undefined && version !== '1')
        poError('PO_VERSION', `Unsupported PO transport version ${JSON.stringify(version)}.`, from);
    const baseLocale = po.headers.get('x-source-language');
    if (baseLocale !== undefined && baseLocale !== options.baseLocale)
        poError('PO_BASE_LOCALE', 'PO source language does not match the project base locale.', from);
    const base = indexCatalog(input.catalogs[options.baseLocale], options.baseLocale);
    const target = input.catalogs[options.locale] ?? Object.create(null);
    const targetIndex = indexCatalog(target, options.locale);
    const result = { locale: options.locale, catalogFile: resolve(input.directory, options.locale + '.json'), written: false, dryRun: !!options.dryRun, added: [], updated: [], unchanged: 0, skipped: { fuzzy: 0, untranslated: 0, obsolete: po.obsolete }, warnings: [] };
    const accepted = new Map();
    const offsets = [0];
    for (let i = 0; i < text.length; i++)
        if (text[i] === '\n')
            offsets.push(i + 1);
    const entryError = (code, message, id, line) => { throw new CompileError([{ code, message, locale: options.locale, messageId: id, file: from, location: { line, column: 1, offset: offsets[line - 1] } }]); };
    for (const entry of po.entries) {
        if (entry.fuzzy) {
            result.skipped.fuzzy++;
            continue;
        }
        if (entry.translation === '' && !entry.empty) {
            result.skipped.untranslated++;
            continue;
        }
        const source = base.get(entry.id);
        if (!source)
            entryError('PO_UNKNOWN_ID', 'This message ID is absent from the base catalog. Remove the entry or mark it obsolete.', entry.id, entry.line);
        if (entry.source !== source.text)
            entryError('PO_STALE_SOURCE', 'The source message changed. Export current source text and review this translation before importing.', entry.id, entry.line);
        const existing = targetIndex.get(entry.id);
        if (existing?.text === entry.translation)
            result.unchanged++;
        else {
            (existing ? result.updated : result.added).push(entry.id);
            setMessage(target, entry.id, existing?.path ?? source.path, entry.translation);
        }
        accepted.set(entry.id, entry.line);
    }
    input.catalogs[options.locale] = target;
    const checked = checkProject({ ...options, catalogs: input.catalogs });
    // Edited values have PO coordinates; untouched values keep JSON coordinates.
    const translated = (diagnostic) => {
        const line = diagnostic.locale === options.locale ? accepted.get(diagnostic.messageId ?? '') : undefined;
        return line === undefined ? diagnostic : { ...diagnostic, file: from, location: { line, column: 1, offset: offsets[line - 1] } };
    };
    if (!checked.ok)
        throw new CompileError(locateDiagnostics(checked.errors.map(translated), input.sources));
    result.warnings = locateDiagnostics(checked.warnings, input.sources);
    result.added.sort(compare);
    result.updated.sort(compare);
    if (options.dryRun || !result.added.length && !result.updated.length)
        return result;
    const previous = input.sources.get(options.locale);
    const indentation = previous?.text.match(/\n([ \t]+)"/)?.[1] ?? '  ';
    const eol = previous?.text.includes('\r\n') ? '\r\n' : '\n';
    const output = JSON.stringify(target, null, indentation).replaceAll('\n', eol) + eol;
    const temporary = result.catalogFile + '.' + randomUUID() + '.tmp';
    try {
        await writeFile(temporary, output, { flag: 'wx', mode: previous?.mode ?? 0o666 });
        if (previous)
            await chmod(temporary, previous.mode);
        const names = (await readdir(input.directory)).filter(file => file.endsWith('.json')).sort(compare);
        if (names.join('\0') !== input.names.join('\0'))
            poError('CATALOG_CHANGED', 'Catalog files changed during import. Retry the command.', input.directory);
        for (const snapshot of input.sources.values())
            if ((await fileStamp(snapshot.file))?.stamp !== snapshot.stamp)
                poError('CATALOG_CHANGED', 'Catalog changed during import. Retry the command.', snapshot.file);
        if (previous)
            await rename(temporary, result.catalogFile);
        else
            await link(temporary, result.catalogFile); // An independently created target must never be replaced.
        result.written = true;
    }
    finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT')
            throw error; });
    }
    return result;
}
