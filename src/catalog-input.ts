import type { Catalog } from './compiler.js';

// File generation owns these parsed objects and never exposes or mutates them.
// Object identity is therefore a valid revision marker here. Arbitrary objects
// passed to the public compiler are deliberately not registered.
const snapshots = new WeakSet<object>();

/** JSON.parse with an optional leading UTF-8 BOM, which editors commonly add. */
export function parseCatalogJson(text: string): Catalog {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Catalog;
}

export function parseCatalogSnapshot(text: string): Catalog {
  const catalog = parseCatalogJson(text);
  if (catalog !== null && typeof catalog === 'object') snapshots.add(catalog);
  return catalog;
}

export function isCatalogSnapshot(catalog: Catalog): boolean {
  return snapshots.has(catalog);
}
