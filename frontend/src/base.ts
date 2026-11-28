// The Base screen: a map editor for your base (walls, guns, mines, garrison),
// your three attack waves, practice raids against your own base, scouting and
// raiding other players' bases through fog of war, and the replay viewer.
// Talks to /api/base. DOM nodes only, never innerHTML with server strings.

import { theme, withAlpha, font } from './theme';
import {
  BaseState, Counts, Kind, Layout, Replay, Rules, SiteId, RaidLog,
  ENTRANCE_NAMES, SOLDIERS, WAVES, HQ_ID, HIDDEN_ID,
  kindInfo, siteInfo, cellOf, xyOf, routes, placed, guardsPlaced, roomFor, layoutProblem, supplyOf, totalOf,
  saveCost, reserve, spareOf, starterBlueprint, sampleWaves, sameLayout, sameWaves, moveSite,
  troopAt, damageAt, revealedAt, outcomeLine, shortDuration, ago,
} from './siege';

export interface BaseDeps {
  auth: () => { token: string };
  /** Cash changed: the rest of the hideout should reload. */
  onCash: () => void;
  /** Unread incoming defense raid count changed. */
  onUnread?: (count: number) => void;
  error: (msg: string) => void;
  note: (msg: string) => void;
}

type BaseTab = 'build' | 'army' | 'raid' | 'log';
type Tool = Kind | 'erase';

interface Playback {
  data: Replay;
  /** Current time in ticks (fractional while playing). */
  tick: number;
  playing: boolean;
  speed: number;
  /** Show the fog the attacker had (always on for the attacker's own replays). */
  fog: boolean;
  title: string;
  /** Shown when the replay ends. */
  result: string;
}

interface PendingRaid {
  state: BaseState;
  raid: { defender: string; loot: number; payout: number; contractBonus: number; salvage: number };
  line: string;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (cls: string, text: string, onClick: () => void): HTMLButtonElement => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const money = (n: number) => `$${Math.floor(n).toLocaleString('en-US')}`;
const plural = (name: string, n: number) => {
  const lower = name.toLowerCase();
  if (n === 1) return lower;
  if (lower.endsWith('man')) return lower.slice(0, -3) + 'men';
  if (lower.endsWith('y')) return lower.slice(0, -1) + 'ies';
  return lower + 's';
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const SITE_GRID: (SiteId | null)[] = ['northWest', 'north', 'northEast', 'west', null, 'east', 'southWest', 'south', 'southEast'];
const SITE_SHORT: Record<SiteId, string> = { northWest: 'NW', north: 'N', northEast: 'NE', west: 'W', east: 'E', southWest: 'SW', south: 'S', southEast: 'SE' };
const TOOL_KEYS: Kind[] = ['wall', 'turret', 'sniper', 'mine', 'rifleman', 'scout', 'heavy', 'grenadier'];
const GROUND = '#161910';
const CONCRETE = '#7d7f6c';

/** Draw one kind of piece centred on (cx, cy) in a cell of size `s`. */
export function drawPiece(ctx: CanvasRenderingContext2D, kind: Kind, cx: number, cy: number, s: number, color: string, posted = false) {
  ctx.save();
  ctx.lineWidth = Math.max(1.5, s * 0.08);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  const r = s * 0.3;
  if (posted) {
    // A garrison soldier stands in a sandbag ring.
    ctx.save();
    ctx.strokeStyle = withAlpha(color, 0.55);
    ctx.setLineDash([s * 0.12, s * 0.1]);
    ctx.beginPath(); ctx.arc(cx, cy, s * 0.42, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  switch (kind) {
    case 'wall': {
      const pad = s * 0.06;
      ctx.fillStyle = CONCRETE;
      ctx.fillRect(cx - s / 2 + pad, cy - s / 2 + pad, s - pad * 2, s - pad * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.fillRect(cx - s / 2 + pad, cy - s / 2 + pad, s - pad * 2, s * 0.16);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.fillRect(cx - s / 2 + pad, cy + s / 2 - pad - s * 0.14, s - pad * 2, s * 0.14);
      break;
    }
    case 'turret': {
      ctx.fillStyle = '#23261c';
      ctx.beginPath(); ctx.arc(cx, cy, s * 0.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(cx, cy, s * 0.16, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + s * 0.36, cy - s * 0.2); ctx.stroke();
      break;
    }
    case 'sniper': {
      ctx.fillStyle = '#23261c';
      ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.44); ctx.lineTo(cx + s * 0.44, cy); ctx.lineTo(cx, cy + s * 0.44); ctx.lineTo(cx - s * 0.44, cy);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - s * 0.2, cy); ctx.lineTo(cx + s * 0.2, cy); ctx.moveTo(cx, cy - s * 0.2); ctx.lineTo(cx, cy + s * 0.2); ctx.stroke();
      break;
    }
    case 'mine': {
      ctx.fillStyle = '#23261c';
      ctx.beginPath(); ctx.arc(cx, cy, s * 0.24, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, s * 0.07, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      break;
    }
    case 'rifleman':
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      break;
    case 'scout':
      ctx.beginPath(); ctx.moveTo(cx, cy - r * 1.15); ctx.lineTo(cx + r, cy + r * 0.85); ctx.lineTo(cx - r, cy + r * 0.85); ctx.closePath(); ctx.fill();
      break;
    case 'heavy':
      ctx.fillRect(cx - r * 1.05, cy - r * 1.05, r * 2.1, r * 2.1);
      break;
    case 'grenadier':
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = GROUND;
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2); ctx.fill();
      break;
  }
  ctx.restore();
}

export class BaseView {
  state: BaseState | null = null;
  tab: BaseTab = 'build';
  tool: Tool = 'wall';
  /** The layout and waves being edited; saved to the server on request. */
  draft: Layout = { site: 'west', pieces: [] };
  waves: Counts[] = [{}, {}, {}];
  /** Entrance (0-2) each wave uses, for practice and for raids. */
  entrances = [0, 1, 2];
  playback: Playback | null = null;
  lastRaid: { defender: string; loot: number; payout: number; contractBonus: number; line: string } | null = null;
  busy = false;
  visible = false;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hover: number | null = null;
  private cursor: number | null = null;
  private painting: 'place' | 'erase' | null = null;
  private pendingRaid: PendingRaid | null = null;
  private raf = 0;
  private lastFrame = 0;
  private limitNote = '';

  constructor(private deps: BaseDeps) {
    this.canvas = document.getElementById('baseCanvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    document.querySelectorAll<HTMLButtonElement>('[data-base-tab]').forEach(btn => btn.addEventListener('click', () => {
      this.tab = btn.dataset.baseTab as BaseTab;
      this.stopReplay();
      if (this.tab === 'log' && (this.state?.unreadDefenses ?? 0) > 0) void this.ackDefenses();
      this.render();
    }));
    new ResizeObserver(() => this.resize()).observe(this.q('baseCanvasWrap'));
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
    this.canvas.addEventListener('pointerdown', e => this.pointerDown(e));
    this.canvas.addEventListener('pointermove', e => this.pointerMove(e));
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; if (!this.painting) this.draw(); });
    this.canvas.addEventListener('keydown', e => this.keyDown(e));
    this.canvas.addEventListener('blur', () => { this.cursor = null; this.draw(); });
    const stop = () => { this.painting = null; };
    this.canvas.addEventListener('pointerup', stop);
    this.canvas.addEventListener('pointercancel', stop);
  }

  private q(id: string) { return document.getElementById(id)!; }
  private get rules(): Rules { return this.state!.rules; }

