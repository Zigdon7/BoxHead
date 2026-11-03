// End-to-end tests: boots the real server binary against a throwaway database
// and drives it over HTTP + WebSocket exactly like the browser client does.
//
// Run: node --test tests/e2e   (after `cargo build` and `vite build`)
// Override the binary with BOXHEAD_SERVER_BIN.

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
const BIN = process.env.BOXHEAD_SERVER_BIN
  ?? joinPath(ROOT, 'backend', 'target', 'debug', process.platform === 'win32' ? 'boxhead-server.exe' : 'boxhead-server');

let server;
let workDir;
let base;
let wsUrl;

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
  /** Only messages arriving after this call. */
  waitForNext(pred, timeout, label) {
    const seen = this.messages.length;
    return this.waitFor((m) => this.messages.indexOf(m) >= seen && pred(m), timeout, label);
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

before(async () => {
  assert.ok(existsSync(BIN), `Server binary not found at ${BIN}. Run cargo build first.`);
  workDir = mkdtempSync(joinPath(tmpdir(), 'boxhead-e2e-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
  server = spawn(BIN, [], {
    cwd: workDir, // fresh boxhead.db per run
    env: {
      ...process.env,
      PORT: String(port),
      STATIC_DIR: joinPath(ROOT, 'frontend', 'dist'),
      BOXHEAD_EMPTY_ROOM_TTL_SECS: String(EMPTY_TTL_SECS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  const exited = new Promise((_, rej) => server.once('exit', code => rej(new Error(`server exited (${code}):\n${log}`))));
  await Promise.race([exited, waitUntil(() => listRooms().then(r => r.ok).catch(() => false), { message: 'server start' })]);
});

after(async () => {
  server?.kill();
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

// ---------------------------------------------------------------- restart / admin

describe('restart and admin', () => {
  test('play-again restart is gated like joining', async () => {
    const guest = new URLSearchParams({ roomId: 'verified', profileId: randomUUID(), startingWave: '1' });
    assert.match((await api(`/admin/restart?${guest}`, { method: 'POST' })).error, /verified/i);
    const missing = new URLSearchParams({ roomId: 'gone', profileId: randomUUID() });
    assert.match((await api(`/admin/restart?${missing}`, { method: 'POST' })).error, /not found/i);
  });

  test('play-again cannot reset a round that is still running', async () => {
    const { room } = await mustCreate('Active Round');
    const c = await joinOk({ roomId: room.id });
    const params = new URLSearchParams({ roomId: room.id, profileId: randomUUID(), startingWave: '1' });
    const res = await api(`/admin/restart?${params}`, { method: 'POST' });
    assert.equal(res.ok, false);
    assert.match(res.error, /still active/);
    await c.close();
  });

  test('admin restart of one room resyncs only that room', async () => {
    const { room } = await mustCreate('Restart Me');
    const c = await joinOk({ roomId: room.id });
    const other = await joinOk({ roomId: 'open' });
    await sleep(100);
    const res = await api(`/admin/restart?roomId=${room.id}`, { method: 'POST' });
    assert.equal(res.ok, true);
    await c.waitForNext(m => m.type === 'snapshot', 3000, 'resync snapshot');
    await sleep(200);
    const otherSnapshots = other.messages.filter(m => m.type === 'snapshot').length;
    assert.equal(otherSnapshots, 1, 'other room not resynced');
    await Promise.all([c.close(), other.close()]);
  });

  test('admin status aggregates every room', async () => {
    const { room } = await mustCreate('Status Check');
    const c = await joinOk({ roomId: room.id });
    const status = await api('/admin/status');
    assert.ok(Array.isArray(status.rooms));
    const entry = status.rooms.find(r => r.id === room.id);
    assert.equal(entry.connected, 1);
    assert.equal(entry.host_id, c.id);
    assert.ok(status.connected >= 1);
    await c.close();
  });
});

// ---------------------------------------------------------------- static client

describe('static client', () => {
  test('serves the new home screen and server browser markup', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const id of ['menuHome', 'playBtn', 'signInBtn', 'menuBrowser', 'verifiedRoomList', 'openRoomList',
      'deployBtn', 'menuSignIn', 'homeFriendsList', 'createRoomBtn']) {
      assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    }
  });
});

// Runs last: it fills the server to its room limit.
describe('capacity', () => {
  test('the server caps the number of rooms', async () => {
    let error;
    for (let i = 0; i < 40 && !error; i++) {
      const res = await createRoom(`Flood ${i}`);
      if (!res.ok) error = res.error;
    }
    assert.match(error ?? '', /limit/i);
    assert.ok((await listRooms()).rooms.length <= 32);
  });
});
