// Small declaration maps bound the work done by an editor when following one
// message, including when the original JSON occupies a single very long line.
const messagesPerDeclaration = 256;
export function declarationGroups(entry, ids) {
    const prefix = entry.slice(0, -'index.js'.length);
    if (ids.length <= messagesPerDeclaration)
        return [{ file: prefix + 'messages.d.ts', ids }];
    const groups = [];
    for (let i = 0; i < ids.length; i += messagesPerDeclaration) {
        groups.push({ file: `${prefix}types/${i / messagesPerDeclaration}.d.ts`, ids: ids.slice(i, i + messagesPerDeclaration) });
    }
    return groups;
}
