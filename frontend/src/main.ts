import {
  Player,
  Zombie,
  Bullet,
  Wall,
  ClientInput,
  DeltaState,
  SnapshotState,
  InitPayload,
  DropPickup,
  Placeable,
} from './generated/types';
import {
  WEAPON_STATS,
  MAP_WIDTH,
  MAP_HEIGHT,
  TUNNEL_WIDTH,
  PLAYER_SPEED,
  PLAYER_RADIUS,
  DASH_SPEED_MULT,
  DASH_DURATION,
  DASH_MAX_CHARGES,
  DASH_RECHARGE_TIME,
  COMBO_DURATION,
  WAVE_BREAK_DURATION,
  MELEE_COOLDOWN,
  MELEE_RANGE,
} from './constants';

// Local composite type for rendering
interface GameState {
  players: Record<string, Player>;
  zombies: Zombie[];
  bullets: Bullet[];
  placeables: Placeable[];
  wave: number;
  waveKills: number;
  waveTarget: number;
  waveBreakTimer: number;
  walls: Wall[];
  ammoPickups: { id: string; pos: { x: number; y: number }; amount: number; respawnAt: number }[];
  mapWidth: number;
  mapHeight: number;
  gameOver: boolean;
  drops: DropPickup[];
}

// --- Visual Effects Types ---
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  alpha: number;
  life: number;
  maxLife: number;
  drag: number;
}

interface BloodStain {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  createdAt: number;
  blobs: { dx: number; dy: number; r: number }[];
}

interface FloatingText {
  x: number;
  y: number;
  vy: number;
  text: string;
  color: string;
  size: number;
  life: number;
  maxLife: number;
}

interface Shockwave {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  color: string;
  life: number;
  maxLife: number;
}

interface MuzzleFlash {
  x: number;
  y: number;
  angle: number;
  size: number;
  color: string;
  life: number;
}

interface DashGhost {
  x: number;
  y: number;
  angle: number;
  alpha: number;
}

interface FeedEvent {
  text: string;
  color: string;
  time: number;
}

const particles: Particle[] = [];
const bloodStains: BloodStain[] = [];
const floatingTexts: FloatingText[] = [];
const shockwaves: Shockwave[] = [];
const muzzleFlashes: MuzzleFlash[] = [];
const dashGhosts: DashGhost[] = [];
const eventFeed: FeedEvent[] = [];

let screenShakeAmount = 0;
let damageFlashAlpha = 0;
let healFlashAlpha = 0;
let waveBannerText = '';
let waveBannerSub = '';
let waveBannerColor = '#ffb400';
let waveBannerTimer = 0;
let armoryOpen = false;
let hotbarMeleeBtnRect = { x: 0, y: 0, w: 0, h: 0 };
let hotbarArmoryBtnRect = { x: 0, y: 0, w: 0, h: 0 };
let hotbarWeaponRects: { slot: number; x: number; y: number; w: number; h: number }[] = [];
let hotbarTacticalRects: { item: number; x: number; y: number; w: number; h: number }[] = [];

function addScreenShake(intensity: number) {
  screenShakeAmount = Math.min(22, Math.max(screenShakeAmount, intensity));
}

function pushFeedEvent(text: string, color = '#e0e0e0') {
  eventFeed.unshift({ text, color, time: performance.now() });
  if (eventFeed.length > 6) eventFeed.pop();
}

function spawnFloatingText(x: number, y: number, text: string, color = '#fff', size = 14) {
  floatingTexts.push({
    x: x + (Math.random() - 0.5) * 14,
    y: y - 10,
    vy: -38 - Math.random() * 15,
    text,
    color,
    size,
    life: 0.85,
    maxLife: 0.85,
  });
}

function spawnBlood(x: number, y: number, count: number, isKill: boolean) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 35 + Math.random() * (isKill ? 150 : 90);
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 2 + Math.random() * 3,
      color: Math.random() < 0.6 ? '#c62828' : '#8e0000',
      alpha: 0.95,
      life: 0.28 + Math.random() * 0.25,
      maxLife: 0.5,
      drag: 0.9,
    });
  }
  if (isKill) {
    const blobs = [];
    const blobCount = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < blobCount; i++) {
      blobs.push({
        dx: (Math.random() - 0.5) * 16,
        dy: (Math.random() - 0.5) * 16,
        r: 4 + Math.random() * 8,
      });
    }
    bloodStains.push({
      x,
      y,
      radius: 10 + Math.random() * 6,
      alpha: 0.45,
      createdAt: performance.now(),
      blobs,
    });
    if (bloodStains.length > 75) bloodStains.shift();
  }
}

function spawnExplosion(x: number, y: number, maxRadius: number, color = '#ff6d00') {
  shockwaves.push({
    x,
    y,
    radius: 8,
    maxRadius,
    color,
    life: 0.35,
    maxLife: 0.35,
  });
  for (let i = 0; i < 28; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 50 + Math.random() * 240;
    const isSmoke = i >= 18;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: isSmoke ? 5 + Math.random() * 5 : 2.5 + Math.random() * 3.5,
      color: isSmoke ? '#555' : Math.random() < 0.5 ? '#ffab00' : '#ff3d00',
      alpha: 1,
      life: isSmoke ? 0.55 : 0.35 + Math.random() * 0.15,
      maxLife: 0.55,
      drag: 0.92,
    });
  }
  // Camera shake scaled by distance to local player
  const me = players[myId];
  if (me) {
    const dist = Math.hypot(me.pos.x - x, me.pos.y - y);
    if (dist < 600) {
      addScreenShake(Math.max(4, 15 * (1 - dist / 600)));
    }
  }
}

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
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
const playAgainBtn = document.getElementById('playAgainBtn')!;
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
const gameOverKills = document.getElementById('gameOverKills')!;
const gameOverCombo = document.getElementById('gameOverCombo')!;

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
  if (scr === 'gameover') {
    gameOverOverlay.style.display = 'flex';
  } else {
    gameOverOverlay.style.display = 'none';
  }
  friendsOverlay.classList.toggle('hidden', true);
  document.getElementById('gameSettingsBtn')?.classList.toggle('hidden', scr !== 'playing');
  if (scr === 'menu') updateAuthDOM();
  if (scr === 'gameover') {
    gameOverWave.textContent = finalWave.toString();
    gameOverScore.textContent = Math.floor(finalScore).toString();
    gameOverKills.textContent = finalKills.toString();
    gameOverCombo.textContent = `${finalMaxCombo}x`;
  }
}

let finalWave = 1;
let finalScore = 0;
let finalKills = 0;
let finalMaxCombo = 0;
let playerName = localStorage.getItem('boxhead_name') || 'Operative';

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
  const redirectUri = `${window.location.origin}/api/auth/google/callback`;
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

fetch('/api/config')
  .then(r => r.json())
  .then(data => { (window as any).__GOOGLE_CLIENT_ID = data.google_client_id || ''; })
  .catch(() => {});

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

setInterval(() => { if (isLoggedIn) refreshFriends(); }, 5000);
if (isLoggedIn) refreshFriends();

// --- Static data (received once on init) ---
let staticWalls: Wall[] = [];
let staticMapWidth = 2400;
let staticMapHeight = 1800;
let staticAmmoSpawns: { x: number; y: number; amount: number }[] = [];

