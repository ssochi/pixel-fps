/* global THREE */
import { buildShape } from './geo.js';
import { PLATE_H, PLATE_R } from './squishy.js';
import { clamp } from './util.js';

/** 场景：一张桌子、一个白瓷盘、一盏主灯。相机绕着盘子转 */
export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' }));
    r.outputEncoding = THREE.sRGBEncoding;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.94;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.5, 60);
    this.az = 0.5; this.el = 0.62; this.dist = 9;
    this.target = new THREE.Vector3(0, 0.42, 0);

    this.hemi = new THREE.HemisphereLight(0xfff3e6, 0xd9a48c, 0.22);
    this.scene.add(this.hemi);
    const key = (this.key = new THREE.DirectionalLight(0xfff0dc, 0.95));
    key.position.set(-3.2, 6.5, 3.6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -4.2; sc.right = sc.top = 4.2; sc.near = 1; sc.far = 16;
    key.shadow.bias = -0.0015; key.shadow.normalBias = 0.02; key.shadow.radius = 3;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffdfe6, 0.22);
    fill.position.set(4, 3, -3);
    this.scene.add(fill);

    // 桌面：边缘渐隐到页面背景里，所以不需要地平线
    const fade = document.createElement('canvas');
    fade.width = fade.height = 256;
    const g = fade.getContext('2d'), grad = g.createRadialGradient(128, 128, 60, 128, 128, 128);
    grad.addColorStop(0, '#fff'); grad.addColorStop(1, '#000');
    g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
    this.table = new THREE.Mesh(
      new THREE.CircleGeometry(9, 64),
      new THREE.MeshStandardMaterial({ color: 0xf2cdbd, roughness: 0.95, transparent: true, alphaMap: new THREE.CanvasTexture(fade) }),
    );
    this.table.rotation.x = -Math.PI / 2;
    this.table.position.y = -PLATE_H;
    this.table.receiveShadow = true;
    this.scene.add(this.table);

    // 盘子：车削出一个带矮边的浅盘
    const prof = [[0, -PLATE_H], [PLATE_R * 0.8, -PLATE_H], [PLATE_R + 0.2, 0.05], [PLATE_R + 0.26, 0.06], [PLATE_R + 0.22, 0.02], [PLATE_R, 0], [0, 0]];
    this.plate = new THREE.Mesh(
      new THREE.LatheGeometry(prof.map(([x, y]) => new THREE.Vector2(x, y)), 72),
      new THREE.MeshStandardMaterial({ color: 0xf4ece4, roughness: 0.3, side: THREE.DoubleSide }),
    );
    this.plate.receiveShadow = true;
    this.plate.castShadow = true;
    this.scene.add(this.plate);

    // 环境光照：一个带两块"柔光箱"的小摄影棚，蜡面和巧克力才有像样的反光
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(12, 24, 12), new THREE.MeshBasicMaterial({ color: 0x3d3835, side: THREE.BackSide })));
    const box = (w, h, x, y, z, c) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c, c * 0.96, c * 0.9), side: THREE.DoubleSide }));
      m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
    };
    box(9, 9, -2, 9, 2, 1.7);
    box(5, 7, -9, 3, 5, 1.0);
    box(4, 5, 8, 4, -5, 0.5);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: 0x5a4a42 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -2; env.add(floor);
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(env, 0.035).texture;
    pm.dispose();

    // 蜡粉：裂开的瞬间喷一小团白雾
    const dot = document.createElement('canvas');
    dot.width = dot.height = 64;
    const dg = dot.getContext('2d'), rg = dg.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, 'rgba(255,255,255,.9)'); rg.addColorStop(0.4, 'rgba(255,255,255,.35)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    dg.fillStyle = rg; dg.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(dot);
    this.puffs = [];
    for (let i = 0; i < 28; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      sp.visible = false;
      this.scene.add(sp);
      this.puffs.push({ sp, t: 1, size: 0.3, vy: 0 });
    }
    this.puffHead = 0;
    this.shake = 0;

    this.caster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
  }

  puff(pos, size) {
    const p = this.puffs[this.puffHead];
    this.puffHead = (this.puffHead + 1) % this.puffs.length;
    p.sp.position.copy(pos);
    p.sp.visible = true;
    p.t = 0; p.size = size; p.vy = 0.3 + Math.random() * 0.4;
  }

  /** 一次碎得多，镜头轻轻震一下 */
  kick(a) { this.shake = Math.min(0.07, this.shake + a); }

  update(dt) {
    for (const p of this.puffs) {
      if (p.t >= 1) continue;
      p.t += dt / 0.55;
      if (p.t >= 1) { p.sp.visible = false; continue; }
      p.sp.position.y += p.vy * dt;
      const k = p.size * (0.5 + 1.6 * Math.sqrt(p.t));
      p.sp.scale.set(k, k, 1);
      p.sp.material.opacity = 0.55 * (1 - p.t) ** 1.5;
    }
    if (this.shake > 0.0005) {
      this.shake *= Math.exp(-dt * 16);
      this.place();
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
    } else if (this.shake > 0) { this.shake = 0; this.place(); }
  }

  setTheme(dark, tableColor) {
    this.table.material.color.set(tableColor);
    this.plate.material.color.set(dark ? 0xd8cdc6 : 0xf4ece4);
    this.hemi.intensity = dark ? 0.14 : 0.22;
    this.key.intensity = dark ? 0.8 : 0.9;
  }

  resize(w, h) {
    this.w = w; this.h = h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // 竖屏时拉远，保证盘子左右不被裁掉
    const half = (this.camera.fov * Math.PI) / 360;
    const fitW = 1.72 / (Math.tan(half) * this.camera.aspect);
    this.dist = clamp(Math.max(7.4, fitW), 7.4, 19);
    this.camera.updateProjectionMatrix();
    this.place();
  }

  orbit(dx, dy) {
    this.az -= dx * 0.008;
    this.el = clamp(this.el + dy * 0.006, 0.22, 1.25);
    this.place();
  }

  place() {
    const c = Math.cos(this.el), s = Math.sin(this.el);
    this.camera.position.set(this.target.x + Math.sin(this.az) * c * this.dist, this.target.y + s * this.dist, this.target.z + Math.cos(this.az) * c * this.dist);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  /** 屏幕坐标 → 世界空间射线（返回新对象，可以留着下一帧用） */
  ray(x, y) {
    this.ndc.set((x / this.w) * 2 - 1, -(y / this.h) * 2 + 1);
    this.caster.setFromCamera(this.ndc, this.camera);
    return this.caster.ray.clone();
  }

  render() { this.renderer.render(this.scene, this.camera); }
}

