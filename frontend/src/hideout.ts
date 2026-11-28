// Hideout: one Stash screen (loadout on the left, every stash item on the right,
// a compare panel under the loadout), a Trader screen (stock table plus a
// sell list), the Homefront (tier, facilities, Operations ranks), the Base
// (base.ts: defenses, attack waves, base raids) and the Operators screen
// (create/switch operators, season, Legacy, retiring).
// Talks to /api/hideout. DOM nodes only, never innerHTML with server strings.

import type { Item, Slot } from './generated/types';
import {
  Hideout, MapSummary, Offer, SLOTS, SLOT_LABEL, RARITY_COLOR, RARITY_LABEL, KIND_LABEL, KIND_ICON,
  slotsFor, itemEffect, upgradeDelta, mapLockText, bestMapFor, formatClock, gearScoreWith, gearScore,
  DECRYPT_SECS, estimatedValue, isEncrypted, isWeapon, itemGroup, ItemGroup,
  weaponDamageMult, armorMaxHealth, packCapacity, packMaxAmmo, weaponDps,
  daysUntil, opsProgress,
} from './raid';
import { BaseView } from './base';

type HideoutTab = 'stash' | 'trader' | 'homefront' | 'base' | 'operators';
type TraderGroup = 'all' | 'weapons' | 'armor' | 'packs';
const RARITY_RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 } as const;
const GROUPS: { id: ItemGroup; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'weapons', label: 'Weapons' }, { id: 'armor', label: 'Armor' },
  { id: 'packs', label: 'Packs' }, { id: 'valuables', label: 'Valuables' }, { id: 'encrypted', label: 'Sealed' },
];
const TRADER_GROUPS: { id: TraderGroup; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'weapons', label: 'Weapons' }, { id: 'armor', label: 'Armor' }, { id: 'packs', label: 'Packs' },
];

export interface HideoutDeps {
  auth: () => { token: string };
  /** The server says this session isn't signed in. */
  onSignedOut?: () => void;
  icon: (id: string) => SVGSVGElement;
  /** The hideout changed (cash, gear score, maps). */
  onChange: (h: Hideout) => void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const money = (n: number) => `$${Math.floor(n).toLocaleString('en-US')}`;
const FACILITY_ICON: Record<string, string> = { storage: 'i-crate', armory: 'i-pistol', office: 'i-shield-check', workshop: 'i-wrench' };
const PERK_ICON: Record<string, string> = { vitality: 'i-heart', firepower: 'i-crosshair', scavenger: 'i-coins', packrat: 'i-crate', broker: 'i-shield-check' };

/** A segmented HUD meter: `on` lit segments out of `of`; segments past `cap` are hatched (unreachable). */
function segMeter(on: number, of: number, label: string, cap = of, tone: 'you' | 'money' = 'you'): HTMLElement {
  const m = el('span', `seg-meter${tone === 'money' ? ' seg-meter--money' : ''}`);
  m.setAttribute('role', 'img');
  m.setAttribute('aria-label', label);
  m.title = label;
  for (let i = 0; i < of; i++) m.append(el('i', i < on ? 'on' : i >= cap ? 'cap' : ''));
  return m;
}

/** What each Homefront facility is for, in one line. */
const FACILITY_WHAT: Record<string, string> = {
  storage: 'Room for items in your stash.',
  armory: 'Better gear for sale at the trader (power = item strength).',
  office: 'Insurance gets your gear back if you die in a raid.',
  workshop: 'Makes cash while you are away.',
};
/** A short UTC calendar date, e.g. "Dec 4". */
const shortDate = (unix: number) => new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The one number that matters for each kind of gear. */
export function keyStat(item: Pick<Item, 'kind' | 'power'>): { label: string; value: number; text: string } | null {
  if (isWeapon(item.kind)) { const v = weaponDps(item.kind, item.power)!; return { label: 'DPS', value: v, text: `${v} DPS · ${Math.round(weaponDamageMult(item.power) * 100)}% damage` }; }
  if (item.kind === 'armor') { const v = armorMaxHealth(item.power); return { label: 'Max health', value: v, text: `${v} max health` }; }
  if (item.kind === 'pack') { const v = packCapacity(item.power); return { label: 'Loot slots', value: v, text: `${v} loot slots · ${packMaxAmmo(item.power)} ammo` }; }
  return null;
}

/** What sets each kind of gear apart, beyond its power. */
export const KIND_TRAIT: Partial<Record<Item['kind'], string>> = {
  pistol: 'Accurate', uzi: 'Rapid fire', shotgun: 'Spread', rocketLauncher: 'Explosive',
  armor: 'Health', pack: 'Capacity',
};

const touch = () => window.matchMedia('(pointer: coarse), (max-width: 720px)').matches;

/** A second number that tells gear of the same power apart. */
export const KIND_RATE: Partial<Record<Item['kind'], string>> = {
  pistol: '5 shots/s', uzi: '12 shots/s', shotgun: '2 blasts/s', rocketLauncher: '1 shot/s · 80 splash',
};

/** A button that needs a second click within 3 s (for things you can't undo). */
function confirmButton(cls: string, label: string, armedLabel: string, onConfirm: () => void): HTMLButtonElement {
  const btn = el('button', cls, label);
  btn.type = 'button';
  let armed = 0;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
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

export class HideoutView {
  state: Hideout | null = null;
  selectedId: string | null = null;
  tab: HideoutTab = 'stash';
  busy = false;
  filter: ItemGroup = 'all';
  sort: 'value' | 'power' | 'rarity' | 'name' = 'value';
  traderFilter: TraderGroup = 'all';
  showOutclassed = false;
  checked = new Set<string>();
  topPick = new Set<string>();
  showKeepers = false;
  /** Operator creation form: name and the raids choice (null until picked). */
  newName = '';
  newRaidable: boolean | null = null;
  /** Established accounts open the new-operator form on demand. */
  creating = false;
  /** The Base tab: defenses, attack waves and base raids. */
  base: BaseView;
  overflowKeep = new Set<string>();
  private overflowOperator: string | undefined;

  constructor(private deps: HideoutDeps) {
    this.base = new BaseView({
      auth: deps.auth,
      onCash: () => void this.refresh(),
      onUnread: (n) => this.setBaseUnread(n),
      error: (msg) => this.error(msg),
      note: (msg) => this.note(msg),
    });
    document.querySelectorAll<HTMLButtonElement>('[data-hideout-tab]').forEach(btn => btn.addEventListener('click', () => {
      this.tab = btn.dataset.hideoutTab as HideoutTab;
      this.render();
    }));
    const sort = document.getElementById('invSort') as HTMLSelectElement | null;
    sort?.addEventListener('change', () => { this.sort = sort.value as typeof this.sort; this.render(); });
    document.getElementById('invSelectValuables')?.addEventListener('click', () => {
      for (const i of this.state?.stash ?? []) if (i.kind === 'valuable' && !i.protected) this.checked.add(i.id);
      this.render();
    });
    document.getElementById('invClear')?.addEventListener('click', () => { this.checked.clear(); this.render(); });
    document.getElementById('sheetScrim')?.addEventListener('click', () => this.select(null));
    const sellBtn = document.getElementById('invSellSelected') as HTMLButtonElement | null;
    let armed = 0;
    sellBtn?.addEventListener('click', () => {
      const ids = [...this.checked];
      if (ids.length === 0) return;
      if (!armed) {
        sellBtn.textContent = 'Click again to sell (no buy-back)';
        sellBtn.classList.add('armed');
        armed = window.setTimeout(() => { armed = 0; sellBtn.classList.remove('armed'); this.render(); }, 3000);
        return;
      }
      window.clearTimeout(armed);
      armed = 0;
      sellBtn.classList.remove('armed');
      this.checked.clear();
      void this.act('sellMany', { itemIds: ids });
    });
  }

  private q(id: string) { return document.getElementById(id)!; }

  async refresh(): Promise<Hideout | null> {
    const { token } = this.deps.auth();
    try {
      const res = await fetch(`/api/hideout?token=${encodeURIComponent(token)}`);
      const data = await res.json() as Hideout & { signedOut?: boolean };
      if (data.ok) this.apply(data);
      else if (data.signedOut) this.deps.onSignedOut?.();
      else this.error(data.error || 'Could not load your hideout');
      return data.ok ? data : null;
    } catch {
      this.error('Network error: the hideout is offline');
      return null;
    }
  }

  private apply(h: Hideout) {
    // Another operator has its own base.
    if (this.state?.id !== h.id) { this.base.reset(); if (this.base.visible && !h.needsOperator) void this.base.load(); }
    this.state = h;
    if (this.overflowOperator !== h.id) { this.overflowKeep.clear(); this.overflowOperator = h.id; }
    for (const item of h.overflow ?? []) if (item.protected) this.overflowKeep.add(item.id);
    for (const id of this.overflowKeep) if (!h.overflow?.some(i => i.id === id)) this.overflowKeep.delete(id);
    if (this.selectedId && !this.findItem(this.selectedId)) this.selectedId = null;
    for (const id of [...this.checked]) if (!h.stash.some(i => i.id === id && !i.protected)) this.checked.delete(id);
    this.render();
    this.deps.onChange(h);
  }

  private error(msg: string) {
    const node = this.q('hideoutError');
    node.classList.remove('ok-text');
    node.textContent = msg;
  }
  private note(msg: string) {
    const node = this.q('hideoutError');
    node.classList.add('ok-text');
    node.textContent = msg;
  }

  private async act(action: string, body: Record<string, unknown>) {
    if (this.busy) return;
    this.busy = true;
    this.error('');
    const { token } = this.deps.auth();
    try {
      const res = await fetch(`/api/hideout/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ...body }),
      });
      const data = await res.json() as Hideout;
      const before = this.state;
      if (data.operators !== undefined) this.apply(data);
      if (!data.ok) this.error(data.error || 'That did not work');
      else if (action === 'buy' && before) {
        // Point at the new item so equipping it is one click away.
        const fresh = data.stash.find(i => !before.stash.some(b => b.id === i.id));
        if (fresh) {
          this.selectedId = fresh.id;
          this.render();
          const best = upgradeDelta(data.loadout, fresh);
          this.note(best && best.delta > 0 ? `Bought ${fresh.name}. Equip it from your stash for +${best.delta} gear score.` : `Bought ${fresh.name}. It's in your stash.`);
        }
      } else if (action === 'sell' || action === 'sellMany') this.note(`Sold for ${money(before?.cash !== undefined ? data.cash - before.cash : 0)}.`);
      else if (action === 'carry') this.note(body.carry ? 'Packed: it starts your next raid in your pack. Decrypt it at an uplink, then extract.' : 'Unpacked: it stays in your stash.');
      else if (action === 'equip') this.note('Equipped.');
      else if (action === 'deleteOperator') this.note('Operator deleted.');
      else if (action === 'createOperator') { this.newName = ''; this.newRaidable = null; this.creating = false; this.tab = 'stash'; this.render(); this.note(`${data.name} reporting in. Starter kit and $${data.cash} are in the stash.`); }
      else if (action === 'switchOperator') this.note(`Now playing ${data.name}.`);
      else if (action === 'upgradeTier') this.note(`Homefront raised to tier ${data.homefront?.tier}.`);
      else if (action === 'promoteRaidable') this.note(`${data.name} is now Raidable: Tier 4, +15% Workshop income and base raids unlocked.`);
      else if (action === 'upgradeFacility') this.note('Facility upgraded.');
      else if (action === 'collectWorkshop') this.note(`Collected ${money(before?.cash !== undefined ? data.cash - before.cash : 0)} from the Workshop.`);
      else if (action === 'requisition') this.note('Requested gear added to your stash, protected from accidental sale.');
      else if (action === 'resolveOverflow') this.note('Extraction loot selection saved.');
      else if (action === 'respec') this.note('Legacy points refunded. Choose your new perks.');
      else if (action === 'relocate') this.note('Retired. Your Legacy grew: spend points on perks, then create a new operator.');
      else if (action === 'buyPerk') this.note('Perk upgraded. It applies to every operator on your account.');
    } catch {
      this.error('Network error');
    } finally {
      this.busy = false;
      this.render();
    }
  }

  equip(item: Item, slot: Slot) { void this.act('equip', { itemId: item.id, slot }); }
  unequip(slot: Slot) { void this.act('unequip', { slot }); }
  sell(item: Item) { if (this.selectedId === item.id) this.selectedId = null; void this.act('sell', { itemId: item.id }); }
  buy(offer: Offer) { void this.act('buy', { offerId: offer.id }); }
  setCarry(item: Item, carry: boolean) { void this.act('carry', { itemId: item.id, carry }); }

  private findItem(id: string): { item: Item; slot: Slot | null } | null {
    const h = this.state;
    if (!h) return null;
    for (const s of SLOTS) if (h.loadout[s]?.id === id) return { item: h.loadout[s]!, slot: s };
    const item = h.stash.find(i => i.id === id);
    return item ? { item, slot: null } : null;
  }

  private carried(item: Item) { return this.state?.carry?.includes(item.id) ?? false; }

  /** If selling this would lower the best gear score you can reach, by how much. */
  private sellCost(h: Hideout, item: Item): { from: number; to: number } | null {
    const best = this.bestOwned(h);
    if (!SLOTS.some(s => best[s]?.id === item.id)) return null;
    const without: Hideout = { ...h, stash: h.stash.filter(i => i.id !== item.id), loadout: { ...h.loadout } };
    for (const s of SLOTS) if (without.loadout[s]?.id === item.id) without.loadout[s] = null;
    const from = gearScore(best), to = gearScore(this.bestOwned(without));
    return to < from ? { from, to } : null;
  }

  private select(id: string | null) { this.selectedId = id; this.render(); }

  private setBaseUnread(n: number) {
    const badge = document.getElementById('baseUnreadBadge');
    if (!badge) return;
    badge.hidden = n <= 0;
    badge.textContent = n > 0 ? String(n) : '';
  }

  // ---------- Rendering ----------

  render() {
    const h = this.state;
    if (!h) return;
    this.setBaseUnread(h.unreadBaseDefenses ?? 0);
    // With no operator there's nothing to manage but operators.
    if (h.needsOperator) this.tab = 'operators';
    this.q('menuHideout').classList.toggle('first-run', !!h.needsOperator);
    this.q('hideoutCash').textContent = money(h.cash);
    this.q('operatorChipName').textContent = h.needsOperator ? 'None yet' : (h.name ?? '—');
    document.querySelector('#menuHideout .hq-title')!.textContent = h.needsOperator ? 'Welcome to BoxHead' : 'Hideout';
    this.q('gsOperator').textContent = h.name ? `${h.name} · ` : '';
    this.renderGearMeter(h);
    document.querySelectorAll<HTMLButtonElement>('.hq-tabs [data-hideout-tab]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.hideoutTab === this.tab));
      btn.disabled = !!h.needsOperator && btn.dataset.hideoutTab !== 'operators';
    });
    (document.getElementById('toDeployBtn') as HTMLButtonElement | null)?.toggleAttribute('hidden', !!h.needsOperator);
    this.q('hideoutStash').hidden = this.tab !== 'stash';
    this.q('hideoutTrader').hidden = this.tab !== 'trader';
    this.q('hideoutHomefront').hidden = this.tab !== 'homefront';
    this.q('hideoutOperators').hidden = this.tab !== 'operators';
    this.q('hideoutBase').hidden = this.tab !== 'base';
    this.base.setVisible(this.tab === 'base');
    this.renderHomefront(h);
    this.renderOperators(h);
    this.renderSlots(h);
    this.renderCompare(h);
    this.renderStashStats(h);
    this.renderStash(h);
    this.renderTrader(h);
    this.renderSellList(h);
    this.renderRewardChoices(h);
  }

