import { useEffect, useRef, useState } from 'react';
import { rich } from '@nordbeam/locale/react';
import { i18n, resolveLocale } from './app-i18n.js';

export function App() {
  const { messages: m, locale, setLocale } = i18n.useI18n();
  const [name, setName] = useState('Ada');
  const [count, setCount] = useState(2);
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);

  async function changeLocale(value: string) {
    const ticket = ++request.current;
    setError('');
    try { await setLocale(resolveLocale(value)); }
    catch (reason) { if (ticket === request.current) setError(String(reason)); }
  }

  return <main>
    <div className="eyebrow">Nordbeam Locale / React SSR</div>
    <h1>{m.title()}</h1>
    <p className="description">{m.description()}</p>
    <div className="controls">
      <label>{m.localeLabel()}<select id="locale" value={locale} onChange={event => void changeLocale(event.target.value)}>
        <option value="en">English</option><option value="fr">Français</option><option value="ar">العربية</option>
      </select></label>
      <label>{m.nameLabel()}<input id="name" value={name} onChange={event => setName(event.target.value)} /></label>
      <label>{m.countLabel()}<input id="count" type="number" min="0" max="10000" value={count}
        onChange={event => setCount(Math.max(0, Math.min(10000, Math.floor(Number(event.target.value) || 0))))} /></label>
    </div>
    <section className="preview" aria-live="polite">
      <h2 id="greeting">{m.greeting({ name })}</h2>
      <p id="items">{m.items({ count })}</p>
      <p className="total">{m.total({ amount: count * 12.5 })}</p>
      <p id="rich-note">{rich(m.richNote, { name, strong: children => <strong>{children}</strong>,
        link: children => <a href="#details">{children}</a> })}</p>
    </section>
    <footer id="details"><span id="status">{m.status({ locale })}</span><p>{m.note()}</p></footer>
    {error && <p role="alert" id="error">{error}</p>}
  </main>;
}
