import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getLocale } from '@nordbeam/locale/tanstack-start';
import { i18n } from '../i18n-app';

/** Server functions format messages in the locale of the page that called them. */
const greetFromServer = createServerFn().handler(async () => {
  const { messages } = await i18n.load((getLocale() ?? i18n.defaultLocale) as (typeof i18n.locales)[number]);
  return messages.greeting({ name: 'Server' });
});

export const Route = createFileRoute('/blog/$slug')({
  // Loaders format messages with the locale the root route resolved.
  loader: async ({ params, context }) => {
    const { messages } = await i18n.load(context.locale);
    return { title: messages.post({ slug: params.slug }), greeting: await greetFromServer() };
  },
  component: Post,
});

function Post() {
  const { title, greeting } = Route.useLoaderData();
  const m = i18n.useMessages();
  return <section data-page="post">
    <h1>{title}</h1>
    <p data-server-fn>{m.fromServer({ greeting })}</p>
  </section>;
}
