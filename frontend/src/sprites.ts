import type { ZombieType, Placeable, DropPickup, Weapon } from './generated/types';

export function drawEnemySprite(ctx: CanvasRenderingContext2D, type: ZombieType, sx: number, sy: number, angle = 0): number {
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
      ctx.fillText('TNT', 0, 1);
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
    const pulse = 0.75 + 0.25 * Math.sin(now / 200);
    const bob = Math.sin(now / 300) * 3;
    const dy = sy + bob;

    const glowColors: Record<string, string> = {
      ammo: 'rgba(255,200,0,0.25)',
      health: 'rgba(76,175,80,0.3)',
      weapon: 'rgba(156,39,176,0.3)',
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
      weapon: `rgba(40,0,50,${pulse})`,
      tactical: `rgba(55,20,0,${pulse})`,
    };
    ctx.beginPath();
    ctx.arc(sx, dy, 14, 0, Math.PI * 2);
    ctx.fillStyle = bgColors[d.type] || 'rgba(0,0,0,0.5)';
    ctx.fill();

    const ringColors: Record<string, string> = {
      ammo: '#ffb400',
      health: '#4caf50',
      weapon: '#ce93d8',
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
    } else if (d.type === 'weapon') {
      ctx.fillStyle = '#ce93d8';
      ctx.fillRect(sx - 2, dy - 8, 5, 10);
      ctx.fillRect(sx - 6, dy - 2, 13, 5);
      ctx.fillRect(sx - 4, dy + 3, 4, 6);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 8px sans-serif';
      ctx.fillText('\u2605', sx + 5, dy - 5);
    } else if (d.type === 'tactical') {
      ctx.fillStyle = '#ffab00';
      ctx.font = 'bold 11px monospace';
      ctx.fillText('TAC', sx, dy + 1);
    }

    const labelColors: Record<string, string> = {
      ammo: '#ffd54f',
      health: '#81c784',
      weapon: '#ce93d8',
      tactical: '#ffab00',
    };
    const labelText: Record<string, string> = {
      ammo: 'AMMO',
      health: 'HEALTH',
      weapon: 'WEAPON',
      tactical: 'GEAR',
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
