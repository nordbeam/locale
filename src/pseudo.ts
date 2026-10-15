import { isLiteralElement, parse, TYPE } from '@formatjs/icu-messageformat-parser';
import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import type { Catalog } from './compiler.js';

const accented: Record<string, string> = {
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Đ', E: 'Ë', F: 'Ƒ', G: 'Ĝ', H: 'Ħ', I: 'Ï', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ř', S: 'Š', T: 'Ŧ', U: 'Ü', V: 'Ṽ', W: 'Ŵ', X: 'Ẍ', Y: 'Ÿ', Z: 'Ž',
  a: 'å', b: 'ƀ', c: 'ç', d: 'đ', e: 'ë', f: 'ƒ', g: 'ĝ', h: 'ħ', i: 'ï', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ṁ', n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ř', s: 'š', t: 'ŧ', u: 'ü', v: 'ṽ', w: 'ŵ', x: 'ẍ', y: 'ÿ', z: 'ž',
};

function escapeIcuLiteral(value: string): string {
  return value.replaceAll("'", "''").replace(/[{}#<>]/g, match => `'${match}'`);
}

function transformLiteral(value: string, expansion: number): string {
  if (!/\p{L}/u.test(value)) return value;
  const transformed = [...value].map(character => accented[character] ?? character).join('');
  const letters = [...value].filter(character => /\p{L}/u.test(character)).length;
  return `［${transformed}${'·'.repeat(Math.ceil(letters * expansion))}］`;
}

function literalNodes(nodes: readonly MessageFormatElement[], output: MessageFormatElement[]): void {
  for (const node of nodes) {
    if (node.type === TYPE.literal) output.push(node);
    else if (node.type === TYPE.select || node.type === TYPE.plural) for (const option of Object.values(node.options)) literalNodes(option.value, output);
    else if (node.type === TYPE.tag) literalNodes(node.children, output);
  }
}

/** Create expanded development text while retaining ICU control syntax. */
export function pseudoLocalizeMessage(source: string, options: { expansion?: number } = {}): string {
  const expansion = options.expansion ?? 0.3;
  if (!Number.isFinite(expansion) || expansion < 0 || expansion > 5) throw new RangeError('Pseudo-locale expansion must be between 0 and 5.');
  const ast = parse(source, { captureLocation: true });
  const literals: MessageFormatElement[] = [];
  literalNodes(ast, literals);
  const replacements: { start: number; end: number; value: string }[] = [];
  for (const node of literals) if (isLiteralElement(node) && node.location) replacements.push({
    start: node.location.start.offset,
    end: node.location.end.offset,
    value: escapeIcuLiteral(transformLiteral(node.value, expansion)),
  });
  replacements.sort((left, right) => right.start - left.start);
  let result = source;
  for (const replacement of replacements) result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
  return result;
}

/** Recursively pseudolocalize a catalog without mutating it. */
export function pseudoLocalizeCatalog(catalog: Catalog, options: { expansion?: number } = {}): Catalog {
  const result: Catalog = Object.create(null) as Catalog;
  for (const [key, value] of Object.entries(catalog)) result[key] = typeof value === 'string' ? pseudoLocalizeMessage(value, options) : pseudoLocalizeCatalog(value, options);
  return result;
}
