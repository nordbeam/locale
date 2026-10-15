/**
 * Shared routing policy for the Next.js middleware and navigation adapters.
 * Pure and Edge-safe: no React, Next or Node imports.
 *
 * Paths handled here are percent-encoded URL paths. Pattern params are decoded
 * once when matched and encoded once per segment when filled, so a value that
 * is already decoded (`a/b`, `100%`, `café`) is never decoded or encoded twice.
 */

export type NextLocalePrefixMode = 'always' | 'as-needed' | 'never';

export interface NextLocaleCookieOptions {
  readonly name?: string;
  readonly sameSite?: 'lax' | 'strict' | 'none';
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly maxAge?: number;
}

/** A localized pattern, or a string used for every locale. A missing locale falls back to the internal pattern. */
export type NextPathnameValue<Locale extends string = string> = string | Partial<Record<Locale, string>>;
export type NextPathnamesInput<Locale extends string = string> = Readonly<Record<string, NextPathnameValue<Locale>>>;

/**
 * A host that serves some of the locales. `domain` is a host with an optional
 * port, such as `example.de` or `localhost:3001`. `locales` defaults to all
 * routing locales. `defaultLocale` is the locale of unprefixed paths on the host.
 */
export interface NextDomain<Locale extends string = string> {
  readonly domain: string;
  readonly defaultLocale: NoInfer<Locale>;
  readonly locales?: readonly NoInfer<Locale>[];
}

export interface NextRouting<Locale extends string = string, Pathnames extends NextPathnamesInput<Locale> = NextPathnamesInput<Locale>> {
  readonly locales: readonly Locale[];
  readonly defaultLocale: Locale;
  readonly localePrefix?: NextLocalePrefixMode | { readonly mode: NextLocalePrefixMode; readonly prefixes?: Partial<Record<Locale, string>> };
  readonly localeDetection?: boolean;
  readonly localeCookie?: boolean | NextLocaleCookieOptions;
  readonly alternateLinks?: boolean;
  /** Internal pattern (`/blog/[slug]`) to its localized pattern per locale. */
  readonly pathnames?: Pathnames;
  /** Hosts that serve a subset of the locales. Requests on other hosts use the routing itself. */
  readonly domains?: readonly NextDomain<Locale>[];
}

export type NextQueryValue = string | number | boolean | null | undefined;
export type NextQuery = Readonly<Record<string, NextQueryValue | readonly NextQueryValue[]>> | string;
export type NextPathParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Pattern parameter types, read from the `[param]`, `[...param]` and `[[...param]]` segments of a pattern. */
type SegmentParams<S extends string> =
  S extends `[[...${infer Name}]]` ? { readonly [K in Name]?: string[] }
  : S extends `[...${infer Name}]` ? { readonly [K in Name]: string[] }
  : S extends `[${infer Name}]` ? { readonly [K in Name]: string }
  : {};

export type PathParams<Pattern extends string> = Pattern extends `${infer Head}/${infer Tail}`
  ? SegmentParams<Head> & PathParams<Tail>
  : SegmentParams<Pattern>;

interface NextPathnameObjectBase {
  readonly query?: NextQuery;
  readonly hash?: string;
}

type PatternHref<Pattern extends string> = [keyof PathParams<Pattern>] extends [never]
  ? NextPathnameObjectBase & { readonly pathname: Pattern; readonly params?: undefined }
  : {} extends PathParams<Pattern>
    ? NextPathnameObjectBase & { readonly pathname: Pattern; readonly params?: PathParams<Pattern> }
    : NextPathnameObjectBase & { readonly pathname: Pattern; readonly params: PathParams<Pattern> };

/** Object form of an internal href. With typed pathnames, `pathname` is one of the keys and `params` follow its pattern. */
export type NextPathnameHref<Pathnames> = string extends keyof Pathnames
  ? NextPathnameObjectBase & { readonly pathname: string; readonly params?: NextPathParams }
  : { [Pattern in keyof Pathnames & string]: PatternHref<Pattern> }[keyof Pathnames & string];

/** Any href the routing helpers understand. Objects are either a concrete path or a pattern with params. */
export type NextRoutingHref = string | URL | {
  readonly pathname?: string | null;
  readonly params?: NextPathParams;
  readonly query?: unknown;
  readonly hash?: string | null;
};

