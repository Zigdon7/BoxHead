import './guide.css';
import { drawEnemySprite, drawPlaceableSprite, drawDropSprite, drawGunSprite } from './sprites';
import type { ZombieType, PlaceableType, DropType, Weapon } from './generated/types';

type Entry = { name: string; art: string; tag: string; text: string; stats: string[]; tip?: string };
const enemies: (Entry & { type: ZombieType; first: number; hp: (w: number) => number; speed: (w: number) => number })[] = [
  { name:'Walker', type:'zombie', first:1, art:'enemy:zombie', tag:'Wave 1 · melee', text:'The green standard zombie. Slow, direct pursuit makes a lone Walker manageable, but a crowd cuts off your escape routes.', stats:['20 damage / hit','1s attack interval'], tip:'Keep moving and thin the front of the pack with your unlimited-ammo pistol.', hp:w=>20+w*10, speed:w=>38+Math.min(w*2.2,30) },
  { name:'Devil', type:'devil', first:2, art:'enemy:devil', tag:'Wave 2 · burst pursuit', text:'Red body, yellow eyes and horns. Periodically surges toward its target at 1.55× normal speed. It does not shoot fireballs.', stats:['20 damage / hit','1s attack interval'], tip:'Leave space for its short rush, then dash sideways rather than back into the pack.', hp:w=>50+w*20, speed:w=>54+Math.min(w*2.4,34) },
  { name:'Crawler', type:'crawler', first:3, art:'enemy:crawler', tag:'Wave 3 · fast flanker', text:'Small, pale and fast. Zigzags toward you, ignores walls and attacks twice as often as a Walker.', stats:['20 damage / hit','0.5s attack interval','Ignores walls'], tip:'Prioritize nearby Crawlers. A wall is not cover against them; use open space and quick aim.', hp:w=>10+w*5, speed:w=>78+Math.min(w*2.6,36) },
  { name:'Brute', type:'brute', first:4, art:'enemy:brute', tag:'Wave 4 · heavy melee', text:'The big brown monster with the red snout. Very slow and very tough. Ignores walls and deals double melee damage. It has no ranged attack.', stats:['40 damage / hit','1.5s attack interval','Ignores walls'], tip:'Kite it in open space. Its size and health make it a good explosive target; never trade melee hits.', hp:w=>150+w*30, speed:w=>24+Math.min(w*1.4,20) },
  { name:'Vampire', type:'vampire', first:5, art:'enemy:vampire', tag:'Wave 5 · circling hunter', text:'Pale body, red eyes and a dark cape. Approaches at an angle, circles at close range and restores up to 15 HP when it lands a hit.', stats:['16 damage / hit','1s attack interval','Heals on hit'], tip:'Track its sideways movement and focus it down before repeated hits undo your damage.', hp:w=>80+w*15, speed:w=>64+Math.min(w*2.4,34) },
];
const weapons: Entry[] = [
 {name:'Pistol',art:'weapon:pistol',tag:'Slot 1 · starting weapon',text:'Reliable single-shot sidearm with unlimited ammunition. Always available even when your shared ammo reserve is empty.',stats:['25 base damage','0.2s between shots'],tip:'Use it to clean up stragglers and conserve ammo.'},
 {name:'Uzi',art:'weapon:uzi',tag:'Slot 2 · unlockable',text:'Rapid-fire SMG for sustained pressure. Consumes the shared ammo reserve quickly.',stats:['15 base damage','0.08s between shots'],tip:'Best when you can maintain accurate fire into an approaching pack.'},
 {name:'Shotgun',art:'weapon:shotgun',tag:'Slot 3 · unlockable',text:'Fires five pellets in a spread. The listed base damage is split across those pellets; close targets can absorb the whole blast.',stats:['80 base damage total','5 pellets','0.5s between shots'],tip:'Let the pack approach enough to land multiple pellets without losing your escape route.'},
 {name:'Rocket Launcher',art:'weapon:rocketLauncher',tag:'Slot 4 · unlockable',text:'Launches a visible rocket that explodes on impact and can trigger nearby barrels and mines.',stats:['150 base damage','80px blast radius','1s between shots'],tip:'Aim at clusters and explosive setups rather than isolated targets.'},
 {name:'Plasma Katana',art:'katana',tag:'Space / right-click · no ammo',text:'A 120° cone cleave with strong knockback. Starts at 62px reach and heals 5 HP per melee kill; edge upgrades improve damage, reach and healing.',stats:['45 base damage','0.38s cooldown','5 HP per kill'],tip:'Use it to finish weakened enemies. A swing is not invulnerability—dash when overwhelmed.'},
];
const gear: Entry[] = [
 {name:'Explosive Barrel',art:'gear:barrel',tag:'E / 5 · placeable',text:'A red TNT barrel. Shooting, cleaving or blasting it triggers an area explosion, knockback and chain reactions.',stats:['200 blast damage','110px blast radius','30 HP'],tip:'Place it ahead of a pack, then detonate it when the group closes in.'},
 {name:'Reinforced Barricade',art:'gear:barricade',tag:'Q / 6 · placeable',text:'A steel-braced brown barricade. Blocks enemies, takes damage while they attack it and deals contact damage back to them.',stats:['220 HP','12 contact damage / second'],tip:'Buy time to reload your plan, reposition or revive a teammate. It will not last forever.'},
 {name:'Claymore Mine',art:'gear:mine',tag:'F / 7 · placeable',text:'A round mine with a blinking red sensor. Detonates when an enemy enters its proximity radius. Other blasts can trigger it too.',stats:['175 blast damage','38px trigger radius','95px blast radius'],tip:'Seed a retreat path before you need it, then lead the horde over it.'},
];
const pickups: Entry[] = [
 {name:'Ammo Drop',art:'drop:ammo',tag:'Enemy drop · 12s lifetime',text:'The yellow bullet pickup restores 15 ammunition, up to your reserve capacity.',stats:['+15 ammo'],tip:'Walk over it before it disappears.'},
 {name:'Health Drop',art:'drop:health',tag:'Enemy drop · 12s lifetime',text:'The green pickup with a white cross restores 25 health, capped at your maximum HP.',stats:['+25 HP'],tip:'Collect when hurt; do not let the pack trap you over a medkit.'},
 {name:'Weapon Drop',art:'drop:weapon',tag:'Enemy drop · 12s lifetime',text:'The purple gun pickup unlocks a random locked firearm. With all firearms unlocked, it grants ammo, score and credits instead.',stats:['Random firearm unlock'],tip:'Check your weapon slots after collecting it; an unlock does not automatically equip the gun.'},
 {name:'Tactical Drop',art:'drop:tactical',tag:'Enemy drop · 12s lifetime',text:'The orange TAC pickup adds one randomly selected barrel, barricade or mine to your inventory.',stats:['+1 random tactical item'],tip:'Watch the gear counters to see which supply you received.'},
 {name:'Ammo Station',art:'station',tag:'Fixed map resource',text:'A yellow box marked AMMO. Restores 15 ammo when collected and becomes available again after 15 seconds.',stats:['+15 ammo','15s respawn'],tip:'Plan loops through stations instead of waiting on an empty one.'},
];
const upgrades: Entry[] = [
 {name:'Firearm Power',art:'weapon:pistol',tag:'Armory · card 1',text:'Raises firearm damage by 20% and critical chance by 4 percentage points per level. Critical chance is capped at 60%. Maximum 10 levels.',stats:['$200 + $150 × current level'],tip:'Base critical hits deal 1.75× damage.'},
 {name:'Plasma Katana Edge',art:'katana',tag:'Armory · card 2',text:'Each level adds 35% melee damage, 10% reach and 3 more healing per melee kill. Maximum 10 levels.',stats:['$150 + $125 × current level'],tip:'A strong choice for a close-range build, but keep respecting heavy enemies.'},
 {name:'Nano-Armor & Medkit',art:'drop:health',tag:'Armory · card 3',text:'Adds 25 maximum HP and immediately restores 60 HP. Maximum health is capped at 350. This is a health upgrade, not damage reduction.',stats:['$150','+25 max HP','+60 HP'],tip:'Buy while injured to benefit from the immediate heal.'},
 {name:'Expanded Magazine',art:'drop:ammo',tag:'Armory · card 4',text:'Adds 25 to your shared ammo capacity and fills the reserve. Capacity is capped at 300.',stats:['$125','+25 max ammo','Full refill'],tip:'All non-pistol weapons draw from the same reserve.'},
 {name:'Tactical Munitions Pack',art:'gear:barrel',tag:'Armory · card 5',text:'Restocks two of each deployable: barrels, barricades and claymores.',stats:['$140','+2 of each gear item'],tip:'Explosive chain reactions reward planning more than random placement.'},
 {name:'Unlock Next Firearm',art:'weapon:rocketLauncher',tag:'Armory · card 6',text:'Unlocks and equips the next locked firearm in order: Uzi, Shotgun, Rocket Launcher. Does not refill ammunition. Unavailable once all three are unlocked.',stats:['$250','Unlock + equip'],tip:'Purchase ammunition separately if your reserve is low.'},
];

