# svelte-i18n

`--format svelte-i18n --framework svelte`. svelte-i18n messages are ICU (it uses `intl-messageformat`), so catalogs are copied as ICU JSON with the default catalog format. Nordbeam has a Svelte adapter (`@nordbeam/locale/svelte`); install `@sveltejs/vite-plugin-svelte` before `--write` if the tool should create the Vite config.

```sh
npx nordbeam-locale migrate-project --from src/lib/locales --format svelte-i18n --framework svelte --source-dir src --json
```

## What the codemod rewrites

The `$_` and `$t` stores in modules that import `svelte-i18n`, in `<script>` blocks and in markup, when the key is static. Reported and left alone: initialisation, dictionary registration and locale switching (`SVELTE_I18N_SETUP`), SvelteKit hooks and `+layout` locale handling (`SVELTEKIT_HOOK`), dynamic keys, and options it cannot translate.

If the project has a wrapper that re-exports a formatter type, move it with the explicit options (it never guesses compatibility): `--messages-import '$lib/i18n/nordbeam' --move-type-import MessageFormatter` on `codemod`. The `--messages-import` module must export the binding named by `--messages-object` (default `m`); the generated `src/i18n/index.js` does not.

## After the tool

- Replace `register(...)`, `init(...)` and `waitLocale` with the adapter: create the instance in the scaffolded `src/i18n/svelte.ts` (client app) or per request in `+layout.ts` (SvelteKit), call `setI18nContext(i18n)` in the root layout, and read messages with `getI18nContext()` in children. The `svelte.md` reference in the nordbeam-locale skill has the SvelteKit load pattern.
- Rewritten calls look like `m.key(...)`; in components the binding is the `messages` store, so read it as `$messages.key(...)` or bind `const { messages: m } = getI18nContext()` and use `$m.key(...)`. Check each file: the tool does not always create the binding.
- `$locale.set('fr')` becomes `setLocale('fr')` from the context. `$json(...)`, `$time`, `$date`, `$number` formatters are not messages: express them in ICU or use `Intl`.
- Finish with [finishing.md](finishing.md).
