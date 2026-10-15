import { basename, dirname, relative, resolve, sep } from 'node:path';
import { encode } from '@jridgewell/sourcemap-codec';
import type { SourceMapMappings } from '@jridgewell/sourcemap-codec';
import type { CompiledProject } from './compiler.js';
import { declarationGroups } from './type-layout.js';

interface Span { start: number; end: number }
interface Source { file: string; text: string }
interface MapPlan {
  lines: number;
  // Each five integers describe one pair of endpoints:
  // generated line, start/end columns, local message index, quote trimming.
  pairs: Uint32Array;
}
export type DeclarationMapCache = Map<string, { declaration: string; linkedDeclaration: string; source: Source; map: string; plan: MapPlan; sourcePath: string; outDir: string }>;

/** Parse only compiler-owned declarations. The generated coordinates depend on
 * their text, not the JSON values/layout, so a watch session can retain them.
 */
function planDeclaration(declaration: string, namespaceOnly: boolean): MapPlan {
  const pairs: number[] = [];
  const property = /readonly ("(?:[^"\\]|\\.)*"): typeof \$m(\d+)/g;
  let lineNumber = 0;
  for (let start = 0; ; lineNumber++) {
    const newline = declaration.indexOf('\n', start);
    const line = declaration.slice(start, newline < 0 ? declaration.length : newline);
    // Generated hover text opens its line (after indentation) and holds no "*/".
    // Skipping it keeps columns, like blanking it, so message text can never
    // imitate a declaration. Any other shape takes the general path.
    const indent = line.startsWith('/** ') ? 0 : line.startsWith('  /** ') ? 2 : -1;
    const close = indent < 0 ? -1 : line.indexOf('*/', indent + 3);
    if (close >= 0) {
      const code = close + 2, at = skipSpace(line, code);
      if (line.startsWith('declare const $m', at)) declared(lineNumber, line, at);
      property.lastIndex = code;
      for (let match; (match = property.exec(line));) pairs.push(lineNumber, match.index + 9, match.index + 9 + match[1]!.length, Number(match[2]), 0);
    } else if (!line.includes('/**')) {
      const at = skipSpace(line, 0);
      if (line.startsWith('declare const $m', at)) declared(lineNumber, line, at);
      if (namespaceOnly && line.startsWith('export {$m')) alias(lineNumber, line);
      property.lastIndex = 0;
      if (line.includes('readonly "')) for (const match of line.matchAll(property)) pairs.push(lineNumber, match.index + 9, match.index + 9 + match[1]!.length, Number(match[2]), 0);
    } else planLine(lineNumber, line, namespaceOnly, pairs);
    if (newline < 0) break;
    start = newline + 1;
  }
  function declared(lineNumber: number, line: string, at: number): void {
    const fn = /^declare const (\$m(\d+)):/.exec(line.slice(at));
    if (fn) pairs.push(lineNumber, at + 14, at + 14 + fn[1]!.length, Number(fn[2]), 1);
  }
  function alias(lineNumber: number, line: string): void {
    const match = /^export \{\$m(\d+) as ((?:[A-Za-z_$][A-Za-z0-9_$]*)|(?:"(?:[^"\\]|\\.)*"))\};/.exec(line);
    if (match) { const start = line.indexOf(match[2]!); pairs.push(lineNumber, start, start + match[2]!.length, Number(match[1]), 0); }
  }
  return { lines: lineNumber + 1, pairs: Uint32Array.from(pairs) };
}

const skipSpace = (line: string, at: number): number => {
  while (at < line.length && /\s/.test(line[at]!)) at++;
  return at;
};

