import { createRouter } from '@tanstack/react-router';
import { i18n } from './i18n.js';
import { Route, routeTree } from './root.js';

export function getRouter() {
  return createRouter({ routeTree, ...i18n.routerOptions() });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}

// The route context carries the locale the root beforeLoad resolved.
export const locale: 'en' | 'de' = Route.useRouteContext().locale;
