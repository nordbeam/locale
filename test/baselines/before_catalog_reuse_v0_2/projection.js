import { quote, header } from './codegen.js';
import { CompileError } from './diagnostics.js';
/** Index compiler-owned, single-line definitions once for many selections.
 * Offsets retain the source without allocating one string per message.
 */
export class Projection {
    source;
    names;
    offsets;
    helpers = new Map();
    literal;
    constructor(source, names) {
        this.source = source;
        this.names = names;
        this.offsets = new Uint32Array(names.size * 2);
        const declarations = /^const \$m(\d+)=|^let (\$f\d+)Cache;|^const (\$literal)=/gm;
        for (const match of source.matchAll(declarations)) {
            const end = source.indexOf('\n', match.index);
            const lineEnd = end < 0 ? source.length : end;
            if (match[1] !== undefined) {
                const index = Number(match[1]);
                this.offsets[index * 2] = match.index + match[0].length;
                this.offsets[index * 2 + 1] = lineEnd;
            }
            else if (match[2])
                this.helpers.set(match[2], source.slice(match.index, lineEnd));
            else
                this.literal = source.slice(match.index, lineEnd);
        }
    }
    compile(keys) {
        const selected = [...new Set(keys)];
        const helpers = new Map();
        let usesLiteral = false;
        // Generated literals are JSON strings. Skip them before renaming internal
        // identifiers so translated text and argument names can contain $f0, etc.
        const tokens = /"(?:[^"\\]|\\.)*"|(\$f\d+(?:Cache)?|\$literal)\b/g;
        const rename = (text) => text.replace(tokens, (token, identifier) => {
            if (!identifier)
                return token;
            if (identifier === '$literal') {
                usesLiteral = true;
                return token;
            }
            const cached = identifier.endsWith('Cache');
            const old = cached ? identifier.slice(0, -5) : identifier;
            let local = helpers.get(old);
            if (local === undefined) {
                local = `$f${helpers.size}`;
                helpers.set(old, local);
            }
            return local + (cached ? 'Cache' : '');
        });
        const messages = selected.map((key, local) => {
            const index = this.names.get(key);
            if (index === undefined)
                throw new CompileError([{ code: 'UNKNOWN_MESSAGE', message: `Unknown selected message ${quote(key)}.` }]);
            const start = this.offsets[index * 2], end = this.offsets[index * 2 + 1];
            if (end <= start)
                throw new Error(`Missing generated definition for ${quote(key)}.`);
            return `const $m${local}=${rename(this.source.slice(start, end))}`;
        });
        const prelude = [];
        for (const old of helpers.keys()) {
            const code = this.helpers.get(old);
            if (code === undefined)
                throw new Error(`Missing generated formatter ${old}.`);
            prelude.push(rename(code));
        }
        if (usesLiteral) {
            if (!this.literal)
                throw new Error('Missing generated literal factory.');
            prelude.unshift(this.literal);
        }
        return header + [...prelude, ...messages].join('\n') + `\nexport default {__proto__:null,${selected.map((key, i) => `[${quote(key)}]:$m${i}`).join(',')}};\n`;
    }
}
