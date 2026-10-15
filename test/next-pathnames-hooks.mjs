// Resolve hook for next-pathnames-navigation.test.mjs: the App Router hooks
// need a rendering context, so the navigation modules get a stub that reads
// globalThis. redirect and permanentRedirect stay real. The navigation modules
// read the host with React's useSyncExternalStore, which also needs a renderer.
const stub = new URL('./next-pathnames-navigation-stub.mjs', import.meta.url).href;
const reactStub = new URL('./next-pathnames-react-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const navigation = /\/dist\/next-navigation(-client)?\.js$/.test(context.parentURL ?? '');
  if (specifier === 'next/navigation.js' && navigation) {
    return { url: stub, shortCircuit: true };
  }
  if (specifier === 'react' && navigation) {
    return { url: reactStub, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
