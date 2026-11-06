import { drawEnemySprite, drawPlaceableSprite, drawDropSprite, drawGunSprite } from './sprites';
import { theme, withAlpha, font } from './theme';
import {
  RoomInfo, Friend, OPEN_ROOM_ID, partitionRooms, resolveSelectedRoom, roomStatusText,
  verifyStatusText, sortFriends, friendsSummary, defaultCallsign, accountLabel,
} from './lobby';
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
let waveBannerColor = theme.accent;
let waveBannerTimer = 0;
let armoryOpen = false;
let hotbarMeleeBtnRect = { x: 0, y: 0, w: 0, h: 0 };
let hotbarArmoryBtnRect = { x: 0, y: 0, w: 0, h: 0 };
let hotbarDashBtnRect = { x: 0, y: 0, w: 0, h: 0 };
let hotbarWeaponRects: { slot: number; x: number; y: number; w: number; h: number }[] = [];
let hotbarTacticalRects: { item: number; x: number; y: number; w: number; h: number }[] = [];

function addScreenShake(intensity: number) {
  screenShakeAmount = Math.min(22, Math.max(screenShakeAmount, intensity));
}

function pushFeedEvent(text: string, color = theme.textSecondary) {
  eventFeed.unshift({ text, color, time: performance.now() });
  if (eventFeed.length > 6) eventFeed.pop();
}

function spawnFloatingText(x: number, y: number, text: string, color = theme.text, size = 14) {
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

const signInBtn = document.getElementById('signInBtn')!;
const authSectionIn = document.getElementById('authSectionIn')!;
const loggedInStatus = document.getElementById('loggedInStatus')!;
const loginErrorMsg = document.getElementById('loginErrorMsg')!;

const friendsListContainer = document.getElementById('friendsListContainer')!;
const homeFriendsList = document.getElementById('homeFriendsList')!;
const homeFriendsSummary = document.getElementById('homeFriendsSummary')!;
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

// --- Servers (rooms) ---
// Every lobby is hosted by the game server. Signed-in (verified) accounts can
// join any lobby; guests can only join open lobbies. The server enforces this
// on join — the UI just reflects what the server reports.
let rooms: RoomInfo[] = [];
let accountVerified = false;
let selectedRoomId = localStorage.getItem('boxhead_room') || OPEN_ROOM_ID;
let currentRoomId = selectedRoomId;
let currentRoomName = 'Arena';
const roomListEl = document.getElementById('roomList')!;
roomListEl.addEventListener('scroll', () => updateRoomListFade(roomListEl), { passive: true });
type LobbyFilter = 'all' | 'verified' | 'open';
let lobbyFilter: LobbyFilter = 'all';
const deployBtn = document.getElementById('deployBtn') as HTMLButtonElement;
const deployLabel = document.getElementById('deployLabel')!;
const lobbyWaveSelect = document.querySelector('#menuBrowser [data-wave-select]') as HTMLSelectElement;
const lobbyWaveHint = document.getElementById('lobbyWaveHint')!;
const verifyStatusEl = document.getElementById('verifyStatus')!;
const roomErrorMsg = document.getElementById('roomErrorMsg')!;
const roomNameInput = document.getElementById('roomNameInput') as HTMLInputElement;
const roomVerifiedOnly = document.getElementById('roomVerifiedOnly') as HTMLInputElement;
const roomVerifiedLabel = document.getElementById('roomVerifiedLabel')!;

function selectRoom(id: string) {
  selectedRoomId = id;
  localStorage.setItem('boxhead_room', id);
  renderRooms();
}

function renderRoomItem(room: RoomInfo): HTMLButtonElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'room-item' + (room.id === selectedRoomId ? ' selected' : '');
  item.disabled = !room.canJoin;
  item.title = room.canJoin ? `Select ${room.name} (double-click to join)` : 'Sign in to join verified lobbies';
  const title = document.createElement('span');
  title.className = 'room-title';
  if (!room.canJoin) title.append(svgIcon('i-lock'));
  const name = document.createElement('span');
  name.className = 'room-name';
  name.textContent = room.name;
  title.append(name);
  // Badges: who can join (a rule, not an endorsement), then Official for lobbies the server runs.
  const kind = document.createElement('span');
  kind.className = 'badge';
  kind.append(svgIcon(room.verifiedOnly ? 'i-shield-check' : 'i-globe'), room.verifiedOnly ? 'Verified only' : 'Public');
  title.append(kind);
  if (room.permanent) {
    const official = document.createElement('span');
    official.className = 'badge badge--strong';
    official.title = 'Run by the game server; always available';
    official.append(svgIcon('i-star'), 'Official');
    title.append(official);
  }
  // Status: a dot (green = match running, red = overrun) and one line of text.
  const meta = document.createElement('span');
  meta.className = 'room-meta' + (room.players > 0 ? ' room-meta--live' : '');
  const dot = document.createElement('span');
  // Filled white = a match is running, red = overrun, hollow = waiting.
  dot.className = 'status-dot ' + (room.players > 0 ? (room.gameOver ? 'over' : 'live') : 'idle');
  meta.append(dot, room.canJoin ? roomStatusText(room) : 'Sign in to join');
  const count = document.createElement('span');
  count.className = 'room-count';
  // Only lobbies with people in them show a count; the status line already says the rest are waiting.
  if (room.players > 0) count.append(svgIcon('i-users'), `${room.players} ${room.players === 1 ? 'player' : 'players'}`);
  item.append(title, meta, count);
  item.addEventListener('click', () => selectRoom(room.id));
  item.addEventListener('dblclick', () => { selectRoom(room.id); deploy(); });
  return item;
}

function renderRoomList(container: HTMLElement, list: RoomInfo[], emptyText: string) {
  if (list.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'room-empty';
    empty.textContent = emptyText;
    container.replaceChildren(empty);
  } else {
    container.replaceChildren(...list.map(renderRoomItem));
  }
  updateRoomListFade(container);
}

/** Fade the list's bottom edge while more lobbies are scrolled out of view. */
function updateRoomListFade(container: HTMLElement) {
  container.classList.toggle('has-more', container.scrollTop + container.clientHeight < container.scrollHeight - 4);
}

function renderRooms() {
  // Fall back to the open arena if the remembered lobby vanished or is locked.
  selectedRoomId = resolveSelectedRoom(rooms, selectedRoomId);
  verifyStatusEl.textContent = verifyStatusText(accountVerified, isLoggedIn);
  verifyStatusEl.classList.toggle('ok', accountVerified);
  roomVerifiedOnly.disabled = !accountVerified;
  if (!accountVerified) roomVerifiedOnly.checked = false;
  roomVerifiedLabel.classList.toggle('locked', !accountVerified);
  roomVerifiedLabel.title = accountVerified ? 'Only verified accounts can join' : 'Sign in to host verified lobbies';

  const { verified, open } = partitionRooms(rooms);
  // Lobbies with players first, so running matches are easy to find.
  const shown = (lobbyFilter === 'verified' ? verified : lobbyFilter === 'open' ? open : [...verified, ...open]).slice().sort((a, b) => b.players - a.players);
  renderRoomList(roomListEl, shown, lobbyFilter === 'all' ? 'No lobbies yet' : lobbyFilter === 'open' ? 'No public lobbies yet' : 'No verified lobbies yet');
  document.querySelectorAll<HTMLButtonElement>('[data-lobby-filter]').forEach(btn => {
    const filter = btn.dataset.lobbyFilter as LobbyFilter;
    const count = filter === 'verified' ? verified.length : filter === 'open' ? open.length : rooms.length;
    const countEl = document.createElement('span');
    countEl.className = 'seg-count';
    countEl.textContent = String(count);
    btn.replaceChildren(filter === 'all' ? 'All' : filter === 'verified' ? 'Verified only' : 'Public', countEl);
    btn.setAttribute('aria-pressed', String(filter === lobbyFilter));
  });
  const selected = rooms.find(r => r.id === selectedRoomId);
  // The starting wave only matters when you start a match, i.e. join an empty lobby.
  const inProgress = !!selected && selected.players > 0;
  // Joining a running match drops you in at its current wave, so the button says so.
  deployLabel.textContent = !selected ? 'Join' : inProgress ? `Join ${selected.name} · Wave ${selected.wave}` : `Join ${selected.name}`;
  lobbyWaveSelect.disabled = inProgress;
  lobbyWaveHint.textContent = !selected ? 'Pick a lobby to join.'
    : inProgress ? `${selected.name} is on Wave ${selected.wave}: you'll join the match in progress.`
    : `${selected.name} is empty: its match starts at the wave you pick.`;
}

async function refreshRooms() {
  try {
    const res = await fetch(`/api/rooms?token=${encodeURIComponent(authToken)}`);
    const data = await res.json();
    if (!data.ok) return;
    rooms = data.rooms;
    accountVerified = !!data.verified;
    renderRooms();
  } catch { /* keep the last list */ }
}

async function createRoom() {
  roomErrorMsg.textContent = '';
  const name = roomNameInput.value.trim();
  if (!name) { roomErrorMsg.textContent = 'Name your lobby first'; return; }
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken, name, verifiedOnly: roomVerifiedOnly.checked }),
    });
    const data = await res.json();
    if (!data.ok) { roomErrorMsg.textContent = data.error || 'Could not create lobby'; return; }
    roomNameInput.value = '';
    selectedRoomId = data.room.id;
    localStorage.setItem('boxhead_room', selectedRoomId);
    await refreshRooms();
    deploy();
  } catch {
    roomErrorMsg.textContent = 'Network error';
  }
}

