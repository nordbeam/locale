import { quote, header, rewriteGeneratedIdentifiers, substituteTextParameters } from './codegen.js';
import { CompileError } from './diagnostics.js';
import { nestedMessageAliases } from './nested-messages.js';

/** Index compiler-owned, single-line definitions once for many selections.
 * Offsets retain the source without allocating one string per message.
 */
export class Projection {
  private readonly offsets: Uint32Array;
  private readonly helpers = new Map<string, string>();
  private readonly factories = new Map<string, { body: string; parameters: number }>();
  private literal: string | undefined;
  private parts: string | undefined;
  private memo: string | undefined;

  constructor(readonly source: string, readonly names: ReadonlyMap<string, number>) {
    this.offsets = new Uint32Array(names.size * 2);
    const declarations = /^const \$m(\d+)=|^let (\$f\d+)Cache;|^const (\$memo|\$literal|\$parts)=|^const (\$f\d+)=/gm;
    for (const match of source.matchAll(declarations)) {
      const end = source.indexOf('\n', match.index);
      const lineEnd = end < 0 ? source.length : end;
      if (match[1] !== undefined) {
        const index = Number(match[1]);
        this.offsets[index * 2] = match.index + match[0].length;
        this.offsets[index * 2 + 1] = lineEnd;
      } else if (match[2]) this.helpers.set(match[2], source.slice(match.index, lineEnd));
      else if (match[4]) {
        const code = source.slice(match.index, lineEnd);
        const factory = /^const \$f\d+=\(([^)]*)\)=>(.*);$/.exec(code);
        if (!factory || !/^\$s0(?:,\$s\d+)*$/.test(factory[1]!)) throw new Error('Invalid generated message factory.');
        this.factories.set(match[4], { body: factory[2]!, parameters: factory[1]!.split(',').length });
        this.helpers.set(match[4], code);
      }
      else if (match[3] === '$memo') this.memo = source.slice(match.index, lineEnd);
      else if (match[3] === '$literal') this.literal = source.slice(match.index, lineEnd);
      else if (match[3] === '$parts') this.parts = source.slice(match.index, lineEnd);
    }
  }

  compile(keys: readonly string[], nested = true): string {
    const selected = [...new Set(keys)];
    const helpers = new Map<string, string>();
    let usesLiteral = false, usesParts = false, usesMemo = false;
    // Generated literals are JSON strings. Skip them before renaming internal
    // identifiers so translated text and argument names can contain $f0, etc.
    const rename = (text: string): string => rewriteGeneratedIdentifiers(text, identifier => {
      if (identifier === '$literal') { usesLiteral = true; return identifier; }
      if (identifier === '$parts') { usesParts = true; return identifier; }
      if (identifier === '$memo') { usesMemo = true; return identifier; }
      const cached = identifier.endsWith('Cache');
      const old = cached ? identifier.slice(0, -5) : identifier;
      let local = helpers.get(old);
      if (local === undefined) { local = `$f${helpers.size}`; helpers.set(old, local); }
      return local + (cached ? 'Cache' : '');
    });
    const uses = new Map<string, number>();
    const definitions = selected.map(key => {
      const index = this.names.get(key);
      if (index === undefined) throw new CompileError([{code:'UNKNOWN_MESSAGE',message:`Unknown selected message ${quote(key)}.`}]);
      const start = this.offsets[index * 2]!, end = this.offsets[index * 2 + 1]!;
      if (end <= start) throw new Error(`Missing generated definition for ${quote(key)}.`);
      const body = this.source.slice(start, end);
      const call = /^\/\*#__PURE__\*\/(\$f\d+)\((.*)\);$/.exec(body);
      if (call) uses.set(call[1]!, (uses.get(call[1]!) ?? 0) + 1);
      return { body, call };
    });
    const messages = definitions.map(({ body, call }, local) => {
      // A template shared in the full catalog may be a one-off in this route.
      // Restore its direct expression before assigning local formatter names.
      if (call && uses.get(call[1]!) === 1) {
        const factory = this.factories.get(call[1]!);
        if (!factory) throw new Error('Missing generated message factory.');
        const texts = JSON.parse(`[${call[2]}]`) as string[];
        if (texts.length !== factory.parameters || texts.some(text => typeof text !== 'string')) throw new Error('Invalid generated message factory arguments.');
        body = substituteTextParameters(factory.body, texts) + ';';
      }
      // Selected modules expose only this object. Keeping a temporary binding
      // for every message adds identifiers that some minifiers cannot remove.
      return `[${quote(selected[local])}]:${rename(body.slice(0, -1))}`;
    });
    const prelude: string[] = [];
    for (const old of helpers.keys()) {
      const code = this.helpers.get(old);
      if (code === undefined) throw new Error(`Missing generated formatter ${old}.`);
      prelude.push(rename(code));
    }
    if (usesLiteral) {
      if (!this.literal) throw new Error('Missing generated literal factory.');
      prelude.unshift(this.literal);
    }
    if (usesParts) {
      if (!this.parts) throw new Error('Missing generated rich-parts helper.');
      prelude.unshift(this.parts);
    }
    if (usesMemo) {
      if (!this.memo) throw new Error('Missing generated formatter memo helper.');
      prelude.unshift(this.memo);
    }
    const aliases = nested ? nestedMessageAliases(selected) : '';
    if (!aliases) return header + prelude.join('\n') + `\nexport default {__proto__:null,${messages.join(',')}};\n`;
    return header + prelude.join('\n') + `\nconst messages=/*#__PURE__*/(()=>{const messages={__proto__:null,${messages.join(',')}};${aliases}return messages;})();export default messages;\n`;
  }
}
