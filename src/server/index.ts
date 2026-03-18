import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { Game } from './game';
import { ClientInput } from '../shared/types';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../client')));

const server = app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

const wss = new WebSocketServer({ server });
const game = new Game();

wss.on('connection', (ws: WebSocket) => {
  const playerId = Math.random().toString(36).substring(7);
  game.addPlayer(playerId);

  ws.send(JSON.stringify({ type: 'init', id: playerId }));

  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'input') {
        game.handleInput(playerId, data.input as ClientInput);
      }
    } catch (e) {
      console.error('Invalid message', e);
    }
  });

  ws.on('close', () => {
    game.removePlayer(playerId);
  });
});

setInterval(() => {
  game.update();
  const state = game.getState();
  const stateStr = JSON.stringify({ type: 'state', state });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(stateStr);
    }
  });
}, 1000 / 60);
