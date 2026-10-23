// 3D-сцена: глиняный макет квартала на круглом подиуме, солнце, траектории и луч от окна.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { sunVector } from './sun.js';
import { detectQuality, lowerTier } from './quality.js';

// модель (x — восток, y — север, z — вверх) → three (y — вверх, север = −z)
const V = (x, y, z = 0) => new THREE.Vector3(x, z, -y);

const COLORS = {
  base: new THREE.Color('#f6f2eb'),
  guess: new THREE.Color('#e6e1d8'),
  target: new THREE.Color('#f3b56f'),
  blocker: new THREE.Color('#b4bdd3'),
  hover: new THREE.Color('#fde3c4'),
  focus: new THREE.Color('#c4cde0'),
};

const SKY = [
  // высота солнца°, зенит, горизонт, цвет солнца, сила солнца, сила неба, цвет неба, цвет земли
  [-18, '#0e1324', '#1b2134', '#000000', 0.0, 0.62, '#7180b0', '#26232c'],
  [-7, '#1d2544', '#4a4560', '#000000', 0.0, 0.72, '#7f89b6', '#332d36'],
  [-1.5, '#46507a', '#c99a8c', '#ff8a52', 0.25, 0.85, '#b0afcb', '#776860'],
  [4, '#7d95bf', '#f2b88a', '#ffac6c', 1.7, 1.0, '#c9cde0', '#b9a58e'],
  [12, '#a7bdd8', '#f2dcc3', '#ffd3a2', 2.6, 1.15, '#dfe3ec', '#cdbca4'],
  [28, '#bacde2', '#f3ede3', '#fff0dd', 3.1, 1.25, '#e9ecf1', '#d8c9b2'],
  [70, '#b5cbe2', '#f3ede3', '#fff6ea', 3.3, 1.3, '#eef0f4', '#dccfba'],
];

function lerpSky(altDeg) {
  let i = 0;
  while (i < SKY.length - 2 && altDeg > SKY[i + 1][0]) i++;
  const a = SKY[i], b = SKY[i + 1];
  const t = THREE.MathUtils.clamp((altDeg - a[0]) / (b[0] - a[0]), 0, 1);
  const c = (k) => new THREE.Color(a[k]).lerp(new THREE.Color(b[k]), t);
  const n = (k) => a[k] + (b[k] - a[k]) * t;
  return { zenith: c(1), horizon: c(2), sun: c(3), sunI: n(4), hemiI: n(5), hemiSky: c(6), hemiGround: c(7) };
}

const easeOut = (t) => 1 - Math.pow(1 - t, 4);
const easeInOut = (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2);

