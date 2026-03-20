import { GameState, ClientInput, WEAPON_STATS } from '../shared/types';

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const scoreDisplay = document.getElementById('scoreDisplay')!;

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

let state: GameState | null = null;
let myId = '';
let camX = 0;
let camY = 0;
let screenMouseX = 0;
let screenMouseY = 0;

// Melee visual effect
let meleeSwingTime = 0;
let meleeSwingAngle = 0;

const input: ClientInput = {
  up: false, down: false, left: false, right: false,
  mouseX: 0, mouseY: 0, shooting: false, melee: false, switchWeapon: false
};

const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProtocol}//${window.location.host}`);

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'init') {
    myId = data.id;
  } else if (data.type === 'state') {
    state = data.state;
  }
};

window.addEventListener('keydown', (e) => {
  if (e.key === 'w' || e.key === 'W') input.up = true;
  if (e.key === 's' || e.key === 'S') input.down = true;
  if (e.key === 'a' || e.key === 'A') input.left = true;
  if (e.key === 'd' || e.key === 'D') input.right = true;
  if (e.key === ' ' || e.key === 'e' || e.key === 'E') {
    input.melee = true;
    meleeSwingTime = 0.3; // visual duration
    if (state?.players[myId]) {
      meleeSwingAngle = state.players[myId].angle;
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'w' || e.key === 'W') input.up = false;
  if (e.key === 's' || e.key === 'S') input.down = false;
  if (e.key === 'a' || e.key === 'A') input.left = false;
  if (e.key === 'd' || e.key === 'D') input.right = false;
  if (e.key === ' ' || e.key === 'e' || e.key === 'E') input.melee = false;
});

window.addEventListener('mousemove', (e) => {
  screenMouseX = e.clientX;
  screenMouseY = e.clientY;
  input.mouseX = screenMouseX + camX;
  input.mouseY = screenMouseY + camY;
});

window.addEventListener('mousedown', () => input.shooting = true);
window.addEventListener('mouseup', () => input.shooting = false);
window.addEventListener('contextmenu', (e) => e.preventDefault());

setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    input.mouseX = screenMouseX + camX;
    input.mouseY = screenMouseY + camY;
    ws.send(JSON.stringify({ type: 'input', input }));
  }
}, 1000 / 60);

let lastFrameTime = performance.now();

function updateCamera() {
  if (!state || !state.players[myId]) return;
  const p = state.players[myId];
  const targetX = p.pos.x - canvas.width / 2;
  const targetY = p.pos.y - canvas.height / 2;
  camX = Math.max(0, Math.min(state.mapWidth - canvas.width, targetX));
  camY = Math.max(0, Math.min(state.mapHeight - canvas.height, targetY));
}

function drawGrid() {
  if (!state) return;
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
  if (!state) return;
  for (const w of state.walls) {
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
  if (!state) return;
  for (const pickup of state.ammoPickups) {
    // Skip if not yet respawned (respawnAt > 0 means it was picked up)
    // We can't easily check gameTime from client, so server sends respawnAt
    // If respawnAt > 0 and we don't know server time, we just show all with respawnAt === 0
    // Actually let's just check if it exists — server handles availability
    if (pickup.respawnAt > 0) continue; // picked up, waiting to respawn

    const sx = pickup.pos.x - camX;
    const sy = pickup.pos.y - camY;
    if (sx < -30 || sx > canvas.width + 30 || sy < -30 || sy > canvas.height + 30) continue;

    // Pulsing glow
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 300);

    // Outer glow
    ctx.shadowColor = `rgba(255, 200, 0, ${pulse * 0.5})`;
    ctx.shadowBlur = 15;

    // Ammo box
    ctx.fillStyle = `rgba(255, 180, 0, ${pulse})`;
    ctx.fillRect(sx - 12, sy - 8, 24, 16);
    ctx.strokeStyle = '#aa7700';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx - 12, sy - 8, 24, 16);

    // Bullet icon on box
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('AMMO', sx, sy + 4);

    ctx.shadowBlur = 0;
  }
}

