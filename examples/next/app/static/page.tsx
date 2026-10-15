import { greeting } from '../../src/i18n/locales/en.js';

export const dynamic = 'force-static';
export default function StaticPage() {
  return <p data-static-greeting>{greeting({ name: 'Static' })}</p>;
}
