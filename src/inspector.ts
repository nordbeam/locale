/**
 * Explicitly opt-in development inspection for generated message functions.
 * Nothing in the compiler or generated locale modules imports this module.
 * Applications should import it from `@nordbeam/locale/inspector` only from a
 * development entrypoint (or behind a dynamic import).
 */

export interface MessageInspection {
  readonly sequence: number;
  readonly key: string;
  readonly locale: string;
  readonly arguments?: unknown;
  readonly result?: unknown;
  readonly error?: string;
  readonly durationMs: number;
  readonly at: number;
}

export interface MessageInspector {
  /** Wrap generated messages. The proxy preserves nested `m.product.price` access. */
  wrap<Messages>(messages: Messages, locale?: string): Messages;
  setLocale(locale: string): void;
  getLocale(): string;
  records(): readonly MessageInspection[];
  subscribe(listener: () => void): () => void;
  clear(): void;
}

export interface MessageInspectorOptions {
  locale?: string;
  /** Bound retained calls to keep a long-running dev session predictable. */
  maxEntries?: number;
}

const now = (): number => typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now();

function argumentSnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  // A shallow copy prevents later mutation of the call object from changing
  // the inspector's displayed context. Nested values (including React nodes)
  // remain application-owned and are deliberately not serialized.
  return Object.freeze({ ...(value as Record<string, unknown>) });
}

function canonicalKey(prefix: string, property: string): string {
  return prefix ? `${prefix}.${property}` : property;
}

/** Create a bounded call recorder for generated message functions. */
export function createMessageInspector(options: MessageInspectorOptions = {}): MessageInspector {
  const maxEntries = options.maxEntries ?? 500;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer.');
  let locale = options.locale ?? 'en';
  let sequence = 0;
  let entries: MessageInspection[] = [];
  const listeners = new Set<() => void>();
  const objectProxies = new WeakMap<object, Map<string, object>>();
  const functionProxies = new WeakMap<Function, Map<string, Function>>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* An overlay must never break the app. */ }
    }
  };
  const push = (entry: Omit<MessageInspection, 'sequence' | 'at'>): void => {
    const next = Object.freeze({ ...entry, sequence: ++sequence, at: Date.now() });
    if (entries.length >= maxEntries) entries = entries.slice(entries.length - maxEntries + 1);
    entries.push(next);
    notify();
  };
  const wrapFunction = <F extends Function>(fn: F, key: string, callLocale: string): F => {
    const existing = functionProxies.get(fn)?.get(callLocale);
    if (existing) return existing as F;
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const started = now();
      try {
        const receiver: unknown = this;
        const result = Reflect.apply(fn, receiver, args);
        push({ key, locale: callLocale, ...(args.length ? { arguments: argumentSnapshot(args[0]) } : {}), result, durationMs: Math.max(0, now() - started) });
        return result;
      } catch (error) {
        push({ key, locale: callLocale, ...(args.length ? { arguments: argumentSnapshot(args[0]) } : {}), error: error instanceof Error ? error.message : String(error), durationMs: Math.max(0, now() - started) });
        throw error;
      }
    };
    // Preserve the two reflective properties most tooling uses. This is best
    // effort because generated functions may have unusual descriptors.
    try { Object.defineProperty(wrapped, 'name', { value: fn.name, configurable: true }); } catch { /* ignored */ }
    try { Object.defineProperty(wrapped, 'length', { value: fn.length, configurable: true }); } catch { /* ignored */ }
    let byLocale = functionProxies.get(fn);
    if (!byLocale) functionProxies.set(fn, byLocale = new Map());
    byLocale.set(callLocale, wrapped);
    return (wrapped as unknown) as F;
  };
  const wrapObject = <T extends object>(object: T, prefix: string, callLocale: string): T => {
    const cacheKey = `${prefix}\u0000${callLocale}`;
    const existing = objectProxies.get(object)?.get(cacheKey);
    if (existing) return existing as T;
    // Generated nested properties are intentionally non-configurable. Proxying
    // the original object would violate JavaScript's proxy invariants when a
    // nested object is read, so make a shallow descriptor-preserving facade.
    const target = Object.create(Object.getPrototypeOf(object)) as T;
    for (const property of Reflect.ownKeys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, property)!;
      descriptor.configurable = true;
      if ('writable' in descriptor) descriptor.writable = true;
      Object.defineProperty(target, property, descriptor);
    }
    const proxy = new Proxy(target, {
      get(target, property, receiver) {
        if (typeof property !== 'string' || !Object.hasOwn(target, property)) return Reflect.get(target, property, receiver);
        const value = Reflect.get(target, property, receiver);
        const key = canonicalKey(prefix, property);
        if (typeof value === 'function') return wrapFunction(value, key, callLocale);
        if (value && typeof value === 'object') return wrapObject(value, key, callLocale);
        return value;
      },
    });
    let byLocale = objectProxies.get(object);
    if (!byLocale) objectProxies.set(object, byLocale = new Map());
    byLocale.set(cacheKey, proxy);
    return proxy;
  };

  return {
    wrap<Messages>(messages: Messages, messageLocale = locale): Messages {
      if (!messages || typeof messages !== 'object') throw new TypeError('Message inspector expects a generated messages object.');
      return wrapObject(messages as object, '', messageLocale) as Messages;
    },
    setLocale(next: string): void { if (!next) throw new TypeError('Inspector locale must be a nonempty string.'); locale = next; },
    getLocale: () => locale,
    records: () => entries,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    clear() { if (entries.length) { entries = []; notify(); } },
  };
}

