/**
 * Explicitly opt-in development inspection for generated message functions.
 * Nothing in the compiler or generated locale modules imports this module.
 * Applications should import it from `@nordbeam/locale/inspector` only from a
 * development entrypoint (or behind a dynamic import).
 */
import { noise } from './text-noise.js';

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
  /** Clear the recorded calls. The texts messages rendered stay, for scanRenderedText. */
  clear(): void;
  /** Every distinct text a wrapped message returned, whitespace collapsed; the newest 10,000. */
  renderedTexts(): ReadonlySet<string>;
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
  const rendered = new Set<string>();
  // Strings in a result: plain text, or the parts of rich output such as React elements.
  const collect = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      const text = collapse(value);
      if (!text) return;
      rendered.delete(text);
      rendered.add(text);
      if (rendered.size > 10_000) rendered.delete(rendered.values().next().value!);
      return;
    }
    if (!value || typeof value !== 'object' || depth > 6) return;
    if (Array.isArray(value)) { for (const item of value) collect(item, depth + 1); return; }
    const props = (value as { props?: { children?: unknown } }).props;
    if (props && typeof props === 'object') collect(props.children, depth + 1);
  };
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
        collect(result, 0);
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
    renderedTexts: () => rendered,
  };
}

const collapse = (text: string): string => text.replace(/[\s\u00a0]+/g, ' ').trim();

export interface RenderedTextFinding {
  /** The text, whitespace collapsed. */
  readonly text: string;
  /** The element that shows it. */
  readonly element: unknown;
  /** Set when the text is an attribute value, such as placeholder. */
  readonly attribute?: string;
  /** A short selector for the element, such as main > form.login > button. */
  readonly path: string;
}

export interface RenderedTextOptions {
  /** The subtree to check. Default: document.body. */
  root?: unknown;
  /** Attributes whose value is UI text. Default: placeholder, title, alt, aria-label and aria-description. */
  attributes?: readonly string[];
  /** Text to accept as it is: exact strings or regular expressions. */
  ignore?: ReadonlyArray<string | RegExp>;
}

interface DomNode {
  nodeType: number;
  nodeValue?: string | null;
  childNodes?: ArrayLike<DomNode>;
  tagName?: string;
  id?: string;
  parentNode?: DomNode | null;
  getAttribute?(name: string): string | null;
  hasAttribute?(name: string): boolean;
}

// Elements whose text is code, user input or not shown.
const skippedElements = new Set(['script', 'style', 'noscript', 'template', 'code', 'pre', 'kbd', 'samp', 'var', 'textarea', 'iframe', 'object', 'math']);
const defaultAttributes = ['placeholder', 'title', 'alt', 'aria-label', 'aria-description'];

function selector(element: DomNode): string {
  const parts: string[] = [];
  for (let node: DomNode | null | undefined = element; node && node.nodeType === 1 && parts.length < 4; node = node.parentNode) {
    const tag = node.tagName!.toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    const className = node.getAttribute?.('class')?.trim().split(/\s+/)[0];
    parts.unshift(node.id ? `${tag}#${node.id}` : className ? `${tag}.${className}` : tag);
    if (node.id) break;
  }
  return parts.join(' > ');
}

/**
 * Find text on the page that no wrapped message rendered: the runtime
 * counterpart of nordbeam-locale hardcoded. It reads what is in the DOM now, so
 * open each screen (and its dialogs) before checking it. Code, names, numbers
 * and text marked translate="no", .notranslate or data-nordbeam-locale-ignore are skipped.
 */
