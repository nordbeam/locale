import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { compileProject, CompileError } from './compiler.js';
import type { Catalog, CompiledProject } from './compiler.js';
import { generate, markProject, writeProject } from './project.js';
import type { GenerateOptions, GenerateResult } from './project.js';
import { attachDeclarationMaps } from './source-maps.js';
import { duplicateKeyDiagnostics, invalidJson, locateCompileError } from './catalog-diagnostics.js';
import { parseCatalogJson } from './catalog-input.js';
import { configKeys as persistedConfigKeys } from './config.js';
import type { CatalogSource } from './catalog-diagnostics.js';
import { CliError, usageError } from './error-codes.js';

const starter: Catalog = {
  greeting: 'Hello {name}!',
  items: '{count, plural, =0 {Your basket is empty} one {# item} other {# items}}',
};


/** Application integration templates created by `nordbeam-locale init`.
 * These files are deliberately ordinary source files: users can edit them,
 * and init never replaces an existing framework config or adapter. */
export type InitFramework = 'next' | 'vite-react' | 'vue' | 'svelte' | 'solid' | 'tanstack-start';

type ScaffoldResult = { created: string[]; existing: string[]; notes: string[] };

/** Vite plugin each component framework needs next to nordbeamLocale(). vite-react uses the React plugin only in user code. */
const frameworkVitePlugins: Partial<Record<InitFramework, { package: string; statement: string; call: string }>> = {
  vue: { package: '@vitejs/plugin-vue', statement: "import vue from '@vitejs/plugin-vue';", call: 'vue()' },
  svelte: { package: '@sveltejs/vite-plugin-svelte', statement: "import { svelte } from '@sveltejs/vite-plugin-svelte';", call: 'svelte()' },
  solid: { package: 'vite-plugin-solid', statement: "import solid from 'vite-plugin-solid';", call: 'solid()' },
};

/** The files `planInitialize` expects `initialize` to create or update. */
export interface InitPlan {
  readonly generated: readonly string[];
  readonly config: readonly string[];
  readonly scaffold: readonly string[];
  readonly packageEdits: readonly string[];
}

/** Find an existing catalog convention without making an empty directory just
 * to probe it. `src/locales` wins when both conventions are present because it
 * is the conventional application-owned source location. */
