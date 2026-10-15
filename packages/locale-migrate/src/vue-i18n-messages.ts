import type { Diagnostic } from '@nordbeam/locale/internal/migrate';

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'named'; name: string }
  | { kind: 'list'; index: number }
  | { kind: 'link'; key: string; modifier?: string };

export interface VueMessageLeaf { id: string; value: string }

const warning = (code: string, message: string, hint?: string): Diagnostic => ({ code, message, ...(hint ? { hint } : {}) });

/** Thrown for syntax whose runtime meaning cannot be reproduced in ICU. */
class Unconvertible extends Error {}

/** Split a vue-i18n message into pipe-separated forms of text, argument and link nodes.
 * Special characters are { } @ |; they are escaped as {'|'} literals or, since vue-i18n 11.3, \| \{ \} \@ \\. */
function parse(source: string): Node[][] {
  const forms: Node[][] = [[]];
  let text = '';
  const flush = (): void => { if (text) forms.at(-1)!.push({ kind: 'text', text }); text = ''; };
  for (let index = 0; index < source.length;) {
    const rest = source.slice(index), char = source[index]!;
    if (char === '\\' && /^\\[{}@|\\]/.test(rest)) { text += rest[1]; index += 2; continue; }
    if (char === '%' && rest.startsWith('%{')) throw new Unconvertible('legacy %{name} interpolation');
    if (char === '{') {
      const literal = /^\{\s*'((?:[^'\\]|\\.)*)'\s*\}/.exec(rest);
      if (literal) { text += literal[1]!.replace(/\\(.)/g, '$1'); index += literal[0].length; continue; }
      const list = /^\{\s*(\d+)\s*\}/.exec(rest);
      if (list) { flush(); forms.at(-1)!.push({ kind: 'list', index: Number(list[1]) }); index += list[0].length; continue; }
      const named = /^\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(rest);
      if (named) { flush(); forms.at(-1)!.push({ kind: 'named', name: named[1]! }); index += named[0].length; continue; }
      throw new Unconvertible(`the brace expression ${JSON.stringify(rest.slice(0, rest.indexOf('}') + 1 || 12))}`);
    }
    if (char === '@') {
      const head = /^@(?:\.([A-Za-z]\w*))?:/.exec(rest);
      if (head) {
        const tail = rest.slice(head[0].length);
        const quoted = /^\(([\w.-]+)\)/.exec(tail) ?? /^\{\s*'([^']+)'\s*\}/.exec(tail);
        const bare = quoted ? undefined : /^[\w.-]*\w/.exec(tail);
        const matched = quoted ?? bare;
        const name = quoted?.[1] ?? bare?.[0];
        if (!matched || !name) throw new Unconvertible('a linked message whose key is computed');
        flush();
        forms.at(-1)!.push({ kind: 'link', key: name, ...(head[1] ? { modifier: head[1] } : {}) });
        index += head[0].length + matched[0].length;
        continue;
      }
    }
    if (char === '|') { flush(); forms.push([]); index++; continue; }
    text += char; index++;
  }
  flush();
  return forms;
}

