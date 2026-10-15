import { quote } from './codegen.js';

type Node = { direct?: string; children: Map<string, Node> };

function tree(ids: readonly string[]): Node {
  const root: Node = { children: new Map() };
  for (const id of ids) {
    let node = root;
    for (const part of id.split('.')) {
      let child = node.children.get(part);
      if (!child) { child = { children: new Map() }; node.children.set(part, child); }
      node = child;
    }
    node.direct = id;
  }
  return root;
}

/** Emit a non-enumerable nested view while retaining canonical flat IDs. */
export function nestedMessageAliases(ids: readonly string[]): string {
  if (!ids.some(id => id.includes('.'))) return '';
  const root = tree(ids);
  const expression = (node: Node): string => {
    const children = [...node.children].map(([key, child]) => `[${quote(key)}]:${expression(child)}`).join(',');
    if (!children) return `messages[${quote(node.direct!)}]`;
    const source = `{__proto__:null,${children}}`;
    return node.direct ? `$nest(messages[${quote(node.direct)}],${source})` : source;
  };
  const assignments: string[] = [];
  for (const [key, node] of root.children) {
    if (!node.children.size) continue;
    if (node.direct) {
      const children = [...node.children].map(([childKey, child]) => `[${quote(childKey)}]:${expression(child)}`).join(',');
      assignments.push(`$nest(messages[${quote(node.direct)}],{__proto__:null,${children}});`);
    } else {
      assignments.push(`Object.defineProperty(messages,${quote(key)},{value:${expression(node)}});`);
    }
  }
  if (!assignments.length) return '';
  const directIds = new Set(ids);
  const collision = ids.some(id => {
    const parts = id.split('.');
    return parts.length > 1 && parts.slice(1).some((_, index) => directIds.has(parts.slice(0, index + 1).join('.')));
  });
  return (collision ? 'const $nest=(target,source)=>Object.defineProperties(target,Object.getOwnPropertyDescriptors(source));\n' : '')
    + assignments.join('') + '\n';
}

/** Build the full nested view from canonical flat keys without repeating every
 * dotted ID in generated source. The initializer is emitted behind a pure call
 * so named imports can tree-shake the complete default catalog. */
export function nestedMessageRuntime(): string {
  return 'const $nested=messages=>{for(const key of Object.keys(messages)){if(!key.includes("."))continue;const parts=key.split(".");let target=messages;for(let i=0;i<parts.length-1;i++){const part=parts[i];let next=Object.hasOwn(target,part)?target[part]:undefined;if((typeof next!=="object"&&typeof next!=="function")||next===null){next={__proto__:null};Object.defineProperty(target,part,{value:next,enumerable:target!==messages});}target=next;}Object.defineProperty(target,parts.at(-1),{value:messages[key],enumerable:true});}return messages;};\n';
}

export function nestedMessageTypeLiteral(ids: readonly string[], flat: string): string {
  const root = tree(ids);
  const expression = (node: Node): string => {
    const children = [...node.children].map(([key, child]) => `readonly ${quote(key)}:${expression(child)}`).join(';');
    if (!children) return `${flat}[${quote(node.direct!)}]`;
    // A dotted namespace is an object at the type level. When a catalog also
    // contains the namespace itself (for example `account` and
    // `account.name`), retain the callable message's type while adding its
    // children. Avoid a synthetic `$Namespace` helper here: it used to leak
    // into TypeScript's excess-property diagnostics and made a missing key
    // print implementation details instead of the public Messages name.
    return node.direct
      ? `${flat}[${quote(node.direct)}]&{${children}}`
      : `((...args:any[])=>never)&{${children}}`;
  };
  const properties = [...root.children]
    .filter(([, node]) => node.children.size)
    .map(([key, node]) => `readonly ${quote(key)}:${expression(node)}`);
  return `{${properties.join(';')}}`;
}
