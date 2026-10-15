# vue-i18n and Nuxt i18n

`--format vue-i18n` (or `nuxt-i18n`) with `--framework vue`. Nordbeam has a Vue 3 adapter (`@nordbeam/locale/vue`), so the legacy plugin is replaced by it. Nuxt is not a scaffold target: the codemod still rewrites static calls, but wire the Vue adapter into the Nuxt app by hand (`VUE_NUXT_PLUGIN`). Install `@vitejs/plugin-vue` before `--write` when the Vite config is created by the tool.

```sh
npx nordbeam-locale migrate-project --from src/locales --format vue-i18n --framework vue --source-dir src --json
```

## The catalog is converted, not copied

`vue-i18n` (and `nuxt-i18n`) use the `vue-i18n` catalog converter, so vue-i18n syntax is translated to ICU, and anything it cannot translate faithfully is skipped and reported instead of being copied as wrong text. Each locale is converted on its own, so check that every locale reports the same skips.

| vue-i18n | Becomes | Diagnostic |
| --- | --- | --- |
| `car \| cars` (2 forms) | `{count, plural, =1 {car} other {cars}}` (vue-i18n's default rule: 1 is the first form, 0 and the rest the second) | `VUE_I18N_PIPE_PLURAL` |
| `no apples \| one apple \| {count} apples` (3 forms) | `{count, plural, =0 {...} =1 {...} other {...}}` | `VUE_I18N_PIPE_PLURAL` |
| `{n}` used as the count | the plural is on `{n}` instead | `VUE_I18N_PIPE_PLURAL` |
| `@:key`, `@:(key)`, `@:{'key'}` | the referenced message text, inlined | `VUE_I18N_LINK_INLINED` |
| `@.upper:key`, `@.lower:key`, `@.capitalize:key` on fixed text | the modified text, computed at migration time | `VUE_I18N_LINK_INLINED` |
| `{0}`, `{1}` | `{arg0}`, `{arg1}` | `VUE_I18N_LIST_INTERPOLATION` |
| `{'@'}`, `\\|`, `\\{` escapes | literal text | none |

Call-site implications: the plural message needs the number as an argument named `count` (or `n`): `m.apples({ count: 3 })` replaces `t('apples', 3)`. List messages take an object: `m.hi({ arg0: 'Ada' })` replaces `t('hi', ['Ada'])`; rename the arguments in the catalog and the calls if you want clearer names.

Skipped with `VUE_I18N_UNSUPPORTED_SYNTAX` (the message is absent from the output, so `m.<id>` does not exist until you add it by hand): custom link modifiers, modifiers on a message that has arguments, links to missing keys, to plurals, to messages that themselves contain links (nested or cyclic), computed link keys such as `@:{name}`, messages with more than three pipe forms (these need a custom `pluralRules`, which cannot be read from a catalog), and the legacy `%{name}` syntax. Write the ICU text yourself, then run `check`. Inlined links are copies: a later edit to the target does not update them.

## What the codemod rewrites and what it reports

Rewritten: static calls with an aliased `t` from `useI18n()` (verified in `<script setup>`). Reported and left alone, with warnings: `$t`, `$tc`, `$d`, `$n` template helpers (`VUE_TEMPLATE_API`, `VUE_GLOBAL_TRANSLATOR`), translations in attribute bindings (`VUE_ATTRIBUTE_TRANSLATION`), `<i18n-t>` components (`VUE_I18N_COMPONENT`), calls that pass options or a plural number (`UNSUPPORTED_OPTIONS`), and the `createI18n`/`app.use` bootstrap (`VUE_I18N_PLUGIN`: replace it with `createVueI18n` from `@nordbeam/locale/vue`).

## Bind `m` correctly in Vue

The codemod writes calls as `m.key(...)`. In Vue `messages` is a ref, and the codemod does not always create the binding (in a verified run it left `m` unbound in a `<script setup>` block, next to the untouched `useI18n` import). Fix each rewritten site:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import { i18n } from '../i18n/vue.js';
const { messages: m } = i18n.useI18n();          // a ref: use m.value in script, m in templates
const label = computed(() => m.value.hello({ name: 'Ada' }));   // reactive to locale changes
</script>
<template><p>{{ label }}</p><p>{{ m.apples({ count: 3 }) }}</p></template>
```

Replace `useI18n()` from vue-i18n with the instance from the generated `src/i18n/vue.ts`, `app.use(i18n)` in the entry, and `locale.value = 'fr'` with `i18n.useI18n().setLocale('fr')`. Details: the `vue.md` reference in the nordbeam-locale skill. Finish with [finishing.md](finishing.md).
