import '@fontsource/barlow/400.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '@fontsource/share-tech-mono/400.css';
import { drawEnemySprite, drawPlaceableSprite, drawDropSprite, drawGunSprite, drawNestSprite, drawCrateSprite, drawExtractZone } from './sprites';
import { HideoutView, keyStat } from './hideout';
import { Presence } from './presence';
import {
  Hideout, MapSummary, RARITY_COLOR, RARITY_LABEL, KIND_LABEL, KIND_ICON, EXTRACT_TIME, CAMP_LIMIT, CAMP_WARNING,
  weaponDamageMult, formatClock, formatDistance, nearest, compass, threatLevel, raidTitle, swapCandidate, backpackValue, enemyName, itemEffect,
  deployRiskText, campWarningText, itemsValue, DECRYPT_SECS, isEncrypted, estimatedValue,
} from './raid';
import { COMBO_MAX_MULT } from './constants';
import { theme, withAlpha, font } from './theme';
import {
  RoomInfo, Friend, Matchmaking, OPEN_ROOM_ID, resolveSelectedRoom, roomStatusText,
  matchmakingText, sortFriends, friendsSummary, friendLabel, friendDetail, FriendIdentity, roomsForMap,
  ServerInfo, buildLabel, safeLink, signInIntro,
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
  Item,
  ExtractPoint,
  Point,
  MapInfo,
  RaidEnd,
} from './generated/types';
import {
  WEAPON_STATS,
  PLAYER_SPEED,
  PLAYER_RADIUS,
  DASH_SPEED_MULT,
  DASH_DURATION,
  DASH_MAX_CHARGES,
  DASH_RECHARGE_TIME,
  COMBO_DURATION,
  MELEE_COOLDOWN,
  MELEE_RANGE,
} from './constants';

// Local composite type for rendering
interface GameState {
  players: Record<string, Player>;
  zombies: Zombie[];
  bullets: Bullet[];
  placeables: Placeable[];
  walls: Wall[];
  ammoPickups: { id: string; pos: { x: number; y: number }; amount: number; respawnAt: number }[];
  mapWidth: number;
  mapHeight: number;
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
let mapOpen = false;
let hotbarMeleeBtnRect = { x: 0, y: 0, w: 0, h: 0 };
let hotbarMapBtnRect = { x: 0, y: 0, w: 0, h: 0 };
let hotbarDashBtnRect = { x: 0, y: 0, w: 0, h: 0 };
let hotbarWeaponRects: { slot: number; x: number; y: number; w: number; h: number }[] = [];
let hotbarTacticalRects: { item: number; x: number; y: number; w: number; h: number }[] = [];

function addScreenShake(intensity: number) {
  screenShakeAmount = Math.min(22, Math.max(screenShakeAmount, intensity));
}

function pushFeedEvent(text: string, color = theme.textSecondary) {
  eventFeed.unshift({ text, color, time: performance.now() });
  if (eventFeed.length > 4) eventFeed.pop();
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
const operatorCallsign = document.getElementById('operatorCallsign')!;
const emailInputEl = document.getElementById('emailInput') as HTMLInputElement;
const emailPassEl = document.getElementById('emailPassInput') as HTMLInputElement;
const bskyHandleEl = document.getElementById('bskyHandleInput') as HTMLInputElement;
const bskyPassEl = document.getElementById('bskyPassInput') as HTMLInputElement;
const addFriendEl = document.getElementById('addFriendInputEl') as HTMLInputElement;

const mainMenuOverlay = document.getElementById('mainMenuOverlay')!;
const friendsOverlay = document.getElementById('friendsOverlay')!;
const resultsOverlay = document.getElementById('resultsOverlay')!;

const emailLoginBtn = document.getElementById('emailLoginBtn')!;
const emailRegisterBtn = document.getElementById('emailRegisterBtn')!;
const bskyLoginBtn = document.getElementById('bskyLoginBtn')!;
const googleLoginBtn = document.getElementById('googleLoginBtn')!;
const logoutBtn = document.getElementById('logoutBtn')!;
const playBtn = document.getElementById('playBtn')!;
const playAgainBtn = document.getElementById('resultsDeployBtn')!;
const friendsBtn = document.getElementById('friendsBtn')!;
const closeFriendsBtn = document.getElementById('closeFriendsBtn')!;
const addFriendBtn = document.getElementById('addFriendBtn')!;
const backToMenuBtn = document.getElementById('resultsHideoutBtn')!;

const signInBtn = document.getElementById('signInBtn')!;
const authSectionIn = document.getElementById('authSectionIn')!;
const loggedInStatus = document.getElementById('loggedInStatus')!;
const loginErrorMsg = document.getElementById('loginErrorMsg')!;

const friendsListContainer = document.getElementById('friendsListContainer')!;
const homeFriendsList = document.getElementById('homeFriendsList')!;
const homeFriendsSummary = document.getElementById('homeFriendsSummary')!;
const addFriendErrorMsg = document.getElementById('addFriendErrorMsg')!;

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// --- Servers (rooms) ---
// Every lobby is hosted by the game server. Players are matched by the platform
// they signed in with (Steam, Bluesky, or email/Google) unless they turn on
// cross-platform play. The server only lists, and only admits, the player's own
// pool; the UI just reflects what it reports.
let rooms: RoomInfo[] = [];
let matchmaking: Matchmaking | null = null;
let selectedRoomId = localStorage.getItem('boxhead_room') || OPEN_ROOM_ID;
/** The map chosen on the deploy screen; the lobby list shows only its raids. */
let deployMapId = localStorage.getItem('boxhead_map') || 'outskirts';
let currentRoomId = selectedRoomId;
let currentRoomName = 'Arena';
const roomListEl = document.getElementById('roomList')!;
roomListEl.addEventListener('scroll', () => updateRoomListFade(roomListEl), { passive: true });
const deployBtn = document.getElementById('deployBtn') as HTMLButtonElement;
const deployLabel = document.getElementById('deployLabel')!;
const mapListEl = document.getElementById('mapList')!;
const crossplayToggle = document.getElementById('crossplayToggle') as HTMLInputElement;
const crossplayStatus = document.getElementById('crossplayStatus')!;
const poolLabelEl = document.getElementById('poolLabel')!;
const roomErrorMsg = document.getElementById('roomErrorMsg')!;
const roomNameInput = document.getElementById('roomNameInput') as HTMLInputElement;

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
  item.title = room.canJoin ? `Select ${room.name} (double-click to deploy)` : 'Sign in to join';
  const title = document.createElement('span');
  title.className = 'room-title';
  if (!room.canJoin) title.append(svgIcon('i-lock'));
  const name = document.createElement('span');
  name.className = 'room-name';
  name.textContent = room.name;
  title.append(name);
  // Badges: who can join (the matchmaking pool), then Official for lobbies the server runs.
  const kind = document.createElement('span');
  kind.className = 'badge badge--pool';
  kind.append(svgIcon(room.pool.id === 'cross' ? 'i-globe' : 'i-users'), room.pool.label);
  title.append(kind);
  if (room.permanent) {
    const official = document.createElement('span');
    official.className = 'badge badge--strong';
    official.title = 'Run by the game server; always available';
    official.append(svgIcon('i-star'), 'Official');
    title.append(official);
  }
  // Status: a dot (filled = a raid is running, hollow = empty) and one line of text.
  const meta = document.createElement('span');
  meta.className = 'room-meta' + (room.players > 0 ? ' room-meta--live' : '');
  const dot = document.createElement('span');
  dot.className = 'status-dot ' + (room.players > 0 ? 'live' : 'idle');
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

/** Current gear score and map list, from the last hideout load. */
function currentMap(): MapSummary | undefined { return hideoutView.state?.maps.find(m => m.id === deployMapId); }

function renderRooms() {
  hideoutView.renderMaps(mapListEl, deployMapId, (m) => {
    deployMapId = m.id;
    localStorage.setItem('boxhead_map', m.id);
    selectedRoomId = resolveSelectedRoom(rooms, '', m.id);
    renderRooms();
  });
  const mapRooms = roomsForMap(rooms, deployMapId);
  // Fall back to the public raid on this map if the remembered one vanished or is locked.
  selectedRoomId = resolveSelectedRoom(rooms, selectedRoomId, deployMapId);
  renderMatchmaking();

  // Raids with players first, so running ones are easy to find.
  const shown = mapRooms.slice().sort((a, b) => b.players - a.players);
  renderRoomList(roomListEl, shown, 'No raids on this map yet');
  const selected = rooms.find(r => r.id === selectedRoomId);
  const map = currentMap();
  const locked = !!map && !map.unlocked;
  const gs = hideoutView.state?.gearScore ?? 0;
  const fee = map?.entryFee ?? 0;
  const broke = (hideoutView.state?.cash ?? 0) < fee;
  const inRaid = !!hideoutView.state?.inRaid;
  const noOperator = !!hideoutView.state?.needsOperator;
  deployBtn.disabled = locked || !selected || inRaid || broke || noOperator;
  deployLabel.textContent = noOperator ? 'Create an operator in the hideout first' : inRaid ? 'Already deployed' : locked ? `Needs gear score ${map!.minGearScore}` : broke ? `Entry fee $${fmtInt(fee)}: not enough cash`
    : selected ? `Deploy · ${selected.name}${fee ? ` · $${fmtInt(fee)}` : ''}` : 'Deploy';
  deployBtn.title = locked ? `Your gear score is ${gs}. Equip better gear in the hideout.` : broke ? 'Sell loot at the trader to raise the entry fee.' : '';
  // Insurance: a share of the loadout's value, refunded never; returns the gear if you die.
  const insureCost = hideoutView.state?.insuranceCost ?? 0;
  const insureToggle = document.getElementById('insureToggle') as HTMLInputElement;
  const canInsure = insureCost > 0 && (hideoutView.state?.cash ?? 0) >= fee + insureCost;
  insureToggle.disabled = !canInsure;
  if (!canInsure) insureToggle.checked = false;
  document.getElementById('insureText')!.textContent = insureCost > 0
    ? `Insure my loadout · $${fmtInt(insureCost)}${canInsure ? '' : ' (not enough cash)'}`
    : 'Insure my loadout (nothing equipped to insure)';
  document.getElementById('insureLabel')!.classList.toggle('locked', !canInsure);
  document.getElementById('deployRisk')!.textContent = deployRiskText(hideoutView.state?.loadout ?? {}, fee, insureToggle.checked);
}

async function refreshRooms() {
  try {
    const res = await fetch(`/api/rooms?token=${encodeURIComponent(authToken)}`);
    const data = await res.json();
    if (!data.ok) return;
    rooms = data.rooms;
    matchmaking = data.matchmaking ?? null;
    renderRooms();
  } catch { /* keep the last list */ }
}

/** The cross-platform switch and the "Lobbies · Steam" label above the list. */
function renderMatchmaking() {
  crossplayToggle.checked = !!matchmaking?.crossplay;
  crossplayToggle.disabled = !matchmaking || crossplayToggle.dataset.busy === '1';
  crossplayStatus.textContent = matchmakingText(matchmaking);
  const label = document.createElement('b');
  label.textContent = matchmaking ? matchmaking.pool.label : 'Cross-platform';
  poolLabelEl.replaceChildren('Lobbies · ', label);
}

crossplayToggle.addEventListener('change', async () => {
  const enabled = crossplayToggle.checked;
  crossplayToggle.dataset.busy = '1';
  crossplayToggle.disabled = true;
  roomErrorMsg.textContent = '';
  try {
    const res = await fetch('/api/matchmaking/crossplay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken, enabled }),
    });
    const data = await res.json();
    if (!data.ok) roomErrorMsg.textContent = data.error || 'Could not change matchmaking';
    else matchmaking = data.matchmaking;
  } catch {
    roomErrorMsg.textContent = 'Network error';
  }
  delete crossplayToggle.dataset.busy;
  // The lobby list changes with the pool: the old selection may no longer be joinable.
  await refreshRooms();
  renderMatchmaking();
});

async function createRoom() {
  roomErrorMsg.textContent = '';
  const name = roomNameInput.value.trim();
  if (!name) { roomErrorMsg.textContent = 'Name your lobby first'; return; }
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken, name, map: deployMapId }),
    });
    const data = await res.json();
    if (!data.ok) { roomErrorMsg.textContent = data.error || 'Could not create the raid'; return; }
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
type MenuView = 'home' | 'hideout' | 'browser' | 'signin';
let menuView: MenuView = 'home';
const menuViews: Record<MenuView, HTMLElement> = {
  home: document.getElementById('menuHome')!,
  hideout: document.getElementById('menuHideout')!,
  browser: document.getElementById('menuBrowser')!,
  signin: document.getElementById('menuSignIn')!,
};
/** The token from a password-reset link, while its form is open. */
let resetToken = '';
function showMenuView(view: MenuView) {
  // Everything past the home screen needs an account.
  if (!isLoggedIn && (view === 'hideout' || view === 'browser')) view = 'signin';
  if (view !== 'signin') { bskyLinkMode = false; if (resetToken) hideResetForm(); }
  menuView = view;
  for (const [name, el] of Object.entries(menuViews)) el.classList.toggle('hidden', name !== view);
  if (view === 'browser') { void refreshRooms(); void hideoutView.refresh(); }
  if (view === 'hideout') void hideoutView.refresh();
}
document.querySelectorAll<HTMLElement>('[data-menu-view]').forEach(el =>
  el.addEventListener('click', () => showMenuView(el.dataset.menuView as MenuView)));
