# Nordbeam Locale cookbook

This page collects small, copyable patterns for the React target. Start with
the plain `loadLocale` flow in the README; add a selected loader only after a
Vite warning identifies a boundary that cannot be inferred safely.

## Locale switcher

Create the client controller once, then render it below its provider. The
provider keeps the current locale visible while a new locale is loading and
exposes `pending` for accessible progress UI.

```tsx
// src/i18n/client.ts
'use client';
import { createClientI18n } from '@nordbeam/locale/react';
import { loadLocale } from './index.js';

export const i18n = createClientI18n(loadLocale);
```

```tsx
import { i18n } from './i18n/client.js';

export function LocaleSwitcher() {
  const { locale, setLocale, pending } = i18n.useI18n();
  return (
    <label>
      Language
      <select
        value={locale}
        disabled={pending}
        onChange={event => void setLocale(event.target.value as 'en' | 'fr')}
      >
        <option value="en">English</option>
        <option value="fr">Français</option>
      </select>
      {pending ? <span aria-live="polite"> Loading…</span> : null}
    </label>
  );
}
```

Mount the provider at the browser boundary with the locale selected by the
server or bootstrap code:

```tsx
<i18n.Provider initialLocale="en" fallback={<p>Loading translations…</p>}>
  <App />
</i18n.Provider>
```

For Next.js, pass only the locale string from a Server Component to a small
`'use client'` provider. Never pass a loaded messages object across React
Flight; generated message functions are not serializable.

## Dates and currency

Keep formatting in the catalog so translators can control word order and
plural rules. ICU `number`, `date`, and `time` arguments use the platform
`Intl` implementation.

```json
{
  "invoice.total": "Total: {amount, number, ::currency/USD}",
  "invoice.due": "Due {date, date, medium}",
  "cart.updated": "Updated at {at, time, short}"
}
```

```ts
const { messages: m } = await loadLocale('en');
m['invoice.total']({ amount: 1299.5 });
m['invoice.due']({ date: new Date('2026-09-10T12:00:00Z') });
m['cart.updated']({ at: new Date() });
```

Pin `timeZone` in `nordbeam-locale.config.json` when server and browser output
must agree. Currency and locale display still follow the requested locale and
the runtime's `Intl` data.

## Rich text

Use the server-safe rich entry when an ICU message contains XML-like tags. Each
slot receives its rendered children and must return a React element.

```json
{
  "terms": "Read our <link>terms of service</link> and <strong>privacy policy</strong>."
}
```

```tsx
import { rich } from '@nordbeam/locale/react/rich';

const { messages: m } = await loadLocale('en');
const content = rich(m.terms, {
  link: children => <a href="/terms">{children}</a>,
  strong: children => <strong>{children}</strong>,
});
```

A plain argument such as `{code}` also takes a React element, in a message with
or without tags. The element goes where the argument is, so translators can
still move it:

```tsx
// "promo": "Use {code} at checkout"
rich(m.promo, { code: <strong>{promoCode}</strong> });
```

When the element's text should be translated too, make it a slot
(`Use <code>{code}</code> at checkout`) so translators see it. Number, date and
`select` arguments take values only.

Use `includeSources` only when a component needs the original ICU source for a
custom rich renderer. Ordinary messages should use the generated formatter
alone.

## Testing

Bind the generated `Messages` type once. Selectors stay refactorable, and a
locale matrix exercises every catalog without putting a global locale in test
state.

```ts
import { createMessageTestHelpers } from '@nordbeam/locale/testing';
import type { Locale, Messages } from '../src/i18n/index.js';
import { loadLocale, locales } from '../src/i18n/index.js';

const testI18n = createMessageTestHelpers<Messages>();

test('price has a stable key', () => {
  expect(testI18n.keyFromSelector(m => m.product.price)).toBe('product.price');
});

test('every locale renders the price', async () => {
  const results = await testI18n.localeMatrix(locales, loadLocale,
    messages => messages.product.price({ amount: 12 }));
  expect(Object.keys(results) as Locale[]).toEqual(locales);
});
```

For snapshot tests, set a fixed `timeZone` and pass stable dates. Prefer
message functions over snapshots of the generated module itself.

Component tests need a messages object for the provider. Import the base
locale's generated module for the real text, `messageIds` when a test asserts
IDs, and `withMessages` to replace a few messages:

```tsx
import { compileMessages, messageIds, withMessages } from '@nordbeam/locale/testing';
import en from '../src/i18n/locales/en.js';

const renderWith = (messages: typeof en) =>
  render(<i18n.Provider initial={{ locale: 'en', messages }}><Checkout /></i18n.Provider>);

test('shows the title by ID', () => {
  renderWith(messageIds(en));
  expect(screen.getByText('checkout.title')).toBeVisible();
});

test('formats the total', async () => {
  renderWith(withMessages(en, await compileMessages({ 'cart.total': 'Total: {amount, number}' })));
  expect(screen.getByText('Total: 1,200')).toBeVisible();
});
```

## CI

Run strict validation before the application type-check. If generated output is
ignored, `prebuild` runs the generator before each build, so a clean clone builds
without a manual step. Avoid `prepare` for this: it runs on every `npm install`,
including production installs where the CLI is not present.

```json
{
  "scripts": {
    "prebuild": "nordbeam-locale --production",
    "i18n:check": "nordbeam-locale check --strict",
    "build": "npm run i18n:check && tsc -b"
  }
}
```

For a repository that wants a separate generation step, use
`npx nordbeam-locale` before `tsc` and keep `nordbeam-locale check --strict` in the
verification job. In development, run `nordbeam-locale --watch`; framework
integrations may own that watcher in dev so a second terminal is unnecessary.

See the [package reference](reference/README.md) for every public entry point.
