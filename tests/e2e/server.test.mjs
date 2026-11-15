// End-to-end tests: boots the real server binary against a throwaway database
// and drives it over HTTP + WebSocket exactly like the browser client does.
//
// Also boots the separate ops dashboard service against the game server's
// internal ops API (plus a dead server, to check outage reporting).
//
// Run: node --test tests/e2e/server.test.mjs  (after building backend, dashboard and frontend)
// Override binaries with BOXHEAD_SERVER_BIN / BOXHEAD_DASHBOARD_BIN.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(import.meta.dirname, '..', '..');
/** The server version, from backend/Cargo.toml. */
const VERSION = readFileSync(joinPath(ROOT, 'backend', 'Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1];
const EMPTY_TTL_SECS = 2;
const EXE = process.platform === 'win32' ? '.exe' : '';
const BIN = process.env.BOXHEAD_SERVER_BIN ?? joinPath(ROOT, 'backend', 'target', 'debug', `boxhead-server${EXE}`);
const DASH_BIN = process.env.BOXHEAD_DASHBOARD_BIN ?? joinPath(ROOT, 'dashboard', 'target', 'debug', `boxhead-dashboard${EXE}`);
const OPS_TOKEN = `ops-${randomUUID()}`;
const SIM_THREADS = 4;
const PUBLISH_THREADS = 2;
const MAX_ROOMS = 64;
// What the main test server is told about its build (shown on the home screen).
const BUILD = 'e2e1234';
const FEEDBACK_URL = 'https://example.com/boxhead/feedback';
const NOTICE = 'Playtest build. Progress may be wiped.';

let server;
let dashboard;
let workDir;
let base;
let wsUrl;
let opsBase;
let dashBase;
let deadServer;
let outbox;
const extraProcesses = [];

// ---------------------------------------------------------------- helpers

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    }).on('error', rej);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitUntil(fn, { timeout = 8000, interval = 100, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await sleep(interval);
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { status: res.status, text }; }
}

/** The lobby list. Without a token it is seen by a signed-in email account
 *  (the pool every test account is in); pass '' to look as a signed-out visitor. */
let viewerToken;
const listRooms = async token => {
  if (token === undefined) token = viewerToken ??= (await signUp({ operator: false })).token;
  return api(`/api/rooms?token=${encodeURIComponent(token)}`);
};
/** Host a lobby. Without a token this signs up a fresh account to host it. */
const createRoom = async (name, { token, map } = {}) => {
  if (token === undefined) token = (await signUp()).token;
  return api('/api/rooms', { method: 'POST', body: { token, name, map } });
};
const setCrossplay = (token, enabled) => api('/api/matchmaking/crossplay', { method: 'POST', body: { token, enabled } });

/** Create a lobby that the test depends on, failing loudly if the server refuses. */
async function mustCreate(name, opts) {
  const res = await createRoom(name, opts);
  assert.equal(res.ok, true, `could not create lobby "${name}": ${JSON.stringify(res)}`);
  return res;
}

/** Emails the server "sent" to `to` (the e2e server writes mail to an outbox folder). */
function mailTo(to, dir = outbox) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map(f => JSON.parse(readFileSync(joinPath(dir, f), 'utf8'))).filter(m => m.to === to);
}

/** Wait for an email to `to` whose body matches `pattern`; returns the first capture group. */
async function linkFromMail(to, pattern, dir = outbox) {
  return waitUntil(() => {
    for (const m of mailTo(to, dir)) { const hit = m.body.match(pattern); if (hit) return hit[1]; }
    return null;
  }, { timeout: 4000, message: `email to ${to}` });
}

/** Follow the confirmation link emailed to `email`. */
async function confirmEmail(email) {
  const token = await linkFromMail(email, /email\/confirm\?token=([0-9a-f]+)/);
  const res = await fetch(`${base}/api/auth/email/confirm?token=${token}`, { redirect: 'manual' });
  assert.equal(res.headers.get('location'), '/?email=confirmed');
}

/** A fresh, email-confirmed account. By default it also creates a safe operator, since an
 *  account can't deploy or trade without one; pass `{ operator: false }` to skip. */
async function signUp({ operator = true, raidable = false, confirm = true } = {}) {
  const email = `tester-${randomUUID()}@example.com`;
  const res = await api('/api/auth/email/register', { method: 'POST', body: { email, password: 'hunter22' } });
  assert.equal(res.ok, true, JSON.stringify(res));
  if (confirm) await confirmEmail(email);
  if (operator) {
    const made = await api('/api/hideout/createOperator', { method: 'POST', body: { token: res.token, name: 'Tester', raidable } });
    assert.equal(made.ok, true, JSON.stringify(made));
  }
  return { ...res, email, password: 'hunter22' };
}

class Client {
  constructor(path = '') {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(wsUrl + path);
    this.opened = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.closed = new Promise(res => this.ws.addEventListener('close', res, { once: true }));
    this.ws.addEventListener('message', e => {
      const msg = JSON.parse(e.data);
      this.messages.push(msg);
      this.waiters = this.waiters.filter(w => (w.pred(msg) ? (w.res(msg), false) : true));
    });
  }
  send(obj) { this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
  /** Resolve with the first message (already received or future) matching pred. */
  waitFor(pred, timeout = 4000, label = 'message') {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`Timed out waiting for ${label}`)), timeout);
      this.waiters.push({ pred, res: m => { clearTimeout(timer); res(m); } });
    });
  }
  /** Only messages arriving after this call. Use `mark()` + `waitAfter()` when
   *  the trigger is an awaited request: the reply could land before this runs. */
  waitForNext(pred, timeout, label) {
    return this.waitAfter(this.mark(), pred, timeout, label);
  }
  mark() { return this.messages.length; }
  /** Messages received after `mark` (an index from `mark()`). */
  waitAfter(mark, pred, timeout, label) {
    return this.waitFor((m) => this.messages.indexOf(m) >= mark && pred(m), timeout, label);
  }
  async close() {
    if (this.ws.readyState <= 1) this.ws.close();
    await this.closed;
    await sleep(50); // let the server finish cleanup
  }
}

/** Open a socket and join. Without a token this signs up a fresh account first
 *  (there is no guest play); pass `token: ''` or a bogus one to test refusals. */
async function join(opts = {}) {
  const token = 'token' in opts ? opts.token : (await signUp()).token;
  const c = new Client();
  await c.opened;
  c.send({ type: 'join', name: 'Tester', ...opts, token });
  return c;
}

/** Join and wait until the server confirms with init + snapshot. */
async function joinOk(opts) {
  const c = await join(opts);
  const first = await c.waitFor(m => m.type === 'init' || m.type === 'joinError', 4000, 'init');
  assert.equal(first.type, 'init', `expected init, got ${JSON.stringify(first)}`);
  c.id = first.id;
  c.init = first;
  c.snapshot = await c.waitFor(m => m.type === 'snapshot', 4000, 'snapshot');
  return c;
}

/** Join expecting a refusal: returns the joinError and asserts the socket closes. */
async function joinRefused(opts) {
  const c = await join(opts);
  const msg = await c.waitFor(m => m.type === 'joinError' || m.type === 'init', 4000, 'joinError');
  assert.equal(msg.type, 'joinError', `expected joinError, got ${JSON.stringify(msg)}`);
  await Promise.race([c.closed, sleep(3000).then(() => { throw new Error('socket not closed after joinError'); })]);
  assert.ok(!c.messages.some(m => m.type === 'init' || m.type === 'snapshot'), 'refused client must not receive game state');
  return msg;
}

const idle = { up: false, down: false, left: false, right: false, mouseX: 0, mouseY: 0, shooting: false, melee: false, selectWeapon: 0 };

// ---------------------------------------------------------------- lifecycle