/** The general line rule: blank the first hover comment, then match. */
function planLine(lineNumber: number, original: string, namespaceOnly: boolean, pairs: number[]): void {
  const line = original.replace(/\/\*\*.*?\*\//, comment => ' '.repeat(comment.length));
  const fn = /^\s*declare const (\$m(\d+)):/.exec(line);
  if (fn) {
    const start = line.indexOf(fn[1]!);
    pairs.push(lineNumber, start, start + fn[1]!.length, Number(fn[2]), 1);
  }
  // Namespace-derived members resolve to the alias; named imports can
  // resolve to the function declaration. Both ranges must remain mapped.
  if (namespaceOnly) {
    const alias = /^export \{\$m(\d+) as ((?:[A-Za-z_$][A-Za-z0-9_$]*)|(?:"(?:[^"\\]|\\.)*"))\};/.exec(line);
    if (alias) {
      const start = line.indexOf(alias[2]!);
      pairs.push(lineNumber, start, start + alias[2]!.length, Number(alias[1]), 0);
    }
  }
  for (const property of line.matchAll(/readonly ("(?:[^"\\]|\\.)*"): typeof \$m(\d+)/g)) {
    const start = property.index + 'readonly '.length;
    pairs.push(lineNumber, start, start + property[1]!.length, Number(property[2]), 0);
  }
}

/** Locate keys in an already parsed/validated JSON catalog. This scanner only
 * records source spans; it never replaces JSON.parse or catalog validation.
 */
function keySpans(text: string): Map<string, Span> {
  const spans = new Map<string, Span>();
  const tokens = /\s*("(?:[^"\\]|\\.)*"|[{}:,])/y;
  let position = 0;
  function next(): { value: string; start: number; end: number } {
    tokens.lastIndex = position;
    const match = tokens.exec(text);
    if (!match) throw new Error('Expected a validated JSON catalog while creating declaration maps.');
    position = tokens.lastIndex;
    return {value:match[1]!,start:position-match[1]!.length,end:position};
  }
  function object(prefix: string): void {
    let key = next();
    if (key.value === '}') return;
    for (;;) {
      const id = prefix + (key.value.includes('\\') ? JSON.parse(key.value) as string : key.value.slice(1, -1));
      next(); // colon; JSON.parse already validated it
      const value = next();
      if (value.value === '{') object(id + '.');
      else spans.set(id, {start:key.start,end:key.end});
      if (next().value === '}') return;
      key = next();
    }
  }
  next(); // opening brace
  object('');
  return spans;
}

export function attachDeclarationMaps(project: CompiledProject, source: Source, outDir: string, cache?: DeclarationMapCache): void {
  // Intern the unchanged source once for the whole map set. Comparing/retaining
  // a fresh large JSON string separately for every type file is expensive.
  const cachedSource = cache?.values().next().value?.source;
  if (cachedSource?.file === source.file && cachedSource.text === source.text) source = cachedSource;
  let spans: Map<string, Span> | undefined;
  const lineStarts = [0];
  let indexed = false;
  const sourcePosition = (offset: number): [number, number] => {
    if (!indexed) {
      // Declaration maps use ECMAScript lines, including LS/PS inside JSON
      // strings. The language server converts target offsets to editor lines.
      const breaks = /\r\n?|[\n\u2028\u2029]/g;
      for (let match; (match = breaks.exec(source.text));) lineStarts.push(breaks.lastIndex);
      indexed = true;
    }
    let low=0, high=lineStarts.length;
    while(low+1<high){const mid=(low+high)>>>1;if(lineStarts[mid]!<=offset)low=mid;else high=mid;}
    return [low,offset-lineStarts[low]!];
  };
  const current = new Set<string>();
  for (const [entry, groupIds] of Object.entries(project.groups)) for (const {file:name, ids} of declarationGroups(entry, groupIds)) {
    const declaration = project.files[name]!;
    const namespaceOnly = ids.length < groupIds.length;
    const previous = cache?.get(name);
    const plan = previous?.declaration === declaration ? previous.plan : planDeclaration(declaration,namespaceOnly);
    const sourcePath = previous?.outDir === outDir && previous.source.file === source.file ? previous.sourcePath
      : relative(dirname(resolve(outDir,name)),source.file).split(sep).join('/');
    const linkedDeclaration = previous?.declaration === declaration ? previous.linkedDeclaration
      : declaration + `//# sourceMappingURL=${basename(name)}.map\n`;
    let map: string;
    if (previous?.declaration === declaration && previous.source === source && previous.sourcePath === sourcePath) map = previous.map;
    else {
      spans ??= keySpans(source.text);
      const mappings: SourceMapMappings = Array.from({length:plan.lines},()=>[]);
      const pairs = plan.pairs;
      for (let i=0;i<pairs.length;i+=5) {
        const span = spans.get(ids[pairs[i+3]!]!)!;
        const trim = pairs[i+4]!;
        const [startLine,startColumn] = sourcePosition(span.start+trim);
        const [endLine,endColumn] = sourcePosition(span.end-trim);
        mappings[pairs[i]!]!.push([pairs[i+1]!,0,startLine,startColumn],[pairs[i+2]!,0,endLine,endColumn]);
      }
      map = JSON.stringify({version:3,file:basename(name),sources:[sourcePath],names:[],mappings:encode(mappings)}) + '\n';
      cache?.set(name,{declaration,linkedDeclaration,source,map,plan,sourcePath,outDir});
    }
    current.add(name);
    project.files[name] = linkedDeclaration;
    project.files[name+'.map'] = map;
  }
  if (cache) for(const name of cache.keys()) if(!current.has(name))cache.delete(name);
}