document.getElementById('refreshRoomsBtn')!.addEventListener('click', () => void refreshRooms());
document.getElementById('createRoomBtn')!.addEventListener('click', () => void createRoom());
document.querySelectorAll<HTMLButtonElement>('[data-lobby-filter]').forEach(btn => btn.addEventListener('click', () => {
  lobbyFilter = btn.dataset.lobbyFilter as LobbyFilter;
  renderRooms();
}));
document.querySelectorAll<HTMLButtonElement>('[data-pw-toggle]').forEach(btn => btn.addEventListener('click', () => {
  const input = document.getElementById(btn.dataset.pwToggle!) as HTMLInputElement;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.replaceChildren(svgIcon(show ? 'i-eye-off' : 'i-eye'));
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
}));
document.getElementById('forgotPwBtn')!.addEventListener('click', () => {
  const hint = document.getElementById('forgotPwHint')!;
  hint.hidden = !hint.hidden;
});
// Hosting lives behind a toggle so the main path stays: pick a lobby, then Join.
const hostToggleBtn = document.getElementById('hostToggleBtn')!;
hostToggleBtn.addEventListener('click', () => {
  const form = document.getElementById('hostForm')!;
  const open = form.classList.toggle('hidden') === false;
  hostToggleBtn.setAttribute('aria-expanded', String(open));
  if (open) roomNameInput.focus();
});
roomNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') void createRoom(); });
setInterval(() => { if (currentScreen === 'menu' && menuView === 'browser') void refreshRooms(); }, 5000);

// --- Menu views: home (Play / Sign in), server browser, sign in ---
type MenuView = 'home' | 'browser' | 'signin';
let menuView: MenuView = 'home';
const menuViews: Record<MenuView, HTMLElement> = {
  home: document.getElementById('menuHome')!,
  browser: document.getElementById('menuBrowser')!,
  signin: document.getElementById('menuSignIn')!,
};
function showMenuView(view: MenuView) {
  menuView = view;
  for (const [name, el] of Object.entries(menuViews)) el.classList.toggle('hidden', name !== view);
  if (view === 'browser') void refreshRooms();
}
document.querySelectorAll<HTMLElement>('[data-menu-view]').forEach(el =>
  el.addEventListener('click', () => showMenuView(el.dataset.menuView as MenuView)));
document.getElementById('signInBtn')!.addEventListener('click', () => showMenuView('signin'));

function deploy() {
  if (!playerName.trim()) playerName = 'Operative';
  nameInputEl.value = playerName;
  connectToServer();
}
deployBtn.addEventListener('click', deploy);

// --- Screen state ---
type Screen = 'menu' | 'playing' | 'gameover';
let currentScreen: Screen = 'menu';

function updateAuthDOM() {
  signInBtn.classList.toggle('hidden', isLoggedIn);
  document.getElementById('signInHint')!.classList.toggle('hidden', isLoggedIn);
  friendsBtn.classList.toggle('hidden', !isLoggedIn);
  authSectionIn.classList.toggle('hidden', !isLoggedIn);
  updateAccountSummary();
  if (isLoggedIn) {
    // Lead with the callsign other players see; the account handle is secondary.
    const callsign = playerName.trim() || defaultCallsign(authHandle);
    loggedInStatus.textContent = callsign;
    loggedInStatus.title = accountLabel(authHandle);
    document.getElementById('accountAvatar')!.textContent = callsign.charAt(0).toUpperCase() || '?';
  }
}

// A stable browser profile lets the server persist and enforce wave unlocks.
function newWaveProfile(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
const waveProfile = localStorage.getItem('boxhead_wave_profile') || newWaveProfile();
localStorage.setItem('boxhead_wave_profile', waveProfile);
let highestWave = Math.max(1, Number(localStorage.getItem('boxhead_highest_wave')) || 1);
let startingWave = 1;
const waveSelects = [...document.querySelectorAll<HTMLSelectElement>('[data-wave-select]')];
function renderWaveOptions() {
  for (const select of waveSelects) {
    select.replaceChildren();
    for (let value = 1; value <= highestWave; value++) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = `Wave ${value}${value === highestWave && value > 1 ? ' (best)' : ''}`;
      select.append(option);
    }
    select.value = String(startingWave);
  }
}
function rememberWave(reached: number) {
  if (!Number.isInteger(reached) || reached <= highestWave) return;
  highestWave = reached;
  localStorage.setItem('boxhead_highest_wave', String(highestWave));
  renderWaveOptions();
  updateAccountSummary();
}
for (const select of waveSelects) select.addEventListener('change', () => {
  startingWave = Math.max(1, Math.min(highestWave, Number(select.value) || 1));
  for (const other of waveSelects) other.value = String(startingWave);
});
async function refreshWaveProgress() {
  try {
    const response = await fetch(`/api/progress?profileId=${encodeURIComponent(waveProfile)}`);
    if (!response.ok) return;
    const progress = await response.json();
    rememberWave(progress.highestWave);
  } catch { /* Keep the last saved options when offline. */ }
}
renderWaveOptions();
void refreshWaveProgress();

let serverPaused = false;
let roomHostId: string | null = null;
const roomControls = document.getElementById('roomControls')!;
const pauseButton = document.getElementById('pauseBtn') as HTMLButtonElement;
const resumeButton = document.getElementById('resumeBtn') as HTMLButtonElement;
const pauseOverlay = document.getElementById('pauseOverlay')!;
function renderRoomControls() {
  const playing = currentScreen === 'playing';
  const host = roomHostId === myId && !!myId;
  roomControls.classList.toggle('hidden', !playing);
  pauseButton.disabled = !host;
  const pauseKey = document.createElement('kbd');
  pauseKey.className = 'kbd';
  pauseKey.textContent = 'P';
  pauseButton.replaceChildren(svgIcon(serverPaused ? 'i-play' : 'i-pause'), pauseKey);
  const pauseLabel = host ? (serverPaused ? 'Resume (P)' : 'Pause the round (P)') : 'Only the host can pause';
  pauseButton.title = pauseLabel;
  pauseButton.setAttribute('aria-label', pauseLabel);
  pauseOverlay.hidden = !serverPaused || !playing;
  pauseOverlay.style.display = serverPaused && playing ? 'flex' : 'none';
  resumeButton.hidden = !host;
  document.getElementById('leaveMatchBtn')!.classList.toggle('btn-block', !host);
  // The host leaving unpauses the match and hands host to the next player.
  document.getElementById('leaveHint')!.textContent = host
    ? 'If you leave, the match resumes for your squad.'
    : 'If you leave, your squad plays on without you.';
  const hostName = (roomHostId && players[roomHostId]?.name) || 'the host';
  document.getElementById('pauseMessage')!.textContent = host
    ? 'You paused the match for everyone. Only you can resume it.'
    : `Paused by ${hostName} (host). Only the host can resume the match.`;
}
function requestPause() {
  if (currentScreen !== 'playing' || roomHostId !== myId || ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'pause', paused: !serverPaused }));
}
pauseButton.addEventListener('click', requestPause);
resumeButton.addEventListener('click', requestPause);

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
  renderRoomControls();
  if (scr === 'menu') { updateAuthDOM(); void refreshWaveProgress(); void refreshRooms(); }
  if (scr === 'gameover') {
    gameOverWave.textContent = finalWave.toString();
    const orDash = (n: number, text: string) => (n > 0 ? text : '—');
    gameOverScore.textContent = orDash(finalScore, Math.floor(finalScore).toLocaleString('en-US'));
    gameOverKills.textContent = orDash(finalKills, `${finalKills}`);
    gameOverCombo.textContent = orDash(finalMaxCombo, `×${finalMaxCombo}`);
    renderSquadResults();
  }
}

