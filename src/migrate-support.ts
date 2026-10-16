/**
 * Internal seam for @nordbeam/locale-migrate. It re-exports the core APIs that the migration
 * package builds on. This is not a stable public API: install @nordbeam/locale and
 * @nordbeam/locale-migrate at exactly the same version.
 */
export { checkProject, compileProject, CompileError } from './compiler.js';
export { parse as parseIcuMessage } from '@formatjs/icu-messageformat-parser';
export type { MessageFormatElement as IcuMessageElement } from '@formatjs/icu-messageformat-parser';
export { staticScopes } from './scope-modules.js';
export type { Catalog, Diagnostic } from './compiler.js';
export { discoverConfig, readConfig } from './config.js';
export { initialize, planInitialize } from './init.js';
export type { InitFramework, InitPlan } from './init.js';
export type { GenerateOptions } from './project.js';
export { createPlan } from './plan-apply.js';
export type { FilePlan } from './plan-apply.js';
export { CliError } from './error-codes.js';
export type { MigrateModule } from './migrate-loader.js';