/** Spawn a binary, capturing output; `ready` polls until it is serving. */
async function launch(bin, { env, cwd, ready }) {
  const child = spawn(bin, [], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  child.stdout.on('data', d => { child.log += d; });
  child.stderr.on('data', d => { child.log += d; });
  child.exitCode$ = new Promise((res, rej) => {
    child.once('exit', code => res(code));
    child.once('error', rej);
  });
  if (ready) {
    const died = child.exitCode$.then(code => { throw new Error(`${bin} exited (${code}):\n${child.log}`); });
    try {
      await Promise.race([died, waitUntil(ready, { message: `${bin} to start` })]);
    } catch (error) {
      // A failed launch never reaches the caller's cleanup list. Stop it here
      // so startup failures report their logs and cannot hang the whole suite.
      child.kill();
      await child.exitCode$.catch(() => {});
      throw new Error(`${error.message}\nStartup output:\n${child.log}`, { cause: error });
    }
  }
  return child;
}

before(async () => {
  assert.ok(existsSync(BIN), `Server binary not found at ${BIN}. Run cargo build in backend/ first.`);
  assert.ok(existsSync(DASH_BIN), `Dashboard binary not found at ${DASH_BIN}. Run cargo build in dashboard/ first.`);
  workDir = mkdtempSync(joinPath(tmpdir(), 'boxhead-e2e-'));
  outbox = joinPath(workDir, 'outbox');
  const [port, opsPort, dashPort, deadPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
  opsBase = `http://127.0.0.1:${opsPort}`;
  dashBase = `http://127.0.0.1:${dashPort}`;
  deadServer = `http://127.0.0.1:${deadPort}`;
  server = await launch(BIN, {
    cwd: workDir, // fresh boxhead.db per run
    env: {
      PORT: String(port),
      STATIC_DIR: joinPath(ROOT, 'frontend', 'dist'),
      BOXHEAD_EMPTY_ROOM_TTL_SECS: String(EMPTY_TTL_SECS),
      BOXHEAD_OPS_TOKEN: OPS_TOKEN,
      BOXHEAD_OPS_ADDR: `127.0.0.1:${opsPort}`,
      BOXHEAD_SERVER_ID: 'e2e-game',
      BOXHEAD_SIM_THREADS: String(SIM_THREADS),
      BOXHEAD_PUBLISH_THREADS: String(PUBLISH_THREADS),
      BOXHEAD_MAX_ROOMS: String(MAX_ROOMS),
      BOXHEAD_MAIL_OUTBOX: outbox,
      // The suite signs up hundreds of accounts from one address; limits get their own server below.
      BOXHEAD_RATE_LIMIT: 'off',
      BOXHEAD_PVP: '1',
      BOXHEAD_BUILD: BUILD,
      BOXHEAD_FEEDBACK_URL: FEEDBACK_URL,
      BOXHEAD_NOTICE: `  ${NOTICE}  `,
    },
    ready: () => listRooms('').then(r => r.ok).catch(() => false),
  });
  dashboard = await launch(DASH_BIN, {
    cwd: workDir,
    env: {
      BOXHEAD_OPS_TOKEN: OPS_TOKEN,
      GAME_SERVERS: `${opsBase}, ${deadServer}`,
      DASHBOARD_ADDR: `127.0.0.1:${dashPort}`,
      DASHBOARD_POLL_MS: '250',
    },
    ready: () => fetch(`${dashBase}/healthz`).then(r => r.ok).catch(() => false),
  });
});

after(async () => {
  for (const child of [server, dashboard, ...extraProcesses]) child?.kill();
  await sleep(200);
  for (let i = 0; i < 10 && workDir; i++) {
    try { rmSync(workDir, { recursive: true, force: true }); break; } catch { await sleep(200); }
  }
});

// ---------------------------------------------------------------- rooms API

describe('server browser API', () => {
  test('lists one official raid for every map in your matchmaking pool', async () => {
    const res = await listRooms();
    assert.equal(res.ok, true);
    assert.deepEqual(res.matchmaking, {
      platform: { id: 'direct', label: 'Email & Google' }, crossplay: false, pool: { id: 'direct', label: 'Email & Google' },
    });
    for (const map of ['outskirts', 'rustyard', 'quarantine', 'blacksite']) {
      const open = res.rooms.find(r => r.id === `${map}-direct`);
      assert.ok(open, `official raid for ${map}`);
      assert.deepEqual([open.pool.id, open.permanent, open.map.id, open.canJoin], ['direct', true, map, true]);
    }
    assert.ok(res.rooms.every(r => r.pool.id === 'direct'), 'only your own pool is listed');
    assert.equal(res.rooms.find(r => r.id === 'outskirts-direct').name, 'Outskirts');
    assert.equal(res.rooms.find(r => r.id === 'rustyard-direct').map.minGearScore, 20);
    const tiers = res.rooms.map(r => r.map.tier);
    assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b), 'listed in map order');
  });

  test('hosted raids are on the map you choose', async () => {
    const res = await createRoom('Deep Run', { map: 'blacksite' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.room.map.id, 'blacksite');
    assert.equal((await createRoom('Nowhere', { map: 'atlantis' })).ok, false);
  });

  test('signed-out visitors can browse the cross-platform raids but not join', async () => {
    const res = await listRooms('');
    assert.equal(res.verified, false);
    assert.equal(res.matchmaking, null);
    assert.ok(res.rooms.length >= 4);
    assert.ok(res.rooms.every(r => r.pool.id === 'cross' && !r.canJoin));
  });

  test('signed-in accounts are verified and can join every room', async () => {
    const { token } = await signUp();
    const res = await listRooms(token);
    assert.equal(res.verified, true);
    assert.ok(res.rooms.every(r => r.canJoin));
  });

  test('a bogus token is treated as signed out', async () => {
    const res = await listRooms('not-a-real-token');
    assert.equal(res.verified, false);
  });

  test('signed-in players host open lobbies that others can see and join', async () => {
    const created = await createRoom('Randos Welcome');
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.room.pool.id, 'direct');
    assert.equal(created.room.permanent, false);
    const { token } = await signUp();
    const asOther = await listRooms(token);
    assert.ok(asOther.rooms.some(r => r.id === created.room.id && r.canJoin));
    const stranger = await joinOk({ roomId: created.room.id });
    await stranger.close();
  });

  test('signed-out players cannot host lobbies', async () => {
    for (const token of ['', 'forged']) {
      const res = await createRoom('Sneaky', { token });
      assert.equal(res.ok, false);
      assert.match(res.error, /sign in/i);
    }
  });

  test('cross-platform play is off by default and moves you into the shared pool', async () => {
    const { token } = await signUp();
    const res = await setCrossplay(token, true);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual([res.matchmaking.crossplay, res.matchmaking.pool.id, res.matchmaking.platform.id], [true, 'cross', 'direct']);
    const list = await listRooms(token);
    assert.equal(list.matchmaking.pool.id, 'cross');
    assert.ok(list.rooms.length >= 4 && list.rooms.every(r => r.pool.id === 'cross' && r.canJoin));
    // A lobby hosted with cross-play on is a cross-platform lobby.
    const hosted = await createRoom('Everyone', { token });
    assert.equal(hosted.room.pool.id, 'cross');
    assert.ok(!(await listRooms()).rooms.some(r => r.id === hosted.room.id), 'hidden from players who kept it off');
    const off = await setCrossplay(token, false);
    assert.deepEqual([off.matchmaking.crossplay, off.matchmaking.pool.id], [false, 'direct']);
    assert.match((await setCrossplay('', true)).error, /sign in/i);
    assert.equal((await setCrossplay(token, 'yes')).ok, false);
  });

  test('raids only admit players from their own pool', async () => {
    const host = await signUp();
    const { room } = await mustCreate('Home Turf', { token: host.token });
    const crosser = await signUp();
    await setCrossplay(crosser.token, true);
    assert.match((await joinRefused({ roomId: room.id, token: crosser.token })).error, /Email & Google players only.*Turn off cross-platform/);
    assert.match((await joinRefused({ roomId: 'outskirts-direct', token: crosser.token })).error, /Turn off cross-platform/);
    // A bare map id is that map's raid in your own pool.
    const c = await joinOk({ roomId: 'outskirts', token: crosser.token });
    assert.equal((await c.waitFor(m => m.type === 'room')).roomId, 'outskirts-cross');
    await c.close();
    const stayer = await signUp();
    assert.match((await joinRefused({ roomId: 'outskirts-cross', token: stayer.token })).error, /cross-platform\. Turn on/);
    await setCrossplay(crosser.token, false);
    const back = await joinOk({ roomId: room.id, token: crosser.token });
    await back.close();
  });

  test('lobby names are validated and sanitised', async () => {
    assert.equal((await createRoom('')).ok, false);
    assert.equal((await createRoom('    ')).ok, false);
    assert.equal((await api('/api/rooms', { method: 'POST', body: { token: (await signUp()).token } })).ok, false, 'missing name');
    const long = await createRoom('L'.repeat(60));
    assert.equal(long.room.name.length, 24);
    const ctrl = await createRoom('  Night\nShift\t ');
    assert.equal(ctrl.room.name, 'NightShift');
  });

  test('malformed create requests are rejected without crashing', async () => {
    const res = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.ok(res.status >= 400 && res.status < 500);
    assert.equal((await listRooms()).ok, true, 'server still healthy');
  });
});

// ---------------------------------------------------------------- auth

