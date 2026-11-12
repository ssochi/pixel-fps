import { fracture } from './fracture.js';
import { BASE_Y, CORE_TYPES, FLOOR_Y, SHELL_TYPES, buildShellTexture, getOutline } from './shapes.js';
import { SoftBody } from './softbody.js';
import { clamp, clipHalfPlane, mulberry32, pointInPoly, polyStats, tracePoly, TAU } from './util.js';

const GRAVITY = 950;
const INTACT = 0, CRACKED = 1, GONE = 2;
const tmp = [0, 0];

/** 一只捏捏从"出厂"到被捏碎的全部状态 */
export class Round {
  constructor(preset, shellKey, coreKey, seed, texScale, events = {}) {
    this.preset = preset;
    this.shellType = SHELL_TYPES[shellKey];
    this.coreType = CORE_TYPES[coreKey];
    this.events = events;
    this.rng = mulberry32(seed);
    const { outline, m } = getOutline(preset);
    this.outline = outline;
    this.m = m;
    this.tex = buildShellTexture(preset, texScale, seed);
    this.body = new SoftBody(outline, this.coreType);

    const rng = this.rng;
    this.frags = fracture(outline, this.shellType.cells, rng).map((c) => ({
      ...c,
      state: INTACT,
      hp: this.shellType.tough * (0.5 + rng() * 0.75),
      loose: 0,
      dx: 0, dy: 0, rot: 0,
      jx: 0, jy: 0, jr: 0,
      pop: 0,
      sprite: null,
      attach: this.body.attach(c.cx, c.cy),
      polyX: c.poly.map((p) => {
        const k = 1 + 1.3 / Math.max(c.r, 3);
        return [c.cx + (p[0] - c.cx) * k, c.cy + (p[1] - c.cy) * k];
      }),
    }));
    this.totalArea = this.frags.reduce((s, f) => s + f.area, 0);
    this.goneArea = 0;

    // 每个内芯粒子归哪块脆皮管（脆皮没碎，下面的肉就捏不动）
    const b = this.body;
    for (let i = 0; i < b.n; i++) {
      let best = 0, bd = Infinity;
      this.frags.forEach((f, k) => {
        const d = (f.cx - b.ox[i]) ** 2 + (f.cy - b.oy[i]) ** 2;
        if (d < bd) { bd = d; best = k; }
      });
      b.frag[i] = best;
    }

    this.intact = document.createElement('canvas');
    this.intact.width = this.tex.canvas.width;
    this.intact.height = this.tex.canvas.height;
    this.intactDirty = true;

    // 内芯上的小表情 + 高光 + 爆浆亮片，都绑在粒子上跟着变形
    const f = preset.face, fx = m.ox, fy = f.y + m.oy, s = f.s;
    const pin = (x, y) => ({ x, y, at: b.attach(x, y) });
    this.face = {
      s,
      eyes: [pin(fx - 17 * s, fy - 4 * s), pin(fx + 17 * s, fy - 4 * s)],
      mouth: pin(fx, fy + 6 * s),
      blush: [pin(fx - 28 * s, fy + 5 * s), pin(fx + 28 * s, fy + 5 * s)],
    };
    this.gloss = pin(m.left + m.w * 0.3, m.top + m.h * 0.24);
    this.beads = [];
    if (coreKey === 'jelly') {
      for (let i = 0; i < 46; i++) {
        let x, y;
        do { x = m.left + rng() * m.w; y = m.top + rng() * m.h; } while (!pointInPoly(x, y, outline));
        const st = polyStats(outline);
        x = st.cx + (x - st.cx) * 0.86; y = st.cy + (y - st.cy) * 0.86;
        this.beads.push({ ...pin(x, y), r: 1.4 + rng() * 2.6, tw: rng() * TAU, white: rng() < 0.6 });
      }
    }

    // 指印颜色：内芯暗部再压深一点
    const lo = parseInt(preset.core.lo.slice(1), 16);
    this.dentRGB = [lo >> 16, (lo >> 8) & 255, lo & 255].map((v) => Math.round(v * 0.74)).join(',');

    this.fingers = new Map();
    this.shards = [];
    this.crumbs = [];
    this.puffs = [];
    this.dents = [];
    this.queue = [];
    this.time = 0;
    this.cracks = 0;
    this.startAt = -1;
    this.endAt = -1;
    this.done = false;
    this.squish = 0;
    this.walls = [-170, 170];
  }

