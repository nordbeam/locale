# Rich React messages — `@nordbeam/locale/react/rich`

The `rich` function renders a compiled rich message with typed React slots.

```tsx
import { rich } from '@nordbeam/locale/react/rich';

rich(message, { strong: children => <strong>{children}</strong> });
```

Use this server-safe entry from Server Components. Slot callbacks return React
elements; see the [rich text recipe](../COOKBOOK.md#rich-text).
