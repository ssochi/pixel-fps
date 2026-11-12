// 款式：每款 = 一个 3D SDF 造型 + 表面细节（刀口、纹路、坚果粒）+ 脆皮配色 + 内芯配色
import { clamp, lerp, smoothstep } from './util.js';

// ---------- 噪声 ----------
function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const c = (a, b, d) => hash3(xi + a, yi + b, zi + d);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}
const fbm = (x, y, z) => noise3(x, y, z) * 0.6 + noise3(x * 2.1 + 7, y * 2.1 + 3, z * 2.1 + 5) * 0.3 + noise3(x * 4.3, y * 4.3, z * 4.3) * 0.1;

// ---------- SDF ----------
const ellipsoid = (cy, rx, ry, rz) => (x, y, z) => (Math.hypot(x / rx, (y - cy) / ry, z / rz) - 1) * Math.min(rx, ry, rz);
const rbox = (cy, hx, hy, hz, r) => (x, y, z) => {
  const dx = Math.abs(x) - hx + r, dy = Math.abs(y - cy) - hy + r, dz = Math.abs(z) - hz + r;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dy, dz), 0) - r;
};
const capsuleX = (cy, half, r, sy) => (x, y, z) => {
  const px = x - clamp(x, -half, half), py = (y - cy) / sy;
  return Math.hypot(px, py, z) - r;
};
/** 切出平底，让它稳稳坐在盘子上（带一点圆角） */
const seated = (f, k = 0.1) => (x, y, z) => {
  const a = f(x, y, z), b = -y;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
};

const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const line = (t, w) => { const d = t - Math.round(t); return Math.exp(-(d * d) / (w * w)); };

/** 烤色：底部和刀口浅，顶上深，带一点不均匀 */
function baked(p, g, pal, top) {
  const t = clamp(smoothstep(0.08, top, p[1]) * 0.8 + (fbm(p[0] * 2.3, p[1] * 2.3, p[2] * 2.3) - 0.5) * 0.7, 0, 1);
  let c = mix3(pal[0], pal[1], smoothstep(0, 0.55, t));
  c = mix3(c, pal[2], smoothstep(0.5, 1, t));
  return mix3(c, pal[3], g * 0.9);
}

/**
 * detail(p, dir) → [径向偏移, 纹路强度 0~1]
 * color(p, g) → sRGB [r,g,b]
 */
