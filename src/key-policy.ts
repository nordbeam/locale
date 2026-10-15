import type { Diagnostic } from './diagnostics.js';

/** Exact message IDs or descendants of a dotted prefix ending in `.*`. */
export type KeyPattern = string;

export interface KeyPolicyOptions {
  readonly lockedKeys?: readonly KeyPattern[];
  readonly ignoredKeys?: readonly KeyPattern[];
}

export type KeyPolicyDecision = 'translate' | 'locked' | 'ignored';

export interface ResolvedKeyPolicy {
  readonly id: string;
  readonly decision: KeyPolicyDecision;
  /** The first matching configured pattern, when the key is locked or ignored. */
  readonly pattern?: KeyPattern;
}

function prefixOf(pattern: KeyPattern): string | undefined {
  return pattern.endsWith('.*') ? pattern.slice(0, -2) : undefined;
}

/** Return whether a configured pattern selects an exact ID or one of its descendants. */
export function matchesKeyPattern(id: string, pattern: KeyPattern): boolean {
  if (!id || !pattern) return false;
  const prefix = prefixOf(pattern);
  return prefix === undefined ? id === pattern : id.startsWith(prefix + '.');
}

function validPattern(pattern: unknown): pattern is KeyPattern {
  if (typeof pattern !== 'string' || !pattern) return false;
  const star = pattern.indexOf('*');
  return star < 0 || (star === pattern.length - 1 && pattern.endsWith('.*') && pattern.length > 2 && pattern.indexOf('*', star + 1) < 0);
}

export function patternsOverlap(a: KeyPattern, b: KeyPattern): boolean {
  if (a === b) return true;
  const ap = prefixOf(a), bp = prefixOf(b);
  if (ap === undefined) return bp === undefined ? false : matchesKeyPattern(a, b);
  if (bp === undefined) return matchesKeyPattern(b, a);
  return ap.startsWith(bp + '.') || bp.startsWith(ap + '.');
}

/** Validate a lock/ignore list before it reaches a workflow or compiler call. */
export function validateKeyPatterns(value: unknown, file = 'config', option = 'keys'): asserts value is readonly KeyPattern[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some(pattern => !validPattern(pattern))) {
    throw new Error(`${file}: ${option} must be an array of exact message IDs or prefix patterns ending in .*.`);
  }
  const patterns = value as readonly KeyPattern[];
  for (let i = 0; i < patterns.length; i++) {
    for (let j = 0; j < i; j++) if (patternsOverlap(patterns[i]!, patterns[j]!)) {
      throw new Error(`${file}: ${option} contains overlapping patterns ${JSON.stringify(patterns[j]!)} and ${JSON.stringify(patterns[i]!)}.`);
    }
  }
}

/** Validate both policy scopes, including ambiguity between locked and ignored keys. */
export function validateKeyPolicy(options: KeyPolicyOptions, file = 'config'): void {
  if (options.lockedKeys === undefined && options.ignoredKeys === undefined) return;
  validateKeyPatterns(options.lockedKeys, file, 'lockedKeys');
  validateKeyPatterns(options.ignoredKeys, file, 'ignoredKeys');
  for (const locked of options.lockedKeys ?? []) for (const ignored of options.ignoredKeys ?? []) {
    if (patternsOverlap(locked, ignored)) {
      throw new Error(`${file}: lockedKeys and ignoredKeys overlap at ${JSON.stringify(locked)} and ${JSON.stringify(ignored)}.`);
    }
  }
}

/** Resolve one message ID with deterministic, validated lock/ignore semantics. */
export function resolveKeyPolicy(id: string, options: KeyPolicyOptions = {}): ResolvedKeyPolicy {
  if (typeof id !== 'string' || !id) throw new TypeError('Message ID must be a nonempty string.');
  validateKeyPolicy(options, 'key policy');
  for (const pattern of options.ignoredKeys ?? []) if (matchesKeyPattern(id, pattern)) return { id, decision: 'ignored', pattern };
  for (const pattern of options.lockedKeys ?? []) if (matchesKeyPattern(id, pattern)) return { id, decision: 'locked', pattern };
  return { id, decision: 'translate' };
}

/**
 * `then` stays a valid message ID, but a top-level `then` member makes the messages
 * object a thenable: `await messages` would wait forever. Pass the base catalog IDs.
 */
export function thenableKeyDiagnostics(ids: Iterable<string>): Diagnostic[] {
  for (const id of ids) if (id === 'then' || id.startsWith('then.')) return [{
    code: 'THENABLE_KEY', messageId: 'then',
    message: 'The top-level "then" key makes the messages object thenable.',
    hint: 'a `then` member makes the messages object a thenable, so `await messages` never resolves; rename the key or never await the messages object directly',
  }];
  return [];
}