/** Literal text becomes ICU text: apostrophes doubled, braces quoted, tag-like `<` quoted, and # quoted inside plural branches. */
function icuLiteral(text: string, inPlural: boolean): string {
  return text.replace(/'/g, "''").replace(/[{}]/g, "'$&'").replace(/#/g, inPlural ? "'#'" : '#').replace(/<(?=\/?[A-Za-z])/g, "'<'");
}

const applyModifier = (modifier: string, text: string, locale: string | undefined): string => {
  if (modifier === 'upper') return text.toLocaleUpperCase(locale);
  if (modifier === 'lower') return text.toLocaleLowerCase(locale);
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
};

/** Convert vue-i18n message text to ICU. Constructs with no faithful ICU equivalent are skipped, never copied. */
export function convertVueMessages(leaves: readonly VueMessageLeaf[], locale: string | undefined, warnings: Diagnostic[]): Map<string, string> {
  const raw = new Map(leaves.map(leaf => [leaf.id, leaf.value]));
  const output = new Map<string, string>();
  const modifiers = ['upper', 'lower', 'capitalize'];
  for (const leaf of leaves) {
    try {
      const forms = parse(leaf.value);
      const lists = new Set<number>(), names = new Set<string>();
      let linked = false;
      // A plain link copies the referenced nodes; a modifier is applied only to fixed text.
      const expand = (nodes: Node[]): Node[] => nodes.flatMap((node): Node[] => {
        if (node.kind !== 'link') return [node];
        linked = true;
        const source = raw.get(node.key);
        if (source === undefined) throw new Unconvertible(`a link to ${JSON.stringify(node.key)}, which is not defined in this catalog`);
        if (node.modifier && !modifiers.includes(node.modifier)) throw new Unconvertible(`the custom link modifier @.${node.modifier}`);
        const target = parse(source);
        if (target.length > 1) throw new Unconvertible(`a link to the pipe plural ${JSON.stringify(node.key)}`);
        if (target[0]!.some(item => item.kind === 'link')) throw new Unconvertible(`a link to ${JSON.stringify(node.key)}, which itself contains a link (nested or cyclic links)`);
        if (!node.modifier) return target[0]!;
        if (!target[0]!.every(item => item.kind === 'text')) throw new Unconvertible(`the modifier @.${node.modifier} on a message with arguments`);
        const text = target[0]!.map(item => (item as { text: string }).text).join('');
        return [{ kind: 'text', text: applyModifier(node.modifier, text, locale) }];
      });
      const expanded = forms.map(expand);
      for (const form of expanded) for (const node of form) {
        if (node.kind === 'list') lists.add(node.index);
        if (node.kind === 'named') names.add(node.name);
      }
      const plural = expanded.length > 1;
      if (expanded.length > 3) throw new Unconvertible(`${expanded.length} pipe-separated forms (the default rule only defines 2 or 3, so this needs a custom pluralization rule)`);
      const selector = names.has('n') && !names.has('count') ? 'n' : 'count';
      const render = (form: Node[]): string => {
        const text = form.map(node => {
          if (node.kind === 'text') return icuLiteral(node.text, plural);
          if (node.kind === 'list') return `{arg${node.index}}`;
          if (node.kind === 'named') return `{${plural && (node.name === 'n' || node.name === 'count') ? selector : node.name}}`;
          return '';
        }).join('');
        return plural ? text.trim() : text;
      };
      let value: string;
      if (!plural) value = render(expanded[0]!);
      else {
        // vue-i18n's default rule: 2 forms pick the first only for |count| of 1 (0 is plural); 3 forms pick by 0, 1 and everything else.
        const bodies = expanded.map(render);
        const branches = bodies.length === 2 ? [['=1', bodies[0]!], ['other', bodies[1]!]] : [['=0', bodies[0]!], ['=1', bodies[1]!], ['other', bodies[2]!]];
        value = `{${selector}, plural, ${branches.map(([key, body]) => `${key} {${body}}`).join(' ')}}`;
        warnings.push(warning('VUE_I18N_PIPE_PLURAL', `Converted the vue-i18n pipe plural in ${JSON.stringify(leaf.id)} to an ICU plural on {${selector}}.`, `Pass the number as {${selector}: n} at call sites; vue-i18n supplied it implicitly from the second argument of $t.`));
      }
      const ordered = [...lists].sort((a, b) => a - b);
      if (ordered.length) warnings.push(warning('VUE_I18N_LIST_INTERPOLATION', `Converted list placeholders ${ordered.map(index => `{${index}}`).join(', ')} in ${JSON.stringify(leaf.id)} to named arguments ${ordered.map(index => `{arg${index}}`).join(', ')}.`, 'Call sites that passed an array must pass an object such as { arg0: value }; rename the arguments if you want clearer names.'));
      if (linked) warnings.push(warning('VUE_I18N_LINK_INLINED', `Inlined the linked messages in ${JSON.stringify(leaf.id)}.`, 'The text is copied, so later edits to the linked message do not propagate.'));
      output.set(leaf.id, value);
    } catch (error) {
      if (!(error instanceof Unconvertible)) throw error;
      warnings.push(warning('VUE_I18N_UNSUPPORTED_SYNTAX', `Skipped ${JSON.stringify(leaf.id)}: it uses ${error.message}, which has no faithful ICU conversion.`, 'Write this message by hand in the migrated catalog (an ICU plural, or compose messages in code), then run check.'));
    }
  }
  return output;
}