// --- Live game state (built from snapshots + deltas) ---
let players: Record<string, Player> = {};
let zombieMap: Map<string, Zombie> = new Map();
let bulletMap: Map<string, Bullet> = new Map();
let bulletCreationTime: Map<string, number> = new Map();
let placeableMap: Map<string, Placeable> = new Map();
let wave = 1;
let waveKills = 0;
let waveTarget = 12;
let waveBreakTimer = 0;
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

  const me = players[myId];
  const hasOverdrive = me && me.combo >= 10;
  const baseSpeed = hasOverdrive ? PLAYER_SPEED * 1.15 : PLAYER_SPEED;
  const speed = dashActiveTimer > 0 ? baseSpeed * DASH_SPEED_MULT : baseSpeed;
  predictedX += dx * speed * dt;
  predictedY += dy * speed * dt;

  predictedX = Math.max(PLAYER_RADIUS, Math.min(staticMapWidth - PLAYER_RADIUS, predictedX));
  predictedY = Math.max(PLAYER_RADIUS, Math.min(staticMapHeight - PLAYER_RADIUS, predictedY));

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
  if (!playerName.trim()) playerName = 'Operative';
  nameInputEl.value = playerName;
  connectToServer();
});
playAgainBtn.addEventListener('click', async () => {
  try {
    await fetch('/admin/restart', { method: 'POST' });
  } catch { /* ignore */ }
  if (ws) { ws.close(); ws = null; }
  connectToServer();
});
friendsBtn.addEventListener('click', () => { friendsOverlay.classList.remove('hidden'); friendsOverlay.style.display = 'flex'; });
closeFriendsBtn.addEventListener('click', () => { friendsOverlay.classList.add('hidden'); friendsOverlay.style.display = 'none'; });
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
    { title: 'Combat & Mobility', keys: ['shoot', 'melee', 'dash'] },
    { title: 'Weapons', keys: ['weapon1', 'weapon2', 'weapon3', 'weapon4'] },
    { title: 'Tactical & Armory', keys: ['placeBarrel', 'placeBarricade', 'placeMine', 'toggleShop'] },
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

  bindingsGrid.querySelectorAll('.key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
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

window.addEventListener('keydown', (e) => {
  if (!settingsListening) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Escape') {
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
}, true);

window.addEventListener('mousedown', (e) => {
  if (!settingsListening) return;
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

// ============ Tactical Armory UI (DOM Modal) ============
const armoryOverlay = document.getElementById('armoryOverlay')!;
const armoryCreditsVal = document.getElementById('armoryCreditsVal')!;
const armoryGrid = document.getElementById('armoryGrid')!;
const closeArmoryBtn = document.getElementById('closeArmoryBtn')!;

function toggleArmory(forceState?: boolean) {
  armoryOpen = forceState !== undefined ? forceState : !armoryOpen;
  if (armoryOpen && currentScreen === 'playing') {
    armoryOverlay.style.display = 'flex';
    renderArmoryDOM();
  } else {
    armoryOpen = false;
    armoryOverlay.style.display = 'none';
  }
}

closeArmoryBtn.addEventListener('click', () => toggleArmory(false));
armoryOverlay.addEventListener('mousedown', (e) => {
  if (e.target === armoryOverlay) {
    toggleArmory(false);
  }
});

function renderLevelPips(level: number, maxPips = 6): string {
  let html = '<div class="level-pips">';
  for (let i = 0; i < maxPips; i++) {
    html += `<span class="level-pip ${i < level ? 'filled' : ''}"></span>`;
  }
  if (level > maxPips) {
    html += `<span style="font-size:0.65rem;color:#ffb400;margin-left:3px;">+${level - maxPips}</span>`;
  }
  html += '</div>';
  return html;
}

function renderArmoryDOM() {
  if (!armoryOpen) return;
  const p = players[myId];
  if (!p) return;

  const credits = Math.floor(p.credits ?? 0);
  armoryCreditsVal.textContent = `$${credits}`;

  const dmgLv = p.damageLevel || 0;
  const meleeLv = p.meleeLevel || 0;
  const dmgCost = 150 + dmgLv * 125;
  const meleeCost = 125 + meleeLv * 100;

  const slots = p.weaponSlots || [true, false, false, false];
  const weaponNames = ['Pistol', 'Uzi SMG', 'Combat Shotgun', 'Rocket Launcher'];
  const nextLockedIdx = slots.findIndex((unlocked, idx) => idx > 0 && !unlocked);
  const nextWeaponName = nextLockedIdx !== -1 ? weaponNames[nextLockedIdx] : 'All Firearms Unlocked';

  const curMeleeDmg = Math.round(45 * (1 + meleeLv * 0.35));
  const nextMeleeDmg = Math.round(45 * (1 + (meleeLv + 1) * 0.35));
  const nextMeleeHeal = 5 + (meleeLv + 1) * 3;

  const cards = [
    {
      id: 1,
      shortcut: '1',
      icon: '🔫',
      iconBg: 'rgba(229, 57, 53, 0.2)',
      iconColor: '#ff5252',
      title: `Firearm Power (Lv.${dmgLv})`,
      desc: 'Boosts bullet & explosive damage by +20% and crit chance by +4% per level.',
      statText: `+${dmgLv * 20}% → +${(dmgLv + 1) * 20}% DMG`,
      pips: renderLevelPips(dmgLv),
      cost: dmgCost,
    },
    {
      id: 5,
      shortcut: '2',
      icon: '⚔️',
      iconBg: 'rgba(0, 229, 255, 0.18)',
      iconColor: '#00e5ff',
      title: `Plasma Katana (Lv.${meleeLv})`,
      desc: 'Sharpens melee cleave (+35% DMG, +10% reach) and increases vampiric lifesteal on kill.',
      statText: `${curMeleeDmg} → ${nextMeleeDmg} DMG • +${nextMeleeHeal}HP/Kill`,
      pips: renderLevelPips(meleeLv),
      cost: meleeCost,
    },
    {
      id: 2,
      shortcut: '3',
      icon: '🛡️',
      iconBg: 'rgba(0, 230, 118, 0.18)',
      iconColor: '#00e676',
      title: 'Nano-Armor & Medkit',
      desc: 'Permanently increases Max HP by +25 and immediately restores +60 Health.',
      statText: `HP ${Math.ceil(p.health)}/${p.maxHealth} → +25 Max & +60 Heal`,
      pips: '',
      cost: 120,
    },
    {
      id: 3,
      shortcut: '4',
      icon: '🔋',
      iconBg: 'rgba(255, 180, 0, 0.18)',
      iconColor: '#ffd54f',
      title: 'Expanded Magazine',
      desc: 'Increases Max Ammo capacity by +25 and completely refills your reserve.',
      statText: `Ammo ${Math.floor(p.ammo)}/${p.maxAmmo} → ${p.maxAmmo + 25} Full`,
      pips: '',
      cost: 100,
    },
    {
      id: 4,
      shortcut: '5',
      icon: '💣',
      iconBg: 'rgba(41, 182, 246, 0.18)',
      iconColor: '#29b6f6',
      title: 'Tactical Munitions Pack',
      desc: 'Field resupply of +2 Explosive Barrels, +2 Steel Barricades, and +2 Claymores.',
      statText: `Gear: ${(p.tacticalItems?.[0] || 0)}B / ${(p.tacticalItems?.[1] || 0)}W / ${(p.tacticalItems?.[2] || 0)}M (+2 All)`,
      pips: '',
      cost: 125,
    },
    {
      id: 6,
      shortcut: '6',
      icon: '🚀',
      iconBg: 'rgba(206, 147, 216, 0.18)',
      iconColor: '#ce93d8',
      title: nextLockedIdx !== -1 ? `Unlock ${nextWeaponName}` : 'Full Arsenal Resupply',
      desc:
        nextLockedIdx !== -1
          ? `Immediately unlocks & equips the ${nextWeaponName} with a full ammo reserve.`
          : 'All firearms unlocked! Grants a full ammo refill +20 bonus capacity.',
      statText: nextLockedIdx !== -1 ? `UNLOCK SLOT [${nextLockedIdx + 1}]` : 'ARSENAL COMPLETE',
      pips: renderLevelPips(slots.filter(Boolean).length, 4),
      cost: 250,
    },
  ];

  armoryGrid.innerHTML = cards
    .map((c) => {
      const canBuy = credits >= c.cost;
      return `
      <div class="shop-card ${canBuy ? 'affordable' : 'locked'}">
        <div>
          <div class="shop-card-top">
            <div style="display:flex; align-items:center; gap:10px;">
              <div class="shop-icon" style="background:${c.iconBg}; color:${c.iconColor}; border:1px solid ${c.iconColor}44;">
                ${c.icon}
              </div>
              <div>
                <div class="shop-title">${c.title}</div>
                ${c.pips}
              </div>
            </div>
            <span class="shop-shortcut">[${c.shortcut}]</span>
          </div>
          <p class="shop-desc" style="margin-top:8px;">${c.desc}</p>
        </div>
        <div style="display:flex; flex-direction:column; gap:8px;">
          <div class="shop-stat-row">
            <span>${c.statText}</span>
          </div>
          <button class="shop-buy-btn ${canBuy ? 'can-buy' : 'cant-buy'}" data-upgrade-id="${c.id}">
            <span>${canBuy ? 'PURCHASE' : 'NEED CREDITS'}</span>
            <span>$${c.cost}</span>
          </button>
        </div>
      </div>
    `;
    })
    .join('');

  armoryGrid.querySelectorAll('.shop-buy-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number((btn as HTMLElement).dataset.upgradeId);
      if (id > 0) {
        pendingBuyUpgrade = id;
        maybeSendInput();
      }
    });
  });
}

// Melee visual effect & cooldown tracker
let meleeSwingTime = 0;
let meleeSwingAngle = 0;
let meleeCooldownTimer = 0;

function triggerMeleeAttack() {
  input.melee = true;
  if (meleeCooldownTimer <= 0) {
    meleeSwingTime = 0.28;
    meleeCooldownTimer = MELEE_COOLDOWN;
    addScreenShake(3.2);
    const p = players[myId];
    if (p) {
      meleeSwingAngle = p.angle;
      const px = predictionInitialized ? predictedX : p.pos.x;
      const py = predictionInitialized ? predictedY : p.pos.y;
      const reach = MELEE_RANGE * (1 + (p.meleeLevel || 0) * 0.1);
      // Spawn plasma katana slash sparks along the 120° arc
      for (let i = 0; i < 10; i++) {
        const frac = i / 9 - 0.5;
        const a = meleeSwingAngle + frac * ((Math.PI * 2) / 3);
        const r = reach * (0.65 + Math.random() * 0.35);
        particles.push({
          x: px + Math.cos(a) * r,
          y: py + Math.sin(a) * r,
          vx: Math.cos(a) * (60 + Math.random() * 90),
          vy: Math.sin(a) * (60 + Math.random() * 90),
          radius: 2 + Math.random() * 2.5,
          color: Math.random() < 0.65 ? '#00e5ff' : '#ffffff',
          alpha: 0.95,
          life: 0.18 + Math.random() * 0.12,
          maxLife: 0.3,
          drag: 0.86,
        });
      }
    }
  }
}

// --- Interpolation ---
interface StateSnapshot {
  players: Record<string, Player>;
  zombies: Map<string, Zombie>;
  timestamp: number;
}
const stateBuffer: StateSnapshot[] = [];
const INTERP_DELAY = isMobile ? 100 : 60;
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
    timestamp: performance.now(),
  });
  if (stateBuffer.length > MAX_BUFFER_SIZE) {
    stateBuffer.shift();
  }
}

function getInterpolatedPlayers(): Record<string, Player> {
  if (stateBuffer.length < 2) return players;
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

    if (id === myId && predictionInitialized) {
      result[id] = {
        ...n,
        pos: { x: predictedX, y: predictedY },
      };
      continue;
    }

    let angleDiff = n.angle - o.angle;
    if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

    result[id] = {
      ...n,
      pos: {
        x: o.pos.x + (n.pos.x - o.pos.x) * t,
        y: o.pos.y + (n.pos.y - o.pos.y) * t,
      },
      angle: o.angle + angleDiff * t,
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
        y: o.pos.y + (n.pos.y - o.pos.y) * t,
      },
    });
  }
  return result;
}

function getExtrapolatedBullets(): Bullet[] {
  const now = performance.now();
  const result: Bullet[] = [];
  for (const [id, b] of bulletMap) {
    const created = bulletCreationTime.get(id) ?? now;
    const elapsed = (now - created) / 1000;
    result.push({
      ...b,
      pos: {
        x: b.pos.x + b.vel.x * elapsed,
        y: b.pos.y + b.vel.y * elapsed,
      },
    });
  }
  return result;
}

const input: ClientInput = {
  up: false,
  down: false,
  left: false,
  right: false,
  mouseX: 0,
  mouseY: 0,
  shooting: false,
  melee: false,
  selectWeapon: 0,
  dash: false,
  placeItem: 0,
  buyUpgrade: 0,
};

let pendingPlaceItem = 0;
let pendingBuyUpgrade = 0;

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
  placeBarrel: string;
  placeBarricade: string;
  placeMine: string;
  toggleShop: string;
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
  placeBarrel: 'KeyE',
  placeBarricade: 'KeyQ',
  placeMine: 'KeyF',
  toggleShop: 'KeyB',
};

const BINDING_LABELS: Record<keyof KeyBindings, string> = {
  moveUp: 'Move Up',
  moveDown: 'Move Down',
  moveLeft: 'Move Left',
  moveRight: 'Move Right',
  shoot: 'Shoot',
  melee: 'Melee Swing',
  dash: 'i-Frame Dash',
  weapon1: 'Slot 1 (Pistol)',
  weapon2: 'Slot 2 (Uzi)',
  weapon3: 'Slot 3 (Shotgun)',
  weapon4: 'Slot 4 (Rocket)',
  placeBarrel: 'Place Barrel',
  placeBarricade: 'Place Barricade',
  placeMine: 'Place Claymore',
  toggleShop: 'Toggle Armory',
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
  return code;
}

function codeToActions(code: string): (keyof KeyBindings)[] {
  const result: (keyof KeyBindings)[] = [];
  for (const [action, bound] of Object.entries(bindings)) {
    if (
      bound === code ||
      (code === 'ShiftRight' && bound === 'ShiftLeft') ||
      (code === 'ShiftLeft' && bound === 'ShiftRight')
    ) {
      result.push(action as keyof KeyBindings);
    }
  }
  return result;
}

const keysDown = new Set<string>();

let dashCharges = DASH_MAX_CHARGES;
let dashRechargeTimer = 0;
let dashPending = false;
let dashActiveTimer = 0;
let dashIframeTimer = 0;

const doubleTapTimes: Record<string, number> = {};
const DOUBLE_TAP_WINDOW = 400;

let ws: WebSocket | null = null;
let inputInterval: ReturnType<typeof setInterval> | null = null;

const pendingDeltas: DeltaState[] = [];
const MAX_DELTAS_PER_FRAME = isMobile ? 3 : 999;

