import { createNextNavigation } from '../../packages/locale/dist/next-navigation.js';
import { defineRouting } from '../../packages/locale/dist/next-routing.js';

const routing = defineRouting({
  locales: ['en', 'de'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  pathnames: {
    '/about': { de: '/ueber-uns' },
    '/blog/[slug]': { de: '/artikel/[slug]' },
    '/docs/[...path]': { de: '/dokumente/[...path]' },
    '/shop/[[...cat]]': '/shop/[[...cat]]',
    '/blog/[slug]/comments/[id]': { de: '/artikel/[slug]/kommentare/[id]' },
  },
});

const { Link, redirect, permanentRedirect, getPathname, usePathname, useRouter } = createNextNavigation(routing);

// Accepted: plain strings, typed pattern objects, and the optional catch-all without params.
export const plain = <Link href="/anything/goes" locale="de">Plain</Link>;
export const blog = <Link href={{ pathname: '/blog/[slug]', params: { slug: 'hello' }, query: { tab: 'all' }, hash: 'top' }} locale="de">Post</Link>;
export const docs = <Link href={{ pathname: '/docs/[...path]', params: { path: ['a', 'b'] } }}>Docs</Link>;
export const shop = <Link href={{ pathname: '/shop/[[...cat]]' }}>Shop</Link>;
export const nested = <Link href={{ pathname: '/blog/[slug]/comments/[id]', params: { slug: 'a', id: '1' } }}>Comment</Link>;
export const about = getPathname({ href: { pathname: '/about' }, locale: 'de' });
export const current: string = usePathname();
export const router = useRouter().replace(usePathname(), { locale: 'de' });
export const perm = (): never => permanentRedirect({ pathname: '/blog/[slug]', params: { slug: 'x' } }, 'de');
export const redirected = (): never => redirect('/about', 'de');

// @ts-expect-error pathname must be one of the configured pattern keys
export const unknownKey = <Link href={{ pathname: '/nope' }}>Nope</Link>;

// @ts-expect-error params must match the pattern's [param] names
export const wrongParam = getPathname({ href: { pathname: '/blog/[slug]', params: { id: 'x' } }, locale: 'de' });

// @ts-expect-error a [param] takes a string, not an array
export const stringArray = getPathname({ href: { pathname: '/blog/[slug]', params: { slug: ['a'] } }, locale: 'de' });

// @ts-expect-error a catch-all takes an array of segments
export const catchAllString = getPathname({ href: { pathname: '/docs/[...path]', params: { path: 'a' } }, locale: 'de' });

// @ts-expect-error a dynamic pattern needs its params
export const missingParams = getPathname({ href: { pathname: '/blog/[slug]' }, locale: 'de' });

// @ts-expect-error a static pattern takes no params
export const staticParams = getPathname({ href: { pathname: '/about', params: { slug: 'x' } }, locale: 'de' });

// @ts-expect-error locale must be one of the configured locales
export const unknownLocale = getPathname({ href: '/about', locale: 'fr' });

// @ts-expect-error pathname keys are checked for redirect too
export const redirectUnknown = (): never => redirect({ pathname: '/missing' }, 'de');
