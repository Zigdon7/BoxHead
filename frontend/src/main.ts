import { Player, Zombie, Bullet, Wall, ClientInput, DeltaState, SnapshotState, InitPayload, DropPickup } from './generated/types';
import { WEAPON_STATS, PLAYER_SPEED, PLAYER_RADIUS } from './constants';

// Local composite type for rendering
interface GameState {
  players: Record<string, Player>;
  zombies: Zombie[];
  bullets: Bullet[];
  wave: number;
  barricades: unknown[];
  walls: Wall[];
  ammoPickups: { id: string; pos: { x: number; y: number }; amount: number; respawnAt: number }[];
  mapWidth: number;
  mapHeight: number;
  gameOver: boolean;
  drops: DropPickup[];
}

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
document.getElementById('scoreDisplay');
const nameInputEl = document.getElementById('nameInput') as HTMLInputElement;

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// --- Screen state ---
type Screen = 'menu' | 'playing' | 'gameover';
let currentScreen: Screen = 'menu';
let finalWave = 0;
let finalScore = 0;
let playerName = localStorage.getItem('boxhead_name') || '';
let nameInputFocused = false;

// --- Bluesky auth ---
let authToken = localStorage.getItem('boxhead_auth_token') || '';
let authHandle = localStorage.getItem('boxhead_auth_handle') || '';
let authDid = localStorage.getItem('boxhead_auth_did') || '';
let isLoggedIn = !!authToken;
let loginError = '';
let loginLoading = false;

// --- Friends ---
interface Friend { handle: string; did: string; online: boolean; }
let friendsList: Friend[] = [];
let friendsOpen = false;
let addFriendInput = '';
let addFriendError = '';

async function bskyLogin(handle: string, password: string) {
  loginLoading = true;
  loginError = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, password }),
    });
    const data = await res.json();
    if (data.ok) {
      authToken = data.token;
      authHandle = data.handle;
      authDid = data.did;
      isLoggedIn = true;
      playerName = authHandle;
      nameInputEl.value = playerName;
      localStorage.setItem('boxhead_auth_token', authToken);
      localStorage.setItem('boxhead_auth_handle', authHandle);
      localStorage.setItem('boxhead_auth_did', authDid);
      localStorage.setItem('boxhead_name', playerName);
      refreshFriends();
    } else {
      loginError = data.error || 'Login failed';
    }
  } catch {
    loginError = 'Network error';
  }
  loginLoading = false;
}

function bskyLogout() {
  authToken = '';
  authHandle = '';
  authDid = '';
  isLoggedIn = false;
  friendsList = [];
  localStorage.removeItem('boxhead_auth_token');
  localStorage.removeItem('boxhead_auth_handle');
  localStorage.removeItem('boxhead_auth_did');
}

async function refreshFriends() {
  if (!authToken) return;
  try {
    const res = await fetch(`/api/friends?token=${encodeURIComponent(authToken)}`);
    const data = await res.json();
    if (data.ok) friendsList = data.friends;
  } catch { /* ignore */ }
}

async function addFriend(handle: string) {
  addFriendError = '';
  try {
    const res = await fetch('/api/friends/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken, handle }),
    });
    const data = await res.json();
    if (data.ok) {
      addFriendInput = '';
      refreshFriends();
    } else {
      addFriendError = data.error || 'Failed';
    }
  } catch {
    addFriendError = 'Network error';
  }
}

async function removeFriend(did: string) {
  try {
    await fetch('/api/friends/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken, did }),
    });
    refreshFriends();
  } catch { /* ignore */ }
}

// Refresh friends periodically when logged in
setInterval(() => { if (isLoggedIn) refreshFriends(); }, 5000);
if (isLoggedIn) refreshFriends();

// --- Static data (received once on init) ---
let staticWalls: Wall[] = [];
let staticMapWidth = 2400;
let staticMapHeight = 1800;
let staticAmmoSpawns: { x: number; y: number; amount: number }[] = [];

// --- Live game state (built from snapshots + deltas) ---
let players: Record<string, Player> = {};
let zombieMap: Map<string, Zombie> = new Map();  // id -> zombie
let bulletMap: Map<string, Bullet> = new Map();   // id -> bullet (with initial pos/vel, client extrapolates)
let bulletCreationTime: Map<string, number> = new Map(); // id -> performance.now() when created
let wave = 1;
let ammoAvailability: Map<string, boolean> = new Map();
let gameOver = false;
let dropMap: Map<string, DropPickup> = new Map();

let myId = '';
let camX = 0;
let camY = 0;
let screenMouseX = 0;
let screenMouseY = 0;

// --- Client-side prediction ---
let predictedX = 0;
let predictedY = 0;
let predictionInitialized = false;

function resolveCircleRect(px: number, py: number, radius: number, rx: number, ry: number, rw: number, rh: number): [number, number] {
  const closestX = Math.max(rx, Math.min(rx + rw, px));
  const closestY = Math.max(ry, Math.min(ry + rh, py));
  const dx = px - closestX;
  const dy = py - closestY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist > 0 && dist < radius) {
    const overlap = radius - dist;
    return [px + (dx / dist) * overlap, py + (dy / dist) * overlap];
  } else if (dist === 0) {
    const left = px - rx;
    const right = (rx + rw) - px;
    const top = py - ry;
    const bottom = (ry + rh) - py;
    const min = Math.min(left, right, top, bottom);
    if (min === left) return [rx - radius, py];
    if (min === right) return [rx + rw + radius, py];
    if (min === top) return [px, ry - radius];
    return [px, ry + rh + radius];
  }
  return [px, py];
}

function predictLocalMovement(dt: number) {
  if (!predictionInitialized || currentScreen !== 'playing') return;

  let dx = 0;
  let dy = 0;
  if (input.up) dy -= 1;
  if (input.down) dy += 1;
  if (input.left) dx -= 1;
  if (input.right) dx += 1;

  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > 0) {
    dx /= len;
    dy /= len;
  }

  predictedX += dx * PLAYER_SPEED * dt;
  predictedY += dy * PLAYER_SPEED * dt;

  // Clamp to map bounds
  predictedX = Math.max(PLAYER_RADIUS, Math.min(staticMapWidth - PLAYER_RADIUS, predictedX));
  predictedY = Math.max(PLAYER_RADIUS, Math.min(staticMapHeight - PLAYER_RADIUS, predictedY));

  // Wall collision (brute force — only ~40 walls)
  for (const w of staticWalls) {
    const cx = Math.max(w.x, Math.min(w.x + w.w, predictedX));
    const cy = Math.max(w.y, Math.min(w.y + w.h, predictedY));
    const ddx = predictedX - cx;
    const ddy = predictedY - cy;
    const dist = Math.sqrt(ddx * ddx + ddy * ddy);
    if (dist < PLAYER_RADIUS) {
      [predictedX, predictedY] = resolveCircleRect(predictedX, predictedY, PLAYER_RADIUS, w.x, w.y, w.w, w.h);
    }
  }
}

// --- Mobile detection ---
const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

// --- Input element wiring ---
const bskyHandleEl = document.getElementById('bskyHandleInput') as HTMLInputElement;
const bskyPassEl = document.getElementById('bskyPassInput') as HTMLInputElement;
const addFriendEl = document.getElementById('addFriendInputEl') as HTMLInputElement;

nameInputEl.value = playerName;
nameInputEl.addEventListener('input', () => { playerName = nameInputEl.value; });
bskyHandleEl.addEventListener('input', () => { loginError = ''; });
addFriendEl.addEventListener('input', () => { addFriendInput = addFriendEl.value; addFriendError = ''; });

const allInputs = [nameInputEl, bskyHandleEl, bskyPassEl, addFriendEl];
for (const el of allInputs) {
  el.addEventListener('focus', () => { nameInputFocused = true; });
  el.addEventListener('blur', () => { nameInputFocused = false; });
}

// Melee visual effect
let meleeSwingTime = 0;
let meleeSwingAngle = 0;

// --- Interpolation ---
interface StateSnapshot {
  players: Record<string, Player>;
  zombies: Map<string, Zombie>;
  timestamp: number;
}
const stateBuffer: StateSnapshot[] = [];
const INTERP_DELAY = isMobile ? 100 : 60; // ms behind latest state (wider buffer on mobile)
const MAX_BUFFER_SIZE = 10;

