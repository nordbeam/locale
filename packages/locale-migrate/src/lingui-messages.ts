import { parseIcuMessage } from '@nordbeam/locale/internal/migrate';
import type { IcuMessageElement } from '@nordbeam/locale/internal/migrate';

/**
 * Lingui 3 catalogs hold ICU as messageformat-parser reads it, which is not quite what
 * Nordbeam (FormatJS) reads:
 * - an apostrophe starts quoted text only before `{`, `}` or, in a plural, `#`; FormatJS
 *   also quotes before `<` and `>`, so `it'<br/>` would lose its apostrophe;
 * - `<0>…</0>` and `<0/>` are literal text that `<Trans>` turns into its numbered
 *   components, and other HTML (`<br/>`, `<a href="…">`) stays text on the page. FormatJS
 *   reads both as rich-text tags.
 * So each message is decoded the way Lingui reads it and printed again for FormatJS:
 * numbered tags become `<tag0>` tags, and a run of literal HTML becomes one quoted literal
 * (`'<br/><br/>'`, never `'<br/>''<br/>'`, which is a single quoted run holding an
 * escaped apostrophe).
 */
export type LinguiNode =
  | { readonly kind: 'text'; value: string }
  | { readonly kind: 'pound' }
  | { readonly kind: 'argument'; readonly name: string; readonly type?: string; readonly style?: string }
  | { readonly kind: 'branches'; readonly name: string; readonly type: 'plural' | 'selectordinal' | 'select'; readonly offset?: string; readonly cases: ReadonlyArray<readonly [string, LinguiNode[]]> };

export interface LinguiConversion {
  /** The message as Nordbeam reads it. */
  readonly text: string;
  /** Lingui 3 trims what a message with arguments renders (`interpolate` returns `result.trim()`); the conversion trims it too. */
  readonly trimmed: boolean;
  /** The text the conversion changed, when the converted message does not read back as the source did. */
  readonly changed?: { readonly source: string; readonly converted: string };
}

/** Decode Lingui ICU (messageformat-parser 4, DOUBLE_OPTIONAL apostrophes, `#` special in nested plural statements). */
export function decodeLinguiMessage(source: string): LinguiNode[] {
  let index = 0;
  const fail = (reason: string): never => { throw new SyntaxError(`${reason} at offset ${index}`); };
  const space = (): void => { while (/\s/.test(source[index] ?? '')) index++; };
  const word = (stop: RegExp): string => {
    const start = index;
    while (index < source.length && !stop.test(source[index]!)) index++;
    return source.slice(start, index);
  };
  const message = (inPlural: boolean, nested: boolean): LinguiNode[] => {
    const nodes: LinguiNode[] = [];
    let text = '';
    const flush = (): void => { if (text) nodes.push({ kind: 'text', value: text }); text = ''; };
    while (index < source.length) {
      const char = source[index]!;
      if (char === '}') { if (nested) break; fail('Unmatched }'); }
      if (char === '{') { flush(); nodes.push(argument(inPlural)); continue; }
      if (char === '#' && inPlural) { flush(); nodes.push({ kind: 'pound' }); index++; continue; }
      if (char === "'") {
        const next = source[index + 1];
        if (next === "'") { text += "'"; index += 2; continue; }
        if (next === '{' || next === '}' || (next === '#' && inPlural)) {
          // Quoted literal text up to the next lone apostrophe; an unterminated quote runs to the end.
          for (index++; index < source.length;) {
            if (source[index] === "'") {
              if (source[index + 1] === "'") { text += "'"; index += 2; continue; }
              index++;
              break;
            }
            text += source[index++];
          }
          continue;
        }
      }
      text += char;
      index++;
    }
    flush();
    return nodes;
  };
  const argument = (inPlural: boolean): LinguiNode => {
    index++;
    space();
    const name = word(/[\s,}{]/);
    if (!name) fail('Empty argument');
    space();
    if (source[index] === '}') { index++; return { kind: 'argument', name }; }
    if (source[index] !== ',') fail(`Expected , or } after ${name}`);
    index++;
    space();
    const type = word(/[\s,}{]/);
    space();
    if (type === 'plural' || type === 'selectordinal' || type === 'select') {
      if (source[index] !== ',') fail(`Expected , after ${type}`);
      index++;
      space();
      let offset: string | undefined;
      if (type !== 'select' && source.startsWith('offset:', index)) {
        index += 'offset:'.length;
        space();
        offset = word(/[\s{}]/);
      }
      const cases: Array<readonly [string, LinguiNode[]]> = [];
      for (;;) {
        space();
        if (index >= source.length) fail(`Unclosed ${type}`);
        if (source[index] === '}') { index++; break; }
        const key = word(/[\s{}]/);
        space();
        if (!key || source[index] !== '{') fail(`Expected { after case ${key}`);
        index++;
        const body = message(inPlural || type !== 'select', true);
        if (source[index] !== '}') fail(`Unclosed case ${key}`);
        index++;
        cases.push([key, body]);
      }
      return { kind: 'branches', name, type, ...(offset !== undefined ? { offset } : {}), cases };
    }
    if (source[index] === '}') { index++; return { kind: 'argument', name, type }; }
    if (source[index] !== ',') fail(`Expected , or } after ${type}`);
    index++;
    // In a style every apostrophe starts or ends quoted text, and braces nest.
    const start = index;
    let depth = 0, quoted = false;
    for (; index < source.length; index++) {
      const char = source[index]!;
      if (char === "'") quoted = !quoted;
      else if (!quoted && char === '{') depth++;
      else if (!quoted && char === '}') { if (depth === 0) break; depth--; }
    }
    if (index >= source.length) fail(`Unclosed argument ${name}`);
    const style = source.slice(start, index).trim();
    index++;
    return { kind: 'argument', name, type, style };
  };
  return message(false, false);
}