/** Game over: everyone's result, best score first, your row highlighted. */
function renderSquadResults() {
  const table = document.getElementById('gameOverSquad') as HTMLTableElement;
  const list = Object.values(players).sort((a, b) => b.score - a.score);
  table.replaceChildren();
  // Co-op: everyone's result sits beside your death recap, in a wider panel.
  const squad = list.length >= 2;
  document.getElementById('gameOverDetails')!.classList.toggle('has-squad', squad);
  document.getElementById('gameOverSquadCard')!.hidden = !squad;
  if (!squad) return; // solo rounds: the stat tiles already say it all
  const head = table.createTHead().insertRow();
  for (const label of ['Player', 'Score', 'Kills']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  for (const p of list) {
    const tr = body.insertRow();
    if (p.id === myId) tr.className = 'me';
    for (const text of [p.name || p.id.slice(0, 6), Math.floor(p.score).toLocaleString('en-US'), `${p.kills || 0}`]) tr.insertCell().textContent = text;
  }
}

let finalWave = 1;
let finalScore = 0;
let finalKills = 0;
let finalMaxCombo = 0;
// Older builds saved the full sign-in email as the callsign; never broadcast that.
let playerName = (n => (n.includes('@') ? defaultCallsign(n) : n))(localStorage.getItem('boxhead_name') || 'Operative');

// --- Auth ---
let authToken = localStorage.getItem('boxhead_auth_token') || '';
let authHandle = localStorage.getItem('boxhead_auth_handle') || '';
let authUserId = localStorage.getItem('boxhead_auth_user_id') || '';
let isLoggedIn = !!authToken;

// --- Friends ---
let friendsList: Friend[] = [];

function setAuthState(token: string, handle: string, userId: string, displayName?: string) {
  authToken = token;
  authHandle = handle || displayName || '';
  authUserId = userId;
  isLoggedIn = true;
  playerName = defaultCallsign(authHandle);
  nameInputEl.value = playerName;
  localStorage.setItem('boxhead_auth_token', authToken);
  localStorage.setItem('boxhead_auth_handle', authHandle);
  localStorage.setItem('boxhead_auth_user_id', authUserId);
  localStorage.setItem('boxhead_name', playerName);
  updateAuthDOM();
  refreshFriends();
  void refreshRooms();
  if (menuView === 'signin') showMenuView('home');
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
  accountVerified = false;
  updateFriendsDOM();
  void refreshRooms();
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
  bskyLoginBtn.querySelector('span')!.textContent = 'Sign in with Bluesky';
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

// Built with DOM nodes (not innerHTML) so handles can never inject markup.
function renderFriendList(container: HTMLElement, removable: boolean) {
  if (friendsList.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'friends-empty';
    empty.textContent = removable ? 'No friends yet' : 'No friends yet. Add some from Manage Friends.';
    container.replaceChildren(empty);
    return;
  }
  container.replaceChildren(...sortFriends(friendsList).map(f => {
    const row = document.createElement('div');
    row.className = 'friend-item';
    const label = document.createElement('span');
    const dot = document.createElement('div');
    dot.className = `status-dot${f.online ? ' online' : ''}`;
    const handle = document.createElement('span');
    handle.textContent = f.handle;
    const state = document.createElement('span');
    state.className = `friend-state${f.online ? ' online' : ''}`;
    state.textContent = f.online ? 'Online' : 'Offline';
    label.append(dot, handle);
    row.append(label, state);
    if (removable) {
      const remove = document.createElement('button');
      remove.className = 'btn-icon-red';
      remove.title = `Remove ${f.handle}`;
      remove.setAttribute('aria-label', `Remove ${f.handle}`);
      remove.append(svgIcon('i-close'));
      remove.addEventListener('click', () => void removeFriend(f.user_id));
      row.append(remove);
    }
    return row;
  }));
}

/** An icon from the sprite in index.html. */
function svgIcon(id: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function updateFriendsDOM() {
  renderFriendList(friendsListContainer, true);
  renderFriendList(homeFriendsList, false);
  homeFriendsSummary.textContent = friendsSummary(friendsList);
  document.getElementById('friendsBtnLabel')!.textContent = friendsList.length === 0 ? 'Add friends' : 'Friends';
  updateAccountSummary();
}

/** One useful line under the account name: best wave and friends online. */
function updateAccountSummary() {
  const online = friendsList.filter(f => f.online).length;
  const friends = friendsList.length === 0 ? '0 friends' : `${online}/${friendsList.length} friends online`;
  document.getElementById('accountSummary')!.textContent = `Best: Wave ${highestWave} · ${friends}`;
}

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
updateFriendsDOM();
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
    bskyLoginBtn.querySelector('span')!.textContent = 'Signing in…';
    bskyLogin(bskyHandleEl.value, bskyPassEl.value);
  }
});
googleLoginBtn.addEventListener('click', googleLogin);
logoutBtn.addEventListener('click', clearAuthState);
playBtn.addEventListener('click', () => showMenuView('browser'));
playAgainBtn.addEventListener('click', async () => {
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(currentRoomId)}/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken, profileId: waveProfile, startingWave }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) return;
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
// Leaving a paused match asks for a second click.
const leaveMatchBtn = document.getElementById('leaveMatchBtn')!;
const leaveLabel = leaveMatchBtn.querySelector('span')!;
let leaveConfirmTimer = 0;
leaveMatchBtn.addEventListener('click', () => {
  if (!leaveConfirmTimer) {
    leaveLabel.textContent = 'Click again to leave';
    leaveConfirmTimer = window.setTimeout(() => { leaveConfirmTimer = 0; leaveLabel.textContent = 'Leave match'; }, 3000);
    return;
  }
  window.clearTimeout(leaveConfirmTimer);
  leaveConfirmTimer = 0;
  leaveLabel.textContent = 'Leave match';
  if (ws) { ws.close(); ws = null; }
  serverPaused = false;
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

// Esc closes the open window, or opens settings during a match. Runs in the
// capture phase, before the game's own key handling (which closes the armory).
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || settingsListening || e.repeat) return;
  if (settingsOverlay.style.display === 'flex') { closeSettings(); e.stopPropagation(); return; }
  if (friendsOverlay.style.display === 'flex') { friendsOverlay.classList.add('hidden'); friendsOverlay.style.display = 'none'; e.stopPropagation(); return; }
  if (currentScreen === 'menu' && menuView !== 'home') { showMenuView('home'); e.stopPropagation(); return; }
  if (currentScreen === 'playing' && !armoryOpen) { openSettings(); e.stopPropagation(); }
}, true);

// Enter presses the open screen's primary button (Play, Join, Sign in, Play again),
// unless a focused control handles Enter itself.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.repeat || settingsListening) return;
  const target = e.target as HTMLElement;
  if (target.closest('button, a, select, textarea') || target === roomNameInput || target.id === 'addFriendInputEl') return;
  if (settingsOverlay.style.display === 'flex' || friendsOverlay.style.display === 'flex') return;
  let primary: HTMLButtonElement | null = null;
  if (currentScreen === 'gameover') primary = playAgainBtn as HTMLButtonElement;
  else if (currentScreen === 'menu' && menuView === 'home') primary = playBtn as HTMLButtonElement;
  else if (currentScreen === 'menu' && menuView === 'browser') primary = deployBtn;
  else if (currentScreen === 'menu' && menuView === 'signin') {
    primary = (document.getElementById('authTabBsky')!.classList.contains('hidden') ? emailLoginBtn : bskyLoginBtn) as HTMLButtonElement;
  }
  if (!primary || primary.disabled) return;
  e.preventDefault();
  primary.click();
});

