import { basename, dirname, relative, resolve, sep } from 'node:path';
import { encode } from '@jridgewell/sourcemap-codec';
import { declarationGroups } from './type-layout.js';
/** Parse only compiler-owned declarations. The generated coordinates depend on
 * their text, not the JSON values/layout, so a watch session can retain them.
 */
function planDeclaration(declaration, namespaceOnly) {
    const lines = declaration.split('\n');
    const pairs = [];
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
        const line = lines[lineNumber];
        const fn = /^declare const (\$m(\d+)):/.exec(line);
        if (fn) {
            const start = line.indexOf(fn[1]);
            pairs.push(lineNumber, start, start + fn[1].length, Number(fn[2]), 1);
        }
        // Namespace-derived members resolve to the alias; named imports can
        // resolve to the function declaration. Both ranges must remain mapped.
        if (namespaceOnly) {
            const alias = /^export \{\$m(\d+) as ("(?:[^"\\]|\\.)*")\};/.exec(line);
            if (alias) {
                const start = line.indexOf(alias[2]);
                pairs.push(lineNumber, start, start + alias[2].length, Number(alias[1]), 0);
            }
        }
        for (const property of line.matchAll(/readonly ("(?:[^"\\]|\\.)*"): typeof \$m(\d+)/g)) {
            const start = property.index + 'readonly '.length;
            pairs.push(lineNumber, start, start + property[1].length, Number(property[2]), 0);
        }
    }
    return { lines: lines.length, pairs: Uint32Array.from(pairs) };
}
/** Locate keys in an already parsed/validated JSON catalog. This scanner only
 * records source spans; it never replaces JSON.parse or catalog validation.
 */
function keySpans(text) {
    const spans = new Map();
    const tokens = /\s*("(?:[^"\\]|\\.)*"|[{}:,])/y;
    let position = 0;
    function next() {
        tokens.lastIndex = position;
        const match = tokens.exec(text);
        if (!match)
            throw new Error('Expected a validated JSON catalog while creating declaration maps.');
        position = tokens.lastIndex;
        return { value: match[1], start: position - match[1].length, end: position };
    }
    function object(prefix) {
        let key = next();
        if (key.value === '}')
            return;
        for (;;) {
            const id = prefix + JSON.parse(key.value);
            next(); // colon; JSON.parse already validated it
            const value = next();
            if (value.value === '{')
                object(id + '.');
            else
                spans.set(id, { start: key.start, end: key.end });
            if (next().value === '}')
                return;
            key = next();
        }
    }
    next(); // opening brace
    object('');
    return spans;
}
export function attachDeclarationMaps(project, source, outDir, cache) {
    // Intern the unchanged source once for the whole map set. Comparing/retaining
    // a fresh large JSON string separately for every type file is expensive.
    const cachedSource = cache?.values().next().value?.source;
    if (cachedSource?.file === source.file && cachedSource.text === source.text)
        source = cachedSource;
    let spans;
    const lineStarts = [0];
    let indexed = false;
    const sourcePosition = (offset) => {
        if (!indexed) {
            // Declaration maps use ECMAScript lines, including LS/PS inside JSON
            // strings. The language server converts target offsets to editor lines.
            for (let i = 0; i < source.text.length; i++) {
                if (source.text[i] === '\r') {
                    if (source.text[i + 1] === '\n')
                        i++;
                    lineStarts.push(i + 1);
                }
                else if (source.text[i] === '\n' || source.text[i] === '\u2028' || source.text[i] === '\u2029')
                    lineStarts.push(i + 1);
            }
            indexed = true;
        }
        let low = 0, high = lineStarts.length;
        while (low + 1 < high) {
            const mid = (low + high) >>> 1;
            if (lineStarts[mid] <= offset)
                low = mid;
            else
                high = mid;
        }
        return [low, offset - lineStarts[low]];
    };
    const current = new Set();
    for (const [entry, groupIds] of Object.entries(project.groups))
        for (const { file: name, ids } of declarationGroups(entry, groupIds)) {
            const declaration = project.files[name];
            const namespaceOnly = ids.length < groupIds.length;
            const previous = cache?.get(name);
            const plan = previous?.declaration === declaration ? previous.plan : planDeclaration(declaration, namespaceOnly);
            const sourcePath = previous?.outDir === outDir && previous.source.file === source.file ? previous.sourcePath
                : relative(dirname(resolve(outDir, name)), source.file).split(sep).join('/');
            const linkedDeclaration = previous?.declaration === declaration ? previous.linkedDeclaration
                : declaration + `//# sourceMappingURL=${basename(name)}.map\n`;
            let map;
            if (previous?.declaration === declaration && previous.source === source && previous.sourcePath === sourcePath)
                map = previous.map;
            else {
                spans ??= keySpans(source.text);
                const mappings = Array.from({ length: plan.lines }, () => []);
                const pairs = plan.pairs;
                for (let i = 0; i < pairs.length; i += 5) {
                    const span = spans.get(ids[pairs[i + 3]]);
                    const trim = pairs[i + 4];
                    const [startLine, startColumn] = sourcePosition(span.start + trim);
                    const [endLine, endColumn] = sourcePosition(span.end - trim);
                    mappings[pairs[i]].push([pairs[i + 1], 0, startLine, startColumn], [pairs[i + 2], 0, endLine, endColumn]);
                }
                map = JSON.stringify({ version: 3, file: basename(name), sources: [sourcePath], names: [], mappings: encode(mappings) }) + '\n';
                cache?.set(name, { declaration, linkedDeclaration, source, map, plan, sourcePath, outDir });
            }
            current.add(name);
            project.files[name] = linkedDeclaration;
            project.files[name + '.map'] = map;
        }
    if (cache)
        for (const name of cache.keys())
            if (!current.has(name))
                cache.delete(name);
}
