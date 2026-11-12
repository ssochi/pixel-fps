import { TAU, bbox, mulberry32, resampleClosed, tracePoly } from './util.js';

export const BASE_Y = 104; // 捏捏底部所在的高度
export const FLOOR_Y = 108; // 桌面

// ---------- 用 SDF 捏造型：圆、椭圆、圆角盒、胶囊 + 平滑并集 ----------
const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const ellipse = (cx, cy, rx, ry) => (x, y) => (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry);
const rbox = (cx, cy, hw, hh, rad) => (x, y) => {
  const dx = Math.abs(x - cx) - (hw - rad), dy = Math.abs(y - cy) - (hh - rad);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - rad;
};
const capsule = (ax, ay, bx, by, r) => (x, y) => {
  const px = x - ax, py = y - ay, ex = bx - ax, ey = by - ay;
  const t = Math.max(0, Math.min(1, (px * ex + py * ey) / (ex * ex + ey * ey)));
  return Math.hypot(px - ex * t, py - ey * t) - r;
};
const smin = (k, ...fs) => (x, y) => {
  let d = fs[0](x, y);
  for (let i = 1; i < fs.length; i++) {
    const e = fs[i](x, y), h = Math.max(k - Math.abs(d - e), 0) / k;
    d = Math.min(d, e) - h * h * k * 0.25;
  }
  return d;
};

/** 从中心向外打射线描出轮廓（造型都是星形的），再归一化到"坐在桌面上" */
function traceOutline(sdf, lift = 0, n = 128) {
  const raw = [], steps = n * 3;
  for (let i = 0; i < steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * TAU, dx = Math.cos(a), dy = Math.sin(a);
    let r = 260;
    while (r > 0 && sdf(dx * r, dy * r) > 0) r -= 2;
    let lo = r, hi = r + 2;
    for (let k = 0; k < 16; k++) {
      const m = (lo + hi) / 2;
      if (sdf(dx * m, dy * m) > 0) hi = m; else lo = m;
    }
    raw.push([dx * lo, dy * lo]);
  }
  const bb = bbox(raw);
  const ox = -(bb.x + bb.x1) / 2, oy = BASE_Y - lift - bb.y1;
  const outline = resampleClosed(raw, n).map((p) => [p[0] + ox, p[1] + oy]);
  const b = bbox(outline);
  return {
    outline,
    m: { ox, oy, left: b.x, top: b.y, w: b.w, h: b.h, right: b.x1, bottom: b.y1, cx: b.x + b.w / 2, cy: b.y + b.h / 2 },
  };
}

