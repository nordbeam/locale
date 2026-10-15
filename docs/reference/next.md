# Next.js configuration — `@nordbeam/locale/next`

The build-only wrapper ensures generated modules exist before Next compilation.

```js
import { withNordbeamLocale } from '@nordbeam/locale/next';
export default withNordbeamLocale({ reactStrictMode: true });
```

- `withNordbeamLocale(nextConfig, options?)` — wraps static or async Next config.
  `withNordbeamI18n` is a deprecated alias of the same function.
- `NextConfig`, `NextConfigFactory`, `NextConfigInput`, `NextOptions`, and
  `NextConfigContext` — configuration types.
- `GenerateOptions` — re-exported generation options.

The wrapper starts the generator watcher during `next dev`;
see the [Next guide](../NEXTJS.md).