const segmentRanks = { static: 0, param: 1, rest: 2, optional: 3 } as const;
const paramName = '[A-Za-z_][A-Za-z0-9_]*';
const optionalPattern = new RegExp(`^\\[\\[\\.\\.\\.(${paramName})\\]\\]$`);
const restPattern = new RegExp(`^\\[\\.\\.\\.(${paramName})\\]$`);
const dynamicPattern = new RegExp(`^\\[(${paramName})\\]$`);

interface Segment {
  readonly kind: keyof typeof segmentRanks;
  /** Decoded static text, or the param name. */
  readonly value: string;
}

interface Pattern {
  readonly source: string;
  readonly segments: readonly Segment[];
  readonly signature: string;
  readonly shape: string;
}

interface Entry {
  readonly pattern: Pattern;
  readonly localized: ReadonlyMap<string, Pattern>;
}

interface Compiled {
  readonly entries: readonly Entry[];
  readonly byLocale: ReadonlyMap<string, readonly Entry[]>;
  /** Locale prefixes, longest first, for `matchLocalePrefix`. */
  readonly prefixes: readonly { readonly locale: string; readonly prefix: string }[];
  /** The routing each normalized domain is served with, keyed by host. */
  readonly domains: ReadonlyMap<string, NextRouting<any, any>>;
  /** The first domain that serves each locale. */
  readonly served: ReadonlyMap<string, string>;
}

const compiledRoutings = new WeakMap<object, Compiled>();

