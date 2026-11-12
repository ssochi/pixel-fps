// 网格生成：测地球 → 按 SDF 鼓成食物造型 → 把表面切成一块块脆皮

/** 正二十面体细分出的测地球：顶点是单位方向，三角形共享顶点 */
export function geodesic(n) {
  const t = (1 + Math.sqrt(5)) / 2;
  const base = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  const faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const pos = [], idx = [], seen = new Map();
  const vert = (x, y, z) => {
    const l = Math.hypot(x, y, z);
    x /= l; y /= l; z /= l;
    const key = `${Math.round(x * 2e4)},${Math.round(y * 2e4)},${Math.round(z * 2e4)}`;
    let i = seen.get(key);
    if (i === undefined) { i = pos.length / 3; pos.push(x, y, z); seen.set(key, i); }
    return i;
  };
  for (const [a, b, c] of faces) {
    const A = base[a], B = base[b], C = base[c], grid = [];
    for (let i = 0; i <= n; i++) {
      grid.push([]);
      for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n, w = 1 - u - v;
        grid[i].push(vert(A[0] * w + B[0] * u + C[0] * v, A[1] * w + B[1] * u + C[1] * v, A[2] * w + B[2] * u + C[2] * v));
      }
    }
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n - i; j++) {
        idx.push(grid[i][j], grid[i + 1][j], grid[i][j + 1]);
        if (j < n - i - 1) idx.push(grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]);
      }
  }
  return { dirs: new Float32Array(pos), idx: new Uint32Array(idx) };
}

export function computeNormals(P, idx, out) {
  out.fill(0);
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l; out[i + 1] /= l; out[i + 2] /= l;
  }
  return out;
}

const sphereCache = new Map();

/** 从造型中心沿每个方向打射线，把球面顶点推到食物表面上 */
export function buildShape(food, n) {
  if (!sphereCache.has(n)) sphereCache.set(n, geodesic(n));
  const { dirs, idx } = sphereCache.get(n);
  const V = dirs.length / 3, [cx, cy, cz] = food.center;
  const P0 = new Float32Array(V * 3), groove = new Float32Array(V), col = new Float32Array(V * 3);
  const p = [0, 0, 0], d = [0, 0, 0];
  for (let i = 0; i < V; i++) {
    d[0] = dirs[i * 3]; d[1] = dirs[i * 3 + 1]; d[2] = dirs[i * 3 + 2];
    let r = 2.4;
    while (r > 0 && food.sdf(cx + d[0] * r, cy + d[1] * r, cz + d[2] * r) > 0) r -= 0.04;
    let lo = r, hi = r + 0.04;
    for (let k = 0; k < 14; k++) {
      const m = (lo + hi) / 2;
      if (food.sdf(cx + d[0] * m, cy + d[1] * m, cz + d[2] * m) > 0) hi = m; else lo = m;
    }
    p[0] = cx + d[0] * lo; p[1] = cy + d[1] * lo; p[2] = cz + d[2] * lo;
    const [dr, g] = food.detail(p, d);
    const flat = p[1] < 0.02 ? 0 : Math.min(1, p[1] / 0.12); // 底面保持平
    const rr = lo + dr * flat;
    P0[i * 3] = cx + d[0] * rr; P0[i * 3 + 1] = Math.max(0, cy + d[1] * rr); P0[i * 3 + 2] = cz + d[2] * rr;
    groove[i] = g;
  }
  const N0 = computeNormals(P0, idx, new Float32Array(V * 3));
  let top = 0, rad = 0;
  for (let i = 0; i < V; i++) {
    p[0] = P0[i * 3]; p[1] = P0[i * 3 + 1]; p[2] = P0[i * 3 + 2];
    const c = food.color(p, groove[i]);
    // 顶点色按线性空间存
    for (let k = 0; k < 3; k++) col[i * 3 + k] = Math.pow(Math.min(1, Math.max(0, c[k])), 2.2);
    top = Math.max(top, p[1]); rad = Math.max(rad, Math.hypot(p[0], p[2]));
  }
  return { V, P0, N0, idx, col, top, rad };
}

