import { fileURLToPath } from 'node:url';
import { withNordbeamLocale } from '@nordbeam/locale/next';

const root = fileURLToPath(new URL('.', import.meta.url));

export default withNordbeamLocale({
  reactStrictMode: true,
  turbopack: { root: fileURLToPath(new URL('../..', import.meta.url)) },
}, { root });
