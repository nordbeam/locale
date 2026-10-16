'use client';

import * as React from 'react';
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, useTransition } from 'react';
import type { ReactNode, ReactElement } from 'react';
import { createLocaleStore } from './index.js';
import type { LoadedLocale, LocaleStore } from './index.js';

export { rich } from './react-rich.js';

/** Bind typed hooks to a locale loader. Each Provider owns its own store. */
export function createReactI18n<Locale extends string, Messages>(
  loadLocale: (locale: Locale) => Promise<LoadedLocale<Locale, Messages>>,
) {
  type Snapshot = LoadedLocale<Locale, Messages>;
  type State = { store: LocaleStore<Locale, Messages>; getServerSnapshot: () => Snapshot };
  const Context = createContext<State | null>(null);

  function Provider({ initial, children }: { initial: Snapshot; children?: ReactNode }): ReactElement {
    // Capture once: the server snapshot must stay the same while different
    // Suspense boundaries hydrate, even if a client locale switch has started.
    const [state] = useState<State>(() => {
      const store = createLocaleStore({ initial, loadLocale });
      const serverSnapshot = store.getSnapshot();
      return { store, getServerSnapshot: () => serverSnapshot };
    });
    return createElement(Context.Provider, { value: state }, children);
  }

  function useStateContext(): State {
    const state = useContext(Context);
    if (!state) throw new Error('Nordbeam Locale: wrap this component in its matching i18n.Provider.');
    return state;
  }

  function useSnapshot(): Snapshot {
    const { store, getServerSnapshot } = useStateContext();
    return useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);
  }

  function useMessages(): Messages { return useSnapshot().messages; }
  function useLocale(): Locale { return useSnapshot().locale; }
  // Controls that only change the locale need no store subscription.
  function useSetLocale(): LocaleStore<Locale, Messages>['setLocale'] { return useStateContext().store.setLocale; }
  function useI18n(): Snapshot & Pick<LocaleStore<Locale, Messages>, 'setLocale'> {
    const snapshot = useSnapshot();
    const setLocale = useSetLocale();
    return useMemo(() => ({ ...snapshot, setLocale }), [snapshot, setLocale]);
  }

  return { Provider, useMessages, useLocale, useSetLocale, useI18n, loadLocale };
}

type PendingResource<Value> = {
  status: 'pending';
  promise: Promise<Value>;
};
type FulfilledResource<Value> = {
  status: 'fulfilled';
  promise: Promise<Value>;
  value: Value;
};
type RejectedResource<Value> = {
  status: 'rejected';
  promise: Promise<Value>;
  reason: unknown;
};
type Resource<Value> = PendingResource<Value> | FulfilledResource<Value> | RejectedResource<Value>;

function readResource<Value>(resource: Resource<Value>, forget: () => void): Value {
  if (resource.status === 'fulfilled') return resource.value;
  if (resource.status === 'rejected') {
    // React retries a throwing render synchronously before it shows the boundary. Keep
    // the failure visible for that pass, then forget it so a later render retries.
    // Forgetting now would restart the load inside that retry and loop.
    setTimeout(forget, 0);
    throw resource.reason;
  }
  // Throwing one stable cached thenable is the common React 18/19 Suspense
  // contract. It also avoids bundler-specific React.use implementations while
  // prerendering a Client Component on the server.
  throw resource.promise;
}

/**
 * Bind Suspense-native hooks to a locale loader. Locale resources are shared
 * by providers created from this factory and deduplicated by locale.
 *
 * The Provider is controlled: update its locale prop inside a React transition
 * to keep already revealed content visible while the next locale loads.
 */
