import { useEffect, useState, type ReactNode } from 'react';
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts } from '@tanstack/react-router';
import type { TanStackStartRouterContext } from '@nordbeam/locale/tanstack-start';
import { i18n } from '../i18n-app';

export const Route = createRootRouteWithContext<TanStackStartRouterContext<(typeof i18n.locales)[number]>>()({
  beforeLoad: i18n.beforeLoad,
  head: () => ({ meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }] }),
  shellComponent: RootDocument,
  component: Root,
});

function RootDocument({ children }: { children: ReactNode }) {
  const html = i18n.useHtmlAttributes();
  return <html {...html}>
    <head><HeadContent /></head>
    <body>{children}<Scripts /></body>
  </html>;
}

// State set once the page is interactive, as analytics or theme code does. The update reaches
// the provider while hydration may still be waiting for the catalog.
function Root() {
  const [interactive, setInteractive] = useState(false);
  useEffect(() => setInteractive(true), []);
  return <i18n.Provider><Layout interactive={interactive} /></i18n.Provider>;
}

function Layout({ interactive }: { interactive: boolean }) {
  const { messages: m } = i18n.useI18n();
  return <main data-interactive={interactive || undefined}>
    <nav>
      <Link to="/">{m.title()}</Link>{' '}
      <Link to="/about" data-nav="about">{m.about()}</Link>{' '}
      <Link to="/blog/$slug" params={{ slug: 'hello' }} data-nav="post">{m.post({ slug: 'hello' })}</Link>
    </nav>
    <p data-switcher>
      {i18n.locales.map(locale => <i18n.LocaleLink key={locale} locale={locale} data-switch-locale={locale}>{locale}</i18n.LocaleLink>)}
    </p>
    <Outlet />
  </main>;
}
