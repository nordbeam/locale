import { Children, Fragment, createElement, isValidElement } from 'react';
import type { ReactNode, ReactElement } from 'react';

type RichMessage = <$Node>(args: never) => Array<string | $Node>;
type RichArguments<Message extends RichMessage> = {
  [Key in keyof Parameters<Message>[0]]: Parameters<Message>[0][Key] extends (children: unknown[]) => unknown
    ? (children: ReactNode[]) => ReactNode : Parameters<Message>[0][Key]
};

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

/** Render a generated rich message with typed slots and automatic React keys. */
export function rich<Message extends RichMessage>(message: Message, args: RichArguments<NoInfer<Message>>): ReactElement {
  const values: Record<string, unknown> = { ...args };
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (typeof value === 'function') values[key] = (children: ReactNode[]) => value(keyedParts(children));
  }
  // The generic node type is specialized by the React slot callbacks above.
  const render = message as unknown as (args: Record<string, unknown>) => ReactNode[];
  return createElement(Fragment, null, keyedParts(render(values)));
}
