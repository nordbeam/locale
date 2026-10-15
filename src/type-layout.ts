// Small declaration maps bound the work done by an editor when following one
// message, including when the original JSON occupies a single very long line.
const messagesPerDeclaration = 256;

export interface DeclarationGroup {
  file: string;
  ids: readonly string[];
}

export function declarationGroups(entry: string, ids: readonly string[]): DeclarationGroup[] {
  const prefix = entry.slice(0, -'index.js'.length);
  if (ids.length <= messagesPerDeclaration) return [{file:prefix+'messages.d.ts',ids}];
  const groups: DeclarationGroup[] = [];
  for (let i=0;i<ids.length;i+=messagesPerDeclaration) {
    groups.push({file:`${prefix}types/${i/messagesPerDeclaration}.d.ts`,ids:ids.slice(i,i+messagesPerDeclaration)});
  }
  return groups;
}

/** The aggregate declaration only depends on group membership and paths. */
export function sameDeclarationLayout(a: readonly DeclarationGroup[], b: readonly DeclarationGroup[]): boolean {
  return a === b || (a.length === b.length && a.every((group, index) => {
    const previous = b[index]!;
    return group.file === previous.file && group.ids.length === previous.ids.length
      && group.ids.every((id, i) => id === previous.ids[i]);
  }));
}
