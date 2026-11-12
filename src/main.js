import { Sfx } from './audio.js';
import { drawLeftovers, drawRound, drawTable } from './render.js';
import { Round } from './round.js';
import { CORE_TYPES, PRESETS, SHELL_TYPES, buildShellTexture, getOutline } from './shapes.js';
import { clamp } from './util.js';

// 老一点的浏览器没有 roundRect
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r); this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r); this.arcTo(x, y, x + w, y, r);
    this.closePath();
  };
}

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const ctx = canvas.getContext('2d');
const sfx = new Sfx();
const canVibrate = () => !!navigator.vibrate && navigator.userActivation?.hasBeenActive !== false;

const view = { w: 0, h: 0, dpr: 1, scale: 1, ox: 0, oy: 0, left: 0, right: 0, top: 0, bottom: 0 };
const colors = { table0: '#f7d6c8', table1: '#efc2b4', tableEdge: 'rgba(255,255,255,.6)' };

// ---------- 记住上次的选择 ----------
const store = {
  get() { try { return JSON.parse(localStorage.getItem('cuipi-nienie') || '{}'); } catch { return {}; } },
  set(v) { try { localStorage.setItem('cuipi-nienie', JSON.stringify(v)); } catch { /* 隐私模式下可能不可用 */ } },
};
const saved = store.get();
const state = {
  preset: PRESETS.find((p) => p.id === saved.preset) || PRESETS[0],
  shell: SHELL_TYPES[saved.shell] ? saved.shell : null,
  core: CORE_TYPES[saved.core] ? saved.core : null,
  sound: saved.sound !== false,
};
state.shell ||= state.preset.shellType;
state.core ||= state.preset.coreType;
sfx.enabled = state.sound;

let round = null;
let leftovers = null; // 上一只的碎片，淡出用
let lastVibe = 0;
let hintOff = false;

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  colors.table0 = cs.getPropertyValue('--table0').trim() || colors.table0;
  colors.table1 = cs.getPropertyValue('--table1').trim() || colors.table1;
  colors.tableEdge = cs.getPropertyValue('--table-edge').trim() || colors.tableEdge;
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  view.w = w; view.h = h; view.dpr = dpr;
  view.scale = Math.min(w / 300, h / 540, 2.4);
  view.ox = w / 2; view.oy = h * 0.47;
  view.left = -view.ox / view.scale; view.right = (w - view.ox) / view.scale;
  view.top = -view.oy / view.scale; view.bottom = (h - view.oy) / view.scale;
  if (round) round.walls = [view.left + 10, view.right - 10];
  readColors();
}

function newRound() {
  if (round && (round.shards.length || round.crumbs.length)) leftovers = { round, alpha: 1 };
  const texScale = clamp(view.scale * view.dpr, 2, 4);
  round = new Round(state.preset, state.shell, state.core, (Math.random() * 2 ** 31) | 0, texScale, {
    crack(e) {
      sfx.crack(e);
      if (!hintOff) { hintOff = true; $('hint').classList.add('off'); }
      const now = performance.now();
      if (canVibrate() && now - lastVibe > 45) { lastVibe = now; try { navigator.vibrate(e > 0.7 ? 12 : 6); } catch { /* 无震动 */ } }
    },
    detach() {},
    land(v) { sfx.land(v); },
    squishTap() { if (state.core === 'jelly') sfx.bubble(0.1); },
    done(r) {
      sfx.chime();
      if (canVibrate()) try { navigator.vibrate([20, 40, 30]); } catch { /* 无震动 */ }
      showToast(`捏完啦！用时 ${r.elapsed.toFixed(1)} 秒 · 咔嚓 ${r.cracks} 声`, '内芯还能接着捏，桌上的碎片也能再碾一遍');
    },
  });
  round.walls = [view.left + 10, view.right - 10];
  sfx.kind = state.shell;
  $('modelName').textContent = state.preset.name;
  hideToast();
  store.set({ preset: state.preset.id, shell: state.shell, core: state.core, sound: state.sound });
}