document.getElementById('signInBtn')!.addEventListener('click', () => showMenuView('signin'));

function deploy() {
  connectToServer();
}
deployBtn.addEventListener('click', deploy);

// --- Screen state ---
type Screen = 'menu' | 'playing' | 'results';
let currentScreen: Screen = 'menu';

function updateAuthDOM() {
  signInBtn.classList.toggle('hidden', isLoggedIn);
  document.getElementById('signInHint')!.classList.toggle('hidden', isLoggedIn);
  friendsBtn.classList.toggle('hidden', !isLoggedIn);
  authSectionIn.classList.toggle('hidden', !isLoggedIn);
  updateAccountSummary();
  if (isLoggedIn) {
    const callsign = hideoutView.state?.name || friendIdentity?.operator?.name || 'Choose an operator';
    loggedInStatus.textContent = callsign;
    loggedInStatus.title = `Account ID: ${authUserId}`;
    document.getElementById('accountAvatar')!.textContent = callsign.charAt(0).toUpperCase() || '?';
  }
}

// There is no guest play: your stash lives on your account.
const hideoutView = new HideoutView({
  auth: () => ({ token: authToken }),
  onSignedOut: () => { clearAuthState(); requireSignIn(); },
  icon: (id) => svgIcon(id),
  onChange: (h: Hideout) => {
    operatorCallsign.textContent = h.name || 'Create an operator first';
    friendIdentity = { accountId: h.accountId || authUserId, operator: h.friendId && h.name ? { id: h.friendId, name: h.name } : null };
    updateAuthDOM(); updateFriendIdentity(); void refreshFriends();
    if (menuView === 'browser') renderRooms();
  },
});
document.getElementById('toDeployBtn')!.addEventListener('click', () => showMenuView('browser'));
document.getElementById('insureToggle')!.addEventListener('change', () => renderRooms());

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
  const solo = Object.keys(players).length <= 1;
  pauseButton.disabled = !host || (!serverPaused && !solo);
  const pauseKey = document.createElement('kbd');
  pauseKey.className = 'kbd';
  pauseKey.textContent = 'P';
  pauseButton.replaceChildren(svgIcon(serverPaused ? 'i-play' : 'i-pause'), pauseKey);
  const pauseLabel = serverPaused ? 'Resume (P)' : solo && host ? 'Pause the raid (P)' : 'You can only pause when you are alone in the raid';
  pauseButton.title = pauseLabel;
  pauseButton.setAttribute('aria-label', pauseLabel);
  pauseOverlay.hidden = !serverPaused || !playing;
  pauseOverlay.style.display = serverPaused && playing ? 'flex' : 'none';
  resumeButton.hidden = !host;
  document.getElementById('leaveMatchBtn')!.classList.toggle('btn-block', !host);
  // The host leaving unpauses the match and hands host to the next player.
  document.getElementById('leaveHint')!.textContent = host
    ? 'Leaving forfeits your loadout and loot. The raid resumes for everyone else.'
    : 'Leaving forfeits your loadout and loot. Your squad plays on without you.';
  const hostName = (roomHostId && players[roomHostId]?.name) || 'the host';
  document.getElementById('pauseMessage')!.textContent = host
    ? 'Raid paused, raid clock included. Anyone who joins resumes it.'
    : `Paused by ${hostName}. Only they can resume the raid.`;
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
  resultsOverlay.style.display = scr === 'results' ? 'flex' : 'none';
  friendsOverlay.classList.toggle('hidden', true);
  document.getElementById('gameSettingsBtn')?.classList.toggle('hidden', scr !== 'playing');
  if (scr !== 'playing') mapOpen = false;
  renderRoomControls();
  if (scr === 'menu') { updateAuthDOM(); void hideoutView.refresh(); void refreshRooms(); }
  if (scr === 'results') { renderRaidResults(); void refreshDeployAgain(); }
  document.getElementById('settingsLeave')!.hidden = scr !== 'playing';
}

/** "Deploy again" only makes sense if you can still enter this map. */
async function refreshDeployAgain() {
  const h = await hideoutView.refresh();
  const map = h?.maps.find(m => m.id === deployMapId);
  const ok = !!map && map.unlocked && (h?.cash ?? 0) >= (map.entryFee ?? 0);
  const naked = !!h && !h.loadout.primary && !h.loadout.secondary && !h.loadout.armor && !h.loadout.pack;
  playAgainBtn.textContent = !ok ? 'Choose a map' : `Deploy again${map!.entryFee ? ` · $${fmtInt(map!.entryFee)}` : ''}${naked ? ' (no gear equipped)' : ''}`;
}

/** The loadout you deployed with (for telling insured gear apart on the results screen). */
let deployedLoadout: Hideout['loadout'] = {};
/** The raid that just ended, as reported by the server. */
let lastRaidEnd: RaidEnd | null = null;

function lootCard(item: Item): HTMLElement {
  const card = document.createElement('div');
  card.className = 'item-card';
  card.style.setProperty('--rarity', RARITY_COLOR[item.rarity]);
  const icon = document.createElement('span');
  icon.className = 'item-icon';
  icon.append(svgIcon(KIND_ICON[item.kind]));
  const body = document.createElement('span');
  body.className = 'item-body';
  const name = document.createElement('span');
  name.className = 'item-name';
  name.textContent = item.name;
  const meta = document.createElement('span');
  meta.className = 'item-meta';
  meta.textContent = `${RARITY_LABEL[item.rarity]} · power ${item.power} · $${fmtInt(item.value)}`;
  body.append(name, meta);
  card.append(icon, body);
  return card;
}

function renderRaidResults() {
  const end = lastRaidEnd;
  if (!end) return;
  const o = end.outcome;
  const { title, tagline, kept } = raidTitle(o.result);
  const titleEl = document.getElementById('resultsTitle')!;
  titleEl.textContent = title;
  titleEl.classList.toggle('won', kept);
  titleEl.classList.toggle('lost', !kept);
  const killer = o.killedBy ? ` by ${enemyName(o.killedBy)}` : '';
  document.getElementById('resultsTagline')!.textContent = o.result === 'killed' ? `Killed${killer}. Your loadout and loot are lost` : tagline;
  document.getElementById('resultsMap')!.textContent = kept && o.extractName ? `${end.map} · out through ${o.extractName}` : end.map;
  document.getElementById('resultsTime')!.textContent = formatClock(o.survivedSecs);
  document.getElementById('resultsKills')!.textContent = `${o.kills}`;
  document.getElementById('resultsBountyLabel')!.textContent = kept ? 'Bounty banked' : 'Bounty lost';
  document.getElementById('resultsBounty')!.textContent = `$${fmtInt(o.bounty)}`;
  document.getElementById('resultsLootCount')!.textContent = kept ? `${o.loot.length}` : '—';
  const lootEl = document.getElementById('resultsLoot')!;
  // An insured loadout came back: only the pack was lost.
  const insured = !kept && !!end.settlement?.insured;
  const loadoutIds = new Set(Object.values(deployedLoadout).filter(Boolean).map(i => i!.id));
  const shown = kept ? o.loot : insured ? o.lost.filter(i => !loadoutIds.has(i.id)) : o.lost;
  lootEl.replaceChildren(...shown.map(lootCard));
  document.getElementById('resultsLootTitle')!.textContent = kept ? 'Loot'
    : shown.length ? `Lost · $${fmtInt(itemsValue(shown))}` : 'Lost';
  const settle = end.settlement;
  let line: string;
  if (insured) line = 'Your equipped gear, including the pack itself, is back in the hideout. Pack contents and bounty are gone.';
  else if (!kept) line = shown.length
    ? 'Everything above is gone. Gear in your stash is safe: re-equip in the hideout, or buy from the trader.'
    : 'You went in with nothing equipped, so nothing was lost.';
  else if (!settle) line = 'Your stash could not be updated. Check the hideout.';
  else line = `+$${fmtInt(settle.cashEarned)} banked · ${settle.itemsKept} item${settle.itemsKept === 1 ? '' : 's'} added to your stash`
    + (settle.bonusCash ? ` (incl. $${fmtInt(settle.bonusCash)} rank and perk bonus)` : '')
    + (settle.itemsPending ? ` · ${settle.itemsPending} overflow items waiting for your choice in the stash` : '')
    + (settle.itemsAutoSold ? ` · ${settle.itemsAutoSold} sold because your stash was full` : '') + ` · you now have $${fmtInt(settle.cash)}`;
  const ops = settle?.ops;
  if (ops) {
    const mapName = hideoutView.state?.maps.find(m => m.id === ops.map)?.name ?? end.map;
    line += ` · ${mapName} Operations +${ops.xpGained} XP`
      + (ops.rankedUp ? ` · rank ${ops.rank} reached: cheaper entry, bigger bounty` : ops.next === null ? ' (top rank)' : ` (${ops.xp}/${ops.next} to rank ${ops.rank + 1})`);
  }
  if (o.activity) line += ` · ${o.activity.assists} assists · ${o.activity.crates} crates · ${o.activity.revives} credited revives`;
  if (kept && o.loot.length === 0) lootEl.append(Object.assign(document.createElement('p'), { className: 'meta', textContent: 'You extracted with an empty pack.' }));
  document.getElementById('resultsSettlement')!.textContent = line;
  document.getElementById('resultsLootCard')!.hidden = false;
}

// --- Auth ---
let authToken = localStorage.getItem('boxhead_auth_token') || '';
let authHandle = localStorage.getItem('boxhead_auth_handle') || '';
let authUserId = localStorage.getItem('boxhead_auth_user_id') || '';
let isLoggedIn = !!authToken;

// --- Friends ---
let friendsList: Friend[] = [];
let friendIdentity: FriendIdentity | null = null;
const presence = new Presence();

function setAuthState(token: string, handle: string, userId: string, displayName?: string) {
  authToken = token;
  authHandle = handle || displayName || '';
  authUserId = userId;
  isLoggedIn = true;
  localStorage.setItem('boxhead_auth_token', authToken);
  localStorage.setItem('boxhead_auth_handle', authHandle);
  localStorage.setItem('boxhead_auth_user_id', authUserId);
  presence.connect(token);
  localStorage.removeItem('boxhead_name');
  updateAuthDOM();
  refreshFriends();
  refreshMe();
  void refreshRooms();
  if (menuView === 'signin') showMenuView('home');
}

/** Send a signed-out player to the sign-in screen with a reason. */
function requireSignIn() {
  showMenuView('signin');
  loginErrorMsg.textContent = 'Sign in to play. Your stash and gear live on your account.';
}

// --- Linked identities (Steam, Bluesky) on one BoxHead account ---
let linkedAccounts: { provider: string; handle: string }[] = [];
let linkError = '';
/** The Bluesky form is attaching Bluesky to the signed-in account, not signing in. */
let bskyLinkMode = false;

function refreshMe() {
  if (!authToken) return;
  fetch(`/api/auth/me?token=${encodeURIComponent(authToken)}`)
    .then(r => r.json())
    .then(data => {
      if (!data.ok) { clearAuthState(); return; }
      linkedAccounts = data.linked || [];
      renderLinkedAccounts();
      renderEmailStatus(data.emailUnconfirmed ?? null);
    })
    .catch(() => {});
}

function renderLinkedAccounts() {
  const box = document.getElementById('linkedAccounts')!;
  box.replaceChildren();
  if (!isLoggedIn) return;
  for (const [provider, label] of [['steam', 'Steam'], ['bluesky', 'Bluesky']] as const) {
    const row = document.createElement('div');
    row.className = 'linked-row';
    const acct = linkedAccounts.find(a => a.provider === provider);
    const text = document.createElement('span');
    if (acct) {
      const b = document.createElement('b');
      b.textContent = acct.handle || 'linked';
      text.append(`${label}: `, b);
    } else {
      text.textContent = `${label}: not linked`;
    }
    row.append(text);
    if (!acct) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link';
      btn.textContent = `Link ${label}`;
      btn.title = `Sign in with ${label} once; after that it opens this same account`;
      btn.addEventListener('click', () => { linkError = ''; if (provider === 'steam') steamLogin(true); else startBskyLink(); });
      row.append(btn);
    }
    box.append(row);
  }
  if (linkError) {
    const err = document.createElement('p');
    err.className = 'error-text';
    err.textContent = linkError;
    box.append(err);
  }
}

function steamLogin(link = false) {
  loginErrorMsg.textContent = '';
  const url = `/api/auth/steam/start${link && authToken ? `?link=${encodeURIComponent(authToken)}` : ''}`;
  const popup = window.open(url, 'steam-login', 'width=820,height=720,menubar=no,toolbar=no');
  // Popups blocked: do it in this tab (the callback page brings you back).
  if (!popup) window.location.href = url;
}

function startBskyLink() {
  bskyLinkMode = true;
  showMenuView('signin');
  bskyLinkMode = true;
  (document.querySelector('.auth-tab[data-tab="bsky"]') as HTMLElement | null)?.click();
  document.getElementById('signInSub')!.textContent = 'Link your Bluesky account. After this, signing in with Bluesky opens this same account.';
  bskyLoginBtn.querySelector('span')!.textContent = 'Link Bluesky';
}

