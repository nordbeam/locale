import { lstat, mkdir, readFile, rename, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from '@babel/parser';
import { CodemodStrictError, codemodSource } from './codemods.js';
import { migrateNextIntlConfigSource, migrateNextIntlNavigationSource, migrateNextIntlRoutingSource } from './migrate-next-boundaries.js';

/** The App Router i18n integrations understood by the migration planner. */
export type NextI18nFramework = 'next-intl' | 'next-i18next' | 'react-i18next' | 'next-international';

export interface NextMigrationOptions {
  /** Project root. Defaults to the current working directory. */
  readonly root?: string;
  /** Directory to scan. Defaults to `app` and then `src/app` when present. */
  readonly sourceDir?: string;
  /** Generated Nordbeam output directory. Defaults to `src/i18n`. */
  readonly outDir?: string;
  /** Generated client adapter, relative to root. Defaults to `${outDir}/client.ts`. */
  readonly clientOut?: string;
  /** Source library. `auto` detects one library per file and skips ties. */
  readonly framework?: NextI18nFramework | 'auto';
  /** Name used for the generated message object. Defaults to `m`. */
  readonly messagesObject?: string;
  /** Explicitly name the dynamic route segment when the path is not conventional. */
  readonly localeParam?: string;
  /** Add locale static params to `[locale]` pages/layouts (default true). */
  readonly staticParams?: boolean;
  /** Fail closed at the project planner when any recognized call or boundary
   * cannot be proven safe. Source-level migration still returns diagnostics. */
  readonly strict?: boolean;
}

export interface NextMigrationSkip {
  readonly file: string;
  readonly reason: string;
  readonly kind: 'locale' | 'provider' | 'shape' | 'framework' | 'call';
}

export interface NextMigrationFilePlan {
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly replacements: number;
  readonly skips: readonly NextMigrationSkip[];
}

export interface NextMigrationPlan {
  readonly root: string;
  readonly sourceDir: string;
  readonly dryRun: true;
  readonly filesScanned: number;
  readonly replacements: number;
  readonly changed: readonly NextMigrationFilePlan[];
  readonly skipped: readonly NextMigrationSkip[];
  /** Steps a person must finish, such as renaming middleware.ts to proxy.ts or deleting an unused request config. */
  readonly manualActions: readonly string[];
}

export interface NextMigrationApplyResult {
  readonly root: string;
  readonly dryRun: false;
  readonly changed: readonly string[];
  readonly replacements: number;
  readonly skipped: readonly NextMigrationSkip[];
}

export interface NextSourceMigrationResult {
  readonly code: string;
  readonly replacements: number;
  readonly skipped: readonly NextMigrationSkip[];
  readonly framework?: NextI18nFramework;
}

/**
 * Replace the framework-owned locale middleware in a Next.js proxy. The App
 * Router codemod intentionally handles pages/components separately; this
 * narrow adapter keeps routing semantics instead of replacing middleware with
 * a plain `NextResponse.next()` pass-through.
 */
export function migrateNextMiddlewareSource(text: string, file = 'proxy.ts'): NextSourceMigrationResult {
  if (!/['"]next-intl\/middleware['"]/.test(text)) return { code: text, replacements: 0, skipped: [] };
  const imported = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]next-intl\/middleware['"]\s*;?/.exec(text);
  const factory = imported?.[1];
  const name = factory?.replace(/\$/g, '\\$');
  const anyCall = name ? new RegExp(`\\b${name}\\s*\\(`, 'g') : undefined;
  const routingCall = name ? new RegExp(`\\b${name}(\\s*\\(\\s*[A-Za-z_$][\\w$]*\\s*\\))`, 'g') : undefined;
  // Every use of the factory must be createMiddleware(routing); an inline options object or a re-exported factory needs a person.
  const calls = anyCall ? text.match(anyCall)?.length ?? 0 : 0;
  if (!imported || !routingCall || calls === 0 || calls !== text.match(routingCall)?.length) {
    return { code: text, replacements: 0, skipped: [{ file, reason: 'next-intl middleware is not created from a routing object; wire createNextMiddleware manually', kind: 'shape' }] };
  }
  const code = text
    .replace(imported[0], "import { createNextMiddleware } from '@nordbeam/locale/next/middleware';")
    .replace(routingCall, 'createNextMiddleware$1');
  return { code, replacements: 2, skipped: [], framework: 'next-intl' };
}

const extensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const identifier = /^[A-Za-z_$][\w$]*$/;
const frameworkNames: NextI18nFramework[] = ['next-intl', 'next-i18next', 'react-i18next', 'next-international'];

function quote(value: string): string { return JSON.stringify(value); }

function messageAccess(root: string, id: string): string {
  const parts = id.split('.');
  return parts.every(part => identifier.test(part) && !['__proto__', 'then', 'default'].includes(part))
    ? `${root}.${parts.join('.')}` : `${root}[${quote(id)}]`;
}

function routeLocaleParam(file: string, explicit?: string): { param?: string; ambiguous: boolean } {
  if (explicit) return { param: explicit, ambiguous: false };
  const names = [...file.matchAll(/(?:^|[\\/])\[([A-Za-z_$][\w$]*)\](?=[\\/]|$)/g)].map(match => match[1]!);
  const unique = [...new Set(names)];
  return unique.length === 1 ? { param: unique[0], ambiguous: false } : { ambiguous: unique.length > 1 };
}

function detectFramework(text: string, requested: NextMigrationOptions['framework']): { framework?: NextI18nFramework; tie: boolean } {
  if (requested && requested !== 'auto') return { framework: requested, tie: false };
  const found = frameworkNames.filter(name => {
    const modules = name === 'next-intl' ? /['"]next-intl(?:\/server)?['"]/
      : name === 'next-i18next' ? /['"]next-i18next(?:\/server|\/client)?['"]/
      : name === 'react-i18next' ? /['"]react-i18next['"]/
      : /['"]next-international(?:\/server|\/client)?['"]/;
    return modules.test(text);
  });
  return { framework: found.length === 1 ? found[0] : undefined, tie: found.length > 1 };
}

function clientFile(text: string): boolean {
  // A directive must occur before imports (comments and a BOM are allowed).
  return /^(?:\uFEFF|\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use client['"]\s*;?/.test(text);
}

function hasTranslationBinding(text: string, framework: NextI18nFramework): boolean {
  if (framework === 'next-intl') return /\b(?:useTranslations|getTranslations)\s*\(/.test(text);
  if (framework === 'next-i18next') return /\b(?:useT|getT|useTranslation)\s*\(/.test(text);
  if (framework === 'react-i18next') return /\buseTranslation\s*\(/.test(text);
  return /\b(?:useI18n|getI18n)\s*\(|createI18n(?:Client|Server)\s*\(/.test(text);
}

function splitImportClause(clause: string): string[] {
  const fields: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i];
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { fields.push(clause.slice(start, i).trim()); start = i + 1; }
  }
  const tail = clause.slice(start).trim();
  if (tail) fields.push(tail);
  return fields;
}

/** Remove only named legacy hooks. Provider and unrelated type imports stay intact. */
function removeImports(text: string, modules: readonly string[], names: readonly string[]): string {
  const modulesPattern = modules.map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const wanted = new Set(names);
  return text.replace(new RegExp(`(^[ \\t]*import\\s+)((?:(?!\\n[ \\t]*import\\b)[\\s\\S])*?)(\\s+from\\s+['"](?:${modulesPattern})['"]\\s*;?\\s*)`, 'gm'), (_all, prefix: string, clause: string, suffix: string) => {
    const fields = splitImportClause(clause);
    const kept = fields.filter(field => {
      const named = /^\{([\s\S]*)\}$/.exec(field);
      if (named) {
        const members = named[1]!.split(',').map(member => member.trim()).filter(Boolean);
        const remaining = members.filter(member => {
          const imported = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(member);
          return !imported || (!wanted.has(imported[1]!) && !wanted.has(imported[2] ?? ''));
        });
        if (!remaining.length) return false;
        return true;
      }
      return !wanted.has(field.replace(/^type\s+/, '').trim());
    });
    // Rebuild named fields because the callback above cannot mutate a string.
    const rebuilt: string[] = [];
    for (const field of kept) {
      const named = /^\{([\s\S]*)\}$/.exec(field);
      if (!named) { rebuilt.push(field); continue; }
      const remaining = named[1]!.split(',').map(member => member.trim()).filter(member => {
        const imported = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(member);
        return !imported || (!wanted.has(imported[1]!) && !wanted.has(imported[2] ?? ''));
      });
      if (remaining.length) rebuilt.push(`{ ${remaining.join(', ')} }`);
    }
    if (!rebuilt.length) return '';
    return prefix + rebuilt.join(', ') + suffix;
  });
}

function addImport(text: string, statement: string): string {
  const specifier = statement.match(/from\s+['"]([^'"]+)/)?.[1];
  if (specifier) {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const named = /^import\s+\{([^}]*)\}\s+from\s+['"]/.exec(statement);
    if (named) {
      const existing = new RegExp(`import\\s+\\{([^}]*)\\}\\s+from\\s+['"]${escaped}['"]`).exec(text);
      if (existing) {
        const fields = [...new Set(`${existing[1]},${named[1]}`.split(',').map(field => field.trim()).filter(Boolean))];
        return text.replace(existing[0], `import { ${fields.join(', ')} } from ${quote(specifier)}`);
      }
    } else if (new RegExp(`from\\s+['"]${escaped}['"]`).test(text)) return text;
  }
  const directive = /^(?:\uFEFF|\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use client['"]\s*;?\s*/.exec(text);
  if (directive) return text.slice(0, directive[0].length) + statement + '\n' + text.slice(directive[0].length);
  return statement + '\n' + text;
}

function generatedImport(file: string, root: string, target: string): string {
  let path = relative(dirname(file), resolve(root, target)).replaceAll('\\', '/');
  if (!path.startsWith('.')) path = `./${path}`;
  return `${path.replace(/\.(?:[cm]?tsx?|jsx?)$/, '')}.js`;
}

function functionOpening(text: string): { open: number; params: string } | undefined {
  const match = /export\s+default\s+async\s+function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/m.exec(text);
  if (!match) return;
  const start = match.index + match[0].length - 1;
  let depth = 0, quoteChar = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoteChar) { if (ch === '\\') i++; else if (ch === quoteChar) quoteChar = ''; continue; }
    if (ch === '"' || ch === "'") { quoteChar = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) {
      const rest = text.slice(i + 1);
      const brace = rest.search(/\{/);
      if (brace < 0) return;
      return { open: i + 1 + brace, params: text.slice(start + 1, i) };
    }
  }
}

function matchingBrace(text: string, open: number): number | undefined {
  let depth = 0, quote: string | undefined;
  for (let index = open; index < text.length; index++) {
    const character = text[index]!, next = text[index + 1];
    if (quote) {
      if (character === '\\') { index++; continue; }
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '/' && next === '/') {
      const end = text.indexOf('\n', index + 2);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return index;
  }
  return undefined;
}

function parseNextOutput(text: string): string | undefined {
  try {
    parse(text, { sourceType: 'unambiguous', errorRecovery: false, plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'] });
    return;
  } catch (error) {
    return `rewritten Next source did not parse; no rewrites applied: ${(error as Error).message}`;
  }
}

function destructuredRouteBinding(text: string, open: number, property: string, expression: string): { name: string; end: number } | undefined {
  const close = matchingBrace(text, open);
  const bodyEnd = close ?? text.length;
  const body = text.slice(open + 1, bodyEnd);
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedExpression = expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+\\{([^}]*)\\}\\s*=\\s*(?:await\\s+)?${escapedExpression}\\b`, 'g');
  const field = new RegExp(`(?:^|,)\\s*${escapedProperty}(?:\\s*:\\s*([A-Za-z_$][\\w$]*))?(?:\\s*=\\s*[^,]+)?\\s*(?:,|$)`);
  for (const match of body.matchAll(declaration)) {
    const fields = match[1]!;
    const found = field.exec(fields);
    if (found) {
      let end = open + 1 + match.index! + match[0].length;
      if (text[end] === ';') end++;
      return { name: found[1] ?? property, end };
    }
  }
  return undefined;
}

function paramsExpression(parameters: string): string | undefined {
  const trimmed = parameters.trim();
  if (trimmed.startsWith('{')) {
    const close = trimmed.indexOf('}');
    if (close >= 0 && /(?:^|[{,\s])params(?:[,\s}]|$)/.test(trimmed.slice(0, close + 1))) return 'params';
    return;
  }
  const identifierParameter = /^([A-Za-z_$][\w$]*)\s*(?::[\s\S]*)?$/.exec(trimmed);
  return identifierParameter ? `${identifierParameter[1]}.params` : undefined;
}

function hookDeclaration(text: string, framework: NextI18nFramework, client: boolean): { names: string[]; start: number; end: number; namespace?: string; namespaceDynamic?: boolean }[] {
  const result: { names: string[]; start: number; end: number; namespace?: string; namespaceDynamic?: boolean }[] = [];
  const call = framework === 'next-intl' ? client ? 'useTranslations' : 'getTranslations'
    : framework === 'next-i18next' ? client ? 'useT|useTranslation' : 'getT'
    : framework === 'react-i18next' ? 'useTranslation'
    : client ? 'useI18n' : 'getI18n';
  // Keep the statement delimiter outside the match so adjacent declarations
  // on one line are all discovered (consuming `;` here used to hide every
  // hook after the first one).
  const pattern = new RegExp(`(^|(?<=[;{\\n]))([ \\t]*)(?:const|let|var)\\s+([^=;\\n]+?)\\s*=\\s*(?:await\\s+)?(?:${call})\\s*\\(([^)]*)\\)\\s*;?`, 'gm');
  for (const match of text.matchAll(pattern)) {
    const lhs = match[3]!.trim(), args = match[4]!.trim();
    const names: string[] = [];
    const destructured = /^\{([\s\S]*)\}$/.exec(lhs);
    if (destructured) {
      for (const member of destructured[1]!.split(',')) {
        const found = /^\s*(?:t|useI18n|i18n)\s*(?::\s*([A-Za-z_$][\w$]*))?/.exec(member);
        if (found) names.push(found[1] ?? member.trim().split(/\s*:/)[0]!);
      }
    } else if (identifier.test(lhs)) names.push(lhs);
    if (!names.length) continue;
    const namespace = /^['"]([^'"]+)['"]/.exec(args)?.[1]
      ?? /\bnamespace\s*:\s*(['"])([^'"\\]*)\1/.exec(args)?.[2];
    const namespaceDynamic = args.length > 0 && !namespace;
    result.push({ names, ...(namespace ? { namespace } : {}), ...(namespaceDynamic ? { namespaceDynamic: true } : {}), start: match.index! + (match[1]?.length ?? 0) + match[2]!.length, end: match.index! + match[0].length });
  }
  return result;
}

function lexicalBlockAt(text: string, offset: number): number {
  const stack: number[] = [];
  let quote: string | undefined;
  for (let index = 0; index < offset; index++) {
    const character = text[index]!, next = text[index + 1];
    if (quote) {
      if (character === '\\') { index++; continue; }
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '/' && next === '/') { const end = text.indexOf('\n', index + 2); index = end < 0 || end >= offset ? offset : end; continue; }
    if (character === '/' && next === '*') { const end = text.indexOf('*/', index + 2); index = end < 0 || end >= offset ? offset : end + 1; continue; }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') stack.push(index);
    else if (character === '}') stack.pop();
  }
  return stack.at(-1) ?? -1;
}

function hookScopeGroups(text: string, declarations: readonly { start: number; end: number }[]): Array<{ first: { start: number; end: number }; all: readonly { start: number; end: number }[] }> {
  const groups = new Map<number, Array<{ start: number; end: number }>>();
  for (const declaration of declarations) {
    const key = lexicalBlockAt(text, declaration.start);
    groups.set(key, [...(groups.get(key) ?? []), declaration]);
  }
  return [...groups.values()].map(all => {
    const ordered = [...all].sort((left, right) => left.start - right.start);
    return { first: ordered[0]!, all: ordered };
  }).sort((left, right) => right.first.start - left.first.start);
}

function lexicalScopePathAt(text: string, offset: number): number[] {
  const stack: number[] = [];
  let quote: string | undefined;
  for (let index = 0; index < offset; index++) {
    const character = text[index]!, next = text[index + 1];
    if (quote) {
      if (character === '\\') { index++; continue; }
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '/' && next === '/') { const end = text.indexOf('\n', index + 2); index = end < 0 || end >= offset ? offset : end; continue; }
    if (character === '/' && next === '*') { const end = text.indexOf('*/', index + 2); index = end < 0 || end >= offset ? offset : end + 1; continue; }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') stack.push(index);
    else if (character === '}') stack.pop();
  }
  return stack;
}

function generatedBindingEntries(text: string, object: string): Array<{ offset: number; scope: number[] }> {
  const escaped = object.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&');
  const pattern = new RegExp(`\\b(?:const|let|var)\\s+\\{\\s*messages\\s*:\\s*${escaped}\\s*\\}\\s*=\\s*i18n\\.useI18n\\s*\\(`, 'g');
  return [...text.matchAll(pattern)].map(match => ({ offset: match.index!, scope: lexicalScopePathAt(text, match.index!) }));
}

function scopeContains(outer: readonly number[], inner: readonly number[]): boolean {
  return outer.length <= inner.length && outer.every((value, index) => value === inner[index]);
}

/**
 * Return whether an already-generated messages binding is visible at a legacy
 * hook. An unrelated component's binding must never satisfy another component;
 * doing that leaves the rewritten call with an unresolved identifier. A
 * binding declared later in the same lexical scope is also rejected so we can
 * fail closed instead of creating a duplicate const or a temporal-dead-zone
 * reference.
 */
function generatedBindingStatus(text: string, offset: number, entries: readonly { offset: number; scope: number[] }[]): 'visible' | 'unsafe' | 'absent' {
  const target = lexicalScopePathAt(text, offset);
  if (entries.some(entry => entry.offset < offset && scopeContains(entry.scope, target))) return 'visible';
  if (entries.some(entry => entry.offset >= offset && entry.scope.length === target.length && entry.scope.every((value, index) => value === target[index]))) return 'unsafe';
  return 'absent';
}

function placeClientMessageBindings(text: string, framework: NextI18nFramework, object: string, preserveLegacy: boolean): { code: string; placed: boolean } {
  const declarations = hookDeclaration(text, framework, true);
  if (!declarations.length) return { code: text, placed: false };
  const groups = hookScopeGroups(text, declarations);
  const generated = generatedBindingEntries(text, object);
  const statuses = groups.map(group => generatedBindingStatus(text, group.first.start, generated));
  // Preflight all groups before mutating offsets. If a generated binding is in
  // the same scope but appears later, preserving the source is safer than
  // producing a duplicate declaration or relying on a TDZ reference.
  if (statuses.some(status => status === 'unsafe')) return { code: text, placed: false };
  const binding = `const { messages: ${object} } = i18n.useI18n();`;
  let code = text;
  groups.forEach((group, index) => {
    const status = statuses[index]!;
    if (status === 'visible') {
      if (!preserveLegacy) {
        for (const item of [...group.all].sort((left, right) => right.start - left.start))
          code = code.slice(0, item.start) + code.slice(item.end);
      }
      return;
    }
    if (preserveLegacy) {
      code = code.slice(0, group.first.start) + binding + '\n' + code.slice(group.first.start);
      return;
    }
    for (const item of [...group.all].sort((left, right) => right.start - left.start)) {
      code = item.start === group.first.start
        ? code.slice(0, item.start) + binding + code.slice(item.end)
        : code.slice(0, item.start) + code.slice(item.end);
    }
  });
  return { code, placed: true };
}

function bindingValueUses(text: string, declarations: readonly { names: readonly string[]; start: number; end: number }[]): Array<{ callee: string; reason: string }> {
  const ranges = declarations.map(item => [item.start, item.end] as const);
  const result: Array<{ callee: string; reason: string }> = [], seen = new Set<string>();
  const names = [...new Set(declarations.flatMap(item => item.names))];
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&');
    for (const match of text.matchAll(new RegExp(`\\b${escaped}\\b`, 'g'))) {
      const offset = match.index!;
      if (ranges.some(([start, end]) => offset >= start && offset < end)) continue;
      const before = text.slice(Math.max(0, offset - 2), offset), after = text.slice(offset + name.length, offset + name.length + 4);
      if (/\.$/.test(before) || /^\s*(?:\?\.)?\s*\./.test(after) || /^\s*:/.test(after)) continue;
      if (/^\s*(?:\?\.)?\s*\(/.test(after)) continue;
      const key = `${name}:${offset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ callee: name, reason: `${name} is used as a value outside a proven translation call; retain the legacy helper and migrate this reference manually` });
    }
  }
  return result;
}

function replaceCalls(text: string, names: readonly string[], object: string, namespace?: string): { code: string; count: number } {
  let code = text, count = 0;
  for (const name of names) {
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*\\(\\s*(['"])([^'"]*)\\1\\s*(?:,\\s*([^)]*))?\\)`, 'g');
    code = code.replace(pattern, (_all, _quote: string, id: string, values?: string) => {
      count++;
      const full = namespace ? `${namespace}.${id}` : id;
      return `${messageAccess(object, full)}(${values?.trim() ?? ''})`;
    });
  }
  return { code, count };
}

/** Methods such as next-intl's `t.raw`, `t.has`, and `t.markup` do not have a
 * typed-message equivalent. Removing the legacy hook while leaving one of
 * those calls behind would create a runtime ReferenceError, so retain the
 * hook/import boundary and report the exact member for manual migration. */
function unsupportedTranslationMembers(text: string, names: readonly string[], framework: NextI18nFramework): string[] {
  // Nordbeam exposes rich rendering as a separate helper; there is no
  // message-object method that can preserve next-intl rich semantics.
  const allowed = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const match of text.matchAll(new RegExp(`(?<![\\w$.])${escaped}\\s*(?:\\?\\.)\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g')))
      if (!allowed.has(match[1]!)) result.push(`${name}.${match[1]}`);
    for (const match of text.matchAll(new RegExp(`(?<![\\w$.])${escaped}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g')))
      if (!allowed.has(match[1]!)) result.push(`${name}.${match[1]}`);
  }
  return [...new Set(result)];
}

function providerAmbiguous(text: string, framework: NextI18nFramework): boolean {
  const provider = framework === 'next-intl' ? 'NextIntlClientProvider' : framework === 'next-i18next' ? 'I18nProvider' : framework === 'next-international' ? 'I18nProvider' : '';
  if (!provider || !new RegExp(`<${provider}\\b`).test(text)) return false;
  // A hook in a component is evaluated before that component returns its JSX,
  // so rewriting a provider in the same file would put the hook outside the
  // provider context. An existing provider before the first hook is the only
  // locally provable safe boundary; otherwise leave the complete file alone.
  const providerStart = text.search(new RegExp(`<${provider}\\b`));
  const hookStart = text.search(/\b(?:useTranslations|useT|useTranslation|useI18n)\s*\(/);
  const nordbeamStart = text.search(/<i18n\.Provider\b/);
  return nordbeamStart < 0 || (hookStart >= 0 && nordbeamStart > hookStart) || providerStart < 0;
}

function staticParams(text: string, param: string): string {
  if (/export\s+(?:async\s+)?function\s+generateStaticParams\s*\(/.test(text)) return text;
  const argument = param === 'locale' ? '' : quote(param);
  const statement = `\n\n/** Generated for the App Router locale segment. */\nexport function generateStaticParams() {\n  return i18n.generateStaticParams(${argument});\n}\n`;
  const exportIndex = text.indexOf('\nexport default');
  return exportIndex < 0 ? text + statement : text.slice(0, exportIndex) + statement + text.slice(exportIndex);
}

function wrapProviderLayout(text: string, options: NextMigrationOptions & { file: string; root: string }): { code: string; replacement: number; skip?: NextMigrationSkip } {
  if (text.includes('<NordbeamLocaleProvider') || clientFile(text)) return { code: text, replacement: 0,
    ...(clientFile(text) ? { skip: { file: options.file, reason: 'nearest locale layout is a Client Component; provider ownership is ambiguous', kind: 'provider' as const } } : {}) };
  const route = routeLocaleParam(options.file, options.localeParam);
  const opening = functionOpening(text);
  const params = opening && paramsExpression(opening.params);
  if (!route.param || !opening || !params || !/\bchildren\b/.test(opening.params)) {
    return { code: text, replacement: 0, skip: { file: options.file, reason: 'nearest locale layout is not a conventional async layout receiving children and params', kind: 'provider' } };
  }
  const children = [...text.slice(opening.open + 1).matchAll(/\{\s*children\s*\}/g)];
  if (children.length !== 1) return { code: text, replacement: 0, skip: { file: options.file, reason: 'locale layout must contain exactly one direct {children} slot for automatic provider wiring', kind: 'provider' } };
  const param = route.param;
  let code = text;
  if (!new RegExp(`\\b(?:const|let|var)\\s+\\{\\s*${param}\\s*\\}\\s*=\\s*(?:await\\s+)?params\\b`).test(code)) {
    code = code.slice(0, opening.open + 1) + `\n  const { ${param} } = await ${params};` + code.slice(opening.open + 1);
  }
  const slotPattern = /\{\s*children\s*\}/;
  code = code.replace(slotPattern, `<NordbeamLocaleProvider locale={${param}}>{children}</NordbeamLocaleProvider>`);
  const providerTarget = `${options.outDir ?? 'src/i18n'}/provider.ts`;
  code = addImport(code, `import { NordbeamLocaleProvider } from ${quote(generatedImport(options.file, options.root, providerTarget))};`);
  return { code, replacement: 1 };
}

/** Plan one App Router source file. This function never writes files. */
export function migrateNextSource(text: string, options: NextMigrationOptions & { readonly file: string }): NextSourceMigrationResult {
  const root = resolve(options.root ?? '.');
  const detected = detectFramework(text, options.framework);
  const skips: NextMigrationSkip[] = [];
  if (detected.tie) return { code: text, replacements: 0, skipped: [{ file: options.file, reason: 'multiple i18n frameworks detected; select framework explicitly', kind: 'framework' }] };
  const framework = detected.framework;
  if (!framework || !hasTranslationBinding(text, framework)) return { code: text, replacements: 0, skipped: [] };
  const client = clientFile(text);
  if (client && providerAmbiguous(text, framework)) {
    return { code: text, replacements: 0, skipped: [{ file: options.file, reason: 'provider boundary is ambiguous; a legacy provider in this component would run after its translation hook', kind: 'provider' }] };
  }
  const object = options.messagesObject ?? 'm';
  if (!identifier.test(object)) throw new TypeError('messagesObject must be a JavaScript identifier.');
  const route = routeLocaleParam(options.file, options.localeParam);
  if (!client && !route.param) {
    return { code: text, replacements: 0, skipped: [{ file: options.file, reason: route.ambiguous ? 'more than one dynamic route segment; locale parameter is ambiguous' : 'no conventional locale route segment; locale loading was skipped', kind: 'locale' }] };
  }
  let code = text;
  let replacements = 0;
  const declarations = hookDeclaration(code, framework, client);
  let activeDeclarations = declarations;
  let serverOpening: { open: number; params: string } | undefined;
  let serverParams: string | undefined;
  if (!client) {
    serverOpening = functionOpening(code);
    serverParams = serverOpening && paramsExpression(serverOpening.params);
    if (!serverOpening || !serverParams) {
      return { code: text, replacements: 0, skipped: [{ file: options.file, reason: 'server translation is not in a conventional async component receiving params', kind: 'shape' }] };
    }
    // codemodSource can recognize every imported server factory in a file.
    // Restrict the active binding set to the default component and reject any
    // additional helper boundary; otherwise a later named helper can be
    // rewritten to the default component's `m` object and lose its declaration.
    activeDeclarations = declarations.filter(declaration => lexicalScopePathAt(code, declaration.start).includes(serverOpening!.open));
    if (activeDeclarations.length !== declarations.length) {
      return {
        code: text,
        replacements: 0,
        skipped: [{ file: options.file, reason: 'server translations cross the default component boundary (for example generateMetadata); migrate each async server helper separately', kind: 'shape' }],
        ...(framework ? { framework } : {}),
      };
    }
  }
  const customCalls = activeDeclarations.flatMap(declaration => declaration.names.map(name => ({
    callee: name,
    ...(declaration.namespace ? { namespace: declaration.namespace } : {}),
    ...(declaration.namespaceDynamic ? { namespaceDynamic: true } : {}),
  })));
  const valueUses = bindingValueUses(code, activeDeclarations);
  if (client) {
    let converted = codemodSource(code, framework === 'react-i18next' ? 'i18next' : framework === 'next-i18next' ? 'i18next' : framework === 'next-international' ? 'next-international' : 'next-intl', { messagesObject: object, customCalls, cleanup: false });
    code = converted.code; replacements += converted.replacements;
    const legacyMembers = unsupportedTranslationMembers(code, declarations.flatMap(item => item.names), framework);
    const callSkips = [...new Map([...converted.skipped, ...legacyMembers.map(member => ({ callee: member, reason: 'translation helper member is not supported by the generated messages object; migrate this member manually' })), ...valueUses].map(item => [item.callee, item])).values()];
    skips.push(...callSkips.map(item => ({ file: options.file, reason: `${item.callee}: ${item.reason}`, kind: 'call' as const })));
    // A skipped dynamic/member call still depends on the legacy hook. Keep
    // its declaration and imports in place; static calls in the same file may
    // use the generated object alongside it. If nothing was rewritten, avoid
    // adding a generated import to an otherwise unchanged file.
    const preserveLegacy = callSkips.length > 0;
    if (preserveLegacy && replacements === 0) return { code: text, replacements: 0, skipped: skips, ...(framework ? { framework } : {}) };
    const placed = placeClientMessageBindings(code, framework, object, preserveLegacy);
    if (!placed.placed) return { code: text, replacements: 0, skipped: [...skips, { file: options.file, reason: 'translation hook declaration is not in a conventional component scope; bind the generated messages object manually', kind: 'shape' }], ...(framework ? { framework } : {}) };
    code = placed.code;
    const clientTarget = options.clientOut ?? `${options.outDir ?? 'src/i18n'}/client.ts`;
    code = addImport(code, `import { i18n } from ${quote(generatedImport(resolve(root, options.file), root, clientTarget))};`);
    if (!preserveLegacy) {
      const modules = framework === 'next-intl' ? ['next-intl'] : framework === 'next-i18next' ? ['next-i18next/client'] : framework === 'react-i18next' ? ['react-i18next'] : ['next-international/client', 'next-international'];
      const names = framework === 'next-intl' ? ['useTranslations'] : framework === 'next-i18next' ? ['useT', 'useTranslation'] : framework === 'react-i18next' ? ['useTranslation'] : ['useI18n'];
      if (framework === 'next-international') {
        code = code.replace(/(^|\n)[ \t]*const\s+\{\s*useI18n\s*\}\s*=\s*createI18nClient\([^;\n]*\);?[ \t]*/g, '$1');
      }
      code = removeImports(code, modules, names);
    }
  } else {
    const opening = serverOpening ?? functionOpening(code);
    const params = serverParams ?? (opening && paramsExpression(opening.params));
    if (!opening || !params) {
      return { code: text, replacements: 0, skipped: [{ file: options.file, reason: 'server translation is not in a conventional async component receiving params', kind: 'shape' }] };
    }
    let converted = codemodSource(code, framework === 'react-i18next' ? 'i18next' : framework === 'next-i18next' ? 'i18next' : framework === 'next-international' ? 'next-international' : 'next-intl', { messagesObject: object, customCalls, cleanup: false });
    code = converted.code; replacements += converted.replacements;
    const legacyMembers = unsupportedTranslationMembers(code, activeDeclarations.flatMap(item => item.names), framework);
    const callSkips = [...new Map([...converted.skipped, ...legacyMembers.map(member => ({ callee: member, reason: 'translation helper member is not supported by the generated messages object; migrate this member manually' })), ...valueUses].map(item => [item.callee, item])).values()];
    skips.push(...callSkips.map(item => ({ file: options.file, reason: `${item.callee}: ${item.reason}`, kind: 'call' as const })));
    const preserveLegacy = callSkips.length > 0;
    if (preserveLegacy && replacements === 0) return { code: text, replacements: 0, skipped: skips, ...(framework ? { framework } : {}) };
    const migratedOpening = functionOpening(code);
    const migratedParams = migratedOpening && paramsExpression(migratedOpening.params);
    if (!migratedOpening || !migratedParams) return { code: text, replacements: 0, skipped: [{ file: options.file, reason: 'server component boundary changed during planning', kind: 'shape' }] };
    const localeParam = options.localeParam ?? route.param!;
    const localeBinding = destructuredRouteBinding(code, migratedOpening.open, localeParam, migratedParams);
    const load = localeBinding
      ? `\\n  const { messages: ${object} } = await i18n.loadLocale(${localeBinding.name});`
      : `\\n  const { ${localeParam} } = await ${migratedParams};\\n  const { messages: ${object} } = await i18n.loadLocale(${localeParam});`;
    const loadOffset = localeBinding?.end ?? migratedOpening.open + 1;
    code = code.slice(0, loadOffset) + load.replaceAll('\\n', '\n') + code.slice(loadOffset);
    if (!preserveLegacy) {
      const currentDeclarations = hookDeclaration(code, framework, false);
      for (let i = currentDeclarations.length - 1; i >= 0; i--) {
        const item = currentDeclarations[i]!;
        code = code.slice(0, item.start) + code.slice(item.end);
      }
    }
    const target = `${options.outDir ?? 'src/i18n'}/next.ts`;
    code = addImport(code, `import { i18n } from ${quote(generatedImport(resolve(root, options.file), root, target))};`);
    if (!preserveLegacy) {
      const modules = framework === 'next-intl' ? ['next-intl/server'] : framework === 'next-i18next' ? ['next-i18next/server'] : framework === 'react-i18next' ? ['react-i18next'] : ['next-international/server', 'next-international'];
      const names = framework === 'next-intl' ? ['getTranslations'] : framework === 'next-i18next' ? ['getT'] : framework === 'react-i18next' ? ['useTranslation'] : ['getI18n', 'createI18nServer', 'setStaticParamsLocale'];
      if (framework === 'next-international') {
      // The factory declaration is only a legacy hook bridge. Leaving it
      // behind after removing createI18nServer would produce an undefined
      // identifier, so remove this narrow, single-purpose declaration too.
        code = code.replace(/(^|\n)[ \t]*const\s+\{\s*getI18n\s*\}\s*=\s*createI18nServer\([^;\n]*\);?[ \t]*/g, '$1');
      }
      code = removeImports(code, modules, names);
    }
    if (options.staticParams !== false && /(?:^|[\\/])(?:page|layout)\.[cm]?[jt]sx?$/.test(options.file) && route.param) {
      code = staticParams(code, route.param);
    }
  }
  const outputError = parseNextOutput(code);
  if (outputError) {
    return {
      code: text,
      replacements: 0,
      skipped: [...skips, { file: options.file, reason: outputError, kind: 'shape' }],
      ...(framework ? { framework } : {}),
    };
  }
  return { code, replacements, skipped: skips, ...(framework ? { framework } : {}) };
}

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && !ignored.has(entry.name)) await visit(resolve(current, entry.name));
      else if (entry.isFile() && extensions.has(extname(entry.name))) result.push(resolve(current, entry.name));
    }
  }
  await visit(directory);
  return result;
}

const boundaryExtensions = ['ts', 'mts', 'js', 'mjs'];

async function firstFile(directory: string, bases: readonly string[]): Promise<string | undefined> {
  for (const base of bases) for (const extension of boundaryExtensions) {
    const file = resolve(directory, `${base}.${extension}`);
    try { if ((await lstat(file)).isFile()) return file; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await lstat(path)).isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Next loads proxy.ts/middleware.ts from the folder that holds app/ or pages/: the root, or src/. */
async function nextRequestDirectory(root: string): Promise<string> {
  if (await isDirectory(resolve(root, 'app')) || await isDirectory(resolve(root, 'pages'))) return root;
  return await isDirectory(resolve(root, 'src/app')) || await isDirectory(resolve(root, 'src/pages')) ? resolve(root, 'src') : root;
}

async function nextMajor(root: string): Promise<number | undefined> {
  const read = async (file: string): Promise<Record<string, unknown> | undefined> => {
    try { return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>; }
    catch { return undefined; }
  };
  const installed = await read(resolve(root, 'node_modules/next/package.json'));
  const project = await read(resolve(root, 'package.json')) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> } | undefined;
  const range = typeof installed?.version === 'string' ? installed.version : { ...project?.dependencies, ...project?.devDependencies }.next;
  const major = typeof range === 'string' ? Number(/^\D*(\d+)\./.exec(range)?.[1]) : NaN;
  return Number.isInteger(major) ? major : undefined;
}

/** next-intl's request boundary, routing and navigation modules and Next config plugin have Nordbeam
 * counterparts, so a conventional file is rewritten in place; anything else becomes a skip or a manual action.
 * Rewriting in place matters: Next 16 refuses to build when middleware.ts and proxy.ts both exist. */
async function planNextIntlBoundaries(root: string, changed: NextMigrationFilePlan[], skipped: NextMigrationSkip[], manualActions: string[], visited: Set<string>): Promise<void> {
  const edits = new Map<string, NextMigrationFilePlan>();
  const edit = async (file: string, transform: (text: string) => NextSourceMigrationResult): Promise<NextSourceMigrationResult> => {
    visited.add(file);
    const existing = edits.get(file) ?? changed.find(item => item.file === file);
    const before = existing?.before ?? await readFile(file, 'utf8');
    const result = transform(existing?.after ?? before);
    skipped.push(...result.skipped);
    if (result.code !== (existing?.after ?? before)) {
      edits.set(file, { file, before, after: result.code, replacements: (existing?.replacements ?? 0) + result.replacements, skips: [...(existing?.skips ?? []), ...result.skipped] });
    }
    return result;
  };
  const projectPath = (file: string): string => relative(root, file).split(sep).join('/');
  const request = await firstFile(await nextRequestDirectory(root), ['proxy', 'middleware']);
  if (request) {
    const result = await edit(request, text => migrateNextMiddlewareSource(text, request));
    if (result.replacements && basename(request).startsWith('middleware') && ((await nextMajor(root)) ?? 16) >= 16) {
      manualActions.push(`Rename ${projectPath(request)} to proxy${extname(request)} (or run npx @next/codemod@canary middleware-to-proxy .). Next 16 still loads middleware but deprecates it, and refuses to build when both middleware and proxy files exist.`);
    }
  }
  const config = await firstFile(root, ['next.config']);
  const configRewritten = config ? (await edit(config, text => migrateNextIntlConfigSource(text, config))).replacements > 0 : false;
  const requestConfigs: string[] = [];
  const searched = await isDirectory(resolve(root, 'src')) ? ['src'] : ['i18n', 'lib', 'libs', 'utils', 'config'];
  for (const directory of searched.map(name => resolve(root, name))) {
    if (!await isDirectory(directory)) continue;
    for (const file of await sourceFiles(directory)) {
      const text = edits.get(file)?.after ?? changed.find(item => item.file === file)?.after ?? await readFile(file, 'utf8');
      if (/['"]next-intl\/routing['"]/.test(text)) await edit(file, current => migrateNextIntlRoutingSource(current, file));
      if (/['"]next-intl\/navigation['"]/.test(text)) await edit(file, current => migrateNextIntlNavigationSource(current, file));
      if (/\bgetRequestConfig\b/.test(text) && /['"]next-intl\/server['"]/.test(text)) requestConfigs.push(file);
    }
  }
  if (configRewritten && requestConfigs.length) {
    manualActions.push(`Delete ${requestConfigs.map(projectPath).join(', ')} (next-intl getRequestConfig) once nothing imports it; only createNextIntlPlugin read it, and withNordbeamLocale replaced that.`);
  }
  for (const [file, plan] of edits) {
    const index = changed.findIndex(item => item.file === file);
    if (index >= 0) changed[index] = plan; else changed.push(plan);
  }
  changed.sort((left, right) => left.file < right.file ? -1 : left.file > right.file ? 1 : 0);
}

/** Scan an App Router tree and return a deterministic, non-mutating plan. */
export async function planNextMigration(options: NextMigrationOptions = {}): Promise<NextMigrationPlan> {
  const root = resolve(options.root ?? '.');
  let sourceDir = resolve(root, options.sourceDir ?? 'app');
  if (!options.sourceDir) {
    try { await lstat(sourceDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      sourceDir = resolve(root, 'src/app');
    }
  }
  const files = await sourceFiles(sourceDir);
  const changed: NextMigrationFilePlan[] = [], skipped: NextMigrationSkip[] = [];
  for (const file of files) {
    const before = await readFile(file, 'utf8');
    const result = migrateNextSource(before, { ...options, root, file });
    skipped.push(...result.skipped);
    if (result.code !== before) changed.push({ file, before, after: result.code, replacements: result.replacements, skips: result.skipped });
  }
  const clientChanges = changed.filter(item => clientFile(item.before) && /i18n\.useI18n\(\)/.test(item.after));
  for (const client of clientChanges) {
    const layouts = files.filter(file => /(?:^|[\\/])layout\.[cm]?[jt]sx?$/.test(file)
      && client.file.startsWith(dirname(file) + sep) && routeLocaleParam(file, options.localeParam).param)
      .sort((left, right) => right.length - left.length);
    const layout = layouts[0];
    if (!layout) { skipped.push({ file: client.file, reason: 'no conventional locale layout owns this Client Component; add NordbeamLocaleProvider manually', kind: 'provider' }); continue; }
    const existing = changed.find(item => item.file === layout);
    const before = existing?.before ?? await readFile(layout, 'utf8');
    const current = existing?.after ?? before;
    const wrapped = wrapProviderLayout(current, { ...options, root, file: layout });
    if (wrapped.skip) { skipped.push(wrapped.skip); continue; }
    if (wrapped.code === current) continue;
    if (existing) {
      const index = changed.indexOf(existing);
      changed[index] = { ...existing, after: wrapped.code, replacements: existing.replacements + wrapped.replacement };
    } else changed.push({ file: layout, before, after: wrapped.code, replacements: wrapped.replacement, skips: [] });
  }
  const manualActions: string[] = [], visited = new Set(files);
  if (options.framework === undefined || options.framework === 'auto' || options.framework === 'next-intl') await planNextIntlBoundaries(root, changed, skipped, manualActions, visited);
  if (options.strict && skipped.length) {
    throw new CodemodStrictError(skipped.map(item => ({ file: item.file, callee: item.kind, reason: item.reason })));
  }
  return { root, sourceDir, dryRun: true, filesScanned: visited.size, replacements: changed.reduce((sum, item) => sum + item.replacements, 0), changed, skipped, manualActions };
}

/** Apply a previously reviewed plan. Concurrent edits are rejected. */
export async function applyNextMigration(plan: NextMigrationPlan): Promise<NextMigrationApplyResult> {
  const changed: string[] = [];
  for (const item of plan.changed) {
    const current = await readFile(item.file, 'utf8');
    if (current !== item.before) throw new Error(`Refusing to apply stale Next migration plan: ${item.file}`);
  }
  const staged: Array<{ file: string; temporary: string }> = [];
  const backups: Array<{ file: string; backup: string }> = [];
  let complete = false;
  try {
    for (const item of plan.changed) {
      await mkdir(dirname(item.file), { recursive: true });
      const temporary = `${item.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, item.after, { flag: 'wx' });
      staged.push({ file: item.file, temporary });
    }
    for (const item of staged) {
      const backup = `${item.file}.${randomUUID()}.bak`;
      await rename(item.file, backup);
      backups.push({ file: item.file, backup });
    }
    for (const item of staged) { await rename(item.temporary, item.file); changed.push(item.file); }
    complete = true;
  } finally {
    if (!complete) {
      for (const file of changed) await unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      for (const item of [...backups].reverse()) await rename(item.backup, item.file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    } else {
      for (const item of backups) await unlink(item.backup).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
    for (const item of staged) await unlink(item.temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
  return { root: plan.root, dryRun: false, changed, replacements: plan.replacements, skipped: plan.skipped };
}

// Verbose aliases make the API discoverable to callers that name the operation "App" Router.
export const planNextAppMigration = planNextMigration;
export const applyNextAppMigration = applyNextMigration;

export { migrateNextIntlConfigSource, migrateNextIntlNavigationSource, migrateNextIntlRoutingSource } from './migrate-next-boundaries.js';
