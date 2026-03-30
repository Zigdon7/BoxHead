import { Player, Zombie, Bullet, Wall, ClientInput, DeltaState, SnapshotState, InitPayload, DropPickup } from './generated/types';
import { WEAPON_STATS, MAP_WIDTH, MAP_HEIGHT, TUNNEL_WIDTH, PLAYER_SPEED, PLAYER_RADIUS, DASH_SPEED_MULT, DASH_DURATION, DASH_MAX_CHARGES, DASH_RECHARGE_TIME } from './constants';

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
const emailInputEl = document.getElementById('emailInput') as HTMLInputElement;
const emailPassEl = document.getElementById('emailPassInput') as HTMLInputElement;
const bskyHandleEl = document.getElementById('bskyHandleInput') as HTMLInputElement;
const bskyPassEl = document.getElementById('bskyPassInput') as HTMLInputElement;
const addFriendEl = document.getElementById('addFriendInputEl') as HTMLInputElement;

const mainMenuOverlay = document.getElementById('mainMenuOverlay')!;
const friendsOverlay = document.getElementById('friendsOverlay')!;
const gameOverOverlay = document.getElementById('gameOverOverlay')!;

const emailLoginBtn = document.getElementById('emailLoginBtn')!;
const emailRegisterBtn = document.getElementById('emailRegisterBtn')!;
const bskyLoginBtn = document.getElementById('bskyLoginBtn')!;
const googleLoginBtn = document.getElementById('googleLoginBtn')!;
const logoutBtn = document.getElementById('logoutBtn')!;
const playBtn = document.getElementById('playBtn')!;
const friendsBtn = document.getElementById('friendsBtn')!;
const closeFriendsBtn = document.getElementById('closeFriendsBtn')!;
const addFriendBtn = document.getElementById('addFriendBtn')!;
const backToMenuBtn = document.getElementById('backToMenuBtn')!;

const authSectionOut = document.getElementById('authSectionOut')!;
const authSectionIn = document.getElementById('authSectionIn')!;
const loggedInStatus = document.getElementById('loggedInStatus')!;
const loginErrorMsg = document.getElementById('loginErrorMsg')!;

const friendsListContainer = document.getElementById('friendsListContainer')!;
const addFriendErrorMsg = document.getElementById('addFriendErrorMsg')!;

const gameOverWave = document.getElementById('gameOverWave')!;
const gameOverScore = document.getElementById('gameOverScore')!;

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// --- Screen state ---
type Screen = 'menu' | 'playing' | 'gameover';
let currentScreen: Screen = 'menu';

function updateAuthDOM() {
  if (isLoggedIn) {
    authSectionOut.classList.add('hidden');
    authSectionIn.classList.remove('hidden');
    loggedInStatus.textContent = `Logged in as @${authHandle}`;
    friendsBtn.textContent = `Friends (${friendsList.filter(f => f.online).length}/${friendsList.length})`;
  } else {
    authSectionOut.classList.remove('hidden');
    authSectionIn.classList.add('hidden');
  }
}

function setScreen(scr: Screen) {
  currentScreen = scr;
  mainMenuOverlay.classList.toggle('hidden', scr !== 'menu');
  gameOverOverlay.classList.toggle('hidden', scr !== 'gameover');
  friendsOverlay.classList.toggle('hidden', true);
  // Show/hide in-game gear button
  document.getElementById('gameSettingsBtn')?.classList.toggle('hidden', scr !== 'playing');
  if (scr === 'menu') updateAuthDOM();
  if (scr === 'gameover') {
    gameOverWave.textContent = finalWave.toString();
    gameOverScore.textContent = Math.floor(finalScore).toString();
  }
}

let finalWave = 0;
let finalScore = 0;
let playerName = localStorage.getItem('boxhead_name') || '';

// --- Auth ---
let authToken = localStorage.getItem('boxhead_auth_token') || '';
let authHandle = localStorage.getItem('boxhead_auth_handle') || '';
let authUserId = localStorage.getItem('boxhead_auth_user_id') || '';
let isLoggedIn = !!authToken;

// --- Friends ---
interface Friend { handle: string; display_name: string; user_id: string; online: boolean; }
let friendsList: Friend[] = [];

function setAuthState(token: string, handle: string, userId: string, displayName?: string) {
  authToken = token;
  authHandle = handle || displayName || '';
  authUserId = userId;
  isLoggedIn = true;
  playerName = authHandle;
  nameInputEl.value = playerName;
  localStorage.setItem('boxhead_auth_token', authToken);
  localStorage.setItem('boxhead_auth_handle', authHandle);
  localStorage.setItem('boxhead_auth_user_id', authUserId);
  localStorage.setItem('boxhead_name', playerName);
  updateAuthDOM();
  refreshFriends();
}