function clonePlayersForInterp(p: Record<string, Player>): Record<string, Player> {
  const result: Record<string, Player> = {};
  for (const id in p) {
    result[id] = { ...p[id], pos: { ...p[id].pos } };
  }
  return result;
}

function cloneZombiesForInterp(z: Map<string, Zombie>): Map<string, Zombie> {
  const result = new Map<string, Zombie>();
  for (const [id, zombie] of z) {
    result.set(id, { ...zombie, pos: { ...zombie.pos } });
  }
  return result;
}

function pushStateSnapshot() {
  stateBuffer.push({
    players: clonePlayersForInterp(players),
    zombies: cloneZombiesForInterp(zombieMap),
    timestamp: performance.now()
  });
  if (stateBuffer.length > MAX_BUFFER_SIZE) {
    stateBuffer.shift();
  }
}

function getInterpolatedPlayers(): Record<string, Player> {
  if (stateBuffer.length < 2) return players;
  const renderTime = performance.now() - INTERP_DELAY;

  // Find bracketing snapshots
  let older: StateSnapshot | null = null;
  let newer: StateSnapshot | null = null;
  for (let i = 0; i < stateBuffer.length - 1; i++) {
    if (stateBuffer[i].timestamp <= renderTime && stateBuffer[i + 1].timestamp >= renderTime) {
      older = stateBuffer[i];
      newer = stateBuffer[i + 1];
      break;
    }
  }

  if (!older || !newer) {
    // Use latest
    return stateBuffer[stateBuffer.length - 1].players;
  }

  const t = (renderTime - older.timestamp) / (newer.timestamp - older.timestamp);
  const result: Record<string, Player> = {};

  for (const id in newer.players) {
    const n = newer.players[id];
    const o = older.players[id];
    if (!o) {
      result[id] = { ...n, pos: { ...n.pos } };
      continue;
    }

    // Local player uses client-side prediction
    if (id === myId && predictionInitialized) {
      result[id] = {
        ...n,
        pos: { x: predictedX, y: predictedY },
      };
      continue;
    }

    // Fix angle wrapping across -PI/+PI boundary
    let angleDiff = n.angle - o.angle;
    if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

    result[id] = {
      ...n,
      pos: {
        x: o.pos.x + (n.pos.x - o.pos.x) * t,
        y: o.pos.y + (n.pos.y - o.pos.y) * t
      },
      angle: o.angle + angleDiff * t
    };
  }
  return result;
}

function getInterpolatedZombies(): Zombie[] {
  if (stateBuffer.length < 2) return Array.from(zombieMap.values());
  const renderTime = performance.now() - INTERP_DELAY;

  let older: StateSnapshot | null = null;
  let newer: StateSnapshot | null = null;
  for (let i = 0; i < stateBuffer.length - 1; i++) {
    if (stateBuffer[i].timestamp <= renderTime && stateBuffer[i + 1].timestamp >= renderTime) {
      older = stateBuffer[i];
      newer = stateBuffer[i + 1];
      break;
    }
  }

  if (!older || !newer) {
    const latest = stateBuffer[stateBuffer.length - 1];
    return Array.from(latest.zombies.values());
  }

  const t = (renderTime - older.timestamp) / (newer.timestamp - older.timestamp);
  const result: Zombie[] = [];

  for (const [id, n] of newer.zombies) {
    const o = older.zombies.get(id);
    if (!o) {
      result.push({ ...n, pos: { ...n.pos } });
      continue;
    }
    result.push({
      ...n,
      pos: {
        x: o.pos.x + (n.pos.x - o.pos.x) * t,
        y: o.pos.y + (n.pos.y - o.pos.y) * t
      }
    });
  }
  return result;
}

// --- Client-side bullet extrapolation ---
function getExtrapolatedBullets(): { pos: { x: number; y: number } }[] {
  const now = performance.now();
  const result: { pos: { x: number; y: number } }[] = [];
  for (const [id, b] of bulletMap) {
    const created = bulletCreationTime.get(id) ?? now;
    const elapsed = (now - created) / 1000;
    result.push({
      pos: {
        x: b.pos.x + b.vel.x * elapsed,
        y: b.pos.y + b.vel.y * elapsed
      }
    });
  }
  return result;
}

const input: ClientInput = {
  up: false, down: false, left: false, right: false,
  mouseX: 0, mouseY: 0, shooting: false, melee: false, selectWeapon: 0
};

let ws: WebSocket | null = null;
let inputInterval: ReturnType<typeof setInterval> | null = null;

// --- Delta queue (batch-process on mobile to reduce per-frame work) ---
const pendingDeltas: DeltaState[] = [];
const MAX_DELTAS_PER_FRAME = isMobile ? 3 : 999;

function drainDeltaQueue() {
  const count = Math.min(pendingDeltas.length, MAX_DELTAS_PER_FRAME);
  for (let i = 0; i < count; i++) {
    applyDelta(pendingDeltas[i]);
    pushStateSnapshot();
    // Detect game over transition
    if (gameOver && currentScreen === 'playing') {
      const me = players[myId];
      finalWave = wave;
      finalScore = me ? me.score : 0;
      currentScreen = 'gameover';
    }
  }
  pendingDeltas.splice(0, count);
}

function resetGameState() {
  players = {};
  zombieMap.clear();
  bulletMap.clear();
  bulletCreationTime.clear();
  wave = 1;
  ammoAvailability.clear();
  gameOver = false;
  dropMap.clear();
  myId = '';
  stateBuffer.length = 0;
  lastSentInput = '';
  lastSendTime = 0;
  predictionInitialized = false;
  pendingDeltas.length = 0;
}

