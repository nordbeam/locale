import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { installSkills, listBundledSkills, skillManifestName } from '../dist/skills.js';
import { commandNames, optionHelp } from '../dist/cli-help.js';
import { temporary } from './helpers.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const skillsRoot = join(root, 'skills');
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runtimePackage = JSON.parse(readFileSync(join(root, 'packages/locale/package.json'), 'utf8'));
const cli = (cwd, ...args) => spawnSync(process.execPath, [join(root, 'dist/cli.js'), ...args], { cwd, encoding: 'utf8' });
const json = result => JSON.parse(result.stdout);

function files(directory, prefix = '') {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(directory, path) : [path];
  });
}
const skillNames = readdirSync(skillsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

/** Fenced code blocks of a markdown file, as { lang, text }. */
function codeBlocks(text) {
  return [...text.matchAll(/^```(\w*)\n([\s\S]*?)^```/gm)].map(match => ({ lang: match[1], text: match[2] }));
}

test('the repository ships the two documented skills', () => {
  assert.deepEqual(skillNames, ['nordbeam-locale', 'nordbeam-locale-migrate']);
});

for (const name of skillNames) {
  test(`skill ${name} follows the Agent Skills format`, () => {
    const dir = join(skillsRoot, name);
    const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(match, 'frontmatter must start on the first line');
    // A strict YAML parser must accept the frontmatter: unquoted ": " in a description breaks several skill loaders.
    const front = parseYaml(match[1]);
    assert.deepEqual(Object.keys(front).sort(), ['compatibility', 'description', 'license', 'name']);
    const field = key => front[key];
    assert.equal(field('name'), name, 'name must equal the directory name');
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(name.length <= 64);
    const description = field('description');
    assert.ok(description && description.length > 200 && description.length <= 1024, `description length ${description?.length}`);
    assert.ok(!description.includes('\n'));
    assert.ok((field('compatibility') ?? '').length <= 500);
    assert.ok(text.split('\n').length < 500, 'SKILL.md should stay under 500 lines');
    assert.equal(field('license'), 'Apache-2.0');
  });

  test(`skill ${name} has valid relative links and valid eval files`, () => {
    const dir = join(skillsRoot, name);
    const markdown = files(dir).filter(file => file.endsWith('.md'));
    assert.ok(markdown.includes('SKILL.md'));
    for (const file of markdown) {
      const text = readFileSync(join(dir, file), 'utf8').replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^(https?:|#|mailto:)/.test(target)) continue;
        const path = resolve(dirname(join(dir, file)), target.split('#')[0]);
        assert.ok(existsSync(path), `${name}/${file} links to missing ${target}`);
      }
    }
    for (const file of readdirSync(join(dir, 'references'))) {
      assert.ok(readFileSync(join(dir, 'SKILL.md'), 'utf8').includes(`references/${file}`) || markdown.some(other => other !== `references/${file}` && readFileSync(join(dir, other), 'utf8').includes(file)), `references/${file} is not linked from anywhere`);
    }
    const evals = JSON.parse(readFileSync(join(dir, 'evals/evals.json'), 'utf8'));
    assert.equal(evals.skill_name, name);
    assert.ok(evals.evals.length >= 5);
    assert.deepEqual(evals.evals.map(item => item.id), evals.evals.map((_, index) => index + 1));
    for (const item of evals.evals) {
      assert.ok(item.prompt.length > 40 && item.expected_output && item.expectations.length >= 3, `eval ${item.id}`);
    }
    const triggers = JSON.parse(readFileSync(join(dir, 'evals/trigger-evals.json'), 'utf8'));
    assert.ok(triggers.filter(item => item.should_trigger).length >= 8 && triggers.filter(item => !item.should_trigger).length >= 8);
    for (const item of triggers) assert.ok(typeof item.query === 'string' && typeof item.should_trigger === 'boolean');
  });

  test(`skill ${name} only names real package entries, commands and options`, () => {
    const dir = join(skillsRoot, name);
    const entries = pkg => Object.keys(pkg.exports).map(key => key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`);
    const migrateExports = ['codemods', 'project', 'next', 'react', 'frameworks', 'catalog'].map(key => `@nordbeam/locale-migrate/${key}`);
    const known = new Set([...entries(rootPackage), ...entries(runtimePackage), ...migrateExports, '@nordbeam/locale-migrate']);
    for (const file of files(dir).filter(item => item.endsWith('.md'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const [, specifier] of text.matchAll(/['"`](@nordbeam\/locale(?:-migrate)?(?:\/[a-z/]+)?|nordbeam-locale\/[a-z/]+)['"`]/g)) {
        assert.ok(known.has(specifier), `${name}/${file} imports unknown entry ${specifier}`);
      }
      for (const block of codeBlocks(text)) {
        for (const line of block.text.split('\n')) {
          const command = /(?:^|\s)(?:npx )?nordbeam-locale(?: ([a-z][a-z-]*))?((?: .*)?)$/.exec(line.replace(/^\s*(?:\$|#)\s*/, ''));
          if (!command || /^\s*(?:import|\/\/|\*)/.test(line) || !/^\s*(?:npx |nordbeam-locale|claude |\$)/.test(line)) continue;
          const sub = command[1];
          if (sub && !['npm', 'to'].includes(sub)) assert.ok(commandNames.includes(sub) || sub === 'help', `${name}/${file}: unknown command ${sub} in "${line.trim()}"`);
          for (const [, option] of command[2].matchAll(/ --([a-z][a-z-]*)/g)) {
            assert.ok(option in optionHelp, `${name}/${file}: unknown option --${option} in "${line.trim()}"`);
          }
        }
      }
    }
  });
}

test('the package ships the skills without their evals', () => {
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  const paths = JSON.parse(pack.stdout)[0].files.map(file => file.path);
  for (const name of skillNames) assert.ok(paths.includes(`skills/${name}/SKILL.md`), `${name} is not packed`);
  assert.ok(paths.some(path => path.startsWith('skills/nordbeam-locale/references/')));
  assert.equal(paths.filter(path => path.includes('/evals/')).length, 0, 'evals must not ship');
});

test('the Claude Code marketplace and plugin manifests are consistent with the skills', () => {
  const marketplace = JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(marketplace.name, 'nordbeam');
  assert.ok(marketplace.owner?.name);
  const plugin = marketplace.plugins.find(item => item.name === 'nordbeam-locale');
  assert.ok(plugin, 'plugin nordbeam-locale');
  assert.equal(plugin.source, './');
  assert.equal(plugin.strict, false);
  assert.deepEqual([...plugin.skills].sort(), skillNames.map(name => `./skills/${name}`));
  for (const path of plugin.skills) assert.ok(existsSync(join(root, path, 'SKILL.md')));
});

test('installSkills creates both targets, is idempotent, and reports counts', async t => {
  const dir = await temporary(t);
  const first = await installSkills(dir, { version: '1.0.0' });
  assert.deepEqual(first.skills.map(item => `${item.target}:${item.skill}:${item.action}`), [
    'claude:nordbeam-locale:created', 'claude:nordbeam-locale-migrate:created', 'agents:nordbeam-locale:created', 'agents:nordbeam-locale-migrate:created',
  ]);
  for (const target of ['.claude/skills', '.agents/skills']) {
    for (const name of skillNames) {
      assert.ok(existsSync(join(dir, target, name, 'SKILL.md')));
      assert.equal(existsSync(join(dir, target, name, 'evals')), false, 'evals are not installed');
      assert.deepEqual(files(join(dir, target, name)).filter(file => file !== skillManifestName).sort(), files(join(skillsRoot, name)).filter(file => !file.startsWith('evals/')).sort());
    }
  }
  const second = await installSkills(dir, { version: '1.0.0' });
  assert.ok(second.skills.every(item => item.action === 'unchanged' && item.counts.created === 0 && item.counts.skipped === 0));
});

test('installSkills never clobbers local edits and updates only files it installed unmodified', async t => {
  const source = await temporary(t);
  const project = await temporary(t);
  await mkdir(join(source, 'demo/references'), { recursive: true });
  await writeFile(join(source, 'demo/SKILL.md'), '---\nname: demo\ndescription: d\n---\nv1\n');
  await writeFile(join(source, 'demo/references/a.md'), 'a1\n');
  await writeFile(join(source, 'demo/references/gone.md'), 'gone\n');
  const options = { targets: ['claude'], version: '1', source };
  await installSkills(project, options);
  const base = join(project, '.claude/skills/demo');
  await writeFile(join(base, 'references/a.md'), 'edited by the user\n');
  await writeFile(join(source, 'demo/SKILL.md'), '---\nname: demo\ndescription: d\n---\nv2\n');
  await writeFile(join(source, 'demo/references/a.md'), 'a2\n');
  await rm(join(source, 'demo/references/gone.md'));
  const result = (await installSkills(project, { ...options, version: '2' })).skills[0];
  const byFile = Object.fromEntries(result.files.map(item => [item.file.slice(base.length + 1), item]));
  assert.equal(byFile['SKILL.md'].action, 'updated');
  assert.equal(byFile['references/a.md'].action, 'skipped');
  assert.match(byFile['references/a.md'].reason, /edited after installation/);
  assert.equal(byFile['references/gone.md'].action, 'removed');
  assert.equal(await readFile(join(base, 'references/a.md'), 'utf8'), 'edited by the user\n');
  assert.match(await readFile(join(base, 'SKILL.md'), 'utf8'), /v2/);
  assert.equal(existsSync(join(base, 'references/gone.md')), false);
  // A third run with the same sources keeps skipping the edited file, even though it differs.
  const third = (await installSkills(project, { ...options, version: '2' })).skills[0];
  assert.equal(third.counts.skipped, 1);
  assert.equal(await readFile(join(base, 'references/a.md'), 'utf8'), 'edited by the user\n');
  // Once the user reverts to the shipped content the file is adopted again.
  await writeFile(join(base, 'references/a.md'), 'a2\n');
  assert.equal((await installSkills(project, { ...options, version: '2' })).skills[0].counts.skipped, 0);
});

test('installSkills leaves unmanaged files, symlinked skills and dry runs alone', async t => {
  const project = await temporary(t);
  const own = join(project, '.claude/skills/nordbeam-locale');
  await mkdir(own, { recursive: true });
  await writeFile(join(own, 'SKILL.md'), 'my own skill\n');
  const linked = join(project, '.agents/skills');
  await mkdir(linked, { recursive: true });
  const elsewhere = join(project, 'shared/nordbeam-locale-migrate');
  await mkdir(elsewhere, { recursive: true });
  await symlink(elsewhere, join(linked, 'nordbeam-locale-migrate'));
  const dry = await installSkills(project, { version: '1', dryRun: true, skills: ['nordbeam-locale'], targets: ['agents'] });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.skills[0].action, 'created');
  assert.equal(existsSync(join(linked, 'nordbeam-locale')), false, 'a dry run writes nothing');
  const result = await installSkills(project, { version: '1' });
  const find = (target, skill) => result.skills.find(item => item.target === target && item.skill === skill);
  assert.equal(await readFile(join(own, 'SKILL.md'), 'utf8'), 'my own skill\n');
  assert.equal(find('claude', 'nordbeam-locale').files.find(item => item.file.endsWith('/SKILL.md')).action, 'skipped');
  assert.match(find('claude', 'nordbeam-locale').files.find(item => item.file.endsWith('/SKILL.md')).reason, /not installed by nordbeam-locale/);
  assert.equal(find('agents', 'nordbeam-locale-migrate').action, 'skipped');
  assert.match(find('agents', 'nordbeam-locale-migrate').reason, /symbolic link/);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.deepEqual(await listBundledSkills(), skillNames);
  await assert.rejects(installSkills(project, { version: '1', skills: ['nope'] }), error => error.code === 'USAGE' && error.details.validValues.includes('nordbeam-locale'));
});

test('skills install works from the CLI with JSON, filters and exit codes', async t => {
  const dir = await temporary(t);
  const preview = cli(dir, 'skills', 'install', '--dry-run', '--json');
  assert.equal(preview.status, 0, preview.stderr);
  const previewBody = json(preview);
  assert.equal(previewBody.ok, true);
  assert.equal(previewBody.dryRun, true);
  assert.equal(previewBody.version, rootPackage.version);
  assert.equal(previewBody.totals.skipped, 0);
  assert.equal(existsSync(join(dir, '.claude')), false);
  const only = json(cli(dir, 'skills', 'install', '--target', 'claude', '--skill', 'nordbeam-locale', '--json'));
  assert.equal(only.skills.length, 1);
  assert.equal(only.skills[0].directory, '.claude/skills/nordbeam-locale');
  assert.ok(only.skills[0].files.every(item => item.file.startsWith('.claude/skills/nordbeam-locale/') && item.action === 'created'));
  assert.ok(existsSync(join(dir, '.claude/skills/nordbeam-locale/SKILL.md')));
  assert.equal(existsSync(join(dir, '.agents')), false);
  const human = cli(dir, 'skills', 'install');
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Preserved skill nordbeam-locale in \.claude\/skills\/nordbeam-locale \(\d+ files\)/);
  assert.match(human.stdout, /Created skill nordbeam-locale-migrate in \.agents\/skills\/nordbeam-locale-migrate/);
  for (const args of [['skills'], ['skills', 'list'], ['skills', 'install', '--target', 'cursor'], ['skills', 'install', '--skill', 'nope'], ['skills', 'install', '--write']]) {
    const bad = cli(dir, ...args, '--json');
    assert.equal(bad.status, 2, `${args.join(' ')}: ${bad.stdout}${bad.stderr}`);
    assert.equal(json(bad).errors[0].code, 'USAGE');
  }
  assert.equal(cli(dir, 'skills', 'install', '--ndjson').status, 2);
  const misuse = cli(dir, 'check', '--target', 'claude');
  assert.equal(misuse.status, 2);
  assert.match(misuse.stderr, /--target and --skill are available with nordbeam-locale skills install/);
});

test('init --agent installs the skills and points AGENTS.md at them without touching edits', async t => {
  const dir = await temporary(t);
  const first = cli(dir, 'init', '--agent', '--json');
  assert.equal(first.status, 0, first.stderr);
  const body = json(first);
  assert.equal(body.agentFiles[0].file, 'AGENTS.md');
  assert.equal(body.agentSkills.length, 4);
  assert.ok(body.agentSkills.every(item => item.action === 'created'));
  const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /\.claude\/skills\/nordbeam-locale\/` and `\.agents\/skills\/nordbeam-locale\//);
  assert.match(agents, /nordbeam-locale-migrate/);
  const skill = join(dir, '.agents/skills/nordbeam-locale/SKILL.md');
  await writeFile(skill, 'locally edited\n');
  // init --agent on an existing configuration only refreshes the agent files.
  const again = json(cli(dir, 'init', '--agent', '--json'));
  assert.equal(again.agentFiles[0].action, 'unchanged');
  const edited = again.agentSkills.find(item => item.target === 'agents' && item.skill === 'nordbeam-locale');
  assert.equal(edited.counts.skipped, 1);
  assert.equal(await readFile(skill, 'utf8'), 'locally edited\n');
  const plain = cli(dir, 'init', '--agent');
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /Preserved skill nordbeam-locale-migrate in \.claude\/skills\/nordbeam-locale-migrate/);
  assert.match(plain.stderr, /\.agents\/skills\/nordbeam-locale\/SKILL\.md: The file was not installed by nordbeam-locale|\.agents\/skills\/nordbeam-locale\/SKILL\.md: The file was edited after installation/);
});

test('capabilities, help and the agent guide describe the skills command and the shipped skills', () => {
  const capabilities = json(cli(root, 'capabilities', '--json'));
  const command = capabilities.commands.find(item => item.name === 'skills');
  assert.equal(command.access, 'write');
  assert.equal(command.preview, true);
  assert.equal(command.idempotent, true);
  assert.deepEqual(command.options, ['target', 'skill']);
  assert.match(command.invocation, /^skills install /);
  assert.match(capabilities.commands.find(item => item.name === 'init').summary, /installs the bundled agent skills/);
  const help = cli(root, 'help', 'skills');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--target <claude\|agents\|all>/);
  assert.match(help.stdout, /--skill <name>/);
  assert.match(help.stdout, /--dry-run/);
  assert.match(cli(root, '--help').stdout, /^  skills\s/m);
  assert.match(cli(root, 'agent-guide').stdout, /nordbeam-locale-migrate/);
});
