# Nordbeam Locale for VS Code

The first-party extension reads `nordbeam-locale.config.json` (and recognizes the bounded legacy config aliases) and the configured JSON catalogs. It provides inline base-locale text, all-locale hovers, message-ID completion, extraction, source-safe rename assistance, missing-locale repair, a missing-translations report, and generated-type verification.

## Message calls

The extension finds message calls with a small tokenizer, not a regex. Strings, template text, comments and regex literals are skipped, and template interpolations are read. A call is recognized when its receiver is:

- a binding from `const { messages: t } = await loadLocale(...)`, `await loadCheckout(...)`, `await i18n.loadLocale(...)` or `i18n.useI18n(...)`;
- a binding from `const t = i18n.useMessages(...)` or `useMessages(...)`;
- or one of the identifiers in `nordbeam.messageIdentifiers` (default `m` and `messages`).

Calls in dot form (`t.checkout.pay()`), bracket form (`t['checkout.pay']()`) and mixed form (`t['checkout']['pay']()`) are all read. Other libraries' `t()`, `translate()` and `formatMessage()` are not treated as message calls.

Fallback identifiers are matched without type information. Array, String, Map and Set method names (for example `messages.map()`) are not reported for fallback identifiers, but a detected binding is always treated as a message object.

## Completion and missing translations

Typing `t.` or `t['` completes message IDs from the base-locale catalog. Dot completion offers the next segment and descends into namespaces; bracket completion offers the rest of the ID.

`Nordbeam: Show missing translations` writes, per non-base locale, the base IDs that the locale lacks to the “Nordbeam Locale” output channel. Each base catalog key that is missing in some locale also gets an Information diagnostic listing those locales.

## Settings

- `nordbeam.messageIdentifiers`: identifiers treated as message objects when a file has no detected binding. Must be valid JavaScript identifiers. Default `["m", "messages"]`.
- `nordbeam.inlineTranslations`: show the base-locale text beside typed message calls. Default `true`.
- `nordbeam.verifyOnSave`: run `nordbeam-locale check` after catalog saves. Default `true`.

## Development

Build and test from the repository root with `npm run vscode:check`. Use **Run Extension** from this directory for an Extension Development Host.

Rename delegates to the installed Nordbeam CLI so catalog and recognized source changes use its transactional write path. Verification runs `npx nordbeam-locale check` locally.

## License

[Apache License 2.0](LICENSE). Copyright 2026 Nordbeam.