function connectToServer() {
  resetGameState();
  currentScreen = 'playing';
  localStorage.setItem('boxhead_name', playerName);

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws`);

  ws.onopen = () => {
    ws!.send(JSON.stringify({ type: 'join', name: playerName, token: authToken || undefined }));
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data) as { type: string };

    if (data.type === 'init') {
      const init = data as InitPayload;
      myId = init.id;
      staticWalls = init.walls;
      staticMapWidth = init.mapWidth;
      staticMapHeight = init.mapHeight;
      staticAmmoSpawns = init.ammoSpawnPoints;
      for (let i = 0; i < staticAmmoSpawns.length; i++) {
        ammoAvailability.set(`ammo_${i}`, true);
      }
    } else if (data.type === 'snapshot') {
      const snap = data as SnapshotState;
      players = snap.players;
      // Initialize prediction from snapshot
      const mySnap = snap.players[myId];
      if (mySnap) {
        predictedX = mySnap.pos.x;
        predictedY = mySnap.pos.y;
        predictionInitialized = true;
      }
      zombieMap.clear();
      for (const z of snap.zombies) {
        zombieMap.set(z.id, z);
      }
      bulletMap.clear();
      bulletCreationTime.clear();
      const now = performance.now();
      for (const b of snap.bullets) {
        bulletMap.set(b.id, b);
        bulletCreationTime.set(b.id, now);
      }
      wave = snap.wave;
      gameOver = snap.gameOver;
      ammoAvailability.clear();
      for (const a of snap.ammoPickups) {
        ammoAvailability.set(a.id, a.available);
      }
      dropMap.clear();
      if (snap.drops) {
        for (const d of snap.drops) {
          dropMap.set(d.id, d);
        }
      }

      // If snapshot says game is no longer over (restart happened), go back to playing
      if (!snap.gameOver && currentScreen === 'gameover') {
        currentScreen = 'playing';
      }

      pushStateSnapshot();
    } else if (data.type === 'delta') {
      pendingDeltas.push(data as DeltaState);
    }
  };

  ws.onclose = () => {
    if (inputInterval) { clearInterval(inputInterval); inputInterval = null; }
    if (currentScreen === 'playing') {
      currentScreen = 'menu';
    }
  };

  // Start sending input
  inputInterval = setInterval(maybeSendInput, 1000 / 30);
}

function applyDelta(delta: DeltaState) {
  // Players
  if (delta.players) {
    for (const id in delta.players) {
      const diff = delta.players[id];
      const existing = players[id];
      if (existing) {
        if (diff.name !== undefined) existing.name = diff.name;
        if (diff.pos) {
          existing.pos = diff.pos;
          // Reconcile prediction with server for local player
          if (id === myId && predictionInitialized) {
            const errX = diff.pos.x - predictedX;
            const errY = diff.pos.y - predictedY;
            const errDist = Math.sqrt(errX * errX + errY * errY);
            if (errDist > 50) {
              // Snap if too far (teleport, respawn, etc.)
              predictedX = diff.pos.x;
              predictedY = diff.pos.y;
            } else if (errDist > 2) {
              // Smooth correction
              predictedX += errX * 0.3;
              predictedY += errY * 0.3;
            }
          }
        }
        if (diff.angle !== undefined) existing.angle = diff.angle;
        if (diff.health !== undefined) existing.health = diff.health;
        if (diff.score !== undefined) existing.score = diff.score;
        if (diff.ammo !== undefined) existing.ammo = diff.ammo;
        if (diff.maxAmmo !== undefined) existing.maxAmmo = diff.maxAmmo;
        if (diff.weapon !== undefined) existing.weapon = diff.weapon;
        if (diff.weaponSlots !== undefined) existing.weaponSlots = diff.weaponSlots;
      } else {
        // New player — diff should be a full Player
        players[id] = diff as Player;
      }
    }
  }
  if (delta.playersRemoved) {
    for (const id of delta.playersRemoved) {
      delete players[id];
    }
  }

  // Zombies
  if (delta.zombiesNew) {
    for (const z of delta.zombiesNew) {
      zombieMap.set(z.id, z);
    }
  }
  if (delta.zombiesUpdated) {
    for (const diff of delta.zombiesUpdated) {
      const existing = zombieMap.get(diff.id);
      if (existing) {
        if (diff.pos) existing.pos = diff.pos;
        if (diff.health !== undefined) existing.health = diff.health;
      }
    }
  }
  if (delta.zombiesRemoved) {
    for (const id of delta.zombiesRemoved) {
      zombieMap.delete(id);
    }
  }

  // Bullets
  if (delta.bulletsNew) {
    const now = performance.now();
    for (const b of delta.bulletsNew) {
      bulletMap.set(b.id, b);
      bulletCreationTime.set(b.id, now);
    }
  }
  if (delta.bulletsRemoved) {
    for (const id of delta.bulletsRemoved) {
      bulletMap.delete(id);
      bulletCreationTime.delete(id);
    }
  }

  // Scalars
  if (delta.wave !== undefined) wave = delta.wave;
  if (delta.gameOver !== undefined) gameOver = delta.gameOver;
  if (delta.ammoPickups) {
    for (const a of delta.ammoPickups) {
      ammoAvailability.set(a.id, a.available);
    }
  }
  if (delta.dropsNew) {
    for (const d of delta.dropsNew) {
      dropMap.set(d.id, d);
    }
  }
  if (delta.dropsRemoved) {
    for (const id of delta.dropsRemoved) {
      dropMap.delete(id);
    }
  }
}

// --- Input ---
window.addEventListener('keydown', (e) => {
  if (nameInputFocused) return;
  if (e.key === 'w' || e.key === 'W') input.up = true;
  if (e.key === 's' || e.key === 'S') input.down = true;
  if (e.key === 'a' || e.key === 'A') input.left = true;
  if (e.key === 'd' || e.key === 'D') input.right = true;
  if (e.key === ' ' || e.key === 'e' || e.key === 'E') {
    input.melee = true;
    meleeSwingTime = 0.3;
    const p = players[myId];
    if (p) meleeSwingAngle = p.angle;
  }
  if (e.key >= '1' && e.key <= '4') {
    input.selectWeapon = parseInt(e.key);
  }
});

window.addEventListener('keyup', (e) => {
  if (nameInputFocused) return;
  if (e.key === 'w' || e.key === 'W') input.up = false;
  if (e.key === 's' || e.key === 'S') input.down = false;
  if (e.key === 'a' || e.key === 'A') input.left = false;
  if (e.key === 'd' || e.key === 'D') input.right = false;
  if (e.key === ' ' || e.key === 'e' || e.key === 'E') input.melee = false;
  if (e.key >= '1' && e.key <= '4') {
    input.selectWeapon = 0;
  }
});

window.addEventListener('mousemove', (e) => {
  screenMouseX = e.clientX;
  screenMouseY = e.clientY;
});

window.addEventListener('mousedown', () => input.shooting = true);
window.addEventListener('mouseup', () => input.shooting = false);
window.addEventListener('contextmenu', (e) => e.preventDefault());

// --- Mobile touch controls ---
// Left half: virtual joystick (movement)
// Right half: aim direction + auto-shoot
// Bottom-right buttons: melee, weapon cycle

let moveStickId: number | null = null;
let moveStickOrigin = { x: 0, y: 0 };
let aimTouchId: number | null = null;
let touchMeleeBtn = { x: 0, y: 0, r: 30 };
let touchWeaponBtn = { x: 0, y: 0, r: 30 };
// Visual feedback for joystick
let moveStickPos = { x: 0, y: 0 };
let moveStickActive = false;

const JOYSTICK_DEAD_ZONE = 15;
const JOYSTICK_MAX = 60;

function handleTouchStart(e: TouchEvent) {
  e.preventDefault();
  for (let i = 0; i < e.changedTouches.length; i++) {
    const t = e.changedTouches[i];
    const tx = t.clientX;
    const ty = t.clientY;

    // Check melee button
    if (currentScreen === 'playing') {
      const mdx = tx - touchMeleeBtn.x;
      const mdy = ty - touchMeleeBtn.y;
      if (mdx * mdx + mdy * mdy < (touchMeleeBtn.r + 10) ** 2) {
        input.melee = true;
        meleeSwingTime = 0.3;
        const p = players[myId];
        if (p) meleeSwingAngle = p.angle;
        continue;
      }

      // Check weapon cycle button
      const wdx = tx - touchWeaponBtn.x;
      const wdy = ty - touchWeaponBtn.y;
      if (wdx * wdx + wdy * wdy < (touchWeaponBtn.r + 10) ** 2) {
        // Cycle to next available weapon
        const p = players[myId];
        if (p) {
          const currentSlot = ['pistol', 'uzi', 'shotgun', 'rocketLauncher'].indexOf(p.weapon);
          for (let s = 1; s <= 4; s++) {
            const next = (currentSlot + s) % 4;
            if (p.weaponSlots[next]) {
              input.selectWeapon = next + 1;
              // Reset after a short delay
              setTimeout(() => { input.selectWeapon = 0; }, 100);
              break;
            }
          }
        }
        continue;
      }
    }

    // Left half: movement joystick
    if (tx < canvas.width / 2 && moveStickId === null) {
      moveStickId = t.identifier;
      moveStickOrigin = { x: tx, y: ty };
      moveStickPos = { x: tx, y: ty };
      moveStickActive = true;
    }
    // Right half: aim + shoot
    else if (tx >= canvas.width / 2 && aimTouchId === null) {
      aimTouchId = t.identifier;
      screenMouseX = tx;
      screenMouseY = ty;
      input.shooting = true;
    }
  }
}

function handleTouchMove(e: TouchEvent) {
  e.preventDefault();
  for (let i = 0; i < e.changedTouches.length; i++) {
    const t = e.changedTouches[i];

    if (t.identifier === moveStickId) {
      const dx = t.clientX - moveStickOrigin.x;
      const dy = t.clientY - moveStickOrigin.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      moveStickPos = { x: t.clientX, y: t.clientY };

      if (dist < JOYSTICK_DEAD_ZONE) {
        input.up = input.down = input.left = input.right = false;
      } else {
        const angle = Math.atan2(dy, dx);
        // 8-direction snapping
        input.right = angle > -Math.PI / 4 && angle < Math.PI / 4;
        input.down = angle > Math.PI / 4 && angle < 3 * Math.PI / 4;
        input.left = angle > 3 * Math.PI / 4 || angle < -3 * Math.PI / 4;
        input.up = angle > -3 * Math.PI / 4 && angle < -Math.PI / 4;
      }
    }

    if (t.identifier === aimTouchId) {
      screenMouseX = t.clientX;
      screenMouseY = t.clientY;
    }
  }
}

function handleTouchEnd(e: TouchEvent) {
  e.preventDefault();
  for (let i = 0; i < e.changedTouches.length; i++) {
    const t = e.changedTouches[i];

    if (t.identifier === moveStickId) {
      moveStickId = null;
      moveStickActive = false;
      input.up = input.down = input.left = input.right = false;
    }
    if (t.identifier === aimTouchId) {
      aimTouchId = null;
      input.shooting = false;
    }
  }
  // Clear melee on any touch end
  input.melee = false;
}

if (isMobile) {
  canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
  canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
  canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', handleTouchEnd, { passive: false });
}

// Phase 6: Only send input when it changes (+ heartbeat)
let lastSentInput = '';
let lastSendTime = 0;
const HEARTBEAT_INTERVAL = 500;

function maybeSendInput() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (currentScreen !== 'playing') return;
  // Compute world mouse coords
  input.mouseX = Math.round(screenMouseX + camX);
  input.mouseY = Math.round(screenMouseY + camY);

  const snapshot = JSON.stringify(input);
  const now = performance.now();

  if (snapshot !== lastSentInput || now - lastSendTime > HEARTBEAT_INTERVAL) {
    ws.send(JSON.stringify({ type: 'input', input }));
    lastSentInput = snapshot;
    lastSendTime = now;
  }
}

// --- Legacy state accessor for draw functions ---
// Build a GameState-like object for rendering (using interpolated data)
function buildRenderState(): GameState | null {
  if (!myId || Object.keys(players).length === 0 && zombieMap.size === 0) return null;

  const interpPlayers = getInterpolatedPlayers();
  const interpZombies = getInterpolatedZombies();
  const extrapBullets = getExtrapolatedBullets();

  return {
    players: interpPlayers,
    zombies: interpZombies,
    bullets: extrapBullets as Bullet[],
    wave,
    barricades: [],
    walls: staticWalls,
    ammoPickups: staticAmmoSpawns.map((s, i) => ({
      id: `ammo_${i}`,
      pos: { x: s.x, y: s.y },
      amount: s.amount,
      respawnAt: ammoAvailability.get(`ammo_${i}`) ? 0 : 1
    })),
    mapWidth: staticMapWidth,
    mapHeight: staticMapHeight,
    gameOver,
    drops: Array.from(dropMap.values()),
  };
}

let lastFrameTime = performance.now();

function updateCamera() {
  if (!players[myId]) return;
  // Use predicted position for instant camera response
  const px = predictionInitialized ? predictedX : players[myId].pos.x;
  const py = predictionInitialized ? predictedY : players[myId].pos.y;
  const targetX = px - canvas.width / 2;
  const targetY = py - canvas.height / 2;
  camX = Math.max(0, Math.min(staticMapWidth - canvas.width, targetX));
  camY = Math.max(0, Math.min(staticMapHeight - canvas.height, targetY));
}

function drawGrid() {
  const gridSize = 60;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  const startX = Math.floor(camX / gridSize) * gridSize;
  const startY = Math.floor(camY / gridSize) * gridSize;
  for (let x = startX; x < camX + canvas.width; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x - camX, 0);
    ctx.lineTo(x - camX, canvas.height);
    ctx.stroke();
  }
  for (let y = startY; y < camY + canvas.height; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y - camY);
    ctx.lineTo(canvas.width, y - camY);
    ctx.stroke();
  }
}

function drawWalls() {
  for (const w of staticWalls) {
    const sx = w.x - camX;
    const sy = w.y - camY;
    if (sx + w.w < 0 || sx > canvas.width || sy + w.h < 0 || sy > canvas.height) continue;

    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(sx, sy, w.w, w.h);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(sx, sy, w.w, 2);
    ctx.fillRect(sx, sy, 2, w.h);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(sx, sy + w.h - 2, w.w, 2);
    ctx.fillRect(sx + w.w - 2, sy, 2, w.h);
  }
}

function drawAmmoPickups() {
  for (let i = 0; i < staticAmmoSpawns.length; i++) {
    const available = ammoAvailability.get(`ammo_${i}`);
    if (!available) continue;

    const pickup = staticAmmoSpawns[i];
    const sx = pickup.x - camX;
    const sy = pickup.y - camY;
    if (sx < -30 || sx > canvas.width + 30 || sy < -30 || sy > canvas.height + 30) continue;

    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 300);

    if (!isMobile) {
      ctx.shadowColor = `rgba(255, 200, 0, ${pulse * 0.5})`;
      ctx.shadowBlur = 15;
    }

    ctx.fillStyle = `rgba(255, 180, 0, ${pulse})`;
    ctx.fillRect(sx - 12, sy - 8, 24, 16);
    ctx.strokeStyle = '#aa7700';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx - 12, sy - 8, 24, 16);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('AMMO', sx, sy + 4);

    ctx.shadowBlur = 0;
  }
}

function drawDrops(state: GameState) {
  for (const d of state.drops) {
    const sx = d.pos.x - camX;
    const sy = d.pos.y - camY;
    if (sx < -30 || sx > canvas.width + 30 || sy < -30 || sy > canvas.height + 30) continue;

    const pulse = 0.7 + 0.3 * Math.sin(performance.now() / 200);

    if (d.type === 'ammo') {
      // Yellow ammo box
      ctx.fillStyle = `rgba(255, 200, 0, ${pulse})`;
      ctx.fillRect(sx - 10, sy - 7, 20, 14);
      ctx.strokeStyle = '#aa7700';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx - 10, sy - 7, 20, 14);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('AMMO', sx, sy + 3);
    } else if (d.type === 'health') {
      // Green cross
      ctx.fillStyle = `rgba(76, 175, 80, ${pulse})`;
      ctx.fillRect(sx - 4, sy - 10, 8, 20);
      ctx.fillRect(sx - 10, sy - 4, 20, 8);
      ctx.strokeStyle = '#2E7D32';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx - 4, sy - 10, 8, 20);
      ctx.strokeRect(sx - 10, sy - 4, 20, 8);
    } else if (d.type === 'weapon') {
      // Purple diamond
      ctx.fillStyle = `rgba(156, 39, 176, ${pulse})`;
      ctx.beginPath();
      ctx.moveTo(sx, sy - 12);
      ctx.lineTo(sx + 10, sy);
      ctx.lineTo(sx, sy + 12);
      ctx.lineTo(sx - 10, sy);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#7B1FA2';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 7px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('GUN', sx, sy + 3);
    }
  }
}

function drawTickHealthBar(sx: number, sy: number, health: number, maxHealth: number, barW: number, weaponDmg: number) {
  const barH = 4;
  const y = sy;

  ctx.fillStyle = '#333';
  ctx.fillRect(sx - 1, y - 1, barW + 2, barH + 2);

  ctx.fillStyle = 'rgba(200, 0, 0, 0.6)';
  ctx.fillRect(sx, y, barW, barH);

  const healthPct = Math.max(0, health / maxHealth);
  const fillW = barW * healthPct;
  ctx.fillStyle = health / maxHealth > 0.3 ? '#4CAF50' : '#FF9800';
  ctx.fillRect(sx, y, fillW, barH);

  if (weaponDmg > 0 && maxHealth > 0) {
    const shotsToKill = Math.ceil(maxHealth / weaponDmg);
    if (shotsToKill >= 2 && shotsToKill <= 20) {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.lineWidth = 1;
      for (let t = 1; t < shotsToKill; t++) {
        const tickX = sx + (t / shotsToKill) * barW;
        ctx.beginPath();
        ctx.moveTo(tickX, y);
        ctx.lineTo(tickX, y + barH);
        ctx.stroke();
      }
    }
  }
}

function drawZombies(state: GameState) {
  const myPlayer = state.players[myId];
  const weaponDmg = myPlayer ? (WEAPON_STATS[myPlayer.weapon]?.damage ?? 25) : 25;

  for (const z of state.zombies) {
    const sx = z.pos.x - camX;
    const sy = z.pos.y - camY;
    if (sx < -60 || sx > canvas.width + 60 || sy < -60 || sy > canvas.height + 60) continue;

    let size = 10;
    let bodyColor = '#4CAF50';
    let shoulderColor = '#388E3C';
    let eyeColor = '#fff';

    if (z.type === 'devil') { size = 14; bodyColor = '#e53935'; shoulderColor = '#b71c1c'; eyeColor = '#ffeb3b'; }
    if (z.type === 'crawler') { size = 8; bodyColor = '#bcc6cc'; shoulderColor = '#98a4ab'; eyeColor = '#b71c1c'; }
    if (z.type === 'brute') { size = 20; bodyColor = '#5d4037'; shoulderColor = '#3e2723'; eyeColor = '#ff5722'; }
    if (z.type === 'vampire') { size = 12; bodyColor = '#e0e0e0'; shoulderColor = '#9e9e9e'; eyeColor = '#d50000'; }

    ctx.save();
    ctx.translate(sx, sy);

    let angle = 0;
    let closestP = null;
    let minDist = Infinity;
    for (const pid in state.players) {
      const p = state.players[pid];
      if (p.health <= 0) continue;
      const dist = Math.hypot(p.pos.x - z.pos.x, p.pos.y - z.pos.y);
      if (dist < minDist) { minDist = dist; closestP = p; }
    }
    if (closestP) {
      angle = Math.atan2(closestP.pos.y - z.pos.y, closestP.pos.x - z.pos.x);
    }

    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath();
    ctx.ellipse(0, size + 4, size * 1.5, size * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(angle);

    // Cape for vampire
    if (z.type === 'vampire') {
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.moveTo(-size, 0);
      ctx.lineTo(-size - 10, -size - 8);
      ctx.lineTo(-size - 10, size + 8);
      ctx.fill();
    }

    // Shoulders
    ctx.fillStyle = shoulderColor;
    ctx.fillRect(-size * 0.8, -size * 1.2, size * 1.6, size * 2.4);

    if (z.type === 'brute') {
      ctx.fillStyle = '#212121';
      ctx.fillRect(-size * 0.9, -size * 1.3, size * 1.8, size * 2.6);
    }

    // Arms
    ctx.fillStyle = bodyColor;
    if (z.type === 'crawler') {
      ctx.fillRect(0, -size * 1.5, size * 1.2, 4);
      ctx.fillRect(0, size * 1.5 - 4, size * 1.2, 4);
    } else {
      ctx.fillRect(size * 0.2, -size * 1.4, size, size * 0.6);
      ctx.fillRect(size * 0.2, size * 0.8, size, size * 0.6);
    }

    // Head
    ctx.fillStyle = bodyColor;
    ctx.fillRect(-size, -size, size * 2, size * 2);

    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-size + 1, -size + 1, size * 2 - 2, size * 2 - 2);

    // Eyes
    ctx.fillStyle = eyeColor;
    ctx.fillRect(size * 0.4, -size * 0.6, size * 0.3, size * 0.3);
    ctx.fillRect(size * 0.4, size * 0.3, size * 0.3, size * 0.3);

    // Pupils
    if (z.type !== 'vampire' && z.type !== 'brute') {
      ctx.fillStyle = '#000';
      ctx.fillRect(size * 0.5, -size * 0.5, size * 0.1, size * 0.1);
      ctx.fillRect(size * 0.5, size * 0.4, size * 0.1, size * 0.1);
    }

    // Horns
    if (z.type === 'devil') {
      ctx.fillStyle = '#b71c1c';
      ctx.beginPath();
      ctx.moveTo(-size * 0.5, -size);
      ctx.lineTo(size * 0.5, -size - 8);
      ctx.lineTo(size * 0.5, -size);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-size * 0.5, size);
      ctx.lineTo(size * 0.5, size + 8);
      ctx.lineTo(size * 0.5, size);
      ctx.fill();
    }

    // Blood / Mouth
    if (z.type === 'brute') {
      ctx.fillStyle = '#8e0000';
      ctx.fillRect(size * 0.6, -size * 0.3, size * 0.4, size * 0.6);
    }

    ctx.restore();

    // Health bar with tick marks
    const barW = size * 2 + 10;
    drawTickHealthBar(sx - barW / 2, sy - size - 16, z.health, z.maxHealth, barW, weaponDmg);
  }
}

function drawBullets(state: GameState) {
  ctx.fillStyle = '#FFEB3B';
  if (!isMobile) {
    ctx.shadowColor = '#FFEB3B';
    ctx.shadowBlur = 6;
  }
  for (const b of state.bullets) {
    const sx = b.pos.x - camX;
    const sy = b.pos.y - camY;
    if (sx < -10 || sx > canvas.width + 10 || sy < -10 || sy > canvas.height + 10) continue;
    ctx.beginPath();
    ctx.arc(sx, sy, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

function drawMeleeSwing(dt: number, state: GameState) {
  if (meleeSwingTime <= 0) return;
  meleeSwingTime -= dt;
  const p = state.players[myId];
  if (!p) return;

  const sx = p.pos.x - camX;
  const sy = p.pos.y - camY;

  const progress = 1 - (meleeSwingTime / 0.3);
  const alpha = 1 - progress;
  const arcRadius = 30 + progress * 20;

  ctx.save();
  ctx.translate(sx, sy);

  ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.8})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  const startAngle = meleeSwingAngle - Math.PI / 4;
  const endAngle = meleeSwingAngle + Math.PI / 4;
  ctx.arc(0, 0, arcRadius, startAngle, endAngle);
  ctx.stroke();

  if (progress < 0.5) {
    ctx.fillStyle = `rgba(255, 200, 100, ${alpha})`;
    for (let i = 0; i < 3; i++) {
      const a = meleeSwingAngle + (Math.random() - 0.5) * Math.PI / 3;
      const dist = arcRadius + Math.random() * 10;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * dist, Math.sin(a) * dist, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

function drawPlayers(state: GameState) {
  for (const id in state.players) {
    const p = state.players[id];
    const sx = p.pos.x - camX;
    const sy = p.pos.y - camY;
    if (sx < -50 || sx > canvas.width + 50 || sy < -50 || sy > canvas.height + 50) continue;

    ctx.save();
    ctx.translate(sx, sy);

    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath();
    ctx.ellipse(0, 20, 16, 8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(p.angle);

    const isMe = id === myId;
    const suitColor = isMe ? '#1976D2' : '#D32F2F';
    const skinColor = '#FFC107';
    const gunColor = '#424242';

    // Shoulders (Body)
    ctx.fillStyle = suitColor;
    ctx.fillRect(-10, -18, 20, 36);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-10, -18, 20, 36);

    // Hands
    ctx.fillStyle = skinColor;
    ctx.fillRect(10, -16, 8, 8);
    ctx.fillRect(10, 8, 8, 8);
    ctx.strokeRect(10, -16, 8, 8);
    ctx.strokeRect(10, 8, 8, 8);

    // Gun
    ctx.fillStyle = gunColor;
    if (p.weapon === 'pistol') {
      ctx.fillRect(15, -4, 18, 8);
    } else if (p.weapon === 'uzi') {
      ctx.fillRect(12, -4, 20, 8);
      ctx.fillRect(20, -6, 4, 12);
    } else if (p.weapon === 'shotgun') {
      ctx.fillRect(10, -5, 26, 10);
      ctx.fillStyle = '#795548';
      ctx.fillRect(10, -4, 8, 8);
    } else if (p.weapon === 'rocketLauncher') {
      ctx.fillRect(8, -6, 28, 12);
      ctx.fillStyle = '#795548';
      ctx.fillRect(8, -4, 8, 8);
      ctx.fillStyle = '#f44336';
      ctx.beginPath();
      ctx.arc(34, 0, 5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(15, -4, 18, 8);
    }
    ctx.strokeRect(15, -4, 18, 8);

    // Head
    ctx.fillStyle = skinColor;
    ctx.fillRect(-12, -12, 24, 24);

    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.strokeRect(-12, -12, 24, 24);
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.fillRect(-12, 0, 24, 12);

    // Eyes
    ctx.fillStyle = '#000';
    ctx.fillRect(6, -6, 3, 3);
    ctx.fillRect(6, 3, 3, 3);

    ctx.restore();

    // Player name
    const displayName = p.name || p.id.slice(0, 6);
    ctx.fillStyle = isMe ? '#64B5F6' : '#eee';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(displayName, sx, sy - 36);

    // Health bar
    const barW = 34;
    ctx.fillStyle = '#333';
    ctx.fillRect(sx - barW / 2 - 1, sy - 32, barW + 2, 6);
    ctx.fillStyle = '#c62828';
    ctx.fillRect(sx - barW / 2, sy - 31, barW, 4);
    ctx.fillStyle = p.health > 30 ? '#4CAF50' : '#FF9800';
    ctx.fillRect(sx - barW / 2, sy - 31, barW * (p.health / 100), 4);
  }
}

function drawMinimap(state: GameState) {
  const mmW = 180;
  const mmH = mmW * (staticMapHeight / staticMapWidth);
  const mmX = canvas.width - mmW - 15;
  const mmY = canvas.height - mmH - 15;
  const scaleX = mmW / staticMapWidth;
  const scaleY = mmH / staticMapHeight;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(mmX - 2, mmY - 2, mmW + 4, mmH + 4);
  ctx.fillStyle = '#444';
  ctx.fillRect(mmX, mmY, mmW, mmH);

  ctx.fillStyle = '#666';
  for (const w of staticWalls) {
    ctx.fillRect(mmX + w.x * scaleX, mmY + w.y * scaleY, Math.max(1, w.w * scaleX), Math.max(1, w.h * scaleY));
  }

  // Ammo pickups on minimap
  for (let i = 0; i < staticAmmoSpawns.length; i++) {
    if (!ammoAvailability.get(`ammo_${i}`)) continue;
    const pickup = staticAmmoSpawns[i];
    ctx.fillStyle = '#ffb400';
    ctx.fillRect(mmX + pickup.x * scaleX - 2, mmY + pickup.y * scaleY - 2, 4, 4);
  }

  for (const d of state.drops) {
    ctx.fillStyle = d.type === 'ammo' ? '#ffb400' : d.type === 'health' ? '#4CAF50' : '#9C27B0';
    ctx.fillRect(mmX + d.pos.x * scaleX - 1, mmY + d.pos.y * scaleY - 1, 3, 3);
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(mmX + camX * scaleX, mmY + camY * scaleY, canvas.width * scaleX, canvas.height * scaleY);

  for (const z of state.zombies) {
    ctx.fillStyle = z.type === 'devil' ? '#e53935' : '#4CAF50';
    ctx.fillRect(mmX + z.pos.x * scaleX - 1, mmY + z.pos.y * scaleY - 1, 2, 2);
  }

  for (const id in state.players) {
    const p = state.players[id];
    ctx.fillStyle = id === myId ? '#2196F3' : '#F44336';
    ctx.fillRect(mmX + p.pos.x * scaleX - 2, mmY + p.pos.y * scaleY - 2, 4, 4);
  }
}

function drawHUD(state: GameState) {
  const p = state.players[myId];
  if (!p) return;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(10, 10, 280, 80);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 1;
  ctx.strokeRect(10, 10, 280, 80);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`Score: ${p.score}`, 20, 32);
  ctx.fillText(`Wave: ${state.wave}`, 160, 32);
  const ammoText = p.weapon === 'pistol' ? 'Ammo: \u221E' : `Ammo: ${p.ammo}/${p.maxAmmo}`;
  ctx.fillText(ammoText, 20, 52);
  ctx.fillText(`HP: ${p.health}`, 160, 52);
  if (!isMobile) {
    ctx.font = '13px monospace';
    ctx.fillStyle = '#aaa';
    ctx.fillText(`Melee: Space/E`, 20, 72);
  }
}

function drawWeaponBar(state: GameState) {
  const p = state.players[myId];
  if (!p) return;

  const slotW = 60;
  const slotH = 50;
  const gap = 4;
  const totalW = slotW * 4 + gap * 3;
  const barX = (canvas.width - totalW) / 2;
  const barY = canvas.height - slotH - 10;

  const weapons = ['pistol', 'uzi', 'shotgun', 'rocketLauncher'];
  const names = ['Pistol', 'Uzi', 'Shotgun', 'Rocket'];
  const slots = p.weaponSlots || [true, false, false, false];

  for (let i = 0; i < 4; i++) {
    const x = barX + i * (slotW + gap);
    const unlocked = slots[i];
    const active = p.weapon === weapons[i];

    // Background
    ctx.fillStyle = active ? 'rgba(33, 150, 243, 0.7)' : unlocked ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(x, barY, slotW, slotH);

    // Border
    ctx.strokeStyle = active ? '#64B5F6' : unlocked ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)';
    ctx.lineWidth = active ? 2 : 1;
    ctx.strokeRect(x, barY, slotW, slotH);

    // Slot number
    ctx.fillStyle = active ? '#fff' : unlocked ? '#aaa' : '#555';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${i + 1}`, x + 4, barY + 13);

    if (unlocked) {
      // Weapon name
      ctx.fillStyle = active ? '#fff' : '#ccc';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(names[i], x + slotW / 2, barY + 28);

      // Damage
      const dmg = WEAPON_STATS[weapons[i]]?.damage ?? 0;
      ctx.fillStyle = '#ffb400';
      ctx.font = '9px monospace';
      ctx.fillText(`${dmg} dmg`, x + slotW / 2, barY + 42);
    } else {
      // Locked indicator
      ctx.fillStyle = '#555';
      ctx.font = '18px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('[?]', x + slotW / 2, barY + 34);
    }
  }
}

