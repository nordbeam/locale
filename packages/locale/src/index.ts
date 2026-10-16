export interface LoadedLocale<Locale extends string, Messages> {
  readonly locale: Locale;
  readonly messages: Messages;
}

export interface LocaleStore<Locale extends string, Messages> {
  getSnapshot(): LoadedLocale<Locale, Messages>;
  /** Read the current messages synchronously after the initial locale is loaded. */
  getMessages(): Messages;
  subscribe(listener: () => void): () => void;
  /** Applies a locale; cached locales skip the loader. Resolves false when a newer request superseded this one, and rejects when the loader fails. */
  setLocale(locale: Locale): Promise<boolean>;
  /** Loads a locale into the cache without switching to it. Rejects when the loader fails; nothing is cached on failure. */
  preload(locale: Locale): Promise<void>;
  /** Drops cached locales, or every cached locale when omitted. The current snapshot is kept. */
  invalidate(locale?: Locale): void;
}

/** Create an isolated client store. Server requests can call loadLocale directly. */
export function createLocaleStore<Locale extends string, Messages>(options: {
  initial: LoadedLocale<Locale, Messages>;
  loadLocale: (locale: Locale) => Promise<LoadedLocale<Locale, Messages>>;
}): LocaleStore<Locale, Messages> {
  let current = Object.freeze({ ...options.initial });
  let request = 0;
  // Stores the in-flight or settled load per locale; failed loads are removed so they are never cached.
  const cache = new Map<Locale, Promise<LoadedLocale<Locale, Messages>>>([[current.locale, Promise.resolve(current)]]);
  const listeners = new Set<() => void>();
  const load = (locale: Locale) => {
    let entry = cache.get(locale);
    if (!entry) {
      entry = (async () => {
        const loaded = await options.loadLocale(locale);
        if (loaded.locale !== locale) throw new Error(`Locale loader returned ${loaded.locale} for ${locale}`);
        return Object.freeze({ ...loaded });
      })();
      cache.set(locale, entry);
      entry.catch(() => { if (cache.get(locale) === entry) cache.delete(locale); });
    }
    return entry;
  };
  return {
    getSnapshot: () => current,
    getMessages: () => current.messages,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async setLocale(locale) {
      const ticket = ++request;
      if (locale === current.locale) return true;
      let loaded: LoadedLocale<Locale, Messages>;
      try { loaded = await load(locale); }
      catch (error) { if (ticket !== request) return false; throw error; }
      if (ticket !== request) return false;
      current = loaded;
      for (const listener of [...listeners]) listener();
      return true;
    },
    async preload(locale) {
      await load(locale);
    },
    invalidate(locale) {
      if (locale === undefined) cache.clear();
      else cache.delete(locale);
    },
  };
}
