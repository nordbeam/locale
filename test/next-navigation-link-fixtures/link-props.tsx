import { createNextNavigation } from '../../dist/next-navigation.js';

const { Link, redirect } = createNextNavigation({ locales: ['en', 'fr'], defaultLocale: 'en', localePrefix: 'as-needed' });

export const accepted = <>
  <Link href="/about" className="nav" onClick={() => undefined} prefetch={false} locale="fr">About</Link>
  <Link href="/about" locale={false} scroll={false} target="_blank" rel="noreferrer">Raw</Link>
</>;

// @ts-expect-error unknown props are rejected
export const unknownProp = <Link href="/about" notAProp={true}>About</Link>;

// @ts-expect-error locale must be one of the configured locales
export const unknownLocale = <Link href="/about" locale="de">About</Link>;

export const redirectWithLocale = (): never => redirect('/dashboard', 'fr');
export const redirectWithOptions = (): never => redirect('/dashboard', { locale: false });

// @ts-expect-error redirect requires an explicit locale
export const redirectWithoutLocale = (): never => redirect('/dashboard');