  get shellLeft() { return clamp(1 - this.goneArea / this.totalArea, 0, 1); }
  get elapsed() { return this.startAt < 0 ? 0 : (this.endAt < 0 ? this.time : this.endAt) - this.startAt; }
  get pressing() { for (const f of this.fingers.values()) if (f.onBody) return true; return false; }

  // ---------------- 输入 ----------------
  pointerDown(id, x, y) {
    if (this.body.contains(x, y, 14)) {
      const f = { x, y, px: x, py: y, t: 0, speed: 0, vx: 0, vy: 0, press: 0, onBody: true, trail: 0, dent: null };
      this.fingers.set(id, f);
      f.dent = { x, y, depth: 0.15, active: true, at: null, ox: 0, oy: 0 };
      this.dents.push(f.dent);
      this.tap(x, y);
      return true;
    }
    return this.crushShard(x, y);
  }

  pointerMove(id, x, y) {
    const f = this.fingers.get(id);
    if (f) { f.x = x; f.y = y; }
  }

  pointerUp(id) {
    const f = this.fingers.get(id);
    if (!f) return;
    this.releaseDent(f.dent);
    this.fingers.delete(id);
  }

  releaseDent(d) {
    if (!d || !d.active) return;
    d.active = false;
    const r = this.body.toRest(d.x, d.y);
    d.at = this.body.attach(r[0], r[1]);
    d.rx = r[0]; d.ry = r[1];
  }

  /** 点下去的一瞬间：指尖下那块脆皮立刻"咔" */
  tap(x, y) {
    let best = null, bd = 32;
    for (const fr of this.frags) {
      if (fr.state === GONE) continue;
      const d = Math.hypot(fr.cx + fr.dx - x, fr.cy + fr.dy - y);
      if (fr.state === INTACT) {
        if (d < bd) { bd = d; best = fr; }
        if (d < 34) fr.hp -= 0.45 * (1 - d / 34);
      } else if (d < 26 + fr.r * 0.4) fr.loose += 0.4;
    }
    if (best) this.crack(best, 1);
    else if (this.events.squishTap) this.events.squishTap();
  }

  // ---------------- 脆皮 ----------------
  crack(fr, energy) {
    if (fr.state !== INTACT) return;
    const rng = this.rng;
    fr.state = CRACKED;
    fr.pop = 1;
    fr.jx = (rng() - 0.5) * 1.5; fr.jy = (rng() - 0.5) * 1.5; fr.jr = (rng() - 0.5) * 0.07;
    fr.sprite = this.makeSprite(fr.poly);
    this.intactDirty = true;
    this.cracks++;
    if (this.startAt < 0) this.startAt = this.time;
    this.events.crack?.(energy);

    this.spawnCrumbs(fr.cx, fr.cy, fr.r, 1 + ((rng() * 3) | 0), 60);
    if (energy > 0.5) this.puffs.push({ x: fr.cx, y: fr.cy, r: fr.r * 0.8, t: 0 });

    const [lo, span, decay] = this.shellType.spread;
    if (energy < 0.1) return;
    for (const n of fr.neighbors) {
      const nb = this.frags[n];
      if (nb.state !== INTACT) continue;
      nb.hp -= energy * (lo + span * rng());
      if (nb.hp <= 0) this.queue.push({ t: this.time + 0.02 + rng() * 0.055, fr: nb, e: energy * decay });
    }
  }

