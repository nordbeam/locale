import { CompileError } from './diagnostics.js';
export function poError(code, message, file, line, messageId) {
    throw new CompileError([{ code, message, file, messageId, ...(line ? { location: { line, column: 1, offset: 0 } } : {}) }]);
}
/** PO is UTF-8 text. Reject strings which would be changed by encoding/gettext. */
export function assertPoText(text, context = {}) {
    if (/[\u0000\u0004\uD800-\uDFFF]/u.test(text)) {
        throw new CompileError([{ code: 'PO_UNREPRESENTABLE_TEXT', message: 'PO transport cannot represent NUL, EOT or unpaired UTF-16 surrogates. Use valid Unicode text without NUL/EOT.', ...context }]);
    }
}
export function quotePo(text) {
    return '"' + text.replace(/[\x00-\x1f\x7f"\\]/g, char => {
        const escapes = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f', '\v': '\\v', '\x07': '\\a', '"': '\\"', '\\': '\\\\' };
        return escapes[char] ?? '\\' + char.charCodeAt(0).toString(8).padStart(3, '0');
    }) + '"';
}
function unquote(text, file, line) {
    const invalid = (message) => poError('INVALID_PO', message, file, line);
    if (!text.startsWith('"'))
        invalid('Expected a double-quoted PO string.');
    let result = '';
    for (let i = 1; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            if (text.slice(i + 1).trim())
                invalid('Unexpected text after the closing quote.');
            assertPoText(result, { file, location: { line, column: 1, offset: 0 } });
            return result;
        }
        if (char === '\\') {
            const escape = text[++i];
            if (escape === undefined)
                invalid('Unterminated PO string.');
            const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07', '"': '"', '\\': '\\' };
            if (Object.hasOwn(escapes, escape))
                result += escapes[escape];
            else if (/[0-7x]/.test(escape)) {
                const digits = escape === 'x' ? text.slice(i + 1).match(/^[0-9a-fA-F]+/)?.[0] : text.slice(i).match(/^[0-7]{1,3}/)?.[0];
                if (!digits)
                    invalid('Invalid numeric PO escape.');
                const value = parseInt(digits, escape === 'x' ? 16 : 8);
                if (value > 127)
                    invalid('Use literal UTF-8 characters for non-ASCII text instead of numeric byte escapes.');
                result += String.fromCharCode(value);
                i += digits.length - (escape === 'x' ? 0 : 1);
            }
            else
                invalid(`Unsupported PO escape \\${escape}. Use PO C-style escapes, not JSON Unicode escapes.`);
        }
        else {
            if (char === '\r')
                invalid('Escape carriage returns inside PO strings as \\r.');
            result += char;
        }
    }
    return invalid('Unterminated PO string.');
}
/** Strict single-string entries; gettext plural arrays have different semantics. */
export function parsePo(text, file) {
    try {
        return readPo(text, file);
    }
    catch (error) {
        if (!(error instanceof CompileError))
            throw error;
        const offsets = [0];
        for (let i = 0; i < text.length; i++)
            if (text[i] === '\n')
                offsets.push(i + 1);
        throw new CompileError(error.diagnostics.map(d => d.location ? { ...d, location: { ...d.location, offset: offsets[d.location.line - 1] } } : d));
    }
}
function readPo(text, file) {
    assertPoText(text, { file });
    const result = { headers: new Map(), entries: [], obsolete: 0 };
    let fields = {}, current;
    let fuzzy = false, empty = false, start = 1, header = false;
    const seen = new Set();
    const finish = () => {
        if (!current)
            return;
        if (fields.msgid === undefined || fields.msgstr === undefined)
            poError('INVALID_PO', 'Each PO entry requires msgid and one msgstr.', file, start, fields.msgctxt);
        if (fields.msgctxt === undefined && fields.msgid === '') {
            if (header || result.entries.length)
                poError('INVALID_PO', 'The PO header must appear once, before message entries.', file, start);
            header = true;
            if (fuzzy)
                poError('PO_FUZZY_HEADER', 'Review and remove the fuzzy flag on the PO header before importing.', file, start);
            for (const line of fields.msgstr.split('\n')) {
                if (!line.trim())
                    continue;
                const colon = line.indexOf(':');
                if (colon < 1)
                    poError('INVALID_PO', 'Expected a Name: value header field.', file, start);
                const name = line.slice(0, colon).trim().toLowerCase();
                if (result.headers.has(name))
                    poError('INVALID_PO', `Duplicate PO header ${JSON.stringify(name)}.`, file, start);
                result.headers.set(name, line.slice(colon + 1).trim());
            }
        }
        else {
            const id = fields.msgctxt;
            if (!id)
                poError('PO_MISSING_CONTEXT', 'Each translation needs its stable message ID in msgctxt. Export a PO file with fasti18n export first.', file, start);
            if (seen.has(id))
                poError('PO_DUPLICATE_ID', `Duplicate message ID ${JSON.stringify(id)}.`, file, start, id);
            seen.add(id);
            result.entries.push({ id, source: fields.msgid, translation: fields.msgstr, fuzzy, empty, line: start });
        }
        fields = {};
        current = undefined;
        fuzzy = false;
        empty = false;
    };
    for (const [index, raw] of text.replace(/^\uFEFF/, '').split('\n').entries()) {
        const line = index + 1, value = raw.replace(/\r$/, '').trim();
        if (!value) {
            finish();
            continue;
        }
        if (value.startsWith('#')) {
            finish();
            if (/^#~\s*msgid\s/.test(value))
                result.obsolete++;
            if (value.startsWith('#~')) {
                fuzzy = false;
                empty = false;
                continue;
            }
            if (value.startsWith('#,'))
                fuzzy ||= value.slice(2).split(',').some(flag => flag.trim() === 'fuzzy');
            if (value === '#. fasti18n:empty')
                empty = true;
            continue;
        }
        if (value.startsWith('"')) {
            if (!current)
                poError('INVALID_PO', 'A continuation string must follow msgctxt, msgid or msgstr.', file, line);
            fields[current] += unquote(value, file, line);
            continue;
        }
        if (/^(msgid_plural|msgstr\[)/.test(value))
            poError('PO_GETTEXT_PLURAL', 'Keep ICU plurals inside a single msgid/msgstr. Gettext plural arrays cannot be imported.', file, line, fields.msgctxt);
        const match = /^(msgctxt|msgid|msgstr)[ \t]+(.*)$/.exec(value);
        if (!match)
            poError('INVALID_PO', 'Expected msgctxt, msgid, msgstr, a quoted continuation or a comment.', file, line);
        const field = match[1];
        if ((field === 'msgctxt' || field === 'msgid') && current === 'msgstr')
            finish();
        if (fields[field] !== undefined || (field === 'msgctxt' && current) || (field === 'msgid' && current && current !== 'msgctxt') || (field === 'msgstr' && current !== 'msgid')) {
            poError('INVALID_PO', 'Expected one msgctxt, then msgid, then one msgstr per entry.', file, line, fields.msgctxt);
        }
        if (!current)
            start = line;
        current = field;
        fields[field] = unquote(match[2], file, line);
    }
    finish();
    if (!header)
        poError('PO_MISSING_HEADER', 'A PO header with Language and UTF-8 Content-Type is required.', file);
    return result;
}
