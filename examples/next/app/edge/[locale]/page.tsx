import { notFound } from 'next/navigation';
import { createNextI18n } from '@nordbeam/locale/next/runtime';
import { loadLocale, locales } from '../../../src/i18n/scopes/route/index.js';

const i18n = createNextI18n({ locales, loadLocale });
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function EdgePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!i18n.hasLocale(locale)) notFound();
  const { messages: m } = await i18n.loadLocale(locale);
  return <p data-edge-greeting>{m.greeting({ name: 'Edge' })}</p>;
}
