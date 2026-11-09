import type { ZombieType, Placeable, DropPickup, Weapon } from './generated/types';
import { RARITY_COLOR } from './raid';

/** Draw an enemy. Elites are drawn 30% bigger with a gold ring. Returns the drawn half-size. */
export function drawEnemySprite(ctx: CanvasRenderingContext2D, type: ZombieType, sx: number, sy: number, angle = 0, elite = false): number {
    if (type === 'abomination') return drawAbomination(ctx, sx, sy, angle);
    if (elite) {
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(1.3, 1.3);
      const size = drawEnemySprite(ctx, type, 0, 0, angle, false);
      ctx.strokeStyle = '#f2b53c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, size * 1.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return size * 1.3;
    }
    let size = 10;
    let bodyColor = '#4CAF50';
    let shoulderColor = '#388E3C';
    let eyeColor = '#fff';

    if (type === 'devil') { size = 14; bodyColor = '#e53935'; shoulderColor = '#b71c1c'; eyeColor = '#ffeb3b'; }
    if (type === 'crawler') { size = 8; bodyColor = '#bcc6cc'; shoulderColor = '#98a4ab'; eyeColor = '#b71c1c'; }
    if (type === 'brute') { size = 20; bodyColor = '#5d4037'; shoulderColor = '#3e2723'; eyeColor = '#ff5722'; }
    if (type === 'vampire') { size = 12; bodyColor = '#e0e0e0'; shoulderColor = '#9e9e9e'; eyeColor = '#d50000'; }

    ctx.save();
    ctx.translate(sx, sy);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath();
    ctx.ellipse(0, size + 4, size * 1.5, size * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(angle);

    if (type === 'vampire') {
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.moveTo(-size, 0);
      ctx.lineTo(-size - 10, -size - 8);
      ctx.lineTo(-size - 10, size + 8);
      ctx.fill();
    }

    ctx.fillStyle = shoulderColor;
    ctx.fillRect(-size * 0.8, -size * 1.2, size * 1.6, size * 2.4);

    if (type === 'brute') {
      ctx.fillStyle = '#212121';
      ctx.fillRect(-size * 0.9, -size * 1.3, size * 1.8, size * 2.6);
    }

    ctx.fillStyle = bodyColor;
    if (type === 'crawler') {
      ctx.fillRect(0, -size * 1.5, size * 1.2, 4);
      ctx.fillRect(0, size * 1.5 - 4, size * 1.2, 4);
    } else {
      ctx.fillRect(size * 0.2, -size * 1.4, size, size * 0.6);
      ctx.fillRect(size * 0.2, size * 0.8, size, size * 0.6);
    }

    ctx.fillStyle = bodyColor;
    ctx.fillRect(-size, -size, size * 2, size * 2);

    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-size + 1, -size + 1, size * 2 - 2, size * 2 - 2);

    ctx.fillStyle = eyeColor;
    ctx.fillRect(size * 0.4, -size * 0.6, size * 0.3, size * 0.3);
    ctx.fillRect(size * 0.4, size * 0.3, size * 0.3, size * 0.3);

    if (type !== 'vampire' && type !== 'brute') {
      ctx.fillStyle = '#000';
      ctx.fillRect(size * 0.5, -size * 0.5, size * 0.1, size * 0.1);
      ctx.fillRect(size * 0.5, size * 0.4, size * 0.1, size * 0.1);
    }

    if (type === 'devil') {
      ctx.fillStyle = '#b71c1c';
      ctx.beginPath();
      ctx.moveTo(-size * 0.5, -size);
      ctx.lineTo(size * 0.5, -size - 8);
      ctx.lineTo(size * 0.5, -size);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-size * 0.5, size);
      ctx.lineTo(size * 0.5, size + 8);
      ctx.lineTo(size * 0.5, size);
      ctx.fill();
    }

    if (type === 'brute') {
      ctx.fillStyle = '#8e0000';
      ctx.fillRect(size * 0.6, -size * 0.3, size * 0.4, size * 0.6);
    }

    ctx.restore();

  return size;
}