function drainDeltaQueue() {
  const count = Math.min(pendingDeltas.length, MAX_DELTAS_PER_FRAME);
  for (let i = 0; i < count; i++) {
    applyDelta(pendingDeltas[i]);
    pushStateSnapshot();
    if (gameOver && currentScreen === 'playing') {
      const me = players[myId];
      finalWave = wave;
      finalScore = me ? me.score : 0;
      finalKills = me ? me.kills : 0;
      finalMaxCombo = me ? me.maxCombo : 0;
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
  placeableMap.clear();
  particles.length = 0;
  bloodStains.length = 0;
  floatingTexts.length = 0;
  shockwaves.length = 0;
  muzzleFlashes.length = 0;
  dashGhosts.length = 0;
  eventFeed.length = 0;
  wave = 1;
  waveKills = 0;
  waveTarget = 12;
  waveBreakTimer = 0;
  ammoAvailability.clear();
  gameOver = false;
  dropMap.clear();
  myId = '';
  stateBuffer.length = 0;
  lastSentInput = '';
  lastSendTime = 0;
  predictionInitialized = false;
  pendingDeltas.length = 0;
  toggleArmory(false);
}

function triggerWaveBanner(title: string, subtitle: string, color = '#ffb400') {
  waveBannerText = title;
  waveBannerSub = subtitle;
  waveBannerColor = color;
  waveBannerTimer = 3.2;
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
      if (init.gameOver) {
        gameOver = true;
        wave = init.wave ?? 1;
        finalWave = wave;
        finalScore = 0;
        setScreen('gameover');
      } else {
        triggerWaveBanner(`WAVE ${init.wave}`, 'SURVIVE THE HORDE', '#e53935');
        pushFeedEvent(`Deployed to Arena — Wave ${init.wave}`, '#64b5f6');
      }
    } else if (data.type === 'snapshot') {
      const snap = data as SnapshotState;
      players = snap.players;
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
      placeableMap.clear();
      if (snap.placeables) {
        for (const p of snap.placeables) {
          placeableMap.set(p.id, p);
        }
      }
      wave = snap.wave;
      waveKills = snap.waveKills ?? 0;
      waveTarget = snap.waveTarget ?? wave * 12;
      waveBreakTimer = snap.waveBreakTimer ?? 0;
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

      if (snap.gameOver && currentScreen === 'playing') {
        const me = players[myId];
        finalWave = wave;
        finalScore = me ? Math.floor(me.score) : 0;
        finalKills = me ? me.kills : 0;
        finalMaxCombo = me ? me.maxCombo : 0;
        toggleArmory(false);
        setScreen('gameover');
      } else if (!snap.gameOver && currentScreen === 'gameover') {
        setScreen('playing');
      }

      if (armoryOpen) renderArmoryDOM();
      pushStateSnapshot();
    } else if (data.type === 'delta') {
      pendingDeltas.push(data as DeltaState);
    }
  };

  ws.onclose = () => {
    if (inputInterval) { clearInterval(inputInterval); inputInterval = null; }
    if (currentScreen === 'playing') {
      toggleArmory(false);
      setScreen('menu');
    }
  };

  inputInterval = setInterval(maybeSendInput, 1000 / 30);
}

function applyDelta(delta: DeltaState) {
  let myShopStateChanged = false;
  // Players
  if (delta.players) {
    for (const id in delta.players) {
      const diff = delta.players[id];
      const existing = players[id];
      if (existing) {
        if (diff.damageLog !== undefined) existing.damageLog = diff.damageLog;
        if (diff.name !== undefined) existing.name = diff.name;
        if (diff.pos) {
          existing.pos = diff.pos;
          if (id === myId && predictionInitialized) {
            const errX = diff.pos.x - predictedX;
            const errY = diff.pos.y - predictedY;
            const errDist = Math.sqrt(errX * errX + errY * errY);
            if (errDist > 50) {
              predictedX = diff.pos.x;
              predictedY = diff.pos.y;
            } else if (errDist > 2) {
              predictedX += errX * 0.3;
              predictedY += errY * 0.3;
            }
          }
        }
        if (diff.angle !== undefined) existing.angle = diff.angle;
        if (diff.health !== undefined) {
          if (id === myId) {
            if (diff.health < existing.health) {
              const lost = Math.round(existing.health - diff.health);
              damageFlashAlpha = 0.55;
              addScreenShake(8);
              spawnFloatingText(predictedX, predictedY - 18, `-${lost} HP`, '#ff1744', 16);
            } else if (diff.health > existing.health) {
              const gained = Math.round(diff.health - existing.health);
              healFlashAlpha = 0.35;
              spawnFloatingText(predictedX, predictedY - 18, `+${gained} HP`, '#00e676', 15);
            }
            myShopStateChanged = true;
          }
          existing.health = diff.health;
        }
        if (diff.maxHealth !== undefined) {
          existing.maxHealth = diff.maxHealth;
          if (id === myId) myShopStateChanged = true;
        }
        if (diff.score !== undefined) existing.score = diff.score;
        if (diff.credits !== undefined) {
          if (id === myId) {
            const prevCredits = existing.credits ?? 0;
            const deltaCredits = Math.round(diff.credits - prevCredits);
            if (deltaCredits >= 25) {
              spawnFloatingText(predictedX + 12, predictedY - 28, `+$${deltaCredits}`, '#00e676', 14);
            }
            myShopStateChanged = true;
          }
          existing.credits = diff.credits;
        }
        if (diff.ammo !== undefined) {
          if (id === myId && diff.ammo > existing.ammo) {
            const gained = Math.round(diff.ammo - existing.ammo);
            spawnFloatingText(predictedX, predictedY - 26, `+${gained} AMMO`, '#ffd54f', 13);
          }
          existing.ammo = diff.ammo;
          if (id === myId) myShopStateChanged = true;
        }
        if (diff.maxAmmo !== undefined) {
          existing.maxAmmo = diff.maxAmmo;
          if (id === myId) myShopStateChanged = true;
        }
        if (diff.weapon !== undefined) existing.weapon = diff.weapon;
        if (diff.weaponSlots !== undefined) {
          if (id === myId) {
            const weaponNames = ['Pistol', 'Uzi', 'Shotgun', 'Rocket Launcher'];
            for (let s = 1; s < 4; s++) {
              if (diff.weaponSlots[s] && !existing.weaponSlots[s]) {
                spawnFloatingText(predictedX, predictedY - 34, `UNLOCKED ${weaponNames[s].toUpperCase()}!`, '#ce93d8', 16);
                pushFeedEvent(`Unlocked ${weaponNames[s]}!`, '#ce93d8');
              }
            }
            myShopStateChanged = true;
          }
          existing.weaponSlots = diff.weaponSlots;
        }
        if (diff.combo !== undefined) {
          if (id === myId && diff.combo > existing.combo) {
            if (diff.combo === 5) {
              pushFeedEvent('5x COMBO! +$35, +15 Ammo & +1 Barrel', '#ffd54f');
              spawnFloatingText(predictedX, predictedY - 38, '5x STREAK! +$35 & BARREL', '#ffd54f', 15);
            } else if (diff.combo === 10) {
              pushFeedEvent('10x OVERDRIVE! +$75, Rapid Fire + Claymore!', '#ff6d00');
              spawnFloatingText(predictedX, predictedY - 40, '10x OVERDRIVE! RAPID FIRE', '#ff6d00', 17);
            } else if (diff.combo % 15 === 0) {
              pushFeedEvent(`${diff.combo}x JUGGERNAUT! +$120, +2 Barricades & +Max Ammo`, '#e040fb');
              spawnFloatingText(predictedX, predictedY - 42, `${diff.combo}x STREAK! +$120`, '#e040fb', 17);
            } else if (diff.combo % 10 === 0) {
              pushFeedEvent(`${diff.combo}x STREAK! +$75, +1 Claymore & +15 HP`, '#ff5252');
            } else if (diff.combo % 5 === 0) {
              pushFeedEvent(`${diff.combo}x STREAK! +$35, +15 Ammo & +1 Barrel`, '#ffd54f');
            }
          }
          existing.combo = diff.combo;
        }
        if (diff.comboTimer !== undefined) existing.comboTimer = diff.comboTimer;
        if (diff.maxCombo !== undefined) existing.maxCombo = diff.maxCombo;
        if (diff.kills !== undefined) existing.kills = diff.kills;
        if (diff.tacticalItems !== undefined) {
          existing.tacticalItems = diff.tacticalItems;
          if (id === myId) myShopStateChanged = true;
        }
        if (diff.damageLevel !== undefined) {
          if (id === myId && diff.damageLevel > existing.damageLevel) {
            spawnFloatingText(predictedX, predictedY - 36, `FIREARM POWER LV.${diff.damageLevel}!`, '#ffab00', 16);
            pushFeedEvent(`Upgraded Firearm Power to Lv.${diff.damageLevel}`, '#ffab00');
            myShopStateChanged = true;
          }
          existing.damageLevel = diff.damageLevel;
        }
        if (diff.meleeLevel !== undefined) {
          if (id === myId && diff.meleeLevel > (existing.meleeLevel || 0)) {
            spawnFloatingText(predictedX, predictedY - 36, `KATANA EDGE LV.${diff.meleeLevel}!`, '#00e5ff', 16);
            pushFeedEvent(`Upgraded Plasma Katana to Lv.${diff.meleeLevel}`, '#00e5ff');
            myShopStateChanged = true;
          }
          existing.meleeLevel = diff.meleeLevel;
        }
      } else {
        players[id] = diff as Player;
      }
    }
  }
  if (myShopStateChanged && armoryOpen) {
    renderArmoryDOM();
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
        if (diff.health !== undefined) {
          const dmg = Math.round(existing.health - diff.health);
          if (dmg > 0) {
            const isCrit = dmg >= 40 && dmg < 130;
            spawnBlood(existing.pos.x, existing.pos.y, 6, false);
            spawnFloatingText(
              existing.pos.x,
              existing.pos.y - 12,
              isCrit ? `CRIT! -${dmg}` : `-${dmg}`,
              isCrit ? '#ffab00' : '#ffffff',
              isCrit ? 15 : 12
            );
          }
          existing.health = diff.health;
        }
      }
    }
  }
  if (delta.zombiesRemoved) {
    for (const id of delta.zombiesRemoved) {
      const z = zombieMap.get(id);
      if (z) {
        const dmg = Math.max(10, Math.round(z.health));
        spawnBlood(z.pos.x, z.pos.y, 14, true);
        spawnFloatingText(z.pos.x, z.pos.y - 14, `-${dmg}`, '#ff5252', 14);
      }
      zombieMap.delete(id);
    }
  }

  // Bullets
  if (delta.bulletsNew) {
    const now = performance.now();
    for (const b of delta.bulletsNew) {
      bulletMap.set(b.id, b);
      bulletCreationTime.set(b.id, now);

      // Muzzle flash FX
      const owner = players[b.ownerId];
      if (owner) {
        const angle = Math.atan2(b.vel.y, b.vel.x);
        const mx = (b.ownerId === myId && predictionInitialized ? predictedX : owner.pos.x) + Math.cos(angle) * 26;
        const my = (b.ownerId === myId && predictionInitialized ? predictedY : owner.pos.y) + Math.sin(angle) * 26;
        muzzleFlashes.push({
          x: mx,
          y: my,
          angle,
          size: b.isRocket ? 14 : b.isCrit ? 11 : 8,
          color: b.isRocket ? '#ff6d00' : b.isCrit ? '#ffab00' : '#fff59d',
          life: 0.06,
        });
        if (b.ownerId === myId) {
          addScreenShake(b.isRocket ? 5 : owner.weapon === 'shotgun' ? 3.5 : 1.2);
        }
      }
    }
  }
  if (delta.bulletsRemoved) {
    const now = performance.now();
    for (const id of delta.bulletsRemoved) {
      const b = bulletMap.get(id);
      if (b && b.isRocket) {
        const created = bulletCreationTime.get(id) ?? now;
        const elapsed = (now - created) / 1000;
        const rx = b.pos.x + b.vel.x * elapsed;
        const ry = b.pos.y + b.vel.y * elapsed;
        spawnExplosion(rx, ry, 85, '#ff5722');
      }
      bulletMap.delete(id);
      bulletCreationTime.delete(id);
    }
  }

  // Placeables
  if (delta.placeablesNew) {
    for (const p of delta.placeablesNew) {
      placeableMap.set(p.id, p);
    }
  }
  if (delta.placeablesUpdated) {
    for (const diff of delta.placeablesUpdated) {
      const existing = placeableMap.get(diff.id);
      if (existing && diff.health !== undefined) {
        existing.health = diff.health;
      }
    }
  }
  if (delta.placeablesRemoved) {
    for (const id of delta.placeablesRemoved) {
      const pl = placeableMap.get(id);
      if (pl) {
        if (pl.type === 'barrel') {
          spawnExplosion(pl.pos.x, pl.pos.y, 115, '#ff3d00');
          pushFeedEvent('Explosive Barrel Detonated! 💥', '#ff6d00');
        } else if (pl.type === 'mine') {
          spawnExplosion(pl.pos.x, pl.pos.y, 95, '#ffab00');
          pushFeedEvent('Claymore Triggered! 💥', '#ffd54f');
        }
      }
      placeableMap.delete(id);
    }
  }

  // Wave & Wave Break transitions
  if (delta.waveBreakTimer !== undefined) {
    if (waveBreakTimer <= 0 && delta.waveBreakTimer > 0) {
      triggerWaveBanner(`WAVE ${wave} CLEARED!`, '+$100 BONUS, +25 HP & TACTICAL RESUPPLY — PRESS [B] FOR ARMORY', '#00e676');
      pushFeedEvent(`Wave ${wave} Cleared! +$100 Credits & Resupply.`, '#00e676');
    }
    waveBreakTimer = delta.waveBreakTimer;
  }
  if (delta.wave !== undefined) {
    if (delta.wave > wave) {
      triggerWaveBanner(`WAVE ${delta.wave}`, 'HOSTILES INBOUND — SURVIVE THE HORDE', '#e53935');
      pushFeedEvent(`Wave ${delta.wave} Started!`, '#ff5252');
    }
    wave = delta.wave;
  }
  if (delta.waveKills !== undefined) waveKills = delta.waveKills;
  if (delta.waveTarget !== undefined) waveTarget = delta.waveTarget;
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
    dashIframeTimer = DASH_DURATION + 0.12;
    if (dashRechargeTimer <= 0) {
      dashRechargeTimer = DASH_RECHARGE_TIME;
    }
    const me = players[myId];
    if (me) {
      shockwaves.push({
        x: predictionInitialized ? predictedX : me.pos.x,
        y: predictionInitialized ? predictedY : me.pos.y,
        radius: 10,
        maxRadius: 48,
        color: '#29b6f6',
        life: 0.22,
        maxLife: 0.22,
      });
    }
  }
}

