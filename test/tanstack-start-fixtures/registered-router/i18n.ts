import { createTanStackStartI18n, defineRouting } from '../../../dist/tanstack-start.js';

export const routing = defineRouting({ locales: ['en', 'de'], defaultLocale: 'en', localePrefix: 'as-needed' });
export const i18n = createTanStackStartI18n({
  routing,
  loadLocale: async (locale: 'en' | 'de') => ({ locale, messages: { title: () => 'Welcome' } }),
});
