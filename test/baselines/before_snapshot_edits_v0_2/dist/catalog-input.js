// File generation owns these parsed objects and never exposes or mutates them.
// Object identity is therefore a valid revision marker here. Arbitrary objects
// passed to the public compiler are deliberately not registered.
const snapshots = new WeakSet();
export function parseCatalogSnapshot(text) {
    const catalog = JSON.parse(text);
    if (catalog !== null && typeof catalog === 'object')
        snapshots.add(catalog);
    return catalog;
}
export function isCatalogSnapshot(catalog) {
    return snapshots.has(catalog);
}