function drawScoreboard(state: GameState) {
  const playerList = Object.values(state.players)
    .sort((a, b) => b.score - a.score);

  if (playerList.length === 0) return;

  const rowH = 22;
  const headerH = 28;
  const padX = 12;
  const padY = 8;
  const boardW = isMobile ? 160 : 200;
  const boardH = headerH + padY * 2 + playerList.length * rowH;
  const boardX = canvas.width - boardW - 15;
  const boardY = 10;

  // Background
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(boardX, boardY, boardW, boardH);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(boardX, boardY, boardW, boardH);

  // Header
  ctx.fillStyle = '#888';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('PLAYER', boardX + padX, boardY + 8);
  ctx.textAlign = 'right';
  ctx.fillText('SCORE', boardX + boardW - padX, boardY + 8);

  // Divider
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.beginPath();
  ctx.moveTo(boardX + 6, boardY + headerH);
  ctx.lineTo(boardX + boardW - 6, boardY + headerH);
  ctx.stroke();

  // Rows
  for (let i = 0; i < playerList.length; i++) {
    const p = playerList[i];
    const y = boardY + headerH + padY + i * rowH;
    const isMe = p.id === myId;
    const dead = p.health <= 0;

    // Highlight own row
    if (isMe) {
      ctx.fillStyle = 'rgba(33, 150, 243, 0.15)';
      ctx.fillRect(boardX + 2, y - 2, boardW - 4, rowH);
    }

    // Name
    ctx.fillStyle = dead ? '#666' : isMe ? '#64B5F6' : '#ddd';
    ctx.font = isMe ? 'bold 12px sans-serif' : '12px sans-serif';
    ctx.textAlign = 'left';
    const name = (p.name || p.id.slice(0, 6));
    ctx.fillText(name.length > 12 ? name.slice(0, 11) + '…' : name, boardX + padX, y + 2);

    // Score
    ctx.fillStyle = dead ? '#666' : '#ffb400';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.floor(p.score)}`, boardX + boardW - padX, y + 2);
  }
}

function drawMobileControls() {
  if (!isMobile || currentScreen !== 'playing') return;

  // --- Virtual joystick (left side) ---
  const joyBaseX = 90;
  const joyBaseY = canvas.height - 110;

  if (moveStickActive) {
    // Outer ring
    ctx.beginPath();
    ctx.arc(moveStickOrigin.x, moveStickOrigin.y, JOYSTICK_MAX, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Inner stick (clamped to max radius)
    let dx = moveStickPos.x - moveStickOrigin.x;
    let dy = moveStickPos.y - moveStickOrigin.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > JOYSTICK_MAX) {
      dx = (dx / dist) * JOYSTICK_MAX;
      dy = (dy / dist) * JOYSTICK_MAX;
    }
    ctx.beginPath();
    ctx.arc(moveStickOrigin.x + dx, moveStickOrigin.y + dy, 22, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fill();
  } else {
    // Static hint
    ctx.beginPath();
    ctx.arc(joyBaseX, joyBaseY, JOYSTICK_MAX, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(joyBaseX, joyBaseY, 22, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('MOVE', joyBaseX, joyBaseY);
  }

  // --- Melee button (bottom-right) ---
  const meleeX = canvas.width - 70;
  const meleeY = canvas.height - 160;
  touchMeleeBtn = { x: meleeX, y: meleeY, r: 30 };

  ctx.beginPath();
  ctx.arc(meleeX, meleeY, 30, 0, Math.PI * 2);
  ctx.fillStyle = input.melee ? 'rgba(229, 57, 53, 0.6)' : 'rgba(255, 255, 255, 0.12)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('MELEE', meleeX, meleeY);

  // --- Weapon cycle button ---
  const weapX = canvas.width - 70;
  const weapY = canvas.height - 90;
  touchWeaponBtn = { x: weapX, y: weapY, r: 30 };

  ctx.beginPath();
  ctx.arc(weapX, weapY, 30, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = 'bold 10px sans-serif';
  ctx.fillText('WEAPON', weapX, weapY - 5);
  ctx.font = '9px sans-serif';
  ctx.fillText('▶▶', weapX, weapY + 9);

  // --- Aim crosshair feedback (right side) ---
  if (aimTouchId !== null) {
    ctx.beginPath();
    ctx.arc(screenMouseX, screenMouseY, 20, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(229, 57, 53, 0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(screenMouseX - 10, screenMouseY);
    ctx.lineTo(screenMouseX + 10, screenMouseY);
    ctx.moveTo(screenMouseX, screenMouseY - 10);
    ctx.lineTo(screenMouseX, screenMouseY + 10);
    ctx.stroke();
  }
}

// --- Menu button hit detection ---
let menuPlayBtn = { x: 0, y: 0, w: 0, h: 0 };
let gameOverMenuBtn = { x: 0, y: 0, w: 0, h: 0 };

function focusHiddenInput(el: HTMLInputElement) {
  el.style.pointerEvents = 'auto';
  el.focus();
  setTimeout(() => { el.style.pointerEvents = 'none'; }, 100);
}

function hitTest(mx: number, my: number, r: {x:number;y:number;w:number;h:number}) {
  return mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;
}

function handleMenuClick(mx: number, my: number) {
  if (currentScreen === 'menu') {
    // Friends panel interactions (check first since it overlays)
    if (friendsOpen && isLoggedIn) {
      const panelW = 280;
      const panelH = Math.min(400, 100 + friendsList.length * 30 + 50);
      const panelX = (canvas.width - panelW) / 2;
      const panelY = (canvas.height - panelH) / 2;

      // Close button
      if (mx >= panelX + panelW - 30 && mx <= panelX + panelW && my >= panelY && my <= panelY + 35) {
        friendsOpen = false;
        return;
      }

      // Remove friend buttons
      let y = panelY + 45;
      for (const f of friendsList) {
        if (mx >= panelX + panelW - 30 && mx <= panelX + panelW && my >= y - 8 && my <= y + 20) {
          removeFriend(f.did);
          return;
        }
        y += 28;
      }

      // Add friend input
      y += 8;
      const addX = panelX + 10;
      const addW = panelW - 80;
      const addH = 28;
      if (mx >= addX && mx <= addX + addW && my >= y && my <= y + addH) {
        focusHiddenInput(addFriendEl);
        return;
      }

      // Add friend button
      const addBtnX = addX + addW + 5;
      if (mx >= addBtnX && mx <= addBtnX + 55 && my >= y && my <= y + addH) {
        if (addFriendInput.trim()) addFriend(addFriendInput.trim());
        return;
      }

      // Click outside panel closes it
      if (mx < panelX || mx > panelX + panelW || my < panelY || my > panelY + panelH) {
        friendsOpen = false;
      }
      return;
    }

    // Name input
    if (hitTest(mx, my, menuNameBtn)) {
      focusHiddenInput(nameInputEl);
      return;
    }

    // Bluesky handle input
    if (!isLoggedIn && hitTest(mx, my, menuBskyHandleBtn)) {
      focusHiddenInput(bskyHandleEl);
      return;
    }

    // Bluesky password input
    if (!isLoggedIn && hitTest(mx, my, menuBskyPassBtn)) {
      focusHiddenInput(bskyPassEl);
      return;
    }

    // Bluesky login button
    if (!isLoggedIn && hitTest(mx, my, menuBskyLoginBtn) && !loginLoading) {
      if (bskyHandleEl.value && bskyPassEl.value) {
        bskyLogin(bskyHandleEl.value, bskyPassEl.value);
      }
      return;
    }

    // Logout button
    if (isLoggedIn && hitTest(mx, my, menuBskyLogoutBtn)) {
      bskyLogout();
      return;
    }

    // Friends button
    if (isLoggedIn && hitTest(mx, my, menuFriendsBtn)) {
      friendsOpen = !friendsOpen;
      return;
    }

    // Blur all inputs
    for (const el of allInputs) el.blur();

    // Play button
    if (hitTest(mx, my, menuPlayBtn)) {
      connectToServer();
    }
  } else if (currentScreen === 'gameover') {
    if (hitTest(mx, my, gameOverMenuBtn)) {
      if (ws) { ws.close(); ws = null; }
      currentScreen = 'menu';
    }
  }
}

canvas.addEventListener('click', (e) => handleMenuClick(e.clientX, e.clientY));
canvas.addEventListener('touchstart', (e) => {
  if (currentScreen === 'menu' || currentScreen === 'gameover') {
    const t = e.changedTouches[0];
    handleMenuClick(t.clientX, t.clientY);
  }
}, { passive: true });

let menuNameBtn = { x: 0, y: 0, w: 0, h: 0 };
let menuBskyHandleBtn = { x: 0, y: 0, w: 0, h: 0 };
let menuBskyPassBtn = { x: 0, y: 0, w: 0, h: 0 };
let menuBskyLoginBtn = { x: 0, y: 0, w: 0, h: 0 };
let menuBskyLogoutBtn = { x: 0, y: 0, w: 0, h: 0 };
let menuFriendsBtn = { x: 0, y: 0, w: 0, h: 0 };

function drawMenu() {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Title
  ctx.fillStyle = '#e53935';
  ctx.font = 'bold 72px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('BOXHEAD', cx, cy - 160);

  ctx.fillStyle = '#8888aa';
  ctx.font = '20px sans-serif';
  ctx.fillText('Survive the horde', cx, cy - 110);

  // --- Name input ---
  const fieldW = 260;
  const fieldH = 38;
  const fieldX = cx - fieldW / 2;
  const fieldY = cy - 80;
  menuNameBtn = { x: fieldX, y: fieldY, w: fieldW, h: fieldH };

  ctx.fillStyle = '#16213e';
  ctx.fillRect(fieldX, fieldY, fieldW, fieldH);
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(fieldX, fieldY, fieldW, fieldH);

  ctx.textAlign = 'left';
  ctx.fillStyle = playerName ? '#fff' : '#666';
  ctx.font = '16px sans-serif';
  ctx.fillText(playerName || 'Enter name...', fieldX + 10, fieldY + fieldH / 2 + 1);

  // --- Bluesky auth section ---
  const authY = cy - 30;
  if (isLoggedIn) {
    // Logged in state
    ctx.fillStyle = '#4caf50';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Logged in as @${authHandle}`, cx, authY + 10);

    // Logout button (small)
    const logW = 80;
    const logH = 28;
    const logX = cx - logW / 2;
    const logY = authY + 20;
    menuBskyLogoutBtn = { x: logX, y: logY, w: logW, h: logH };
    ctx.fillStyle = '#333';
    ctx.fillRect(logX, logY, logW, logH);
    ctx.strokeStyle = '#555';
    ctx.strokeRect(logX, logY, logW, logH);
    ctx.fillStyle = '#aaa';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Logout', cx, logY + logH / 2 + 1);

    // Friends button
    const fbW = 140;
    const fbH = 32;
    const fbX = cx - fbW / 2;
    const fbY = authY + 56;
    menuFriendsBtn = { x: fbX, y: fbY, w: fbW, h: fbH };
    ctx.fillStyle = '#16213e';
    ctx.fillRect(fbX, fbY, fbW, fbH);
    ctx.strokeStyle = '#2196F3';
    ctx.lineWidth = 1;
    ctx.strokeRect(fbX, fbY, fbW, fbH);
    ctx.fillStyle = '#64B5F6';
    ctx.font = 'bold 13px sans-serif';
    const onlineCount = friendsList.filter(f => f.online).length;
    ctx.fillText(`Friends (${onlineCount}/${friendsList.length})`, cx, fbY + fbH / 2 + 1);
  } else {
    // Login form
    ctx.fillStyle = '#8888aa';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Sign in with Bluesky (optional)', cx, authY);

    const inputW = 200;
    const inputH = 30;
    const inputX = cx - inputW / 2;

    // Handle input
    const hY = authY + 8;
    menuBskyHandleBtn = { x: inputX, y: hY, w: inputW, h: inputH };
    ctx.fillStyle = '#16213e';
    ctx.fillRect(inputX, hY, inputW, inputH);
    ctx.strokeStyle = '#333';
    ctx.strokeRect(inputX, hY, inputW, inputH);
    ctx.fillStyle = bskyHandleEl.value ? '#fff' : '#555';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(bskyHandleEl.value || 'handle.bsky.social', inputX + 8, hY + inputH / 2 + 1);

    // Password input
    const pY = hY + inputH + 4;
    menuBskyPassBtn = { x: inputX, y: pY, w: inputW, h: inputH };
    ctx.fillStyle = '#16213e';
    ctx.fillRect(inputX, pY, inputW, inputH);
    ctx.strokeStyle = '#333';
    ctx.strokeRect(inputX, pY, inputW, inputH);
    ctx.fillStyle = bskyPassEl.value ? '#fff' : '#555';
    ctx.fillText(bskyPassEl.value ? '•'.repeat(bskyPassEl.value.length) : 'App password', inputX + 8, pY + inputH / 2 + 1);

    // Login button
    const lbW = 80;
    const lbX = cx + inputW / 2 + 8;
    const lbY = hY;
    menuBskyLoginBtn = { x: lbX, y: lbY, w: lbW, h: inputH * 2 + 4 };
    ctx.fillStyle = loginLoading ? '#555' : '#1976D2';
    ctx.fillRect(lbX, lbY, lbW, inputH * 2 + 4);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(loginLoading ? '...' : 'Login', lbX + lbW / 2, lbY + inputH + 2);

    if (loginError) {
      ctx.fillStyle = '#e53935';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(loginError, cx, pY + inputH + 14);
    }
  }

  // --- Play button ---
  ctx.textAlign = 'center';
  const btnW = 240;
  const btnH = 56;
  const btnX = cx - btnW / 2;
  const btnY = cy + 100;
  menuPlayBtn = { x: btnX, y: btnY, w: btnW, h: btnH };

  ctx.fillStyle = '#e53935';
  ctx.beginPath();
  ctx.moveTo(btnX + 10, btnY);
  ctx.arcTo(btnX + btnW, btnY, btnX + btnW, btnY + btnH, 10);
  ctx.arcTo(btnX + btnW, btnY + btnH, btnX, btnY + btnH, 10);
  ctx.arcTo(btnX, btnY + btnH, btnX, btnY, 10);
  ctx.arcTo(btnX, btnY, btnX + btnW, btnY, 10);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText('PLAY', cx, btnY + btnH / 2);

  // Controls
  ctx.fillStyle = '#555';
  ctx.font = '14px sans-serif';
  if (isMobile) {
    ctx.fillText('Left stick to move  |  Right side to aim & shoot', cx, cy + 200);
  } else {
    ctx.fillText('WASD to move  |  Click to shoot  |  Space for melee  |  1-4 switch weapons', cx, cy + 200);
  }

  // --- Friends panel overlay ---
  if (friendsOpen && isLoggedIn) {
    drawFriendsPanel();
  }
}

