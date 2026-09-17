import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import occtimportjs from 'occt-import-js';
import './style.css';
import { createLesson } from './lesson.js';

const COLORS = {
  bg: 0x10131a,
  panel: '#171b24',
  panel2: '#202634',
  text: '#f7f8fb',
  muted: '#9da6b8',
  accent: '#ff9b5b',
  cyan: '#64d5ff',
  green: '#7ee6a4',
  red: '#ff7474',
  pcb: 0x0b6b59,
  pcbEdge: 0x0a4038,
  plastic: 0xf1f3f6,
  black: 0x0b0d11,
  copper: 0xc78655,
  metal: 0xc6ccd6,
  header: 0x1d2430,
};

const STEPS = [
  { title: '先核对零件', hint: 'PCB、两条排母、屏幕/排线、喇叭、3 个按键、摇杆、2 颗螺钉和 2 颗铜螺母', focus: 'parts' },
  { title: '安装两条排母', hint: '让排母的塑料底座朝 PCB，上下两排孔位对应，不要错位一孔', focus: 'headers' },
  { title: '插入 ESP32-P4', hint: '从上方垂直压入两条排母；天线/USB 方向按 PCB 丝印对齐', focus: 'esp32' },
  { title: '装屏幕和排线', hint: '屏幕先定位到前壳开口，再把细排线从后侧接入 DSI 连接器，避免折死', focus: 'screen' },
  { title: '贴扬声器与按键', hint: '喇叭双面胶贴后壳预留位；按键帽朝外，摇杆穿过右侧圆孔', focus: 'controls' },
  { title: '合壳、锁螺钉', hint: '确认线材没有压在柱子上，再用 2 颗 M2.5×6 锁入热熔铜螺母', focus: 'case' },
  { title: '完成检查', hint: 'USB 口、屏幕、三个按键和摇杆应能动作；通电前再次确认排线方向', focus: 'done' },
];

const app = document.querySelector('#app');
app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">●</span><div><div class="eyebrow">HACHIMODOCK / HARDWARE REPLICA</div><h1>哈基米机 · 3D 装配向导</h1></div></div>
      <div class="status"><span class="dot"></span> 交互演示 <span class="sep">·</span> 真实外壳 STEP</div>
    </header>
    <section class="workspace">
      <div class="stage-card">
        <div id="stage" class="stage"></div>
        <div class="stage-toolbar">
          <button id="resetCamera" class="tool-btn">⌂ 复位视角</button>
          <button id="toggleExploded" class="tool-btn">↕ 爆炸视图</button>
          <span class="stage-tip">拖拽旋转 · 滚轮缩放 · 右键平移</span>
        </div>
        <div id="loading" class="loading"><span class="spinner"></span> 正在载入 STEP 外壳…</div>
      </div>
      <aside class="side-card">
        <div class="side-head"><div><div class="eyebrow">ASSEMBLY CHECKLIST</div><h2 id="stepTitle">1 / 7 · 先核对零件</h2></div><span id="stepBadge" class="badge">准备</span></div>
        <p id="stepHint" class="step-hint"></p>
        <div id="stepList" class="step-list"></div>
        <div class="warning"><span>⚠</span><div><strong>装配示意 · 位置待校准</strong><p>排线必须断电插拔，接 DSI 而非 CSI。接触面方向须按实物接口确认，不能仅凭蓝色加强片判断。</p></div></div>
        <div class="legend"><span><i class="swatch green"></i>当前步骤</span><span><i class="swatch cyan"></i>接口/线材</span><span><i class="swatch orange"></i>待安装</span></div>
      </aside>
    </section>
    <footer class="timeline">
      <div class="timeline-head"><div><div class="eyebrow">STEP-BY-STEP PLAYBACK</div><div class="timeline-label"><span id="timelineCount">01</span><strong id="timelineLabel">准备零件</strong></div></div><div class="playback"><button id="prevStep" class="round-btn">‹</button><button id="playStep" class="play-btn">▶ 播放</button><button id="nextStep" class="round-btn">›</button></div></div>
      <input id="progress" class="progress" type="range" min="0" max="6" value="0" step="1" />
      <div class="timecodes"><span>0:00</span><span id="timecode">约 0:00</span><span>7 步</span></div>
    </footer>
  </main>
