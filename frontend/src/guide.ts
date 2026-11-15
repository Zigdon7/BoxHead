import './guide.css';
import { drawEnemySprite, drawPlaceableSprite, drawDropSprite, drawGunSprite, drawNestSprite, drawCrateSprite, drawExtractZone } from './sprites';
import type { ZombieType, PlaceableType, DropType, Weapon, Rarity } from './generated/types';
import { RARITY_COLOR, RARITY_LABEL, formatClock } from './raid';

type Entry = { name: string; art: string; tag: string; text: string; stats: string[]; tip?: string };

// Base stats on the first map (backend/src/game.rs). Later maps multiply health and damage.
const enemies: (Entry & { hp: number; speed: number; dmg: number; from: number })[] = [
  { name: 'Walker', art: 'enemy:zombie', tag: 'Every map · melee', from: 1, hp: 50, speed: 46, dmg: 20, text: 'The green standard zombie. Slow and direct: alone it is easy, but a crowd cuts off your escape routes.', stats: ['1s attack interval'], tip: 'Keep moving and thin the front of the pack with your pistol, which never runs dry.' },
  { name: 'Crawler', art: 'enemy:crawler', tag: 'Every map · fast flanker', from: 1, hp: 25, speed: 88, dmg: 20, text: 'Small, pale and fast. Zigzags toward you, follows routes through doorways and attacks twice as often as a Walker.', stats: ['0.5s attack interval'], tip: 'Kill Crawlers first. Break sight around buildings to shake pursuit.' },
  { name: 'Devil', art: 'enemy:devil', tag: 'Every map · burst pursuit', from: 1, hp: 100, speed: 62, dmg: 20, text: 'Red body, yellow eyes and horns. Every two seconds it surges forward at 1.55× speed.', stats: ['1s attack interval'], tip: 'Leave room for its rush, then dash sideways, not back into the pack.' },
  { name: 'Brute', art: 'enemy:brute', tag: 'Rust Yard and later · heavy melee', from: 2, hp: 260, speed: 30, dmg: 40, text: 'The big brown monster with the red snout. Very slow and very tough, follows doorways and hits twice as hard.', stats: ['1.5s attack interval'], tip: 'Kite it in the open and use explosives. Never trade melee hits.' },
  { name: 'Vampire', art: 'enemy:vampire', tag: 'Quarantine Zone and later · circling hunter', from: 3, hp: 160, speed: 72, dmg: 16, text: 'Pale body, red eyes and a dark cape. Approaches at an angle, circles at close range and heals when it hits you.', stats: ['1s attack interval', 'Heals on hit'], tip: 'Track its sideways movement and focus it before it heals back up.' },
  { name: 'Abomination', art: 'enemy:abomination', tag: 'Boss · sent after campers', from: 1, hp: 1400, speed: 150, dmg: 60, text: 'A many-eyed mass of flesh, almost as fast as you. It crawls out of the nearest nest when someone camps, then hunts that player for up to 30 seconds, smashing through walls before returning home. Camp again in the same raid and the nests send packs of three elites instead, for as long as you keep camping.', stats: ['30s hunt', 'Ignores walls', 'One per player per raid', 'Drops a lucky gear roll and a valuable'], tip: 'Keep moving and you will never meet one. If one is after you, head for an extraction point or bring it down with your squad and explosives.' },
];