describe('accounts', () => {
  test('register, login and /me all report verified once the email is confirmed', async () => {
    const user = await signUp();
    assert.equal(user.verified, false, 'register answers before the confirmation');
    const login = await api('/api/auth/email/login', { method: 'POST', body: { email: user.email, password: user.password } });
    assert.equal(login.ok, true);
    assert.equal(login.verified, true);
    const me = await api(`/api/auth/me?token=${login.token}`);
    assert.equal(me.ok, true);
    assert.equal(me.verified, true);
  });

  test('bad credentials and invalid registrations are refused', async () => {
    const user = await signUp();
    const wrongPass = await api('/api/auth/email/login', { method: 'POST', body: { email: user.email, password: 'wrong-pass' } });
    const noAccount = await api('/api/auth/email/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'whatever' } });
    assert.equal(wrongPass.ok, false);
    assert.equal(noAccount.ok, false);
    assert.equal(wrongPass.error, noAccount.error, 'never reveals which emails have accounts');
    assert.equal((await api('/api/auth/email/register', { method: 'POST', body: { email: user.email, password: 'hunter22' } })).ok, false, 'duplicate');
    assert.equal((await api('/api/auth/email/register', { method: 'POST', body: { email: 'short@example.com', password: 'seven77' } })).ok, false, 'short password');
    assert.equal((await api('/api/auth/email/register', { method: 'POST', body: { email: 'not-an-email', password: 'hunter22' } })).ok, false, 'bad email');
    assert.equal((await api('/api/auth/me?token=bogus')).ok, false);
  });

  test('/me lists the identities linked to the account', async () => {
    const user = await signUp();
    const me = await api(`/api/auth/me?token=${user.token}`);
    assert.deepEqual(me.linked, [{ provider: 'email', handle: user.email }]);
  });

  test('Steam sign-in sends you to Steam with a one-time return address', async () => {
    const res = await fetch(base + '/api/auth/steam/start', { redirect: 'manual' });
    assert.ok(res.status >= 300 && res.status < 400, `redirect, got ${res.status}`);
    const to = new URL(res.headers.get('location'));
    assert.equal(to.origin + to.pathname, 'https://steamcommunity.com/openid/login');
    assert.equal(to.searchParams.get('openid.mode'), 'checkid_setup');
    const back = new URL(to.searchParams.get('openid.return_to'));
    assert.equal(back.pathname, '/api/auth/steam/callback');
    assert.ok(back.searchParams.get('nonce'));
    assert.equal(to.searchParams.get('openid.realm'), back.origin);
    // Linking needs a real session.
    const bad = await fetch(base + '/api/auth/steam/start?link=bogus', { redirect: 'manual' });
    assert.equal(bad.status, 200);
    assert.match(await bad.text(), /expired/);
  });

  test('a forged Steam callback signs nobody in', async () => {
    const forged = await (await fetch(base + '/api/auth/steam/callback?nonce=made-up&openid.mode=id_res&openid.claimed_id=https://steamcommunity.com/openid/id/76561197960287930')).text();
    assert.match(forged, /expired/);
    assert.doesNotMatch(forged, /"token"/);
    // A real nonce, but an assertion that didn't come back from Steam.
    const start = await fetch(base + '/api/auth/steam/start', { redirect: 'manual' });
    const back = new URL(new URL(start.headers.get('location')).searchParams.get('openid.return_to'));
    const q = new URLSearchParams({ nonce: back.searchParams.get('nonce'), 'openid.mode': 'id_res', 'openid.return_to': 'http://evil.example/cb',
      'openid.op_endpoint': 'https://steamcommunity.com/openid/login', 'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561197960287930' });
    const page = await (await fetch(`${base}/api/auth/steam/callback?${q}`)).text();
    assert.match(page, /didn't match/);
    assert.doesNotMatch(page, /"token"/);
  });

  test('Bluesky linking needs the Bluesky password, not just a session', async () => {
    const user = await signUp();
    const res = await api('/api/auth/login', { method: 'POST', body: { handle: '', password: '', token: user.token } });
    assert.equal(res.ok, false);
  });

  test('new email accounts confirm by link before they can deploy or host', async () => {
    const user = await signUp({ confirm: false });
    assert.equal(user.emailUnconfirmed, user.email);
    let me = await api(`/api/auth/me?token=${user.token}`);
    assert.deepEqual([me.verified, me.emailUnconfirmed, me.email], [false, user.email, user.email]);
    assert.match((await joinRefused({ roomId: 'outskirts', token: user.token })).error, /Confirm your email/);
    assert.match((await createRoom('Early', { token: user.token })).error, /Confirm your email/);
    // The hideout works meanwhile.
    assert.equal((await api(`/api/hideout?token=${user.token}`)).ok, true);
    // Resending replaces the first link.
    const first = await linkFromMail(user.email, /token=([0-9a-f]+)/);
    const resent = await api('/api/auth/email/resend', { method: 'POST', body: { token: user.token } });
    assert.deepEqual([resent.ok, resent.sentTo], [true, user.email]);
    await waitUntil(() => mailTo(user.email).length === 2, { message: 'second email' });
    const stale = await fetch(`${base}/api/auth/email/confirm?token=${first}`, { redirect: 'manual' });
    assert.equal(stale.headers.get('location'), '/?email=expired');
    const second = mailTo(user.email).map(m => m.body.match(/token=([0-9a-f]+)/)[1]).find(t => t !== first);
    const ok = await fetch(`${base}/api/auth/email/confirm?token=${second}`, { redirect: 'manual' });
    assert.equal(ok.headers.get('location'), '/?email=confirmed');
    me = await api(`/api/auth/me?token=${user.token}`);
    assert.deepEqual([me.verified, me.emailUnconfirmed], [true, null]);
    const c = await joinOk({ roomId: 'outskirts', token: user.token });
    await c.close();
    assert.equal((await api('/api/auth/email/resend', { method: 'POST', body: { token: user.token } })).alreadyConfirmed, true);
  });

  test('password reset by emailed link signs out other devices', async () => {
    const user = await signUp({ operator: false });
    const unknown = await api('/api/auth/password/forgot', { method: 'POST', body: { email: 'ghost@example.com' } });
    const known = await api('/api/auth/password/forgot', { method: 'POST', body: { email: user.email.toUpperCase() } });
    assert.equal(unknown.message, known.message, 'same answer whether or not the account exists');
    assert.equal(mailTo('ghost@example.com').length, 0);
    const token = await linkFromMail(user.email, /\?reset=([0-9a-f]+)/);
    assert.equal((await api('/api/auth/password/reset', { method: 'POST', body: { token, password: 'short' } })).ok, false);
    const reset = await api('/api/auth/password/reset', { method: 'POST', body: { token, password: 'fresh-pass-1' } });
    assert.equal(reset.ok, true, JSON.stringify(reset));
    assert.ok(reset.token && reset.token !== user.token);
    assert.equal((await api(`/api/auth/me?token=${user.token}`)).ok, false, 'old session signed out');
    assert.equal((await api(`/api/auth/me?token=${reset.token}`)).ok, true);
    assert.equal((await api('/api/auth/email/login', { method: 'POST', body: { email: user.email, password: 'hunter22' } })).ok, false);
    assert.equal((await api('/api/auth/email/login', { method: 'POST', body: { email: user.email, password: 'fresh-pass-1' } })).ok, true);
    assert.match((await api('/api/auth/password/reset', { method: 'POST', body: { token, password: 'another-pass' } })).error, /expired or was already used/);
  });

  test('deleting an account removes it for good', async () => {
    const user = await signUp();
    assert.match((await api('/api/account/delete', { method: 'POST', body: { token: user.token } })).error, /DELETE/);
    const c = await joinOk({ roomId: 'outskirts', token: user.token });
    assert.match((await api('/api/account/delete', { method: 'POST', body: { token: user.token, confirm: 'DELETE' } })).error, /in a raid/);
    await c.close();
    await waitUntil(async () => !(await api(`/api/hideout?token=${user.token}`)).inRaid, { message: 'raid to end' });
    assert.equal((await api('/api/account/delete', { method: 'POST', body: { token: user.token, confirm: 'DELETE' } })).ok, true);
    assert.equal((await api(`/api/auth/me?token=${user.token}`)).ok, false);
    assert.equal((await api('/api/auth/email/login', { method: 'POST', body: { email: user.email, password: user.password } })).ok, false);
    // The email can sign up again, as a brand-new account.
    const again = await api('/api/auth/email/register', { method: 'POST', body: { email: user.email, password: 'hunter22' } });
    assert.equal(again.ok, true);
    assert.notEqual(again.user_id, user.user_id);
  });

  test('email is case-insensitive', async () => {
    const user = await signUp();
    const login = await api('/api/auth/email/login', { method: 'POST', body: { email: user.email.toUpperCase(), password: user.password } });
    assert.equal(login.ok, true);
  });

  test('friends show online while in any lobby and offline after leaving', async () => {
    const me = await signUp();
    const pal = await signUp();
    assert.equal((await api('/api/friends/add', { method: 'POST', body: { token: me.token, kind: 'account', id: pal.user_id } })).ok, true);
    const friendOnline = async () => (await api(`/api/friends?token=${me.token}`)).friends.find(f => f.kind === 'account' && f.id === pal.user_id)?.online;
    assert.equal(await friendOnline(), false);
    const { room } = await mustCreate('Hangout');
    const c = await joinOk({ roomId: room.id, token: pal.token });
    assert.equal(await friendOnline(), true);
    await c.close();
    await waitUntil(async () => (await friendOnline()) === false, { message: 'friend to go offline' });
  });

  test('friends list requires sign-in and starts empty', async () => {
    assert.equal((await api('/api/friends?token=')).ok, false);
    const { token } = await signUp();
    const res = await api(`/api/friends?token=${token}`);
    assert.equal(res.ok, true);
    assert.deepEqual(res.friends, []);
    assert.equal((await api('/api/friends/add', { method: 'POST', body: { token: 'bogus', handle: 'x.bsky.social' } })).ok, false);
    assert.equal((await api('/api/friends/add', { method: 'POST', body: { token, handle: '' } })).ok, false);
    assert.equal((await api('/api/friends/remove', { method: 'POST', body: { token: 'bogus', user_id: 'x' } })).ok, false);
  });

  test('account and operator friends keep separate identities across menus, raids and operator switches', async () => {
    const me = await signUp();
    const pal = await signUp();
    const first = await api(`/api/hideout?token=${pal.token}`);
    const second = await api('/api/hideout/createOperator', { method: 'POST', body: { token: pal.token, name: 'Sable' } });
    const act = (action, extra) => api(`/api/hideout/${action}`, { method: 'POST', body: { token: pal.token, ...extra } });
    await act('switchOperator', { operatorId: first.id });
    const change = (route, kind, id) => api(`/api/friends/${route}`, { method: 'POST', body: { token: me.token, kind, id } });
    assert.equal((await change('add', 'account', pal.user_id)).ok, true);
    assert.equal((await change('add', 'operator', first.friendId)).ok, true);
    assert.equal((await change('add', 'account', me.user_id)).ok, false);
    assert.equal((await change('add', 'operator', 'op:missing')).ok, false);
    const list = async () => (await api(`/api/friends?token=${me.token}`)).friends;
    const presence = async () => {
      const c = new Client('/presence');
      await c.opened;
      c.send({ type: 'presence', token: pal.token });
      assert.equal((await c.waitFor(m => m.type === 'presence')).ok, true);
      return c;
    };
    const tabA = await presence();
    const tabB = await presence();
    try {
      let friends = await list();
      assert.equal(friends.find(f => f.kind === 'account').operator.name, 'Tester');
      assert.equal(friends.find(f => f.kind === 'operator').online, true);
      assert.equal(friends.find(f => f.kind === 'account').activity, 'hideout');
      await tabA.close();
      assert.equal((await list()).find(f => f.kind === 'account').online, true, 'another tab keeps presence alive');
      await act('switchOperator', { operatorId: second.id });
      friends = await list();
      assert.equal(friends.find(f => f.kind === 'account').operator.name, 'Sable');
      const operatorFriend = friends.find(f => f.kind === 'operator');
      assert.deepEqual(Object.keys(operatorFriend).sort(), ['activity', 'id', 'kind', 'name', 'online']);
      assert.equal(operatorFriend.name, 'Tester');
      assert.equal(operatorFriend.online, false);
      assert.ok(!JSON.stringify(operatorFriend).includes(pal.user_id));
      assert.ok(!JSON.stringify(operatorFriend).includes(pal.email));
      const theirs = (await api(`/api/friends?token=${pal.token}`)).friends;
      assert.equal(theirs.filter(f => f.kind === 'operator').length, 0, 'operator links do not follow you to another character');
      assert.equal(theirs.filter(f => f.kind === 'account').length, 1);
      const raid = await joinOk({ token: pal.token, name: 'Forged callsign' });
      assert.equal(raid.snapshot.players[raid.id].name, 'Sable');
      assert.equal((await list()).find(f => f.kind === 'account').activity, 'raid');
      await raid.close();
      assert.equal((await list()).find(f => f.kind === 'account').activity, 'hideout');
      await act('switchOperator', { operatorId: first.id });
      assert.equal((await list()).find(f => f.kind === 'operator').online, true);
      await tabB.close();
      assert.ok((await list()).every(f => !f.online));
      assert.equal((await change('remove', 'account', pal.user_id)).ok, true);
      assert.equal((await list()).length, 1, 'account removal leaves the operator friendship intact');
      assert.equal((await change('remove', 'operator', first.friendId)).ok, true);
      assert.deepEqual(await list(), []);
      assert.deepEqual((await api(`/api/friends?token=${pal.token}`)).friends, []);
    } finally {
      if (tabA.ws.readyState < 2) await tabA.close();
      if (tabB.ws.readyState < 2) await tabB.close();
    }
  });
});

// ---------------------------------------------------------------- join gating

describe('joining rooms over WebSocket', () => {
  test('a new account joins Outskirts and gets the map, room status and snapshot', async () => {
    const c = await joinOk({ roomId: 'outskirts' });
    const room = await c.waitFor(m => m.type === 'room');
    assert.equal(room.roomId, 'outskirts-direct');
    assert.equal(room.roomName, 'Outskirts');
    assert.equal(room.pool, 'direct');
    const init = c.messages.find(m => m.type === 'init');
    assert.equal(init.map.id, 'outskirts');
    assert.ok(init.mapWidth >= 4000 && init.mapHeight >= 3000, 'a large map');
    assert.ok(init.extracts.length >= 4 && init.crates.length > 10 && init.nests.length >= 4);
    assert.equal(init.uplinks.length, 2, 'decryption uplinks');
    assert.ok(init.uplinks.every(u => u.radius > 0 && u.name.startsWith('Uplink')));
    const me = c.snapshot.players[c.id];
    assert.ok(me, 'own player in snapshot');
    assert.equal(me.gearScore, 3, 'the starter kit');
    assert.equal(me.decrypt, 0);
    assert.ok(me.raidTime <= init.map.raidSecs && me.raidTime > init.map.raidSecs - 5, 'the raid clock just started');
    assert.deepEqual(me.weapons.map(w => w.name), ['Service Pistol']);
    assert.ok(c.snapshot.crates.length === init.crates.length);
    await c.close();
  });

  test('only signed-in accounts can drop in', async () => {
    for (const token of ['', null, 'forged-token']) {
      const err = await joinRefused({ roomId: 'outskirts', token });
      assert.match(err.error, /sign in/i);
    }
    // Client claims are ignored, and so is an old guest profile id.
    const err = await joinRefused({ roomId: 'outskirts', token: '', verified: true, profileId: randomUUID() });
    assert.match(err.error, /sign in/i);
  });

  test('signed-in players can join a player-hosted lobby in their pool', async () => {
    const { token } = await signUp();
    const { room } = await mustCreate('Our Lobby', { token });
    const c = await joinOk({ roomId: room.id });
    await c.close();
  });

  test('joining an unknown room is refused', async () => {
    const err = await joinRefused({ roomId: 'no-such-room' });
    assert.match(err.error, /no longer exists/);
  });

  test('omitting roomId lands in the Outskirts raid of your pool', async () => {
    const c = await joinOk({});
    assert.equal((await c.waitFor(m => m.type === 'room')).roomId, 'outskirts-direct');
    await c.close();
  });

  test('garbage before the join message is ignored', async () => {
    const c = new Client();
    await c.opened;
    c.send('not json at all');
    c.send({ type: 'input', input: idle });
    c.send({ type: 'join', name: 'Patient', token: (await signUp()).token, roomId: 'outskirts' });
    const init = await c.waitFor(m => m.type === 'init');
    assert.ok(init.id);
    await c.close();
  });

  test('callsigns always use the operator name, including repeated raids and forged join names', async () => {
    const { room } = await mustCreate('Names');
    const user = await signUp();
    for (const name of ['   ' + 'N'.repeat(30), '   ', 'Someone else']) {
      const client = await joinOk({ roomId: room.id, token: user.token, name });
      assert.equal(client.snapshot.players[client.id].name, 'Tester');
      await client.close();
    }
  });

  test('gear score gates the harder maps', async () => {
    for (const map of ['rustyard', 'quarantine', 'blacksite']) {
      const err = await joinRefused({ roomId: map });
      assert.match(err.error, /Gear score 3 is too low/, map);
    }
  });

  test('one operator can only be in one raid at a time', async () => {
    const { token } = await signUp();
    const first = await joinOk({ roomId: 'outskirts', token });
    const err = await joinRefused({ roomId: 'outskirts', token });
    assert.match(err.error, /already deployed/);
    await first.close();
    const again = await joinOk({ roomId: 'outskirts', token });
    await again.close();
  });
});

// ---------------------------------------------------------------- hideout

const hideout = (token = '') => api(`/api/hideout?token=${encodeURIComponent(token)}`);
const hideoutAct = (action, body) => api(`/api/hideout/${action}`, { method: 'POST', body });

describe('hideout: operators, Homefront and Legacy', () => {
  test('a new account has no operator until it creates one, and the choice sticks', async () => {
    const { token } = await signUp({ operator: false });
    let h = await hideout(token);
    assert.equal(h.ok, true, JSON.stringify(h));
    assert.equal(h.needsOperator, true);
    assert.deepEqual(h.operators, []);
    assert.equal(h.cash, 0, 'empty defaults so every screen renders');
    assert.equal(h.season.id.match(/^\d{4}-Q[1-4]$/) !== null, true, h.season.id);
    assert.match((await hideoutAct('buy', { token, offerId: 'pistol-8' })).error, /operator/i);
    const err = await joinRefused({ roomId: 'outskirts', token });
    assert.match(err.error, /Create an operator/);

    h = await hideoutAct('createOperator', { token, name: 'Nomad', raidable: true });
    assert.equal(h.ok, true, JSON.stringify(h));
    assert.equal(h.needsOperator, false);
    assert.deepEqual([h.name, h.raidable, h.cash, h.homefront.tier, h.homefront.maxTier], ['Nomad', true, 400, 1, 4]);
    h = await hideoutAct('createOperator', { token, name: 'Homebody', raidable: false });
    assert.deepEqual([h.name, h.raidable, h.homefront.maxTier], ['Homebody', false, 3], 'safe operators stop at the safe tier');
    assert.equal(h.operators.length, 2);
    h = await hideoutAct('switchOperator', { token, operatorId: h.operators.find(o => o.name === 'Nomad').id });
    assert.equal(h.name, 'Nomad');
    const c = await joinOk({ roomId: 'outskirts', token });
    assert.equal((await hideout(token)).operators.find(o => o.name === 'Nomad').inRaid, true);
    const busy = await hideoutAct('switchOperator', { token, operatorId: h.operators.find(o => o.name === 'Homebody').id });
    assert.equal(busy.ok, false, 'no switching mid-raid');
    await c.close();
  });

  test('an operator can be deleted to free its slot, but not mid-raid', async () => {
    const { token } = await signUp();
    let h = await hideoutAct('createOperator', { token, name: 'Spare', raidable: false });
    assert.equal(h.operators.length, 2);
    const spare = h.operators.find(o => o.name === 'Spare').id;
    assert.match((await hideoutAct('deleteOperator', { token, operatorId: spare })).error, /Confirm/);
    const c = await joinOk({ roomId: 'outskirts', token });
    assert.match((await hideoutAct('deleteOperator', { token, operatorId: spare, confirm: true })).error, /in a raid/);
    assert.match((await hideoutAct('createOperator', { token, name: 'Third', raidable: false })).error, /Finish your raid/);
    await c.close();
    await waitUntil(async () => !(await hideout(token)).inRaid, { message: 'raid to be voided' });
    h = await hideoutAct('deleteOperator', { token, operatorId: spare, confirm: true });
    assert.equal(h.ok, true, JSON.stringify(h));
    assert.deepEqual(h.operators.map(o => o.name), ['Tester']);
    assert.equal(h.name, 'Tester', 'the remaining operator is active');
    h = await hideoutAct('deleteOperator', { token, operatorId: h.operators[0].id, confirm: true });
    assert.equal(h.needsOperator, true, 'deleting the last operator leaves the create screen');
  });

  test('a safe operator is never offered a facility level it cannot build', async () => {
    const { token } = await signUp();
    const h = await hideout(token);
    assert.equal(h.homefront.maxTier, 3);
    for (const f of h.homefront.facilities) assert.equal(f.next.level <= h.homefront.maxTier, true, f.id);
  });

  test('facilities follow the tier, and relocation and perks wait for their time', async () => {
    const { token } = await signUp();
    let h = await hideoutAct('upgradeFacility', { token, facility: 'storage' });
    assert.equal(h.ok, true, JSON.stringify(h));
    assert.equal(h.stashCapacity, 50);
    assert.equal(h.cash, 0);
    h = await hideoutAct('upgradeFacility', { token, facility: 'armory' });
    assert.match(h.error, /need \$600 more/);
    h = await hideoutAct('upgradeTier', { token });
    assert.match(h.error, /\$1,?500|1500/);
    assert.equal(h.relocation.blocker !== null, true, 'tier 1 operators cannot relocate');
    assert.equal((await hideoutAct('relocate', { token, confirm: true })).ok, false);
    assert.match((await hideoutAct('buyPerk', { token, perk: 'vitality' })).error, /No Legacy/);
    assert.deepEqual(h.legacy.perks.map(p => p.id), ['vitality', 'firepower', 'scavenger', 'packrat', 'broker']);
    assert.deepEqual(h.operations.map(o => [o.map, o.rank]), [['outskirts', 0], ['rustyard', 0], ['quarantine', 0], ['blacksite', 0]]);
  });
});

describe('hideout: stash, trader and loadout', () => {
  test('protected overflow, requisitions, automatic income and respec work through the API', async () => {
    const { token } = await signUp();
    const stranger = await signUp();
    let h = await hideout(token);
    const db = new DatabaseSync(joinPath(workDir, 'boxhead.db'));
    const pending = randomUUID();
    try {
      db.prepare('UPDATE operators SET cash=2000, produced_at=? WHERE profile=?').run(Math.floor(Date.now()/1000)-7200,h.id);
      db.prepare("INSERT INTO facilities VALUES (?,'armory',1), (?,'workshop',1)").run(h.id,h.id);
      db.prepare("INSERT INTO operations (profile,map,xp,requisition) VALUES (?,'outskirts',500,120)").run(h.id);
      db.prepare('UPDATE accounts SET legacy_earned=3 WHERE user_id=?').run(h.accountId);
      db.prepare("INSERT INTO account_perks VALUES (?,'vitality',1)").run(h.accountId);
      db.prepare("INSERT INTO items (id,profile,kind,rarity,power,name,protected,origin_tier,overflow) VALUES (?,?,'encrypted','rare',65,'Reserved cache',1,4,1)").run(pending,h.id);
    } finally { db.close(); }
    h = await hideout(token);
    assert.equal(h.homefront.workshop.collected,120);
    assert.equal(h.cash,2120);
    assert.equal(h.investmentValue,1400);
    assert.deepEqual(h.overflow.map(i => [i.id,i.protected,i.originTier]),[[pending,true,4]]);
    assert.equal((await hideoutAct('protect',{token:stranger.token,itemId:pending,protected:false})).ok,false);
    assert.equal((await hideoutAct('resolveOverflow',{token,keepIds:[]})).ok,false,'missing preview cannot sell');
    assert.equal((await hideoutAct('resolveOverflow',{token,expectedIds:[pending],keepIds:[]})).ok,false,'protected loot cannot be sold');
    assert.equal((await hideoutAct('requisition',{token,map:'outskirts',kind:'armor'})).ok,false,'resolve overflow first');
    h = await hideoutAct('resolveOverflow',{token,expectedIds:[pending],keepIds:[pending]});
    assert.equal(h.ok,true,JSON.stringify(h));
    assert.equal(h.overflow.length,0);
    assert.equal((await hideoutAct('resolveOverflow',{token,expectedIds:[pending],keepIds:[]})).ok,false,'stale confirmation rejected');
    h = await hideoutAct('requisition',{token,map:'outskirts',kind:'armor'});
    assert.equal(h.ok,true,JSON.stringify(h));
    assert.ok(h.stash.some(i => i.kind==='armor' && i.power===22 && i.protected));
    assert.equal(h.operations.find(o => o.map==='outskirts').requisition,0);
    assert.equal((await hideoutAct('respec',{token})).ok,false);
    h = await hideoutAct('respec',{token,confirm:true});
    assert.equal(h.ok,true,JSON.stringify(h));
    assert.equal(h.legacy.available,3);
    assert.equal(h.cash,1120);
  });

  test('a new operator gets the starter kit, cash and the map ladder', async () => {
    const { token } = await signUp();
    const h = await hideout(token);
    assert.equal(h.ok, true, JSON.stringify(h));
    assert.equal(h.cash, 400);
    assert.equal(h.gearScore, 3);
    assert.equal(h.loadout.primary.name, 'Service Pistol');
    assert.equal(h.loadout.secondary, null);
    assert.deepEqual(h.maps.map(m => [m.id, m.unlocked]), [['outskirts', true], ['rustyard', false], ['quarantine', false], ['blacksite', false]]);
    assert.equal(h.offers.length, 18);
    assert.deepEqual([h.carry, h.carryCapacity], [[], 4]);
    for (const t of ['', 'nope']) {
      const out = await hideout(t);
      assert.equal(out.ok, false, 'no stash without an account');
      assert.equal(out.signedOut, true);
    }
  });

  test('buy, equip and sell round-trip through the stash', async () => {
    const { token } = await signUp();
    let h = await hideoutAct('buy', { token, offerId: 'pistol-8' });
    assert.equal(h.ok, true, JSON.stringify(h));
    const bought = h.stash.find(i => i.name === 'Surplus Pistol');
    assert.ok(bought);
    h = await hideoutAct('equip', { token, itemId: bought.id, slot: 'secondary' });
    assert.equal(h.loadout.secondary.id, bought.id);
    assert.equal(h.gearScore, Math.floor((6 + 8 + 4 + 4) / 4));
    const wrong = await hideoutAct('equip', { token, itemId: bought.id, slot: 'armor' });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /can't go/);
    const before = h.cash;
    h = await hideoutAct('sell', { token, itemId: bought.id });
    assert.equal(h.cash, before + bought.value);
    assert.equal(h.loadout.secondary, null);
    const broke = await hideoutAct('buy', { token, offerId: 'rocketLauncher-24' });
    assert.equal(broke.ok, false);
    assert.match(broke.error, /more/);
  });

  test('the stash belongs to the account, on any device', async () => {
    const user = await signUp();
    await hideoutAct('buy', { token: user.token, offerId: 'pistol-8' });
    const login = await api('/api/auth/email/login', { method: 'POST', body: { email: user.email, password: user.password } });
    const elsewhere = await hideout(login.token);
    assert.equal(elsewhere.account, true);
    assert.ok(elsewhere.stash.some(i => i.name === 'Surplus Pistol'));
    assert.equal((await hideoutAct('buy', { token: '', offerId: 'pistol-8' })).ok, false, 'no shopping signed out');
  });

  test('the inventory screen bulk-sells stash items', async () => {
    const { token } = await signUp();
    await hideoutAct('buy', { token, offerId: 'pistol-8' });
    let h = await hideoutAct('buy', { token, offerId: 'pistol-8' });
    const ids = h.stash.map(i => i.id);
    const worth = h.stash.reduce((s, i) => s + i.value, 0);
    const before = h.cash;
    h = await hideoutAct('sellMany', { token, itemIds: ids });
    assert.equal(h.ok, true, JSON.stringify(h));
    assert.equal(h.cash, before + worth);
    assert.equal(h.stash.length, 0);
    const equipped = await hideoutAct('sellMany', { token, itemIds: [h.loadout.primary.id] });
    assert.equal(equipped.ok, false, 'equipped gear is not bulk-sold');
  });

  test('sealed loot can be packed for the next raid and starts in your pack', async () => {
    const user = await signUp();
    const { token } = user;
    // Put a sealed item in the stash directly (it normally comes out of a raid).
    const operatorId = (await hideout(token)).id;
    const db = new DatabaseSync(joinPath(workDir, 'boxhead.db'));
    db.prepare("INSERT INTO items (id, profile, kind, rarity, power, name, slot) VALUES (?, ?, 'encrypted', 'rare', 12, 'Sealed Case', NULL)")
      .run('sealed-' + user.user_id, operatorId);
    db.close();
    let h = await hideout(token);
    const sealed = h.stash.find(i => i.kind === 'encrypted');
    assert.ok(sealed, JSON.stringify(h.stash));
    const gun = await hideoutAct('carry', { token, itemId: h.loadout.primary.id, carry: true });
    assert.equal(gun.ok, false, 'only sealed items can be packed');
    h = await hideoutAct('carry', { token, itemId: sealed.id, carry: true });
    assert.deepEqual(h.carry, [sealed.id]);
    const c = await joinOk({ roomId: 'outskirts', token });
    assert.deepEqual(c.snapshot.players[c.id].backpack.map(i => i.kind), ['encrypted']);
    const locked = await hideoutAct('carry', { token, itemId: sealed.id, carry: false });
    assert.equal(locked.ok, false, 'locked while deployed');
    await c.close(); // never played: voided, the sealed item stays packed at home
    h = await waitUntil(async () => { const x = await hideout(token); return x.inRaid ? null : x; }, { message: 'raid to be voided' });
    assert.deepEqual(h.carry, [sealed.id]);
  });

  test('leaving mid-raid forfeits the loadout but not the stash', async () => {
    const { token } = await signUp();
    await hideoutAct('buy', { token, offerId: 'pistol-8' }); // stays in the stash
    const c = await joinOk({ roomId: 'outskirts', token });
    const locked = await hideoutAct('sell', { token, itemId: (await hideout(token)).stash[0].id });
    assert.equal(locked.ok, false, 'gear is locked while deployed');
    assert.match(locked.error, /in a raid/);
    assert.equal((await hideout(token)).inRaid, true);
    c.send({ type: 'input', input: idle }); // actually playing
    await sleep(150);
    await c.close();
    const after = await waitUntil(async () => { const h = await hideout(token); return h.inRaid ? null : h; }, { message: 'raid to settle' });
    assert.equal(after.deaths, 1);
    assert.equal(after.gearScore, 0, 'the equipped kit was lost');
    assert.deepEqual(after.stash.map(i => i.name), ['Surplus Pistol']);
    // With nothing equipped you can still raid with a loaner.
    const loaner = await joinOk({ roomId: 'outskirts', token });
    assert.deepEqual(loaner.snapshot.players[loaner.id].weapons.map(w => w.name), ['Loaner Pistol']);
    await loaner.close();
  });

  test('dropping before ever playing voids the raid instead of losing the kit', async () => {
    const { token } = await signUp();
    const c = await joinOk({ roomId: 'outskirts', token });
    await c.close();
    const after = await waitUntil(async () => { const h = await hideout(token); return h.inRaid ? null : h; }, { message: 'raid to be voided' });
    assert.equal(after.deaths, 0);
    assert.equal(after.gearScore, 3, 'the starter kit is still equipped');
  });

  test('insurance bought for a raid that was never played is paid back', async () => {
    const { token } = await signUp();
    const before = await hideout(token);
    assert.equal(before.insuranceCost > 0, true);
    const c = await joinOk({ roomId: 'outskirts', token, insure: true });
    assert.equal((await hideout(token)).cash, before.cash - before.insuranceCost);
    await c.close();
    const after = await waitUntil(async () => { const h = await hideout(token); return h.inRaid ? null : h; }, { message: 'raid to be voided' });
    assert.equal(after.cash, before.cash);
  });

  test('insurance brings the loadout back after a lost raid', async () => {
    const { token } = await signUp();
    const before = await hideout(token);
    assert.ok(before.insuranceCost > 0);
    const c = await joinOk({ roomId: 'outskirts', token, insure: true });
    c.send({ type: 'input', input: idle });
    await sleep(150);
    await c.close();
    const after = await waitUntil(async () => { const h = await hideout(token); return h.inRaid ? null : h; }, { message: 'raid to settle' });
    assert.equal(after.deaths, 1);
    assert.equal(after.gearScore, before.gearScore, 'the insured kit came back');
    assert.equal(after.cash, before.cash - before.insuranceCost);
  });

  test('harder maps charge an entry fee', async () => {
    const res = await api('/api/maps');
    assert.deepEqual(res.maps.map(m => m.entryFee), [0, 150, 600, 2000]);
  });

  test('the public maps endpoint lists the ladder', async () => {
    const res = await api('/api/maps');
    assert.equal(res.ok, true);
    assert.deepEqual(res.maps.map(m => m.minGearScore), [0, 20, 40, 65]);
    assert.ok(res.maps.every((m, i) => i === 0 || m.enemyHealth > res.maps[i - 1].enemyHealth));
  });
});

// ---------------------------------------------------------------- server-side simulation

describe('server-hosted simulation', () => {
  test('the server streams deltas without any client input', async () => {
    const { room } = await mustCreate('Ticking');
    const c = await joinOk({ roomId: room.id });
    const first = await c.waitFor(m => m.type === 'delta');
    await sleep(500);
    const deltas = c.messages.filter(m => m.type === 'delta');
    assert.ok(deltas.length >= 10, `expected a steady delta stream, got ${deltas.length}`);
    assert.ok(deltas.at(-1).tick > first.tick, 'tick advances on the server');
    await c.close();
  });

  test('movement is simulated authoritatively by the server', async () => {
    const { room } = await mustCreate('Movement');
    const c = await joinOk({ roomId: room.id });
    const start = c.snapshot.players[c.id].pos;
    // Walk toward the middle of the map. Insertion points sit on the map's edges,
    // and one on the east edge can have the boundary wall 15 units to its right.
    const right = start.x < c.init.mapWidth / 2;
    const moved = x => (right ? x - start.x : start.x - x) > 20;
    const timer = setInterval(() => c.send({ type: 'input', input: { ...idle, right, left: !right } }), 33);
    try {
      await c.waitFor(m => m.type === 'delta' && moved(m.players?.[c.id]?.pos?.x), 4000, `player to move ${right ? 'right' : 'left'}`);
    } finally { clearInterval(timer); }
    await c.close();
  });

  test('players in the same lobby see each other; other lobbies are isolated', async () => {
    const { room: r1 } = await mustCreate('Lobby One');
    const { room: r2 } = await mustCreate('Lobby Two');
    const a = await joinOk({ roomId: r1.id, name: 'Alice' });
    const b = await joinOk({ roomId: r1.id, name: 'Bob' });
    const c = await joinOk({ roomId: r2.id, name: 'Carol' });
    assert.ok(b.snapshot.players[a.id], 'Bob sees Alice');
    await a.waitFor(m => (m.type === 'delta' || m.type === 'snapshot') && m.players?.[b.id], 4000, 'Alice to see Bob');
    await sleep(300);
    for (const m of c.messages) {
      assert.ok(!m.players?.[a.id] && !m.players?.[b.id], 'Carol never sees lobby one players');
    }
    for (const m of [...a.messages, ...b.messages]) assert.ok(!m.players?.[c.id], 'lobby one never sees Carol');
    await Promise.all([a.close(), b.close(), c.close()]);
  });

  test('only a solo host can pause; a new arrival resumes, and other raids never see it', async () => {
    const { room } = await mustCreate('Pause Test');
    const host = await joinOk({ roomId: room.id });
    const outsider = await joinOk({ roomId: 'outskirts' });
    assert.equal((await host.waitFor(m => m.type === 'room')).hostId, host.id);

    host.send({ type: 'pause', paused: true });
    await host.waitForNext(m => m.type === 'room' && m.paused === true, 3000, 'solo pause');
    assert.equal((await listRooms()).rooms.find(r => r.id === room.id).paused, true);
    assert.ok(!outsider.messages.some(m => m.type === 'room' && m.paused), 'other rooms unaffected');

    const since = host.mark();
    const guest = await joinOk({ roomId: room.id });
    await host.waitAfter(since, m => m.type === 'room' && m.paused === false, 3000, 'joining resumes the raid');
    host.send({ type: 'pause', paused: true });
    await sleep(300);
    assert.equal((await listRooms()).rooms.find(r => r.id === room.id).paused, false, 'a shared raid cannot be paused');
    guest.send({ type: 'pause', paused: true });
    await sleep(200);
    assert.equal((await listRooms()).rooms.find(r => r.id === room.id).paused, false);
    await Promise.all([host.close(), guest.close(), outsider.close()]);
  });

  test('host leaving hands host to the next player', async () => {
    const { room } = await mustCreate('Host Handoff');
    const host = await joinOk({ roomId: room.id });
    const next = await joinOk({ roomId: room.id });
    await host.close();
    await next.waitFor(m => m.type === 'room' && m.hostId === next.id, 3000, 'host handoff');
    await next.close();
  });

  test('the browser shows live player counts', async () => {
    const { room } = await mustCreate('Counting');
    const count = async () => (await listRooms()).rooms.find(r => r.id === room.id)?.players;
    const a = await joinOk({ roomId: room.id });
    const b = await joinOk({ roomId: room.id });
    assert.equal(await count(), 2);
    await a.close();
    await waitUntil(async () => (await count()) === 1, { message: 'count to drop' });
    await b.close();
  });
});

// ---------------------------------------------------------------- lobby lifetime

describe('lobby lifetime', () => {
  test('empty player lobbies shut down after the TTL', async () => {
    const { room } = await mustCreate('Ephemeral');
    await waitUntil(async () => !(await listRooms()).rooms.some(r => r.id === room.id),
      { timeout: EMPTY_TTL_SECS * 4000 + 2000, message: 'empty lobby to be reaped' });
    const err = await joinRefused({ roomId: room.id });
    assert.match(err.error, /no longer exists/);
  });

  test('occupied lobbies outlive the TTL', async () => {
    const { room } = await mustCreate('Occupied');
    const c = await joinOk({ roomId: room.id });
    await sleep(EMPTY_TTL_SECS * 2000 + 1500);
    assert.ok((await listRooms()).rooms.some(r => r.id === room.id));
    assert.ok(c.ws.readyState === WebSocket.OPEN, 'player still connected');
    await c.close();
  });

  test('official rooms never shut down', async () => {
    await sleep(EMPTY_TTL_SECS * 1000 + 500);
    const ids = (await listRooms()).rooms.map(r => r.id);
    assert.ok(ids.includes('outskirts-direct') && ids.includes('blacksite-direct'));
  });
});

// ---------------------------------------------------------------- replay / ops API

async function ops(path, { method = 'GET', token = OPS_TOKEN, body } = {}) {
  const headers = {};
  if (token != null) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(opsBase + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const opsRoom = async id => (await ops('/ops/v1/status')).json.rooms.find(r => r.id === id);
describe('public endpoints', () => {
  test('/api/config names the build, the operator notice and where to send feedback', async () => {
    const config = await api('/api/config');
    assert.equal(config.version, VERSION, 'the version in backend/Cargo.toml');
    assert.equal(config.build, BUILD);
    assert.equal(config.feedbackUrl, FEEDBACK_URL);
    assert.equal(config.notice, NOTICE, 'trimmed to one line');
    assert.equal(config.pvp, true);
    assert.equal(config.minPassword, 8);
    assert.ok(server.log.includes(`BoxHead server ${VERSION} (${BUILD})`), 'the startup log names the build');
  });

  test('/healthz answers ok while the database is up', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });

  test('the old public admin endpoints are gone', async () => {
    for (const [method, path] of [['GET', '/admin'], ['GET', '/admin/status'], ['POST', '/admin/restart'], ['GET', '/ops/v1/status'], ['POST', '/api/rooms/outskirts/replay'], ['GET', '/api/progress']]) {
      const res = await fetch(base + path, { method });
      assert.ok(res.status >= 400, `${method} ${path} should not be served publicly (got ${res.status})`);
      const text = await res.text();
      assert.ok(!text.includes('"rooms"') && !text.includes('highestWave'), `${method} ${path} leaked data`);
    }
  });
});

describe('ops API (internal, for the dashboard)', () => {
  test('requires the bearer token', async () => {
    assert.equal((await ops('/ops/v1/status', { token: null })).status, 401);
    assert.equal((await ops('/ops/v1/status', { token: 'wrong' })).status, 401);
    assert.equal((await ops('/ops/v1/status', { token: '' })).status, 401);
    assert.equal((await ops('/ops/v1/restart-all', { method: 'POST', token: 'wrong' })).status, 401);
    assert.equal((await ops('/ops/v1/rooms/outskirts/restart', { method: 'POST', token: null })).status, 401);
  });

  test('reports the server, its sim threads and every room', async () => {
    const { room } = await mustCreate('Ops Visible');
    const c = await joinOk({ roomId: room.id });
    await sleep(300);
    const { status, json } = await ops('/ops/v1/status');
    assert.equal(status, 200);
    assert.equal(json.serverId, 'e2e-game');
    assert.deepEqual([json.version, json.build], [VERSION, BUILD]);
    assert.equal(json.simThreadCount, SIM_THREADS);
    assert.ok(json.simThreads.length >= 1 && json.simThreads.length <= SIM_THREADS);
    assert.ok(json.simThreads.every(t => t.name.startsWith('room-sim-')));
    assert.equal(json.publishThreadCount, PUBLISH_THREADS);
    assert.ok(json.publishThreads.length >= 1 && json.publishThreads.every(t => t.name.startsWith('room-pub-')));
    assert.equal(json.roomLimit, MAX_ROOMS);
    assert.equal(json.emptyRoomTtlSecs, EMPTY_TTL_SECS);
    const entry = json.rooms.find(r => r.id === room.id);
    assert.equal(entry.connected, 1);
    assert.equal(entry.map, 'Outskirts');
    assert.equal(entry.tier, 1);
    assert.equal(entry.hostId, c.id);
    assert.ok(entry.tick.count > 5, 'room has been ticking');
    assert.match(entry.tick.lastThread, /^room-sim-\d+$/);
    assert.equal(entry.tick.budgetUs, 16667);
    assert.ok(entry.publish.count > 5, 'state provider has been sending');
    assert.match(entry.publish.lastThread, /^room-pub-\d+$/, 'network work runs off the game threads');
    assert.ok(json.totals.connected >= 1);
    await c.close();
  });

  test('restarting one room resyncs only that room', async () => {
    const { room } = await mustCreate('Restart Me');
    const c = await joinOk({ roomId: room.id });
    const other = await joinOk({ roomId: 'outskirts' });
    await sleep(100);
    const since = c.mark();
    const res = await ops(`/ops/v1/rooms/${room.id}/restart`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    const snap = await c.waitAfter(since, m => m.type === 'snapshot', 3000, 'resync snapshot');
    assert.ok(snap.players[c.id], 'players keep raiding through a world reset');
    assert.ok(snap.crates.every(cr => cr.available), 'every crate restocked');
    await sleep(200);
    assert.equal(other.messages.filter(m => m.type === 'snapshot').length, 1, 'other room not resynced');
    assert.equal((await ops('/ops/v1/rooms/nope/restart', { method: 'POST' })).status, 404);
    await Promise.all([c.close(), other.close()]);
  });

  test('restart-all resyncs every room', async () => {
    const { room } = await mustCreate('Everyone');
    const a = await joinOk({ roomId: room.id });
    const b = await joinOk({ roomId: 'outskirts' });
    const [sinceA, sinceB] = [a.mark(), b.mark()];
    const res = await ops('/ops/v1/restart-all', { method: 'POST' });
    assert.equal(res.json.ok, true);
    assert.ok(res.json.restarted >= 5, `restarted ${res.json.restarted}`);
    await a.waitAfter(sinceA, m => m.type === 'snapshot', 3000, 'resync A');
    await b.waitAfter(sinceB, m => m.type === 'snapshot', 3000, 'resync B');
    await Promise.all([a.close(), b.close()]);
  });

  test('without BOXHEAD_OPS_TOKEN the ops API is not started at all', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'boxhead-e2e-noops-'));
    const [port, opsPort] = [await freePort(), await freePort()];
    const env = { ...process.env, PORT: String(port), STATIC_DIR: joinPath(ROOT, 'frontend', 'dist'), BOXHEAD_OPS_ADDR: `127.0.0.1:${opsPort}` };
    delete env.BOXHEAD_OPS_TOKEN;
    const child = spawn(BIN, [], { cwd: dir, env, stdio: 'ignore' });
    extraProcesses.push(child);
    await waitUntil(() => fetch(`http://127.0.0.1:${port}/api/rooms`).then(r => r.ok).catch(() => false), { message: 'second server' });
    await assert.rejects(fetch(`http://127.0.0.1:${opsPort}/ops/v1/status`), 'ops port must be closed');
    child.kill();
  });
});

// ---------------------------------------------------------------- production defaults

describe('production defaults (rate limits on, PvP off)', () => {
  let prod;
  let prodBase;
  let prodOutbox;
  before(async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'boxhead-e2e-prod-'));
    prodOutbox = joinPath(dir, 'outbox');
    const port = await freePort();
    prodBase = `http://127.0.0.1:${port}`;
    prod = await launch(BIN, {
      cwd: dir,
      env: { PORT: String(port), STATIC_DIR: joinPath(ROOT, 'frontend', 'dist'), BOXHEAD_MAIL_OUTBOX: prodOutbox,
        BOXHEAD_RATE_LIMIT: '', BOXHEAD_PVP: '', BOXHEAD_OPS_TOKEN: '',
        BOXHEAD_BUILD: '', BOXHEAD_NOTICE: '', BOXHEAD_FEEDBACK_URL: 'javascript:alert(1)' },
      ready: () => fetch(`${prodBase}/api/config`).then(r => r.ok).catch(() => false),
    });
    extraProcesses.push(prod);
  });
  const post = (path, body) => fetch(prodBase + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  test('new operators are Safe until PvP ships', async () => {
    assert.equal((await (await fetch(`${prodBase}/api/config`)).json()).pvp, false);
    const reg = await (await post('/api/auth/email/register', { email: `pvp-${randomUUID()}@example.com`, password: 'hunter22' })).json();
    assert.equal(reg.ok, true, JSON.stringify(reg));
    const raid = await (await post('/api/hideout/createOperator', { token: reg.token, name: 'Wolf', raidable: true })).json();
    assert.equal(raid.ok, false);
    assert.match(raid.error, /arrive with PvP/);
    assert.equal(raid.pvpEnabled, false);
    const safe = await (await post('/api/hideout/createOperator', { token: reg.token, name: 'Lamb', raidable: false })).json();
    assert.equal(safe.ok, true, JSON.stringify(safe));
  });

  test('an unlabelled build shows only its version, and a feedback link must be http(s)', async () => {
    const config = await (await fetch(`${prodBase}/api/config`)).json();
    assert.equal(config.version, VERSION);
    assert.deepEqual([config.build, config.notice, config.feedbackUrl], ['', '', '']);
    assert.match(prod.log, /BOXHEAD_FEEDBACK_URL is not an http\(s\) link/);
  });

  test('sign-ups from one address are rate limited', async () => {
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const res = await post('/api/auth/email/register', { email: `flood-${i}-${randomUUID()}@example.com`, password: 'hunter22' });
      statuses.push(res.status);
      if (res.status === 429) {
        assert.ok(Number(res.headers.get('retry-after')) > 0);
        const body = await res.json();
        assert.deepEqual([body.ok, body.rateLimited], [false, true]);
        assert.match(body.error, /Too many attempts/);
      }
    }
    const firstLimited = statuses.indexOf(429);
    assert.ok(firstLimited > 0 && firstLimited <= 10, statuses.join());
    assert.ok(statuses.slice(0, firstLimited).every(s => s === 200) && statuses.slice(firstLimited).every(s => s === 429), statuses.join());
  });

  test('password guessing against one email is rate limited', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await post('/api/auth/email/login', { email: 'victim@example.com', password: `guess-${i}` })).status);
    assert.deepEqual([statuses[0], statuses.at(-1)], [200, 429]);
  });
});

