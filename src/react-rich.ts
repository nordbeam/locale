import { Children, Fragment, createElement, isValidElement } from 'react';
import type { ReactNode, ReactElement } from 'react';

type RichMessage = <$Node>(args: never) => Array<string | $Node>;
type TextMessage = (args: never) => string;
/** A plain `{name}` argument is typed string or number. */
type IsPlain<Value> = [Value] extends [string | number] ? [string | number] extends [Value] ? true : false : false;
type Arguments<Message extends RichMessage | TextMessage> = {
  [Key in keyof Parameters<Message>[0]]: Parameters<Message>[0][Key] extends (children: unknown[]) => unknown
    ? (children: ReactNode[]) => ReactNode
    : IsPlain<Parameters<Message>[0][Key]> extends true ? Parameters<Message>[0][Key] | ReactElement : Parameters<Message>[0][Key]
};
// A message without tags needs `rich` only to place an element in a plain argument.
type RichArguments<Message extends RichMessage | TextMessage> = Message extends RichMessage ? Arguments<Message>
  : true extends { [Key in keyof Parameters<Message>[0]]: IsPlain<Parameters<Message>[0][Key]> }[keyof Parameters<Message>[0]] ? Arguments<Message> : never;

function keyedParts(children: ReactNode[]): ReactNode[] {
  // The compiler owns this outer array. Text-only runs need no copy or React
  // traversal; callback results can still be arbitrary React children.
  let parts: ReactNode[] | undefined;
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (typeof child === 'string' || typeof child === 'number') {
      parts?.push(child);
      continue;
    }
    parts ??= children.slice(0, index);
    if (child == null || typeof child === 'boolean') continue;
    if (isValidElement(child)) {
      parts.push(createElement(Fragment, { key: parts.length }, child));
    } else {
      // Delegate arrays, iterables, portals and React-version-specific nodes
      // to React. Never inspect element children or mutate a callback result.
      const target = parts;
      Children.forEach(child, value => {
        if (value === null) return;
        target.push(typeof value === 'string' || typeof value === 'number' ? value
          : createElement(Fragment, { key: target.length }, value));
      });
    }
  }
  return parts ?? children;
}

// An element passed for a plain argument enters the message as this private-use marker,
// so the generated formatter places it like text; the marker is then swapped for the element.
const marker = /\uE000(\d+)\uE001/;

function withElements(parts: ReactNode[], elements: readonly ReactElement[] | undefined): ReactNode[] {
  if (!elements) return parts;
  const result: ReactNode[] = [];
  for (const part of parts) {
    if (typeof part !== 'string' || !part.includes('\uE000')) { result.push(part); continue; }
    const pieces = part.split(marker);
    for (let index = 0; index < pieces.length; index++) {
      if (index % 2) result.push(elements[Number(pieces[index])]);
      else if (pieces[index]) result.push(pieces[index]);
    }
  }
  return result;
}

/** Render a generated rich message with typed slots and automatic React keys. A plain
 * `{name}` argument may be a React element, also in a message without tags:
 * `rich(m.code, { code: <b>{code}</b> })`. */
export function rich<Message extends RichMessage | TextMessage>(message: Message, args: RichArguments<NoInfer<Message>>): ReactElement {
  const values: Record<string, unknown> = { ...args };
  let elements: ReactElement[] | undefined;
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (typeof value === 'function') values[key] = (children: ReactNode[]) => value(keyedParts(withElements(children, elements)));
    else if (isValidElement(value)) values[key] = `\uE000${(elements ??= []).push(value) - 1}\uE001`;
  }
  // The generic node type is specialized by the React slot callbacks above.
  const output = (message as unknown as (args: Record<string, unknown>) => string | ReactNode[])(values);
  return createElement(Fragment, null, keyedParts(withElements(typeof output === 'string' ? [output] : output, elements)));
}
