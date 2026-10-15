import { hydrateRoot } from 'react-dom/client';
import { App } from './App.js';
import { i18n, resolveLocale } from './app-i18n.js';
import '../../vite/src/style.css';

const data = JSON.parse(document.getElementById('i18n-initial')!.textContent!);
const initial = await i18n.loadLocale(resolveLocale(data.locale));
hydrateRoot(document.getElementById('root')!, <i18n.Provider initial={initial}><App /></i18n.Provider>);
