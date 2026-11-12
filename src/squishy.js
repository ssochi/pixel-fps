/* global THREE */
import { CORE_TYPES, SHELL_TYPES, noise3 } from './foods.js';
import { buildFragments, buildShape, computeNormals } from './geo.js';
import { clamp, mulberry32 } from './util.js';

export const PLATE_R = 1.95;
export const PLATE_H = 0.06;
const INTACT = 0, CRACKED = 1, GONE = 2, DUST = 3;
const GRAVITY = 26;
const MAX_CRUMBS = 700;
const INNER = 0.004; // 脆皮内表面离内芯的距离

const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), q1 = new THREE.Quaternion(), m1 = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const c1 = new THREE.Color();

/**
 * 一只捏捏：
 *  - 内芯是一张会变形的表面网格。手指按下去 = 凹坑 + 周围鼓包 + 整体被压扁，松手后按内芯类型回弹
 *  - 脆皮是贴在内芯表面的一块块碎片。内芯一变形，碎片被"掰弯"超过极限就裂；
 *    裂开后变成刚性小片跟着内芯走，再被搓、被挤就脱落，掉到盘子上
 */
export class Squishy {
  constructor(food, shellKey, coreKey, seed, detail, events = {}) {
    this.food = food;
    this.shellType = SHELL_TYPES[shellKey];
    this.coreType = CORE_TYPES[coreKey];
    this.events = events;
    const rng = (this.rng = mulberry32(seed));

    const shape = (this.shape = buildShape(food, detail));
    const fx = buildFragments(shape, this.shellType.cells, rng, noise3); // 会顺手把碎片边界拉直，所以要最先做
    const { V, P0, N0, idx } = shape;
    this.P = Float32Array.from(P0);
    this.N = Float32Array.from(N0);
    this.O = new Float32Array(V * 3); // 相对出厂形状的位移
    this.flow = new Float32Array(V);
    // 顶点邻接表（抹平用）、每个顶点分到的面积和出厂体积（体积守恒用）
    const sets = Array.from({ length: V }, () => new Set());
    this.va = new Float32Array(V);
    for (let f = 0; f < idx.length; f += 3) {
      const a = idx[f], b = idx[f + 1], c = idx[f + 2];
      sets[a].add(b).add(c); sets[b].add(a).add(c); sets[c].add(a).add(b);
      const ux = P0[b * 3] - P0[a * 3], uy = P0[b * 3 + 1] - P0[a * 3 + 1], uz = P0[b * 3 + 2] - P0[a * 3 + 2];
      const vx = P0[c * 3] - P0[a * 3], vy = P0[c * 3 + 1] - P0[a * 3 + 1], vz = P0[c * 3 + 2] - P0[a * 3 + 2];
      const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6;
      this.va[a] += ar; this.va[b] += ar; this.va[c] += ar;
    }
    this.nbrAt = new Int32Array(V + 1);
    for (let i = 0; i < V; i++) this.nbrAt[i + 1] = this.nbrAt[i] + sets[i].size;
    this.nbr = new Int32Array(this.nbrAt[V]);
    sets.forEach((st, i) => { let k = this.nbrAt[i]; for (const v of st) this.nbr[k++] = v; });
    this.vol0 = this.volume();
    this.Z = new Float32Array(V); // 从裂缝里挤出来的内馅，沿法线鼓起多高
    this.pressure = new Float32Array(V);
    this.oozing = 0;
    this.T = new Float32Array(V * 3);
    this.W = new Float32Array(V);
    this.center = new THREE.Vector3(0, shape.top * 0.5, 0);
    // 防按穿用：每个顶点朝"底部中心"的方向 U，以及最多能往那边走多远
    this.U = new Float32Array(V * 3);
    this.reach = new Float32Array(V);
    const gy = shape.top * 0.12;
    for (let i = 0; i < V; i++) {
      const j = i * 3, x = -P0[j], y = gy - P0[j + 1], z = -P0[j + 2], l = Math.hypot(x, y, z) || 1;
      this.U[j] = x / l; this.U[j + 1] = y / l; this.U[j + 2] = z / l;
      this.reach[i] = l * 0.8;
    }

    this.group = new THREE.Group();

    // ---- 内芯 ----
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(this.P, 3).setUsage(THREE.DynamicDrawUsage));
    cg.setAttribute('normal', new THREE.BufferAttribute(this.N, 3).setUsage(THREE.DynamicDrawUsage));
    cg.setIndex(new THREE.BufferAttribute(idx, 1));
    cg.boundingSphere = new THREE.Sphere(this.center.clone(), 4);
    this.coreMesh = new THREE.Mesh(cg, new THREE.MeshStandardMaterial({ color: food.core, roughness: this.coreType.rough, metalness: 0, envMapIntensity: this.coreType.gloss }));
    this.coreMesh.castShadow = this.coreMesh.receiveShadow = true;
    this.coreMesh.frustumCulled = false;
    this.group.add(this.coreMesh);

