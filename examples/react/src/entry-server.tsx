import { renderToString } from 'react-dom/server';
import { App } from './App.js';
import { i18n, resolveLocale } from './app-i18n.js';

export async function render(requestedLocale: string | null) {
  const locale = resolveLocale(requestedLocale);
  const initial = await i18n.loadLocale(locale);
  return {
    locale,
    direction: locale === 'ar' ? 'rtl' : 'ltr',
    html: renderToString(<i18n.Provider initial={initial}><App /></i18n.Provider>),
    // Only data crosses the network. Message functions are loaded on both sides.
    data: JSON.stringify({ locale }).replaceAll('<', '\\u003c'),
  };
}