// ---------------------------------------------------------------- parallel simulation

describe('parallel room simulation', () => {
  test('many busy rooms tick in parallel across sim threads while the API stays responsive', async () => {
    const ROOMS = 24;
    const clients = [];
    // Sign everyone up first: account creation is slow (bcrypt) and empty lobbies are reaped fast.
    const tokens = await Promise.all(Array.from({ length: ROOMS + 1 }, async () => (await signUp()).token));
    for (let i = 0; i < ROOMS; i++) {
      const { room } = await mustCreate(`Load ${i}`, { token: tokens[ROOMS] });
      clients.push(await joinOk({ roomId: room.id, name: `bot${i}`, token: tokens[i] }));
      clients.at(-1).roomId = room.id;
    }
    const before = (await ops('/ops/v1/status')).json;
    const started = Date.now();
    await sleep(1500);

    // The public API answers quickly even with every room simulating.
    const t0 = Date.now();
    assert.equal((await listRooms()).ok, true);
    assert.ok(Date.now() - t0 < 500, `listing took ${Date.now() - t0}ms under load`);

    const after = (await ops('/ops/v1/status')).json;
    const elapsedSecs = (Date.now() - started) / 1000;
    for (const c of clients) {
      const r = after.rooms.find(x => x.id === c.roomId);
      const r0 = before.rooms.find(x => x.id === c.roomId);
      const rate = (r.tick.count - r0.tick.count) / elapsedSecs;
      assert.ok(rate > 40, `${r.name} ticked at ${rate.toFixed(1)}/s, expected ~60`);
      assert.ok(r.tick.avgUs < r.tick.budgetUs, `${r.name} average tick ${r.tick.avgUs}us exceeds the budget`);
      assert.match(r.tick.lastThread, /^room-sim-/);
      assert.match(r.publish.lastThread, /^room-pub-/);
    }
    const busyThreads = after.simThreads.filter(t => {
      const t0 = before.simThreads.find(x => x.name === t.name);
      return t.ticks - (t0?.ticks ?? 0) > 0;
    });
    assert.ok(busyThreads.length >= 2, `work should spread over several threads, used ${busyThreads.length}`);
    await Promise.all(clients.map(c => c.close()));
  });
});

