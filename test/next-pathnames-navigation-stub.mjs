export { permanentRedirect, redirect } from 'next/navigation.js';
export function usePathname() { return globalThis.__w2Pathname ?? '/'; }
export function useRouter() { return globalThis.__w2Router; }