/** A result from the Steam/Google popup (or the same-tab fallback). */
function handleAuthResult(d: { ok: boolean; error?: string; linked?: string; token?: string; handle?: string; user_id?: string; display_name?: string }) {
  if (!d.ok) {
    if (isLoggedIn) { linkError = d.error || 'Linking failed'; renderLinkedAccounts(); }
    else loginErrorMsg.textContent = d.error || 'Sign-in failed';
    return;
  }
  if (d.linked) { linkError = ''; refreshMe(); return; }
  if (d.token) setAuthState(d.token, d.handle || '', d.user_id || '', d.display_name);
}

function clearAuthState() {
  presence.disconnect();
  authToken = '';
  authHandle = '';
  authUserId = '';
  isLoggedIn = false;
  friendsList = [];
  friendIdentity = null;
  hideoutView.state = null;
  updateAuthDOM();
  localStorage.removeItem('boxhead_auth_token');
  localStorage.removeItem('boxhead_auth_handle');
  localStorage.removeItem('boxhead_auth_user_id');
  matchmaking = null;
  linkedAccounts = [];
  renderEmailStatus(null);
  updateFriendsDOM();
  if (menuView === 'hideout' || menuView === 'browser') showMenuView('home');
  void refreshRooms();
}

async function bskyLogin(handle: string, password: string) {
  loginErrorMsg.textContent = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, password, token: bskyLinkMode ? authToken : undefined }),
    });
    const data = await res.json();
    if (data.ok && data.linked) {
      bskyLinkMode = false;
      bskyPassEl.value = '';
      refreshMe();
      showMenuView('home');
    } else if (data.ok) {
      setAuthState(data.token, data.handle, data.user_id, data.display_name);
    } else {
      loginErrorMsg.textContent = data.error || 'Login failed';
    }
  } catch {
    loginErrorMsg.textContent = 'Network error';
  }
  bskyLoginBtn.querySelector('span')!.textContent = bskyLinkMode ? 'Link Bluesky' : 'Sign in with Bluesky';
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
      if (endpoint === 'register') showHomeNotice(data.mailError
        ? `Account created, but the confirmation email didn't send: ${data.mailError} Use "Resend link" below.`
        : `Account created. We sent a confirmation link to ${data.handle}: confirm it to deploy.`, !!data.mailError);
    } else {
      loginErrorMsg.textContent = data.error || 'Auth failed';
    }
  } catch {
    loginErrorMsg.textContent = 'Network error';
  }
}

// --- Email confirmation, password reset and account deletion ---
let minPassword = 8;

function showHomeNotice(text: string, bad = false) {
  const n = document.getElementById('homeNotice')!;
  n.textContent = text;
  n.classList.toggle('bad', bad);
  n.hidden = !text;
}

/** The "confirm your email" banner on the home screen, from /api/auth/me. */
function renderEmailStatus(unconfirmed: string | null) {
  document.getElementById('emailBanner')!.hidden = !unconfirmed;
  document.getElementById('emailBannerAddr')!.textContent = unconfirmed ?? '';
  document.getElementById('verifiedBadge')!.hidden = !!unconfirmed;
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

document.getElementById('resendEmailBtn')!.addEventListener('click', async () => {
  const msg = document.getElementById('emailBannerMsg')!;
  msg.textContent = 'Sending…';
  try {
    const data = await postJson('/api/auth/email/resend', { token: authToken });
    msg.textContent = data.ok ? (data.alreadyConfirmed ? 'Already confirmed.' : `Sent. Check ${data.sentTo} (and the spam folder).`) : (data.error || 'Could not send');
    if (data.alreadyConfirmed) refreshMe();
  } catch { msg.textContent = 'Network error'; }
});

document.getElementById('forgotSendBtn')!.addEventListener('click', async () => {
  const msg = document.getElementById('forgotMsg')!;
  const email = emailInputEl.value.trim();
  if (!email) { msg.textContent = 'Enter your email above first.'; emailInputEl.focus(); return; }
  msg.textContent = 'Sending…';
  try {
    const data = await postJson('/api/auth/password/forgot', { email });
    msg.textContent = data.ok ? data.message : (data.error || 'Could not send');
  } catch { msg.textContent = 'Network error'; }
});

/** Opened from a reset email (/?reset=<token>): show only the new-password form. */
function showResetForm(token: string) {
  resetToken = token;
  showMenuView('signin');
  document.getElementById('signInTitle')!.textContent = 'New password';
  document.getElementById('signInSub')!.textContent = 'Choose a new password. This signs you out on every other device.';
  document.getElementById('resetSection')!.hidden = false;
  document.getElementById('authSectionOut')!.hidden = true;
  (document.getElementById('resetPassInput') as HTMLInputElement).focus();
}
let signInSubDefault = signInIntro(false);
function hideResetForm() {
  resetToken = '';
  document.getElementById('signInSub')!.textContent = signInSubDefault;
  document.getElementById('signInTitle')!.textContent = 'Sign in';
  document.getElementById('resetSection')!.hidden = true;
  document.getElementById('authSectionOut')!.hidden = false;
}

async function submitReset() {
  const err = document.getElementById('resetErr')!;
  const password = (document.getElementById('resetPassInput') as HTMLInputElement).value;
  err.textContent = '';
  if (password.length < minPassword) { err.textContent = `Use at least ${minPassword} characters.`; return; }
  try {
    const data = await postJson('/api/auth/password/reset', { token: resetToken, password });
    if (!data.ok) { err.textContent = data.error || 'Could not reset the password'; return; }
    hideResetForm();
    setAuthState(data.token, data.handle, data.user_id, data.display_name);
    showHomeNotice('Password changed. You are signed in, and every other device was signed out.');
  } catch { err.textContent = 'Network error'; }
}
document.getElementById('resetPassBtn')!.addEventListener('click', () => void submitReset());
document.getElementById('resetPassInput')!.addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Enter') void submitReset(); });

const deleteInput = document.getElementById('deleteConfirmInput') as HTMLInputElement;
const deleteGo = document.getElementById('deleteAccountGo') as HTMLButtonElement;
document.getElementById('deleteAccountBtn')!.addEventListener('click', () => {
  const box = document.getElementById('deleteConfirm')!;
  box.hidden = !box.hidden;
  if (!box.hidden) deleteInput.focus();
});
deleteInput.addEventListener('input', () => { deleteGo.disabled = deleteInput.value.trim().toUpperCase() !== 'DELETE'; });
deleteGo.addEventListener('click', async () => {
  const err = document.getElementById('deleteAccountErr')!;
  err.textContent = '';
  try {
    const data = await postJson('/api/account/delete', { token: authToken, confirm: 'DELETE' });
    if (!data.ok) { err.textContent = data.error || 'Could not delete the account'; return; }
    deleteInput.value = '';
    deleteGo.disabled = true;
    document.getElementById('deleteConfirm')!.hidden = true;
    clearAuthState();
    showMenuView('home');
    showHomeNotice('Your account was deleted.');
  } catch { err.textContent = 'Network error'; }
});

// Links from emails land here: /?email=confirmed|expired or /?reset=<token>.
{
  const params = new URLSearchParams(window.location.search);
  const email = params.get('email');
  const reset = params.get('reset');
  if (email || reset) window.history.replaceState(null, '', window.location.pathname);
  if (email === 'confirmed') showHomeNotice('Email confirmed. You can deploy now.');
  else if (email === 'expired') showHomeNotice('That confirmation link has expired or was already used. Sign in and press "Resend link" for a new one.', true);
  if (reset && /^[0-9a-f]{16,128}$/.test(reset)) queueMicrotask(() => showResetForm(reset));
}

window.addEventListener('message', (e) => {
  if (e.origin !== window.location.origin) return;
  if (e.data?.type === 'steam-auth') { handleAuthResult(e.data); return; }
  if (e.data?.type === 'google-auth') {
    if (e.data.ok) {
      setAuthState(e.data.token, e.data.handle, e.data.user_id, e.data.display_name);
    } else {
      loginErrorMsg.textContent = e.data.error || 'Google login failed';
    }
  }
});

/** Show what the server says about this build: version, operator notice and where to send feedback. */
function showServerInfo(info: ServerInfo) {
  const text = buildLabel(info);
  const notice = (info.notice ?? '').trim();
  const url = safeLink(info.feedbackUrl);
  const each = <T extends HTMLElement>(selector: string, fn: (el: T) => void) => document.querySelectorAll<T>(selector).forEach(fn);
  each('[data-build-label]', el => { el.textContent = text; el.hidden = !text; });
  each('[data-server-notice]', el => { el.textContent = notice; el.hidden = !notice; });
  each<HTMLAnchorElement>('[data-feedback-link]', a => { if (url) a.href = url; a.hidden = !url; });
  each('[data-build-line]', el => { el.hidden = !text && !url; });
}

fetch('/api/config')
  .then(r => r.json())
  .then(data => {
    (window as any).__GOOGLE_CLIENT_ID = data.google_client_id || '';
    minPassword = data.minPassword || minPassword;
    // Google sign-in needs keys on the server; without them the button would open a Google error page.
    const google = !!data.google_client_id;
    googleLoginBtn.hidden = !google;
    const sub = document.getElementById('signInSub')!;
    if (sub.textContent === signInSubDefault) sub.textContent = signInIntro(google);
    signInSubDefault = signInIntro(google);
    showServerInfo(data);
  })
  .catch(() => {});

if (isLoggedIn) refreshMe();
// Signed in through Steam in this same tab (popup blocked): pick up the result.
try {
  const pending = localStorage.getItem('boxhead_pending_auth');
  if (pending) { localStorage.removeItem('boxhead_pending_auth'); handleAuthResult(JSON.parse(pending)); }
} catch { /* ignore */ }

async function refreshFriends() {
  if (!authToken) return;
  const requestedToken = authToken;
  try {
    const res = await fetch(`/api/friends?token=${encodeURIComponent(requestedToken)}`);
    const data = await res.json();
    if (requestedToken !== authToken) return;
    if (data.ok) {
      friendsList = data.friends;
      friendIdentity = data.identity;
      updateFriendIdentity();
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
    handle.textContent = friendLabel(f);
    handle.className = 'friend-name';
    const tier = document.createElement('small');
    tier.className = 'friend-tier';
    tier.textContent = f.kind === 'account' ? 'Account' : 'Operator';
    const state = document.createElement('span');
    state.className = `friend-state${f.online ? ' online' : ''}`;
    state.textContent = friendDetail(f);
    label.append(dot, tier, handle);
    row.append(label, state);
    if (removable) {
      const remove = document.createElement('button');
      remove.className = 'btn-icon-red';
      remove.title = `Remove ${friendLabel(f)}`;
      remove.setAttribute('aria-label', `Remove ${friendLabel(f)}`);
      remove.append(svgIcon('i-close'));
      remove.addEventListener('click', () => void removeFriend(f));
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

/** One useful line under the account name: gear score, extracts and friends online. */
function updateAccountSummary(h: Hideout | null = hideoutView?.state ?? null) {
  const online = friendsList.filter(f => f.online).length;
  const friends = friendsList.length === 0 ? '0 friends' : `${online}/${friendsList.length} friends online`;
  const first = h?.needsOperator ? 'No operator yet: create one in the hideout'
    : h ? `${h.name ? `Operator: ${h.name} · ` : ''}Gear score ${h.gearScore}` : 'Gear score —';
  const second = [h && !h.needsOperator ? `${h.extracts} extraction${h.extracts === 1 ? '' : 's'}` : '', friends].filter(Boolean).join(' · ');
  const line = (text: string) => Object.assign(document.createElement('span'), { className: 'account-summary-line', textContent: text });
  document.getElementById('accountSummary')!.replaceChildren(line(first), line(second));
}

async function addFriend(handle: string) {
  addFriendErrorMsg.textContent = '';
  try {
    const res = await fetch('/api/friends/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken, id: handle, kind: (document.getElementById('friendKind') as HTMLSelectElement).value }),
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

async function removeFriend(friend: Friend) {
  try {
    await fetch('/api/friends/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken, id: friend.id, kind: friend.kind }),
    });
    refreshFriends();
  } catch { /* ignore */ }
}

setInterval(() => { if (isLoggedIn) refreshFriends(); }, 5000);
if (isLoggedIn) presence.connect(authToken);

function updateFriendIdentity() {
  operatorCallsign.textContent = friendIdentity?.operator?.name || 'Create an operator first';
  (document.getElementById('ownAccountId') as HTMLInputElement).value = friendIdentity?.accountId || authUserId;
  (document.getElementById('ownOperatorId') as HTMLInputElement).value = friendIdentity?.operator?.id || '';
  document.getElementById('ownOperatorName')!.textContent = friendIdentity?.operator?.name || 'No operator selected';
}

document.getElementById('friendKind')!.addEventListener('change', () => {
  const operator = (document.getElementById('friendKind') as HTMLSelectElement).value === 'operator';
  addFriendEl.placeholder = operator ? 'Paste their operator ID' : 'Paste their account ID';
  document.getElementById('friendKindHint')!.textContent = operator
    ? 'Only these two operators become friends. Your account and other operators stay private.'
    : 'Account friends stay connected across operators and see which operator you are playing.';
});
for (const id of ['ownAccountId', 'ownOperatorId']) {
  document.getElementById(id)!.addEventListener('click', event => (event.target as HTMLInputElement).select());
}
updateFriendsDOM();
if (isLoggedIn) refreshFriends();

// --- Static data (received once on init) ---
let staticWalls: Wall[] = [];
let staticMapWidth = 4640;
let staticMapHeight = 4000;
let staticAmmoSpawns: { x: number; y: number; amount: number }[] = [];
let staticExtracts: ExtractPoint[] = [];
let staticCrates: Point[] = [];
let staticNests: Point[] = [];
/** Terminals that decrypt sealed loot while you stand in their ring. */
let staticUplinks: ExtractPoint[] = [];
const UPLINK_COLOR = '#4fe3f7';
let raidMap: MapInfo | null = null;
let crateAvailability: Map<string, boolean> = new Map();

// --- Live game state (built from snapshots + deltas) ---
let players: Record<string, Player> = {};
let zombieMap: Map<string, Zombie> = new Map();
let bulletMap: Map<string, Bullet> = new Map();
let bulletCreationTime: Map<string, number> = new Map();
let placeableMap: Map<string, Placeable> = new Map();
let ammoAvailability: Map<string, boolean> = new Map();
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
document.getElementById('steamLoginBtn')!.addEventListener('click', () => steamLogin(false));
logoutBtn.addEventListener('click', clearAuthState);
playBtn.addEventListener('click', () => { if (isLoggedIn) showMenuView('hideout'); else requireSignIn(); });
// Results: deploy straight back into the same raid, or go gear up.
// Results: deploy straight back in, unless losing your kit locked you out of this map.
playAgainBtn.addEventListener('click', async () => {
  if (ws) { ws.close(); ws = null; }
  const h = await hideoutView.refresh();
  const map = h?.maps.find(m => m.id === deployMapId);
  if (!map || !map.unlocked || (h && h.cash < (map.entryFee ?? 0))) { setScreen('menu'); showMenuView('browser'); return; }
  connectToServer();
});
friendsBtn.addEventListener('click', () => { friendsOverlay.classList.remove('hidden'); friendsOverlay.style.display = 'flex'; });
closeFriendsBtn.addEventListener('click', () => { friendsOverlay.classList.add('hidden'); friendsOverlay.style.display = 'none'; });
backToMenuBtn.addEventListener('click', () => {
  if (ws) { ws.close(); ws = null; }
  setScreen('menu');
  showMenuView('hideout');
});
// Leave from Controls (Esc) works in any raid, solo or squad. It asks twice.
const settingsLeaveBtn = document.getElementById('settingsLeaveBtn')!;
const settingsLeaveLabel = settingsLeaveBtn.querySelector('span')!;
let settingsLeaveTimer = 0;
settingsLeaveBtn.addEventListener('click', () => {
  if (!settingsLeaveTimer) {
    settingsLeaveLabel.textContent = 'Click again: lose your gear';
    settingsLeaveTimer = window.setTimeout(() => { settingsLeaveTimer = 0; settingsLeaveLabel.textContent = 'Leave raid'; }, 3000);
    return;
  }
  window.clearTimeout(settingsLeaveTimer);
  settingsLeaveTimer = 0;
  settingsLeaveLabel.textContent = 'Leave raid';
  leavingRaid = true;
  closeSettings();
  if (ws) ws.close();
});
// Leaving a paused match asks for a second click.
const leaveMatchBtn = document.getElementById('leaveMatchBtn')!;
const leaveLabel = leaveMatchBtn.querySelector('span')!;
let leaveConfirmTimer = 0;
leaveMatchBtn.addEventListener('click', () => {
  if (!leaveConfirmTimer) {
    leaveLabel.textContent = 'Click again: lose your gear';
    leaveConfirmTimer = window.setTimeout(() => { leaveConfirmTimer = 0; leaveLabel.textContent = 'Leave raid'; }, 3000);
    return;
  }
  window.clearTimeout(leaveConfirmTimer);
  leaveConfirmTimer = 0;
  leaveLabel.textContent = 'Leave raid';
  // The server settles a mid-raid exit as abandoned; its result arrives before the socket closes.
  leavingRaid = true;
  serverPaused = false;
  if (ws) ws.close();
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
  if (currentScreen === 'menu' && menuView !== 'home') { showMenuView(menuView === 'browser' ? 'hideout' : 'home'); e.stopPropagation(); return; }
  if (currentScreen === 'playing' && mapOpen) { mapOpen = false; e.stopPropagation(); return; }
  if (currentScreen === 'playing' && raidInvOpen) { toggleRaidInventory(false); e.stopPropagation(); return; }
  if (currentScreen === 'playing') { openSettings(); e.stopPropagation(); }
}, true);

// Enter presses the open screen's primary button (Play, Join, Sign in, Play again),
// unless a focused control handles Enter itself.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.repeat || settingsListening) return;
  const target = e.target as HTMLElement;
  if (target.closest('button, a, select, textarea') || target === roomNameInput || target.id === 'addFriendInputEl') return;
  if (settingsOverlay.style.display === 'flex' || friendsOverlay.style.display === 'flex') return;
  let primary: HTMLButtonElement | null = null;
  if (currentScreen === 'results') primary = backToMenuBtn as HTMLButtonElement;
  else if (currentScreen === 'menu' && menuView === 'home') primary = playBtn as HTMLButtonElement;
  else if (currentScreen === 'menu' && menuView === 'hideout') primary = document.getElementById('toDeployBtn') as HTMLButtonElement;
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
    { title: 'Weapons', keys: ['melee', 'weapon1', 'weapon2'] },
    { title: 'Deployables, pack & map', keys: ['placeBarrel', 'placeBarricade', 'placeMine', 'dropItem', 'inventory', 'toggleMap'] },
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
    row('Pause (solo only)', fixed('P')) + row('Controls / leave', fixed('Esc'));
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

// ============ Full map (M) ============
// A big map overlay on the canvas: extracts, nests, crates and your squad.
function toggleMap(force?: boolean) {
  mapOpen = force !== undefined ? force : !mapOpen;
  if (currentScreen !== 'playing') mapOpen = false;
}

// ============ Pack screen (I) ============
// Every item you're carrying, with a drop button for each. The raid keeps running.
let raidInvOpen = false;
let raidInvKey = '';
let pendingDropId: string | null = null;
let pendingProtectId: string | null = null;
const raidInvEl = document.getElementById('raidInventory')!;
document.getElementById('raidInvClose')!.addEventListener('click', () => toggleRaidInventory(false));

// While the pack is open, hovering a row and holding the drop key (G) drops that
// item. Gun keys keep switching guns.
let raidInvHoverRow: HTMLElement | null = null;
for (const type of ['keydown', 'keyup'] as const) {
  window.addEventListener(type, (e) => {
    if (!raidInvOpen || currentScreen !== 'playing' || e.code !== bindings.dropItem || !raidInvHoverRow?.isConnected) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (type === 'keydown' && e.repeat) return;
    raidInvHoverRow.querySelector('.hold-btn')?.dispatchEvent(new Event(type === 'keydown' ? 'slot-hold' : 'slot-release'));
  }, true);
}

let raidInvHelpSeen = (() => { try { return Number(localStorage.getItem('boxhead_pack_help') || 0); } catch { return 0; } })();
function toggleRaidInventory(force?: boolean) {
  raidInvOpen = force !== undefined ? force : !raidInvOpen;
  if (raidInvOpen) { raidInvHelpSeen++; try { localStorage.setItem('boxhead_pack_help', String(raidInvHelpSeen)); } catch { /* ignore */ } }
  if (currentScreen !== 'playing') raidInvOpen = false;
  raidInvEl.hidden = !raidInvOpen;
  raidInvKey = '';
  if (raidInvOpen) renderRaidInventory();
}

/** A Drop button you hold for half a second, so a stray click never throws loot away. */
function holdToDrop(onDone: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'hold-btn';
  const label = document.createElement('span');
  label.textContent = 'Hold to drop';
  btn.append(label);
  btn.title = 'Hold (mouse, or Space/Enter when focused) for half a second to drop it here';
  let timer = 0;
  const start = (e: Event) => {
    e.preventDefault();
    if (timer) return;
    btn.classList.add('holding');
    label.textContent = 'Hold…';
    timer = window.setTimeout(() => { timer = 0; onDone(); }, 500);
  };
  const cancel = () => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    btn.classList.remove('holding');
    label.textContent = 'Hold to drop';
  };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', cancel);
  btn.addEventListener('pointerleave', cancel);
  btn.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.stopPropagation(); start(e); } });
  btn.addEventListener('slot-hold', start);
  btn.addEventListener('slot-release', cancel);
  btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.stopPropagation(); cancel(); } });
  return btn;
}

