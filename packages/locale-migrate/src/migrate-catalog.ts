import { lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkProject, CompileError } from '@nordbeam/locale/internal/migrate';
import type { Catalog, Diagnostic } from '@nordbeam/locale/internal/migrate';
import { decodeMigrationCatalog } from './catalog-formats.js';
import { grouped } from './grouped-warnings.js';
import type { MigrationFormat } from './catalog-formats.js';
import { convertVueMessages } from './vue-i18n-messages.js';

export interface MigrationResult {
  ok: boolean;
  format: MigrationFormat;
  source: string;
  destination?: string;
  /** Where the notes were written, with `notes`. */
  notesDestination?: string;
  dryRun: boolean;
  output: string;
  /** Notes about the migrated messages, from source comments and descriptions, by message ID. */
  notes: Record<string, string>;
  messageCount: number;
  /** Every message ID the source holds, before renames: `migrationIdRenames` over the IDs of all locales gives renames that agree across catalogs. */
  ids: string[];
  /** IDs that could not nest as written, and the IDs they migrated as. */
  renamed: Record<string, string>;
  changed: string[];
  warnings: Diagnostic[];
  collisions: Array<{ code: string; message: string; path?: string }>;
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function fail(code: string, message: string, context: Partial<Diagnostic> = {}): never {
  throw new CompileError([{ code, message, ...context }]);
}

async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, { flag: 'wx' }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}

type MigrationLeaf = { id: string; path: string[]; value: string };
type MigrationInput = Record<string, unknown>;

const isObject = (value: unknown): value is MigrationInput =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function migrationWarning(code: string, message: string, hint?: string): Diagnostic {
  return { code, message, ...(hint ? { hint } : {}) };
}

/** IDs that cannot nest as written, and the IDs they migrate as. A nested catalog key is
 * a message or a namespace, never both, and a segment is never empty:
 * - an empty or space-edged segment is trimmed away, so the sentence ID
 *   `"Try again later."` becomes `"Try again later"`;
 * - an ID that is also the prefix of others (`toast` and `toast.action`) becomes `toast.message`.
 * An ID whose new name is taken keeps its name, and its collision is reported. Pass the IDs
 * of every locale, so all catalogs and the source codemod rename alike. */
export function migrationIdRenames(ids: Iterable<string>): Map<string, string> {
  const all = new Set(ids), renames = new Map<string, string>(), final = new Set(all);
  const move = (id: string, next: string): void => { final.delete(renames.get(id) ?? id); final.add(next); renames.set(id, next); };
  for (const id of all) {
    const segments = id.split('.');
    if (!segments.some(segment => !segment || segment !== segment.trim())) continue;
    const next = segments.map(segment => segment.trim()).filter(Boolean).join('.');
    if (next && next !== id && !final.has(next)) move(id, next);
  }
  const prefixes = new Set<string>();
  for (const id of final) { const parts = id.split('.'); for (let end = 1; end < parts.length; end++) prefixes.add(parts.slice(0, end).join('.')); }
  for (const id of all) {
    const current = renames.get(id) ?? id;
    if (prefixes.has(current) && !final.has(`${current}.message`)) move(id, `${current}.message`);
  }
  return renames;
}

/** Convert the common JSON forms emitted by i18next, next-intl and FormatJS.
 * This intentionally migrates catalogs only. Source calls are not rewritten:
 * APIs such as i18next's namespaces and interpolation options need semantic
 * review, and a lexical codemod could silently change runtime behavior. */