/** The camping punisher: a huge, many-eyed mass of flesh. */
function drawAbomination(ctx: CanvasRenderingContext2D, sx: number, sy: number, angle: number): number {
    const size = 28;
    const t = performance.now() / 1000;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.ellipse(0, size + 6, size * 1.6, size * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(angle);
    // Pulsing body lobes
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + t * 0.6;
      const r = size * (0.55 + 0.08 * Math.sin(t * 3 + i));
      ctx.fillStyle = i % 2 ? '#4a1d3f' : '#5e2750';
      ctx.beginPath();
      ctx.arc(Math.cos(a) * size * 0.45, Math.sin(a) * size * 0.45, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#6f2f5f';
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.85, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2a0f24';
    ctx.lineWidth = 3;
    ctx.stroke();
    // Arms reaching forward
    ctx.fillStyle = '#4a1d3f';
    ctx.fillRect(size * 0.5, -size * 1.05, size * 0.9, size * 0.35);
    ctx.fillRect(size * 0.5, size * 0.7, size * 0.9, size * 0.35);
    // A cluster of glowing eyes
    ctx.fillStyle = '#ffe14d';
    for (const [ex, ey, er] of [[0.45, -0.3, 0.13], [0.5, 0.25, 0.11], [0.2, 0, 0.15], [0.25, -0.55, 0.08], [0.3, 0.55, 0.08]]) {
      ctx.beginPath();
      ctx.arc(size * ex, size * ey, size * er, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#8e0000';
    ctx.fillRect(size * 0.62, -size * 0.12, size * 0.25, size * 0.24);
    ctx.restore();
    return size;
}

/** An unbreakable monster nest: a fleshy mound on a dark stain. */
export function drawNestSprite(ctx: CanvasRenderingContext2D, sx: number, sy: number, now = 0) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 420);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = `rgba(90, 10, 30, ${0.25 + pulse * 0.12})`;
    ctx.beginPath();
    ctx.arc(0, 0, 120, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(40, 6, 18, 0.55)';
    ctx.beginPath();
    ctx.arc(0, 0, 64, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.fillStyle = i % 2 ? '#5b1626' : '#7a2034';
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 24, Math.sin(a) * 24, 16 + (i % 3) * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#9b2a40';
    ctx.beginPath();
    ctx.arc(0, 0, 26 + pulse * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255, 80, 60, ${0.5 + pulse * 0.5})`;
    ctx.beginPath();
    ctx.arc(0, 0, 9 + pulse * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

/** A supply crate (closed). */
export function drawCrateSprite(ctx: CanvasRenderingContext2D, sx: number, sy: number, now = 0) {
    const glow = 0.5 + 0.5 * Math.sin(now / 500);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = `rgba(242, 181, 60, ${0.12 + glow * 0.1})`;
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-14, -9, 30, 22);
    ctx.fillStyle = '#7a5a2e';
    ctx.fillRect(-16, -12, 32, 24);
    ctx.strokeStyle = '#3e2c14';
    ctx.lineWidth = 2;
    ctx.strokeRect(-16, -12, 32, 24);
    ctx.beginPath();
    ctx.moveTo(-16, -12); ctx.lineTo(16, 12);
    ctx.moveTo(16, -12); ctx.lineTo(-16, 12);
    ctx.stroke();
    ctx.fillStyle = '#f2b53c';
    ctx.fillRect(-3, -14, 6, 4);
    ctx.restore();
}

/** An extraction zone on the ground: a ring that fills as you extract. */
export function drawExtractZone(ctx: CanvasRenderingContext2D, sx: number, sy: number, radius: number, name: string, now = 0, progress = 0) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 350);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = `rgba(64, 201, 122, ${0.08 + pulse * 0.06})`;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.setLineDash([10, 8]);
    ctx.lineDashOffset = -now / 60;
    ctx.strokeStyle = `rgba(64, 201, 122, ${0.55 + pulse * 0.3})`;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.setLineDash([]);
    if (progress > 0) {
      ctx.strokeStyle = '#40c97a';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(0, 0, radius - 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, progress));
      ctx.stroke();
    }
    ctx.fillStyle = '#40c97a';
    ctx.font = '800 13px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('EXTRACT', 0, -8);
    ctx.fillStyle = 'rgba(242, 243, 245, 0.85)';
    ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
    ctx.fillText(name, 0, 10);
    ctx.restore();
}

/** Gear or a valuable on the ground, glowing in its rarity color with a power tag. */
function drawLootSprite(ctx: CanvasRenderingContext2D, d: DropPickup, sx: number, sy: number, now: number) {
    const item = d.item!;
    const color = RARITY_COLOR[item.rarity];
    const bob = Math.sin(now / 300 + sx * 0.01) * 2.5;
    const y = sy + bob;
    ctx.save();
    // Light beam: brighter for rarer items, so a legendary reads from across the street.
    const beam = { common: 0, uncommon: 0.12, rare: 0.18, epic: 0.24, legendary: 0.32 }[item.rarity];
    if (beam > 0) {
      const g = ctx.createLinearGradient(sx, y - 70, sx, y);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, color + Math.round(beam * 255).toString(16).padStart(2, '0'));
      ctx.fillStyle = g;
      ctx.fillRect(sx - 6, y - 70, 12, 70);
    }
    ctx.beginPath();
    ctx.arc(sx, y, 16, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(12, 14, 18, 0.85)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = color;
    if (item.kind === 'valuable') {
      ctx.beginPath();
      ctx.moveTo(sx, y - 8); ctx.lineTo(sx + 7, y); ctx.lineTo(sx, y + 8); ctx.lineTo(sx - 7, y);
      ctx.closePath();
      ctx.fill();
    } else if (item.kind === 'armor') {
      ctx.beginPath();
      ctx.moveTo(sx, y - 9); ctx.lineTo(sx + 7, y - 6); ctx.lineTo(sx + 6, y + 3); ctx.lineTo(sx, y + 9); ctx.lineTo(sx - 6, y + 3); ctx.lineTo(sx - 7, y - 6);
      ctx.closePath();
      ctx.fill();
    } else if (item.kind === 'encrypted') {
      // A sealed case with a cyan lock: decrypt it at an uplink.
      ctx.fillRect(sx - 8, y - 3, 16, 11);
      ctx.strokeStyle = '#4fe3f7';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, y - 3, 4.5, Math.PI, 0);
      ctx.stroke();
      ctx.fillStyle = '#4fe3f7';
      ctx.fillRect(sx - 1.5, y + 1, 3, 4);
    } else if (item.kind === 'pack') {
      ctx.fillRect(sx - 7, y - 6, 14, 13);
      ctx.fillStyle = 'rgba(12,14,18,0.85)';
      ctx.fillRect(sx - 4, y - 2, 8, 2);
    } else {
      ctx.save();
      ctx.translate(sx - 2, y);
      ctx.scale(0.8, 0.8);
      ctx.fillRect(-9, -3, 20, 5);
      ctx.fillRect(-7, 1, 5, 7);
      ctx.restore();
    }
    ctx.font = '800 11px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = color;
    ctx.fillText(`${item.power}`, sx, y + 19);
    ctx.restore();
}

export function drawPlaceableSprite(ctx: CanvasRenderingContext2D, pl: Placeable, sx: number, sy: number, now = 0) {
    ctx.save();
    ctx.translate(sx, sy);

    if (pl.type === 'barrel') {
      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.ellipse(0, 12, 16, 8, 0, 0, Math.PI * 2);
      ctx.fill();

      // Red explosive barrel
      ctx.fillStyle = '#d32f2f';
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffeb3b';
      ctx.stroke();

      // Inner hazard ring & icon
      ctx.fillStyle = '#b71c1c';
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffeb3b';
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', 0, 1);
    } else if (pl.type === 'barricade') {
      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(-19, -15, 42, 34);

      // Reinforced steel/sandbag barricade
      ctx.fillStyle = '#5d4037';
      ctx.fillRect(-20, -16, 40, 32);
      ctx.strokeStyle = '#8d6e63';
      ctx.lineWidth = 2;
      ctx.strokeRect(-20, -16, 40, 32);

      // Steel cross-bracing
      ctx.fillStyle = '#78909c';
      ctx.fillRect(-18, -5, 36, 10);
      ctx.fillStyle = '#cfd8dc';
      ctx.fillRect(-14, -2, 4, 4);
      ctx.fillRect(10, -2, 4, 4);

      // Health bar if damaged
      if (pl.health < pl.maxHealth) {
        const bw = 36;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(-bw / 2, -24, bw, 4);
        ctx.fillStyle = '#ffb400';
        ctx.fillRect(-bw / 2, -24, bw * Math.max(0, pl.health / pl.maxHealth), 4);
      }
    } else if (pl.type === 'mine') {
      // Faint sensor trigger radius
      const blink = Math.sin(now / 150) > 0;
      ctx.strokeStyle = blink ? 'rgba(255, 82, 82, 0.32)' : 'rgba(255, 82, 82, 0.14)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, 38, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Mine body
      ctx.fillStyle = '#263238';
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#90a4ae';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Blinking LED
      ctx.fillStyle = blink ? '#ff1744' : '#880e4f';
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
}

export function drawDropSprite(ctx: CanvasRenderingContext2D, d: DropPickup, sx: number, sy: number, now = 0) {
    if (d.type === 'loot' && d.item) return drawLootSprite(ctx, d, sx, sy, now);
    const pulse = 0.75 + 0.25 * Math.sin(now / 200);
    const bob = Math.sin(now / 300) * 3;
    const dy = sy + bob;

    const glowColors: Record<string, string> = {
      ammo: 'rgba(255,200,0,0.25)',
      health: 'rgba(76,175,80,0.3)',
      tactical: 'rgba(255,109,0,0.3)',
    };
    const glowR = 22 + 4 * Math.sin(now / 250);
    ctx.beginPath();
    ctx.arc(sx, dy, glowR, 0, Math.PI * 2);
    ctx.fillStyle = glowColors[d.type] || 'rgba(255,255,255,0.1)';
    ctx.fill();

    const bgColors: Record<string, string> = {
      ammo: `rgba(50,40,0,${pulse})`,
      health: `rgba(0,40,10,${pulse})`,
      tactical: `rgba(55,20,0,${pulse})`,
    };
    ctx.beginPath();
    ctx.arc(sx, dy, 14, 0, Math.PI * 2);
    ctx.fillStyle = bgColors[d.type] || 'rgba(0,0,0,0.5)';
    ctx.fill();

    const ringColors: Record<string, string> = {
      ammo: '#ffb400',
      health: '#4caf50',
      tactical: '#ff6d00',
    };
    ctx.strokeStyle = ringColors[d.type] || '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (d.type === 'ammo') {
      ctx.fillStyle = '#ffd54f';
      ctx.fillRect(sx - 6, dy - 3, 4, 10);
      ctx.fillRect(sx - 1, dy - 3, 4, 10);
      ctx.fillRect(sx + 4, dy - 3, 4, 10);
      ctx.fillStyle = '#ff8f00';
      ctx.fillRect(sx - 6, dy - 5, 4, 3);
      ctx.fillRect(sx - 1, dy - 5, 4, 3);
      ctx.fillRect(sx + 4, dy - 5, 4, 3);
    } else if (d.type === 'health') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(sx - 2, dy - 8, 5, 16);
      ctx.fillRect(sx - 8, dy - 2, 16, 5);
      ctx.fillStyle = '#e53935';
      ctx.fillRect(sx - 1, dy - 7, 3, 14);
      ctx.fillRect(sx - 7, dy - 1, 14, 3);
    } else if (d.type === 'tactical') {
      ctx.fillStyle = '#ffab00';
      ctx.font = 'bold 11px monospace';
      ctx.fillText('+1', sx, dy + 1);
    }

    const labelColors: Record<string, string> = {
      ammo: '#ffd54f',
      health: '#81c784',
      tactical: '#ffab00',
    };
    const labelText: Record<string, string> = {
      ammo: 'AMMO',
      health: 'HEALTH',
      tactical: 'DEPLOYABLE',
    };
    ctx.fillStyle = labelColors[d.type] || '#fff';
    ctx.font = 'bold 8px monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(labelText[d.type] || '', sx, dy + 16);
}

export function drawGunSprite(ctx: CanvasRenderingContext2D, weapon: Weapon) {
    // Gun
    ctx.fillStyle = '#424242';
    if (weapon === 'pistol') {
      ctx.fillRect(15, -4, 18, 8);
    } else if (weapon === 'uzi') {
      ctx.fillRect(12, -4, 20, 8);
      ctx.fillRect(20, -6, 4, 12);
    } else if (weapon === 'shotgun') {
      ctx.fillRect(10, -5, 26, 10);
      ctx.fillStyle = '#795548';
      ctx.fillRect(10, -4, 8, 8);
    } else if (weapon === 'rocketLauncher') {
      ctx.fillRect(8, -6, 28, 12);
      ctx.fillStyle = '#795548';
      ctx.fillRect(8, -4, 8, 8);
      ctx.fillStyle = '#f44336';
      ctx.beginPath();
      ctx.arc(34, 0, 5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(15, -4, 18, 8);
    }
    ctx.strokeRect(15, -4, 18, 8);

}
