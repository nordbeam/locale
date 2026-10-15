export interface MessageKey { readonly key: string }

export type MessageSelectorTree<Messages> =
  (Messages extends (...args: any[]) => any ? MessageKey : unknown)
  & { readonly [Key in keyof Messages]: MessageSelectorTree<Messages[Key]> };

/** Build property-based selectors and locale snapshots for a generated Messages type. */
export function createMessageTestHelpers<Messages>() {
  const keyFromSelector = (select: (messages: MessageSelectorTree<Messages>) => MessageKey): string => {
    const nodes = new Map<string, MessageKey>();
    const make = (path: string): MessageKey => {
      const existing = nodes.get(path);
      if (existing) return existing;
      const target = Object.freeze({ key: path });
      const node = new Proxy(target, { get(value, property, receiver) {
        if (property === 'key') return path;
        if (typeof property !== 'string') return Reflect.get(value, property, receiver);
        return make(path ? `${path}.${property}` : property);
      } });
      nodes.set(path, node);
      return node;
    };
    const selected = select(make('') as MessageSelectorTree<Messages>);
    if (!selected || typeof selected.key !== 'string' || !selected.key) throw new TypeError('Message selector must return one message.');
    return selected.key;
  };
  const localeMatrix = async <Locale extends string, Result>(locales: readonly Locale[], loadLocale: (locale: Locale) => Promise<{ readonly messages: Messages }>, render: (messages: Messages, locale: Locale) => Result): Promise<Record<Locale, Result>> => {
    const entries = await Promise.all(locales.map(async locale => [locale, render((await loadLocale(locale)).messages, locale)] as const));
    return Object.fromEntries(entries) as Record<Locale, Result>;
  };
  return { keyFromSelector, localeMatrix };
}