  /** A line explaining why something is locked, with the lock icon. */
  private locked(tag: 'p' | 'span', text: string, extra = ''): HTMLElement {
    const line = el(tag, `locked-line${extra ? ' ' + extra : ''}`);
    line.append(this.deps.icon('i-lock'), text);
    return line;
  }

  // ---------- Homefront ----------

  private renderHomefront(h: Hideout) {
    const hf = h.homefront;
    const tierBox = this.q('hfTier');
    const facBox = this.q('hfFacilities');
    const opsBox = this.q('hfOps');
    if (!hf) { tierBox.replaceChildren(); facBox.replaceChildren(); opsBox.replaceChildren(); return; }

    const head = el('div', 'hf-head');
    const stamp = el('div', 'tier-stamp');
    stamp.append(el('span', 'tier-stamp-label', 'Tier'), el('b', '', String(hf.tier)), el('span', 'tier-stamp-of', `/ ${hf.maxTier}`));
    const titleGroup = el('div', 'hf-title hf-title--stack');
    titleGroup.append(el('h3', '', `${h.name ?? 'Operator'}'s Homefront`));
    const pips = el('div', 'tier-pips');
    for (let t = 1; t <= hf.topTier; t++) {
      const pip = el('span', `tier-pip${t <= hf.tier ? ' on' : ''}${t > hf.maxTier ? ' locked' : ''}`);
      pip.title = t <= hf.maxTier ? `Tier ${t}` : h.pvpEnabled === false ? `Tier ${t}: arrives with PvP` : `Tier ${t}: Raidable operators only`;
      pips.append(pip);
    }
    titleGroup.append(pips);
    head.append(stamp, titleGroup);
    const parts: HTMLElement[] = [head, el('p', 'hf-sub', 'Your base. Each tier raises every facility\'s level cap.')];
    if (hf.next) {
      const n = hf.next;
      const shortCash = Math.max(0, n.cash - h.cash);
      const shortItems = Math.max(0, n.valuables - n.have);
      const req = el('ul', 'checklist');
      const check = (ok: boolean, text: string) => {
        const li = el('li', ok ? 'ok' : 'todo');
        li.append(el('span', 'check-mark', ok ? '✓' : '✗'), text);
        return li;
      };
      req.append(
        check(shortCash === 0, `${money(n.cash)} cash${shortCash ? ` (you have ${money(h.cash)})` : ''}`),
        check(shortItems === 0, `${n.valuables} ${RARITY_LABEL[n.minRarity]} or better valuables (you have ${Math.min(n.have, n.valuables)})`),
      );
      const ready = !shortCash && !shortItems && !h.inRaid;
      const label = h.inRaid ? 'Finish your raid first' : ready ? `Raise to tier ${n.tier}`
        : (shortItems && shortCash) ? 'Not ready yet: 2 requirements left'
        : shortItems ? `Need ${shortItems} more ${RARITY_LABEL[n.minRarity]}+ valuable${shortItems === 1 ? '' : 's'}` : `Need ${money(shortCash)} more`;
      let action: HTMLElement;
      if (ready) {
        const btn = el('button', 'btn btn-sm btn-money-solid', label);
        btn.type = 'button';
        btn.addEventListener('click', () => void this.act('upgradeTier', {}));
        action = btn;
      } else {
        action = this.locked('p', label);
      }
      const row = el('div', 'tier-next');
      const reqBox = el('div');
      reqBox.append(el('span', 'label', `To reach tier ${n.tier}`), req);
      if (ready) row.append(reqBox, action); else { reqBox.append(action); row.append(reqBox); }
      parts.push(row);
      if (!ready && !h.inRaid) parts.push(el('p', 'hf-sub', 'Raid for cash and valuables. Harder maps drop rarer ones.'));
      if (!shortItems && n.uses.length) {
        const names = n.uses.map(id => h.stash.find(i => i.id === id)?.name).filter(Boolean).join(', ');
        parts.push(el('p', 'hf-sub', `Uses your cheapest qualifying valuables: ${names}.`));
      }
    } else if (hf.tier < hf.topTier) {
      parts.push(el('p', 'hf-sub', h.pvpEnabled === false
        ? `Tier ${hf.safeTier} is the top tier for now. Tier ${hf.topTier} arrives with PvP in a later season.`
        : `Tier ${hf.safeTier} is the top tier for a Safe operator: its Homefront can't be raided, so it can't build higher.`));
    } else {
      parts.push(el('p', 'hf-sub', 'Your Homefront is at its top tier.'));
    }
    tierBox.replaceChildren(...parts);

    facBox.replaceChildren(...hf.facilities.map(f => {
      const card = el('div', 'fac');
      const top = el('div', 'fac-top');
      const tile = el('span', 'icon-tile');
      tile.append(this.deps.icon(FACILITY_ICON[f.id] ?? 'i-crate'));
      const nameBox = el('div', 'fac-title');
      const lvl = el('div', 'fac-level-row');
      // Count to the highest level this operator can ever build, not one it can't reach.
      lvl.append(segMeter(f.level, hf.maxTier, `Level ${f.level} of ${hf.maxTier}`, f.maxLevel), el('span', 'fac-level num', `${f.level}/${hf.maxTier}`));
      nameBox.append(el('span', 'fac-name', f.name), lvl);
      top.append(tile, nameBox);
      card.append(top, el('p', 'fac-what', FACILITY_WHAT[f.id]));
      if (f.id === 'workshop' && f.level > 0) {
        const w = hf.workshop;
        const strip = el('div', 'collect-strip');
        const txt = el('div');
        txt.append(el('div', 'money-text', w.collected ? `${money(w.collected)} automatically banked` : 'Automatically banks when you return'),
          el('div', 'hf-sub', `Accumulates up to 48 hours (${money(w.capacity)}). No collection schedule needed.`));
        strip.append(txt);
        card.append(strip);
      }
      const fx = el('div', 'fac-fx');
      fx.append(el('span', 'fac-now', f.level === 0 ? 'Not built' : f.effect));
      if (f.next) {
        fx.append(el('span', 'fac-arrow', '▶'), el('span', `fac-then${f.next.needsTier ? ' dim' : ''}`, f.next.effect));
        fx.setAttribute('aria-label', `Now: ${f.level === 0 ? 'not built' : f.effect}. Next level: ${f.next.effect}.`);
      }
      card.append(fx);
      if (f.next) {
        const short = f.next.cost - h.cash;
        if (f.next.needsTier) card.append(this.locked('p', `Needs Homefront tier ${f.next.level}`));
        else if (short > 0) card.append(this.locked('p', `Costs ${money(f.next.cost)}: need ${money(short)} more`));
        else {
          const btn = el('button', 'btn btn-secondary btn-sm', `Upgrade · ${money(f.next.cost)}`);
          btn.type = 'button';
          btn.disabled = h.inRaid;
          btn.addEventListener('click', () => void this.act('upgradeFacility', { facility: f.id }));
          card.append(btn);
        }
      } else {
        card.append(el('p', 'fac-next', 'Fully upgraded'));
      }
      return card;
    }));

    opsBox.replaceChildren(...(h.operations ?? []).map(o => {
      const row = el('div', 'ops-row');
      const map = h.maps.find(m => m.id === o.map);
      const locked = !!map && !map.unlocked;
      row.classList.toggle('locked', locked);
      const rank = el('span', 'ops-rank');
      if (locked) rank.append(this.deps.icon('i-lock'), 'Locked');
      else rank.append(segMeter(o.rank, o.maxRank, `Level ${o.rank} of ${o.maxRank}`), el('span', 'num', `${o.rank}/${o.maxRank}`));
      row.append(el('span', 'ops-name', o.name), rank);
      if (locked) {
        row.append(this.locked('span', `Unlocks at gear score ${map!.minGearScore} (you have ${h.gearScore})`, 'ops-meta'));
        return row;
      }
      const bar = el('div', 'ops-bar');
      const fill = el('span');
      fill.style.width = `${Math.round(opsProgress(o) * 100)}%`;
      bar.append(fill);
      const xp = o.next === null ? `${o.xp.toLocaleString('en-US')} XP · top level` : `${o.xp.toLocaleString('en-US')} / ${o.next.toLocaleString('en-US')} XP to level ${o.rank + 1}`;
      const perks: string[] = [];
      if (o.baseEntryFee > 0) perks.push(o.entryFee < o.baseEntryFee ? `Entry fee ${money(o.entryFee)} (was ${money(o.baseEntryFee)})` : `Entry fee ${money(o.entryFee)}`);
      else perks.push('Free entry');
      perks.push(o.bountyBonus > 0 ? `Bounty +${Math.round(o.bountyBonus * 100)}%` : 'No bounty bonus yet');
      row.append(bar, el('span', 'ops-meta', xp), el('span', 'ops-meta ops-perks', perks.join(' · ')));
      return row;
    }));
  }

