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
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(import.meta.dirname, '..', '..');
const EMPTY_TTL_SECS = 2;
const EXE = process.platform === 'win32' ? '.exe' : '';
const BIN = process.env.BOXHEAD_SERVER_BIN ?? joinPath(ROOT, 'backend', 'target', 'debug', `boxhead-server${EXE}`);
const DASH_BIN = process.env.BOXHEAD_DASHBOARD_BIN ?? joinPath(ROOT, 'dashboard', 'target', 'debug', `boxhead-dashboard${EXE}`);
const OPS_TOKEN = `ops-${randomUUID()}`;
const SIM_THREADS = 4;
const PUBLISH_THREADS = 2;
const MAX_ROOMS = 64;

let server;
let dashboard;
let workDir;
let base;
let wsUrl;
let opsBase;
let dashBase;
let deadServer;
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

const listRooms = (token = '') => api(`/api/rooms?token=${encodeURIComponent(token)}`);
const createRoom = (name, { token = '', verifiedOnly = false } = {}) =>
  api('/api/rooms', { method: 'POST', body: { token, name, verifiedOnly } });

/** Create a lobby that the test depends on, failing loudly if the server refuses. */
async function mustCreate(name, opts) {
  const res = await createRoom(name, opts);
  assert.equal(res.ok, true, `could not create lobby "${name}": ${JSON.stringify(res)}`);
  return res;
}

async function signUp() {
  const email = `tester-${randomUUID()}@example.com`;
  const res = await api('/api/auth/email/register', { method: 'POST', body: { email, password: 'hunter22' } });
  assert.equal(res.ok, true, JSON.stringify(res));
  return { ...res, email, password: 'hunter22' };
}