function drawFriendsPanel() {
  const panelW = 280;
  const panelH = Math.min(400, 100 + friendsList.length * 30 + 50);
  const panelX = (canvas.width - panelW) / 2;
  const panelY = (canvas.height - panelH) / 2;

  // Background
  ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = '#2196F3';
  ctx.lineWidth = 2;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  // Header
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Friends', panelX + panelW / 2, panelY + 20);

  // Close button (top-right)
  ctx.fillStyle = '#888';
  ctx.font = '18px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('✕', panelX + panelW - 10, panelY + 20);

  // Friend list
  let y = panelY + 45;
  if (friendsList.length === 0) {
    ctx.fillStyle = '#666';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No friends yet', panelX + panelW / 2, y + 10);
    y += 30;
  } else {
    for (const f of friendsList) {
      // Online indicator
      ctx.fillStyle = f.online ? '#4caf50' : '#555';
      ctx.beginPath();
      ctx.arc(panelX + 20, y + 6, 5, 0, Math.PI * 2);
      ctx.fill();

      // Handle
      ctx.fillStyle = f.online ? '#fff' : '#888';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`@${f.handle}`, panelX + 32, y + 8);

      // Remove button
      ctx.fillStyle = '#c62828';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('✕', panelX + panelW - 15, y + 8);

      y += 28;
    }
  }

  // Add friend input
  y += 8;
  const addX = panelX + 10;
  const addW = panelW - 80;
  const addH = 28;
  ctx.fillStyle = '#16213e';
  ctx.fillRect(addX, y, addW, addH);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.strokeRect(addX, y, addW, addH);
  ctx.fillStyle = addFriendInput ? '#fff' : '#555';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(addFriendInput || 'handle.bsky.social', addX + 8, y + addH / 2 + 1);

  // Add button
  const addBtnX = addX + addW + 5;
  const addBtnW = 55;
  ctx.fillStyle = '#1976D2';
  ctx.fillRect(addBtnX, y, addBtnW, addH);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Add', addBtnX + addBtnW / 2, y + addH / 2 + 1);

  if (addFriendError) {
    ctx.fillStyle = '#e53935';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(addFriendError, panelX + panelW / 2, y + addH + 14);
  }
}

