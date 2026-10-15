import type { ReactNode } from 'react';
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts } from '@tanstack/react-router';
import type { TanStackStartRouterContext } from '@nordbeam/locale/tanstack-start';
import { i18n } from '../i18n-app';

export const Route = createRootRouteWithContext<TanStackStartRouterContext<(typeof i18n.locales)[number]>>()({
  beforeLoad: i18n.beforeLoad,
  head: () => ({ meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }] }),
  shellComponent: RootDocument,
  component: () => <i18n.Provider><Layout /></i18n.Provider>,
});

function RootDocument({ children }: { children: ReactNode }) {
  const html = i18n.useHtmlAttributes();
  return <html {...html}>
    <head><HeadContent /></head>
    <body>{children}<Scripts /></body>
  </html>;
}

function Layout() {
  const { messages: m } = i18n.useI18n();
  return <main>
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