const weapons: Entry[] = [
  { name: 'Pistol', art: 'weapon:pistol', tag: 'Gun · unlimited ammo', text: 'A weak but reliable sidearm. It never uses your ammo reserve, so you are never unarmed.', stats: ['18 base damage', '0.2s between shots'], tip: 'With no gun equipped you deploy with a loaner pistol that hits 20% softer than any real gun, but is never lost.' },
  { name: 'Uzi', art: 'weapon:uzi', tag: 'Gun · uses ammo', text: 'Rapid-fire SMG for sustained pressure. Drains the shared ammo reserve quickly.', stats: ['15 base damage', '0.08s between shots'], tip: 'Best into an approaching pack, where every bullet lands.' },
  { name: 'Shotgun', art: 'weapon:shotgun', tag: 'Gun · uses ammo', text: 'Five pellets in a spread. The damage is split between the pellets; up close a target takes them all.', stats: ['80 base damage total', '5 pellets', '0.5s between shots'], tip: 'Let them come close, but keep an escape route.' },
  { name: 'Rocket Launcher', art: 'weapon:rocketLauncher', tag: 'Gun · uses ammo', text: 'A slow rocket that explodes on impact and sets off nearby barrels and claymores.', stats: ['150 base damage', '80 unit blast', '1s between shots', '2 ammo per rocket'], tip: 'Save it for crowds, Brutes and Abominations.' },
  { name: 'Plasma Katana', art: 'katana', tag: 'Space / right-click · always with you', text: 'A 120° cone cleave with strong knockback. It gets stronger with your gear score and heals you a little on each kill.', stats: ['45 base damage × (1 + gear score / 90)', '0.38s cooldown', 'Heals 4% of max health per kill'], tip: 'Finish weakened enemies with it. A swing is not invulnerability; dash when you are swarmed.' },
];

const gear: Entry[] = [
  { name: 'Guns', art: 'weapon:shotgun', tag: 'Primary & secondary slots', text: 'Any gun fits either weapon slot. Power multiplies its damage: power 50 deals double, power 100 triple.', stats: ['Damage × (1 + power / 50)', 'Keys 1 and 2 switch'], tip: 'Carry one gun that never runs dry and one that hits hard.' },
  { name: 'Armor', art: 'drop:health', tag: 'Armor slot', text: 'Raises your maximum health. You start each raid at full health.', stats: ['Max health = 100 + 2 × power'], tip: 'Later maps hit much harder; armor is what lets you survive there.' },
  { name: 'Pack', art: 'drop:ammo', tag: 'Pack slot', text: 'Sets how much loot you can carry out, your shared ammo reserve and the deployables you start with.', stats: ['Loot slots = 4 + power / 12', 'Ammo = 60 + 2 × power', 'No pack: 2 slots'], tip: 'A bigger pack means more loot per extraction, and more to lose.' },
  { name: 'Valuables', art: 'loot:valuable', tag: 'Loot · cash and Homefront upgrades', text: 'Gold watches, lab notes, vaccine samples. Sell them for cash or save them for Homefront tier upgrades: tier 2 needs two uncommon-or-better valuables, and tier 3 needs three rare-or-better.', stats: ['Sell for cash', 'Save for Homefront upgrades'], tip: 'With a full pack, valuables and sealed items compete by sale value or estimated opened value. Gear only replaces weaker carried gear and can be equipped after extraction.' },
];

const deployables: Entry[] = [
  { name: 'Explosive Barrel', art: 'gear:barrel', tag: 'E / 5 · deployable', text: 'Shooting, cleaving or blasting it sets off an explosion with knockback and chain reactions.', stats: ['200 blast damage', '110 unit blast', '30 HP'], tip: 'Place it ahead of a pack, then detonate it as they close in.' },
  { name: 'Reinforced Barricade', art: 'gear:barricade', tag: 'Q / 6 · deployable', text: 'Blocks enemies, takes damage while they claw at it and hurts them back.', stats: ['220 HP', '12 contact damage / second'], tip: 'Buy time to revive a squadmate or to finish an extraction.' },
  { name: 'Claymore Mine', art: 'gear:mine', tag: 'F / 7 · deployable', text: 'Detonates when an enemy steps close. Other blasts set it off too.', stats: ['175 blast damage', '38 unit trigger', '95 unit blast'], tip: 'Mine the approach to an extraction point before you stand in it.' },
];

