# Testing helpers — `nordbeam-locale/testing`

Bind test helpers to the generated message contract, and build the messages
objects that component tests render with.

```ts
import { compileMessages, createMessageTestHelpers, messageIds, withMessages } from 'nordbeam-locale/testing';
```

`createMessageTestHelpers<Messages>()` returns selector-to-key helpers and a
locale matrix runner. `MessageKey` and `MessageSelectorTree<Messages>` are the
supporting types. See the [testing recipe](../COOKBOOK.md#testing).

## Messages for component tests

A generated locale module is a complete messages object that renders the real
text, and it can be imported statically so a test renders synchronously:

```ts
import en from '../src/i18n/locales/en.js';
// <i18n.Provider initial={{ locale: 'en', messages: en }}>…
```

The helpers below build other messages objects from it. Each result has the
same IDs, the same nested view (`m.checkout.title`) and the same type, so it can
go anywhere the generated object goes, such as a provider's `initial`.

- `messageIds(messages, options?)` renders every message as its ID, for tests
  that assert IDs rather than text. A call with slot functions, as `rich()`
  makes, returns `[id]`. `options.format(id, args)` renders something else, such
  as the ID with its arguments.
- `withMessages(messages, overrides)` returns a copy with some messages
  replaced, by message ID. A replacement is literal text, or a function that
  takes the message's arguments and returns what the message returns. Flat
  (`m['checkout.title']`) and nested (`m.checkout.title`) access both return
  it. An ID the object does not have throws a `RangeError`, and text with ICU
  syntax (`{` or `}`) throws a `TypeError` that points to `compileMessages`.
  Overrides compose: `withMessages(withMessages(en, a), b)`.
- `compileMessages(texts, options?)` compiles ICU messages in memory with the
  project's compiler and resolves to message functions that render exactly as
  generated output does. Pass the result to `withMessages`. Options: `locale`
  (plural rules and formatting, default `en`), `formats` and `timeZone` as in
  the configuration, and `development` (argument checks that throw, default
  `true`). It loads the compiler on first use and evaluates the compiled module
  with `new Function`, which Node test runners allow and a page with a strict
  Content-Security-Policy does not.

```ts
const ids = messageIds(en);
ids.checkout.title(); // "checkout.title"

const m = withMessages(en, {
  'checkout.title': 'Pay now',
  greeting: ({ name }) => `Hi ${name}`,
  ...await compileMessages({ 'cart.total': 'Total: {amount, number}' }),
});
```

None of these change the object passed in or its functions. The module has no
Node built-ins; `compileMessages` imports the compiler only when it is called.

`MessageIdOf<Messages>` is the union of message IDs of a messages type (its
messages, not its namespaces). `MessageOverrides<Messages>`, `MessageIdOptions`
and `CompileMessagesOptions` type the arguments above.

### Why `{ ...messages }` is not an override

Generated messages objects hold every message under its full ID, and these are
the only enumerable top-level properties: `Object.keys(messages)` lists each
message once. The nested view's top-level namespaces (`messages.checkout`) are
not enumerable, and their properties point at the same functions. A spread or
`Object.assign` therefore copies the flat IDs only, and replacing
`copy['checkout.title']` would not change `copy.checkout.title`. `withMessages`
rebuilds both views.