export function createSuspenseI18n<Locale extends string, Messages>(
  loadLocale: (locale: Locale) => Promise<LoadedLocale<Locale, Messages>>,
) {
  type Snapshot = LoadedLocale<Locale, Messages>;
  const Context = createContext<Snapshot | null>(null);
  const resources = new Map<Locale, Resource<Snapshot>>();

  function getResource(locale: Locale): Resource<Snapshot> {
    const cached = resources.get(locale);
    if (cached) return cached;

    let loading: Promise<Snapshot>;
    try { loading = loadLocale(locale); }
    catch (reason) { loading = Promise.reject(reason); }
    let pending: PendingResource<Snapshot>;
    const promise = loading.then(loaded => {
      if (loaded.locale !== locale) throw new Error(`Locale loader returned ${loaded.locale} for ${locale}`);
      return loaded;
    }).then(
      loaded => {
        if (resources.get(locale) === pending) {
          resources.set(locale, { status: 'fulfilled', promise, value: loaded });
        }
        return loaded;
      },
      reason => {
        if (resources.get(locale) === pending) {
          resources.set(locale, { status: 'rejected', promise, reason });
        }
        throw reason;
      },
    );
    pending = { status: 'pending', promise };
    resources.set(locale, pending);
    return pending;
  }

  function Provider({ locale, preloadLocales, children }: {
    locale: Locale;
    preloadLocales?: readonly Locale[];
    children?: ReactNode;
  }): ReactElement {
    const resource = getResource(locale);
    const snapshot = readResource(resource, () => forgetRejected(locale, resource));
    // Start likely follow-up locales after hydration. Keeping this in an effect
    // avoids loading client-only alternatives while rendering on the server.
    useEffect(() => {
      for (const nextLocale of preloadLocales ?? []) {
        if (nextLocale !== locale) void getResource(nextLocale).promise.catch(() => undefined);
      }
    }, [locale, preloadLocales]);
    return createElement(Context.Provider, { value: snapshot }, children);
  }

  function useSnapshot(): Snapshot {
    const snapshot = useContext(Context);
    if (!snapshot) throw new Error('Nordbeam Locale: wrap this component in its matching Suspense i18n.Provider.');
    return snapshot;
  }

  function forgetRejected(locale: Locale, resource: Resource<Snapshot>): void {
    if (resources.get(locale) === resource) resources.delete(locale);
  }
  function preload(locale: Locale): Promise<Snapshot> {
    // An explicit preload retries a failure that no render has consumed yet.
    if (resources.get(locale)?.status === 'rejected') resources.delete(locale);
    return getResource(locale).promise;
  }
  function isLoaded(locale: Locale): boolean { return resources.get(locale)?.status === 'fulfilled'; }
  function invalidate(locale?: Locale): void {
    if (locale === undefined) resources.clear();
    else resources.delete(locale);
  }
  /**
   * Use messages loaded elsewhere for their locale, in place of what `loadLocale` would
   * load, such as a smaller catalog for the first page. A Provider reads them when it
   * next renders, without suspending.
   */
  function prime(snapshot: Snapshot): void {
    resources.set(snapshot.locale, { status: 'fulfilled', promise: Promise.resolve(snapshot), value: snapshot });
  }
  function useMessages(): Messages { return useSnapshot().messages; }
  function useLocale(): Locale { return useSnapshot().locale; }
  function useI18n(): Snapshot { return useSnapshot(); }

  return { Provider, useMessages, useLocale, useI18n, preload, isLoaded, invalidate, prime, loadLocale };
}

function useRequiredContext<Value>(context: React.Context<Value | null>): Value {
  const value = useContext(context);
  if (value === null) throw new Error('Nordbeam Locale: wrap this component in its matching client i18n.Provider.');
  return value;
}

/**
 * Create a client i18n controller whose Provider owns locale state.
 *
 * Locale changes that are already cached commit synchronously. Cold changes are
 * automatically wrapped in a transition, so revealed UI remains visible while
 * its catalog loads. Consumers never need to coordinate useState,
 * startTransition, preload, or cache checks themselves.
 *
 * Provider `initialLocale` is read on mount only, like a useState initial value.
 * Later changes are ignored; call setLocale to change the locale. Provider
 * `preload` is live: a changed list starts loading its locales.
 */
