import { createRequire } from 'node:module';
import type { NextOptions } from 'nordbeam-locale/next';

export type { GenerateOptions, NextOptions } from 'nordbeam-locale/next';

export type NextConfig = object;
export type NextConfigContext = Record<string, unknown>;
export type NextConfigFactory = (
  phase: string,
  context: NextConfigContext,
) => NextConfig | Promise<NextConfig>;
export type NextConfigInput = NextConfig | NextConfigFactory;

// next start loads next.config too, but it serves what next build compiled, so
// it has nothing to generate. Skipping there keeps nordbeam-locale, the build
// tooling, out of the production install.
const productionServer = 'phase-production-server';

const missingTools = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === 'ERR_MODULE_NOT_FOUND' && /['"]nordbeam-locale['"]/.test(String((error as Error).message));

/** Generate Nordbeam Locale's ordinary ESM before Next.js starts compiling, and
 * keep it in sync with catalog edits during next dev. Generation runs in
 * nordbeam-locale, which next dev and next build need installed (a
 * devDependency); next start does not. */
export function withNordbeamLocale(
  nextConfig: NextConfigInput = {},
  options: NextOptions = {},
): NextConfigFactory {
  return async (phase, context) => {
    if (phase === productionServer) return typeof nextConfig === 'function' ? nextConfig(phase, context) : nextConfig;
    let tools: typeof import('nordbeam-locale/next');
    try {
      tools = await import('nordbeam-locale/next');
    } catch (error) {
      if (!missingTools(error)) throw error;
      const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
      throw new Error(`Nordbeam Locale: generating messages for Next.js needs nordbeam-locale, which is not installed. Install it: npm install --save-dev nordbeam-locale@${version}`, { cause: error });
    }
    return tools.withNordbeamLocale(nextConfig, options)(phase, context);
  };
}

/** @deprecated Use withNordbeamLocale. */
export const withNordbeamI18n = withNordbeamLocale;