  // ---------- Server ----------

  /** The Base tab opened or closed. */
  setVisible(on: boolean) {
    if (on === this.visible) return;
    this.visible = on;
    if (on) { void this.load(); this.resize(); }
    else this.stopReplay();
  }

  /** Forget everything (signed out, or another operator became active). */
  reset() {
    this.state = null;
    this.playback = null;
    this.pendingRaid = null;
    this.lastRaid = null;
    this.cursor = null;
    cancelAnimationFrame(this.raf);
  }

  private dirtyLayout() { return !!this.state && !sameLayout(this.draft, this.state.layout); }
  private dirtyWaves() { return !!this.state && !sameWaves(this.waves, this.state.waves); }

  /** Take the server's base; `take` says which unsaved edits it replaces. */
  private apply(base: BaseState, take: 'all' | 'waves' | null) {
    const first = !this.state;
    this.state = base;
    if (first || take === 'all') this.draft = clone(base.layout);
    if (first || take) this.waves = [0, 1, 2].map(i => ({ ...(base.waves[i] ?? {}) }));
    const k = this.tool === 'erase' ? null : kindInfo(base.rules, this.tool);
    if (k && !k.soldier && k.cap === 0) this.tool = 'wall';
    this.deps.onUnread?.(base.unreadDefenses ?? 0);
    if (this.tab === 'log' && (base.unreadDefenses ?? 0) > 0) void this.ackDefenses();
    this.render();
  }

  async load() {
    const { token } = this.deps.auth();
    try {
      const res = await fetch(`/api/base?token=${encodeURIComponent(token)}`);
      const data = await res.json() as { ok: boolean; error?: string; base?: BaseState | null };
      if (data.ok && data.base) this.apply(data.base, null);
      else if (data.error) this.deps.error(data.error);
    } catch {
      this.deps.error('Network error: could not load your base');
    }
  }

  private async post(action: string, body: Record<string, unknown>, take: 'all' | 'waves' | null = null, deferApply = false) {
    if (this.busy) return null;
    this.busy = true;
    this.deps.error('');
    try {
      const { token } = this.deps.auth();
      const res = await fetch(`/api/base/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...body }),
      });
      const data = await res.json() as {
        ok: boolean; error?: string; base?: BaseState | null; replay?: Replay; spent?: number; earned?: number; fee?: number;
        raid?: { id: string; defender: string; loot: number; payout?: number; contractBonus?: number; salvage?: number };
      };
      this.busy = false;
      if (data.base && (!deferApply || !data.ok)) this.apply(data.base, data.ok ? take : null);
      if (!data.ok) { this.deps.error(data.error || 'That did not work'); return null; }
      return data;
    } catch {
      this.busy = false;
      this.deps.error('Network error');
      return null;
    }
  }

  private async ackDefenses() {
    if (!this.state || (this.state.unreadDefenses ?? 0) === 0) return;
    this.state.unreadDefenses = 0;
    this.deps.onUnread?.(0);
    this.updateLogBadge();
    const { token } = this.deps.auth();
    try {
      await fetch('/api/base/ack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      });
    } catch { /* ignore transient ack failure */ }
  }

  private async save() {
    const body: Record<string, unknown> = {};
    if (this.dirtyLayout()) body.layout = this.draft;
    if (this.dirtyWaves()) body.waves = this.waves;
    const data = await this.post('save', body, 'all');
    if (!data) return;
    this.deps.note(data.spent ? `Saved. Spent ${money(data.spent)}.` : 'Saved.');
    if (data.spent) this.deps.onCash();
  }

  private async refill() {
    const data = await this.post('refill', {}, 'waves');
    if (!data) return;
    this.deps.note(data.spent ? `Refilled lost troops for ${money(data.spent)}.` : 'Restored troops from reserve.');
    if (data.spent) this.deps.onCash();
  }

  private async sellSpare(kind: Kind, count: number) {
    const data = await this.post('sell', { kind, count });
    if (!data) return;
    this.deps.note(`Sold ${count} spare ${plural(kindInfo(this.rules, kind).name, count)} for ${money(data.earned ?? 0)}.`);
    this.deps.onCash();
  }

  private revert() {
    if (!this.state) return;
    this.draft = clone(this.state.layout);
    this.waves = [0, 1, 2].map(i => ({ ...(this.state!.waves[i] ?? {}) }));
    this.render();
  }

  private async practice() {
    if (this.waves.every(w => totalOf(w) === 0)) {
      this.waves = sampleWaves(this.rules);
      this.deps.note('Loaded balanced sample waves for practice (free — not bought).');
    }
    const data = await this.post('practice', { layout: this.draft, waves: this.waves, entrances: this.entrances });
    if (data?.replay) this.play(data.replay, 'Practice raid on your base', `Practice: ${outcomeLine(data.replay.outcome)}. Nothing was lost.`, false);
  }

  private async scout() {
    const data = await this.post('scout', {});
    if (!data) return;
    this.lastRaid = null;
    if (data.fee) {
      this.deps.note(`Scouted a new target (${money(data.fee)} fee).`);
      this.deps.onCash();
    }
    this.render();
  }

  private async launch() {
    const target = this.state?.target;
    if (!target) return;
    // Defer applying post-raid state/cash until the replay finishes or is skipped/closed
    // so the outcome isn't spoiled at tick 00:00.
    const data = await this.post('raid', { entrances: this.entrances }, 'waves', true);
    if (!data?.replay || !data.raid || !data.base) return;
    const payout = data.raid.payout ?? data.raid.loot;
    const contractBonus = data.raid.contractBonus ?? 0;
    const salvage = data.raid.salvage ?? 0;
    const line = outcomeLine(data.replay.outcome);
    const bonusNote = contractBonus > 0 ? ` (incl. ${money(contractBonus)} contract bonus)` : '';
    this.pendingRaid = {
      state: data.base,
      raid: { defender: data.raid.defender, loot: data.raid.loot, payout, contractBonus, salvage },
      line,
    };
    this.play(data.replay, `Raid on ${data.raid.defender}'s base`, `${line} · earned ${money(payout)}${bonusNote}`, true);
  }

  /** Reveal the deferred raid outcome and sync post-raid cash & waves. */
  private commitPendingRaid() {
    const pending = this.pendingRaid;
    if (!pending) return;
    this.pendingRaid = null;
    this.lastRaid = {
      defender: pending.raid.defender,
      loot: pending.raid.loot,
      payout: pending.raid.payout,
      contractBonus: pending.raid.contractBonus,
      line: pending.line,
    };
    this.apply(pending.state, 'waves');
    this.deps.onCash();
  }

  private async watch(log: RaidLog, attacking: boolean) {
    const data = await this.post('replay', { id: log.id });
    if (!data?.replay) return;
    const payout = log.payout ?? log.loot;
    const cashNote = attacking
      ? `earned ${money(payout)}${log.contractBonus ? ` (incl. ${money(log.contractBonus)} contract)` : ''}`
      : `lost ${money(log.loot)}${log.salvage ? ` · salvaged ${money(log.salvage)}` : ''}`;
    this.play(data.replay, attacking ? `Your raid on ${log.opponent}` : `${log.opponent}'s raid on your base`, `${outcomeLine(data.replay.outcome)} · ${cashNote}`, attacking);
  }

  // ---------- Replays ----------

  private play(data: Replay, title: string, result: string, fog: boolean) {
    this.playback = { data, tick: 0, playing: true, speed: 1, fog: fog || data.fog, title, result };
    this.lastFrame = performance.now();
    this.render();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(t => this.frame(t));
  }

  private stopReplay() {
    if (!this.playback) return;
    this.playback = null;
    cancelAnimationFrame(this.raf);
    if (this.pendingRaid) this.commitPendingRaid();
  }

  private get endTick() { return this.playback ? this.playback.data.outcome.ticks + 8 : 0; }

  private frame(now: number) {
    const p = this.playback;
    if (!p || !this.visible) return;
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (p.playing) {
      p.tick = Math.min(this.endTick, p.tick + dt * p.data.ticksPerSec * p.speed);
      if (p.tick >= this.endTick) {
        p.playing = false;
        if (this.pendingRaid) this.commitPendingRaid();
        else this.renderTransport();
      }
      this.syncTransport();
    }
    this.draw();
    this.raf = requestAnimationFrame(t => this.frame(t));
  }

  // ---------- Editing ----------

  private cellAt(e: PointerEvent): number | null {
    if (!this.state) return null;
    const rect = this.canvas.getBoundingClientRect();
    const g = this.rules.grid;
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * g);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * g);
    return x < 0 || y < 0 || x >= g || y >= g ? null : cellOf(g, x, y);
  }

