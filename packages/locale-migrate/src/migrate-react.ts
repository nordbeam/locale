import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { extname, relative, resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse } from '@babel/parser';
import { codemodSource, type CodemodFormat, type CodemodSkip } from './codemods.js';

/** React integrations understood by the migration planner. */
export type ReactMigrationFormat =
  | 'auto'
  | 'react-i18next' | 'i18next'
  | 'react-intl' | 'formatjs'
  | 'lingui' | 'lingui-react'
  | 'tolgee' | 'tolgee-react';

export interface ReactMigrationOptions {
  /** Integration to migrate. `auto` only rewrites bindings proven by imports/hooks. */
  readonly format?: ReactMigrationFormat;
  /** Local name used for the generated adapter (default: `i18n`). */
  readonly i18nName?: string;
  /** Module containing the generated named `i18n` adapter. */
  readonly i18nImport?: string;
  /** Aliases accepted for i18nImport by callers integrating older tooling. */
  readonly i18nModule?: string;
  readonly modulePath?: string;
  /** File path used to calculate a relative generated-module import. */
  readonly filename?: string;
  readonly root?: string;
  /** Explicit server/client snapshot expression, e.g. `initial`. */
  readonly initialExpression?: string;
  readonly initial?: string;
  /** Vite scaffold uses createClientI18n.Provider, whose prop is initialLocale. */
  readonly initialLocaleExpression?: string;
  readonly initialLocale?: string;
  readonly framework?: 'vite-react' | 'react';
  /** Wrap conventional createRoot/hydrateRoot calls when an initial snapshot is explicit. */
  readonly wrapRoots?: boolean;
  readonly messageIds?: readonly string[] | ReadonlySet<string>;
  readonly messageIdBySource?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  readonly messageIdRenames?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** Message IDs whose base text has rich tags; see CodemodSourceOptions.richMessageIds. */
  readonly richMessageIds?: readonly string[] | ReadonlySet<string>;
}

export interface ReactMigrationSkip extends CodemodSkip {
  readonly kind: 'call' | 'hook' | 'root' | 'import';
}

export interface ReactMigrationPlan {
  readonly format: ReactMigrationFormat;
  readonly changed: boolean;
  readonly code: string;
  readonly replacements: number;
  readonly wrappedRoots: number;
  readonly generatedImport?: string;
  readonly removedImports: readonly string[];
  readonly skipped: readonly ReactMigrationSkip[];
  readonly sourceHash: string;
}

export interface ReactProjectFilePlan extends ReactMigrationPlan {
  readonly file: string;
}

export interface ReactProjectMigrationPlan {
  readonly root: string;
  readonly sourceDir: string;
  readonly filesScanned: number;
  readonly changed: readonly ReactProjectFilePlan[];
  readonly skipped: readonly ReactMigrationSkip[];
}

type Replacement = { start: number; end: number; text: string };
type ImportSpec = { imported: string; local: string; start: number; end: number; text: string };

const validIdentifier = /^[A-Za-z_$][\w$]*$/;
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const legacyModules = new Set(['react-i18next', 'i18next', 'react-intl', '@lingui/react', '@lingui/react/macro', '@tolgee/react']);
const legacyExports = new Set([
  'useTranslation', 'Trans', 'I18nextProvider', 'initReactI18next',
  'useIntl', 'IntlProvider', 'RawIntlProvider', 'FormattedMessage', 'defineMessages',
  'useLingui', 'I18nProvider', 'LinguiProvider',
  'useTranslate', 'TolgeeProvider', 'T',
]);

function maskCode(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i++; continue; }
      if (c === '/' && next === '*') { state = 'block'; i++; continue; }
      if (c === "'") { state = 'single'; continue; }
      if (c === '"') { state = 'double'; continue; }
      if (c === '`') { state = 'template'; continue; }
      mask[i] = 1; continue;
    }
    if (state === 'line') { if (c === '\n' || c === '\r') state = 'code'; continue; }
    if (state === 'block') { if (c === '*' && next === '/') { state = 'code'; i++; } continue; }
    if (c === '\\') { i++; continue; }
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) state = 'code';
  }
  return mask;
}

function sourceHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function codeMatches(text: string, pattern: RegExp): RegExpExecArray[] {
  const mask = maskCode(text), result: RegExpExecArray[] = [];
  for (const match of text.matchAll(pattern)) if (mask[match.index!] && match[0]) result.push(match);
  return result;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function balanced(text: string, open: number, left: string, right: string, mask = maskCode(text)): number | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (!mask[i]) continue;
    if (text[i] === left) depth++;
    else if (text[i] === right && --depth === 0) return i;
  }
}

