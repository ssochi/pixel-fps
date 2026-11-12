import { bbox, clamp, pointInPoly, polyStats, resampleClosed } from './util.js';

const RING = 56;
const SPACING = 24;
const MAX_DISP = 62;

/**
 * 内芯：一圈轮廓粒子 + 内部六边形点阵，用 PBD 弹簧连起来。
 * - 慢回弹：过阻尼地爬回原形
 * - 黏土：原形会跟着当前形状蠕变（捏成啥样就是啥样）
 * - 爆浆：欠阻尼，Q 弹抖动
 * 上面还盖着脆皮的粒子会被"钉住"，所以脆皮没碎之前捏不动。
 */
export class SoftBody {
  constructor(outline, core) {
    this.core = core;
    const st = polyStats(outline);
    const ringPts = resampleClosed(outline, RING).map((p) => [
      st.cx + (p[0] - st.cx) * 0.972,
      st.cy + (p[1] - st.cy) * 0.972,
    ]);
    const pts = ringPts.slice();
    const bb = bbox(ringPts);
    let row = 0;
    for (let y = bb.y + SPACING * 0.5; y < bb.y1; y += SPACING * 0.866, row++) {
      for (let x = bb.x + (row % 2 ? SPACING / 2 : 0); x < bb.x1; x += SPACING) {
        if (!pointInPoly(x, y, ringPts)) continue;
        let near = Infinity;
        for (const r of ringPts) near = Math.min(near, Math.hypot(r[0] - x, r[1] - y));
        if (near > SPACING * 0.55) pts.push([x, y]);
      }
    }

    const n = (this.n = pts.length);
    this.ring = RING;
    this.x = new Float32Array(n); this.y = new Float32Array(n);
    this.ox = new Float32Array(n); this.oy = new Float32Array(n); // 出厂形状
    this.rx = new Float32Array(n); this.ry = new Float32Array(n); // 当前"想回到"的形状
    this.vx = new Float32Array(n); this.vy = new Float32Array(n);
    this.px = new Float32Array(n); this.py = new Float32Array(n);
    this.hold = new Float32Array(n).fill(1);
    this.frag = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = this.ox[i] = this.rx[i] = pts[i][0];
      this.y[i] = this.oy[i] = this.ry[i] = pts[i][1];
    }

