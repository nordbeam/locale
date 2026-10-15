import { notFound } from 'next/navigation';
import { createNextI18n } from '@nordbeam/locale/next/runtime';
import { rich } from '@nordbeam/locale/react/rich';
import { loadLocale, locales } from '../../src/i18n/scopes/route/index.js';
import { ClientGreeting } from './client-greeting';
import { getLocaleDirection } from '../locale-direction';

const i18n = createNextI18n({ locales, loadLocale });

export const dynamicParams = false;
export function generateStaticParams() { return i18n.generateStaticParams(); }

export default async function LocalePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!i18n.hasLocale(locale)) notFound();
  const { messages: m } = await i18n.loadLocale(locale);
  return <main lang={locale} dir={getLocaleDirection(locale)} data-locale-scope>
    <h1>{m.title()}</h1>
    <p data-server-greeting>{m.greeting({ name: 'Server' })}</p>
    <p>{m.items({ count: 2 })}</p>
    <p>{rich(m.richNote, { strong: children => <strong>{children}</strong> })}</p>
    <ClientGreeting locale={locale} />
  </main>;
}
