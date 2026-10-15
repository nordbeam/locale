import { hasInjectionContext, inject, onScopeDispose, ref, shallowReadonly, shallowRef, watch } from 'vue';
import type { App, InjectionKey, Ref, ShallowRef } from 'vue';
import { createLocaleStore } from './index.js';
import type { LoadedLocale } from './index.js';

/**
 * Bind Vue composables to a locale loader. Installing the plugin creates a store
 * for that app, so server renders can use one instance per request without
 * sharing locale state.
 */
export function createVueI18n<Locale extends string, Messages>(options: {
  initial: LoadedLocale<Locale, Messages>;
  loadLocale: (locale: Locale) => Promise<LoadedLocale<Locale, Messages>>;
}) {
  type Loader<Selected> = (locale: Locale) => Promise<LoadedLocale<Locale, Selected>>;
  type AnyLoader = Loader<unknown>;
  type State = {
    locale: Readonly<Ref<Locale>>;
    messages: Readonly<ShallowRef<Messages>>;
    pending: Readonly<Ref<boolean>>;
    setLocale(locale: Locale): Promise<boolean>;
    preload(locale: Locale): Promise<void>;
    select<Selected>(loader: Loader<Selected>): Promise<Readonly<ShallowRef<Selected>>>;
  };
  const key: InjectionKey<State> = Symbol('nordbeam-locale');

  function createState(): State {
    const store = createLocaleStore({ initial: options.initial, loadLocale: options.loadLocale });
    const locale = shallowRef<Locale>(store.getSnapshot().locale);
    const messages = shallowRef<Messages>(store.getMessages());
    const pending = ref(false);
    const selections = new Map<AnyLoader, Map<Locale, Promise<LoadedLocale<Locale, unknown>>>>();
    // Counts mounted selections per loader so locale switches warm only what is in use.
    const active = new Map<AnyLoader, number>();
    let latest = 0;

    store.subscribe(() => {
      const snapshot = store.getSnapshot();
      locale.value = snapshot.locale;
      messages.value = snapshot.messages;
    });

    function loadSelection<Selected>(loader: Loader<Selected>, next: Locale): Promise<LoadedLocale<Locale, Selected>> {
      const key = loader as AnyLoader;
      const entries = selections.get(key) ?? new Map<Locale, Promise<LoadedLocale<Locale, unknown>>>();
      selections.set(key, entries);
      const cached = entries.get(next);
      if (cached) return cached as Promise<LoadedLocale<Locale, Selected>>;

      let loading: Promise<LoadedLocale<Locale, Selected>>;
      try { loading = loader(next); }
      catch (reason) { loading = Promise.reject(reason); }
      const promise: Promise<LoadedLocale<Locale, Selected>> = loading.then(loaded => {
        if (loaded.locale !== next) throw new Error(`Locale loader returned ${loaded.locale} for ${next}`);
        return loaded;
      }, reason => {
        // Failed loads are retried by the next request instead of being cached forever.
        if (entries.get(next) === promise) entries.delete(next);
        throw reason;
      });
      entries.set(next, promise);
      return promise;
    }

    async function setLocale(next: Locale): Promise<boolean> {
      const ticket = ++latest;
      pending.value = true;
      try {
        // Warm mounted selections first so messages and selections switch together.
        await Promise.all([...active.keys()].map(loader => loadSelection(loader, next)));
        if (ticket !== latest) return false;
        return await store.setLocale(next);
      } finally {
        if (ticket === latest) pending.value = false;
      }
    }

    function select<Selected>(loader: Loader<Selected>): Promise<Readonly<ShallowRef<Selected>>> {
      const key = loader as AnyLoader;
      active.set(key, (active.get(key) ?? 0) + 1);
      onScopeDispose(() => {
        const count = (active.get(key) ?? 1) - 1;
        if (count > 0) active.set(key, count);
        else active.delete(key);
      });

      const value = shallowRef<Selected>();
      let ticket = 0;
      const follow = (next: Locale) => {
        const current = ++ticket;
        return loadSelection(loader, next).then(loaded => {
          // Keep the previous selection visible until the newest locale is ready.
          if (current === ticket || value.value === undefined) value.value = loaded.messages;
        });
      };
      watch(() => locale.value, next => follow(next));
      return follow(locale.value).then(() => shallowReadonly(value) as Readonly<ShallowRef<Selected>>);
    }

    return {
      locale: shallowReadonly(locale),
      messages: shallowReadonly(messages),
      pending: shallowReadonly(pending),
      setLocale,
      preload(next) {
        return Promise.all([options.loadLocale(next), ...[...active.keys()].map(loader => loadSelection(loader, next))])
          .then(() => undefined);
      },
      select,
    };
  }

  function useStore(): State {
    if (!hasInjectionContext()) throw new Error('Nordbeam Locale: call this composable inside setup() or another composable.');
    const state = inject(key, null);
    if (!state) throw new Error('Nordbeam Locale: install this i18n instance with app.use(i18n) before using its composables.');
    return state;
  }

  /** Locale, messages, pending state and switching for the nearest installed app. */
  function useI18n(): Pick<State, 'locale' | 'messages' | 'pending' | 'setLocale' | 'preload'> {
    const { locale, messages, pending, setLocale, preload } = useStore();
    return { locale, messages, pending, setLocale, preload };
  }

  /**
   * Messages for the current locale, or a selected loader. Selected loaders
   * return a promise so `await useMessages(loader)` works in async setup under
   * Suspense; they reload when the locale changes and keep the old value until
   * the new one is ready.
   */
  function useMessages(): Readonly<ShallowRef<Messages>>;
  function useMessages<Selected>(loader: Loader<Selected>): Promise<Readonly<ShallowRef<Selected>>>;
  function useMessages<Selected>(loader?: Loader<Selected>) {
    const store = useStore();
    return loader ? store.select(loader) : store.messages;
  }

  return {
    install(app: App): void {
      app.provide(key, createState());
    },
    useI18n,
    useMessages,
  };
}
