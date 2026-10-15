#!/usr/bin/env node
// `npx nordbeam-locale` lands here when the project has no @nordbeam/locale yet.
// Run the CLI of the @nordbeam/locale this package depends on.
await import(new URL('cli.js', import.meta.resolve('@nordbeam/locale')).href);