/** Lingui renders a compiled message (one with an argument) trimmed, and a plain-text message as written. */
function trimLikeLingui(nodes: LinguiNode[]): boolean {
  if (!nodes.some(node => node.kind !== 'text')) return false;
  let trimmed = false;
  const first = nodes[0], last = nodes.at(-1);
  if (first?.kind === 'text' && first.value !== first.value.trimStart()) { first.value = first.value.trimStart(); trimmed = true; }
  if (last?.kind === 'text' && last.value !== last.value.trimEnd()) { last.value = last.value.trimEnd(); trimmed = true; }
  if (first?.kind === 'text' && !first.value) nodes.shift();
  if (nodes.at(-1)?.kind === 'text' && !(nodes.at(-1) as { value: string }).value) nodes.pop();
  return trimmed;
}

const numberedTag = /<(\/?)(\d+)(\/?)>/g;
// Literal HTML for FormatJS: anything `<` followed by a letter, `/` or `!` up to the next `>`.
const literalTag = /<[A-Za-z/!][^<>]*>/y;

/** Literal text for FormatJS. Characters FormatJS would read as syntax go in quoted runs, and
 * neighbouring runs merge, so an apostrophe never joins two runs. Lone apostrophes are marked
 * and resolved once the whole message is printed, when what follows them is known. */