// ---------------------------------------------------------------- dashboard service

async function dash(path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(dashBase + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const overview = async () => (await dash('/api/overview')).json;

describe('dashboard service', () => {
  test('serves the ops page', async () => {
    const res = await fetch(dashBase + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('BOXHEAD OPS'));
    assert.ok(!html.includes('innerHTML'), 'page must render player-supplied names as text');
  });

  test('shows the live game server and flags the unreachable one', async () => {
    const o = await waitUntil(async () => {
      const v = await overview();
      return v.servers[0].up && v.servers[1].lastError ? v : null;
    }, { message: 'dashboard to poll both servers' });
    assert.equal(o.totals.servers, 2);
    assert.equal(o.totals.serversUp, 1);
    assert.equal(o.servers[0].serverId, 'e2e-game');
    assert.equal(o.servers[0].simThreadCount, SIM_THREADS);
    assert.equal(o.servers[1].up, false);
    assert.ok(o.servers[1].lastError);
  });

  test('tracks rooms, tick health and per-thread load', async () => {
    const { room } = await mustCreate('Dash Room');
    const c = await joinOk({ roomId: room.id });
    const entry = await waitUntil(async () => {
      const o = await overview();
      const r = o.servers[0].rooms.find(x => x.id === room.id);
      return r && r.tick.count > 10 ? { o, r } : null;
    }, { message: 'room to appear on the dashboard' });
    assert.equal(entry.r.name, 'Dash Room');
    assert.equal(entry.r.connected, 1);
    assert.ok(['ok', 'warn', 'over'].includes(entry.r.health));
    assert.match(entry.r.tick.lastThread, /^room-sim-/);
    const threads = entry.o.servers[0].threads;
    assert.ok(threads.length >= 1);
    for (const t of threads) assert.ok(t.utilization >= 0 && t.utilization <= 1);
    await waitUntil(async () => (await overview()).servers[0].threads.some(t => t.ticksPerSec > 0), { message: 'thread tick rate' });
    await c.close();
  });

  test('restart actions need the anti-CSRF header', async () => {
    const res = await dash('/api/servers/0/restart-all', { method: 'POST', body: '{}' });
    assert.equal(res.status, 403);
    const form = await fetch(`${dashBase}/api/servers/0/rooms/outskirts/restart`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1',
    });
    assert.equal(form.status, 403, 'a cross-site form post is refused');
  });

  test('restarts a room through the dashboard', async () => {
    const { room } = await mustCreate('Dash Restart');
    const c = await joinOk({ roomId: room.id });
    const since = c.mark();
    const res = await dash(`/api/servers/0/rooms/${room.id}/restart`, { method: 'POST', headers: { 'X-Dashboard-Action': '1' }, body: '{}' });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.ok, true);
    await c.waitAfter(since, m => m.type === 'snapshot', 3000, 'resync after dashboard restart');
    await c.close();
  });

  test('rejects bad targets', async () => {
    const h = { 'X-Dashboard-Action': '1' };
    assert.equal((await dash('/api/servers/9/restart-all', { method: 'POST', headers: h, body: '{}' })).status, 404);
    assert.equal((await dash('/api/servers/0/rooms/no-such-room/restart', { method: 'POST', headers: h, body: '{}' })).status, 404);
    assert.equal((await dash('/api/servers/0/rooms/a.b/restart', { method: 'POST', headers: h, body: '{}' })).status, 400);
    assert.equal((await dash('/api/servers/1/restart-all', { method: 'POST', headers: h, body: '{}' })).status, 502, 'dead server reported as bad gateway');
  });

  test('refuses to start without a token or exposed without a password', async () => {
    const env = { BOXHEAD_OPS_TOKEN: OPS_TOKEN, GAME_SERVERS: opsBase };
    const noToken = await launch(DASH_BIN, { cwd: workDir, env: { ...env, BOXHEAD_OPS_TOKEN: '', DASHBOARD_ADDR: `127.0.0.1:${await freePort()}` } });
    assert.equal(await noToken.exitCode$, 2);
    const exposed = await launch(DASH_BIN, { cwd: workDir, env: { ...env, DASHBOARD_ADDR: `0.0.0.0:${await freePort()}` } });
    assert.equal(await exposed.exitCode$, 2);
    assert.match(exposed.log, /DASHBOARD_PASSWORD/);
  });

  test('a password-protected dashboard requires HTTP basic auth', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const child = await launch(DASH_BIN, {
      cwd: workDir,
      env: { BOXHEAD_OPS_TOKEN: OPS_TOKEN, GAME_SERVERS: opsBase, DASHBOARD_ADDR: `127.0.0.1:${port}`, DASHBOARD_PASSWORD: 'correct horse' },
      ready: () => fetch(`${url}/healthz`).then(r => r.ok).catch(() => false),
    });
    extraProcesses.push(child);
    const basic = pw => ({ Authorization: 'Basic ' + Buffer.from(`ops:${pw}`).toString('base64') });
    assert.equal((await fetch(`${url}/api/overview`)).status, 401);
    assert.equal((await fetch(`${url}/`)).status, 401);
    assert.equal((await fetch(`${url}/api/overview`, { headers: basic('wrong') })).status, 401);
    assert.equal((await fetch(`${url}/api/overview`, { headers: basic('correct horse') })).status, 200);
    child.kill();
  });
});