  // ---------- Operators, season and Legacy ----------

  private renderOperators(h: Hideout) {
    const fresh = !!h.needsOperator && (h.legacy?.earned ?? 0) === 0;
    // A brand-new account sees only the create form; seasons and Legacy come later.
    this.q('hideoutOperators').classList.toggle('hq-body--solo', fresh);
    this.q('opSide').hidden = fresh;
    const season = h.season;
    const seasonBox = this.q('opSeason');
    seasonBox.hidden = fresh || !season;
    if (season) {
      const open = season.relocationOpen;
      const days = daysUntil(season.now, open ? season.endsAt : season.relocationOpensAt);
      const head = el('div', 'hf-head');
      const t = el('div', 'hf-title');
      t.append(el('h3', '', season.name));
      const ends = daysUntil(season.now, season.endsAt);
      head.append(t, el('span', 'season-when', `Ends ${shortDate(season.endsAt - 86400)} · ${ends} day${ends === 1 ? '' : 's'} left`));
      const what = el('p', 'hf-sub', 'Retire one operator per season for account-wide rewards.');
      const range = `${shortDate(season.relocationOpensAt)} – ${shortDate(season.endsAt - 86400)}`;
      const when = el('p', 'season-window', open
        ? `Retirement window: open now until ${shortDate(season.endsAt - 86400)} (${days} day${days === 1 ? '' : 's'} left)`
        : `Retirement window: ${range} (opens in ${days} day${days === 1 ? '' : 's'})`);
      const more = el('details', 'more');
      more.append(el('summary', '', 'How retiring works'),
        el('p', 'hf-sub', 'Seasons follow the calendar quarter. Your account can retire one operator per season, and it leaves with everything it owns. Legacy points depend on its total value (cash, items and installed Homefront investment): $5,000 earns 1, $20,000 earns 2 and $50,000 earns 3, up to 12 in total. Retiring is optional, and skipping a season costs nothing.'));
      seasonBox.replaceChildren(head, what, when, this.q('opRelocate'), more);
    }

    const ops = h.operators ?? [];
    this.q('opListHead').hidden = ops.length === 0;
    this.q('opCount').textContent = `${ops.length}/${h.maxOperators ?? 3} slots used`;
    this.q('opList').replaceChildren(...ops.map(o => {
      const row = el('div', `op-row${o.active ? ' active' : ''}`);
      const avatar = el('span', `op-avatar${o.raidable ? ' raid' : ''}`, (o.name.trim()[0] ?? '?').toUpperCase());
      const info = el('div', 'op-info');
      const name = el('div', 'op-row-name', o.name);
      name.append(el('span', `tag ${o.raidable ? 'tag--raid' : 'tag--safe'}`, o.raidable ? 'Raidable' : 'Safe'));
      if (o.active) name.append(el('span', 'tag tag--you', 'Active'));
      if (o.inRaid) name.append(el('span', 'tag tag--raid', 'In raid'));
      const readouts = el('div', 'readouts');
      const readout = (label: string, value: string, cls = '') => {
        const r = el('span', `readout ${cls}`);
        r.append(el('span', 'readout-label', label), el('span', 'readout-value', value));
        return r;
      };
      readouts.append(readout('Tier', String(o.tier)), readout('Gear', String(o.gearScore), 'you'), readout('Cash', money(o.cash), 'money'));
      info.append(name, readouts);
      row.append(avatar, info);
      if (!o.active) {
        const btn = el('button', 'btn btn-secondary btn-sm', h.inRaid ? 'In a raid' : 'Switch to');
        btn.type = 'button';
        btn.disabled = h.inRaid;
        btn.addEventListener('click', () => void this.act('switchOperator', { operatorId: o.id }));
        row.append(btn);
      }
      if (o.active && !o.raidable && h.pvpEnabled !== false && !o.inRaid && !h.inRaid) {
        const promo = confirmButton('btn btn-secondary btn-sm', 'Opt into Raidable', `Confirm: ${o.name} becomes Raidable permanently (+15% Workshop, Tier 4, base raids)`,
          () => void this.act('promoteRaidable', { confirm: true }));
        promo.title = 'Permanently promote this Safe operator to Raidable.';
        row.append(promo);
      }
      if (!o.inRaid && !h.inRaid) {
        const del = confirmButton('link link--muted op-delete', 'Delete', `Click again: ${o.name} and everything they own is gone for good`,
          () => void this.act('deleteOperator', { operatorId: o.id, confirm: true }));
        del.title = `Delete ${o.name} to free the slot. Nothing is kept and no Legacy is earned.`;
        row.append(del);
      }
      return row;
    }));

    // The create form leads for a new account and follows the list otherwise.
    const create = this.q('opCreate');
    const list = this.q('opList');
    if (fresh) list.before(create); else list.after(create);
    this.renderCreate(h, ops.length);
    this.renderLegacy(h);
    this.renderRelocate(h);
  }

