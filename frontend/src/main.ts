import { Player, Zombie, Bullet, Wall, ClientInput, DeltaState, SnapshotState, InitPayload, DropPickup } from './generated/types';
import { WEAPON_STATS } from './constants';

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

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

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
const INTERP_DELAY = 60; // ms behind latest state
const MAX_BUFFER_SIZE = 5;

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
    result[id] = {
      ...n,
      pos: {
        x: o.pos.x + (n.pos.x - o.pos.x) * t,
        y: o.pos.y + (n.pos.y - o.pos.y) * t
      },
      angle: o.angle + (n.angle - o.angle) * t
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

const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws`);

// --- Message handling ---
ws.onmessage = (event) => {
  const data = JSON.parse(event.data) as { type: string };

  if (data.type === 'init') {
    const init = data as InitPayload;
    myId = init.id;
    staticWalls = init.walls;
    staticMapWidth = init.mapWidth;
    staticMapHeight = init.mapHeight;
    staticAmmoSpawns = init.ammoSpawnPoints;
    // Initialize ammo availability (all available until told otherwise)
    for (let i = 0; i < staticAmmoSpawns.length; i++) {
      ammoAvailability.set(`ammo_${i}`, true);
    }
  } else if (data.type === 'snapshot') {
    const snap = data as SnapshotState;
    players = snap.players;
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
    pushStateSnapshot();
  } else if (data.type === 'delta') {
    applyDelta(data as DeltaState);
    pushStateSnapshot();
  }
};

function applyDelta(delta: DeltaState) {
  // Players
  if (delta.players) {
    for (const id in delta.players) {
      const diff = delta.players[id];
      const existing = players[id];
      if (existing) {
        if (diff.pos) existing.pos = diff.pos;
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

// Phase 6: Only send input when it changes (+ heartbeat)
let lastSentInput = '';
let lastSendTime = 0;
const HEARTBEAT_INTERVAL = 500;

function maybeSendInput() {
  if (ws.readyState !== WebSocket.OPEN) return;
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

// Send input check every frame (cheap — only actually sends on change)
setInterval(maybeSendInput, 1000 / 30);

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
  const p = players[myId];
  if (!p) return;
  // Use latest (non-interpolated) player pos for camera to reduce input lag feel
  const targetX = p.pos.x - canvas.width / 2;
  const targetY = p.pos.y - canvas.height / 2;
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

    ctx.shadowColor = `rgba(255, 200, 0, ${pulse * 0.5})`;
    ctx.shadowBlur = 15;

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
  ctx.shadowColor = '#FFEB3B';
  ctx.shadowBlur = 6;
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
  ctx.fillText(`Ammo: ${p.ammo}/${p.maxAmmo}`, 20, 52);
  ctx.fillText(`HP: ${p.health}`, 160, 52);
  ctx.font = '13px monospace';
  ctx.fillStyle = '#aaa';
  ctx.fillText(`Melee: Space/E`, 20, 72);
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

function draw() {
  const now = performance.now();
  const dt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const state = buildRenderState();

  if (state) {
    updateCamera();

    ctx.fillStyle = '#3d3d3d';
    ctx.fillRect(-camX, -camY, staticMapWidth, staticMapHeight);

    drawGrid();
    drawWalls();
    drawAmmoPickups();
    drawDrops(state);
    drawBullets(state);
    drawZombies(state);
    drawPlayers(state);
    drawMeleeSwing(dt, state);
    drawMinimap(state);
    drawHUD(state);
    drawWeaponBar(state);

    if (state.gameOver) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#e53935';
      ctx.font = 'bold 64px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('GAME OVER', canvas.width / 2, canvas.height / 2 - 30);
      ctx.fillStyle = '#fff';
      ctx.font = '28px sans-serif';
      ctx.fillText(`Wave: ${state.wave}`, canvas.width / 2, canvas.height / 2 + 20);
      ctx.fillText('Refresh to play again', canvas.width / 2, canvas.height / 2 + 60);
    }
  } else {
    ctx.fillStyle = '#fff';
    ctx.font = '24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Connecting...', canvas.width / 2, canvas.height / 2);
  }

  requestAnimationFrame(draw);
}

draw();