/**
 * 把表面切成脆皮碎片：从随机种子三角形出发做多源 Dijkstra，
 * 边权带随机扰动，所以每块都连通、边界又不规则。贴着盘子的底面不裹脆皮。
 */
export function buildFragments(shape, count, rng, warp = () => 0.5) {
  const wo = rng() * 50;
  const { P0, N0, idx } = shape, F = idx.length / 3;
  const cen = new Float32Array(F * 3), area = new Float32Array(F), covered = new Uint8Array(F);
  for (let f = 0; f < F; f++) {
    const a = idx[f * 3] * 3, b = idx[f * 3 + 1] * 3, c = idx[f * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) cen[f * 3 + k] = (P0[a + k] + P0[b + k] + P0[c + k]) / 3;
    const ux = P0[b] - P0[a], uy = P0[b + 1] - P0[a + 1], uz = P0[b + 2] - P0[a + 2];
    const vx = P0[c] - P0[a], vy = P0[c + 1] - P0[a + 1], vz = P0[c + 2] - P0[a + 2];
    area[f] = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    covered[f] = cen[f * 3 + 1] > 0.012 ? 1 : 0;
  }
  // 三角形邻接
  const adj = new Int32Array(F * 3).fill(-1), edges = new Map();
  for (let f = 0; f < F; f++)
    for (let e = 0; e < 3; e++) {
      const a = idx[f * 3 + e], b = idx[f * 3 + ((e + 1) % 3)];
      const key = a < b ? a * 1e6 + b : b * 1e6 + a, o = edges.get(key);
      if (o === undefined) edges.set(key, f * 3 + e);
      else { adj[f * 3 + e] = (o / 3) | 0; adj[o] = f; }
    }

  // 种子：best-candidate，让碎片大小比较均匀
  const pool = [];
  for (let f = 0; f < F; f++) if (covered[f]) pool.push(f);
  const seeds = [];
  for (let i = 0; i < count; i++) {
    let best = -1, bd = -1;
    for (let t = 0; t < (i ? 8 : 1); t++) {
      const f = pool[(rng() * pool.length) | 0];
      let d = Infinity;
      for (const s of seeds) d = Math.min(d, (cen[s * 3] - cen[f * 3]) ** 2 + (cen[s * 3 + 1] - cen[f * 3 + 1]) ** 2 + (cen[s * 3 + 2] - cen[f * 3 + 2]) ** 2);
      if (d > bd) { bd = d; best = f; }
    }
    seeds.push(best);
  }

  // 多源 Dijkstra（小顶堆）
  const owner = new Int32Array(F).fill(-1), dist = new Float64Array(F).fill(Infinity);
  const heap = [];
  const push = (d, f, o) => {
    heap.push([d, f, o]);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  seeds.forEach((f, s) => { dist[f] = 0; push(0, f, s); });
  while (heap.length) {
    const [d, f, o] = pop();
    if (owner[f] >= 0 || d > dist[f]) continue;
    owner[f] = o;
    for (let e = 0; e < 3; e++) {
      const g = adj[f * 3 + e];
      if (g < 0 || !covered[g] || owner[g] >= 0) continue;
      // 边权随位置平滑起伏（而不是逐边乱跳）：碎片边界弯弯曲曲，但不会碎成锯齿
      const w = Math.hypot(cen[g * 3] - cen[f * 3], cen[g * 3 + 1] - cen[f * 3 + 1], cen[g * 3 + 2] - cen[f * 3 + 2]) * (0.55 + 0.9 * warp(cen[g * 3] * 3.1 + wo, cen[g * 3 + 1] * 3.1, cen[g * 3 + 2] * 3.1));
      if (d + w < dist[g]) { dist[g] = d + w; push(d + w, g, o); }
    }
  }

  // 边界沿着三角网格走会是一排锯齿：把边界上的顶点朝两侧邻居拉直几轮，裂缝就是干净的折线
  const link = new Map();
  const tie = (a, b) => { (link.get(a) || link.set(a, []).get(a)).push(b); };
  for (let f = 0; f < F; f++)
    for (let e = 0; e < 3; e++) {
      const g = adj[f * 3 + e];
      if (g < f || owner[g] === owner[f]) continue;
      const a = idx[f * 3 + e], b = idx[f * 3 + ((e + 1) % 3)];
      tie(a, b); tie(b, a);
    }
  for (let it = 0; it < 3; it++) {
    const next = [];
    for (const [v, nb] of link) {
      if (nb.length !== 2 || P0[v * 3 + 1] < 0.02) continue; // 三岔口和贴盘子的一圈不动
      const a = nb[0] * 3, b = nb[1] * 3, j = v * 3;
      next.push(v, P0[j] * 0.4 + (P0[a] + P0[b]) * 0.3, P0[j + 1] * 0.4 + (P0[a + 1] + P0[b + 1]) * 0.3, P0[j + 2] * 0.4 + (P0[a + 2] + P0[b + 2]) * 0.3);
    }
    for (let k = 0; k < next.length; k += 4) { const j = next[k] * 3; P0[j] = next[k + 1]; P0[j + 1] = next[k + 2]; P0[j + 2] = next[k + 3]; }
  }
  computeNormals(P0, idx, N0);
  for (let f = 0; f < F; f++) {
    const a = idx[f * 3] * 3, b = idx[f * 3 + 1] * 3, c = idx[f * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) cen[f * 3 + k] = (P0[a + k] + P0[b + k] + P0[c + k]) / 3;
    const ux = P0[b] - P0[a], uy = P0[b + 1] - P0[a + 1], uz = P0[b + 2] - P0[a + 2];
    const vx = P0[c] - P0[a], vy = P0[c + 1] - P0[a + 1], vz = P0[c + 2] - P0[a + 2];
    area[f] = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }

  const frags = seeds.map(() => ({ tris: [], area: 0, c: [0, 0, 0], neighbors: new Set() }));
  for (let f = 0; f < F; f++) {
    const o = owner[f];
    if (o < 0) continue;
    const fr = frags[o];
    fr.tris.push(f); fr.area += area[f];
    for (let k = 0; k < 3; k++) fr.c[k] += cen[f * 3 + k] * area[f];
    for (let e = 0; e < 3; e++) { const g = adj[f * 3 + e]; if (g >= 0 && owner[g] >= 0 && owner[g] !== o) fr.neighbors.add(owner[g]); }
  }
  const out = [], remap = new Int32Array(frags.length).fill(-1);
  frags.forEach((fr, i) => { if (fr.tris.length) { remap[i] = out.length; out.push(fr); } });
  for (const fr of out) {
    fr.neighbors = [...fr.neighbors].map((i) => remap[i]).filter((i) => i >= 0);
    for (let k = 0; k < 3; k++) fr.c[k] /= fr.area;
    // 锚点：最靠近质心的顶点；采样点：用来量这块皮被弯了多少
    const verts = new Set();
    for (const f of fr.tris) for (let k = 0; k < 3; k++) verts.add(idx[f * 3 + k]);
    let best = -1, bd = Infinity, r = 0;
    for (const v of verts) {
      const d = (P0[v * 3] - fr.c[0]) ** 2 + (P0[v * 3 + 1] - fr.c[1]) ** 2 + (P0[v * 3 + 2] - fr.c[2]) ** 2;
      if (d < bd) { bd = d; best = v; }
      r = Math.max(r, d);
    }
    fr.anchor = best; fr.r = Math.sqrt(r);
    const all = [...verts], step = Math.max(1, Math.floor(all.length / 12));
    fr.samples = all.filter((_, i) => i % step === 0);
    fr.n = [N0[best * 3], N0[best * 3 + 1], N0[best * 3 + 2]];
  }
  for (let f = 0; f < F; f++) owner[f] = owner[f] >= 0 ? remap[owner[f]] : -1;
  return { frags: out, owner, adj };
}