// ---------- 脆皮上的花纹 ----------
function speckle(g, m, rng, n, color, r0, r1, a0, a1) {
  g.fillStyle = color;
  for (let i = 0; i < n; i++) {
    g.globalAlpha = a0 + rng() * (a1 - a0);
    g.beginPath();
    g.arc(m.left + rng() * m.w, m.top + rng() * m.h, r0 + rng() * (r1 - r0), 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;
}

const decor = {
  avocado(g, m, rng) {
    speckle(g, m, rng, 320, '#9cc46a', 0.8, 2.4, 0.1, 0.32);
    speckle(g, m, rng, 260, '#16300f', 0.8, 2.6, 0.12, 0.34);
  },
  lemon(g, m, rng) {
    speckle(g, m, rng, 230, '#d99a00', 0.7, 1.6, 0.18, 0.4);
    speckle(g, m, rng, 120, '#fffbd6', 0.6, 1.3, 0.3, 0.6);
  },
  tomato(g, m) {
    g.save();
    g.translate(m.ox, m.top + 13);
    const leaf = (ang, len) => {
      g.save(); g.rotate(ang);
      g.beginPath(); g.moveTo(0, -4);
      g.quadraticCurveTo(11, len * 0.4, 0, len);
      g.quadraticCurveTo(-11, len * 0.4, 0, -4);
      g.fillStyle = '#3f9a3c'; g.fill();
      g.strokeStyle = 'rgba(20,70,25,.55)'; g.lineWidth = 1; g.stroke();
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0, len * 0.8);
      g.strokeStyle = 'rgba(210,240,170,.5)'; g.stroke();
      g.restore();
    };
    [-1.35, -0.7, 0, 0.7, 1.35].forEach((a, i) => leaf(a, i % 2 ? 40 : 34));
    g.fillStyle = '#2f7d31';
    g.beginPath(); g.arc(0, -2, 6, 0, TAU); g.fill();
    g.restore();
  },
  butter(g, m) {
    g.save();
    g.lineWidth = 2;
    const inset = 14, r = 12;
    for (const [dx, col] of [[1.2, 'rgba(255,255,255,.7)'], [0, 'rgba(196,140,30,.45)']]) {
      g.strokeStyle = col;
      g.beginPath();
      g.roundRect(m.left + inset + dx, m.top + inset + dx, m.w - inset * 2, m.h - inset * 2, r);
      g.stroke();
    }
    g.font = '800 30px "Arial Rounded MT Bold", "Trebuchet MS", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if ('letterSpacing' in g) g.letterSpacing = '5px';
    g.fillStyle = 'rgba(255,255,255,.8)'; g.fillText('BUTTER', m.cx + 1.4, m.cy + 2.4);
    g.fillStyle = 'rgba(206,150,34,.75)'; g.fillText('BUTTER', m.cx, m.cy + 1);
    g.restore();
  },
  egg(g, m, rng) {
    speckle(g, m, rng, 90, '#9a6a3c', 0.7, 2.3, 0.15, 0.45);
  },
  icebar(g, m, rng) {
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = '#9a6a42'; g.lineWidth = 5;
    g.beginPath();
    for (let y = m.top + 26, i = 0; y < m.bottom - 12; y += 21, i++) {
      const x0 = m.left - 8, x1 = m.right + 8;
      if (i === 0) g.moveTo(i % 2 ? x1 : x0, y);
      g.lineTo(i % 2 ? x0 : x1, y + 15);
    }
    g.stroke();
    for (let i = 0; i < 34; i++) {
      const x = m.left + rng() * m.w, y = m.top + rng() * m.h, s = 2.2 + rng() * 3.2;
      g.save(); g.translate(x, y); g.rotate(rng() * TAU);
      g.beginPath(); g.moveTo(-s, -s * 0.5); g.lineTo(s * 0.7, -s * 0.8); g.lineTo(s, s * 0.4); g.lineTo(-s * 0.4, s * 0.8);
      g.closePath();
      g.fillStyle = rng() < 0.5 ? '#f0cf93' : '#dcae6a'; g.fill();
      g.strokeStyle = 'rgba(90,50,20,.5)'; g.lineWidth = 0.7; g.stroke();
      g.restore();
    }
    g.restore();
  },
  bone(g, m, rng) {
    speckle(g, m, rng, 40, '#b9a988', 0.6, 1.4, 0.12, 0.3);
  },
  bear(g, m) {
    const X = (x) => x + m.ox, Y = (y) => y + m.oy;
    g.fillStyle = '#f2b8a4';
    for (const s of [-1, 1]) { g.beginPath(); g.arc(X(s * 64), Y(-62), 15, 0, TAU); g.fill(); }
    g.fillStyle = '#f6e3c8';
    g.beginPath(); g.ellipse(X(0), Y(38), 34, 26, 0, 0, TAU); g.fill();
    g.fillStyle = '#4a2c20';
    for (const s of [-1, 1]) { g.beginPath(); g.arc(X(s * 34), Y(4), 6.5, 0, TAU); g.fill(); }
    g.beginPath(); g.ellipse(X(0), Y(27), 9, 6.5, 0, 0, TAU); g.fill();
    g.strokeStyle = '#4a2c20'; g.lineWidth = 2.4; g.lineCap = 'round';
    g.beginPath(); g.moveTo(X(0), Y(33)); g.lineTo(X(0), Y(41));
    g.moveTo(X(-10), Y(43)); g.quadraticCurveTo(X(-4), Y(50), X(0), Y(41)); g.quadraticCurveTo(X(4), Y(50), X(10), Y(43));
    g.stroke();
    g.fillStyle = '#fff';
    for (const s of [-1, 1]) { g.beginPath(); g.arc(X(s * 34 - 2), Y(2), 2, 0, TAU); g.fill(); }
  },
};

// ---------- 款式 ----------
export const PRESETS = [
  {
    id: 'avocado', name: '牛油果', shellType: 'std', coreType: 'slow',
    sdf: smin(46, circle(0, -58, 44), circle(0, 28, 74)),
    shell: { hi: '#6f9c45', mid: '#3f6b2a', lo: '#1f3d17', side: '#dcebb0' },
    core: { hi: '#fbffd0', mid: '#dcea86', lo: '#a9c552' },
    face: { y: 22, s: 1.1 }, decor: decor.avocado,
  },
  {
    id: 'lemon', name: '柠檬', shellType: 'thin', coreType: 'jelly',
    sdf: smin(24, ellipse(0, 0, 98, 70), circle(-100, 0, 15), circle(100, 0, 15)),
    shell: { hi: '#fff28a', mid: '#ffd93b', lo: '#eaa800', side: '#fff9d6' },
    core: { hi: '#ffffff', mid: '#fff6b8', lo: '#f6dd6a' },
    face: { y: 2, s: 1 }, decor: decor.lemon,
  },
  {
    id: 'tomato', name: '番茄', shellType: 'std', coreType: 'slow',
    sdf: smin(16, ellipse(-40, 2, 66, 76), ellipse(40, 2, 66, 76), ellipse(0, 6, 62, 80)),
    shell: { hi: '#ff8a70', mid: '#f0402f', lo: '#b3161b', side: '#ffd9cf' },
    core: { hi: '#ffe1da', mid: '#ffa79a', lo: '#f0716a' },
    face: { y: 12, s: 1.15 }, decor: decor.tomato,
  },
  {
    id: 'butter', name: '黄油块', shellType: 'thick', coreType: 'clay',
    sdf: rbox(0, 0, 106, 62, 20),
    shell: { hi: '#fff8cf', mid: '#ffe68a', lo: '#efc04e', side: '#fffdf0' },
    core: { hi: '#fffef2', mid: '#fff0b8', lo: '#f2d27a' },
    face: { y: 2, s: 1 }, decor: decor.butter,
  },
  {
    id: 'egg', name: '溏心蛋', shellType: 'thin', coreType: 'jelly',
    sdf: smin(40, circle(0, -34, 54), circle(0, 20, 76)),
    shell: { hi: '#ffffff', mid: '#f7ecdb', lo: '#d9c3a3', side: '#ffffff', rim: '120,90,50' },
    core: { hi: '#ffe58a', mid: '#ffbe2e', lo: '#f08a12' },
    face: { y: 16, s: 1.1 }, decor: decor.egg,
  },
  {
    id: 'icebar', name: '脆皮雪糕', shellType: 'thick', coreType: 'slow', lift: 30,
    sdf: rbox(0, 0, 62, 96, 38),
    shell: { hi: '#8c5a36', mid: '#5c3520', lo: '#33190c', side: '#a9794f' },
    core: { hi: '#ffffff', mid: '#fff3dc', lo: '#ecd3a8' },
    face: { y: -4, s: 1 }, decor: decor.icebar,
  },
  {
    id: 'bone', name: '骨头', shellType: 'std', coreType: 'clay',
    sdf: smin(14, capsule(-64, 0, 64, 0, 25), circle(-76, -27, 30), circle(-76, 27, 30), circle(76, -27, 30), circle(76, 27, 30)),
    shell: { hi: '#ffffff', mid: '#f6efdf', lo: '#d3c4a4', side: '#ffffff', rim: '120,95,60' },
    core: { hi: '#fff0f4', mid: '#ffc4d3', lo: '#f590ad' },
    face: { y: 0, s: 0.8 }, gloss: [0.14, 0.24], decor: decor.bone,
  },
  {
    id: 'bear', name: '小熊', shellType: 'std', coreType: 'slow',
    sdf: smin(12, circle(0, 12, 86), circle(-64, -62, 30), circle(64, -62, 30)),
    shell: { hi: '#e0a66e', mid: '#bd7d48', lo: '#84502a', side: '#f3d7b5' },
    core: { hi: '#fffaf0', mid: '#ffe6c2', lo: '#f0c48c' },
    face: { y: 18, s: 1.25 }, decor: decor.bear,
  },
];

export const SHELL_TYPES = {
  thin: { name: '薄脆', cells: 150, tough: 0.34, th: 1.6, spread: [0.1, 0.5, 0.6] },
  std: { name: '标准', cells: 100, tough: 0.52, th: 2.6, spread: [0.1, 0.5, 0.55] },
  thick: { name: '厚蜡', cells: 62, tough: 0.78, th: 4.2, spread: [0.16, 0.56, 0.55] },
};

export const CORE_TYPES = {
  // w/zeta：回弹的快慢和阻尼；ks：邻居之间的牵连（越小越像"慢回弹海绵"，形变留得住）
  slow: { name: '慢回弹', w: 4.6, zeta: 2, ks: 0.006, bulge: 15, dentTau: 0.9, plastic: false },
  clay: { name: '黏土', w: 5, zeta: 1.8, ks: 0.008, bulge: 10, dentTau: 40, plastic: true },
  jelly: { name: '爆浆', w: 10, zeta: 0.2, ks: 0.02, bulge: 20, dentTau: 0.14, plastic: false },
};

const outlineCache = new Map();
export function getOutline(preset) {
  if (!outlineCache.has(preset.id)) outlineCache.set(preset.id, traceOutline(preset.sdf, preset.lift || 0));
  return outlineCache.get(preset.id);
}

/** 把完整的脆皮（底色 + 花纹 + 蜡质高光）画成一张贴图，碎片都从这张图上裁 */
export function buildShellTexture(preset, scale, seed = 7) {
  const { outline, m } = getOutline(preset);
  const pad = 6;
  const bx = m.left - pad, by = m.top - pad, bw = m.w + pad * 2, bh = m.h + pad * 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(bw * scale);
  canvas.height = Math.ceil(bh * scale);
  const g = canvas.getContext('2d');
  g.setTransform(scale, 0, 0, scale, -bx * scale, -by * scale);
  g.beginPath(); tracePoly(g, outline);
  g.save(); g.clip();

  const sh = preset.shell;
  const base = g.createRadialGradient(m.left + m.w * 0.32, m.top + m.h * 0.26, 4, m.cx, m.cy, Math.max(m.w, m.h) * 0.74);
  base.addColorStop(0, sh.hi); base.addColorStop(0.5, sh.mid); base.addColorStop(1, sh.lo);
  g.fillStyle = base; g.fillRect(bx, by, bw, bh);

  preset.decor?.(g, m, mulberry32(seed));

  // 边缘压暗 + 底部阴影，做出鼓鼓的体积感
  const rim = sh.rim || '50,22,8';
  g.lineJoin = 'round';
  for (const [lw, a] of [[30, 0.07], [18, 0.08], [8, 0.1]]) {
    g.strokeStyle = `rgba(${rim},${a})`; g.lineWidth = lw;
    g.beginPath(); tracePoly(g, outline); g.stroke();
  }
  const bot = g.createLinearGradient(0, m.top + m.h * 0.55, 0, m.bottom);
  bot.addColorStop(0, `rgba(${rim},0)`); bot.addColorStop(1, `rgba(${rim},0.2)`);
  g.fillStyle = bot; g.fillRect(bx, by, bw, bh);

  // 蜡质高光
  const [gx, gy] = preset.gloss || [0.3, 0.2];
  const hx = m.left + m.w * gx, hy = m.top + m.h * gy;
  const soft = g.createRadialGradient(hx, hy, 0, hx, hy, Math.min(m.w, m.h) * 0.5);
  soft.addColorStop(0, 'rgba(255,255,255,.42)'); soft.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = soft; g.fillRect(bx, by, bw, bh);
  g.save(); g.translate(hx, hy); g.rotate(-0.5);
  g.fillStyle = 'rgba(255,255,255,.62)';
  g.beginPath(); g.ellipse(0, 0, Math.min(m.w, m.h) * 0.13, Math.min(m.w, m.h) * 0.04, 0, 0, TAU); g.fill();
  g.beginPath(); g.ellipse(Math.min(m.w, m.h) * 0.2, 2, Math.min(m.w, m.h) * 0.03, Math.min(m.w, m.h) * 0.022, 0, 0, TAU); g.fill();
  g.restore();

  g.restore();
  return { canvas, scale, bx, by, bw, bh };
}