function handleActionDown(code: string) {
  // When Armory modal is open, number keys [1]-[6] purchase shop cards directly
  if (armoryOpen) {
    const shopShortcuts: Record<string, number> = {
      Digit1: 1, // Firearm Power
      Digit2: 5, // Plasma Katana
      Digit3: 2, // Nano-Armor
      Digit4: 3, // Expanded Magazine
      Digit5: 4, // Tactical Munitions Pack
      Digit6: 6, // Unlock Next Firearm
    };
    if (shopShortcuts[code]) {
      pendingBuyUpgrade = shopShortcuts[code];
      maybeSendInput();
      return;
    }
  }

  const actions = codeToActions(code);
  for (const action of actions) {
    switch (action) {
      case 'moveUp': input.up = true; break;
      case 'moveDown': input.down = true; break;
      case 'moveLeft': input.left = true; break;
      case 'moveRight': input.right = true; break;
      case 'shoot':
        if (!armoryOpen) input.shooting = true;
        break;
      case 'melee':
        if (!armoryOpen) triggerMeleeAttack();
        break;
      case 'dash':
        if (isMoving()) tryTriggerDash();
        break;
      case 'weapon1': input.selectWeapon = 1; break;
      case 'weapon2': input.selectWeapon = 2; break;
      case 'weapon3': input.selectWeapon = 3; break;
      case 'weapon4': input.selectWeapon = 4; break;
      case 'placeBarrel': pendingPlaceItem = 1; break;
      case 'placeBarricade': pendingPlaceItem = 2; break;
      case 'placeMine': pendingPlaceItem = 3; break;
      case 'toggleShop': toggleArmory(); break;
    }
  }

  // Right mouse button (Mouse2) also acts as a quick Melee Cleave trigger
  if (code === 'Mouse2' && !armoryOpen && currentScreen === 'playing') {
    triggerMeleeAttack();
  }

  if (!armoryOpen) {
    if (code === 'Digit5') pendingPlaceItem = 1;
    if (code === 'Digit6') pendingPlaceItem = 2;
    if (code === 'Digit7') pendingPlaceItem = 3;
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
  if (code === 'Mouse2') {
    input.melee = false;
  }
}

function checkDashOnMove() {
  if (keysDown.has(bindings.dash) && isMoving()) {
    tryTriggerDash();
  }
}

window.addEventListener('keydown', (e) => {
  if (document.activeElement?.tagName === 'INPUT') return;
  if (settingsListening) return;
  const code = e.code;
  const wasDown = keysDown.has(code);
  if (wasDown) return;
  keysDown.add(code);

  if (code === 'Escape' && armoryOpen) {
    toggleArmory(false);
    return;
  }

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
  if ((e.target as HTMLElement).closest('#armoryOverlay') || (e.target as HTMLElement).closest('#settingsOverlay')) {
    return;
  }
  if (currentScreen === 'playing' && e.button === 0) {
    // Check if clicking on-screen MELEE button on hotbar
    if (
      e.clientX >= hotbarMeleeBtnRect.x &&
      e.clientX <= hotbarMeleeBtnRect.x + hotbarMeleeBtnRect.w &&
      e.clientY >= hotbarMeleeBtnRect.y &&
      e.clientY <= hotbarMeleeBtnRect.y + hotbarMeleeBtnRect.h
    ) {
      triggerMeleeAttack();
      maybeSendInput();
      setTimeout(() => { input.melee = false; }, 80);
      return;
    }
    // Check if clicking hotbar Armory button
    if (
      e.clientX >= hotbarArmoryBtnRect.x &&
      e.clientX <= hotbarArmoryBtnRect.x + hotbarArmoryBtnRect.w &&
      e.clientY >= hotbarArmoryBtnRect.y &&
      e.clientY <= hotbarArmoryBtnRect.y + hotbarArmoryBtnRect.h
    ) {
      toggleArmory();
      return;
    }
    // Check if clicking weapon slots on hotbar
    for (const wRect of hotbarWeaponRects) {
      if (
        e.clientX >= wRect.x &&
        e.clientX <= wRect.x + wRect.w &&
        e.clientY >= wRect.y &&
        e.clientY <= wRect.y + wRect.h
      ) {
        input.selectWeapon = wRect.slot;
        maybeSendInput();
        setTimeout(() => { input.selectWeapon = 0; }, 80);
        return;
      }
    }
    // Check if clicking tactical item slots on hotbar
    for (const tRect of hotbarTacticalRects) {
      if (
        e.clientX >= tRect.x &&
        e.clientX <= tRect.x + tRect.w &&
        e.clientY >= tRect.y &&
        e.clientY <= tRect.y + tRect.h
      ) {
        pendingPlaceItem = tRect.item;
        maybeSendInput();
        return;
      }
    }
  }
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
let moveStickId: number | null = null;
let moveStickOrigin = { x: 0, y: 0 };
let aimTouchId: number | null = null;
let touchMeleeBtn = { x: 0, y: 0, r: 30 };
let touchWeaponBtn = { x: 0, y: 0, r: 30 };
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

      const wdx = tx - touchWeaponBtn.x;
      const wdy = ty - touchWeaponBtn.y;
      if (wdx * wdx + wdy * wdy < (touchWeaponBtn.r + 10) ** 2) {
        const p = players[myId];
        if (p) {
          const currentSlot = ['pistol', 'uzi', 'shotgun', 'rocketLauncher'].indexOf(p.weapon);
          for (let s = 1; s <= 4; s++) {
            const next = (currentSlot + s) % 4;
            if (p.weaponSlots[next]) {
              input.selectWeapon = next + 1;
              setTimeout(() => { input.selectWeapon = 0; }, 100);
              break;
            }
          }
        }
        continue;
      }
    }

    if (tx < canvas.width / 2 && moveStickId === null) {
      moveStickId = t.identifier;
      moveStickOrigin = { x: tx, y: ty };
      moveStickPos = { x: tx, y: ty };
      moveStickActive = true;
    } else if (tx >= canvas.width / 2 && aimTouchId === null) {
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
  input.melee = false;
}

if (isMobile) {
  canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
  canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
  canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', handleTouchEnd, { passive: false });
}

let lastSentInput = '';
let lastSendTime = 0;
const HEARTBEAT_INTERVAL = 500;

function maybeSendInput() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (currentScreen !== 'playing') return;

  input.mouseX = Math.round(screenMouseX + camX);
  input.mouseY = Math.round(screenMouseY + camY);

  if (dashPending) {
    input.dash = true;
    dashPending = false;
  }
  if (pendingPlaceItem > 0) {
    input.placeItem = pendingPlaceItem;
    pendingPlaceItem = 0;
  }
  if (pendingBuyUpgrade > 0) {
    input.buyUpgrade = pendingBuyUpgrade;
    pendingBuyUpgrade = 0;
  }

  const snapshot = JSON.stringify(input);
  const now = performance.now();

  if (snapshot !== lastSentInput || now - lastSendTime > HEARTBEAT_INTERVAL) {
    ws.send(JSON.stringify({ type: 'input', input }));
    lastSentInput = snapshot;
    lastSendTime = now;
  }

  input.dash = false;
  input.placeItem = 0;
  input.buyUpgrade = 0;
}

function buildRenderState(): GameState | null {
  if (!myId || (Object.keys(players).length === 0 && zombieMap.size === 0)) return null;

  const interpPlayers = getInterpolatedPlayers();
  const interpZombies = getInterpolatedZombies();
  const extrapBullets = getExtrapolatedBullets();

  return {
    players: interpPlayers,
    zombies: interpZombies,
    bullets: extrapBullets,
    placeables: Array.from(placeableMap.values()),
    wave,
    waveKills,
    waveTarget,
    waveBreakTimer,
    walls: staticWalls,
    ammoPickups: staticAmmoSpawns.map((s, i) => ({
      id: `ammo_${i}`,
      pos: { x: s.x, y: s.y },
      amount: s.amount,
      respawnAt: ammoAvailability.get(`ammo_${i}`) ? 0 : 1,
    })),
    mapWidth: staticMapWidth,
    mapHeight: staticMapHeight,
    gameOver,
    drops: Array.from(dropMap.values()),
  };
}

let lastFrameTime = performance.now();

function updateCamera(dt: number) {
  if (!players[myId]) return;
  const px = predictionInitialized ? predictedX : players[myId].pos.x;
  const py = predictionInitialized ? predictedY : players[myId].pos.y;
  const targetX = px - canvas.width / 2;
  const targetY = py - canvas.height / 2;

  let shakeX = 0;
  let shakeY = 0;
  if (screenShakeAmount > 0.1) {
    shakeX = (Math.random() - 0.5) * screenShakeAmount * 2;
    shakeY = (Math.random() - 0.5) * screenShakeAmount * 2;
    screenShakeAmount = Math.max(0, screenShakeAmount - dt * 35);
  } else {
    screenShakeAmount = 0;
  }

  camX = Math.max(0, Math.min(staticMapWidth - canvas.width, targetX)) + shakeX;
  camY = Math.max(0, Math.min(staticMapHeight - canvas.height, targetY)) + shakeY;
}

function drawGrid() {
  const gridSize = 60;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
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

  function drawTunnelOpening(
    x: number,
    y: number,
    w: number,
    h: number,
    arrowDir: 'up' | 'down' | 'left' | 'right'
  ) {
    const sx = x - camX;
    const sy = y - camY;
    if (sx + w < -20 || sx > canvas.width + 20 || sy + h < -20 || sy > canvas.height + 20) return;

    ctx.fillStyle = `rgba(0, 200, 255, ${pulse * 0.15})`;
    ctx.fillRect(sx, sy, w, h);

    ctx.strokeStyle = `rgba(0, 200, 255, ${pulse * 0.6})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.strokeRect(sx + 1, sy + 1, w - 2, h - 2);
    ctx.setLineDash([]);

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

  drawTunnelOpening(hMid - tw / 2, 0, tw, 20, 'up');
  drawTunnelOpening(hMid - tw / 2, MAP_HEIGHT - 20, tw, 20, 'down');
  drawTunnelOpening(0, vMid - tw / 2, 20, tw, 'left');
  drawTunnelOpening(MAP_WIDTH - 20, vMid - tw / 2, 20, tw, 'right');
}

function drawBloodStains() {
  const now = performance.now();
  for (let i = bloodStains.length - 1; i >= 0; i--) {
    const b = bloodStains[i];
    const age = (now - b.createdAt) / 1000;
    if (age > 14) {
      bloodStains.splice(i, 1);
      continue;
    }
    const sx = b.x - camX;
    const sy = b.y - camY;
    if (sx < -30 || sx > canvas.width + 30 || sy < -30 || sy > canvas.height + 30) continue;

    const fade = age > 10 ? 1 - (age - 10) / 4 : 1;
    ctx.fillStyle = `rgba(115, 10, 10, ${b.alpha * fade})`;
    ctx.beginPath();
    ctx.arc(sx, sy, b.radius, 0, Math.PI * 2);
    ctx.fill();
    for (const blob of b.blobs) {
      ctx.beginPath();
      ctx.arc(sx + blob.dx, sy + blob.dy, blob.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawWalls() {
  for (const w of staticWalls) {
    const sx = w.x - camX;
    const sy = w.y - camY;
    if (sx + w.w < 0 || sx > canvas.width || sy + w.h < 0 || sy > canvas.height) continue;

    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(sx + 4, sy + 6, w.w, w.h);

    ctx.fillStyle = '#32353c';
    ctx.fillRect(sx, sy, w.w, w.h);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(sx, sy, w.w, 2);
    ctx.fillRect(sx, sy, 2, w.h);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fillRect(sx, sy + w.h - 2, w.w, 2);
    ctx.fillRect(sx + w.w - 2, sy, 2, w.h);
  }
}

function drawPlaceables(state: GameState) {
  const now = performance.now();
  for (const pl of state.placeables) {
    const sx = pl.pos.x - camX;
    const sy = pl.pos.y - camY;
    if (sx < -60 || sx > canvas.width + 60 || sy < -60 || sy > canvas.height + 60) continue;

    ctx.save();
    ctx.translate(sx, sy);

    if (pl.type === 'barrel') {
      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.ellipse(0, 12, 16, 8, 0, 0, Math.PI * 2);
      ctx.fill();

      // Red explosive barrel
      ctx.fillStyle = '#d32f2f';
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffeb3b';
      ctx.stroke();

      // Inner hazard ring & icon
      ctx.fillStyle = '#b71c1c';
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffeb3b';
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('TNT', 0, 1);
    } else if (pl.type === 'barricade') {
      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(-19, -15, 42, 34);

      // Reinforced steel/sandbag barricade
      ctx.fillStyle = '#5d4037';
      ctx.fillRect(-20, -16, 40, 32);
      ctx.strokeStyle = '#8d6e63';
      ctx.lineWidth = 2;
      ctx.strokeRect(-20, -16, 40, 32);

      // Steel cross-bracing
      ctx.fillStyle = '#78909c';
      ctx.fillRect(-18, -5, 36, 10);
      ctx.fillStyle = '#cfd8dc';
      ctx.fillRect(-14, -2, 4, 4);
      ctx.fillRect(10, -2, 4, 4);

      // Health bar if damaged
      if (pl.health < pl.maxHealth) {
        const bw = 36;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(-bw / 2, -24, bw, 4);
        ctx.fillStyle = '#ffb400';
        ctx.fillRect(-bw / 2, -24, bw * Math.max(0, pl.health / pl.maxHealth), 4);
      }
    } else if (pl.type === 'mine') {
      // Faint sensor trigger radius
      const blink = Math.sin(now / 150) > 0;
      ctx.strokeStyle = blink ? 'rgba(255, 82, 82, 0.32)' : 'rgba(255, 82, 82, 0.14)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, 38, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Mine body
      ctx.fillStyle = '#263238';
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#90a4ae';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Blinking LED
      ctx.fillStyle = blink ? '#ff1744' : '#880e4f';
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
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

    const glowColors: Record<string, string> = {
      ammo: 'rgba(255,200,0,0.25)',
      health: 'rgba(76,175,80,0.3)',
      weapon: 'rgba(156,39,176,0.3)',
      tactical: 'rgba(255,109,0,0.3)',
    };
    const glowR = 22 + 4 * Math.sin(now / 250);
    ctx.beginPath();
    ctx.arc(sx, dy, glowR, 0, Math.PI * 2);
    ctx.fillStyle = glowColors[d.type] || 'rgba(255,255,255,0.1)';
    ctx.fill();

    const bgColors: Record<string, string> = {
      ammo: `rgba(50,40,0,${pulse})`,
      health: `rgba(0,40,10,${pulse})`,
      weapon: `rgba(40,0,50,${pulse})`,
      tactical: `rgba(55,20,0,${pulse})`,
    };
    ctx.beginPath();
    ctx.arc(sx, dy, 14, 0, Math.PI * 2);
    ctx.fillStyle = bgColors[d.type] || 'rgba(0,0,0,0.5)';
    ctx.fill();

    const ringColors: Record<string, string> = {
      ammo: '#ffb400',
      health: '#4caf50',
      weapon: '#ce93d8',
      tactical: '#ff6d00',
    };
    ctx.strokeStyle = ringColors[d.type] || '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (d.type === 'ammo') {
      ctx.fillStyle = '#ffd54f';
      ctx.fillRect(sx - 6, dy - 3, 4, 10);
      ctx.fillRect(sx - 1, dy - 3, 4, 10);
      ctx.fillRect(sx + 4, dy - 3, 4, 10);
      ctx.fillStyle = '#ff8f00';
      ctx.fillRect(sx - 6, dy - 5, 4, 3);
      ctx.fillRect(sx - 1, dy - 5, 4, 3);
      ctx.fillRect(sx + 4, dy - 5, 4, 3);
    } else if (d.type === 'health') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(sx - 2, dy - 8, 5, 16);
      ctx.fillRect(sx - 8, dy - 2, 16, 5);
      ctx.fillStyle = '#e53935';
      ctx.fillRect(sx - 1, dy - 7, 3, 14);
      ctx.fillRect(sx - 7, dy - 1, 14, 3);
    } else if (d.type === 'weapon') {
      ctx.fillStyle = '#ce93d8';
      ctx.fillRect(sx - 2, dy - 8, 5, 10);
      ctx.fillRect(sx - 6, dy - 2, 13, 5);
      ctx.fillRect(sx - 4, dy + 3, 4, 6);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 8px sans-serif';
      ctx.fillText('\u2605', sx + 5, dy - 5);
    } else if (d.type === 'tactical') {
      ctx.fillStyle = '#ffab00';
      ctx.font = 'bold 11px monospace';
      ctx.fillText('TAC', sx, dy + 1);
    }

    const labelColors: Record<string, string> = {
      ammo: '#ffd54f',
      health: '#81c784',
      weapon: '#ce93d8',
      tactical: '#ffab00',
    };
    const labelText: Record<string, string> = {
      ammo: 'AMMO',
      health: 'HEALTH',
      weapon: 'WEAPON',
      tactical: 'GEAR',
    };
    ctx.fillStyle = labelColors[d.type] || '#fff';
    ctx.font = 'bold 8px monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(labelText[d.type] || '', sx, dy + 16);
  }
}

function drawTickHealthBar(sx: number, sy: number, health: number, maxHealth: number, barW: number, weaponDmg: number) {
  const barH = 4;
  const y = sy;

  ctx.fillStyle = '#222';
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
  const dmgMult = myPlayer ? 1 + (myPlayer.damageLevel || 0) * 0.2 : 1;
  const weaponDmg = (myPlayer ? (WEAPON_STATS[myPlayer.weapon]?.damage ?? 25) : 25) * dmgMult;

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

    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath();
    ctx.ellipse(0, size + 4, size * 1.5, size * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(angle);

    if (z.type === 'vampire') {
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.moveTo(-size, 0);
      ctx.lineTo(-size - 10, -size - 8);
      ctx.lineTo(-size - 10, size + 8);
      ctx.fill();
    }

    ctx.fillStyle = shoulderColor;
    ctx.fillRect(-size * 0.8, -size * 1.2, size * 1.6, size * 2.4);

    if (z.type === 'brute') {
      ctx.fillStyle = '#212121';
      ctx.fillRect(-size * 0.9, -size * 1.3, size * 1.8, size * 2.6);
    }

    ctx.fillStyle = bodyColor;
    if (z.type === 'crawler') {
      ctx.fillRect(0, -size * 1.5, size * 1.2, 4);
      ctx.fillRect(0, size * 1.5 - 4, size * 1.2, 4);
    } else {
      ctx.fillRect(size * 0.2, -size * 1.4, size, size * 0.6);
      ctx.fillRect(size * 0.2, size * 0.8, size, size * 0.6);
    }

    ctx.fillStyle = bodyColor;
    ctx.fillRect(-size, -size, size * 2, size * 2);

    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-size + 1, -size + 1, size * 2 - 2, size * 2 - 2);

    ctx.fillStyle = eyeColor;
    ctx.fillRect(size * 0.4, -size * 0.6, size * 0.3, size * 0.3);
    ctx.fillRect(size * 0.4, size * 0.3, size * 0.3, size * 0.3);

    if (z.type !== 'vampire' && z.type !== 'brute') {
      ctx.fillStyle = '#000';
      ctx.fillRect(size * 0.5, -size * 0.5, size * 0.1, size * 0.1);
      ctx.fillRect(size * 0.5, size * 0.4, size * 0.1, size * 0.1);
    }

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

    if (z.type === 'brute') {
      ctx.fillStyle = '#8e0000';
      ctx.fillRect(size * 0.6, -size * 0.3, size * 0.4, size * 0.6);
    }

    ctx.restore();

    const barW = size * 2 + 10;
    drawTickHealthBar(sx - barW / 2, sy - size - 16, z.health, z.maxHealth, barW, weaponDmg);
  }
}

function drawBullets(state: GameState) {
  for (const b of state.bullets) {
    const sx = b.pos.x - camX;
    const sy = b.pos.y - camY;
    if (sx < -20 || sx > canvas.width + 20 || sy < -20 || sy > canvas.height + 20) continue;

    const angle = Math.atan2(b.vel.y, b.vel.x);
    if (b.isRocket) {
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(angle);
      ctx.fillStyle = '#ff3d00';
      ctx.beginPath();
      ctx.arc(-8, 0, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#eceff1';
      ctx.fillRect(-5, -3, 12, 6);
      ctx.fillStyle = '#d32f2f';
      ctx.beginPath();
      ctx.arc(7, 0, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      // Bullet tracer line + head
      const color = b.isCrit ? '#ff6d00' : '#ffeb3b';
      ctx.strokeStyle = b.isCrit ? 'rgba(255, 109, 0, 0.7)' : 'rgba(255, 235, 59, 0.5)';
      ctx.lineWidth = b.isCrit ? 3.5 : 2.5;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - Math.cos(angle) * 14, sy - Math.sin(angle) * 14);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, b.isCrit ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawVisualEffects(dt: number) {
  // Muzzle flashes
  for (let i = muzzleFlashes.length - 1; i >= 0; i--) {
    const mf = muzzleFlashes[i];
    mf.life -= dt;
    if (mf.life <= 0) {
      muzzleFlashes.splice(i, 1);
      continue;
    }
    const sx = mf.x - camX;
    const sy = mf.y - camY;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(mf.angle);
    ctx.fillStyle = mf.color;
    ctx.beginPath();
    ctx.ellipse(mf.size * 0.5, 0, mf.size, mf.size * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Shockwaves
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const sw = shockwaves[i];
    sw.life -= dt;
    if (sw.life <= 0) {
      shockwaves.splice(i, 1);
      continue;
    }
    const progress = 1 - sw.life / sw.maxLife;
    const r = sw.radius + (sw.maxRadius - sw.radius) * progress;
    const alpha = 1 - progress;
    ctx.save();
    ctx.strokeStyle = sw.color;
    ctx.globalAlpha = alpha * 0.85;
    ctx.lineWidth = 4 * (1 - progress * 0.6);
    ctx.beginPath();
    ctx.arc(sw.x - camX, sw.y - camY, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= p.drag;
    p.vy *= p.drag;

    const sx = p.x - camX;
    const sy = p.y - camY;
    if (sx < -20 || sx > canvas.width + 20 || sy < -20 || sy > canvas.height + 20) continue;

    ctx.save();
    ctx.globalAlpha = Math.max(0, (p.life / p.maxLife) * p.alpha);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(sx, sy, p.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Floating damage & reward numbers
  for (let i = floatingTexts.length - 1; i >= 0; i--) {
    const ft = floatingTexts[i];
    ft.life -= dt;
    if (ft.life <= 0) {
      floatingTexts.splice(i, 1);
      continue;
    }
    ft.y += ft.vy * dt;
    ft.vy *= 0.94;

    const sx = ft.x - camX;
    const sy = ft.y - camY;
    const alpha = Math.min(1, (ft.life / ft.maxLife) * 1.4);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `bold ${ft.size}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillText(ft.text, sx + 1, sy + 1);
    ctx.fillStyle = ft.color;
    ctx.fillText(ft.text, sx, sy);
    ctx.restore();
  }
}

function drawMeleeSwing(dt: number, state: GameState) {
  if (meleeSwingTime <= 0) return;
  meleeSwingTime -= dt;
  const p = state.players[myId];
  if (!p) return;

  const sx = p.pos.x - camX;
  const sy = p.pos.y - camY;

  const progress = Math.max(0, Math.min(1, 1 - meleeSwingTime / 0.28));
  const alpha = Math.max(0, 1 - progress * 0.85);
  const meleeLv = p.meleeLevel || 0;
  const maxReach = MELEE_RANGE * (1 + meleeLv * 0.1);
  const arcRadius = maxReach * (0.55 + progress * 0.45);
  const halfArc = Math.PI / 3; // 120° total cleave arc
  const startAngle = meleeSwingAngle - halfArc;
  const endAngle = meleeSwingAngle + halfArc;
  const currentBladeAngle = startAngle + (endAngle - startAngle) * Math.min(1, progress * 1.25);

  ctx.save();
  ctx.translate(sx, sy);

  // Cleave energy cone fill
  ctx.fillStyle = `rgba(0, 229, 255, ${alpha * 0.18})`;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, arcRadius, startAngle, currentBladeAngle);
  ctx.closePath();
  ctx.fill();

  // Outer cyan plasma wave
  ctx.strokeStyle = `rgba(0, 229, 255, ${alpha * 0.95})`;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(0, 0, arcRadius, startAngle, currentBladeAngle);
  ctx.stroke();

  // Inner white-hot core arc
  ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(0, 0, arcRadius - 4, startAngle + 0.08, currentBladeAngle);
  ctx.stroke();

  // Physical sweeping Plasma Katana blade
  ctx.save();
  ctx.rotate(currentBladeAngle);
  // Hilt
  ctx.fillStyle = '#263238';
  ctx.fillRect(10, -2.5, 10, 5);
  ctx.fillStyle = '#ffb400';
  ctx.fillRect(18, -5, 3, 10);
  // Glowing Katana Blade
  ctx.fillStyle = '#00e5ff';
  ctx.beginPath();
  ctx.moveTo(21, -3);
  ctx.lineTo(maxReach + 4, -1);
  ctx.lineTo(maxReach + 10, 0);
  ctx.lineTo(maxReach + 4, 2.5);
  ctx.lineTo(21, 2.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(21, -1.5, maxReach - 16, 2);
  ctx.restore();

  ctx.restore();
}

function drawPlayers(dt: number, state: GameState) {
  // Update & draw local dash afterimage ghosts
  const me = state.players[myId];
  if (me && dashActiveTimer > 0) {
    dashGhosts.push({ x: me.pos.x, y: me.pos.y, angle: me.angle, alpha: 0.45 });
  }
  for (let i = dashGhosts.length - 1; i >= 0; i--) {
    const g = dashGhosts[i];
    g.alpha -= dt * 2.2;
    if (g.alpha <= 0) {
      dashGhosts.splice(i, 1);
      continue;
    }
    ctx.save();
    ctx.translate(g.x - camX, g.y - camY);
    ctx.rotate(g.angle);
    ctx.globalAlpha = g.alpha;
    ctx.fillStyle = '#29b6f6';
    ctx.fillRect(-12, -18, 24, 36);
    ctx.restore();
  }

  for (const id in state.players) {
    const p = state.players[id];
    const sx = p.pos.x - camX;
    const sy = p.pos.y - camY;
    if (sx < -50 || sx > canvas.width + 50 || sy < -50 || sy > canvas.height + 50) continue;

    if (p.health <= 0) {
      ctx.save();
      ctx.translate(sx, sy);
      ctx.globalAlpha = 0.5 + 0.2 * Math.sin(performance.now() / 400);
      ctx.fillStyle = '#ff5252';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('\u2620', 0, 0);
      ctx.globalAlpha = 1;
      const displayName = p.name || p.id.slice(0, 6);
      ctx.fillStyle = '#ff8888';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(displayName, 0, -24);
      ctx.fillStyle = '#aaa';
      ctx.font = '10px sans-serif';
      ctx.fillText('Stand near to revive', 0, 22);
      ctx.restore();
      continue;
    }

    const isMe = id === myId;
    const hasOverdrive = (p.combo || 0) >= 10;

    ctx.save();
    ctx.translate(sx, sy);

    // Overdrive aura or Dash i-frame shield
    if (isMe && dashIframeTimer > 0) {
      ctx.strokeStyle = 'rgba(41, 182, 246, 0.75)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, 24, 0, Math.PI * 2);
      ctx.stroke();
    } else if (hasOverdrive) {
      ctx.strokeStyle = 'rgba(255, 109, 0, 0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 23 + Math.sin(performance.now() / 120) * 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath();
    ctx.ellipse(0, 20, 16, 8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(p.angle);

    const suitColor = isMe ? '#1976D2' : '#D32F2F';
    const skinColor = '#FFC107';
    const gunColor = '#424242';

    // Sheathed Plasma Katana on back/hip (when not actively mid-swing)
    if (!isMe || meleeSwingTime <= 0) {
      ctx.save();
      ctx.translate(-8, -14);
      ctx.rotate(-0.35);
      // Scabbard
      ctx.fillStyle = '#1c262b';
      ctx.fillRect(-14, -2, 24, 4);
      // Cyan plasma trim on scabbard
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(-12, -0.5, 18, 1.2);
      // Hilt sticking out
      ctx.fillStyle = '#ffb400';
      ctx.fillRect(9, -3.5, 2.5, 7);
      ctx.fillStyle = '#37474f';
      ctx.fillRect(11, -2, 6, 4);
      ctx.restore();
    }

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

    const displayName = p.name || p.id.slice(0, 6);
    ctx.fillStyle = isMe ? '#64B5F6' : '#eee';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(displayName, sx, sy - 36);

    const maxHp = p.maxHealth || 100;
    const barW = 36;
    ctx.fillStyle = '#222';
    ctx.fillRect(sx - barW / 2 - 1, sy - 32, barW + 2, 6);
    ctx.fillStyle = '#c62828';
    ctx.fillRect(sx - barW / 2, sy - 31, barW, 4);
    ctx.fillStyle = p.health / maxHp > 0.3 ? '#4CAF50' : '#FF9800';
    ctx.fillRect(sx - barW / 2, sy - 31, barW * Math.max(0, Math.min(1, p.health / maxHp)), 4);
  }
}

function drawMinimap(state: GameState) {
  const mmW = 185;
  const mmH = mmW * (staticMapHeight / staticMapWidth);
  const mmX = canvas.width - mmW - 15;
  const mmY = canvas.height - mmH - 15;
  const scaleX = mmW / staticMapWidth;
  const scaleY = mmH / staticMapHeight;

  ctx.fillStyle = 'rgba(10, 12, 18, 0.8)';
  ctx.fillRect(mmX - 3, mmY - 3, mmW + 6, mmH + 6);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(mmX - 3, mmY - 3, mmW + 6, mmH + 6);

  ctx.fillStyle = '#262930';
  ctx.fillRect(mmX, mmY, mmW, mmH);

  ctx.fillStyle = '#555';
  for (const w of staticWalls) {
    ctx.fillRect(mmX + w.x * scaleX, mmY + w.y * scaleY, Math.max(1, w.w * scaleX), Math.max(1, w.h * scaleY));
  }

  for (let i = 0; i < staticAmmoSpawns.length; i++) {
    if (!ammoAvailability.get(`ammo_${i}`)) continue;
    const pickup = staticAmmoSpawns[i];
    ctx.fillStyle = '#ffb400';
    ctx.fillRect(mmX + pickup.x * scaleX - 2, mmY + pickup.y * scaleY - 2, 4, 4);
  }

  for (const pl of state.placeables) {
    ctx.fillStyle = pl.type === 'barrel' ? '#ff3d00' : pl.type === 'barricade' ? '#8d6e63' : '#ff1744';
    ctx.fillRect(mmX + pl.pos.x * scaleX - 1.5, mmY + pl.pos.y * scaleY - 1.5, 3, 3);
  }

  for (const d of state.drops) {
    ctx.fillStyle = d.type === 'ammo' ? '#ffb400' : d.type === 'health' ? '#4CAF50' : '#9C27B0';
    ctx.fillRect(mmX + d.pos.x * scaleX - 1, mmY + d.pos.y * scaleY - 1, 3, 3);
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(mmX + camX * scaleX, mmY + camY * scaleY, canvas.width * scaleX, canvas.height * scaleY);

  for (const z of state.zombies) {
    ctx.fillStyle = z.type === 'devil' ? '#e53935' : z.type === 'brute' ? '#ff6d00' : '#4CAF50';
    ctx.fillRect(mmX + z.pos.x * scaleX - 1, mmY + z.pos.y * scaleY - 1, 2.5, 2.5);
  }

  for (const id in state.players) {
    const p = state.players[id];
    ctx.fillStyle = id === myId ? '#29b6f6' : '#F44336';
    ctx.fillRect(mmX + p.pos.x * scaleX - 2.5, mmY + p.pos.y * scaleY - 2.5, 5, 5);
  }
}

function drawHUD(state: GameState) {
  const p = state.players[myId];
  if (!p) return;

  // Top-left Tactical Operative Card
  const cardX = 12;
  const cardY = 12;
  const cardW = 300;
  const cardH = 128;

  ctx.fillStyle = 'rgba(12, 14, 22, 0.85)';
  ctx.fillRect(cardX, cardY, cardW, cardH);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = 1;
  ctx.strokeRect(cardX, cardY, cardW, cardH);

  // Left accent bar
  ctx.fillStyle = '#e53935';
  ctx.fillRect(cardX, cardY, 4, cardH);

  // Row 1: SCORE (High Score Ranking) & CREDITS (Spendable $)
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffb400';
  ctx.font = 'bold 14px monospace';
  ctx.fillText(`SCORE: ${Math.floor(p.score)}`, cardX + 14, cardY + 9);

  // Credits pill on top-right of card
  const creditsText = `$${Math.floor(p.credits ?? 0)}`;
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#00e676';
  ctx.fillText(`CREDITS: ${creditsText}`, cardX + cardW - 12, cardY + 9);

  // Row 2: Kills & Upgrade Levels
  ctx.textAlign = 'left';
  ctx.fillStyle = '#90a4ae';
  ctx.font = 'bold 10px monospace';
  const dmgBonus = (p.damageLevel || 0) * 20;
  const katanaLv = p.meleeLevel || 0;
  ctx.fillText(
    `KILLS: ${p.kills || 0}  •  GUN +${dmgBonus}%  •  KATANA LV.${katanaLv}`,
    cardX + 14,
    cardY + 28
  );

  // Health Bar
  const maxHp = p.maxHealth || 100;
  const hpPct = Math.max(0, Math.min(1, p.health / maxHp));
  const barX = cardX + 14;
  const barW = cardW - 26;

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(barX, cardY + 46, barW, 16);
  ctx.fillStyle = hpPct > 0.35 ? '#43a047' : '#e53935';
  ctx.fillRect(barX, cardY + 46, barW * hpPct, 16);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.strokeRect(barX, cardY + 46, barW, 16);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`HP ${Math.ceil(p.health)}/${maxHp}`, barX + 6, cardY + 48);

  // Ammo Bar
  const isPistol = p.weapon === 'pistol';
  const maxAmmo = p.maxAmmo || 40;
  const ammoPct = isPistol ? 1 : Math.max(0, Math.min(1, p.ammo / maxAmmo));

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(barX, cardY + 68, barW, 14);
  ctx.fillStyle = isPistol ? '#546e7a' : '#ffb300';
  ctx.fillRect(barX, cardY + 68, barW * ammoPct, 14);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.strokeRect(barX, cardY + 68, barW, 14);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 10px monospace';
  ctx.fillText(isPistol ? 'AMMO: \u221E (PISTOL)' : `AMMO: ${Math.floor(p.ammo)}/${maxAmmo}`, barX + 6, cardY + 70);

  // Dash Stamina Pips (3 charges)
  ctx.fillStyle = '#90a4ae';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('DASH', barX, cardY + 92);

  const pipW = 46;
  const pipH = 10;
  const pipGap = 5;
  const pipStartX = barX + 40;
  const pipY = cardY + 92;
  for (let i = 0; i < DASH_MAX_CHARGES; i++) {
    const px = pipStartX + i * (pipW + pipGap);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(px, pipY, pipW, pipH);
    if (i < dashCharges) {
      ctx.fillStyle = '#29b6f6';
      ctx.fillRect(px, pipY, pipW, pipH);
    } else if (i === dashCharges && dashRechargeTimer > 0) {
      const fill = 1 - dashRechargeTimer / DASH_RECHARGE_TIME;
      ctx.fillStyle = '#0277bd';
      ctx.fillRect(px, pipY, pipW * fill, pipH);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px, pipY, pipW, pipH);
  }

  ctx.fillStyle = dashIframeTimer > 0 ? '#29b6f6' : '#78909c';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(dashIframeTimer > 0 ? 'i-FRAME!' : '[SHIFT]', cardX + cardW - 12, cardY + 92);
}

function drawWaveHeader(state: GameState) {
  const w = 340;
  const h = 54;
  const x = (canvas.width - w) / 2;
  const y = 12;

  ctx.fillStyle = 'rgba(12, 14, 22, 0.82)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = state.waveBreakTimer > 0 ? 'rgba(0, 230, 118, 0.5)' : 'rgba(229, 57, 53, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, w, h);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  if (state.waveBreakTimer > 0) {
    ctx.fillStyle = '#00e676';
    ctx.font = 'bold 14px monospace';
    ctx.fillText(`WAVE ${state.wave} COMPLETE — NEXT IN ${state.waveBreakTimer.toFixed(1)}s`, x + w / 2, y + 8);

    const pct = Math.max(0, Math.min(1, state.waveBreakTimer / WAVE_BREAK_DURATION));
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(x + 16, y + 30, w - 32, 12);
    ctx.fillStyle = '#00e676';
    ctx.fillRect(x + 16, y + 30, (w - 32) * pct, 12);

    ctx.fillStyle = '#111';
    ctx.font = 'bold 9px monospace';
    ctx.fillText('PRESS [B] TO SPEND $ CREDITS IN ARMORY', x + w / 2, y + 31);
  } else {
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 15px monospace';
    ctx.fillText(`WAVE ${state.wave}   •   HOSTILES: ${state.zombies.length}`, x + w / 2, y + 8);

    const target = Math.max(1, state.waveTarget);
    const pct = Math.max(0, Math.min(1, state.waveKills / target));
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(x + 16, y + 30, w - 32, 14);
    ctx.fillStyle = '#e53935';
    ctx.fillRect(x + 16, y + 30, (w - 32) * pct, 14);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.strokeRect(x + 16, y + 30, w - 32, 14);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(`${state.waveKills} / ${target} KILLS`, x + w / 2, y + 32);
  }
}

function drawComboHUD(state: GameState) {
  const p = state.players[myId];
  if (!p || !p.combo || p.combo <= 0) return;

  const x = 12;
  const y = 148;
  const w = 220;
  const h = 54;

  const isOverdrive = p.combo >= 10;
  const color = p.combo >= 20 ? '#e040fb' : isOverdrive ? '#ff6d00' : '#ffd54f';
  const mult = Math.min(5.0, 1.0 + (p.combo - 1) * 0.2).toFixed(1);

  ctx.fillStyle = 'rgba(12, 14, 22, 0.85)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  ctx.font = 'bold 20px monospace';
  ctx.fillText(`${p.combo}x COMBO`, x + 12, y + 7);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px monospace';
  ctx.fillText(`${mult}x REWARD`, x + w - 10, y + 11);

  if (isOverdrive) {
    ctx.fillStyle = '#ff6d00';
    ctx.font = 'bold 9px monospace';
    ctx.fillText('⚡ OVERDRIVE', x + w - 10, y + 24);
  }

  // Timer bar
  const pct = Math.max(0, Math.min(1, (p.comboTimer || 0) / COMBO_DURATION));
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(x + 12, y + 36, w - 24, 8);
  ctx.fillStyle = color;
  ctx.fillRect(x + 12, y + 36, (w - 24) * pct, 8);
}

function drawWaveBanner(dt: number) {
  if (waveBannerTimer <= 0) return;
  waveBannerTimer -= dt;

  const alpha = waveBannerTimer < 0.6 ? waveBannerTimer / 0.6 : Math.min(1, (3.2 - waveBannerTimer) * 4);
  const cy = canvas.height * 0.24;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.fillStyle = 'rgba(10, 12, 18, 0.78)';
  ctx.fillRect(0, cy - 36, canvas.width, 72);
  ctx.strokeStyle = waveBannerColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, cy - 36);
  ctx.lineTo(canvas.width, cy - 36);
  ctx.moveTo(0, cy + 36);
  ctx.lineTo(canvas.width, cy + 36);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = waveBannerColor;
  ctx.font = '900 28px sans-serif';
  ctx.fillText(waveBannerText, canvas.width / 2, cy - 8);

  ctx.fillStyle = '#f5f5f5';
  ctx.font = 'bold 13px monospace';
  ctx.fillText(waveBannerSub, canvas.width / 2, cy + 18);
  ctx.restore();
}

function drawWeaponAndTacticalBar(state: GameState) {
  const p = state.players[myId];
  if (!p) return;

  const meleeW = 86;
  const slotW = 64;
  const armoryW = 76;
  const slotH = 56;
  const gap = 5;
  // Layout: [MELEE] + 10px + 4x[WEAPONS] + 10px + 3x[TACTICAL] + 10px + [ARMORY]
  const totalW = meleeW + 10 + slotW * 4 + gap * 3 + 10 + slotW * 3 + gap * 2 + 10 + armoryW;
  const barX = (canvas.width - totalW) / 2;
  const barY = canvas.height - slotH - 12;

  // 1. Prominent On-Screen KATANA MELEE Button
  const mX = barX;
  hotbarMeleeBtnRect = { x: mX, y: barY, w: meleeW, h: slotH };
  const meleeKey = keyDisplayName(bindings.melee);
  const meleeLv = p.meleeLevel || 0;
  const meleeDmg = Math.round(45 * (1 + meleeLv * 0.35));
  const meleeHeal = 5 + meleeLv * 3;
  const isSwinging = meleeSwingTime > 0;
  const cdRatio = Math.max(0, Math.min(1, meleeCooldownTimer / MELEE_COOLDOWN));

  ctx.fillStyle = isSwinging ? 'rgba(0, 229, 255, 0.35)' : 'rgba(10, 24, 34, 0.88)';
  ctx.fillRect(mX, barY, meleeW, slotH);

  // Cooldown progress overlay
  if (cdRatio > 0) {
    ctx.fillStyle = 'rgba(0, 229, 255, 0.18)';
    ctx.fillRect(mX, barY + slotH * (1 - cdRatio), meleeW, slotH * cdRatio);
  }

  ctx.strokeStyle = isSwinging ? '#ffffff' : '#00e5ff';
  ctx.lineWidth = isSwinging ? 2.5 : 1.8;
  ctx.strokeRect(mX, barY, meleeW, slotH);

  ctx.fillStyle = '#00e5ff';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`[${meleeKey}/RMB]`, mX + 4, barY + 4);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('⚔ KATANA', mX + meleeW / 2, barY + 19);

  ctx.fillStyle = '#80deea';
  ctx.font = 'bold 9px monospace';
  ctx.fillText(`${meleeDmg} DMG • +${meleeHeal}♥`, mX + meleeW / 2, barY + 37);

  // 2. Firearm Slots (1-4)
  const weapStartX = mX + meleeW + 10;
  const weapons = ['pistol', 'uzi', 'shotgun', 'rocketLauncher'];
  const names = ['Pistol', 'Uzi', 'Shotgun', 'Rocket'];
  const slots = p.weaponSlots || [true, false, false, false];
  const dmgMult = 1 + (p.damageLevel || 0) * 0.2;
  hotbarWeaponRects = [];

  for (let i = 0; i < 4; i++) {
    const x = weapStartX + i * (slotW + gap);
    hotbarWeaponRects.push({ slot: i + 1, x, y: barY, w: slotW, h: slotH });
    const unlocked = slots[i];
    const active = p.weapon === weapons[i];

    ctx.fillStyle = active
      ? 'rgba(25, 118, 210, 0.82)'
      : unlocked
      ? 'rgba(12, 14, 22, 0.8)'
      : 'rgba(12, 14, 22, 0.45)';
    ctx.fillRect(x, barY, slotW, slotH);

    ctx.strokeStyle = active ? '#64B5F6' : unlocked ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.1)';
    ctx.lineWidth = active ? 2 : 1;
    ctx.strokeRect(x, barY, slotW, slotH);

    ctx.fillStyle = active ? '#fff' : unlocked ? '#aaa' : '#555';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${i + 1}`, x + 5, barY + 4);

    if (unlocked) {
      ctx.fillStyle = active ? '#fff' : '#ddd';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(names[i], x + slotW / 2, barY + 19);

      const dmg = Math.round((WEAPON_STATS[weapons[i]]?.damage ?? 0) * dmgMult);
      ctx.fillStyle = '#ffb400';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(`${dmg} DMG`, x + slotW / 2, barY + 37);
    } else {
      ctx.fillStyle = '#555';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('LOCKED', x + slotW / 2, barY + 25);
    }
  }

  // 3. Tactical slots (Barrel, Barricade, Claymore)
  const tacStartX = weapStartX + 4 * slotW + 3 * gap + 10;
  const tacItems = p.tacticalItems || [0, 0, 0];
  const tacLabels = ['Barrel', 'Wall', 'Mine'];
  const tacKeys = [
    keyDisplayName(bindings.placeBarrel),
    keyDisplayName(bindings.placeBarricade),
    keyDisplayName(bindings.placeMine),
  ];
  const tacColors = ['#ff5252', '#8d6e63', '#ffab00'];
  hotbarTacticalRects = [];

  for (let t = 0; t < 3; t++) {
    const x = tacStartX + t * (slotW + gap);
    hotbarTacticalRects.push({ item: t + 1, x, y: barY, w: slotW, h: slotH });
    const count = tacItems[t] || 0;

    ctx.fillStyle = count > 0 ? 'rgba(18, 20, 30, 0.85)' : 'rgba(12, 14, 22, 0.45)';
    ctx.fillRect(x, barY, slotW, slotH);
    ctx.strokeStyle = count > 0 ? tacColors[t] : 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, barY, slotW, slotH);

    ctx.fillStyle = count > 0 ? tacColors[t] : '#666';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`[${tacKeys[t]}]`, x + 4, barY + 4);

    ctx.fillStyle = count > 0 ? '#fff' : '#666';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(tacLabels[t], x + slotW / 2, barY + 19);

    ctx.fillStyle = count > 0 ? '#00e676' : '#555';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(`x${count}`, x + slotW / 2, barY + 37);
  }

  // 4. Armory Shop Button
  const armX = tacStartX + 3 * slotW + 2 * gap + 10;
  hotbarArmoryBtnRect = { x: armX, y: barY, w: armoryW, h: slotH };
  const shopKey = keyDisplayName(bindings.toggleShop);

  ctx.fillStyle = armoryOpen ? 'rgba(255, 180, 0, 0.9)' : 'rgba(20, 34, 24, 0.88)';
  ctx.fillRect(armX, barY, armoryW, slotH);
  ctx.strokeStyle = armoryOpen ? '#ffd54f' : '#00e676';
  ctx.lineWidth = armoryOpen ? 2.5 : 1.8;
  ctx.strokeRect(armX, barY, armoryW, slotH);

  ctx.fillStyle = armoryOpen ? '#111' : '#ffb400';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`[${shopKey}]`, armX + 4, barY + 4);

  ctx.fillStyle = armoryOpen ? '#111' : '#fff';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Armory', armX + armoryW / 2, barY + 19);

  ctx.fillStyle = armoryOpen ? '#111' : '#00e676';
  ctx.font = 'bold 10px monospace';
  ctx.fillText(`$${Math.floor(p.credits ?? 0)}`, armX + armoryW / 2, barY + 37);
}

function drawScoreboardAndFeed(state: GameState) {
  const playerList = Object.values(state.players).sort((a, b) => b.score - a.score);
  if (playerList.length === 0) return;

  const rowH = 22;
  const headerH = 28;
  const padX = 12;
  const padY = 8;
  const boardW = isMobile ? 160 : 210;
  const boardH = headerH + padY * 2 + playerList.length * rowH;
  const boardX = canvas.width - boardW - 15;
  const boardY = 12;

  ctx.fillStyle = 'rgba(12, 14, 22, 0.78)';
  ctx.fillRect(boardX, boardY, boardW, boardH);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(boardX, boardY, boardW, boardH);

  ctx.fillStyle = '#90a4ae';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('OPERATIVE', boardX + padX, boardY + 8);
  ctx.textAlign = 'right';
  ctx.fillText('SCORE', boardX + boardW - padX, boardY + 8);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.beginPath();
  ctx.moveTo(boardX + 6, boardY + headerH);
  ctx.lineTo(boardX + boardW - 6, boardY + headerH);
  ctx.stroke();

  for (let i = 0; i < playerList.length; i++) {
    const p = playerList[i];
    const y = boardY + headerH + padY + i * rowH;
    const isMe = p.id === myId;
    const dead = p.health <= 0;

    if (isMe) {
      ctx.fillStyle = 'rgba(33, 150, 243, 0.18)';
      ctx.fillRect(boardX + 2, y - 2, boardW - 4, rowH);
    }

    ctx.fillStyle = dead ? '#666' : isMe ? '#64B5F6' : '#ddd';
    ctx.font = isMe ? 'bold 12px sans-serif' : '12px sans-serif';
    ctx.textAlign = 'left';
    const name = p.name || p.id.slice(0, 6);
    ctx.fillText(name.length > 12 ? name.slice(0, 11) + '…' : name, boardX + padX, y + 2);

    ctx.fillStyle = dead ? '#666' : '#ffb400';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.floor(p.score)}`, boardX + boardW - padX, y + 2);
  }

  // Event / Killstreak Feed below scoreboard
  const now = performance.now();
  let feedY = boardY + boardH + 10;
  for (let i = eventFeed.length - 1; i >= 0; i--) {
    const ev = eventFeed[i];
    const age = (now - ev.time) / 1000;
    if (age > 6) {
      eventFeed.splice(i, 1);
      continue;
    }
  }
  for (let i = 0; i < eventFeed.length; i++) {
    const ev = eventFeed[i];
    const age = (now - ev.time) / 1000;
    const alpha = age > 4.5 ? 1 - (age - 4.5) / 1.5 : 1;

    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = 'rgba(12, 14, 22, 0.72)';
    ctx.fillRect(boardX, feedY, boardW, 22);
    ctx.fillStyle = ev.color;
    ctx.fillRect(boardX, feedY, 3, 22);
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(ev.text.slice(0, 28), boardX + 8, feedY + 11);
    ctx.restore();
    feedY += 25;
  }
}

