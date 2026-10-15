import { readFile } from 'node:fs/promises';
import type { Diagnostic } from './compiler.js';
import { CliError } from './error-codes.js';
import type { FilePlan } from './plan-apply.js';
import type { GenerateOptions } from './project.js';
import type { catalogMigrationFormats, sourceCodemodFormats } from './agent.js';

export const migratePackage = '@nordbeam/locale-migrate';

export type CodemodFormat = (typeof sourceCodemodFormats)[number];
export type MigrationFormat = (typeof catalogMigrationFormats)[number];

/** The subset of the migration package's API that the core CLI calls. The package build checks that it still satisfies this type. */
export interface MigrateModule {
  readonly version: string;
  readonly codemodProject: (options: CodemodProjectOptions) => Promise<CodemodProjectResult>;
  readonly migrateProject: (options: MigrateProjectOptions) => Promise<MigrateProjectResult>;
  readonly migrateCatalog: (options: MigrateCatalogOptions) => Promise<MigrateCatalogResult>;
}

export interface CodemodProjectOptions {
  readonly root?: string;
  readonly sourceDir?: string;
  readonly format: CodemodFormat;
  readonly messagesObject?: string;
  readonly messagesImport?: string;
  readonly moveTypeImports?: readonly string[];
  readonly customCalls?: readonly { readonly callee: string; readonly namespace?: string }[];
  readonly messageIdBySourceFile?: string;
  readonly write?: boolean;
  readonly plan: boolean;
  readonly strict?: boolean;
  readonly requireMessagesBinding: boolean | 'warn';
}

export interface CodemodSkip {
  readonly file?: string;
  readonly callee: string;
  readonly reason: string;
  readonly offset?: number;
  readonly line?: number;
  readonly column?: number;
  readonly code?: string;
  readonly action?: string;
}

export interface CodemodProjectResult {
  readonly dryRun: boolean;
  readonly filesScanned: number;
  readonly replacements: number;
  readonly typeImportsMoved: number;
  readonly changed: readonly { readonly file: string; readonly replacements: number; readonly typeImportsMoved: number }[];
  readonly skipped: readonly CodemodSkip[];
  readonly warnings?: readonly CodemodSkip[];
  readonly plan?: FilePlan;
}

export interface MigrateProjectOptions extends GenerateOptions {
  readonly from: string;
  readonly format: CodemodFormat;
  readonly catalogFormat?: MigrationFormat;
  readonly locale?: string;
  readonly framework?: 'next' | 'vite-react' | 'vue' | 'svelte' | 'solid' | 'tanstack-start';
  readonly sourceDir?: string;
  readonly messagesObject?: string;
  readonly customCalls?: readonly { readonly callee: string; readonly namespace?: string }[];
  readonly messageIdBySourceFile?: string;
  readonly write?: boolean;
  readonly configFile?: string;
  readonly initialLocaleExpression?: string;
  readonly strict?: boolean;
}

export interface MigrateProjectResult {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly catalogs: readonly { readonly locale: string; readonly destination: string; readonly messageCount: number }[];
  readonly codemod: { readonly replacements: number };
  readonly integration?: { readonly kind: string; readonly filesScanned: number; readonly filesChanged: number; readonly replacements: number; readonly skipped: readonly unknown[] };
  readonly generatedFiles: readonly string[];
  readonly scaffoldFiles: readonly string[];
  readonly configFiles: readonly string[];
  readonly packageEdits: readonly string[];
  readonly manualActions: readonly string[];
}

export interface MigrateCatalogOptions {
  readonly from: string;
  readonly format: MigrationFormat;
  readonly out?: string;
  readonly dryRun?: boolean;
  readonly locale?: string;
}

export interface MigrateCatalogResult {
  readonly ok: boolean;
  readonly format: MigrationFormat;
  readonly source: string;
  readonly destination?: string;
  readonly dryRun: boolean;
  readonly output: string;
  readonly messageCount: number;
  readonly changed: string[];
  readonly warnings: Diagnostic[];
  readonly collisions: Array<{ readonly code: string; readonly message: string; readonly path?: string }>;
}

/** The core package version, read from its own package.json the same way `--version` does. */
export async function coreVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
  return packageJson.version ?? 'unknown';
}

/** Loads the migration package on first use. The specifier is a variable so the core build never resolves it. */
export async function loadMigrate(command: string, specifier = migratePackage): Promise<MigrateModule> {
  const version = await coreVersion();
  const install = `npm install --save-dev ${migratePackage}@${version}`;
  let module: MigrateModule;
  try { module = await import(specifier) as MigrateModule; }
  catch (error) {
    // Only a missing package named by the specifier is an install problem; a missing dependency of the package is a real failure.
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' && (error as Error).message.includes(`'${specifier}'`))
      throw new CliError('MIGRATE_PACKAGE_MISSING', `${command} needs ${migratePackage}. Install it: ${install}`, { package: migratePackage, version, install });
    throw error;
  }
  if (module.version !== version) throw new CliError('MIGRATE_PACKAGE_VERSION', `${command} needs ${migratePackage}@${version}, but ${specifier} is ${module.version}. Install the matching version: ${install}`, { package: migratePackage, version, installedVersion: module.version, install });
  return module;
}
