import { basename, dirname, relative, resolve, sep } from 'node:path';
import { encode } from '@jridgewell/sourcemap-codec';
import { declarationGroups } from './type-layout.js';
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
            const linkedDeclaration = previous?.declaration === declaration ? previous.linkedDeclaration
                : declaration + `//# sourceMappingURL=${basename(name)}.map\n`;
            let map;
            if (previous?.declaration === declaration && previous.source === source)
                map = previous.map;
            else {
                spans ??= keySpans(source.text);
                const mappings = declaration.split('\n').map((line) => {
                    const segments = [];
                    const add = (column, offset) => { const [line, character] = sourcePosition(offset); segments.push([column, 0, line, character]); };
                    const fn = /^declare const (\$m(\d+)):/.exec(line);
                    if (fn) {
                        const span = spans.get(ids[Number(fn[2])]);
                        const start = line.indexOf(fn[1]);
                        add(start, span.start + 1);
                        add(start + fn[1].length, span.end - 1);
                    }
                    // Namespace-derived catalog members resolve to the export alias, while
                    // named imports can resolve to the function declaration. Map both spans.
                    if (namespaceOnly) {
                        const alias = /^export \{\$m(\d+) as ("(?:[^"\\]|\\.)*")\};/.exec(line);
                        if (alias) {
                            const span = spans.get(ids[Number(alias[1])]);
                            const start = line.indexOf(alias[2]);
                            add(start, span.start);
                            add(start + alias[2].length, span.end);
                        }
                    }
                    for (const property of line.matchAll(/readonly ("(?:[^"\\]|\\.)*"): typeof \$m(\d+)/g)) {
                        const span = spans.get(ids[Number(property[2])]);
                        const start = property.index + 'readonly '.length;
                        const end = start + property[1].length;
                        add(start, span.start);
                        add(end, span.end);
                    }
                    return segments;
                });
                map = JSON.stringify({ version: 3, file: basename(name), sources: [relative(dirname(resolve(outDir, name)), source.file).split(sep).join('/')], names: [], mappings: encode(mappings) }) + '\n';
                cache?.set(name, { declaration, linkedDeclaration, source, map });
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