/** Re-render the pack screen when what it shows changes. */
function renderRaidInventory() {
  if (!raidInvOpen) return;
  const me = players[myId];
  if (!me) return;
  const pack = me.backpack ?? [];
  const cap = me.backpackCapacity || 4;
  const decrypting = pack.find(isEncrypted);
  const nu = nearest(staticUplinks, me.pos.x, me.pos.y);
  const uplinkText = nu ? `${nu.point.name} · ${formatDistance(nu.dist)} ${compass(nu.point.x - me.pos.x, nu.point.y - me.pos.y)}` : '';
  const key = `${pack.map(i => `${i.id}:${!!i.protected}`).join(',')}|${cap}|${Math.floor(me.decrypt || 0)}|${bindings.inventory}|${uplinkText}`;
  if (key === raidInvKey) return;
  // Don't rebuild under a Drop being held down.
  if (raidInvEl.querySelector('.hold-btn.holding')) return;
  raidInvKey = key;
  document.getElementById('raidInvKey')!.textContent = keyDisplayName(bindings.inventory);
  document.getElementById('raidInvCount')!.textContent = `${pack.length}/${cap}`;
  const sealed = pack.filter(isEncrypted);
  const risk = document.getElementById('raidInvSub')!;
  risk.replaceChildren(`At risk: $${fmtInt(backpackValue(pack))}`);
  if (sealed.length) {
    const opened = backpackValue(pack.filter(i => !isEncrypted(i))) + sealed.reduce((s, i) => s + estimatedValue(i), 0);
    risk.append(` · ~$${fmtInt(opened)} once decrypted`);
    const loud = document.createElement('small');
    loud.className = 'rp-uplink';
    loud.textContent = `Nearest uplink: ${uplinkText || 'none in range'}. Decrypting is loud.`;
    risk.append(loud);
  }
  const small = document.createElement('small');
  small.textContent = 'Kept only if you extract.';
  risk.append(small);

  const list = document.getElementById('raidInvList')!;
  list.replaceChildren();
  pack.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'rp-row';
    row.setAttribute('role', 'listitem');
    row.style.setProperty('--rarity', RARITY_COLOR[item.rarity]);
    const icon = document.createElement('span');
    icon.className = 'rar-icon sm' + (isEncrypted(item) ? ' sealed' : '');
    icon.style.setProperty('--rarity', RARITY_COLOR[item.rarity]);
    icon.append(svgIcon(KIND_ICON[item.kind]));
    const body = document.createElement('span');
    body.className = 'row-body';
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = item.name;
    const chip = document.createElement('span');
    chip.className = 'rar-chip';
    if (isEncrypted(item)) {
      chip.classList.add('sealed-chip');
      const dot = document.createElement('span');
      dot.className = 'rar-dot';
      dot.style.background = RARITY_COLOR[item.rarity];
      chip.append(dot, `Sealed · ${RARITY_LABEL[item.rarity]}`);
    } else {
      chip.style.setProperty('--rarity', RARITY_COLOR[item.rarity]);
      chip.textContent = RARITY_LABEL[item.rarity];
    }
    const meta = document.createElement('span');
    meta.className = 'row-meta';
    let progress: HTMLElement | null = null;
    if (isEncrypted(item)) {
      if (item === decrypting && me.decrypt > 0) {
        meta.textContent = `Decrypting · ${Math.max(0, DECRYPT_SECS[item.rarity] - me.decrypt).toFixed(0)}s left`;
        meta.classList.add('rp-uplink');
        progress = document.createElement('span');
        progress.className = 'rp-progress';
        const fill = document.createElement('span');
        fill.style.width = `${Math.min(100, (me.decrypt / DECRYPT_SECS[item.rarity]) * 100)}%`;
        progress.append(fill);
      } else {
        meta.append(`Decrypt ${DECRYPT_SECS[item.rarity]}s · 20% rarity upgrade at tier ${item.originTier || 1}+ only`);
      }
    } else {
      meta.textContent = keyStat(item) ? `${item.power} PWR · ${keyStat(item)!.text.split(' · ')[0]}` : 'Sells at the trader';
    }
    const metaLine = document.createElement('span');
    metaLine.className = 'rp-meta-line';
    metaLine.append(chip, meta);
    body.append(name, metaLine);
    if (progress) body.append(progress);
    const worth = document.createElement('span');
    worth.className = 'rp-value';
    worth.textContent = isEncrypted(item) ? `$${fmtInt(item.value)} now` : `$${fmtInt(item.value)}`;
    if (isEncrypted(item)) {
      const open = document.createElement('small');
      open.className = 'value-open';
      open.style.display = 'block';
      open.textContent = `~$${fmtInt(estimatedValue(item))} decrypted`;
      worth.append(open);
    }
    const side = document.createElement('span');
    side.className = 'rp-side';
    const protect = document.createElement('button');
    protect.className = 'btn btn-secondary btn-sm'; protect.type = 'button';
    protect.textContent = item.protected ? 'Protected ✓' : 'Protect';
    protect.title = 'Prevents automatic replacement and dropping. Does not prevent raid loss.';
    protect.addEventListener('click', () => { pendingProtectId = item.id; maybeSendInput(); });
    side.append(worth, protect);
    if (!item.protected) side.append(holdToDrop(() => { pendingDropId = item.id; maybeSendInput(); }));
    row.addEventListener('pointerenter', () => { raidInvHoverRow = row; });
    row.addEventListener('pointerleave', () => { if (raidInvHoverRow === row) raidInvHoverRow = null; });
    row.append(icon, body, side);
    list.append(row);
  });
  if (pack.length < cap) {
    const row = document.createElement('div');
    row.className = 'rp-row empty';
    const free = cap - pack.length;
    row.textContent = `${free} empty slot${free === 1 ? '' : 's'}`;
    list.append(row);
  }
  const foot = document.getElementById('raidInvFoot')!;
  foot.replaceChildren();
  // Help text only for the first few times you open the pack.
  if (raidInvHelpSeen > 3) { foot.hidden = true; return; }
  foot.hidden = false;
  const line1 = document.createElement('span');
  const g = document.createElement('kbd');
  g.className = 'kbd';
  g.textContent = keyDisplayName(bindings.dropItem);
  line1.append('Hold ', g, ' over an item: drop it');
  const line2 = document.createElement('span');
  line2.append('Tap ', g.cloneNode(true), ': drop your last pickup');
  foot.append(line1, line2);
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
      const reach = MELEE_RANGE;
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
};