/** 选款面板里的小图：用一个临时渲染器把每款低模各拍一张 */
export function renderThumbs(foods, size = 168) {
  const canvas = document.createElement('canvas');
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.outputEncoding = THREE.sRGBEncoding;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.setSize(size, size, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff3e6, 0xd9a48c, 0.6));
  const key = new THREE.DirectionalLight(0xfff0dc, 1.0);
  key.position.set(-3, 6, 4);
  scene.add(key);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.5, 30);
  const out = [];
  for (const food of foods) {
    const sh = buildShape(food, 14);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(sh.P0, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(sh.N0, 3));
    g.setAttribute('color', new THREE.BufferAttribute(sh.col, 3));
    g.setIndex(new THREE.BufferAttribute(sh.idx, 1));
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: food.rough }));
    scene.add(mesh);
    const d = Math.max(sh.rad, sh.top * 0.7) * 4.4;
    cam.position.set(d * 0.42, sh.top * 0.5 + d * 0.5, d * 0.72);
    cam.lookAt(0, sh.top * 0.45, 0);
    r.render(scene, cam);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(canvas, 0, 0);
    out.push(c);
    scene.remove(mesh);
    g.dispose(); mesh.material.dispose();
  }
  r.dispose();
  r.forceContextLoss?.();
  return out;
}
