# Testing helpers — `@nordbeam/locale/testing`

Bind test helpers to the generated message contract.

```ts
import { createMessageTestHelpers } from '@nordbeam/locale/testing';
```

`createMessageTestHelpers<Messages>()` returns selector-to-key helpers and a
locale matrix runner. `MessageKey` and `MessageSelectorTree<Messages>` are the
supporting types. See the [testing recipe](../COOKBOOK.md#testing).
