# next-intl (and the Next.js request, routing and config steps)

`--format next-intl --framework next`. next-intl messages are already ICU, so catalogs are copied as is and the default catalog format applies (no `--catalog-format` needed). Nested objects keep dotted IDs: `Home.title` is `m.Home.title()`. `--from` is the directory of `en.json`, `fr.json`. The same Next-specific steps below apply to `next-i18next`, `react-i18next` and `next-international` projects migrated with `--framework next`.

```sh
npx nordbeam-locale migrate-project --from messages --format next-intl --framework next --source-dir src --json
```

## What the codemod rewrites (verified on a small App Router app)

- `useTranslations('Ns')` in a Client Component: rewritten to `const { messages: m } = i18n.useI18n()` with an import of the generated `src/i18n/client`.
- `await getTranslations('Ns')` in a server page: calls became `m.Home.title(...)`, but `m` was left unbound because the page was not "a conventional async component receiving params" (it appears in `integration.skipped` with kind `shape`).
- `t.rich('key', values)`: becomes `rich(m.Ns.key, values)` with the `@nordbeam/locale/react/rich` import; the tag callbacks keep working, since `rich()` passes them the children. `t.markup`, `t.raw` and `t.has` are reported (`MANUAL_REVIEW`).
- Translators that no hook binds, such as `const [t, navT] = await Promise.all([getTranslations('a'), getTranslations('b')])` or a `t` parameter, are reported as `UNBOUND_TRANSLATOR`.
- The conventional boundary files are rewritten in place and listed among the plan's changed files: the request file (`proxy.ts` or `middleware.ts`, beside `app/` or in `src/`) with `createMiddleware(routing)` becomes `createNextMiddleware(routing)`; `defineRouting` from `next-intl/routing` and `createNavigation` from `next-intl/navigation` switch to `@nordbeam/locale/next/routing` and `/next/navigation`; `createNextIntlPlugin('<path>')` in `next.config` becomes `withNordbeamLocale(...)`. No second request file is created.
- The nearest conventional `[locale]` layout is wrapped in the generated `NordbeamLocaleProvider`.
- Scaffolds written when missing: `src/i18n/next.ts`, `client.ts`, `provider.ts`, `routing.ts`, and a request file beside `app/` (`src/proxy.ts` for a `src/app` project, else `proxy.ts` at the root). An existing request file there suppresses the scaffold.

## Finish by hand

- Server components: bind `m` after validating the locale, as in the Next scaffold: `const { locale } = await params; if (!i18n.hasLocale(locale)) notFound(); const { messages: m } = await i18n.loadLocale(locale);` with `import { i18n } from '<relative path>/i18n/next'`. For statically generated pages also export `dynamicParams = false` and `generateStaticParams() { return i18n.generateStaticParams(); }`.
- Request file: read `manualActions`. On Next 16 a rewritten `middleware.ts` still loads (deprecated), and the plan asks you to rename it to `proxy.ts` (or run `npx @next/codemod@canary middleware-to-proxy .`); never keep both, because Next 16.3 stops the build with "Both middleware file and proxy file are detected". Next ignores a request file that is not beside `app/`. A request file whose factory is not a plain `createMiddleware(routing)` (inline options, composition) is reported in `integration.skipped` with kind `shape`: rewrite it to `createNextMiddleware(routing)` from `@nordbeam/locale/next/middleware` with the scaffolded `config.matcher`.
- Routing: a conventional `routing.ts` (`import { defineRouting } from 'next-intl/routing'`) is converted in place, and `locales`, `defaultLocale`, `localePrefix`, `pathnames` and `domains` keep their shapes. A routing module that imports anything else from `next-intl/routing` (such as the `Routing` type) is reported; change it by hand.
- Config: `createNextIntlPlugin('./path')` with only a path argument becomes `withNordbeamLocale`, and the plan lists the now-unused `getRequestConfig` module (`src/i18n/request.ts`) under `manualActions`: delete it, and `NextIntlClientProvider`, once nothing imports them. Plugin options (such as `experimental.createMessagesDeclaration`) are not converted: the file is reported and kept, so replace the wrapper with `withNordbeamLocale()` yourself.
- Navigation: a module with `import { createNavigation } from 'next-intl/navigation'` is converted in place to `@nordbeam/locale/next/navigation` (same exports: `Link`, `useRouter`, `usePathname`, `redirect`, `getPathname`); `createSharedPathnamesNavigation` and similar legacy helpers are reported, so use `createNextNavigation(routing)` there. `usePathname()` returns the concrete internal path, not the template.
- Rich text: the codemod imports `rich` from `@nordbeam/locale/react/rich`, which works in Server and Client Components. Check that each tag callback's message has the same tags in every locale.
- Named formats: move next-intl `formats` to the `formats` key of `nordbeam-locale.config.json`; `useFormatter` calls have no direct equivalent (put formatting in the message, or use `Intl`).
- Never pass the messages object from a Server Component to a Client Component; pass the locale string.

Verify with [finishing.md](finishing.md); the Next reference in the nordbeam-locale skill covers the target API in detail.
