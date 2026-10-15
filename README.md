# Nordbeam Locale

[![CI](https://github.com/nordbeam/locale/actions/workflows/ci.yml/badge.svg)](https://github.com/nordbeam/locale/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@nordbeam/locale.svg)](https://www.npmjs.com/package/@nordbeam/locale)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Nordbeam Locale compiles ICU MessageFormat catalogs into typed, tree-shaken
JavaScript. Each message becomes a generated function that calls the platform
`Intl` APIs at runtime, so there is no runtime parser and no `eval`. It supports
Vite + React, Next.js App Router, TanStack Start, Vue, Svelte, Solid, and plain
TypeScript/Node.

Requirements: Node 22.12 or newer, TypeScript 5.6 or newer, and Vite 6, 7, or 8
for the Vite plugin.

```sh
npm install @nordbeam/locale
npm install --save-dev @nordbeam/locale-migrate   # only when migrating existing catalogs
```

## Choose your framework

Each path runs `init` for one framework. Existing files are never replaced.

### Vite + React

```sh
npx nordbeam-locale init --framework vite-react
```

Creates `nordbeam-locale.config.json`, `messages/en.json`, `vite.config.ts`
(with `nordbeamLocale()`), `src/i18n/client.ts`, and the generated modules in
`src/i18n/`.

```tsx
// src/App.tsx
import { i18n } from './i18n/client.js';

function Greeting() {
  const { messages: m, locale, setLocale, pending } = i18n.useI18n();
  return <>
    <p lang={locale}>{m.greeting({ name: 'Ada' })}</p>
    <button disabled={pending} onClick={() => setLocale('de')}>Deutsch</button>
  </>;
}

export function App() {
  return <i18n.Provider initialLocale="en"><Greeting /></i18n.Provider>;
}
```

`setLocale` switches the locale for the whole provider. Cached locales apply
immediately, and cold locales keep the current language visible while they load.
Reference: [React](docs/reference/react.md) · [Vite](docs/reference/vite.md)

### Next.js App Router

```sh
npx nordbeam-locale init --framework next
```

Creates these files:

```js
// next.config.mjs
import { withNordbeamLocale } from '@nordbeam/locale/next';

export default withNordbeamLocale({});
```

```ts
// proxy.ts (middleware.ts before Next 16; src/proxy.ts with ./i18n/routing for a src/app project)
import { createNextMiddleware } from '@nordbeam/locale/next/middleware';
import { routing } from './src/i18n/routing';

export default createNextMiddleware(routing);

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
```

```ts
// src/i18n/routing.ts
import { defineRouting } from '@nordbeam/locale/next/routing';
import { baseLocale, locales } from './index.js';

export const routing = defineRouting({
  locales,
  defaultLocale: baseLocale,
  localePrefix: 'always',
});
```

`init` also creates `src/i18n/next.ts` (`createNextI18n`), `src/i18n/client.ts`,
and `src/i18n/provider.ts`. Use the matcher as scaffolded: it keeps `/api`,
`/_next`, `/_vercel`, and file-like paths out of locale routing. See
[the middleware matcher](docs/NEXTJS.md#the-middleware-matcher) before changing it.

A `[locale]` route validates the parameter and generates static locale paths.
Import from `.ts` sources without an extension, as the scaffold does, so webpack
and Turbopack resolve them:

```tsx
// app/[locale]/page.tsx
import { notFound } from 'next/navigation';
import { i18n } from '../../src/i18n/next';

export const dynamicParams = false;
export function generateStaticParams() { return i18n.generateStaticParams(); }

export default async function Page({ params }: PageProps<'/[locale]'>) {
  const { locale } = await params;
  if (!i18n.hasLocale(locale)) notFound();
  const { messages: m } = await i18n.loadLocale(locale);
  return <h1>{m.greeting({ name: 'Ada' })}</h1>;
}
```

To switch locale, create navigation once from the shared routing (add
`src/i18n/navigation.ts`, which the scaffold does not create):

```ts
// src/i18n/navigation.ts
import { createNextNavigation } from '@nordbeam/locale/next/navigation';
import { routing } from './routing';

export const { Link, useRouter, usePathname, redirect } = createNextNavigation(routing);
```

Then `<Link href="/" locale="de">Deutsch</Link>`. In a Server Component, read the
locale that the middleware selected with `getLocale(routing)` from
`@nordbeam/locale/next/server`.

Reference: [Next](docs/reference/next.md) · [routing](docs/reference/next-routing.md) ·
[middleware](docs/reference/next-middleware.md) · [server](docs/reference/next-server.md) ·
[navigation](docs/reference/next-navigation.md) · [guide](docs/NEXTJS.md)

### TanStack Start

```sh
npx nordbeam-locale init --framework tanstack-start
```

Creates `src/i18n/routing.ts` and `src/i18n/tanstack.ts`, plus `vite.config.ts`,
`src/start.ts`, `src/router.tsx` and `src/routes/__root.tsx` when they are
missing. For files that exist, `init` prints what to add. Routes stay
unprefixed: the locale prefix and localized pathnames live in a router
`rewrite`, so `<Link to="/about">` becomes `/fr/a-propos` on a French page.

```ts
// src/i18n/routing.ts
import { defineRouting } from '@nordbeam/locale/tanstack-start';
import { baseLocale, locales } from './index';

export const routing = defineRouting({
  locales,
  defaultLocale: baseLocale,
  localePrefix: 'as-needed',
  pathnames: { '/about': { fr: '/a-propos' } },
});
```

```tsx
// src/router.tsx: the rewrite and its state
createRouter({ routeTree, ...i18n.routerOptions() });

// src/start.ts: detection, redirects, cookie, hreflang header
createStart(() => ({ requestMiddleware: [createLocaleMiddleware(routing)] }));

// src/routes/__root.tsx: load messages, set <html lang dir>, provide them
createRootRouteWithContext<...>()({
  beforeLoad: i18n.beforeLoad,
  shellComponent: ({ children }) => <html {...i18n.useHtmlAttributes()}>...</html>,
  component: () => <i18n.Provider><Outlet /></i18n.Provider>,
});
```

Components read `i18n.useMessages()` and link with TanStack's own `Link`;
`<i18n.LocaleLink locale="fr">` switches language without a reload. Server
functions read the page locale with `getLocale()`.

Reference: [TanStack Start](docs/reference/tanstack-start.md) ·
[routing](docs/reference/next-routing.md) · [React](docs/reference/react.md)

### Vue (Vite)

```sh
npm install vue
npm install --save-dev @vitejs/plugin-vue
npx nordbeam-locale init --framework vue
```

Install the Vite plugin first. `init` writes `vite.config.ts` with
`vue()` and `nordbeamLocale()` only when `@vitejs/plugin-vue` is declared in
`package.json`. Otherwise it prints a note. It also creates `src/i18n/vue.ts`,
which exports `i18n`.

```ts
// src/main.ts
import { createApp, defineComponent, h } from 'vue';
import { i18n } from './i18n/vue.js';

const Greeting = defineComponent({
  setup() {
    const { messages, pending, setLocale } = i18n.useI18n();
    return () => h('button', { disabled: pending.value, onClick: () => setLocale('de') },
      messages.value.greeting({ name: 'Ada' }));
  },
});

createApp(Greeting).use(i18n).mount('#app');
```

`setLocale` returns `false` when a newer call superseded it. Reference: [Vue](docs/reference/vue.md)

### Svelte (Vite)

```sh
npm install svelte
npm install --save-dev @sveltejs/vite-plugin-svelte
npx nordbeam-locale init --framework svelte
```

As with Vue, the plugin must be declared before `init` writes `vite.config.ts`.
`init` also creates `src/i18n/svelte.ts`. Call `setI18nContext(i18n)` once in the
root component or layout, and read the context in children:

```svelte
<!-- src/Greeting.svelte -->
<script lang="ts">
  import { getI18nContext } from '@nordbeam/locale/svelte';
  const { messages, pending, setLocale } = getI18nContext();
</script>

<p>{$messages.greeting({ name: 'Ada' })}</p>
<button disabled={$pending} onclick={() => setLocale('de')}>Deutsch</button>
```

Reference: [Svelte](docs/reference/svelte.md)

### Solid (Vite)

```sh
npm install solid-js
npm install --save-dev vite-plugin-solid
npx nordbeam-locale init --framework solid
```

`init` writes `vite.config.ts` with `solid()` and `nordbeamLocale()` when
`vite-plugin-solid` is declared, and creates `src/i18n/solid.ts`. Wrap the app
once in `i18n.Provider`. Solid accessors are called, not read:

```tsx
// src/App.tsx
import { i18n } from './i18n/solid.js';

function Greeting() {
  const { messages, pending, setLocale } = i18n.useI18n();
  return <button disabled={pending()} onClick={() => setLocale('de')}>
    {messages().greeting({ name: 'Ada' })}
  </button>;
}

export function App() {
  return <i18n.Provider><Greeting /></i18n.Provider>;
}
```

Reference: [Solid](docs/reference/solid.md)

### Plain TypeScript or Node

```sh
npx nordbeam-locale init
```

Creates `nordbeam-locale.config.json`, `messages/en.json`, and the generated
modules in `src/i18n/`. There is no framework adapter. Load a locale and call its
messages:

```js
// app.mjs
import { loadLocale } from './src/i18n/index.js';

const { messages: m } = await loadLocale('en');
console.log(m.greeting({ name: 'Ada' })); // Hello Ada!
```

`loadLocale('de')` returns the German messages with the same typed API. Reference:
[index](docs/reference/index.md)

## Everyday workflow

1. Edit the catalogs in `messages/`, one JSON file per locale. Never edit files in `src/i18n/`.
2. `npx nordbeam-locale check` validates ICU syntax, message IDs, and argument
   contracts without writing output. Add `--strict` in CI to fail on missing
   translations.
3. `npx nordbeam-locale` generates the typed modules.
4. `npx nordbeam-locale verify` runs `check` and confirms that the generated
   output is fresh and unedited.

Every diagnostic has a code. Explain it with `npx nordbeam-locale explain <CODE>`;
the causes and fixes are in [errors](docs/reference/errors.md).

`init` adds `"prebuild": "nordbeam-locale"` to `package.json`, so generation runs
before each build. It does not use `prepare`, which runs on every `npm install`,
including production installs where the CLI is not present.

Set `NODE_ENV=production` in production build scripts. When `NODE_ENV` is unset,
the generated modules include development argument guards. The
[guide](docs/GUIDE.md#development-and-production-output) explains the rule.

## For coding agents

Install the agent skills so Claude Code, Codex, Cursor and other
[Agent Skills](https://agentskills.io) clients use the library correctly. Pick
one path ([details](skills/README.md)):

```sh
# Claude Code plugin marketplace
/plugin marketplace add nordbeam/locale
/plugin install nordbeam-locale@nordbeam

# any agent, via the skills CLI
npx skills add nordbeam/locale

# from the installed package, matched to its version
npx nordbeam-locale init --agent
```

The `nordbeam-locale` skill covers setup, catalogs, ICU syntax, the generated
API, and the check, generate, verify loop. The `nordbeam-locale-migrate` skill
covers moving from i18next, next-intl, FormatJS, Lingui, vue-i18n and others.

- `npx nordbeam-locale init --agent` adds a short Nordbeam Locale block to
  `AGENTS.md`, and to `CLAUDE.md` when that file exists, and installs the skills
  into `.claude/skills/` and `.agents/skills/`. `npx nordbeam-locale skills install`
  refreshes them without touching files you edited.
- `npx nordbeam-locale agent-guide` prints the protocol guide.
- `npx nordbeam-locale capabilities --json` lists every command and its contract.
- `npx nordbeam-locale verify --json` exits 0 only when `check` passes and the
  generated output is fresh and unedited.
- Machine output is compact by default. Lists show 50 rows; narrow with
  `--summary`, `--limit <n|all>`, or `--only CODE`.
- `npx nordbeam-locale mcp` serves the same tools to MCP clients over stdio. See
  [MCP](docs/reference/mcp.md).
- The full contract is in [agent](docs/reference/agent.md). The design rationale
  is in [agent-first tooling](docs/AGENT_TOOLING.md).

## Advanced

- [Guide](docs/GUIDE.md): scopes, selection and named imports, shared literals,
  artifacts, the persistent cache, PO export and import, migrations and codemods,
  pseudo-localization, and the development inspector.
- [Migration](docs/MIGRATION.md): moving from i18next, next-intl, FormatJS,
  Lingui, and other catalog formats.
- [Cookbook](docs/COOKBOOK.md): locale switchers, dates and currency, rich text,
  testing, and CI.
- [Editor support](docs/EDITOR.md): JSON schemas, the VS Code extension, and the
  in-context inspector.
- [Reference](docs/reference/README.md): every public entry point.
- [Documentation index](docs/README.md): every page, grouped by task.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for
the development setup and conventions, and [SECURITY.md](SECURITY.md) to report a
vulnerability privately.

## License

[Apache License 2.0](LICENSE). Copyright 2026 Nordbeam.
