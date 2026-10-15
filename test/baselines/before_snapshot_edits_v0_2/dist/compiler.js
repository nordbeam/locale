import { parse, TYPE } from '@formatjs/icu-messageformat-parser';
import { CompileError, describeIcuError } from './diagnostics.js';
import { declarationGroups } from './type-layout.js';
import { quote, header, rewriteGeneratedIdentifiers, substituteTextParameters } from './codegen.js';
import { Projection } from './projection.js';
import { isCatalogSnapshot } from './catalog-input.js';
import { foldLiteralSelect } from './literal-folding.js';
export { quote } from './codegen.js';
export { CompileError, formatDiagnostic } from './diagnostics.js';
/** Temporary text collection for one render. Snapshots have independent,
 * compact storage; oversized scratch arrays are dropped before the next use. */
class TextBuffer {
    values = [];
    characters = 0;
    length = 0;
    reset() {
        if (this.values.length > 64 || this.characters > 4096)
            this.values = [];
        this.length = 0;
        this.characters = 0;
        return this;
    }
    push(value) {
        this.values[this.length++] = value;
        this.characters += value.length;
    }
    slice() { return this.values.slice(0, this.length); }
}
function trimEmissions(cache) {
    // One iterator avoids rescanning Map tombstones for each eviction.
    for (const [old, cost] of cache.entries) {
        if (cache.bytes <= cache.limit)
            break;
        old.emitted = undefined;
        cache.entries.delete(old);
        cache.bytes -= cost;
    }
}
function forgetEmission(cache, message) {
    const cost = cache.entries.get(message);
    if (cost === undefined)
        return;
    cache.entries.delete(message);
    cache.bytes -= cost;
    message.emitted = undefined;
}
const sameItems = (a, b) => a === b || (a.length === b.length && a.every((value, i) => value === b[i]));
// Unlike JSON.stringify alone, keep explicit undefined and non-finite numbers
// distinct. Both can affect Intl option validation or override named defaults.
function optionKey(value, parents = new Set()) {
    if (value === null)
        return 'null';
    switch (typeof value) {
        case 'undefined': return 'undefined';
        case 'string': return JSON.stringify(value);
        case 'number': return `number:${String(value)}`;
        case 'boolean': return String(value);
        case 'object': {
            if (parents.has(value))
                throw new TypeError('Format options must not contain cycles.');
            parents.add(value);
            const key = Array.isArray(value) ? `[${value.map(item => optionKey(item, parents)).join(',')}]`
                : `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}:${optionKey(item, parents)}`).join(',')}}`;
            parents.delete(value);
            return key;
        }
        default: throw new TypeError('Format options must contain only data.');
    }
}
const own = (object, key) => Object.hasOwn(object, key);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// Unicode mode treats a valid surrogate pair as one code point outside this
// range. Lone surrogates are valid property keys, but invalid ESM export names.
const unpairedSurrogate = /[\uD800-\uDFFF]/u;
const namedMessage = (id) => id !== 'then' && id !== 'default' && !unpairedSurrogate.test(id);
function fail(code, message, context = {}) {
    throw new CompileError([{ ...context, code, message }]);
}
function validateLocale(locale) {
    try {
        const canonical = Intl.getCanonicalLocales(locale)[0];
        if (locale !== canonical)
            fail('INVALID_LOCALE', `Use the canonical locale ${quote(canonical)} instead of ${quote(locale)}.`, { locale });
    }
    catch (error) {
        if (error instanceof CompileError)
            throw error;
        fail('INVALID_LOCALE', `Invalid BCP 47 locale ${quote(locale)}.`, { locale });
    }
}
function flatten(catalog, locale, report, comparison) {
    const result = new Map();
    const ancestors = new Set();
    function problem(code, message, messageId) {
        const diagnostic = { code, message, locale, ...(messageId === undefined ? {} : { messageId }) };
        if (report)
            report(diagnostic);
        else
            throw new CompileError([diagnostic]);
    }
    function visit(value, prefix) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            problem('INVALID_CATALOG', 'Expected an object containing strings or nested catalogs.', prefix);
            return;
        }
        if (ancestors.has(value)) {
            problem('INVALID_CATALOG', 'Catalog contains a circular reference.', prefix);
            return;
        }
        ancestors.add(value);
        for (const [key, entry] of Object.entries(value)) {
            if (!key) {
                problem('INVALID_KEY', 'Message keys must not be empty.', report ? prefix : undefined);
                continue;
            }
            const id = prefix ? `${prefix}.${key}` : key;
            if (typeof entry === 'string') {
                if (result.has(id)) {
                    problem('DUPLICATE_KEY', `Nested and flat keys both resolve to ${quote(id)}.`, id);
                    continue;
                }
                const cached = comparison?.messages?.get(id);
                const equal = cached?.source === entry;
                // Carry validated cached records into changed-table construction too,
                // so an edit near the end does not repeat every successful lookup.
                result.set(id, equal ? cached : entry);
                if (comparison?.unchanged && !equal)
                    comparison.unchanged = false;
            }
            else
                visit(entry, id);
        }
        ancestors.delete(value);
    }
    visit(catalog, '');
    return result;
}
function argumentContext(message, name) {
    function find(nodes) {
        for (const node of nodes) {
            if (node.type === TYPE.literal || node.type === TYPE.pound)
                continue;
            if (node.value === name)
                return node.location?.start;
            if (node.type === TYPE.tag) {
                const found = find(node.children);
                if (found)
                    return found;
            }
            else if (node.type === TYPE.select || node.type === TYPE.plural) {
                for (const branch of Object.values(node.options)) {
                    const found = find(branch.value);
                    if (found)
                        return found;
                }
            }
        }
    }
    const ast = message.ast ?? parse(message.source, { captureLocation: true, shouldParseSkeletons: false });
    return { locale: message.locale, messageId: message.id, source: message.source, ...find(ast) };
}
function mergeArgument(target, name, arg, context, message) {
    const previous = target.get(name);
    if (!previous) {
        target.set(name, { kind: arg.kind, choices: new Set(arg.choices) });
        return;
    }
    if ((previous.kind === 'slot' || arg.kind === 'slot') && previous.kind !== arg.kind) {
        fail('ARGUMENT_TYPE_CONFLICT', `${quote(name)} is used as both ${previous.kind} and ${arg.kind}. Use separate names for values and rich-text slots.`, message ? argumentContext(message, name) : context);
    }
    if (previous.kind === 'value')
        previous.kind = arg.kind;
    else if (arg.kind !== 'value' && arg.kind !== previous.kind) {
        fail('ARGUMENT_TYPE_CONFLICT', `${quote(name)} is used as both ${previous.kind} and ${arg.kind}. Use separate arguments.`, message ? argumentContext(message, name) : context);
    }
    for (const choice of arg.choices)
        previous.choices.add(choice);
}
function readMessage(id, source, locale, intlLocale) {
    const context = { locale, messageId: id, source };
    let ast;
    try {
        ast = parse(source, { captureLocation: true, shouldParseSkeletons: true, locale: intlLocale });
    }
    catch (error) {
        const e = error;
        const description = describeIcuError(e.message);
        fail('INVALID_ICU', description.message, { ...context, ...description, ...e.location?.start });
    }
    const args = new Map();
    function visit(nodes) {
        for (const node of nodes) {
            if (node.type === TYPE.literal || node.type === TYPE.pound)
                continue;
            if (node.type === TYPE.tag) {
                mergeArgument(args, node.value, { kind: 'slot', choices: new Set() }, { ...context, ...node.location?.start });
                visit(node.children);
                continue;
            }
            const kind = node.type === TYPE.number || node.type === TYPE.plural ? 'number'
                : node.type === TYPE.date || node.type === TYPE.time ? 'date'
                    : node.type === TYPE.select ? 'select' : 'value';
            const choices = new Set(node.type === TYPE.select ? Object.keys(node.options).filter(key => key !== 'other') : []);
            mergeArgument(args, node.value, { kind, choices }, { ...context, ...node.location?.start });
            if (node.type === TYPE.select || node.type === TYPE.plural)
                for (const branch of Object.values(node.options))
                    visit(branch.value);
        }
    }
    visit(ast);
    return { id, locale, source, ast, args, emitted: undefined };
}
function typeOf(arg) {
    if (arg.kind === 'slot')
        return '(children: Array<string | $Node>) => $Node';
    if (arg.kind === 'number')
        return 'number';
    if (arg.kind === 'date')
        return 'Date | number';
    if (arg.kind === 'select')
        return [...[...arg.choices].sort().map(quote), '(string & {})'].join(' | ');
    return 'string | number';
}
const dateFormats = {
    short: { month: 'numeric', day: 'numeric', year: '2-digit' },
    medium: { month: 'short', day: 'numeric', year: 'numeric' },
    long: { month: 'long', day: 'numeric', year: 'numeric' },
    full: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
};
const timeFormats = {
    short: { hour: 'numeric', minute: 'numeric' },
    medium: { hour: 'numeric', minute: 'numeric', second: 'numeric' },
    long: { hour: 'numeric', minute: 'numeric', second: 'numeric', timeZoneName: 'short' },
    full: { hour: 'numeric', minute: 'numeric', second: 'numeric', timeZoneName: 'short' },
};
function formatOptions(node, message, options) {
    const kind = node.type === TYPE.number ? 'number' : node.type === TYPE.date ? 'date' : 'time';
    let resolved;
    if (typeof node.style === 'object' && node.style !== null)
        resolved = { ...node.style.parsedOptions };
    else if (node.style) {
        const custom = options.formats?.[kind];
        const defaults = kind === 'date' ? dateFormats : kind === 'time' ? timeFormats
            : { integer: { maximumFractionDigits: 0 }, percent: { style: 'percent' }, currency: { style: 'currency' } };
        if (custom && own(custom, node.style))
            resolved = { ...(own(defaults, node.style) ? defaults[node.style] : {}), ...custom[node.style] };
        else if (own(defaults, node.style))
            resolved = { ...defaults[node.style] };
        else
            fail('UNKNOWN_FORMAT', `Unknown ${kind} format ${quote(node.style)}. Declare it in formats.${kind}.`, { locale: message.locale, messageId: message.id, source: message.source, ...node.location?.start });
    }
    else
        resolved = kind === 'time' ? { ...timeFormats.medium } : {};
    if (kind !== 'number' && options.timeZone && !own(resolved, 'timeZone'))
        resolved.timeZone = options.timeZone;
    const scale = resolved.scale;
    delete resolved.scale;
    return { options: resolved, scale };
}
function formatterKey(kind, locale, options) {
    return optionKey([kind, locale, Object.entries(options).sort(([a], [b]) => compare(a, b))]);
}
function validateFormatter(kind, locale, opts, message) {
    try {
        if (kind === 'NumberFormat')
            new Intl.NumberFormat(locale, opts);
        else if (kind === 'DateTimeFormat')
            new Intl.DateTimeFormat(locale, opts);
        else
            new Intl.PluralRules(locale, opts);
    }
    catch (error) {
        fail('INVALID_FORMAT', error.message, { locale, messageId: message.id });
    }
}
function scopeIds(scope, patterns, ids, report, blocked) {
    function problem(code, message) {
        if (report)
            report({ code, message });
        else
            fail(code, message);
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(scope)) {
        problem('INVALID_SCOPE', `Invalid scope name ${quote(scope)}.`);
        return [];
    }
    if (!Array.isArray(patterns) || !patterns.length || patterns.some(p => typeof p !== 'string')) {
        problem('INVALID_SCOPE', `Scope ${quote(scope)} must contain message IDs or prefix patterns.`);
        return [];
    }
    const selected = new Set();
    for (const pattern of patterns) {
        const matches = ids.filter(id => pattern.endsWith('.*') ? id.startsWith(pattern.slice(0, -1)) : id === pattern);
        if (!matches.length && !blocked?.(pattern))
            problem('EMPTY_SCOPE_PATTERN', `Scope ${quote(scope)} pattern ${quote(pattern)} does not match any messages.`);
        for (const id of matches)
            selected.add(id);
    }
    return ids.filter(id => selected.has(id));
}
function argumentKey(args) {
    // Most contracts have no arguments or one unqualified argument. These keys
    // cannot collide with the JSON-array encoding used for compound contracts.
    if (!args.size)
        return '';
    if (args.size === 1) {
        const [name, arg] = args.entries().next().value;
        if (!arg.choices.size)
            return `${arg.kind}:${name}`;
    }
    return JSON.stringify([...args].map(([name, arg]) => [name, arg.kind, [...arg.choices].sort()]));
}
/** Distinct argument sets cannot share emitted code. Cached schemas preserve
 * argument identities, so compatible edit assemblies can reuse this filter. */
function factoryEligibility(messages, schema) {
    const counts = new Map();
    for (const message of messages)
        if (schema.get(message.id).size)
            counts.set(message.args, (counts.get(message.args) ?? 0) + 1);
    let eligible = null;
    for (const [args, count] of counts)
        if (count > 1) {
            eligible ??= new WeakSet();
            eligible.add(args);
        }
    return eligible;
}
function renderCatalog(messages, schema, options, memoKey, emissions, previous, eligible = null, validations) {
    const helpers = new Map();
    const intlLocales = new Map();
    // Direct, one-pass output never renumbers helpers. Only cached emissions and
    // template assembly need relocatable references and dependency sequences.
    const relocatable = emissions !== undefined || eligible !== null;
    let captured = [];
    let texts;
    let textBuffer;
    let lastFactory;
    let literalGrowth = 128;
    let literalInitializers;
    let literalParameters;
    function register(spec) {
        if (!helpers.has(spec.key))
            helpers.set(spec.key, { ...spec, id: `$f${helpers.size}` });
        return helpers.get(spec.key).id;
    }
    function formatter(kind, locale, opts, message) {
        // Validate statically known options during compilation, not on a user's first call.
        const key = formatterKey(kind, locale, opts);
        if (!helpers.has(key)) {
            validateFormatter(kind, locale, opts, message);
            register({ key, kind, locale, options: opts });
        }
        const spec = helpers.get(key);
        if (!relocatable)
            return spec.id;
        let index = captured.indexOf(spec);
        if (index < 0) {
            index = captured.length;
            captured.push(spec);
        }
        // JSON quoting escapes every control character in user text. Actual NULs
        // therefore only occur in these internal formatter references, never literals.
        return `\0${index}\0`;
    }
    function emitLiteralSelect(select) {
        let branches = '', fallback = '';
        for (const [key, branch] of select.branches) {
            let code;
            if ('branches' in branch)
                code = emitLiteralSelect(branch);
            else if (texts) {
                literalInitializers ??= [];
                literalParameters ??= new Map();
                const parameters = [];
                for (const text of branch.texts)
                    if (text.value) {
                        let parameter = literalParameters.get(text);
                        if (!parameter) {
                            texts.push(text.value);
                            parameter = `$s${texts.length - 1}`;
                            literalParameters.set(text, parameter);
                        }
                        parameters.push(parameter);
                    }
                code = `$c${literalInitializers.length}`;
                literalInitializers.push(parameters.join('+') || '""');
            }
            else
                code = quote(branch.texts.map(text => text.value).join(''));
            if (key === 'other')
                fallback = code;
            else
                branches += `case ${quote(key)}:return ${code};`;
        }
        return `(()=>{switch(p[${quote(select.value)}]){${branches}default:return ${fallback};}})()`;
    }
    function emit(nodes, message, pound) {
        function emitNode(node) {
            if (node.type === TYPE.literal) {
                if (texts && node.value) {
                    texts.push(node.value);
                    return `$s${texts.length - 1}`;
                }
                return quote(node.value);
            }
            if (node.type === TYPE.pound) {
                if (pound === undefined)
                    return quote('#');
                return `${formatter('NumberFormat', message.locale, {}, message)}(${pound})`;
            }
            if (node.type === TYPE.tag)
                throw new Error('Rich text reached the string emitter');
            const value = `p[${quote(node.value)}]`;
            switch (node.type) {
                case TYPE.argument: return value;
                case TYPE.number:
                case TYPE.date:
                case TYPE.time: {
                    const { options: opts, scale } = formatOptions(node, message, options);
                    return `${formatter(node.type === TYPE.number ? 'NumberFormat' : 'DateTimeFormat', message.locale, opts, message)}(${scale !== undefined ? `(${value}*${quote(scale)})` : value})`;
                }
                case TYPE.select: {
                    const branches = Object.entries(node.options).filter(([key]) => key !== 'other').map(([key, branch]) => `case ${quote(key)}:return ${emit(branch.value, message, pound)};`).join('');
                    return `(()=>{switch(${value}){${branches}default:return ${emit(node.options.other.value, message, pound)};}})()`;
                }
                case TYPE.plural: {
                    const count = node.offset ? `(${value}-${node.offset})` : value;
                    const exact = Object.entries(node.options).filter(([key]) => key.startsWith('=')).map(([key, branch]) => `if(${value}===${Number(key.slice(1))})return ${emit(branch.value, message, count)};`).join('');
                    const branches = Object.entries(node.options).filter(([key]) => key !== 'other' && !key.startsWith('=')).map(([key, branch]) => `case ${quote(key)}:return ${emit(branch.value, message, count)};`).join('');
                    const rule = formatter('PluralRules', message.locale, { type: node.pluralType }, message);
                    return `(()=>{${exact}switch(${rule}(${count})){${branches}default:return ${emit(node.options.other.value, message, count)};}})()`;
                }
            }
        }
        const parts = [];
        for (let index = 0; index < nodes.length; index++) {
            const node = nodes[index];
            const position = node.type === TYPE.literal ? index + 1 : index;
            const select = nodes[position];
            if ((node.type === TYPE.literal || node.type === TYPE.select) && select?.type === TYPE.select) {
                const prefix = node.type === TYPE.literal ? node : undefined;
                const after = nodes[position + 1];
                const suffix = after?.type === TYPE.literal ? after : undefined;
                // Removing all concatenation from this text segment is consistently
                // useful; partial folding regresses some engines and remains unchanged.
                const complete = index === 0 && position + 1 + Number(!!suffix) === nodes.length;
                const folded = complete && (prefix?.value || suffix?.value) && foldLiteralSelect(select, prefix, suffix, literalGrowth);
                if (folded) {
                    literalGrowth -= folded.growth;
                    parts.push(emitLiteralSelect(folded.select));
                    index = position + Number(after?.type === TYPE.literal);
                    continue;
                }
            }
            parts.push(emitNode(node));
        }
        return ['""', ...parts].join('+');
    }
    function hasTags(node) {
        return node.type === TYPE.tag || ((node.type === TYPE.select || node.type === TYPE.plural)
            && Object.values(node.options).some(branch => branch.value.some(hasTags)));
    }
    function emitRich(nodes, message, pound) {
        const parts = [];
        let text = [];
        const flush = () => {
            if (text.length) {
                parts.push({ code: emit(text, message, pound), spread: false });
                text = [];
            }
        };
        for (const node of nodes) {
            if (!hasTags(node)) {
                text.push(node);
                continue;
            }
            flush();
            if (node.type === TYPE.tag) {
                parts.push({ code: `p[${quote(node.value)}](${emitRich(node.children, message, pound)})`, spread: false });
            }
            else if (node.type === TYPE.select) {
                const value = `p[${quote(node.value)}]`;
                const branches = Object.entries(node.options).filter(([key]) => key !== 'other')
                    .map(([key, branch]) => `case ${quote(key)}:return ${emitRich(branch.value, message, pound)};`).join('');
                parts.push({ code: `(()=>{switch(${value}){${branches}default:return ${emitRich(node.options.other.value, message, pound)};}})()`, spread: true });
            }
            else if (node.type === TYPE.plural) {
                const value = `p[${quote(node.value)}]`, count = node.offset ? `(${value}-${node.offset})` : value;
                const exact = Object.entries(node.options).filter(([key]) => key.startsWith('='))
                    .map(([key, branch]) => `if(${value}===${Number(key.slice(1))})return ${emitRich(branch.value, message, count)};`).join('');
                const branches = Object.entries(node.options).filter(([key]) => key !== 'other' && !key.startsWith('='))
                    .map(([key, branch]) => `case ${quote(key)}:return ${emitRich(branch.value, message, count)};`).join('');
                const rule = formatter('PluralRules', message.locale, { type: node.pluralType }, message);
                parts.push({ code: `(()=>{${exact}switch(${rule}(${count})){${branches}default:return ${emitRich(node.options.other.value, message, count)};}})()`, spread: true });
            }
        }
        flush();
        if (parts.length === 1 && parts[0].spread)
            return parts[0].code;
        const array = `[${parts.map(part => `${part.spread ? '...' : ''}${part.code}`).join(',')}]`;
        return parts.length > 1 ? `$parts(${array})` : array;
    }
    function messageEmission(message) {
        const args = schema.get(message.id);
        let emitted = message.emitted;
        const templateEligible = !!args.size && !!eligible?.has(message.args);
        if (memoKey === undefined || !emitted || emitted.options !== memoKey || emitted.args !== args || emitted.templateEligible !== templateEligible) {
            captured = [];
            literalGrowth = 128;
            literalInitializers = undefined;
            literalParameters = undefined;
            texts = templateEligible ? (textBuffer ??= new TextBuffer()).reset() : undefined;
            let checks = '';
            if (options.development && args.size) {
                const context = `${message.locale}:${message.id}`;
                if (texts)
                    texts.push(context);
                const shared = texts ? validations.get(args) : undefined;
                if (shared !== undefined)
                    checks = shared;
                else {
                    const errorPrefix = texts ? '$s0+' : '', errorContext = texts ? '' : context;
                    checks = `if(!p||typeof p!=="object")throw new TypeError(${errorPrefix}${quote(errorContext + ': expected message arguments')});`;
                    for (const [key, arg] of args) {
                        const quoted = quote(key), value = `p[${quoted}]`;
                        const test = arg.kind === 'slot' ? `typeof ${value}!=="function"` : arg.kind === 'number' ? `typeof ${value}!=="number"`
                            : arg.kind === 'date' ? `(typeof ${value}!=="number"&&!(${value} instanceof Date))`
                                : arg.kind === 'select' ? `typeof ${value}!=="string"`
                                    : `(typeof ${value}!=="string"&&typeof ${value}!=="number")`;
                        checks += `if(!Object.hasOwn(p,${quoted})||${test})throw new TypeError(${errorPrefix}${quote(`${errorContext}: argument ${quoted} must be ${arg.kind === 'slot' ? 'a slot function' : arg.kind === 'value' ? 'string or number' : arg.kind === 'date' ? 'Date or number' : arg.kind === 'select' ? 'string' : 'number'}`)});`;
                    }
                    // Shared bodies retain the label as a parameter; build their common
                    // checks once per contract. Unique contracts allocate no extra plan.
                    if (texts)
                        validations.set(args, checks);
                }
            }
            let ast = message.ast;
            if (!ast) {
                let locale = intlLocales.get(message.locale);
                if (!locale) {
                    locale = new Intl.Locale(message.locale);
                    intlLocales.set(message.locale, locale);
                }
                ast = parse(message.source, { captureLocation: true, shouldParseSkeletons: true, locale });
            }
            // Share code for plain text while retaining a distinct closure/value per
            // message. Pure calls still let bundlers discard unused named exports.
            const literal = !args.size && ast.every(node => node.type === TYPE.literal);
            let rich = false;
            for (const arg of args.values())
                if (arg.kind === 'slot') {
                    rich = true;
                    break;
                }
            const expression = literal ? quote(ast.map(node => node.type === TYPE.literal ? node.value : '').join('')) : rich ? emitRich(ast, message) : emit(ast, message);
            emitted = { options: memoKey ?? '', args, body: literal ? `/*#__PURE__*/$literal(${expression})`
                    : `(${args.size ? 'p' : ''})=>${checks ? `{${checks}return ${expression};}` : expression}`, helpers: captured, rich, templateEligible };
            // emit()/emitRich() may populate this closure state.
            const initializers = literalInitializers;
            if (initializers?.length) {
                // Preserve original text arguments in shared factories; build complete
                // branch strings once when each message closure is initialized.
                emitted.body = `(()=>{${initializers.map((code, i) => `const $c${i}=${code};`).join('')}return ${emitted.body};})()`;
            }
            if (texts?.length) {
                // Adjacent messages often have the same template. Avoid rebuilding its
                // serialized key; helper identity and map membership protect changes
                // in formatter options and a patch that restarts full assembly.
                let factory = lastFactory;
                if (!factory || factory.body !== emitted.body || factory.parameters !== texts.length
                    || !sameItems(captured, factory.dependencies) || helpers.get(factory.key) !== factory) {
                    const key = 'Factory:' + JSON.stringify([emitted.body, captured.map(helper => helper.key)]);
                    if (!helpers.has(key))
                        register({ key, kind: 'Factory', body: emitted.body, parameters: texts.length, dependencies: captured });
                    factory = helpers.get(key);
                }
                lastFactory = factory;
                emitted.body = factory.body;
                emitted.helpers = captured.concat(factory);
                emitted.texts = texts.slice();
            }
            texts = undefined;
            if (memoKey !== undefined) {
                message.emitted = emitted;
                message.ast = undefined;
            }
        }
        if (emissions) {
            const bytes = (emitted.body.length + (emitted.texts?.reduce((sum, text) => sum + text.length, 0) ?? 0)) * 2 + emitted.helpers.length * 32 + 160;
            emissions.bytes += bytes - (emissions.entries.get(message) ?? 0);
            emissions.entries.delete(message);
            emissions.entries.set(message, bytes);
        }
        return emitted;
    }
    const literalPrefix = '/*#__PURE__*/$literal(';
    function bodyFor(emitted, names, factories) {
        if (!relocatable)
            return emitted.body;
        if (emitted.texts && factories.get(emitted.helpers.at(-1).key) > 1) {
            return `/*#__PURE__*/${names.at(-1)}(${emitted.texts.map(quote).join(',')})`;
        }
        const body = emitted.texts ? substituteTextParameters(emitted.body, emitted.texts) : emitted.body;
        return body.replace(/\0(\d+)\0/g, (_, i) => names[Number(i)]);
    }
    function definition(message, index, body) {
        const name = `$m${index}`;
        // Keep loader collisions and invalid export names on the default catalog.
        const exported = namedMessage(message.id)
            ? `export {${name} as ${quote(message.id)}};\n` : '';
        return `const ${name}=${body};\n${exported}`;
    }
    function renderPrefix(literals, rich, factories) {
        // Number/date accessors return bound functions; generated code caches them.
        // Run literal initialization in the factory's existing scope. The cached
        // expression form remains available for inlining one-off selections.
        const prelude = [...helpers.values()].filter(h => h.kind !== 'Factory' || factories.get(h.key) > 1).map(h => h.kind === 'Factory'
            ? `const ${h.id}=(${Array.from({ length: h.parameters }, (_, i) => `$s${i}`).join(',')})=>${(h.body.startsWith('(()=>{const $c') ? h.body.slice(5, -3) : h.body).replace(/\0(\d+)\0/g, (_, i) => helpers.get(h.dependencies[Number(i)].key).id)};`
            : h.kind === 'PluralRules'
                ? `let ${h.id}Cache;const ${h.id}=v=>(${h.id}Cache??=new Intl.PluralRules(${quote(h.locale)},${quote(h.options)})).select(v);`
                : `let ${h.id}Cache;const ${h.id}=v=>(${h.id}Cache??=new Intl.${h.kind}(${quote(h.locale)},${quote(h.options)}).format)(v);`);
        if (literals)
            prelude.unshift('const $literal=value=>()=>value;');
        if (rich)
            prelude.unshift('const $parts=values=>{let length=0;for(const value of values){if(typeof value==="string"&&length&&typeof values[length-1]==="string")values[length-1]+=value;else values[length++]=value;}values.length=length;return values;};');
        return header + (prelude.length ? prelude.join('\n') + '\n' : '');
    }
    function patch() {
        const layout = previous?.assembly;
        if (!previous || !layout)
            return;
        const changed = [];
        for (let i = 0; i < messages.length; i++)
            if (messages[i] !== previous.messages[i]) {
                changed.push(i);
                // Keep bulk changes on the full emitter; normal typing changes few IDs.
                if (changed.length > 64)
                    return;
            }
        if (!changed.length)
            return previous;
        for (const spec of layout.formatters)
            register(spec);
        const emittedChanges = [];
        let dependenciesChanged = false, literals = layout.literals;
        let factories = layout.factories;
        for (const index of changed) {
            const emitted = messageEmission(messages[index]);
            const sequence = layout.sequences[layout.signatures[index]];
            const oldFactory = sequence.at(-1)?.kind === 'Factory' ? sequence.at(-1).key : undefined;
            const nextFactory = emitted.texts ? emitted.helpers.at(-1).key : undefined;
            if (oldFactory !== nextFactory) {
                if (factories === layout.factories)
                    factories = new Map(factories);
                const counts = factories;
                if (oldFactory) {
                    const count = counts.get(oldFactory) - 1;
                    if (count)
                        counts.set(oldFactory, count);
                    else
                        counts.delete(oldFactory);
                }
                if (nextFactory)
                    counts.set(nextFactory, (counts.get(nextFactory) ?? 0) + 1);
            }
            if (sequence.length !== emitted.helpers.length || sequence.some((spec, i) => spec.key !== emitted.helpers[i].key))
                dependenciesChanged = true;
            const wasLiteral = previous.code.startsWith(literalPrefix, layout.prefix + layout.offsets[index] + `const $m${index}=`.length);
            literals += Number(emitted.body.startsWith(literalPrefix)) - Number(wasLiteral);
            emittedChanges.push(emitted);
        }
        // A one/two-use transition also changes an otherwise unchanged definition.
        // Reassemble that uncommon case; ordinary edits only replace literal data.
        if (factories !== layout.factories)
            for (const [key, count] of factories) {
                const old = layout.factories.get(key) ?? 0;
                if ((old === 1 && count > 1) || (old > 1 && count === 1)) {
                    helpers.clear();
                    return;
                }
            }
        let signatures = layout.signatures, sequences = layout.sequences;
        const renamedSequences = new Set();
        const renames = new Map();
        if (dependenciesChanged) {
            // Rebuild canonical first-use order from the current sequences. Process
            // each unchanged signature once, without visiting every helper per ID.
            helpers.clear();
            signatures = new Uint32Array(messages.length);
            const compact = [];
            const sequenceIds = new Map();
            const mapped = new Uint32Array(layout.sequences.length);
            const intern = (sequence) => {
                const key = sequence.map(register).join(',');
                let id = sequenceIds.get(key);
                if (id === undefined) {
                    id = compact.length;
                    sequenceIds.set(key, id);
                    compact.push(sequence);
                }
                return id;
            };
            let change = 0;
            for (let index = 0; index < messages.length; index++) {
                if (changed[change] === index)
                    signatures[index] = intern(emittedChanges[change++].helpers);
                else {
                    const old = layout.signatures[index];
                    if (!mapped[old])
                        mapped[old] = intern(layout.sequences[old]) + 1;
                    signatures[index] = mapped[old] - 1;
                }
            }
            // Compact on dependency changes so removed styles/sequences cannot
            // accumulate through a long watch session. These hold no prior source.
            sequences = compact;
            for (let i = 0; i < layout.formatters.length; i++) {
                const name = helpers.get(layout.formatters[i].key)?.id;
                if (name !== undefined && name !== `$f${i}`)
                    renames.set(`$f${i}`, name);
            }
            if (renames.size) {
                const oldNames = new Map(layout.formatters.map((spec, i) => [spec.key, `$f${i}`]));
                for (let i = 0; i < mapped.length; i++)
                    if (mapped[i]
                        && layout.sequences[i].some(spec => renames.has(oldNames.get(spec.key))))
                        renamedSequences.add(i);
            }
        }
        const prefix = dependenciesChanged || literals !== layout.literals ? renderPrefix(literals, layout.rich, factories) : previous.code.slice(0, layout.prefix);
        const pieces = [prefix];
        const offsets = new Uint32Array(layout.offsets.length);
        let cursor = layout.prefix, delta = 0, change = 0;
        for (let index = 0; index < messages.length; index++) {
            offsets[index] = layout.offsets[index] + delta;
            let replacement;
            if (changed[change] === index) {
                const emitted = emittedChanges[change++];
                replacement = definition(messages[index], index, bodyFor(emitted, emitted.helpers.map(register), factories));
            }
            else if (renamedSequences.has(layout.signatures[index])) {
                replacement = rewriteGeneratedIdentifiers(previous.code.slice(layout.prefix + layout.offsets[index], layout.prefix + layout.offsets[index + 1]), name => renames.get(name) ?? name);
            }
            if (replacement !== undefined) {
                const start = layout.prefix + layout.offsets[index], end = layout.prefix + layout.offsets[index + 1];
                pieces.push(previous.code.slice(cursor, start), replacement);
                cursor = end;
                delta += replacement.length - (end - start);
            }
        }
        offsets[messages.length] = layout.offsets[messages.length] + delta;
        pieces.push(previous.code.slice(cursor));
        // Join into one current module; do not retain a chain of prior fragments
        // in the assembly metadata. Formatter sequences are immutable and shared.
        return { code: pieces.join(''), assembly: { prefix: prefix.length, literals, rich: layout.rich, offsets, signatures, sequences,
                formatters: dependenciesChanged ? [...helpers.values()] : layout.formatters, factories } };
    }
    const patched = patch();
    if (patched) {
        if (emissions)
            trimEmissions(emissions);
        return patched;
    }
    const code = [];
    const entries = [];
    const offsets = emissions ? new Uint32Array(messages.length + 1) : undefined;
    const signatures = emissions ? new Uint32Array(messages.length) : undefined;
    const sequenceIds = new Map();
    const sequences = [];
    const emittedMessages = eligible ? messages.map(messageEmission) : undefined;
    const factories = new Map();
    for (const emitted of emittedMessages ?? [])
        if (emitted.texts) {
            const key = emitted.helpers.at(-1).key;
            factories.set(key, (factories.get(key) ?? 0) + 1);
        }
    // Parsing/validation above may register helpers ahead of their final first-use
    // order. Rebuild that order consistently with the incremental sequence path.
    if (emittedMessages)
        helpers.clear();
    let literals = 0, rich = 0;
    messages.forEach((message, index) => {
        const name = `$m${index}`;
        const emitted = emittedMessages?.[index] ?? messageEmission(message);
        // Register in original emission order, which can differ from source order
        // for nested plural branches. Incremental and cold output stay identical.
        const names = emitted.helpers.map(register);
        const body = bodyFor(emitted, names, factories);
        if (body.startsWith(literalPrefix))
            literals++;
        if (emitted.rich)
            rich++;
        const section = definition(message, index, body);
        code.push(section);
        if (offsets && signatures) {
            offsets[index + 1] = offsets[index] + section.length;
            const key = names.join(',');
            let signature = sequenceIds.get(key);
            if (signature === undefined) {
                signature = sequences.length;
                sequenceIds.set(key, signature);
                sequences.push(emitted.helpers);
            }
            signatures[index] = signature;
        }
        entries.push(`[${quote(message.id)}]:${name}`);
    });
    const prefix = renderPrefix(literals, rich, factories);
    const suffix = `const messages={__proto__:null,${entries.join(',')}};export default messages;\n`;
    if (emissions)
        trimEmissions(emissions);
    return { code: [prefix, ...code, suffix].join(''), assembly: offsets && signatures
            ? { prefix: prefix.length, literals, rich, offsets, signatures, sequences, formatters: [...helpers.values()], factories } : undefined };
}
// All locales have the same merged argument contract. Declare it once per
// group so TypeScript does not have to parse an identical copy for every locale.
function renderTypes(ids, schema, namedOnly = false) {
    const declarations = [];
    const properties = [];
    ids.forEach((id, index) => {
        const name = `$m${index}`;
        const args = schema.get(id);
        const rich = [...args.values()].some(arg => arg.kind === 'slot');
        const signature = args.size ? `${rich ? '<$Node>' : ''}(args: { ${[...args].map(([key, arg]) => `readonly ${quote(key)}: ${typeOf(arg)}`).join('; ')} }) => ${rich ? 'Array<string | $Node>' : 'string'}` : '() => string';
        declarations.push(`declare const ${name}: ${signature};`);
        if (namedOnly || namedMessage(id))
            declarations.push(`export {${name} as ${quote(id)}};`);
        if (!namedOnly)
            properties.push(`readonly ${quote(id)}: typeof ${name}`);
    });
    // Short property lines keep declaration-map navigation efficient in large
    // catalogs and make the declarations readable when source files are absent.
    if (!namedOnly)
        declarations.push(`declare const messages: {\n${properties.map(property => `  ${property};`).join('\n')}\n};\nexport default messages;`);
    return header + declarations.join('\n') + '\n';
}
function renderTypeFiles(ids, schema) {
    const groups = declarationGroups('index.js', ids).map(group => ({ ...group,
        namedOnly: ids.length > group.ids.length && !group.ids.some(id => unpairedSurrogate.test(id)),
    }));
    const files = Object.create(null);
    for (const group of groups)
        files[group.file] = renderTypes(group.ids, schema, group.namedOnly);
    if (groups[0].file !== 'messages.d.ts') {
        const imports = groups.map(group => quote('./' + group.file.replace(/\.d\.ts$/, '.js')));
        // Most private type modules describe IDs as exports, avoiding duplicate
        // properties. A group containing an invalid export name uses a default
        // object instead, preserving every key and its declaration-map location.
        // Only public-safe names are re-exported from either representation.
        // Flatten once instead of resolving each property through an intersection.
        // The mapped object keeps Record compatibility and explicit readonly keys.
        files['messages.d.ts'] = header + groups.map((group, i) => {
            const names = group.ids.filter(namedMessage);
            return names.length ? `export {${names.map(quote).join(',')}} from ${imports[i]};` : '';
        }).join('\n')
            + '\n' + imports.map((path, i) => `type $T${i} = typeof import(${path})${groups[i].namedOnly ? '' : '.default'};`).join('\n')
            + `\ninterface $Messages extends ${imports.map((_, i) => `$T${i}`).join(', ')} {}\n`
            + 'declare const messages: { readonly [Key in keyof $Messages]: $Messages[Key] };\nexport default messages;\n';
    }
    return files;
}
function renderLoader(locales, baseLocale) {
    return {
        js: header + `export const locales=Object.freeze(${quote(locales)});\nexport const baseLocale=${quote(baseLocale)};\nconst loaders={__proto__:null,${locales.map(locale => `[${quote(locale)}]:()=>import(${quote(`./locales/${locale}.js`)})`).join(',')}};\nexport async function loadLocale(locale){const load=loaders[locale];if(!load)throw new RangeError("Unsupported locale: "+String(locale));const module=await load();return {locale,messages:module.default};}\nexport function selectMessages(...keys){if(!keys.length||keys.some(key=>typeof key!=="string"))throw new TypeError("selectMessages requires message IDs");const cache=new Map();return async locale=>{const loaded=await loadLocale(locale);let messages=cache.get(locale);if(!messages){messages=Object.create(null);for(const key of keys){if(!Object.hasOwn(loaded.messages,key))throw new RangeError("Unknown message: "+key);messages[key]=loaded.messages[key];}cache.set(locale,messages);}return {locale,messages};};}\n`,
        dts: header + `export declare const locales: readonly [${locales.map(quote).join(', ')}];\nexport type Locale = typeof locales[number];\nexport declare const baseLocale: ${quote(baseLocale)};\nexport type Messages = typeof import(${quote(`./locales/${baseLocale}.js`)}).default;\nexport interface LoadedLocale { readonly locale: Locale; readonly messages: Messages }\nexport declare function loadLocale(locale: Locale): Promise<LoadedLocale>;\nexport interface LoadedSelection<Key extends keyof Messages> { readonly locale: Locale; readonly messages: Pick<Messages, Key> }\nexport declare function selectMessages<const Keys extends readonly [keyof Messages, ...(keyof Messages)[]]>(...keys: Keys): (locale: Locale) => Promise<LoadedSelection<Keys[number]>>;\n`,
    };
}
/** Project compiler-owned definitions with only their required helpers.
 * Local names keep output stable when unrelated messages or formatters move.
 */
export function compileSelection(project, entry, locale, keys) {
    const ids = project.groups[entry];
    if (!ids || !project.locales.includes(locale))
        fail('INVALID_SELECTION', 'Unknown loader or locale.');
    const names = new Map(ids.map((id, i) => [id, i]));
    for (const key of keys)
        if (!names.has(key))
            fail('UNKNOWN_MESSAGE', `Unknown selected message ${quote(key)}.`, { locale });
    const file = entry.slice(0, -'index.js'.length) + `locales/${locale}.js`;
    return new Projection(project.files[file], names).compile(keys);
}
/** Validate independent messages without emitting code or retaining their ASTs.
 * Invalid messages/subtrees suppress dependent contract errors, while other
 * catalogs continue to be checked. ICU parsing stops at its first error per message.
 */
export function checkProject(options) {
    const errors = [], warnings = [];
    const report = diagnostic => { errors.push(diagnostic); };
    function attempt(work) {
        try {
            return work();
        }
        catch (error) {
            if (!(error instanceof CompileError))
                throw error;
            errors.push(...error.diagnostics);
        }
    }
    function blockedBy(paths, id) {
        if (paths.has('') || paths.has(id))
            return true;
        for (let end = id.indexOf('.'); end >= 0; end = id.indexOf('.', end + 1))
            if (paths.has(id.slice(0, end)))
                return true;
        return false;
    }
    const locales = Object.keys(options.catalogs).sort();
    const schema = new Map();
    let base = new Map();
    const baseBlocked = new Set();
    let messageCount = 0;
    if (!own(options.catalogs, options.baseLocale)) {
        report({ code: 'BASE_LOCALE_MISSING', message: `No catalog for base locale ${quote(options.baseLocale)}.` });
        baseBlocked.add('');
    }
    // Validation caches are local to this call. Each known Intl configuration is
    // constructed once, including failures; no formatter objects are retained.
    const formats = new Map();
    function checkFormats(message) {
        function formatter(kind, opts, node) {
            const key = formatterKey(kind, message.locale, opts);
            if (!formats.has(key)) {
                try {
                    validateFormatter(kind, message.locale, opts, message);
                    formats.set(key, undefined);
                }
                catch (error) {
                    if (!(error instanceof CompileError))
                        throw error;
                    formats.set(key, error.diagnostics[0].message);
                }
            }
            const invalid = formats.get(key);
            if (invalid)
                report({ code: 'INVALID_FORMAT', message: invalid, locale: message.locale, messageId: message.id, source: message.source, ...node.location?.start });
        }
        function visit(nodes, pound = false) {
            for (const node of nodes) {
                if (node.type === TYPE.number || node.type === TYPE.date || node.type === TYPE.time) {
                    const resolved = attempt(() => formatOptions(node, message, options));
                    if (resolved)
                        formatter(node.type === TYPE.number ? 'NumberFormat' : 'DateTimeFormat', resolved.options, node);
                }
                else if (node.type === TYPE.plural) {
                    formatter('PluralRules', { type: node.pluralType }, node);
                    for (const branch of Object.values(node.options))
                        visit(branch.value, true);
                }
                else if (node.type === TYPE.select) {
                    for (const branch of Object.values(node.options))
                        visit(branch.value, pound);
                }
                else if (node.type === TYPE.tag)
                    visit(node.children, pound);
                else if (node.type === TYPE.pound && pound)
                    formatter('NumberFormat', {}, node);
            }
        }
        visit(message.ast);
    }
    const ordered = own(options.catalogs, options.baseLocale) ? [options.baseLocale, ...locales.filter(locale => locale !== options.baseLocale)] : locales;
    for (const locale of ordered) {
        const isBase = locale === options.baseLocale;
        if (!attempt(() => { validateLocale(locale); return true; })) {
            if (isBase)
                baseBlocked.add('');
            continue;
        }
        const blocked = isBase ? baseBlocked : new Set();
        const ambiguous = new Set();
        const flat = flatten(options.catalogs[locale], locale, diagnostic => {
            report(diagnostic);
            blocked.add(diagnostic.messageId ?? '');
            if (diagnostic.code === 'DUPLICATE_KEY')
                ambiguous.add(diagnostic.messageId);
        });
        if (isBase)
            base = flat;
        const intlLocale = new Intl.Locale(locale);
        for (const [id, source] of [...flat].sort(([a], [b]) => compare(a, b))) {
            messageCount++;
            if (ambiguous.has(id))
                continue;
            const message = attempt(() => readMessage(id, source, locale, intlLocale));
            if (!message)
                continue;
            checkFormats(message);
            if (isBase) {
                schema.set(id, message.args);
                continue;
            }
            if (!base.has(id)) {
                if (!blockedBy(baseBlocked, id))
                    report({ code: 'UNKNOWN_MESSAGE', message: 'This key does not exist in the base catalog.', locale, messageId: id });
                continue;
            }
            const contract = schema.get(id);
            if (!contract)
                continue;
            for (const [name, arg] of message.args) {
                if (!contract.has(name))
                    report({ code: 'UNKNOWN_ARGUMENT', message: `Translation introduces ${quote(name)}, which is absent from the base message.`, ...argumentContext(message, name) });
                else
                    attempt(() => mergeArgument(contract, name, arg, { locale, messageId: id }, message));
            }
        }
        if (!isBase)
            for (const id of base.keys())
                if (!flat.has(id) && !blockedBy(blocked, id)) {
                    if (options.missing === 'error')
                        report({ code: 'MISSING_MESSAGE', message: 'Translation is missing.', locale, messageId: id });
                    else
                        warnings.push({ code: 'FALLBACK_MESSAGE', message: `Using the ${options.baseLocale} message and formatting locale.`, locale, messageId: id });
                }
    }
    for (const [scope, patterns] of Object.entries(options.scopes ?? {})) {
        scopeIds(scope, patterns, [...base.keys()], report, pattern => {
            if (!pattern.endsWith('.*'))
                return blockedBy(baseBlocked, pattern);
            const prefix = pattern.slice(0, -2);
            return blockedBy(baseBlocked, prefix) || [...baseBlocked].some(path => path.startsWith(prefix + '.'));
        });
    }
    // Locale/key order is stable regardless of input object insertion order.
    const order = (a, b) => compare(a.locale ?? '', b.locale ?? '') || compare(a.messageId ?? '', b.messageId ?? '') || (a.offset ?? -1) - (b.offset ?? -1) || compare(a.code, b.code) || compare(a.message, b.message);
    errors.sort(order);
    warnings.sort(order);
    return { ok: errors.length === 0, errors, warnings, locales, messageCount };
}
/** Compile all catalogs in memory. Generated modules have no runtime dependencies. */
export function compileProject(options) {
    return compile(options).project;
}
/** Keep one project's message bodies between builds, without retaining parser ASTs.
 * Inputs may be mutated between calls. Failed compilations never replace the
 * last successful schema or catalog snapshot. Drop the function to release it.
 */
export function createCompiler(cacheOptions = {}) {
    const limit = cacheOptions.maxMessageCacheBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(limit) || limit < 0)
        throw new RangeError('maxMessageCacheBytes must be a nonnegative safe integer.');
    const emissions = { entries: new Map(), bytes: 0, limit };
    let previous;
    return options => {
        const retired = [];
        let committed = false;
        try {
            const result = compile(options, previous, emissions, retired);
            previous = result.state;
            committed = true;
            // Callers may change returned metadata without corrupting the private cache.
            return { ...result.project, locales: [...result.project.locales],
                groups: Object.assign(Object.create(null), Object.fromEntries(Object.entries(result.project.groups).map(([entry, ids]) => [entry, [...ids]]))),
                warnings: result.project.warnings.map(warning => ({ ...warning })) };
        }
        finally {
            // Failed format validation can stop midway through a large catalog. Keep
            // the budget and release failed/removed inputs on that path as well.
            trimEmissions(emissions);
            if (committed)
                for (const message of retired)
                    forgetEmission(emissions, message);
            else
                for (const message of emissions.entries.keys()) {
                    if (previous?.parsed.get(message.locale)?.get(message.id) !== message)
                        forgetEmission(emissions, message);
                }
        }
    };
}
function compile(options, previous, emissionCache, retired) {
    const incremental = emissionCache !== undefined;
    let argumentPool = previous?.argumentPool ?? new Map();
    const argumentKeys = previous?.argumentKeys ?? new WeakMap();
    const emissions = emissionCache ?? { entries: new Map(), bytes: 0, limit: 0 };
    function intern(args) {
        const key = (incremental ? argumentKeys.get(args) : undefined) ?? argumentKey(args);
        const existing = argumentPool.get(key);
        if (existing)
            return existing;
        // Ordinary text/style edits keep the existing contracts. Copy only when
        // adding one, so a failed attempt never mutates the successful pool.
        if (argumentPool === previous?.argumentPool)
            argumentPool = new Map(argumentPool);
        argumentPool.set(key, args);
        if (incremental)
            argumentKeys.set(args, key);
        return args;
    }
    const locales = Object.keys(options.catalogs).sort();
    if (!locales.length || !own(options.catalogs, options.baseLocale))
        fail('BASE_LOCALE_MISSING', `No catalog for base locale ${quote(options.baseLocale)}.`);
    for (const locale of locales)
        validateLocale(locale);
    const parsed = new Map();
    const inputs = new Map();
    let sameContract = previous !== undefined && previous.baseLocale === options.baseLocale && previous.missing === options.missing && previous.parsed.size === locales.length;
    for (const locale of locales) {
        const catalog = options.catalogs[locale];
        const old = previous?.parsed.get(locale);
        const snapshot = previous?.inputs.get(locale);
        if (snapshot?.catalog === catalog) {
            parsed.set(locale, old);
            inputs.set(locale, snapshot);
            continue;
        }
        const reusable = incremental && isCatalogSnapshot(catalog);
        const comparison = { messages: old, unchanged: old !== undefined };
        const flat = flatten(catalog, locale, undefined, comparison);
        if (old && comparison.unchanged && old.size === flat.size) {
            // Validation still traverses mutable input, including duplicate IDs and
            // cycles. Equal source content can retain the sorted parsed table and
            // its message identities without another sort or replacement map.
            parsed.set(locale, old);
            if (reusable) {
                let unchangedContracts = snapshot?.arguments;
                if (!unchangedContracts) {
                    unchangedContracts = new Set();
                    for (const message of old.values())
                        unchangedContracts.add(message.args);
                }
                inputs.set(locale, { catalog, arguments: unchangedContracts });
            }
            continue;
        }
        const contracts = reusable ? new Set() : undefined;
        const intlLocale = new Intl.Locale(locale);
        let matched = 0;
        const messages = new Map([...flat].sort(([a], [b]) => compare(a, b)).map(([id, entry]) => {
            const cached = typeof entry === 'string' ? old?.get(id) : entry;
            const message = typeof entry === 'string' ? readMessage(id, entry, locale, intlLocale) : entry;
            if (message !== cached)
                message.args = intern(message.args);
            contracts?.add(message.args);
            if (cached) {
                matched++;
                if (message !== cached)
                    retired?.push(cached);
            }
            if (!cached || message.args !== cached.args)
                sameContract = false;
            return [id, message];
        }));
        if (old?.size !== messages.size)
            sameContract = false;
        // Only key removal needs a second pass over the previous locale. Ordinary
        // edits retire their replaced message while comparing source text above.
        if (retired && old && matched !== old.size) {
            for (const [id, message] of old)
                if (!messages.has(id))
                    retired.push(message);
        }
        parsed.set(locale, messages);
        if (contracts)
            inputs.set(locale, { catalog, arguments: contracts });
    }
    if (retired && previous)
        for (const [locale, messages] of previous.parsed) {
            if (!parsed.has(locale))
                for (const message of messages.values())
                    retired.push(message);
        }
    const base = parsed.get(options.baseLocale);
    const schema = sameContract ? previous.schema : new Map();
    const warnings = sameContract ? previous.warnings : [];
    if (!sameContract) {
        // Parsed contracts are immutable and already interned. Most translations
        // share them exactly; copy a contract only when cross-locale merging needs
        // a distinct map, so unrelated messages never mutate each other's types.
        for (const [id, message] of base)
            schema.set(id, message.args);
        const merged = new Set();
        for (const locale of locales) {
            if (locale === options.baseLocale)
                continue;
            const messages = parsed.get(locale);
            for (const [id, message] of messages) {
                let contract = schema.get(id);
                if (!contract)
                    fail('UNKNOWN_MESSAGE', 'This key does not exist in the base catalog.', { locale, messageId: id });
                if (message.args === contract || !message.args.size)
                    continue;
                if (!merged.has(id)) {
                    contract = new Map([...contract].map(([name, arg]) => [name, { kind: arg.kind, choices: new Set(arg.choices) }]));
                    schema.set(id, contract);
                    merged.add(id);
                }
                for (const [name, arg] of message.args) {
                    if (!contract.has(name))
                        fail('UNKNOWN_ARGUMENT', `Translation introduces ${quote(name)}, which is absent from the base message.`, argumentContext(message, name));
                    mergeArgument(contract, name, arg, { locale, messageId: id }, message);
                }
            }
            for (const [id, message] of base)
                if (!messages.has(id)) {
                    if (options.missing === 'error')
                        fail('MISSING_MESSAGE', 'Translation is missing.', { locale, messageId: id });
                    warnings.push({ code: 'FALLBACK_MESSAGE', message: `Using the ${options.baseLocale} message and formatting locale.`, locale, messageId: id });
                }
        }
        for (const id of merged)
            schema.set(id, intern(schema.get(id)));
        if (previous) {
            // Schema changes can remove parsed or merged contracts. Retain only the
            // current project's contracts; unchanged schemas reuse the pool directly.
            const active = new Map();
            const retain = (args) => active.set(argumentKeys.get(args), args);
            for (const [locale, messages] of parsed) {
                const snapshot = inputs.get(locale);
                if (snapshot)
                    for (const args of snapshot.arguments)
                        retain(args);
                else
                    for (const message of messages.values())
                        retain(message.args);
            }
            for (const args of schema.values())
                retain(args);
            argumentPool = active;
        }
    }
    const files = Object.create(null);
    const groups = Object.create(null);
    const outputs = new Map();
    const types = new Map();
    const eligibility = new Map();
    let eligibilityReference;
    const memoKey = incremental ? optionKey([!!options.development, options.timeZone, options.formats]) : undefined;
    // Compilation-local only: unchanged emissions need no validation work, and
    // sessions do not retain another growing cache of old contracts.
    const validations = options.development ? new Map() : undefined;
    function group(prefix, ids) {
        const oldType = previous?.types.get(prefix);
        if (oldType && sameItems(ids, oldType.ids))
            ids = oldType.ids;
        groups[`${prefix}index.js`] = ids;
        const typeFiles = oldType?.schema === schema && ids === oldType.ids ? oldType.files : renderTypeFiles(ids, schema);
        for (const [name, code] of Object.entries(typeFiles))
            files[prefix + name] = code;
        if (incremental)
            types.set(prefix, { schema, ids, files: typeFiles });
        for (const locale of locales) {
            const file = `${prefix}locales/${locale}.js`;
            const catalog = parsed.get(locale);
            const oldOutput = previous?.outputs.get(file);
            // A complete, unchanged translation does not depend on edits to base
            // message text. Sparse catalogs still depend on the base fallback map.
            const reusable = oldOutput?.schema === schema && oldOutput.options === memoKey
                && oldOutput.ids === ids && oldOutput.catalog === catalog
                && (catalog.size === base.size || oldOutput.base === base);
            const messages = reusable ? oldOutput.messages : ids.map(id => catalog.get(id) ?? base.get(id));
            const compatible = oldOutput?.schema === schema && oldOutput.options === memoKey && oldOutput.ids === ids;
            // Emissions are shared with scopes and base fallbacks. Use the full locale's
            // filter in every scope, and include eligibility in the emission cache key.
            // Root locales have the same ordered IDs. When every interned contract
            // matches, reuse the first locale's result instead of recounting it.
            const reference = eligibilityReference;
            const eligible = prefix ? eligibility.get(locale) : compatible ? oldOutput.eligible
                : reference && messages.length === reference.messages.length && messages.every((message, i) => message.args === reference.messages[i].args)
                    ? reference.value : factoryEligibility(messages, schema);
            if (!prefix) {
                eligibility.set(locale, eligible);
                eligibilityReference ??= { messages, value: eligible };
            }
            const rendered = compatible && sameItems(messages, oldOutput.messages) ? oldOutput
                : renderCatalog(messages, schema, options, memoKey, incremental ? emissions : undefined, compatible ? oldOutput : undefined, eligible, validations);
            files[file] = rendered.code;
            if (incremental)
                outputs.set(file, { schema, options: memoKey, ids, catalog, base, messages, code: rendered.code, assembly: rendered.assembly, eligible });
            files[`${prefix}locales/${locale}.d.ts`] = header + 'export * from "../messages.js";\nexport { default } from "../messages.js";\n';
        }
        const loader = renderLoader(locales, options.baseLocale);
        files[`${prefix}index.js`] = loader.js;
        files[`${prefix}index.d.ts`] = loader.dts;
    }
    group('', [...base.keys()]);
    for (const [scope, patterns] of Object.entries(options.scopes ?? {})) {
        group(`scopes/${scope}/`, scopeIds(scope, patterns, [...base.keys()]));
    }
    files['package.json'] = '{"type":"module","sideEffects":false}\n';
    return { project: { files, locales, groups, warnings }, state: { parsed, inputs, schema, baseLocale: options.baseLocale, missing: options.missing, warnings, outputs, types, argumentPool, argumentKeys, emissions } };
}