// ---------- 输入 ----------
const toWorld = (e) => [(e.clientX - view.ox) / view.scale, (e.clientY - view.oy) / view.scale];
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (e.pointerType === 'mouse' || sfx.ctx) sfx.unlock();
  const [x, y] = toWorld(e);
  if (round.pointerDown(e.pointerId, x, y)) {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成事件没有可捕获的指针 */ }
  }
});
canvas.addEventListener('pointermove', (e) => {
  const [x, y] = toWorld(e);
  round.pointerMove(e.pointerId, x, y);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
  canvas.addEventListener(type, (e) => round.pointerUp(e.pointerId));
// 触屏上 pointerdown 不算"用户激活"，要等手指抬起才能真正开声音
for (const type of ['pointerup', 'touchend', 'click'])
  window.addEventListener(type, () => sfx.unlock(), { passive: true });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- HUD ----------
let toastTimer = 0;
function showToast(text, sub) {
  const t = $('toast');
  t.textContent = text;
  if (sub) { const s = document.createElement('small'); s.textContent = sub; t.appendChild(s); }
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}
function hideToast() { $('toast').classList.remove('on'); }

const hud = { pct: -1, cracks: -1, time: '' };
function updateHud() {
  const pct = Math.round(round.shellLeft * 100);
  if (pct !== hud.pct) {
    hud.pct = pct;
    $('shellPct').textContent = pct + '%';
    $('shellBar').style.width = pct + '%';
    $('shellBar').parentElement.setAttribute('aria-valuenow', pct);
  }
  if (round.cracks !== hud.cracks) { hud.cracks = round.cracks; $('crackCount').textContent = '咔嚓 ' + round.cracks; }
  const t = round.elapsed.toFixed(1) + ' 秒';
  if (t !== hud.time) { hud.time = t; $('timer').textContent = t; }
}

$('btnAgain').addEventListener('click', () => { sfx.unlock(); newRound(); });
const soundBtn = $('btnSound');
function syncSound() {
  soundBtn.textContent = state.sound ? '声音 开' : '声音 关';
  soundBtn.setAttribute('aria-pressed', String(state.sound));
}
soundBtn.addEventListener('click', () => {
  state.sound = !state.sound;
  sfx.unlock(); sfx.setEnabled(state.sound);
  syncSound();
  store.set({ preset: state.preset.id, shell: state.shell, core: state.core, sound: state.sound });
});
syncSound();

// ---------- 选款面板 ----------
const sheet = $('sheet');
function buildSheet() {
  const grid = $('grid');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'card'; b.dataset.id = p.id;
    const { m } = getOutline(p);
    const size = 152, s = (size * 0.86) / Math.max(m.w, m.h);
    const tex = buildShellTexture(p, s);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(tex.canvas, (size - tex.canvas.width) / 2, (size - tex.canvas.height) / 2);
    const name = document.createElement('span'); name.textContent = p.name;
    const tag = document.createElement('small');
    tag.textContent = `${SHELL_TYPES[p.shellType].name} · ${CORE_TYPES[p.coreType].name}`;
    b.append(c, name, tag);
    b.addEventListener('click', () => {
      state.preset = p; state.shell = p.shellType; state.core = p.coreType;
      syncSheet(); newRound();
    });
    grid.appendChild(b);
  }
  const chips = (host, types, key) => {
    for (const k in types) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.dataset.k = k; b.textContent = types[k].name;
      b.addEventListener('click', () => { state[key] = k; syncSheet(); newRound(); });
      host.appendChild(b);
    }
  };
  chips($('optShell'), SHELL_TYPES, 'shell');
  chips($('optCore'), CORE_TYPES, 'core');
  sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) sheet.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') sheet.hidden = true; });
}
function syncSheet() {
  for (const b of $('grid').children) b.setAttribute('aria-pressed', String(b.dataset.id === state.preset.id));
  for (const b of $('optShell').children) b.setAttribute('aria-pressed', String(b.dataset.k === state.shell));
  for (const b of $('optCore').children) b.setAttribute('aria-pressed', String(b.dataset.k === state.core));
}
$('btnPick').addEventListener('click', () => { sfx.unlock(); syncSheet(); sheet.hidden = false; });

// ---------- 主循环 ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(1 / 30, Math.max(1 / 240, (now - last) / 1000));
  last = now;
  round.update(dt);
  sfx.squish(round.squish, state.core === 'jelly');

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const k = view.dpr * view.scale;
  ctx.setTransform(k, 0, 0, k, view.dpr * view.ox, view.dpr * view.oy);
  drawTable(ctx, view, colors);
  if (leftovers) {
    leftovers.alpha -= dt * 2.6;
    if (leftovers.alpha <= 0) leftovers = null;
    else drawLeftovers(ctx, leftovers.round, leftovers.alpha);
  }
  drawRound(ctx, round);
  updateHud();
  requestAnimationFrame(frame);
}

window.addEventListener('resize', resize);
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', readColors);
new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
document.addEventListener('visibilitychange', () => { last = performance.now(); });

resize();
buildSheet();
newRound();
requestAnimationFrame(frame);

// 调试 / 自动化测试用
window.__nienie = { get round() { return round; }, view, state, sfx, newRound };
