import './world-map.css';
import { drawEnemySprite } from './sprites';
import type { ZombieType } from './generated/types';
export interface LevelRecord { wave: number; clears: number; bestScore: number; bestKills: number }
export interface ProgressData { highestWave: number; highestCleared: number; unlockedWave: number; levels: LevelRecord[] }
export const EMPTY_PROGRESS: ProgressData = { highestWave: 1, highestCleared: 0, unlockedWave: 1, levels: [] };
const positions = [[9,74],[26,78],[44,74],[63,78],[82,68],[87,43],[69,31],[50,39],[32,27],[14,24]];
const svgNS='http://www.w3.org/2000/svg';
function landscape(sector:number,unlocked:number){
 const svg=document.createElementNS(svgNS,'svg');svg.setAttribute('viewBox','0 0 960 580');svg.setAttribute('aria-hidden','true');
 const points=positions.map(([x,y])=>[x*9.6,y*5.8]);
 const palette=sector%3===0?['#527944','#365f3c','#7ea85b']:sector%3===1?['#696448','#4e5237','#a6975a']:['#465d59','#304b4d','#6a8580'];
 let markup=`<defs><pattern id="wmTiles" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="#13291c" stroke-opacity=".09"/></pattern><filter id="wmShadow"><feDropShadow dx="0" dy="7" stdDeviation="2" flood-opacity=".25"/></filter></defs><rect width="960" height="580" fill="${palette[0]}"/><rect width="960" height="580" fill="url(#wmTiles)"/><path d="M580 0Q570 80 675 105T960 130V0Z" fill="#c7c087"/><path d="M620 0Q605 60 705 80T960 100V0Z" fill="#548f94"/><path d="M640 18Q700 45 810 40M730 70L860 80M865 30L930 35" fill="none" stroke="#a1d2bd" stroke-width="4" opacity=".45"/><ellipse cx="495" cy="320" rx="110" ry="44" fill="${palette[1]}"/><ellipse cx="495" cy="305" rx="110" ry="44" fill="${palette[2]}"/><path d="M462 267V240H490V267M506 269V233H531V269" fill="#677269" stroke="#2a4034" stroke-width="6"/><path d="M462 241L477 229L490 241M506 234L519 222L531 234" fill="#7e8879"/>`;
 const trees=[[65,85],[110,145],[280,60],[350,115],[380,478],[460,523],[665,495],[755,510],[925,430],[945,330],[180,310],[110,340],[205,544],[905,165],[355,337]];
 for(const [x,y]of trees)markup+=`<g transform="translate(${x},${y})" filter="url(#wmShadow)"><rect x="-5" y="-1" width="10" height="30" fill="#5d5038"/><path d="M-24 12L0-41L24 12ZM-20-8L0-58L20-8Z" fill="${palette[1]}"/><path d="M0-58L20-8H0Z" fill="${palette[2]}" opacity=".5"/></g>`;
 markup+=`<path d="M20 560L160 552L180 575H30Z" fill="#344f38"/><text x="480" y="555" text-anchor="middle" fill="#eff2d5" fill-opacity=".5" font-size="14" font-family="monospace" letter-spacing="5">SECTOR ${String(sector+1).padStart(2,'0')} · THE DEADLANDS</text>`;
 for(let index=0;index<points.length-1;index++){
  const [x,y]=points[index], [nextX,nextY]=points[index+1];
  const d=`M${x} ${y} Q${(x+nextX)/2} ${y+30} ${nextX} ${nextY}`;
  markup+=`<path d="${d}" fill="none" stroke="#30452e" stroke-width="26" stroke-linecap="round"/><path d="${d}" fill="none" stroke="${sector*10+index+2<=unlocked?'#dfc68a':'#809475'}" stroke-width="16" stroke-linecap="round" stroke-dasharray="${sector*10+index+2<=unlocked?'none':'3 18'}"/>`;
 }
 svg.innerHTML=markup;return svg;
}
export class WorldMap {
 private dialog=document.createElement('dialog');
 private progress:ProgressData=EMPTY_PROGRESS;
 private selected=1;
 private sector=0;
 constructor(private onSelect:(wave:number)=>void){
  this.dialog.id='worldMap';this.dialog.setAttribute('aria-labelledby','worldMapTitle');document.body.append(this.dialog);
  this.dialog.addEventListener('keydown',event=>event.stopPropagation());
 }
 update(progress:ProgressData){this.progress=progress;if(this.dialog.open)this.render()}
 open(selected:number){this.selected=selected;this.sector=Math.floor((selected-1)/10);this.render();if(!this.dialog.open)this.dialog.showModal();this.dialog.querySelector<HTMLButtonElement>(`[data-wave="${selected}"]`)?.scrollIntoView({block:'nearest',inline:'center'})}
 private render(){
  const records=new Map(this.progress.levels.map(level=>[level.wave,level]));
  const current=records.get(this.selected);const available=this.selected<=this.progress.unlockedWave;
  this.dialog.innerHTML=`<header class="wm-header"><div><div class="wm-kicker">CAMPAIGN CHECKPOINTS</div><h2 id="worldMapTitle">Choose your route.</h2><p>${this.progress.levels.length} waves cleared · Highest reached ${this.progress.highestWave} · Checkpoint ${this.progress.unlockedWave} unlocked</p></div><button class="wm-close" aria-label="Close world map">×</button></header><nav class="wm-nav" aria-label="Sector navigation"><button class="wm-prev" aria-label="Previous sector">← Previous</button><span class="wm-sector">SECTOR ${String(this.sector+1).padStart(2,'0')} / WAVES ${this.sector*10+1}–${this.sector*10+10}</span><button class="wm-next" aria-label="Next sector">Next →</button></nav><div class="wm-layout"><div class="wm-scroll"><div class="wm-board" role="group" aria-label="Wave checkpoints"></div></div><aside class="wm-details"><div class="wm-kicker">${current?'CLEARED WITH SQUAD':available?'CHECKPOINT AVAILABLE':'ROUTE LOCKED'}</div><h3>Wave ${this.selected}</h3><canvas class="wm-art" width="440" height="210" role="img" aria-label="Enemies encountered at this wave"></canvas><p>Clear ${this.selected*12} enemies. Survive with at least one squadmate standing.</p><dl><dt>Wave clears</dt><dd>${current?.clears||0}</dd><dt>Best wave score</dt><dd>${Math.round(current?.bestScore||0)}</dd><dt>Best personal kills</dt><dd>${current?.bestKills||0}</dd></dl><button class="wm-choose" ${available?'':'disabled'}>${available?`Choose Wave ${this.selected}`:`Clear Wave ${this.progress.unlockedWave} first`}</button><p class="wm-rule">${available?'Fresh round, fresh loadout. Joining an active squad keeps its current wave.':'Explore the route freely. Complete your available checkpoint to open the next step.'}</p></aside></div><div class="wm-legend"><span class="done">Cleared</span><span class="open">Unlocked</span><span>Locked</span></div><footer class="wm-foot">Be there before the first kill and stay through the clear to earn squad credit. Mid-wave joiners qualify from the next wave. Saves are per browser; earlier checkpoint access is preserved.</footer>`;
  this.dialog.querySelector('.wm-close')!.addEventListener('click',()=>this.dialog.close());
  const prev=this.dialog.querySelector<HTMLButtonElement>('.wm-prev')!,next=this.dialog.querySelector<HTMLButtonElement>('.wm-next')!;
  prev.disabled=this.sector===0;next.disabled=this.sector>=Math.floor((Math.max(this.progress.unlockedWave,this.progress.highestWave)-1)/10)+1;
  prev.addEventListener('click',()=>{this.sector--;this.selected=this.sector*10+1;this.render()});next.addEventListener('click',()=>{this.sector++;this.selected=this.sector*10+1;this.render()});
  const board=this.dialog.querySelector('.wm-board')!;board.append(landscape(this.sector,this.progress.unlockedWave));
  positions.forEach(([x,y],index)=>{
   const wave=this.sector*10+index+1,cleared=records.has(wave),unlocked=wave<=this.progress.unlockedWave;
   const node=document.createElement('button');node.type='button';node.className=`wm-node ${unlocked?'unlocked':'locked'} ${cleared?'cleared':''}`;
   node.style.left=x+'%';node.style.top=y+'%';node.dataset.wave=String(wave);node.setAttribute('aria-pressed',String(wave===this.selected));
   node.setAttribute('aria-label',`Wave ${wave}, ${cleared?'cleared, ':''}${unlocked?'unlocked':'locked'}`);node.title=node.getAttribute('aria-label')!;
   node.innerHTML=`${cleared?'✓':unlocked?wave:'•'}<small>WAVE ${wave}</small>`;
   node.addEventListener('click',()=>{this.selected=wave;this.render();this.dialog.querySelector<HTMLButtonElement>(`[data-wave="${wave}"]`)?.focus()});board.append(node);
  });
  this.dialog.querySelector('.wm-choose')!.addEventListener('click',()=>{if(available){this.onSelect(this.selected);this.dialog.close()}});
  const canvas=this.dialog.querySelector<HTMLCanvasElement>('.wm-art')!,ctx=canvas.getContext('2d')!;
  ctx.fillStyle='#223139';ctx.fillRect(0,0,canvas.width,canvas.height);
  const threats:ZombieType[]=['zombie',...(this.selected>=2?['devil' as const]:[]),...(this.selected>=3?['crawler' as const]:[]),...(this.selected>=4?['brute' as const]:[]),...(this.selected>=5?['vampire' as const]:[])];
  threats.forEach((type,index)=>{ctx.save();ctx.translate((index+1)*canvas.width/(threats.length+1),95);ctx.scale(1.8,1.8);drawEnemySprite(ctx,type,0,0,Math.PI/6);ctx.restore()});
 }
}