export const FOODS = [
  {
    id: 'crossbun', name: '十字餐包', shellType: 'std', coreType: 'vaseline',
    sdf: seated(ellipsoid(0.26, 1.0, 0.74, 1.0)), center: [0, 0.3, 0],
    detail(p, d) {
      const top = smoothstep(0.1, 0.5, d[1]);
      const g = Math.max(Math.exp(-((p[0] / 0.085) ** 2)), Math.exp(-((p[2] / 0.085) ** 2))) * top;
      return [-0.085 * g + 0.035 * (1 - g) * top, g];
    },
    pal: [0xfbe6ae, 0xeeb556, 0xc6792a, 0xfff1c9].map(hex),
    color(p, g) { return baked(p, g, this.pal, 0.85); },
    rough: 0.5, wall: 0xfff6dc, core: 0xffcf73,
  },
  {
    id: 'pineapple', name: '菠萝包', shellType: 'std', coreType: 'vaseline',
    sdf: seated(ellipsoid(0.3, 0.98, 0.8, 0.98)), center: [0, 0.32, 0],
    detail(p, d) {
      const top = smoothstep(0.02, 0.3, d[1]);
      const g = Math.max(line((p[0] + p[2]) * 1.9, 0.11), line((p[0] - p[2]) * 1.9, 0.11)) * top;
      return [-0.05 * g + 0.02 * (1 - g) * top, g];
    },
    pal: [0xfbe9a6, 0xf6cf5a, 0xdc9a2e, 0xfff0b0].map(hex),
    color(p, g) {
      const c = baked(p, g, this.pal, 1.1);
      const s = noise3(p[0] * 26, p[1] * 26, p[2] * 26) > 0.74 ? 0.1 : 0; // 砂糖粒
      return [c[0] + s, c[1] + s, c[2] + s];
    },
    rough: 0.62, wall: 0xfff6d0, core: 0xffc44a,
  },
  {
    id: 'milkstick', name: '牛奶棒', shellType: 'thin', coreType: 'vaseline',
    sdf: seated(capsuleX(0.3, 0.72, 0.5, 0.82)), center: [0, 0.3, 0],
    detail(p, d) {
      const top = smoothstep(0.25, 0.6, d[1] + Math.abs(d[0]) * 0.5);
      const g = line((p[0] + p[2] * 0.7) * 1.55, 0.09) * top * (Math.abs(p[0]) < 1.02 ? 1 : 0);
      return [-0.05 * g, g];
    },
    pal: [0xfff3cf, 0xfbdc8e, 0xe7a94c, 0xfffbe8].map(hex),
    color(p, g) { return baked(p, g, this.pal, 1.0); },
    rough: 0.48, wall: 0xfffbea, core: 0xffe6a6,
  },
  {
    id: 'ganache', name: '生巧砖', shellType: 'thick', coreType: 'vaseline',
    sdf: seated(rbox(0.4, 0.86, 0.42, 0.6, 0.13), 0.05), center: [0, 0.4, 0],
    detail(p) { return [(fbm(p[0] * 5, p[1] * 5, p[2] * 5) - 0.5) * 0.02, 0]; },
    color(p) {
      const n = fbm(p[0] * 1.6, p[1] * 1.6, p[2] * 1.6);
      const dust = smoothstep(0.6, 0.84, p[1]) * (0.35 + 0.65 * fbm(p[0] * 4, 5, p[2] * 4)); // 顶上撒的可可粉
      return mix3(mix3(hex(0x33190f), hex(0x44241a), n), hex(0x7a4e36), dust * 0.6);
    },
    rough: 0.36, wall: 0x6b4027, core: 0xf6d9ae,
  },
  {
    id: 'nutball', name: '坚果巧克力球', shellType: 'thick', coreType: 'vaseline',
    sdf: seated(ellipsoid(0.82, 0.88, 0.88, 0.88), 0.14), center: [0, 0.8, 0],
    bump(p) { return smoothstep(0.5, 0.78, noise3(p[0] * 4.6 + 11, p[1] * 4.6 + 3, p[2] * 4.6 + 7)); },
    detail(p) { return [0.085 * this.bump(p), 0]; },
    color(p) {
      const b = this.bump(p), n = fbm(p[0] * 3, p[1] * 3, p[2] * 3);
      return mix3(mix3(hex(0x4a2814), hex(0x7a4826), n), hex(0xb9824a), b * 0.45);
    },
    rough: 0.32, wall: 0x8a5a36, core: 0xc98a4e,
  },
  {
    id: 'daifuku', name: '草莓大福', shellType: 'thin', coreType: 'vaseline',
    sdf: seated(ellipsoid(0.34, 0.95, 0.74, 0.95), 0.2), center: [0, 0.36, 0],
    detail(p) { return [(fbm(p[0] * 2.2, p[1] * 2.2, p[2] * 2.2) - 0.5) * 0.05, 0]; },
    color(p) {
      const blush = Math.exp(-(((p[0] - 0.1) / 0.5) ** 2 + ((p[2] - 0.45) / 0.5) ** 2)) * smoothstep(0.2, 0.7, p[1]);
      const n = fbm(p[0] * 4, p[1] * 4, p[2] * 4);
      return mix3(mix3(hex(0xf6e9e2), hex(0xffffff), n), hex(0xf9b9c2), blush * 0.75);
    },
    rough: 0.92, wall: 0xffffff, core: 0xff8ea3,
  },
];

export const SHELL_TYPES = {
  // limit：能承受多少弯折才裂；spread：裂纹往邻居传多远
  thin: { name: '薄脆', cells: 170, limit: 0.016, th: 0.02, spread: [0.25, 0.6, 0.62] },
  std: { name: '标准', cells: 115, limit: 0.027, th: 0.03, spread: [0.2, 0.6, 0.56] },
  thick: { name: '厚蜡', cells: 72, limit: 0.045, th: 0.046, spread: [0.2, 0.6, 0.5] },
};

export const CORE_TYPES = {
  // plastic：捏了不回弹；depth：一下最多按多深；sink：陷下去的快慢；ooze：会不会从裂缝里挤出来
  vaseline: { name: '凡士林', plastic: true, depth: 0.56, sink: 0.4, ooze: true, rough: 0.3, gloss: 1.25 },
  clay: { name: '黏土', plastic: true, depth: 0.32, sink: 0.6, ooze: false, rough: 0.92, gloss: 0.6 },
  slow: { name: '慢回弹', plastic: false, depth: 0.52, sink: 0.55, back: 1.15, ooze: false, rough: 0.8, gloss: 0.8 },
};