const world: Entry[] = [
  { name: 'Extraction point', art: 'extract', tag: 'Green ring · map edges and corners', text: 'Stand inside for 6 seconds to leave the raid with everything: your loadout, your pack and your bounty. Leaving the ring resets the countdown.', stats: ['6s to extract', 'The radar and a screen arrow point to the nearest one'], tip: 'Clear the area first. Monsters do not stop the countdown, but they can down you.' },
  { name: 'Monster nest', art: 'nest', tag: 'Red mound · unbreakable', text: 'Monsters patrol near their nest and notice visible players within 15 m. They pursue for up to 12 seconds, forget you after 2.5 seconds out of sight and give up outside their home territory. Returning monsters ignore players until they are home and have rested. Nests can not be destroyed, so plan your route around them.', stats: ['25 m home territory', '12s pursuit limit', 'A few monsters per nest at a time'], tip: 'The full map (M) shows every nest and how far its reach extends.' },
  { name: 'Uplink', art: 'uplink', tag: 'Cyan diamond · inner street crossings', text: 'A lot of loot comes sealed: you can see its rarity and power, but not what it is, and sealed it only sells for scrap. Stand in an uplink’s ring to decrypt the first sealed item in your pack into gear or a valuable, sometimes a grade better. Decrypting is loud: nearby monsters come for you and nests wake up faster.', stats: ['4–15s per item by rarity', 'Tier + 1 uplinks per map'], tip: 'Extracted with sealed loot? Select it in the hideout’s Stash tab and choose Pack for next raid to decrypt it next time.' },
  { name: 'Supply crate', art: 'crate', tag: 'Inside buildings', text: 'Walk into a crate to open it. It spills one to three items: gear or valuables from this map’s loot band, sometimes with ammo. Crates restock after 4 minutes.', stats: ['1–3 items', '4 min restock'], tip: 'Buildings near the centre of a map hold more crates.' },
  { name: 'Ammo cache', art: 'station', tag: 'Fixed map resource', text: 'Restores 20 ammo and refills after 45 seconds. You only take it if you need ammo.', stats: ['+20 ammo', '45s respawn'] },
  { name: 'Enemy drops', art: 'drop:tactical', tag: 'Supplies last 20s · gear lasts 2 min', text: 'Enemies sometimes drop ammo, health or a deployable, and sometimes gear, more often on harder maps. Elites (gold ring) drop loot four times as often.', stats: ['+15 ammo', '+25% of max health', '+1 deployable'], tip: 'Gear on the ground glows in its rarity color and shows its power.' },
];

// Used only when the server can't be reached; keep in step with MAPS in backend/src/gear.rs.
const fallbackMaps = [
  { id: 'outskirts', name: 'Outskirts', tier: 1, minGearScore: 0, threat: 'Low', blurb: 'Abandoned suburbs on the edge of the quarantine. Walkers, crawlers and the odd devil; light loot.', raidSecs: 600, entryFee: 0, lootPower: [2, 16], width: 4640, height: 4000, enemyHealth: 1, enemyDamage: 1, eliteChance: 0 },
  { id: 'rustyard', name: 'Rust Yard', tier: 2, minGearScore: 20, threat: 'Moderate', blurb: 'A collapsed industrial port. Devils hunt in packs and the first brutes appear.', raidSecs: 660, entryFee: 150, lootPower: [14, 34], width: 5280, height: 4000, enemyHealth: 1.5, enemyDamage: 1.35, eliteChance: 0.03 },
  { id: 'quarantine', name: 'Quarantine Zone', tier: 3, minGearScore: 40, threat: 'High', blurb: 'The hot zone behind the wall. Brutes, vampires and elite packs guard valuable caches.', raidSecs: 720, entryFee: 600, lootPower: [32, 59], width: 5920, height: 4000, enemyHealth: 2.1, enemyDamage: 1.8, eliteChance: 0.06 },
  { id: 'blacksite', name: 'Black Site', tier: 4, minGearScore: 65, threat: 'Extreme', blurb: 'The lab where it started. Elite hordes, relentless vampires and the best gear in the zone.', raidSecs: 780, entryFee: 2000, lootPower: [55, 88], width: 6560, height: 4640, enemyHealth: 2.8, enemyDamage: 2.3, eliteChance: 0.11 },
];
type GuideMap = typeof fallbackMaps[number];
let maps: GuideMap[] = fallbackMaps;

