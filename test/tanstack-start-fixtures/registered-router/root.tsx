import { createRootRouteWithContext, createRoute } from '@tanstack/react-router';
import type { TanStackStartRouterContext } from '../../../packages/locale/dist/tanstack-start.js';
import { i18n } from './i18n.js';

// The documented wiring: no wrapper, no annotation.
export const Route = createRootRouteWithContext<TanStackStartRouterContext<'en' | 'de'>>()({
  beforeLoad: i18n.beforeLoad,
  loader: ({ context }) => ({ locale: context.locale }),
});

const about = createRoute({ getParentRoute: () => Route, path: '/about' });

export const routeTree = Route.addChildren([about]);
