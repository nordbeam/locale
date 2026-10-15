import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { i18n } from './i18n-app';

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, ...i18n.routerOptions() });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