`;

const stage = document.querySelector('#stage');
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.bg);
scene.fog = new THREE.Fog(COLORS.bg, 330, 560);
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 1200);
camera.position.set(148, 138, 190);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 30, 0);
controls.minDistance = 95;
controls.maxDistance = 390;

scene.add(new THREE.HemisphereLight(0xdde8ff, 0x10131a, 2.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 3.5);
keyLight.position.set(120, 200, 160);
keyLight.castShadow = true;
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x74cfff, 2);
rimLight.position.set(-150, 90, -120);
scene.add(rimLight);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0x0c1017, roughness: 0.88, metalness: 0.05 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -3;
floor.receiveShadow = true;
scene.add(floor);

const assembly = new THREE.Group();
assembly.rotation.x = -0.11;
scene.add(assembly);
const groups = {};
for (const key of ['case', 'pcb', 'headers', 'esp32', 'screen', 'controls', 'fasteners', 'parts']) groups[key] = new THREE.Group();
Object.values(groups).forEach((g) => assembly.add(g));

const standard = (color, options = {}) => new THREE.MeshStandardMaterial({ color, roughness: options.roughness ?? 0.52, metalness: options.metalness ?? 0.03, transparent: options.transparent ?? false, opacity: options.opacity ?? 1, emissive: options.emissive ?? 0x000000, emissiveIntensity: options.emissiveIntensity ?? 0 });
const box = (w, h, d, material, radius = 0) => {
  const geom = radius ? new RoundedBoxGeometry(w, h, d, 4, radius) : new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geom, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
};
const cyl = (r, h, material, segments = 32) => {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, segments), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
};
const label = (text, color = '#ffffff', scale = 0.75) => {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 128);
  ctx.font = '700 34px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.scale.set(48 * scale, 12 * scale, 1);
  return sprite;
};

function makePcb() {
  const g = new THREE.Group();
  const board = box(82, 2.2, 53, standard(COLORS.pcb, { roughness: 0.44 }), 3);
  board.position.y = 22;
  g.add(board);
  const edge = box(84, 1, 55, standard(COLORS.pcbEdge), 3);
  edge.position.y = 20.8;
  g.add(edge);
  for (const x of [-34, 34]) for (const z of [-21, 21]) { const hole = cyl(2.2, 1.6, standard(0x12191c, { metalness: 0.35 }), 24); hole.position.set(x, 23.4, z); g.add(hole); }
  // silkscreen-like chip blocks make the board orientation obvious without pretending to be the PCB CAD.
  const chips = [[-18, -7, 18, 12], [15, 8, 23, 16], [34, -18, 10, 9], [-34, 13, 9, 8]];
  chips.forEach(([x, z, w, d], i) => { const c = box(w, 1.5, d, standard(i === 1 ? 0x1d252c : 0x182127, { roughness: 0.7 })); c.position.set(x, 24.1, z); g.add(c); });
  for (let i = -4; i <= 4; i++) { const trace = box(2.1, 0.35, 18, standard(0xd5b264, { metalness: 0.55, roughness: 0.25 })); trace.position.set(i * 6.3, 24.1, 0); g.add(trace); }
  const l = label('CUSTOM PCB / 底板', '#8bf1bd', 0.65); l.position.set(0, 27, 0); l.rotation.x = -Math.PI / 2; g.add(l);
  return g;
}

function makeHeaders() {
  const g = new THREE.Group();
  for (const z of [-18, 18]) {
    const body = box(82, 7, 5.8, standard(COLORS.header, { roughness: 0.55 }), 1.2);
    body.position.set(0, 27, z);
    g.add(body);
    for (let i = 0; i < 20; i++) { const pin = cyl(0.58, 10, standard(COLORS.metal, { metalness: 0.8, roughness: 0.24 }), 12); pin.position.set((i - 9.5) * 3.8, 32, z); g.add(pin); }
  }
  const l = label('2 × 1×20P 排母', '#ffe0b8', 0.62); l.position.set(0, 44, 0); g.add(l);
  return g;
}

function makeEsp32() {
  const g = new THREE.Group();
  const b = box(77, 3, 43, standard(0x27343e, { roughness: 0.45, metalness: 0.22 }), 2);
  b.position.y = 40; g.add(b);
  const module = box(34, 5, 28, standard(0x8b9aa4, { roughness: 0.42, metalness: 0.28 }), 2); module.position.set(-5, 44, 0); g.add(module);
  const usb = box(11, 6, 9, standard(0xcbd2da, { roughness: 0.25, metalness: 0.7 }), 1); usb.position.set(-43, 43, 0); g.add(usb);
  const antenna = box(19, 0.8, 31, standard(0x131b23, { roughness: 0.7 }), 1); antenna.position.set(33, 42, 0); g.add(antenna);
  const l = label('ESP32-P4-WIFI6', '#9edaff', 0.62); l.position.set(0, 57, 0); g.add(l);
  return g;
}

function makeScreen() {
  const g = new THREE.Group();
  const glass = box(76, 3, 53, standard(0x06080c, { roughness: 0.18, metalness: 0.18, emissive: 0x07121d, emissiveIntensity: 0.22 }), 5);
  glass.position.set(0, 50, 22); g.add(glass);
  const display = box(67, 0.9, 43, standard(0x183344, { roughness: 0.2, emissive: 0x164866, emissiveIntensity: 0.45 }), 3); display.position.set(0, 52, 22); g.add(display);
  const ribbon = box(34, 0.5, 4, standard(COLORS.cyan, { roughness: 0.38, metalness: 0.1 }), 0.7); ribbon.position.set(0, 37, 47); ribbon.rotation.x = -0.18; g.add(ribbon);
  const connector = box(12, 2, 7, standard(0x171c20, { roughness: 0.45 }), 1); connector.position.set(22, 29, 45); g.add(connector);
  const l = label('2.8″ MIPI-DSI / 排线', '#8feaff', 0.6); l.position.set(0, 67, 22); g.add(l);
  return g;
}

function makeControls() {
  const g = new THREE.Group();
  for (const x of [-32, 0, 32]) {
    const key = box(23, 10, 23, standard(0xf4d8db, { roughness: 0.38 }), 4); key.position.set(x, 8, 22); g.add(key);
    const stem = box(12, 5, 12, standard(0xd7dbe0, { roughness: 0.5 }), 1.5); stem.position.set(x, 15, 22); g.add(stem);
  }
  const stick = cyl(4, 13, standard(COLORS.plastic, { roughness: 0.45 }), 24); stick.position.set(44, 10, 22); g.add(stick);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(9, 32, 20), standard(0xff8c25, { roughness: 0.35 })); ball.position.set(44, 20, 22); ball.castShadow = true; g.add(ball);
  const speaker = cyl(13, 5, standard(0x252a31, { roughness: 0.78 }), 40); speaker.rotation.x = Math.PI / 2; speaker.position.set(30, 56, -24); g.add(speaker);
  const cone = cyl(8, 6, standard(0x11151a, { roughness: 0.75 }), 32); cone.rotation.x = Math.PI / 2; cone.position.set(30, 56, -26); g.add(cone);
  const wire = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(30, 56, -24), new THREE.Vector3(15, 55, -4), new THREE.Vector3(5, 42, 22)]), new THREE.LineBasicMaterial({ color: 0xd64a51, linewidth: 3 })); g.add(wire);
  const l = label('按键 ×3 · 摇杆 · 喇叭', '#ffd1a0', 0.58); l.position.set(30, 71, 8); g.add(l);
  return g;
}

function makeFasteners() {
  const g = new THREE.Group();
  for (const x of [-42, 42]) { const screw = cyl(2.1, 10, standard(COLORS.metal, { metalness: 0.86, roughness: 0.22 }), 20); screw.position.set(x, 69, -27); g.add(screw); const head = cyl(3.7, 1.5, standard(COLORS.metal, { metalness: 0.86, roughness: 0.18 }), 24); head.position.set(x, 75, -27); g.add(head); }
  const l = label('M2.5×6 螺钉 ×2', '#d9e2f0', 0.55); l.position.set(0, 84, -28); g.add(l);
  return g;
}

function makeCaseFallback() {
  const g = new THREE.Group();
  const back = box(122, 14, 97, standard(0x2b3039, { roughness: 0.62 }), 10); back.position.set(0, 11, 0); g.add(back);
  const front = box(127, 13, 102, standard(COLORS.plastic, { roughness: 0.33 }), 10); front.position.set(0, 81, 0); g.add(front);
  const screenCut = box(82, 16, 60, standard(COLORS.bg, { roughness: 0.35 }), 6); screenCut.position.set(0, 86, -2); g.add(screenCut);
  const lowerPanel = box(118, 14, 42, standard(COLORS.plastic, { roughness: 0.34 }), 8); lowerPanel.position.set(0, 38, 28); g.add(lowerPanel);
  return g;
}

groups.pcb.add(makePcb());
groups.headers.add(makeHeaders());
groups.esp32.add(makeEsp32());
groups.screen.add(makeScreen());
groups.controls.add(makeControls());
groups.fasteners.add(makeFasteners());
groups.case.add(makeCaseFallback());

let lesson = null;


function resize() { const w = stage.clientWidth; const h = stage.clientHeight; camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h, false); }
window.addEventListener('resize', resize); resize();

async function loadStepModel() {
  try {
    const occt = await occtimportjs({ locateFile: () => '/occt-import-js.wasm' });
    const options = { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.18, angularDeflection: 0.3 };
    const readStep = async (url) => { const response = await fetch(url); const data = new Uint8Array(await response.arrayBuffer()); const result = occt.ReadStepFile(data, options); if (!result.success) throw new Error(`STEP 解析失败: ${url}`); return result; };
    const createMesh = (item, getMaterial, colorOverride) => { const positions = new Float32Array(item.attributes.position.array); const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3)); if (item.attributes.normal) geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(item.attributes.normal.array), 3)); else geometry.computeVertexNormals(); if (item.index) geometry.setIndex(item.index.array); const mesh = new THREE.Mesh(geometry, getMaterial(colorOverride || item.color)); mesh.castShadow = true; mesh.receiveShadow = true; return mesh; };
    const createCadGroup = (result, classifier = () => 'case', colorizer = () => null) => {
      const materialCache = new Map();
      const getMaterial = (color) => { const key = String(color); if (!materialCache.has(key)) materialCache.set(key, standard(Array.isArray(color) ? new THREE.Color(...color) : (color ?? COLORS.plastic), { roughness: 0.38 })); return materialCache.get(key); };
      const buckets = { case: new THREE.Group(), controls: new THREE.Group(), screen: new THREE.Group() };
      const walk = (node) => { const name = node.name || ''; const bucket = buckets[classifier(name)] || buckets.case; if ((node.meshes || []).length) { const target = new THREE.Group(); target.name = name || 'STEP'; node.meshes.forEach((index) => target.add(createMesh(result.meshes[index], getMaterial, colorizer(name)))); bucket.add(target); } (node.children || []).forEach(walk); };
      walk(result.root);
      Object.values(buckets).forEach((bucket) => { bucket.rotation.x = -Math.PI / 2; bucket.position.y = 25; });
      return buckets;
    };
    const caseResult = await readStep('/assets/full-case.step');
    const caseBuckets = createCadGroup(caseResult, (name) => /按键|摇把/.test(name) ? 'controls' : 'case', (name) => /底壳/.test(name) ? COLORS.black : /按键/.test(name) ? 0xf4d8db : /摇把帽/.test(name) ? 0xff8c25 : /摇把盖板/.test(name) ? 0xe9edf2 : COLORS.plastic);
    groups.case.clear(); groups.case.add(caseBuckets.case);
    // The STEP assembly also carries the exact keycaps and joystick parts.
    groups.controls.add(caseBuckets.controls);
    const screenResult = await readStep('/assets/screen-lens.step');
    const screenBuckets = createCadGroup(screenResult, () => 'case', () => COLORS.black);
    groups.screen.add(screenBuckets.case);
    const tag = label('真实 STEP 外壳 + 屏框', '#ffffff', 0.58); tag.position.set(0, 83, 22); groups.case.add(tag);
    document.querySelector('#loading').remove();
  } catch (error) {
    console.warn('STEP loading fallback:', error);
    document.querySelector('#loading').textContent = 'STEP 外壳载入失败，已显示教学几何';
    document.querySelector('#loading').classList.add('error');
    window.setTimeout(() => document.querySelector('#loading')?.remove(), 2300);
  }
}
loadStepModel().then(() => { lesson = createLesson({ THREE, groups, assembly, camera, controls }); });

function tick() { requestAnimationFrame(tick); lesson?.update(); controls.update(); renderer.render(scene, camera); }
tick();