    const si = [], sj = [], sl = [];
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
        if (d < SPACING * 1.55) { si.push(i); sj.push(j); sl.push(d); }
      }
    this.si = Int32Array.from(si); this.sj = Int32Array.from(sj);
    this.sl = Float32Array.from(sl); this.sl0 = Float32Array.from(sl);
    this.speed = 0;
    this.cx = st.cx; this.cy = st.cy;
  }

  /** 把一个静止坐标绑到最近的 3 个粒子上，之后就能跟着内芯一起动 */
  attach(x, y) {
    const best = [-1, -1, -1], bd = [Infinity, Infinity, Infinity];
    for (let i = 0; i < this.n; i++) {
      const d = (this.ox[i] - x) ** 2 + (this.oy[i] - y) ** 2;
      for (let k = 0; k < 3; k++) {
        if (d < bd[k]) {
          for (let m = 2; m > k; m--) { bd[m] = bd[m - 1]; best[m] = best[m - 1]; }
          bd[k] = d; best[k] = i;
          break;
        }
      }
    }
    const w = bd.map((d) => 1 / (d + 16));
    const sum = w[0] + w[1] + w[2];
    return { i: best, w: w.map((v) => v / sum) };
  }

  /** 用"当前"位置找最近粒子，把屏幕上的一点换算成静止坐标 */
  toRest(x, y) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      const d = (this.x[i] - x) ** 2 + (this.y[i] - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return [x - (this.x[best] - this.ox[best]), y - (this.y[best] - this.oy[best])];
  }

  disp(at, out) {
    let dx = 0, dy = 0;
    for (let k = 0; k < 3; k++) {
      const i = at.i[k];
      dx += (this.x[i] - this.ox[i]) * at.w[k];
      dy += (this.y[i] - this.oy[i]) * at.w[k];
    }
    out[0] = dx; out[1] = dy;
    return out;
  }

  rot(at) {
    const a = at.i[0], b = at.i[1];
    const ax = this.ox[b] - this.ox[a], ay = this.oy[b] - this.oy[a];
    const bx = this.x[b] - this.x[a], by = this.y[b] - this.y[a];
    return clamp(Math.atan2(ax * by - ay * bx, ax * bx + ay * by), -0.7, 0.7);
  }

  /** 手指拖动：直接带着附近的"肉"走 */
  drag(fx, fy, dx, dy) {
    const R = 60, m = Math.hypot(dx, dy);
    if (m < 1e-4) return;
    if (m > 40) { dx *= 40 / m; dy *= 40 / m; }
    for (let i = 0; i < this.n; i++) {
      const d2 = (this.x[i] - fx) ** 2 + (this.y[i] - fy) ** 2;
      if (d2 > R * R) continue;
      const w = (1 - d2 / (R * R)) ** 2 * (1 - this.hold[i] * 0.92) * 0.9;
      this.x[i] += dx * w; this.y[i] += dy * w;
    }
  }

  /** 按下去的瞬间：把指尖周围的肉向外推开（鼓包立刻出现，回弹才是慢的） */
  push(fx, fy, amount) {
    const R = 74;
    for (let i = 0; i < this.n; i++) {
      const dx = this.x[i] - fx, dy = this.y[i] - fy, d = Math.hypot(dx, dy);
      if (d > R || d < 0.01) continue;
      const u = d / R, k = (u * (1 - u) * 4 * amount * (1 - this.hold[i])) / d;
      this.x[i] += dx * k; this.y[i] += dy * k;
    }
  }

  step(dt, fingers) {
    const { n, x, y, ox, oy, rx, ry, vx, vy, px, py, hold, core } = this;
    const SUB = 2, h = dt / SUB;
    const w2 = core.w * core.w, damp = 2 * core.zeta * core.w;
    for (let s = 0; s < SUB; s++) {
      for (let i = 0; i < n; i++) {
        px[i] = x[i]; py[i] = y[i];
        let ax = w2 * (rx[i] - x[i]) - damp * vx[i];
        let ay = w2 * (ry[i] - y[i]) - damp * vy[i];
        // 按压：把手指下面的肉往四周挤，形成鼓包
        for (const f of fingers) {
          const dx = x[i] - f.x, dy = y[i] - f.y, d = Math.hypot(dx, dy), R = 74;
          if (d > R || d < 0.01) continue;
          const u = d / R, k = u * (1 - u) * 4 * f.press * core.bulge * w2 * (1 - hold[i]);
          ax += (dx / d) * k; ay += (dy / d) * k;
        }
        vx[i] += ax * h; vy[i] += ay * h;
        x[i] += vx[i] * h; y[i] += vy[i] * h;
      }
      const { si, sj, sl } = this, ks = core.ks;
      for (let it = 0; it < 2; it++)
        for (let k = 0; k < si.length; k++) {
          const a = si[k], b = sj[k];
          const dx = x[b] - x[a], dy = y[b] - y[a], d = Math.hypot(dx, dy) || 1e-6;
          const c = ((d - sl[k]) / d) * 0.5 * ks;
          x[a] += dx * c; y[a] += dy * c;
          x[b] -= dx * c; y[b] -= dy * c;
        }
      for (let i = 0; i < n; i++) {
        const hd = hold[i] * 0.55;
        if (hd > 0.005) { x[i] += (ox[i] - x[i]) * hd; y[i] += (oy[i] - y[i]) * hd; }
        const dx = x[i] - ox[i], dy = y[i] - oy[i], d = Math.hypot(dx, dy);
        if (d > MAX_DISP) { x[i] = ox[i] + (dx / d) * MAX_DISP; y[i] = oy[i] + (dy / d) * MAX_DISP; }
        vx[i] = (x[i] - px[i]) / h; vy[i] = (y[i] - py[i]) / h;
      }
    }

    let sp = 0;
    for (let i = 0; i < n; i++) sp += Math.hypot(vx[i], vy[i]);
    this.speed = sp / n;

    if (core.plastic) {
      // 黏土：原形朝当前形状蠕变，弹簧原长也跟着变
      const k = 1 - Math.exp(-dt / 0.3);
      for (let i = 0; i < n; i++) {
        if (hold[i] > 0.3) continue;
        rx[i] += (x[i] - rx[i]) * k; ry[i] += (y[i] - ry[i]) * k;
        const dx = rx[i] - ox[i], dy = ry[i] - oy[i], d = Math.hypot(dx, dy);
        if (d > 44) { rx[i] = ox[i] + (dx / d) * 44; ry[i] = oy[i] + (dy / d) * 44; }
      }
      const { si, sj, sl, sl0 } = this;
      for (let q = 0; q < si.length; q++) {
        const a = si[q], b = sj[q];
        const d = Math.hypot(x[b] - x[a], y[b] - y[a]);
        sl[q] = clamp(sl[q] + (d - sl[q]) * k * 0.6, sl0[q] * 0.6, sl0[q] * 1.5);
      }
    }
  }

  contains(x, y, margin = 0) {
    // 射线法，对象是当前（变形后）的轮廓
    let inside = false;
    const R = this.ring;
    for (let i = 0, j = R - 1; i < R; j = i++) {
      const ax = this.x[i], ay = this.y[i], bx = this.x[j], by = this.y[j];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
    if (inside || !margin) return inside;
    for (let i = 0; i < R; i++) if (Math.hypot(this.x[i] - x, this.y[i] - y) < margin) return true;
    return false;
  }
}
