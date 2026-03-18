import { GameState, ClientInput } from '../shared/types';

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const scoreDisplay = document.getElementById('scoreDisplay')!;

let state: GameState | null = null;
let myId = '';

const input: ClientInput = {
  up: false, down: false, left: false, right: false,
  mouseX: 0, mouseY: 0, shooting: false
};

const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsPort = import.meta.env.DEV ? '3000' : window.location.port;
const wsHost = `${window.location.hostname}:${wsPort}`;
const ws = new WebSocket(`${wsProtocol}//${wsHost}`);

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'init') {
    myId = data.id;
  } else if (data.type === 'state') {
    state = data.state;
  }
};

window.addEventListener('keydown', (e) => {
  if (e.key === 'w') input.up = true;
  if (e.key === 's') input.down = true;
  if (e.key === 'a') input.left = true;
  if (e.key === 'd') input.right = true;
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'w') input.up = false;
  if (e.key === 's') input.down = false;
  if (e.key === 'a') input.left = false;
  if (e.key === 'd') input.right = false;
});

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  input.mouseX = e.clientX - rect.left;
  input.mouseY = e.clientY - rect.top;
});

canvas.addEventListener('mousedown', () => input.shooting = true);
canvas.addEventListener('mouseup', () => input.shooting = false);

setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', input }));
  }
}, 1000 / 60);

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (state) {
    // Draw zombies (green squares)
    ctx.fillStyle = '#4CAF50';
    for (const z of state.zombies) {
      ctx.fillRect(z.pos.x - 10, z.pos.y - 10, 20, 20);
    }

    // Draw bullets (yellow dots)
    ctx.fillStyle = '#FFEB3B';
    for (const b of state.bullets) {
      ctx.beginPath();
      ctx.arc(b.pos.x, b.pos.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw players
    for (const id in state.players) {
      const p = state.players[id];
      ctx.save();
      ctx.translate(p.pos.x, p.pos.y);
      ctx.rotate(p.angle);
      
      // Box body
      ctx.fillStyle = id === myId ? '#2196F3' : '#F44336';
      ctx.fillRect(-15, -15, 30, 30);
      
      // Gun barrel
      ctx.fillStyle = '#9E9E9E';
      ctx.fillRect(15, -5, 15, 10);
      
      ctx.restore();

      // Health bar
      ctx.fillStyle = 'red';
      ctx.fillRect(p.pos.x - 15, p.pos.y - 25, 30, 4);
      ctx.fillStyle = 'green';
      ctx.fillRect(p.pos.x - 15, p.pos.y - 25, 30 * (p.health / 100), 4);
    }

    if (state.players[myId]) {
      scoreDisplay.innerText = `Score: ${state.players[myId].score} | Wave: ${state.wave}`;
    }
  }

  requestAnimationFrame(draw);
}

draw();