    // ---- 脆皮 ----
    this.owner = fx.owner;
    this.frags = fx.frags.map((f) => ({
      ...f,
      state: INTACT,
      limit: this.shellType.limit * (0.55 + rng() * 0.9),
      loose: 0, pb: 0, pd: 0,
      q: new THREE.Quaternion(), jq: new THREE.Quaternion(), lift: 0,
      x: new THREE.Vector3(), v: new THREE.Vector3(), w: new THREE.Vector3(),
      age: 0, settled: false, landed: false, written: false,
    }));
    // 裂缝线：落在两块碎片交界上的顶点（往两边各晕开一圈），内馅就是从这些地方挤出来的
    this.vOwnA = new Int32Array(V).fill(-1);
    this.vOwnB = new Int32Array(V).fill(-1);
    this.seam = new Float32Array(V);
    for (let f = 0; f < idx.length / 3; f++) {
      const o = this.owner[f];
      if (o < 0) continue;
      for (let k = 0; k < 3; k++) {
        const v = idx[f * 3 + k];
        if (this.vOwnA[v] < 0) this.vOwnA[v] = o;
        else if (this.vOwnA[v] !== o) { this.vOwnB[v] = o; this.seam[v] = 1; }
      }
    }
    const soft = Float32Array.from(this.seam);
    for (let f = 0; f < idx.length; f += 3)
      for (let k = 0; k < 3; k++) {
        const a = idx[f + k], b = idx[f + ((k + 1) % 3)];
        if (this.seam[a] * 0.45 > soft[b]) soft[b] = this.seam[a] * 0.45;
        if (this.seam[b] * 0.45 > soft[a]) soft[a] = this.seam[b] * 0.45;
      }
    this.seam = soft;
    this.totalArea = this.frags.reduce((s, f) => s + f.area, 0);
    this.goneArea = 0;
    this.buildShell(fx.adj);

    // ---- 渣渣 ----
    const crumbGeo = new THREE.TetrahedronGeometry(1);
    this.crumbMesh = new THREE.InstancedMesh(crumbGeo, new THREE.MeshStandardMaterial({ roughness: 0.6 }), MAX_CRUMBS);
    this.crumbMesh.count = 0;
    this.crumbMesh.castShadow = true;
    this.crumbMesh.frustumCulled = false;
    this.crumbs = [];
    this.crumbHead = 0;
    this.group.add(this.crumbMesh);