export async function migrateCatalog(options: {
  from: string;
  format: MigrationFormat;
  out?: string;
  /** Write the notes found in the source (comments, FormatJS and ARB descriptions) to this JSON file. */
  notes?: string;
  dryRun?: boolean;
  locale?: string;
  /** The catalog is the base locale's: a Lingui message without text takes its ID, as Lingui rendered it. */
  sourceLocale?: boolean;
  /** Renames to apply, from `migrationIdRenames` over every locale's IDs; by default, those this catalog's own IDs need. */
  idRenames?: ReadonlyMap<string, string>;
}): Promise<MigrationResult> {
  let decoded: Awaited<ReturnType<typeof decodeMigrationCatalog>>;
  try { decoded = await decodeMigrationCatalog(options.from, options.format, options.locale, { sourceLocale: options.sourceLocale }); }
  catch (error) { fail('MIGRATION_READ_ERROR', (error as Error).message, { file: resolve(options.from) }); }
  const parsed = decoded.value, traversal = decoded.traversal;
  const warnings: Diagnostic[] = [...decoded.warnings], collisions: Array<{ code: string; message: string; path?: string }> = [];
  const foundNotes: Record<string, string> = Object.assign(Object.create(null), decoded.notes);
  const leavesFound: MigrationLeaf[] = [];
  const seenIds = new Map<string, MigrationLeaf>();
  const droppedMetadata: string[] = [];
  const descriptor = (value: MigrationInput, id: string): string | undefined => {
    const source = typeof value.defaultMessage === 'string' ? value.defaultMessage : typeof value.message === 'string' ? value.message : undefined;
    if (source === undefined) return;
    if (typeof value.description === 'string' && value.description.trim()) foundNotes[id] = value.description;
    const metadata = Object.keys(value).filter(key => !['defaultMessage', 'message', 'description'].includes(key));
    if (metadata.length) droppedMetadata.push(id);
    if (value.message !== undefined && value.defaultMessage === undefined) warnings.push(migrationWarning('MIGRATION_MESSAGE_FIELD', `Used the non-standard message field for ${JSON.stringify(id)}.`));
    return source;
  };
  /** Split i18next text into literal/interpolation pieces and balanced `<name>` tags. Index tags such as <0> get the valid name tag0;
   * self-closing tags, attributes and unbalanced tags cannot be represented, so the message is skipped (undefined). */
  const markup = (text: string, id: string): Array<{ tag: string } | { text: string }> | undefined => {
    const pieces = text.split(/(<\/?[A-Za-z0-9_][^<>]*>)/);
    const stack: string[] = [], result: Array<{ tag: string } | { text: string }> = [], indexed = new Set<string>(), named = new Set<string>();
    const unsupported = (reason: string): undefined => {
      warnings.push(migrationWarning('I18NEXT_UNSUPPORTED_MARKUP', `Skipped ${JSON.stringify(id)}: ${reason}.`, 'Rewrite the message with paired rich-text tags such as <link>...</link> in the legacy catalog, or write the converted message by hand.'));
    };
    for (const [position, piece] of pieces.entries()) {
      if (position % 2 === 0) { if (piece) result.push({ text: piece }); continue; }
      const match = /^<(\/?)([A-Za-z0-9_][\w-]*)>$/.exec(piece);
      if (!match) return unsupported(`the tag ${piece} is self-closing or has attributes, which Nordbeam rich-text tags cannot express`);
      const closing = match[1] === '/', name = /^\d+$/.test(match[2]!) ? `tag${match[2]}` : match[2]!;
      (/^\d+$/.test(match[2]!) ? indexed : named).add(/^\d+$/.test(match[2]!) ? match[2]! : name);
      if (!closing) stack.push(name);
      else if (stack.pop() !== name) return unsupported(`the closing tag ${piece} does not match an open tag`);
      result.push({ tag: closing ? `</${name}>` : `<${name}>` });
    }
    if (stack.length) return unsupported(`the tag <${stack.at(-1)}> is never closed`);
    if (indexed.size) warnings.push(migrationWarning('I18NEXT_TRANS_INDEX', `Converted Trans index tags ${[...indexed].map(name => `<${name}>`).join(', ')} in ${JSON.stringify(id)} to ${[...indexed].map(name => `<tag${name}>`).join(', ')}.`, 'Render the message with rich() and pass one function per tag (tag0, tag1, ...), in place of the Trans components prop.'));
    if (named.size) warnings.push(migrationWarning('I18NEXT_RICH_TEXT', `Converted tags ${[...named].map(name => `<${name}>`).join(', ')} in ${JSON.stringify(id)} to ICU rich-text tags.`, 'Render the message with rich() and pass one function per tag; a plain call no longer returns the markup as text.'));
    return result;
  };
  const interpolate = (text: string, id: string): string | undefined => {
    if (/\$t\(/.test(text)) warnings.push(migrationWarning('I18NEXT_NESTING', `Kept i18next nesting $t(...) in ${JSON.stringify(id)} as literal text.`, 'Inline the referenced message or compose the two messages in code; nesting is not followed.'));
    const pieces = markup(text, id);
    if (!pieces) return undefined;
    const converted = pieces.map(piece => 'tag' in piece ? piece.tag
      : piece.text.split(/(\{\{[^{}]*\}\})/).map((part, index) => index % 2 === 1 ? convertPlaceholder(part, id) : escapeLiteral(part, id)).join(''));
    const result = converted.join('');
    if (/\{\{[^}]*\}\}/.test(result)) warnings.push(migrationWarning('MIGRATION_INTERPOLATION_REVIEW', `Could not fully convert an i18next interpolation in ${JSON.stringify(id)}.`, 'Only simple {{name}}, {{-name}} and common formatters are converted; review nested paths and other formatters.'));
    return result;
  };
  /** Literal i18next text becomes ICU text: apostrophes are doubled, braces, hashes and
   * tag-like `<` are quoted. Unbalanced braces are warned because i18next keeps them literal. */
  const escapeLiteral = (text: string, id: string): string => {
    if (/[{}]/.test(text)) warnings.push(migrationWarning('MIGRATION_LITERAL_BRACE', `Quoted literal brace text in ${JSON.stringify(id)}; i18next keeps single { and } as text.`, 'Confirm the text is meant to be literal. Use {{name}} for interpolation.'));
    return text
      .replace(/'/g, "''")
      .replace(/[{}#]/g, "'$&'")
      .replace(/<(?=\/?[A-Za-z])/g, "'<'");
  };
  const convertPlaceholder = (token: string, id: string): string => {
    const match = /^\{\{\s*(-?)([A-Za-z_$][\w$]*)\s*(?:,\s*([^{}]*?)\s*)?\}\}$/.exec(token);
    if (!match) return token;
    const name = match[2]!, format = match[3];
    if (match[1]) warnings.push(migrationWarning('MIGRATION_UNESCAPED_INTERPOLATION', `Converted unescaped i18next interpolation {{-${name}}} in ${JSON.stringify(id)}; review HTML escaping at the call site.`));
    if (format === undefined) return `{${name}}`;
    if (format === 'number') return `{${name}, number}`;
    if (format === 'datetime') return `{${name}, date}`;
    const currency = /^currency\(([A-Za-z]{3})\)$/.exec(format);
    if (currency) return `{${name}, number, ::currency/${currency[1]!.toUpperCase()}}`;
    const formatter = format.split('(')[0]!.trim();
    warnings.push(migrationWarning('I18NEXT_FORMATTER', `Kept i18next formatter ${JSON.stringify(formatter)} on {{${name}}} in ${JSON.stringify(id)} as a plain argument.`, `Format ${name} in code, or declare a matching Nordbeam format and reference it.`));
    return `{${name}}`;
  };
  function visit(value: unknown, path: string[], format: 'i18next' | 'vue-i18n' | 'next-intl' | 'formatjs'): void {
    const id = path.join('.');
    if (typeof value === 'string') {
      const converted = format === 'i18next' ? interpolate(value, id) : value;
      if (converted === undefined) return;
      const leaf = { id, path, value: converted };
      const previous = seenIds.get(id);
      if (previous) collisions.push({ code: 'MIGRATION_ID_COLLISION', path: id, message: `Input contains both nested and flat values for ${JSON.stringify(id)}.` });
      else { seenIds.set(id, leaf); leavesFound.push(leaf); }
      return;
    }
    if (!isObject(value)) {
      collisions.push({ code: 'MIGRATION_UNSUPPORTED_VALUE', path: id, message: `Cannot migrate ${JSON.stringify(id || '(root)')}: expected a string or nested object.` });
      return;
    }
    const descriptorLike = Object.hasOwn(value, 'defaultMessage') || Object.hasOwn(value, 'message')
      || (format === 'formatjs' && Object.keys(value).length > 0 && Object.keys(value).every(key => ['id', 'description', 'file', 'source', 'module'].includes(key)));
    if (format !== 'i18next' && descriptorLike) {
      const text = descriptor(value, id);
      if (text !== undefined) { visit(text, path, format); return; }
      if (format === 'formatjs') {
        collisions.push({ code: 'MIGRATION_UNSUPPORTED_DESCRIPTOR', path: id, message: `FormatJS descriptor ${JSON.stringify(id)} has no string defaultMessage.` });
        return;
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (!key) { collisions.push({ code: 'MIGRATION_INVALID_KEY', path: id, message: 'Message keys must not be empty.' }); continue; }
      visit(child, [...path, key], format);
    }
  }
  visit(parsed, [], traversal);
  if (droppedMetadata.length) warnings.push(grouped('MIGRATION_METADATA_DROPPED', droppedMetadata, (count, examples) => `Dropped FormatJS metadata (fields other than defaultMessage and description) from ${count} message${count === 1 ? '' : 's'}${examples}.`, 'Nordbeam catalogs store message text; descriptions become notes with --notes.'));
  if (traversal === 'vue-i18n') {
    const converted = convertVueMessages(leavesFound, options.locale, warnings);
    for (let index = leavesFound.length - 1; index >= 0; index--) {
      const leaf = leavesFound[index]!, value = converted.get(leaf.id);
      if (value === undefined) leavesFound.splice(index, 1);
      else leaf.value = value;
    }
  }
  if (traversal === 'i18next') {
    const byId = new Map(leavesFound.map(leaf => [leaf.id, leaf]));
    const consumed = new Set<string>();
    const mergedIds = new Set<string>();
    const pluralSuffix = /^(.+?)_(ordinal_)?(zero|one|two|few|many|other|plural)$/;
    const contextBases = new Set<string>();
    for (const leaf of leavesFound) {
      const separator = leaf.id.lastIndexOf('_'), base = leaf.id.slice(0, separator);
      if (separator <= 0 || pluralSuffix.test(leaf.id) || !byId.has(base) || contextBases.has(base)) continue;
      contextBases.add(base);
      warnings.push(migrationWarning('I18NEXT_CONTEXT', `Migrated i18next context variants ${JSON.stringify(leaf.id)} of ${JSON.stringify(base)} as separate messages.`, `Use one message with a select on a context argument, e.g. {gender, select, female {...} male {...} other {...}}, and pass the context from code.`));
    }
    for (const leaf of [...leavesFound]) {
      if (consumed.has(leaf.id)) continue;
      const match = pluralSuffix.exec(leaf.id);
      if (!match) continue;
      const base = match[1]!, ordinal = match[2] !== undefined, variants = new Map<string, MigrationLeaf>();
      // i18next v4 uses _zero for count 0 in every language, so it is an exact match.
      const branch = (category: string): string => category === 'plural' ? 'other' : category === 'zero' && !ordinal ? '=0' : category;
      for (const candidate of leavesFound) {
        const candidateMatch = pluralSuffix.exec(candidate.id);
        if (candidateMatch?.[1] === base && (candidateMatch[2] !== undefined) === ordinal) variants.set(branch(candidateMatch[3]!), candidate);
      }
      // Ordinal plurals never reuse the cardinal base message as their "other" branch.
      const mergedId = ordinal ? `${base}_ordinal` : base;
      const fallback = ordinal ? undefined : byId.get(base);
      if (fallback) variants.set('other', fallback);
      if (variants.size < 2 || (ordinal && !variants.has('other'))) {
        warnings.push(migrationWarning('MIGRATION_UNPAIRED_PLURAL', `Kept i18next plural-like key ${JSON.stringify(leaf.id)} unchanged because no matching variant was found.`, ordinal ? 'Ordinal plurals need an _ordinal_other variant.' : 'Pair _one/_other (or the locale-specific categories) before migrating.'));
        continue;
      }
      const basePath = fallback?.path ?? leaf.path.slice(0, -1).concat(`${base.split('.').at(-1)!}${ordinal ? '_ordinal' : ''}`);
      if (ordinal) warnings.push(migrationWarning('MIGRATION_ORDINAL_ID', `Migrated i18next ordinal plurals of ${JSON.stringify(base)} to message ${JSON.stringify(mergedId)}.`, `Call t(${JSON.stringify(mergedId)}) with the ordinal count; the migration does not rewrite source calls.`));
      const body = [...variants].sort(([a], [b]) => a === 'other' ? 1 : b === 'other' ? -1 : compare(a, b)).map(([category, item]) => `${category} {${item.value}}`).join(' ');
      const merged = { id: mergedId, path: basePath, value: `{count, ${ordinal ? 'selectordinal' : 'plural'}, ${body}}` };
      const existing = byId.get(mergedId);
      if (existing && existing.path.join('.') !== basePath.join('.')) collisions.push({ code: 'MIGRATION_ID_COLLISION', path: mergedId, message: `Plural variants collide with existing message ${JSON.stringify(mergedId)}.` });
      else {
        if (existing) consumed.add(existing.id);
        for (const item of variants.values()) consumed.add(item.id);
        byId.set(mergedId, merged); leavesFound.push(merged);
        mergedIds.add(mergedId);
      }
    }
    for (let index = leavesFound.length - 1; index >= 0; index--) if (consumed.has(leavesFound[index]!.id) && !mergedIds.has(leavesFound[index]!.id)) leavesFound.splice(index, 1);
  }
  const outputRoot: MigrationInput = Object.create(null);
  const ids = [...new Set(leavesFound.map(leaf => leaf.id))];
  const renames = options.idRenames ?? migrationIdRenames(ids);
  const renamed: Record<string, string> = Object.create(null);
  for (const leaf of leavesFound) {
    const next = renames.get(leaf.id);
    if (next === undefined) continue;
    renamed[leaf.id] = next;
    if (Object.hasOwn(foundNotes, leaf.id)) { foundNotes[next] = foundNotes[leaf.id]!; delete foundNotes[leaf.id]; }
    leaf.id = next;
  }
  const renamedIds = Object.keys(renamed).sort(compare);
  if (renamedIds.length) warnings.push({ ...grouped('MIGRATION_ID_RENAMED', renamedIds, count => `Renamed ${count} message ID${count === 1 ? '' : 's'} that cannot nest as written: ${renamedIds.slice(0, 3).map(id => `${JSON.stringify(id)} → ${JSON.stringify(renamed[id])}`).join(', ')}${count > 3 ? ', …' : ''}.`,
    'A nested key is a message or a namespace, never both, and never empty. migrate-project rewrites the calls to these IDs; after migrate alone, rename them in the source.'), renamed: { ...renamed } } as Diagnostic);
  const outputLeaves = [...new Map(leavesFound.map(leaf => [leaf.id, leaf])).values()].sort((a, b) => compare(a.id, b.id));
  for (const leaf of outputLeaves) {
    const path = leaf.id.split('.');
    let node = outputRoot;
    let layoutConflict = false;
    for (const key of path.slice(0, -1)) {
      const existing = node[key];
      if (typeof existing === 'string') { collisions.push({ code: 'MIGRATION_LAYOUT_COLLISION', path: leaf.id, message: `Cannot place ${JSON.stringify(leaf.id)} because ${JSON.stringify(key)} is already a message.` }); layoutConflict = true; break; }
      if (!isObject(existing)) node[key] = Object.create(null);
      node = node[key] as MigrationInput;
    }
    if (layoutConflict) continue;
    const key = path.at(-1)!;
    if (Object.hasOwn(node, key)) collisions.push({ code: 'MIGRATION_ID_COLLISION', path: leaf.id, message: `Output contains duplicate message ID ${JSON.stringify(leaf.id)}.` });
    else node[key] = leaf.value;
  }
  const validation = checkProject({ baseLocale: 'en', catalogs: { en: outputRoot as Catalog } });
  for (const diagnostic of validation.errors) collisions.push({
    code: `MIGRATION_${diagnostic.code}`,
    message: diagnostic.message,
    ...(diagnostic.messageId ? { path: diagnostic.messageId } : {}),
  });
  const output = JSON.stringify(outputRoot, null, 2) + '\n';
  // Notes of messages that plural merging consumed have no message left to describe.
  const outputIds = new Set(outputLeaves.map(leaf => leaf.id));
  const notes: Record<string, string> = Object.create(null);
  for (const id of Object.keys(foundNotes).sort(compare)) if (outputIds.has(id)) notes[id] = foundNotes[id]!;
  const noteCount = Object.keys(notes).length;
  if (noteCount && !options.notes) warnings.push(migrationWarning('MIGRATION_METADATA_DROPPED', `Dropped ${noteCount} note${noteCount === 1 ? '' : 's'} from source comments and descriptions.`, 'Pass --notes <file> to keep them in a notes file, and set "notes" in the config.'));
  const changed: string[] = [];
  const destination = options.out ? resolve(options.out) : undefined;
  const notesDestination = options.notes && noteCount ? resolve(options.notes) : undefined;
  const absent = async (file: string): Promise<boolean> => {
    try { await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
    collisions.push({ code: 'MIGRATION_OUTPUT_EXISTS', path: file, message: `Refusing to overwrite existing migration output ${file}.` });
    return false;
  };
  if (collisions.length === 0 && (destination || notesDestination)) {
    const writable = [destination && await absent(destination), notesDestination && await absent(notesDestination)];
    if (!writable.includes(false) && !options.dryRun) {
      if (destination) { await atomicWrite(destination, output); changed.push(destination); }
      if (notesDestination) { await atomicWrite(notesDestination, JSON.stringify(notes, null, 2) + '\n'); changed.push(notesDestination); }
    }
  }
  return { ok: collisions.length === 0, format: options.format, source: resolve(options.from), ...(destination ? { destination } : {}),
    ...(notesDestination ? { notesDestination } : {}), dryRun: options.dryRun === true, output, notes, messageCount: outputLeaves.length, ids, renamed: { ...renamed }, changed, warnings, collisions };
}
