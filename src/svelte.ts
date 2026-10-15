import { getContext, setContext } from 'svelte';
import type { Readable } from 'svelte/store';
import { createLocaleStore } from './index.js';
import type { LoadedLocale } from './index.js';

type Loader<Locale extends string, Messages> = (locale: Locale) => Promise<LoadedLocale<Locale, Messages>>;
type Listener<Value> = (value: Value) => void;
type Slot<Locale extends string, Messages> = { promise: Promise<LoadedLocale<Locale, Messages>>; loaded?: LoadedLocale<Locale, Messages> };

export interface SvelteI18n<Locale extends string, Messages> {
  /** Current locale. Use as `$locale` in components. */
  readonly locale: Readable<Locale>;
  /** Current messages. Use as `$messages.greeting({ name })` in components. */
  readonly messages: Readable<Messages>;
  /** True while a cold locale is loading. The previous locale stays visible meanwhile. */
  readonly pending: Readable<boolean>;
  /** Returns false when a newer request superseded this change. */
  setLocale(locale: Locale): Promise<boolean>;
  /** Load a locale, or a selected loader's locale, without switching to it. */
  preload<SelectedMessages = Messages>(
    locale: Locale,
    loader?: Loader<Locale, SelectedMessages>,
  ): Promise<LoadedLocale<Locale, SelectedMessages>>;
  /**
   * Store of the selected messages for the current locale. Each loader is cached
   * per locale in this instance. The value stays undefined until the first
   * selection is ready, so call `preload` during server rendering.
   */
  select<SelectedMessages>(loader: Loader<Locale, SelectedMessages>): Readable<SelectedMessages | undefined>;
}

/** Bind a locale loader to Svelte stores. Create one instance per app, or per request on the server. */
export function createSvelteI18n<Locale extends string, Messages>(options: {
  initial: LoadedLocale<Locale, Messages>;
  loadLocale: Loader<Locale, Messages>;
}): SvelteI18n<Locale, Messages> {
  const { initial, loadLocale } = options;
  // Keyed per instance so concurrent server requests never share loaded messages.
  const slots = new Map<Loader<Locale, unknown>, Map<Locale, Slot<Locale, unknown>>>();

  function localeSlots<SelectedMessages>(loader: Loader<Locale, SelectedMessages>) {
    const key = loader as Loader<Locale, unknown>;
    let byLocale = slots.get(key);
    if (!byLocale) {
      byLocale = new Map();
      slots.set(key, byLocale);
    }
    return byLocale as Map<Locale, Slot<Locale, SelectedMessages>>;
  }

  function slot<SelectedMessages>(loader: Loader<Locale, SelectedMessages>, locale: Locale): Slot<Locale, SelectedMessages> {
    const byLocale = localeSlots(loader);
    const cached = byLocale.get(locale);
    if (cached) return cached;

    let loading: Promise<LoadedLocale<Locale, SelectedMessages>>;
    try { loading = loader(locale); }
    catch (reason) { loading = Promise.reject(reason); }
    const created: Slot<Locale, SelectedMessages> = {
      promise: loading.then(
        loaded => {
          if (loaded.locale !== locale) throw new Error(`Locale loader returned ${loaded.locale} for ${locale}`);
          created.loaded = loaded;
          return loaded;
        },
        reason => {
          // Failed loads are retried on the next request instead of being cached.
          if (byLocale.get(locale) === created) byLocale.delete(locale);
          throw reason;
        },
      ),
    };
    byLocale.set(locale, created);
    return created;
  }

  // The default loader is cached as well, so preloaded and warm locales switch without a pending state.
  localeSlots(loadLocale).set(initial.locale, { promise: Promise.resolve(initial), loaded: initial });
  const loadFull = (locale: Locale) => slot(loadLocale, locale).promise;
  const store = createLocaleStore({ initial, loadLocale: loadFull });

  const pending = stateStore(false);
  let latest = 0;

  function derived<Value>(read: () => Value): Readable<Value> {
    return {
      subscribe(run) {
        let last = read();
        run(last);
        return store.subscribe(() => {
          const next = read();
          if (Object.is(next, last)) return;
          last = next;
          run(next);
        });
      },
    };
  }

  return {
    locale: derived(() => store.getSnapshot().locale),
    messages: derived(() => store.getSnapshot().messages),
    pending: pending.readable,
    async setLocale(locale) {
      const ticket = ++latest;
      const warm = store.getSnapshot().locale === locale || localeSlots(loadLocale).get(locale)?.loaded !== undefined;
      // Only cold locales expose a pending state. Warm locales switch in place.
      pending.set(!warm);
      try { return await store.setLocale(locale); }
      finally { if (ticket === latest) pending.set(false); }
    },
    preload<SelectedMessages = Messages>(locale: Locale, loader?: Loader<Locale, SelectedMessages>) {
      const selectLoader: Loader<Locale, unknown> = loader ?? loadLocale;
      return slot(selectLoader, locale).promise as Promise<LoadedLocale<Locale, SelectedMessages>>;
    },
    select: selection,
  };

  function selection<SelectedMessages>(loader: Loader<Locale, SelectedMessages>): Readable<SelectedMessages | undefined> {
    const listeners = new Set<Listener<SelectedMessages>>();
    let value: SelectedMessages | undefined;
    let unsubscribe: (() => void) | undefined;

    function commit(next: SelectedMessages) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener(next);
    }

    // Shows the selection for the current locale, or keeps the previous value until it is ready.
    function sync() {
      const locale = store.getSnapshot().locale;
      const current = slot(loader, locale);
      if (current.loaded) {
        commit(current.loaded.messages);
        return;
      }
      void current.promise.then(
        loaded => {
          if (listeners.size && store.getSnapshot().locale === locale) commit(loaded.messages);
        },
        () => undefined,
      );
    }

    return {
      subscribe(run) {
        const listener: Listener<SelectedMessages> = next => run(next);
        if (listeners.size === 0) {
          unsubscribe = store.subscribe(sync);
          sync();
        }
        listeners.add(listener);
        if (value !== undefined) run(value);
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) {
            unsubscribe?.();
            unsubscribe = undefined;
          }
        };
      },
    };
  }
}

/** Minimal observable value with Svelte store semantics. */
function stateStore<Value>(initial: Value) {
  let value = initial;
  const listeners = new Set<Listener<Value>>();
  return {
    set(next: Value) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener(next);
    },
    readable: {
      subscribe(run: Listener<Value>) {
        const listener: Listener<Value> = next => run(next);
        listeners.add(listener);
        run(value);
        return () => { listeners.delete(listener); };
      },
    } satisfies Readable<Value>,
  };
}

const contextKey = Symbol('nordbeam-locale');

/** Make an i18n instance available to descendants. Call it during a root component's initialization. */
export function setI18nContext<Locale extends string, Messages>(i18n: SvelteI18n<Locale, Messages>): void {
  setContext(contextKey, i18n);
}

/**
 * Read the i18n instance set by a parent. Pass the generated types for typed messages:
 * `getI18nContext<Locale, Messages>()`.
 */
export function getI18nContext<Locale extends string = string, Messages = unknown>(): SvelteI18n<Locale, Messages> {
  const i18n = getContext<SvelteI18n<Locale, Messages> | undefined>(contextKey);
  if (!i18n) throw new Error('Nordbeam Locale: call setI18nContext in a parent component before getI18nContext.');
  return i18n;
}
