import { readdir, readFile, mkdir, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compileProject, checkProject, createCompiler, CompileError } from './compiler.js';
import { attachDeclarationMaps } from './source-maps.js';
import { parseCatalogSnapshot } from './catalog-input.js';
import { locateCompileError, locateDiagnostics, invalidJson } from './catalog-diagnostics.js';
const marker = '.fasti18n-manifest.json';
const generatedPath = /^(?:package\.json|(?:scopes\/[A-Za-z][A-Za-z0-9_-]*\/)?(?:messages\.d\.ts(?:\.map)?|types\/\d+\.d\.ts(?:\.map)?|index\.(?:js|d\.ts)|locales\/[A-Za-z0-9-]+\.(?:js|d\.ts)))$/;
const isMissing = (e) => e.code === 'ENOENT';
async function fileStamp(file) {
    try {
        const stat = await lstat(file, { bigint: true });
        return { regular: stat.isFile(), stamp: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') };
    }
    catch (error) {
        if (isMissing(error))
            return;
        throw error;
    }
}
async function readOptional(file) {
    try {
        return await readFile(file, 'utf8');
    }
    catch (error) {
        if (isMissing(error))
            return;
        throw error;
    }
}
async function atomicWrite(file, content) {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, content);
        await rename(temporary, file);
    }
    finally {
        await unlink(temporary).catch(error => { if (!isMissing(error))
            throw error; });
    }
}
/** Write compiler-owned files, preserving unrelated files and unchanged mtimes. */
export async function writeProject(project, directory) {
    return writeOutput(project, directory);
}
async function writeOutput(project, directory, cache) {
    const outDir = resolve(directory);
    const previousText = await readOptional(resolve(outDir, marker));
    let previous = [];
    if (previousText) {
        const manifest = JSON.parse(previousText);
        if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.some(file => typeof file !== 'string' || !generatedPath.test(file)))
            throw new Error(`Invalid fasti18n ownership manifest in ${outDir}`);
        previous = manifest.files;
    }
    const names = Object.keys(project.files).sort();
    const owned = new Set(previous);
    const stamps = new Map();
    if (names.some(name => !generatedPath.test(name)))
        throw new Error('Compiled project contains an unsafe output path');
    // Preflight every destination before touching existing output.
    for (const name of names) {
        const file = resolve(outDir, name);
        const state = await fileStamp(file);
        if (state && (!state.regular || !owned.has(name)))
            throw new Error(`Refusing to overwrite unowned output: ${file}. Choose an empty outDir.`);
        if (state)
            stamps.set(name, state.stamp);
    }
    const changed = [];
    const nextCache = new Map();
    for (const name of names) {
        const file = resolve(outDir, name);
        const content = project.files[name];
        const cached = cache?.get(name);
        if (cached?.content === content && cached.stamp === stamps.get(name)) {
            nextCache.set(name, cached);
            continue;
        }
        if (await readOptional(file) !== content) {
            await atomicWrite(file, content);
            changed.push(file);
            if (cache)
                stamps.set(name, (await fileStamp(file)).stamp);
        }
        if (cache)
            nextCache.set(name, { content, stamp: stamps.get(name) });
    }
    for (const stale of previous.filter(name => !Object.hasOwn(project.files, name))) {
        const file = resolve(outDir, stale);
        await unlink(file).catch(error => { if (!isMissing(error))
            throw error; });
        changed.push(file);
    }
    const manifest = JSON.stringify({ version: 1, files: names }, null, 2) + '\n';
    if (manifest !== previousText)
        await atomicWrite(resolve(outDir, marker), manifest);
    if (cache) {
        cache.clear();
        for (const [name, entry] of nextCache)
            cache.set(name, entry);
    }
    return changed;
}
export async function generate(options, read = file => readFile(file, 'utf8')) {
    return generateProject(options, read, compileProject);
}
/** Read and validate catalogs. Does not create, inspect or update generated output. */
export async function check(options, read = file => readFile(file, 'utf8')) {
    const input = resolve(options.root ?? '.', options.catalogs ?? 'messages');
    let catalogFiles;
    try {
        catalogFiles = (await readdir(input, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => resolve(input, entry.name)).sort();
    }
    catch (error) {
        return { ok: false, errors: [{ code: 'CATALOG_READ_ERROR', message: error.message, file: input }], warnings: [], locales: [], messageCount: 0, catalogFiles: [] };
    }
    const catalogs = Object.create(null);
    const sources = new Map();
    const errors = [];
    const locales = [];
    for (const file of catalogFiles) {
        const locale = file.slice(input.length + 1, -5);
        locales.push(locale);
        let text;
        try {
            text = await read(file);
        }
        catch (error) {
            errors.push({ code: 'CATALOG_READ_ERROR', message: error.message, locale, file });
            continue;
        }
        try {
            catalogs[locale] = JSON.parse(text);
            sources.set(locale, { file, text });
        }
        catch (error) {
            errors.push(...invalidJson(error, locale, { file, text }).diagnostics);
        }
    }
    const result = checkProject({ ...options, catalogs });
    // A base file that could not be read/parsed is already explained by its load error.
    const baseFailed = errors.some(error => error.locale === options.baseLocale);
    errors.push(...locateDiagnostics(result.errors.filter(error => !baseFailed || error.code !== 'BASE_LOCALE_MISSING'), sources));
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    errors.sort((a, b) => compare(a.locale ?? '', b.locale ?? '') || (a.location?.offset ?? -1) - (b.location?.offset ?? -1) || compare(a.code, b.code));
    return { ...result, ok: errors.length === 0, errors, warnings: locateDiagnostics(result.warnings, sources), locales, catalogFiles };
}
/** An isolated, serialized generation session for watch mode and build plugins.
 * Configuration is captured at creation. Every run rereads source files;
 * output metadata is checked before skipping IO.
 */
export function createGenerator(options, cacheOptions) {
    const config = structuredClone(options);
    const compile = createCompiler(cacheOptions ?? config.cache);
    const output = new Map();
    const declarationMaps = new Map();
    let sources = new Map();
    let compiled;
    let tail = Promise.resolve();
    return (read = file => readFile(file, 'utf8')) => {
        const job = tail.then(async () => {
            const next = new Map();
            let nextCompiled = compiled;
            const result = await generateProject(config, read, input => {
                if (!nextCompiled || next.size !== sources.size || [...next].some(([file, item]) => item !== sources.get(file)))
                    nextCompiled = compile(input);
                // Keep the memoized output private even if callers edit returned metadata.
                return { ...nextCompiled, files: Object.assign(Object.create(null), nextCompiled.files), locales: [...nextCompiled.locales],
                    groups: Object.assign(Object.create(null), Object.fromEntries(Object.entries(nextCompiled.groups).map(([entry, ids]) => [entry, [...ids]]))),
                    warnings: nextCompiled.warnings.map(warning => ({ ...warning })) };
            }, output, (file, text) => {
                const previous = sources.get(file);
                const item = previous?.text === text ? previous : { text, catalog: parseCatalogSnapshot(text) };
                next.set(file, item);
                return item.catalog;
            }, declarationMaps);
            sources = next;
            compiled = nextCompiled;
            return result;
        });
        tail = job.catch(() => undefined);
        return job;
    };
}
async function generateProject(options, read, compile, output, parseCatalog = (_file, text) => JSON.parse(text), declarationMaps) {
    const root = resolve(options.root ?? '.');
    const input = resolve(root, options.catalogs ?? 'messages');
    const outDir = resolve(root, options.outDir ?? 'src/i18n');
    const inputFromOutput = relative(outDir, input);
    if (inputFromOutput === '' || (!inputFromOutput.startsWith('..') && !isAbsolute(inputFromOutput)))
        throw new Error('Catalogs cannot be inside the generated output directory.');
    const catalogFiles = (await readdir(input, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => resolve(input, entry.name)).sort();
    const catalogs = Object.create(null);
    const sources = new Map();
    let source;
    for (const file of catalogFiles) {
        const locale = file.slice(input.length + 1, -5);
        let text;
        try {
            text = await read(file);
        }
        catch (error) {
            throw new CompileError([{ code: 'CATALOG_READ_ERROR', message: error.message, locale, file }]);
        }
        sources.set(locale, { file, text });
        try {
            catalogs[locale] = parseCatalog(file, text);
            if (locale === options.baseLocale)
                source = { file, text };
        }
        catch (error) {
            throw invalidJson(error, locale, { file, text });
        }
    }
    let project;
    try {
        project = compile({ ...options, catalogs });
    }
    catch (error) {
        if (error instanceof CompileError)
            throw locateCompileError(error, sources);
        throw error;
    }
    sources.clear();
    if (source)
        attachDeclarationMaps(project, source, outDir, declarationMaps);
    const changed = await writeOutput(project, outDir, output);
    return { ...project, catalogFiles, changed, outDir };
}