function compilePattern(source: string): Pattern {
  if (typeof source !== 'string' || !source.startsWith('/') || source.startsWith('//') || (source.length > 1 && source.endsWith('/'))) {
    throw new TypeError(`Nordbeam pathname '${source}' must start with '/' and must not end with '/' or contain '//'.`);
  }
  const parts = source === '/' ? [] : source.slice(1).split('/');
  const segments = parts.map((part, index): Segment => {
    const optional = part.match(optionalPattern);
    if (optional) return checkEnd({ kind: 'optional', value: optional[1]! }, index);
    const rest = part.match(restPattern);
    if (rest) return checkEnd({ kind: 'rest', value: rest[1]! }, index);
    const param = part.match(dynamicPattern);
    if (param) return { kind: 'param', value: param[1]! };
    if (!part || /[[\]?#]/.test(part)) throw new TypeError(`Nordbeam pathname '${source}' has an invalid segment '${part}'.`);
    return { kind: 'static', value: part };
  });
  const names = segments.flatMap(segment => segment.kind === 'static' ? [] : [segment.value]);
  if (new Set(names).size !== names.length) throw new TypeError(`Nordbeam pathname '${source}' repeats a param name.`);
  const signature = segments.flatMap(segment => segment.kind === 'static' ? [] : [`${segment.kind}:${segment.value}`]).sort().join(',');
  const shape = segments.map(segment => segment.kind === 'static' ? `s:${segment.value}` : segment.kind).join('/');
  return { source, segments, signature, shape };

  function checkEnd(segment: Segment, index: number): Segment {
    if (index !== parts.length - 1) throw new TypeError(`Nordbeam pathname '${source}': catch-all segments must be the last segment.`);
    return segment;
  }
}

/** Static before dynamic before catch-all, then fewer segments first. Used for every match, so the order is total. */
function specificity(left: Pattern, right: Pattern): number {
  const length = Math.min(left.segments.length, right.segments.length);
  for (let index = 0; index < length; index++) {
    const difference = segmentRanks[left.segments[index]!.kind] - segmentRanks[right.segments[index]!.kind];
    if (difference) return difference;
  }
  return left.segments.length - right.segments.length;
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function matchPattern(pattern: Pattern, segments: readonly string[]): NextPathParams | undefined {
  const params: Record<string, string | string[] | undefined> = {};
  for (let index = 0; index < pattern.segments.length; index++) {
    const { kind, value } = pattern.segments[index]!;
    if (kind === 'rest' || kind === 'optional') {
      const rest = segments.slice(index).map(safeDecode);
      if (kind === 'rest' && !rest.length) return undefined;
      params[value] = rest.length ? rest : undefined;
      return params;
    }
    if (index >= segments.length) return undefined;
    if (kind === 'static') {
      if (safeDecode(segments[index]!) !== value) return undefined;
    } else {
      params[value] = safeDecode(segments[index]!);
    }
  }
  return segments.length === pattern.segments.length ? params : undefined;
}

function fillPattern(pattern: Pattern, params: NextPathParams = {}): string {
  const out: string[] = [];
  for (const segment of pattern.segments) {
    if (segment.kind === 'static') {
      out.push(encodeURIComponent(segment.value));
      continue;
    }
    const value = params[segment.value];
    if (segment.kind === 'param') {
      if (typeof value !== 'string' || !value) throw new TypeError(`Nordbeam pathname '${pattern.source}' needs a non-empty string for param '${segment.value}'.`);
      out.push(encodeURIComponent(value));
      continue;
    }
    const values = value === undefined ? [] : typeof value === 'string' ? [value] : value;
    if (segment.kind === 'rest' && !values.length) throw new TypeError(`Nordbeam pathname '${pattern.source}' needs at least one value for catch-all param '${segment.value}'.`);
    if (values.some(item => !item)) throw new TypeError(`Nordbeam pathname '${pattern.source}' has an empty value for param '${segment.value}'.`);
    for (const item of values) out.push(encodeURIComponent(item));
  }
  return `/${out.join('/')}`;
}

/** The lowercase host of a configured domain, with its default port removed. Rejects anything that is not a bare host. */
function normalizeDomain(domain: string): string {
  if (typeof domain !== 'string' || !/^[^\s/?#@]+$/.test(domain)) throw new TypeError(`Nordbeam domain '${domain}' must be a host such as 'example.de' or 'localhost:3001'.`);
  try { return new URL(`http://${domain}`).host; }
  catch { throw new TypeError(`Nordbeam domain '${domain}' must be a host such as 'example.de' or 'localhost:3001'.`); }
}

/** Each domain gets its own routing view, which shares the compiled pathnames and keeps only the domain's locales. */
function buildDomains(routing: NextRouting<string, NextPathnamesInput<string>>, { entries, byLocale, prefixes }: Pick<Compiled, 'entries' | 'byLocale' | 'prefixes'>): Pick<Compiled, 'domains' | 'served'> {
  const locales = routing.locales;
  const domains = new Map<string, NextRouting<any, any>>();
  const served = new Map<string, string>();
  for (const item of routing.domains ?? []) {
    const host = normalizeDomain(item.domain);
    if (domains.has(host)) throw new TypeError(`Nordbeam domain '${host}' is listed more than once.`);
    const domainLocales = item.locales ?? locales;
    if (!domainLocales.length || new Set(domainLocales).size !== domainLocales.length || domainLocales.some(locale => !locales.includes(locale))) {
      throw new TypeError(`Nordbeam domain '${host}' needs unique locales from the routing locales.`);
    }
    if (!domainLocales.includes(item.defaultLocale)) throw new TypeError(`Nordbeam domain '${host}' needs its defaultLocale in its locales.`);
    const view: NextRouting<string, any> = { ...routing, domains: undefined, locales: domainLocales, defaultLocale: item.defaultLocale };
    compiledRoutings.set(view, {
      entries,
      byLocale: new Map(domainLocales.map(locale => [locale, byLocale.get(locale)!] as const)),
      prefixes: prefixes.filter(({ locale }) => domainLocales.includes(locale)),
      domains: new Map(),
      served: new Map(),
    });
    domains.set(host, view);
    for (const locale of domainLocales) if (!served.has(locale)) served.set(locale, host);
  }
  return { domains, served };
}

function build(routing: NextRouting<string, NextPathnamesInput<string>>): Compiled {
  const locales = routing.locales;
  if (!locales.length || !locales.includes(routing.defaultLocale)) {
    throw new TypeError('Nordbeam routing requires a non-empty locale list containing defaultLocale.');
  }
  if (new Set(locales).size !== locales.length) throw new TypeError('Nordbeam routing locales must be unique.');
  const entries = Object.entries(routing.pathnames ?? {}).map(([source, value]): Entry => {
    const pattern = compilePattern(source);
    if (typeof value === 'object') {
      for (const key of Object.keys(value)) {
        if (!locales.includes(key)) throw new TypeError(`Nordbeam pathname '${source}' has a pattern for unknown locale '${key}'.`);
      }
    }
    const localized = new Map(locales.map(locale => {
      const variant = typeof value === 'string' ? value : value[locale] ?? source;
      const compiled = compilePattern(variant);
      if (compiled.signature !== pattern.signature) {
        throw new TypeError(`Nordbeam pathname '${source}' and its ${locale} variant '${variant}' must have the same params.`);
      }
      return [locale, compiled] as const;
    }));
    return { pattern, localized };
  });
  const byLocale = new Map(locales.map(locale => {
    const list = entries.map(entry => ({ entry, pattern: entry.localized.get(locale)! })).sort((left, right) => specificity(left.pattern, right.pattern));
    const shapes = new Map<string, string>();
    for (const { entry, pattern } of list) {
      const other = shapes.get(pattern.shape);
      if (other !== undefined) throw new TypeError(`Nordbeam pathnames '${other}' and '${entry.pattern.source}' are ambiguous in ${locale}.`);
      shapes.set(pattern.shape, entry.pattern.source);
    }
    return [locale, list.map(({ entry }) => entry)] as const;
  }));
  const prefixes = locales.map(locale => ({ locale, prefix: localePrefix(routing, locale) })).sort((left, right) => right.prefix.length - left.prefix.length);
  const compiled = { entries: [...entries].sort((left, right) => specificity(left.pattern, right.pattern)), byLocale, prefixes };
  return { ...compiled, ...buildDomains(routing, compiled) };
}

/** Validates `routing` and compiles its pathnames once per routing object. Throws a TypeError on invalid config. */
export function compileRouting<Locale extends string>(routing: NextRouting<Locale, any>): Compiled {
  let compiled = compiledRoutings.get(routing);
  if (!compiled) {
    compiled = build(routing);
    compiledRoutings.set(routing, compiled);
  }
  return compiled;
}

/**
 * The routing that serves requests on `domain`: its locales and default locale,
 * with the same prefix rules and pathnames. Undefined when the host is not configured.
 */
export function domainRouting<Locale extends string>(routing: NextRouting<Locale, any>, domain: string | null | undefined): NextRouting<Locale, any> | undefined {
  return domain ? compileRouting(routing).domains.get(domain.toLowerCase()) : undefined;
}

/** The first configured domain that serves `locale`, or undefined when no domain lists it. */
export function servingDomain<Locale extends string>(routing: NextRouting<Locale, any>, locale: Locale): string | undefined {
  return compileRouting(routing).served.get(locale);
}

/** Identity helper that validates a routing object and keeps its literal types for pathname keys and params. */
export function defineRouting<const Locale extends string, const Pathnames extends NextPathnamesInput<Locale> = NextPathnamesInput<Locale>>(
  routing: NextRouting<Locale, Pathnames>,
): NextRouting<Locale, Pathnames> {
  compileRouting(routing);
  return routing;
}

export function localePrefixConfig<Locale extends string>(routing: NextRouting<Locale, any>) {
  const value = routing.localePrefix ?? 'always';
  return typeof value === 'string' ? { mode: value, prefixes: {} as Partial<Record<Locale, string>> } : value;
}

export function localePrefix<Locale extends string>(routing: NextRouting<Locale, any>, locale: Locale): string {
  return localePrefixConfig(routing).prefixes?.[locale] ?? `/${locale}`;
}

/** The prefix a locale carries in the URL, or '' when its paths are unprefixed. */
export function prefixOf<Locale extends string>(routing: NextRouting<Locale, any>, locale: Locale): string {
  const mode = localePrefixConfig(routing).mode;
  return mode === 'never' || (mode === 'as-needed' && locale === routing.defaultLocale) ? '' : localePrefix(routing, locale);
}

/** Joins a prefix and an unprefixed path. The root path has no trailing slash, so `/fr` and `/` stay canonical. */
export function joinPath(prefix: string, path: string): string {
  return `${prefix}${path === '/' ? '' : path}` || '/';
}

/** Finds the locale whose prefix starts `pathname`. Longer prefixes win, so `/a/b` beats `/a`. */
export function matchLocalePrefix<Locale extends string>(pathname: string, routing: NextRouting<Locale, any>, ignoreCase = false): { locale: Locale; prefix: string } | undefined {
  const lower = ignoreCase ? pathname.toLowerCase() : pathname;
  return compileRouting(routing).prefixes.find(({ prefix }) => {
    const value = ignoreCase ? prefix.toLowerCase() : prefix;
    return lower === value || lower.startsWith(`${value}/`);
  }) as { locale: Locale; prefix: string } | undefined;
}

/** Removes a locale prefix from `pathname`. Paths without one have no `locale`. */
export function stripLocalePrefix<Locale extends string>(pathname: string, routing: NextRouting<Locale, any>): { path: string; locale?: Locale } {
  const matched = matchLocalePrefix(pathname, routing);
  return matched ? { path: pathname.slice(matched.prefix.length) || '/', locale: matched.locale } : { path: pathname || '/' };
}

/** The internal concrete path for an external, unprefixed path in `locale`, or undefined when no localized pattern matches. */
export function toInternalPath<Locale extends string>(external: string, locale: Locale, routing: NextRouting<Locale, any>): string | undefined {
  const compiled = compileRouting(routing);
  if (!compiled.entries.length) return undefined;
  const segments = splitPath(external);
  for (const entry of compiled.byLocale.get(locale) ?? []) {
    const params = matchPattern(entry.localized.get(locale)!, segments);
    if (params) return fillPattern(entry.pattern, params);
  }
  return undefined;
}

/**
 * Like `toInternalPath`, but also accepts the internal pattern itself and the
 * localized paths of other locales (the preferred locale is tried first).
 * Used to canonicalize requests that name a page under the wrong locale.
 */
export function toInternalPathAny<Locale extends string>(external: string, routing: NextRouting<Locale, any>, preferred?: Locale): string | undefined {
  const compiled = compileRouting(routing);
  if (!compiled.entries.length) return undefined;
  const segments = splitPath(external);
  const order = preferred === undefined ? routing.locales : [preferred, ...routing.locales.filter(locale => locale !== preferred)];
  for (const locale of order) {
    for (const entry of compiled.byLocale.get(locale) ?? []) {
      const params = matchPattern(entry.localized.get(locale)!, segments);
      if (params) return fillPattern(entry.pattern, params);
    }
  }
  for (const entry of compiled.entries) {
    const params = matchPattern(entry.pattern, segments);
    if (params) return fillPattern(entry.pattern, params);
  }
  return undefined;
}

/** The unprefixed external path for an internal concrete path. Paths that match no pattern are returned unchanged. */
export function toExternalPath<Locale extends string>(internal: string, locale: Locale, routing: NextRouting<Locale, any>): string {
  const compiled = compileRouting(routing);
  if (!compiled.entries.length) return internal;
  const segments = splitPath(internal);
  for (const entry of compiled.entries) {
    const params = matchPattern(entry.pattern, segments);
    if (params) return fillPattern(entry.localized.get(locale)!, params);
  }
  return internal;
}

function queryString(query: unknown): string {
  if (typeof query === 'string') return query ? `?${query.replace(/^\?/, '')}` : '';
  if (!query || typeof query !== 'object') return '';
  const search = new URLSearchParams(Object.entries(query).flatMap(([key, value]) =>
    (Array.isArray(value) ? value : [value])
      .filter(item => item !== undefined && item !== null)
      .map(item => [key, String(item)] as [string, string])));
  const text = search.toString();
  return text ? `?${text}` : '';
}

function hashString(hash: string | null | undefined): string {
  return hash ? `#${hash.replace(/^#/, '')}` : '';
}

/** Splits a root-relative string href into its path, query and hash. Returns undefined for any other href. */
function splitRoute(href: string): { path: string; query: string; hash: string } | undefined {
  if (!href.startsWith('/') || href.startsWith('//')) return undefined;
  const match = href.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/)!;
  return { path: match[1] || '/', query: match[2] ?? '', hash: match[3] ?? '' };
}

/** True for root-relative paths such as `/about`. Relative, hash-only, query-only, absolute and protocol-relative hrefs keep their meaning under every locale. */
export function isRouteHref(href: NextRoutingHref): boolean {
  if (href instanceof URL) return false;
  if (typeof href === 'string') return href.startsWith('/') && !href.startsWith('//');
  return typeof href.pathname === 'string' && href.pathname.startsWith('/') && !href.pathname.startsWith('//');
}

/** `https` for public hosts and `http` for localhost and 127.0.0.1, so local domains can be tested without TLS. */
export function originOf(host: string, protocol = /^(localhost|127\.0\.0\.1|\[::1\]|[^:]*\.localhost)(:\d+)?$/.test(host) ? 'http:' : 'https:'): string {
  return `${protocol}//${host}`;
}

function localizedHref<Locale extends string>({ href, locale }: { readonly href: NextRoutingHref; readonly locale: Locale }, routing: NextRouting<Locale, any>): string {
  if (href instanceof URL) return href.toString();
  if (typeof href === 'string') {
    const route = splitRoute(href);
    if (!route) return href;
    return joinPath(prefixOf(routing, locale), toExternalPath(route.path, locale, routing)) + route.query + route.hash;
  }
  const query = queryString(href.query);
  const hash = hashString(href.hash);
  if (!isRouteHref(href)) return `${href.pathname ?? ''}${query}${hash}`;
  const pathname = href.pathname!;
  // Brackets only appear in patterns, so a bracketed pathname is always filled from its params.
  if (!/[[\]]/.test(pathname)) {
    return joinPath(prefixOf(routing, locale), toExternalPath(pathname, locale, routing)) + query + hash;
  }
  const entry = compileRouting(routing).entries.find(item => item.pattern.source === pathname);
  const path = entry ? fillPattern(entry.localized.get(locale)!, href.params) : fillPattern(compilePattern(pathname), href.params);
  return joinPath(prefixOf(routing, locale), path) + query + hash;
}

/**
 * The full external href for `href` in `locale`: locale prefix, localized path,
 * then query and hash. Pattern objects (`{ pathname: '/blog/[slug]', params }`)
 * are filled from their localized pattern. Non-route hrefs are serialized unchanged.
 *
 * With `domain`, a locale that the domain serves uses that domain's prefix rules.
 * A locale it does not serve gets the absolute URL on the first domain that does.
 * An unknown `domain` is ignored.
 */
export function getPathname<Locale extends string>({ href, locale, domain }: { readonly href: NextRoutingHref; readonly locale: Locale; readonly domain?: string | null }, routing: NextRouting<Locale, any>): string {
  const scoped = domainRouting(routing, domain);
  if (scoped && !scoped.locales.includes(locale) && isRouteHref(href)) {
    const serving = servingDomain(routing, locale);
    if (serving) return originOf(serving) + localizedHref({ href, locale }, domainRouting(routing, serving)!);
  }
  return localizedHref({ href, locale }, scoped?.locales.includes(locale) ? scoped : routing);
}

/**
 * Route-aware `localize` for navigation hrefs: an explicit locale wins, then a locale prefix in the href, then the current pathname's locale.
 * With `domain`, an unprefixed current pathname is in the domain's default locale.
 */
export function localize<Locale extends string>(href: NextRoutingHref, locale: Locale | false | undefined, current: string | null, routing: NextRouting<Locale, any>, domain?: string | null): NextRoutingHref {
  if (!isRouteHref(href)) return href;
  // Match Next's `locale={false}` contract: callers provide the complete URL
  // and the adapter must not strip or add a locale segment. A pattern object is
  // still filled from its params, but not localized.
  if (locale === false) {
    if (typeof href === 'string' || href instanceof URL || !/[[\]]/.test(href.pathname!)) return href;
    return `${fillPattern(compilePattern(href.pathname!), href.params)}${queryString(href.query)}${hashString(href.hash)}`;
  }
  const pathname = typeof href === 'string' ? splitRoute(href)!.path : href.pathname!;
  const stripped = stripLocalePrefix(pathname, routing);
  // A prefixed href names its locale, so its path is mapped back to the internal route through that locale.
  const internal = stripped.locale === undefined ? stripped.path : toInternalPathAny(stripped.path, routing, stripped.locale) ?? stripped.path;
  const target = locale ?? stripped.locale ?? (current ? stripLocalePrefix(current, routing).locale : undefined) ?? domainRouting(routing, domain)?.defaultLocale ?? routing.defaultLocale;
  if (typeof href === 'string') {
    const route = splitRoute(href)!;
    return getPathname({ href: { pathname: internal, query: route.query, hash: route.hash.slice(1) }, locale: target, domain }, routing);
  }
  return getPathname({ href: { ...href, pathname: internal }, locale: target, domain }, routing);
}