class Client {
  constructor() {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(wsUrl);
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

async function join(opts = {}) {
  const c = new Client();
  await c.opened;
  c.send({ type: 'join', name: 'Tester', profileId: randomUUID(), ...opts });
  return c;
}

/** Join and wait until the server confirms with init + snapshot. */
async function joinOk(opts) {
  const c = await join(opts);
  const first = await c.waitFor(m => m.type === 'init' || m.type === 'joinError', 4000, 'init');
  assert.equal(first.type, 'init', `expected init, got ${JSON.stringify(first)}`);
  c.id = first.id;
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
  child.exitCode$ = new Promise(res => child.once('exit', code => res(code)));
  if (ready) {
    const died = child.exitCode$.then(code => { throw new Error(`${bin} exited (${code}):\n${child.log}`); });
    await Promise.race([died, waitUntil(ready, { message: `${bin} to start` })]);
  }
  return child;
}

before(async () => {
  assert.ok(existsSync(BIN), `Server binary not found at ${BIN}. Run cargo build in backend/ first.`);
  assert.ok(existsSync(DASH_BIN), `Dashboard binary not found at ${DASH_BIN}. Run cargo build in dashboard/ first.`);
  workDir = mkdtempSync(joinPath(tmpdir(), 'boxhead-e2e-'));
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
    },
    ready: () => listRooms().then(r => r.ok).catch(() => false),
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
  test('lists the two official server-hosted rooms', async () => {
    const res = await listRooms();
    assert.equal(res.ok, true);
    const ids = res.rooms.map(r => r.id);
    assert.ok(ids.includes('open') && ids.includes('verified'));
    const open = res.rooms.find(r => r.id === 'open');
    const verified = res.rooms.find(r => r.id === 'verified');
    assert.deepEqual([open.name, open.verifiedOnly, open.permanent], ['Open Arena', false, true]);
    assert.deepEqual([verified.name, verified.verifiedOnly, verified.permanent], ['Verified Arena', true, true]);
  });

  test('guests are unverified and see verified rooms as locked', async () => {
    const res = await listRooms();
    assert.equal(res.verified, false);
    for (const r of res.rooms) assert.equal(r.canJoin, !r.verifiedOnly, r.name);
  });

  test('signed-in accounts are verified and can join every room', async () => {
    const { token } = await signUp();
    const res = await listRooms(token);
    assert.equal(res.verified, true);
    assert.ok(res.rooms.every(r => r.canJoin));
  });

  test('a bogus token is treated as a guest', async () => {
    const res = await listRooms('not-a-real-token');
    assert.equal(res.verified, false);
    assert.equal(res.rooms.find(r => r.id === 'verified').canJoin, false);
  });

  test('guests can host open lobbies that strangers can see and join', async () => {
    const created = await createRoom('Randos Welcome');
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.room.verifiedOnly, false);
    assert.equal(created.room.permanent, false);
    const { token } = await signUp();
    const asOther = await listRooms(token);
    assert.ok(asOther.rooms.some(r => r.id === created.room.id && r.canJoin));
    const stranger = await joinOk({ roomId: created.room.id });
    await stranger.close();
  });

  test('guests cannot host verified-only lobbies', async () => {
    const res = await createRoom('Sneaky', { verifiedOnly: true });
    assert.equal(res.ok, false);
    assert.match(res.error, /verified/i);
    const fake = await createRoom('Sneaky', { verifiedOnly: true, token: 'forged' });
    assert.equal(fake.ok, false);
  });

  test('signed-in players can host verified-only lobbies, locked for guests', async () => {
    const { token } = await signUp();
    const res = await createRoom('Vets Only', { token, verifiedOnly: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.room.verifiedOnly, true);
    assert.equal(res.room.canJoin, true);
    const guestView = (await listRooms()).rooms.find(r => r.id === res.room.id);
    assert.equal(guestView.canJoin, false);
  });

  test('lobby names are validated and sanitised', async () => {
    assert.equal((await createRoom('')).ok, false);
    assert.equal((await createRoom('    ')).ok, false);
    assert.equal((await api('/api/rooms', { method: 'POST', body: {} })).ok, false, 'missing name');
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
  test('register, login and /me all report verified', async () => {
    const user = await signUp();
    assert.equal(user.verified, true);
    const login = await api('/api/auth/email/login', { method: 'POST', body: { email: user.email, password: user.password } });
    assert.equal(login.ok, true);
    assert.equal(login.verified, true);
    const me = await api(`/api/auth/me?token=${login.token}`);
    assert.equal(me.ok, true);
    assert.equal(me.verified, true);
  });

  test('bad credentials and invalid registrations are refused', async () => {
    const user = await signUp();
    assert.equal((await api('/api/auth/email/login', { method: 'POST', body: { email: user.email, password: 'wrong-pass' } })).ok, false);
    assert.equal((await api('/api/auth/email/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'whatever' } })).ok, false);
    assert.equal((await api('/api/auth/email/register', { method: 'POST', body: { email: user.email, password: 'hunter22' } })).ok, false, 'duplicate');
    assert.equal((await api('/api/auth/email/register', { method: 'POST', body: { email: 'short@example.com', password: '123' } })).ok, false, 'short password');
    assert.equal((await api('/api/auth/email/register', { method: 'POST', body: { email: 'not-an-email', password: 'hunter22' } })).ok, false, 'bad email');
    assert.equal((await api('/api/auth/me?token=bogus')).ok, false);
  });

  test('email is case-insensitive', async () => {
    const user = await signUp();
    const login = await api('/api/auth/email/login', { method: 'POST', body: { email: user.email.toUpperCase(), password: user.password } });
    assert.equal(login.ok, true);
  });

  test('friends show online while in any lobby and offline after leaving', async () => {
    const me = await signUp();
    const pal = await signUp();
    // Adding friends normally resolves a Bluesky handle; link directly in the scratch DB instead.
    const db = new DatabaseSync(joinPath(workDir, 'boxhead.db'));
    for (const [a, b] of [[me.user_id, pal.user_id], [pal.user_id, me.user_id]]) {
      db.prepare('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)').run(a, b);
    }
    db.close();
    const friendOnline = async () => (await api(`/api/friends?token=${me.token}`)).friends.find(f => f.user_id === pal.user_id)?.online;
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
});

// ---------------------------------------------------------------- join gating

describe('joining rooms over WebSocket', () => {
  test('guest joins the open arena and gets init, room status and snapshot', async () => {
    const c = await joinOk({ roomId: 'open' });
    const room = await c.waitFor(m => m.type === 'room');
    assert.equal(room.roomId, 'open');
    assert.equal(room.roomName, 'Open Arena');
    assert.equal(room.verifiedOnly, false);
    assert.ok(c.snapshot.players[c.id], 'own player in snapshot');
    await c.close();
  });

  test('guest is refused from the verified arena', async () => {
    const err = await joinRefused({ roomId: 'verified' });
    assert.match(err.error, /signed-in/i);
  });

  test('guest is refused from a player-hosted verified lobby', async () => {
    const { token } = await signUp();
    const { room } = await mustCreate('Locked Lobby', { token, verifiedOnly: true });
    await joinRefused({ roomId: room.id });
  });

  test('signed-in player joins the verified arena', async () => {
    const { token } = await signUp();
    const c = await joinOk({ roomId: 'verified', token });
    assert.equal((await c.waitFor(m => m.type === 'room')).roomId, 'verified');
    await c.close();
  });

  test('verified players can join unverified rooms', async () => {
    const { token } = await signUp();
    const a = await joinOk({ roomId: 'open', token });
    const { room } = await mustCreate('Mixed Squad');
    const b = await joinOk({ roomId: room.id, token });
    await a.close();
    await b.close();
  });

  test('forged or invalid credentials cannot get into verified rooms', async () => {
    await joinRefused({ roomId: 'verified', token: 'forged-token' });
    await joinRefused({ roomId: 'verified', token: '' });
    await joinRefused({ roomId: 'verified', verified: true }); // client claims are ignored
    await joinRefused({ roomId: 'verified', token: null });
  });

  test('joining an unknown room is refused', async () => {
    const err = await joinRefused({ roomId: 'no-such-room' });
    assert.match(err.error, /no longer exists/);
  });

  test('omitting roomId lands in the open arena', async () => {
    const c = await joinOk({});
    assert.equal((await c.waitFor(m => m.type === 'room')).roomId, 'open');
    await c.close();
  });

  test('garbage before the join message is ignored', async () => {
    const c = new Client();
    await c.opened;
    c.send('not json at all');
    c.send({ type: 'input', input: idle });
    c.send({ type: 'join', name: 'Patient', profileId: randomUUID(), roomId: 'open' });
    const init = await c.waitFor(m => m.type === 'init');
    assert.ok(init.id);
    await c.close();
  });

  test('callsigns are trimmed to 16 chars and blank names get a default', async () => {
    const { room } = await mustCreate('Names');
    const long = await joinOk({ roomId: room.id, name: '   ' + 'N'.repeat(30) });
    assert.equal(long.snapshot.players[long.id].name, 'N'.repeat(16));
    const blank = await joinOk({ roomId: room.id, name: '   ' });
    const snap = await blank.waitFor(m => m.type === 'snapshot');
    assert.match(snap.players[blank.id].name, /^Player_/);
    await long.close();
    await blank.close();
  });

  test('a new profile cannot start beyond its unlocked wave', async () => {
    const { room } = await mustCreate('Wave Cheat');
    const c = await joinOk({ roomId: room.id, startingWave: 50 });
    const init = c.messages.find(m => m.type === 'init');
    assert.equal(init.wave, 1);
    await c.close();
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
    const timer = setInterval(() => c.send({ type: 'input', input: { ...idle, right: true } }), 33);
    try {
      await c.waitFor(m => m.type === 'delta' && m.players?.[c.id]?.pos?.x > start.x + 20, 4000, 'player to move right');
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

  test('only the host can pause, and pause is broadcast to the lobby only', async () => {
    const { room } = await mustCreate('Pause Test');
    const host = await joinOk({ roomId: room.id });
    const guest = await joinOk({ roomId: room.id });
    const outsider = await joinOk({ roomId: 'open' });
    assert.equal((await host.waitFor(m => m.type === 'room')).hostId, host.id);

    guest.send({ type: 'pause', paused: true });
    await sleep(300);
    assert.equal((await listRooms()).rooms.find(r => r.id === room.id).paused, false, 'non-host pause ignored');

    host.send({ type: 'pause', paused: true });
    await guest.waitForNext(m => m.type === 'room' && m.paused === true, 3000, 'paused broadcast');
    assert.equal((await listRooms()).rooms.find(r => r.id === room.id).paused, true);
    assert.ok(!outsider.messages.some(m => m.type === 'room' && m.paused), 'other rooms unaffected');

    host.send({ type: 'pause', paused: false });
    await guest.waitForNext(m => m.type === 'room' && m.paused === false, 3000, 'resume broadcast');
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
    assert.ok(ids.includes('open') && ids.includes('verified'));
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
const replay = (roomId, body = {}) => api(`/api/rooms/${encodeURIComponent(roomId)}/replay`, { method: 'POST', body: { profileId: randomUUID(), startingWave: 1, ...body } });

describe('player replay', () => {
  test('replay is gated like joining', async () => {
    assert.match((await replay('verified')).error, /verified/i);
    assert.match((await replay('verified', { token: 'forged' })).error, /verified/i);
    assert.match((await replay('gone')).error, /not found/i);
  });

  test('players cannot reset a round that is still running', async () => {
    const { room } = await mustCreate('Active Round');
    const c = await joinOk({ roomId: room.id });
    const res = await replay(room.id);
    assert.equal(res.ok, false);
    assert.match(res.error, /still active/);
    await c.close();
  });

  test('the old public admin endpoints are gone', async () => {
    for (const [method, path] of [['GET', '/admin'], ['GET', '/admin/status'], ['POST', '/admin/restart'], ['GET', '/ops/v1/status']]) {
      const res = await fetch(base + path, { method });
      assert.ok(res.status >= 400, `${method} ${path} should not be served publicly (got ${res.status})`);
      const text = await res.text();
      assert.ok(!text.includes('"rooms"'), `${method} ${path} leaked room data`);
    }
  });
});

describe('ops API (internal, for the dashboard)', () => {
  test('requires the bearer token', async () => {
    assert.equal((await ops('/ops/v1/status', { token: null })).status, 401);
    assert.equal((await ops('/ops/v1/status', { token: 'wrong' })).status, 401);
    assert.equal((await ops('/ops/v1/status', { token: '' })).status, 401);
    assert.equal((await ops('/ops/v1/restart-all', { method: 'POST', token: 'wrong' })).status, 401);
    assert.equal((await ops('/ops/v1/rooms/open/restart', { method: 'POST', token: null })).status, 401);
  });

  test('reports the server, its sim threads and every room', async () => {
    const { room } = await mustCreate('Ops Visible');
    const c = await joinOk({ roomId: room.id });
    await sleep(300);
    const { status, json } = await ops('/ops/v1/status');
    assert.equal(status, 200);
    assert.equal(json.serverId, 'e2e-game');
    assert.equal(json.simThreadCount, SIM_THREADS);
    assert.ok(json.simThreads.length >= 1 && json.simThreads.length <= SIM_THREADS);
    assert.ok(json.simThreads.every(t => t.name.startsWith('room-sim-')));
    assert.equal(json.publishThreadCount, PUBLISH_THREADS);
    assert.ok(json.publishThreads.length >= 1 && json.publishThreads.every(t => t.name.startsWith('room-pub-')));
    assert.equal(json.roomLimit, MAX_ROOMS);
    assert.equal(json.emptyRoomTtlSecs, EMPTY_TTL_SECS);
    const entry = json.rooms.find(r => r.id === room.id);
    assert.equal(entry.connected, 1);
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
    const other = await joinOk({ roomId: 'open' });
    await sleep(100);
    const since = c.mark();
    const res = await ops(`/ops/v1/rooms/${room.id}/restart`, { method: 'POST', body: { startingWave: 3 } });
    assert.equal(res.status, 200);
    assert.equal(res.json.startingWave, 3);
    const snap = await c.waitAfter(since, m => m.type === 'snapshot', 3000, 'resync snapshot');
    assert.equal(snap.wave, 3, 'operators can choose the restart wave');
    await sleep(200);
    assert.equal(other.messages.filter(m => m.type === 'snapshot').length, 1, 'other room not resynced');
    assert.equal((await ops('/ops/v1/rooms/nope/restart', { method: 'POST' })).status, 404);
    await Promise.all([c.close(), other.close()]);
  });

  test('restart-all resyncs every room', async () => {
    const { room } = await mustCreate('Everyone');
    const a = await joinOk({ roomId: room.id });
    const b = await joinOk({ roomId: 'open' });
    const [sinceA, sinceB] = [a.mark(), b.mark()];
    const res = await ops('/ops/v1/restart-all', { method: 'POST' });
    assert.equal(res.json.ok, true);
    assert.ok(res.json.restarted >= 3);
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

// ---------------------------------------------------------------- parallel simulation

describe('parallel room simulation', () => {
  test('many busy rooms tick in parallel across sim threads while the API stays responsive', async () => {
    const ROOMS = 24;
    const clients = [];
    for (let i = 0; i < ROOMS; i++) {
      const { room } = await mustCreate(`Load ${i}`);
      clients.push(await joinOk({ roomId: room.id, name: `bot${i}` }));
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
    const form = await fetch(`${dashBase}/api/servers/0/rooms/open/restart`, {
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
  test('serves the new home screen and server browser markup', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const id of ['menuHome', 'playBtn', 'signInBtn', 'menuBrowser', 'roomList', 'lobbyWaveSelect',
      'hostToggleBtn', 'deployBtn', 'menuSignIn', 'homeFriendsList', 'createRoomBtn', 'gameOverDetails']) {
      assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    }
    // One lobby list, filtered by who can join.
    for (const filter of ['all', 'verified', 'open']) {
      assert.ok(html.includes(`data-lobby-filter="${filter}"`), `missing the ${filter} lobby filter`);
    }
  });
});

// Runs last: it fills the server to its room limit.
describe('capacity', () => {
  test('the server caps the number of rooms', async () => {
    let error;
    for (let i = 0; i < MAX_ROOMS + 10 && !error; i++) {
      const res = await createRoom(`Flood ${i}`);
      if (!res.ok) error = res.error;
    }
    assert.match(error ?? '', /limit/i);
    assert.ok((await listRooms()).rooms.length <= MAX_ROOMS);
  });
});
