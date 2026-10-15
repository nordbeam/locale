import { createStart } from '@tanstack/react-start';
import { createLocaleFunctionMiddleware, createLocaleMiddleware } from '@nordbeam/locale/tanstack-start';
import { routing } from './i18n-app';

export const startInstance = createStart(() => ({
  requestMiddleware: [createLocaleMiddleware(routing)],
  functionMiddleware: [createLocaleFunctionMiddleware()],
}));