function callArguments(text: string, open: number): string[] | undefined {
  const mask = maskCode(text), close = balanced(text, open, '(', ')', mask);
  if (close === undefined) return;
  const result: string[] = [];
  let start = open + 1, round = 0, square = 0, curly = 0;
  for (let i = start; i < close; i++) {
    if (!mask[i]) continue;
    if (text[i] === '(') round++; else if (text[i] === ')') round--;
    else if (text[i] === '[') square++; else if (text[i] === ']') square--;
    else if (text[i] === '{') curly++; else if (text[i] === '}') curly--;
    else if (text[i] === ',' && !round && !square && !curly) { result.push(text.slice(start, i).trim()); start = i + 1; }
  }
  const tail = text.slice(start, close).trim();
  if (tail || result.length) result.push(tail);
  return result;
}

function staticImportPath(value: string): string | undefined {
  const match = /^\s*(['"])([^'"]+)\1\s*$/.exec(value);
  return match?.[2];
}

function imports(text: string): Array<{ source: string; start: number; end: number; specs: ImportSpec[]; sideEffect: boolean }> {
  const result: Array<{ source: string; start: number; end: number; specs: ImportSpec[]; sideEffect: boolean }> = [];
  const pattern = /\bimport\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2\s*;?/g;
  for (const match of codeMatches(text, pattern)) {
    const clause = match[1]!, source = match[3]!, clauseStart = match.index! + match[0].indexOf(clause);
    const specs: ImportSpec[] = [];
    const named = /\{([\s\S]*?)\}/.exec(clause);
    if (named) {
      const base = clauseStart + named.index + 1;
      for (const item of named[1]!.split(',')) {
        const trimmed = item.trim(); if (!trimmed) continue;
        const parsed = /^(\w[\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(trimmed);
        if (!parsed) continue;
        const local = parsed[2] ?? parsed[1]!;
        const offset = item.indexOf(trimmed);
        specs.push({ imported: parsed[1]!, local, start: base + offset, end: base + offset + trimmed.length, text: trimmed });
      }
    }
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (namespace) {
      const offset = clause.indexOf(namespace[0]);
      specs.push({ imported: '*', local: namespace[1]!, start: clauseStart + offset, end: clauseStart + offset + namespace[0].length, text: namespace[0] });
    }
    const defaultImport = /^\s*([A-Za-z_$][\w$]*)/.exec(clause);
    if (defaultImport && !/^\s*\{/.test(clause) && !/^\s*\*/.test(clause)) {
      const offset = clause.indexOf(defaultImport[1]!);
      specs.push({ imported: 'default', local: defaultImport[1]!, start: clauseStart + offset, end: clauseStart + offset + defaultImport[1]!.length, text: defaultImport[1]! });
    }
    result.push({ source, start: match.index!, end: match.index! + match[0].length, specs, sideEffect: false });
  }
  const sideEffectPattern = /\bimport\s*(['"])([^'"]+)\1\s*;?/g;
  for (const match of codeMatches(text, sideEffectPattern)) if (!result.some(item => item.start === match.index!)) {
    result.push({ source: match[2]!, start: match.index!, end: match.index! + match[0].length, specs: [], sideEffect: true });
  }
  return result.sort((a, b) => a.start - b.start);
}

function identifierUses(text: string, local: string, excluded: Array<{ start: number; end: number }> = []): number {
  const pattern = new RegExp(`\\b${escapeRegExp(local)}\\b`, 'g'), mask = maskCode(text);
  let count = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    if (!mask[index] || excluded.some(range => index >= range.start && index < range.end)) continue;
    count++;
  }
  return count;
}

function normalizeFormat(format: ReactMigrationFormat): CodemodFormat {
  if (format === 'react-i18next' || format === 'i18next') return 'i18next';
  if (format === 'react-intl' || format === 'formatjs') return 'formatjs';
  if (format === 'lingui' || format === 'lingui-react') return 'lingui';
  if (format === 'tolgee' || format === 'tolgee-react') return 'tolgee';
  return format;
}

function relativeImport(options: ReactMigrationOptions): string {
  const modulePath = options.i18nImport ?? options.i18nModule ?? options.modulePath ?? './i18n.js';
  if (!options.filename || !options.root || !modulePath.startsWith('/')) return modulePath;
  let value = relative(dirname(resolve(options.filename)), resolve(options.root, modulePath));
  value = value.replace(/\.(?:tsx?|jsx?|mts|cts)$/, '');
  return value.startsWith('.') ? value : `./${value}`;
}

function initialAttribute(options: ReactMigrationOptions): string | undefined {
  const client = options.framework === 'vite-react' || options.initialLocaleExpression !== undefined || options.initialLocale !== undefined;
  const value = client
    ? options.initialLocaleExpression ?? options.initialLocale
    : options.initialExpression ?? options.initial;
  if (!value?.trim()) return;
  const expression = value.trim();
  const prop = client ? 'initialLocale' : 'initial';
  return expression.startsWith('{') && expression.endsWith('}') ? `${prop}=${expression}` : `${prop}={${expression}}`;
}

function generatedImport(local: string, module: string): string {
  return `import { ${local === 'i18n' ? 'i18n' : `i18n as ${local}`} } from ${JSON.stringify(module)};`;
}

function bindingExists(text: string, local: string): boolean {
  const escaped = escapeRegExp(local);
  for (const match of codeMatches(text, /\b(?:const|let|var)\s+([^;\n]+)/g)) {
    const declaration = match[1]!.trim();
    const binding = declaration.match(/^(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*=/)?.[1];
    if (!binding) continue;
    if (binding === local) return true;
    if (binding.startsWith('{') || binding.startsWith('[')) for (const field of binding.slice(1, -1).split(',')) {
      const parts = field.trim().split(':').map(item => item.trim()), name = parts.at(-1);
      if (name === local) return true;
    }
  }
  return codeMatches(text, new RegExp(`\\b(?:class|function)\\s+${escaped}\\b`, 'g')).length > 0
    || imports(text).some(item => item.specs.some(spec => spec.local === local));
}

function generatedLocal(text: string, requested: string): string {
  if (!bindingExists(text, requested)) return requested;
  let index = 0, candidate = 'nordbeamLocale';
  while (bindingExists(text, candidate)) candidate = `nordbeamLocale${++index}`;
  return candidate;
}

function providerWrapped(node: string, local: string): boolean {
  return new RegExp(`^\\s*<${escapeRegExp(local)}\\.Provider(?:\\s|>)`).test(node);
}

function rootReplacements(text: string, local: string, options: ReactMigrationOptions, skipped: ReactMigrationSkip[]): { replacements: Replacement[]; wrapped: number } {
  if (options.wrapRoots === false) return { replacements: [], wrapped: 0 };
  const initial = initialAttribute(options);
  const mask = maskCode(text), replacements: Replacement[] = [];
  let wrapped = 0;
  const importedRoots = new Set<string>();
  for (const item of imports(text)) if (item.source === 'react-dom/client') {
    for (const spec of item.specs) if (spec.imported === 'createRoot' || spec.imported === 'hydrateRoot') importedRoots.add(spec.local);
  }
  if (!importedRoots.size) return { replacements, wrapped };
  if (!initial) {
    for (const name of importedRoots) skipped.push({ kind: 'root', callee: name, reason: options.framework === 'vite-react' || options.initialLocaleExpression !== undefined || options.initialLocale !== undefined
      ? 'Vite client root requires an explicit initialLocaleExpression; locale was not guessed'
      : 'root wrapper requires an explicit initial snapshot expression; locale was not guessed' });
    return { replacements, wrapped };
  }
  const wrap = (node: string): string | undefined => {
    if (!/^\s*</.test(node) || providerWrapped(node, local)) return;
    return `<${local}.Provider ${initial}>${node.trim()}</${local}.Provider>`;
  };
  for (const name of importedRoots) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, 'g');
    for (const match of codeMatches(text, pattern)) {
      const open = match.index! + match[0].lastIndexOf('('), close = balanced(text, open, '(', ')', mask);
      if (close === undefined) continue;
      const args = callArguments(text, open); if (!args) continue;
      // Imported aliases still carry their original imported name in the import table.
      const isHydrate = [...imports(text)].some(item => item.source === 'react-dom/client' && item.specs.some(spec => spec.local === name && spec.imported === 'hydrateRoot'));
      if (isHydrate) {
        if (args.length < 2) continue;
        const node = args[1]!;
        const wrappedNode = wrap(node);
        if (!wrappedNode) { if (providerWrapped(node, local)) continue; skipped.push({ kind: 'root', callee: name, reason: 'root render argument is not a conventional JSX element' }); continue; }
        const start = text.indexOf(node, open + 1), end = start + node.length;
        replacements.push({ start, end, text: wrappedNode }); wrapped++;
      } else {
        const rootEnd = close + 1;
        const render = new RegExp(`\\.render\\s*\\(`, 'g'); render.lastIndex = rootEnd;
        const renderMatch = render.exec(text); if (!renderMatch || renderMatch.index > rootEnd + 160) continue;
        const renderOpen = renderMatch.index + renderMatch[0].lastIndexOf('('), renderArgs = callArguments(text, renderOpen);
        if (!renderArgs?.length) continue;
        const node = renderArgs[0]!;
        const wrappedNode = wrap(node);
        if (!wrappedNode) { if (providerWrapped(node, local)) continue; skipped.push({ kind: 'root', callee: name, reason: 'root render argument is not a conventional JSX element' }); continue; }
        const start = text.indexOf(node, renderOpen + 1), end = start + node.length;
        replacements.push({ start, end, text: wrappedNode }); wrapped++;
      }
    }
  }
  return { replacements, wrapped };
}

function hookDeclarations(text: string): Array<{ start: number; end: number; locals: string[]; translationLocals: string[]; hook: string }> {
  const result: Array<{ start: number; end: number; locals: string[]; translationLocals: string[]; hook: string }> = [];
  const pattern = /\b(?:const|let)\s+((?:\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*))\s*=\s*(?:await\s+)?(useTranslation|useIntl|useLingui|useTranslate)\s*\([^;\n]*\)\s*;?/g;
  for (const match of codeMatches(text, pattern)) {
    const declaration = match[1]!, hook = match[2]!, locals: string[] = [], translationLocals: string[] = [];
    if (declaration.startsWith('{') || declaration.startsWith('[')) {
      for (const field of declaration.slice(1, -1).split(',')) {
        const item = field.trim(); if (!item || item.startsWith('...')) continue;
        const parts = item.split(':').map(value => value.trim()), local = (parts[1] ?? parts[0] ?? '').replace(/^\.{3}/, '').trim();
        if (!validIdentifier.test(local)) continue;
        locals.push(local);
        const property = parts[0];
        if ((hook === 'useTranslation' && property === 't') || (hook === 'useIntl' && (property === 'formatMessage' || property === 'intl')) || (hook === 'useLingui' && (property === 'i18n' || property === '_' || property === 't')) || (hook === 'useTranslate' && property === 't')) translationLocals.push(local);
      }
    } else { locals.push(declaration); translationLocals.push(declaration); }
    result.push({ start: match.index!, end: match.index! + match[0].length, locals, translationLocals, hook });
  }
  return result;
}

function blockStartAt(text: string, offset: number): number {
  const mask = maskCode(text), stack: number[] = [];
  for (let i = 0; i < offset; i++) if (mask[i]) {
    if (text[i] === '{') stack.push(i);
    else if (text[i] === '}') stack.pop();
  }
  return stack.at(-1) ?? -1;
}

function usesOutsideHookDeclarations(text: string, local: string): number {
  let body = text;
  const declarations = hookDeclarations(text).sort((a, b) => b.start - a.start);
  for (const declaration of declarations) body = body.slice(0, declaration.start) + body.slice(declaration.end);
  return identifierUses(body, local);
}

function conditionalHook(text: string, declaration: { start: number }): boolean {
  const lineStart = text.lastIndexOf('\n', declaration.start - 1) + 1;
  const line = text.slice(lineStart, declaration.start);
  // A hook nested directly in a control-flow block cannot be made safe by a
  // textual codemod. Leave it untouched instead of manufacturing a Rules of
  // Hooks violation.
  if (/\b(?:if|for|while|switch|catch)\s*\([^)]*\)\s*\{?\s*$/.test(line)) return true;
  const previous = text.slice(0, lineStart).split(/\r?\n/).at(-2)?.trim() ?? '';
  return /\b(?:if|for|while|switch|catch)\s*\([^)]*\)\s*\{\s*$/.test(previous);
}

function addMessageBindings(text: string, local: string, declarations: ReturnType<typeof hookDeclarations>, skipped: ReactMigrationSkip[]): string {
  const replacements: Replacement[] = [];
  for (const declaration of declarations) {
    const generatedBinding = new RegExp(`^\\s*const\\s+m\\s*=\\s*${escapeRegExp(local)}\\.useMessages\\(\\)\\s*;?`);
    if (generatedBinding.test(text.slice(declaration.end))) continue;
    if (conditionalHook(text, declaration)) {
      skipped.push({ kind: 'hook', callee: declaration.hook, reason: 'hook declaration is inside conditional control flow; migration would violate the Rules of Hooks', offset: declaration.start });
      continue;
    }
    if (!declaration.translationLocals.length || declaration.locals.some(item => !declaration.translationLocals.includes(item))) {
      skipped.push({ kind: 'hook', callee: declaration.hook, reason: 'hook destructuring includes non-translation state; binding was left unchanged', offset: declaration.start });
      continue;
    }
    if (declaration.locals.some(item => item === 'm') && declaration.translationLocals.length !== 1) {
      skipped.push({ kind: 'hook', callee: declaration.hook, reason: 'message binding name collides with generated m binding', offset: declaration.start });
      continue;
    }
    const remaining = declaration.locals.some(item => usesOutsideHookDeclarations(text, item) > 0);
    const original = text.slice(declaration.start, declaration.end);
    if (remaining) {
      // Keep a legacy hook alive when the same object is used for non-message
      // APIs (formatDate, changeLanguage, readiness, etc.).
      replacements.push({ start: declaration.end, end: declaration.end, text: `\nconst m = ${local}.useMessages();` });
    } else {
      replacements.push({ start: declaration.start, end: declaration.end, text: `const m = ${local}.useMessages();` });
    }
    void original;
  }
  replacements.sort((a, b) => b.start - a.start);
  let code = text; for (const item of replacements) code = code.slice(0, item.start) + item.text + code.slice(item.end);
  return code;
}

type AstNode = { type?: string; start?: number; end?: number; [key: string]: unknown };

/** Bind `m` at the top of each component or hook (a function named `Name` or `useName`) that
 * uses it with no binding in scope. A file whose messages were all `<Trans>` elements had no
 * useLingui() for addMessageBindings to replace. Counts the references no component encloses:
 * a hook cannot bind those, so the caller leaves the file unchanged. */
function bindComponentMessages(text: string, local: string): { code: string; unbound: number } {
  let program: AstNode;
  try { program = parse(text, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'] }).program as unknown as AstNode; }
  catch { return { code: text, unbound: 1 }; }
  const functionLike = (node: AstNode): boolean => /Function(?:Declaration|Expression)$|^(?:ArrowFunctionExpression|ObjectMethod|ClassMethod|ClassPrivateMethod)$/.test(node.type ?? '');
  const nameOf = (value: unknown): string | undefined => {
    const node = value as AstNode & { name?: string; property?: unknown } | undefined;
    return node?.type === 'Identifier' ? node.name : node?.type === 'MemberExpression' ? nameOf(node.property) : undefined;
  };
  const declaresM = (value: unknown): boolean => {
    const node = value as AstNode | undefined;
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'Identifier') return (node as { name?: string }).name === 'm';
    if (node.type === 'VariableDeclaration') return (node.declarations as AstNode[]).some(item => declaresM(item.id));
    if (node.type === 'ImportDeclaration') return (node.specifiers as AstNode[]).some(item => declaresM(item.local));
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') return declaresM(node.id);
    if (node.type === 'ObjectPattern') return (node.properties as AstNode[]).some(item => declaresM(item.type === 'RestElement' ? item.argument : item.value));
    if (node.type === 'ArrayPattern') return (node.elements as Array<AstNode | null>).some(item => declaresM(item));
    if (node.type === 'AssignmentPattern') return declaresM(node.left);
    if (node.type === 'RestElement') return declaresM(node.argument);
    if (node.type === 'TSParameterProperty') return declaresM(node.parameter);
    return false;
  };
  const bound = (ancestors: readonly AstNode[]): boolean => ancestors.some(node =>
    functionLike(node) ? (node.params as AstNode[]).some(declaresM)
    : node.type === 'BlockStatement' || node.type === 'Program' ? (node.body as AstNode[]).some(item => declaresM(item) || (item.type === 'ExportNamedDeclaration' && declaresM(item.declaration)))
    : false);
  const inserts = new Map<number, string>();
  let unbound = 0;
  const visit = (node: AstNode, ancestors: AstNode[], names: Map<AstNode, string | undefined>, hint?: string): void => {
    if (functionLike(node)) names.set(node, nameOf(node.id) ?? (/Method$/.test(node.type!) ? nameOf(node.key) ?? '' : hint));
    const parent = ancestors.at(-1);
    if (node.type === 'Identifier' && (node as { name?: string }).name === 'm' && parent?.type === 'MemberExpression' && parent.object === node && !bound(ancestors)) {
      const component = [...ancestors].reverse().find(item => functionLike(item) && /^(?:[A-Z]|use[A-Z0-9])/.test(names.get(item) ?? ''));
      const body = component?.body as AstNode | undefined;
      if (!body) unbound++;
      else if (body.type === 'BlockStatement') {
        // Indent like the body's first statement, or one step past the line that opens it.
        const first = (body.body as AstNode[])[0];
        const indent = first ? /[ \t]*$/.exec(text.slice(0, first.start))![0] : `${/^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', body.start!) + 1))![0]}  `;
        inserts.set(body.start! + 1, `\n${indent}const m = ${local}.useMessages();`);
      } else { inserts.set(body.start!, `{ const m = ${local}.useMessages(); return (`); inserts.set(body.end!, ');}'); }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'type' || /Comments$/.test(key)) continue;
      const childHint = node.type === 'VariableDeclarator' && key === 'init' ? nameOf(node.id)
        : node.type === 'AssignmentExpression' && key === 'right' ? nameOf(node.left)
        : (node.type === 'CallExpression' && key === 'arguments') || node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'ParenthesizedExpression' ? hint : undefined;
      for (const item of Array.isArray(child) ? child : [child]) if (item && typeof item === 'object' && typeof (item as AstNode).type === 'string') visit(item as AstNode, [...ancestors, node], names, childHint);
    }
  };
  visit(program, [], new Map());
  let code = text;
  for (const [offset, insert] of [...inserts].sort((left, right) => right[0] - left[0])) code = code.slice(0, offset) + insert + code.slice(offset);
  return { code, unbound };
}

/** A component that renders `render(m)` with the current messages: a message element outside
 * any component stays lazy, rendering in the current locale as Lingui's `<Trans>` did. Function
 * declarations hoist, so module-scope elements may use it before this line. */
function messageComponentDeclaration(name: string, local: string, typed: boolean): string {
  return typed
    ? `\n/** Renders a message outside a component, in the current locale. Generated by Nordbeam Locale's migration. */\nfunction ${name}({ render }: { render: (m: ReturnType<typeof ${local}.useMessages>) => React.ReactNode }) {\n  return <>{render(${local}.useMessages())}</>;\n}\n`
    : `\n/** Renders a message outside a component, in the current locale. Generated by Nordbeam Locale's migration. */\nfunction ${name}({ render }) {\n  return <>{render(${local}.useMessages())}</>;\n}\n`;
}

function removeDeadImports(text: string, skipped: ReactMigrationSkip[]): { code: string; removed: string[] } {
  const replacements: Replacement[] = [], removed: string[] = [];
  for (const declaration of imports(text)) {
    if (!legacyModules.has(declaration.source) || declaration.sideEffect) continue;
    const candidates = declaration.specs.filter(spec => spec.imported === 'default' || spec.imported === '*' || legacyExports.has(spec.imported));
    const dead = candidates.filter(spec => identifierUses(text, spec.local, [{ start: declaration.start, end: declaration.end }]) === 0);
    if (!dead.length) continue;
    const named = declaration.specs.filter(spec => spec.imported !== 'default' && spec.imported !== '*');
    const keep = declaration.specs.filter(spec => !dead.includes(spec));
    if (!keep.length) { replacements.push({ start: declaration.start, end: declaration.end, text: '' }); removed.push(...dead.map(item => item.local)); continue; }
    let rewritten = text.slice(declaration.start, declaration.end);
    if (named.length) {
      const namedMatch = /\{([\s\S]*?)\}/.exec(rewritten);
      if (namedMatch) {
        const keepNamed = named.filter(spec => !dead.includes(spec)).map(spec => spec.text).join(', ');
        if (!keepNamed) rewritten = rewritten.replace(namedMatch[0], '');
        else rewritten = rewritten.replace(namedMatch[0], `{ ${keepNamed} }`);
      }
    }
    for (const spec of dead.filter(item => item.imported === 'default' || item.imported === '*')) {
      rewritten = rewritten.replace(new RegExp(`\\b${escapeRegExp(spec.text)}(?:\\s*,\\s*)?`), '');
    }
    rewritten = rewritten.replace(/import\s+from\s+/, 'import ');
    replacements.push({ start: declaration.start, end: declaration.end, text: rewritten }); removed.push(...dead.map(item => item.local));
  }
  replacements.sort((a, b) => b.start - a.start);
  let code = text; for (const item of replacements) code = code.slice(0, item.start) + item.text + code.slice(item.end);
  return { code, removed };
}

function insertImport(text: string, local: string, module: string): { code: string; inserted?: string } {
  const existing = imports(text).find(item => item.source === module && item.specs.some(spec => spec.local === local));
  if (existing) return { code: text };
  const statement = generatedImport(local, module);
  const directive = /^((?:\s*['"][^'"\n]+['"]\s*;?\s*\n)+)/.exec(text);
  const offset = directive ? directive[1]!.length : 0;
  return { code: text.slice(0, offset) + statement + '\n' + text.slice(offset), inserted: statement };
}

/** Plan one source file. The returned code is always a preview; no files are written. */
export function planReactMigration(source: string, options: ReactMigrationOptions = {}): ReactMigrationPlan {
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  const format = options.format ?? 'auto', codemodFormat = normalizeFormat(format), requestedLocal = options.i18nName ?? 'i18n';
  if (!validIdentifier.test(requestedLocal)) throw new TypeError('i18nName must be a JavaScript identifier.');
  const module = relativeImport(options);
  const local = imports(source).some(item => item.source === module && item.specs.some(spec => spec.local === requestedLocal))
    ? requestedLocal : generatedLocal(source, requestedLocal);
  const skipped: ReactMigrationSkip[] = [];
  const declarations = hookDeclarations(source);
  const scopes = declarations.map(declaration => blockStartAt(source, declaration.start));
  const duplicateScope = scopes.some((scope, index) => scopes.indexOf(scope) !== index);
  // A file without a hook declaration (only `<Trans>` elements) is rewritten too: its
  // components bind m themselves, below.
  const rewriteAllowed = declarations.every(declaration =>
    !conditionalHook(source, declaration)
    && declaration.translationLocals.length > 0
    && declaration.locals.every(item => declaration.translationLocals.includes(item))
    && !(declaration.locals.some(item => item === 'm') && declaration.translationLocals.length !== 1))
    && !duplicateScope;
  if (!rewriteAllowed) for (const declaration of declarations) {
    if (conditionalHook(source, declaration)) skipped.push({ kind: 'hook', callee: declaration.hook, reason: 'hook declaration is inside conditional control flow; migration would violate the Rules of Hooks', offset: declaration.start });
    else if (!declaration.translationLocals.length || declaration.locals.some(item => !declaration.translationLocals.includes(item))) skipped.push({ kind: 'hook', callee: declaration.hook, reason: 'hook destructuring includes non-translation state; binding was left unchanged', offset: declaration.start });
    else if (duplicateScope) skipped.push({ kind: 'hook', callee: declaration.hook, reason: 'multiple hook bindings share one lexical scope; generated m binding would collide', offset: declaration.start });
  }
  // Tolgee v4 returns the translator directly, while v5 returns `{ t }`.
  // Normalize the former only for the isolated call detector; the generated
  // hook binding below replaces either spelling in the final source.
  const codemodInput = codemodFormat === 'tolgee' || codemodFormat === 'auto'
    ? source.replace(/\b(const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*useTranslate\(\s*\)/g, '$1 { t: $2 } = useTranslate()')
    : source;
  let messageComponent = 'LocaleMessage';
  for (let index = 2; bindingExists(source, messageComponent); index++) messageComponent = `LocaleMessage${index}`;
  const jsxFile = !options.filename || /\.[cm]?[jt]sx$/.test(options.filename) || /\.[cm]?js$/.test(options.filename);
  let callResult = rewriteAllowed
    ? codemodSource(codemodInput, codemodFormat, { messagesObject: '__NORD_BEAM_MESSAGES__', filename: options.filename, messageIds: options.messageIds, messageIdBySource: options.messageIdBySource, messageIdRenames: options.messageIdRenames,
      richMessageIds: options.richMessageIds, ...(jsxFile ? { messageComponent } : {}), cleanup: false })
    : { code: source, replacements: 0, skipped: [] as readonly CodemodSkip[] };
  let code = callResult.code.replaceAll('__NORD_BEAM_MESSAGES__', 'm');
  const needsMessageBinding = rewriteAllowed && callResult.replacements > 0;
  if (needsMessageBinding) {
    code = addMessageBindings(code, local, hookDeclarations(code), skipped);
    // A component whose messages had no hook declaration binds m at its top. A file that
    // declares an m of its own, or uses m where no component encloses it, is left unchanged.
    const bound = bindComponentMessages(code, local);
    const ownM = /\b(?:const|let|var|function|class)\s+m\b|\bimport\s+m\b|\bas\s+m\b|\(\s*m\s*[,)]|\bm\s*=>/.test(source);
    if (bound.unbound || ownM) {
      skipped.push({ kind: 'call', callee: 'm', code: 'MISSING_MESSAGES_BINDING', reason: ownM ? 'the file declares an m of its own, so the generated messages binding would collide; no rewrites applied' : `${bound.unbound} rewritten message reference(s) are outside any component or hook, where m cannot be bound; no rewrites applied`,
        action: 'Rename the local m, or move the messages into a component, then re-run the migration.' });
      callResult = { code: source, replacements: 0, skipped: callResult.skipped };
      code = source;
    } else {
      code = bound.code;
      if (code.includes(`<${messageComponent} render=`)) code = code.replace(/\n*$/, '\n') + messageComponentDeclaration(messageComponent, local, /\.[cm]?tsx$/.test(options.filename ?? '.tsx'));
    }
  }
  skipped.push(...callResult.skipped.map(item => ({ ...item, kind: 'call' as const })));
  const roots = rootReplacements(code, local, options, skipped);
  const rootReplacementsSorted = roots.replacements.sort((a, b) => b.start - a.start);
  for (const replacement of rootReplacementsSorted) code = code.slice(0, replacement.start) + replacement.text + code.slice(replacement.end);
  let generatedImport: string | undefined;
  const providerNeedsImport = new RegExp(`<${escapeRegExp(local)}\\.Provider\\b`).test(code)
    && !imports(code).some(item => item.source === module && item.specs.some(spec => spec.local === local));
  const needsImport = (needsMessageBinding && callResult.replacements > 0) || roots.wrapped > 0 || providerNeedsImport;
  if (needsImport) {
    const inserted = insertImport(code, local, module); code = inserted.code; generatedImport = inserted.inserted;
  }
  const importsResult = removeDeadImports(code, skipped); code = importsResult.code;
  const changed = code !== source;
  return { format, changed, code, replacements: callResult.replacements, wrappedRoots: roots.wrapped, ...(generatedImport ? { generatedImport } : {}), removedImports: importsResult.removed, skipped, sourceHash: sourceHash(source) };
}

/** Apply a source plan. This pure API intentionally returns text; callers own persistence. */
export function applyReactMigration(plan: ReactMigrationPlan): string;
export function applyReactMigration(source: string, options?: ReactMigrationOptions): string;
export function applyReactMigration(planOrSource: ReactMigrationPlan | string, options: ReactMigrationOptions = {}): string {
  return typeof planOrSource === 'string' ? planReactMigration(planOrSource, options).code : planOrSource.code;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !new Set(['node_modules', '.git', 'dist', 'build', 'coverage']).has(entry.name)) await visit(resolve(current, entry.name));
      else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) result.push(resolve(current, entry.name));
    }
  }
  await visit(directory); return result;
}

/** Plan all React/Vite source files below sourceDir. */
export async function planReactProject(options: ReactMigrationOptions & { root?: string; sourceDir?: string }): Promise<ReactProjectMigrationPlan> {
  const root = resolve(options.root ?? '.');
  const sourceDir = resolve(root, options.sourceDir ?? 'src');
  const files = await sourceFiles(sourceDir), changed: ReactProjectFilePlan[] = [], skipped: ReactMigrationSkip[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const plan = planReactMigration(source, { ...options, root, filename: file });
    const filePlan = { ...plan, file };
    if (plan.changed) changed.push(filePlan);
    skipped.push(...plan.skipped.map(item => ({ ...item, file })));
  }
  return { root, sourceDir, filesScanned: files.length, changed, skipped };
}

/** Apply a previously planned project migration (or plan then apply options). */
export async function applyReactProject(plan: ReactProjectMigrationPlan): Promise<ReactProjectMigrationPlan>;
export async function applyReactProject(options: ReactMigrationOptions & { root?: string; sourceDir?: string }): Promise<ReactProjectMigrationPlan>;
export async function applyReactProject(planOrOptions: ReactProjectMigrationPlan | (ReactMigrationOptions & { root?: string; sourceDir?: string })): Promise<ReactProjectMigrationPlan> {
  const plan = 'changed' in planOrOptions && 'filesScanned' in planOrOptions
    ? planOrOptions
    : await planReactProject(planOrOptions);
  const staged: Array<{ file: string; temporary: string }> = [];
  try {
    // A plan is a preview of specific bytes. Refuse to overwrite edits made
    // after planning, even when the destination still exists.
    for (const file of plan.changed) {
      const current = await readFile(file.file, 'utf8');
      if (sourceHash(current) !== file.sourceHash) throw new Error(`React migration plan is stale for ${file.file}; re-plan before applying.`);
    }
    for (const file of plan.changed) {
      await mkdir(dirname(file.file), { recursive: true });
      const temporary = `${file.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, file.code, { flag: 'wx' });
      staged.push({ file: file.file, temporary });
    }
    for (const item of staged) await rename(item.temporary, item.file);
  } finally {
    for (const item of staged) await unlink(item.temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  return plan;
}

// Short aliases make the API pleasant for CLI adapters while retaining explicit names.
export const planReact = planReactMigration;
export const applyReact = applyReactMigration;
export const planReactFrameworkMigration = planReactMigration;
export const applyReactFrameworkMigration = applyReactMigration;
