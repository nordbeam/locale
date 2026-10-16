# Svelte 5 and SvelteKit (Vite)

Package entries: `@nordbeam/locale/svelte` (`createSvelteI18n`, `setI18nContext`, `getI18nContext`), `nordbeam-locale/vite`. Locale, messages and pending state are Svelte stores (store syntax also works in Svelte 4).

## Setup

```sh
npm install svelte
npm install --save-dev @sveltejs/vite-plugin-svelte
npx nordbeam-locale init --framework svelte
```

Install the plugin first: init writes `vite.config.ts` with `svelte()` and `nordbeamLocale()` only when `@sveltejs/vite-plugin-svelte` is declared and no Vite config exists; otherwise it prints a note. Init also creates `src/i18n/svelte.ts` (`export const i18n = createSvelteI18n({ initial: { locale: baseLocale, messages }, loadLocale })`, with the base locale imported statically).

## Client app

Provide the instance once in the root component, read it in children:

```svelte
<!-- src/App.svelte -->
<script lang="ts">
  import { setI18nContext } from '@nordbeam/locale/svelte';
  import { i18n } from './i18n/svelte.js';
  import Greeting from './Greeting.svelte';

  setI18nContext(i18n);
</script>

<Greeting />
```

```svelte
<!-- src/Greeting.svelte -->
<script lang="ts">
  import { getI18nContext } from '@nordbeam/locale/svelte';
  import type { Locale, Messages } from './i18n/index.js';

  const { locale, messages, pending, setLocale } = getI18nContext<Locale, Messages>();
</script>

<p lang={$locale}>{$messages.greeting({ name: 'Ada' })}</p>
<button disabled={$pending} onclick={() => setLocale('de')}>Deutsch</button>
```

- Stores: `locale`, `messages` (use `$messages.key(values)` in templates), `pending` (true while a cold locale loads, previous locale stays visible).
- `setLocale(locale)` resolves `true` when applied and `false` when a newer request superseded it. `preload(locale, loader?)` loads without switching.
- `getI18nContext()` throws when no parent called `setI18nContext`; it must run during component initialisation.
- The module-level `i18n` from the scaffold is correct for a client-only app. For SSR or SvelteKit create one instance per request (below); a module-scope instance would share loaded messages between users.

## Selected loaders

```ts
// src/lib/i18n.ts
import { selectMessages } from '$lib/i18n/index.js';
export const home = selectMessages('greeting', 'items');
```

```svelte
<script lang="ts">
  import { getI18nContext } from '@nordbeam/locale/svelte';
  import { home } from '$lib/i18n.js';
  const { select } = getI18nContext();
  const selected = select(home);
</script>
{#if $selected}<p>{$selected.greeting({ name: 'Ada' })}</p>{/if}
```

A selection is not available synchronously. During server rendering, `await preload(locale, loader)` before rendering. Call `selectMessages` in a `.ts` module; the Vite plugin does not analyse raw `.svelte` scripts.

## SvelteKit

Message functions cannot be serialised from a server `load`, so the server returns only the locale and a universal `+layout.ts` creates the instance on server and client:

```ts
// src/routes/+layout.server.ts
export function load({ cookies }) {
  return { locale: cookies.get('locale') === 'fr' ? 'fr' : 'en' };
}
```

```ts
// src/routes/+layout.ts
import { createSvelteI18n } from '@nordbeam/locale/svelte';
import { loadLocale } from '$lib/i18n/index.js';

export async function load({ data }) {
  const initial = await loadLocale(data.locale);
  return { i18n: createSvelteI18n({ initial, loadLocale }) };
}
```

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { setI18nContext } from '@nordbeam/locale/svelte';
  let { data, children } = $props();
  setI18nContext(data.i18n);
</script>

{@render children()}
```

In SvelteKit the generated folder is usually under `src/lib/i18n`; set `outDir` accordingly (`init --out-dir src/lib/i18n`) and keep the `$lib` alias in imports. Validate the locale value (as `'fr'`/`'en'` above), never trust it raw.

Reference page: https://github.com/nordbeam/locale/blob/main/docs/reference/svelte.md