let pendingPlaceItem = 0;
let pendingDrop = false;
/** Items you just dropped or swapped out: the loot hint ignores them for a few seconds. */
const recentlyDropped = new Map<string, number>();

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
  placeBarrel: string;
  placeBarricade: string;
  placeMine: string;
  toggleMap: string;
  dropItem: string;
  inventory: string;
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
  placeBarrel: 'KeyE',
  placeBarricade: 'KeyQ',
  placeMine: 'KeyF',
  toggleMap: 'KeyM',
  dropItem: 'KeyG',
  inventory: 'KeyI',
};

const BINDING_LABELS: Record<keyof KeyBindings, string> = {
  moveUp: 'Move up',
  moveDown: 'Move down',
  moveLeft: 'Move left',
  moveRight: 'Move right',
  shoot: 'Shoot',
  melee: 'Katana',
  dash: 'Dash',
  weapon1: 'Primary gun',
  weapon2: 'Secondary gun',
  placeBarrel: 'Place barrel',
  placeBarricade: 'Place barricade',
  placeMine: 'Place claymore',
  toggleMap: 'Full map',
  dropItem: 'Drop last pickup',
  inventory: 'Pack (inventory)',
};

function loadBindings(): KeyBindings {
  try {
    const saved = localStorage.getItem('boxhead_keybindings');
    if (saved) {
      // Keep only actions that still exist (older builds had more weapon keys and an armory key).
      const parsed = JSON.parse(saved) as Record<string, string>;
      const merged = { ...DEFAULT_BINDINGS };
      for (const key of Object.keys(DEFAULT_BINDINGS) as (keyof KeyBindings)[]) if (typeof parsed[key] === 'string') merged[key] = parsed[key];
      return merged;
    }
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
  ammoAvailability.clear();
  crateAvailability.clear();
  dropMap.clear();
  lastRaidEnd = null;
  lastSnapshotTick = 0;
  leavingRaid = false;
  joinRefused = false;
  lootHintKey = '';
  myId = '';
  stateBuffer.length = 0;
  lastSentInput = '';
  lastSendTime = 0;
  predictionInitialized = false;
  pendingDeltas.length = 0;
  mapOpen = false;
}

/** Set when the player chose to leave, so the closing socket isn't reported as a lost connection. */
let leavingRaid = false;
/** Tick of the last snapshot; deltas at or before it are stale. */
let lastSnapshotTick = 0;
let joinRefused = false;
let lootHintKey = '';

function triggerWaveBanner(title: string, subtitle: string, color = theme.accent) {
  waveBannerText = title;
  waveBannerSub = subtitle;
  waveBannerColor = color;
  waveBannerTimer = 3.2;
}

function connectToServer() {
  deployedLoadout = { ...(hideoutView.state?.loadout ?? {}) };
  roomErrorMsg.textContent = '';
  currentRoomId = selectedRoomId;
  currentRoomName = rooms.find(r => r.id === currentRoomId)?.name ?? currentMap()?.name ?? 'the raid';
  resetGameState();
  setScreen('playing');

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws`);

  ws.onopen = () => {
    ws!.send(JSON.stringify({ type: 'join', token: authToken || undefined, roomId: currentRoomId, insure: (document.getElementById('insureToggle') as HTMLInputElement).checked }));
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data) as { type: string };

    if (data.type === 'joinError') {
      // The server refused the join (e.g. verified-only room); onclose returns to the menu.
      joinRefused = true;
      roomErrorMsg.textContent = (data as { type: string; error?: string }).error || 'Could not join that raid';
      setScreen('menu');
      showMenuView('browser');
    } else if (data.type === 'raidEnd') {
      lastRaidEnd = data as RaidEnd;
      if (ws) ws.onclose = null;
      if (inputInterval) { clearInterval(inputInterval); inputInterval = null; }
      setScreen('results');
    } else if (data.type === 'room') {
      const room = data as { type: string; hostId: string | null; paused: boolean; roomName?: string };
      roomHostId = room.hostId;
      if (room.roomName) currentRoomName = room.roomName;
      if (serverPaused !== room.paused) {
        serverPaused = room.paused;
        input.up = input.down = input.left = input.right = input.shooting = input.melee = input.dash = false;
        input.placeItem = input.selectWeapon = 0;
        keysDown.clear();
        dashPending = false;
        dashActiveTimer = dashIframeTimer = 0;
        lastSentInput = '';
        mapOpen = false;
      }
      renderRoomControls();
    } else if (data.type === 'init') {
      const init = data as InitPayload;
      myId = init.id;
      staticWalls = init.walls;
      staticMapWidth = init.mapWidth;
      staticMapHeight = init.mapHeight;
      staticAmmoSpawns = init.ammoSpawnPoints;
      staticExtracts = init.extracts;
      staticCrates = init.crates;
      staticNests = init.nests;
      staticUplinks = init.uplinks ?? [];
      raidMap = init.map;
      minimapCache = null;
      for (let i = 0; i < staticAmmoSpawns.length; i++) ammoAvailability.set(`ammo_${i}`, true);
      for (let i = 0; i < staticCrates.length; i++) crateAvailability.set(`crate_${i}`, true);
      triggerWaveBanner(init.map.name, `Find loot · reach an extract within ${formatClock(init.map.raidSecs)}`, theme.text);
      pushFeedEvent(currentRoomName && currentRoomName !== init.map.name ? `Deployed to ${init.map.name} · ${currentRoomName}` : `Deployed to ${init.map.name}`, theme.you);
    } else if (data.type === 'snapshot') {
      const snap = data as SnapshotState;
      // Deltas queued before this snapshot describe older states: drop them.
      for (let i = pendingDeltas.length - 1; i >= 0; i--) if (pendingDeltas[i].tick <= snap.tick) pendingDeltas.splice(i, 1);
      lastSnapshotTick = snap.tick;
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
      crateAvailability.clear();
      for (const c of snap.crates ?? []) crateAvailability.set(c.id, c.available);
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
      const delta = data as DeltaState;
      if (lastSnapshotTick > 0 && delta.tick > lastSnapshotTick) pendingDeltas.push(delta);
    }
  };

  const connection = ws;
  ws.onclose = () => {
    if (ws !== connection) return;
    if (inputInterval) { clearInterval(inputInterval); inputInterval = null; }
    // A raid result closes the socket itself (onclose is cleared), and a refused
    // join already showed its reason. Anything else mid-raid is a lost connection.
    if (currentScreen === 'playing' && !joinRefused) {
      setScreen('menu');
      showMenuView('hideout');
      document.getElementById('hideoutError')!.textContent = leavingRaid
        ? 'You left the raid. Your loadout and loot were lost.'
        : 'Connection lost. A raid you drop out of counts as abandoned.';
    }
  };

  inputInterval = setInterval(maybeSendInput, 1000 / 30);
}

function applyDelta(delta: DeltaState) {
  // Players
  if (delta.players) {
    for (const id in delta.players) {
      const diff = delta.players[id];
      const existing = players[id];
      if (!existing) {
        players[id] = diff as Player;
        continue;
      }
      const me = id === myId;
      if (diff.damageLog !== undefined) existing.damageLog = diff.damageLog;
      if (diff.name !== undefined) existing.name = diff.name;
      if (diff.pos) {
        existing.pos = diff.pos;
        if (me && predictionInitialized) {
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
        if (me) {
          if (diff.health < existing.health) {
            const lost = Math.round(existing.health - diff.health);
            damageFlashAlpha = 0.55;
            addScreenShake(8);
            spawnFloatingText(predictedX, predictedY - 18, `-${lost} HP`, theme.accent, 16);
            if (diff.health <= 0) pushFeedEvent(Object.values(players).some(o => o.id !== myId && o.health > 0) ? 'You are down: get revived' : 'You are down: nobody can revive you', theme.accent);
          } else if (diff.health > existing.health) {
            const gained = Math.round(diff.health - existing.health);
            healFlashAlpha = 0.35;
            spawnFloatingText(predictedX, predictedY - 18, `+${gained} HP`, theme.health, 15);
          }
        } else if (diff.health <= 0 && existing.health > 0) {
          pushFeedEvent(`${existing.name || 'Squadmate'} down: stand close to revive`, theme.accent);
        }
        existing.health = diff.health;
      }
      if (diff.maxHealth !== undefined) existing.maxHealth = diff.maxHealth;
      if (diff.bounty !== undefined) {
        const gained = Math.round(diff.bounty - (existing.bounty ?? 0));
        if (me && gained >= 10) spawnFloatingText(predictedX + 12, predictedY - 28, `+$${gained}`, theme.money, 14);
        existing.bounty = diff.bounty;
      }
      if (diff.ammo !== undefined) {
        if (me && diff.ammo > existing.ammo + 1) {
          spawnFloatingText(predictedX, predictedY - 26, `+${Math.round(diff.ammo - existing.ammo)} ammo`, theme.text, 13);
        }
        existing.ammo = diff.ammo;
      }
      if (diff.maxAmmo !== undefined) existing.maxAmmo = diff.maxAmmo;
      if (diff.weapon !== undefined) existing.weapon = diff.weapon;
      if (diff.weapons !== undefined) existing.weapons = diff.weapons;
      if (diff.activeSlot !== undefined) existing.activeSlot = diff.activeSlot;
      if (diff.backpack !== undefined) {
        if (me) {
          const before = new Set(existing.backpack.map(i => i.id));
          const after = new Set(diff.backpack.map(i => i.id));
          // A sealed item replaced in place by a new one was decrypted, not dropped.
          const opened = new Set<string>();
          diff.backpack.forEach((item, idx) => {
            const old = existing.backpack[idx];
            if (!before.has(item.id) && old && isEncrypted(old) && !after.has(old.id) && existing.backpack.length === diff.backpack!.length) {
              opened.add(old.id);
              spawnFloatingText(predictedX, predictedY - 40, `Decrypted: ${item.name}`, RARITY_COLOR[item.rarity], 17);
              pushFeedEvent(`Decrypted ${old.name} → ${RARITY_LABEL[item.rarity]} ${item.name} · $${fmtInt(item.value)}`, RARITY_COLOR[item.rarity]);
              before.add(item.id);
            }
          });
          for (const item of diff.backpack) {
            if (before.has(item.id)) continue;
            spawnFloatingText(predictedX, predictedY - 40, `+ ${item.name} (${item.power})`, RARITY_COLOR[item.rarity], item.rarity === 'common' ? 14 : 16);
            pushFeedEvent(`+ ${item.name} · $${fmtInt(item.value)}`, RARITY_COLOR[item.rarity]);
          }
          for (const old of existing.backpack) {
            if (!after.has(old.id) && !opened.has(old.id)) {
              recentlyDropped.set(old.id, performance.now());
              pushFeedEvent(`Dropped ${old.name}`, theme.textSecondary);
            }
          }
        }
        existing.backpack = diff.backpack;
      }
      if (diff.backpackCapacity !== undefined) existing.backpackCapacity = diff.backpackCapacity;
      if (diff.gearScore !== undefined) existing.gearScore = diff.gearScore;
      if (diff.raidTime !== undefined) {
        if (me) {
          for (const mark of [300, 120, 60]) {
            if (existing.raidTime > mark && diff.raidTime <= mark) {
              triggerWaveBanner(`${formatClock(mark)} left`, 'Get to an extraction point or be lost', mark <= 60 ? theme.accent : theme.money);
              pushFeedEvent(`${formatClock(mark)} left in the raid`, mark <= 60 ? theme.accent : theme.money);
            }
          }
        }
        existing.raidTime = diff.raidTime;
      }
      if (diff.extractProgress !== undefined) {
        if (me && existing.extractProgress <= 0 && diff.extractProgress > 0) pushFeedEvent('Extracting: stay inside the ring', theme.health);
        existing.extractProgress = diff.extractProgress;
      }
      if (diff.bleedout !== undefined) existing.bleedout = diff.bleedout;
      if (diff.camp !== undefined) {
        if (me && existing.camp < CAMP_WARNING && diff.camp >= CAMP_WARNING && !existing.hunted) {
          pushFeedEvent('Camping: keep moving or be hunted', theme.money);
        }
        existing.camp = diff.camp;
      }
      if (diff.decrypt !== undefined) {
        if (me && !(existing.decrypt > 0) && diff.decrypt > 0) pushFeedEvent('Decrypting: stay in the ring · the noise draws monsters', UPLINK_COLOR);
        existing.decrypt = diff.decrypt;
      }
      if (diff.hunted !== undefined) {
        if (me && diff.hunted && !existing.hunted) {
          triggerWaveBanner('Hunted', 'You stayed in one place too long. Something is coming for you', theme.accent);
          addScreenShake(10);
        }
        if (me && !diff.hunted && existing.hunted) pushFeedEvent('The hunt is over', theme.textSecondary);
        existing.hunted = diff.hunted;
      }
      if (diff.combo !== undefined) {
        if (me && diff.combo > existing.combo && diff.combo % 5 === 0) {
          const c = diff.combo;
          pushFeedEvent(c === 10 ? 'Overdrive! Rapid fire and a speed boost' : `${c}× combo: resupplied`, theme.money);
          spawnFloatingText(predictedX, predictedY - 52, c === 10 ? 'Overdrive' : `${c}× combo`, theme.money, c >= 10 ? 17 : 15);
        }
        existing.combo = diff.combo;
      }
      if (diff.comboTimer !== undefined) existing.comboTimer = diff.comboTimer;
      if (diff.maxCombo !== undefined) existing.maxCombo = diff.maxCombo;
      if (diff.kills !== undefined) existing.kills = diff.kills;
      if (diff.activity !== undefined) existing.activity = diff.activity;
      if (diff.tacticalItems !== undefined) existing.tacticalItems = diff.tacticalItems;
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
      // Culled enemies (far from everyone) vanish without a death effect.
      // Enemies also vanish when they leave your view range: only show deaths on screen.
      const visible = z && Math.abs(z.pos.x - camX - canvas.width / 2) < canvas.width / 2 + 40 && Math.abs(z.pos.y - camY - canvas.height / 2) < canvas.height / 2 + 40;
      if (z && visible && z.type === 'abomination') {
        triggerWaveBanner('Abomination down', 'It dropped high-end loot', theme.money);
        spawnExplosion(z.pos.x, z.pos.y, 140, '#7a2034');
      }
      if (z && visible) {
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

  if (delta.crates) {
    for (const c of delta.crates) {
      if (crateAvailability.get(c.id) && !c.available) {
        const i = Number(c.id.slice(6));
        const crate = staticCrates[i];
        if (crate && Math.hypot(crate.x - predictedX, crate.y - predictedY) < 400) {
          spawnFloatingText(crate.x, crate.y - 20, 'Crate opened', theme.money, 14);
          shockwaves.push({ x: crate.x, y: crate.y, radius: 8, maxRadius: 46, color: '#f2b53c', life: 0.3, maxLife: 0.3 });
        }
      }
      crateAvailability.set(c.id, c.available);
    }
  }
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
  const actions = codeToActions(code);
  for (const action of actions) {
    switch (action) {
      case 'moveUp': input.up = true; break;
      case 'moveDown': input.down = true; break;
      case 'moveLeft': input.left = true; break;
      case 'moveRight': input.right = true; break;
      case 'shoot': input.shooting = true; break;
      case 'melee': triggerMeleeAttack(); break;
      case 'dash':
        if (isMoving()) tryTriggerDash();
        break;
      case 'weapon1': input.selectWeapon = 1; break;
      case 'weapon2': input.selectWeapon = 2; break;
      case 'placeBarrel': pendingPlaceItem = 1; break;
      case 'placeBarricade': pendingPlaceItem = 2; break;
      case 'placeMine': pendingPlaceItem = 3; break;
      case 'toggleMap': toggleMap(); break;
      case 'dropItem': pendingDrop = true; break;
      case 'inventory': toggleRaidInventory(); break;
    }
  }

  // Right mouse button (Mouse2) also acts as a quick Melee Cleave trigger
  if (code === 'Mouse2' && currentScreen === 'playing') {
    triggerMeleeAttack();
  }
  if (code === 'Digit5') pendingPlaceItem = 1;
  if (code === 'Digit6') pendingPlaceItem = 2;
  if (code === 'Digit7') pendingPlaceItem = 3;
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
      case 'weapon1': case 'weapon2':
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
  if ((e.target as HTMLElement).closest('#roomControls, #pauseOverlay, #raidInventory') || (e.target as HTMLElement).closest('#settingsOverlay')) {
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
    // Hotbar map button
    if (
      e.clientX >= hotbarMapBtnRect.x &&
      e.clientX <= hotbarMapBtnRect.x + hotbarMapBtnRect.w &&
      e.clientY >= hotbarMapBtnRect.y &&
      e.clientY <= hotbarMapBtnRect.y + hotbarMapBtnRect.h
    ) {
      toggleMap();
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
        if (p && p.weapons.length > 1) {
          input.selectWeapon = ((p.activeSlot + 1) % p.weapons.length) + 1;
          setTimeout(() => { input.selectWeapon = 0; }, 100);
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
  if (pendingDrop) {
    input.dropItem = true;
    pendingDrop = false;
  }
  if (pendingProtectId) { input.protectId = pendingProtectId; pendingProtectId = null; }
  if (pendingDropId) {
    input.dropId = pendingDropId;
    pendingDropId = null;
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
  input.dropItem = false;
  delete input.dropId;
  delete input.protectId;
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
    walls: staticWalls,
    ammoPickups: staticAmmoSpawns.map((s, i) => ({
      id: `ammo_${i}`,
      pos: { x: s.x, y: s.y },
      amount: s.amount,
      respawnAt: ammoAvailability.get(`ammo_${i}`) ? 0 : 1,
    })),
    mapWidth: staticMapWidth,
    mapHeight: staticMapHeight,
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

const onScreen = (x: number, y: number, pad: number) => {
  const sx = x - camX, sy = y - camY;
  return sx > -pad && sx < canvas.width + pad && sy > -pad && sy < canvas.height + pad;
};

function drawNests() {
  const now = performance.now();
  for (const n of staticNests) if (onScreen(n.x, n.y, 140)) drawNestSprite(ctx, n.x - camX, n.y - camY, now);
}

function drawCrates() {
  const now = performance.now();
  staticCrates.forEach((c, i) => {
    if (crateAvailability.get(`crate_${i}`) && onScreen(c.x, c.y, 40)) drawCrateSprite(ctx, c.x - camX, c.y - camY, now);
  });
}

function drawExtracts(state: GameState) {
  const now = performance.now();
  const me = state.players[myId];
  for (const e of staticExtracts) {
    if (!onScreen(e.x, e.y, e.radius + 40)) continue;
    const inside = me && Math.hypot(me.pos.x - e.x, me.pos.y - e.y) < e.radius;
    drawExtractZone(ctx, e.x - camX, e.y - camY, e.radius, e.name, now, inside ? (me.extractProgress || 0) / EXTRACT_TIME : 0);
  }
}

function drawUplinks(state: GameState) {
  const now = performance.now();
  const me = state.players[myId];
  for (const u of staticUplinks) {
    if (!onScreen(u.x, u.y, u.radius + 60)) continue;
    const sx = u.x - camX, sy = u.y - camY;
    const inside = !!me && Math.hypot(me.pos.x - u.x, me.pos.y - u.y) < u.radius;
    const sealed = me?.backpack?.find(isEncrypted);
    ctx.save();
    // Ring
    ctx.strokeStyle = withAlpha(UPLINK_COLOR, inside ? 0.9 : 0.5);
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]);
    ctx.lineDashOffset = -now / 60;
    ctx.beginPath(); ctx.arc(sx, sy, u.radius, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = withAlpha(UPLINK_COLOR, inside ? 0.1 : 0.05);
    ctx.fill();
    // Terminal: a glowing diamond on a base.
    const pulse = 0.6 + 0.4 * Math.sin(now / 300);
    ctx.fillStyle = '#10161d';
    ctx.fillRect(sx - 14, sy - 6, 28, 18);
    ctx.shadowColor = UPLINK_COLOR;
    ctx.shadowBlur = 14 * pulse;
    ctx.fillStyle = UPLINK_COLOR;
    ctx.beginPath(); ctx.moveTo(sx, sy - 22); ctx.lineTo(sx + 9, sy - 10); ctx.lineTo(sx, sy + 2); ctx.lineTo(sx - 9, sy - 10); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    // Progress arc while you decrypt here.
    if (inside && sealed && me.decrypt > 0) {
      ctx.strokeStyle = UPLINK_COLOR;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(sx, sy, u.radius - 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, me.decrypt / DECRYPT_SECS[sealed.rarity]));
      ctx.stroke();
    }
    ctx.restore();
    hudText(u.name.toUpperCase(), sx, sy + 30, { size: 11, weight: 800, color: UPLINK_COLOR, align: 'center' });
    if (inside && !sealed) hudText('Nothing sealed to decrypt', sx, sy + 46, { size: 11, weight: 600, color: theme.textSecondary, align: 'center' });
  }
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
  const gun = myPlayer?.weapons?.[myPlayer.activeSlot];
  const weaponDmg = (myPlayer ? (WEAPON_STATS[myPlayer.weapon]?.damage ?? 25) : 25) * weaponDamageMult(gun?.power ?? 1);

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

    const size = drawEnemySprite(ctx, z.type, sx, sy, angle, !!z.elite);

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
  const maxReach = MELEE_RANGE;
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
      ctx.fillText(`Bleeding out ${Math.ceil(p.bleedout || 0)}s · stand close to revive`, 0, 22);
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
  map: new Path2D('M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14'),
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

/** Pre-rendered walls for the radar and full map (the big maps have hundreds of walls). */
let minimapCache: { canvas: HTMLCanvasElement; scale: number } | null = null;
function wallLayer(): { canvas: HTMLCanvasElement; scale: number } {
  if (minimapCache) return minimapCache;
  const scale = 0.12;
  const c = document.createElement('canvas');
  c.width = Math.ceil(staticMapWidth * scale);
  c.height = Math.ceil(staticMapHeight * scale);
  const g = c.getContext('2d')!;
  g.fillStyle = theme.field;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = theme.borderStrong;
  for (const w of staticWalls) g.fillRect(w.x * scale, w.y * scale, Math.max(1, w.w * scale), Math.max(1, w.h * scale));
  minimapCache = { canvas: c, scale };
  return minimapCache;
}

/** Radar: the area around you (the maps are far bigger than the screen), with
 *  extracts pinned to the rim when they're out of range. */
const RADAR_RANGE = 1500;
function drawMinimap(state: GameState) {
  const me = state.players[myId];
  if (!me) return;
  const pad = 8;
  const size = HUD.sideW - pad * 2;
  const px = canvas.width - HUD.margin - HUD.sideW;
  const py = canvas.height - HUD.margin - HUD.sideW;
  const mmX = px + pad;
  const mmY = py + pad;
  const cx = predictionInitialized ? predictedX : me.pos.x;
  const cy = predictionInitialized ? predictedY : me.pos.y;
  const scale = size / (RADAR_RANGE * 2);
  const toX = (x: number) => mmX + size / 2 + (x - cx) * scale;
  const toY = (y: number) => mmY + size / 2 + (y - cy) * scale;
  const dot = (x: number, y: number, r: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(toX(x), toY(y), r, 0, Math.PI * 2);
    ctx.fill();
  };

  hudPanel(px, py, HUD.sideW, HUD.sideW);
  ctx.save();
  hudRoundRect(mmX, mmY, size, size, 6);
  ctx.clip();
  const layer = wallLayer();
  const k = scale / layer.scale;
  ctx.drawImage(layer.canvas, mmX + size / 2 - cx * scale, mmY + size / 2 - cy * scale, layer.canvas.width * k, layer.canvas.height * k);
  for (const n of staticNests) {
    ctx.strokeStyle = withAlpha(theme.accent, 0.85);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(toX(n.x), toY(n.y), 5, 0, Math.PI * 2);
    ctx.stroke();
  }
  staticCrates.forEach((c, i) => { if (crateAvailability.get(`crate_${i}`)) dot(c.x, c.y, 2.5, theme.money); });
  for (const d of state.drops) if (d.type === 'loot' && d.item) dot(d.pos.x, d.pos.y, 2.5, RARITY_COLOR[d.item.rarity]);
  for (const z of state.zombies) dot(z.pos.x, z.pos.y, z.type === 'abomination' ? 5 : 2, theme.accent);
  for (const e of staticExtracts) {
    ctx.strokeStyle = theme.health;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(toX(e.x), toY(e.y), Math.max(4, e.radius * scale), 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const u of staticUplinks) {
    const ux = toX(u.x), uy = toY(u.y);
    ctx.fillStyle = UPLINK_COLOR;
    ctx.beginPath(); ctx.moveTo(ux, uy - 5); ctx.lineTo(ux + 4, uy); ctx.lineTo(ux, uy + 5); ctx.lineTo(ux - 4, uy); ctx.closePath(); ctx.fill();
  }
  for (const id in state.players) if (id !== myId) dot(state.players[id].pos.x, state.players[id].pos.y, 3.5, theme.text);
  // You, with a heading tick.
  dot(cx, cy, 4, theme.you);
  ctx.strokeStyle = theme.you;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(toX(cx), toY(cy));
  ctx.lineTo(toX(cx) + Math.cos(me.angle) * 10, toY(cy) + Math.sin(me.angle) * 10);
  ctx.stroke();
  ctx.restore();

  // Extracts beyond radar range: green chevrons on the rim.
  for (const e of staticExtracts) {
    const dx = e.x - cx, dy = e.y - cy;
    if (Math.abs(dx) < RADAR_RANGE && Math.abs(dy) < RADAR_RANGE) continue;
    const t = (size / 2 - 7) / Math.max(Math.abs(dx), Math.abs(dy)) / scale;
    const ex = mmX + size / 2 + dx * scale * t, ey = mmY + size / 2 + dy * scale * t;
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.fillStyle = theme.health;
    ctx.beginPath();
    ctx.moveTo(5, 0); ctx.lineTo(-4, -5); ctx.lineTo(-4, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  hudKeycap(keyDisplayName(bindings.toggleMap), px + HUD.sideW - pad - 4, py + pad + 4, 'right');
}

/** Full map overlay (M): the whole raid at a glance. */
function drawFullMap(state: GameState) {
  if (!mapOpen) return;
  const me = state.players[myId];
  ctx.fillStyle = 'rgba(5, 6, 9, 0.78)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const maxW = canvas.width - 120, maxH = canvas.height - 200;
  const scale = Math.min(maxW / staticMapWidth, maxH / staticMapHeight);
  const w = staticMapWidth * scale, h = staticMapHeight * scale;
  const x0 = (canvas.width - w) / 2, y0 = (canvas.height - h) / 2 + 20;
  const X = (x: number) => x0 + x * scale, Y = (y: number) => y0 + y * scale;
  hudPanel(x0 - 12, y0 - 52, w + 24, h + 64);
  hudText(raidMap ? `${raidMap.name} · Tier ${raidMap.tier}` : 'Map', x0, y0 - 22, { size: 16, weight: 800, caps: true });
  let lx = x0 + w;
  for (const [label, color] of [['You', theme.you], ['Crate', theme.money], ['Nest', theme.accent], ['Uplink', UPLINK_COLOR], ['Extract', theme.health]] as const) {
    const tw = hudText(label, lx, y0 - 22, { size: 12, weight: 600, color: theme.textSecondary, align: 'right' });
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lx - tw - 9, y0 - 26, 4, 0, Math.PI * 2);
    ctx.fill();
    lx -= tw + 28;
  }
  const layer = wallLayer();
  ctx.drawImage(layer.canvas, x0, y0, w, h);
  for (const n of staticNests) {
    ctx.fillStyle = withAlpha(theme.accent, 0.25);
    // Match the monsters' home territory, rather than the nest activation range.
    ctx.beginPath(); ctx.arc(X(n.x), Y(n.y), 800 * scale, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = theme.accent;
    ctx.beginPath(); ctx.arc(X(n.x), Y(n.y), 5, 0, Math.PI * 2); ctx.fill();
  }
  staticCrates.forEach((c, i) => {
    if (!crateAvailability.get(`crate_${i}`)) return;
    ctx.fillStyle = theme.money;
    ctx.fillRect(X(c.x) - 2, Y(c.y) - 2, 4, 4);
  });
  for (const e of staticExtracts) {
    ctx.strokeStyle = theme.health;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(X(e.x), Y(e.y), Math.max(7, e.radius * scale), 0, Math.PI * 2); ctx.stroke();
    hudText(e.name, X(e.x), Y(e.y) + (e.y < staticMapHeight / 2 ? 24 : -16), { size: 12, weight: 700, color: theme.health, align: 'center' });
  }
  for (const u of staticUplinks) {
    const ux = X(u.x), uy = Y(u.y);
    ctx.fillStyle = UPLINK_COLOR;
    ctx.beginPath(); ctx.moveTo(ux, uy - 8); ctx.lineTo(ux + 6, uy); ctx.lineTo(ux, uy + 8); ctx.lineTo(ux - 6, uy); ctx.closePath(); ctx.fill();
    hudText(u.name, ux, uy + 20, { size: 11, weight: 700, color: UPLINK_COLOR, align: 'center' });
  }
  for (const id in state.players) {
    const p = state.players[id];
    const mine = id === myId;
    ctx.fillStyle = mine ? theme.you : p.health > 0 ? theme.text : theme.accent;
    ctx.beginPath(); ctx.arc(X(p.pos.x), Y(p.pos.y), mine ? 6 : 4, 0, Math.PI * 2); ctx.fill();
    if (!mine) hudText(p.name, X(p.pos.x), Y(p.pos.y) - 9, { size: 11, weight: 700, align: 'center' });
  }
  if (me) {
    const ne = nearest(staticExtracts, me.pos.x, me.pos.y);
    if (ne) {
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = withAlpha(theme.health, 0.7);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(X(me.pos.x), Y(me.pos.y)); ctx.lineTo(X(ne.point.x), Y(ne.point.y)); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  hudText(`Press ${keyDisplayName(bindings.toggleMap)} or Esc to close · the raid keeps running`, canvas.width / 2, y0 + h + 34, { size: 12, weight: 600, color: theme.textSecondary, align: 'center' });
}

/** Shared geometry for the hotbar: katana, dash | 2 guns | 3 deployables | map. */
function hotbarLayout() {
  const gap = 6;
  const groupGap = 17;
  const slots = 8;
  const fixed = gap * 4 + groupGap * 3;
  const room = canvas.width - 2 * (HUD.margin + HUD.sideW + 24);
  const slotW = Math.max(54, Math.min(84, Math.floor((room - fixed) / slots)));
  const slotH = 66;
  const totalW = slotW * slots + fixed;
  return { slotW, slotH, gap, groupGap, totalW, x: Math.round((canvas.width - totalW) / 2), y: canvas.height - HUD.margin - slotH };
}

/** Height of the desktop status card (bottom left). */
const STATUS_CARD_H = 168;

/**
 * Vitals. Desktop: a status card in the bottom-left corner (health, ammo, the
 * bounty and pack you'd lose by dying) that mirrors the radar.
 * Touch screens keep a slim strip under the raid header.
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

  const maxHp = p.maxHealth || 100;
  const hpPct = p.health / maxHp;
  const lowHp = hpPct <= 0.3;
  hudLabel('Health', x + pad, y + 30, 'left', lowHp ? theme.accent : theme.textSecondary);
  const hpTotalW = hudText(` / ${maxHp}`, right, y + 30, { size: 13, weight: 600, color: theme.textMuted, align: 'right' });
  hudText(`${Math.ceil(Math.max(0, p.health))}`, right - hpTotalW, y + 30, { size: 18, weight: 800, color: lowHp ? theme.accent : theme.text, align: 'right' });
  ctx.save();
  if (lowHp) ctx.globalAlpha = 0.65 + 0.35 * Math.sin(performance.now() / 120);
  hudBar(x + pad, y + 40, w - pad * 2, 10, hpPct, lowHp ? theme.accent : theme.health);
  ctx.restore();

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

  // What's at stake: banked only if you extract.
  hudLabel('Bounty', x + pad, y + 118);
  hudText(`$${fmtInt(p.bounty ?? 0)}`, right, y + 118, { size: 18, weight: 800, color: theme.money, align: 'right' });
  const pack = p.backpack ?? [];
  const cap = p.backpackCapacity || 4;
  const packLabelW = hudLabel('Pack', x + pad, y + 150);
  hudKeycap(keyDisplayName(bindings.inventory), x + pad + packLabelW + 6, y + 136);
  const full = pack.length >= cap;
  const valW = hudText(`$${fmtInt(backpackValue(pack))}`, right, y + 150, { size: 13, weight: 700, color: theme.textSecondary, align: 'right' });
  hudText(`${pack.length}/${cap}  `, right - valW, y + 150, { size: 18, weight: 800, color: full ? theme.money : theme.text, align: 'right' });
  // One pip per slot, filled in the item's rarity color.
  const pipW = Math.min(12, (w - pad * 2 - (cap - 1) * 3) / cap);
  for (let i = 0; i < cap; i++) {
    const item = pack[i];
    hudRoundRect(x + pad + i * (pipW + 3), y + 158, pipW, 4, 2);
    ctx.fillStyle = item ? RARITY_COLOR[item.rarity] : HUD.track;
    ctx.fill();
  }
}

/** Touch layout: one slim strip under the raid header. */
function drawVitalsStrip(p: Player) {
  const h = 40;
  const w = Math.min(hotbarLayout().totalW, canvas.width - HUD.margin * 2);
  const x = Math.round((canvas.width - w) / 2);
  const y = HUD.margin + (threatLevel(p.camp || 0, !!p.hunted) === 'none' ? 76 : 102);
  const pad = HUD.pad;
  const base = y + 26;
  hudPanel(x, y, w, h);
  const inner = w - pad * 2;
  const ammoX = x + pad + Math.round(inner * 0.5);
  const bountyX = ammoX + Math.round(inner * 0.25);
  ctx.fillStyle = HUD.border;
  ctx.fillRect(ammoX - 12, y + 9, 1, h - 18);
  ctx.fillRect(bountyX - 12, y + 9, 1, h - 18);
  const maxHp = p.maxHealth || 100;
  const hpPct = p.health / maxHp;
  const lowHp = hpPct <= 0.3;
  const labelW = hudLabel('HP', x + pad, base - 1, 'left', lowHp ? theme.accent : theme.textSecondary);
  const valueRight = ammoX - 26;
  const valueW = hudText(`${Math.ceil(Math.max(0, p.health))}`, valueRight, base, { size: 18, weight: 800, color: lowHp ? theme.accent : theme.text, align: 'right' });
  const barX = x + pad + labelW + 12;
  hudBar(barX, y + h / 2 - 5, valueRight - valueW - 10 - barX, 10, hpPct, lowHp ? theme.accent : theme.health);
  const ammoLabelW = hudLabel('Ammo', ammoX, base - 1);
  hudText(p.weapon === 'pistol' ? '∞' : `${Math.floor(p.ammo)}`, ammoX + ammoLabelW + 10, base, { size: 18, weight: 800 });
  hudText(`$${fmtInt(p.bounty ?? 0)} · ${(p.backpack ?? []).length}/${p.backpackCapacity || 4}`, bountyX, base, { size: 15, weight: 800, color: theme.money });
}

/**
 * Raid header (top centre): map, raid clock, the nearest extraction and the
 * camping threat. While extracting it becomes a progress bar.
 */
function drawRaidHeader(state: GameState) {
  const me = state.players[myId];
  if (!me) return;
  const w = 380;
  const x = Math.round((canvas.width - w) / 2);
  const y = HUD.margin;
  const pad = HUD.pad;
  const threat = threatLevel(me.camp || 0, !!me.hunted);
  const h = threat === 'none' ? 66 : 92;
  const lowTime = me.raidTime <= 120;
  hudPanel(x, y, w, h, { border: threat === 'hunted' ? theme.accent : lowTime ? theme.money : HUD.border });

  hudText(raidMap?.name ?? 'Raid', x + pad, y + 26, { size: 16, weight: 800, caps: true, maxWidth: 190 });
  ctx.save();
  if (me.raidTime <= 60) ctx.globalAlpha = 0.7 + 0.3 * Math.sin(performance.now() / 150);
  const leftW = hudText(' left', x + w - pad, y + 26, { size: 12, weight: 600, color: theme.textSecondary, align: 'right' });
  hudText(formatClock(me.raidTime), x + w - pad - leftW, y + 27, { size: 20, weight: 800, color: lowTime ? (me.raidTime <= 60 ? theme.accent : theme.money) : theme.text, align: 'right' });
  ctx.restore();

  const extracting = (me.extractProgress || 0) > 0;
  const ne = nearest(staticExtracts, me.pos.x, me.pos.y);
  const sealed = (me.backpack ?? []).find(isEncrypted);
  if (extracting) {
    hudText(`Extracting · ${Math.max(0, EXTRACT_TIME - me.extractProgress).toFixed(1)}s`, x + pad, y + 48, { size: 13, weight: 800, color: theme.health });
    hudBar(x + pad, y + 54, w - pad * 2, 6, me.extractProgress / EXTRACT_TIME, theme.health);
  } else if (sealed && (me.decrypt || 0) > 0) {
    const need = DECRYPT_SECS[sealed.rarity];
    hudText(`Decrypting ${sealed.name} · ${Math.max(0, need - me.decrypt).toFixed(1)}s`, x + pad, y + 48, { size: 13, weight: 800, color: UPLINK_COLOR, maxWidth: w - pad * 2 });
    hudBar(x + pad, y + 54, w - pad * 2, 6, me.decrypt / need, UPLINK_COLOR);
  } else if (sealed) {
    const nu = nearest(staticUplinks, me.pos.x, me.pos.y);
    if (nu) {
      const dx = nu.point.x - me.pos.x, dy = nu.point.y - me.pos.y;
      hudText(`Sealed loot · ${nu.point.name}`, x + pad, y + 50, { size: 12, weight: 600, color: theme.textSecondary });
      hudText(`${formatDistance(nu.dist)} ${compass(dx, dy)}`, x + w - pad, y + 50, { size: 13, weight: 700, color: UPLINK_COLOR, align: 'right' });
    }
  } else if (ne) {
    const dx = ne.point.x - me.pos.x, dy = ne.point.y - me.pos.y;
    hudText('Nearest extract', x + pad, y + 50, { size: 12, weight: 600, color: theme.textSecondary });
    hudText(`${ne.point.name} · ${formatDistance(ne.dist)} ${compass(dx, dy)}`, x + w - pad, y + 50, { size: 13, weight: 700, color: theme.health, align: 'right', maxWidth: w - 130 });
  }

  if (threat === 'warning') {
    const pct = Math.min(1, (me.camp - CAMP_WARNING) / (CAMP_LIMIT - CAMP_WARNING));
    hudText(campWarningText(me.camp), x + pad, y + 76, { size: 12, weight: 700, color: theme.money });
    hudBar(x + pad, y + 82, w - pad * 2, 4, pct, theme.money);
  } else if (threat === 'hunted') {
    ctx.save();
    ctx.globalAlpha = 0.7 + 0.3 * Math.sin(performance.now() / 120);
    const mine = state.zombies.filter(z => z.target === myId);
    const boss = mine.some(z => z.type === 'abomination');
    hudText(boss ? 'Abomination hunt · survive 30s, extract or fight' : 'Elite hunt · survive 30s, extract or fight', x + pad, y + 80, { size: 13, weight: 800, color: theme.accent, maxWidth: w - pad * 2 - 60 });
    ctx.restore();
    const closest = nearest(mine.map(z => z.pos), me.pos.x, me.pos.y);
    if (closest) hudText(formatDistance(closest.dist), x + w - pad, y + 80, { size: 13, weight: 800, color: theme.accent, align: 'right' });
  }
}

/** Off-screen pointer toward the nearest extraction, at the edge of the play area. */
function drawExtractPointer(state: GameState) {
  const me = state.players[myId];
  if (!me) return;
  const ne = nearest(staticExtracts, me.pos.x, me.pos.y);
  if (!ne) return;
  const sx = ne.point.x - camX, sy = ne.point.y - camY;
  if (sx > 0 && sx < canvas.width && sy > 0 && sy < canvas.height) return;
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const a = Math.atan2(sy - cy, sx - cx);
  const r = Math.min(canvas.width, canvas.height) * 0.32;
  ctx.save();
  ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  ctx.rotate(a);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = theme.health;
  ctx.beginPath();
  ctx.moveTo(12, 0); ctx.lineTo(-6, -8); ctx.lineTo(-2, 0); ctx.lineTo(-6, 8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Standing on loot with a full pack: say why it wasn't picked up. */
function drawLootHint(state: GameState) {
  const me = state.players[myId];
  if (!me || me.health <= 0) return;
  const cap = me.backpackCapacity || 4;
  for (const d of state.drops) {
    if (d.type !== 'loot' || !d.item) continue;
    if (Math.hypot(d.pos.x - me.pos.x, d.pos.y - me.pos.y) > 34) continue;
    const dropped = recentlyDropped.get(d.item.id);
    if (dropped && performance.now() - dropped < 5000) continue;
    const swap = swapCandidate(me.backpack ?? [], cap, d.item);
    if (swap === 'fits') continue;
    const dropKey = keyDisplayName(bindings.dropItem);
    const valuable = d.item.kind === 'valuable';
    const text = swap
      ? `Pack full: swapping your ${swap.name} for this`
      : `Pack full · ${dropKey} drops ${me.backpack?.at(-1)?.name ?? 'your last pickup'} (your last pickup)`;
    void valuable;
    const key = `${d.id}|${text}`;
    if (key !== lootHintKey) { lootHintKey = key; }
    hudText(text, canvas.width / 2, canvas.height / 2 + 70, { size: 13, weight: 700, color: theme.money, align: 'center' });
    const detail = isEncrypted(d.item)
      ? `${RARITY_LABEL[d.item.rarity]} sealed item · ~$${fmtInt(estimatedValue(d.item))} once decrypted at an uplink`
      : `${RARITY_LABEL[d.item.rarity]} ${KIND_LABEL[d.item.kind]} · power ${d.item.power} · ${itemEffect(d.item)} · $${fmtInt(d.item.value)}`;
    hudText(detail, canvas.width / 2, canvas.height / 2 + 88, { size: 12, weight: 600, color: theme.textSecondary, align: 'center' });
    return;
  }
}

/** Red pulse at the screen edges while an Abomination hunts you. */
function drawThreatOverlay(state: GameState) {
  const me = state.players[myId];
  if (!me?.hunted) return;
  const a = 0.18 + 0.1 * Math.sin(performance.now() / 260);
  const g = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, canvas.width * 0.3, canvas.width / 2, canvas.height / 2, canvas.width * 0.7);
  g.addColorStop(0, 'rgba(120, 20, 50, 0)');
  g.addColorStop(1, `rgba(120, 20, 50, ${a})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
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
  const mult = Math.min(COMBO_MAX_MULT, 1.0 + (p.combo - 1) * 0.2);
  const bonus = Math.round((mult - 1) * 100);
  hudPanel(x, y, w, h, { border: overdrive ? theme.money : HUD.border });

  const labelW = hudLabel('Combo', x + pad, y + 22);
  hudText(`×${p.combo}`, x + pad + labelW + 6, y + 22, { size: 13, weight: 800 });
  if (overdrive) hudTag('OVERDRIVE', x + w - pad, y + 9, theme.money);
  else if (mult >= COMBO_MAX_MULT) hudTag('MAX', x + w - pad, y + 9, theme.money);
  const bonusW = hudText(`+${bonus}%`, x + pad, y + 46, { size: 20, weight: 800, color: theme.money });
  hudText('kill bounty', x + pad + bonusW + 6, y + 46, { size: 12, weight: 600, color: theme.textSecondary });
  hudBar(x + pad, y + 53, w - pad * 2, 4, (p.comboTimer || 0) / COMBO_DURATION, theme.money);
}

/**
 * Teammates off screen: a name chip pinned to the edge of a safe frame (clear of
 * every HUD panel), with a chevron pointing toward them. Red while they're downed.
 */
function drawTeammateMarkers(state: GameState) {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const top = HUD.margin + 104;
  const bottom = canvas.height - HUD.margin - (isMobile ? 0 : STATUS_CARD_H) - 30;
  const left = HUD.margin + 24;
  const right = canvas.width - HUD.margin - 24;
  // Side panels the chips must also clear (x, y, w, h): squad list, minimap, combo meter.
  const squadH = 38 + Object.keys(state.players).length * 30 + 4;
  const mapH = HUD.sideW;
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
  const side = isMobile ? 0 : HUD.margin + HUD.sideW + 24;
  ctx.fillRect(side, cy - 46, canvas.width - side * 2, 92);
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
  /** Rarity color for gear: a stripe along the bottom edge. */
  accent?: string;
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
  if (s.accent) {
    hudRoundRect(x + 8, y + h - 4, w - 16, 3, 1.5);
    ctx.fillStyle = s.accent;
    ctx.fill();
  }
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

  hotbarMeleeBtnRect = { x, y: barY, w: slotW, h: slotH };
  drawHotbarSlot(x, barY, slotW, slotH, {
    key: keyDisplayName(bindings.melee), icon: HOTBAR_ICONS.katana, name: 'Katana',
    active: meleeSwingTime > 0, cooldown: meleeCooldownTimer / MELEE_COOLDOWN,
  });
  x += slotW + gap;

  hotbarDashBtnRect = { x, y: barY, w: slotW, h: slotH };
  drawHotbarSlot(x, barY, slotW, slotH, {
    key: keyDisplayName(bindings.dash), icon: HOTBAR_ICONS.dash, name: 'Dash',
    pips: { filled: dashCharges, total: DASH_MAX_CHARGES },
    active: dashIframeTimer > 0, disabled: dashCharges === 0,
    cooldown: dashCharges < DASH_MAX_CHARGES ? dashRechargeTimer / DASH_RECHARGE_TIME : 0,
  });
  x += slotW + groupGap;
  groupDivider();

  // The two guns you brought in. The equipped one shows its ammo; the frame takes its rarity color.
  const icons: Record<string, Path2D> = { pistol: HOTBAR_ICONS.pistol, uzi: HOTBAR_ICONS.uzi, shotgun: HOTBAR_ICONS.shotgun, rocketLauncher: HOTBAR_ICONS.rocket };
  const shortName: Record<string, string> = { pistol: 'Pistol', uzi: 'Uzi', shotgun: 'Shotgun', rocketLauncher: 'Rocket' };
  const weaponKeys = [bindings.weapon1, bindings.weapon2];
  hotbarWeaponRects = [];
  for (let i = 0; i < 2; i++) {
    const gun = p.weapons?.[i];
    hotbarWeaponRects.push({ slot: i + 1, x, y: barY, w: slotW, h: slotH });
    const equipped = !!gun && p.activeSlot === i;
    drawHotbarSlot(x, barY, slotW, slotH, gun ? {
      key: keyDisplayName(weaponKeys[i]), icon: icons[gun.kind], name: `${shortName[gun.kind]} ${gun.power}`, active: equipped,
      tag: equipped ? (gun.kind === 'pistol' ? '∞' : `${Math.floor(p.ammo)}`) : undefined, accent: RARITY_COLOR[gun.rarity],
    } : {
      key: keyDisplayName(weaponKeys[i]), icon: HOTBAR_ICONS.lock, name: 'Empty', disabled: true,
    });
    x += slotW + gap;
  }
  x += groupGap - gap;
  groupDivider();

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

  hotbarMapBtnRect = { x, y: barY, w: slotW, h: slotH };
  drawHotbarSlot(x, barY, slotW, slotH, {
    key: keyDisplayName(bindings.toggleMap), icon: HOTBAR_ICONS.map, name: 'Map', open: mapOpen,
  });
}

/** Squad status: name, health and kills, so you can see who needs help. */
function drawScoreboardAndFeed(state: GameState) {
  const playerList = Object.values(state.players).sort((a, b) => b.kills - a.kills);
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
  hudLabel('Kills', x + w - pad, y + 24, 'right');
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
    hudText(fmtInt(p.kills || 0), x + w - pad, ry + 18, { size: 13, weight: 700, color: down ? theme.textMuted : theme.text, align: 'right' });
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
  const visible = player && player.health <= 0 && (currentScreen === 'playing' || (currentScreen === 'results' && lastRaidEnd?.outcome.result === 'killed'));
  deathRecap.hidden = !visible;
  if (!visible) { recapKey = ''; recapShowAll = false; return; }
  const over = currentScreen === 'results';
  const parent = over ? document.getElementById('resultsDetails')! : document.body;
  if (deathRecap.parentElement !== parent) parent.appendChild(deathRecap);
  deathRecap.classList.toggle('recap--floating', !over);
  const hits = player.damageLog || [];
  const key = `${over}|${JSON.stringify(hits)}|${recapShowAll}`;
  if (key === recapKey) return;
  recapKey = key;

  const name = enemyName;
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

  if (currentScreen === 'playing' || currentScreen === 'results') {
    const state = buildRenderState();

    if (state) {
      updateCamera(dt);

      ctx.fillStyle = '#252830';
      ctx.fillRect(-camX, -camY, staticMapWidth, staticMapHeight);

      if (!isMobile) drawGrid();
      drawNests();
      drawExtracts(state);
      drawUplinks(state);
      drawBloodStains();
      drawWalls();
      drawAmmoPickups();
      drawCrates();
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
      drawThreatOverlay(state);
      drawExtractPointer(state);
      drawHUD(state);
      drawRaidHeader(state);
      drawComboHUD(state);
      drawScoreboardAndFeed(state);
      if (!isMobile) drawWeaponAndTacticalBar(state);
      drawTeammateMarkers(state);
      drawLootHint(state);
      drawWaveBanner(dt);
      drawMobileControls();
      drawFullMap(state);
      renderRaidInventory();
    } else {
      ctx.fillStyle = theme.textSecondary;
      ctx.font = font(18, 600);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`Deploying to ${currentRoomName}…`, canvas.width / 2, canvas.height / 2);
    }
  }

  requestAnimationFrame(draw);
}

draw();
