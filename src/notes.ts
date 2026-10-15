import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { CompileError } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';

/** Translator notes by message ID. */
export type Notes = Readonly<Record<string, string>>;

/**
 * The notes file is shaped like a catalog, nested or with dotted keys, and its strings
 * describe the messages for translators and developers: where the text appears, what an
 * argument holds, or that legal must review a change. Catalogs keep message text only.
 */
export function parseNotes(text: string, file?: string): Notes {
  const fail = (message: string, messageId?: string): never => {
    throw new CompileError([{ code: 'INVALID_NOTES', message, ...(file ? { file } : {}), ...(messageId ? { messageId } : {}) }]);
  };
  let value: unknown;
  try { value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); }
  catch (error) { return fail(`The notes file is not valid JSON: ${(error as Error).message}`); }
  const notes: Record<string, string> = Object.create(null);
  const visit = (node: unknown, prefix: string): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return fail('Expected an object of note strings or nested objects.', prefix || undefined);
    for (const [key, entry] of Object.entries(node)) {
      const id = prefix ? `${prefix}.${key}` : key;
      if (typeof entry === 'string') { if (entry.trim()) notes[id] = entry; }
      else visit(entry, id);
    }
  };
  visit(value, '');
  return notes;
}

/** The notes file a project configures, resolved against its root. */
export function notesFile(options: { readonly root?: string; readonly notes?: string; readonly catalogs?: string }): string | undefined {
  if (options.notes === undefined) return;
  const root = resolve(options.root ?? '.');
  const file = resolve(root, options.notes);
  const fromCatalogs = relative(resolve(root, options.catalogs ?? 'messages'), file);
  // Every .json file in the catalog directory is read as a locale.
  if (!fromCatalogs.startsWith('..') && !isAbsolute(fromCatalogs) && !fromCatalogs.includes('/') && !fromCatalogs.includes('\\')) {
    throw new CompileError([{ code: 'INVALID_NOTES', message: 'The notes file cannot be in the catalog directory, where every .json file is a locale.', file }]);
  }
  return file;
}

export async function readNotes(options: { readonly root?: string; readonly notes?: string; readonly catalogs?: string },
  read: (file: string) => Promise<string> = file => readFile(file, 'utf8')): Promise<Notes | undefined> {
  const file = notesFile(options);
  if (!file) return;
  let text: string;
  try { text = await read(file); }
  catch (error) { throw new CompileError([{ code: 'INVALID_NOTES', message: `The notes file cannot be read: ${(error as Error).message}`, file }]); }
  return parseNotes(text, file);
}

/** The message IDs of a catalog, nested or dotted. */
export function catalogIds(catalog: object): Set<string> {
  const ids = new Set<string>();
  const visit = (node: object, prefix: string): void => {
    for (const [key, entry] of Object.entries(node)) {
      const id = prefix ? `${prefix}.${key}` : key;
      if (typeof entry === 'string') ids.add(id);
      else if (entry && typeof entry === 'object' && !Array.isArray(entry)) visit(entry, id);
    }
  };
  visit(catalog, '');
  return ids;
}

/** Notes whose message is gone, usually after a rename. */
export function unknownNotes(notes: Notes | undefined, ids: ReadonlySet<string>, file?: string): Diagnostic[] {
  if (!notes) return [];
  return Object.keys(notes).filter(id => !ids.has(id)).sort().map(id => ({
    code: 'UNKNOWN_NOTE', message: 'This note describes a message that is not in the base catalog.', messageId: id, ...(file ? { file } : {}),
  }));
}
