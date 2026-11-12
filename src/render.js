import { CRACKED } from './round.js';
import { BASE_Y, FLOOR_Y } from './shapes.js';
import { TAU, tracePoly } from './util.js';

const tmp = [0, 0];
const easeOutBack = (t) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;

export function drawTable(ctx, view, colors) {
  const top = FLOOR_Y - 30;
  const g = ctx.createLinearGradient(0, top, 0, view.bottom);
  g.addColorStop(0, colors.table0); g.addColorStop(1, colors.table1);
  ctx.fillStyle = g;
  ctx.fillRect(view.left, top, view.right - view.left, view.bottom - top);
  ctx.fillStyle = colors.tableEdge;
  ctx.fillRect(view.left, top, view.right - view.left, 1.6);
}

function bodyPath(ctx, b) {
  const n = b.ring, x = b.x, y = b.y;
  ctx.beginPath();
  ctx.moveTo((x[n - 1] + x[0]) / 2, (y[n - 1] + y[0]) / 2);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    ctx.quadraticCurveTo(x[i], y[i], (x[i] + x[j]) / 2, (y[i] + y[j]) / 2);
  }
  ctx.closePath();
}

const pinPos = (b, p) => { b.disp(p.at, tmp); return [p.x + tmp[0], p.y + tmp[1]]; };