  detach(fr, fvx = 0, fvy = 0) {
    if (fr.state === GONE) return;
    if (fr.state === INTACT) { fr.sprite = this.makeSprite(fr.poly); this.intactDirty = true; }
    fr.state = GONE;
    this.goneArea += fr.area;
    const rng = this.rng, b = this.body;
    let nx = fr.cx - b.cx, ny = fr.cy - b.cy;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    this.shards.push({
      poly: fr.poly, cx: fr.cx, cy: fr.cy, r: fr.r, area: fr.area, sprite: fr.sprite,
      x: fr.cx + fr.dx, y: fr.cy + fr.dy, a: fr.rot + fr.jr,
      vx: clamp(nx * (30 + rng() * 100) + fvx * 0.3, -420, 420),
      vy: clamp(ny * 40 - (50 + rng() * 120) + fvy * 0.3, -520, 300),
      w: (rng() - 0.5) * 12,
      floorY: FLOOR_Y + 5 + rng() * 50, settled: false, flat: 0, hit: false,
    });
    this.spawnCrumbs(fr.cx + fr.dx, fr.cy + fr.dy, fr.r, (rng() * 3) | 0, 110);
    this.events.detach?.();
    if (this.shards.length > 320) {
      const i = this.shards.findIndex((s) => s.settled);
      if (i >= 0) this.shards.splice(i, 1);
    }
  }

