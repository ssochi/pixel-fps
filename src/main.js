/* global THREE */
import { Sfx } from './audio.js';
import { CORE_TYPES, FOODS, SHELL_TYPES } from './foods.js';
import { Squishy } from './squishy.js';
import { Stage, renderThumbs } from './stage.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const sfx = new Sfx();
const canVibrate = () => !!navigator.vibrate && navigator.userActivation?.hasBeenActive !== false;
const stage = new Stage(canvas);
// 网格密度：细一点裂缝更自然，但每帧要算的顶点也更多
const DETAIL = 30;

// ---------- 记住上次的选择 ----------
const store = {
  get() { try { return JSON.parse(localStorage.getItem('cuipi-nienie-3d') || '{}'); } catch { return {}; } },
  set(v) { try { localStorage.setItem('cuipi-nienie-3d', JSON.stringify(v)); } catch { /* 隐私模式下可能不可用 */ } },
};
const saved = store.get();
const state = {
  food: FOODS.find((p) => p.id === saved.food) || FOODS[0],
  shell: SHELL_TYPES[saved.shell] ? saved.shell : null,
  core: CORE_TYPES[saved.core] ? saved.core : null,
  sound: saved.sound !== false,
};
state.shell ||= state.food.shellType;
state.core ||= state.food.coreType;
sfx.enabled = state.sound;
const save = () => store.set({ food: state.food.id, shell: state.shell, core: state.core, sound: state.sound });

let round = null;
let lastVibe = 0;
let hintOff = false;
let spawnT = 0;
let burst = 0; // 本帧新裂开的碎片数

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const dark = cs.colorScheme.includes('dark') && !cs.colorScheme.includes('light');
  stage.setTheme(dark, cs.getPropertyValue('--table0').trim() || '#f2cdbd');
}

function resize() {
  stage.resize(window.innerWidth, window.innerHeight);
  readTheme();
}

function newRound() {
  if (round) { stage.scene.remove(round.group); round.dispose(); }
  round = new Squishy(state.food, state.shell, state.core, (Math.random() * 2 ** 31) | 0, DETAIL, {
    crack(e) {
      sfx.crack(e);
      if (!hintOff) { hintOff = true; $('hint').classList.add('off'); }
      const now = performance.now();
      if (canVibrate() && now - lastVibe > 45) { lastVibe = now; try { navigator.vibrate(e > 0.7 ? 12 : 6); } catch { /* 无震动 */ } }
    },
    puff(pos, e) { burst++; if (Math.random() < 0.3 + e * 0.5) stage.puff(pos, 0.22 + e * 0.28); },
    land(v) { sfx.land(v); },
    squishTap() { if (state.core === 'jelly') sfx.bubble(0.1); },
    done(r) {
      sfx.chime();
      if (canVibrate()) try { navigator.vibrate([20, 40, 30]); } catch { /* 无震动 */ }
      showToast(`脆皮捏光啦！用时 ${r.elapsed.toFixed(1)} 秒 · 咔嚓 ${r.cracks} 声`, '内芯还能接着捏，盘子里的碎片点一下能碾成渣');
    },
  });
  stage.scene.add(round.group);
  stage.target.y = round.shape.top * 0.42;
  stage.place();
  spawnT = 0;
  sfx.kind = state.shell;
  $('modelName').textContent = state.food.name;
  hideToast();
  save();
}

// ---------- 输入：按在捏捏上 = 捏；按在空白处拖 = 转视角 ----------
const orbiting = new Map();
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (e.pointerType === 'mouse' || sfx.ctx) sfx.unlock();
  const what = round.pointerDown(e.pointerId, stage.ray(e.clientX, e.clientY));
  if (!what) orbiting.set(e.pointerId, [e.clientX, e.clientY]);
  if (what !== 'shard') { try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成事件没有可捕获的指针 */ } }
});
canvas.addEventListener('pointermove', (e) => {
  const o = orbiting.get(e.pointerId);
  if (o) {
    stage.orbit(e.clientX - o[0], e.clientY - o[1]);
    o[0] = e.clientX; o[1] = e.clientY;
  } else round.pointerMove(e.pointerId, stage.ray(e.clientX, e.clientY));
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
  canvas.addEventListener(type, (e) => { orbiting.delete(e.pointerId); round.pointerUp(e.pointerId); });
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
  syncSound(); save();
});
syncSound();

// ---------- 选款面板 ----------
const sheet = $('sheet');
function buildSheet() {
  const grid = $('grid');
  let thumbs = [];
  try { thumbs = renderThumbs(FOODS); } catch { /* 没有小图也能选 */ }
  FOODS.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'card'; b.dataset.id = p.id;
    if (thumbs[i]) b.appendChild(thumbs[i]);
    const name = document.createElement('span'); name.textContent = p.name;
    const tag = document.createElement('small');
    tag.textContent = `${SHELL_TYPES[p.shellType].name} · ${CORE_TYPES[p.coreType].name}`;
    b.append(name, tag);
    b.addEventListener('click', () => {
      state.food = p; state.shell = p.shellType; state.core = p.coreType;
      syncSheet(); newRound();
    });
    grid.appendChild(b);
  });
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
  for (const b of $('grid').children) b.setAttribute('aria-pressed', String(b.dataset.id === state.food.id));
  for (const b of $('optShell').children) b.setAttribute('aria-pressed', String(b.dataset.k === state.shell));
  for (const b of $('optCore').children) b.setAttribute('aria-pressed', String(b.dataset.k === state.core));
}
$('btnPick').addEventListener('click', () => { sfx.unlock(); syncSheet(); sheet.hidden = false; });

// ---------- 主循环 ----------
let last = performance.now();
const easeOutBack = (t) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;
function frame(now) {
  const dt = Math.min(1 / 30, Math.max(1 / 240, (now - last) / 1000));
  last = now;
  burst = 0;
  round.update(dt);
  // 这一帧同时裂了好几块：加一声厚的、镜头震一下、震动长一点
  if (burst >= 4) {
    const lv = Math.min(1, burst / 14);
    sfx.crunch(lv);
    stage.kick(0.012 + 0.03 * lv);
    if (canVibrate()) try { navigator.vibrate(18 + Math.round(22 * lv)); } catch { /* 无震动 */ }
  }
  stage.update(dt);
  if (spawnT < 1) {
    spawnT = Math.min(1, spawnT + dt / 0.4);
    round.group.scale.setScalar(Math.max(0.01, easeOutBack(spawnT)));
  }
  sfx.squish(round.squish, state.core === 'jelly');
  stage.render();
  updateHud();
  requestAnimationFrame(frame);
}

window.addEventListener('resize', resize);
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', readTheme);
new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
document.addEventListener('visibilitychange', () => { last = performance.now(); });

resize();
buildSheet();
newRound();
requestAnimationFrame(frame);

// 调试 / 自动化测试用
window.__nienie = { get round() { return round; }, stage, state, sfx, newRound, THREE };
