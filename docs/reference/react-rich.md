# Rich React messages — `@nordbeam/locale/react/rich`

The `rich` function renders a compiled rich message with typed React slots.

```tsx
import { rich } from '@nordbeam/locale/react/rich';

rich(message, { strong: children => <strong>{children}</strong> });
```

Use this server-safe entry from Server Components. Slot callbacks return React
elements; see the [rich text recipe](../COOKBOOK.md#rich-text).

A plain `{name}` argument (typed `string | number`) also accepts a React
element, which `rich` places where the argument is. This works in messages
without tags too, so `rich(m.promo, { code: <strong>{code}</strong> })` renders
`"Use {code} at checkout"` with the element inside. Number, date and `select`
arguments do not accept elements. A message with neither tags nor plain
arguments is not accepted: call it directly.
