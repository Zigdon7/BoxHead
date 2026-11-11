#!/usr/bin/env node
// Release check: everything that should be true before a build goes in front of players.
//
//   npm run release:check              static checks, unit tests, release builds, end-to-end tests
//   npm run release:check -- --quick   static checks and unit tests only (a few minutes less)
//   npm run release:check -- --docker  also build the Docker image and smoke-test it
//
// It changes nothing in the repository. Exit code 0 means every step passed.
// The steps and what they protect against are described in docs/PLAYTEST.md.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, delimiter } from 'node:path';
import { createServer } from 'node:net';

const ROOT = resolve(import.meta.dirname, '..');
const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';
const args = new Set(process.argv.slice(2));
const QUICK = args.has('--quick');
const DOCKER = args.has('--docker');
for (const a of args) {
  if (!['--quick', '--docker'].includes(a)) { console.error(`Unknown option ${a}. Options: --quick, --docker`); process.exit(2); }
}

const read = p => readFileSync(join(ROOT, p), 'utf8');
const results = [];
const env = toolchainEnv();

// ---------------------------------------------------------------- running things

/** Run a command, streaming its output. Returns true when it exits with 0. */
function run(cmd, { cwd = ROOT, extraEnv = {}, quiet = false } = {}) {
  const res = spawnSync(cmd, { cwd, shell: true, env: { ...env, ...extraEnv }, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  return { ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** One named step. `fn` returns a list of problems (empty = passed) or throws. */
async function step(name, fn) {
  console.log(`\n\x1b[1m▶ ${name}\x1b[0m`);
  const started = Date.now();
  let problems;
  try { problems = (await fn()) ?? []; } catch (e) { problems = [e.message]; }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  for (const p of problems) console.log(`  \x1b[31m✗\x1b[0m ${p}`);
  if (problems.length === 0) console.log(`  \x1b[32m✓\x1b[0m passed (${secs}s)`);
  results.push({ name, ok: problems.length === 0, secs });
  return problems.length === 0;
}

/** A step that is just one command. */
const command = (name, cmd, opts) => step(name, () => (run(cmd, opts).ok ? [] : [`\`${cmd}\` failed`]));

// ---------------------------------------------------------------- toolchain

/** The environment for cargo and npm. On Windows this works around three
 *  known traps (see "Windows toolchain" in the README): a stale cargo ahead of
 *  rustup's on PATH, a clang-based `gcc` ahead of the MinGW GCC that bundled
 *  SQLite needs, and a system linker that produces a release server which
 *  crashes at startup. Anything already set in the environment wins. */
function toolchainEnv() {
  const out = { ...process.env };
  if (!WIN) return out;
  const pathKey = Object.keys(out).find(k => k.toLowerCase() === 'path') ?? 'Path';
  const prepend = [];
  const rustup = join(homedir(), '.cargo', 'bin');
  if (existsSync(join(rustup, 'cargo.exe'))) prepend.push(rustup);
  const winget = join(out.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  if (existsSync(winget)) {
    const winlibs = readdirSync(winget).find(d => d.startsWith('BrechtSanders.WinLibs.POSIX.MSVCRT'));
    const bin = winlibs && join(winget, winlibs, 'mingw64', 'bin');
    if (bin && existsSync(join(bin, 'gcc.exe'))) prepend.push(bin);
  }
  if (prepend.length) out[pathKey] = [...prepend, out[pathKey]].join(delimiter);
  const linkerVar = 'CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER';
  if (!out[linkerVar]) {
    const rustupHome = out.RUSTUP_HOME ?? join(homedir(), '.rustup');
    const own = join(rustupHome, 'toolchains', 'stable-x86_64-pc-windows-gnu', 'lib', 'rustlib',
      'x86_64-pc-windows-gnu', 'bin', 'self-contained', 'x86_64-w64-mingw32-gcc.exe');
    if (existsSync(own)) out[linkerVar] = own;
  }
  return out;
}

// ---------------------------------------------------------------- static checks

const VERSION_RE = /^version = "([^"]+)"/m;

function versions() {
  const lockVersion = (path, name) => read(path).match(new RegExp(`name = "${name}"\\r?\\nversion = "([^"]+)"`))?.[1];
  const frontendLock = JSON.parse(read('frontend/package-lock.json'));
  return {
    'package.json': JSON.parse(read('package.json')).version,
    'frontend/package.json': JSON.parse(read('frontend/package.json')).version,
    'frontend/package-lock.json': frontendLock.version,
    'frontend/package-lock.json (root package)': frontendLock.packages?.['']?.version,
    'backend/Cargo.toml': read('backend/Cargo.toml').match(VERSION_RE)?.[1],
    'backend/Cargo.lock': lockVersion('backend/Cargo.lock', 'boxhead-server'),
    'dashboard/Cargo.toml': read('dashboard/Cargo.toml').match(VERSION_RE)?.[1],
    'dashboard/Cargo.lock': lockVersion('dashboard/Cargo.lock', 'boxhead-dashboard'),
  };
}

function checkVersions() {
  const all = versions();
  const want = all['backend/Cargo.toml'];
  const problems = Object.entries(all).filter(([, v]) => v !== want).map(([file, v]) => `${file} says ${v ?? 'nothing'}, backend/Cargo.toml says ${want}`);
  if (problems.length === 0) console.log(`  version ${want} everywhere`);
  return problems;
}

/** Rust source files under a crate's src/. */
function rustSources(crate) {
  return readdirSync(join(ROOT, crate, 'src')).filter(f => f.endsWith('.rs')).map(f => read(join(crate, 'src', f)));
}

/** Every setting the servers read must be explained where a host will look for it. */
function checkSettingsDocumented() {
  const names = new Set();
  for (const src of [...rustSources('backend'), ...rustSources('dashboard')]) {
    for (const m of src.matchAll(/\bvar(?:_os)?\("([A-Z][A-Z0-9_]+)"\)/g)) names.add(m[1]);
  }
  const docs = read('README.md') + read('docs/HOSTING.md');
  const problems = [...names].filter(n => !docs.includes(`\`${n}\``)).map(n => `${n} is read by the code but not described in README.md or docs/HOSTING.md`);

  // Everything compose.yaml takes from .env must be listed in .env.example.
  const example = read('.env.example');
  const composeVars = new Set([...read('compose.yaml').matchAll(/\$\{([A-Z][A-Z0-9_]+)/g)].map(m => m[1]));
  for (const v of composeVars) {
    if (!new RegExp(`^#?\\s*${v}=`, 'm').test(example)) problems.push(`${v} is used by compose.yaml but missing from .env.example`);
  }
  if (problems.length === 0) console.log(`  ${names.size} server settings documented, ${composeVars.size} compose settings in .env.example`);
  return problems;
}

/** Relative links in the Markdown docs must point at files that exist. */
function checkDocLinks() {
  const files = ['README.md', ...readdirSync(join(ROOT, 'docs')).filter(f => f.endsWith('.md')).map(f => `docs/${f}`)];
  const problems = [];
  let count = 0;
  for (const file of files) {
    for (const m of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // same-page anchor or absolute URL
      count++;
      if (!existsSync(join(ROOT, dirname(file), target))) problems.push(`${file} links to ${m[1]}, which doesn't exist`);
    }
  }
  if (problems.length === 0) console.log(`  ${count} relative links in ${files.length} documents resolve`);
  return problems;
}

/** frontend/src/generated/types.ts must be what schema/types.json generates. */
function checkGeneratedTypes() {
  const dir = mkdtempSync(join(tmpdir(), 'boxhead-types-'));
  try {
    const out = join(dir, 'types.ts');
    const res = run(`npx json2ts ../schema/types.json -o "${out}" --unreachableDefinitions`, { cwd: join(ROOT, 'frontend'), quiet: true });
    if (!res.ok) return [`json2ts failed: ${res.out.trim().split('\n').pop()}`];
    const norm = s => s.replace(/\r\n/g, '\n');
    return norm(readFileSync(out, 'utf8')) === norm(read('frontend/src/generated/types.ts'))
      ? [] : ['frontend/src/generated/types.ts is out of date: run `npm run generate:types` and commit the result'];
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The built website has every page the server links to. */
function checkBundle() {
  return ['index.html', 'learn.html', 'about.html'].filter(f => !existsSync(join(ROOT, 'frontend', 'dist', f))).map(f => `frontend/dist/${f} was not built`);
}

// ---------------------------------------------------------------- docker

const freePort = () => new Promise((res, rej) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Build the image, start it on a throwaway volume and ask it who it is. */
async function dockerSmoke(version) {
  if (!run('docker info', { quiet: true }).ok) return ['Docker is not running'];
  // compose.yaml must parse with nothing but the required settings.
  const dir = mkdtempSync(join(tmpdir(), 'boxhead-compose-'));
  const envFile = join(dir, 'env');
  writeFileSync(envFile, 'BASE_URL=https://play.example.com\nBOXHEAD_OPS_TOKEN=check\nDASHBOARD_PASSWORD=check\n');
  const config = run(`docker compose --env-file "${envFile}" --profile tunnel --profile caddy config -q`, { quiet: true });
  rmSync(dir, { recursive: true, force: true });
  if (!config.ok) return [`compose.yaml does not validate: ${config.out.trim()}`];

  // Built the way compose builds it: the build label goes in as a build argument.
  const tag = 'boxhead:release-check';
  if (!run(`docker build --build-arg BOXHEAD_BUILD=release-check -t ${tag} .`).ok) return ['docker build failed'];
  const name = `boxhead-release-check-${process.pid}`;
  const port = await freePort();
  const started = run(`docker run -d --rm --name ${name} -p 127.0.0.1:${port}:3001 -e BASE_URL=http://127.0.0.1:${port} ${tag}`, { quiet: true });
  if (!started.ok) return [`docker run failed: ${started.out.trim()}`];
  try {
    const base = `http://127.0.0.1:${port}`;
    let health = '';
    for (let i = 0; i < 60 && health !== 'ok'; i++) {
      health = await fetch(`${base}/healthz`).then(r => r.text()).catch(() => '');
      if (health !== 'ok') await sleep(500);
    }
    if (health !== 'ok') return [`the container never answered /healthz:\n${run(`docker logs ${name}`, { quiet: true }).out}`];
    const problems = [];
    const config = await fetch(`${base}/api/config`).then(r => r.json());
    if (config.version !== version) problems.push(`the image reports version ${config.version}, expected ${version}`);
    if (config.build !== 'release-check') problems.push('the image lost its BOXHEAD_BUILD label');
    for (const page of ['/', '/learn.html', '/about.html']) {
      const res = await fetch(base + page);
      if (res.status !== 200) problems.push(`${page} answered ${res.status} from the image`);
    }
    const maps = await fetch(`${base}/api/maps`).then(r => r.json());
    if (maps.maps?.length !== 4) problems.push('the image does not list the four maps');
    if (problems.length === 0) console.log(`  image ${tag} serves version ${config.version} and the website`);
    return problems;
  } finally {
    run(`docker stop ${name}`, { quiet: true });
    run(`docker rmi ${tag}`, { quiet: true });
  }
}

// ---------------------------------------------------------------- the run

const git = cmd => run(`git ${cmd}`, { quiet: true }).out.trimEnd();
const version = versions()['backend/Cargo.toml'];
console.log(`BoxHead release check · version ${version} · ${git('rev-parse --abbrev-ref HEAD')} @ ${git('rev-parse --short HEAD')}`);
const dirty = git('status --porcelain');
if (dirty) console.log(`\x1b[33mNote: the working tree has uncommitted changes, so this checks more than the commit above:\x1b[0m\n${dirty}`);
for (const tool of ['node --version', 'cargo --version', 'rustc --version']) console.log(`  ${run(tool, { quiet: true, cwd: join(ROOT, 'backend') }).out.trim() || `${tool.split(' ')[0]}: NOT FOUND`}`);

await step('Versions agree', checkVersions);
await step('Settings are documented', checkSettingsDocumented);
await step('Documentation links resolve', checkDocLinks);
if (!existsSync(join(ROOT, 'frontend', 'node_modules'))) await command('Install frontend packages', 'npm ci', { cwd: join(ROOT, 'frontend') });
await step('Generated types match the schema', checkGeneratedTypes);
await command('Frontend typecheck', 'npm run typecheck', { cwd: join(ROOT, 'frontend') });
await command('Frontend unit tests', 'npm test', { cwd: join(ROOT, 'frontend') });
await command('Backend unit tests', 'cargo test --locked', { cwd: join(ROOT, 'backend') });
await command('Dashboard unit tests', 'cargo test --locked', { cwd: join(ROOT, 'dashboard') });

if (!QUICK) {
  const built = await command('Build the website', 'npm run build', { cwd: join(ROOT, 'frontend') });
  await step('The website has every page', checkBundle);
  const server = await command('Build the game server (release)', 'cargo build --release --locked', { cwd: join(ROOT, 'backend') });
  const dash = await command('Build the dashboard (release)', 'cargo build --release --locked', { cwd: join(ROOT, 'dashboard') });
  if (built && server && dash) {
    // The same suite as `npm run test:e2e`, against the optimized binaries that ship.
    await command('End-to-end tests against the release binaries', 'node --test --test-reporter=dot tests/e2e/server.test.mjs', {
      extraEnv: {
        BOXHEAD_SERVER_BIN: join(ROOT, 'backend', 'target', 'release', `boxhead-server${EXE}`),
        BOXHEAD_DASHBOARD_BIN: join(ROOT, 'dashboard', 'target', 'release', `boxhead-dashboard${EXE}`),
      },
    });
  } else {
    results.push({ name: 'End-to-end tests against the release binaries', ok: false, secs: '0.0' });
    console.log('\n\x1b[31mSkipped the end-to-end tests: a build failed.\x1b[0m');
  }
}

if (DOCKER) await step('Docker image builds and serves the game', () => dockerSmoke(version));

console.log('\n\x1b[1mSummary\x1b[0m');
for (const r of results) console.log(`  ${r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${r.name} (${r.secs}s)`);
const failed = results.filter(r => !r.ok);
const skipped = [QUICK && 'release builds and end-to-end tests (--quick)', !DOCKER && 'the Docker image (add --docker)'].filter(Boolean);
if (skipped.length) console.log(`  Not checked: ${skipped.join('; ')}.`);
if (failed.length) {
  console.log(`\n\x1b[31m${failed.length} of ${results.length} checks failed.\x1b[0m Do not ship this build.`);
  process.exit(1);
}
console.log(`\n\x1b[32mAll ${results.length} checks passed for ${version}.\x1b[0m`);
