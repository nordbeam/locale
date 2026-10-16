import type { MigrateModule } from 'nordbeam-locale/internal/migrate';
import { codemodProject } from './codemods.js';
import { migrateCatalog } from './migrate-catalog.js';
import { migrateProject } from './migrate-project.js';

export * from './codemods.js';
export * from './migrate-project.js';
export * from './migrate-next.js';
export * from './migrate-react.js';
export * from './migrate-frameworks.js';
export * from './migrate-catalog.js';
export * from './catalog-formats.js';

// Keep in step with the nordbeam-locale version; the core CLI refuses a mismatched package.
export const version = '0.4.0';

// Compile-time guard: the build fails if this package stops satisfying the core loader's MigrateModule contract.
const contract = { version, codemodProject, migrateProject, migrateCatalog } satisfies MigrateModule;
void contract;