function illustration(art: string, name: string) {
  const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 280; canvas.className = 'portrait';
  canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', name + ' — in-game illustration'); canvas.textContent = name;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#273341'; ctx.fillRect(0, 0, 400, 280);
  ctx.strokeStyle = '#ffffff06'; ctx.lineWidth = 1;
  for (let x = 0; x < 400; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 280); ctx.stroke(); }
  for (let y = 0; y < 280; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(400, y); ctx.stroke(); }
  ctx.translate(200, 133);
  const [kind, type] = art.split(':');
  if (kind === 'nest') { ctx.scale(1.1, 1.1); drawNestSprite(ctx, 0, 0, 0); return canvas; }
  if (kind === 'uplink') {
    ctx.strokeStyle = '#4fe3f7'; ctx.lineWidth = 2; ctx.setLineDash([10, 8]);
    ctx.beginPath(); ctx.arc(0, 0, 90, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#10161d'; ctx.fillRect(-21, -9, 42, 27);
    ctx.fillStyle = '#4fe3f7'; ctx.shadowColor = '#4fe3f7'; ctx.shadowBlur = 16;
    ctx.beginPath(); ctx.moveTo(0, -33); ctx.lineTo(14, -15); ctx.lineTo(0, 3); ctx.lineTo(-14, -15); ctx.closePath(); ctx.fill();
    return canvas;
  }
  if (kind === 'extract') { drawExtractZone(ctx, 0, 0, 100, 'North-West Gate', 0, 0.6); return canvas; }
  ctx.scale(kind === 'enemy' && type === 'abomination' ? 2 : 3, kind === 'enemy' && type === 'abomination' ? 2 : 3);
  ctx.lineWidth = 1; ctx.strokeStyle = '#9ba9ba';
  if (kind === 'enemy') drawEnemySprite(ctx, type as ZombieType, 0, 0, Math.PI / 7);
  else if (kind === 'gear') drawPlaceableSprite(ctx, { id: 'guide', type: type as PlaceableType, pos: { x: 0, y: 0 }, health: 220, maxHealth: 220, ownerId: '' }, 0, 0, 150);
  else if (kind === 'drop') drawDropSprite(ctx, { id: 'guide', type: type as DropType, pos: { x: 0, y: 0 } }, 0, 0, 0);
  else if (kind === 'loot') drawDropSprite(ctx, { id: 'guide', type: 'loot', pos: { x: 0, y: 0 }, item: { id: 'g', kind: 'valuable', rarity: 'epic', power: 42, name: 'Gold Watch', value: 900 } }, 0, 0, 0);
  else if (kind === 'crate') drawCrateSprite(ctx, 0, 0, 0);
  else if (kind === 'weapon') { ctx.scale(1.7, 1.7); ctx.translate(-22, 0); drawGunSprite(ctx, type as Weapon); }
  else if (kind === 'katana') {
    ctx.rotate(-.35); ctx.fillStyle = '#37474f'; ctx.fillRect(-28, -3, 15, 6); ctx.fillStyle = '#ffb400'; ctx.fillRect(-15, -7, 3, 14);
    ctx.shadowColor = '#00e5ff'; ctx.shadowBlur = 10; ctx.fillStyle = '#00e5ff'; ctx.fillRect(-12, -3, 45, 6); ctx.fillStyle = '#fff'; ctx.fillRect(-12, -1, 43, 2); ctx.shadowBlur = 0;
  } else if (kind === 'station') {
    ctx.fillStyle = '#ffb400'; ctx.fillRect(-20, -12, 40, 24); ctx.strokeStyle = '#aa7700'; ctx.lineWidth = 2; ctx.strokeRect(-20, -12, 40, 24);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('AMMO', 0, 0);
  }
  return canvas;
}

function card(entry: Entry) {
  const article = document.createElement('article'); article.className = 'card'; article.append(illustration(entry.art, entry.name));
  const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = entry.tag; article.append(tag);
  const title = document.createElement('h3'); title.textContent = entry.name; article.append(title);
  const text = document.createElement('p'); text.textContent = entry.text; article.append(text);
  const stats = document.createElement('div'); stats.className = 'stats';
  for (const stat of entry.stats) { const label = document.createElement('span'); label.textContent = stat; stats.append(label); }
  article.append(stats);
  if (entry.tip) { const tip = document.createElement('p'); tip.className = 'tip'; tip.textContent = entry.tip; article.append(tip); }
  return article;
}

