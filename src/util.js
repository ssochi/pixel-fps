export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** 可复现的伪随机数 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 整数对 → [0,1) 的确定性哈希，用来让相邻碎片共享同一条裂缝 */
export function hash3(a, b, c) {
  let h = Math.imul(a + 1, 374761393) ^ Math.imul(b + 1, 668265263) ^ Math.imul(c + 1, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function bbox(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, x1, y1 };
}

/** 返回 { area, cx, cy }，area 取绝对值 */
export function polyStats(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const k = p[0] * q[1] - q[0] * p[1];
    a += k;
    cx += (p[0] + q[0]) * k;
    cy += (p[1] + q[1]) * k;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    for (const p of poly) { sx += p[0]; sy += p[1]; }
    return { area: 0, cx: sx / poly.length, cy: sy / poly.length };
  }
  return { area: Math.abs(a / 2), cx: cx / (3 * a), cy: cy / (3 * a) };
}

export function tracePoly(ctx, poly) {
  ctx.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
  ctx.closePath();
}

/** 闭合折线按弧长均匀重采样 */
export function resampleClosed(pts, n) {
  const m = pts.length, acc = [0];
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % m];
    acc.push(acc[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = acc[m], out = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * total;
    while (acc[k + 1] < t) k++;
    const a = pts[k], b = pts[(k + 1) % m];
    const u = (t - acc[k]) / (acc[k + 1] - acc[k] || 1);
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return out;
}

/** 半平面裁剪：保留 (p-m)·n <= 0 的一侧 */
export function clipHalfPlane(pts, mx, my, nx, ny) {
  const out = [], n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const da = (a[0] - mx) * nx + (a[1] - my) * ny;
    const db = (b[0] - mx) * nx + (b[1] - my) * ny;
    if (da <= 0) out.push(a);
    if (da <= 0 !== db <= 0) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