export function scanRenderedText(inspector: MessageInspector, options: RenderedTextOptions = {}): RenderedTextFinding[] {
  const root = (options.root ?? (globalThis as { document?: { body?: unknown } }).document?.body) as DomNode | undefined;
  if (!root) throw new Error('scanRenderedText needs a browser document or options.root.');
  const texts = inspector.renderedTexts();
  const parts = [...texts].filter(text => text.length >= 2).sort((a, b) => b.length - a.length);
  const ignored = (text: string): boolean => (options.ignore ?? []).some(rule => typeof rule === 'string' ? rule === text : rule.test(text));
  const fromMessages = (text: string): boolean => {
    // Rich messages arrive in parts (React children), and each part is recorded on its own.
    if (texts.has(text)) return true;
    // Text around a message, such as "3 invoices · " + message: what is left must not read as UI text.
    let rest = text;
    for (const part of parts) if (part.length <= rest.length && rest.includes(part)) rest = rest.split(part).join(' ');
    return rest !== text && (!collapse(rest) || noise(collapse(rest), 'child') !== undefined);
  };
  const findings: RenderedTextFinding[] = [];
  const check = (text: string, element: DomNode, position: 'child' | 'text', attribute?: string): void => {
    text = collapse(text);
    if (!text || noise(text, position) !== undefined || ignored(text) || fromMessages(text)) return;
    findings.push({ text, element, ...(attribute ? { attribute } : {}), path: selector(element) });
  };
  const attributes = options.attributes ?? defaultAttributes;
  const walk = (element: DomNode): void => {
    if (skippedElements.has(element.tagName?.toLowerCase() ?? '') || element.hasAttribute?.('hidden') || element.hasAttribute?.('data-nordbeam-locale-ignore')
      || element.hasAttribute?.('data-nordbeam-locale-inspector') || element.getAttribute?.('translate') === 'no'
      || /(?:^|\s)notranslate(?:\s|$)/.test(element.getAttribute?.('class') ?? '') || element.getAttribute?.('contenteditable') === 'true') return;
    for (const name of attributes) { const value = element.getAttribute?.(name); if (value) check(value, element, 'text', name); }
    const type = element.tagName?.toLowerCase() === 'input' ? element.getAttribute?.('type') : undefined;
    if (type === 'submit' || type === 'button' || type === 'reset') { const value = element.getAttribute?.('value'); if (value) check(value, element, 'text', 'value'); }
    // Adjacent text nodes are one run: React renders "You have {n} invoices" as three.
    let run = '';
    const nodes = element.childNodes ?? [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (node.nodeType === 3) { run += node.nodeValue ?? ''; continue; }
      if (run) { check(run, element, 'child'); run = ''; }
      if (node.nodeType === 1) walk(node);
    }
    if (run) check(run, element, 'child');
  };
  walk(root);
  return findings;
}

export interface InspectorOverlayOptions {
  /** Supply a document for tests or an iframe; defaults to the active browser document. */
  document?: { createElement(name: string): any; body?: { appendChild(node: any): unknown } };
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** Options for the overlay's "Find hardcoded text" check. */
  text?: RenderedTextOptions;
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
  // The last "Find hardcoded text" result, and the outlines it drew.
  let found: RenderedTextFinding[] | undefined;
  let outlined: Array<[any, string]> = [];
  const unmark = (): void => { for (const [element, outline] of outlined) element.style.outline = outline; outlined = []; };
  const findText = (): void => {
    unmark();
    found = scanRenderedText(inspector, { root: document.body, ...options.text });
    for (const finding of found) {
      const element = finding.element as { style?: { outline: string; outlineOffset?: string } };
      if (!element.style || outlined.some(([marked]) => marked === element)) continue;
      outlined.push([element, element.style.outline]);
      element.style.outline = '2px dashed #f59e0b';
    }
    render();
  };
  const render = (): void => {
    const records = inspector.records();
    root.textContent = '';
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #374151;position:sticky;top:0;background:#111827';
    const title = document.createElement('strong'); title.textContent = `Locale inspector (${records.length})`; header.appendChild(title);
    const clear = document.createElement('button'); clear.textContent = 'Clear'; clear.type = 'button'; clear.onclick = () => inspector.clear(); header.appendChild(clear);
    const check = document.createElement('button'); check.textContent = 'Find hardcoded text'; check.type = 'button'; check.onclick = findText; header.appendChild(check);
    root.appendChild(header);
    if (found) {
      const section = document.createElement('div'); section.style.cssText = 'padding:6px 8px;border-bottom:1px solid #374151;background:#1c1917';
      const summary = document.createElement('div'); summary.style.cssText = 'display:flex;gap:8px;align-items:center;color:#fbbf24';
      const count = document.createElement('span');
      count.textContent = found.length ? `${found.length} ${found.length === 1 ? 'string' : 'strings'} on this screen did not come from a message` : 'Every string on this screen came from a message';
      summary.appendChild(count);
      const hide = document.createElement('button'); hide.textContent = 'Hide'; hide.type = 'button'; hide.onclick = () => { unmark(); found = undefined; render(); }; summary.appendChild(hide);
      section.appendChild(summary);
      for (const finding of found.slice(0, 100)) {
        const item = document.createElement('div'); item.style.cssText = 'padding:4px 0;cursor:pointer';
        item.textContent = `${JSON.stringify(finding.text)}${finding.attribute ? ` [${finding.attribute}]` : ''}`;
        const where = document.createElement('div'); where.style.opacity = '0.65'; where.textContent = finding.path; item.appendChild(where);
        item.onclick = () => (finding.element as { scrollIntoView?(options: unknown): void }).scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        section.appendChild(item);
      }
      root.appendChild(section);
    }
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
  return { element: root, dispose() { unsubscribe(); unmark(); root.remove?.(); } };
}