function drawGameOver() {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  // Darken game underneath
  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Title
  ctx.fillStyle = '#e53935';
  ctx.font = 'bold 64px sans-serif';
  ctx.fillText('GAME OVER', cx, cy - 80);

  // Stats
  ctx.fillStyle = '#fff';
  ctx.font = '28px sans-serif';
  ctx.fillText(`Wave: ${finalWave}`, cx, cy - 20);
  ctx.fillStyle = '#ffb400';
  ctx.fillText(`Score: ${Math.floor(finalScore)}`, cx, cy + 20);

  // Menu button
  const btnW = 260;
  const btnH = 52;
  const btnX = cx - btnW / 2;
  const btnY = cy + 60;
  gameOverMenuBtn = { x: btnX, y: btnY, w: btnW, h: btnH };

  ctx.fillStyle = '#333';
  ctx.beginPath();
  ctx.moveTo(btnX + 10, btnY);
  ctx.arcTo(btnX + btnW, btnY, btnX + btnW, btnY + btnH, 10);
  ctx.arcTo(btnX + btnW, btnY + btnH, btnX, btnY + btnH, 10);
  ctx.arcTo(btnX, btnY + btnH, btnX, btnY, 10);
  ctx.arcTo(btnX, btnY, btnX + btnW, btnY, 10);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('BACK TO MENU', cx, btnY + btnH / 2);
}

