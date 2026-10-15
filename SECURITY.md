# Security policy

## Supported versions

Nordbeam Locale is pre-1.0. Security fixes are released for the latest minor
version of `@nordbeam/locale` and `@nordbeam/locale-migrate`.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through
[GitHub private vulnerability reporting](https://github.com/nordbeam/locale/security/advisories/new),
or email [github@nordbeam.io](mailto:github@nordbeam.io) with "security" in
the subject. Include the affected version, a description of the impact, and
the smallest reproduction you can share.

We aim to acknowledge reports within three business days and to agree on a
disclosure timeline with you once the issue is confirmed. Credit is given in
the advisory unless you ask otherwise.

## Scope

Relevant areas include:

- The generated runtime: escaping of interpolated values and rich-text
  content, and any path that could execute catalog content as code.
- The compiler and CLI when run on untrusted catalogs or projects: path
  traversal, writes outside the configured output directory, and resource
  exhaustion.
- The plan/apply protocol (`apply-plan`) and the MCP server: any way to write
  outside the plan's allow-list or bypass the stale-plan check.
- The Next.js middleware and routing helpers: open redirects and cookie
  handling.
