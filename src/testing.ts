import type { Formats } from './compiler.js';

export interface MessageKey { readonly key: string }

export type MessageSelectorTree<Messages> =
  (Messages extends (...args: any[]) => any ? MessageKey : unknown)
  & { readonly [Key in keyof Messages]: MessageSelectorTree<Messages[Key]> };

/** Build property-based selectors and locale snapshots for a generated Messages type. */
export function createMessageTestHelpers<Messages>() {
  const keyFromSelector = (select: (messages: MessageSelectorTree<Messages>) => MessageKey): string => {
    const nodes = new Map<string, MessageKey>();
    const make = (path: string): MessageKey => {
      const existing = nodes.get(path);
      if (existing) return existing;
      const target = Object.freeze({ key: path });
      const node = new Proxy(target, { get(value, property, receiver) {
        if (property === 'key') return path;
        if (typeof property !== 'string') return Reflect.get(value, property, receiver);
        return make(path ? `${path}.${property}` : property);
      } });
      nodes.set(path, node);
      return node;
    };
    const selected = select(make('') as MessageSelectorTree<Messages>);
    if (!selected || typeof selected.key !== 'string' || !selected.key) throw new TypeError('Message selector must return one message.');
    return selected.key;
  };
  const localeMatrix = async <Locale extends string, Result>(locales: readonly Locale[], loadLocale: (locale: Locale) => Promise<{ readonly messages: Messages }>, render: (messages: Messages, locale: Locale) => Result): Promise<Record<Locale, Result>> => {
    const entries = await Promise.all(locales.map(async locale => [locale, render((await loadLocale(locale)).messages, locale)] as const));
    return Object.fromEntries(entries) as Record<Locale, Result>;
  };
  return { keyFromSelector, localeMatrix };
}

type MessageFunction = (...args: any[]) => any;

/** The message IDs of a generated messages object: its messages, not the namespaces of its nested view. */
export type MessageIdOf<Messages> = {
  [Key in keyof Messages & string]: Messages[Key] extends (...args: any[]) => infer Result ? [Result] extends [never] ? never : Key : never
}[keyof Messages & string];

/** Replacements by message ID: literal text, or a function with the message's arguments. */
export type MessageOverrides<Messages> = {
  readonly [Id in MessageIdOf<Messages>]?: string
    | ((...args: Parameters<Extract<Messages[Id], MessageFunction>>) => ReturnType<Extract<Messages[Id], MessageFunction>>)
};

export interface MessageIdOptions {
  /** The text a message renders. The default is its ID. */
  readonly format?: (id: string, args: Readonly<Record<string, unknown>> | undefined) => string;
}

export interface CompileMessagesOptions {
  /** The locale whose plural rules and number and date formats apply. Default: `en`. */
  readonly locale?: string;
  /** Named number, date and time styles, as in the project configuration. */
  readonly formats?: Formats;
  readonly timeZone?: string;
  /** Argument checks that throw on a missing or mistyped argument. Default: `true`. */
  readonly development?: boolean;
}

/** A rich message is called with slot functions and returns an array of parts. */
const hasSlot = (args: unknown): boolean => !!args && typeof args === 'object'
  && Object.values(args).some(value => typeof value === 'function');

const textMessage = (render: (args: Readonly<Record<string, unknown>> | undefined) => string): MessageFunction =>
  (args?: Readonly<Record<string, unknown>>) => {
    const text = render(args);
    return hasSlot(args) ? [text] : text;
  };

/**
 * A messages object shaped like generated ones: each message under its full ID, enumerable,
 * plus the nested view (`m.checkout.title`). Top-level namespaces are not enumerable, so
 * `Object.keys` lists every message once. Functions passed in are never changed: a message
 * that is also a namespace (`account` beside `account.title`) gets a copy to hold its children.
 */
