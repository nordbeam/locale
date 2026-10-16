/**
 * Whether a string reads like UI text, without a parser: the static text scan
 * and the browser inspector's rendered-text check share these rules.
 */

const urlLike = /^(?:[a-z][\w+.-]*:\/\/|mailto:|tel:|www\.|data:)|^\.[\w.-]+$|^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$|^\.{0,2}\/[\w./${}:@%+-]*$|^[\w-]+(?:\.[\w-]+)*\.(?:com|se|io|org|net|dev|app|ai|co|eu|de|uk|nu|fi|no|dk|fr|es|it|nl|ch|at|be|pl|us|ca|au|jp|cn|in|info|biz|xyz|tech|cloud|so|sh|me|tv|gg|ly)$|^[\w-]+\.(?:pdf|png|jpe?g|gif|webp|avif|svg|ico|csv|tsv|json|ya?ml|xlsx?|docx?|pptx?|txt|zip|gz|xml|sie|html?|css|m?[jt]sx?|md|mp[34]|wav|webm|woff2?|ttf|otf)$/i;
const cssUnit = /^-?\d*\.?\d+(?:px|r?em|vh|vw|vmin|vmax|%|ms|s|deg|fr|ch|ex|pt|dpi|x)$/;
const dateFormat = /^(?=.*(?:yy|MM|dd|HH|hh|mm|ss|EEE|MMM|LLL))[yMdHhmsSaEZXxDGLQqwWkKTtcoiIeu\s.,:/'()[\]-]+$/;
const codeLike = /=>|\(\)|\$\{|^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\s|^\s*[{[]\s*"|;\s*$|^\s*<\/?[a-z][\w-]*[\s>/]|^[\w$.]+\([^)]*\)$|^(?:rgba?|hsla?|var|calc|url|translate[XYZ]?|rotate|scale|cubic-bezier)\(/;
const classToken = /^!?-?[a-z0-9@[\]():/._%#&>~=+*-]+$/;

/** Where the string sits: JSX children and text attributes keep single lowercase words. */
export type Position = 'child' | 'text' | 'code';

/**
 * Why a string is not UI text, or undefined when it may be. `position` loosens
 * the rules where only prose appears: JSX children and text attributes keep
 * single lowercase words ("or", "of"), which in code are usually identifiers.
 */
export function noise(raw: string, position: Position): string | undefined {
  // Most strings in code are one ASCII token: decide those without normalizing.
  if (asciiToken.test(raw)) return /[A-Za-z]{2}/.test(raw) ? cssUnit.test(raw) ? 'code' : token(raw, position) : 'symbols';
  const text = (raw.includes('{') ? raw.replace(/\{[\w$]*\}/g, ' ') : raw).replace(/[\s\u00a0]+/g, ' ').trim();
  if (!/\p{L}{2,}/u.test(text)) return 'symbols';
  if (urlLike.test(text)) return 'url';
  if (cssUnit.test(text) || /^#[\da-f]{3,8}$/i.test(text)) return 'code';
  if (codeLike.test(raw)) return 'code';
  if (/^(?:no)?(?:index|follow|archive|snippet|imageindex|translate)(?:\s*,\s*(?:no)?(?:index|follow|archive|snippet|imageindex|translate))*$/i.test(text)) return 'code';
  if (dateFormat.test(text) && !/\p{L}{4,}/u.test(text.replace(/\b(?:yyyy|MMMM|EEEE|LLLL)\b/g, ''))) return 'format';
  if (!text.includes(' ')) {
    if (/^[\w$]+(?:[._:/][\w$]+)+$/.test(text)) return 'identifier';
    return token(text, position);
  }
  if (companyName.test(text)) return 'name';
  if (position === 'code') {
    const tokens = text.split(' ');
    if (tokens.every(item => classToken.test(item)) && tokens.some(item => /[-:[\]/]/.test(item) && !/^\p{L}+-\p{L}+$/u.test(item) || /^(?:flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|truncate|underline|italic|uppercase|lowercase|capitalize|border|rounded|shadow|container|sr-only|group|peer|transition)$/.test(item))) return 'classes';
  }
  return undefined;
}

const asciiToken = /^[\w$-]+$/;
/** A company: capitalized words and a legal form, "Acme Nautics AB", "Globex Inc.". */
const companyName = /^(?:[\p{Lu}\d][\p{L}\d&.'-]*\s+){1,4}(?:AB|Inc\.?|Ltd\.?|LLC|GmbH|Oyj?|ASA?|ApS|AG|S\.?A\.?|B\.?V\.?|N\.?V\.?|Corp\.?|Co\.|PLC|plc|KB|HB|SARL|S\.?r\.?l\.?|Pty Ltd)$/u;

/** One token without spaces: identifiers, constants, keys, locale tags and formats. */
function token(text: string, position: Position): string | undefined {
  if (text.includes('_')) return 'identifier';
  if (/^[a-z]+(?:[A-Z\d][a-z\d]*)+$/.test(text) && position !== 'child') return 'identifier';
  // LinkedIn, GitHub, YouTube, iPhone: brand names read the same in every language.
  if (/^[A-Z][a-z\d]+(?:[A-Z][a-z\d]*)+$/.test(text) || /^[a-z]+(?:[A-Z][a-z\d]*)+$/.test(text)) return position === 'child' ? 'name' : 'identifier';
  // A language switcher's SV / EN.
  if (/^(?:SV|EN|DE|FR|ES|NL|DA|NB|NN|FI|PL|PT|JA|ZH|KO|RU|TR|CS|ET|LV|LT|IS|HE|EL|HU|RO|BG|HR|SK|SL)$/.test(text)) return 'code';
  if (/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?-(?:[A-Z]{2}|\d{3})$|^[a-z]{2,3}-[A-Z][a-z]{3}$/.test(text)) return 'code';
  if (/^no(?:index|follow|archive|snippet)$/i.test(text)) return 'code';
  if (dateFormat.test(text)) return 'format';
  if (position !== 'child' && /^[a-z][a-z\d]*(?:-[a-z\d]+)+$/.test(text)) return 'identifier';
  if (position === 'code' && (/^[a-z][a-z\d]*$/.test(text) || /^[A-Z\d]{2,4}$/.test(text))) return 'identifier';
  return undefined;
}
