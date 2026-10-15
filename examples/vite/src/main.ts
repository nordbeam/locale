import { createLocaleStore } from '@nordbeam/locale';
import { selectMessages } from './i18n/index.js';
import type { Locale } from './i18n/index.js';
import './style.css';

// Keep this page's dependencies next to its code. Vite emits locale chunks
// containing just these messages; no separate scope configuration is needed.
const loadLocale = selectMessages('eyebrow', 'title', 'description', 'greeting',
  'items', 'total', 'nameLabel', 'countLabel', 'localeLabel', 'status', 'note');

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const text = (id: string, value: string) => { document.getElementById(id)!.textContent = value; };
const store = createLocaleStore({ initial: await loadLocale('en'), loadLocale });

function render() {
  const { locale, messages: m } = store.getSnapshot();
  const count = Math.max(0, Math.min(10000, Math.floor(Number(input('count').value) || 0)));
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  text('eyebrow', m.eyebrow());
  text('title', m.title());
  text('description', m.description());
  text('locale-label', m.localeLabel());
  text('name-label', m.nameLabel());
  text('count-label', m.countLabel());
  text('greeting', m.greeting({ name: input('name').value }));
  text('items', m.items({ count }));
  text('total', m.total({ amount: count * 12.5 }));
  text('status', m.status({ locale }));
  text('note', m.note());
}

store.subscribe(render);
input('name').addEventListener('input', render);
input('count').addEventListener('input', render);
input('locale').addEventListener('change', async () => {
  text('error', '');
  try { await store.setLocale(input('locale').value as Locale); }
  catch (error) {
    input('locale').value = store.getSnapshot().locale;
    text('error', String(error));
  }
});
render();
