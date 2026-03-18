# BoxHead Remake

A modern, open-source rebuild of the classic flash game "BoxHead" - featuring real-time multiplayer co-op over WebSockets, written in TypeScript.

## Features
- **Top-Down Shooter:** WASD movement, mouse aim and shoot.
- **Progressive Waves:** Zombies get faster and tougher.
- **Server-Authoritative Multiplayer:** Shared game state using Node.js WebSockets.
- **Canvas Rendering:** Fast and responsive HTML5 canvas graphics.

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run development servers (Client + Backend):
   ```bash
   npm run dev
   ```

3. Open your browser to `http://localhost:5173`. Share the link to play with friends!

## Build for Production

```bash
npm run build
npm start
```

## Controls
- **WASD** - Move
- **Mouse** - Aim
- **Left Click** - Shoot

## Technologies
- TypeScript
- Vite
- Express
- ws (WebSockets)
- Canvas API
