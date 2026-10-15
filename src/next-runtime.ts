/** Typed helpers for an App Router `[locale]` segment. This entry is free of
 * Node and Next imports, so it is safe in Node, Edge, and client graphs. */
export function createNextI18n<Locale extends string, Loaded>(options: {
  locales: readonly Locale[];
  loadLocale: (locale: Locale) => Promise<Loaded>;
}) {
  const supported = new Set<string>(options.locales);
  const hasLocale = (value: string): value is Locale => supported.has(value);
  const requireLocale = (value: string): Locale => {
    if (!hasLocale(value)) throw new RangeError(`Unsupported locale: ${value}`);
    return value;
  };
  const loadLocale = (value: string): Promise<Loaded> => options.loadLocale(requireLocale(value));
  const generateStaticParams = <Key extends string = 'locale'>(key: Key = 'locale' as Key): Array<Record<Key, Locale>> =>
    options.locales.map(locale => ({ [key]: locale }) as Record<Key, Locale>);
  return { locales: options.locales, hasLocale, requireLocale, loadLocale, generateStaticParams } as const;
}
