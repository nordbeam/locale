/** Create an isolated client store. Server requests can call loadLocale directly. */
export function createLocaleStore(options) {
    let current = Object.freeze({ ...options.initial });
    let request = 0;
    const listeners = new Set();
    return {
        getSnapshot: () => current,
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        async setLocale(locale) {
            const ticket = ++request;
            if (locale === current.locale)
                return true;
            let loaded;
            try {
                loaded = await options.loadLocale(locale);
            }
            catch (error) {
                if (ticket !== request)
                    return false;
                throw error;
            }
            if (ticket !== request)
                return false;
            if (loaded.locale !== locale)
                throw new Error(`Locale loader returned ${loaded.locale} for ${locale}`);
            current = Object.freeze({ ...loaded });
            for (const listener of [...listeners])
                listener();
            return true;
        },
    };
}