function clearAuthState() {
  authToken = '';
  authHandle = '';
  authUserId = '';
  isLoggedIn = false;
  friendsList = [];
  updateAuthDOM();
  localStorage.removeItem('boxhead_auth_token');
  localStorage.removeItem('boxhead_auth_handle');
  localStorage.removeItem('boxhead_auth_user_id');
}

async function bskyLogin(handle: string, password: string) {
  loginErrorMsg.textContent = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, password }),
    });
    const data = await res.json();
    if (data.ok) {
      setAuthState(data.token, data.handle, data.user_id, data.display_name);
    } else {
      loginErrorMsg.textContent = data.error || 'Login failed';
    }
  } catch {
    loginErrorMsg.textContent = 'Network error';
  }
  bskyLoginBtn.textContent = 'Sign in with Bluesky';
}

function googleLogin() {
  // Open Google OAuth in a popup — the callback page will postMessage back
  const redirectUri = `${window.location.origin}/api/auth/google/callback`;
  // Client ID is embedded in the URL; the server handles the secret
  const params = new URLSearchParams({
    client_id: (window as any).__GOOGLE_CLIENT_ID || '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
  });
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  window.open(url, 'google-login', 'width=500,height=600,menubar=no,toolbar=no');
}

async function emailAuth(endpoint: string) {
  loginErrorMsg.textContent = '';
  const email = emailInputEl.value.trim();
  const password = emailPassEl.value;
  if (!email || !password) { loginErrorMsg.textContent = 'Email and password required'; return; }
  try {
    const res = await fetch(`/api/auth/email/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (data.ok) {
      setAuthState(data.token, data.handle, data.user_id, data.display_name);
    } else {
      loginErrorMsg.textContent = data.error || 'Auth failed';
    }
  } catch {
    loginErrorMsg.textContent = 'Network error';
  }
}

// Listen for Google OAuth callback from popup
window.addEventListener('message', (e) => {
  if (e.origin !== window.location.origin) return;
  if (e.data?.type === 'google-auth') {
    if (e.data.ok) {
      setAuthState(e.data.token, e.data.handle, e.data.user_id, e.data.display_name);
    } else {
      loginErrorMsg.textContent = e.data.error || 'Google login failed';
    }
  }
});

// Fetch config (Google client ID) on load
fetch('/api/config')
  .then(r => r.json())
  .then(data => { (window as any).__GOOGLE_CLIENT_ID = data.google_client_id || ''; })
  .catch(() => {});

// Validate existing session on page load
if (isLoggedIn) {
  fetch(`/api/auth/me?token=${encodeURIComponent(authToken)}`)
    .then(r => r.json())
    .then(data => {
      if (!data.ok) clearAuthState();
    })
    .catch(() => {});
}

async function refreshFriends() {
  if (!authToken) return;
  try {
    const res = await fetch(`/api/friends?token=${encodeURIComponent(authToken)}`);
    const data = await res.json();
    if (data.ok) {
        friendsList = data.friends;
        updateFriendsDOM();
        updateAuthDOM();
    }
  } catch { /* ignore */ }
}

function updateFriendsDOM() {
  if (friendsList.length === 0) {
    friendsListContainer.innerHTML = '<div style="text-align:center; color:#666; padding:10px;">No friends yet</div>';
    return;
  }
  friendsListContainer.innerHTML = friendsList.map(f => `
    <div class="friend-item">
      <span>
        <div class="status-dot ${f.online ? 'online' : ''}"></div>
        ${f.handle}
      </span>
      <button class="btn-icon-red" onclick="window.removeFriendFromDOM('${f.user_id}')">✕</button>
    </div>
  `).join('');
}
(window as any).removeFriendFromDOM = removeFriend;

async function addFriend(handle: string) {
  addFriendErrorMsg.textContent = '';
  try {
    const res = await fetch('/api/friends/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken, handle }),
    });
    const data = await res.json();
    if (data.ok) {
      addFriendEl.value = '';
      refreshFriends();
    } else {
      addFriendErrorMsg.textContent = data.error || 'Failed';
    }
  } catch {
    addFriendErrorMsg.textContent = 'Network error';
  }
}

async function removeFriend(userId: string) {
  try {
    await fetch('/api/friends/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken, user_id: userId }),
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

  const speed = dashActiveTimer > 0 ? PLAYER_SPEED * DASH_SPEED_MULT : PLAYER_SPEED;
  predictedX += dx * speed * dt;
  predictedY += dy * speed * dt;

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

nameInputEl.value = playerName;
nameInputEl.addEventListener('input', () => { playerName = nameInputEl.value; });

// Auth tab switching
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = (tab as HTMLElement).dataset.tab;
    document.getElementById('authTabEmail')!.classList.toggle('hidden', target !== 'email');
    document.getElementById('authTabBsky')!.classList.toggle('hidden', target !== 'bsky');
    document.getElementById('authTabGoogle')!.classList.toggle('hidden', target !== 'google');
    loginErrorMsg.textContent = '';
  });
});

emailLoginBtn.addEventListener('click', () => emailAuth('login'));
emailRegisterBtn.addEventListener('click', () => emailAuth('register'));
bskyLoginBtn.addEventListener('click', () => {
  if (bskyHandleEl.value && bskyPassEl.value) {
    bskyLoginBtn.textContent = 'Signing in...';
    bskyLogin(bskyHandleEl.value, bskyPassEl.value);
  }
});
googleLoginBtn.addEventListener('click', googleLogin);
logoutBtn.addEventListener('click', clearAuthState);
playBtn.addEventListener('click', () => {
  if (playerName.trim()) connectToServer();
  else nameInputEl.focus();
});
friendsBtn.addEventListener('click', () => { friendsOverlay.classList.remove('hidden'); });
closeFriendsBtn.addEventListener('click', () => { friendsOverlay.classList.add('hidden'); });
backToMenuBtn.addEventListener('click', () => {
  if (ws) { ws.close(); ws = null; }
  setScreen('menu');
});
addFriendBtn.addEventListener('click', () => {
  if (addFriendEl.value.trim()) addFriend(addFriendEl.value.trim());
});

document.addEventListener('DOMContentLoaded', () => setScreen('menu'));

// ============ Settings UI ============
const settingsOverlay = document.getElementById('settingsOverlay')!;
const bindingsGrid = document.getElementById('bindingsGrid')!;
const doubleTapToggle = document.getElementById('doubleTapDashToggle') as HTMLInputElement;
const gameSettingsBtn = document.getElementById('gameSettingsBtn')!;

let settingsListening: { action: keyof KeyBindings; btn: HTMLElement } | null = null;

function openSettings() {
  settingsOverlay.style.display = 'flex';
  doubleTapToggle.checked = doubleTapDash;
  renderBindingsGrid();
}

function closeSettings() {
  settingsOverlay.style.display = 'none';
  settingsListening = null;
}

function renderBindingsGrid() {
  const sections: { title: string; keys: (keyof KeyBindings)[] }[] = [
    { title: 'Movement', keys: ['moveUp', 'moveDown', 'moveLeft', 'moveRight'] },
    { title: 'Combat', keys: ['shoot', 'melee', 'dash'] },
    { title: 'Weapons', keys: ['weapon1', 'weapon2', 'weapon3', 'weapon4'] },
  ];

  let html = '';
  for (const section of sections) {
    html += `<div class="settings-section-title">${section.title}</div>`;
    for (const action of section.keys) {
      const label = BINDING_LABELS[action];
      const display = keyDisplayName(bindings[action]);
      html += `<span class="action-label">${label}</span>`;
      html += `<button class="key-btn" data-action="${action}">${display}</button>`;
    }
  }
  bindingsGrid.innerHTML = html;

  // Attach click handlers
  bindingsGrid.querySelectorAll('.key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // Cancel previous listening
      if (settingsListening) {
        settingsListening.btn.classList.remove('listening');
        settingsListening.btn.textContent = keyDisplayName(bindings[settingsListening.action]);
      }
      const action = (btn as HTMLElement).dataset.action as keyof KeyBindings;
      settingsListening = { action, btn: btn as HTMLElement };
      btn.classList.add('listening');
      btn.textContent = 'Press key...';
    });
  });
}

// Capture key/mouse for rebinding
window.addEventListener('keydown', (e) => {
  if (!settingsListening) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Escape') {
    // Cancel rebind
    settingsListening.btn.classList.remove('listening');
    settingsListening.btn.textContent = keyDisplayName(bindings[settingsListening.action]);
    settingsListening = null;
    return;
  }
  bindings[settingsListening.action] = e.code;
  saveBindings(bindings);
  settingsListening.btn.classList.remove('listening');
  settingsListening.btn.textContent = keyDisplayName(e.code);
  settingsListening = null;
}, true); // capture phase so it fires before the game keydown

window.addEventListener('mousedown', (e) => {
  if (!settingsListening) return;
  // Don't capture clicks on the settings panel buttons themselves
  if ((e.target as HTMLElement).closest('.key-btn') || (e.target as HTMLElement).closest('.btn')) return;
  e.preventDefault();
  const code = `Mouse${e.button}`;
  bindings[settingsListening.action] = code;
  saveBindings(bindings);
  settingsListening.btn.classList.remove('listening');
  settingsListening.btn.textContent = keyDisplayName(code);
  settingsListening = null;
}, true);

doubleTapToggle.addEventListener('change', () => {
  doubleTapDash = doubleTapToggle.checked;
  localStorage.setItem('boxhead_doubletap_dash', doubleTapDash ? 'true' : 'false');
});

document.getElementById('menuSettingsBtn')!.addEventListener('click', openSettings);
gameSettingsBtn.addEventListener('click', openSettings);
document.getElementById('closeSettingsBtn')!.addEventListener('click', closeSettings);
document.getElementById('saveSettingsBtn')!.addEventListener('click', closeSettings);
document.getElementById('resetBindingsBtn')!.addEventListener('click', () => {
  bindings = { ...DEFAULT_BINDINGS };
  saveBindings(bindings);
  renderBindingsGrid();
});

// Show/hide in-game gear button
function updateGearButton() {
  gameSettingsBtn.classList.toggle('hidden', currentScreen !== 'playing');
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
  mouseX: 0, mouseY: 0, shooting: false, melee: false, selectWeapon: 0, dash: false
};

// ============ Key Bindings System ============

interface KeyBindings {
  moveUp: string;
  moveDown: string;
  moveLeft: string;
  moveRight: string;
  shoot: string;
  melee: string;
  dash: string;
  weapon1: string;
  weapon2: string;
  weapon3: string;
  weapon4: string;
}

const DEFAULT_BINDINGS: KeyBindings = {
  moveUp: 'KeyW',
  moveDown: 'KeyS',
  moveLeft: 'KeyA',
  moveRight: 'KeyD',
  shoot: 'Mouse0',
  melee: 'Space',
  dash: 'ShiftLeft',
  weapon1: 'Digit1',
  weapon2: 'Digit2',
  weapon3: 'Digit3',
  weapon4: 'Digit4',
};

const BINDING_LABELS: Record<keyof KeyBindings, string> = {
  moveUp: 'Move Up',
  moveDown: 'Move Down',
  moveLeft: 'Move Left',
  moveRight: 'Move Right',
  shoot: 'Shoot',
  melee: 'Melee',
  dash: 'Dash',
  weapon1: 'Weapon 1',
  weapon2: 'Weapon 2',
  weapon3: 'Weapon 3',
  weapon4: 'Weapon 4',
};

function loadBindings(): KeyBindings {
  try {
    const saved = localStorage.getItem('boxhead_keybindings');
    if (saved) return { ...DEFAULT_BINDINGS, ...JSON.parse(saved) };
  } catch { /* ignore */ }
  return { ...DEFAULT_BINDINGS };
}

function saveBindings(b: KeyBindings) {
  localStorage.setItem('boxhead_keybindings', JSON.stringify(b));
}

let bindings = loadBindings();
let doubleTapDash = localStorage.getItem('boxhead_doubletap_dash') !== 'false';

function keyDisplayName(code: string): string {
  if (code === 'Mouse0') return 'LMB';
  if (code === 'Mouse1') return 'MMB';
  if (code === 'Mouse2') return 'RMB';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (code === 'ControlLeft' || code === 'ControlRight') return 'Ctrl';
  if (code === 'AltLeft' || code === 'AltRight') return 'Alt';
  if (code === 'Space') return 'Space';
  if (code === 'ArrowUp') return 'Up';
  if (code === 'ArrowDown') return 'Down';
  if (code === 'ArrowLeft') return 'Left';
  if (code === 'ArrowRight') return 'Right';
  if (code === 'Tab') return 'Tab';
  if (code === 'CapsLock') return 'Caps';
  if (code === 'Backquote') return '`';
  if (code === 'Minus') return '-';
  if (code === 'Equal') return '=';
  if (code === 'BracketLeft') return '[';
  if (code === 'BracketRight') return ']';
  if (code === 'Semicolon') return ';';
  if (code === 'Quote') return "'";
  if (code === 'Comma') return ',';
  if (code === 'Period') return '.';
  if (code === 'Slash') return '/';
  if (code === 'Backslash') return '\\';
  return code;
}

// Reverse lookup: code -> action
function codeToActions(code: string): (keyof KeyBindings)[] {
  const result: (keyof KeyBindings)[] = [];
  for (const [action, bound] of Object.entries(bindings)) {
    if (bound === code || (code === 'ShiftRight' && bound === 'ShiftLeft') || (code === 'ShiftLeft' && bound === 'ShiftRight')) {
      result.push(action as keyof KeyBindings);
    }
  }
  return result;
}

// Pressed keys set (by code)
const keysDown = new Set<string>();

// Dash state — charge-based (max 3)
let dashCharges = DASH_MAX_CHARGES;
let dashRechargeTimer = 0; // time until next charge restored
let dashPending = false; // one-shot flag — true until sent to server
let dashActiveTimer = 0; // client-side visual for speed prediction

// Double-tap tracking: keyCode -> last press timestamp
const doubleTapTimes: Record<string, number> = {};
const DOUBLE_TAP_WINDOW = 400; // ms

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
      setScreen('gameover');
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
  setScreen('playing');
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
      // If the server already has a game-over in progress, show it immediately
      // (player joined an ended session — no need to wait for snapshot/delta).
      if (init.gameOver) {
        gameOver = true;
        wave = init.wave;
        finalWave = wave;
        finalScore = 0;
        setScreen('gameover');
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

      // Sync screen state with server-authoritative gameOver flag
      if (snap.gameOver && currentScreen === 'playing') {
        const me = players[myId];
        finalWave = wave;
        finalScore = me ? Math.floor(me.score) : 0;
        setScreen('gameover');
      } else if (!snap.gameOver && currentScreen === 'gameover') {
        // Restart happened — go back to playing
        setScreen('playing');
      }

      pushStateSnapshot();
    } else if (data.type === 'delta') {
      pendingDeltas.push(data as DeltaState);
    }
  };

  ws.onclose = () => {
    if (inputInterval) { clearInterval(inputInterval); inputInterval = null; }
    // Only revert to menu if we weren't already showing the game-over screen.
    // If the server closed the connection because the game ended (or because the
    // player joined a game that was already over), we stay on the gameover screen
    // so the player sees their final stats.
    if (currentScreen === 'playing') {
      setScreen('menu');
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

// --- Input (configurable bindings) ---

function isMoving() {
  return input.up || input.down || input.left || input.right;
}

function tryTriggerDash() {
  if (dashCharges > 0 && dashActiveTimer <= 0) {
    dashPending = true;
    dashCharges--;
    dashActiveTimer = DASH_DURATION;
    if (dashRechargeTimer <= 0) {
      dashRechargeTimer = DASH_RECHARGE_TIME;
    }
  }
}

function handleActionDown(code: string) {
  const actions = codeToActions(code);
  for (const action of actions) {
    switch (action) {
      case 'moveUp': input.up = true; break;
      case 'moveDown': input.down = true; break;
      case 'moveLeft': input.left = true; break;
      case 'moveRight': input.right = true; break;
      case 'shoot': input.shooting = true; break;
      case 'melee':
        input.melee = true;
        meleeSwingTime = 0.3;
        { const p = players[myId]; if (p) meleeSwingAngle = p.angle; }
        break;
      case 'dash':
        // Shift+direction: only trigger if moving
        if (isMoving()) tryTriggerDash();
        break;
      case 'weapon1': input.selectWeapon = 1; break;
      case 'weapon2': input.selectWeapon = 2; break;
      case 'weapon3': input.selectWeapon = 3; break;
      case 'weapon4': input.selectWeapon = 4; break;
    }
  }

}

function handleActionUp(code: string) {
  const actions = codeToActions(code);
  for (const action of actions) {
    switch (action) {
      case 'moveUp': input.up = false; break;
      case 'moveDown': input.down = false; break;
      case 'moveLeft': input.left = false; break;
      case 'moveRight': input.right = false; break;
      case 'shoot': input.shooting = false; break;
      case 'melee': input.melee = false; break;
      case 'weapon1': case 'weapon2': case 'weapon3': case 'weapon4':
        input.selectWeapon = 0; break;
    }
  }
}

// Also trigger dash when you start moving while shift is already held
function checkDashOnMove() {
  if (keysDown.has(bindings.dash) && isMoving()) {
    tryTriggerDash();
  }
}

window.addEventListener('keydown', (e) => {
  if (document.activeElement?.tagName === 'INPUT') return;
  if (settingsListening) return; // settings is capturing this key
  const code = e.code;
  const wasDown = keysDown.has(code);
  if (wasDown) return; // ignore key repeat
  keysDown.add(code);

  // Double-tap dash: check BEFORE handleActionDown so we detect the re-press
  if (doubleTapDash && !wasDown) {
    const dirCodes = [bindings.moveUp, bindings.moveDown, bindings.moveLeft, bindings.moveRight];
    if (dirCodes.includes(code)) {
      const now = performance.now();
      const prev = doubleTapTimes[code] || 0;
      if (now - prev < DOUBLE_TAP_WINDOW && prev > 0) {
        tryTriggerDash();
        doubleTapTimes[code] = 0;
      } else {
        doubleTapTimes[code] = now;
      }
    }
  }

  handleActionDown(code);
  // Check if we just started moving while dash key is held
  const dirActions = codeToActions(code);
  if (dirActions.some(a => a.startsWith('move'))) checkDashOnMove();
});

window.addEventListener('keyup', (e) => {
  if (document.activeElement?.tagName === 'INPUT') return;
  const code = e.code;
  keysDown.delete(code);
  handleActionUp(code);
});

window.addEventListener('mousemove', (e) => {
  screenMouseX = e.clientX;
  screenMouseY = e.clientY;
});

window.addEventListener('mousedown', (e) => {
  if (settingsListening) return;
  const code = `Mouse${e.button}`;
  keysDown.add(code);
  handleActionDown(code);
});
window.addEventListener('mouseup', (e) => {
  const code = `Mouse${e.button}`;
  keysDown.delete(code);
  handleActionUp(code);
});
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

  // Apply one-shot dash
  if (dashPending) {
    input.dash = true;
    dashPending = false;
  }

  const snapshot = JSON.stringify(input);
  const now = performance.now();

  if (snapshot !== lastSentInput || now - lastSendTime > HEARTBEAT_INTERVAL) {
    ws.send(JSON.stringify({ type: 'input', input }));
    lastSentInput = snapshot;
    lastSendTime = now;
  }

  // Clear one-shot dash after sending
  input.dash = false;
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

function drawTunnels() {
  const pulse = 0.4 + 0.3 * Math.sin(performance.now() / 500);
  const tw = TUNNEL_WIDTH;
  const hMid = MAP_WIDTH / 2;
  const vMid = MAP_HEIGHT / 2;
  const arrowSize = 12;

  // Helper to draw a tunnel opening with arrows
  function drawTunnelOpening(
    x: number, y: number, w: number, h: number,
    arrowDir: 'up' | 'down' | 'left' | 'right'
  ) {
    const sx = x - camX;
    const sy = y - camY;
    if (sx + w < -20 || sx > canvas.width + 20 || sy + h < -20 || sy > canvas.height + 20) return;

    // Glowing opening
    ctx.fillStyle = `rgba(0, 200, 255, ${pulse * 0.15})`;
    ctx.fillRect(sx, sy, w, h);

    // Border glow lines
    ctx.strokeStyle = `rgba(0, 200, 255, ${pulse * 0.6})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.strokeRect(sx + 1, sy + 1, w - 2, h - 2);
    ctx.setLineDash([]);

    // Directional arrows
    ctx.fillStyle = `rgba(0, 200, 255, ${pulse * 0.8})`;
    const cx = sx + w / 2;
    const cy = sy + h / 2;

    const drawArrow = (ax: number, ay: number) => {
      ctx.beginPath();
      if (arrowDir === 'up') {
        ctx.moveTo(ax, ay - arrowSize);
        ctx.lineTo(ax - arrowSize / 2, ay);
        ctx.lineTo(ax + arrowSize / 2, ay);
      } else if (arrowDir === 'down') {
        ctx.moveTo(ax, ay + arrowSize);
        ctx.lineTo(ax - arrowSize / 2, ay);
        ctx.lineTo(ax + arrowSize / 2, ay);
      } else if (arrowDir === 'left') {
        ctx.moveTo(ax - arrowSize, ay);
        ctx.lineTo(ax, ay - arrowSize / 2);
        ctx.lineTo(ax, ay + arrowSize / 2);
      } else {
        ctx.moveTo(ax + arrowSize, ay);
        ctx.lineTo(ax, ay - arrowSize / 2);
        ctx.lineTo(ax, ay + arrowSize / 2);
      }
      ctx.fill();
    };

    if (arrowDir === 'left' || arrowDir === 'right') {
      drawArrow(cx, cy - 30);
      drawArrow(cx, cy);
      drawArrow(cx, cy + 30);
    } else {
      drawArrow(cx - 30, cy);
      drawArrow(cx, cy);
      drawArrow(cx + 30, cy);
    }
  }

  // Top tunnel
  drawTunnelOpening(hMid - tw / 2, 0, tw, 20, 'up');
  // Bottom tunnel
  drawTunnelOpening(hMid - tw / 2, MAP_HEIGHT - 20, tw, 20, 'down');
  // Left tunnel
  drawTunnelOpening(0, vMid - tw / 2, 20, tw, 'left');
  // Right tunnel
  drawTunnelOpening(MAP_WIDTH - 20, vMid - tw / 2, 20, tw, 'right');
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
  const now = performance.now();
  for (const d of state.drops) {
    const sx = d.pos.x - camX;
    const sy = d.pos.y - camY;
    if (sx < -40 || sx > canvas.width + 40 || sy < -40 || sy > canvas.height + 40) continue;

    const pulse = 0.75 + 0.25 * Math.sin(now / 200);
    const bob = Math.sin(now / 300) * 3;
    const dy = sy + bob;

    // Outer glow
    const glowColors: Record<string, string> = {
      ammo: 'rgba(255,200,0,0.25)',
      health: 'rgba(76,175,80,0.3)',
      weapon: 'rgba(156,39,176,0.3)',
    };
    const glowR = 22 + 4 * Math.sin(now / 250);
    ctx.beginPath();
    ctx.arc(sx, dy, glowR, 0, Math.PI * 2);
    ctx.fillStyle = glowColors[d.type] || 'rgba(255,255,255,0.1)';
    ctx.fill();

    // Inner circle bg
    const bgColors: Record<string, string> = {
      ammo: `rgba(50,40,0,${pulse})`,
      health: `rgba(0,40,10,${pulse})`,
      weapon: `rgba(40,0,50,${pulse})`,
    };
    ctx.beginPath();
    ctx.arc(sx, dy, 14, 0, Math.PI * 2);
    ctx.fillStyle = bgColors[d.type] || 'rgba(0,0,0,0.5)';
    ctx.fill();

    // Border ring
    const ringColors: Record<string, string> = {
      ammo: '#ffb400',
      health: '#4caf50',
      weapon: '#ce93d8',
    };
    ctx.strokeStyle = ringColors[d.type] || '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (d.type === 'ammo') {
      // Bullet icon
      ctx.fillStyle = '#ffb400';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText('\u{1F4A5}', sx, dy); // or a simpler icon
      // Actually draw bullet shapes
      ctx.fillStyle = '#ffd54f';
      ctx.fillRect(sx - 6, dy - 3, 4, 10);
      ctx.fillRect(sx - 1, dy - 3, 4, 10);
      ctx.fillRect(sx + 4, dy - 3, 4, 10);
      ctx.fillStyle = '#ff8f00';
      ctx.fillRect(sx - 6, dy - 5, 4, 3);
      ctx.fillRect(sx - 1, dy - 5, 4, 3);
      ctx.fillRect(sx + 4, dy - 5, 4, 3);
    } else if (d.type === 'health') {
      // Red cross
      ctx.fillStyle = '#fff';
      ctx.fillRect(sx - 2, dy - 8, 5, 16);
      ctx.fillRect(sx - 8, dy - 2, 16, 5);
      ctx.fillStyle = '#e53935';
      ctx.fillRect(sx - 1, dy - 7, 3, 14);
      ctx.fillRect(sx - 7, dy - 1, 14, 3);
    } else if (d.type === 'weapon') {
      // Gun silhouette
      ctx.fillStyle = '#ce93d8';
      // Barrel
      ctx.fillRect(sx - 2, dy - 8, 5, 10);
      // Body
      ctx.fillRect(sx - 6, dy - 2, 13, 5);
      // Grip
      ctx.fillRect(sx - 4, dy + 3, 4, 6);
      // Star accent
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 8px sans-serif';
      ctx.fillText('\u2605', sx + 5, dy - 5);
    }

    // Label below
    const labelColors: Record<string, string> = { ammo: '#ffd54f', health: '#81c784', weapon: '#ce93d8' };
    const labelText: Record<string, string> = { ammo: 'AMMO', health: 'HEALTH', weapon: 'WEAPON' };
    ctx.fillStyle = labelColors[d.type] || '#fff';
    ctx.font = 'bold 8px monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(labelText[d.type] || '', sx, dy + 16);
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

    // Dead player: draw ghost marker with revive hint
    if (p.health <= 0) {
      ctx.save();
      ctx.translate(sx, sy);
      ctx.globalAlpha = 0.5 + 0.2 * Math.sin(performance.now() / 400);
      // Skull icon
      ctx.fillStyle = '#ff5252';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('\u2620', 0, 0);
      ctx.globalAlpha = 1;
      // Player name
      const displayName = p.name || p.id.slice(0, 6);
      ctx.fillStyle = '#ff8888';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(displayName, 0, -24);
      // "Stand near to revive" hint
      ctx.fillStyle = '#aaa';
      ctx.font = '10px sans-serif';
      ctx.fillText('Stand near to revive', 0, 22);
      ctx.restore();
      continue;
    }

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

  // Dash stamina bar (3 pips)
  ctx.font = '11px monospace';
  ctx.fillStyle = '#aaa';
  ctx.fillText('Dash', 20, 72);
  const pipW = 28;
  const pipH = 8;
  const pipGap = 3;
  const pipStartX = 62;
  const pipY = 64;
  for (let i = 0; i < DASH_MAX_CHARGES; i++) {
    const px = pipStartX + i * (pipW + pipGap);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(px, pipY, pipW, pipH);
    if (i < dashCharges) {
      ctx.fillStyle = '#4caf50';
      ctx.fillRect(px, pipY, pipW, pipH);
    } else if (i === dashCharges && dashRechargeTimer > 0) {
      // Partially filling pip
      const fill = 1 - (dashRechargeTimer / DASH_RECHARGE_TIME);
      ctx.fillStyle = '#2e7d32';
      ctx.fillRect(px, pipY, pipW * fill, pipH);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(px, pipY, pipW, pipH);
  }

  // Shift label
  ctx.fillStyle = '#666';
  ctx.font = '9px monospace';
  ctx.fillText('[Shift]', pipStartX + DASH_MAX_CHARGES * (pipW + pipGap) + 2, 72);
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

function drawStatusEffects(state: GameState) {
  const p = state.players[myId];
  if (!p) return;

  const panelX = 10;
  const panelY = canvas.height - 160;
  const iconSize = 28;
  const gap = 6;

  interface StatusEntry {
    icon: string;
    label: string;
    color: string;
    active: boolean;
    detail: string;
  }

  const statuses: StatusEntry[] = [];

  // Weapons unlocked
  const weaponNames = ['Pistol', 'Uzi', 'Shotgun', 'Rocket'];
  const weaponIcons = ['\u{1F52B}', '\u{26A1}', '\u{1F4A3}', '\u{1F680}'];
  const weaponColors = ['#aaa', '#ffd54f', '#ff8a65', '#ef5350'];
  const slots = p.weaponSlots || [true, false, false, false];
  for (let i = 1; i < 4; i++) {
    if (slots[i]) {
      statuses.push({
        icon: weaponIcons[i],
        label: weaponNames[i],
        color: weaponColors[i],
        active: p.weapon === ['pistol', 'uzi', 'shotgun', 'rocketLauncher'][i],
        detail: p.weapon === ['pistol', 'uzi', 'shotgun', 'rocketLauncher'][i] ? 'ACTIVE' : 'Unlocked',
      });
    }
  }

  // Dash charges
  statuses.push({
    icon: '\u{1F4A8}',
    label: 'Dash',
    color: dashCharges > 0 ? '#4caf50' : '#555',
    active: dashActiveTimer > 0,
    detail: `${dashCharges}/${DASH_MAX_CHARGES}`,
  });

  // Health status
  if (p.health <= 30) {
    statuses.push({
      icon: '\u{1F534}',
      label: 'Low HP',
      color: '#e53935',
      active: true,
      detail: `${Math.ceil(p.health)} HP`,
    });
  }

  if (statuses.length === 0) return;

  // Panel background
  const panelH = statuses.length * (iconSize + gap) + 8;
  const panelW = 130;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  for (let i = 0; i < statuses.length; i++) {
    const s = statuses[i];
    const y = panelY + 6 + i * (iconSize + gap);

    // Icon bg
    ctx.fillStyle = s.active ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(panelX + 4, y, iconSize, iconSize);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1;
    ctx.strokeRect(panelX + 4, y, iconSize, iconSize);

    // Icon text
    ctx.fillStyle = s.color;
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.icon, panelX + 4 + iconSize / 2, y + iconSize / 2);

    // Label + detail
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ddd';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(s.label, panelX + iconSize + 10, y + 2);
    ctx.fillStyle = s.color;
    ctx.font = '9px monospace';
    ctx.fillText(s.detail, panelX + iconSize + 10, y + 15);
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

function draw() {
  const now = performance.now();
  const dt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  // Process queued deltas (batched on mobile)
  drainDeltaQueue();

  // Client-side prediction — runs every frame for instant response
  predictLocalMovement(dt);

  // Dash charge recharge
  dashActiveTimer = Math.max(0, dashActiveTimer - dt);
  if (dashCharges < DASH_MAX_CHARGES) {
    dashRechargeTimer -= dt;
    if (dashRechargeTimer <= 0) {
      dashCharges++;
      dashRechargeTimer = dashCharges < DASH_MAX_CHARGES ? DASH_RECHARGE_TIME : 0;
    }
  }

  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  canvas.style.cursor = currentScreen === 'playing' ? 'crosshair' : 'default';

  if (currentScreen === 'menu') {
    // Handled by HTML overlay
  } else if (currentScreen === 'playing' || currentScreen === 'gameover') {
    const state = buildRenderState();

    if (state) {
      updateCamera();

      ctx.fillStyle = '#3d3d3d';
      ctx.fillRect(-camX, -camY, staticMapWidth, staticMapHeight);

      if (!isMobile) drawGrid();
      drawTunnels();
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
      if (!isMobile) drawStatusEffects(state);
      drawMobileControls();

      if (currentScreen === 'gameover') {
        // Handled by HTML overlay
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