function drawScreenVignettes(dt: number) {
  if (damageFlashAlpha > 0) {
    damageFlashAlpha = Math.max(0, damageFlashAlpha - dt * 1.4);
    const grad = ctx.createRadialGradient(
      canvas.width / 2,
      canvas.height / 2,
      canvas.width * 0.25,
      canvas.width / 2,
      canvas.height / 2,
      canvas.width * 0.65
    );
    grad.addColorStop(0, 'rgba(229, 57, 53, 0)');
    grad.addColorStop(1, `rgba(229, 57, 53, ${damageFlashAlpha})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  if (healFlashAlpha > 0) {
    healFlashAlpha = Math.max(0, healFlashAlpha - dt * 1.2);
    ctx.fillStyle = `rgba(0, 230, 118, ${healFlashAlpha * 0.25})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

function drawMobileControls() {
  if (!isMobile || currentScreen !== 'playing') return;

  const joyBaseX = 90;
  const joyBaseY = canvas.height - 110;

  if (moveStickActive) {
    ctx.beginPath();
    ctx.arc(moveStickOrigin.x, moveStickOrigin.y, JOYSTICK_MAX, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 2;
    ctx.stroke();

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

  const meleeX = canvas.width - 70;
  const meleeY = canvas.height - 160;
  touchMeleeBtn = { x: meleeX, y: meleeY, r: 32 };

  ctx.beginPath();
  ctx.arc(meleeX, meleeY, 32, 0, Math.PI * 2);
  ctx.fillStyle = input.melee ? 'rgba(0, 229, 255, 0.55)' : 'rgba(10, 24, 34, 0.75)';
  ctx.fill();
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚔ KATANA', meleeX, meleeY);

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
}

const deathRecap = document.createElement('section');
deathRecap.id = 'deathRecap';
deathRecap.style.cssText = 'background:rgba(24,12,16,.96);border:1px solid #a94442;border-radius:10px;padding:16px;color:#eee;font:13px monospace;width:min(440px,90vw);box-sizing:border-box;max-height:32vh;overflow:auto;';
let recapKey = '';
function updateDeathRecap() {
  const player = players[myId];
  const visible = player && player.health <= 0 && (currentScreen === 'playing' || currentScreen === 'gameover');
  deathRecap.hidden = !visible;
  if (!visible) { recapKey = ''; return; }
  const over = currentScreen === 'gameover';
  const parent = over ? gameOverOverlay.querySelector('.menu-panel')! : document.body;
  if (deathRecap.parentElement !== parent) {
    if (over) parent.insertBefore(deathRecap, parent.lastElementChild);
    else parent.appendChild(deathRecap);
  }
  deathRecap.style.width = over ? '100%' : 'min(440px,90vw)';
  deathRecap.style.position = over ? 'static' : 'fixed';
  deathRecap.style.left = over ? '' : '50%';
  deathRecap.style.top = over ? '' : '20px';
  deathRecap.style.transform = over ? '' : 'translateX(-50%)';
  deathRecap.style.zIndex = '20';
  const hits = player.damageLog || [];
  const key = JSON.stringify(hits);
  if (key === recapKey) return;
  recapKey = key;
  deathRecap.replaceChildren();
  const title = document.createElement('strong');
  const last = hits[hits.length - 1];
  const label = (type: string) => type.charAt(0).toUpperCase() + type.slice(1);
  title.textContent = last ? `DOWNED BY ${label(last.source).toUpperCase()} — melee` : 'DEATH BREAKDOWN';
  deathRecap.append(title);
  const summary = document.createElement('p');
  summary.textContent = last ? 'Recent hits (up to 15 seconds before death). Distances are server-side pixels.' : 'No damage history recorded for this life.';
  deathRecap.append(summary);
  for (const hit of [...hits].reverse()) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:5px 0;border-top:1px solid #ffffff20';
    row.textContent = `${last ? (last.time - hit.time).toFixed(1) : '0.0'}s before · ${label(hit.source)} · ${hit.damage} damage · ${Math.round(hit.distance)}px · ${Math.round(hit.healthAfter)} HP left`;
    deathRecap.append(row);
  }
}

function draw() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  drainDeltaQueue();
  updateDeathRecap();
  predictLocalMovement(dt);

  dashActiveTimer = Math.max(0, dashActiveTimer - dt);
  dashIframeTimer = Math.max(0, dashIframeTimer - dt);
  meleeCooldownTimer = Math.max(0, meleeCooldownTimer - dt);
  if (dashCharges < DASH_MAX_CHARGES) {
    dashRechargeTimer -= dt;
    if (dashRechargeTimer <= 0) {
      dashCharges++;
      dashRechargeTimer = dashCharges < DASH_MAX_CHARGES ? DASH_RECHARGE_TIME : 0;
    }
  }

  ctx.fillStyle = '#181a20';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  canvas.style.cursor = currentScreen === 'playing' ? 'crosshair' : 'default';

  if (currentScreen === 'playing' || currentScreen === 'gameover') {
    const state = buildRenderState();

    if (state) {
      updateCamera(dt);

      ctx.fillStyle = '#252830';
      ctx.fillRect(-camX, -camY, staticMapWidth, staticMapHeight);

      if (!isMobile) drawGrid();
      drawTunnels();
      drawBloodStains();
      drawWalls();
      drawAmmoPickups();
      drawPlaceables(state);
      drawDrops(state);
      drawBullets(state);
      drawZombies(state);
      drawPlayers(dt, state);
      drawMeleeSwing(dt, state);
      drawVisualEffects(dt);
      drawScreenVignettes(dt);

      if (!isMobile) drawMinimap(state);
      drawHUD(state);
      drawWaveHeader(state);
      drawComboHUD(state);
      drawScoreboardAndFeed(state);
      if (!isMobile) drawWeaponAndTacticalBar(state);
      drawWaveBanner(dt);
      drawMobileControls();
    } else {
      ctx.fillStyle = '#fff';
      ctx.font = '24px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Deploying to Arena...', canvas.width / 2, canvas.height / 2);
    }
  }

  requestAnimationFrame(draw);
}

draw();
