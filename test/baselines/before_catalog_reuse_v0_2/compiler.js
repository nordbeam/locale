import { parse, TYPE } from '@formatjs/icu-messageformat-parser';
import { CompileError } from './diagnostics.js';
import { declarationGroups } from './type-layout.js';
import { quote, header } from './codegen.js';
import { Projection } from './projection.js';
export { quote } from './codegen.js';
export { CompileError, formatDiagnostic } from './diagnostics.js';
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
const sameItems = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
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
function fail(code, message, context = {}) {
    throw new CompileError([{ ...context, code, message }]);
}
function flatten(catalog, locale) {
    const result = new Map();
    const ancestors = new Set();
    function visit(value, prefix) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            fail('INVALID_CATALOG', 'Expected an object containing strings or nested catalogs.', { locale, messageId: prefix });
        if (ancestors.has(value))
            fail('INVALID_CATALOG', 'Catalog contains a circular reference.', { locale, messageId: prefix });
        ancestors.add(value);
        for (const [key, entry] of Object.entries(value)) {
            if (!key)
                fail('INVALID_KEY', 'Message keys must not be empty.', { locale });
            const id = prefix ? `${prefix}.${key}` : key;
            if (typeof entry === 'string') {
                if (result.has(id))
                    fail('DUPLICATE_KEY', `Nested and flat keys both resolve to ${quote(id)}.`, { locale, messageId: id });
                result.set(id, entry);
            }
            else
                visit(entry, id);
        }
        ancestors.delete(value);
    }
    visit(catalog, '');
    return result;
}
function mergeArgument(target, name, arg, context) {
    const previous = target.get(name);
    if (!previous) {
        target.set(name, { kind: arg.kind, choices: new Set(arg.choices) });
        return;
    }
    if (previous.kind === 'value')
        previous.kind = arg.kind;
    else if (arg.kind !== 'value' && arg.kind !== previous.kind) {
        fail('ARGUMENT_TYPE_CONFLICT', `${quote(name)} is used as both ${previous.kind} and ${arg.kind}. Use separate arguments.`, context);
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
        fail('INVALID_ICU', e.message, { ...context, ...e.location?.start });
    }
    const args = new Map();
    function visit(nodes) {
        for (const node of nodes) {
            if (node.type === TYPE.literal || node.type === TYPE.pound)
                continue;
            if (node.type === TYPE.tag)
                fail('UNSUPPORTED_RICH_TEXT', 'Rich-text tags are not supported in this string compiler yet. Use plain text or keep markup in your view.', { ...context, ...node.location?.start });
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
function renderCatalog(messages, schema, options, memoKey, emissions) {
    const helpers = new Map();
    const intlLocales = new Map();
    let captured = [];
    function register(spec) {
        if (!helpers.has(spec.key))
            helpers.set(spec.key, { ...spec, id: `$f${helpers.size}` });
        return helpers.get(spec.key).id;
    }
    function formatter(kind, locale, opts, message) {
        // Validate statically known options during compilation, not on a user's first call.
        const key = optionKey([kind, locale, Object.entries(opts).sort(([a], [b]) => compare(a, b))]);
        if (!helpers.has(key)) {
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
            register({ key, kind, locale, options: opts });
        }
        const spec = helpers.get(key);
        if (memoKey === undefined)
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
    function formatOptions(node, message) {
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
    function emit(nodes, message, pound) {
        const parts = nodes.map(node => {
            if (node.type === TYPE.literal)
                return quote(node.value);
            if (node.type === TYPE.pound) {
                if (pound === undefined)
                    return quote('#');
                return `${formatter('NumberFormat', message.locale, {}, message)}(${pound})`;
            }
            if (node.type === TYPE.tag)
                throw new Error('Rich text must be rejected before emission');
            const value = `p[${quote(node.value)}]`;
            switch (node.type) {
                case TYPE.argument: return value;
                case TYPE.number:
                case TYPE.date:
                case TYPE.time: {
                    const { options: opts, scale } = formatOptions(node, message);
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
        });
        return ['""', ...parts].join('+');
    }
    const code = [];
    const entries = [];
    let usesLiteral = false;
    messages.forEach((message, index) => {
        const name = `$m${index}`;
        const args = schema.get(message.id);
        let emitted = message.emitted;
        if (memoKey === undefined || !emitted || emitted.options !== memoKey || emitted.args !== args) {
            captured = [];
            let checks = '';
            if (options.development && args.size) {
                const context = `${message.locale}:${message.id}`;
                checks += `if(!p||typeof p!=="object")throw new TypeError(${quote(`${context}: expected message arguments`)});`;
                for (const [key, arg] of args) {
                    const value = `p[${quote(key)}]`;
                    const test = arg.kind === 'number' ? `typeof ${value}!=="number"`
                        : arg.kind === 'date' ? `(typeof ${value}!=="number"&&!(${value} instanceof Date))`
                            : arg.kind === 'select' ? `typeof ${value}!=="string"`
                                : `(typeof ${value}!=="string"&&typeof ${value}!=="number")`;
                    checks += `if(!Object.hasOwn(p,${quote(key)})||${test})throw new TypeError(${quote(`${context}: argument ${quote(key)} must be ${arg.kind === 'value' ? 'string or number' : arg.kind === 'date' ? 'Date or number' : arg.kind === 'select' ? 'string' : 'number'}`)});`;
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
            const expression = literal ? quote(ast.map(node => node.type === TYPE.literal ? node.value : '').join('')) : emit(ast, message);
            emitted = { options: memoKey ?? '', args, body: literal ? `/*#__PURE__*/$literal(${expression})`
                    : `(${args.size ? 'p' : ''})=>${checks ? `{${checks}return ${expression};}` : expression}`, helpers: captured };
            if (memoKey !== undefined) {
                message.emitted = emitted;
                message.ast = undefined;
            }
        }
        if (emissions) {
            const bytes = emitted.body.length * 2 + emitted.helpers.length * 32 + 160;
            emissions.bytes += bytes - (emissions.entries.get(message) ?? 0);
            emissions.entries.delete(message);
            emissions.entries.set(message, bytes);
        }
        // Register in original emission order, which can differ from source order
        // for nested plural branches. Incremental and cold output stay identical.
        const names = emitted.helpers.map(register);
        const body = memoKey === undefined ? emitted.body : emitted.body.replace(/\0(\d+)\0/g, (_, i) => names[Number(i)]);
        if (body.startsWith('/*#__PURE__*/$literal('))
            usesLiteral = true;
        code.push(`const ${name}=${body};`);
        // A named then export would make dynamic import assimilate the module as a
        // Promise. The default catalog still supports both these message IDs safely.
        if (message.id !== 'then' && message.id !== 'default') {
            code.push(`export {${name} as ${quote(message.id)}};`);
        }
        entries.push(`[${quote(message.id)}]:${name}`);
    });
    // Number/date format accessors return an already-bound function. Cache it
    // directly, avoiding the accessor and its brand checks on every message call.
    const prelude = [...helpers.values()].map(h => h.kind === 'PluralRules'
        ? `let ${h.id}Cache;const ${h.id}=v=>(${h.id}Cache??=new Intl.PluralRules(${quote(h.locale)},${quote(h.options)})).select(v);`
        : `let ${h.id}Cache;const ${h.id}=v=>(${h.id}Cache??=new Intl.${h.kind}(${quote(h.locale)},${quote(h.options)}).format)(v);`);
    if (usesLiteral)
        prelude.unshift('const $literal=value=>()=>value;');
    code.push(`const messages={__proto__:null,${entries.join(',')}};export default messages;`);
    if (emissions)
        trimEmissions(emissions);
    return header + [...prelude, ...code].join('\n') + '\n';
}
// All locales have the same merged argument contract. Declare it once per
// group so TypeScript does not have to parse an identical copy for every locale.
function renderTypes(ids, schema, namedOnly = false) {
    const declarations = [];
    const properties = [];
    ids.forEach((id, index) => {
        const name = `$m${index}`;
        const args = schema.get(id);
        const signature = args.size ? `(args: { ${[...args].map(([key, arg]) => `readonly ${quote(key)}: ${typeOf(arg)}`).join('; ')} }) => string` : '() => string';
        declarations.push(`declare const ${name}: ${signature};`);
        if (namedOnly || (id !== 'then' && id !== 'default'))
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
    const groups = declarationGroups('index.js', ids);
    const files = Object.create(null);
    for (const group of groups)
        files[group.file] = renderTypes(group.ids, schema, groups.length > 1);
    if (groups[0].file !== 'messages.d.ts') {
        const imports = groups.map(group => quote('./' + group.file.replace(/\.d\.ts$/, '.js')));
        // Private type modules describe every ID as an export, avoiding duplicate
        // property declarations. Only public-safe names are
        // re-exported; then/default remain properties of the public default catalog.
        // Flatten once instead of resolving each property through an intersection.
        // The mapped object keeps Record compatibility and explicit readonly keys.
        files['messages.d.ts'] = header + groups.map((group, i) => {
            const names = group.ids.filter(id => id !== 'then' && id !== 'default');
            return names.length ? `export {${names.map(quote).join(',')}} from ${imports[i]};` : '';
        }).join('\n')
            + '\n' + imports.map((path, i) => `type $T${i} = typeof import(${path});`).join('\n')
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
        try {
            const result = compile(options, previous, emissions);
            previous = result.state;
            // Callers may change returned metadata without corrupting the private cache.
            return { ...result.project, locales: [...result.project.locales],
                groups: Object.assign(Object.create(null), Object.fromEntries(Object.entries(result.project.groups).map(([entry, ids]) => [entry, [...ids]]))),
                warnings: result.project.warnings.map(warning => ({ ...warning })) };
        }
        finally {
            // Failed format validation can stop midway through a large catalog. Keep
            // the budget and release failed/removed inputs on that path as well.
            trimEmissions(emissions);
            for (const [message, cost] of emissions.entries) {
                if (previous?.parsed.get(message.locale)?.get(message.id) !== message) {
                    emissions.entries.delete(message);
                    emissions.bytes -= cost;
                    message.emitted = undefined;
                }
            }
        }
    };
}
function compile(options, previous, emissionCache) {
    const incremental = emissionCache !== undefined;
    const argumentPool = new Map();
    const argumentKeys = previous?.argumentKeys ?? new WeakMap();
    const emissions = emissionCache ?? { entries: new Map(), bytes: 0, limit: 0 };
    function intern(args) {
        if (!incremental)
            return args;
        const key = argumentKeys.get(args) ?? JSON.stringify([...args].map(([name, arg]) => [name, arg.kind, [...arg.choices].sort()]));
        const shared = argumentPool.get(key) ?? previous?.argumentPool.get(key) ?? args;
        argumentPool.set(key, shared);
        argumentKeys.set(shared, key);
        return shared;
    }
    const locales = Object.keys(options.catalogs).sort();
    if (!locales.length || !own(options.catalogs, options.baseLocale))
        fail('BASE_LOCALE_MISSING', `No catalog for base locale ${quote(options.baseLocale)}.`);
    for (const locale of locales) {
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
    const parsed = new Map();
    let sameContract = previous !== undefined && previous.baseLocale === options.baseLocale && previous.missing === options.missing && previous.parsed.size === locales.length;
    for (const locale of locales) {
        const intlLocale = new Intl.Locale(locale);
        const old = previous?.parsed.get(locale);
        const messages = new Map([...flatten(options.catalogs[locale], locale)].sort(([a], [b]) => compare(a, b)).map(([id, source]) => {
            const cached = old?.get(id);
            const message = cached?.source === source ? cached : readMessage(id, source, locale, intlLocale);
            message.args = intern(message.args);
            if (!cached || message.args !== cached.args)
                sameContract = false;
            return [id, message];
        }));
        if (old?.size !== messages.size)
            sameContract = false;
        parsed.set(locale, messages);
    }
    const base = parsed.get(options.baseLocale);
    const schema = sameContract ? previous.schema : new Map();
    const warnings = sameContract ? previous.warnings : [];
    if (!sameContract) {
        for (const [id, message] of base)
            schema.set(id, new Map([...message.args].map(([name, arg]) => [name, { kind: arg.kind, choices: new Set(arg.choices) }])));
        for (const locale of locales) {
            const messages = parsed.get(locale);
            for (const [id, message] of messages) {
                if (!base.has(id))
                    fail('UNKNOWN_MESSAGE', 'This key does not exist in the base catalog.', { locale, messageId: id });
                for (const [name, arg] of message.args) {
                    if (!schema.get(id).has(name))
                        fail('UNKNOWN_ARGUMENT', `Translation introduces ${quote(name)}, which is absent from the base message.`, { locale, messageId: id });
                    mergeArgument(schema.get(id), name, arg, { locale, messageId: id });
                }
            }
            for (const [id, message] of base)
                if (!messages.has(id)) {
                    if (options.missing === 'error')
                        fail('MISSING_MESSAGE', 'Translation is missing.', { locale, messageId: id });
                    warnings.push({ code: 'FALLBACK_MESSAGE', message: `Using the ${options.baseLocale} message and formatting locale.`, locale, messageId: id });
                }
        }
    }
    for (const [id, args] of schema) {
        const shared = intern(args);
        if (shared !== args)
            schema.set(id, shared);
    }
    const files = Object.create(null);
    const groups = Object.create(null);
    const outputs = new Map();
    const types = new Map();
    const memoKey = incremental ? optionKey([!!options.development, options.timeZone, options.formats]) : undefined;
    function group(prefix, ids) {
        groups[`${prefix}index.js`] = ids;
        const oldType = previous?.types.get(prefix);
        const typeFiles = oldType?.schema === schema && sameItems(ids, oldType.ids) ? oldType.files : renderTypeFiles(ids, schema);
        for (const [name, code] of Object.entries(typeFiles))
            files[prefix + name] = code;
        if (incremental)
            types.set(prefix, { schema, ids, files: typeFiles });
        for (const locale of locales) {
            const file = `${prefix}locales/${locale}.js`;
            const messages = ids.map(id => parsed.get(locale).get(id) ?? base.get(id));
            const oldOutput = previous?.outputs.get(file);
            const code = oldOutput?.schema === schema && oldOutput.options === memoKey && sameItems(messages, oldOutput.messages)
                ? oldOutput.code : renderCatalog(messages, schema, options, memoKey, incremental ? emissions : undefined);
            files[file] = code;
            if (incremental)
                outputs.set(file, { schema, options: memoKey, messages, code });
            files[`${prefix}locales/${locale}.d.ts`] = header + 'export * from "../messages.js";\nexport { default } from "../messages.js";\n';
        }
        const loader = renderLoader(locales, options.baseLocale);
        files[`${prefix}index.js`] = loader.js;
        files[`${prefix}index.d.ts`] = loader.dts;
    }
    group('', [...base.keys()]);
    for (const [scope, patterns] of Object.entries(options.scopes ?? {})) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(scope))
            fail('INVALID_SCOPE', `Invalid scope name ${quote(scope)}.`);
        if (!Array.isArray(patterns) || !patterns.length || patterns.some(p => typeof p !== 'string'))
            fail('INVALID_SCOPE', `Scope ${quote(scope)} must contain message IDs or prefix patterns.`);
        const selected = new Set();
        for (const pattern of patterns) {
            const matches = [...base.keys()].filter(id => pattern.endsWith('.*') ? id.startsWith(pattern.slice(0, -1)) : id === pattern);
            if (!matches.length)
                fail('EMPTY_SCOPE_PATTERN', `Scope ${quote(scope)} pattern ${quote(pattern)} does not match any messages.`);
            for (const id of matches)
                selected.add(id);
        }
        group(`scopes/${scope}/`, [...base.keys()].filter(id => selected.has(id)));
    }
    files['package.json'] = '{"type":"module","sideEffects":false}\n';
    return { project: { files, locales, groups, warnings }, state: { parsed, schema, baseLocale: options.baseLocale, missing: options.missing, warnings, outputs, types, argumentPool, argumentKeys, emissions } };
}
