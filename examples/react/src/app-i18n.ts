import { createReactI18n } from '@nordbeam/locale/react';
import { selectMessages, locales } from './i18n/index.js';
import type { Locale } from './i18n/index.js';

export const i18n = createReactI18n(selectMessages('title', 'description', 'greeting',
  'items', 'total', 'nameLabel', 'countLabel', 'localeLabel', 'status', 'note', 'richNote'));

export function resolveLocale(value: unknown): Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value) ? value as Locale : 'en';
}