function drawCore(ctx, round) {
  const b = round.body, m = round.m, c = round.preset.core;
  let cx = 0, cy = 0;
  for (let i = 0; i < b.ring; i++) { cx += b.x[i]; cy += b.y[i]; }
  cx /= b.ring; cy /= b.ring;
  const jelly = round.beads.length > 0;

  bodyPath(ctx, b);
  const g = ctx.createRadialGradient(cx - m.w * 0.18, cy - m.h * 0.22, 4, cx, cy, Math.max(m.w, m.h) * 0.72);
  g.addColorStop(0, c.hi); g.addColorStop(0.55, c.mid); g.addColorStop(1, c.lo);
  ctx.fillStyle = g;
  ctx.fill();

  ctx.save();
  ctx.clip();
  ctx.lineJoin = 'round';
  for (const [lw, a] of [[30, 0.06], [17, 0.07], [7, 0.09]]) {
    ctx.strokeStyle = `rgba(120,50,30,${a})`; ctx.lineWidth = lw;
    bodyPath(ctx, b); ctx.stroke();
  }

  if (jelly) {
    // 爆浆：里面漂着亮片
    for (const bead of round.beads) {
      const [x, y] = pinPos(b, bead);
      const tw = 0.55 + 0.45 * Math.sin(round.time * 3 + bead.tw);
      ctx.globalAlpha = bead.white ? 0.5 + 0.4 * tw : 0.5;
      ctx.fillStyle = bead.white ? '#fff' : c.lo;
      ctx.beginPath(); ctx.arc(x, y, bead.r, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // 指印：左上暗、右下亮，看起来才是"凹进去"的
  const dc = round.dentRGB;
  for (const d of round.dents) {
    const R = 22 + 12 * d.depth, k = Math.min(1, d.depth);
    let gr = ctx.createRadialGradient(d.x - 2, d.y - 3, 0, d.x, d.y, R);
    gr.addColorStop(0, `rgba(${dc},${0.5 * k})`);
    gr.addColorStop(0.6, `rgba(${dc},${0.22 * k})`);
    gr.addColorStop(1, `rgba(${dc},0)`);
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(d.x, d.y, R, 0, TAU); ctx.fill();
    gr = ctx.createRadialGradient(d.x - R * 0.2, d.y - R * 0.25, R * 0.5, d.x - R * 0.2, d.y - R * 0.25, R * 1.12);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.72, `rgba(255,255,255,${0.2 * k})`);
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(d.x, d.y, R * 1.05, 0, TAU); ctx.fill();
  }

  // 高光
  const [hx, hy] = pinPos(b, round.gloss);
  const hr = Math.min(m.w, m.h) * 0.24;
  const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, hr);
  hg.addColorStop(0, 'rgba(255,255,255,.6)'); hg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hg;
  ctx.beginPath(); ctx.arc(hx, hy, hr, 0, TAU); ctx.fill();

  drawFace(ctx, round);
  ctx.restore();

  // 轮廓线：浅色内芯在浅色背景上也立得住
  ctx.strokeStyle = 'rgba(130,60,35,.3)'; ctx.lineWidth = 1.1; ctx.lineJoin = 'round';
  bodyPath(ctx, b); ctx.stroke();
}

function drawFace(ctx, round) {
  const b = round.body, f = round.face, s = f.s;
  const squeezed = round.pressing;
  const blink = !squeezed && round.time % 3.6 > 3.48;
  ctx.fillStyle = 'rgba(255,110,130,.34)';
  for (const p of f.blush) {
    const [x, y] = pinPos(b, p);
    ctx.beginPath(); ctx.ellipse(x, y, 7 * s, 4.2 * s, 0, 0, TAU); ctx.fill();
  }
  ctx.strokeStyle = ctx.fillStyle = '#4a2c20';
  ctx.lineWidth = 2.2 * s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  f.eyes.forEach((p, i) => {
    const [x, y] = pinPos(b, p), dir = i ? -1 : 1;
    if (squeezed) {
      // 被捏的时候 > <
      ctx.beginPath();
      ctx.moveTo(x - 4 * s * dir, y - 4 * s); ctx.lineTo(x + 3.5 * s * dir, y); ctx.lineTo(x - 4 * s * dir, y + 4 * s);
      ctx.stroke();
    } else if (blink) {
      ctx.beginPath(); ctx.moveTo(x - 4 * s, y); ctx.lineTo(x + 4 * s, y); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.ellipse(x, y, 3.8 * s, 5 * s, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x - 1.2 * s, y - 1.8 * s, 1.4 * s, 0, TAU); ctx.fill();
      ctx.fillStyle = '#4a2c20';
    }
  });
  const [mx, my] = pinPos(b, f.mouth);
  ctx.beginPath();
  if (squeezed) ctx.ellipse(mx, my + 1.5 * s, 3 * s, 3.8 * s, 0, 0, TAU);
  else { ctx.moveTo(mx - 5 * s, my); ctx.quadraticCurveTo(mx, my + 6 * s, mx + 5 * s, my); }
  ctx.stroke();
}

function drawSprite(ctx, sp, cx, cy, x, y, rot, sy = 1, scale = 1) {
  ctx.save();
  ctx.translate(x, y);
  if (sy !== 1 || scale !== 1) ctx.scale(scale, sy * scale);
  if (rot) ctx.rotate(rot);
  ctx.drawImage(sp.canvas, sp.x - cx, sp.y - cy, sp.w, sp.h);
  ctx.restore();
}

export function drawRound(ctx, round, alpha = 1) {
  const b = round.body, m = round.m, t = round.tex;
  ctx.globalAlpha = alpha;

  // 接触阴影
  const sw = m.w * 0.5;
  const sg = ctx.createRadialGradient(m.cx, FLOOR_Y + 2, 2, m.cx, FLOOR_Y + 2, sw);
  sg.addColorStop(0, 'rgba(120,60,40,.28)'); sg.addColorStop(1, 'rgba(120,60,40,0)');
  ctx.save();
  ctx.translate(0, FLOOR_Y + 2); ctx.scale(1, 0.16); ctx.translate(0, -(FLOOR_Y + 2));
  ctx.fillStyle = sg;
  ctx.beginPath(); ctx.arc(m.cx, FLOOR_Y + 2, sw, 0, TAU); ctx.fill();
  ctx.restore();

  const spawn = Math.min(1, round.time / 0.38);
  ctx.save();
  if (spawn < 1) {
    const k = easeOutBack(spawn);
    ctx.translate(m.cx, BASE_Y); ctx.scale(k, k); ctx.translate(-m.cx, -BASE_Y);
  }

  if (round.preset.lift) {
    // 雪糕棍
    const y0 = m.bottom - 14;
    ctx.fillStyle = '#e8c690';
    ctx.beginPath(); ctx.roundRect(m.cx - 9, y0, 18, FLOOR_Y - y0 + 2, 7); ctx.fill();
    ctx.fillStyle = 'rgba(120,70,30,.18)';
    ctx.beginPath(); ctx.roundRect(m.cx + 3, y0, 6, FLOOR_Y - y0 + 2, 4); ctx.fill();
  }

  drawCore(ctx, round);

  if (round.intactDirty) round.renderIntact();
  if (round.intactAny) ctx.drawImage(round.intact, t.bx, t.by, t.bw, t.bh);
  for (const fr of round.frags) {
    if (fr.state !== CRACKED) continue;
    drawSprite(ctx, fr.sprite, fr.cx, fr.cy, fr.cx + fr.dx, fr.cy + fr.dy, fr.rot + fr.jr, 1, 1 + fr.pop * 0.07);
    if (fr.pop > 0) {
      // 刚裂开的一瞬间闪一下白
      ctx.save();
      ctx.translate(fr.dx, fr.dy);
      ctx.globalAlpha = alpha * fr.pop * 0.55;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); tracePoly(ctx, fr.poly); ctx.fill();
      ctx.restore();
      ctx.globalAlpha = alpha;
    }
  }
  ctx.restore();

  // 桌上的碎片、空中的碎片、渣渣
  for (const s of round.shards) {
    if (s.flat > 0.05) {
      ctx.fillStyle = `rgba(120,60,40,${0.12 * s.flat})`;
      ctx.beginPath(); ctx.ellipse(s.x, s.y + 2.5, s.r * 0.95, s.r * 0.32, 0, 0, TAU); ctx.fill();
    }
    drawSprite(ctx, s.sprite, s.cx, s.cy, s.x, s.y, s.a, 1 - 0.48 * s.flat);
  }
  for (const c of round.crumbs) {
    ctx.fillStyle = c.c;
    ctx.fillRect(c.x - c.s / 2, c.y - c.s / 2, c.s, c.s * (c.settled ? 0.6 : 1));
  }
  for (const p of round.puffs) {
    // 蜡粉：边缘虚化的一小团白雾
    const pr = p.r * (0.8 + p.t * 1.8);
    const pg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, pr);
    pg.addColorStop(0, 'rgba(255,255,255,.55)'); pg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = alpha * (1 - p.t);
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.arc(p.x, p.y, pr, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** 上一只留下的碎片：淡出 */
export function drawLeftovers(ctx, round, alpha) {
  ctx.globalAlpha = alpha;
  for (const s of round.shards) drawSprite(ctx, s.sprite, s.cx, s.cy, s.x, s.y, s.a, 1 - 0.48 * s.flat);
  for (const c of round.crumbs) { ctx.fillStyle = c.c; ctx.fillRect(c.x - c.s / 2, c.y - c.s / 2, c.s, c.s * 0.6); }
  ctx.globalAlpha = 1;
}
