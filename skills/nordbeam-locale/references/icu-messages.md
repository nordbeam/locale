# ICU message syntax for Nordbeam Locale catalogs

Catalog values are ICU MessageFormat strings in strict JSON files. Each value compiles to a typed function; a syntax or contract error fails `check` with the JSON path, line, column and a code frame, so write, run `npx nordbeam-locale check --json`, and fix what it reports. Outputs below were produced by the real generator in `en` with the default runtime `Intl` data.

Contents: [Arguments](#arguments) · [Plural](#plural) · [Select](#select-and-nesting) · [Numbers](#numbers) · [Dates and times](#dates-and-times) · [Rich text](#rich-text) · [Escaping](#escaping) · [Translations](#translations-must-match) · [IDs and layout](#ids-and-layout)

## Arguments

```json
{ "greeting": "Hello {name}!" }
```

`m.greeting({ name: 'Ada' })` accepts `string | number`. A missing argument is a type error, and in development output a runtime `TypeError`: `en:greeting: argument "name" must be string or number`. Argument names are identifiers; use the same names in every locale.

## Plural

```json
{ "items": "{count, plural, =0 {Your basket is empty} one {# item} other {# items}}" }
```

`m.items({ count })` takes a `number`. Output: `0` gives `Your basket is empty`, `1` gives `1 item`, `1234` gives `1,234 items`.

- `other` is required. Exact matches (`=0`, `=1`) win over category keywords.
- Valid categories are `zero`, `one`, `two`, `few`, `many`, `other`. Each locale uses a subset: English `one`/`other`; French `one`/`many`/`other`; Polish `one`/`few`/`many`/`other`; Arabic all six. Use `Intl.PluralRules(locale).resolvedOptions().pluralCategories` to list a locale's categories. A translation that lacks a category its language needs gets `MISSING_PLURAL_CATEGORY` and falls back to `other` for those counts.
- Inside a branch `#` is the count formatted for the locale (`1,234` in English, `1.234` in German). `{count}` in the same branch prints the raw number (`1234`). Use `#` for counts.
- `offset:1` subtracts before choosing a category and before printing `#`:

```json
{ "who": "{n, plural, offset:1 =0 {Nobody} =1 {Just {first}} one {{first} and # other} other {{first} and # others}}" }
```

`n: 0, 1, 2, 4` with `first: 'Ann'` gives `Nobody`, `Just Ann`, `Ann and 1 other`, `Ann and 3 others`.

- Ordinals use `selectordinal` with the same shape: `{place, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}` gives `1st`, `2nd`, `3rd`, `4th`, `11th`, `22nd`.

## Select and nesting

```json
{
  "role": "{role, select, admin {Administrator} editor {Editor} other {Member}}",
  "cats": "{gender, select, female {{count, plural, one {She has # cat} other {She has # cats}}} other {{count, plural, one {They have # cat} other {They have # cats}}}}"
}
```

`m.role({ role })` is typed `"admin" | "editor" | (string & {})`: known branches autocomplete, any string is accepted and falls to `other`. `other` is required. Nest plural inside select (and the reverse) to cover gender plus count; each nested level still needs its own `other`. Branch sets may differ across locales only for branches the base message also defines or for `other`; extra or missing select branches are reported (`UNKNOWN_SELECT_BRANCH`, `MISSING_SELECT_BRANCH`).

## Numbers

```json
{
  "pct": "Done: {ratio, number, percent}",
  "rows": "Rows: {n, number, integer}",
  "total": "Total: {amount, number, ::currency/EUR}",
  "views": "Views: {n, number, ::compact-short}"
}
```

Arguments are `number`. Outputs: `0.256` gives `Done: 26%`; `1234.7` gives `Rows: 1,235`; `5` gives `Total: €5.00`; `12345` gives `Views: 12K`. `::` introduces an ICU number skeleton (`::currency/USD`, `::percent`, `::compact-short`; `{n, number, ::unit/kilometer}` gives `5 km`, and adding `unit-width-full-name` gives `5 kilometers`); a style or skeleton that `Intl` rejects is `INVALID_FORMAT`. Custom named styles can be declared under `formats` in the config (an undeclared style is `UNKNOWN_FORMAT`).

## Dates and times

```json
{
  "when": "{d, date, short} / {d, date, long} / {d, time, medium}",
  "day": "{d, date, ::yyyyMMMd}",
  "updated": "Updated {at, time, short} on {at, date, medium}"
}
```

Arguments are `Date | number` (epoch milliseconds). For `2026-09-10T12:00:00Z` in a UTC-offset-less environment: `short` date `9/10/26`, `long` `September 10, 2026`, `medium` time `1:00:00 PM` (the zone follows the runtime), `::yyyyMMMd` gives `Sep 10, 2026`. Styles are `short`, `medium`, `long`, `full`, or a `::` skeleton. Output depends on the runtime time zone; set `"timeZone": "UTC"` (or the product's zone) in `nordbeam-locale.config.json` when server and browser must agree, and use fixed dates in tests.

## Rich text

```json
{ "terms": "Read our <link>terms</link> and <b>privacy policy</b>.", "nest": "Click <a>here</a> or <b>read <i>more</i></b>" }
```

XML-like tags become required callback arguments: `m.terms({ link: children => ..., b: children => ... })`. Tags may nest. The message returns an array of strings and callback results; the generic node type is whatever your callbacks return. In React use `rich(m.terms, { link: children => <a href="/terms">{children}</a>, b: children => <strong>{children}</strong> })` from `@nordbeam/locale/react/rich` (keys are added for you). Rules:

- Every translation must keep the same tags as the base message. A dropped tag is `DROPPED_RICH_TAG` (text renders without markup); a new tag is `UNEXPECTED_SLOT`.
- A name must be a value in every message or a slot in every message that uses it (`SLOT_MISMATCH`, `ARGUMENT_KIND_MISMATCH`, `ARGUMENT_TYPE_CONFLICT`).
- Put whole phrases inside tags so translators can reorder them. Avoid splitting one sentence into several keys around a link.
- Tags cannot be numbered (`<0>`); use names that describe the slot (`<link>`, `<b>`).

## Escaping

| Want | Write | Result |
| --- | --- | --- |
| literal `{` and `}` | `'{'braces'}'` | `{braces}` |
| literal `<` | `1 '<' 2` | `1 < 2` |
| literal `'` | `don''t` | `don't` |
| literal `#` in plain text | `Tag: # stays` | `Tag: # stays` |

An apostrophe starts a quote only before `{`, `}`, `<` or (inside a plural) `#`; a lone `'` elsewhere is literal (`don't stop` prints as written), but write `''` when in doubt. Do not wrap `#` in quotes outside a plural: `'#'` prints with the quotes. In JSON, `\"` escapes a double quote and `\n` a newline; keep each message on one JSON string.

## Translations must match

For every message the other locales must use the same argument names, argument kinds (value or rich slot), rich tags, and the plural/select branches the base defines. Differences are diagnostics: `UNKNOWN_ARGUMENT`, `MISSING_ARGUMENT`, `MISSING_PLURAL_BRANCH`, `UNKNOWN_PLURAL_BRANCH`, `MISSING_SELECT_BRANCH`, `UNKNOWN_SELECT_BRANCH`, `DROPPED_RICH_TAG`. A locale may omit a key (served from the base locale as `FALLBACK_MESSAGE`, an error as `MISSING_MESSAGE` under `check --strict`). Translations may reorder arguments and change number/date styles freely.

## IDs and layout

Keys are non-empty dotted IDs (`checkout.pay`); nested JSON objects produce the same IDs. A key cannot be both a message and a namespace (`CATALOG_LAYOUT_CONFLICT`). The ID `then` is rejected (`THENABLE_KEY`) because it would make the module look like a Promise. Keep IDs stable and semantic (`cart.empty`), not the English text. `extract`, `rename`, `prune` and `inspect --id <id> --json` manage and describe IDs; `rename` updates all catalogs and recognisable source references.