function renderBindingsGrid() {
  const sections: { title: string; keys: (keyof KeyBindings)[] }[] = [
    { title: 'Movement', keys: ['moveUp', 'moveDown', 'moveLeft', 'moveRight'] },
    { title: 'Combat', keys: ['shoot', 'dash'] },
    { title: 'Weapons', keys: ['melee', 'weapon1', 'weapon2', 'weapon3', 'weapon4'] },
    { title: 'Gear & armory', keys: ['placeBarrel', 'placeBarricade', 'placeMine', 'toggleShop'] },
  ];

  // Two columns so every binding fits without scrolling on a normal screen. Keys line up in
  // one column; a fixed alternate (the katana's right-click) sits just left of its key.
  const altKey: Partial<Record<keyof KeyBindings, string>> = { melee: 'Mouse2' };
  const fixed = (key: string, alt = false) => `<span class="key-static${alt ? ' key-static--alt' : ''}" title="Fixed key: can't be rebound"><svg class="icon"><use href="#i-lock"/></svg>${key}</span>`;
  const row = (label: string, key: string, alt = '') =>
    `<div class="binding-row"><span class="action-label">${label}</span><span class="key-pair">${alt}${key}</span></div>`;
  const column = (list: typeof sections) => list.map((section) =>
    `<h4 class="settings-section-title">${section.title}</h4>` + section.keys.map((action) => row(
      BINDING_LABELS[action],
      `<button class="key-btn" data-action="${action}">${keyDisplayName(bindings[action])}</button>`,
      altKey[action] ? fixed(keyDisplayName(altKey[action]!), true) : '')).join('')).join('');
  const fixedRows = `<h4 class="settings-section-title">Game</h4>` +
    row('Pause (host only)', fixed('P')) + row('Controls / back', fixed('Esc')) + row('Buy in the armory', fixed('1–6'));
  bindingsGrid.innerHTML = `<div class="binding-col">${column(sections.slice(0, 2))}${fixedRows}</div><div class="binding-col">${column(sections.slice(2))}</div>`;

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
document.querySelectorAll('[data-open-settings]').forEach(el => el.addEventListener('click', openSettings));
// Resetting is destructive, so it asks for a second click.
const resetBindingsBtn = document.getElementById('resetBindingsBtn')!;
let resetConfirmTimer = 0;
const resetLabel = resetBindingsBtn.querySelector('span')!;
resetBindingsBtn.addEventListener('click', () => {
  if (!resetConfirmTimer) {
    resetLabel.textContent = 'Click again to reset all keys';
    resetConfirmTimer = window.setTimeout(() => { resetConfirmTimer = 0; resetLabel.textContent = 'Reset to defaults'; }, 3000);
    return;
  }
  window.clearTimeout(resetConfirmTimer);
  resetConfirmTimer = 0;
  resetLabel.textContent = 'Reset to defaults';
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
  // No shopping while downed: the death recap takes the armory's place.
  const downed = (players[myId]?.health ?? 1) <= 0;
  if (armoryOpen && currentScreen === 'playing' && !downed) {
    armoryOverlay.style.display = 'flex';
    renderArmoryDOM();
  } else {
    armoryOpen = false;
    armoryOverlay.style.display = 'none';
  }
}

closeArmoryBtn.addEventListener('click', () => toggleArmory(false));

/** Taking damage while shopping flashes the armory's frame: the match keeps running. */
function flashArmoryPanel() {
  const panel = document.querySelector('#armoryOverlay .panel') as HTMLElement | null;
  if (!panel) return;
  panel.classList.remove('is-hit');
  void panel.offsetWidth; // restart the animation
  panel.classList.add('is-hit');
}
document.querySelectorAll('[data-close-armory]').forEach(el => el.addEventListener('click', () => toggleArmory(false)));
armoryOverlay.addEventListener('mousedown', (e) => {
  if (e.target === armoryOverlay) {
    toggleArmory(false);
  }
});

const MAX_UPGRADE_LEVEL = 10;

function renderArmoryDOM() {
  if (!armoryOpen) return;
  const p = players[myId];
  if (!p) return;

  const credits = Math.floor(p.credits ?? 0);
  armoryCreditsVal.textContent = `$${fmtInt(credits)}`;

  const dmgLv = p.damageLevel || 0;
  const meleeLv = p.meleeLevel || 0;
  const dmgCost = 200 + dmgLv * 150;
  const meleeCost = 150 + meleeLv * 125;

  const slots = p.weaponSlots || [true, false, false, false];
  const weaponNames = ['Pistol', 'Uzi', 'Shotgun', 'Rocket'];
  const nextLockedIdx = slots.findIndex((unlocked, idx) => idx > 0 && !unlocked);
  const nextWeapon = nextLockedIdx !== -1 ? weaponNames[nextLockedIdx] : '';
  const unlockedCount = slots.filter(Boolean).length;

  const curMeleeDmg = Math.round(45 * (1 + meleeLv * 0.35));
  const nextMeleeDmg = Math.round(45 * (1 + (meleeLv + 1) * 0.35));
  const tac = p.tacticalItems || [0, 0, 0];

  // Order matches the number keys that buy them while the armory is open.
  // Every stat reads "Label current → next".
  const cards: {
    id: number; shortcut: string; icon: string; title: string; level: string;
    maxed: boolean; desc: string; stats: [string, string, string][]; cost: number;
  }[] = [
    {
      id: 1, shortcut: '1', icon: 'i-crosshair', title: 'Firearm power',
      level: `Level ${Math.min(dmgLv, MAX_UPGRADE_LEVEL)} / ${MAX_UPGRADE_LEVEL}`, maxed: dmgLv >= MAX_UPGRADE_LEVEL,
      desc: '+20% gun and explosive damage, +4% crit chance.',
      stats: [
        ['Bonus damage', `+${dmgLv * 20}%`, `+${(dmgLv + 1) * 20}%`],
        ['Crit chance', `${Math.min(60, 20 + dmgLv * 4)}%`, `${Math.min(60, 20 + (dmgLv + 1) * 4)}%`],
      ],
      cost: dmgCost,
    },
    {
      id: 5, shortcut: '2', icon: 'i-sword', title: 'Katana',
      level: `Level ${Math.min(meleeLv, MAX_UPGRADE_LEVEL)} / ${MAX_UPGRADE_LEVEL}`, maxed: meleeLv >= MAX_UPGRADE_LEVEL,
      desc: 'Harder, wider swings that heal you on each kill.',
      stats: [['Damage', `${curMeleeDmg}`, `${nextMeleeDmg}`]], cost: meleeCost,
    },
    {
      id: 2, shortcut: '3', icon: 'i-shield', title: 'Armor & medkit', level: 'Repeatable', maxed: false,
      desc: '+25 max health, and heals 60 right away.',
      stats: [['Max health', `${p.maxHealth}`, `${p.maxHealth + 25}`]], cost: 150,
    },
    {
      id: 3, shortcut: '4', icon: 'i-ammo', title: 'Bigger magazine', level: 'Repeatable', maxed: false,
      desc: '+25 ammo capacity, and refills your reserve.',
      stats: [['Ammo capacity', `${p.maxAmmo}`, `${p.maxAmmo + 25}`]], cost: 125,
    },
    {
      id: 4, shortcut: '5', icon: 'i-crate', title: 'Gear resupply', level: 'Repeatable', maxed: false,
      desc: '+2 of each placeable you drop from the hotbar.',
      stats: [
        ['Barrels', `${tac[0]}`, `${tac[0] + 2}`],
        ['Barricades', `${tac[1]}`, `${tac[1] + 2}`],
        ['Claymores', `${tac[2]}`, `${tac[2] + 2}`],
      ],
      cost: 140,
    },
    {
      id: 6, shortcut: '6', icon: nextLockedIdx !== -1 ? ['i-pistol', 'i-uzi', 'i-shotgun', 'i-rocket'][nextLockedIdx] : 'i-crosshair',
      title: nextWeapon ? `Unlock ${nextWeapon}` : 'Arsenal complete',
      level: `Guns ${unlockedCount} / 4`, maxed: nextLockedIdx === -1,
      desc: nextWeapon ? `Unlocks and equips the ${nextWeapon}. Shares your ammo.` : 'Every weapon is unlocked.',
      stats: [['Weapons', `${unlockedCount}`, `${unlockedCount + 1}`]], cost: 250,
    },
  ];

  armoryGrid.innerHTML = cards.map((c) => {
    const canBuy = !c.maxed && credits >= c.cost;
    const stats = c.stats.map(([label, cur, next]) =>
      `<span class="shop-stat"><span class="shop-stat-label">${label}</span> ${c.maxed ? cur : `${cur} → ${next}`}</span>`).join('');
    // The price sits on the card; the button says whether you can buy it, or how far off you are.
    let buy: string;
    if (c.maxed) {
      buy = `<button class="btn btn-sm shop-buy-btn maxed" disabled><svg class="icon"><use href="#i-check"/></svg><span>Maxed out</span></button>`;
    } else if (canBuy) {
      buy = `<button class="btn btn-sm shop-buy-btn btn-money-solid" data-upgrade-id="${c.id}"><span>Buy</span><kbd class="kbd">${c.shortcut}</kbd></button>`;
    } else {
      const pct = Math.round((credits / c.cost) * 100);
      buy = `<button class="btn btn-sm shop-buy-btn cant-buy" data-upgrade-id="${c.id}" disabled title="Not enough credits"><svg class="icon"><use href="#i-lock"/></svg><span>Need $${fmtInt(c.cost - credits)} more</span><kbd class="kbd">${c.shortcut}</kbd><span class="progress" style="width:${pct}%"></span></button>`;
    }
    const level = `<span class="badge">${c.level}</span>`;
    return `
      <div class="shop-card">
        <div class="shop-card-top">
          <span class="shop-icon"><svg class="icon"><use href="#${c.icon}"/></svg></span>
          <div>
            <div class="shop-title">${c.title}</div>
            <div class="shop-level">${level}${c.maxed ? '' : `<span class="shop-price${canBuy ? '' : ' shop-price--short'}">$${fmtInt(c.cost)}</span>`}</div>
          </div>
        </div>
        <p class="shop-desc">${c.desc}</p>
        <div class="shop-stat-row">${stats}</div>
        <div class="shop-buy">${buy}</div>
      </div>`;
  }).join('');

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
    const elapsed = serverPaused ? 0 : (now - created) / 1000;
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
  moveUp: 'Move up',
  moveDown: 'Move down',
  moveLeft: 'Move left',
  moveRight: 'Move right',
  shoot: 'Shoot',
  melee: 'Katana',
  dash: 'Dash',
  weapon1: 'Pistol',
  weapon2: 'Uzi',
  weapon3: 'Shotgun',
  weapon4: 'Rocket',
  placeBarrel: 'Place barrel',
  placeBarricade: 'Place barricade',
  placeMine: 'Place claymore',
  toggleShop: 'Open armory',
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
  if (code === 'Mouse0') return 'Left click';
  if (code === 'Mouse1') return 'Middle click';
  if (code === 'Mouse2') return 'Right click';
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
  serverPaused = false;
  roomHostId = null;
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

function triggerWaveBanner(title: string, subtitle: string, color = theme.accent) {
  waveBannerText = title;
  waveBannerSub = subtitle;
  waveBannerColor = color;
  waveBannerTimer = 3.2;
}

function connectToServer() {
  roomErrorMsg.textContent = '';
  currentRoomId = selectedRoomId;
  currentRoomName = rooms.find(r => r.id === currentRoomId)?.name ?? 'Arena';
  resetGameState();
  setScreen('playing');
  localStorage.setItem('boxhead_name', playerName);

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws`);

  ws.onopen = () => {
    ws!.send(JSON.stringify({ type: 'join', name: playerName, token: authToken || undefined, profileId: waveProfile, startingWave, roomId: currentRoomId }));
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data) as { type: string };

    if (data.type === 'joinError') {
      // The server refused the join (e.g. verified-only room); onclose returns to the menu.
      roomErrorMsg.textContent = (data as { type: string; error?: string }).error || 'Could not join that lobby';
      showMenuView('browser');
    } else if (data.type === 'room') {
      const room = data as { type: string; hostId: string | null; paused: boolean; roomName?: string };
      roomHostId = room.hostId;
      if (room.roomName) currentRoomName = room.roomName;
      if (serverPaused !== room.paused) {
        serverPaused = room.paused;
        input.up = input.down = input.left = input.right = input.shooting = input.melee = input.dash = false;
        input.placeItem = input.buyUpgrade = input.selectWeapon = 0;
        keysDown.clear();
        dashPending = false;
        dashActiveTimer = dashIframeTimer = 0;
        lastSentInput = '';
        toggleArmory(false);
      }
      renderRoomControls();
    } else if (data.type === 'init') {
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
        triggerWaveBanner(`Wave ${init.wave}`, 'Survive the horde', theme.accent);
        pushFeedEvent(`Joined ${currentRoomName} · Wave ${init.wave}`, theme.you);
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
      rememberWave(wave);
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

  const connection = ws;
  ws.onclose = () => {
    if (ws !== connection) return;
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
              spawnFloatingText(predictedX, predictedY - 18, `-${lost} HP`, theme.accent, 16);
              if (armoryOpen) flashArmoryPanel();
            } else if (diff.health > existing.health) {
              const gained = Math.round(diff.health - existing.health);
              healFlashAlpha = 0.35;
              spawnFloatingText(predictedX, predictedY - 18, `+${gained} HP`, theme.health, 15);
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
              spawnFloatingText(predictedX + 12, predictedY - 28, `+$${deltaCredits}`, theme.money, 14);
            }
            myShopStateChanged = true;
          }
          existing.credits = diff.credits;
        }
        if (diff.ammo !== undefined) {
          if (id === myId && diff.ammo > existing.ammo) {
            const gained = Math.round(diff.ammo - existing.ammo);
            spawnFloatingText(predictedX, predictedY - 26, `+${gained} ammo`, theme.text, 13);
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
            const weaponNames = ['Pistol', 'Uzi', 'Shotgun', 'Rocket'];
            for (let s = 1; s < 4; s++) {
              if (diff.weaponSlots[s] && !existing.weaponSlots[s]) {
                spawnFloatingText(predictedX, predictedY - 34, `Unlocked ${weaponNames[s]}`, theme.you, 16);
                pushFeedEvent(`Unlocked the ${weaponNames[s]}`, theme.you);
              }
            }
            myShopStateChanged = true;
          }
          existing.weaponSlots = diff.weaponSlots;
        }
        if (diff.combo !== undefined) {
          if (id === myId && diff.combo > existing.combo) {
            const c = diff.combo;
            if (c % 5 === 0) {
              // Milestone credits stack (server rules): every 5th kill +$35, every 10th +$60 more, every 15th +$100 more.
              const bonus = 35 + (c % 10 === 0 ? 60 : 0) + (c % 15 === 0 ? 100 : 0);
              pushFeedEvent(c === 10 ? `Overdrive! +$${bonus}, rapid fire` : `${c}× combo: +$${bonus}`, theme.money);
              spawnFloatingText(predictedX, predictedY - 38, c === 10 ? 'Overdrive: rapid fire' : `${c}× combo +$${bonus}`, theme.money, c >= 10 ? 17 : 15);
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
            spawnFloatingText(predictedX, predictedY - 36, `Firearm power level ${diff.damageLevel}`, theme.you, 16);
            pushFeedEvent(`Firearm power: level ${diff.damageLevel}`, theme.you);
            myShopStateChanged = true;
          }
          existing.damageLevel = diff.damageLevel;
        }
        if (diff.meleeLevel !== undefined) {
          if (id === myId && diff.meleeLevel > (existing.meleeLevel || 0)) {
            spawnFloatingText(predictedX, predictedY - 36, `Katana level ${diff.meleeLevel}`, theme.you, 16);
            pushFeedEvent(`Katana: level ${diff.meleeLevel}`, theme.you);
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
              isCrit ? `Crit -${dmg}` : `-${dmg}`,
              isCrit ? theme.money : theme.text,
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
        spawnFloatingText(z.pos.x, z.pos.y - 14, `-${dmg}`, theme.text, 15);
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
        const elapsed = serverPaused ? 0 : (now - created) / 1000;
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
          pushFeedEvent('Barrel detonated', theme.textSecondary);
        } else if (pl.type === 'mine') {
          spawnExplosion(pl.pos.x, pl.pos.y, 95, '#ffab00');
          pushFeedEvent('Claymore triggered', theme.textSecondary);
        }
      }
      placeableMap.delete(id);
    }
  }

  // Wave & Wave Break transitions
  if (delta.waveBreakTimer !== undefined) {
    if (waveBreakTimer <= 0 && delta.waveBreakTimer > 0) {
      // The server pays 100 + 30 per wave number for a clear.
      const clearBonus = 100 + wave * 30;
      triggerWaveBanner(`Wave ${wave} cleared`, `+$${clearBonus} · +25 HP · gear resupplied`, theme.text);
      pushFeedEvent(`Wave ${wave} cleared: +$${clearBonus}`, theme.money);
    }
    waveBreakTimer = delta.waveBreakTimer;
  }
  if (delta.wave !== undefined) {
    if (delta.wave > wave) {
      waveBreakTimer = 0;
      triggerWaveBanner(`Wave ${delta.wave}`, 'Hostiles inbound', theme.accent);
      pushFeedEvent(`Wave ${delta.wave} started`, theme.textSecondary);
    }
    wave = delta.wave;
    rememberWave(wave);
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
  if (code === 'KeyP' && !e.repeat && currentScreen === 'playing') {
    e.preventDefault(); requestPause(); return;
  }
  if (serverPaused) return;
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
  if (settingsListening || serverPaused) return;
  if ((e.target as HTMLElement).closest('#roomControls, #pauseOverlay, #armoryOverlay') || (e.target as HTMLElement).closest('#settingsOverlay')) {
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
    // Hotbar Dash slot
    if (
      e.clientX >= hotbarDashBtnRect.x &&
      e.clientX <= hotbarDashBtnRect.x + hotbarDashBtnRect.w &&
      e.clientY >= hotbarDashBtnRect.y &&
      e.clientY <= hotbarDashBtnRect.y + hotbarDashBtnRect.h
    ) {
      tryTriggerDash();
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
  if (serverPaused) return;
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
  if (currentScreen !== 'playing' || serverPaused) return;

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

    drawPlaceableSprite(ctx, pl, sx, sy, now);
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
    ctx.font = font(10, 700);
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

    drawDropSprite(ctx, d, sx, sy, now);
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

    const size = drawEnemySprite(ctx, z.type, sx, sy, angle);

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
    ctx.font = font(ft.size, 800);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.strokeText(ft.text, sx, sy);
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
      ctx.fillStyle = theme.accent;
      ctx.font = font(24, 700);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('\u2620', 0, 0);
      ctx.globalAlpha = 1;
      const displayName = p.name || p.id.slice(0, 6);
      ctx.fillStyle = theme.text;
      ctx.font = font(12, 700);
      ctx.fillText(displayName, 0, -24);
      ctx.fillStyle = theme.textSecondary;
      ctx.font = font(11, 600);
      ctx.fillText('Stand close to revive', 0, 22);
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

    drawGunSprite(ctx, p.weapon);

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
    ctx.font = font(12, 700);
    const tagW = ctx.measureText(displayName).width + 12;
    hudRoundRect(sx - tagW / 2, sy - 52, tagW, 17, 8.5);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fill();
    ctx.fillStyle = isMe ? theme.you : theme.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(displayName, sx, sy - 37);

    const maxHp = p.maxHealth || 100;
    const barW = 36;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(sx - barW / 2 - 1, sy - 32, barW + 2, 6);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(sx - barW / 2, sy - 31, barW, 4);
    ctx.fillStyle = p.health / maxHp > 0.3 ? theme.health : theme.accent;
    ctx.fillRect(sx - barW / 2, sy - 31, barW * Math.max(0, Math.min(1, p.health / maxHp)), 4);
    // Your dash charges, where you're looking.
    if (isMe) {
      for (let i = 0; i < DASH_MAX_CHARGES; i++) {
        ctx.beginPath();
        ctx.arc(sx - (DASH_MAX_CHARGES - 1) * 5 + i * 10, sy + 28, 3, 0, Math.PI * 2);
        if (i < dashCharges) {
          ctx.fillStyle = theme.you;
          ctx.fill();
        } else {
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = withAlpha(theme.text, 0.35);
          ctx.stroke();
        }
      }
    }
  }
}

// ============ HUD (canvas) ============
// Every panel uses the shared design tokens (theme.ts): one panel style, one
// type scale (11px caps labels, 12–13px details, 15–20px values) and the same
// color meanings as the menus (red = enemies/damage, green = health,
// gold = money, blue = you/selected, neutral = everything else).
// Layout: controls + combo top-left · wave top-center · squad + feed top-right ·
// vitals strip above the hotbar at the bottom · minimap bottom-right.
const HUD = {
  margin: 16,
  radius: 10,
  pad: 14,
  gap: 8,
  fill: withAlpha(theme.surface, 0.93),
  border: theme.border,
  track: 'rgba(255, 255, 255, 0.10)',
  /** Height of the HTML pause/settings buttons at the top-left. */
  controlsH: 40,
  sideW: 208,
};

type CtxWithTracking = CanvasRenderingContext2D & { letterSpacing?: string };
const fmtInt = (n: number) => Math.floor(n).toLocaleString('en-US');

function hudRoundRect(x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function hudPanel(x: number, y: number, w: number, h: number, opts: { fill?: string; border?: string; borderWidth?: number } = {}) {
  hudRoundRect(x + 0.5, y + 0.5, w - 1, h - 1, HUD.radius);
  ctx.fillStyle = opts.fill ?? HUD.fill;
  ctx.fill();
  ctx.lineWidth = opts.borderWidth ?? 1;
  ctx.strokeStyle = opts.border ?? HUD.border;
  ctx.stroke();
}

interface HudTextOpts {
  size?: number; weight?: number; color?: string; align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline; caps?: boolean; maxWidth?: number;
}

/** Draws text in the UI typeface; returns the drawn width. */
function hudText(text: string, x: number, y: number, o: HudTextOpts = {}): number {
  const c = ctx as CtxWithTracking;
  ctx.font = font(o.size ?? 13, o.weight ?? 600);
  ctx.fillStyle = o.color ?? theme.text;
  ctx.textAlign = o.align ?? 'left';
  ctx.textBaseline = o.baseline ?? 'alphabetic';
  const tracked = o.caps && 'letterSpacing' in c;
  if (tracked) c.letterSpacing = '0.08em';
  let s = o.caps ? text.toUpperCase() : text;
  if (o.maxWidth && ctx.measureText(s).width > o.maxWidth) {
    while (s.length > 1 && ctx.measureText(`${s}…`).width > o.maxWidth) s = s.slice(0, -1);
    s = `${s.trimEnd()}…`;
  }
  ctx.fillText(s, x, y);
  const width = ctx.measureText(s).width;
  if (tracked) c.letterSpacing = '0px';
  return width;
}

/** 12px uppercase label (the HUD's minimum text size). */
function hudLabel(text: string, x: number, y: number, align: CanvasTextAlign = 'left', color = theme.textSecondary): number {
  return hudText(text, x, y, { size: 13, weight: 700, color, align, caps: true });
}

function hudBar(x: number, y: number, w: number, h: number, pct: number, color: string) {
  hudRoundRect(x, y, w, h, h / 2);
  ctx.fillStyle = HUD.track;
  ctx.fill();
  const p = Math.max(0, Math.min(1, pct));
  if (p > 0) {
    hudRoundRect(x, y, Math.max(h, w * p), h, h / 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/** Keycap matching the HTML .kbd. `align` says which edge x is. Returns its width. */
function hudKeycap(label: string, x: number, y: number, align: 'left' | 'right' | 'center' = 'left', h = 18): number {
  ctx.font = font(11, 600);
  const w = Math.max(h, ctx.measureText(label).width + 10);
  const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
  hudRoundRect(left + 0.5, y + 0.5, w - 1, h - 1, 4);
  ctx.fillStyle = theme.surfaceRaised;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.borderStrong;
  ctx.stroke();
  hudText(label, left + w / 2, y + h / 2 + 0.5, { size: 11, weight: 600, color: theme.text, align: 'center', baseline: 'middle' });
  return w;
}

function hudTagWidth(text: string): number {
  ctx.font = font(11, 700);
  return ctx.measureText(text).width + 10;
}

/** Small rounded tag, e.g. "OVERDRIVE", "×2" or a price. Returns its width. */
function hudTag(text: string, xRight: number, y: number, color: string, o: { fill?: string; border?: string } = {}): number {
  ctx.font = font(11, 700);
  const w = ctx.measureText(text).width + 10;
  hudRoundRect(xRight - w + 0.5, y + 0.5, w - 1, 17, 8.5);
  ctx.fillStyle = o.fill ?? withAlpha(color, 0.16);
  ctx.fill();
  if (o.border) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = o.border;
    ctx.stroke();
  }
  hudText(text, xRight - w / 2, y + 13, { size: 11, weight: 700, color, align: 'center' });
  return w;
}

// Line icons for the hotbar (24px grid, 2px stroke), matching the HTML icon set.
const HOTBAR_ICONS: Record<string, Path2D> = {
  katana: new Path2D('M20 4l-1 5-9 9-4-4 9-9zM7 13l4 4M4.5 19.5 7 17'),
  pistol: new Path2D('M3 7h17v4h-8l-1.5 2.5H8L7 19H4l1-6.5L3 11z'),
  uzi: new Path2D('M3 8h17v4h-7v7h-3v-7H7l-1 3H3zM15 8V5'),
  shotgun: new Path2D('M2 10h20v3H9l-2 5H4l1-5H2z'),
  rocket: new Path2D('M2 9.5h14l5 2.5-5 2.5H2zM7 14.5V18'),
  barrel: new Path2D('M7 3h10v18H7zM7 8h10M7 16h10'),
  barricade: new Path2D('M3 8h18v8H3zM8 8l-3 8M13 8l-3 8M18 8l-3 8'),
  claymore: new Path2D('M4 17a8 7 0 0 1 16 0zM12 10V6M9 7l3-2 3 2'),
  armory: new Path2D('M5 8h14l-1 12H6zM9 8a3 3 0 0 1 6 0'),
  lock: new Path2D('M7 11h10v8H7zM9 11V8.5a3 3 0 0 1 6 0V11'),
  dash: new Path2D('M5 6l6 6-6 6M13 6l6 6-6 6'),
};

function drawIcon(icon: Path2D, cx: number, cy: number, size: number, color: string) {
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke(icon);
  ctx.restore();
}

function drawMinimap(state: GameState) {
  const pad = 8;
  const mmW = HUD.sideW - pad * 2;
  const mmH = mmW * (staticMapHeight / staticMapWidth);
  const panelW = mmW + pad * 2;
  const panelH = mmH + pad * 2;
  const px = canvas.width - HUD.margin - panelW;
  const py = canvas.height - HUD.margin - panelH;
  const mmX = px + pad;
  const mmY = py + pad;
  const scaleX = mmW / staticMapWidth;
  const scaleY = mmH / staticMapHeight;
  const dot = (x: number, y: number, size: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(mmX + x * scaleX - size / 2, mmY + y * scaleY - size / 2, size, size);
  };

  hudPanel(px, py, panelW, panelH);
  ctx.save();
  hudRoundRect(mmX, mmY, mmW, mmH, 6);
  ctx.clip();
  ctx.fillStyle = theme.field;
  ctx.fillRect(mmX, mmY, mmW, mmH);
  ctx.fillStyle = theme.borderStrong;
  for (const w of staticWalls) {
    ctx.fillRect(mmX + w.x * scaleX, mmY + w.y * scaleY, Math.max(1, w.w * scaleX), Math.max(1, w.h * scaleY));
  }
  for (let i = 0; i < staticAmmoSpawns.length; i++) {
    if (ammoAvailability.get(`ammo_${i}`)) dot(staticAmmoSpawns[i].x, staticAmmoSpawns[i].y, 3, theme.textSecondary);
  }
  for (const pl of state.placeables) dot(pl.pos.x, pl.pos.y, 3, theme.textMuted);
  for (const d of state.drops) dot(d.pos.x, d.pos.y, 3, d.type === 'health' ? theme.health : theme.textSecondary);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(mmX + camX * scaleX, mmY + camY * scaleY, canvas.width * scaleX, canvas.height * scaleY);

  for (const z of state.zombies) dot(z.pos.x, z.pos.y, 3, theme.accent);
  for (const id in state.players) {
    if (id !== myId) dot(state.players[id].pos.x, state.players[id].pos.y, 5, theme.text);
  }
  const me = state.players[myId];
  if (me) dot(me.pos.x, me.pos.y, 6, theme.you);
  ctx.restore();
}

/** Shared geometry for the hotbar and the vitals strip that sits on it. */
function hotbarLayout() {
  const gap = 6;
  const groupGap = 17;
  const fixed = gap * 6 + groupGap * 3;
  // Ten equal slots, centred between the status card (bottom left) and the minimap (bottom right).
  const room = canvas.width - 2 * (HUD.margin + HUD.sideW + 24);
  const slotW = Math.max(54, Math.min(78, Math.floor((room - fixed) / 10)));
  const slotH = 66;
  const totalW = slotW * 10 + fixed;
  return { slotW, slotH, gap, groupGap, totalW, x: Math.round((canvas.width - totalW) / 2), y: canvas.height - HUD.margin - slotH };
}

/** Height of the desktop status card (bottom left). */
const STATUS_CARD_H = 132;

/**
 * Vitals. Desktop: a status card in the bottom-left corner (health, ammo, credits)
 * that mirrors the minimap, so the bottom centre holds only the hotbar.
 * Touch screens keep a slim strip under the wave header.
 */
function drawHUD(state: GameState) {
  const p = state.players[myId];
  if (!p) return;
  if (isMobile) { drawVitalsStrip(p); return; }

  const w = HUD.sideW;
  const h = STATUS_CARD_H;
  const x = HUD.margin;
  const y = canvas.height - HUD.margin - h;
  const pad = HUD.pad;
  const right = x + w - pad;
  hudPanel(x, y, w, h);

  // Health: the heaviest element.
  const maxHp = p.maxHealth || 100;
  const hpPct = p.health / maxHp;
  const lowHp = hpPct <= 0.3;
  hudLabel('Health', x + pad, y + 30, 'left', lowHp ? theme.accent : theme.textSecondary);
  const hpTotalW = hudText(` / ${maxHp}`, right, y + 30, { size: 13, weight: 600, color: theme.textMuted, align: 'right' });
  hudText(`${Math.ceil(Math.max(0, p.health))}`, right - hpTotalW, y + 30, { size: 18, weight: 800, color: lowHp ? theme.accent : theme.text, align: 'right' });
  ctx.save();
  if (lowHp) ctx.globalAlpha = 0.65 + 0.35 * Math.sin(performance.now() / 120); // pulse when low
  hudBar(x + pad, y + 40, w - pad * 2, 10, hpPct, lowHp ? theme.accent : theme.health);
  ctx.restore();

  // Ammo: the pistol never runs dry, so it shows ∞; other guns get a thin bar.
  hudLabel('Ammo', x + pad, y + 78);
  if (p.weapon === 'pistol') {
    hudText('∞', right, y + 82, { size: 24, weight: 700, align: 'right' });
  } else {
    const maxAmmo = p.maxAmmo || 40;
    const ammoPct = p.ammo / maxAmmo;
    const lowAmmo = ammoPct <= 0.25;
    const ammoTotalW = hudText(` / ${maxAmmo}`, right, y + 78, { size: 13, weight: 600, color: theme.textMuted, align: 'right' });
    hudText(`${Math.floor(p.ammo)}`, right - ammoTotalW, y + 78, { size: 18, weight: 800, color: lowAmmo ? theme.accent : theme.text, align: 'right' });
    hudBar(x + pad, y + 86, w - pad * 2, 4, ammoPct, lowAmmo ? theme.accent : theme.textSecondary);
  }

  // Credits: what the armory spends.
  hudLabel('Credits', x + pad, y + 118);
  hudText(`$${fmtInt(p.credits ?? 0)}`, right, y + 118, { size: 18, weight: 800, color: theme.money, align: 'right' });
}

/** Touch layout: one slim strip under the wave header. */
function drawVitalsStrip(p: Player) {
  const h = 40;
  const w = Math.min(hotbarLayout().totalW, canvas.width - HUD.margin * 2);
  const x = Math.round((canvas.width - w) / 2);
  const y = HUD.margin + 66;
  const pad = HUD.pad;
  const base = y + 26;
  hudPanel(x, y, w, h);
  const inner = w - pad * 2;
  const ammoX = x + pad + Math.round(inner * 0.52);
  const creditsX = ammoX + Math.round(inner * 0.25);
  ctx.fillStyle = HUD.border;
  ctx.fillRect(ammoX - 12, y + 9, 1, h - 18);
  ctx.fillRect(creditsX - 12, y + 9, 1, h - 18);
  const maxHp = p.maxHealth || 100;
  const hpPct = p.health / maxHp;
  const lowHp = hpPct <= 0.3;
  const labelW = hudLabel('Health', x + pad, base - 1, 'left', lowHp ? theme.accent : theme.textSecondary);
  const valueRight = ammoX - 26;
  const totalW = hudText(` / ${maxHp}`, valueRight, base, { size: 13, weight: 600, color: theme.textMuted, align: 'right' });
  const valueW = hudText(`${Math.ceil(Math.max(0, p.health))}`, valueRight - totalW, base, { size: 18, weight: 800, color: lowHp ? theme.accent : theme.text, align: 'right' });
  const barX = x + pad + labelW + 12;
  hudBar(barX, y + h / 2 - 5, valueRight - totalW - valueW - 14 - barX, 10, hpPct, lowHp ? theme.accent : theme.health);
  const ammoLabelW = hudLabel('Ammo', ammoX, base - 1);
  if (p.weapon === 'pistol') {
    hudText('∞', ammoX + ammoLabelW + 12, base + 2, { size: 24, weight: 700 });
  } else {
    const vw = hudText(`${Math.floor(p.ammo)}`, ammoX + ammoLabelW + 12, base, { size: 18, weight: 800 });
    hudText(` / ${p.maxAmmo || 40}`, ammoX + ammoLabelW + 12 + vw, base, { size: 13, weight: 600, color: theme.textMuted });
  }
  const creditsLabelW = hudLabel('Credits', creditsX, base - 1);
  hudText(`$${fmtInt(p.credits ?? 0)}`, creditsX + creditsLabelW + 12, base, { size: 18, weight: 800, color: theme.money });
}

function drawWaveHeader(state: GameState) {
  const w = 340;
  const x = Math.round((canvas.width - w) / 2);
  const y = HUD.margin;
  const pad = HUD.pad;
  const onBreak = state.waveBreakTimer > 0;
  hudPanel(x, y, w, onBreak ? 84 : 58);

  if (onBreak) {
    hudText(`Wave ${state.wave} cleared`, x + pad, y + 27, { size: 16, weight: 800, caps: true });
    hudText(`Next wave in ${Math.ceil(state.waveBreakTimer)}s`, x + w - pad, y + 27, { size: 13, weight: 700, color: theme.textSecondary, align: 'right' });
    hudBar(x + pad, y + 37, w - pad * 2, 8, state.waveBreakTimer / WAVE_BREAK_DURATION, theme.textSecondary);
    // "[B] Open the armory", centered
    const hint = 'Open the armory';
    const keyLabel = keyDisplayName(bindings.toggleShop);
    ctx.font = font(12, 600);
    const hintW = ctx.measureText(hint).width;
    ctx.font = font(11, 700);
    const keyW = Math.max(18, ctx.measureText(keyLabel).width + 10);
    const startX = x + (w - (keyW + 8 + hintW)) / 2;
    hudKeycap(keyLabel, startX, y + 55, 'left');
    hudText(hint, startX + keyW + 8, y + 68, { size: 12, weight: 600, color: theme.textSecondary });
  } else {
    const target = Math.max(1, state.waveTarget);
    // Progress counts up, and the bar fills as the squad's kills land.
    const kills = Math.min(target, Math.max(0, state.waveKills));
    hudText(`Wave ${state.wave}`, x + pad, y + 27, { size: 16, weight: 800, caps: true });
    const unitW = hudText(` / ${target} kills`, x + w - pad, y + 27, { size: 13, weight: 600, color: theme.textSecondary, align: 'right' });
    hudText(`${kills}`, x + w - pad - unitW, y + 27, { size: 16, weight: 800, align: 'right' });
    ctx.save();
    if (target - kills <= 3) ctx.globalAlpha = 0.7 + 0.3 * Math.sin(performance.now() / 150); // almost cleared
    hudBar(x + pad, y + 37, w - pad * 2, 8, kills / target, theme.text);
    ctx.restore();
  }
}

function drawComboHUD(state: GameState) {
  const p = state.players[myId];
  // A combo starts paying out at ×2, so there is nothing to show before then.
  if (!p || !p.combo || p.combo < 2) return;

  const x = HUD.margin;
  const y = HUD.margin + HUD.controlsH + HUD.gap;
  const w = 260;
  const h = 64;
  const pad = HUD.pad;
  const overdrive = p.combo >= 10;
  const bonus = Math.round((Math.min(5.0, 1.0 + (p.combo - 1) * 0.2) - 1) * 100);
  hudPanel(x, y, w, h, { border: overdrive ? theme.money : HUD.border });

  const labelW = hudLabel('Combo', x + pad, y + 22);
  hudText(`×${p.combo}`, x + pad + labelW + 6, y + 22, { size: 13, weight: 800 });
  if (overdrive) hudTag('OVERDRIVE', x + w - pad, y + 9, theme.money);
  const bonusW = hudText(`+${bonus}%`, x + pad, y + 46, { size: 20, weight: 800, color: theme.money });
  hudText('rewards', x + pad + bonusW + 6, y + 46, { size: 12, weight: 600, color: theme.textSecondary });
  hudBar(x + pad, y + 53, w - pad * 2, 4, (p.comboTimer || 0) / COMBO_DURATION, theme.money);
}

/**
 * Teammates off screen: a name chip pinned to the edge of a safe frame (clear of
 * every HUD panel), with a chevron pointing toward them. Red while they're downed.
 */
function drawTeammateMarkers(state: GameState) {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const top = HUD.margin + 92;
  const bottom = canvas.height - HUD.margin - (isMobile ? 0 : STATUS_CARD_H) - 30;
  const left = HUD.margin + 24;
  const right = canvas.width - HUD.margin - 24;
  // Side panels the chips must also clear (x, y, w, h): squad list, minimap, combo meter.
  const squadH = 38 + Object.keys(state.players).length * 30 + 4;
  const mapH = (HUD.sideW - 16) * (staticMapHeight / staticMapWidth) + 16;
  const sideX = canvas.width - HUD.margin - HUD.sideW;
  const avoid: [number, number, number, number][] = [
    [sideX, HUD.margin, HUD.sideW, squadH],
    [sideX, canvas.height - HUD.margin - mapH, HUD.sideW, mapH],
    [HUD.margin, HUD.margin + HUD.controlsH + HUD.gap, 260, 64],
  ];
  for (const id in state.players) {
    if (id === myId) continue;
    const p = state.players[id];
    const sx = p.pos.x - camX;
    const sy = p.pos.y - camY;
    if (sx >= 0 && sx <= canvas.width && sy >= 0 && sy <= canvas.height) continue;
    const dx = sx - cx;
    const dy = sy - cy;
    const t = Math.min(
      (dx > 0 ? right - cx : cx - left) / Math.max(1e-6, Math.abs(dx)),
      (dy > 0 ? bottom - cy : cy - top) / Math.max(1e-6, Math.abs(dy)),
    );
    const mx = cx + dx * t;
    let my = cy + dy * t;
    for (const [rx, ry, rw, rh] of avoid) {
      if (mx > rx - 60 && mx < rx + rw + 60 && my > ry - 20 && my < ry + rh + 20) my = my < cy ? ry + rh + 26 : ry - 26;
    }
    const angle = Math.atan2(sy - my, sx - mx);
    const down = p.health <= 0;
    const color = down ? theme.accent : theme.text;

    const name = p.name || p.id.slice(0, 6);
    ctx.font = font(12, 700);
    const w = ctx.measureText(name).width + 38;
    const h = 24;
    const lx = Math.max(left - 16, Math.min(right + 16 - w, mx - w / 2));
    const ly = Math.max(top - 16, Math.min(bottom + 16 - h, my - h / 2));
    hudPanel(lx, ly, w, h, { fill: theme.surface, border: down ? theme.accent : theme.borderStrong });
    // A chevron inside the chip points the way.
    ctx.save();
    ctx.translate(lx + 15, ly + h / 2);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(-3, -5);
    ctx.lineTo(3, 0);
    ctx.lineTo(-3, 5);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();
    hudText(name, lx + 28, ly + 16, { size: 12, weight: 700, color });
  }
}

/** A soft shade behind the bottom bar keeps it readable over a busy floor. */
function drawHudBackdrop() {
  const h = 180;
  const g = ctx.createLinearGradient(0, canvas.height - h, 0, canvas.height);
  g.addColorStop(0, 'rgba(0, 0, 0, 0)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
  ctx.fillStyle = g;
  ctx.fillRect(0, canvas.height - h, canvas.width, h);
}

function drawWaveBanner(dt: number) {
  if (waveBannerTimer <= 0 || serverPaused) return;
  waveBannerTimer -= dt;

  // Full strength, then a quick fade: in over 0.15 s, out over the last 0.3 s.
  const alpha = waveBannerTimer < 0.3 ? waveBannerTimer / 0.3 : Math.min(1, (3.2 - waveBannerTimer) / 0.15);
  const cy = Math.round(canvas.height * 0.26);

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(0, cy - 46, canvas.width, 92);
  hudText(waveBannerText, canvas.width / 2, cy + 8, { size: 42, weight: 900, color: waveBannerColor, align: 'center', caps: true });
  hudText(waveBannerSub, canvas.width / 2, cy + 32, { size: 13, weight: 700, color: theme.text, align: 'center', caps: true });
  ctx.restore();
}

interface HotbarSlot {
  key: string;
  icon: Path2D;
  name: string;
  /** Corner tag: a count like "×2", or the active gun's ammo. */
  tag?: string;
  /** Charges shown as dots in the corner (Dash). */
  pips?: { filled: number; total: number };
  /** Selected (equipped weapon, swinging katana, dashing): blue fill and border. */
  active?: boolean;
  /** Its panel is open (Armory): blue outline only, so it isn't mistaken for the equipped weapon. */
  open?: boolean;
  disabled?: boolean;
  locked?: boolean;
  /** 0–1 cooldown, drawn as a fill that drains from the top. */
  cooldown?: number;
}

function drawHotbarSlot(x: number, y: number, w: number, h: number, s: HotbarSlot) {
  // Locked weapons are dashed tiles: visibly not yours yet.
  if (s.locked) ctx.setLineDash([5, 4]);
  hudPanel(x, y, w, h, {
    fill: s.active ? withAlpha(theme.you, 0.16) : HUD.fill,
    border: s.active || s.open ? theme.you : s.locked ? theme.borderStrong : HUD.border,
    borderWidth: s.active || s.open ? 2 : 1,
  });
  ctx.setLineDash([]);
  if (s.cooldown && s.cooldown > 0) {
    ctx.save();
    hudRoundRect(x, y, w, h, HUD.radius);
    ctx.clip();
    ctx.fillStyle = withAlpha(theme.you, 0.18);
    ctx.fillRect(x, y + h * (1 - s.cooldown), w, h * s.cooldown);
    ctx.restore();
  }
  const dim = !!(s.locked || s.disabled);
  ctx.save();
  if (dim) ctx.globalAlpha = 0.4;
  hudKeycap(s.key, x + 6, y + 6);
  if (s.pips) {
    for (let i = 0; i < s.pips.total; i++) {
      const cx = x + w - 10 - (s.pips.total - 1 - i) * 11;
      ctx.beginPath();
      ctx.arc(cx, y + 15, 3.5, 0, Math.PI * 2);
      if (i < s.pips.filled) {
        ctx.fillStyle = theme.you;
        ctx.fill();
      } else {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = theme.borderStrong;
        ctx.stroke();
      }
    }
  } else if (s.tag && !s.locked) {
    hudTag(s.tag, x + w - 6, y + 6, theme.text);
  }
  drawIcon(s.icon, x + w / 2, y + 37, 30, s.active ? theme.you : theme.text);
  ctx.restore();
  // The padlock sits in the corner where counts go, at full strength.
  if (s.locked) drawIcon(HOTBAR_ICONS.lock, x + w - 15, y + 15, 16, theme.textSecondary);
  // Names stay readable on dimmed slots.
  hudText(s.name, x + w / 2, y + 60, { size: 13, weight: 700, color: dim ? theme.textMuted : theme.text, align: 'center', maxWidth: w - 8 });
}

function drawWeaponAndTacticalBar(state: GameState) {
  const p = state.players[myId];
  if (!p) return;

  const { slotW, slotH, gap, groupGap, x: barX, y: barY } = hotbarLayout();
  let x = barX;
  const groupDivider = () => {
    ctx.fillStyle = HUD.border;
    ctx.fillRect(Math.round(x - groupGap / 2), barY + 12, 1, slotH - 24);
  };

  // Katana (melee)
  hotbarMeleeBtnRect = { x, y: barY, w: slotW, h: slotH };
  drawHotbarSlot(x, barY, slotW, slotH, {
    key: keyDisplayName(bindings.melee), icon: HOTBAR_ICONS.katana, name: 'Katana',
    active: meleeSwingTime > 0, cooldown: meleeCooldownTimer / MELEE_COOLDOWN,
  });
  x += slotW + gap;

  // Dash: one dot per charge; the fill drains as the next charge comes back.
  hotbarDashBtnRect = { x, y: barY, w: slotW, h: slotH };
  drawHotbarSlot(x, barY, slotW, slotH, {
    key: keyDisplayName(bindings.dash), icon: HOTBAR_ICONS.dash, name: 'Dash',
    pips: { filled: dashCharges, total: DASH_MAX_CHARGES },
    active: dashIframeTimer > 0, disabled: dashCharges === 0,
    cooldown: dashCharges < DASH_MAX_CHARGES ? dashRechargeTimer / DASH_RECHARGE_TIME : 0,
  });
  x += slotW + groupGap;
  groupDivider();

  // Firearms (1–4); the equipped one shows its ammo in the corner.
  const weapons = ['pistol', 'uzi', 'shotgun', 'rocketLauncher'];
  const names = ['Pistol', 'Uzi', 'Shotgun', 'Rocket'];
  const icons = [HOTBAR_ICONS.pistol, HOTBAR_ICONS.uzi, HOTBAR_ICONS.shotgun, HOTBAR_ICONS.rocket];
  const weaponKeys = [bindings.weapon1, bindings.weapon2, bindings.weapon3, bindings.weapon4];
  const slots = p.weaponSlots || [true, false, false, false];
  hotbarWeaponRects = [];
  for (let i = 0; i < 4; i++) {
    hotbarWeaponRects.push({ slot: i + 1, x, y: barY, w: slotW, h: slotH });
    const equipped = p.weapon === weapons[i];
    drawHotbarSlot(x, barY, slotW, slotH, {
      key: keyDisplayName(weaponKeys[i]), icon: icons[i], name: names[i], active: equipped, locked: !slots[i],
      tag: equipped ? (weapons[i] === 'pistol' ? '∞' : `${Math.floor(p.ammo)}`) : undefined,
    });
    x += slotW + gap;
  }
  x += groupGap - gap;
  groupDivider();

  // Gear (barrel, barricade, claymore) with a count in the corner
  const tacItems = p.tacticalItems || [0, 0, 0];
  const tacLabels = ['Barrel', 'Barricade', 'Claymore'];
  const tacIcons = [HOTBAR_ICONS.barrel, HOTBAR_ICONS.barricade, HOTBAR_ICONS.claymore];
  const tacKeys = [bindings.placeBarrel, bindings.placeBarricade, bindings.placeMine];
  hotbarTacticalRects = [];
  for (let t = 0; t < 3; t++) {
    hotbarTacticalRects.push({ item: t + 1, x, y: barY, w: slotW, h: slotH });
    const count = tacItems[t] || 0;
    drawHotbarSlot(x, barY, slotW, slotH, {
      key: keyDisplayName(tacKeys[t]), icon: tacIcons[t], name: tacLabels[t], tag: `×${count}`, disabled: count === 0,
    });
    x += slotW + gap;
  }
  x += groupGap - gap;
  groupDivider();

  // Armory
  hotbarArmoryBtnRect = { x, y: barY, w: slotW, h: slotH };
  drawHotbarSlot(x, barY, slotW, slotH, {
    key: keyDisplayName(bindings.toggleShop), icon: HOTBAR_ICONS.armory, name: 'Armory', open: armoryOpen,
  });
}

/** Squad status: name, health and score columns, so you can see who needs help. */
function drawScoreboardAndFeed(state: GameState) {
  const playerList = Object.values(state.players).sort((a, b) => b.score - a.score);
  if (playerList.length === 0) return;

  const rowH = 30;
  const headH = 38;
  const pad = 12;
  const w = isMobile ? 200 : HUD.sideW;
  const h = headH + playerList.length * rowH + 4;
  const x = canvas.width - HUD.margin - w;
  const y = HUD.margin;
  const scoreColW = 40;
  const healthColW = 48;
  const healthX = x + w - pad - scoreColW - 10 - healthColW;
  hudPanel(x, y, w, h);
  hudLabel('Player', x + pad, y + 24);
  hudLabel('HP', healthX, y + 24);
  hudLabel('Score', x + w - pad, y + 24, 'right');
  ctx.fillStyle = HUD.border;
  ctx.fillRect(x + 1, y + headH - 4, w - 2, 1);

  for (let i = 0; i < playerList.length; i++) {
    const p = playerList[i];
    const ry = y + headH + i * rowH;
    const isMe = p.id === myId;
    const down = p.health <= 0;
    if (isMe) {
      hudRoundRect(x + 4, ry, w - 8, rowH - 4, 6);
      ctx.fillStyle = withAlpha(theme.you, 0.14);
      ctx.fill();
      ctx.fillStyle = theme.you;
      ctx.fillRect(x + 4, ry + 5, 3, rowH - 14);
    }
    hudText(p.name || p.id.slice(0, 6), x + pad, ry + 18, {
      size: 13, weight: isMe ? 700 : 600, color: down ? theme.textMuted : isMe ? theme.you : theme.text, maxWidth: healthX - 8 - (x + pad),
    });
    if (down) {
      hudTag('DOWN', healthX + hudTagWidth('DOWN'), ry + 4, theme.accent);
    } else {
      const hpPct = p.health / (p.maxHealth || 100);
      hudBar(healthX, ry + 9, healthColW, 6, hpPct, hpPct <= 0.3 ? theme.accent : theme.health);
    }
    hudText(fmtInt(p.score), x + w - pad, ry + 18, { size: 13, weight: 700, color: down ? theme.textMuted : theme.text, align: 'right' });
  }

  // Event feed below the squad panel (hidden while paused)
  const now = performance.now();
  for (let i = eventFeed.length - 1; i >= 0; i--) {
    if ((now - eventFeed[i].time) / 1000 > 6) eventFeed.splice(i, 1);
  }
  if (serverPaused) return;
  let feedY = y + h + HUD.gap;
  for (const ev of eventFeed) {
    const age = (now - ev.time) / 1000;
    ctx.save();
    ctx.globalAlpha = Math.max(0, age > 4.5 ? 1 - (age - 4.5) / 1.5 : 1);
    hudPanel(x, feedY, w, 30);
    hudRoundRect(x + 8, feedY + 9, 3, 12, 1.5);
    ctx.fillStyle = ev.color;
    ctx.fill();
    hudText(ev.text, x + 18, feedY + 19, { size: 12, weight: 600, maxWidth: w - 26 });
    ctx.restore();
    feedY += 30 + 6;
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
    ctx.font = font(10, 700);
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
  ctx.font = font(11, 700);
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
  ctx.font = font(10, 700);
  ctx.fillText('WEAPON', weapX, weapY - 5);
  ctx.font = font(10, 600);
  ctx.fillText('▶▶', weapX, weapY + 9);
}

// Death recap: who downed you and the last hits, shown while downed and on game over.
const deathRecap = document.createElement('section');
deathRecap.id = 'deathRecap';
deathRecap.className = 'recap';
let recapKey = '';
let recapShowAll = false;
const RECAP_ROWS = 3;
function updateDeathRecap() {
  const player = players[myId];
  const visible = player && player.health <= 0 && (currentScreen === 'playing' || currentScreen === 'gameover');
  deathRecap.hidden = !visible;
  if (!visible) { recapKey = ''; recapShowAll = false; return; }
  if (armoryOpen) toggleArmory(false);
  const over = currentScreen === 'gameover';
  const parent = over ? document.getElementById('gameOverDetails')! : document.body;
  if (deathRecap.parentElement !== parent) parent.appendChild(deathRecap);
  deathRecap.classList.toggle('recap--floating', !over);
  const hits = player.damageLog || [];
  const key = `${over}|${JSON.stringify(hits)}|${recapShowAll}`;
  if (key === recapKey) return;
  recapKey = key;

  const name = (type: string) => type.charAt(0).toUpperCase() + type.slice(1);
  const last = hits[hits.length - 1];
  const title = document.createElement('p');
  title.className = 'recap-title';
  if (last) {
    title.append(over ? 'Killed by ' : 'Downed by ');
    const killer = document.createElement('b');
    killer.textContent = name(last.source);
    title.append(killer, ' (melee)');
  } else {
    title.textContent = over ? 'Killed' : 'Downed';
  }
  deathRecap.replaceChildren(title);
  if (!last) return;

  const table = document.createElement('table');
  table.className = 'recap-table';
  const head = table.createTHead().insertRow();
  for (const label of ['Time', 'Enemy', 'Damage', 'HP left']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  const rows = [...hits].reverse();
  for (const hit of recapShowAll ? rows : rows.slice(0, RECAP_ROWS)) {
    const tr = body.insertRow();
    const time = tr.insertCell();
    time.textContent = hit === last ? 'Final hit' : `${(last.time - hit.time).toFixed(1)}s before`;
    for (const text of [name(hit.source), `${hit.damage}`, `${Math.max(0, Math.round(hit.healthAfter))}`]) tr.insertCell().textContent = text;
  }
  deathRecap.append(table);
  if (rows.length > RECAP_ROWS) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'link recap-more';
    more.setAttribute('aria-expanded', String(recapShowAll));
    more.append(recapShowAll ? 'Show fewer' : `Show all ${rows.length} hits`, svgIcon('i-chevron'));
    more.addEventListener('click', () => { recapShowAll = !recapShowAll; recapKey = ''; updateDeathRecap(); });
    deathRecap.append(more);
  }
}

function draw() {
  const now = performance.now();
  const frameDt = Math.min(0.1, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  drainDeltaQueue();
  const dt = serverPaused ? 0 : frameDt;
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

      drawHudBackdrop();
      if (!isMobile) drawMinimap(state);
      drawHUD(state);
      drawWaveHeader(state);
      drawComboHUD(state);
      drawScoreboardAndFeed(state);
      if (!isMobile) drawWeaponAndTacticalBar(state);
      drawTeammateMarkers(state);
      drawWaveBanner(dt);
      drawMobileControls();
    } else {
      ctx.fillStyle = theme.textSecondary;
      ctx.font = font(18, 600);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`Joining ${currentRoomName}…`, canvas.width / 2, canvas.height / 2);
    }
  }

  requestAnimationFrame(draw);
}

draw();
