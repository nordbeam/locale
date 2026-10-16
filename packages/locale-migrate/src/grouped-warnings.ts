import type { Diagnostic } from 'nordbeam-locale/internal/migrate';

/** A warning about many messages at once: `count` of them, every ID in `messageIds`. */
export type GroupedDiagnostic = Diagnostic & { readonly count: number; readonly messageIds: readonly string[] };

/** One warning per code and catalog instead of one per message: thousands of identical
 * lines (a dotted ID, a dropped reference comment) hid the warnings that needed a person. */
export function grouped(code: string, ids: readonly string[], message: (count: number, examples: string) => string, hint?: string): GroupedDiagnostic {
  const examples = `: ${ids.slice(0, 3).map(id => JSON.stringify(id)).join(', ')}${ids.length > 3 ? ', …' : ''}`;
  return { code, message: message(ids.length, examples), ...(hint ? { hint } : {}), count: ids.length, messageIds: [...ids] };
}

/** Source-locale messages without text, an empty msgstr or one only translations hold: Lingui
 * rendered the ID there, so the ID becomes the text. One warning covers both. */
export function linguiSourceIdWarning(ids: readonly string[]): GroupedDiagnostic {
  return grouped('LINGUI_SOURCE_ID_TEXT', ids, (count, examples) => `${count} message${count === 1 ? '' : 's'} of the source locale had no text; each takes its ID as text, which is what Lingui rendered${examples}.`,
    'Write the text these messages should show. Where the ID is a key, pages showed the key.');
}