export function createClientI18n<Locale extends string, Messages>(
  loadLocale: (locale: Locale) => Promise<LoadedLocale<Locale, Messages>>,
) {
  type Loader<SelectedMessages = Messages> =
    (locale: Locale) => Promise<LoadedLocale<Locale, SelectedMessages>>;
  type AnyLoader = Loader<unknown>;
  type SetLocale = (locale: Locale) => void;
  // Stable for the Provider's lifetime, so reading actions never re-renders a consumer.
  type Actions = {
    setLocale: SetLocale;
    // Loader identity -> mounted consumers. Only the first consumer registers its preloads.
    activeLoaders: Map<AnyLoader, number>;
    preload?: readonly Locale[];
  };
  // Split so a locale or pending change re-renders only the consumers that read it.
  const ActionsContext = createContext<Actions | null>(null);
  const LocaleContext = createContext<Locale | null>(null);
  const PendingContext = createContext<boolean | null>(null);
  // High enough that an app with many module-scope selections never reaches it.
  const MAX_SELECTION_LOADERS = 1000;
  let resources = new WeakMap<AnyLoader, Map<Locale, Resource<LoadedLocale<Locale, unknown>>>>();
  // Weak so a dropped loader's messages can be collected; invalidate(locale) walks the live ones.
  let resourceMaps = new Set<WeakRef<Map<Locale, Resource<LoadedLocale<Locale, unknown>>>>>();
  let loaderCount = 0;

  function resourcesFor<SelectedMessages>(loader: Loader<SelectedMessages>) {
    const key = loader as AnyLoader;
    let cache = resources.get(key) as Map<Locale, Resource<LoadedLocale<Locale, SelectedMessages>>> | undefined;
    if (!cache) {
      // Inline loaders get a new identity on every render, and each one would suspend
      // on a new resource forever. Counting identities catches that even when a
      // suspended first mount discards its hook state.
      if (++loaderCount > MAX_SELECTION_LOADERS) {
        throw new Error(`Nordbeam Locale: useMessages/useI18n received more than ${MAX_SELECTION_LOADERS} distinct selection loaders. Loaders must be stable: create them once at module scope with selectMessages(...), not inline in a component.`);
      }
      cache = new Map();
      resources.set(key, cache as Map<Locale, Resource<LoadedLocale<Locale, unknown>>>);
      for (const ref of resourceMaps) if (!ref.deref()) resourceMaps.delete(ref);
      resourceMaps.add(new WeakRef(cache as Map<Locale, Resource<LoadedLocale<Locale, unknown>>>));
    }
    return cache;
  }

  function forgetRejected(loader: AnyLoader, locale: Locale, resource: object): void {
    const cache = resources.get(loader);
    if (cache?.get(locale) === resource) cache.delete(locale);
  }

  function getResource<SelectedMessages>(loader: Loader<SelectedMessages>, locale: Locale) {
    type Snapshot = LoadedLocale<Locale, SelectedMessages>;
    const cache = resourcesFor(loader);
    const cached = cache.get(locale);
    if (cached) return cached;

    let loading: Promise<Snapshot>;
    try { loading = loader(locale); }
    catch (reason) { loading = Promise.reject(reason); }
    let pending: PendingResource<Snapshot>;
    const promise = loading.then(loaded => {
      if (loaded.locale !== locale) throw new Error(`Locale loader returned ${loaded.locale} for ${locale}`);
      return loaded;
    }).then(
      loaded => {
        if (cache.get(locale) === pending) {
          cache.set(locale, { status: 'fulfilled', promise, value: loaded });
        }
        return loaded;
      },
      reason => {
        if (cache.get(locale) === pending) {
          cache.set(locale, { status: 'rejected', promise, reason });
        }
        throw reason;
      },
    );
    pending = { status: 'pending', promise };
    cache.set(locale, pending);
    return pending;
  }

  function Provider({ initialLocale, preload, fallback = null, children }: {
    initialLocale: Locale;
    preload?: readonly Locale[];
    fallback?: ReactNode;
    children?: ReactNode;
  }): ReactElement {
    const [locale, setCurrentLocale] = useState(initialLocale);
    const [pending, startTransition] = useTransition();
    const [actions] = useState<Actions>(() => {
      const activeLoaders = new Map<AnyLoader, number>();
      const setLocale = (nextLocale: Locale) => {
        const loaders = activeLoaders.size ? activeLoaders.keys() : [loadLocale as AnyLoader];
        const warm = [...loaders].every(loader => resources.get(loader)?.get(nextLocale)?.status === 'fulfilled');
        if (warm) {
          setCurrentLocale(nextLocale);
        } else {
          startTransition(() => setCurrentLocale(nextLocale));
        }
      };
      return { setLocale, activeLoaders, preload };
    });

    useEffect(() => {
      actions.preload = preload;
      let cancelled = false;
      // Provider effects can run before descendant registrations. One microtask
      // keeps preloading post-hydration while letting selected hooks publish
      // their loader contracts first.
      void Promise.resolve().then(() => {
        if (cancelled) return;
        const loaders = actions.activeLoaders.size ? [...actions.activeLoaders.keys()] : [loadLocale as AnyLoader];
        for (const nextLocale of preload ?? []) {
          if (nextLocale === locale) continue;
          for (const loader of loaders) void getResource(loader, nextLocale).promise.catch(() => undefined);
        }
      });
      return () => { cancelled = true; };
    }, [actions, locale, preload]);

    return createElement(React.Suspense, { fallback },
      createElement(ActionsContext.Provider, { value: actions },
        createElement(LocaleContext.Provider, { value: locale },
          createElement(PendingContext.Provider, { value: pending }, children))));
  }

  function useActions(): Actions { return useRequiredContext(ActionsContext); }

  function useLoaded<SelectedMessages>(loader: Loader<SelectedMessages>): LoadedLocale<Locale, SelectedMessages> {
    const actions = useActions();
    const locale = useRequiredContext(LocaleContext);
    useEffect(() => {
      const key = loader as AnyLoader;
      const count = actions.activeLoaders.get(key) ?? 0;
      actions.activeLoaders.set(key, count + 1);
      if (count === 0) {
        for (const nextLocale of actions.preload ?? []) void getResource(loader, nextLocale).promise.catch(() => undefined);
      }
      return () => {
        const remaining = actions.activeLoaders.get(key) ?? 0;
        if (remaining <= 1) actions.activeLoaders.delete(key);
        else actions.activeLoaders.set(key, remaining - 1);
      };
    }, [actions, loader]);
    const resource = getResource(loader, locale);
    return readResource(resource, () => forgetRejected(loader as AnyLoader, locale, resource));
  }

  function preload<SelectedMessages = Messages>(
    locale: Locale,
    loader: Loader<SelectedMessages> = loadLocale as unknown as Loader<SelectedMessages>,
  ): Promise<LoadedLocale<Locale, SelectedMessages>> {
    // An explicit preload retries a failure that no render has consumed yet.
    if (resources.get(loader as AnyLoader)?.get(locale)?.status === 'rejected') {
      resources.get(loader as AnyLoader)?.delete(locale);
    }
    return getResource(loader, locale).promise;
  }
  function isLoaded<SelectedMessages = Messages>(
    locale: Locale,
    loader: Loader<SelectedMessages> = loadLocale as unknown as Loader<SelectedMessages>,
  ): boolean {
    return resources.get(loader as AnyLoader)?.get(locale)?.status === 'fulfilled';
  }
  function invalidate(locale?: Locale, loader?: AnyLoader): void {
    if (loader) {
      if (locale === undefined) resources.get(loader)?.clear();
      else resources.get(loader)?.delete(locale);
    } else if (locale === undefined) {
      resources = new WeakMap();
      resourceMaps = new Set();
      loaderCount = 0;
    } else {
      for (const ref of resourceMaps) {
        const cache = ref.deref();
        if (cache) cache.delete(locale);
        else resourceMaps.delete(ref);
      }
    }
  }
  function useMessages<SelectedMessages = Messages>(
    loader: Loader<SelectedMessages> = loadLocale as unknown as Loader<SelectedMessages>,
  ): SelectedMessages {
    return useLoaded(loader).messages;
  }
  function useLocale(): Locale { return useRequiredContext(LocaleContext); }
  function useSetLocale(): SetLocale { return useActions().setLocale; }
  function usePending(): boolean { return useRequiredContext(PendingContext); }
  function useI18n<SelectedMessages = Messages>(
    loader: Loader<SelectedMessages> = loadLocale as unknown as Loader<SelectedMessages>,
  ): LoadedLocale<Locale, SelectedMessages> & { setLocale: SetLocale; pending: boolean } {
    const { setLocale } = useActions();
    const snapshot = useLoaded(loader);
    const pending = usePending();
    return useMemo(() => ({ ...snapshot, setLocale, pending }), [snapshot, setLocale, pending]);
  }

  return {
    Provider,
    useMessages,
    useLocale,
    useSetLocale,
    usePending,
    useI18n,
    preload,
    isLoaded,
    invalidate,
    loadLocale,
  };
}