export interface InspectorOverlayOptions {
  /** Supply a document for tests or an iframe; defaults to the active browser document. */
  document?: { createElement(name: string): any; body?: { appendChild(node: any): unknown } };
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

export interface InspectorOverlayHandle {
  readonly element: unknown;
  dispose(): void;
}

function display(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return '—';
  try { return JSON.stringify(value); } catch { return Object.prototype.toString.call(value); }
}

/** Mount a tiny DOM overlay. Import this function only from a dev browser path. */
export function mountInspectorOverlay(inspector: MessageInspector, options: InspectorOverlayOptions = {}): InspectorOverlayHandle {
  const document = options.document ?? (globalThis as { document?: InspectorOverlayOptions['document'] }).document;
  if (!document?.createElement || !document.body?.appendChild) throw new Error('The Nordbeam inspector overlay requires a browser document.');
  const root = document.createElement('aside');
  const position = options.position ?? 'bottom-right';
  const [vertical, horizontal] = position.split('-');
  root.setAttribute?.('data-nordbeam-locale-inspector', '');
  root.style.cssText = `position:fixed;z-index:2147483647;${vertical}:${vertical === 'top' || vertical === 'bottom' ? '12px' : 'auto'};${horizontal}:12px;width:360px;max-height:48vh;overflow:auto;background:#111827;color:#f9fafb;border:1px solid #374151;border-radius:8px;box-shadow:0 8px 32px #0008;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace`;
  const render = (): void => {
    const records = inspector.records();
    root.textContent = '';
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #374151;position:sticky;top:0;background:#111827';
    const title = document.createElement('strong'); title.textContent = `Locale inspector (${records.length})`; header.appendChild(title);
    const clear = document.createElement('button'); clear.textContent = 'Clear'; clear.type = 'button'; clear.onclick = () => inspector.clear(); header.appendChild(clear);
    root.appendChild(header);
    for (const record of [...records].reverse()) {
      const item = document.createElement('div'); item.style.cssText = 'padding:6px 8px;border-bottom:1px solid #1f2937';
      const line = document.createElement('div'); line.textContent = `${record.locale} · ${record.key} · ${record.durationMs.toFixed(1)}ms`; item.appendChild(line);
      const detail = document.createElement('div'); detail.style.opacity = '0.75'; detail.textContent = record.error ? `error: ${record.error}` : `args: ${display(record.arguments)} → ${display(record.result)}`; item.appendChild(detail);
      root.appendChild(item);
    }
  };
  const unsubscribe = inspector.subscribe(render);
  document.body.appendChild(root);
  render();
  return { element: root, dispose() { unsubscribe(); root.remove?.(); } };
}