export async function detectCatalogDirectory(root: string): Promise<string | undefined> {
  for (const directory of ['src/locales', 'locales']) {
    try {
      if ((await lstat(resolve(root, directory))).isDirectory()) return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

/** Infer the adapter from installed application dependencies. Explicit
 * `--framework` always remains authoritative. */
export async function detectFramework(root: string): Promise<InitFramework | undefined> {
  // A malformed package file should not prevent the core init flow. npm
  // reports the package error independently, while init can still create
  // its config and catalogs.
  const dependencies = await declaredDependencies(root);
  if (Object.hasOwn(dependencies, 'next')) return 'next';
  if (Object.hasOwn(dependencies, '@tanstack/react-start')) return 'tanstack-start';
  if (!Object.hasOwn(dependencies, 'vite')) return undefined;
  if (Object.hasOwn(dependencies, 'svelte') || Object.hasOwn(dependencies, '@sveltejs/kit')) return 'svelte';
  if (Object.hasOwn(dependencies, 'vue')) return 'vue';
  if (Object.hasOwn(dependencies, 'solid-js')) return 'solid';
  return 'vite-react';
}

async function declaredDependencies(root: string): Promise<Record<string, unknown>> {
  const packageJson = await readJsonOptional(resolve(root, 'package.json')) as {
    dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; peerDependencies?: Record<string, unknown>;
  } | undefined;
  return { ...packageJson?.dependencies, ...packageJson?.devDependencies, ...packageJson?.peerDependencies };
}

/** Keep package.json churn out of migrations: reuse the file's indentation,
 * line endings and final newline. Minified files stay minified. */
function formatPackageJson(value: unknown, original: string): string {
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const body = original.trimEnd();
  const indents = [...body.matchAll(/^([ \t]+)\S/gm)].map(match => match[1]!).sort((left, right) => left.length - right.length);
  const indent = body.includes('\n') ? indents[0] ?? '  ' : '';
  const text = JSON.stringify(value, null, indent);
  return (newline === '\n' ? text : text.replace(/\n/g, newline)) + (original.endsWith('\n') ? newline : '');
}

/** Compute the package.json script additions without writing them. */
async function packageScriptsEdit(root: string): Promise<{ file: string; text: string } | undefined> {
  const file = resolve(root, 'package.json');
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  let packageJson: { scripts?: Record<string, string>; [key: string]: unknown };
  try { packageJson = JSON.parse(text) as typeof packageJson; }
  catch { return; }
  const scripts = packageJson.scripts ?? (packageJson.scripts = {});
  let changed = false;
  const additions: Record<string, string> = {
    i18n: 'nordbeam-locale',
    'i18n:watch': 'nordbeam-locale --watch',
  };
  for (const [name, command] of Object.entries(additions)) {
    if (scripts[name] === undefined) { scripts[name] = command; changed = true; }
  }
  // `prebuild` rather than `prepare`: prepare runs on every npm install, including production installs
  // that omit the devDependency CLI, which would fail them. Generation belongs before builds.
  // A prepare that already invokes the CLI (or the earlier bin name) counts as present, so nothing is duplicated.
  const invokesI18n = (command: string | undefined): boolean => command?.includes('nordbeam-locale') === true || command?.includes('nordbeam-i18n') === true;
  if (!invokesI18n(scripts.prepare) && !invokesI18n(scripts.prebuild)) {
    scripts.prebuild = scripts.prebuild === undefined ? 'nordbeam-locale' : `${scripts.prebuild} && nordbeam-locale`;
    changed = true;
  }
  if (!changed) return;
  return { file, text: formatPackageJson(packageJson, text) };
}

async function updatePackageScripts(root: string): Promise<string | undefined> {
  const edit = await packageScriptsEdit(root);
  if (!edit) return;
  await writeFile(edit.file, edit.text);
  return edit.file;
}

async function optionalFile(root: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    try {
      const stat = await lstat(resolve(root, name));
      if (stat.isFile()) return resolve(root, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

async function readJsonOptional(file: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** Next 16 uses proxy.ts for the request boundary; earlier majors use
 * middleware.ts. The installed package wins, then the declared range; an
 * unknown range (for example `latest`) gets the current convention. */
async function nextRequestFile(root: string): Promise<'proxy.ts' | 'middleware.ts'> {
  const installed = await readJsonOptional(resolve(root, 'node_modules/next/package.json'));
  const packageJson = await readJsonOptional(resolve(root, 'package.json')) as {
    dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; peerDependencies?: Record<string, unknown>;
  } | undefined;
  const declared = { ...packageJson?.dependencies, ...packageJson?.devDependencies, ...packageJson?.peerDependencies }.next;
  const range = typeof installed?.version === 'string' ? installed.version : declared;
  const major = typeof range === 'string' ? Number(/^\D*(\d+)\./.exec(range)?.[1]) : NaN;
  return Number.isInteger(major) && major < 16 ? 'middleware.ts' : 'proxy.ts';
}

/** Next only loads proxy.ts/middleware.ts from the folder that holds app/ (or pages/):
 * the project root, or src/ when the app lives under src/app. A root app/ wins, as it does in Next. */
async function nextRequestDirectory(root: string): Promise<string> {
  const isDirectory = async (path: string): Promise<boolean> => {
    try { return (await lstat(resolve(root, path))).isDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  if (await isDirectory('app') || await isDirectory('pages')) return root;
  return await isDirectory('src/app') || await isDirectory('src/pages') ? resolve(root, 'src') : root;
}

async function createIfAbsent(file: string, content: string, result: ScaffoldResult, apply: boolean): Promise<void> {
  try {
    await lstat(file);
    result.existing.push(file);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!apply) { result.created.push(file); return; }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, { flag: 'wx' });
  result.created.push(file);
}

/** `./x` or `../x`: the extensionless specifier from the directory of `file` to `target`. */
function specifierFrom(file: string, target: string): string {
  const path = relative(dirname(file), target).split(sep).join('/');
  return path.startsWith('../') ? path : `./${path}`;
}

async function textOrEmpty(file: string): Promise<string> {
  return (await readText(file)) ?? '';
}

/** TanStack Start: the i18n modules next to the generated output, plus the application files that wire them in.
 * Application files that exist are never edited; a note says what each one needs. */
async function scaffoldTanStackStart(root: string, outDir: string, result: ScaffoldResult, apply: boolean): Promise<void> {
  await createIfAbsent(resolve(outDir, 'routing.ts'), `import { defineRouting } from '@nordbeam/locale/tanstack-start';
import { baseLocale, locales } from './index';

/** Locale routing shared by the request middleware and the router rewrite. Add pathnames or domains here. */
export const routing = defineRouting({
  locales,
  defaultLocale: baseLocale,
  localePrefix: 'as-needed',
});
`, result, apply);
  await createIfAbsent(resolve(outDir, 'tanstack.ts'), `import { createTanStackStartI18n } from '@nordbeam/locale/tanstack-start';
import { loadLocale } from './index';
import { routing } from './routing';

/** Locale state for TanStack Start: the root route helpers, the provider, hooks and the language switcher link. */
export const i18n = createTanStackStartI18n({ routing, loadLocale });
export { loadLocale, routing };
`, result, apply);

  const viteConfig = await optionalFile(root, ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']);
  const dependencies = await declaredDependencies(root);
  if (viteConfig) {
    result.existing.push(viteConfig);
    if (!/nordbeam(?:Locale|I18n)\s*\(/.test(await textOrEmpty(viteConfig))) {
      result.notes.push(`Add nordbeamLocale() from @nordbeam/locale/vite to the plugins in ${relative(root, viteConfig)}, before tanstackStart(): import { nordbeamLocale } from '@nordbeam/locale/vite'; plugins: [nordbeamLocale(), tanstackStart(), viteReact()].`);
    }
  } else if (Object.hasOwn(dependencies, '@vitejs/plugin-react')) {
    await createIfAbsent(resolve(root, 'vite.config.ts'), `import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nordbeamLocale } from '@nordbeam/locale/vite';

export default defineConfig({
  plugins: [nordbeamLocale(), tanstackStart(), viteReact()],
});
`, result, apply);
  } else result.notes.push('Install @vitejs/plugin-react, then add nordbeamLocale() from @nordbeam/locale/vite, tanstackStart() from @tanstack/react-start/plugin/vite and viteReact() to the plugins in vite.config.ts.');

  const start = resolve(root, 'src/start.ts');
  const router = resolve(root, 'src/router.tsx');
  const rootRoute = resolve(root, 'src/routes/__root.tsx');
  const routingImport = specifierFrom(start, resolve(outDir, 'routing'));
  const i18nFrom = (file: string) => specifierFrom(file, resolve(outDir, 'tanstack'));

  await createIfAbsent(start, `import { createStart } from '@tanstack/react-start';
import { createLocaleFunctionMiddleware, createLocaleMiddleware } from '@nordbeam/locale/tanstack-start';
import { routing } from '${routingImport}';

export const startInstance = createStart(() => ({
  requestMiddleware: [createLocaleMiddleware(routing)],
  functionMiddleware: [createLocaleFunctionMiddleware()],
}));
`, result, apply);
  if (result.existing.includes(start) && !(await textOrEmpty(start)).includes('createLocaleMiddleware')) {
    result.notes.push(`In src/start.ts, register the locale middleware: import { createLocaleFunctionMiddleware, createLocaleMiddleware } from '@nordbeam/locale/tanstack-start'; import { routing } from '${routingImport}'; then createStart(() => ({ requestMiddleware: [createLocaleMiddleware(routing)], functionMiddleware: [createLocaleFunctionMiddleware()] })).`);
  }

  await createIfAbsent(router, `import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { i18n } from '${i18nFrom(router)}';

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, ...i18n.routerOptions() });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
`, result, apply);
  if (result.existing.includes(router) && !(await textOrEmpty(router)).includes('routerOptions')) {
    result.notes.push(`In src/router.tsx, spread the locale options into createRouter: import { i18n } from '${i18nFrom(router)}'; createRouter({ routeTree, ...i18n.routerOptions() }). To add your own router context, merge it: context: { ...i18n.routerOptions().context, ...yourContext }.`);
  }

  await createIfAbsent(rootRoute, `import type { ReactNode } from 'react';
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { TanStackStartRouterContext } from '@nordbeam/locale/tanstack-start';
import { i18n } from '${i18nFrom(rootRoute)}';

export const Route = createRootRouteWithContext<TanStackStartRouterContext<(typeof i18n.locales)[number]>>()({
  beforeLoad: i18n.beforeLoad,
  head: () => ({ meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }] }),
  shellComponent: RootDocument,
  component: () => <i18n.Provider><Outlet /></i18n.Provider>,
});

function RootDocument({ children }: { children: ReactNode }) {
  return <html {...i18n.useHtmlAttributes()}>
    <head><HeadContent /></head>
    <body>{children}<Scripts /></body>
  </html>;
}
`, result, apply);
  if (result.existing.includes(rootRoute) && !(await textOrEmpty(rootRoute)).includes('i18n.beforeLoad')) {
    result.notes.push(`In src/routes/__root.tsx, import { i18n } from '${i18nFrom(rootRoute)}' and: use createRootRouteWithContext<TanStackStartRouterContext<(typeof i18n.locales)[number]>>() with beforeLoad: i18n.beforeLoad; render <html {...i18n.useHtmlAttributes()}> in the shellComponent; wrap the root component's <Outlet /> in <i18n.Provider>.`);
  }
}

/** Adapter files for the component frameworks. The base locale is imported
 * statically so each instance exists synchronously; top-level await would fail
 * Vite's default build targets. */
const frameworkAdapters: Record<'vue' | 'svelte' | 'solid', (baseLocale: string) => string> = {
  vue: baseLocale => `import { createVueI18n } from '@nordbeam/locale/vue';
import { baseLocale, loadLocale } from './index';
import messages from './locales/${baseLocale}';

/**
 * Vue i18n instance. Register it once in the entry file with \`app.use(i18n)\`,
 * then call \`i18n.useI18n()\` or \`i18n.useMessages()\` inside \`setup()\`.
 */
export const i18n = createVueI18n({ initial: { locale: baseLocale, messages }, loadLocale });
`,
  svelte: baseLocale => `import { createSvelteI18n } from '@nordbeam/locale/svelte';
import { baseLocale, loadLocale } from './index';
import messages from './locales/${baseLocale}';

/**
 * Svelte i18n instance. Call \`setI18nContext(i18n)\` during initialization of
 * the root component or layout. Descendants read it with \`getI18nContext()\`.
 */
export const i18n = createSvelteI18n({ initial: { locale: baseLocale, messages }, loadLocale });
`,
  solid: baseLocale => `import { createSolidI18n } from '@nordbeam/locale/solid';
import { baseLocale, loadLocale } from './index';
import messages from './locales/${baseLocale}';

/**
 * Solid i18n instance. Wrap the application once with \`<i18n.Provider>\`, then
 * read \`i18n.useI18n()\` or \`i18n.useMessages(loader)\` inside components.
 */
export const i18n = createSolidI18n({ initial: { locale: baseLocale, messages }, loadLocale });
`,
};

/** Write the framework adapters, or only report them when `apply` is false.
 * Scaffold imports are extensionless so they resolve under both webpack and
 * Turbopack, and TypeScript source resolution, for every scaffold file. */
async function scaffoldFramework(root: string, outDir: string, framework: InitFramework, baseLocale: string, apply = true): Promise<ScaffoldResult> {
  const result: ScaffoldResult = { created: [], existing: [], notes: [] };
  if (framework === 'next') {
    const nextConfig = await optionalFile(root, ['next.config.mjs', 'next.config.js', 'next.config.ts']);
    if (!nextConfig) await createIfAbsent(resolve(root, 'next.config.mjs'), `import { withNordbeamLocale } from '@nordbeam/locale/next';

export default withNordbeamLocale({});
`, result, apply);
    else result.existing.push(nextConfig);
    await createIfAbsent(resolve(outDir, 'next.ts'), `import { createNextI18n } from '@nordbeam/locale/next/runtime';
import { locales, loadLocale } from './index.js';

/** Shared App Router locale validation and static-params helper. */
export const i18n = createNextI18n({ locales, loadLocale });
export { locales, loadLocale };
`, result, apply);
    await createIfAbsent(resolve(outDir, 'client.ts'), `'use client';
import { createClientI18n } from '@nordbeam/locale/react';
import { loadLocale } from './index.js';

/** Shared Client Component controller. */
export const i18n = createClientI18n(loadLocale);
export { loadLocale };
`, result, apply);
    await createIfAbsent(resolve(outDir, 'provider.ts'), `'use client';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { locales } from './index.js';
import { i18n } from './client';

const supported = new Set<string>(locales);
/** Hydration-safe bridge for a server-owned App Router locale. */
export function NordbeamLocaleProvider({ locale, children }: { locale: string; children?: ReactNode }) {
  if (!supported.has(locale)) throw new RangeError('Unsupported locale: ' + locale);
  return createElement(i18n.Provider, { initialLocale: locale as (typeof locales)[number] }, children);
}
`, result, apply);
    await createIfAbsent(resolve(outDir, 'routing.ts'), `import { defineRouting } from '@nordbeam/locale/next/routing';
import { baseLocale, locales } from './index.js';

/** Locale routing shared by the request proxy and App Router links. Add pathnames or domains here. */
export const routing = defineRouting({
  locales,
  defaultLocale: baseLocale,
  localePrefix: 'always',
});
`, result, apply);
    const requestDirectory = await nextRequestDirectory(root);
    const requestFile = await optionalFile(requestDirectory, ['proxy.ts', 'proxy.js', 'proxy.mjs', 'middleware.ts', 'middleware.js', 'middleware.mjs']);
    if (requestFile) result.existing.push(requestFile);
    else {
      const routingImport = relative(requestDirectory, resolve(outDir, 'routing')).split(sep).join('/');
      const specifier = routingImport.startsWith('../') ? routingImport : `./${routingImport}`;
      await createIfAbsent(resolve(requestDirectory, await nextRequestFile(root)), `import { createNextMiddleware } from '@nordbeam/locale/next/middleware';
import { routing } from '${specifier}';

export default createNextMiddleware(routing);

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\\\..*).*)'],
};
`, result, apply);
    }
  } else if (framework === 'tanstack-start') {
    await scaffoldTanStackStart(root, outDir, result, apply);
  } else if (framework === 'vite-react') {
    const viteConfig = await optionalFile(root, ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']);
    if (!viteConfig) await createIfAbsent(resolve(root, 'vite.config.ts'), `import { defineConfig } from 'vite';
import { nordbeamLocale } from '@nordbeam/locale/vite';

export default defineConfig({
  plugins: [nordbeamLocale()],
});
`, result, apply);
    else result.existing.push(viteConfig);
    await createIfAbsent(resolve(outDir, 'client.ts'), `import { createClientI18n } from '@nordbeam/locale/react';
import { loadLocale } from './index.js';

/** One state-owning client store for the browser application. */
export const i18n = createClientI18n(loadLocale);
export { loadLocale };
`, result, apply);
  } else if (framework === 'vue' || framework === 'svelte' || framework === 'solid') {
    const plugin = frameworkVitePlugins[framework]!;
    const viteConfig = await optionalFile(root, ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']);
    if (viteConfig) result.existing.push(viteConfig);
    else if (Object.hasOwn(await declaredDependencies(root), plugin.package)) {
      await createIfAbsent(resolve(root, 'vite.config.ts'), `import { defineConfig } from 'vite';
${plugin.statement}
import { nordbeamLocale } from '@nordbeam/locale/vite';

export default defineConfig({
  plugins: [${plugin.call}, nordbeamLocale()],
});
`, result, apply);
    } else result.notes.push(`Install ${plugin.package}, then add ${plugin.call} and nordbeamLocale() from @nordbeam/locale/vite to the Vite plugins in vite.config.ts.`);
    await createIfAbsent(resolve(outDir, `${framework}.ts`), frameworkAdapters[framework](baseLocale), result, apply);
  }
  return result;
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function requireAbsent(file: string): Promise<void> {
  try { await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new CliError('FILE_EXISTS', `Refusing to replace existing file: ${file}`, { path: file });
}

async function readText(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Seed an empty catalog directory or adopt existing catalogs, then generate.
 * New user-owned source/config files use exclusive creation; none is replaced.
 */
export async function initialize(options: GenerateOptions, configFile: string, configExists: boolean, framework?: InitFramework): Promise<{
  project: GenerateResult; seeded: boolean; created: string[]; updated?: string[]; framework?: InitFramework; frameworkCreated?: string[]; frameworkExisting?: string[]; frameworkNotes?: string[];
}> {
  const root = options.root ?? process.cwd();
  const input = resolve(root, options.catalogs ?? 'messages');
  const outDir = resolve(root, options.outDir ?? 'src/i18n');
  if (inside(outDir, input) || inside(input, outDir)) throw usageError('Catalog and generated output directories must be separate.');
  if (inside(outDir, configFile) || dirname(configFile) === input) throw usageError('Keep the configuration outside the catalog and generated output directories.');
  let catalogFiles: string[];
  try {
    catalogFiles = (await readdir(input, {withFileTypes: true}))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => resolve(input, entry.name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    catalogFiles = [];
  }
  const catalogs: Record<string, Catalog> = Object.create(null);
  const sources = new Map<string, CatalogSource>();
  const baseFile = resolve(input, `${options.baseLocale}.json`);
  let baseText = '';
  for (const file of catalogFiles) {
    const locale = file.slice(input.length + 1, -5);
    let text: string;
    try { text = await readFile(file, 'utf8'); }
    catch (error) { throw new CompileError([{ code: 'CATALOG_READ_ERROR', message: (error as Error).message, locale, file }]); }
    sources.set(locale, { file, text });
    try {
      catalogs[locale] = parseCatalogJson(text);
      if(file===baseFile)baseText=text;
    }
    catch (error) { throw invalidJson(error as Error, locale, { file, text }); }
    const duplicates = duplicateKeyDiagnostics({ file, text }, locale, catalogs[locale]);
    if (duplicates.length) throw new CompileError(duplicates);
  }
  const seeded = catalogFiles.length === 0;
  if (seeded) {catalogs[options.baseLocale] = starter;baseText=JSON.stringify(starter,null,2)+'\n';}
  // Compilation and output ownership checks happen before creating source/config.
  let compiled: CompiledProject;
  try { compiled = compileProject({...options, catalogs}); }
  catch (error) { if (error instanceof CompileError) throw locateCompileError(error, sources); throw error; }
  sources.clear();
  attachDeclarationMaps(compiled,{file:baseFile,text:baseText},outDir);
  compiled = markProject(compiled, !!options.development, resolve(root), input);
  if (seeded) await requireAbsent(resolve(input, `${options.baseLocale}.json`));
  if (!configExists) await requireAbsent(configFile);
  const changed = await writeProject(compiled, outDir);
  const created: string[] = [];
  if (seeded) {
    const file = resolve(input, `${options.baseLocale}.json`);
    await mkdir(input, {recursive: true});
    await writeFile(file, baseText, {flag: 'wx'});
    created.push(file);
    catalogFiles.push(file);
  }
  if (!configExists) {
    // Persist the config vocabulary only. Anything else (CLI flags, absolute
    // paths, development-only switches) would be rejected by the next run.
    const optionValues: Partial<Record<(typeof persistedConfigKeys)[number], unknown>> = options;
    const config = Object.fromEntries(persistedConfigKeys.filter(key => optionValues[key] !== undefined).map(key => [key, optionValues[key]]));
    await mkdir(dirname(configFile), {recursive: true});
    await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', {flag: 'wx'});
    created.push(configFile);
  }
  // Record the generation inputs in the manifest, so verify reports a fresh project
  // right after init. The output files already match, so only the manifest is written.
  await generate(options);
  const updated = await updatePackageScripts(root);
  const frameworkResult = framework ? await scaffoldFramework(root, outDir, framework, options.baseLocale) : undefined;
  return {
    project: {...compiled, catalogFiles, changed, outDir}, seeded, created,
    ...(updated ? { updated: [updated] } : {}),
    ...(framework ? { framework, frameworkCreated: frameworkResult!.created, frameworkExisting: frameworkResult!.existing, frameworkNotes: frameworkResult!.notes } : {}),
  };
}

/** Report what `initialize` would create or update for the given catalogs,
 * without writing. Existing generated, config, scaffold and package files are
 * compared on disk, so the preview shows the real effect of `--write`. */
export async function planInitialize(options: GenerateOptions, catalogs: Record<string, Catalog>, baseText: string, configFile: string, configExists: boolean, framework?: InitFramework): Promise<InitPlan> {
  const root = options.root ?? process.cwd();
  const outDir = resolve(root, options.outDir ?? 'src/i18n');
  let compiled = compileProject({...options, catalogs});
  attachDeclarationMaps(compiled, {file: resolve(root, options.catalogs ?? 'messages', `${options.baseLocale}.json`), text: baseText}, outDir);
  compiled = markProject(compiled, !!options.development, resolve(root), resolve(root, options.catalogs ?? 'messages'));
  const generated: string[] = [];
  for (const name of Object.keys(compiled.files).sort()) {
    if (await readText(resolve(outDir, name)) !== compiled.files[name]) generated.push(resolve(outDir, name));
  }
  const scaffold = framework ? await scaffoldFramework(root, outDir, framework, options.baseLocale, false) : { created: [], existing: [], notes: [] };
  const edit = await packageScriptsEdit(root);
  return {
    generated,
    config: configExists ? [] : [configFile],
    scaffold: scaffold.created,
    packageEdits: edit ? [edit.file] : [],
  };
}

const agentStart = '<!-- nordbeam-locale:start -->';
const agentEnd = '<!-- nordbeam-locale:end -->';

/** The agent onboarding block. It names the configured paths, so it is generated from the resolved options. */
export function agentBlock(options: { catalogs?: string; outDir?: string; baseLocale: string }): string {
  const catalogs = (options.catalogs ?? 'messages').replace(/\/+$/, ''), outDir = (options.outDir ?? 'src/i18n').replace(/\/+$/, '');
  return [
    agentStart,
    '## Nordbeam Locale',
    '',
    `- Catalogs: \`${catalogs}/\` holds one JSON file per locale. The base locale is \`${options.baseLocale}\`. Edit these files.`,
    `- Generated output: \`${outDir}/\` is written by the tool. Never edit files there; change the catalogs and regenerate.`,
    '- Edit loop: edit a catalog, run `nordbeam-locale check --json`, run `nordbeam-locale` to generate, then run `nordbeam-locale verify --json` before you finish.',
    '- `nordbeam-locale explain <CODE>` gives the cause and fix for any error code.',
    '- Agent skills: `.claude/skills/nordbeam-locale/` and `.agents/skills/nordbeam-locale/` (installed by `init --agent`, refreshed by `nordbeam-locale skills install`). Read `SKILL.md` before changing catalogs or setup; use `nordbeam-locale-migrate` when moving from another i18n library.',
    '- MCP clients: `nordbeam-locale mcp` serves the check, generate, inspect and rename tools over stdio.',
    '- Full agent guide: `nordbeam-locale agent-guide`. Machine contract: `nordbeam-locale capabilities --json`.',
    agentEnd,
  ].join('\n');
}

/** Replaces the block in place, or appends it after the existing text. */
function withAgentBlock(text: string, block: string): string {
  const start = text.indexOf(agentStart), end = start === -1 ? -1 : text.indexOf(agentEnd, start);
  if (end !== -1) return text.slice(0, start) + block + text.slice(end + agentEnd.length);
  const head = text.trimEnd();
  return `${head ? `${head}\n\n` : ''}${block}\n`;
}

/** Writes the agent block to AGENTS.md (created when missing) and to CLAUDE.md when that file already exists. */
export async function writeAgentInstructions(root: string, options: { catalogs?: string; outDir?: string; baseLocale: string }): Promise<{ file: string; action: 'created' | 'updated' | 'unchanged' }[]> {
  const block = agentBlock(options);
  const written: { file: string; action: 'created' | 'updated' | 'unchanged' }[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = resolve(root, name);
    let existing: string | undefined;
    try { existing = await readFile(file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // CLAUDE.md is only updated when the project already has one; AGENTS.md is always provided.
      if (name === 'CLAUDE.md') continue;
    }
    const next = withAgentBlock(existing ?? '', block);
    if (existing === next) { written.push({ file, action: 'unchanged' }); continue; }
    await writeFile(file, next);
    written.push({ file, action: existing === undefined ? 'created' : 'updated' });
  }
  return written;
}