  private renderCreate(h: Hideout, count: number) {
    const box = this.q('opCreate');
    box.classList.toggle('hf-card', !!h.needsOperator || this.creating);
    if (count >= (h.maxOperators ?? 3)) {
      box.replaceChildren(el('p', 'hf-sub', `You have ${count} operators, the most an account can hold. Retire one at the end of a season, or delete one, to make room.`));
      return;
    }
    if (!h.needsOperator && !this.creating) {
      const left = (h.maxOperators ?? 3) - count;
      const open = el('button', 'btn btn-secondary btn-sm', `+ New operator (${left} slot${left === 1 ? '' : 's'} left)`);
      open.type = 'button';
      open.addEventListener('click', () => { this.creating = true; this.renderCreate(h, count); });
      box.replaceChildren(open);
      return;
    }
    const head = el('div', 'hf-head');
    const t = el('div', 'hf-title');
    t.append(el('h3', '', h.needsOperator ? 'Create your operator' : 'New operator'));
    head.append(t);
    if (!h.needsOperator) {
      const cancel = el('button', 'link link--muted', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => { this.creating = false; this.renderCreate(h, count); });
      head.append(cancel);
    }
    const intro = el('p', 'hf-sub', h.needsOperator
      ? 'The character you raid with. Name them and pick a side.'
      : 'Each operator has its own stash, cash and Homefront. Perks and Legacy are shared by your account.');
    const nameLabel = el('label', 'field');
    const name = el('input');
    name.type = 'text';
    name.maxLength = 16;
    name.placeholder = `Operator ${count + 1}`;
    name.value = this.newName;
    name.addEventListener('input', () => { this.newName = name.value; });
    nameLabel.append(el('span', 'label', 'Name (optional)'), name);
    // Until PvP ships, every new operator is Safe and Raidable is shown as coming soon.
    const pvp = h.pvpEnabled !== false;
    if (!pvp) this.newRaidable = false;
    const warn = el('p', 'warn-line', pvp
      ? '⚠ Safe or Raidable is permanent for this operator. You can create more operators later.'
      : '⚠ Raidable operators and base raids are switched off on this server. Every operator is Safe.');
    const grid = el('div', 'choice-grid');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', 'Safe or Raidable');
    const top = h.homefront?.topTier ?? 4;
    const safeTier = h.homefront?.safeTier ?? 3;
    const choice = (raidable: boolean, title: string, line: string, stats: [string, string, 'good' | 'bad' | 'neutral'][], note?: string) => {
      const picked = this.newRaidable === raidable;
      const soon = raidable && !pvp;
      const b = el('button', `choice choice--faction ${raidable ? 'raid' : 'safe'}${soon ? ' soon' : ''}`);
      b.type = 'button';
      b.disabled = soon;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(picked));
      const emblem = el('span', `choice-emblem ${raidable ? 'raid' : 'safe'}`);
      emblem.append(this.deps.icon(raidable ? 'i-crosshair' : 'i-shield-check'));
      const tl = el('span', 'choice-title', title);
      const tags = el('span', 'choice-tags');
      if (note) tags.append(el('span', 'tag tag--safe', note));
      if (soon) tags.append(el('span', 'tag', 'Coming soon'));
      if (picked) tags.append(el('span', 'tag tag--you', 'Selected'));
      const list = el('div', 'choice-stats');
      for (const [label, value, tone] of stats) {
        const row = el('div', 'choice-stat');
        row.append(el('span', 'choice-stat-label', label), el('span', `choice-stat-value ${tone}`, value));
        list.append(row);
      }
      b.append(emblem, tl, tags, el('p', 'choice-line', line), list);
      b.addEventListener('click', () => { this.newRaidable = raidable; this.renderCreate(h, count); });
      return b;
    };
    grid.append(
      choice(false, 'Safe', 'Zombies only. Your base can never be raided; you can opt into Raidable later when ready.',
        [['Base raids', 'Immune', 'good'], ['Base max', `Tier ${safeTier}`, 'neutral'], ['Workshop', 'Standard', 'neutral']], pvp ? 'Recommended' : undefined),
      choice(true, 'Raidable', 'Strike rival bases for cash. Only cash (max 20%) is at risk; gear, stash and pieces stay safe.',
        [['Base raids', 'Active', 'bad'], ['Base max', `Tier ${top}`, 'good'], ['Workshop', '+15% rate', 'good']]),
    );
    const create = el('button', 'btn btn-primary', this.newRaidable === null ? 'Choose Safe or Raidable' : `Create ${this.newRaidable ? 'Raidable' : 'Safe'} operator`);
    create.type = 'button';
    create.disabled = this.newRaidable === null;
    create.addEventListener('click', () => void this.act('createOperator', { name: this.newName, raidable: this.newRaidable }));
    box.replaceChildren(head, intro, nameLabel, warn, grid, create);
  }

  private renderLegacy(h: Hideout) {
    const lg = h.legacy;
    const box = this.q('opLegacy');
    if (!lg) { box.replaceChildren(); return; }
    const head = el('div', 'pane-head');
    head.append(el('span', 'label', 'Legacy perks'));
    const parts: HTMLElement[] = [head, el('p', 'hf-sub', 'Shared by every operator. Earn points by retiring operators.')];
    const pts = el('div', 'legacy-points');
    pts.append(el('b', 'num', String(lg.available)), el('span', 'hf-sub', `Legacy point${lg.available === 1 ? '' : 's'} to spend`));
    parts.push(pts);
    parts.push(el('p', 'legacy-totals', `${lg.earned} earned · ${lg.earned - lg.available} spent · ${lg.available} left (you can earn up to ${lg.cap})`));
    if (lg.stashBonus) parts.push(el('p', 'legacy-totals', `Retirement stash bonus: +${lg.stashBonus} slots (max +${lg.stashBonusCap})`));
    if (lg.boostLevel) parts.push(el('p', 'hf-sub', `Season boost level ${lg.boostLevel}: +${lg.boostLevel * 5}% bounty and +${lg.boostLevel * 10}% Operations XP`));
    for (const p of lg.perks) {
      const row = el('div', 'perk-row');
      const tile = el('span', 'icon-tile icon-tile--money');
      tile.append(this.deps.icon(PERK_ICON[p.id] ?? 'i-star'));
      const name = el('span', 'perk-name', p.name);
      row.append(tile, name);
      if (lg.available > 0 && p.rank < p.maxRank) {
        const btn = el('button', 'btn btn-secondary btn-sm', '+1 · 1 pt');
        btn.title = `Spend 1 point on ${p.name}`;
        btn.type = 'button';
        btn.addEventListener('click', () => void this.act('buyPerk', { perk: p.id }));
        row.append(btn);
      } else if (p.rank >= p.maxRank) {
        row.append(el('span', 'perk-max', 'Maxed'));
      }
      const meta = el('span', 'op-row-meta perk-meta');
      meta.append(segMeter(p.rank, p.maxRank, `Level ${p.rank} of ${p.maxRank}`, p.maxRank, 'money'), el('span', 'perk-rank num', `${p.rank}/${p.maxRank}`), `${p.perRank} per level`);
      row.append(meta);
      parts.push(row);
    }
    if (lg.earned > lg.available) {
      const reset = confirmButton('btn btn-secondary btn-sm', `Reset perks · ${money(lg.respecCost ?? 1000)}`, 'Confirm: refund all allocated points', () => void this.act('respec', { confirm: true }));
      reset.disabled = h.inRaid || h.cash < (lg.respecCost ?? 1000);
      parts.push(reset, el('p', 'hf-sub', 'Refunds every allocated point. All operators must be home and fit their stash without Packrat.'));
    }
    if (lg.badges.length) {
      const badges = el('div', 'badge-list');
      for (const b of lg.badges) {
        const tag = el('span', 'tag tag--you', `${b.season} · ${b.operator}`);
        tag.title = `${b.operator} retired in ${b.season}, worth ${money(b.value)}`;
        badges.append(tag);
      }
      parts.push(el('span', 'label', 'Season badges'), el('p', 'hf-sub', 'One for each operator you retired.'), badges);
    }
    box.replaceChildren(...parts);
  }

  private renderRelocate(h: Hideout) {
    const box = this.q('opRelocate');
    const r = h.relocation;
    if (!r || h.needsOperator) { box.replaceChildren(); return; }
    const parts: HTMLElement[] = [];
    if (r.reward) {
      const w = r.reward;
      const investment = h.investmentValue ?? 0;
      const items = Math.max(0, w.value - h.cash - investment);
      parts.push(el('p', 'hf-sub', `Retiring ${h.name} is permanent. You lose ${money(w.value)} (${money(h.cash)} cash + ${money(items)} in items + ${money(investment)} invested). Your account gets:`));
      const list = el('ul', 'reward-lines');
      const lines = [
        w.legacyPoints ? `${w.legacyPoints} Legacy point${w.legacyPoints === 1 ? '' : 's'} to spend on perks` : 'No Legacy points (worth under $5,000)',
        w.stashSlots ? `${w.stashSlots} stash slots on every operator` : '',
        `Next season: ${w.boostLevel * 5}% more bounty and ${w.boostLevel * 10}% more Operations XP`,
        `A ${h.season?.id ?? 'season'} badge with ${h.name}'s name`,
      ].filter(Boolean);
      for (const line of lines) list.append(el('li', '', line));
      parts.push(list);
    }
    if (r.blocker) {
      const window = h.season && !h.season.relocationOpen && /four weeks/.test(r.blocker);
      const label = window ? `Retire ${h.name} (window not open yet)` : r.blocker.replace(/\.$/, '');
      const btn = el('button', 'btn btn-secondary btn-block', label);
      btn.type = 'button';
      btn.disabled = true;
      parts.push(btn);
    } else {
      parts.push(confirmButton('btn btn-primary btn-block', `Retire ${h.name}`, `Click again: ${h.name} is gone for good`, () => void this.act('relocate', { confirm: true })));
    }
    box.replaceChildren(...parts);
  }

  /** Gear score as progress toward the next map. */
  private renderGearMeter(h: Hideout) {
    this.q('hideoutGs').textContent = String(h.gearScore);
    const next = h.maps.find(m => m.minGearScore > h.gearScore);
    const prev = bestMapFor(h.maps, h.gearScore);
    const from = prev?.minGearScore ?? 0;
    const fill = this.q('gsFill');
    const sub = this.q('hideoutSub');
    if (h.inRaid) {
      sub.textContent = 'Deployed: gear locked';
      fill.style.width = '100%';
    } else if (next) {
      sub.textContent = `reach ${next.minGearScore} to unlock ${next.name}`;
      const pct = (gs: number) => Math.max(4, Math.min(100, ((gs - from) / Math.max(1, next.minGearScore - from)) * 100));
      fill.style.width = `${pct(h.gearScore)}%`;
      const potential = gearScore(this.bestOwned(h));
      const ghost = this.q('gsGhost');
      ghost.style.width = potential > h.gearScore ? `${pct(potential)}%` : '0';
      ghost.title = potential > h.gearScore ? `Equip best → ${potential}` : '';
    } else {
      sub.textContent = 'Every map open';
      fill.style.width = '100%';
    }
    this.q('gsMeter').title = `Gear score is the average power of your 4 loadout slots.${next ? ` ${next.name} opens at ${next.minGearScore}.` : ''}`;
  }

  private icon(item: Pick<Item, 'kind' | 'rarity'>, size = '') {
    const tile = el('span', `rar-icon${size ? ' ' + size : ''}${item.kind === 'encrypted' ? ' sealed' : ''}`);
    tile.style.setProperty('--rarity', RARITY_COLOR[item.rarity]);
    tile.append(this.deps.icon(KIND_ICON[item.kind]));
    return tile;
  }

  private rarityChip(item: Pick<Item, 'rarity' | 'kind'>) {
    if (item.kind === 'encrypted') {
      const chip = el('span', 'rar-chip sealed-chip');
      const dot = el('span', 'rar-dot');
      dot.style.background = RARITY_COLOR[item.rarity];
      chip.append(dot, `Sealed · ${RARITY_LABEL[item.rarity]}`);
      return chip;
    }
    const chip = el('span', 'rar-chip', RARITY_LABEL[item.rarity]);
    chip.style.setProperty('--rarity', RARITY_COLOR[item.rarity]);
    return chip;
  }

  /** The strongest loadout you could equip from what you already own. */
  private bestOwned(h: Hideout): Partial<Record<Slot, Item | null>> {
    const owned = [...SLOTS.map(s => h.loadout[s]).filter((i): i is Item => !!i), ...h.stash];
    const top = (pred: (i: Item) => boolean) => owned.filter(pred).sort((a, b) => b.power - a.power);
    const guns = top(i => isWeapon(i.kind));
    return { primary: guns[0] ?? null, secondary: guns[1] ?? null, armor: top(i => i.kind === 'armor')[0] ?? null, pack: top(i => i.kind === 'pack')[0] ?? null };
  }

  /** Equip the strongest gear you own, one slot at a time. */
  async equipBest() {
    const h = this.state;
    if (!h) return;
    const best = this.bestOwned(h);
    for (const s of SLOTS) {
      const want = best[s];
      const cur = this.state?.loadout[s];
      if (want && want.id !== cur?.id) await this.act('equip', { itemId: want.id, slot: s });
    }
    this.note(`Equipped your best gear: gear score ${this.state?.gearScore ?? ''}.`);
  }

  /** Where the selected stash item would go: its best slot. */
  private targetSlot(h: Hideout): Slot | null {
    const sel = this.selectedId ? this.findItem(this.selectedId) : null;
    if (!sel || sel.slot) return null;
    return upgradeDelta(h.loadout, sel.item)?.slot ?? null;
  }

  private renderSlots(h: Hideout) {
    const powers = SLOTS.map(s => h.loadout[s]?.power ?? 0);
    const exact = powers.reduce((a, b) => a + b, 0) / 4;
    this.q('gsMath').textContent = `Gear score = (${powers.join(' + ')}) ÷ 4 = ${Number.isInteger(exact) ? exact : `${exact} → ${h.gearScore}`}`;
    this.q('gsMath').title = 'The average power of your 4 slots, rounded down. An empty slot counts as 0.';
    const wrap = this.q('loadoutSlots');
    wrap.replaceChildren();
    const sel = this.selectedId ? this.findItem(this.selectedId) : null;
    const fits = sel && !sel.slot ? slotsFor(sel.item.kind) : [];
    const target = this.targetSlot(h);
    for (const slot of SLOTS) {
      const item = h.loadout[slot];
      const card = el('button', 'slot-card' + (item ? '' : ' empty') + (sel?.item.id === item?.id && item ? ' selected' : '')
        + (fits.includes(slot) ? ' fits' : '') + (target === slot ? ' target' : ''));
      card.type = 'button';
      card.append(el('span', 'slot-label', SLOT_LABEL[slot]));
      if (item) {
        card.style.setProperty('--rarity', RARITY_COLOR[item.rarity]);
        const body = el('span', 'slot-body');
        body.append(el('span', 'slot-name', item.name));
        const meta = el('span', 'slot-meta');
        meta.append(this.rarityChip(item), el('span', '', keyStat(item)?.text ?? ''));
        body.append(meta);
        const power = el('span', 'power-num');
        power.append(el('b', '', String(item.power)), el('small', '', 'PWR'));
        card.append(this.icon(item, 'lg'), body, power);
        card.addEventListener('click', () => this.select(item.id));
      } else {
        const noGuns = !h.loadout.primary && !h.loadout.secondary;
        card.append(el('span', 'slot-empty-text', slot === 'primary' && noGuns ? 'Empty · you get a loaner pistol' : fits.includes(slot) ? `Empty · ${touch() ? 'tap' : 'click'} to equip here` : 'Empty'));
        card.disabled = !fits.includes(slot);
        if (sel && fits.includes(slot)) card.addEventListener('click', () => this.equip(sel.item, slot));
      }
      wrap.append(card);
    }
  }

  /** Compare panel: what the selected item does, against what it would replace. */
  private renderCompare(h: Hideout) {
    const box = this.q('itemDetail');
    box.replaceChildren();
    box.classList.remove('dimmed');
    if (this.checked.size > 0 && window.matchMedia('(max-width: 720px)').matches) {
      box.classList.add('empty');
      return;
    }
    if (this.checked.size > 0) {
      const picked = h.stash.filter(i => this.checked.has(i.id));
      box.classList.remove('empty');
      box.style.setProperty('--rarity', 'var(--money)');
      const head = el('div', 'compare-titles');
      head.append(el('span', 'compare-name', `Selling ${picked.length} item${picked.length === 1 ? '' : 's'}`), el('span', 'compare-sub', `${money(picked.reduce((s, i) => s + i.value, 0))} total`));
      const rows = el('div', 'compare-rows');
      for (const i of picked.slice(0, 8)) {
        const r = el('div', 'cmp-row');
        r.append(el('span', 'cmp-label', i.name), el('span', 'cmp-val', money(i.value)));
        rows.append(r);
      }
      if (picked.length > 8) rows.append(el('div', 'cmp-row cmp-vs', `and ${picked.length - 8} more`));
      const sealedPicked = picked.filter(isEncrypted);
      const extra: HTMLElement[] = [];
      if (sealedPicked.length) {
        const loss = sealedPicked.reduce((s, i) => s + estimatedValue(i) - i.value, 0);
        const drop = el('button', 'btn btn-sealed btn-sm', `Unselect sealed (selling forfeits ~${money(loss)})`);
        drop.type = 'button';
        drop.addEventListener('click', () => { sealedPicked.forEach(i => this.checked.delete(i.id)); this.render(); });
        extra.push(drop);
      }
      const cost = picked.map(i => this.sellCost(h, i)).find(Boolean);
      extra.push(el('p', 'compare-note', cost ? `Careful: includes your best gear. Your best gear score drops from ${cost.from}.` : "Won't lower your gear score."));
      box.append(head, rows, ...extra);
      return;
    }
    const found = this.selectedId ? this.findItem(this.selectedId) : null;
    if (!found) {
      box.classList.add('empty');
      box.append(el('p', 'compare-empty', 'Select an item to compare it with your loadout.'));
      return;
    }
    box.classList.remove('empty');
    const { item, slot } = found;
    box.style.setProperty('--rarity', RARITY_COLOR[item.rarity]);
    const head = el('div', 'compare-head');
    const titles = el('div', 'compare-titles');
    titles.append(el('span', 'compare-name', item.name));
    const sub = el('span', 'compare-sub');
    sub.append(this.rarityChip(item), el('span', '', isEncrypted(item) ? 'Encrypted · contents unknown' : `${KIND_LABEL[item.kind]}${slot ? ` · equipped as ${SLOT_LABEL[slot].toLowerCase()}` : ''}`));
    titles.append(sub);
    const close = el('button', 'icon-btn compare-close');
    close.type = 'button';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.append(this.deps.icon('i-close'));
    close.addEventListener('click', () => this.select(null));
    head.append(this.icon(item, 'lg'), titles, close);
    box.append(head);

    const rows = el('div', 'compare-rows');
    const row = (label: string, from: string | null, to: string, dir: number) => {
      const r = el('div', 'cmp-row');
      r.append(el('span', 'cmp-label', label));
      const v = el('span', 'cmp-val');
      if (from !== null && from !== to) v.append(el('span', 'cmp-from', from), el('span', 'cmp-arrow', '→'));
      v.append(el('span', 'cmp-to' + (dir > 0 ? ' up' : dir < 0 ? ' down' : ''), to));
      r.append(v);
      rows.append(r);
    };
    const actions = el('div', 'compare-actions');
    actions.append(this.protectButton(h, item));
    const extras: HTMLElement[] = [];

    if (isEncrypted(item)) {
      row('Decrypt time', null, `${DECRYPT_SECS[item.rarity]}s at an uplink`, 0);
      row('Rarity upgrade', null, item.originTier ? `20% chance at tier ${item.originTier}+; none below` : '20% at any uplink (legacy item)', 0);
      row('Worth opened', null, `~${money(estimatedValue(item))}`, 1);
      row('Worth sealed', null, `${money(item.value)} scrap`, 0);
      box.append(rows, el('p', 'compare-note', 'Opens into gear (60%) or a valuable of this rarity and power, sometimes a grade better. Pack it to take it on your next raid; it is lost if you die.'));
      const packed = this.carried(item);
      const full = !packed && h.carry.length >= h.carryCapacity;
      const pack = el('button', 'btn btn-primary btn-sm', packed ? 'Unpack' : `Pack for next raid (${h.carry.length}/${h.carryCapacity})`);
      pack.type = 'button';
      pack.disabled = h.inRaid || full;
      pack.title = full ? `Your pack fits ${h.carryCapacity}. Equip a bigger pack or unpack something.` : '';
      pack.addEventListener('click', () => this.setCarry(item, !packed));
      actions.append(pack);
    } else if (slot) {
      const stat = keyStat(item);
      row('Power', null, String(item.power), 0);
      if (stat) row(stat.label, null, stat.text.split(' · ')[0], 0);
      row('Sells for', null, money(item.value), 0);
      const un = el('button', 'btn btn-secondary btn-sm', 'Unequip');
      un.type = 'button';
      un.disabled = h.inRaid || h.stash.length >= h.stashCapacity;
      un.title = h.inRaid ? 'Gear is locked while you are deployed' : h.stash.length >= h.stashCapacity ? 'Your stash is full' : `Gear score ${h.gearScore} → ${gearScoreWith(h.loadout, slot, null)}`;
      un.addEventListener('click', () => this.unequip(slot));
      actions.append(un);
    } else if (slotsFor(item.kind).length) {
      const best = upgradeDelta(h.loadout, item)!;
      const current = h.loadout[best.slot] ?? null;
      const stat = keyStat(item)!;
      const curStat = current ? keyStat(current) : null;
      row(`vs ${current ? current.name : `empty ${SLOT_LABEL[best.slot].toLowerCase()}`}`, null, '', 0);
      rows.lastElementChild!.classList.add('cmp-vs');
      row('Power', current ? String(current.power) : '—', String(item.power), Math.sign(item.power - (current?.power ?? 0)));
      const short = (t: string) => t.split(' · ')[0].replace(/ (DPS|damage|max health|loot slots)$/, '');
      row(stat.label, curStat ? short(curStat.text) : '—', short(stat.text), Math.sign(stat.value - (curStat?.value ?? 0)));
      row('Gear score', String(h.gearScore), String(h.gearScore + best.delta), Math.sign(best.delta));
      row('Sells for', null, money(item.value), 0);
      if (isWeapon(item.kind)) box.dataset.note = '1';
      const primaryBtn = el('button', 'btn btn-sm btn-upgrade-solid',
        `${h.loadout[best.slot] ? 'Swap into' : 'Equip as'} ${SLOT_LABEL[best.slot].toLowerCase()}${best.delta ? ` (${best.delta > 0 ? '+' : ''}${best.delta})` : ''}`);
      primaryBtn.type = 'button';
      primaryBtn.disabled = h.inRaid;
      primaryBtn.title = h.loadout[best.slot] ? `${h.loadout[best.slot]!.name} goes back to your stash` : '';
      primaryBtn.addEventListener('click', () => this.equip(item, best.slot));
      actions.append(primaryBtn);
      // The other gun slot is a worse choice; offer it quietly (you may want it on key 1).
      for (const s of slotsFor(item.kind).filter(s => s !== best.slot)) {
        const cur = h.loadout[s];
        const alt = el('button', 'link compare-alt', `Put in ${SLOT_LABEL[s].toLowerCase()} instead${cur ? ` (replaces ${cur.name})` : ''}`);
        alt.type = 'button';
        alt.disabled = h.inRaid;
        alt.addEventListener('click', () => this.equip(item, s));
        extras.push(alt);
      }
    } else {
      row('Sells for', null, money(item.value), 0);
      box.append(rows, el('p', 'compare-note', 'Valuables fund Homefront upgrades or sell for cash. Protect any you want to reserve; unprotect them when ready to spend them on a tier upgrade.'));
    }
    if (!box.contains(rows)) box.append(rows);
    const cost = this.sellCost(h, item);
    const sell = confirmButton('btn btn-money btn-sm', `Sell ${money(item.value)}`,
      cost ? `Best gear score ${cost.from} → ${cost.to}. Sell?` : slot ? 'Sell equipped? Click again' : 'Click again to sell', () => this.sell(item));
    sell.disabled = h.inRaid || !!item.protected;
    actions.append(sell);
    delete box.dataset.note;
    box.append(actions, ...extras);
  }

  private renderStashStats(h: Hideout) {
    const box = this.q('stashStats');
    box.replaceChildren();
    const used = h.stash.length;
    const cap = el('div', 'stat-inline');
    cap.append(el('span', 'field-label', 'Stash'), el('b', 'num', `${used}/${h.stashCapacity}`));
    const bar = el('span', 'cap-bar' + (used >= h.stashCapacity ? ' full' : used >= h.stashCapacity * 0.8 ? ' warn' : ''));
    const fill = el('span');
    fill.style.width = `${Math.min(100, (used / h.stashCapacity) * 100)}%`;
    bar.append(fill);
    cap.append(bar);

    const value = el('div', 'stat-inline');
    value.append(el('span', 'field-label', 'Worth'), el('b', 'stat-money num', money(h.stash.reduce((s, i) => s + i.value, 0))));

    const sealed = h.stash.filter(isEncrypted).length;
    const pack = el('div', 'stat-inline stat-pack');
    pack.title = `Sealed items you pack start your next raid in your pack (it fits ${h.carryCapacity}), ready to decrypt at an uplink.`;
    pack.append(el('span', 'field-label', `Raid pack ${h.carry.length}/${h.carryCapacity}`));
    const pips = el('span', 'pips');
    const packed = h.stash.filter(i => h.carry.includes(i.id));
    for (let i = 0; i < h.carryCapacity; i++) {
      const pip = el('span', 'pip' + (packed[i] ? ' on' : ''));
      if (packed[i]) { pip.style.background = RARITY_COLOR[packed[i].rarity]; pip.title = packed[i].name; }
      pips.append(pip);
    }
    pack.append(pips);
    if (sealed > h.carry.length && h.carry.length < h.carryCapacity && this.filter !== 'encrypted') {
      const go = el('button', 'btn btn-sealed btn-xs', `+ Add sealed (${sealed - h.carry.length})`);
      go.title = 'Show your sealed items so you can pack them for the next raid';
      go.type = 'button';
      go.addEventListener('click', () => { this.filter = 'encrypted'; this.render(); });
      pack.append(go);
    }
    box.append(cap, value, pack);

    // Better gear sitting in the stash? Offer to equip it.
    const best = this.bestOwned(h);
    const potential = gearScore(best);
    if (potential > h.gearScore && !h.inRaid) {
      const inline = el('button', 'btn btn-upgrade btn-xs eb-inline', `Equip best (+${potential - h.gearScore})`);
      inline.type = 'button';
      inline.addEventListener('click', () => void this.equipBest());
      box.append(inline);
    }
    const banner = this.q('equipBestBanner');
    banner.replaceChildren();
    banner.hidden = h.inRaid || potential <= h.gearScore;
    if (!banner.hidden) {
      const unlock = h.maps.filter(m => m.minGearScore > h.gearScore && m.minGearScore <= potential).pop();
      banner.append(el('span', 'eb-text', `Gear in your stash raises your gear score from ${h.gearScore} to ${potential}${unlock ? ` and unlocks ${unlock.name}` : ''}.`));
      const btn = el('button', 'btn btn-upgrade btn-sm', `Equip best (+${potential - h.gearScore})`);
      btn.type = 'button';
      btn.addEventListener('click', () => void this.equipBest());
      banner.append(btn);
    }
  }

  private renderStash(h: Hideout) {
    // Filter chips (counts over the stash).
    const filters = this.q('invFilters');
    filters.replaceChildren();
    const sel = document.getElementById('invFilterSelect') as HTMLSelectElement | null;
    if (sel) {
      sel.replaceChildren(...GROUPS.map(g => {
        const count = g.id === 'all' ? h.stash.length : h.stash.filter(i => itemGroup(i.kind) === g.id).length;
        const o = el('option', '', `${g.label} (${count})`);
        o.value = g.id;
        o.disabled = count === 0 && g.id !== 'all';
        return o;
      }));
      sel.value = this.filter;
      sel.onchange = () => { this.filter = sel.value as ItemGroup; this.render(); };
    }
    for (const g of GROUPS) {
      const count = g.id === 'all' ? h.stash.length : h.stash.filter(i => itemGroup(i.kind) === g.id).length;
      const btn = el('button', 'chip');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(this.filter === g.id));
      btn.append(g.label, el('span', 'chip-count', String(count)));
      btn.disabled = count === 0 && g.id !== 'all';
      btn.addEventListener('click', () => { this.filter = g.id; this.render(); });
      filters.append(btn);
    }

    const shown = h.stash.filter(i => this.filter === 'all' || itemGroup(i.kind) === this.filter);
    const worth = (i: Item) => (isEncrypted(i) ? estimatedValue(i) : i.value);
    const gain = (i: Item) => upgradeDelta(h.loadout, i)?.delta ?? -99;
    shown.sort((a, b) => {
      switch (this.sort) {
        case 'power': return b.power - a.power;
        case 'rarity': return RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity] || worth(b) - worth(a);
        case 'name': return a.name.localeCompare(b.name);
        default: {
          // Upgrades first, then (while carry slots are free) sealed items to pack, then by value.
          const rank = (i: Item) => (gain(i) > 0 ? 2 : isEncrypted(i) && h.carry.length < h.carryCapacity && !this.carried(i) ? 1 : 0);
          return rank(b) - rank(a) || Math.max(0, gain(b)) - Math.max(0, gain(a)) || worth(b) - worth(a);
        }
      }
    });

    // The single best stash item for each slot gets a filled Equip; the rest stay quiet.
    const bestSet = this.bestOwned(h);
    this.topPick = new Set(SLOTS.map(s => bestSet[s]).filter((i): i is Item => !!i && h.stash.some(x => x.id === i.id)).map(i => i.id));
    const list = this.q('stashGrid');
    list.replaceChildren();
    if (h.stash.length === 0) list.append(el('p', 'list-empty', 'Your stash is empty. Extract with loot, or buy gear from the trader.'));
    else if (shown.length === 0) list.append(el('p', 'list-empty', 'Nothing of this kind.'));
    for (const item of shown) list.append(this.stashRow(h, item));
    this.q('invCount').textContent = `Item · ${shown.length}`;
    const all = document.getElementById('invSelectAll') as HTMLInputElement | null;
    if (all) {
      all.checked = shown.length > 0 && shown.every(i => this.checked.has(i.id));
      all.indeterminate = !all.checked && shown.some(i => this.checked.has(i.id));
      all.disabled = h.inRaid || shown.length === 0;
      all.onchange = () => {
        if (all.checked) shown.filter(i => !i.protected).forEach(i => this.checked.add(i.id)); else shown.forEach(i => this.checked.delete(i.id));
        this.render();
      };
    }

    // Sticky multi-select bar.
    const ids = [...this.checked];
    const total = h.stash.filter(i => this.checked.has(i.id)).reduce((s, i) => s + i.value, 0);
    this.q('invBulk').classList.toggle('open', ids.length > 0);
    this.q('menuHideout').classList.toggle('selling', ids.length > 0 && this.tab === 'stash');
    list.classList.toggle('with-bar', ids.length > 0);
    const sealedSel = h.stash.filter(i => this.checked.has(i.id) && isEncrypted(i));
    const selText = this.q('invSelected');
    selText.replaceChildren(`${ids.length} selected · ${money(total)}`);
    if (sealedSel.length) {
      const loss = sealedSel.reduce((s, i) => s + estimatedValue(i) - i.value, 0);
      const warn = el('button', 'sell-warn', `⚠ Selling sealed forfeits ~${money(loss)} · Unselect sealed`);
      warn.type = 'button';
      warn.title = `You'd get about ${money(loss)} less than decrypting ${sealedSel.length === 1 ? 'it' : 'them'} first. Click to take ${sealedSel.length === 1 ? 'it' : 'them'} out of the sale.`;
      warn.addEventListener('click', () => { sealedSel.forEach(i => this.checked.delete(i.id)); this.render(); });
      selText.append(warn);
    }
    const sell = this.q('invSellSelected') as HTMLButtonElement;
    sell.disabled = ids.length === 0 || h.inRaid;
    if (!sell.classList.contains('armed')) sell.textContent = `Sell for ${money(total)}`;
    (this.q('invSelectValuables') as HTMLButtonElement).disabled = h.inRaid || !h.stash.some(i => i.kind === 'valuable');
  }

  private stashRow(h: Hideout, item: Item): HTMLElement {
    const row = el('div', 'stash-row' + (this.selectedId === item.id ? ' selected' : '') + (this.checked.has(item.id) ? ' checked' : '') + (isEncrypted(item) ? ' is-sealed' : ''));
    row.setAttribute('role', 'listitem');
    row.tabIndex = 0;
    row.style.setProperty('--rarity', RARITY_COLOR[item.rarity]);
    row.addEventListener('click', (e) => {
      if (e.shiftKey) { this.toggleCheck(item.id); return; }
      this.select(item.id);
    });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === row) this.select(item.id); });
    const best = upgradeDelta(h.loadout, item);
    row.addEventListener('dblclick', () => { if (best && !h.inRaid) this.equip(item, best.slot); });

    const box = el('input', 'row-check');
    box.type = 'checkbox';
    box.checked = this.checked.has(item.id);
    box.disabled = h.inRaid || !!item.protected;
    box.setAttribute('aria-label', `Select ${item.name} to sell`);
    box.addEventListener('click', e => e.stopPropagation());
    box.addEventListener('change', () => this.toggleCheck(item.id));

    const body = el('span', 'row-body');
    const name = el('span', 'row-name', item.name);
    const meta = el('span', 'row-meta');
    meta.append(this.rarityChip(item));
    if (isEncrypted(item)) {
      meta.append(el('span', 'hide-sm', `${DECRYPT_SECS[item.rarity]}s to decrypt`), el('span', 'value-open', `~${money(estimatedValue(item))} decrypted`));
      if (this.carried(item)) meta.append(el('span', 'tag tag-packed', 'Packed'));
    } else {
      if (slotsFor(item.kind).length) meta.append(el('span', 'inline-pwr', `${item.power} PWR`));
      meta.append(el('span', 'hide-sm', keyStat(item)?.text.split(' · ')[0] ?? 'Sell at the trader'));
    }
    body.append(name, meta);

    const power = el('span', 'power-num');
    if (slotsFor(item.kind).length) power.append(el('b', '', String(item.power)), el('small', '', 'PWR'));
    else { power.append(el('b', 'no-power', '—')); power.title = "Can't be equipped: doesn't count toward gear score"; }

    const value = el('span', 'row-value num', money(item.value));
    if (isEncrypted(item)) value.title = `Scrap value while sealed. Roughly ${money(estimatedValue(item))} once decrypted.`;

    const action = el('span', 'row-action');
    action.style.flexWrap = 'wrap';
    action.append(this.protectButton(h, item));
    if (best) {
      const btn = el('button', 'btn btn-sm ' + (this.topPick.has(item.id) ? 'btn-upgrade-solid' : best.delta > 0 ? 'btn-upgrade' : 'btn-secondary'));
      if (best.delta > 0) btn.append('Equip · GS', ` +${best.delta}`);
      else btn.append('Equip');
      btn.type = 'button';
      btn.disabled = h.inRaid;
      btn.title = `Equip as ${SLOT_LABEL[best.slot].toLowerCase()} (gear score ${h.gearScore} → ${h.gearScore + best.delta})`;
      if (this.topPick.has(item.id)) btn.title = `Part of Equip best. ${btn.title}`;
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.equip(item, best.slot); });
      action.append(btn);
    } else if (isEncrypted(item)) {
      const packed = this.carried(item);
      const full = !packed && h.carry.length >= h.carryCapacity;
      const btn = el('button', 'btn btn-sm ' + (packed ? 'btn-sealed on' : 'btn-sealed'), packed ? 'Packed ✓' : 'Pack');
      btn.type = 'button';
      btn.disabled = h.inRaid || full;
      btn.title = full ? `Your pack fits ${h.carryCapacity}` : packed ? 'Click to leave it in the stash' : 'Take it on your next raid to decrypt at an uplink';
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.setCarry(item, !packed); });
      action.append(btn);
    } else {
      const btn = confirmButton('btn btn-sm btn-money', 'Sell', 'Sure?', () => this.sell(item));
      btn.disabled = h.inRaid || !!item.protected;
      action.append(btn);
    }
    row.append(box, this.icon(item), body, power, value, action);
    return row;
  }

  private protectButton(h: Hideout, item: Item): HTMLButtonElement {
    const button = el('button', 'btn btn-secondary btn-sm', item.protected ? 'Protected ✓' : 'Protect');
    button.type = 'button';
    button.disabled = h.inRaid || this.busy;
    button.title = 'Protection prevents automatic replacement, dropping, sales and Homefront consumption. It does not insure raid losses.';
    button.addEventListener('click', e => { e.stopPropagation(); void this.act('protect', { itemId: item.id, protected: !item.protected }); });
    return button;
  }

  private renderRewardChoices(h: Hideout) {
    let overflow = document.getElementById('extractionOverflow');
    if (!overflow) {
      overflow = el('section', 'reward-review'); overflow.id = 'extractionOverflow';
      overflow.style.gridColumn = '1 / -1'; this.q('hideoutStash').prepend(overflow);
    }
    const pending = h.overflow ?? [];
    overflow.hidden = pending.length === 0;
    overflow.replaceChildren();
    if (pending.length) {
      const free = Math.max(0, h.stashCapacity - h.stash.length);
      overflow.append(el('h3', '', `Review extracted loot · ${pending.length} waiting`),
        el('p', 'hf-sub', `Select items to keep (${free} free stash slots). Unselected items are sold only when you confirm. Resolve this before deploying. Sell stash items below to make room.`));
      for (const item of pending) {
        const row = el('div', 'cmp-row');
        const label = el('label'); const check = el('input'); check.type = 'checkbox';
        check.checked = this.overflowKeep.has(item.id); check.disabled = !!item.protected;
        check.addEventListener('change', () => { if (check.checked) this.overflowKeep.add(item.id); else this.overflowKeep.delete(item.id); this.render(); });
        label.append(check, ` Keep ${item.name} · ${RARITY_LABEL[item.rarity]} · ${item.power} power · ${money(item.value)}`);
        row.append(label, this.protectButton(h, item)); overflow.append(row);
      }
      const sold = pending.filter(i => !this.overflowKeep.has(i.id));
      const confirm = confirmButton('btn btn-primary btn-sm', `Keep ${this.overflowKeep.size}, sell ${sold.length} for ${money(sold.reduce((n,i) => n+i.value, 0))}`, 'Confirm selection and sales', () => void this.act('resolveOverflow', { expectedIds: pending.map(i => i.id), keepIds: [...this.overflowKeep] }));
      confirm.disabled = this.busy || this.overflowKeep.size > free;
      overflow.append(confirm);
    }
    let requests = document.getElementById('targetedRequisitions');
    if (!requests) { requests = el('section', 'reward-review'); requests.id = 'targetedRequisitions'; this.q('hideoutHomefront').append(requests); }
    requests.replaceChildren(el('h3', '', 'Targeted gear requisitions'), el('p', 'hf-sub', 'Bank activity credits by extracting: kills and assists +1, unique crates +8, valid revives +5 (raid caps apply). Armory level 1 unlocks a chosen Rare item for 120 credits from its map. Credits are separate from Operations XP.'));
    const armory = h.homefront?.facilities.find(f => f.id === 'armory')?.level ?? 0;
    for (const op of h.operations ?? []) {
      const row = el('div', 'cmp-row'); row.style.flexWrap = 'wrap'; row.style.gap = '8px';
      const select = el('select'); select.setAttribute('aria-label', `Requested gear from ${op.name}`);
      for (const kind of ['pistol','uzi','shotgun','rocketLauncher','armor','pack'] as const) {
        const option = el('option', '', KIND_LABEL[kind]); option.value = kind; select.append(option);
      }
      const credits = op.requisition ?? 0; const cost = op.requisitionCost ?? 120;
      const request = el('button', 'btn btn-secondary btn-sm', `Request · ${cost} credits`); request.type = 'button';
      request.disabled = this.busy || h.inRaid || armory < 1 || credits < cost || pending.length > 0 || h.stash.length >= h.stashCapacity;
      request.addEventListener('click', () => void this.act('requisition', { map: op.map, kind: select.value }));
      row.append(el('span', '', `${op.name} · ${credits}/${cost} credits · Rare power ${op.requisitionPower ?? 0}`), select, request); requests.append(row);
    }
    if (!armory) requests.append(el('p', 'hf-sub', 'Build Armory level 1 to redeem credits. Trader stock alone stays below the score 40 gate.'));
  }

  private toggleCheck(id: string) {
    if (this.state?.stash.find(i => i.id === id)?.protected) return;
    if (this.checked.has(id)) this.checked.delete(id); else this.checked.add(id);
    // On phones the compare sheet would cover the list you're ticking.
    if (window.matchMedia('(max-width: 720px)').matches) this.selectedId = null;
    this.render();
  }

  // ---------- Trader ----------

  private renderTrader(h: Hideout) {
    const filters = this.q('traderFilters');
    filters.replaceChildren();
    const chipFor = new Map<TraderGroup, [HTMLButtonElement, string]>();
    const inGroup = (o: Offer, g: TraderGroup) => g === 'all' || itemGroup(o.kind) === g;
    for (const g of TRADER_GROUPS) {
      const btn = el('button', 'chip');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(this.traderFilter === g.id));
      filters.append(btn);
      chipFor.set(g.id, [btn, g.label]);
      btn.addEventListener('click', () => { this.traderFilter = g.id; this.render(); });
    }

    // Compare against the best gear you already own (equipped or in the stash),
    // so the trader never "upgrades" you past something you could just equip.
    const asItem = (o: Offer): Item => ({ id: o.id, name: o.name, kind: o.kind, rarity: o.rarity, power: o.power, value: 0 });
    const owned = this.bestOwned(h);
    const ownedGs = gearScore(owned);
    const gainOf = (o: Offer) => upgradeDelta(owned, asItem(o));
    const nowGainOf = (o: Offer) => upgradeDelta(h.loadout, asItem(o))?.delta ?? 0;
    const beaten = (o: Offer) => { const r = owned[gainOf(o)?.slot ?? slotsFor(o.kind)[0]]; return !!r && r.power >= o.power; };
    // One baseline for the GS column and the Best upgrade pick: the best gear you
    // own (equipped or not). When that differs from what you wear, the column
    // header says so.
    // Gains count from the loadout you'll actually have: if Step 1 (Equip best)
    // is pending, from that; the "now" figure is shown alongside, labelled.
    const afterBest = ownedGs > h.gearScore;
    const gainFor = (o: Offer) => (afterBest ? gainOf(o)?.delta ?? 0 : nowGainOf(o));
    this.q('gsHead').textContent = afterBest ? 'GS gain (after Equip best)' : 'GS gain';
    this.q('gsHead').title = afterBest ? `What the purchase adds once you've pressed Equip best (which takes you from ${h.gearScore} to ${ownedGs} for free).` : 'What the purchase adds to your gear score.';
    this.q('traderFoot').hidden = true;
    // Power drives gear score, but a gun of another type can hit harder or softer.
    const rivalFor = (o: Offer) => {
      const gs = afterBest ? gainOf(o) : upgradeDelta(h.loadout, asItem(o));
      const slot = gs?.slot ?? slotsFor(o.kind)[0];
      return (afterBest ? owned[slot] : h.loadout[slot]) ?? null;
    };
    const dpsChange = (o: Offer) => {
      const r = rivalFor(o);
      const mine = weaponDps(o.kind, o.power);
      const theirs = r ? weaponDps(r.kind, r.power) : null;
      return mine !== null && theirs !== null ? mine - theirs : null;
    };
    const affordable = h.offers.filter(o => o.price <= h.cash && !beaten(o) && gainFor(o) > 0 && (dpsChange(o) ?? 0) >= 0);
    const bestOffer = affordable.sort((a, b) => (gainFor(b) / b.price) - (gainFor(a) / a.price) || gainFor(b) - gainFor(a))[0];

    const nowGain = (o: Offer) => upgradeDelta(h.loadout, asItem(o))?.delta ?? 0;
    const note = this.q('traderNote');
    note.replaceChildren();
    const empty = SLOTS.filter(s => !owned[s]);
    if (ownedGs > h.gearScore && !h.inRaid) {
      note.classList.add('urgent');
      note.append(el('span', '', `Equip your better stash gear first. It's free. Items you already beat are hidden.`));
      const btn = el('button', 'btn btn-upgrade-solid btn-sm', `Equip best first: ${h.gearScore} → ${ownedGs}`);
      btn.type = 'button';
      btn.addEventListener('click', () => void this.equipBest());
      note.append(btn);
    } else if (empty.length) {
      note.append(el('span', '', `You own nothing for your ${empty.map(s => SLOT_LABEL[s].toLowerCase()).join(' and ')} slot${empty.length > 1 ? 's' : ''}: anything that fits raises your gear score.`));
    }
    note.hidden = note.childElementCount === 0;
    if (note.hidden) note.classList.remove('urgent');

    const list = this.q('traderGrid');
    list.replaceChildren();
    const full = h.stash.length >= h.stashCapacity;
    const isOutclassed = (o: Offer) => { const r = owned[gainOf(o)?.slot ?? slotsFor(o.kind)[0]]; return !!r && r.power >= o.power; };
    for (const [id, [btn, label]] of chipFor) {
      const inG = h.offers.filter(o => inGroup(o, id));
      const listed = this.showOutclassed ? inG.length : inG.filter(o => !isOutclassed(o)).length;
      btn.replaceChildren(label, el('span', 'chip-count', String(listed)));
      btn.title = this.showOutclassed ? '' : `${listed} worth buying of ${inG.length}`;
    }
    const visible = h.offers.filter(o => inGroup(o, this.traderFilter));
    const outclassed = visible.filter(isOutclassed);
    const shown = this.showOutclassed ? visible : visible.filter(o => !isOutclassed(o));
    if (shown.length === 0) list.append(el('p', 'list-empty', 'Everything here is weaker than gear you already own.'));
    // Best value first: most gear score per dollar, then cheapest.
    const weaker = (o: Offer) => ((dpsChange(o) ?? 0) < 0 ? 1 : 0);
    shown.sort((a, b) => weaker(a) - weaker(b) || (gainFor(b) / b.price) - (gainFor(a) / a.price) || a.price - b.price);
    for (const offer of shown) {
      const g = gainOf(offer);
      const slot = g?.slot ?? slotsFor(offer.kind)[0];
      const rival = owned[slot] ?? null;
      const worse = !!rival && rival.power >= offer.power;
      const wearing = upgradeDelta(h.loadout, asItem(offer));
      const replaced = wearing ? h.loadout[wearing.slot] ?? null : null;
      const canAfford = h.cash >= offer.price;
      const row = el('div', 'trade-row' + (offer === bestOffer ? ' best' : '') + (worse ? ' worse' : '') + (canAfford ? '' : ' cant'));
      row.style.setProperty('--rarity', RARITY_COLOR[offer.rarity]);
      const body = el('span', 'row-body');
      const name = el('span', 'row-name', offer.name);
      if (offer === bestOffer) {
        const tag = el('span', 'tag tag-best', 'Best upgrade');
        tag.title = `Most gear score for the money: ${money(Math.round(offer.price / Math.max(1, gainFor(offer))))} a point`;
        name.append(tag);
      }
      body.append(name);
      const pw = el('span', 'row-meta inline-pwr-row');
      pw.append(el('span', 'inline-pwr', `${offer.power} PWR`));
      body.append(pw);
      const versus = afterBest ? rival : replaced;
      const vsLine = el('span', 'row-meta');
      if (worse) vsLine.append(`You own better: ${rival!.name} (${rival!.power})`);
      else if (versus) {
        vsLine.append(`+${offer.power - versus.power} power vs your ${versus.name}`);
        const d = dpsChange(offer);
        if (d !== null && d !== 0) vsLine.append(el('span', d < 0 ? 'dps-down' : 'dps-up', `${d > 0 ? '+' : '−'}${Math.abs(d)} DPS`));
      } else vsLine.append(`Fills your empty ${SLOT_LABEL[(wearing?.slot ?? slot)].toLowerCase()}`);
      body.append(vsLine);
      const power = el('span', 'power-num');
      power.append(el('b', '', String(offer.power)), el('small', '', 'PWR'));
      const stat = el('span', 'trade-stat');
      const dps = weaponDps(offer.kind, offer.power);
      stat.append(el('span', 'trait-chip', KIND_TRAIT[offer.kind] ?? ''),
        el('small', '', dps ? `${dps} DPS · ${KIND_RATE[offer.kind]}` : keyStat(offer)?.text.split(' · ')[0] ?? itemEffect(offer)));
      const gain = gainFor(offer);
      const delta = el('span', 'trade-delta ' + (gain > 0 ? 'up' : 'none'));
      // A delta, like the stash's "Equip +N", so there's no baseline to misread.
      if (afterBest) {
        // Counted from the loadout Equip best gives you; muted until you press it.
        delta.classList.add('pending');
        delta.append(el('small', 'gs-prefix', 'GS '), el('b', '', gain > 0 ? `+${gain}` : '—'));
        if (gain > 0) delta.append(el('small', 'gs-to', `→ ${ownedGs + gain}`));
        delta.title = `Press Equip best (free) to see what this adds. Bought and equipped right now it adds +${nowGain(offer)}.`;
      } else {
        delta.append(el('small', 'gs-prefix', 'GS '), el('b', '', gain > 0 ? `+${gain}` : '—'));
        if (gain > 0) delta.append(el('small', 'gs-to', `${h.gearScore} → ${h.gearScore + gain}`));
      }

      delta.title = afterBest
        ? `After you equip your best stash gear (gear score ${ownedGs}), this adds +${gain}. Bought and equipped right now instead, it adds +${nowGain(offer)}.`
        : `Your gear score goes from ${h.gearScore} to ${h.gearScore + gain} if you buy and equip it.`;
      const sideGrade = (dpsChange(offer) ?? 0) < 0;
      if (sideGrade) name.append(el('span', 'tag tag-side', 'Side-grade'));
      const btn = el('button', 'btn btn-sm trade-buy ' + (offer === bestOffer ? 'btn-money-solid' : canAfford && gain > 0 && !sideGrade ? 'btn-money' : 'btn-cant'));
      btn.type = 'button';
      btn.disabled = !canAfford || h.inRaid || full;
      btn.textContent = `Buy ${money(offer.price)}`;
      if (!canAfford) btn.prepend(this.deps.icon('i-lock'));
      btn.title = full ? `Stash full (${h.stash.length}/${h.stashCapacity})` : h.inRaid ? 'Locked while deployed'
        : canAfford ? `Buy ${offer.name}: ${money(h.cash - offer.price)} left after` : `You need ${money(offer.price - h.cash)} more`;
      btn.addEventListener('click', () => this.buy(offer));
      row.append(this.icon(offer), body, power, stat, delta, btn);
      list.append(row);
    }
    if (outclassed.length) {
      const more = el('button', 'link trade-more', this.showOutclassed ? `Hide ${outclassed.length} you already beat` : `Show ${outclassed.length} you already beat`);
      more.type = 'button';
      more.addEventListener('click', () => { this.showOutclassed = !this.showOutclassed; this.render(); });
      list.append(more);
    }
  }

  /** Trader side panel: sell straight from the stash. */
  private renderSellList(h: Hideout) {
    const list = this.q('sellList');
    list.replaceChildren();
    this.q('sellStats').textContent = `${h.stash.length}/${h.stashCapacity} · ${money(h.stash.reduce((s, i) => s + i.value, 0))}`;
    const items = h.stash.filter(i => !isEncrypted(i)).sort((a, b) => (this.sellCost(h, a) ? 1 : 0) - (this.sellCost(h, b) ? 1 : 0) || b.value - a.value);
    const sealed = h.stash.length - items.length;
    if (items.length === 0) list.append(el('p', 'list-empty', 'Nothing to sell.'));
    let headed = false;
    const keepers = items.filter(i => this.sellCost(h, i)).length;
    for (const item of items) {
      if (this.sellCost(h, item)) {
        if (!headed) {
          headed = true;
          const toggle = el('button', 'link sell-keep-toggle', this.showKeepers ? `Hide your best gear (${keepers})` : `Show your best gear (${keepers}) · hidden to keep it safe`);
          toggle.type = 'button';
          toggle.title = 'Gear your best loadout uses. Selling it lowers the gear score you can reach.';
          toggle.addEventListener('click', () => { this.showKeepers = !this.showKeepers; this.render(); });
          list.append(toggle);
        }
        if (!this.showKeepers) continue;
      }
      const row = el('div', 'sell-row');
      row.style.setProperty('--rarity', RARITY_COLOR[item.rarity]);
      const body = el('span', 'row-body');
      const cost = this.sellCost(h, item);
      body.append(el('span', 'row-name', item.name));
      const meta = el('span', 'row-meta');
      meta.append(this.rarityChip(item));
      if (slotsFor(item.kind).length) meta.append(el('span', '', `${item.power} PWR`));
      if (cost) meta.append(el('span', 'tag tag-keep', 'Best gear'));
      body.append(meta);
      const btn = confirmButton('btn btn-sm ' + (cost ? 'btn-sell-muted' : 'btn-sell'), `Sell ${money(item.value)}`, cost ? `GS ${cost.from}→${cost.to}?` : 'Sure?', () => this.sell(item));
      if (cost) btn.title = `This is part of your best loadout: selling it drops your best gear score from ${cost.from} to ${cost.to}.`;
      btn.disabled = h.inRaid || !!item.protected;
      row.append(this.icon(item, 'sm'), body, btn);
      list.append(row);
    }
    const noteEl = this.q('sellNote');
    noteEl.hidden = !sealed;
    if (sealed) noteEl.replaceChildren(el('span', '', `${sealed} sealed item${sealed === 1 ? ' is' : 's are'} worth more decrypted, so ${sealed === 1 ? "it's" : "they're"} not listed here. Sell or pack ${sealed === 1 ? 'it' : 'them'} from the Stash.`));
  }

  /** Map cards for the deploy screen. */
  renderMaps(container: HTMLElement, selected: string, onPick: (m: MapSummary) => void) {
    const h = this.state;
    container.replaceChildren();
    if (!h) return;
    for (const map of h.maps) {
      const card = el('button', 'map-card' + (map.id === selected ? ' selected' : '') + (map.unlocked ? '' : ' locked'));
      card.type = 'button';
      card.dataset.tier = String(map.tier);
      const top = el('span', 'map-top');
      top.append(el('span', 'map-name', map.name), el('span', 'badge', `Tier ${map.tier}`));
      const fee = map.entryFee ? `$${map.entryFee.toLocaleString('en-US')} entry` : 'Free entry';
      const meta = el('span', 'map-meta', `${map.threat} threat · loot power ${map.lootPower[0]}–${map.lootPower[1]} (+ rarity) · ${formatClock(map.raidSecs)} raid · ${fee}`);
      const gate = el('span', 'map-gate' + (map.unlocked ? ' ok' : ''));
      if (!map.unlocked) gate.append(this.deps.icon('i-lock'));
      gate.append(map.unlocked ? (map.minGearScore === 0 ? 'Open to everyone' : `Gear score ${map.minGearScore}+ · unlocked`) : mapLockText(map, h.gearScore));
      card.append(top, el('span', 'map-blurb', map.blurb), meta, gate);
      card.addEventListener('click', () => onPick(map));
      container.append(card);
    }
  }
}

// Kept for the results screen and tests.
export { gearScore };
