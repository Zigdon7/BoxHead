import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { Game } from './game';
import { DeltaTracker } from './delta';
import { ClientInput, InitPayload } from '../shared/types';

const app = express();
const port = process.env.PORT || 3001;

// In production, serve built client from dist/client
const clientDir = process.env.NODE_ENV === 'production'
  ? path.join(__dirname, '../../dist/client')
  : path.join(__dirname, '../client');
app.use(express.static(clientDir));

const server = app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

const wss = new WebSocketServer({ server });
const game = new Game();
const deltaTracker = new DeltaTracker();

// Track which clients need a full snapshot on next tick
const pendingSnapshots = new Set<WebSocket>();

wss.on('connection', (ws: WebSocket) => {
  const playerId = Math.random().toString(36).substring(7);
  game.addPlayer(playerId);

  // Send static init data (walls, map dimensions, ammo spawn points)
  const initPayload: InitPayload = {
    type: 'init',
    id: playerId,
    walls: game.getWalls(),
    mapWidth: game.getMapDimensions().width,
    mapHeight: game.getMapDimensions().height,
    ammoSpawnPoints: game.getAmmoSpawnPoints()
  };
  ws.send(JSON.stringify(initPayload));

  // Queue a full snapshot for this client on the next tick
  pendingSnapshots.add(ws);

  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'input') {
        game.handleInput(playerId, data.input as ClientInput);
      }
    } catch (e) {
      console.error('Invalid message', e);
    }
  });

  ws.on('close', () => {
    game.removePlayer(playerId);
    pendingSnapshots.delete(ws);
  });
});

const TICK_RATE = 20; // Hz (Phase 5: reduced from 60)

setInterval(() => {
  game.update();

  const players = game.getPlayers();
  const zombies = game.getZombies();
  const bullets = game.getBullets();
  const wave = game.getWave();
  const ammoAvailability = game.getAmmoAvailability();
  const gameOver = game.isGameOver();

  // Compute delta once for all clients
  const delta = deltaTracker.computeDelta(players, zombies, bullets, wave, ammoAvailability, gameOver);
  const deltaStr = JSON.stringify(delta);

  // Build snapshot string lazily (only if someone needs it)
  let snapshotStr: string | null = null;

  wss.clients.forEach(client => {
    if (client.readyState !== WebSocket.OPEN) return;

    if (pendingSnapshots.has(client)) {
      if (!snapshotStr) {
        snapshotStr = JSON.stringify(
          deltaTracker.buildSnapshot(players, zombies, bullets, wave, ammoAvailability, gameOver)
        );
      }
      client.send(snapshotStr);
      pendingSnapshots.delete(client);
    } else {
      client.send(deltaStr);
    }
  });
}, 1000 / TICK_RATE);
