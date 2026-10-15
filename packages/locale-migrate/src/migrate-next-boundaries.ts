import type { NextSourceMigrationResult } from './migrate-next.js';

/** next-intl owns three small boundary modules next to the app: the routing definition, the navigation
 * helpers and the Next config plugin. Each has a Nordbeam equivalent with the same shape, so a
 * conventional file is rewritten; anything else is reported with the exact manual step. */

const unchanged = (code: string, file: string, reason?: string): NextSourceMigrationResult => ({
  code, replacements: 0, skipped: reason ? [{ file, reason, kind: 'framework' }] : [],
});

/** Swap `import { <name> } from '<legacy>'` for the Nordbeam module when `<name>` is the only member. */
function swapNamedImport(text: string, file: string, legacy: string, name: string, target: string, description: string): NextSourceMigrationResult {
  const escaped = legacy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*(['"])${escaped}\\2`, 'g');
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return unchanged(text, file, new RegExp(`['"]${escaped}['"]`).test(text) ? `${description} is not a named import of ${name} from ${legacy}; replace it with ${target} by hand` : undefined);
  for (const match of matches) {
    const members = match[1]!.split(',').map(member => member.trim()).filter(Boolean);
    if (members.length !== 1 || members[0] !== name) {
      return unchanged(text, file, `${legacy} imports ${members.filter(member => member !== name).join(', ') || 'a different export'} besides ${name}; Nordbeam has no equivalent for it, so migrate this file by hand (${target} exports ${name})`);
    }
  }
  return { code: text.replace(pattern, (_all, _members, quote: string) => `import { ${name} } from ${quote}${target}${quote}`), replacements: matches.length, skipped: [], framework: 'next-intl' };
}

/** `defineRouting` from next-intl/routing is the same identity helper with the same options as the Nordbeam one. */
export function migrateNextIntlRoutingSource(text: string, file = 'routing.ts'): NextSourceMigrationResult {
  if (!/['"]next-intl\/routing['"]/.test(text)) return unchanged(text, file);
  return swapNamedImport(text, file, 'next-intl/routing', 'defineRouting', '@nordbeam/locale/next/routing', 'The next-intl routing definition');
}

/** `createNavigation(routing)` returns the same Link, redirect, usePathname, useRouter and getPathname. */
export function migrateNextIntlNavigationSource(text: string, file = 'navigation.ts'): NextSourceMigrationResult {
  if (!/['"]next-intl\/navigation['"]/.test(text)) return unchanged(text, file);
  return swapNamedImport(text, file, 'next-intl/navigation', 'createNavigation', '@nordbeam/locale/next/navigation', 'The next-intl navigation module');
}

/** Index of the parenthesis that closes the call opened at `open`, ignoring strings. */
function closingParenthesis(text: string, open: number): number | undefined {
  let depth = 0, quote: string | undefined;
  for (let index = open; index < text.length; index++) {
    const character = text[index]!;
    if (quote) { if (character === '\\') index++; else if (character === quote) quote = undefined; continue; }
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === '(') depth++;
    else if (character === ')' && --depth === 0) return index;
  }
}

/** Replace `createNextIntlPlugin('./i18n/request.ts')` and its `withNextIntl(config)` wrapper with `withNordbeamLocale(config)`.
 * The plugin argument only names the request-config file, which Nordbeam does not read. */
export function migrateNextIntlConfigSource(text: string, file = 'next.config.ts'): NextSourceMigrationResult {
  const imported = /import\s+(?:([A-Za-z_$][\w$]*)|\{\s*default\s+as\s+([A-Za-z_$][\w$]*)\s*\})\s*from\s*(['"])next-intl\/plugin\3\s*;?[ \t]*\n?/.exec(text);
  if (!imported) return unchanged(text, file, /['"]next-intl\/plugin['"]/.test(text) ? 'createNextIntlPlugin is not a default import; replace it with withNordbeamLocale from @nordbeam/locale/next by hand' : undefined);
  const factory = (imported[1] ?? imported[2])!;
  const manual = (reason: string): NextSourceMigrationResult => unchanged(text, file, `${reason}; replace createNextIntlPlugin with withNordbeamLocale from @nordbeam/locale/next by hand`);
  let code = text.replace(imported[0], '');
  const call = new RegExp(`\\b${factory.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
  let result = '', cursor = 0, wrapper: string | undefined;
  for (const match of code.matchAll(call)) {
    if (match.index! < cursor) continue;
    const open = match.index! + match[0].length - 1, close = closingParenthesis(code, open);
    if (close === undefined) return manual('createNextIntlPlugin has an unbalanced call');
    const argument = code.slice(open + 1, close).trim();
    if (argument && !/^(['"])[^'"\\]*\1$/.test(argument)) return manual('createNextIntlPlugin receives options other than the request-config path');
    const before = code.slice(0, match.index!), declaration = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*$/.exec(before);
    if (declaration) {
      // `const withNextIntl = createNextIntlPlugin(path);` is dropped and its uses become withNordbeamLocale.
      wrapper = declaration[1];
      let end = close + 1;
      if (code[end] === ';') end++;
      if (code[end] === '\n') end++;
      result += code.slice(cursor, declaration.index!);
      cursor = end;
    } else if (/^\s*\(/.test(code.slice(close + 1))) {
      // `createNextIntlPlugin(path)(config)` calls the plugin in place.
      result += code.slice(cursor, match.index!) + 'withNordbeamLocale';
      cursor = close + 1;
    } else return manual('createNextIntlPlugin is used in a form this migration does not recognise');
  }
  result += code.slice(cursor);
  code = result;
  if (wrapper) {
    const uses = new RegExp(`\\b${wrapper.replace(/\$/g, '\\$')}\\b`, 'g');
    const bare = [...code.matchAll(uses)].filter(match => !/^\s*\(/.test(code.slice(match.index! + match[0].length)));
    if (bare.length) return manual(`${wrapper} is used other than as ${wrapper}(config)`);
    code = code.replace(uses, 'withNordbeamLocale');
  }
  if (!/\bwithNordbeamLocale\b/.test(code.replace(/import[^\n]*withNordbeamLocale[^\n]*/g, ''))) return manual('the plugin wrapper is never applied to the Next config');
  if (!/import\s*\{[^}]*\bwithNordbeamLocale\b[^}]*\}\s*from\s*['"]@nordbeam\/locale\/next['"]/.test(code)) {
    const lastImport = [...code.matchAll(/^import[^\n]*\n/gm)].at(-1);
    const statement = "import { withNordbeamLocale } from '@nordbeam/locale/next';\n";
    code = lastImport ? code.slice(0, lastImport.index! + lastImport[0].length) + statement + code.slice(lastImport.index! + lastImport[0].length) : statement + code;
  }
  return { code, replacements: 1, skipped: [], framework: 'next-intl' };
}
