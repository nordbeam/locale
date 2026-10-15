import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function markdownFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

/** Lines outside fenced code blocks, with inline code spans blanked out. */
function prose(source) {
  let fence = false;
  return source.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return ''; }
    return fence ? '' : line.replace(/`[^`]*`/g, match => ' '.repeat(match.length));
  });
}

/** GitHub heading slug: lowercase, punctuation dropped except - and _, spaces to -. */
function slug(text) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

function headingSlugs(file) {
  const seen = new Map();
  const slugs = new Set();
  for (const line of prose(readFileSync(file, 'utf8'))) {
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = slug(match[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

function links(file) {
  const found = [];
  prose(readFileSync(file, 'utf8')).forEach((line, index) => {
    for (const match of line.matchAll(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      found.push({ line: index + 1, target: match[2].replace(/^<|>$/g, '') });
    }
  });
  return found;
}

const readme = join(root, 'README.md');
const docs = markdownFiles(join(root, 'docs'));
const files = [readme, ...docs];

test('every relative link target exists, and every anchor resolves', () => {
  const failures = [];
  for (const file of files) {
    for (const { line, target } of links(file)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [pathPart, anchor] = target.split('#', 2);
      const targetFile = pathPart === '' ? file : resolve(dirname(file), pathPart);
      const where = `${relative(root, file)}:${line}`;
      if (!existsSync(targetFile)) {
        failures.push(`${where} missing target ${target}`);
        continue;
      }
      if (anchor !== undefined && targetFile.endsWith('.md') && !headingSlugs(targetFile).has(decodeURIComponent(anchor))) {
        failures.push(`${where} no heading "#${anchor}" in ${relative(root, targetFile)}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('docs and reference indexes link every page in their folder', () => {
  const indexes = [
    [join(root, 'docs', 'README.md'), docs.filter(file => dirname(file) === join(root, 'docs'))],
    [join(root, 'docs', 'reference', 'README.md'), docs.filter(file => dirname(file) === join(root, 'docs', 'reference'))],
  ];
  const missing = indexes.flatMap(([index, pages]) => {
    const linked = new Set(links(index).map(({ target }) => resolve(dirname(index), target.split('#', 1)[0])));
    return pages.filter(file => file !== index && !linked.has(file)).map(file => `${relative(root, index)} lacks ${relative(root, file)}`);
  });
  assert.deepEqual(missing, []);
});

test('every docs page is linked from README.md or another doc', () => {
  const linked = new Set();
  for (const file of files) {
    for (const { target } of links(file)) {
      const pathPart = target.split('#', 1)[0];
      if (pathPart === '' || /^[a-z][a-z0-9+.-]*:/i.test(pathPart)) continue;
      const targetFile = resolve(dirname(file), pathPart);
      if (targetFile !== file) linked.add(targetFile);
    }
  }
  const orphans = docs.filter(file => !linked.has(file)).map(file => relative(root, file));
  assert.deepEqual(orphans, []);
});