function draw() {
  const now = performance.now();
  const dt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  // Process queued deltas (batched on mobile)
  drainDeltaQueue();

  // Client-side prediction — runs every frame for instant response
  predictLocalMovement(dt);

  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  canvas.style.cursor = currentScreen === 'playing' ? 'crosshair' : 'default';

  if (currentScreen === 'menu') {
    drawMenu();
  } else if (currentScreen === 'playing' || currentScreen === 'gameover') {
    const state = buildRenderState();

    if (state) {
      updateCamera();

      ctx.fillStyle = '#3d3d3d';
      ctx.fillRect(-camX, -camY, staticMapWidth, staticMapHeight);

      if (!isMobile) drawGrid();
      drawWalls();
      drawAmmoPickups();
      drawDrops(state);
      drawBullets(state);
      drawZombies(state);
      drawPlayers(state);
      drawMeleeSwing(dt, state);
      if (!isMobile) drawMinimap(state);
      drawHUD(state);
      drawScoreboard(state);
      if (!isMobile) drawWeaponBar(state);
      drawMobileControls();

      if (currentScreen === 'gameover') {
        drawGameOver();
      }
    } else {
      ctx.fillStyle = '#fff';
      ctx.font = '24px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Connecting...', canvas.width / 2, canvas.height / 2);
    }
  }

  requestAnimationFrame(draw);
}

draw();
