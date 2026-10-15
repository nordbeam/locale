import { createStart } from '@tanstack/react-start';
import {
  createLocaleFunctionMiddleware,
  createLocaleMiddleware,
  createTanStackStartI18n,
  defineRouting,
  getLocale,
  type TanStackStartRouterContext,
} from '../../dist/tanstack-start.js';

const routing = defineRouting({
  locales: ['en', 'de'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  pathnames: {
    '/about': { de: '/ueber-uns' },
    '/blog/$slug': { de: '/artikel/$slug' },
  },
  domains: [{ domain: 'example.de', defaultLocale: 'de', locales: ['de'] }],
});

const messages = { title: () => 'Welcome', greeting: (values: { name: string }) => `Hello ${values.name}` };
const i18n = createTanStackStartI18n({
  routing,
  loadLocale: async (locale: 'en' | 'de') => ({ locale, messages }),
});

// The locale names are the routing locales.
export const locales: readonly ('en' | 'de')[] = i18n.locales;
export const link = <i18n.LocaleLink locale="de" className="switch">Deutsch</i18n.LocaleLink>;
export const setter = (): Promise<void> => i18n.useSetLocale()('de');
export const path: string = i18n.getPathname({ to: '/blog/$slug', params: { slug: 'x' }, locale: 'de', search: { page: 2 }, hash: 'top' });
export const loaded = i18n.load('de').then(value => value.messages.greeting({ name: 'Ada' }));
export const typed: string = i18n.useMessages().greeting({ name: 'Ada' });
export const current: 'en' | 'de' = i18n.useLocale();
export const html: { readonly lang: 'en' | 'de'; readonly dir: 'ltr' | 'rtl' } = i18n.useHtmlAttributes();
export const resolved: Promise<{ locale: 'en' | 'de' }> = i18n.beforeLoad({ location: { publicHref: '/de' }, context: {}, matches: [] });
export const context: TanStackStartRouterContext<'en' | 'de'> = i18n.routerOptions().context;
export const where: string | undefined = getLocale();

// Both middlewares register in createStart.
export const start = createStart(() => ({
  requestMiddleware: [createLocaleMiddleware(routing, { trustForwardedHost: true, ignore: pathname => pathname.startsWith('/health') })],
  functionMiddleware: [createLocaleFunctionMiddleware()],
}));

// @ts-expect-error a locale outside the routing is rejected by LocaleLink
export const unknownLink = <i18n.LocaleLink locale="fr">Francais</i18n.LocaleLink>;

// @ts-expect-error a locale outside the routing is rejected by the switcher
export const unknownSetter = (): Promise<void> => i18n.useSetLocale()('fr');

// @ts-expect-error getPathname needs a known locale
export const unknownPath = i18n.getPathname({ to: '/about', locale: 'fr' });

// @ts-expect-error getPathname needs a locale
export const missingLocale = i18n.getPathname({ to: '/about' });

// @ts-expect-error messages are typed by the loader
export const missingMessage = i18n.useMessages().nope();

export const badPathname = defineRouting({
  locales: ['en', 'de'],
  defaultLocale: 'en',
  // @ts-expect-error a pathname variant for a locale outside the routing is rejected
  pathnames: { '/about': { fr: '/a-propos' } },
});

export const badDomain = defineRouting({
  locales: ['en', 'de'],
  defaultLocale: 'en',
  // @ts-expect-error a domain's locales must be routing locales
  domains: [{ domain: 'example.fr', defaultLocale: 'fr' }],
});
