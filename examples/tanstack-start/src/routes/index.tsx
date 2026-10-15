import { createFileRoute } from '@tanstack/react-router';
import { i18n } from '../i18n-app';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  const { messages: m, locale } = i18n.useI18n();
  return <section data-page="home" data-locale={locale}>
    <h1>{m.title()}</h1>
    <p data-greeting>{m.greeting({ name: 'Client' })}</p>
    <p>{m.items({ count: 2 })}</p>
  </section>;
}