    this.presses = new Map();
    this.queue = [];
    this.caster = new THREE.Raycaster();
    this.time = 0;
    this.cracks = 0;
    this.startAt = -1;
    this.endAt = -1;
    this.done = false;
    this.squish = 0;
  }

  get shellLeft() { return clamp(1 - this.goneArea / this.totalArea, 0, 1); }
  get elapsed() { return this.startAt < 0 ? 0 : (this.endAt < 0 ? this.time : this.endAt) - this.startAt; }

  // ------------------------------------------------------------------ 建脆皮网格
  buildShell(adj) {
    const { P0, N0, idx, col } = this.shape, th = this.shellType.th;
    const wall = new THREE.Color(this.food.wall).convertSRGBToLinear();
    const src = [], off = [], kind = [], rest = [], rn = [], color = [], index = [];
    const add = (v, o, k, nx, ny, nz, r, g, b) => {
      src.push(v); off.push(o); kind.push(k);
      rest.push(P0[v * 3] + N0[v * 3] * o, P0[v * 3 + 1] + N0[v * 3 + 1] * o, P0[v * 3 + 2] + N0[v * 3 + 2] * o);
      rn.push(nx, ny, nz); color.push(r, g, b);
      return src.length - 1;
    };
    this.frags.forEach((fr, fi) => {
      fr.v0 = src.length;
      const top = new Map(), bot = new Map();
      const T = (v) => { let i = top.get(v); if (i === undefined) { i = add(v, th, 0, N0[v * 3], N0[v * 3 + 1], N0[v * 3 + 2], col[v * 3], col[v * 3 + 1], col[v * 3 + 2]); top.set(v, i); } return i; };
      const Bt = (v) => { let i = bot.get(v); if (i === undefined) { i = add(v, INNER, 1, -N0[v * 3], -N0[v * 3 + 1], -N0[v * 3 + 2], wall.r, wall.g, wall.b); bot.set(v, i); } return i; };
      for (const f of fr.tris) {
        const a = idx[f * 3], b = idx[f * 3 + 1], c = idx[f * 3 + 2];
        index.push(T(a), T(b), T(c), Bt(c), Bt(b), Bt(a));
        for (let e = 0; e < 3; e++) {
          const g = adj[f * 3 + e];
          if (g >= 0 && this.owner[g] === fi) continue;
          // 碎片边缘：补一圈侧壁，裂开后才看得出蜡的厚度
          const va = idx[f * 3 + e], vb = idx[f * 3 + ((e + 1) % 3)], vc = idx[f * 3 + ((e + 2) % 3)];
          const ex = P0[vb * 3] - P0[va * 3], ey = P0[vb * 3 + 1] - P0[va * 3 + 1], ez = P0[vb * 3 + 2] - P0[va * 3 + 2];
          const ax = N0[va * 3] + N0[vb * 3], ay = N0[va * 3 + 1] + N0[vb * 3 + 1], az = N0[va * 3 + 2] + N0[vb * 3 + 2];
          let nx = ey * az - ez * ay, ny = ez * ax - ex * az, nz = ex * ay - ey * ax;
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l; ny /= l; nz /= l;
          if (nx * (P0[vc * 3] - P0[va * 3]) + ny * (P0[vc * 3 + 1] - P0[va * 3 + 1]) + nz * (P0[vc * 3 + 2] - P0[va * 3 + 2]) > 0) { nx = -nx; ny = -ny; nz = -nz; }
          const w = (v, o) => add(v, o, 2, nx, ny, nz, wall.r, wall.g, wall.b);
          const at = w(va, th), bt = w(vb, th), ab = w(va, INNER), bb = w(vb, INNER);
          // 三角形朝向跟着侧壁法线走
          const i3 = at * 3, j3 = ab * 3, k3 = bb * 3;
          const ux = rest[j3] - rest[i3], uy = rest[j3 + 1] - rest[i3 + 1], uz = rest[j3 + 2] - rest[i3 + 2];
          const wx = rest[k3] - rest[i3], wy = rest[k3 + 1] - rest[i3 + 1], wz = rest[k3 + 2] - rest[i3 + 2];
          const facing = (uy * wz - uz * wy) * nx + (uz * wx - ux * wz) * ny + (ux * wy - uy * wx) * nz;
          if (facing > 0) index.push(at, ab, bb, at, bb, bt);
          else index.push(at, bb, ab, at, bt, bb);
        }
      }
      fr.v1 = src.length;
      // 碎片自己的质心（脱落后绕它转）
      let cx = 0, cy = 0, cz = 0;
      for (let v = fr.v0; v < fr.v1; v++) { cx += rest[v * 3]; cy += rest[v * 3 + 1]; cz += rest[v * 3 + 2]; }
      const n = fr.v1 - fr.v0;
      fr.pivot = new THREE.Vector3(cx / n, cy / n, cz / n);
      const a = fr.anchor;
      fr.a0 = new THREE.Vector3(P0[a * 3], P0[a * 3 + 1], P0[a * 3 + 2]);
      fr.n0 = new THREE.Vector3(N0[a * 3], N0[a * 3 + 1], N0[a * 3 + 2]);
      fr.col = [col[a * 3], col[a * 3 + 1], col[a * 3 + 2]];
    });
    const n = src.length;
    this.sSrc = Int32Array.from(src); this.sOff = Float32Array.from(off); this.sKind = Uint8Array.from(kind);
    this.sRest = Float32Array.from(rest); this.sRn = Float32Array.from(rn);
    this.sPos = new Float32Array(n * 3); this.sNrm = new Float32Array(n * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.sNrm, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(color), 3));
    g.setIndex(new THREE.BufferAttribute(n > 65535 ? Uint32Array.from(index) : Uint16Array.from(index), 1));
    this.shellMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: this.food.rough, metalness: 0 }));
    this.shellMesh.castShadow = this.shellMesh.receiveShadow = true;
    this.shellMesh.frustumCulled = false;
    this.wallColor = wall;
    this.group.add(this.shellMesh);
  }

  // ------------------------------------------------------------------ 输入
  hit(ray) {
    this.caster.ray.copy(ray);
    const h = this.caster.intersectObject(this.coreMesh, false)[0];
    if (!h) return null;
    const P = this.P;
    let vi = h.face.a, bd = Infinity;
    for (const v of [h.face.a, h.face.b, h.face.c]) {
      const d = (P[v * 3] - h.point.x) ** 2 + (P[v * 3 + 1] - h.point.y) ** 2 + (P[v * 3 + 2] - h.point.z) ** 2;
      if (d < bd) { bd = d; vi = v; }
    }
    return { vi, face: h.faceIndex };
  }

  aim(pr, vi, ray) {
    const { P0, N0 } = this.shape, plastic = this.coreType.plastic;
    // 膏体没有"原形"可言：以当前形状为准。慢回弹才以出厂形状为准
    const R = plastic ? this.P : P0, RN = plastic ? this.N : N0;
    if (pr.vi !== vi) pr.moved += Math.hypot(P0[vi * 3] - P0[pr.vi * 3], P0[vi * 3 + 1] - P0[pr.vi * 3 + 1], P0[vi * 3 + 2] - P0[pr.vi * 3 + 2]);
    pr.vi = vi;
    pr.tc.set(R[vi * 3], R[vi * 3 + 1], R[vi * 3 + 2]);
    // 按压方向：主要顺着表面往里，掺一点视线方向。所以捏侧面是横着挤，按顶上是往下压
    pr.td.set(-RN[vi * 3], -RN[vi * 3 + 1], -RN[vi * 3 + 2]).multiplyScalar(0.65).addScaledVector(ray.direction, 0.35).normalize();
  }

  pointerDown(id, ray) {
    const h = this.hit(ray);
    if (!h) return this.crushAt(ray) ? 'shard' : null;
    const pr = {
      vi: h.vi, c: new THREE.Vector3(), tc: new THREE.Vector3(), d: new THREE.Vector3(), td: new THREE.Vector3(),
      ray: null, t: 0, depth: 0, thick: 1, speed: 0, moved: 0, delivered: 0, peak: 0,
    };
    this.aim(pr, h.vi, ray);
    pr.c.copy(pr.tc); pr.d.copy(pr.td);
    this.presses.set(id, pr);
    // 指尖下那块脆皮当场裂开
    const fi = this.owner[h.face];
    if (fi >= 0) {
      const fr = this.frags[fi];
      if (fr.state === INTACT) this.crack(fr, 1);
      else if (fr.state === CRACKED) fr.loose += 0.45;
    } else this.events.squishTap?.();
    return 'body';
  }

  pointerMove(id, ray) {
    const pr = this.presses.get(id);
    if (pr) pr.ray = ray;
  }

  pointerUp(id) {
    this.presses.delete(id);
  }

  /** 点盘子上的碎片：碾成渣 */
  crushAt(ray) {
    let best = null, bt = Infinity;
    for (const fr of this.frags) {
      if (fr.state !== GONE || !fr.settled) continue;
      v1.copy(fr.x).sub(ray.origin);
      const t = v1.dot(ray.direction);
      const d = v1.addScaledVector(ray.direction, -t).length();
      if (d < Math.max(fr.r * 0.85, 0.14) && t < bt) { bt = t; best = fr; }
    }
    if (!best) return false;
    best.state = DUST; best.written = false;
    this.spawnCrumbs(best.x, UP, best.col, 9 + ((this.rng() * 5) | 0), 2.4);
    this.events.crack?.(0.45);
    return true;
  }

  // ------------------------------------------------------------------ 脆皮状态
  crack(fr, energy) {
    if (fr.state !== INTACT) return;
    const rng = this.rng;
    fr.state = CRACKED;
    fr.lift = 0.004 + rng() * 0.012;
    v1.set(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize();
    fr.jq.setFromAxisAngle(v1, (rng() - 0.5) * 0.16);
    this.cracks++;
    if (this.startAt < 0) this.startAt = this.time;
    this.events.crack?.(energy);
    const a = fr.anchor, P = this.P, N = this.N;
    v1.set(P[a * 3], P[a * 3 + 1], P[a * 3 + 2]);
    v2.set(N[a * 3], N[a * 3 + 1], N[a * 3 + 2]);
    this.spawnCrumbs(v1, v2, fr.col, 2 + ((rng() * 3) | 0), 1.6);
    this.events.puff?.(v1, energy);

    const [lo, span, decay] = this.shellType.spread;
    if (energy < 0.1) return;
    for (const n of fr.neighbors) {
      const nb = this.frags[n];
      if (nb.state !== INTACT) continue;
      nb.limit -= this.shellType.limit * energy * (lo + span * rng());
      if (nb.limit <= 0) this.queue.push({ t: this.time + 0.02 + rng() * 0.06, fr: nb, e: energy * decay });
    }
  }

  detach(fr, kick = 1) {
    if (fr.state === GONE || fr.state === DUST) return;
    if (fr.state === INTACT) this.cracks++;
    this.frameTransform(fr);
    const rng = this.rng, a = fr.anchor, N = this.N;
    // 接着当前的位置和朝向飞出去
    fr.x.copy(fr.pivot).sub(fr.a0).applyQuaternion(fr.q).add(fr.base);
    fr.state = GONE;
    fr.age = 0;
    this.goneArea += fr.area;
    v2.set(N[a * 3], N[a * 3 + 1], N[a * 3 + 2]);
    fr.v.copy(v2).multiplyScalar((1.2 + rng() * 2.2) * kick);
    fr.v.x += (rng() - 0.5) * 1.2; fr.v.z += (rng() - 0.5) * 1.2; fr.v.y += 1.2 + rng() * 2;
    fr.w.set(rng() - 0.5, rng() - 0.5, rng() - 0.5).multiplyScalar(14);
    this.spawnCrumbs(fr.x, v2, fr.col, (rng() * 3) | 0, 2);
  }

  spawnCrumbs(pos, nrm, col, n, speed) {
    const rng = this.rng, wc = this.wallColor;
    for (let i = 0; i < n; i++) {
      let c = this.crumbs[this.crumbHead];
      if (!c) c = this.crumbs[this.crumbHead] = { x: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3() };
      const slot = this.crumbHead;
      this.crumbHead = (this.crumbHead + 1) % MAX_CRUMBS;
      c.x.copy(pos).addScaledVector(nrm, 0.03);
      c.x.x += (rng() - 0.5) * 0.12; c.x.y += (rng() - 0.5) * 0.08; c.x.z += (rng() - 0.5) * 0.12;
      c.v.set(rng() - 0.5, rng() * 0.6, rng() - 0.5).multiplyScalar(speed * 1.6).addScaledVector(nrm, speed * (0.3 + rng()));
      c.q.set(rng(), rng(), rng(), rng()).normalize();
      const s = 0.012 + rng() * 0.024;
      c.s.set(s * (0.7 + rng()), s * 0.5, s * (0.7 + rng()));
      c.live = true;
      const pale = rng() < 0.5;
      m1.compose(c.x, c.q, c.s);
      this.crumbMesh.setMatrixAt(slot, m1);
      this.crumbMesh.setColorAt(slot, pale ? wc : c1.setRGB(col[0], col[1], col[2]));
      this.crumbMesh.count = Math.max(this.crumbMesh.count, slot + 1);
    }
    if (n) { this.crumbMesh.instanceMatrix.needsUpdate = true; if (this.crumbMesh.instanceColor) this.crumbMesh.instanceColor.needsUpdate = true; }
  }

  /** 裂开但还挂在内芯上的碎片：按锚点的位置和法线求一个刚体变换 */
  frameTransform(fr) {
    const a = fr.anchor, P = this.P, N = this.N;
    v1.set(N[a * 3], N[a * 3 + 1], N[a * 3 + 2]);
    fr.q.setFromUnitVectors(fr.n0, v1).multiply(fr.jq);
    (fr.base ||= new THREE.Vector3()).set(P[a * 3], P[a * 3 + 1], P[a * 3 + 2]).addScaledVector(v1, fr.lift);
  }

  // ------------------------------------------------------------------ 每帧
  update(dt) {
    this.time += dt;
    for (const pr of this.presses.values()) {
      pr.t += dt;
      if (pr.ray) {
        const h = this.hit(pr.ray);
        if (h) this.aim(pr, h.vi, pr.ray);
        pr.ray = null;
      }
      const k = 1 - Math.exp(-dt * 22);
      v1.copy(pr.c);
      pr.c.lerp(pr.tc, k);
      pr.d.lerp(pr.td, k).normalize();
      pr.speed += (v1.distanceTo(pr.c) / dt - pr.speed) * Math.min(1, dt * 12);
    }
    this.stepCore(dt);
    this.stepShell(dt);
    this.stepCrumbs(dt);

    if (this.queue.length) {
      const due = this.queue.filter((q) => q.t <= this.time);
      this.queue = this.queue.filter((q) => q.t > this.time);
      for (const q of due) this.crack(q.fr, q.e);
    }
    if (!this.done && this.goneArea / this.totalArea >= 0.965) {
      for (const fr of this.frags) if (fr.state < GONE) this.detach(fr, 0.6);
      this.done = true;
      this.endAt = this.time;
      this.events.done?.(this);
    }
  }

  stepCore(dt) {
    const { P0, N0, V, idx } = this.shape, { P, N, O, T, W, Z, pressure } = this;
    const core = this.coreType, plastic = core.plastic;
    const R = plastic ? P : P0, RN = plastic ? N : N0;
    const flow = this.flow;
    T.fill(0); W.fill(0);
    if (plastic) flow.fill(0);
    if (core.ooze) pressure.fill(0);

    for (const pr of this.presses.values()) {
      const cx = pr.c.x, cy = pr.c.y, cz = pr.c.z, dx = pr.d.x, dy = pr.d.y, dz = pr.d.z;
      // 这个方向上东西有多厚：决定最多能按多深
      let thick = 0.2;
      for (let i = 0; i < V; i++) {
        const qx = R[i * 3] - cx, qy = R[i * 3 + 1] - cy, qz = R[i * 3 + 2] - cz;
        const al = qx * dx + qy * dy + qz * dz;
        if (al > thick && qx * qx + qy * qy + qz * qz - al * al < 0.05) thick = al;
      }
      pr.thick += (thick - pr.thick) * Math.min(1, dt * 10);
      const dmax = Math.min(core.depth, pr.thick * 0.44);
      let D, sqk, e, wAll;
      if (plastic) {
        // 膏体：只往前走、不回头。每帧把"还没按到位的那部分"推进去一点；
        // 手指滑到新地方，那里还没被按过，所以又能接着往下陷 —— 这就是抹、犁的效果
        pr.delivered *= Math.exp(-pr.moved / 0.3);
        pr.moved = 0;
        D = Math.max(0, dmax - pr.delivered) * (1 - Math.exp(-dt / core.sink));
        pr.delivered += D;
        pr.depth = pr.delivered;
        // 整体压扁只算"比之前按得更深"的那部分：手指来回抹只会犁出沟，不会把整坨越推越远
        const deeper = Math.max(0, pr.delivered - pr.peak);
        pr.peak = Math.max(pr.peak, pr.delivered);
        sqk = (0.45 * deeper) / pr.thick; // 近端被推过去、远端贴着盘子不动 → 整体变扁
        e = 0; // 往四周摊开多少，交给下面的体积守恒去算
        wAll = D > 1e-5 ? 0.35 : 0;
      } else {
        D = pr.depth = dmax * (1 - Math.exp(-pr.t / core.sink));
        const s = 0.34 * (D / 0.52) ** 2;
        sqk = Math.min(s, 0.3 / pr.thick);
        e = 1 / Math.sqrt(1 - s) - 1;
        wAll = s * 2.5;
      }
      const sig2 = 0.34 * 0.34;
      for (let i = 0; i < V; i++) {
        const j = i * 3;
        const qx = R[j] - cx, qy = R[j + 1] - cy, qz = R[j + 2] - cz;
        const al = qx * dx + qy * dy + qz * dz;
        const px = qx - al * dx, py = qy - al * dy, pz = qz - al * dz;
        const x2 = (px * px + py * py + pz * pz) / sig2;
        const near = al < 0.7 ? 1 : al > 1.3 ? 0 : 1 - (al - 0.7) / 0.6;
        const g = Math.exp(-x2 * 0.5) * near; // 指尖下的凹坑
        const b = plastic ? 0 : x2 * Math.exp(-x2 / 2.9) * 0.2 * near; // 坑边被挤起来的一圈
        if (plastic) flow[i] += Math.exp(-x2 / 9) * (1 - g); // 被挤走的料主要堆到坑的周围
        const push = D * g + sqk * Math.max(0, pr.thick - al);
        T[j] += dx * push + RN[j] * D * b + px * e;
        T[j + 1] += dy * push + RN[j + 1] * D * b + py * e;
        T[j + 2] += dz * push + RN[j + 2] * D * b + pz * e;
        const w = g + b * 2 + wAll;
        if (w > W[i]) W[i] = w;
        if (core.ooze) pressure[i] += pr.depth * Math.exp(-x2 * 0.14) * near;
      }
    }

    let moved = 0;
    if (plastic) {
      for (let j = 0; j < V * 3; j++) { O[j] += T[j]; moved += Math.abs(T[j]); }
      // 手指经过的地方被抹平：棱角、褶子、原来的刀口都会被揉掉
      const { nbr, nbrAt } = this;
      for (let i = 0; i < V; i++) {
        const w = W[i];
        if (w < 0.08) continue;
        let ax = 0, ay = 0, az = 0;
        const n0 = nbrAt[i], n1 = nbrAt[i + 1];
        for (let k = n0; k < n1; k++) { const q = nbr[k] * 3; ax += P[q]; ay += P[q + 1]; az += P[q + 2]; }
        const j = i * 3, c = (0.22 * Math.min(1, w)) / (n1 - n0), keep = 0.22 * Math.min(1, w);
        O[j] += ax * c - P[j] * keep; O[j + 1] += ay * c - P[j + 1] * keep; O[j + 2] += az * c - P[j + 2] * keep;
      }
      // 体积守恒：按进去多少体积，就在周围鼓出多少。膏体不可压缩，这一步决定了它像不像真的
      this.place();
      const dv = this.vol0 - this.volume();
      if (Math.abs(dv) > 2e-4) {
        const va = this.va;
        let sum = 0;
        for (let i = 0; i < V; i++) { flow[i] = (flow[i] + 0.1) * Math.min(1, P[i * 3 + 1] / 0.12); sum += flow[i] * va[i]; }
        const lam = clamp(dv / (sum || 1), -0.03, 0.03);
        for (let i = 0; i < V; i++) {
          const j = i * 3, d = flow[i] * lam;
          O[j] += N[j] * d; O[j + 1] += N[j + 1] * d; O[j + 2] += N[j + 2] * d;
        }
      }
    } else {
      const back = core.back;
      for (let i = 0; i < V; i++) {
        const j = i * 3;
        const k = 1 - Math.exp(-dt * (back + (20 - back) * Math.min(1, W[i] * 1.6)));
        for (let a = 0; a < 3; a++) {
          const d = (T[j + a] - O[j + a]) * k;
          O[j + a] += d; moved += Math.abs(d);
        }
      }
    }

    // 爆浆：脆皮裂了但还贴在上面时，内馅没处去，只能从裂缝里挤出来，在缝上鼓成一道道
    if (core.ooze) {
      const { seam, vOwnA, vOwnB, frags } = this;
      for (let i = 0; i < V; i++) {
        if (seam[i] === 0) continue;
        const a = vOwnA[i], b = vOwnB[i];
        const held = (a >= 0 && frags[a].state === CRACKED) || (b >= 0 && frags[b].state === CRACKED);
        if (held) {
          const target = seam[i] * Math.min(0.075, pressure[i] * 0.3);
          if (target > Z[i]) { const d = (target - Z[i]) * Math.min(1, dt * 9); Z[i] += d; moved += d * 3; this.oozing += d; }
        } else if (Z[i] > 0) Z[i] *= 1 - Math.min(1, dt * (0.5 + 6 * W[i])); // 皮掉了以后，鼓出来的那道会慢慢塌平，一按就抹掉
      }
    }

    // 不许按穿：每个顶点朝中心最多走 80%，两边对着捏也碰不到一起，最扁能压成一张厚饼
    const U = this.U, reach = this.reach;
    for (let i = 0; i < V; i++) {
      const j = i * 3, over = O[j] * U[j] + O[j + 1] * U[j + 1] + O[j + 2] * U[j + 2] - reach[i];
      if (over > 0) { O[j] -= U[j] * over; O[j + 1] -= U[j + 1] * over; O[j + 2] -= U[j + 2] * over; }
      const m = Math.hypot(O[j], O[j + 1], O[j + 2]);
      if (m > 0.95) { const k = 0.95 / m; O[j] *= k; O[j + 1] *= k; O[j + 2] *= k; } // 再怎么揉也不会摊出盘子
    }
    this.place();
    computeNormals(P, idx, this.N);
    const g = this.coreMesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    this.squish = clamp(moved / V / dt / 0.9, 0, 1) * (0.25 + 0.75 * (1 - this.shellLeft));
  }

  /** 位移 → 顶点位置（盘子以下的压回盘面） */
  place() {
    const { P0, N0, V } = this.shape, { P, O, Z } = this;
    for (let i = 0; i < V; i++) {
      const j = i * 3, z = Z[i];
      P[j] = P0[j] + O[j] + N0[j] * z;
      const y = P0[j + 1] + O[j + 1] + N0[j + 1] * z;
      P[j + 1] = y < 0 ? 0 : y;
      P[j + 2] = P0[j + 2] + O[j + 2] + N0[j + 2] * z;
    }
  }

  volume() {
    const P = this.P, idx = this.shape.idx;
    let v = 0;
    for (let f = 0; f < idx.length; f += 3) {
      const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
      v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) + P[a + 1] * (P[b + 2] * P[c] - P[b] * P[c + 2]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
    }
    return v / 6;
  }

  stepShell(dt) {
    const { O, P, N, sSrc, sOff, sKind, sRest, sRn, sPos, sNrm } = this;
    const active = [...this.presses.values()];
    const sdf = this.food.sdf;

    for (const fr of this.frags) {
      if (fr.state === DUST) {
        if (!fr.written) { sPos.fill(0, fr.v0 * 3, fr.v1 * 3); fr.written = true; }
        continue;
      }

      if (fr.state < GONE) {
        // 这块皮被掰弯了多少：各采样点位移和锚点位移之差
        const a = fr.anchor * 3, ox = O[a], oy = O[a + 1], oz = O[a + 2];
        let bend = 0;
        for (const s of fr.samples) {
          const d = Math.hypot(O[s * 3] - ox, O[s * 3 + 1] - oy, O[s * 3 + 2] - oz);
          if (d > bend) bend = d;
        }
        if (fr.state === INTACT) {
          if (bend > fr.limit) this.crack(fr, 0.32);
        } else {
          // 是"正在被继续挤"才会掉，而不是"变形了就一直掉"：膏体变形是永久的
          const lim = this.shellType.limit;
          const disp = Math.hypot(ox, oy, oz);
          if (bend > lim * 2.4) fr.loose += (Math.max(0, bend - fr.pb) / lim) * 0.35;
          if (disp > 0.2) fr.loose += Math.abs(disp - fr.pd) * 3;
          fr.pb = bend; fr.pd = disp;
          for (const pr of active) {
            const d = pr.c.distanceTo(fr.a0);
            if (d < 0.45) fr.loose += dt * (0.35 + pr.speed * 1.5) * (1 - d / 0.45);
          }
          let support = 0;
          for (const n of fr.neighbors) if (this.frags[n].state < GONE) support++;
          if (support === 0) fr.loose += dt * 3;
          if (fr.loose >= 1) this.detach(fr, 1 + Math.min(0.7, disp * 2.5));
        }
      }

      if (fr.state === INTACT) {
        // 没裂的时候只露外表面：侧壁和内表面收进内芯里，表面才是一整张、看不出接缝
        for (let v = fr.v0; v < fr.v1; v++) {
          const s = sSrc[v] * 3, j = v * 3, o = sKind[v] === 0 ? sOff[v] : -0.02;
          sPos[j] = P[s] + N[s] * o; sPos[j + 1] = P[s + 1] + N[s + 1] * o; sPos[j + 2] = P[s + 2] + N[s + 2] * o;
          sNrm[j] = N[s]; sNrm[j + 1] = N[s + 1]; sNrm[j + 2] = N[s + 2];
        }
        continue;
      }

      let ox, oy, oz, bx, by, bz, scale;
      if (fr.state === CRACKED) {
        this.frameTransform(fr);
        ox = fr.a0.x; oy = fr.a0.y; oz = fr.a0.z;
        bx = fr.base.x; by = fr.base.y; bz = fr.base.z;
        scale = 0.985; // 略微缩一点，缝里露出内芯
      } else {
        if (fr.settled && fr.written) continue;
        this.stepShard(fr, dt, sdf);
        ox = fr.pivot.x; oy = fr.pivot.y; oz = fr.pivot.z;
        bx = fr.x.x; by = fr.x.y; bz = fr.x.z;
        scale = 1;
        fr.written = fr.settled;
      }
      const qx = fr.q.x, qy = fr.q.y, qz = fr.q.z, qw = fr.q.w;
      for (let v = fr.v0; v < fr.v1; v++) {
        const j = v * 3;
        let x = (sRest[j] - ox) * scale, y = (sRest[j + 1] - oy) * scale, z = (sRest[j + 2] - oz) * scale;
        // 四元数旋转 v' = v + 2w(q×v) + 2q×(q×v)
        let tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
        sPos[j] = x + qw * tx + (qy * tz - qz * ty) + bx;
        sPos[j + 1] = y + qw * ty + (qz * tx - qx * tz) + by;
        sPos[j + 2] = z + qw * tz + (qx * ty - qy * tx) + bz;
        x = sRn[j]; y = sRn[j + 1]; z = sRn[j + 2];
        tx = 2 * (qy * z - qz * y); ty = 2 * (qz * x - qx * z); tz = 2 * (qx * y - qy * x);
        sNrm[j] = x + qw * tx + (qy * tz - qz * ty);
        sNrm[j + 1] = y + qw * ty + (qz * tx - qx * tz);
        sNrm[j + 2] = z + qw * tz + (qx * ty - qy * tx);
      }
    }
    const g = this.shellMesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
  }

  /** 脱落的碎片：重力、从捏捏身上滑开、落盘、躺平 */
  stepShard(fr, dt, sdf) {
    fr.age += dt;
    const floor = Math.hypot(fr.x.x, fr.x.z) < PLATE_R ? 0 : -PLATE_H;
    const rest = floor + this.shellType.th * 0.5 + 0.012;
    if (!fr.landed) {
      fr.v.y -= GRAVITY * dt;
      fr.x.addScaledVector(fr.v, dt);
      const wl = fr.w.length();
      if (wl > 1e-4) { q1.setFromAxisAngle(v1.copy(fr.w).divideScalar(wl), wl * dt); fr.q.premultiply(q1); }
      // 别穿进捏捏里：用造型的 SDF 把它推出来
      if (fr.age < 3) {
        const d = sdf(fr.x.x, fr.x.y, fr.x.z);
        if (d < 0.04) {
          const h = 0.02;
          v1.set(sdf(fr.x.x + h, fr.x.y, fr.x.z) - d, sdf(fr.x.x, fr.x.y + h, fr.x.z) - d, sdf(fr.x.x, fr.x.y, fr.x.z + h) - d).normalize();
          fr.x.addScaledVector(v1, 0.04 - d);
          const vn = fr.v.dot(v1);
          if (vn < 0) fr.v.addScaledVector(v1, -vn * 1.2);
          // 落在顶上的要顺着坡往外滑，不能悬在那儿
          const hr = Math.hypot(fr.x.x, fr.x.z) || 1;
          fr.v.x += (fr.x.x / hr) * 14 * dt + v1.x * 6 * dt;
          fr.v.z += (fr.x.z / hr) * 14 * dt + v1.z * 6 * dt;
        }
      }
      if (fr.x.y <= rest && fr.v.y < 0) {
        fr.x.y = rest;
        this.events.land?.(clamp(-fr.v.y / 9, 0.15, 1));
        if (fr.v.y < -2.4) { fr.v.y *= -0.24; fr.v.x *= 0.55; fr.v.z *= 0.55; fr.w.multiplyScalar(0.45); }
        else { fr.landed = true; fr.flat = 0; }
      }
      return;
    }
    // 落定：转到平躺
    fr.flat += dt;
    fr.x.y += (rest - fr.x.y) * Math.min(1, dt * 14);
    v1.copy(fr.n0).applyQuaternion(fr.q);
    v2.set(0, v1.y >= 0 ? 1 : -1, 0);
    q1.setFromUnitVectors(v1, v2).multiply(fr.q);
    fr.q.slerp(q1, Math.min(1, dt * 14));
    if (fr.flat > 0.45) fr.settled = true;
  }

  stepCrumbs(dt) {
    let any = false;
    for (let i = 0; i < this.crumbs.length; i++) {
      const c = this.crumbs[i];
      if (!c || !c.live) continue;
      any = true;
      c.v.y -= GRAVITY * dt;
      c.x.addScaledVector(c.v, dt);
      const floor = (Math.hypot(c.x.x, c.x.z) < PLATE_R ? 0 : -PLATE_H) + c.s.y * 0.5;
      if (c.x.y <= floor) {
        c.x.y = floor;
        if (c.v.y < -2) { c.v.y *= -0.3; c.v.x *= 0.5; c.v.z *= 0.5; }
        else c.live = false;
      }
      m1.compose(c.x, c.q, c.s);
      this.crumbMesh.setMatrixAt(i, m1);
    }
    if (any) this.crumbMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const m of [this.coreMesh, this.shellMesh, this.crumbMesh]) { m.geometry.dispose(); m.material.dispose(); }
  }
}
