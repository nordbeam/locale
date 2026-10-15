#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serveMcp } from './mcp.js';

try {
  const { values } = parseArgs({ options: { root: { type: 'string' }, config: { type: 'string' } }, strict: true });
  await serveMcp({ root: values.root, config: values.config });
} catch (error) {
  process.stderr.write(`nordbeam-locale-mcp: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