function messagesObject(flat: Readonly<Record<string, MessageFunction>>): object {
  const messages: Record<string, unknown> = Object.create(null);
  const copies = new WeakSet<MessageFunction>();
  const define = (target: object, key: string, value: unknown, enumerable: boolean) =>
    Object.defineProperty(target, key, { value, enumerable, configurable: true, writable: true });
  for (const id of Object.keys(flat)) define(messages, id, flat[id], true);
  // Shorter IDs first, so a message is in place before its children are.
  for (const id of Object.keys(flat).sort((a, b) => a.split('.').length - b.split('.').length)) {
    if (!id.includes('.')) continue;
    const parts = id.split('.');
    let target: Record<string, unknown> = messages;
    for (let index = 0; index < parts.length - 1; index++) {
      const part = parts[index]!;
      let next = Object.hasOwn(target, part) ? target[part] : undefined;
      if (typeof next === 'function' && !copies.has(next as MessageFunction)) {
        const original = next as MessageFunction;
        const copy: MessageFunction = function (this: unknown, ...args: unknown[]) { return original.apply(this, args); };
        copies.add(copy);
        define(target, part, copy, Object.getOwnPropertyDescriptor(target, part)!.enumerable ?? true);
        next = copy;
      } else if ((typeof next !== 'object' && typeof next !== 'function') || next === null) {
        next = Object.create(null);
        define(target, part, next, target !== messages);
      }
      target = next as Record<string, unknown>;
    }
    define(target, parts.at(-1)!, flat[id], true);
  }
  return messages;
}

const flatMessages = (messages: object): Record<string, MessageFunction> => {
  const flat: Record<string, MessageFunction> = Object.create(null);
  for (const id of Object.keys(messages)) {
    const value = (messages as Record<string, unknown>)[id];
    if (typeof value === 'function') flat[id] = value as MessageFunction;
  }
  return flat;
};

/**
 * A messages object in which every message renders its ID, for tests that assert IDs
 * rather than text. It has the IDs and the nested view of the object passed in, usually a
 * generated locale (`import en from './src/i18n/locales/en.js'`). A call with slot
 * functions, as `rich()` makes, returns `[id]`. `format` renders something else, such as
 * the ID with its arguments.
 */
export function messageIds<Messages extends object>(messages: Messages, options: MessageIdOptions = {}): Messages {
  const format = options.format ?? ((id: string) => id);
  const flat = flatMessages(messages);
  for (const id of Object.keys(flat)) flat[id] = textMessage(args => format(id, args));
  return messagesObject(flat) as Messages;
}

/**
 * A copy of a messages object with some messages replaced. A replacement is literal text,
 * or a function that takes the message's arguments; flat (`m['checkout.title']`) and nested
 * (`m.checkout.title`) access both return it. Text with ICU arguments or tags goes through
 * `compileMessages` first. An ID the object does not have is a `RangeError`.
 */
export function withMessages<Messages extends object>(messages: Messages, overrides: MessageOverrides<Messages>): Messages {
  const flat = flatMessages(messages);
  for (const [id, value] of Object.entries(overrides as Readonly<Record<string, unknown>>)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(flat, id)) throw new RangeError(`Unknown message: ${id}`);
    if (typeof value === 'function') flat[id] = value as MessageFunction;
    else if (typeof value !== 'string') throw new TypeError(`The replacement for ${id} must be text or a function.`);
    else if (/[{}]/.test(value)) throw new TypeError(`The replacement for ${id} has ICU syntax. Compile it with compileMessages() first, or pass a function.`);
    else flat[id] = textMessage(() => value);
  }
  return messagesObject(flat) as Messages;
}

/**
 * Compile ICU messages in memory with the project's compiler, for a test's own texts:
 * `withMessages(en, await compileMessages({ 'cart.total': 'Total: {amount, number}' }))`.
 * The result renders exactly as generated output does. It loads the compiler on first use
 * and evaluates its output with `new Function`, so it needs a runtime that allows that
 * (Node test runners do; a page with a strict Content-Security-Policy does not).
 */
export async function compileMessages<const Texts extends Readonly<Record<string, string>>>(texts: Texts, options: CompileMessagesOptions = {}): Promise<{ readonly [Id in keyof Texts]: MessageFunction }> {
  const { compileProject } = await import('./compiler.js');
  const locale = options.locale ?? 'en';
  const project = compileProject({
    baseLocale: locale, catalogs: { [locale]: { ...texts } }, development: options.development ?? true, artifacts: 'runtime',
    ...(options.formats ? { formats: options.formats } : {}), ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });
  const source = project.files[`internal/locales/${locale}.js`];
  const end = /export default messages;\s*$/;
  if (!source || !end.test(source) || /^\s*import\b/m.test(source)) throw new Error('compileMessages: the compiler returned a module it cannot evaluate.');
  return new Function(`'use strict';${source.replace(end, 'return messages;')}`)() as { readonly [Id in keyof Texts]: MessageFunction };
}
