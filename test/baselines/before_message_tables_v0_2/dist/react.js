'use client';
import { Children, Fragment, createContext, createElement, isValidElement, useContext, useMemo, useState, useSyncExternalStore } from 'react';
import { createLocaleStore } from './index.js';
function keyedParts(children) {
    // The compiler owns this outer array. Text-only runs need no copy or React
    // traversal; callback results can still be arbitrary React children.
    let parts;
    for (let index = 0; index < children.length; index++) {
        const child = children[index];
        if (typeof child === 'string' || typeof child === 'number') {
            parts?.push(child);
            continue;
        }
        parts ??= children.slice(0, index);
        if (child == null || typeof child === 'boolean')
            continue;
        if (isValidElement(child)) {
            parts.push(createElement(Fragment, { key: parts.length }, child));
        }
        else {
            // Delegate arrays, iterables, portals and React-version-specific nodes
            // to React. Never inspect element children or mutate a callback result.
            const target = parts;
            Children.forEach(child, value => {
                if (value === null)
                    return;
                target.push(typeof value === 'string' || typeof value === 'number' ? value
                    : createElement(Fragment, { key: target.length }, value));
            });
        }
    }
    return parts ?? children;
}
/** Render a generated rich message with typed slots and automatic React keys. */
export function rich(message, args) {
    const values = { ...args };
    for (const key of Object.keys(values)) {
        const value = values[key];
        if (typeof value === 'function')
            values[key] = (children) => value(keyedParts(children));
    }
    // The generic node type is specialized by the React slot callbacks above.
    const render = message;
    return createElement(Fragment, null, keyedParts(render(values)));
}
/** Bind typed hooks to a locale loader. Each Provider owns its own store. */
export function createReactI18n(loadLocale) {
    const Context = createContext(null);
    function Provider({ initial, children }) {
        // Capture once: the server snapshot must stay the same while different
        // Suspense boundaries hydrate, even if a client locale switch has started.
        const [state] = useState(() => {
            const store = createLocaleStore({ initial, loadLocale });
            const serverSnapshot = store.getSnapshot();
            return { store, getServerSnapshot: () => serverSnapshot };
        });
        return createElement(Context.Provider, { value: state }, children);
    }
    function useStateContext() {
        const state = useContext(Context);
        if (!state)
            throw new Error('fasti18n: wrap this component in its matching i18n.Provider.');
        return state;
    }
    function useSnapshot() {
        const { store, getServerSnapshot } = useStateContext();
        return useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);
    }
    function useMessages() { return useSnapshot().messages; }
    function useLocale() { return useSnapshot().locale; }
    // Controls that only change the locale need no store subscription.
    function useSetLocale() { return useStateContext().store.setLocale; }
    function useI18n() {
        const snapshot = useSnapshot();
        const setLocale = useSetLocale();
        return useMemo(() => ({ ...snapshot, setLocale }), [snapshot, setLocale]);
    }
    return { Provider, useMessages, useLocale, useSetLocale, useI18n, loadLocale };
}