  spawnCrumbs(x, y, r, n, speed) {
    const rng = this.rng, sh = this.preset.shell;
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU, v = speed * (0.3 + rng());
      this.crumbs.push({
        x: x + Math.cos(a) * r * rng(), y: y + Math.sin(a) * r * rng(),
        vx: Math.cos(a) * v, vy: Math.sin(a) * v - 70 * rng(),
        s: 0.9 + rng() * 1.9, c: rng() < 0.55 ? sh.side : rng() < 0.5 ? sh.mid : sh.hi,
        floorY: FLOOR_Y + 3 + rng() * 54, settled: false,
      });
    }
    if (this.crumbs.length > 520) this.crumbs.splice(0, this.crumbs.length - 520);
  }

  makeSprite(poly) {
    const th = this.shellType.th, pad = th + 2, s = this.tex.scale, t = this.tex;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of poly) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    x0 -= pad; y0 -= pad;
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.ceil((x1 - x0 + pad) * s));
    c.height = Math.max(2, Math.ceil((y1 - y0 + pad) * s));
    const g = c.getContext('2d');
    g.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);
    g.lineJoin = 'round';
    // 侧面：露出蜡的厚度
    g.fillStyle = this.preset.shell.side;
    for (let k = 3; k >= 1; k--) {
      g.save(); g.translate(0, (th * k) / 3);
      g.beginPath(); tracePoly(g, poly); g.fill();
      g.restore();
    }
    g.save(); g.translate(0, th);
    g.strokeStyle = 'rgba(60,30,15,.28)'; g.lineWidth = 0.9;
    g.beginPath(); tracePoly(g, poly); g.stroke();
    g.restore();
    g.strokeStyle = 'rgba(50,25,12,.42)'; g.lineWidth = 1.3;
    g.beginPath(); tracePoly(g, poly); g.stroke();
    // 顶面：从整张脆皮贴图上裁
    g.save();
    g.beginPath(); tracePoly(g, poly); g.clip();
    g.drawImage(t.canvas, t.bx, t.by, t.bw, t.bh);
    g.strokeStyle = 'rgba(255,255,255,.42)'; g.lineWidth = 1.7;
    g.beginPath(); tracePoly(g, poly); g.stroke();
    g.restore();
    return { canvas: c, x: x0, y: y0, w: c.width / s, h: c.height / s };
  }

  renderIntact() {
    const g = this.intact.getContext('2d'), t = this.tex, s = t.scale;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.intact.width, this.intact.height);
    this.intactDirty = false;
    this.intactAny = false;
    g.setTransform(s, 0, 0, s, -t.bx * s, -t.by * s);
    g.save();
    g.beginPath();
    for (const fr of this.frags) if (fr.state === INTACT) { tracePoly(g, fr.polyX); this.intactAny = true; }
    if (this.intactAny) { g.clip(); g.drawImage(t.canvas, t.bx, t.by, t.bw, t.bh); }
    g.restore();
  }

  /** 点桌上的碎片：还能再碾碎一次 */
  crushShard(x, y) {
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      if (!s.settled || Math.abs(x - s.x) > s.r + 6 || Math.abs(y - s.y) > s.r * 0.6 + 8) continue;
      const rng = this.rng;
      this.shards.splice(i, 1);
      this.spawnCrumbs(s.x, s.y, s.r * 0.6, 3 + ((rng() * 3) | 0), 90);
      this.events.crack?.(0.4);
      if (s.area > 70) {
        const a = rng() * Math.PI, nx = Math.cos(a), ny = Math.sin(a);
        for (const sign of [1, -1]) {
          const poly = clipHalfPlane(s.poly, s.cx, s.cy, nx * sign, ny * sign);
          if (poly.length < 3) continue;
          const st = polyStats(poly);
          if (st.area < 8) continue;
          let r = 0;
          for (const p of poly) r = Math.max(r, Math.hypot(p[0] - st.cx, p[1] - st.cy));
          const ca = Math.cos(s.a), sa = Math.sin(s.a), ox = st.cx - s.cx, oy = st.cy - s.cy;
          this.shards.push({
            poly, cx: st.cx, cy: st.cy, r, area: st.area, sprite: this.makeSprite(poly),
            x: s.x + ox * ca - oy * sa, y: s.y - 2, a: s.a,
            vx: -sign * nx * (50 + rng() * 60), vy: -(130 + rng() * 90), w: (rng() - 0.5) * 9,
            floorY: clamp(s.floorY + (rng() - 0.5) * 12, FLOOR_Y + 5, FLOOR_Y + 56),
            settled: false, flat: 1, hit: true,
          });
        }
      }
      return true;
    }
    return false;
  }

  // ---------------- 每帧 ----------------
  update(dt) {
    this.time += dt;
    const b = this.body;

    // 手指：拖动内芯 + 给脆皮施压
    const active = [];
    for (const f of this.fingers.values()) {
      f.t += dt;
      const dx = f.x - f.px, dy = f.y - f.py, mv = Math.hypot(dx, dy);
      f.vx = dx / dt; f.vy = dy / dt;
      f.speed += (mv / dt - f.speed) * Math.min(1, dt * 14);
      const press = Math.min(1, f.t / 0.16);
      b.push(f.x, f.y, (press - f.press) * this.coreType.bulge);
      f.press = press;
      b.drag(f.px, f.py, dx, dy);
      this.pressShell(f, dt);
      f.px = f.x; f.py = f.y;
      active.push(f);
      const d = f.dent;
      d.x = f.x; d.y = f.y; d.depth = Math.max(d.depth, f.press);
      f.trail += mv;
      if (f.trail > 26) {
        // 拖动时沿路留下一串慢慢回弹的指印
        f.trail = 0;
        this.releaseDent(d);
        f.dent = { x: f.x, y: f.y, depth: 0.7, active: true, at: null };
        this.dents.push(f.dent);
        if (this.dents.length > 36) this.dents.shift();
      }
    }

    // 脆皮状态 → 内芯软硬
    for (let i = 0; i < b.n; i++) {
      const st = this.frags[b.frag[i]].state;
      const target = st === INTACT ? 1 : st === CRACKED ? 0.42 : 0;
      b.hold[i] += (target - b.hold[i]) * Math.min(1, dt * 9);
    }
    b.step(dt, active);

    // 排队中的连锁开裂
    if (this.queue.length) {
      const due = this.queue.filter((q) => q.t <= this.time);
      this.queue = this.queue.filter((q) => q.t > this.time);
      for (const q of due) this.crack(q.fr, q.e); // crack() 里可能又排进新的
    }

    // 已经裂开的碎片：跟着内芯动，松了就掉
    let bare = 0;
    for (const fr of this.frags) {
      if (fr.state === GONE) { bare += fr.area; continue; }
      if (fr.state === INTACT) continue;
      bare += fr.area * 0.5;
      b.disp(fr.attach, tmp);
      fr.dx = tmp[0] + fr.jx; fr.dy = tmp[1] + fr.jy;
      fr.rot = b.rot(fr.attach) * 0.8;
      if (fr.pop > 0) fr.pop = Math.max(0, fr.pop - dt * 7);
      const stretch = Math.hypot(tmp[0], tmp[1]);
      if (stretch > 13) fr.loose += dt * (stretch - 13) * 0.3;
      let support = 0;
      for (const n of fr.neighbors) if (this.frags[n].state !== GONE) support++;
      if (support === 0) fr.loose += dt * 3;
      if (fr.loose >= 1) {
        let fvx = 0, fvy = 0;
        for (const f of active) if (Math.hypot(f.x - fr.cx - fr.dx, f.y - fr.cy - fr.dy) < 70) { fvx = f.vx; fvy = f.vy; }
        this.detach(fr, fvx, fvy);
      }
    }
    const bareFrac = bare / this.totalArea;
    this.squish = clamp((b.speed - 5) / 70, 0, 1) * bareFrac;

    // 飞出去的碎片和渣渣
    const [wl, wr] = this.walls;
    for (const s of this.shards) {
      if (s.settled) { s.flat += (1 - s.flat) * Math.min(1, dt * 10); continue; }
      s.vy += GRAVITY * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.a += s.w * dt;
      if (s.x < wl) { s.x = wl; s.vx = Math.abs(s.vx) * 0.4; }
      if (s.x > wr) { s.x = wr; s.vx = -Math.abs(s.vx) * 0.4; }
      if (s.y >= s.floorY && s.vy > 0) {
        s.y = s.floorY;
        if (!s.hit || s.vy > 260) this.events.land?.(clamp(s.vy / 700, 0.15, 1));
        s.hit = true;
        if (s.vy > 150) { s.vy *= -0.26; s.vx *= 0.55; s.w *= 0.45; }
        else { s.settled = true; s.vx = s.vy = s.w = 0; }
      }
      if (s.hit) s.flat += (1 - s.flat) * Math.min(1, dt * 8);
    }
    for (const c of this.crumbs) {
      if (c.settled) continue;
      c.vy += GRAVITY * dt;
      c.x += c.vx * dt; c.y += c.vy * dt;
      if (c.x < wl || c.x > wr) { c.x = clamp(c.x, wl, wr); c.vx *= -0.4; }
      if (c.y >= c.floorY && c.vy > 0) {
        c.y = c.floorY;
        if (c.vy > 170) { c.vy *= -0.3; c.vx *= 0.5; }
        else c.settled = true;
      }
    }
    for (const p of this.puffs) p.t += dt * 3.2;
    if (this.puffs.length && this.puffs[0].t >= 1) this.puffs = this.puffs.filter((p) => p.t < 1);

    // 指印：按着的时候加深，松手后按内芯类型回弹
    const tau = this.coreType.dentTau;
    for (const d of this.dents) {
      if (d.active) continue;
      d.depth *= Math.exp(-dt / tau);
      b.disp(d.at, tmp);
      d.x = d.rx + tmp[0]; d.y = d.ry + tmp[1];
    }
    if (this.dents.some((d) => !d.active && d.depth < 0.03)) this.dents = this.dents.filter((d) => d.active || d.depth >= 0.03);

    // 捏完了
    if (!this.done && this.goneArea / this.totalArea >= 0.965) {
      for (const fr of this.frags) if (fr.state !== GONE) this.detach(fr);
      this.done = true;
      this.endAt = this.time;
      this.events.done?.(this);
    }
  }

  pressShell(f, dt) {
    const hold = Math.min(1, f.t / 0.5);
    const R = 30 + 26 * hold;
    const power = 0.5 + 1.3 * hold + Math.min(3, f.speed / 160);
    for (const fr of this.frags) {
      if (fr.state === GONE) continue;
      const reach = R + fr.r * 0.5;
      const d = Math.hypot(fr.cx + fr.dx - f.x, fr.cy + fr.dy - f.y);
      if (d > reach) continue;
      const k = 1 - d / reach;
      if (fr.state === INTACT) {
        fr.hp -= power * k * dt * 1.5;
        if (fr.hp <= 0) this.crack(fr, 0.8);
      } else fr.loose += power * k * dt * (0.9 + f.speed / 120);
    }
  }
}

export { INTACT, CRACKED, GONE, BASE_Y };