  private editing() { return !!this.state && !this.playback && this.tab === 'build'; }

  private pieceAt(cell: number) {
    const [x, y] = xyOf(this.rules.grid, cell);
    return this.draft.pieces.findIndex(p => p.x === x && p.y === y);
  }

  private pointerDown(e: PointerEvent) {
    if (!this.editing()) return;
    const cell = this.cellAt(e);
    if (cell === null) return;
    e.preventDefault();
    this.cursor = cell;
    const at = this.pieceAt(cell);
    const same = at >= 0 && this.draft.pieces[at].kind === this.tool;
    this.painting = this.tool === 'erase' || e.button === 2 || same ? 'erase' : 'place';
    this.canvas.setPointerCapture(e.pointerId);
    this.paint(cell);
  }

  private pointerMove(e: PointerEvent) {
    const cell = this.cellAt(e);
    if (cell === this.hover) return;
    this.hover = cell;
    if (this.painting && cell !== null && this.editing()) this.paint(cell);
    else this.draw();
  }

  /** Keyboard grid editor: arrow keys move cursor, Space/Enter toggles, Backspace/Delete erases, 1-8/0 pick tool. */
  private keyDown(e: KeyboardEvent) {
    if (!this.editing()) return;
    const g = this.rules.grid;
    if (e.key >= '1' && e.key <= '8') {
      const k = TOOL_KEYS[Number(e.key) - 1];
      const info = kindInfo(this.rules, k);
      if (info && (info.soldier || info.cap > 0)) {
        this.tool = k;
        this.limitNote = '';
        this.renderPanel();
        this.draw();
      }
      e.preventDefault();
      return;
    }
    if (e.key === '0') { this.tool = 'erase'; this.renderPanel(); this.draw(); e.preventDefault(); return; }
    const start = this.cursor ?? cellOf(g, Math.floor(g / 2), Math.floor(g / 2));
    let [x, y] = xyOf(g, start);
    if (e.key === 'ArrowUp') y = Math.max(0, y - 1);
    else if (e.key === 'ArrowDown') y = Math.min(g - 1, y + 1);
    else if (e.key === 'ArrowLeft') x = Math.max(0, x - 1);
    else if (e.key === 'ArrowRight') x = Math.min(g - 1, x + 1);
    else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      this.cursor = start;
      const at = this.pieceAt(start);
      const same = at >= 0 && this.draft.pieces[at].kind === this.tool;
      this.painting = this.tool === 'erase' || same ? 'erase' : 'place';
      this.paint(start);
      this.painting = null;
      return;
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      this.cursor = start;
      this.painting = 'erase';
      this.paint(start);
      this.painting = null;
      return;
    } else return;
    e.preventDefault();
    this.cursor = cellOf(g, x, y);
    this.draw();
  }

  private paint(cell: number) {
    const site = siteInfo(this.rules, this.draft.site);
    if (cell === site.hq || site.entrances.includes(cell)) return;
    const at = this.pieceAt(cell);
    this.limitNote = '';
    if (this.painting === 'erase') {
      if (at < 0) return;
      this.draft.pieces.splice(at, 1);
    } else if (this.tool !== 'erase') {
      if (at >= 0 && this.draft.pieces[at].kind === this.tool) return;
      const without: Layout = at >= 0 ? { ...this.draft, pieces: this.draft.pieces.filter((_, i) => i !== at) } : this.draft;
      if (roomFor(this.rules, without, this.tool) <= 0) {
        const info = kindInfo(this.rules, this.tool);
        this.limitNote = info.soldier ? `A tier ${this.state!.tier} base garrisons ${this.rules.guardCap} soldiers.` : `A tier ${this.state!.tier} base holds ${info.cap} ${plural(info.name, info.cap)}.`;
        this.painting = null;
        this.renderPanel();
        return;
      }
      const [x, y] = xyOf(this.rules.grid, cell);
      this.draft.pieces = [...without.pieces, { kind: this.tool, x, y }];
    }
    this.renderPanel();
    this.draw();
  }

  // ---------- Panels ----------

  private updateLogBadge() {
    const badge = document.getElementById('baseLogBadge');
    if (!badge) return;
    const n = this.state?.unreadDefenses ?? 0;
    badge.hidden = n <= 0;
    badge.textContent = n > 0 ? String(n) : '';
  }

  render() {
    if (!this.state) return;
    document.querySelectorAll<HTMLButtonElement>('[data-base-tab]').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.baseTab === this.tab)));
    this.updateLogBadge();
    this.renderPanel();
    this.renderTransport();
    this.draw();
  }

  private stageTitle(): [string, string] {
    const s = this.state!;
    if (this.playback) return [this.playback.title, ''];
    if (this.tab === 'raid' && s.target && !s.raidBlocker) return [`${s.target.name}'s base`, 'Unscouted: your soldiers clear the fog as they advance'];
    return [`${s.name}'s base`, `Tier ${s.tier} · ${siteInfo(s.rules, this.draft.site).name}`];
  }

  private renderPanel() {
    if (!this.state) return;
    const [title, meta] = this.stageTitle();
    this.q('baseStageTitle').textContent = title;
    this.q('baseStageMeta').textContent = meta;
    const panel = this.q('basePanel');
    const parts = this.tab === 'build' ? this.buildPanel() : this.tab === 'army' ? this.armyPanel() : this.tab === 'raid' ? this.raidPanel() : this.logPanel();
    panel.replaceChildren(...parts);
    this.q('baseHint').textContent = this.playback ? '' : this.tab === 'build'
      ? 'Click/drag or use arrow keys + Space to edit · right-click to remove · walls block movement and line of sight'
      : this.tab === 'raid' && this.state.target && !this.state.raidBlocker ? 'You only know where the HQ and the entrances are.' : '';
  }

  private glyph(kind: Kind, color: string, posted = false): HTMLCanvasElement {
    const c = el('canvas', 'base-glyph');
    const size = 28, dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    drawPiece(ctx, kind, size / 2, size / 2, size * 0.9, color, posted);
    return c;
  }

  /** "Saving buys ..." line and the save / revert buttons, shared by Build and Army. */
  private saveBlock(problem: string | null): HTMLElement[] {
    const s = this.state!;
    const cost = saveCost(s.rules, this.draft, this.waves, s.owned);
    const dirty = this.dirtyLayout() || this.dirtyWaves();
    const out: HTMLElement[] = [];
    if (cost.buys.length) {
      const list = cost.buys.map(b => `${b.count} ${plural(kindInfo(s.rules, b.kind).name, b.count)}`).join(', ');
      out.push(el('p', 'base-cost', `Saving buys ${list}: ${money(cost.total)}`));
    } else if (dirty) {
      out.push(el('p', 'hf-sub', 'Nothing new to buy: you already own all of it.'));
    }
    const short = cost.total - s.cash;
    const row = el('div', 'base-actions');
    const label = !dirty ? 'Saved' : short > 0 ? `Need ${money(short)} more` : cost.total ? `Buy and save · ${money(cost.total)}` : 'Save';
    const saveBtn = button('btn btn-money-solid btn-sm', label, () => void this.save());
    saveBtn.disabled = !dirty || short > 0 || !!problem || this.busy;
    row.append(saveBtn);
    if (dirty) row.append(button('btn btn-ghost btn-sm', 'Undo changes', () => this.revert()));
    out.push(row);
    return out;
  }

  private spareSection(soldiersOnly: boolean): HTMLElement[] {
    const s = this.state!;
    const spares = spareOf(s.rules, s.layout, s.waves, s.owned)
      .filter(sp => kindInfo(s.rules, sp.kind).soldier === soldiersOnly);
    if (!spares.length) return [];
    const head = el('div', 'pane-head');
    head.append(el('span', 'label', soldiersOnly ? 'Reserve soldiers' : 'Spare equipment'),
      el('span', 'meta', `Sell back (${Math.round((s.rules.sellRefundRate ?? 0.5) * 100)}%)`));
    const box = el('div', 'base-info');
    for (const sp of spares) {
      const info = kindInfo(s.rules, sp.kind);
      const row = el('div', 'base-spare-row');
      row.append(el('span', '', `${sp.count} ${plural(info.name, sp.count)}`));
      const sell = button('btn btn-ghost btn-sm', `Sell all · +${money(sp.refund)}`, () => void this.sellSpare(sp.kind, sp.count));
      sell.disabled = this.busy;
      row.append(sell);
      box.append(row);
    }
    return [head, box];
  }

  private buildPanel(): HTMLElement[] {
    const s = this.state!;
    const rules = s.rules;
    const have = placed(this.draft);
    const parts: HTMLElement[] = [];

    if (s.layout.pieces.length === 0) {
      const intro = el('div', 'base-info base-intro');
      intro.append(
        el('b', '', 'Base Command — Design the Kill-Zone'),
        el('span', '', 'Place your HQ on a side or corner, then shape open firing lanes with walls, turrets, mines and garrison guards. Every entrance must keep a route in. Draft freely and run a free Practice raid before spending cash.'),
      );
      parts.push(intro);
    }

    const siteHead = el('div', 'pane-head');
    siteHead.append(el('span', 'label', 'HQ position'), el('span', 'meta', siteInfo(rules, this.draft.site).name));
    const compass = el('div', 'base-compass');
    compass.setAttribute('role', 'radiogroup');
    compass.setAttribute('aria-label', 'HQ position');
    for (const id of SITE_GRID) {
      if (!id) { compass.append(el('span', 'base-compass-mid', 'Map')); continue; }
      const b = button('base-compass-btn', SITE_SHORT[id], () => { this.draft = moveSite(rules, this.draft, id); this.render(); });
      b.title = siteInfo(rules, id).name;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(this.draft.site === id));
      b.setAttribute('aria-label', siteInfo(rules, id).name);
      compass.append(b);
    }
    const quickRow = el('div', 'base-actions');
    if (this.draft.pieces.length === 0) {
      quickRow.append(button('btn btn-secondary btn-sm', 'Starter blueprint', () => {
        this.draft = starterBlueprint(rules, this.draft.site);
        this.deps.note('Loaded starter blueprint (unsaved — test it in Practice or click Buy and save).');
        this.render();
      }));
    } else {
      quickRow.append(button('btn btn-ghost btn-sm', 'Clear map', () => {
        this.draft = { site: this.draft.site, pieces: [] };
        this.render();
      }));
    }
    parts.push(siteHead, compass, quickRow);

    const row = (kind: Kind, group: 'gear' | 'guard') => {
      const info = kindInfo(rules, kind);
      const count = have[kind] ?? 0;
      const locked = group === 'gear' && info.cap === 0;
      const b = el('button', `base-tool${this.tool === kind ? ' on' : ''}`);
      b.type = 'button';
      b.disabled = locked;
      b.setAttribute('aria-pressed', String(this.tool === kind));
      const name = el('span', 'base-tool-name', info.name);
      const spare = (s.owned[kind] ?? 0) - count - (group === 'guard' ? this.waves.reduce((n, w) => n + (w[kind] ?? 0), 0) : 0);
      const sub = locked ? 'Unlocks at a higher Homefront tier'
        : `${money(info.price)}${spare > 0 ? ` · ${spare} spare` : ''}`;
      const text = el('span', 'base-tool-text');
      text.append(name, el('span', 'base-tool-sub', sub));
      b.append(this.glyph(kind, group === 'guard' ? theme.you : kind === 'mine' ? theme.money : theme.you, group === 'guard'), text,
        el('span', 'base-tool-count num', group === 'gear' ? `${count}/${info.cap}` : String(count)));
      b.addEventListener('click', () => { this.tool = kind; this.limitNote = ''; this.renderPanel(); this.draw(); });
      return b;
    };
    const gearHead = el('div', 'pane-head');
    gearHead.append(el('span', 'label', 'Equipment'));
    const gear = el('div', 'base-tools');
    for (const k of rules.kinds.filter(k => !k.soldier)) gear.append(row(k.id, 'gear'));
    const guardHead = el('div', 'pane-head');
    guardHead.append(el('span', 'label', 'Garrison'), el('span', 'meta num', `${guardsPlaced(this.draft)}/${rules.guardCap} posted`));
    const guards = el('div', 'base-tools');
    for (const k of SOLDIERS) guards.append(row(k, 'guard'));
    const erase = button(`base-tool base-tool--erase${this.tool === 'erase' ? ' on' : ''}`, 'Remove pieces', () => { this.tool = 'erase'; this.renderPanel(); });
    erase.setAttribute('aria-pressed', String(this.tool === 'erase'));
    parts.push(gearHead, gear, guardHead, guards, erase);

    if (this.tool !== 'erase') {
      const info = kindInfo(rules, this.tool);
      const stats: string[] = [];
      if (info.hp) stats.push(`${Math.round(info.hp * (info.soldier ? rules.guardHpMult : 1))} health`);
      if (info.dps) stats.push(`${info.dps} damage/s`);
      if (info.range) stats.push(`reach ${info.range} squares`);
      if (this.tool === 'mine') stats.push(`${rules.mineDamage} damage within ${rules.mineRadius} squares`);
      const card = el('div', 'base-info');
      card.append(el('b', '', info.name), el('span', '', info.soldier ? `${info.blurb} Dug in at a post: holds its ground with ${Math.round((rules.guardHpMult - 1) * 100)}% more health.` : info.blurb));
      if (stats.length) card.append(el('span', 'base-info-stats num', stats.join(' · ')));
      parts.push(card);
    }

    const problem = layoutProblem(rules, this.draft);
    if (this.limitNote) parts.push(el('p', 'warn-line', this.limitNote));
    parts.push(problem ? el('p', 'base-problem', problem) : el('p', 'base-ok', 'All three entrances can reach the HQ.'));
    parts.push(...this.saveBlock(problem));
    const test = button('btn btn-secondary btn-sm btn-block', 'Run a practice raid', () => void this.practice());
    test.disabled = !!problem || this.busy;
    test.title = 'Send your waves (or sample waves) at this layout. Free: nothing is bought, lost or saved.';
    parts.push(test, el('p', 'hf-sub', 'Practice is free and uses the layout on screen, even before you buy it.'));
    parts.push(...this.spareSection(false));
    return parts;
  }

  /** A, B, C buttons choosing the entrance one wave uses. */
  private entrancePicker(wave: number): HTMLElement {
    const seg = el('div', 'segmented base-entrance');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', `Wave ${wave + 1} entrance`);
    ENTRANCE_NAMES.forEach((name, i) => {
      const b = button('', name, () => { this.entrances[wave] = i; this.renderPanel(); this.draw(); });
      b.setAttribute('aria-pressed', String(this.entrances[wave] === i));
      b.title = `Wave ${wave + 1} enters at ${name}`;
      seg.append(b);
    });
    return seg;
  }

  private waveSummary(w: Counts): string {
    const bits = SOLDIERS.filter(k => w[k]).map(k => `${w[k]} ${plural(kindInfo(this.rules, k).name, w[k]!)}`);
    return bits.length ? bits.join(', ') : 'Empty';
  }

  private refillButton(): HTMLElement | null {
    const s = this.state!;
    const hasRefill = (s.refillWaves ?? []).some(w => totalOf(w) > 0);
    if (!hasRefill) return null;
    const cost = s.refillCost ?? 0;
    const short = cost - s.cash;
    const label = short > 0 ? `Refill lost troops · need ${money(short)} more` : cost > 0 ? `Refill lost troops · ${money(cost)}` : 'Restore lost troops (from reserve)';
    const btn = button('btn btn-money-solid btn-sm btn-block', label, () => void this.refill());
    btn.disabled = short > 0 || this.busy;
    return btn;
  }

  private armyPanel(): HTMLElement[] {
    const s = this.state!;
    const rules = s.rules;
    const intro = el('div', 'base-info base-intro');
    intro.append(
      el('b', '', 'Strike Force — 3 Waves, 4 Roles'),
      el('span', '', `Waves set out ${rules.waveGapSecs}s apart (${rules.waveSupply} supply/wave at tier ${s.tier}). Heavies soak fire, Riflemen deal +50% to garrison, Grenadiers prioritize turrets/HQ (2.5×), and Scouts spot fog & disarm mines.`),
    );
    const parts: HTMLElement[] = [intro];
    const refillBtn = this.refillButton();
    if (refillBtn) parts.push(refillBtn);
    if (this.waves.every(w => totalOf(w) === 0)) {
      parts.push(button('btn btn-secondary btn-sm btn-block', 'Load sample waves', () => {
        this.waves = sampleWaves(rules);
        this.render();
      }));
    }
    for (let w = 0; w < WAVES; w++) {
      const wave = this.waves[w];
      const used = supplyOf(rules, wave);
      const card = el('div', 'base-wave');
      const head = el('div', 'base-wave-head');
      head.append(el('b', '', `Wave ${w + 1}`), el('span', `num base-supply${used > rules.waveSupply ? ' over' : ''}`, `${used}/${rules.waveSupply} supply`), this.entrancePicker(w));
      card.append(head);
      for (const k of SOLDIERS) {
        const info = kindInfo(rules, k);
        const n = wave[k] ?? 0;
        const line = el('div', 'base-soldier');
        const text = el('span', 'base-tool-text');
        text.append(el('span', 'base-tool-name', info.name), el('span', 'base-tool-sub', `${info.supply} supply · ${money(info.price)}`));
        const minus = button('base-step', '−', () => { wave[k] = Math.max(0, n - 1); this.renderPanel(); });
        minus.disabled = n === 0;
        minus.setAttribute('aria-label', `One fewer ${info.name.toLowerCase()} in wave ${w + 1}`);
        const plus = button('base-step', '+', () => { wave[k] = n + 1; this.renderPanel(); });
        plus.disabled = used + (info.supply ?? 1) > rules.waveSupply;
        plus.setAttribute('aria-label', `One more ${info.name.toLowerCase()} in wave ${w + 1}`);
        line.title = info.blurb;
        line.append(this.glyph(k, theme.accent), text, minus, el('span', 'base-step-n num', String(n)), plus);
        card.append(line);
      }
      parts.push(card);
    }
    const spare = reserve(this.draft, this.waves, s.owned);
    if (totalOf(spare)) parts.push(el('p', 'hf-sub', `In reserve (owned, not assigned): ${this.waveSummary(spare)}.`));
    parts.push(...this.saveBlock(layoutProblem(rules, this.draft)));
    const test = button('btn btn-secondary btn-sm btn-block', 'Run a practice raid on your base', () => void this.practice());
    test.disabled = this.busy;
    parts.push(test, el('p', 'hf-sub', 'Practice is free and uses the waves on screen, owned or not.'));
    parts.push(...this.spareSection(true));
    return parts;
  }

  private raidPanel(): HTMLElement[] {
    const s = this.state!;
    const parts: HTMLElement[] = [];
    if (this.pendingRaid) {
      const live = el('div', 'base-info base-intro');
      live.append(
        el('b', '', `Raid on ${this.pendingRaid.raid.defender} in progress`),
        el('span', '', 'Watch the replay unfold on the map, or click Skip to result in the playback bar.'),
      );
      parts.push(live);
      return parts;
    }

    const shield = s.shieldUntil - s.now;
    const own = el('div', 'base-info');
    own.append(el('b', '', 'Your base'));
    if (!s.raidable) own.append(el('span', '', 'Safe operator: this base can never be raided.'));
    else if (s.raidBlocker) own.append(el('span', '', 'Base raids are off on this server.'));
    else if (shield > 0) own.append(el('span', '', `Shielded for ${shortDuration(shield)} after the last raid on it. Raiding someone drops your shield (same rivals stay on a 24h cooldown).`));
    else if (s.atRisk === 0 || (s.cash + (s.workshopAtRisk ?? 0)) < s.rules.minTargetCash) own.append(el('span', '', `Not worth raiding: under ${money(s.rules.minTargetCash)} exposed cash, so nobody is offered your base.`));
    else {
      const wsNote = (s.workshopAtRisk ?? 0) > 0 ? ` (includes ${money(s.workshopAtRisk!)} uncollected Workshop)` : '';
      own.append(el('span', '', `Open to raids. Up to ${money(s.atRisk)} is at risk${wsNote}. Repelling an attack salvages ${Math.round((s.rules.defenderSalvageShare ?? 0.3) * 100)}% of dead attacker value; your pieces are never lost.`));
    }
    parts.push(own);
    if (s.raidBlocker) {
      const line = el('p', 'locked-line');
      line.append(s.raidBlocker);
      parts.push(line);
      return parts;
    }
    const refillBtn = this.refillButton();
    if (refillBtn) parts.push(refillBtn);
    if (this.lastRaid) {
      const r = this.lastRaid;
      const card = el('div', 'base-result');
      const bonus = r.contractBonus > 0 ? ` (incl. ${money(r.contractBonus)} contract bonus)` : '';
      card.append(el('b', '', `Raid on ${r.defender}`), el('span', '', r.line), el('span', 'money-text', `Earned ${money(r.payout)}${bonus}`));
      parts.push(card);
    }
    const fee = s.scoutFee ?? 0;
    const scoutLabel = (verb: string) => fee > 0 ? `${verb} · ${money(fee)}` : `${verb} · Free`;
    const t = s.target;
    if (!t) {
      const intro = el('div', 'base-info base-intro');
      intro.append(
        el('b', '', 'Raid Ops — 1. Scout · 2. Pick A/B/C · 3. Launch'),
        el('span', '', `Matches unshielded Raidable rivals within ${s.rules.maxTierGap ?? 1} tier (24h per-rival cooldown). Destroying a defended HQ also pays a contract bonus up to ${money(s.rules.contractCap ?? 600)}.`),
      );
      parts.push(intro);
      const scout = button('btn btn-primary btn-block', scoutLabel(this.lastRaid ? 'Scout another base' : 'Scout a base'), () => void this.scout());
      scout.disabled = this.busy || s.cash < fee;
      parts.push(scout);
      return parts;
    }
    const card = el('div', 'base-target');
    const name = el('div', 'base-target-name', t.name);
    name.append(el('span', 'tag tag--raid', `Tier ${t.tier}`));
    const netMax = Math.floor(t.lootPool * (1 - (s.rules.lootBurnShare ?? 0.15)));
    card.append(name,
      el('span', 'hf-sub', `HQ on the ${siteInfo(s.rules, t.site).name.toLowerCase()} · ${t.hqHp.toLocaleString('en-US')} health`),
      el('span', 'money-text', `Up to ${money(netMax)} net loot + contract bonus`),
      el('span', 'hf-sub', `Defender risks up to ${money(t.lootPool)} (${Math.round((s.rules.lootBurnShare ?? 0.15) * 100)}% raid burn). Defended HQs pay up to ${money(s.rules.contractCap ?? 600)} extra on destruction.`));
    parts.push(card);
    const wavesHead = el('div', 'pane-head');
    wavesHead.append(el('span', 'label', 'Your waves'), el('span', 'meta', 'Pick an entrance for each'));
    parts.push(wavesHead);
    const saved = s.waves;
    for (let w = 0; w < WAVES; w++) {
      const line = el('div', 'base-wave-line');
      const text = el('span', 'base-tool-text');
      text.append(el('span', 'base-tool-name', `Wave ${w + 1}`), el('span', 'base-tool-sub', this.waveSummary(saved[w] ?? {})));
      line.append(text, this.entrancePicker(w));
      parts.push(line);
    }
    const empty = saved.every(w => totalOf(w ?? {}) === 0);
    if (this.dirtyWaves()) parts.push(el('p', 'warn-line', 'Your Army tab has unsaved changes. The raid uses the saved waves above.'));
    if (empty) {
      parts.push(el('p', 'base-problem', 'Your waves are empty. Buy or refill soldiers on the Army tab first.'));
    } else {
      parts.push(this.confirm('btn btn-primary btn-block', `Raid ${t.name}`, 'Click again: soldiers that die are gone', () => void this.launch()));
    }
    const again = button('link link--muted', scoutLabel('Scout a different base'), () => void this.scout());
    again.disabled = this.busy || s.cash < fee;
    parts.push(again);
    return parts;
  }

  /** A button that needs a second click within 3 s. */
  private confirm(cls: string, label: string, armedLabel: string, onConfirm: () => void): HTMLButtonElement {
    let armed = 0;
    const btn = button(cls, label, () => {
      if (!armed) {
        btn.textContent = armedLabel;
        btn.classList.add('armed');
        armed = window.setTimeout(() => { armed = 0; btn.textContent = label; btn.classList.remove('armed'); }, 3000);
        return;
      }
      window.clearTimeout(armed);
      armed = 0;
      onConfirm();
    });
    return btn;
  }

  private logPanel(): HTMLElement[] {
    const s = this.state!;
    const section = (title: string, logs: RaidLog[], attacking: boolean, none: string) => {
      const head = el('div', 'pane-head');
      head.append(el('span', 'label', title), el('span', 'meta num', String(logs.length)));
      const out: HTMLElement[] = [head];
      if (!logs.length) out.push(el('p', 'hf-sub', none));
      for (const log of logs) {
        const row = el('div', `base-log${log.destroyed ? (attacking ? ' won' : ' lost') : ''}`);
        const text = el('span', 'base-tool-text');
        const extra = attacking
          ? (log.contractBonus ? ` · +${money(log.contractBonus)} contract` : '')
          : (log.salvage ? ` · +${money(log.salvage)} salvage` : '');
        text.append(el('span', 'base-tool-name', `${attacking ? 'vs' : 'by'} ${log.opponent}`),
          el('span', 'base-tool-sub', `${ago(s.now, log.at)} · ${outcomeLine(log)}${extra}`));
        const net = attacking ? (log.payout ?? log.loot) : ((log.salvage ?? 0) - log.loot);
        const cash = el('span', `num base-log-cash ${net >= 0 ? 'gain' : 'loss'}`, `${net >= 0 ? '+' : '−'}${money(Math.abs(net))}`);
        row.append(text, cash);
        if (log.replayable) {
          const w = button('btn btn-secondary btn-sm', 'Watch', () => void this.watch(log, attacking));
          w.disabled = this.busy;
          row.append(w);
        }
        out.push(row);
      }
      return out;
    };
    return [
      ...section('Raids on your base', s.defenses, false, s.raidable ? 'Nobody has raided your base yet.' : 'Safe operators are never raided.'),
      ...section('Your raids', s.attacks, true, 'You have not raided anyone yet.'),
      el('p', 'hf-sub', 'Raids on your base replay with everything visible. Your own raids replay through the fog you had.'),
    ];
  }

  // ---------- Replay transport ----------

  private renderTransport() {
    const bar = this.q('baseTransport');
    const p = this.playback;
    bar.hidden = !p;
    if (!p) { bar.replaceChildren(); return; }
    const done = p.tick >= this.endTick;
    const toggle = button('btn btn-secondary btn-sm', done ? 'Replay' : p.playing ? 'Pause' : 'Play', () => {
      if (p.tick >= this.endTick) p.tick = 0;
      p.playing = !p.playing || done;
      this.lastFrame = performance.now();
      this.renderTransport();
    });
    const speed = button('btn btn-ghost btn-sm', `${p.speed}×`, () => { p.speed = p.speed >= 4 ? 1 : p.speed * 2; this.renderTransport(); });
    speed.title = 'Playback speed';
    const scrub = el('input', 'base-scrub');
    scrub.id = 'baseScrub';
    scrub.type = 'range';
    scrub.min = '0';
    scrub.max = String(this.endTick);
    scrub.step = '1';
    scrub.value = String(Math.floor(p.tick));
    scrub.setAttribute('aria-label', 'Replay position');
    scrub.addEventListener('input', () => {
      p.tick = Number(scrub.value);
      p.playing = false;
      if (p.tick >= this.endTick && this.pendingRaid) this.commitPendingRaid();
      this.syncTransport();
      this.draw();
    });
    scrub.addEventListener('change', () => this.renderTransport());
    const time = el('span', 'num base-time');
    time.id = 'baseTime';
    const row = el('div', 'base-transport-row');
    row.append(toggle, speed, scrub, time);
    if (!done && this.pendingRaid) {
      row.append(button('btn btn-secondary btn-sm', 'Skip to result', () => {
        p.tick = this.endTick;
        p.playing = false;
        this.commitPendingRaid();
      }));
    }
    if (!p.data.fog) {
      const label = el('label', 'check');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = p.fog;
      box.addEventListener('change', () => { p.fog = box.checked; this.draw(); });
      label.append(box, "Attacker's view");
      label.title = 'Show only what the attacking soldiers uncovered';
      row.append(label);
    }
    row.append(button('btn btn-ghost btn-sm', 'Close', () => { this.stopReplay(); this.render(); }));
    const result = el('p', `base-result-line${done ? ' done' : ''}`, done ? p.result : '');
    bar.replaceChildren(row, result);
    this.syncTransport();
  }

  private syncTransport() {
    const p = this.playback;
    if (!p) return;
    const secs = Math.floor(Math.min(p.tick, p.data.outcome.ticks) / p.data.ticksPerSec);
    const total = Math.floor(p.data.outcome.ticks / p.data.ticksPerSec);
    const time = document.getElementById('baseTime');
    if (time) time.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} / ${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    const scrub = document.getElementById('baseScrub') as HTMLInputElement | null;
    if (scrub && document.activeElement !== scrub) scrub.value = String(Math.floor(p.tick));
  }

  // ---------- Drawing ----------

  private resize() {
    const wrap = this.q('baseCanvasWrap');
    const size = Math.floor(Math.min(wrap.clientWidth, wrap.clientHeight || wrap.clientWidth));
    if (size <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.style.width = this.canvas.style.height = `${size}px`;
    if (this.canvas.width !== Math.round(size * dpr)) this.canvas.width = this.canvas.height = Math.round(size * dpr);
    this.draw();
  }

  private center(cell: number, s: number): [number, number] {
    const [x, y] = xyOf(this.rules.grid, cell);
    return [(x + 0.5) * s, (y + 0.5) * s];
  }

  private drawGround(s: number) {
    const ctx = this.ctx, g = this.rules.grid;
    ctx.fillStyle = GROUND;
    ctx.fillRect(0, 0, g * s, g * s);
    ctx.strokeStyle = 'rgba(235, 230, 214, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < g; i++) { ctx.moveTo(i * s, 0); ctx.lineTo(i * s, g * s); ctx.moveTo(0, i * s); ctx.lineTo(g * s, i * s); }
    ctx.stroke();
  }

  private drawEntrances(s: number, entrances: number[], waveEntrances: number[] | null) {
    const ctx = this.ctx;
    entrances.forEach((cell, i) => {
      const [cx, cy] = this.center(cell, s);
      ctx.fillStyle = withAlpha(theme.money, 0.18);
      ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
      ctx.strokeStyle = theme.money;
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - s / 2 + 1, cy - s / 2 + 1, s - 2, s - 2);
      ctx.fillStyle = theme.money;
      ctx.font = font(Math.round(s * 0.58), 800);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ENTRANCE_NAMES[i], cx, cy + 1);
      if (waveEntrances) {
        // Which waves come in here, as small numbered tabs beside the gate.
        const waves = waveEntrances.map((e, w) => (e === i ? w + 1 : 0)).filter(Boolean);
        const [x, y] = xyOf(this.rules.grid, cell);
        const g = this.rules.grid;
        const dx = x === 0 ? 1 : x === g - 1 ? -1 : 0;
        const dy = dx !== 0 ? 0 : y === 0 ? 1 : -1;
        waves.forEach((w, n) => {
          const bx = cx + dx * s * (1 + n * 0.72), by = cy + dy * s * (1 + n * 0.72);
          ctx.fillStyle = theme.accent;
          ctx.beginPath(); ctx.arc(bx, by, s * 0.3, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = font(Math.round(s * 0.4), 800);
          ctx.fillText(String(w), bx, by + 1);
        });
      }
    });
  }

  private drawHq(s: number, cell: number, color: string, frac: number | null) {
    const ctx = this.ctx;
    const [cx, cy] = this.center(cell, s);
    const dead = frac !== null && frac <= 0;
    ctx.fillStyle = dead ? '#3a2019' : '#23261c';
    ctx.fillRect(cx - s * 0.46, cy - s * 0.46, s * 0.92, s * 0.92);
    ctx.strokeStyle = dead ? theme.textMuted : color;
    ctx.lineWidth = Math.max(2, s * 0.1);
    ctx.strokeRect(cx - s * 0.46, cy - s * 0.46, s * 0.92, s * 0.92);
    ctx.fillStyle = dead ? theme.textMuted : color;
    ctx.font = font(Math.round(s * 0.42), 800);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('HQ', cx, cy + 1);
    if (frac !== null) this.drawBar(cx, cy - s * 0.62, s * 1.5, Math.max(0, frac), color);
  }

  private drawBar(cx: number, y: number, w: number, frac: number, color: string) {
    const ctx = this.ctx;
    const h = Math.max(3, w * 0.09);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(cx - w / 2, y - h / 2, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(cx - w / 2, y - h / 2, w * frac, h);
  }

  private drawFog(s: number, seen: boolean[]) {
    const ctx = this.ctx, g = this.rules.grid;
    ctx.fillStyle = 'rgba(6, 7, 4, 0.9)';
    for (let cell = 0; cell < seen.length; cell++) {
      if (seen[cell]) continue;
      const [x, y] = xyOf(g, cell);
      ctx.fillRect(x * s, y * s, s + 0.5, s + 0.5);
    }
    ctx.strokeStyle = 'rgba(235, 230, 214, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let cell = 0; cell < seen.length; cell++) {
      if (seen[cell]) continue;
      const [x, y] = xyOf(g, cell);
      ctx.moveTo(x * s + s * 0.2, y * s + s * 0.8); ctx.lineTo(x * s + s * 0.8, y * s + s * 0.2);
    }
    ctx.stroke();
  }

  draw() {
    if (!this.state || !this.visible || this.canvas.width === 0) return;
    const s = this.canvas.width / this.rules.grid;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.playback) this.drawReplay(s);
    else if (this.tab === 'raid' && this.state.target && !this.state.raidBlocker) this.drawTarget(s);
    else this.drawEditor(s);
  }

  private drawEditor(s: number) {
    const ctx = this.ctx, rules = this.rules, g = rules.grid;
    const site = siteInfo(rules, this.draft.site);
    this.drawGround(s);
    // How soldiers will walk in from each entrance.
    const paths = routes(rules, this.draft);
    ctx.save();
    ctx.setLineDash([s * 0.18, s * 0.2]);
    ctx.lineWidth = Math.max(1.5, s * 0.07);
    paths.forEach(path => {
      if (!path) return;
      ctx.strokeStyle = withAlpha(theme.accent, 0.6);
      ctx.beginPath();
      path.forEach((cell, i) => { const [cx, cy] = this.center(cell, s); if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy); });
      const [hx, hy] = this.center(site.hq, s);
      ctx.lineTo(hx, hy);
      ctx.stroke();
    });
    ctx.restore();
    // The reach of the selected gun, around the square under the pointer/cursor or every one placed.
    const activeCell = this.hover ?? this.cursor;
    const info = this.tool !== 'erase' ? kindInfo(rules, this.tool) : null;
    const ring = (cell: number, range: number, alpha: number) => {
      const [cx, cy] = this.center(cell, s);
      ctx.fillStyle = withAlpha(theme.you, alpha * 0.4);
      ctx.strokeStyle = withAlpha(theme.you, alpha);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, range * s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    };
    if (this.tab === 'build' && info?.range) {
      for (const p of this.draft.pieces) if (p.kind === this.tool) ring(cellOf(g, p.x, p.y), info.range, 0.18);
      if (activeCell !== null && this.pieceAt(activeCell) < 0) ring(activeCell, info.range, 0.4);
    }
    for (const p of this.draft.pieces) {
      const [cx, cy] = this.center(cellOf(g, p.x, p.y), s);
      const soldier = kindInfo(rules, p.kind).soldier;
      drawPiece(ctx, p.kind, cx, cy, s, p.kind === 'mine' ? theme.money : theme.you, soldier);
    }
    this.drawEntrances(s, site.entrances, this.tab === 'build' ? null : this.entrances);
    this.drawHq(s, site.hq, theme.you, null);
    paths.forEach((path, i) => {
      if (path) return;
      const [cx, cy] = this.center(site.entrances[i], s);
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 3;
      ctx.strokeRect(cx - s / 2 + 1.5, cy - s / 2 + 1.5, s - 3, s - 3);
    });
    if (this.tab === 'build' && activeCell !== null && activeCell !== site.hq && !site.entrances.includes(activeCell)) {
      const [cx, cy] = this.center(activeCell, s);
      ctx.strokeStyle = this.tool === 'erase' ? theme.accent : theme.text;
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - s / 2 + 1, cy - s / 2 + 1, s - 2, s - 2);
      if (this.tool !== 'erase' && this.pieceAt(activeCell) < 0) {
        ctx.globalAlpha = 0.5;
        drawPiece(ctx, this.tool, cx, cy, s, this.tool === 'mine' ? theme.money : theme.you, kindInfo(rules, this.tool).soldier);
        ctx.globalAlpha = 1;
      }
    }
  }

  /** A scouted base: only its HQ and entrances are known. */
  private drawTarget(s: number) {
    const t = this.state!.target!;
    this.drawGround(s);
    const seen = new Array<boolean>(this.rules.grid ** 2).fill(false);
    seen[t.hq] = true;
    for (const e of t.entrances) seen[e] = true;
    this.drawFog(s, seen);
    this.drawEntrances(s, t.entrances, this.entrances);
    this.drawHq(s, t.hq, theme.accent, null);
  }

  private drawReplay(s: number) {
    const ctx = this.ctx, p = this.playback!, r = p.data, g = r.grid;
    const tick = Math.min(p.tick, r.outcome.ticks);
    // You are the attacker in your own (fogged) raids, the defender otherwise.
    const attackerIsYou = r.fog;
    const troopColor = attackerIsYou ? theme.you : theme.accent;
    const baseColor = attackerIsYou ? theme.accent : theme.you;
    const fog = p.fog || r.fog;
    const seen = fog ? revealedAt(r, tick) : null;
    const shown = (seenAt: number | null) => !fog || (seenAt !== null && seenAt <= tick);
    const hurt = damageAt(r, tick);
    this.drawGround(s);

    for (const [cell, seenAt] of r.walls) {
      if (!shown(seenAt)) continue;
      const [cx, cy] = this.center(cell, s);
      drawPiece(ctx, 'wall', cx, cy, s, CONCRETE);
    }
    for (const m of r.mines) {
      const blown = m.blown !== null && m.blown <= tick;
      const disarmed = m.disarmed != null && m.disarmed <= tick;
      if (fog && !blown && !disarmed) continue;
      const [cx, cy] = this.center(m.cell, s);
      if (blown) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.beginPath(); ctx.arc(cx, cy, s * 0.36, 0, Math.PI * 2); ctx.fill();
      } else if (disarmed) {
        ctx.strokeStyle = troopColor;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, s * 0.22, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.16, cy - s * 0.16); ctx.lineTo(cx + s * 0.16, cy + s * 0.16);
        ctx.stroke();
      } else drawPiece(ctx, 'mine', cx, cy, s, theme.money);
    }
    const where = new Map<number, [number, number]>();
    where.set(HQ_ID, this.center(r.hq, s));
    for (const d of r.defenses) {
      if (!shown(d.seen)) continue;
      const [cx, cy] = this.center(d.cell, s);
      const gone = d.destroyed !== null && d.destroyed <= tick;
      if (gone) {
        ctx.strokeStyle = theme.textMuted;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx - s * 0.25, cy - s * 0.25); ctx.lineTo(cx + s * 0.25, cy + s * 0.25); ctx.moveTo(cx + s * 0.25, cy - s * 0.25); ctx.lineTo(cx - s * 0.25, cy + s * 0.25); ctx.stroke();
        continue;
      }
      where.set(d.id, [cx, cy]);
      drawPiece(ctx, d.kind, cx, cy, s, baseColor, SOLDIERS.includes(d.kind));
      const left = 1 - (hurt.get(d.id) ?? 0) / d.hp;
      if (left < 1) this.drawBar(cx, cy - s * 0.52, s * 0.8, Math.max(0, left), baseColor);
    }
    this.drawEntrances(s, r.entrances, tick < 5 ? r.waveEntrances : null);
    this.drawHq(s, r.hq, baseColor, 1 - (hurt.get(HQ_ID) ?? 0) / r.hqHp);

    for (const t of r.troops) {
      const at = troopAt(g, t, tick);
      if (!at) continue;
      // Soldiers on the same square fan out a little so a wave reads as a group.
      const ox = ((t.id * 37) % 7 - 3) * s * 0.045, oy = ((t.id * 53) % 7 - 3) * s * 0.045;
      const cx = at.x * s + ox, cy = at.y * s + oy;
      if (t.died !== null && t.died <= tick) {
        if (tick - t.died < 40) {
          ctx.globalAlpha = 0.45 * (1 - (tick - t.died) / 40);
          drawPiece(ctx, t.kind, cx, cy, s * 0.8, theme.textMuted);
          ctx.globalAlpha = 1;
        }
        continue;
      }
      where.set(t.id, [cx, cy]);
      drawPiece(ctx, t.kind, cx, cy, s * 0.8, troopColor);
      const left = 1 - (hurt.get(t.id) ?? 0) / t.hp;
      if (left < 1) this.drawBar(cx, cy - s * 0.42, s * 0.6, Math.max(0, left), troopColor);
    }

    // Tracers for the last few ticks of shots; a hidden gun shows only where it hit.
    ctx.lineWidth = Math.max(1, s * 0.05);
    for (const [t, from, to] of r.shots) {
      if (t > tick) break;
      if (tick - t > 2.5) continue;
      const target = where.get(to);
      if (!target) continue;
      const source = from === HIDDEN_ID ? undefined : where.get(from);
      const byTroop = from >= 0 && from < 1000;
      const color = byTroop ? troopColor : baseColor;
      const fade = 1 - (tick - t) / 2.5;
      if (source) {
        ctx.strokeStyle = withAlpha(color, 0.85 * fade);
        ctx.beginPath(); ctx.moveTo(source[0], source[1]); ctx.lineTo(target[0], target[1]); ctx.stroke();
      }
      ctx.fillStyle = withAlpha(color, 0.9 * fade);
      ctx.beginPath(); ctx.arc(target[0], target[1], s * 0.12, 0, Math.PI * 2); ctx.fill();
    }
    for (const b of r.blasts) {
      if (b.tick > tick) break;
      const age = tick - b.tick;
      if (age > 6) continue;
      const [cx, cy] = this.center(b.cell, s);
      ctx.strokeStyle = withAlpha(theme.money, 1 - age / 6);
      ctx.fillStyle = withAlpha(theme.money, 0.35 * (1 - age / 6));
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(cx, cy, this.rules.mineRadius * s * (0.4 + 0.6 * age / 6), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    if (seen) {
      this.drawFog(s, seen);
      // The HQ and the gates stay readable through the dark.
      this.drawHq(s, r.hq, baseColor, 1 - (hurt.get(HQ_ID) ?? 0) / r.hqHp);
    }
  }
}