function literal(raw: string, inPlural: boolean): string {
  let out = '', run: string | undefined;
  const close = (): void => { if (run !== undefined) out += `'${run}'`; run = undefined; };
  const quote = (text: string): void => { run = (run ?? '') + text.replace(/'/g, "''"); };
  for (let index = 0; index < raw.length;) {
    const char = raw[index]!;
    if (char === '<') {
      literalTag.lastIndex = index;
      const tag = literalTag.exec(raw);
      if (tag) { quote(tag[0]); index += tag[0].length; continue; }
      // A `<` FormatJS would start a tag with, without a closing `>`.
      if (/[A-Za-z/!]/.test(raw[index + 1] ?? '')) { quote('<'); index++; continue; }
    }
    if (char === '{' || char === '}' || (char === '#' && inPlural)) { quote(char); index++; continue; }
    if (char === "'") {
      // Inside a run, or right before something that starts one, the apostrophe joins it.
      if (run !== undefined) { quote("'"); index++; continue; }
      out += '\u0000';
      index++;
      continue;
    }
    close();
    out += char;
    index++;
  }
  close();
  return out;
}

function printText(raw: string, inPlural: boolean): string {
  let out = '', last = 0;
  for (const match of raw.matchAll(numberedTag)) {
    out += literal(raw.slice(last, match.index), inPlural);
    const [, closing, number, selfClosing] = match;
    out += selfClosing ? (closing ? `</tag${number}>` : `<tag${number}></tag${number}>`) : `<${closing}tag${number}>`;
    last = match.index! + match[0].length;
  }
  return out + literal(raw.slice(last), inPlural);
}

function print(nodes: readonly LinguiNode[], inPlural: boolean): string {
  return nodes.map(node => {
    if (node.kind === 'text') return printText(node.value, inPlural);
    if (node.kind === 'pound') return '#';
    if (node.kind === 'argument') return `{${node.name}${node.type ? `, ${node.type}` : ''}${node.style ? `, ${node.style}` : ''}}`;
    const plural = inPlural || node.type !== 'select';
    const cases = node.cases.map(([key, body]) => `${key} {${print(body, plural)}}`).join(' ');
    return `{${node.name}, ${node.type}, ${node.offset !== undefined ? `offset:${node.offset} ` : ''}${cases}}`;
  }).join('');
}

/** A FormatJS message from Lingui nodes. Marked apostrophes are doubled where FormatJS would
 * otherwise read them as the start of quoted text. */
export function printLinguiNodes(nodes: readonly LinguiNode[]): string {
  return print(nodes, false).replace(/\u0000(?=[{}<>'#\u0000])/g, "''").replace(/\u0000/g, "'");
}

/** What a message shows, for comparing a source with its conversion: text as it renders,
 * numbered tags as `<0>…</0>`, arguments as `{name}`, and plural and select branches. */
function linguiVisible(nodes: readonly LinguiNode[]): string {
  return nodes.map(node => {
    if (node.kind === 'text') return node.value.replace(/<(\d+)\/>/g, '<$1></$1>');
    if (node.kind === 'pound') return '#';
    if (node.kind === 'argument') return `{${node.name}}`;
    return `{${node.name}|${node.cases.map(([key, body]) => `${key}:${linguiVisible(body)}`).join('|')}}`;
  }).join('');
}

function icuVisible(elements: readonly IcuMessageElement[]): string {
  return elements.map(element => {
    const node = element as unknown as { type: number; value: string; children?: IcuMessageElement[]; options?: Record<string, { value: IcuMessageElement[] }> };
    switch (node.type) {
      case 0: return node.value;
      case 7: return '#';
      case 8: { const name = /^tag(\d+)$/.exec(node.value)?.[1] ?? node.value; return `<${name}>${icuVisible(node.children ?? [])}</${name}>`; }
      case 5: case 6: return `{${node.value}|${Object.entries(node.options ?? {}).map(([key, option]) => `${key}:${icuVisible(option.value)}`).join('|')}}`;
      default: return `{${node.value}}`;
    }
  }).join('');
}

/** Convert one Lingui message to the ICU Nordbeam reads, and check that it reads back as the source did. */
export function convertLinguiMessage(source: string): LinguiConversion {
  return convertLinguiNodes(decodeLinguiMessage(source));
}

export function convertLinguiNodes(nodes: LinguiNode[]): LinguiConversion {
  const trimmed = trimLikeLingui(nodes);
  const text = printLinguiNodes(nodes);
  const expected = linguiVisible(nodes);
  let converted: string;
  try { converted = icuVisible(parseIcuMessage(text)); }
  catch (error) { converted = `(invalid ICU: ${(error as Error).message})`; }
  return { text, trimmed, ...(converted === expected ? {} : { changed: { source: expected, converted } }) };
}
