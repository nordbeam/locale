# Svelte adapter — `@nordbeam/locale/svelte`

Svelte 5 adapter (store syntax works in Svelte 4 too). It exposes locale,
messages, and pending state as Svelte stores and keeps one instance per app or
per server request.

```ts
import { createSvelteI18n, getI18nContext, setI18nContext } from '@nordbeam/locale/svelte';
```

- `createSvelteI18n({ initial, loadLocale })` — create an instance.
- `setI18nContext(i18n)` — provide it to descendants. Call it in a root component.
- `getI18nContext<Locale, Messages>()` — read it in a child. Throws if no parent set it.

## Create

Create the instance from the generated module. `initial` is the already-loaded
locale for the request.

```ts
// src/lib/i18n.ts
import { createSvelteI18n } from '@nordbeam/locale/svelte';
import { loadLocale } from '$lib/i18n/index.js';

export const createI18n = (initial: Awaited<ReturnType<typeof loadLocale>>) =>
  createSvelteI18n({ initial, loadLocale });
```

Create one instance per request on the server. Never keep one at module scope
in SSR code, because loaded messages would be shared between users.

## Context

```svelte
<!-- Root component: runs once per render -->
<script lang="ts">
  import { setI18nContext } from '@nordbeam/locale/svelte';
  import { createI18n } from '$lib/i18n.js';

  let { initial } = $props();
  setI18nContext(createI18n(initial));
</script>

<slot />
```

```svelte
<!-- Any descendant -->
<script lang="ts">
  import { getI18nContext } from '@nordbeam/locale/svelte';
  import type { Locale, Messages } from '$lib/i18n/index.js';

  const { locale, messages, pending, setLocale } = getI18nContext<Locale, Messages>();
</script>

<p lang={$locale}>{$messages.greeting({ name: 'Ada' })}</p>
<button disabled={$pending} onclick={() => setLocale('fr')}>Français</button>
```

## Stores

- `locale` — current locale.
- `messages` — current messages. Use `$messages.key(values)` in templates.
- `pending` — `true` while a cold locale loads. The previous locale stays visible.
- `setLocale(locale)` — resolves `true` when applied, `false` when a newer
  request superseded it. The newest request always decides the final locale
  and `pending`.
- `preload(locale, loader?)` — load a locale or a selected loader without switching.

The stores follow the Svelte store contract, so `$store` syntax and `get()`
from `svelte/store` both work.

## Selected loaders

Use `select` with `selectMessages` to subscribe to a subset of messages. The
store keeps the previous selection until the next locale is ready.

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

A selection is not available synchronously until it loads. During server
rendering, await `preload(locale, loader)` before rendering so `$selected` is
set. Selections are cached per locale in each instance.

## SvelteKit server data

Message functions can't be serialized from a server `load`, so the server
passes only the locale. The universal `+layout.ts` load then loads that locale
and creates the instance on both the server render and the client.

```ts
// src/routes/+layout.ts
import { createI18n } from '$lib/i18n.js';
import { loadLocale } from '$lib/i18n/index.js';

export async function load({ data }) {
  const initial = await loadLocale(data.locale);
  return { i18n: createI18n(initial) };
}
```

```ts
// src/routes/+layout.server.ts
export function load({ cookies }) {
  return { locale: cookies.get('locale') === 'fr' ? 'fr' : 'en' };
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

## Vite selection

The Vite plugin infers `selectMessages` and `loadLocale` only in `.js`/`.ts`
modules. Call `selectMessages(...)` in a `.ts` module such as `src/lib/i18n.ts`,
then import it into `.svelte` files. Calls written directly inside a `.svelte`
`<script>` still work, but the plugin can't prune the catalog for them.

## Init

`nordbeam-locale init --framework svelte` creates `src/i18n/svelte.ts`, which
exports `i18n` from `createSvelteI18n` with the base locale. Call
`setI18nContext(i18n)` during initialization of the root component or layout;
descendants read it with `getI18nContext()`. When
`@sveltejs/vite-plugin-svelte` is in `package.json` and no Vite config exists,
init also creates `vite.config.ts` with `svelte()` and `nordbeamLocale()`. An
existing config is preserved, and re-running init never replaces the adapter.