export class Stage {
  constructor(canvas, labelsEl, { onHover, onPick } = {}) {
    this.canvas = canvas;
    this.labelsEl = labelsEl;
    this.onHover = onHover;
    this.onPick = onPick;
    this.mobile = matchMedia('(max-width: 767px)').matches;
    this.profile = detectQuality();

    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.profile.name !== 'low', powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(devicePixelRatio, this.profile.dpr));
    r.shadowMap.enabled = true;
    r.shadowMap.type = this.profile.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 5, 20000);
    this.camera.position.set(620, 640, 860);

    const c = (this.controls = new OrbitControls(this.camera, canvas));
    c.enableDamping = true;
    c.dampingFactor = 0.07;
    c.maxPolarAngle = 1.36;
    c.minDistance = 60;
    c.maxDistance = 2200;
    c.rotateSpeed = 0.6;
    c.zoomSpeed = 0.9;
    c.screenSpacePanning = false;
    // Кадр рисуем только когда что-то изменилось: камера, время, подсветка, анимация
    c.addEventListener('change', () => this.invalidate());

    this.world = new THREE.Group();
    this.overlay = new THREE.Group();
    this.scene.add(this.world, this.overlay);

    this.uniforms = { uProgress: { value: 0 }, uLines: { value: 1 } };
    this.lineMats = [];
    this.labels = new Map();
    this.tints = { target: null, hover: null, blocker: null, focus: null };
    this.viewShift = 0;
    this.viewShiftTarget = 0;
    this.viewShiftY = 0;
    this.viewShiftTargetY = 0;
    this.tweens = [];
    this.running = true;
    this.dirty = true;
    this.lastFrame = 0;
    this.pulseUntil = 0;
    this.perfSamples = [];
    this.renders = 0;
    this.debug = new URLSearchParams(location.search).has('debug') ? this.#debugPanel() : null;

    this.#initSky();
    this.#initLights();
    this.#initSunObjects();
    this.#initPointer();
    this.resize();
    addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => !document.hidden && this.invalidate());
    // Ошибка в одном кадре не должна навсегда останавливать отрисовку (three.js не перезапускает цикл сам)
    this.renderer.setAnimationLoop(() => {
      try {
        this.#tick();
      } catch (e) {
        if (!this.tickError) console.error('[3D] ошибка кадра', e);
        this.tickError = e;
      }
    });
  }

  invalidate() {
    this.dirty = true;
  }

  // Понизить качество на ходу: меньше пикселей и теней, без контуров и деревьев
  applyProfile(p) {
    this.profile = p;
    const r = this.renderer;
    r.setPixelRatio(Math.min(devicePixelRatio, p.dpr));
    r.shadowMap.type = p.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    const sh = this.sunLight.shadow;
    sh.mapSize.set(p.shadow, p.shadow);
    sh.map?.dispose();
    sh.map = null;
    this.scene.traverse((o) => {
      if (!o.material) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => (m.needsUpdate = true));
    });
    if (this.edges) this.edges.visible = p.edges;
    if (this.trees) this.trees.visible = p.trees;
    this.resize();
    console.info(`[3D] качество: ${p.name}`);
  }

  #debugPanel() {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;padding:6px 9px;border-radius:8px;background:rgba(29,23,18,.85);color:#fbf8f3;font:11px/1.4 ui-monospace,monospace;pointer-events:none;white-space:pre';
    document.body.appendChild(el);
    return { el, t0: performance.now(), renders: 0, ticks: 0 };
  }

  // ---------- Небо и свет ----------

  #initSky() {
    this.skyU = {
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color() },
      uSunVis: { value: 1 },
      uNight: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.skyU,
      side: THREE.BackSide,
      depthWrite: false,
      toneMapped: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith, uHorizon, uSunDir, uSunCol;
        uniform float uSunVis, uNight;
        varying vec3 vDir;
        float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.6));
          float sd = max(dot(d, uSunDir), 0.0);
          col += uSunCol * (pow(sd, 5.0) * 0.16 + pow(sd, 48.0) * 0.28) * uSunVis * smoothstep(-0.2, 0.05, h);
          if (uNight > 0.0 && h > 0.0) {
            vec3 q = floor(d * 380.0);
            float s = step(0.9972, hash(q));
            col += s * uNight * 0.85 * smoothstep(0.02, 0.35, h);
          }
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 48, 24), mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog(0xf3ede3, 2600, 8000);
  }

  #initLights() {
    const sun = (this.sunLight = new THREE.DirectionalLight(0xffffff, 3));
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.profile.shadow, this.profile.shadow);
    sun.shadow.bias = -0.00025;
    sun.shadow.normalBias = 0.35;
    const s = sun.shadow.camera;
    s.near = 10;
    s.far = 4000;
    this.scene.add(sun, sun.target);
    this.hemi = new THREE.HemisphereLight(0xeef0f4, 0xd8c9b2, 1.2);
    this.scene.add(this.hemi);
  }

  #initSunObjects() {
    const glowTex = radialTexture([
      [0, 'rgba(255,214,150,0.95)'],
      [0.18, 'rgba(255,190,110,0.55)'],
      [0.45, 'rgba(255,170,90,0.14)'],
      [1, 'rgba(255,160,80,0)'],
    ]);
    this.sunOrb = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(7, 32, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff1d6, toneMapped: false, fog: false }),
    );
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false }),
    );
    glow.scale.set(150, 150, 1);
    this.sunOrb.add(glow, core);
    this.overlay.add(this.sunOrb);

    this.arcGroup = new THREE.Group();
    this.overlay.add(this.arcGroup);

    // Маркер окна
    const w = (this.winMarker = new THREE.Group());
    w.visible = false;
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 2.2),
      new THREE.MeshBasicMaterial({ color: 0xffb35c, toneMapped: false, side: THREE.DoubleSide }),
    );
    const ringTex = radialTexture([
      [0, 'rgba(255,180,90,0)'],
      [0.55, 'rgba(255,180,90,0)'],
      [0.62, 'rgba(255,180,90,0.95)'],
      [0.7, 'rgba(255,180,90,0)'],
      [1, 'rgba(255,180,90,0)'],
    ]);
    this.winPulse = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: ringTex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false }),
    );
    this.winPulse.scale.set(18, 18, 1);
    const dotTex = radialTexture([
      [0, 'rgba(255,190,110,1)'],
      [0.3, 'rgba(255,170,90,0.6)'],
      [1, 'rgba(255,160,80,0)'],
    ]);
    this.winGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: dotTex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, blending: THREE.AdditiveBlending }),
    );
    this.winGlow.scale.set(14, 14, 1);
    this.winPlate = plate;
    w.add(plate, this.winPulse, this.winGlow);
    this.overlay.add(w);

    this.guide = this.#line({ color: 0xc98a4a, width: 1.4, dashed: true, opacity: 0.85, depthTest: false });
    this.overlay.add(this.guide);
    this.rayGlow = this.#line({ color: 0xffb35c, width: 9, opacity: 0.18, depthTest: true });
    this.ray = this.#line({ color: 0xffa94d, width: 2.6, opacity: 1, depthTest: true });
    this.overlay.add(this.rayGlow, this.ray);
    const hitTex = radialTexture([
      [0, 'rgba(110,125,160,0)'],
      [0.5, 'rgba(110,125,160,0)'],
      [0.6, 'rgba(90,105,145,1)'],
      [0.72, 'rgba(90,105,145,0)'],
      [1, 'rgba(90,105,145,0)'],
    ]);
    this.hitMark = new THREE.Sprite(new THREE.SpriteMaterial({ map: hitTex, transparent: true, depthWrite: false, depthTest: false }));
    this.hitMark.scale.set(16, 16, 1);
    this.hitMark.visible = false;
    this.overlay.add(this.hitMark);
  }

  #line({ color, width, dashed = false, opacity = 1, depthTest = true, vertexColors = false }) {
    const mat = new LineMaterial({
      color,
      linewidth: width,
      dashed,
      dashSize: 3,
      gapSize: 3,
      transparent: true,
      opacity,
      depthTest,
      depthWrite: false,
      vertexColors,
      worldUnits: false,
      toneMapped: false,
    });
    this.lineMats.push(mat);
    const line = new Line2(new LineGeometry(), mat);
    line.visible = false;
    line.frustumCulled = false;
    return line;
  }

  #setLine(line, points, colors) {
    this.invalidate();
    const start = line.geometry.attributes.instanceStart;
    if (!colors && points.length === 2 && start && start.data.array.length === 6) {
      const [a, b] = points;
      start.data.array.set([a.x, a.y, a.z, b.x, b.y, b.z]);
      start.data.needsUpdate = true;
      if (line.material.dashed) {
        const ds = line.geometry.attributes.instanceDistanceStart;
        if (ds && ds.data.array.length === 2) {
          ds.data.array[0] = 0;
          ds.data.array[1] = a.distanceTo(b);
          ds.data.needsUpdate = true;
        } else line.computeLineDistances();
      }
      line.visible = true;
      return;
    }
    const pos = [];
    for (const p of points) pos.push(p.x, p.y, p.z);
    line.geometry.dispose();
    line.geometry = new LineGeometry();
    line.geometry.setPositions(pos);
    if (colors) line.geometry.setColors(colors);
    if (line.material.dashed) line.computeLineDistances();
    line.visible = points.length > 1;
  }

  // ---------- Модель квартала ----------

  async setModel(model, { animate = true } = {}) {
    if (this.model) await this.#sink();
    this.#disposeWorld();
    this.model = model;
    const R2 = model.R2;
    this.R2 = R2;

    // Подиум
    const groundTex = await groundTexture(model, this.profile.ground);
    groundTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const top = new THREE.Mesh(
      new THREE.CircleGeometry(R2, 180).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1, metalness: 0 }),
    );
    top.receiveShadow = true;
    const side = new THREE.Mesh(
      new THREE.CylinderGeometry(R2, R2 * 0.995, 16, 180, 1, true).translate(0, -8, 0),
      new THREE.MeshStandardMaterial({ color: 0xe4dbcc, roughness: 1 }),
    );
    const bottom = new THREE.Mesh(
      new THREE.CircleGeometry(R2 * 0.995, 120).rotateX(Math.PI / 2).translate(0, -16, 0),
      new THREE.MeshStandardMaterial({ color: 0xcfc4b3, roughness: 1 }),
    );
    const shadowTex = radialTexture([
      [0, 'rgba(60,40,20,0.30)'],
      [0.55, 'rgba(60,40,20,0.14)'],
      [1, 'rgba(60,40,20,0)'],
    ]);
    const floorShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(R2 * 3.1, R2 * 3.1).rotateX(-Math.PI / 2).translate(0, -90, 0),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, fog: false }),
    );
    this.world.add(top, side, bottom, floorShadow);

    this.#buildBuildings(model);
    if (this.profile.trees) this.#buildTrees(model);
    this.invalidate();

    const s = this.sunLight.shadow.camera;
    const ext = R2 * 1.08;
    s.left = -ext; s.right = ext; s.top = ext; s.bottom = -ext;
    s.updateProjectionMatrix();

    this.uniforms.uProgress.value = animate ? 0 : 1.6;
    if (this.edges) this.edges.material.opacity = animate ? 0 : 0.11;
    if (animate) {
      // рост домов идёт в фоне — вызывающий код может сразу ставить окно и считать
      this.rising = this.#tween(2600, (t) => {
        this.uniforms.uProgress.value = t * 1.6;
        if (this.trees) this.trees.scale.y = Math.max(0.001, THREE.MathUtils.clamp((t - 0.45) / 0.55, 0, 1));
        if (this.edges) this.edges.material.opacity = THREE.MathUtils.clamp((t - 0.75) / 0.25, 0, 1) * 0.11;
      }, easeOut);
    } else if (this.trees) this.trees.scale.y = 1;
  }

  // Перестроить дома без анимации (после правки этажности)
  rebuildBuildings() {
    for (const o of [this.buildings, this.edges]) {
      if (!o) continue;
      o.geometry.dispose();
      o.material.dispose();
      this.world.remove(o);
    }
    this.#buildBuildings(this.model);
    if (this.edges) this.edges.material.opacity = 0.11;
    this.invalidate();
  }

  #sink() {
    const from = this.uniforms.uProgress.value;
    return this.#tween(700, (t) => {
      this.uniforms.uProgress.value = from * (1 - t);
      if (this.trees) this.trees.scale.y = Math.max(0.001, 1 - t);
      if (this.edges) this.edges.material.opacity = 0.11 * (1 - t);
    }, (t) => t * t);
  }

  #disposeWorld() {
    this.world.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach((m) => { m.map?.dispose(); m.dispose(); });
      }
    });
    this.world.clear();
    this.buildings = null;
    this.edges = null;
    this.trees = null;
  }

  #buildBuildings(model) {
    const pos = [], nor = [], del = [];
    const ranges = [];
    const R = model.R;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    model.buildings.forEach((b, i) => {
      const start = pos.length / 3;
      try {
        const shapes = b.polys.map((p) => {
          const s = new THREE.Shape(toV2(p.outer));
          s.holes = p.holes.map((h) => new THREE.Path(toV2(h)));
          return s;
        });
        const g = new THREE.ExtrudeGeometry(shapes, { depth: Math.max(0.5, b.h - b.minH), bevelEnabled: false, curveSegments: 1 });
        g.rotateX(-Math.PI / 2);
        g.translate(0, b.minH, 0);
        const gp = g.attributes.position.array, gn = g.attributes.normal.array;
        const d = THREE.MathUtils.clamp(Math.hypot(b.cx, b.cy) / R, 0, 1) * 0.75 + rnd() * 0.15;
        for (let k = 0; k < gp.length; k++) { pos.push(gp[k]); nor.push(gn[k]); }
        for (let k = 0; k < gp.length / 3; k++) del.push(d);
        g.dispose();
      } catch (e) {
        /* кривой контур — пропускаем */
      }
      ranges.push([start, pos.length / 3 - start]);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('aDelay', new THREE.Float32BufferAttribute(del, 1));
    const col = new Float32Array(pos.length);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();

    const triOwner = new Int32Array(pos.length / 9);
    ranges.forEach(([s, n], i) => triOwner.fill(i, s / 3, (s + n) / 3));
    this.ranges = ranges;
    this.triOwner = triOwner;
    this.groups = new Map();
    model.buildings.forEach((b, i) => {
      if (!this.groups.has(b.group)) this.groups.set(b.group, []);
      this.groups.get(b.group).push(i);
    });

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    const U = this.uniforms;
    const rise = /* glsl */ `
      float kRise = clamp((uProgress - aDelay) / 0.6, 0.0, 1.0);
      kRise = 1.0 - pow(1.0 - kRise, 3.0);
      transformed.y *= max(kRise, 0.0001);`;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uProgress = U.uProgress;
      sh.uniforms.uLines = U.uLines;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aDelay;\nuniform float uProgress;\nvarying float vH;\nvarying float vWall;\nvarying float vDist;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${rise}\nvH = transformed.y;\nvWall = 1.0 - step(0.5, abs(objectNormal.y));`)
        .replace('#include <project_vertex>', '#include <project_vertex>\nvDist = -mvPosition.z;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uLines;\nvarying float vH;\nvarying float vWall;\nvarying float vDist;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float ao = mix(0.70, 1.0, smoothstep(0.0, 9.0, vH));
          float fl = vH / 3.0;
          float fw = max(fwidth(fl), 1e-4);
          float f = fract(fl);
          float line = 1.0 - smoothstep(0.0, fw * 1.4, min(f, 1.0 - f));
          line *= vWall * step(1.5, vH) * (1.0 - smoothstep(500.0, 1500.0, vDist)) * uLines;
          diffuseColor.rgb *= ao * (1.0 - 0.075 * line);`);
    };
    const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depthMat.onBeforeCompile = (sh) => {
      sh.uniforms.uProgress = U.uProgress;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aDelay;\nuniform float uProgress;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${rise}`);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.customDepthMaterial = depthMat;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.buildings = mesh;
    this.world.add(mesh);
    this.#refreshAllColors();

    this.edges = null;
    if (!this.profile.edges) return;
    const eg = new THREE.EdgesGeometry(geo, 28);
    this.edges = new THREE.LineSegments(
      eg,
      new THREE.LineBasicMaterial({ color: 0x3a2a1a, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.world.add(this.edges);
  }

  #buildTrees(model) {
    const t = model.trees;
    const n = t.length / 3;
    if (!n) return;
    const crownGeo = new THREE.IcosahedronGeometry(1, 1);
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 1, 6).translate(0, 0.5, 0);
    const crown = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0xbcc6a3, roughness: 1, flatShading: true }), n);
    const trunk = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0xb8a68c, roughness: 1 }), n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const x = t[i * 3], y = t[i * 3 + 1], k = t[i * 3 + 2];
      const r = 2.6 * k;
      q.setFromEuler(new THREE.Euler(0, (i * 2.399) % 6.28, 0));
      m.compose(p.set(x, 3.2 * k + r * 0.7, -y), q, s.set(r, r * 1.15, r));
      crown.setMatrixAt(i, m);
      m.compose(p.set(x, 0, -y), q, s.set(k, 3.4 * k, k));
      trunk.setMatrixAt(i, m);
    }
    crown.castShadow = trunk.castShadow = true;
    crown.receiveShadow = true;
    const g = new THREE.Group();
    g.add(crown, trunk);
    g.scale.y = 0.001;
    this.trees = g;
    this.world.add(g);
  }

  // ---------- Подсветка ----------

  setTint(kind, group) {
    if (this.tints[kind] === group) return;
    const prev = this.tints[kind];
    this.tints[kind] = group;
    this.#refreshGroup(prev);
    this.#refreshGroup(group);
  }

  #colorFor(i) {
    const b = this.model.buildings[i];
    const g = b.group;
    if (this.tints.hover === g) return COLORS.hover;
    if (this.tints.blocker === g) return COLORS.blocker;
    if (this.tints.focus === g) return COLORS.focus;
    if (this.tints.target === g) return COLORS.target;
    return b.src === 'guess' ? COLORS.guess : COLORS.base;
  }

  #refreshGroup(group) {
    if (group == null || !this.buildings) return;
    const list = this.groups.get(group);
    if (!list) return;
    const attr = this.buildings.geometry.attributes.color;
    for (const i of list) this.#paint(attr, i);
    attr.needsUpdate = true;
    this.invalidate();
  }

  #refreshAllColors() {
    const attr = this.buildings.geometry.attributes.color;
    this.model.buildings.forEach((_, i) => this.#paint(attr, i));
    attr.needsUpdate = true;
  }

  #paint(attr, i) {
    const [s, n] = this.ranges[i];
    const c = this.#colorFor(i);
    const a = attr.array;
    for (let k = s; k < s + n; k++) { a[k * 3] = c.r; a[k * 3 + 1] = c.g; a[k * 3 + 2] = c.b; }
  }

  // ---------- Солнце ----------

  setSun(alt, az) {
    const v = sunVector(alt, az);
    const dir = V(v[0], v[1], v[2]).normalize();
    const altDeg = THREE.MathUtils.radToDeg(alt);
    const k = lerpSky(altDeg);
    this.skyU.uZenith.value.copy(k.zenith);
    this.skyU.uHorizon.value.copy(k.horizon);
    this.skyU.uSunDir.value.copy(dir);
    this.skyU.uSunCol.value.copy(k.sun);
    this.skyU.uSunVis.value = THREE.MathUtils.clamp((altDeg + 4) / 6, 0, 1);
    this.skyU.uNight.value = THREE.MathUtils.clamp((-altDeg - 5) / 8, 0, 1);
    this.scene.fog.color.copy(k.horizon);
    this.hemi.color.copy(k.hemiSky);
    this.hemi.groundColor.copy(k.hemiGround);
    this.hemi.intensity = k.hemiI;
    this.sunLight.color.copy(k.sun.clone().lerp(new THREE.Color(1, 1, 1), 0.15));
    this.sunLight.intensity = k.sunI * THREE.MathUtils.clamp(altDeg / 1.5, 0, 1);
    const c = this.domeCenter || new THREE.Vector3();
    this.sunLight.position.copy(dir).multiplyScalar(1600);
    this.sunLight.target.position.set(0, 0, 0);
    this.sunDir = dir;
    this.sunOrb.visible = altDeg > -1.5;
    this.sunOrb.position.copy(c).addScaledVector(dir, this.domeR());
    this.altDeg = altDeg;
    this.invalidate();
    return k;
  }

  domeR() {
    return (this.model?.R || 420) * 0.78;
  }

  // arcs: [{kind, pts:[[alt,az]], hours:[{alt,az,label}]}]
  setSunPaths(arcs) {
    for (const ch of [...this.arcGroup.children]) {
      ch.geometry?.dispose();
      if (ch.material) {
        const k = this.lineMats.indexOf(ch.material);
        if (k >= 0) this.lineMats.splice(k, 1);
        ch.material.dispose();
      }
      this.arcGroup.remove(ch);
    }
    this.invalidate();
    for (const [id] of this.labels) if (id.startsWith('arc')) this.removeLabel(id);
    const c = this.domeCenter || new THREE.Vector3();
    const R = this.domeR();
    arcs.forEach((arc, ai) => {
      const pts = arc.pts.map(([alt, az]) => {
        const v = sunVector(alt, az);
        return c.clone().addScaledVector(V(v[0], v[1], v[2]).normalize(), R);
      });
      if (pts.length < 2) return;
      const today = arc.kind === 'today';
      const line = this.#line({
        color: today ? 0xffffff : 0x6b5a48,
        width: today ? 2.4 : 1.1,
        dashed: !today,
        opacity: today ? 0.95 : 0.4,
        depthTest: true,
        vertexColors: today,
      });
      let colors;
      if (today) {
        colors = [];
        const lo = new THREE.Color('#ff8a3d'), hi = new THREE.Color('#ffd27a');
        for (const [alt] of arc.pts) {
          const cc = lo.clone().lerp(hi, THREE.MathUtils.clamp(alt / 0.9, 0, 1));
          colors.push(cc.r, cc.g, cc.b);
        }
      }
      this.#setLine(line, pts, colors);
      if (!today) {
        line.material.dashSize = 6;
        line.material.gapSize = 5;
      }
      this.arcGroup.add(line);
      if (arc.hours) {
        const dots = [];
        arc.hours.forEach((h, hi) => {
          const v = sunVector(h.alt, h.az);
          const p = c.clone().addScaledVector(V(v[0], v[1], v[2]).normalize(), R);
          dots.push(p);
          this.addLabel(`arc${ai}-${hi}`, h.label, 'lbl-hour', p);
        });
        const g = new THREE.BufferGeometry().setFromPoints(dots);
        const pm = new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, color: 0xffc070, map: dotTexture(), transparent: true, depthWrite: false, toneMapped: false });
        this.arcGroup.add(new THREE.Points(g, pm));
      }
      if (arc.label) {
        const mid = pts[Math.floor(pts.length / 2)];
        this.addLabel(`arc${ai}-name`, arc.label, 'lbl-arc', mid);
      }
    });
  }

  // ---------- Окно и луч ----------

  setWindow(win) {
    this.win = win;
    if (!win) {
      this.winMarker.visible = false;
      this.guide.visible = false;
      this.ray.visible = this.rayGlow.visible = false;
      this.hitMark.visible = false;
      this.domeCenter = null;
      this.removeLabel('win');
      this.invalidate();
      return;
    }
    const p = V(win.x + win.nx * 0.3, win.y + win.ny * 0.3, win.z);
    this.winMarker.visible = true;
    this.winMarker.position.copy(p);
    this.winPlate.lookAt(p.clone().add(V(win.nx, win.ny, 0)));
    this.winPlate.position.set(0, 0, 0);
    this.#setLine(this.guide, [V(win.x + win.nx * 0.3, win.y + win.ny * 0.3, 0), p]);
    this.domeCenter = p.clone();
    this.addLabel('win', win.label || 'Окно', 'lbl-win', p);
    this.pulseUntil = performance.now() + 2600;
    this.invalidate();
  }

  // state: 'lit' | 'blocked' | 'behind' | 'night'
  setRay(state, hitT = 0) {
    if (!this.win || !this.sunDir || state === 'night') {
      if (this.ray.visible || this.hitMark.visible) this.invalidate();
      this.ray.visible = this.rayGlow.visible = false;
      this.hitMark.visible = false;
      return;
    }
    const from = this.domeCenter;
    const len = state === 'blocked' ? Math.max(2, hitT) : this.domeR();
    const to = from.clone().addScaledVector(this.sunDir, len);
    this.#setLine(this.ray, [from, to]);
    this.#setLine(this.rayGlow, [from, to]);
    const m = this.ray.material;
    if (state === 'lit') {
      m.color.set(0xffa13d); m.linewidth = 2.6; m.dashed = false; m.opacity = 1;
      this.rayGlow.visible = true;
    } else if (state === 'blocked') {
      m.color.set(0x5d6d93); m.linewidth = 2; m.dashed = true; m.opacity = 0.95;
      this.rayGlow.visible = false;
    } else {
      m.color.set(0x9c8f80); m.linewidth = 1.4; m.dashed = true; m.opacity = 0.55;
      this.rayGlow.visible = false;
    }
    if (m.dashed) {
      m.dashSize = 4;
      m.gapSize = 3;
      const ds = this.ray.geometry.attributes.instanceDistanceStart;
      if (ds && ds.data.array.length === 2) {
        ds.data.array[0] = 0;
        ds.data.array[1] = from.distanceTo(to);
        ds.data.needsUpdate = true;
      } else this.ray.computeLineDistances();
    }
    if (m.dashed !== this.rayDashed) {
      m.needsUpdate = true;
      this.rayDashed = m.dashed;
    }
    this.hitMark.visible = state === 'blocked';
    if (state === 'blocked') this.hitMark.position.copy(to);
  }

  // ---------- Метки ----------

  addLabel(id, html, cls, pos) {
    let l = this.labels.get(id);
    if (!l) {
      const el = document.createElement('div');
      el.className = `lbl ${cls}`;
      this.labelsEl.appendChild(el);
      l = { el, pos: new THREE.Vector3() };
      this.labels.set(id, l);
    }
    l.el.innerHTML = html;
    if (pos) l.pos.copy(pos);
    this.invalidate();
    return l;
  }
  removeLabel(id) {
    const l = this.labels.get(id);
    if (!l) return;
    l.el.remove();
    this.labels.delete(id);
  }

  #updateLabels() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const v = new THREE.Vector3();
    for (const l of this.labels.values()) {
      v.copy(l.pos).project(this.camera);
      const vis = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      l.el.style.opacity = vis ? '' : '0';
      if (vis) l.el.style.transform = `translate3d(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px, 0)`;
    }
  }

  // ---------- Камера ----------

  setMode(mode) {
    const c = this.controls;
    this.mode = mode;
    // На сенсорных экранах в лендинге макет не перехватывает касания — иначе страницу не пролистать
    const touch = matchMedia('(pointer: coarse)').matches;
    if (mode === 'landing') {
      c.enabled = !touch;
      c.enableZoom = false;
      c.enablePan = false;
      c.autoRotate = true;
      c.autoRotateSpeed = 0.28;
      this.canvas.style.touchAction = touch ? 'pan-y' : 'none';
    } else {
      c.enabled = true;
      c.enableZoom = true;
      c.enablePan = true;
      c.autoRotate = false;
      this.canvas.style.touchAction = 'none';
    }
    this.invalidate();
  }

  // Сдвиг картинки в пикселях: вправо (px) и вниз (py) — чтобы макет не прятался под текстом и панелями
  setViewShift(px, py = 0) {
    this.viewShiftTarget = px;
    this.viewShiftTargetY = py;
  }

  setView({ target, dist, polar, azim }) {
    this.controls.target.copy(target);
    this.camera.position.setFromSpherical(new THREE.Spherical(dist, polar, azim)).add(target);
    this.controls.update();
    this.invalidate();
  }

  flyTo({ target, dist, polar, azim }, dur = 1800) {
    const c = this.controls;
    const fromT = c.target.clone();
    const off = this.camera.position.clone().sub(fromT);
    const s0 = new THREE.Spherical().setFromVector3(off);
    const toT = target ? target.clone() : fromT.clone();
    const s1 = new THREE.Spherical(dist ?? s0.radius, polar ?? s0.phi, azim ?? s0.theta);
    let dth = s1.theta - s0.theta;
    dth = Math.atan2(Math.sin(dth), Math.cos(dth));
    this.flying = true;
    return this.#tween(dur, (t) => {
      c.target.lerpVectors(fromT, toT, t);
      const s = new THREE.Spherical(
        s0.radius + (s1.radius - s0.radius) * t,
        s0.phi + (s1.phi - s0.phi) * t,
        s0.theta + dth * t,
      );
      this.camera.position.setFromSpherical(s).add(c.target);
    }, easeInOut).then(() => (this.flying = false));
  }

  modelToWorld(x, y, z = 0) {
    return V(x, y, z);
  }

  // ---------- Указатель ----------

  #initPointer() {
    this.ray3 = new THREE.Raycaster();
    let down = null;
    let pending = null;
    const el = this.canvas;
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 6 || this.mode !== 'app') return;
      const hit = this.pick(e.clientX, e.clientY);
      this.onPick?.(hit, e);
    });
    el.addEventListener('pointermove', (e) => {
      if (this.mode !== 'app' || e.pointerType === 'touch') return;
      pending = e;
      if (this.hoverRaf) return;
      this.hoverRaf = requestAnimationFrame(() => {
        this.hoverRaf = 0;
        if (!pending || down) return;
        const hit = this.pick(pending.clientX, pending.clientY);
        this.onHover?.(hit, pending);
      });
    });
    el.addEventListener('pointerleave', () => this.onHover?.(null));
  }

  // Точка модели → координаты на экране (clientX, clientY)
  toScreen(x, y, z = 0) {
    const v = V(x, y, z).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }

  // Снимок текущего вида для отчёта: кадр с пропорцией aspect вокруг точки модели (окна).
  // Рисуем и копируем в одной задаче — так буфер WebGL ещё не очищен
  snapshot(aspect, at) {
    // на узком экране телефона кадр был бы мелким — рисуем один кадр в большем разрешении
    const pr = this.renderer.getPixelRatio();
    const need = Math.min(3, 1080 / (this.canvas.clientWidth || 1080));
    if (need > pr) {
      this.renderer.setPixelRatio(need);
      this.resize();
    }
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
    const src = this.canvas;
    let h = src.height * 0.82, w = h * aspect;
    if (w > src.width) {
      w = src.width;
      h = w / aspect;
    }
    let cx = src.width / 2, cy = src.height / 2;
    if (at) {
      const r = src.getBoundingClientRect(), k = src.width / r.width;
      const [sx, sy] = this.toScreen(at.x, at.y, at.z);
      cx = (sx - r.left) * k;
      cy = (sy - r.top) * k;
    }
    const x = Math.min(Math.max(0, cx - w / 2), src.width - w);
    const y = Math.min(Math.max(0, cy - h / 2), src.height - h);
    const out = document.createElement('canvas');
    out.width = Math.round(w);
    out.height = Math.round(h);
    out.getContext('2d').drawImage(src, x, y, w, h, 0, 0, out.width, out.height);
    if (need > pr) {
      this.renderer.setPixelRatio(pr);
      this.resize();
    }
    return out;
  }

  // Точка на земле под курсором (для рисования нового дома)
  pickGround(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.ray3.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    if (!this.ray3.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) return null;
    return { x: p.x, y: -p.z };
  }

  // Черновик контура нового дома: точки и замкнутая линия
  setDraft(pts) {
    if (!this.draft) {
      this.draft = this.#line({ color: 0xc8622a, width: 2.2, opacity: 0.95, depthTest: false });
      this.draftDots = new THREE.Points(
        new THREE.BufferGeometry(),
        new THREE.PointsMaterial({ size: 10, sizeAttenuation: false, color: 0xc8622a, map: dotTexture(), transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
      );
      this.draftDots.frustumCulled = false;
      this.overlay.add(this.draft, this.draftDots);
    }
    const on = !!pts?.length;
    this.draft.visible = on && pts.length > 1;
    this.draftDots.visible = on;
    if (on) {
      const v = pts.map((p) => V(p.x, p.y, 0.6));
      this.draftDots.geometry.dispose();
      this.draftDots.geometry = new THREE.BufferGeometry().setFromPoints(v);
      if (v.length > 1) this.#setLine(this.draft, v.length > 2 ? [...v, v[0]] : v);
    }
    this.invalidate();
  }

  pick(cx, cy) {
    if (!this.buildings || this.uniforms.uProgress.value < 1.5) return null;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.ray3.setFromCamera(ndc, this.camera);
    const hits = this.ray3.intersectObject(this.buildings, false);
    if (!hits.length) return null;
    const h = hits[0];
    const i = this.triOwner[h.faceIndex];
    const n = h.face.normal;
    return {
      i,
      x: h.point.x,
      y: -h.point.z,
      z: h.point.y,
      nx: n.x,
      ny: -n.z,
      wall: Math.abs(n.y) < 0.4,
    };
  }

  // ---------- Цикл ----------

  #tween(dur, fn, ease = (t) => t) {
    return new Promise((resolve) => {
      this.tweens.push({ t0: performance.now(), dur, fn, ease, resolve });
    });
  }

  resize() {
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.#applyViewShift(true);
    const pr = this.renderer.getPixelRatio();
    for (const m of this.lineMats) m.resolution.set(w * pr, h * pr);
    this.invalidate();
  }

  #applyViewShift(force) {
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    const dx = this.viewShiftTarget - this.viewShift;
    const dy = (this.viewShiftTargetY || 0) - (this.viewShiftY || 0);
    if (!force && Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3) return false;
    const k = force ? 1 : 0.08;
    this.viewShift += dx * k;
    this.viewShiftY = (this.viewShiftY || 0) + dy * k;
    if (!this.viewShiftTarget && !this.viewShiftTargetY && Math.abs(this.viewShift) < 0.5 && Math.abs(this.viewShiftY) < 0.5) {
      this.viewShift = this.viewShiftY = 0;
      this.camera.clearViewOffset();
    } else {
      this.camera.setViewOffset(w, h, -this.viewShift, -this.viewShiftY, w, h);
    }
    this.camera.updateProjectionMatrix();
    return true;
  }

  #tick() {
    const now = performance.now();
    if (this.tweens.length) {
      for (const tw of [...this.tweens]) {
        const t = Math.min(1, (now - tw.t0) / tw.dur);
        tw.fn(tw.ease(t));
        if (t >= 1) {
          this.tweens.splice(this.tweens.indexOf(tw), 1);
          tw.resolve();
        }
      }
      this.dirty = true;
    }
    if (!this.running || document.hidden) return;
    // на слабых устройствах — не чаще 30 кадров в секунду
    if (now - this.lastFrame < 1000 / this.profile.fps - 2) return;
    const dt = Math.min(0.1, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
    if (this.debug) this.debug.ticks++;
    this.onFrame?.(dt);
    if (this.#applyViewShift(false)) this.dirty = true;
    this.controls.update(dt);
    if (now < this.pulseUntil && this.winMarker.visible) {
      const pulse = ((now - this.pulseUntil) / 1300) % 1 + 1;
      this.winPulse.visible = true;
      this.winPulse.scale.setScalar(10 + (pulse % 1) * 22);
      this.winPulse.material.opacity = 1 - (pulse % 1);
      this.dirty = true;
    } else if (this.winPulse.visible) {
      this.winPulse.visible = false;
      this.dirty = true;
    }
    if (this.dirty) {
      this.dirty = false;
      this.sky.position.copy(this.camera.position);
      this.#updateLabels();
      this.renderer.render(this.scene, this.camera);
      this.renders++;
      this.#watchPerf(now);
    }
    if (this.debug) this.#debugStats(now);
  }

  // Если кадры при непрерывной анимации идут медленнее ~22 в секунду — понижаем качество.
  // Порог выше 33 мс, чтобы не реагировать на режим экономии батареи, где браузер сам держит 30 кадров/с
  #watchPerf(now) {
    const gap = now - (this.prevRender || now);
    this.prevRender = now;
    if (this.profile.forced || gap <= 0 || gap > 200) {
      this.perfSamples.length = 0;
      return;
    }
    this.perfSamples.push(gap);
    if (this.perfSamples.length < 90) return;
    const avg = this.perfSamples.reduce((a, b) => a + b, 0) / this.perfSamples.length;
    this.perfSamples.length = 0;
    if (avg > Math.max(45, (1000 / this.profile.fps) * 2)) {
      const next = lowerTier(this.profile);
      if (next) this.applyProfile(next);
    }
  }

  #debugStats(now) {
    const d = this.debug;
    const span = now - d.t0;
    if (span < 1000) return;
    const fps = ((this.renders - d.renders) * 1000) / span;
    d.el.textContent = `качество ${this.profile.name}${this.profile.forced ? ' (вручную)' : ''} · DPR ${this.renderer.getPixelRatio()}\n`
      + `кадров/с ${fps.toFixed(0)} · всего ${this.renders}\n${this.profile.gpu || ''}`.slice(0, 160);
    d.t0 = now;
    d.renders = this.renders;
  }
}

// ---------- Текстуры ----------

function toV2(flat) {
  const a = [];
  for (let i = 0; i < flat.length; i += 2) a.push(new THREE.Vector2(flat[i], flat[i + 1]));
  return a;
}

function radialTexture(stops, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let _dot;
function dotTexture() {
  if (_dot) return _dot;
  _dot = radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.45, 'rgba(255,255,255,1)'],
    [0.6, 'rgba(255,255,255,0)'],
    [1, 'rgba(255,255,255,0)'],
  ], 64);
  return _dot;
}

const GROUND = {
  base: '#ebe4d7',
  park: '#dde1c9',
  wood: '#d2d9bd',
  water: '#cdd6d4',
  pitch: '#e3e4cf',
  paved: '#f1ece3',
  road: '#f7f3ec',
  roadEdge: '#d6cbb9',
  path: '#efe8dc',
  rail: '#c3b7a5',
  ink: '#8e7f6d',
};

async function groundTexture(model, size) {
  try {
    await document.fonts.load('500 40px "Cormorant"');
    await document.fonts.load('500 20px "JetBrains Mono"');
  } catch (e) { /* шрифты не критичны */ }
  const R2 = model.R2;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const k = size / (2 * R2);
  const X = (x) => (x + R2) * k;
  const Y = (y) => (R2 - y) * k;
  g.fillStyle = GROUND.base;
  g.fillRect(0, 0, size, size);
  g.save();
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  g.clip();

  const path = (rings) => {
    g.beginPath();
    for (const r of rings) {
      g.moveTo(X(r[0]), Y(r[1]));
      for (let i = 2; i < r.length; i += 2) g.lineTo(X(r[i]), Y(r[i + 1]));
      g.closePath();
    }
  };
  const order = ['paved', 'park', 'wood', 'pitch', 'water'];
  for (const kind of order) {
    for (const a of model.areas) {
      if (a.kind !== kind) continue;
      path(a.rings);
      g.fillStyle = GROUND[kind];
      g.fill('evenodd');
    }
  }
  // мягкий контур у воды
  g.lineWidth = 1.2 * k;
  g.strokeStyle = 'rgba(120,140,140,0.25)';
  for (const a of model.areas) if (a.kind === 'water') { path(a.rings); g.stroke(); }

  const line = (pts) => {
    g.beginPath();
    g.moveTo(X(pts[0]), Y(pts[1]));
    for (let i = 2; i < pts.length; i += 2) g.lineTo(X(pts[i]), Y(pts[i + 1]));
  };
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const roads = model.roads.filter((r) => r.kind !== 'rail');
  const minor = new Set(['footway', 'path', 'cycleway', 'steps', 'bridleway', 'track']);
  // обочины, затем полотно — так перекрёстки сливаются
  for (const r of roads) {
    if (minor.has(r.kind)) continue;
    line(r.pts);
    g.strokeStyle = GROUND.roadEdge;
    g.lineWidth = (r.w + 1.6) * k;
    g.stroke();
  }
  for (const r of roads) {
    if (minor.has(r.kind)) continue;
    line(r.pts);
    g.strokeStyle = GROUND.road;
    g.lineWidth = r.w * k;
    g.stroke();
  }
  for (const r of roads) {
    if (!minor.has(r.kind)) continue;
    line(r.pts);
    g.strokeStyle = GROUND.path;
    g.lineWidth = r.w * k;
    g.stroke();
  }
  g.setLineDash([3 * k, 3 * k]);
  for (const r of model.roads) {
    if (r.kind !== 'rail') continue;
    line(r.pts);
    g.strokeStyle = GROUND.rail;
    g.lineWidth = 1.4 * k;
    g.stroke();
  }
  g.setLineDash([]);
  g.restore();

  // Компас по краю подиума
  const cx = size / 2, cy = size / 2;
  const rr = (R2 - 14) * k;
  g.strokeStyle = 'rgba(110,95,78,0.45)';
  g.lineWidth = Math.max(1, 0.9 * k);
  g.beginPath();
  g.arc(cx, cy, rr, 0, Math.PI * 2);
  g.stroke();
  for (let a = 0; a < 360; a += 5) {
    const big = a % 45 === 0, mid = a % 15 === 0;
    const len = (big ? 9 : mid ? 5 : 2.6) * k;
    const t = (a * Math.PI) / 180;
    g.lineWidth = Math.max(1, (big ? 1.1 : 0.7) * k);
    g.beginPath();
    g.moveTo(cx + Math.sin(t) * rr, cy - Math.cos(t) * rr);
    g.lineTo(cx + Math.sin(t) * (rr - len), cy - Math.cos(t) * (rr - len));
    g.stroke();
  }
  g.fillStyle = GROUND.ink;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const letters = [['С', 0], ['В', 90], ['Ю', 180], ['З', 270]];
  for (const [l, a] of letters) {
    const t = (a * Math.PI) / 180;
    const rl = rr - 22 * k;
    g.save();
    g.translate(cx + Math.sin(t) * rl, cy - Math.cos(t) * rl);
    g.rotate(t);
    g.font = `500 ${Math.round(17 * k)}px "Cormorant", Georgia, serif`;
    g.fillText(l, 0, 0);
    g.restore();
  }
  // Масштабная линейка
  g.save();
  g.translate(cx, cy + rr - 44 * k);
  g.strokeStyle = 'rgba(110,95,78,0.6)';
  g.lineWidth = Math.max(1, 0.8 * k);
  g.beginPath();
  g.moveTo(-50 * k, 0); g.lineTo(50 * k, 0);
  g.moveTo(-50 * k, -3 * k); g.lineTo(-50 * k, 3 * k);
  g.moveTo(50 * k, -3 * k); g.lineTo(50 * k, 3 * k);
  g.moveTo(0, -2 * k); g.lineTo(0, 2 * k);
  g.stroke();
  g.font = `500 ${Math.round(5.2 * k)}px "JetBrains Mono", monospace`;
  g.fillText('100 м', 0, -8 * k);
  g.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
