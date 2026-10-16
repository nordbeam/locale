/** Map offsets in a rewritten revision of a file back to the revision it came from.
 *
 * The project codemod re-runs the source codemod until it converges, so the calls it
 * reports belong to the last revision. A preview leaves the file as it was, and a report
 * must point at that file. Each pass changes few lines, so the revisions are compared
 * line by line (Myers), and each changed run of lines character by character. A skipped
 * call is text the codemod left alone, so it lands on an equal run and maps exactly; an
 * offset inside rewritten text maps to the start of what it replaced. */

/** One aligned run: `length` units equal at `before` and `after`. */
type Run = { before: number; after: number; length: number };

/** The equal runs of two sequences, in order (Myers' O(ND) difference). Undefined when the
 * edit distance passes `limit`, so a caller can fall back to a coarser alignment. */
function equalRuns<T>(before: readonly T[], after: readonly T[], limit: number): Run[] | undefined {
  const n = before.length, m = after.length, max = Math.min(n + m, limit);
  // `furthest[k]` is the furthest x on diagonal k = x - y. Each step d keeps the 2d + 1
  // diagonals it can reach, so memory grows with the square of the edit distance only.
  let furthest = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(furthest);
    const next = new Map<number, number>();
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (furthest.get(k - 1) ?? -1) < (furthest.get(k + 1) ?? -1));
      let x = down ? furthest.get(k + 1)! : furthest.get(k - 1)! + 1;
      let y = x - k;
      while (x < n && y < m && before[x] === after[y]) { x++; y++; }
      next.set(k, x);
      if (x >= n && y >= m) { found = d; break; }
    }
    furthest = next;
  }
  if (found < 0) return;
  const runs: Run[] = [];
  let x = n, y = m;
  for (let d = found; d >= 0; d--) {
    const previous = trace[d]!, k = x - y;
    const down = k === -d || (k !== d && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = previous.get(previousK) ?? 0, previousY = previousX - previousK;
    const end = x;
    while (x > previousX && y > previousY) { x--; y--; }
    if (end > x) runs.push({ before: x, after: y, length: end - x });
    x = previousX; y = previousY;
  }
  return runs.reverse();
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  return starts;
}

/** Equal character runs of two texts: line runs, then the changed lines between them
 * compared character by character (or by common prefix and suffix when too large). */
function characterRuns(before: string, after: string): Run[] {
  if (before === after) return [{ before: 0, after: 0, length: before.length }];
  const beforeStarts = lineStarts(before), afterStarts = lineStarts(after);
  const lines = (text: string, starts: number[]): string[] => starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length));
  const beforeLines = lines(before, beforeStarts), afterLines = lines(after, afterStarts);
  const lineRuns = equalRuns(beforeLines, afterLines, 3000) ?? [];
  const runs: Run[] = [];
  const offsetOf = (starts: number[], text: string, line: number): number => starts[line] ?? text.length;
  const gap = (beforeStart: number, beforeEnd: number, afterStart: number, afterEnd: number): void => {
    if (beforeStart >= beforeEnd || afterStart >= afterEnd) return;
    const left = before.slice(beforeStart, beforeEnd), right = after.slice(afterStart, afterEnd);
    const small = left.length * right.length <= 4_000_000;
    // Offsets are UTF-16 code units, so the comparison is too.
    const inner = small ? equalRuns(left.split(''), right.split(''), 2000) : undefined;
    if (inner) { for (const run of inner) runs.push({ before: beforeStart + run.before, after: afterStart + run.after, length: run.length }); return; }
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
    let suffix = 0;
    while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
    if (prefix) runs.push({ before: beforeStart, after: afterStart, length: prefix });
    if (suffix) runs.push({ before: beforeEnd - suffix, after: afterEnd - suffix, length: suffix });
  };
  let beforeLine = 0, afterLine = 0;
  for (const run of lineRuns) {
    gap(offsetOf(beforeStarts, before, beforeLine), offsetOf(beforeStarts, before, run.before), offsetOf(afterStarts, after, afterLine), offsetOf(afterStarts, after, run.after));
    const beforeStart = offsetOf(beforeStarts, before, run.before), afterStart = offsetOf(afterStarts, after, run.after);
    runs.push({ before: beforeStart, after: afterStart, length: offsetOf(beforeStarts, before, run.before + run.length) - beforeStart });
    beforeLine = run.before + run.length; afterLine = run.after + run.length;
  }
  gap(offsetOf(beforeStarts, before, beforeLine), before.length, offsetOf(afterStarts, after, afterLine), after.length);
  return runs;
}

/** A function from offsets in `after` to offsets in `before`. An offset in an equal run maps
 * exactly; one in changed text maps to where the change starts in `before`. */
export function revisionMapper(before: string, after: string): (offset: number) => number {
  const runs = characterRuns(before, after);
  return offset => {
    let low = 0, high = runs.length - 1, found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (runs[middle]!.after <= offset) { found = middle; low = middle + 1; } else high = middle - 1;
    }
    if (found < 0) return 0;
    const run = runs[found]!;
    if (offset < run.after + run.length) return run.before + offset - run.after;
    // Inside changed text: the end of the last equal run is where the change begins.
    return Math.min(run.before + run.length, before.length);
  };
}

/** Compose the mappers of successive revisions: offsets in the last revision to the first. */
export function revisionsMapper(revisions: readonly string[]): (offset: number) => number {
  const mappers: Array<(offset: number) => number> = [];
  for (let index = 1; index < revisions.length; index++) mappers.push(revisionMapper(revisions[index - 1]!, revisions[index]!));
  return offset => mappers.reduceRight((value, map) => map(value), offset);
}
