import { clamp } from './util.js';

const SR = 44100;

/** 一声"咔嚓"：瞬态 click + 几个高频共振模态 + 砂砾噪声，再叠几次微小的二次碎裂 */
function synthCrack(kind, rnd) {
  const P = {
    thin: { f: [3200, 9500], tau: [0.002, 0.008], len: 0.07, low: 0, extra: 3 },
    std: { f: [2000, 7000], tau: [0.004, 0.013], len: 0.095, low: 0.22, extra: 3 },
    thick: { f: [850, 3800], tau: [0.007, 0.024], len: 0.14, low: 0.6, extra: 2 },
  }[kind];
  const n = Math.floor(SR * P.len), d = new Float32Array(n);
  const events = [{ t: 0, amp: 1 }];
  for (let i = 0; i < P.extra; i++) events.push({ t: 0.004 + rnd() * P.len * 0.55, amp: 0.15 + rnd() * 0.45 });
  for (const ev of events) {
    const modes = [];
    for (let k = 0; k < 5; k++)
      modes.push({
        w: 2 * Math.PI * (P.f[0] + rnd() * (P.f[1] - P.f[0])),
        tau: P.tau[0] + rnd() * (P.tau[1] - P.tau[0]),
        a: 0.3 + rnd() * 0.7, ph: rnd() * 6.283,
      });
    let prev = 0;
    for (let i = Math.floor(ev.t * SR); i < n; i++) {
      const t = i / SR - ev.t;
      const nz = rnd() * 2 - 1, hp = nz - prev;
      prev = nz;
      let s = nz * Math.exp(-t / 0.0011) * 0.9 + hp * Math.exp(-t / (P.tau[1] * 0.8)) * 0.3;
      for (const m of modes) s += m.a * Math.sin(m.w * t + m.ph) * Math.exp(-t / m.tau) * 0.22;
      d[i] += s * ev.amp;
    }
  }
  if (P.low) for (let i = 0; i < n; i++) {
    const t = i / SR;
    d[i] += Math.sin(2 * Math.PI * (210 - 900 * t) * t) * Math.exp(-t / 0.02) * P.low;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  for (let i = 0; i < n; i++) d[i] *= (0.9 / peak) * Math.min(1, (n - i) / 200);
  return d;
}

function synthTick(rnd) {
  const n = Math.floor(SR * 0.03), d = new Float32Array(n);
  const w = 2 * Math.PI * (1800 + rnd() * 3200);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    d[i] = (Math.sin(w * t) * 0.6 + (rnd() * 2 - 1) * 0.5) * Math.exp(-t / 0.004);
  }
  return d;
}

export class Sfx {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.kind = 'std';
    let seed = 20261112;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0), (seed >>> 0) / 4294967296);
    // 页面加载时先把波形算好，第一下点击就能立刻出声
    this.raw = { thin: [], std: [], thick: [], tick: [] };
    for (const k of ['thin', 'std', 'thick']) for (let i = 0; i < 6; i++) this.raw[k].push(synthCrack(k, rnd));
    for (let i = 0; i < 4; i++) this.raw.tick.push(synthTick(rnd));
    this.buf = null;
    this.recent = [];
  }

  /** 必须在用户手势里调用 */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = (this.ctx = new AC());
      this.master = ctx.createGain();
      this.master.gain.value = this.enabled ? 0.9 : 0;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.1;
      this.master.connect(comp).connect(ctx.destination);
      this.buf = {};
      for (const k in this.raw)
        this.buf[k] = this.raw[k].map((d) => {
          const b = ctx.createBuffer(1, d.length, SR);
          b.getChannelData(0).set(d);
          return b;
        });
      // 揉内芯的"咕叽"底噪：循环噪声 → 低通 → 音量跟着形变速度走
      const nb = ctx.createBuffer(1, SR * 2, SR), nd = nb.getChannelData(0);
      let last = 0;
      for (let i = 0; i < nd.length; i++) { last = last * 0.86 + (Math.random() * 2 - 1) * 0.14; nd[i] = last * 3; }
      const src = ctx.createBufferSource();
      src.buffer = nb; src.loop = true;
      this.sqFilter = ctx.createBiquadFilter();
      this.sqFilter.type = 'bandpass'; this.sqFilter.frequency.value = 500; this.sqFilter.Q.value = 0.8;
      this.sqGain = ctx.createGain(); this.sqGain.gain.value = 0;
      src.connect(this.sqFilter).connect(this.sqGain).connect(this.master);
      src.start();
    }
    if (this.ctx.state === 'suspended')
      this.ctx.resume().then(() => {
        // 触屏的第一下是在解锁前捏的：解锁后立刻补一声
        if (this.missed) { this.missed = false; this.crack(1); }
      }).catch(() => {});
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.02);
  }

  get running() { return !!this.ctx && this.ctx.state === 'running'; }

  play(buffer, gain, rate, delay = 0) {
    // 还没被系统放行时不排队，否则解锁的一瞬间会把攒着的声音一起放出来
    if (!this.running) return;
    const ctx = this.ctx, src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buffer; src.playbackRate.value = rate; g.gain.value = gain;
    let node = src.connect(g);
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.random() * 0.8 - 0.4;
      node = node.connect(p);
    }
    node.connect(this.master);
    src.start(ctx.currentTime + delay);
  }

  crack(energy) {
    if (!this.running) { this.missed = true; return; }
    if (!this.enabled) return;
    // 同一瞬间太多声会糊成一片：超过的往后错开一点，变成一串脆响
    const now = this.ctx.currentTime;
    this.recent = this.recent.filter((t) => t > now - 0.03);
    if (this.recent.length > 5) return;
    const delay = this.recent.length * 0.011;
    this.recent.push(now + delay);
    const set = this.buf[this.kind];
    this.play(set[(Math.random() * set.length) | 0], 0.22 + 0.6 * energy, 0.85 + Math.random() * 0.4, delay);
  }

  land(v) {
    if (!this.ctx || !this.enabled || Math.random() > 0.7) return;
    const set = this.buf.tick;
    this.play(set[(Math.random() * set.length) | 0], 0.05 + 0.16 * v, 0.7 + Math.random() * 0.7);
  }

  /** 每帧调用：level 是内芯的形变速度（0~1） */
  squish(level, wet) {
    if (!this.running) return;
    const t = this.ctx.currentTime;
    this.sqGain.gain.setTargetAtTime(clamp(level, 0, 1) * (wet ? 0.5 : 0.3), t, 0.06);
    this.sqFilter.frequency.setTargetAtTime((wet ? 700 : 380) + level * 900, t, 0.08);
    if (wet && level > 0.25 && Math.random() < level * 0.25) this.bubble(0.05 + level * 0.08);
  }

  bubble(gain = 0.08) {
    if (!this.running || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    const f = 180 + Math.random() * 260;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * (2 + Math.random()), t + 0.06);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.09);
  }

  chime() {
    if (!this.running || !this.enabled) return;
    const ctx = this.ctx, t0 = ctx.currentTime + 0.12;
    [[1046.5, 0], [1318.5, 0.09], [1568, 0.18]].forEach(([f, dt]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.11, t0 + dt + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.6);
      o.connect(g).connect(this.master);
      o.start(t0 + dt); o.stop(t0 + dt + 0.65);
    });
  }
}