function illustration(art: string, name: string) {
 const canvas=document.createElement('canvas'); canvas.width=400; canvas.height=280; canvas.className='portrait';
 canvas.setAttribute('role','img');canvas.setAttribute('aria-label',name+' — in-game illustration');canvas.textContent=name;
 const ctx=canvas.getContext('2d')!;
 ctx.fillStyle='#273341';ctx.fillRect(0,0,400,280);
 ctx.strokeStyle='#ffffff06';ctx.lineWidth=1;
 for(let x=0;x<400;x+=32){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,280);ctx.stroke()}
 for(let y=0;y<280;y+=32){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(400,y);ctx.stroke()}
 ctx.translate(200,133);ctx.scale(3,3);ctx.lineWidth=1;ctx.strokeStyle='#9ba9ba';
 const [kind,type]=art.split(':');
 if(kind==='enemy')drawEnemySprite(ctx,type as ZombieType,0,0,Math.PI/7);
 else if(kind==='gear')drawPlaceableSprite(ctx,{id:'guide',type:type as PlaceableType,pos:{x:0,y:0},health:220,maxHealth:220,ownerId:''},0,0,150);
 else if(kind==='drop')drawDropSprite(ctx,{id:'guide',type:type as DropType,pos:{x:0,y:0}},0,0,0);
 else if(kind==='weapon'){ctx.scale(1.7,1.7);ctx.translate(-22,0);drawGunSprite(ctx,type as Weapon)}
 else if(kind==='katana'){
  ctx.rotate(-.35);ctx.fillStyle='#37474f';ctx.fillRect(-28,-3,15,6);ctx.fillStyle='#ffb400';ctx.fillRect(-15,-7,3,14);
  ctx.shadowColor='#00e5ff';ctx.shadowBlur=10;ctx.fillStyle='#00e5ff';ctx.fillRect(-12,-3,45,6);ctx.fillStyle='#fff';ctx.fillRect(-12,-1,43,2);ctx.shadowBlur=0;
 } else if(kind==='station'){
  ctx.fillStyle='#ffb400';ctx.fillRect(-20,-12,40,24);ctx.strokeStyle='#aa7700';ctx.lineWidth=2;ctx.strokeRect(-20,-12,40,24);
  ctx.fillStyle='#fff';ctx.font='bold 11px monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('AMMO',0,0);
 }
 return canvas;
}
function card(entry:Entry){
 const article=document.createElement('article');article.className='card';article.append(illustration(entry.art,entry.name));
 const tag=document.createElement('span');tag.className='tag';tag.textContent=entry.tag;article.append(tag);
 const title=document.createElement('h3');title.textContent=entry.name;article.append(title);
 const text=document.createElement('p');text.textContent=entry.text;article.append(text);
 const stats=document.createElement('div');stats.className='stats';for(const stat of entry.stats){const label=document.createElement('span');label.textContent=stat;stats.append(label)}article.append(stats);
 if(entry.tip){const tip=document.createElement('p');tip.className='tip';tip.textContent=entry.tip;article.append(tip)}
 return article;
}
for(const [id,entries] of [['weaponCards',weapons],['gearCards',gear],['pickupCards',pickups],['upgradeCards',upgrades]] as const){const grid=document.getElementById(id);if(grid)grid.append(...entries.map(card))}
function updateEnemies(){
 const grid=document.getElementById('enemyCards');if(!grid)return;
 const wave=Number((document.getElementById('wavePreview') as HTMLInputElement).value);
 document.getElementById('previewWave')!.textContent=String(wave);
 grid.replaceChildren(...enemies.map(enemy=>card({...enemy,stats:[...enemy.stats,`${enemy.hp(wave)} HP at wave ${wave}`,`${enemy.speed(wave).toFixed(1)}px/s base speed`,...(wave<enemy.first?[`Starts at wave ${enemy.first}`]:[])]})));
}
document.getElementById('wavePreview')?.addEventListener('input',updateEnemies);updateEnemies();
const specimens=document.getElementById('aboutEnemies');if(specimens)for(const enemy of enemies)specimens.append(illustration(enemy.art,enemy.name));
