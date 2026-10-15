import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { compileProject, CompileError } from './compiler.js';
import { writeProject } from './project.js';
import { attachDeclarationMaps } from './source-maps.js';
import { invalidJson, locateCompileError } from './catalog-diagnostics.js';
const starter = {
    greeting: 'Hello {name}!',
    items: '{count, plural, =0 {Your basket is empty} one {# item} other {# items}}',
};
function inside(parent, child) {
    const path = relative(parent, child);
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
async function requireAbsent(file) {
    try {
        await lstat(file);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    throw new Error(`Refusing to replace existing file: ${file}`);
}
/** Seed an empty catalog directory or adopt existing catalogs, then generate.
 * New user-owned source/config files use exclusive creation; none is replaced.
 */
export async function initialize(options, configFile, configExists) {
    const root = options.root ?? process.cwd();
    const input = resolve(root, options.catalogs ?? 'messages');
    const outDir = resolve(root, options.outDir ?? 'src/i18n');
    if (inside(outDir, input) || inside(input, outDir))
        throw new Error('Catalog and generated output directories must be separate.');
    if (inside(outDir, configFile) || dirname(configFile) === input)
        throw new Error('Keep the configuration outside the catalog and generated output directories.');
    let catalogFiles;
    try {
        catalogFiles = (await readdir(input, { withFileTypes: true }))
            .filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => resolve(input, entry.name)).sort();
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        catalogFiles = [];
    }
    const catalogs = Object.create(null);
    const sources = new Map();
    const baseFile = resolve(input, `${options.baseLocale}.json`);
    let baseText = '';
    for (const file of catalogFiles) {
        const locale = file.slice(input.length + 1, -5);
        let text;
        try {
            text = await readFile(file, 'utf8');
        }
        catch (error) {
            throw new CompileError([{ code: 'CATALOG_READ_ERROR', message: error.message, locale, file }]);
        }
        sources.set(locale, { file, text });
        try {
            catalogs[locale] = JSON.parse(text);
            if (file === baseFile)
                baseText = text;
        }
        catch (error) {
            throw invalidJson(error, locale, { file, text });
        }
    }
    const seeded = catalogFiles.length === 0;
    if (seeded) {
        catalogs[options.baseLocale] = starter;
        baseText = JSON.stringify(starter, null, 2) + '\n';
    }
    // Compilation and output ownership checks happen before creating source/config.
    let compiled;
    try {
        compiled = compileProject({ ...options, catalogs });
    }
    catch (error) {
        if (error instanceof CompileError)
            throw locateCompileError(error, sources);
        throw error;
    }
    sources.clear();
    attachDeclarationMaps(compiled, { file: baseFile, text: baseText }, outDir);
    if (seeded)
        await requireAbsent(resolve(input, `${options.baseLocale}.json`));
    if (!configExists)
        await requireAbsent(configFile);
    const changed = await writeProject(compiled, outDir);
    const created = [];
    if (seeded) {
        const file = resolve(input, `${options.baseLocale}.json`);
        await mkdir(input, { recursive: true });
        await writeFile(file, baseText, { flag: 'wx' });
        created.push(file);
        catalogFiles.push(file);
    }
    if (!configExists) {
        const { root: _root, ...config } = options;
        await mkdir(dirname(configFile), { recursive: true });
        await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
        created.push(configFile);
    }
    return { project: { ...compiled, catalogFiles, changed, outDir }, seeded, created };
}