// ---------------------------------------------------------------- static client

describe('static client', () => {
  test('serves the home, hideout, deploy and results markup', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const id of ['menuHome', 'playBtn', 'signInBtn', 'menuHideout', 'loadoutSlots', 'stashGrid', 'traderGrid', 'menuBrowser', 'mapList', 'roomList',
      'hostToggleBtn', 'deployBtn', 'menuSignIn', 'homeFriendsList', 'createRoomBtn', 'resultsOverlay', 'resultsDetails',
      'hideoutStash', 'hideoutTrader', 'invSellSelected', 'sellList', 'raidInventory', 'steamLoginBtn', 'linkedAccounts']) {
      assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    }
    // One lobby list for your matchmaking pool, with the cross-platform switch above it.
    assert.ok(html.includes('id="crossplayToggle"') && html.includes('role="switch"'), 'missing the cross-platform switch');
    // Filled in from /api/config: the build label, the operator's notice and the feedback links.
    for (const id of ['buildLabel', 'serverNotice']) assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    assert.equal(html.split('data-feedback-link').length - 1, 3, 'a feedback link on the home screen, the sign-in screen and the pause menu');
    // Google sign-in stays hidden until /api/config reports a client id (this server has none).
    assert.match(html, /id="googleLoginBtn"[^>]*\shidden[\s>]/, 'the Google button is hidden by default');
    assert.equal((await api('/api/config')).google_client_id, '');
  });

  test('serves the guides', async () => {
    for (const [path, marker] of [['/learn.html', 'id="progression"'], ['/about.html', 'aboutEnemies']]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.ok((await res.text()).includes(marker), `${path} is missing ${marker}`);
    }
  });
});

// Runs last: it fills the server to its room limit.
describe('capacity', () => {
  test('the server caps the number of rooms', async () => {
    let error;
    const { token } = await signUp();
    for (let i = 0; i < MAX_ROOMS + 10 && !error; i++) {
      const res = await createRoom(`Flood ${i}`, { token });
      if (!res.ok) error = res.error;
    }
    assert.match(error ?? '', /limit/i);
    assert.ok((await listRooms()).rooms.length <= MAX_ROOMS);
  });
});
