import { bbox, hash3, pointInPoly, polyStats } from './util.js';

/**
 * 把轮廓预先切成 Voronoi 碎片（脆皮的"隐形裂纹"）。
 * 每个碎片记录邻居，裂纹才能沿着邻接关系一路"咔咔咔"地传出去。
 */
export function fracture(outline, count, rng) {
  const bb = bbox(outline);
  const sample = () => {
    for (;;) {
      const x = bb.x + rng() * bb.w, y = bb.y + rng() * bb.h;
      if (pointInPoly(x, y, outline)) return [x, y];
    }
  };

  // best-candidate 采样：碎片大小更均匀，但仍然不规则
  const seeds = [];
  for (let i = 0; i < count; i++) {
    let best = null, bestD = -1;
    for (let t = 0; t < (i ? 8 : 1); t++) {
      const c = sample();
      let d = Infinity;
      for (const s of seeds) {
        const q = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2;
        if (q < d) d = q;
      }
      if (d > bestD) { bestD = d; best = c; }
    }
    seeds.push(best);
  }

  const cells = [];
  const idx = seeds.map((_, i) => i);
  for (let i = 0; i < count; i++) {
    const s = seeds[i];
    let pts = outline.map((p) => [p[0], p[1]]);
    let labs = new Array(pts.length).fill(-1);
    const order = idx
      .filter((j) => j !== i)
      .sort((a, b) => dist2(seeds[a], s) - dist2(seeds[b], s));

    for (const j of order) {
      const o = seeds[j];
      const d = Math.sqrt(dist2(o, s));
      let maxR = 0;
      for (const p of pts) {
        const r = Math.hypot(p[0] - s[0], p[1] - s[1]);
        if (r > maxR) maxR = r;
      }
      if (d / 2 > maxR) break;
      [pts, labs] = clipLabeled(pts, labs, (s[0] + o[0]) / 2, (s[1] + o[1]) / 2, o[0] - s[0], o[1] - s[1], j);
      if (pts.length < 3) break;
    }

    // 去掉退化的重合点
    const cp = [], cl = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.05) { cp.push(a); cl.push(labs[k]); }
    }
    if (cp.length < 3) { cells.push(null); continue; }
    cells.push({ index: i, raw: cp, labs: cl });
  }

  // 给共享边加锯齿，让裂缝不那么"几何"
  const out = [];
  for (const c of cells) {
    if (!c) continue;
    const { raw, labs, index: i } = c;
    const poly = [];
    const neighbors = new Set();
    let boundary = false;
    for (let k = 0; k < raw.length; k++) {
      const a = raw[k], b = raw[(k + 1) % raw.length], L = labs[k];
      poly.push(a);
      if (L < 0) { boundary = true; continue; }
      if (!cells[L]) continue;
      neighbors.add(L);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 7) continue;
      const fwd = i < L;
      const A = fwd ? a : b, B = fwd ? b : a;
      const ex = B[0] - A[0], ey = B[1] - A[1];
      const lo = Math.min(i, L), hi = Math.max(i, L);
      const q = [0.36, 0.7].map((t, n) => {
        const j = (hash3(lo, hi, n) * 2 - 1) * 0.12;
        return [A[0] + ex * t - ey * j, A[1] + ey * t + ex * j];
      });
      if (fwd) poly.push(q[0], q[1]);
      else poly.push(q[1], q[0]);
    }
    const st = polyStats(poly);
    if (st.area < 1) continue;
    let r = 0;
    for (const p of poly) r = Math.max(r, Math.hypot(p[0] - st.cx, p[1] - st.cy));
    out.push({ id: i, poly, cx: st.cx, cy: st.cy, area: st.area, r, boundary, neighborIds: neighbors });
  }

  // id → 下标，并把邻接关系补成对称的
  const at = new Map(out.map((c, k) => [c.id, k]));
  for (const c of out) c.neighbors = new Set();
  out.forEach((c, k) => {
    for (const id of c.neighborIds) {
      const n = at.get(id);
      if (n === undefined) continue;
      c.neighbors.add(n);
      out[n].neighbors.add(k);
    }
  });
  for (const c of out) { c.neighbors = [...c.neighbors]; delete c.neighborIds; delete c.id; }
  return out;
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** Sutherland–Hodgman，同时给每条边打上"这条边是和谁共享的"标签 */
function clipLabeled(pts, labs, mx, my, nx, ny, label) {
  const out = [], ol = [], n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const da = (a[0] - mx) * nx + (a[1] - my) * ny;
    const db = (b[0] - mx) * nx + (b[1] - my) * ny;
    const ina = da <= 0, inb = db <= 0;
    if (ina) {
      out.push(a); ol.push(labs[i]);
      if (!inb) {
        const t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        ol.push(label);
      }
    } else if (inb) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      ol.push(labs[i]);
    }
  }
  return [out, ol];
}
