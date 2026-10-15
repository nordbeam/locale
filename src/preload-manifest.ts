import { relative, resolve } from 'node:path';
import type { Rolldown } from 'vite';
import type { GenerateResult } from './project.js';
import type { Selections } from './selection.js';

/** JSON artifact consumed by a router/server to preload locale chunks. */
export interface NordbeamLocalePreloadManifest {
  readonly version: 1;
  readonly entries: Readonly<Record<string, {
    readonly file: string;
    readonly locales: Readonly<Record<string, readonly string[]>>;
  }>>;
}

/** @deprecated Use NordbeamLocalePreloadManifest. */
export type NordbeamI18nPreloadManifest = NordbeamLocalePreloadManifest;

/** Build-only mapping from emitted entry modules to their locale dependencies.
 * Consumers can preload these files from a router/server before the entry runs.
 * Dynamic application routes are deliberately separate manifest entries. */
export function preloadManifest(root: string, project: GenerateResult, selections: Selections,
  bundle: Rolldown.OutputBundle, info: (id: string) => Rolldown.ModuleInfo | null): NordbeamLocalePreloadManifest {
  const chunks = Object.values(bundle).filter((item): item is Rolldown.OutputChunk => item.type === 'chunk');
  const owners = new Map<string, string>();
  for (const chunk of chunks) for (const id of chunk.moduleIds) owners.set(id, chunk.fileName);
  const entries: Record<string, { file: string; locales: Record<string, string[]> }> = Object.create(null);
  const fullLoaders = new Set(Object.keys(project.groups).map(file => resolve(project.outDir, file)));
  for (const chunk of chunks) {
    if ((!chunk.isEntry && !chunk.isDynamicEntry) || !chunk.facadeModuleId || chunk.facadeModuleId.startsWith('\0')) continue;
    const entry = relative(root, chunk.facadeModuleId).replaceAll('\\', '/');
    if (entry.startsWith('../') || entry.includes('/node_modules/') || chunk.facadeModuleId.startsWith(project.outDir + '/')) continue;
    const loaders = new Set<string>(), visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const descriptor = selections.modules.get(id);
      if (descriptor && descriptor.locale === undefined) { loaders.add(id); return; }
      if (fullLoaders.has(id)) { loaders.add(id); return; }
      for (const dependency of info(id)?.importedIds ?? []) visit(dependency);
    };
    visit(chunk.facadeModuleId);
    if (!loaders.size) continue;
    const locales: Record<string, string[]> = Object.create(null);
    for (const locale of project.locales) {
      const files = new Set<string>();
      const addChunk = (file: string): void => {
        if (files.has(file)) return;
        const dependency = bundle[file];
        if (!dependency || dependency.type !== 'chunk') return;
        files.add(file);
        for (const imported of dependency.imports) addChunk(imported);
      };
      for (const id of loaders) {
        const descriptor = selections.modules.get(id);
        const modules = descriptor ? [`${id}/${locale}`] : [
          // Full loaders use the compact private catalog module. Keep the
          // public path as a compatibility fallback for integrations that
          // provide a synthetic bundle or older generated output.
          resolve(id, '..', 'internal', 'locales', `${locale}.js`),
          resolve(id, '..', 'locales', `${locale}.js`),
        ];
        const file = modules.map(module => owners.get(module)).find(Boolean);
        if (file) addChunk(file);
      }
      locales[locale] = [...files].sort();
    }
    entries[entry] = { file: chunk.fileName, locales };
  }
  return { version: 1 as const, entries };
}

/** Client chunks that hold each generated full loader's catalog, by locale, as URLs
 * under `base`. Keys are absolute loader paths. Loaders missing from the bundle are
 * left out, and so are chunks the loader already imports statically. */
export function catalogAssets(project: GenerateResult, bundle: Rolldown.OutputBundle, base: string): Map<string, Record<string, string[]>> {
  const chunks = Object.values(bundle).filter((item): item is Rolldown.OutputChunk => item.type === 'chunk');
  const owners = new Map<string, string>();
  for (const chunk of chunks) for (const id of chunk.moduleIds) owners.set(id, chunk.fileName);
  const closure = (file: string, files = new Set<string>()): Set<string> => {
    const chunk = bundle[file];
    if (files.has(file) || !chunk || chunk.type !== 'chunk') return files;
    files.add(file);
    for (const imported of chunk.imports) closure(imported, files);
    return files;
  };
  const prefix = base.endsWith('/') ? base : base + '/';
  const result = new Map<string, Record<string, string[]>>();
  for (const group of Object.keys(project.groups)) {
    const loader = resolve(project.outDir, group);
    const owner = owners.get(loader);
    if (!owner) continue;
    const loaded = closure(owner);
    const locales: Record<string, string[]> = Object.create(null);
    for (const locale of project.locales) {
      const catalog = [resolve(loader, '..', 'internal', 'locales', `${locale}.js`), resolve(loader, '..', 'locales', `${locale}.js`)]
        .map(module => owners.get(module)).find(Boolean);
      locales[locale] = catalog ? [...closure(catalog)].filter(file => !loaded.has(file)).sort().map(file => prefix + file) : [];
    }
    result.set(loader, locales);
  }
  return result;
}
