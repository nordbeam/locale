export class CompileError extends Error {
    diagnostics;
    constructor(diagnostics) {
        super(diagnostics.map(formatDiagnostic).join('\n\n'));
        this.name = 'CompileError';
        this.diagnostics = diagnostics;
    }
}
export function formatDiagnostic(d) {
    const context = [d.locale, d.messageId].filter(x => x !== undefined).join(':');
    const location = d.line ? ` (message ${d.line}:${d.column ?? 1})` : '';
    const heading = `[${d.code}] ${context ? `${context}${location}: ` : ''}${d.message}`;
    if (!d.source || !d.line)
        return heading;
    const line = d.source.split('\n')[d.line - 1] ?? '';
    return `${heading}\n  ${line}\n  ${' '.repeat(Math.max(0, (d.column ?? 1) - 1))}^`;
}
