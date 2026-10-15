import { createFileRoute } from '@tanstack/react-router';
import { i18n } from '../i18n-app';

export const Route = createFileRoute('/about')({ component: About });

function About() {
  const m = i18n.useMessages();
  return <section data-page="about"><h1>{m.about()}</h1></section>;
}
