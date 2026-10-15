# Next runtime — `@nordbeam/locale/next/runtime`

The dependency-free runtime helper validates locale route parameters and creates
static params for App Router pages.

```ts
import { createNextI18n } from '@nordbeam/locale/next/runtime';
```

`createNextI18n({ locales, loadLocale })` returns `hasLocale`, `loadLocale`, and
`generateStaticParams` helpers. It is safe for Node, Edge, and client graphs.
