// Resolve hook for next-middleware-server.test.mjs: next/headers.js only works inside a
// Next request scope, so dist/next-server.js gets a stub that reads globalThis.
const stub = 'export async function headers() { return globalThis.__nordbeamRequestHeaders; }';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/headers.js' && context.parentURL?.endsWith('/dist/next-server.js')) {
    return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