// Draw health bar with tick marks showing shots-to-kill
function drawTickHealthBar(sx: number, sy: number, health: number, maxHealth: number, barW: number, weaponDmg: number) {
  const barH = 4;
  const y = sy;

  // Background
  ctx.fillStyle = '#333';
  ctx.fillRect(sx - 1, y - 1, barW + 2, barH + 2);

  // Red background (lost health)
  ctx.fillStyle = 'rgba(200, 0, 0, 0.6)';
  ctx.fillRect(sx, y, barW, barH);

  // Green fill (current health)
  const healthPct = Math.max(0, health / maxHealth);
  const fillW = barW * healthPct;
  ctx.fillStyle = health / maxHealth > 0.3 ? '#4CAF50' : '#FF9800';
  ctx.fillRect(sx, y, fillW, barH);

  // Tick marks showing damage chunks
  if (weaponDmg > 0 && maxHealth > 0) {
    const shotsToKill = Math.ceil(maxHealth / weaponDmg);
    // Only draw ticks if there are between 2 and ~20 chunks (otherwise too dense)
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

function drawZombies() {
  if (!state) return;

  // Get current player's weapon damage for tick marks
  const myPlayer = state.players[myId];
  const weaponDmg = myPlayer ? (WEAPON_STATS[myPlayer.weapon]?.damage ?? 25) : 25;

  for (const z of state.zombies) {
    const sx = z.pos.x - camX;
    const sy = z.pos.y - camY;
    if (sx < -30 || sx > canvas.width + 30 || sy < -30 || sy > canvas.height + 30) continue;

    const isDevil = z.type === 'devil';
    const size = isDevil ? 14 : 10;

    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.beginPath();
    ctx.ellipse(sx, sy + size + 2, size * 0.8, size * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body
    ctx.fillStyle = isDevil ? '#e53935' : '#4CAF50';
    ctx.fillRect(sx - size, sy - size, size * 2, size * 2);

    // Eyes
    ctx.fillStyle = isDevil ? '#ffeb3b' : '#fff';
    ctx.fillRect(sx - 5, sy - 5, 4, 4);
    ctx.fillRect(sx + 2, sy - 5, 4, 4);
    ctx.fillStyle = '#000';
    ctx.fillRect(sx - 4, sy - 4, 2, 2);
    ctx.fillRect(sx + 3, sy - 4, 2, 2);

    // Devil horns
    if (isDevil) {
      ctx.fillStyle = '#b71c1c';
      ctx.beginPath();
      ctx.moveTo(sx - size, sy - size);
      ctx.lineTo(sx - size + 4, sy - size - 8);
      ctx.lineTo(sx - size + 8, sy - size);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(sx + size - 8, sy - size);
      ctx.lineTo(sx + size - 4, sy - size - 8);
      ctx.lineTo(sx + size, sy - size);
      ctx.fill();
    }

    // Health bar with tick marks
    const barW = size * 2 + 4;
    drawTickHealthBar(sx - barW / 2, sy - size - 8, z.health, z.maxHealth, barW, weaponDmg);
  }
}

function drawBullets() {
  if (!state) return;
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

function drawMeleeSwing(dt: number) {
  if (meleeSwingTime <= 0) return;
  meleeSwingTime -= dt;
  if (!state || !state.players[myId]) return;

  const p = state.players[myId];
  const sx = p.pos.x - camX;
  const sy = p.pos.y - camY;

  const progress = 1 - (meleeSwingTime / 0.3); // 0 to 1
  const alpha = 1 - progress;
  const arcRadius = 30 + progress * 20;

  ctx.save();
  ctx.translate(sx, sy);

  // Sweep arc
  ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.8})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  const startAngle = meleeSwingAngle - Math.PI / 4;
  const endAngle = meleeSwingAngle + Math.PI / 4;
  ctx.arc(0, 0, arcRadius, startAngle, endAngle);
  ctx.stroke();

  // Impact sparks at the end of the arc
  if (progress < 0.5) {
    ctx.fillStyle = `rgba(255, 200, 100, ${alpha})`;
    for (let i = 0; i < 3; i++) {
      const angle = meleeSwingAngle + (Math.random() - 0.5) * Math.PI / 3;
      const dist = arcRadius + Math.random() * 10;
      ctx.beginPath();
      ctx.arc(Math.cos(angle) * dist, Math.sin(angle) * dist, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

function drawPlayers() {
  if (!state) return;
  for (const id in state.players) {
    const p = state.players[id];
    const sx = p.pos.x - camX;
    const sy = p.pos.y - camY;
    if (sx < -50 || sx > canvas.width + 50 || sy < -50 || sy > canvas.height + 50) continue;

    ctx.save();
    ctx.translate(sx, sy);

    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.beginPath();
    ctx.ellipse(0, 18, 12, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(p.angle);

    const isMe = id === myId;
    ctx.fillStyle = isMe ? '#2196F3' : '#F44336';
    ctx.fillRect(-15, -15, 30, 30);
    ctx.strokeStyle = isMe ? '#1565C0' : '#C62828';
    ctx.lineWidth = 2;
    ctx.strokeRect(-15, -15, 30, 30);

    // Gun barrel
    ctx.fillStyle = '#757575';
    ctx.fillRect(15, -4, 18, 8);
    ctx.fillStyle = '#616161';
    ctx.fillRect(15, -4, 18, 2);

    ctx.restore();

    // Health bar
    const barW = 34;
    ctx.fillStyle = '#333';
    ctx.fillRect(sx - barW / 2 - 1, sy - 28, barW + 2, 6);
    ctx.fillStyle = '#c62828';
    ctx.fillRect(sx - barW / 2, sy - 27, barW, 4);
    ctx.fillStyle = p.health > 30 ? '#4CAF50' : '#FF9800';
    ctx.fillRect(sx - barW / 2, sy - 27, barW * (p.health / 100), 4);
  }
}

function drawMinimap() {
  if (!state) return;
  const mmW = 180;
  const mmH = mmW * (state.mapHeight / state.mapWidth);
  const mmX = canvas.width - mmW - 15;
  const mmY = canvas.height - mmH - 15;
  const scaleX = mmW / state.mapWidth;
  const scaleY = mmH / state.mapHeight;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(mmX - 2, mmY - 2, mmW + 4, mmH + 4);
  ctx.fillStyle = '#444';
  ctx.fillRect(mmX, mmY, mmW, mmH);

  ctx.fillStyle = '#666';
  for (const w of state.walls) {
    ctx.fillRect(mmX + w.x * scaleX, mmY + w.y * scaleY, Math.max(1, w.w * scaleX), Math.max(1, w.h * scaleY));
  }

  // Ammo pickups on minimap
  for (const pickup of state.ammoPickups) {
    if (pickup.respawnAt > 0) continue;
    ctx.fillStyle = '#ffb400';
    ctx.fillRect(mmX + pickup.pos.x * scaleX - 2, mmY + pickup.pos.y * scaleY - 2, 4, 4);
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

function drawHUD() {
  if (!state || !state.players[myId]) return;
  const p = state.players[myId];

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
  ctx.fillText(`[${p.weapon.toUpperCase()}]  Melee: Space/E`, 20, 72);

  // Weapon damage indicator
  const dmg = WEAPON_STATS[p.weapon]?.damage ?? 0;
  if (dmg > 0) {
    ctx.fillStyle = '#ffb400';
    ctx.fillText(`DMG: ${dmg}`, 20, 84);
  }
}

function draw() {
  const now = performance.now();
  const dt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (state) {
    updateCamera();

    ctx.fillStyle = '#3d3d3d';
    ctx.fillRect(-camX, -camY, state.mapWidth, state.mapHeight);

    drawGrid();
    drawWalls();
    drawAmmoPickups();
    drawBullets();
    drawZombies();
    drawPlayers();
    drawMeleeSwing(dt);
    drawMinimap();
    drawHUD();

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
