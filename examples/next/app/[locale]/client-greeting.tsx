'use client';

import { createClientI18n } from '@nordbeam/locale/react';
import { loadLocale, type Locale } from '../../src/i18n/scopes/route/index.js';
import { getLocaleDirection } from '../locale-direction';

const i18n = createClientI18n(loadLocale);
const preloadLocales: readonly Locale[] = ['fr', 'ar'];

function Greeting() {
  const { locale, messages, setLocale, pending } = i18n.useI18n();
  return <section lang={locale} dir={getLocaleDirection(locale)} data-client-locale={locale} data-pending={pending}>
    <p data-client-greeting>{messages.greeting({ name: 'Client' })}</p>
    <button type="button" data-switch-locale="fr" onClick={() => setLocale('fr')}>
      Français
    </button>
    <button type="button" data-switch-locale="ar" onClick={() => setLocale('ar')}>
      العربية
    </button>
    <output data-client-locale-value>{locale}</output>
  </section>;
}

export function ClientGreeting({ locale }: { locale: Locale }) {
  return <i18n.Provider
    initialLocale={locale}
    preload={preloadLocales}
    fallback={<p>Loading client translation…</p>}
  >
    <Greeting />
  </i18n.Provider>;
}
