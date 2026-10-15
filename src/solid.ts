import { createComponent, createContext, createResource, createSignal, useContext } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import { createLocaleStore } from './index.js';
import type { LoadedLocale } from './index.js';

/** A locale loader for the full catalog or a selected message subset. */
export type SolidLoader<Locale extends string, Messages> = (locale: Locale) => Promise<LoadedLocale<Locale, Messages>>;

export interface SolidI18nState<Locale extends string, Messages> {
  readonly locale: Accessor<Locale>;
  readonly messages: Accessor<Messages>;
  /** True while a cold locale is loading. The previous locale stays visible. */
  readonly pending: Accessor<boolean>;
  /** Returns false when a newer request superseded this one. */
  setLocale(locale: Locale): Promise<boolean>;
  preload(locale: Locale): Promise<void>;
}

export interface SolidI18n<Locale extends string, Messages> {
  Provider(props: { children?: JSX.Element }): JSX.Element;
  useI18n(): SolidI18nState<Locale, Messages>;
  /** Selected messages for the committed locale. Keeps the previous value while the next locale loads. */
  useMessages<Selected>(loader: SolidLoader<Locale, Selected>): Accessor<Selected | undefined>;
}

/**
 * Bind Solid hooks to a locale loader. Create one instance per app, or per
 * request on the server, so locale state never crosses requests.
 */
export function createSolidI18n<Locale extends string, Messages>(options: {
  initial: LoadedLocale<Locale, Messages>;
  loadLocale: SolidLoader<Locale, Messages>;
}): SolidI18n<Locale, Messages> {
  type Snapshot = LoadedLocale<Locale, Messages>;
  type State = SolidI18nState<Locale, Messages>;
  const Context = createContext<State | null>(null);

  const loads = new Map<Locale, Promise<Snapshot>>();
  const warm = new Set<Locale>();
  function load(locale: Locale): Promise<Snapshot> {
    const cached = loads.get(locale);
    if (cached) return cached;
    let loading: Promise<Snapshot>;
    try { loading = options.loadLocale(locale); }
    catch (reason) { loading = Promise.reject(reason); }
    const promise = loading.then(loaded => {
      if (loaded.locale !== locale) throw new Error(`Locale loader returned ${loaded.locale} for ${locale}`);
      warm.add(locale);
      return loaded;
    }).catch(reason => {
      loads.delete(locale);
      throw reason;
    });
    loads.set(locale, promise);
    return promise;
  }

  const store = createLocaleStore<Locale, Messages>({ initial: options.initial, loadLocale: load });
  const [snapshot, setSnapshot] = createSignal<Snapshot>(store.getSnapshot());
  const [pending, setPending] = createSignal(false);
  store.subscribe(() => setSnapshot(store.getSnapshot()));

  let latest = 0;
  async function setLocale(locale: Locale): Promise<boolean> {
    const ticket = ++latest;
    // Warm and current locales commit without a visible loading state.
    if (!warm.has(locale) && locale !== store.getSnapshot().locale) setPending(true);
    try {
      return await store.setLocale(locale);
    } finally {
      if (ticket === latest) setPending(false);
    }
  }

  async function preload(locale: Locale): Promise<void> {
    await load(locale);
  }

  const state: State = {
    locale: () => snapshot().locale,
    messages: () => snapshot().messages,
    pending,
    setLocale,
    preload,
  };

  function Provider(props: { children?: JSX.Element }): JSX.Element {
    return createComponent(Context.Provider, {
      value: state,
      get children() { return props.children; },
    });
  }

  function requireState(): State {
    const current = useContext(Context);
    if (!current) throw new Error('Nordbeam Locale: wrap this component in its matching i18n.Provider.');
    return current;
  }

  // Selected loaders are cached per loader and locale, mirroring the React adapter.
  const selections = new WeakMap<object, Map<Locale, Promise<unknown>>>();
  function loadSelected<Selected>(loader: SolidLoader<Locale, Selected>, locale: Locale): Promise<Selected> {
    const cache = selections.get(loader) ?? new Map<Locale, Promise<unknown>>();
    selections.set(loader, cache);
    const cached = cache.get(locale) as Promise<Selected> | undefined;
    if (cached) return cached;
    let loading: Promise<LoadedLocale<Locale, Selected>>;
    try { loading = loader(locale); }
    catch (reason) { loading = Promise.reject(reason); }
    const promise = loading.then(loaded => {
      if (loaded.locale !== locale) throw new Error(`Locale loader returned ${loaded.locale} for ${locale}`);
      return loaded.messages;
    }).catch(reason => {
      cache.delete(locale);
      throw reason;
    });
    cache.set(locale, promise);
    return promise;
  }

  function useMessages<Selected>(loader: SolidLoader<Locale, Selected>): Accessor<Selected | undefined> {
    requireState();
    const [resource] = createResource(() => snapshot().locale, locale => loadSelected(loader, locale));
    return resource;
  }

  return { Provider, useI18n: requireState, useMessages };
}
