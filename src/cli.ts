#!/usr/bin/env node
import * as nodeModule from 'node:module';

// Enable Node's compile cache before the CLI body and its subsystems are parsed.
// The body loads through a dynamic import, so it cannot run before this call.
(nodeModule as { enableCompileCache?: () => unknown }).enableCompileCache?.();
await import('./cli-main.js');