function mapCard(m: GuideMap) {
  const article = document.createElement('article'); article.className = 'card';
  const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = `Tier ${m.tier} · ${m.threat} threat`;
  const title = document.createElement('h3'); title.textContent = m.name;
  const text = document.createElement('p'); text.textContent = m.blurb;
  const stats = document.createElement('div'); stats.className = 'stats';
  for (const stat of [
    m.minGearScore === 0 ? 'Open to everyone' : `Gear score ${m.minGearScore}+`,
    m.entryFee ? `$${m.entryFee.toLocaleString('en-US')} entry fee` : 'Free entry',
    `Loot power ${m.lootPower[0]}–${m.lootPower[1]} (+ rarity)`,
    `${formatClock(m.raidSecs)} raid clock`,
    `Enemies ×${m.enemyHealth} health, ×${m.enemyDamage} damage`,
    `${Math.round(m.width / 32 / 10) * 10} × ${Math.round(m.height / 32 / 10) * 10} m`,
  ]) { const s = document.createElement('span'); s.textContent = stat; stats.append(s); }
  article.append(tag, title, text, stats);
  return article;
}

function rarityRow() {
  const row = document.getElementById('rarityRow');
  if (!row) return;
  const bonus: Record<Rarity, number> = { common: 0, uncommon: 3, rare: 6, epic: 10, legendary: 15 };
  for (const r of Object.keys(RARITY_COLOR) as Rarity[]) {
    const chip = document.createElement('span');
    chip.className = 'rarity-chip';
    chip.style.borderColor = RARITY_COLOR[r];
    chip.style.color = RARITY_COLOR[r];
    chip.textContent = `${RARITY_LABEL[r]} · +${bonus[r]} power`;
    row.append(chip);
  }
}

for (const [id, entries] of [['weaponCards', weapons], ['gearCards', gear], ['deployCards', deployables], ['worldCards', world]] as const) {
  const grid = document.getElementById(id);
  if (grid) grid.append(...entries.map(card));
}
rarityRow();

function updateEnemies() {
  const grid = document.getElementById('enemyCards');
  if (!grid) return;
  const select = document.getElementById('mapPreview') as HTMLSelectElement | null;
  const m = maps.find(x => x.id === select?.value) ?? maps[0];
  grid.replaceChildren(...enemies.map(e => card({
    ...e,
    stats: [
      `${Math.round(e.hp * m.enemyHealth)} HP on ${m.name}`,
      `${Math.round(e.dmg * m.enemyDamage)} damage / hit`,
      `${e.speed} base speed`,
      ...e.stats,
      ...(m.tier < e.from ? [`Doesn't appear on ${m.name}`] : []),
    ],
  })));
  const mapsGrid = document.getElementById('mapCards');
  if (mapsGrid) mapsGrid.replaceChildren(...maps.map(mapCard));
}

const select = document.getElementById('mapPreview') as HTMLSelectElement | null;
function fillSelect() {
  if (!select) return;
  const current = select.value;
  select.replaceChildren(...maps.map(m => Object.assign(document.createElement('option'), { value: m.id, textContent: `${m.name} (tier ${m.tier})` })));
  if (maps.some(m => m.id === current)) select.value = current;
}
select?.addEventListener('change', updateEnemies);
fillSelect();
updateEnemies();
// Live numbers from the server when it's reachable.
fetch('/api/maps').then(r => r.json()).then((data: { maps?: GuideMap[] }) => {
  if (data.maps?.length) { maps = data.maps; fillSelect(); updateEnemies(); }
}).catch(() => { /* keep the built-in numbers */ });

const specimens = document.getElementById('aboutEnemies');
if (specimens) for (const enemy of enemies) specimens.append(illustration(enemy.art, enemy.name));
