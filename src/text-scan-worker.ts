import * as nodeModule from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import type { FileResult } from './text-scan.js';
import type { ScanContext } from './text-scan-core.js';

// A worker compiles the scanner and the parser's deserializer again: cache them as the CLI does.
(nodeModule as { enableCompileCache?: () => unknown }).enableCompileCache?.();
const { fileAnalyzer, loadOxc } = await import('./text-scan.js');
// Load the parser while the main thread reads the catalogs; a failure is reported when the work arrives.
loadOxc().catch(() => undefined);

/** One worker of a large text scan: take files from the shared counter until none are left, posting facts in batches. */
parentPort!.once('message', async ({ files, context, counter }: { files: string[]; context: ScanContext; counter: SharedArrayBuffer }) => {
  try {
    const analyze = await fileAnalyzer(context, (workerData as { root: string }).root);
    const next = new Int32Array(counter);
    let batch: FileResult[] = [];
    for (let index = Atomics.add(next, 0, 1); index < files.length; index = Atomics.add(next, 0, 1)) {
      const result = analyze({ file: files[index]! });
      batch.push(result instanceof Promise ? await result : result);
      // The main thread reads a batch while the next one is parsed.
      if (batch.length === 32) { parentPort!.postMessage({ results: batch }); batch = []; }
    }
    parentPort!.postMessage({ results: batch, done: true });
  } catch (error) {
    parentPort!.postMessage({ error: (error as Error).message, diagnostics: (error as { diagnostics?: unknown }).diagnostics });
  }
});
