#!/usr/bin/env node
import { watch } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { generate, createGenerator, check } from './project.js';
import { configName, readConfig } from './config.js';
import { initialize } from './init.js';
import { CompileError, formatDiagnostic } from './diagnostics.js';
let jsonCheck = false;
let jsonImport = false;
async function main() {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
            config: { type: 'string' },
            catalogs: { type: 'string' },
            'base-locale': { type: 'string' },
            'out-dir': { type: 'string' },
            locale: { type: 'string' },
            from: { type: 'string' },
            out: { type: 'string' },
            'dry-run': { type: 'boolean' },
            development: { type: 'boolean' },
            strict: { type: 'boolean' },
            watch: { type: 'boolean' },
            json: { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
        } });
    jsonCheck = positionals[0] === 'check' && !!values.json;
    jsonImport = positionals[0] === 'import' && !!values.json;
    if (positionals.length > 1 || (positionals.length && !['init', 'check', 'export', 'import'].includes(positionals[0])))
        throw new Error('Unknown command. Use fasti18n init, check, export, import, or fasti18n --help.');
    const checking = positionals[0] === 'check';
    const init = positionals[0] === 'init';
    const exporting = positionals[0] === 'export';
    const importing = positionals[0] === 'import';
    if (values.help) {
        console.log('fasti18n init [--config fasti18n.config.json] [--catalogs messages] [--base-locale en] [--out-dir src/i18n]\nfasti18n [--config fasti18n.config.json] [--catalogs messages] [--base-locale en] [--out-dir src/i18n] [--development] [--strict] [--watch]\nfasti18n check [--config fasti18n.config.json] [--strict] [--json]\nCheck reports catalog errors without writing generated files. JSON output has version 1; errors exit 1, warnings alone exit 0.\nThe CLI discovers fasti18n.config.json in the working directory. Config paths are relative to that file. Init seeds an empty catalog directory with editable English examples, or adopts existing catalogs, and generates JS/types without replacing source files.');
        console.log('\nfasti18n export --locale fr [--out fr.po]\nfasti18n import --locale fr --from fr.po [--dry-run] [--strict] [--json]\nExport writes UTF-8 ICU-in-PO to stdout, or creates --out without replacing an existing file. Import merges reviewed translations and validates the proposed project before updating one JSON catalog. --from/--out are relative to the working directory; catalog paths follow the config. Dry runs never write files. Fuzzy, obsolete and untranslated entries are skipped; reviewed stale source text is an error. Run fasti18n to generate JS after import, or use the watcher.');
        return;
    }
    if (values.json && !checking && !importing)
        throw new Error('--json is available with fasti18n check or fasti18n import.');
    if (values.locale !== undefined && !exporting && !importing)
        throw new Error('--locale is available with fasti18n export or import.');
    if (values.from !== undefined && !importing)
        throw new Error('--from is available with fasti18n import.');
    if (values.out !== undefined && !exporting)
        throw new Error('--out is available with fasti18n export.');
    if (values['dry-run'] !== undefined && !importing)
        throw new Error('--dry-run is available with fasti18n import.');
    if (exporting || importing) {
        if (!values.locale)
            throw new Error('Choose a target locale with --locale, for example --locale fr.');
        if (importing && !values.from)
            throw new Error('Choose a PO input file with --from, for example --from fr.po.');
        if (values.watch || values.development !== undefined || values['out-dir'] !== undefined || exporting && values.strict)
            throw new Error('Translation commands do not accept --watch, --development or --out-dir; --strict applies to import validation.');
    }
    if (checking && values.watch)
        throw new Error('fasti18n check is a one-shot validation command. Use fasti18n --watch for generation and repair.');
    if (init && values.watch)
        throw new Error('Run fasti18n init first, then fasti18n --watch.');
    const configFile = resolve(values.config ?? configName);
    const loaded = await readConfig(configFile, !!values.config && !init).catch(error => { throw new CompileError([{ code: 'INVALID_CONFIG', message: error.message, file: configFile }]); });
    const config = loaded ?? {};
    const options = {
        ...config,
        root: dirname(configFile),
        baseLocale: values['base-locale'] ?? config.baseLocale ?? 'en',
        catalogs: values.catalogs ?? config.catalogs ?? 'messages',
        outDir: values['out-dir'] ?? config.outDir ?? 'src/i18n',
        development: values.development ?? config.development,
        missing: values.strict ? 'error' : config.missing,
    };
    if (exporting || importing) {
        const { exportPo, importPo } = await import('./translations.js');
        if (exporting) {
            const result = await exportPo({ ...options, locale: values.locale });
            if (values.out && values.out !== '-') {
                const { mkdir, writeFile } = await import('node:fs/promises');
                const output = resolve(values.out);
                await mkdir(dirname(output), { recursive: true });
                await writeFile(output, result.po, { flag: 'wx' });
            }
            else
                process.stdout.write(result.po);
            console.error(`fasti18n: exported ${result.messageCount} messages for ${result.locale}, ${result.translatedCount} already translated.`);
        }
        else {
            const result = await importPo({ ...options, locale: values.locale, from: resolve(values.from), dryRun: values['dry-run'] });
            if (values.json)
                console.log(JSON.stringify({ version: 1, ok: true, ...result }));
            else {
                for (const warning of result.warnings)
                    console.error(formatDiagnostic(warning) + '\n');
                console.log(`fasti18n: ${result.dryRun ? 'preview' : result.written ? 'imported' : 'no changes'} — ${result.added.length} added, ${result.updated.length} updated, ${result.unchanged} unchanged; skipped ${result.skipped.fuzzy} fuzzy, ${result.skipped.untranslated} untranslated, ${result.skipped.obsolete} obsolete.`);
                const changes = [...result.added.map(id => `+ ${id}`), ...result.updated.map(id => `~ ${id}`)];
                for (const line of changes.slice(0, 20))
                    console.log(line);
                if (changes.length > 20)
                    console.log(`… ${changes.length - 20} more changes. Use --dry-run --json for every ID.`);
                console.log(result.catalogFile);
            }
        }
        return;
    }
    if (checking) {
        const result = await check(options);
        if (values.json)
            console.log(JSON.stringify({ version: 1, ...result }));
        else {
            for (const diagnostic of [...result.errors, ...result.warnings])
                console.error(formatDiagnostic(diagnostic) + '\n');
            console.log(`fasti18n: checked ${result.messageCount} messages in ${result.locales.length} locales — ${result.errors.length} errors, ${result.warnings.length} warnings.`);
        }
        if (!result.ok)
            process.exitCode = 1;
        return;
    }
    if (init) {
        if (loaded && (values.catalogs !== undefined || values['base-locale'] !== undefined || values['out-dir'] !== undefined || values.development !== undefined || values.strict !== undefined)) {
            throw new Error(`Configuration already exists at ${configFile}. Edit that file, then run fasti18n; init never replaces it.`);
        }
        const result = await initialize(options, configFile, loaded !== undefined);
        const display = (file) => relative(process.cwd(), file).split(sep).join('/') || '.';
        for (const file of result.created)
            console.log(`Created ${display(file)}`);
        console.log(`fasti18n: ready — ${result.project.locales.length} locales, ${result.project.changed.length} generated files updated.`);
        for (const warning of result.project.warnings)
            console.warn(`${warning.locale}:${warning.messageId}: ${warning.message}`);
        const configArg = values.config ? ` --config ${JSON.stringify(display(configFile))}` : '';
        console.log(`\nEdit ${display(resolve(options.root, options.catalogs))}/*.json\nGenerate: fasti18n${configArg}\nWatch: fasti18n${configArg} --watch`);
        const module = './' + display(resolve(result.project.outDir, 'index.js'));
        const keys = result.project.groups['index.js'].slice(0, 3);
        const imports = keys.length ? `import { selectMessages } from ${JSON.stringify(module)};\nconst loadLocale = selectMessages(${keys.map(key => JSON.stringify(key)).join(', ')});`
            : `import { loadLocale } from ${JSON.stringify(module)};`;
        console.log(`\nFrom the project directory:\n${imports}\nconst { messages: m } = await loadLocale(${JSON.stringify(options.baseLocale)});`);
        if (result.seeded)
            console.log("m.greeting({ name: 'Ada' });\nm.items({ count: 3 });\n\nThe starter text is English; replace it with your base language.");
        console.log('\nVite: add fasti18n() from "fasti18n/vite" to plugins. It reads fasti18n.config.json at the Vite project root. For a custom config path, pass its options explicitly.');
        return;
    }
    const run = values.watch ? createGenerator(options) : () => generate(options);
    async function build() {
        const result = await run();
        console.log(`fasti18n: ${result.locales.length} locales, ${result.changed.length} files updated → ${result.outDir}`);
        for (const warning of result.warnings)
            console.warn(`${warning.locale}:${warning.messageId}: ${warning.message}`);
    }
    if (!values.watch) {
        await build();
        return;
    }
    // Keep the repair loop available when watch mode starts with a broken catalog.
    try {
        await build();
    }
    catch (error) {
        console.error(error.message);
    }
    let timer;
    let queue = Promise.resolve();
    const watcher = watch(resolve(options.root, options.catalogs), (_event, file) => {
        if (file && !file.endsWith('.json'))
            return;
        clearTimeout(timer);
        timer = setTimeout(() => { queue = queue.then(build).catch(error => { console.error(error.message); }); }, 50);
    });
    const close = () => { clearTimeout(timer); watcher.close(); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
}
main().catch(error => {
    if (jsonCheck)
        console.log(JSON.stringify({ version: 1, ok: false, errors: error instanceof CompileError ? error.diagnostics : [{ code: 'CHECK_ERROR', message: error.message }], warnings: [], locales: [], messageCount: 0, catalogFiles: [] }));
    else if (jsonImport)
        console.log(JSON.stringify({ version: 1, ok: false, errors: error instanceof CompileError ? error.diagnostics : [{ code: 'IMPORT_ERROR', message: error.message }] }));
    else
        console.error(error.message);
    process.exitCode = 1;
});
