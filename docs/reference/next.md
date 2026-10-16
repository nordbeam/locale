# Next.js configuration — `@nordbeam/locale/next`

The wrapper ensures generated modules exist before Next compilation. It is in
the runtime package because `next start` loads `next.config` too; generation
itself runs in `nordbeam-locale`, which `next dev` and `next build` load from the
project's devDependencies. `next start` serves what the build compiled and
returns the configuration without loading it, so a production install without
devDependencies works.

```js
import { withNordbeamLocale } from '@nordbeam/locale/next';
export default withNordbeamLocale({ reactStrictMode: true });
```

- `withNordbeamLocale(nextConfig, options?)` — wraps static or async Next config.
  `withNordbeamI18n` is a deprecated alias of the same function.
- `NextConfig`, `NextConfigFactory`, `NextConfigInput`, `NextOptions`, and
  `NextConfigContext` — configuration types.
- `GenerateOptions` — re-exported generation options. These types come from
  `nordbeam-locale/next`, where the generating wrapper lives with the same
  signature.

Without `nordbeam-locale` installed, `next dev` and `next build` fail with an
error that names the install command.

The wrapper starts the generator watcher during `next dev`;
see the [Next guide](../NEXTJS.md).
