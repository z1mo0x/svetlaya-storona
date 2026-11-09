import { Stage } from './scene.js';
import { featuresToModel, makeProjection, pointInRings, LEVEL_H } from './osm.js';
import { loadFeatures } from './tiles.js';
import { Analyzer, floorZ, floorsOf, NIGHT, BLOCKED, LIT } from './insolation.js';
import {
  sunPosition, sunVector, localToUTC, guessUtcOffset, formatOffset,
  MONTHS_GEN, dayOfYear, dateFromDoy, fmtTime, fmtDur,
} from './sun.js';
import { suggest } from './geocode.js';
import { Calc } from './calc.js';
import { initAnalytics, goal } from './analytics.js';
import { makeCard, shareCard, printReport } from './report.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const body = document.body;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const PLACES = {
  demo: { title: 'Москва, Пресня', lat: 55.7515, lon: 37.5395, region: 'Москва', country: 'ru', demo: true },
  spb: { title: 'Санкт-Петербург, Петроградская сторона', lat: 59.9608, lon: 30.3086, region: 'Санкт-Петербург', country: 'ru' },
  ekb: { title: 'Екатеринбург-Сити', lat: 56.8436, lon: 60.5937, region: 'Свердловская область', country: 'ru' },
};
// Окно демо-дома: пятиэтажка у подножия Москва-Сити, фасад на юг, к башням
const DEMO_WIN = { addr: '1-й Красногвардейский проезд, 20', face: [0.45, -0.9], floor: 2 };

const TYPE_NAMES = {
  apartments: 'жилой дом', residential: 'жилой дом', house: 'частный дом', detached: 'частный дом',
  dormitory: 'общежитие', office: 'офисное здание', commercial: 'коммерческое здание', retail: 'магазин',
  industrial: 'промышленное здание', warehouse: 'склад', school: 'школа', kindergarten: 'детский сад',
  garage: 'гараж', garages: 'гаражи', construction: 'стройка', church: 'храм', hospital: 'больница',
  university: 'университет', hotel: 'гостиница', public: 'общественное здание', service: 'техническое здание',
  roof: 'навес', parking: 'паркинг', yes: 'здание',
};
const DIRS = ['север', 'северо-восток', 'восток', 'юго-восток', 'юг', 'юго-запад', 'запад', 'северо-запад'];
const DIRS_SHORT = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
const OUTDOOR_CODES = ['none', 'loggia', 'balcony'];
const STATE_COLORS = ['#2b2b3d', '#e6ddcf', '#9aa6c0', '#f2a447'];

history.scrollRestoration = 'manual';
const now = new Date();
const S = {
  mode: 'landing',
  place: null,
  model: null,
  an: null,
  proj: null,
  tz: 3,
  tzExact: true,
  date: { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() },
  minute: 12 * 60,
  playing: false,
  win: null,
  day: null,
  yr: null,
  norm: null,
  matrix: null,
  matrixKey: null,
  matrixJob: 0,
  calc: 0,
  load: 0,
  heroVisible: true,
  last: {},
  outdoor: 'none', // что у окна: ничего, лоджия или балкон этажом выше — запоминаем между окнами
  depth: 1.2,
  maxHours: null,
  acc: null, // точность: разброс часов при других высотах угаданных домов
  build: null, // окно без дорисованных домов
  flat: emptyFlat(), // вся квартира: комнаты и их расчёт
  pendingFlat: null, // комнаты из ссылки ждут загрузки квартала
  compare: [], // варианты для сравнения (хранятся в браузере)
};

// ---------- Сцена ----------
const stage = new Stage($('#gl'), $('#labels'), { onHover, onPick });
stage.onFrame = frame;
stage.setMode('landing');
// год солнца и этажи считаются в фоне, чтобы интерфейс не подвисал
const calc = new Calc();
// ?debug=1 — доступ к состоянию из консоли разработчика
if (new URLSearchParams(location.search).has('debug')) window.__app = { stage, S, calc };

function frame(dt) {
  if (!S.model) return;
  if (S.mode === 'landing') {
    if (!S.heroVisible) return;
    const rise = S.day?.sunrise ?? 360, set = S.day?.sunset ?? 1200;
    S.minute += dt * 30;
    if (S.minute > set + 25 || S.minute < rise - 25) S.minute = rise - 25;
    updateTime();
  } else if (S.playing) {
    S.minute = (S.minute + dt * 45) % 1440;
    updateTime();
  }
}

// ---------- Модель и место ----------
async function applyModel(place, model) {
  S.place = place;
  S.model = model;
  S.an = new Analyzer(model);
  S.proj = makeProjection(model.lat, model.lon);
  const tz = guessUtcOffset(place.lat, place.lon, place.region || '', place.country || '');
  S.tz = tz.offset;
  S.tzExact = tz.exact;
  calc.setModel(model);
  S.flat = emptyFlat();
  S.maxHours = null;
  calc.max(S.date.y, S.tz).then((h) => {
    if (S.model !== model) return;
    S.maxHours = h;
    renderVerdict();
  });
  $('#placeName').textContent = place.title;
  $('#tzName').textContent = formatOffset(S.tz) + (S.tzExact ? '' : ' ≈');
  clearWindow();
  await stage.setModel(model, { animate: true });
  updateDate();
}

async function loadPlace(place, prefer) {
  const token = ++S.load;
  if (S.drawing) stopDraw();
  setPlaying(false);
  hideFocus();
  showLoader('Загружаем дома из OpenStreetMap', 0.06);
  try {
    const { features, source } = await loadFeatures(place.lat, place.lon, 470, {
      onProgress: (p) => token === S.load && setLoader(null, 0.1 + p * 0.7),
    });
    if (token !== S.load) return;
    const model = featuresToModel(features, place.lat, place.lon);
    model.source = source;
    if (!model.buildings.length) throw new Error('empty');
    setLoader(`Собрали ${model.buildings.length} ${plural(model.buildings.length, ['дом', 'дома', 'домов'])}`, 1);
    await new Promise((r) => setTimeout(r, 450));
    hideLoader();
    await applyModel(place, model);
    if (token !== S.load) return;
    if (place.added?.length) addBuildings(place.added);
    goal('place_loaded', { buildings: model.buildings.length, source: model.source });
    const w = autoWindow(prefer);
    if (w) setWindow(w, { source: prefer?.exact ? 'link' : 'auto' });
    applyPendingFlat();
    S.minute = sunnyMinute();
    updateTime();
    flyToWindow(1, 2400);
  } catch (e) {
    if (token !== S.load) return;
    console.error(e);
    hideLoader();
    const msg = {
      empty: 'Здесь нет зданий в OpenStreetMap — попробуйте другой адрес',
      rate: 'OpenStreetMap временно ограничил частоту запросов. Подождите минуту и попробуйте снова.',
    }[e.message] || 'Не удалось загрузить дома из OpenStreetMap. Проверьте соединение и попробуйте ещё раз.';
    goal('place_error', { reason: e.message });
    toast(msg, 5200);
  }
}

function floorRange(b) {
  const { lo, hi, fh } = floorsOf(b);
  return [lo, hi, fh];
}

// Фасад здания, наиболее близкий к направлению face
function facadeOf(i, face = [0, -1], at) {
  const b = S.model.buildings[i];
  let best = null;
  for (const p of b.polys) {
    const r = p.outer;
    for (let k = 0; k < r.length; k += 2) {
      const ax = r[k], ay = r[k + 1], bx = r[(k + 2) % r.length], by = r[(k + 3) % r.length];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 5) continue;
      let nx = (by - ay) / L, ny = -(bx - ax) / L;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      if (pointInRings(mx + nx, my + ny, [r])) { nx = -nx; ny = -ny; }
      let score = nx * face[0] + ny * face[1] + Math.min(L, 40) / 400;
      if (at) score = -Math.hypot(mx - at[0], my - at[1]) + (nx * face[0] + ny * face[1]) * 4;
      if (!best || score > best.score) best = { score, x: mx, y: my, nx, ny };
    }
  }
  return best;
}

function buildingAt(x, y, maxD = 70) {
  let best = -1, bestD = maxD;
  S.model.buildings.forEach((b, i) => {
    if (pointInRings(x, y, b.polys.flatMap((p) => [p.outer, ...p.holes]))) { bestD = -1; best = i; }
    if (bestD < 0) return;
    const d = Math.hypot(b.cx - x, b.cy - y);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function autoWindow(prefer) {
  if (prefer?.exact) {
    const i = buildingAt(prefer.x - prefer.nx * 2, prefer.y - prefer.ny * 2, 15);
    if (i >= 0) return { i, x: prefer.x, y: prefer.y, nx: prefer.nx, ny: prefer.ny, floor: prefer.floor };
  }
  const i = buildingAt(0, 0);
  if (i < 0) return null;
  const f = facadeOf(i, prefer ? [prefer.nx, prefer.ny] : [0, -1]);
  if (!f) return null;
  return { i, x: f.x, y: f.y, nx: f.nx, ny: f.ny, floor: prefer?.floor ?? 3 };
}

// ---------- Окно ----------
// Окно с этажами и высотой по дому i — для текущего окна и для комнат квартиры
function windowFor(w) {
  const b = S.model.buildings[w.i];
  const [lo, hi, fh] = floorRange(b);
  const L = Math.hypot(w.nx, w.ny) || 1;
  const win = {
    ...w, nx: w.nx / L, ny: w.ny / L, floor: clamp(Math.round(w.floor), lo, hi), lo, hi, fh, group: b.group,
    outdoor: w.outdoor ?? S.outdoor, depth: w.depth ?? S.depth,
  };
  win.z = floorZ(win.floor, fh);
  return win;
}

function setWindow(w, { fly = false, source } = {}) {
  const b = S.model.buildings[w.i];
  const win = windowFor(w);
  S.win = win;
  body.classList.add('has-win');
  stage.setTint('target', b.group);
  stage.setWindow({ ...win, label: `${win.floor} этаж` });
  renderWindowPanel();
  recompute();
  checkEdge();
  updateHash();
  if (source) goal('window_set', { source });
  if (fly) flyToWindow();
}

// Стороны дома: самая длинная стена в каждом из 8 направлений — выбор окна без клика по 3D
function sidesOf(i) {
  const b = S.model.buildings[i];
  const best = new Map();
  for (const p of b.polys) {
    const r = p.outer;
    for (let k = 0; k < r.length; k += 2) {
      const ax = r[k], ay = r[k + 1], bx = r[(k + 2) % r.length], by = r[(k + 3) % r.length];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 4) continue;
      let nx = (by - ay) / L, ny = -(bx - ax) / L;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      if (pointInRings(mx + nx, my + ny, [r])) { nx = -nx; ny = -ny; }
      const az = ((Math.atan2(nx, ny) * 180) / Math.PI + 360) % 360;
      const sector = Math.round(az / 45) % 8;
      if (!best.has(sector) || best.get(sector).L < L) best.set(sector, { sector, L, x: mx, y: my, nx, ny });
    }
  }
  return [...best.values()].sort((a, c) => a.sector - c.sector);
}

function sectorOf(nx, ny) {
  return Math.round((((Math.atan2(nx, ny) * 180) / Math.PI + 360) % 360) / 45) % 8;
}

function setSide(sector) {
  if (!S.win) return;
  const side = sidesOf(S.win.i).find((x) => x.sector === sector);
  if (!side) return;
  setWindow({ ...S.win, x: side.x, y: side.y, nx: side.nx, ny: side.ny }, { source: 'side' });
}

function setOutdoor(kind, depth = S.depth) {
  S.outdoor = kind;
  S.depth = clamp(Math.round(depth * 10) / 10, 0.6, 2.4);
  if (!S.win) return renderWindowPanel();
  S.win.outdoor = S.outdoor;
  S.win.depth = S.depth;
  renderWindowPanel();
  recompute();
  updateTime();
  updateHash();
  goal('outdoor_change', { kind, depth: S.depth });
}

function clearWindow() {
  S.win = null;
  S.yr = S.norm = null;
  S.matrix = null;
  S.matrixKey = null;
  body.classList.remove('has-win');
  stage.setWindow(null);
  stage.setTint('target', null);
  stage.setTint('blocker', null);
  $('#edgeNote').hidden = true;
  renderWindowPanel();
}

function setFloor(f) {
  if (!S.win) return;
  f = clamp(f, S.win.lo, S.win.hi);
  if (f === S.win.floor) return;
  S.win.floor = f;
  S.win.z = floorZ(f, S.win.fh);
  stage.setWindow({ ...S.win, label: `${f} этаж` });
  renderWindowPanel();
  recompute();
  updateHash();
}

function setBuildingLevels(i, levels) {
  const b = S.model.buildings[i];
  levels = clamp(levels, 1, 160);
  // если высота известна из OSM, меняем только число этажей, а не габарит дома
  if (b.heightKnown === undefined) b.heightKnown = b.src === 'height';
  b.levels = levels;
  if (!b.heightKnown) b.h = Math.max(b.minH + LEVEL_H, levels * LEVEL_H);
  b.src = 'user';
  S.an.items[i].h = b.h;
  S.an.heights[i] = b.h;
  calc.setHeight(i, b.h);
  S.matrixKey = null;
  stage.rebuildBuildings();
  if (S.win) setWindow({ ...S.win });
  else updateHash();
  if (!$('#focusCard').hidden && S.focus === i) renderFocus(i);
}

function checkEdge() {
  const far = S.win && Math.hypot(S.win.x, S.win.y) > S.model.R * 0.55;
  $('#edgeNote').hidden = !far || S.mode !== 'app';
}

// ---------- Расчёты ----------
function recompute() {
  if (!S.win) return;
  const token = ++S.calc;
  const y = S.date.y;
  S.norm = S.an.norm(S.win, y, S.tz);
  renderNorm();
  updateDate();
  $('#verdict').classList.add('is-busy');
  calc.year(S.win, y, S.tz, 10, 1).then((yr) => {
    if (token !== S.calc) return;
    S.yr = yr;
    renderYear();
    renderBlockers();
    renderVerdict();
    updateAccuracy(token);
    updateBuild(token);
    drawHeat($('#heat'), S.yr, dayOfYear(y, S.date.m, S.date.d));
    if (S.onYear) {
      const f = S.onYear;
      S.onYear = null;
      f();
    }
  }).catch((e) => console.error(e));
  updateMatrix();
  updateFlat();
}

// Точность: насколько ответ зависит от домов, чья высота не указана в OSM и угадана по типу здания.
// Пересчитываем с угаданными домами на 40% ниже и на 60% выше
const ACC_LOW = 0.6, ACC_HIGH = 1.6;

function updateAccuracy(token) {
  const w = S.win, y = S.date.y;
  const guessed = [];
  S.model.buildings.forEach((b, i) => {
    if (b.src === 'guess' && Math.hypot(b.cx - w.x, b.cy - w.y) < 450) guessed.push(i);
  });
  S.acc = { guessed, lo: null, hi: null, normFlip: false };
  renderAccuracy();
  if (!guessed.length) return;
  const scaled = (k) => guessed.map((i) => {
    const b = S.model.buildings[i];
    return [i, Math.max(b.minH + 1, b.h * k)];
  });
  Promise.all([calc.variant(w, y, S.tz), calc.variant(w, y, S.tz, scaled(ACC_LOW)), calc.variant(w, y, S.tz, scaled(ACC_HIGH))])
    .then(([base, low, high]) => {
      if (token !== S.calc) return;
      // варианты считаются грубее основного расчёта — переносим их пропорцией на точные часы
      const k = base.hours > 1 ? S.yr.litHours / base.hours : 1;
      S.acc.hi = Math.max(S.yr.litHours, low.hours * k);
      S.acc.lo = Math.min(S.yr.litHours, high.hours * k);
      S.acc.normFlip = low.norm.pass !== high.norm.pass;
      renderAccuracy();
    })
    .catch((e) => console.error(e));
}

function accuracyLevel() {
  const a = S.acc;
  if (!a || !S.yr) return null;
  if (!a.guessed.length) return 'high';
  if (a.lo == null) return null;
  const spread = a.hi - a.lo, H = S.yr.litHours;
  if (a.normFlip) return 'low';
  return spread <= Math.max(40, H * 0.1) ? 'high' : spread <= Math.max(120, H * 0.3) ? 'mid' : 'low';
}

function renderAccuracy() {
  const a = S.acc;
  if (!a || !S.yr || !S.win) return;
  const level = accuracyLevel();
  const tag = $('#accLevel');
  tag.textContent = level ? { high: 'высокая', mid: 'средняя', low: 'низкая' }[level] : 'считаем…';
  tag.className = `acc-level${level ? ` is-${level}` : ''}`;
  const top = (S.yr.top || []).filter((t) => t.share >= 0.01);
  const guessTop = top.filter((t) => groupGuessed(t.group)).length;
  let t;
  if (!a.guessed.length) t = 'Высоты всех домов вокруг окна есть в OpenStreetMap.';
  else if (guessTop) t = `Высота ${guessTop} из ${top.length} ${plural(top.length, ['дома', 'домов', 'домов'])}, которые забирают солнце, не указана в OpenStreetMap и угадана по типу здания.`;
  else t = `У ${a.guessed.length} ${plural(a.guessed.length, ['дома', 'домов', 'домов'])} поблизости высота не указана в OpenStreetMap и угадана по типу здания.`;
  if (a.lo != null) {
    const fmt = (v) => Math.round(v).toLocaleString('ru-RU');
    t += Math.round(a.hi) - Math.round(a.lo) < 10
      ? ' Даже если угаданные дома на 40% ниже или на 60% выше, ответ почти не меняется.'
      : ` Если угаданные дома на 40% ниже или на 60% выше — от <b>${fmt(a.lo)}</b> до <b>${fmt(a.hi)} ч</b> в год.`;
    if (a.normFlip) t += ' От этого зависит и вывод по норме.';
  }
  if (S.model.buildings[S.win.i]?.src === 'guess') t += ' Этажность вашего дома тоже угадана — проверьте номер этажа.';
  if (guessTop || S.model.buildings[S.win.i]?.src === 'guess') t += ' Знаете этажность? Кликните по крыше и укажите её — расчёт уточнится.';
  $('#accText').innerHTML = t;
}

function groupGuessed(g) {
  return (stage.groups.get(g) || []).some((i) => S.model.buildings[i].src === 'guess');
}

const fmtH = (v) => Math.round(v).toLocaleString('ru-RU');
const normWord = (n) => (n.edge ? 'на грани' : n.pass ? 'выполняется' : 'не выполняется');

// «До стройки»: если пользователь дорисовал дома, считаем окно ещё и без них
function updateBuild(token) {
  const added = [];
  S.model.buildings.forEach((b, i) => {
    if (b.added) added.push([i, 0]);
  });
  S.build = null;
  renderBuild();
  if (!added.length) return;
  calc.variant(S.win, S.date.y, S.tz, added, 10, 1)
    .then((r) => {
      if (token !== S.calc) return;
      S.build = { hours: r.hours, norm: r.norm, count: added.length };
      renderBuild();
    })
    .catch((e) => console.error(e));
}

function buildText() {
  if (!S.build || !S.yr || !S.norm) return null;
  const before = S.build.hours, after = S.yr.litHours;
  const lost = before > 0 ? Math.round((1 - after / before) * 100) : 0;
  const what = S.build.count > 1 ? 'Дорисованные дома' : 'Дорисованный дом';
  return {
    lead: `${what} ${lost >= 1 ? `${S.build.count > 1 ? 'заберут' : 'заберёт'} ${lost}% солнца` : 'почти не мешает этому окну'}.`,
    rest: `Сейчас ${fmtH(before)} ч в год, норма ${normWord(S.build.norm)}. После стройки ${fmtH(after)} ч, норма ${normWord(S.norm)}.`,
  };
}

function renderBuild() {
  const el = $('#vBuild');
  const t = buildText();
  el.hidden = !t;
  if (t) el.innerHTML = `<b>${t.lead}</b> ${t.rest}`;
}

// ---------- Вся квартира ----------
// СанПиН 1.2.3685-21: в 1–3-комнатной квартире солнце по норме нужно хотя бы в одной жилой комнате, в 4+ — в двух
let flatJob = 0;
const flatNeed = (size) => (size >= 4 ? 2 : 1);
const sameWin = (a, b) => a && b && a.i === b.i && a.floor === b.floor && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

function emptyFlat() {
  return { size: 2, rooms: [], res: [], key: null };
}

function roomAdd() {
  if (!S.win) return;
  const rooms = S.flat.rooms;
  if (rooms.some((r) => sameWin(r, S.win))) return toast('Это окно уже добавлено');
  if (rooms.length >= 6) return toast('Не больше шести окон');
  const { i, x, y, nx, ny, floor, outdoor, depth } = S.win;
  rooms.push({ i, x, y, nx, ny, floor, outdoor, depth });
  if (rooms.length > S.flat.size) S.flat.size = Math.min(6, rooms.length);
  goal('room_add', { rooms: rooms.length });
  updateFlat();
  updateHash();
}

function roomRemove(k) {
  S.flat.rooms.splice(k, 1);
  updateFlat();
  updateHash();
}

function setRooms(n) {
  S.flat.size = clamp(n, 1, 6);
  renderFlat();
  updateHash();
}

// Каждая комната считается так же точно, как основное окно; пересчёт — только если что-то изменилось
function updateFlat() {
  const rooms = S.flat.rooms;
  const heights = S.model.buildings.reduce((s, b) => s + b.h, 0);
  const key = `${rooms.map((r) => `${r.i}:${r.x}:${r.y}:${r.floor}:${r.outdoor}:${r.depth}`).join('|')}#${S.date.y}#${heights}#${S.model.buildings.length}`;
  if (key === S.flat.key) return renderFlat();
  S.flat.key = key;
  S.flat.res = rooms.map(() => null);
  renderFlat();
  const job = ++flatJob;
  rooms.forEach((r, k) => {
    calc.variant(windowFor(r), S.date.y, S.tz, [], 10, 1)
      .then((res) => {
        if (job !== flatJob) return;
        S.flat.res[k] = res;
        renderFlat();
      })
      .catch((e) => console.error(e));
  });
}

// Квартира относится к текущему окну, только если это окно — одна из её комнат
function flatOfWindow() {
  const s = flatStatus();
  return s && s.state !== 'wait' && S.flat.rooms.some((r) => sameWin(r, S.win)) ? s : null;
}

function flatStatus() {
  const { rooms, res, size } = S.flat;
  if (!rooms.length) return null;
  if (res.some((x) => !x)) return { state: 'wait' };
  const need = flatNeed(size);
  const pass = res.filter((x) => x.norm.pass).length;
  const sure = res.filter((x) => x.norm.pass && !x.norm.edge).length;
  const s = { pass, need, marked: rooms.length, size };
  if (pass >= need) return { ...s, state: sure >= need ? 'pass' : 'edge' };
  return { ...s, state: rooms.length < size ? 'open' : 'fail' };
}

function flatText(s) {
  if (s.state === 'wait') return { lead: 'Считаем комнаты…', rest: '' };
  const need = s.need === 2 ? 'в двух' : 'хотя бы в одной';
  const rest = `Солнце по норме в ${s.pass} из ${s.marked} ${plural(s.marked, ['отмеченной комнаты', 'отмеченных комнат', 'отмеченных комнат'])}, нужно ${need}.`;
  const lead = {
    pass: 'Квартира проходит норму.',
    edge: 'Квартира на грани нормы.',
    fail: 'Квартира не проходит норму.',
    open: 'Пока не хватает.',
  }[s.state];
  const more = s.size - s.marked;
  const tail = s.state === 'open' ? ` Отметьте остальные комнаты (ещё ${more}).` : s.state === 'edge' ? ' Хватает только с окнами «на грани».' : '';
  return { lead, rest: rest + tail };
}

function renderFlat() {
  const f = S.flat;
  $('#roomsOut').textContent = `${f.size} комн.`;
  $('#rooms').innerHTML = f.rooms.map((r, k) => {
    const res = f.res[k];
    const st = res ? (res.norm.edge ? 'edge' : res.norm.pass ? 'pass' : 'fail') : 'wait';
    const word = { pass: 'норма', edge: 'на грани', fail: 'нет нормы', wait: 'считаем…' }[st];
    return `<li class="room is-${st}${sameWin(r, S.win) ? ' cur' : ''}">
      <button type="button" class="room-open" data-k="${k}">
        <span class="room-name">Комната ${k + 1}</span>
        <span class="room-meta">${DIRS_SHORT[sectorOf(r.nx, r.ny)]} · ${r.floor} этаж${res ? ` · ${fmtH(res.hours)} ч` : ''}</span>
        <span class="room-norm">${word}</span>
      </button>
      <button type="button" class="room-del" data-del="${k}" aria-label="Убрать комнату ${k + 1}">×</button>
    </li>`;
  }).join('');
  const s = flatStatus();
  const v = $('#flatVerdict');
  v.hidden = !s;
  if (s) {
    const t = flatText(s);
    v.className = `flat-verdict is-${s.state}`;
    v.innerHTML = `<b>${t.lead}</b> ${t.rest}`;
  }
  const added = f.rooms.some((r) => sameWin(r, S.win));
  $('#roomAdd').disabled = added || f.rooms.length >= 6;
  $('#roomAdd').textContent = added ? 'Это окно уже в квартире' : f.rooms.length ? 'Добавить это окно' : 'Добавить это окно как комнату';
}

// Комнаты в ссылке: «комнат;x:y:nx:ny:этаж:лоджия:глубина,…»
function flatToHash() {
  const f = S.flat;
  if (!f.rooms.length) return '';
  return `${f.size};${f.rooms.map((r) => `${[r.x, r.y, r.nx, r.ny].map((v) => v.toFixed(2)).join(':')}:${r.floor}:${Math.max(0, OUTDOOR_CODES.indexOf(r.outdoor))}:${r.depth}`).join(',')}`;
}

function flatFromHash(str) {
  if (!str) return null;
  const [size, list] = str.split(';');
  const specs = (list || '').split(',').map((s) => s.split(':').map(Number)).filter((a) => a.length === 7 && a.every(isFinite))
    .map(([x, y, nx, ny, floor, o, depth]) => ({ x, y, nx, ny, floor, outdoor: OUTDOOR_CODES[o] || 'none', depth: clamp(depth, 0.6, 2.4) }));
  return specs.length ? { size: clamp(Math.round(+size) || 2, 1, 6), specs } : null;
}

// Комнаты из ссылки привязываем к домам уже загруженного квартала
function applyPendingFlat() {
  const p = S.pendingFlat;
  S.pendingFlat = null;
  if (!p) return;
  S.flat = emptyFlat();
  S.flat.size = p.size;
  for (const sp of p.specs) {
    const i = buildingAt(sp.x - sp.nx * 2, sp.y - sp.ny * 2, 15);
    if (i >= 0) S.flat.rooms.push({ i, ...sp });
  }
  updateFlat();
  updateHash();
}

// Главный ответ: насколько солнечно и сколько забирают соседи
function renderVerdict() {
  const box = $('#verdict');
  if (!S.yr || !S.win) return;
  box.classList.remove('is-busy');
  const hours = S.yr.litHours;
  const ratio = S.maxHours ? hours / S.maxHours : null;
  const level = ratio == null ? 'mid' : ratio >= 0.55 ? 'sunny' : ratio >= 0.3 ? 'mid' : 'low';
  box.dataset.level = level;
  $('#vBadge').textContent = { sunny: 'Солнечно', mid: 'Средне', low: 'Мало солнца' }[level];
  const h = Math.round(hours).toLocaleString('ru-RU');
  let t = `<b>${h} ч</b> прямого солнца в год`;
  if (ratio != null) t += ` — ${Math.round(ratio * 100)}% от лучшего на этой широте (южное окно без соседей).`;
  else t += '.';
  const lost = S.yr.lost;
  t += lost >= 0.05
    ? ` Соседние дома забирают <b>${Math.round(lost * 100)}%</b> солнца, которое могло бы попасть в окно.`
    : ' Соседние дома почти не мешают.';
  if (S.win.outdoor === 'loggia') t += ' С учётом лоджии.';
  if (S.win.outdoor === 'balcony') t += ' С учётом балкона сверху.';
  $('#vText').innerHTML = t;
}

function daySunOnly(y, m, d) {
  const step = 2, n = 720;
  const state = new Uint8Array(n);
  let sunrise = -1, sunset = -1;
  for (let k = 0; k < n; k++) {
    const p = sunPosition(localToUTC(y, m, d, k * step, S.tz), S.model.lat, S.model.lon);
    if (p.alt > 0) {
      state[k] = 1;
      if (sunrise < 0) sunrise = k * step;
      sunset = (k + 1) * step;
    }
  }
  return { step, state, sunrise, sunset, intervals: [], lit: 0, sunOnly: true };
}

function updateDate() {
  if (!S.model) return;
  const { y, m, d } = S.date;
  S.day = S.win ? S.an.day(S.win, y, m, d, S.tz, 2) : daySunOnly(y, m, d);
  const doy = dayOfYear(y, m, d);
  const r = $('#doyRange');
  r.value = doy;
  fillRange(r);
  $('#dateOut').textContent = `${d} ${MONTHS_GEN[m]}`;
  $('#roDate').textContent = `${d} ${MONTHS_GEN[m]}`;
  $$('#dateChips button').forEach((b) => {
    const v = b.dataset.date;
    const on = v === 'today' ? (m === now.getMonth() && d === now.getDate()) : v === `${m}-${d}`;
    b.classList.toggle('active', on);
  });
  updateArcs();
  renderDay();
  drawTrack($('#dayCanvas'), S.day);
  drawTrack($('#roTrack'), S.day);
  if (S.yr) drawHeat($('#heat'), S.yr, doy);
  updateTime();
}

function updateArcs() {
  const { y, m, d } = S.date;
  const { lat, lon } = S.model;
  const every = S.mode === 'app' ? 1 : 3;
  const arc = (mm, dd, kind, label, hours) => {
    const pts = [];
    for (let min = 0; min <= 1440; min += 5) {
      const p = sunPosition(localToUTC(y, mm, dd, min, S.tz), lat, lon);
      if (p.alt > -0.035) pts.push([p.alt, p.az]);
    }
    const hs = [];
    if (hours) {
      for (let h = 0; h <= 24; h += every) {
        const p = sunPosition(localToUTC(y, mm, dd, h * 60, S.tz), lat, lon);
        if (p.alt > 0.03) hs.push({ alt: p.alt, az: p.az, label: String(h).padStart(2, '0') });
      }
    }
    return { kind, pts, hours: hours ? hs : null, label };
  };
  stage.setSunPaths([
    arc(5, 21, 'summer', '22 июня'),
    arc(11, 22, 'winter', '22 декабря'),
    arc(m, d, 'today', null, true),
  ]);
}

function updateTime() {
  if (!S.model) return;
  const { y, m, d } = S.date;
  const p = sunPosition(localToUTC(y, m, d, S.minute, S.tz), S.model.lat, S.model.lon);
  stage.setSun(p.alt, p.az);
  let st = p.alt > 0 ? 1 : 0;
  let blk = -1;
  if (S.win) {
    const w = S.an.prepare(S.win);
    const v = sunVector(p.alt, p.az);
    const [s, b] = S.an.sample(w, v, S.an.items);
    st = s;
    let t = 0;
    if (s === BLOCKED) {
      t = S.an.cast(w.ox, w.oy, w.z, v[0], v[1], v[2]).t;
      blk = b;
    }
    stage.setRay(['night', 'behind', 'blocked', 'lit'][s], t);
    stage.setTint('blocker', blk >= 0 ? S.model.buildings[blk].group : null);
  }
  const altDeg = (p.alt * 180) / Math.PI, azDeg = ((p.az * 180) / Math.PI + 360) % 360;
  setText('#clock', fmtTime(S.minute));
  setText('#roClock', fmtTime(S.minute));
  setText('#roAlt', `${Math.round(altDeg)}°`);
  setText('#sunInfo', altDeg > 0 ? `солнце ${Math.round(altDeg)}° · азимут ${Math.round(azDeg)}°` : 'солнце под горизонтом');
  const ph = $('#playhead');
  const tw = $('#track').clientWidth;
  ph.style.transform = `translateX(${(S.minute / 1440) * tw}px)`;
  renderRayState(st, blk);
  body.classList.toggle('is-night', altDeg < -4);
}

function renderRayState(st, blk) {
  const key = `${st}|${blk}|${S.win?.floor}`;
  if (S.last.ray === key) return;
  S.last.ray = key;
  const el = $('#rayState'), ro = $('#roStatus');
  const cls = st === LIT ? '' : st === BLOCKED ? 'is-blocked' : 'is-off';
  el.className = `ray-state ${cls}`;
  ro.className = `readout-status ${cls}`;
  const names = ['Ночь', 'Солнце за стеной', 'Тень от дома', 'Окно на солнце'];
  el.querySelector('span').textContent = S.win ? names[st] : st ? 'День' : 'Ночь';
  let text = 'Ночь';
  if (S.win) {
    const f = `Окно ${S.win.floor}-го этажа`;
    if (st === LIT) text = `${f} на солнце`;
    else if (st === BLOCKED) text = `${f} в тени: ${shortName(S.model.buildings[blk])}`;
    else if (st === 1) text = 'Солнце с другой стороны дома';
  }
  ro.querySelector('span').textContent = text;
}

// ---------- Отрисовка панелей ----------
function renderWindowPanel() {
  const w = S.win;
  $('#floorSec').style.display = w ? '' : 'none';
  $('#levelsSec').style.display = w ? '' : 'none';
  $('#outdoorSec').style.display = w ? '' : 'none';
  $('#flatSec').style.display = w ? '' : 'none';
  if (!w) {
    $('#winTitle').textContent = 'Кликните по стене дома';
    $('#winSub').textContent = 'там, где находится ваше окно';
    return;
  }
  const b = S.model.buildings[w.i];
  $('#winTitle').textContent = b.name || b.addr || capital(TYPE_NAMES[b.type] || 'Здание');
  const lv = groupLevels(b.group);
  const sub = [b.name && b.addr ? b.addr : TYPE_NAMES[b.type] || 'здание', `${lv} ${plural(lv, ['этаж', 'этажа', 'этажей'])}`, `${Math.round(b.h)} м`];
  $('#winSub').textContent = sub.join(' · ');
  $('#floorOut').textContent = w.floor;
  const fr = $('#floorRange');
  fr.min = w.lo;
  fr.max = w.hi;
  fr.value = w.floor;
  fr.disabled = w.lo === w.hi;
  fillRange(fr);
  const az = ((Math.atan2(w.nx, w.ny) * 180) / Math.PI + 360) % 360;
  $('#facing').innerHTML = `Окно смотрит на <b>${DIRS[Math.round(az / 45) % 8]}</b> · ${Math.round(az)}°`;
  const cur = sectorOf(w.nx, w.ny);
  const sides = sidesOf(w.i);
  $('#sides').innerHTML = sides.map((x) => `<button type="button" role="radio" data-sector="${x.sector}" aria-checked="${x.sector === cur}" class="${x.sector === cur ? 'active' : ''}" title="Окно на ${DIRS[x.sector]}">${DIRS_SHORT[x.sector]}</button>`).join('');
  $('#sides').hidden = sides.length < 2;
  $$('#outdoorSeg button').forEach((x) => {
    const on = x.dataset.outdoor === w.outdoor;
    x.classList.toggle('active', on);
    x.setAttribute('aria-checked', String(on));
  });
  $('#depthRow').hidden = w.outdoor === 'none';
  $('#depthOut').textContent = `${String(w.depth.toFixed(1)).replace('.', ',')} м`;
  const parts = stage.groups.get(b.group)?.length || 1;
  const tag = $('#levelsTag');
  $('#levelsOut').textContent = b.levels;
  if (parts > 1) {
    tag.textContent = `${parts} ${plural(parts, ['часть', 'части', 'частей'])}`;
    tag.className = 'tag';
  } else {
    tag.textContent = b.src === 'guess' ? 'угадана' : b.src === 'user' ? 'вручную' : 'по OSM';
    tag.className = `tag ${b.src === 'guess' ? 'is-guess' : b.src === 'user' ? 'is-user' : ''}`;
  }
  $$('#levelsSec .stepper button').forEach((x) => (x.disabled = parts > 1));
}

function renderDay() {
  const { d, m } = S.date;
  setText('#rDate', `${d} ${MONTHS_GEN[m]}`);
  if (!S.win || !S.day || S.day.sunOnly) return;
  const day = S.day;
  const h = Math.floor(day.lit / 60), mm = Math.round(day.lit % 60);
  $('#rLit').innerHTML = day.lit === 0 ? '0<small>мин</small>' : h ? `${h}<small>ч</small>${mm ? ` ${mm}<small>мин</small>` : ''}` : `${mm}<small>мин</small>`;
  let cap = 'прямого солнца в окне за день';
  if (day.lit === 0) {
    const blocked = day.state.some((s) => s === BLOCKED);
    cap = blocked ? 'прямого солнца нет: его закрывают дома' : 'прямого солнца нет: оно проходит с другой стороны дома';
  }
  $('#rCap').textContent = cap;
  $('#rIntervals').innerHTML = day.intervals.length
    ? day.intervals.map(([a, b]) => `<span>${fmtTime(a)}–${fmtTime(b)}</span>`).join('')
    : '<span class="none">весь день без прямого солнца</span>';
}

function renderNorm() {
  const n = S.norm;
  const card = $('#normCard');
  if (!n) return;
  card.classList.toggle('fail', !n.pass);
  card.classList.toggle('edge', n.edge);
  $('#normBadge').textContent = n.edge ? 'На грани нормы' : n.pass ? 'Норма выполняется' : 'Норма не выполняется';
  const zone = { north: 'северная', center: 'центральная', south: 'южная' }[n.zone];
  const date = n.zone === 'south' ? '22 февраля' : '22 апреля';
  let t = `Расчётный день — ${date}, ${zone} зона: нужно <b>${fmtDur(n.need)}</b> подряд. У окна — <b>${fmtDur(n.longest)}</b> непрерывно`;
  t += n.parts.length > 1 ? `, всего <b>${fmtDur(n.total)}</b>.` : '.';
  if (n.mode === 'broken') t += ' Засчитано как прерывистая инсоляция.';
  t += n.cut === 90
    ? ' Полтора часа после восхода и перед закатом не учитываются (ГОСТ Р 57795-2017).'
    : ' Первый час после восхода и последний перед закатом не учитываются (ГОСТ Р 57795-2017).';
  if (n.edge) {
    t += ` <b>Запас маленький:</b> по инсоляционному графику восход округляют до часа, учитываемый день выходит на ${n.chartShift} мин короче с каждой стороны — и нормы уже не хватает. Проектировщики считают обоими способами.`;
  }
  if (S.win?.outdoor && S.win.outdoor !== 'none') t += ' Учтена лоджия или балкон: они закрывают часть солнца.';
  $('#normText').innerHTML = t;
}

function renderYear() {
  if (!S.yr) return;
  setText('#yearHours', `${Math.round(S.yr.litHours).toLocaleString('ru-RU')} ч в год`);
}

function renderBlockers() {
  const ol = $('#blockers');
  const top = (S.yr?.top || []).filter((t) => t.share >= 0.01).slice(0, 4);
  if (!top.length) {
    ol.innerHTML = '<li class="b-empty">Соседние дома почти не закрывают это окно. Солнце теряется только за стеной самого дома.</li>';
    return;
  }
  const max = top[0].share;
  ol.innerHTML = top.map((t) => {
    const b = S.model.buildings[t.i];
    const dist = Math.round(Math.hypot(b.cx - S.win.x, b.cy - S.win.y));
    const lv = groupLevels(b.group);
    return `<li data-group="${t.group}" data-i="${t.i}">
      <span class="b-name">${esc(shortName(b))}</span>
      <span class="b-meta">${lv} ${plural(lv, ['этаж', 'этажа', 'этажей'])}${groupGuessed(t.group) ? ' (угадано)' : ''} · ${dist} м от окна</span>
      <span class="b-share">${Math.round(t.share * 100)}%</span>
      <span class="b-bar"><i style="--v:${(t.share / max).toFixed(3)}"></i></span>
    </li>`;
  }).join('');
}

// Матрица дома «этажи × стороны»: пересчитывается только при смене дома, лоджии или года
function updateMatrix() {
  if (!S.win) return;
  const key = `${S.win.i}|${S.win.outdoor}|${S.win.depth}|${S.date.y}`;
  if (S.matrixKey === key) return renderMatrix();
  S.matrixKey = key;
  const sides = sidesOf(S.win.i).map(({ sector, x, y, nx, ny }) => ({ sector, x, y, nx, ny }));
  S.matrix = { sides, floors: matrixFloors(S.win.lo, S.win.hi), cells: [] };
  renderMatrix();
  const job = ++S.matrixJob;
  const apply = (cells) => {
    if (!cells || job !== S.matrixJob) return;
    S.matrix.cells = cells;
    renderMatrix();
  };
  calc.matrix(S.win, sides, S.matrix.floors, S.date.y, S.tz, apply).then(apply).catch((e) => console.error(e));
}

// Сверху вниз; у высоток — не больше 30 строк
function matrixFloors(lo, hi) {
  const k = Math.ceil((hi - lo + 1) / 30);
  const out = [];
  for (let f = hi; f >= lo; f -= k) out.push(f);
  if (out[out.length - 1] !== lo) out.push(lo);
  return out;
}

function renderMatrix() {
  const m = S.matrix;
  if (!m || !S.win) return;
  const cur = sectorOf(S.win.nx, S.win.ny);
  const max = Math.max(1, ...m.cells.map((c) => c.hours));
  const cells = new Map(m.cells.map((c) => [`${c.sector}|${c.floor}`, c]));
  let html = `<table><thead><tr><th scope="col"><span class="sr">Этаж</span></th>${m.sides.map((s) => `<th scope="col" title="Окна на ${DIRS[s.sector]}">${DIRS_SHORT[s.sector]}</th>`).join('')}</tr></thead><tbody>`;
  for (const f of m.floors) {
    html += `<tr><th scope="row">${f}</th>`;
    for (const s of m.sides) {
      const c = cells.get(`${s.sector}|${f}`);
      const norm = c ? (c.edge ? 'edge' : c.pass ? 'pass' : '') : 'wait';
      const cls = [s.sector === cur && f === S.win.floor ? 'cur' : '', norm].filter(Boolean).join(' ');
      const said = { edge: ', норма на грани', pass: ', норма выполняется' }[norm] || '';
      const label = c ? `${f} этаж, окна на ${DIRS[s.sector]}: ${Math.round(c.hours)} ч солнца в год${said}` : `${f} этаж, окна на ${DIRS[s.sector]}: считаем`;
      html += `<td class="${cls}"${c ? ` style="--v:${(c.hours / max).toFixed(3)}"` : ''}><button type="button" data-sector="${s.sector}" data-floor="${f}" aria-label="${label}">${c ? Math.round(c.hours) : '·'}</button></td>`;
    }
    html += '</tr>';
  }
  $('#matrix').innerHTML = `${html}</tbody></table>`;
  const total = m.sides.length * m.floors.length;
  setText('#matrixState', m.cells.length < total ? `считаем… ${Math.round((m.cells.length / total) * 100)}%` : 'часов солнца в год');
}

function groupLevels(g) {
  const list = stage.groups.get(g) || [];
  return Math.max(...list.map((i) => floorsOf(S.model.buildings[i]).hi));
}

function shortName(b) {
  if (!b) return 'дом';
  return b.name || b.addr || capital(TYPE_NAMES[b.type] || 'здание');
}

// ---------- Сравнение вариантов ----------
// Список живёт в браузере пользователя: это его личная подборка, на сервер ничего не уходит
const CMP_KEY = 'svet-compare';
const NORM_SHORT = { pass: 'выполняется', edge: 'на грани', fail: 'не выполняется' };

function loadCompare() {
  try {
    const list = JSON.parse(localStorage.getItem(CMP_KEY));
    return Array.isArray(list) ? list.slice(0, 5) : [];
  } catch (e) {
    return [];
  }
}

function saveCompare(list) {
  S.compare = list;
  try {
    localStorage.setItem(CMP_KEY, JSON.stringify(list));
  } catch (e) { /* без хранилища список живёт до перезагрузки */ }
  renderCompareBtn();
  if ($('#compare').open) renderCompare();
}

function compareEntry() {
  const w = S.win, b = S.model.buildings[w.i];
  const hours = Math.round(S.yr.litHours);
  const f = flatOfWindow();
  return {
    key: `${S.model.lat.toFixed(5)},${S.model.lon.toFixed(5)}|${w.x.toFixed(1)},${w.y.toFixed(1)}|${w.floor}`,
    title: reportTitle(b),
    place: S.place?.title || '',
    floor: w.floor,
    dir: DIRS_SHORT[sectorOf(w.nx, w.ny)],
    hours,
    ratio: S.maxHours ? Math.round((hours / S.maxHours) * 100) : null,
    lost: Math.round(S.yr.lost * 100),
    norm: S.norm.edge ? 'edge' : S.norm.pass ? 'pass' : 'fail',
    flat: f ? { state: f.state, pass: f.pass, marked: f.marked, size: f.size } : null,
    acc: accuracyLevel(),
    hash: location.hash,
  };
}

async function compareAdd() {
  if (!S.win) return;
  if (!(await reportReady(false))) return toast('Расчёт ещё не готов, попробуйте через пару секунд');
  updateHash();
  const e = compareEntry();
  const had = S.compare.some((x) => x.key === e.key);
  const list = S.compare.filter((x) => x.key !== e.key);
  if (list.length >= 5) return toast('В сравнении уже пять вариантов — уберите лишний');
  saveCompare([...list, e]);
  goal('compare_add', { count: S.compare.length });
  toast(had ? 'Вариант в сравнении обновлён' : S.compare.length > 1 ? `В сравнении ${S.compare.length} варианта — нажмите «Сравнить»` : 'Добавлено. Выберите другое окно или квартиру и добавьте тоже');
}

function flatShort(f) {
  if (!f) return '—';
  if (f.state === 'open') return `отмечено ${f.marked} из ${f.size} комн.`;
  return `${{ pass: 'проходит', edge: 'на грани', fail: 'не проходит' }[f.state]} (${f.pass} из ${f.marked})`;
}

// Строка сравнения — для таблицы на сайте и для PDF
function compareRow(e) {
  return {
    title: e.title,
    sub: [`${e.floor} этаж`, e.dir, e.place].filter(Boolean).join(' · '),
    hours: `${fmtH(e.hours)} ч`,
    ratio: e.ratio != null ? `${e.ratio}% от лучшего` : '',
    norm: NORM_SHORT[e.norm],
    flat: flatShort(e.flat),
    lost: `${e.lost}%`,
    best: S.compare.length > 1 && e.hours === Math.max(...S.compare.map((x) => x.hours)),
  };
}

function renderCompareBtn() {
  $('#cmpCount').textContent = S.compare.length;
  $('#cmpOpen').hidden = !S.compare.length;
}

function renderCompare() {
  const rows = S.compare.map(compareRow);
  $('#cmpTable').innerHTML = rows.length ? `<table>
    <thead><tr><th>Вариант</th><th>Солнце в год</th><th>Норма окна</th><th>Квартира</th><th>Соседи забирают</th><th><span class="sr">Действия</span></th></tr></thead>
    <tbody>${rows.map((r, k) => `<tr class="${r.best ? 'best' : ''}">
      <td><b>${esc(r.title)}</b><small>${esc(r.sub)}</small></td>
      <td class="num">${r.hours}<small>${r.ratio}</small></td>
      <td><span class="cmp-norm is-${S.compare[k].norm}">${r.norm}</span></td>
      <td>${r.flat}</td>
      <td class="num">${r.lost}</td>
      <td class="cmp-act"><button type="button" data-open="${k}">Открыть</button><button type="button" data-del="${k}" aria-label="Убрать из сравнения">×</button></td>
    </tr>`).join('')}</tbody></table>` : '<p class="cmp-empty">Пока пусто. Выберите окно и нажмите «В сравнение».</p>';
}

function openCompare() {
  renderCompare();
  $('#compare').showModal();
  goal('compare_open', { count: S.compare.length });
}

// ---------- Опрос о цене и подпись риелтора ----------
const SURVEY_KEY = 'svet-survey';
const SIGN_KEY = 'svet-sign';

function maybeSurvey() {
  let done = false;
  try {
    done = !!localStorage.getItem(SURVEY_KEY);
  } catch (e) { /* без хранилища спросим ещё раз — не страшно */ }
  if (!done) $('#survey').hidden = false;
}

function answerSurvey(price) {
  goal('price_survey', { price });
  try {
    localStorage.setItem(SURVEY_KEY, price);
  } catch (e) { /* ответ уже ушёл в Метрику */ }
  $('#surveyBtns').hidden = true;
  $('.survey-q').hidden = true;
  $('#surveyThanks').hidden = false;
}

function readSign() {
  try {
    return (localStorage.getItem(SIGN_KEY) || '').trim();
  } catch (e) {
    return ($('#signInput').value || '').trim();
  }
}

// ---------- Отчёт: картинка и PDF ----------
async function makeReport(kind) {
  if (!S.win || S.reporting) return;
  S.reporting = true;
  const btn = $(kind === 'pdf' ? '#reportPdf' : '#reportImg');
  btn.disabled = true;
  try {
    if (!(await reportReady())) return toast('Расчёт ещё не готов, попробуйте через пару секунд');
    const d = reportData();
    if (kind === 'pdf') {
      goal('report_pdf', { floor: S.win.floor, verdict: d.level });
      await printReport(d);
    } else {
      const res = await shareCard(await makeCard(d), `${d.fileName}.png`, d.shareText);
      goal('report_image', { floor: S.win.floor, verdict: d.level, result: res });
      if (res === 'downloaded') toast('Картинка сохранена в загрузки');
    }
    maybeSurvey();
  } catch (e) {
    console.error(e);
    toast('Не получилось собрать отчёт');
  } finally {
    S.reporting = false;
    btn.disabled = false;
  }
}

// Ждём годовой расчёт, точность, «до стройки», комнаты и матрицу дома, но не дольше 20 секунд
async function reportReady(withMatrix = true) {
  const busy = () => !S.yr || $('#verdict').classList.contains('is-busy');
  const extras = () => (!S.acc?.guessed.length || S.acc.lo != null)
    && (!S.model.buildings.some((b) => b.added) || S.build)
    && S.flat.res.every(Boolean);
  const matrix = () => !withMatrix || (S.matrix && S.matrix.cells.length >= S.matrix.sides.length * S.matrix.floors.length);
  const t0 = performance.now();
  while (!(!busy() && extras() && matrix()) && performance.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 150));
  return !busy();
}

function reportTitle(b) {
  return b.name && b.addr ? `${b.name}, ${b.addr}` : b.name || b.addr || S.place?.title || 'Окно';
}

function reportData() {
  const w = S.win, b = S.model.buildings[w.i], n = S.norm, y = S.date.y;
  const az = ((Math.atan2(w.nx, w.ny) * 180) / Math.PI + 360) % 360;
  const dir = DIRS[Math.round(az / 45) % 8];
  const lv = groupLevels(b.group);
  const depth = `${String(w.depth.toFixed(1)).replace('.', ',')} м`;
  const outdoor = { loggia: `лоджия ${depth}`, balcony: `балкон сверху ${depth}` }[w.outdoor];
  const title = reportTitle(b);
  const hours = Math.round(S.yr.litHours);
  const hoursText = hours.toLocaleString('ru-RU');
  const ratio = S.maxHours ? hours / S.maxHours : null;
  const lost = Math.round(S.yr.lost * 100);
  const level = $('#verdict').dataset.level || 'mid';
  const note = [ratio != null && `${Math.round(ratio * 100)}% от лучшего окна на этой широте`, lost >= 5 ? `соседи забирают ${lost}%` : 'соседи почти не мешают'];
  const added = S.model.buildings.filter((x) => x.added).length;
  const blockers = (S.yr.top || []).filter((t) => t.share >= 0.01).slice(0, 5).map((t) => {
    const nb = S.model.buildings[t.i];
    const nl = groupLevels(nb.group);
    return {
      name: shortName(nb),
      meta: `${nl} ${plural(nl, ['этаж', 'этажа', 'этажей'])}${groupGuessed(t.group) ? ' (угадано)' : ''} · ${Math.round(Math.hypot(nb.cx - w.x, nb.cy - w.y))} м от окна`,
      share: Math.round(t.share * 100),
    };
  });
  const method = [
    `Положение солнца рассчитано для координат ${S.model.lat.toFixed(5)}, ${S.model.lon.toFixed(5)} на каждые 10 минут каждого дня ${y} года (${formatOffset(S.tz)}).`,
    `Дома вокруг — из OpenStreetMap: контуры, высоты и этажность. Где этажность не указана, она оценена по типу здания.${added ? ` Вручную добавлено домов: ${added}.` : ''}`,
    `Расчётная точка — центр окна на ${w.floor} этаже, ${Math.round(w.z)} м над землёй. Солнце, которое скользит вдоль стены под углом меньше 10°, не учитывается.`,
    outdoor && `Учтена ${outdoor}: боковые стены и плита сверху закрывают часть неба.`,
    'Норма — по СанПиН 1.2.3685-21 и ГОСТ Р 57795-2017: непрерывная или прерывистая инсоляция в расчётный день. Учитываемый день отсчитан от точного восхода; «на грани» — если по инсоляционному графику, где восход округлён до часа солнечного времени, нормы не хватает.',
    'Деревья, рельеф и отражённый свет не учитываются. Это ориентир, а не официальное заключение: проектировщик считает по поэтажным планам с точными размерами окон и откосов.',
  ].filter(Boolean);
  const normLine = n.mode === 'broken'
    ? `у окна ${fmtDur(n.total)} с перерывами, нужно ${fmtDur(n.need + 30)}`
    : `у окна ${fmtDur(n.longest)} подряд, нужно ${fmtDur(n.need)}`;
  const heat = document.createElement('canvas');
  drawHeat(heat, S.yr, null, [1200, 200]);
  const fs = flatOfWindow();
  const flat = fs ? {
    ...flatText(fs), state: fs.state,
    rooms: S.flat.rooms.map((r, k) => ({
      name: `Комната ${k + 1}`, dir: DIRS[sectorOf(r.nx, r.ny)], floor: r.floor,
      hours: fmtH(S.flat.res[k].hours), norm: normWord(S.flat.res[k].norm),
    })),
  } : null;
  const level2 = accuracyLevel();
  updateHash();
  return {
    title,
    kicker: [`${w.floor} этаж из ${lv}`, `окна на ${dir}`, outdoor, S.place?.title].filter(Boolean).join(' · '),
    hoursText, level, year: y,
    levelLabel: $('#vBadge').textContent,
    levelNote: capital(`${note.filter(Boolean).join(', ')}.`),
    verdictText: $('#vText').textContent,
    norm: { pass: n.pass, edge: n.edge, line: normLine, text: $('#normText').textContent },
    blockers, method, heat, flat,
    build: buildText(),
    accuracy: level2 && {
      label: { high: 'высокая', mid: 'средняя', low: 'низкая' }[level2],
      text: $('#accText').textContent,
    },
    compare: S.compare.length >= 2 ? S.compare.map(compareRow) : null,
    sign: readSign(),
    matrix: matrixReport(),
    shot: stage.snapshot(1080 / 600, { x: w.x, y: w.y, z: w.z }),
    url: location.href,
    today: new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }),
    fileName: `Солнце — ${title}, ${w.floor} этаж`.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 120),
    shareText: `${title}, ${w.floor} этаж: ${hoursText} ч прямого солнца в год. ${location.href}`,
  };
}

function matrixReport() {
  const m = S.matrix;
  if (!m?.cells.length) return null;
  const cur = sectorOf(S.win.nx, S.win.ny);
  const cells = new Map(m.cells.map((c) => [`${c.sector}|${c.floor}`, c]));
  return {
    cols: m.sides.map((s) => DIRS_SHORT[s.sector]),
    rows: m.floors.map((f) => ({
      floor: f,
      cells: m.sides.map((s) => {
        const c = cells.get(`${s.sector}|${f}`);
        return { hours: c ? Math.round(c.hours) : null, pass: !!c?.pass, edge: !!c?.edge, cur: s.sector === cur && f === S.win.floor };
      }),
    })),
    partial: m.cells.length < m.sides.length * m.floors.length,
  };
}

// ---------- Холсты ----------
// size — явный размер в пикселях для холста вне страницы (отчёт)
function drawHeat(cv, yr, markDoy, size) {
  if (!cv || !yr) return;
  const dpr = size ? 1 : Math.min(devicePixelRatio || 1, 2);
  const [W, H] = size || [cv.clientWidth, cv.clientHeight];
  if (!W || !H) return;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d');
  const off = document.createElement('canvas');
  off.width = yr.days;
  off.height = yr.slots;
  const og = off.getContext('2d');
  const img = og.createImageData(yr.days, yr.slots);
  const rgb = STATE_COLORS.map((c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]);
  for (let di = 0; di < yr.days; di++) {
    for (let k = 0; k < yr.slots; k++) {
      const c = rgb[yr.grid[di * yr.slots + k]];
      const o = (k * yr.days + di) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(off, 0, 0, cv.width, cv.height);
  // полдень и месяцы
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.lineWidth = 1;
  for (let mth = 1; mth < 12; mth++) {
    const x = Math.round((dayOfYear(2025, mth, 1) / 365) * cv.width) + 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, cv.height); g.stroke();
  }
  if (markDoy != null) {
    const x = ((markDoy + 0.5) / 365) * cv.width;
    g.strokeStyle = 'rgba(29,23,18,0.85)';
    g.lineWidth = 1.5 * dpr;
    g.setLineDash([3 * dpr, 3 * dpr]);
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, cv.height); g.stroke();
    g.setLineDash([]);
  }
}

function drawTrack(cv, day) {
  if (!cv || !day) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d');
  const n = day.state.length;
  const colors = day.sunOnly ? ['#2b2b3d', '#f3dcb6'] : STATE_COLORS;
  let start = 0;
  for (let k = 1; k <= n; k++) {
    if (k === n || day.state[k] !== day.state[start]) {
      g.fillStyle = colors[day.state[start]];
      const x0 = Math.floor((start / n) * cv.width), x1 = Math.ceil((k / n) * cv.width);
      g.fillRect(x0, 0, x1 - x0, cv.height);
      start = k;
    }
  }
  // штриховка тени
  if (!day.sunOnly) {
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = dpr;
    for (let k = 0; k < n; k++) {
      if (day.state[k] !== BLOCKED) continue;
      const x0 = (k / n) * cv.width, x1 = ((k + 1) / n) * cv.width;
      g.beginPath();
      g.rect(x0, 0, x1 - x0, cv.height);
      g.save();
      g.clip();
      for (let x = x0 - cv.height; x < x1; x += 5 * dpr) { g.beginPath(); g.moveTo(x, cv.height); g.lineTo(x + cv.height, 0); g.stroke(); }
      g.restore();
    }
    g.restore();
  }
  g.fillStyle = 'rgba(255,255,255,0.4)';
  for (let h = 3; h < 24; h += 3) g.fillRect(Math.round((h / 24) * cv.width), 0, dpr, cv.height * 0.22);
}

// ---------- Указатель ----------
function onHover(hit, e) {
  const tip = $('#tip');
  if (S.drawing) {
    stage.setTint('hover', null);
    tip.classList.remove('show');
    return;
  }
  if (!hit || !S.model) {
    stage.setTint('hover', null);
    tip.classList.remove('show');
    $('#gl').style.cursor = '';
    return;
  }
  const b = S.model.buildings[hit.i];
  stage.setTint('hover', b.group);
  $('#gl').style.cursor = 'pointer';
  const lv = groupLevels(b.group);
  const src = b.src === 'guess' ? 'этажность не указана в OSM' : b.src === 'user' ? 'этажность задана вручную' : `${Math.round(b.h)} м`;
  const action = hit.wall ? 'Клик — поставить окно здесь' : 'Клик по крыше — поправить этажность';
  tip.innerHTML = `<b>${esc(shortName(b))}</b><small>${lv} ${plural(lv, ['этаж', 'этажа', 'этажей'])} · ${src}</small><em>${action}</em>`;
  tip.style.transform = `translate(${Math.min(e.clientX + 16, innerWidth - 290)}px, ${e.clientY + 18}px)`;
  tip.classList.add('show');
}

function onPick(hit, e) {
  if (S.drawing) return drawClick(e);
  hideFocus();
  if (!hit) return;
  if (hit.wall) {
    const b = S.model.buildings[hit.i];
    const [lo, hi, fh] = floorRange(b);
    const floor = clamp(Math.floor(hit.z / fh) + 1, lo, hi);
    setWindow({ i: hit.i, x: hit.x, y: hit.y, nx: hit.nx, ny: hit.ny, floor }, { source: 'wall' });
  } else {
    showFocus(hit.i, e.clientX, e.clientY);
  }
}

function showFocus(i, x, y) {
  S.focus = i;
  const card = $('#focusCard');
  card.hidden = false;
  card.style.left = `${clamp(x + 18, 12, innerWidth - 290)}px`;
  card.style.top = `${clamp(y - 60, 80, innerHeight - 280)}px`;
  renderFocus(i);
  stage.setTint('focus', S.model.buildings[i].group);
}

function renderFocus(i) {
  const b = S.model.buildings[i];
  const parts = stage.groups.get(b.group)?.length || 1;
  $('#focusKind').textContent = b.added ? 'Добавлен вами' : capital(TYPE_NAMES[b.type] || 'здание');
  $('#focusDelete').hidden = !b.added;
  $('#focusTitle').textContent = b.name || b.addr || 'Без адреса';
  $('#focusOut').textContent = parts > 1 ? groupLevels(b.group) : b.levels;
  $$('#focusCard .stepper button').forEach((x) => (x.disabled = parts > 1));
  $('#focusNote').textContent = b.added
    ? 'Нарисован вручную — укажите этажность. Расчёт учитывает его сразу.'
    : parts > 1
    ? `Сложное здание из ${parts} частей — высоты частей взяты из OSM.`
    : b.src === 'guess'
      ? 'Этажность не указана в OSM — мы подставили типовую. Поправьте, если знаете точно.'
      : b.src === 'user' ? 'Этажность задана вами. Расчёт уже обновлён.' : `Высота ${Math.round(b.h)} м по данным OSM.`;
}

// ---------- Достроить дом ----------
function startDraw() {
  if (!S.model) return;
  S.drawing = { pts: [] };
  hideFocus();
  body.classList.add('is-drawing');
  $('#drawBar').hidden = false;
  $('#edgeNote').hidden = true;
  stage.setDraft([]);
  renderDrawBar();
  goal('draw_start');
}

function renderDrawBar() {
  const n = S.drawing?.pts.length || 0;
  $('#drawText').textContent = n < 3
    ? `Кликайте по земле, чтобы обвести контур дома${n ? ` · точек: ${n}` : ''}`
    : `Точек: ${n}. Замкните контур кликом по первой точке или нажмите «Готово»`;
  $('#drawDone').disabled = n < 3;
  $('#drawUndo').disabled = !n;
}

function drawClick(e) {
  const pts = S.drawing.pts;
  // клик рядом с первой точкой замыкает контур
  if (pts.length >= 3) {
    const [sx, sy] = stage.toScreen(pts[0].x, pts[0].y);
    if (Math.hypot(sx - e.clientX, sy - e.clientY) < 16) return finishDraw();
  }
  const g = stage.pickGround(e.clientX, e.clientY);
  if (!g || Math.hypot(g.x, g.y) > S.model.R2 - 5) return toast('Кликните по земле внутри макета');
  pts.push({ x: Math.round(g.x * 2) / 2, y: Math.round(g.y * 2) / 2 });
  stage.setDraft(pts);
  renderDrawBar();
}

function stopDraw() {
  S.drawing = null;
  body.classList.remove('is-drawing');
  $('#drawBar').hidden = true;
  stage.setDraft(null);
  checkEdge();
}

function finishDraw() {
  const pts = S.drawing?.pts || [];
  if (pts.length < 3) return;
  stopDraw();
  const i = addBuildings([{ pts, levels: 9 }]);
  goal('draw_done', { points: pts.length });
  showFocus(i, innerWidth / 2 - 140, 120);
}

let addSeq = 0;
// Добавить нарисованные дома в модель; возвращает индекс последнего
function addBuildings(list) {
  for (const { pts, levels } of list) {
    const outer = pts.flatMap((p) => [p.x, p.y]);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const id = -(1e12 + ++addSeq);
    S.model.buildings.push({
      id, group: id, polys: [{ outer, holes: [] }], bbox, cx: (bbox[0] + bbox[2]) / 2, cy: (bbox[1] + bbox[3]) / 2,
      type: 'construction', h: levels * LEVEL_H, minH: 0, levels, src: 'user', name: 'Добавленный дом', addr: '', added: true,
    });
  }
  rebuildWorld();
  return S.model.buildings.length - 1;
}

function removeBuilding(i) {
  if (!S.model.buildings[i]?.added) return;
  S.model.buildings.splice(i, 1);
  hideFocus();
  if (S.win?.i === i) clearWindow();
  else if (S.win && S.win.i > i) S.win.i--;
  S.flat.rooms = S.flat.rooms.filter((r) => r.i !== i).map((r) => (r.i > i ? { ...r, i: r.i - 1 } : r));
  rebuildWorld();
  goal('draw_remove');
}

// После изменения состава домов: заново анализ, воркер, 3D и расчёт окна
function rebuildWorld() {
  S.an = new Analyzer(S.model);
  calc.setModel(S.model);
  S.matrixKey = null;
  stage.rebuildBuildings();
  if (S.win) setWindow({ ...S.win });
  else updateHash();
}

// Добавленные дома в ссылке: «этажи;x:y,x:y,…|…»
function addedToHash() {
  return S.model.buildings.filter((b) => b.added).map((b) => {
    const r = b.polys[0].outer;
    const pts = [];
    for (let k = 0; k < r.length; k += 2) pts.push(`${r[k]}:${r[k + 1]}`);
    return `${b.levels};${pts.join(',')}`;
  }).join('|');
}

function addedFromHash(str) {
  if (!str) return [];
  return str.split('|').map((part) => {
    const [lv, coords] = part.split(';');
    const pts = (coords || '').split(',').map((c) => c.split(':').map(Number)).filter((c) => c.length === 2 && c.every(isFinite)).map(([x, y]) => ({ x, y }));
    return { levels: clamp(Math.round(+lv) || 9, 1, 160), pts };
  }).filter((b) => b.pts.length >= 3);
}

function hideFocus() {
  $('#focusCard').hidden = true;
  S.focus = null;
  stage.setTint('focus', null);
}

// ---------- Камера ----------
function viewFor(w, dist, polar = 1.02, turn = 0.42) {
  const target = w ? stage.modelToWorld(w.x, w.y, Math.min(w.z * 0.6, 40)) : stage.modelToWorld(0, 0, 0);
  const azim = w ? Math.atan2(w.nx, -w.ny) + turn : 0.55;
  return { target, dist, polar, azim };
}

// Камера сбоку от фасада: дома, которые закрывают солнце, стоят перед окном, поэтому смотрим не «в лоб»
function flyToWindow(k = 1, dur = 1800) {
  const mobile = innerWidth < 960;
  const dist = (mobile ? 900 : 720) * k;
  return stage.flyTo(viewFor(S.win, dist, mobile ? 0.8 : 0.86, 1.05), dur);
}

function landingView() {
  const R = S.model?.R2 || 470;
  const az = S.win ? Math.atan2(S.win.nx, -S.win.ny) + 1.1 : 1.2;
  return {
    target: stage.modelToWorld(0, 30, 30),
    dist: R * (innerWidth < 768 ? 5.6 : 4.3),
    polar: 0.9,
    azim: az,
  };
}

function landingShift() {
  return innerWidth >= 1100 ? [innerWidth * 0.19, 0] : innerWidth < 768 ? [0, innerHeight * 0.2] : [0, 0];
}

// В приложении на телефоне низ экрана занят шторкой — поднимаем макет в видимую часть
function appShift() {
  return innerWidth < 960 ? [0, -innerHeight * 0.25] : [0, 0];
}

// ---------- Режимы ----------
function enterApp() {
  if (S.mode === 'app') return;
  S.mode = 'app';
  hideMenu();
  window.scrollTo({ top: 0, behavior: 'instant' });
  body.classList.add('is-app');
  body.classList.remove('is-landing');
  $('#app').setAttribute('aria-hidden', 'false');
  stage.running = true;
  stage.setMode('app');
  stage.setViewShift(...appShift());
  setTimeout(() => S.mode === 'app' && body.classList.add('app-ready'), 900);
  S.minute = clamp(S.minute, 0, 1439);
  updateArcs();
  checkEdge();
  updateHash();
  setTimeout(() => {
    drawTrack($('#dayCanvas'), S.day);
    if (S.yr) drawHeat($('#heat'), S.yr, dayOfYear(S.date.y, S.date.m, S.date.d));
    updateTime();
  }, 60);
}

function exitApp() {
  if (S.mode !== 'app') return;
  if (S.drawing) stopDraw();
  S.mode = 'landing';
  setPlaying(false);
  hideFocus();
  $('#tip').classList.remove('show');
  body.classList.remove('is-app', 'app-ready');
  body.classList.add('is-landing');
  $('#app').setAttribute('aria-hidden', 'true');
  stage.setMode('landing');
  stage.setViewShift(...landingShift());
  history.replaceState(null, '', location.pathname + location.search);
  S.date = { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
  if (!S.place?.demo) loadDemo(true);
  else {
    if (S.demoWin) setWindow({ ...S.demoWin });
    updateArcs();
    stage.flyTo(landingView(), 1800);
  }
}

async function openDemoApp() {
  enterApp();
  if (!S.place?.demo) await loadDemo(false);
  else flyToWindow();
  S.minute = sunnyMinute();
  updateTime();
}

async function loadDemo(toLanding) {
  ++S.load;
  const model = await fetch('data/demo.json').then((r) => r.json());
  await applyModel(PLACES.demo, model);
  const w = demoWindow();
  if (w) {
    S.demoWin = w;
    setWindow(w);
  }
  if (toLanding) stage.flyTo(landingView(), 2200);
  else flyToWindow(1, 2200);
  return model;
}

function demoWindow() {
  const i = S.model.buildings.findIndex((b) => b.addr === DEMO_WIN.addr);
  if (i < 0) return autoWindow();
  const f = facadeOf(i, DEMO_WIN.face);
  return { i, x: f.x, y: f.y, nx: f.nx, ny: f.ny, floor: DEMO_WIN.floor };
}

// ---------- Поиск ----------
function initSearch(form) {
  const input = form.querySelector('input');
  const list = form.querySelector('.suggest');
  let items = [], active = -1, ctrl, timer, lastQ = '';
  const open = () => list.classList.add('open');
  const close = () => { list.classList.remove('open'); active = -1; };
  const render = () => {
    if (!items.length) {
      list.innerHTML = '<li class="s-note">Ничего не нашлось. Попробуйте «город, улица, дом».</li>';
      open();
      return;
    }
    list.innerHTML = items.map((it, k) => `<li role="option" data-k="${k}" class="${k === active ? 'active' : ''}"><span class="s-title">${esc(it.title)}</span><span class="s-sub">${esc(it.subtitle)}</span></li>`).join('');
    open();
  };
  const run = async (q) => {
    ctrl?.abort();
    ctrl = new AbortController();
    lastQ = q;
    try {
      items = await suggest(q, { signal: ctrl.signal, near: S.model ? { lat: S.model.lat, lon: S.model.lon } : null });
      active = items.length ? 0 : -1;
      render();
      return items;
    } catch (e) {
      if (e.name === 'AbortError') return null;
      list.innerHTML = '<li class="s-note">Поиск адресов сейчас недоступен. Попробуйте чуть позже.</li>';
      open();
      return null;
    }
  };
  const choose = (it) => {
    goal('search', { house: it.isHouse });
    input.value = it.title;
    input.blur();
    close();
    enterApp();
    loadPlace({ title: [it.title, it.subtitle.split(' · ')[0]].filter(Boolean).join(', '), lat: it.lat, lon: it.lon, region: it.region, country: it.country });
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { close(); items = []; return; }
    timer = setTimeout(() => run(q), 260);
  });
  input.addEventListener('keydown', (e) => {
    if (!list.classList.contains('open') || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
    } else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 160));
  input.addEventListener('focus', () => items.length && input.value.trim() === lastQ && render());
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li[data-k]');
    if (!li) return;
    e.preventDefault();
    choose(items[+li.dataset.k]);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q.length < 3) {
      if (S.mode !== 'app') openDemoApp();
      else input.focus();
      return;
    }
    let list2 = items;
    if (q !== lastQ || !items.length) list2 = await run(q);
    if (list2?.length) choose(list2[Math.max(0, active)]);
  });
}

// ---------- Ссылка на окно ----------
function updateHash() {
  if (S.mode !== 'app' || !S.model) return;
  const p = new URLSearchParams();
  p.set('p', `${S.model.lat.toFixed(5)},${S.model.lon.toFixed(5)}`);
  if (S.win) {
    const o = Math.max(0, OUTDOOR_CODES.indexOf(S.win.outdoor));
    p.set('w', [S.win.x, S.win.y, S.win.nx, S.win.ny].map((v) => v.toFixed(2)).join(',') + `,${S.win.floor},${o},${S.win.depth}`);
  }
  p.set('n', S.place?.title || '');
  const added = addedToHash();
  if (added) p.set('a', added);
  const flat = flatToHash();
  if (flat) p.set('f', flat);
  history.replaceState(null, '', `#${p}`);
}

async function openFromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.get('p')) return false;
  const [lat, lon] = p.get('p').split(',').map(Number);
  if (!isFinite(lat) || !isFinite(lon)) return false;
  const w = (p.get('w') || '').split(',').map(Number);
  const ok = (w.length === 5 || w.length === 7) && w.every(isFinite);
  const prefer = ok ? { exact: true, x: w[0], y: w[1], nx: w[2], ny: w[3], floor: w[4] } : null;
  if (ok && w.length === 7) {
    S.outdoor = OUTDOOR_CODES[w[5]] || 'none';
    S.depth = clamp(w[6], 0.6, 2.4);
  }
  enterApp();
  S.pendingFlat = flatFromHash(p.get('f'));
  const added = addedFromHash(p.get('a'));
  const isDemo = Math.abs(lat - PLACES.demo.lat) < 1e-4 && Math.abs(lon - PLACES.demo.lon) < 1e-4;
  if (isDemo) {
    if (added.length) addBuildings(added);
    if (prefer) {
      const win = autoWindow(prefer);
      if (win) setWindow(win, { source: 'link' });
    }
    applyPendingFlat();
    flyToWindow();
  } else {
    const ru = lat > 41 && lat < 82 && lon > 19;
    await loadPlace({ title: p.get('n') || 'Выбранное место', lat, lon, region: p.get('n') || '', country: ru ? 'ru' : '', added }, prefer);
  }
  return true;
}

// ---------- Лендинг ----------
function computeLandingStats() {
  const w = S.win;
  if (!w || !S.yr) return;
  const y = S.date.y;
  $('#stHours').textContent = Math.round(S.yr.litHours).toLocaleString('ru-RU');
  $('#stFloor').textContent = `${w.floor}-го`;
  const tall = S.yr.top.filter((t) => S.model.buildings[t.i].h > 150);
  const towers = tall.reduce((a, t) => a + t.share, 0);
  $('#stTowers').textContent = Math.round(towers * 100);
  const near = Math.min(...tall.map((t) => {
    const b = S.model.buildings[t.i];
    return Math.hypot(b.cx - w.x, b.cy - w.y);
  }));
  if (isFinite(near)) $('#stTowersNear').textContent = ` — ближайшая всего в ${Math.round(near / 10) * 10} метрах`;
  const dec = S.an.day(w, y, 11, 22, S.tz, 2);
  $('#stWinter').textContent = Math.round(dec.lit);
  S.landingYr = S.yr;
  drawHeat($('#landingHeat'), S.landingYr, dayOfYear(y, S.date.m, S.date.d));
  const bs = S.model.buildings;
  const tallest = Math.max(...bs.map((b) => b.h));
  const known = bs.filter((b) => b.src !== 'guess').length;
  $('#stepFact').textContent = `В демо-квартале на Пресне ${bs.length} ${plural(bs.length, ['здание', 'здания', 'зданий'])}, `
    + `самое высокое — ${Math.round(tallest)} м, у ${Math.round((known / bs.length) * 100)}% высота известна из OSM.`;
}

// Самое солнечное время дня — с него удобно начинать просмотр
function sunnyMinute() {
  const d = S.day;
  if (!d) return 12 * 60;
  if (d.intervals?.length) {
    const [a, b] = d.intervals.reduce((m, x) => (x[1] - x[0] > m[1] - m[0] ? x : m));
    return Math.round((a + b) / 2);
  }
  if (d.sunrise >= 0) return Math.round((d.sunrise + d.sunset) / 2);
  return 12 * 60;
}

function initReveal() {
  const heroIO = new IntersectionObserver(([e]) => {
    S.heroVisible = e.isIntersecting;
    if (S.mode === 'landing') stage.running = e.isIntersecting;
  }, { threshold: 0.02 });
  heroIO.observe($('.hero'));

  const heatIO = new IntersectionObserver(([e]) => {
    if (e.isIntersecting && S.landingYr) drawHeat($('#landingHeat'), S.landingYr);
  });
  heatIO.observe($('#landingHeat'));
}

function hideMenu() {
  body.classList.remove('menu-open');
  $('#burger').setAttribute('aria-expanded', 'false');
}

// ---------- Управление ----------
function setPlaying(on) {
  S.playing = on;
  $('#playBtn').classList.toggle('playing', on);
  $('#playBtn').setAttribute('aria-label', on ? 'Остановить время' : 'Запустить время');
}

function initControls() {
  $$('[data-search]').forEach(initSearch);
  $$('[data-open-app]').forEach((b) => b.addEventListener('click', () => {
    goal('open_app');
    openDemoApp();
  }));
  $$('[data-place]').forEach((b) => b.addEventListener('click', () => {
    goal('quick_place', { place: b.dataset.place });
    const p = PLACES[b.dataset.place];
    if (p.demo) openDemoApp();
    else { enterApp(); loadPlace(p); }
  }));
  $('#backBtn').addEventListener('click', exitApp);
  $('#burger').addEventListener('click', () => {
    const open = !body.classList.contains('menu-open');
    body.classList.toggle('menu-open', open);
    $('#burger').setAttribute('aria-expanded', String(open));
  });
  $$('#menu a').forEach((a) => a.addEventListener('click', hideMenu));

  $('#playBtn').addEventListener('click', () => setPlaying(!S.playing));

  // перетаскивание времени
  const track = $('#track');
  const setFromX = (x) => {
    const r = track.getBoundingClientRect();
    S.minute = clamp(((x - r.left) / r.width) * 1440, 0, 1439);
    updateTime();
  };
  track.addEventListener('pointerdown', (e) => {
    setPlaying(false);
    track.setPointerCapture(e.pointerId);
    setFromX(e.clientX);
    const move = (ev) => setFromX(ev.clientX);
    const up = () => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', up); };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
  });

  // дата
  const doy = $('#doyRange');
  doy.addEventListener('input', () => {
    S.date = dateFromDoy(S.date.y, +doy.value);
    fillRange(doy);
    updateDate();
  });
  $$('#dateChips button').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.date;
    if (v === 'today') S.date = { y: S.date.y, m: now.getMonth(), d: now.getDate() };
    else {
      const [m, d] = v.split('-').map(Number);
      S.date = { y: S.date.y, m, d };
    }
    updateDate();
  }));

  // этаж и этажность
  const fr = $('#floorRange');
  fr.addEventListener('input', () => setFloor(+fr.value));
  fr.addEventListener('change', () => goal('floor_change'));
  $$('[data-step]').forEach((b) => b.addEventListener('click', () => {
    const d = +b.dataset.d;
    if (b.dataset.step === 'floor' && S.win) setFloor(S.win.floor + d);
    if (b.dataset.step === 'levels' && S.win) setBuildingLevels(S.win.i, S.model.buildings[S.win.i].levels + d);
    if (b.dataset.step === 'focus' && S.focus != null) setBuildingLevels(S.focus, S.model.buildings[S.focus].levels + d);
    if (b.dataset.step === 'depth') setOutdoor(S.outdoor, S.depth + d * 0.1);
    if (b.dataset.step === 'rooms') setRooms(S.flat.size + d);
  }));
  $('#sides').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sector]');
    if (b) setSide(+b.dataset.sector);
  });
  $$('#outdoorSeg button').forEach((b) => b.addEventListener('click', () => setOutdoor(b.dataset.outdoor)));

  $('#roomAdd').addEventListener('click', roomAdd);
  $('#rooms').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) return roomRemove(+del.dataset.del);
    const open = e.target.closest('[data-k]');
    if (open) setWindow({ ...S.flat.rooms[+open.dataset.k] }, { fly: true, source: 'room' });
  });
  S.compare = loadCompare();
  renderCompareBtn();
  $('#cmpAdd').addEventListener('click', compareAdd);
  $('#cmpOpen').addEventListener('click', openCompare);
  $('#cmpClose').addEventListener('click', () => $('#compare').close());
  $('#compare').addEventListener('click', (e) => {
    if (e.target === $('#compare')) $('#compare').close(); // клик по фону
    const del = e.target.closest('[data-del]');
    if (del) saveCompare(S.compare.filter((_, k) => k !== +del.dataset.del));
    const open = e.target.closest('[data-open]');
    if (open) {
      goal('compare_go');
      location.hash = S.compare[+open.dataset.open].hash;
      location.reload();
    }
  });
  $('#cmpClear').addEventListener('click', () => saveCompare([]));
  $('#cmpPdf').addEventListener('click', () => {
    $('#compare').close();
    makeReport('pdf');
  });
  $('#surveyBtns').addEventListener('click', (e) => {
    const b = e.target.closest('[data-price]');
    if (b) answerSurvey(b.dataset.price);
  });
  $('#signInput').value = readSign();
  $('#signInput').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    try {
      localStorage.setItem(SIGN_KEY, v);
    } catch (err) { /* подпись возьмём из поля */ }
    if (v) goal('report_sign');
  });
  $('#reportImg').addEventListener('click', () => makeReport('image'));
  $('#reportPdf').addEventListener('click', () => makeReport('pdf'));
  $('#focusClose').addEventListener('click', hideFocus);
  $('#focusDelete').addEventListener('click', () => S.focus != null && removeBuilding(S.focus));
  $('#addBtn').addEventListener('click', startDraw);
  $('#drawDone').addEventListener('click', finishDraw);
  $('#drawCancel').addEventListener('click', stopDraw);
  $('#drawUndo').addEventListener('click', () => {
    S.drawing?.pts.pop();
    stage.setDraft(S.drawing?.pts || []);
    renderDrawBar();
  });

  // календарь: клик — перейти к дате и времени
  const heat = $('#heat');
  heat.addEventListener('click', (e) => {
    if (!S.yr) return;
    const r = heat.getBoundingClientRect();
    const di = clamp(Math.floor(((e.clientX - r.left) / r.width) * 365), 0, 364);
    S.date = dateFromDoy(S.date.y, di);
    S.minute = clamp(((e.clientY - r.top) / r.height) * 1440, 0, 1439);
    setPlaying(false);
    updateDate();
  });

  $('#matrix').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sector]');
    if (!b || !S.win) return;
    const side = sidesOf(S.win.i).find((x) => x.sector === +b.dataset.sector);
    if (side) setWindow({ ...S.win, x: side.x, y: side.y, nx: side.nx, ny: side.ny, floor: +b.dataset.floor }, { source: 'matrix' });
  });

  const bl = $('#blockers');
  bl.addEventListener('pointerover', (e) => {
    const li = e.target.closest('li[data-group]');
    stage.setTint('focus', li ? +li.dataset.group : null);
  });
  bl.addEventListener('pointerleave', () => stage.setTint('focus', null));
  bl.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    const b = S.model.buildings[+li.dataset.i];
    stage.flyTo({ target: stage.modelToWorld(b.cx, b.cy, Math.min(b.h / 2, 60)), dist: Math.max(380, b.h * 2.4) }, 1500);
  });

  $('#recenterBtn').addEventListener('click', () => {
    const [lat, lon] = S.proj.toLatLon(S.win.x, S.win.y);
    loadPlace({ ...S.place, demo: false, lat, lon }, { exact: true, x: 0, y: 0, nx: S.win.nx, ny: S.win.ny, floor: S.win.floor });
  });

  $('#shareBtn').addEventListener('click', async () => {
    updateHash();
    goal('share_link');
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Ссылка на окно скопирована');
    } catch (e) {
      toast('Скопируйте ссылку из адресной строки');
    }
  });

  addEventListener('keydown', (e) => {
    if (S.mode !== 'app' || e.target.closest('input')) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!S.playing); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      S.minute = clamp(S.minute + (e.key === 'ArrowRight' ? 10 : -10), 0, 1439);
      updateTime();
    }
    if (e.key === 'Escape') {
      if (S.drawing) stopDraw();
      else hideFocus();
    }
    if (e.key === 'Enter' && S.drawing) finishDraw();
  });

  let rt;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      stage.setViewShift(...(S.mode === 'landing' ? landingShift() : appShift()));
      drawTrack($('#dayCanvas'), S.day);
      drawTrack($('#roTrack'), S.day);
      if (S.yr) drawHeat($('#heat'), S.yr, dayOfYear(S.date.y, S.date.m, S.date.d));
      if (S.landingYr) drawHeat($('#landingHeat'), S.landingYr);
      updateTime();
    }, 120);
  });
}

// ---------- Мелочи ----------
function fillRange(r) {
  const min = +r.min || 0, max = +r.max || 100;
  r.style.setProperty('--fill', `${max > min ? ((r.value - min) / (max - min)) * 100 : 0}%`);
}
function setText(sel, t) {
  const el = $(sel);
  if (el && el.textContent !== t) el.textContent = t;
}
function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
function capital(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

let toastT;
function toast(text, ms = 3200) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), ms);
}
function showLoader(text, p) {
  $('#loader').classList.add('show');
  setLoader(text, p);
}
function setLoader(text, p) {
  if (text) $('#loaderText').textContent = text;
  if (p != null) $('#loaderBar').style.transform = `scaleX(${p})`;
}
function hideLoader() { $('#loader').classList.remove('show'); }

// ---------- Старт ----------
async function boot() {
  initAnalytics();
  initControls();
  initReveal();
  stage.setViewShift(...landingShift());
  try {
    const model = await fetch('data/demo.json').then((r) => r.json());
    stage.setView({ target: stage.modelToWorld(0, 30, 30), dist: innerWidth < 768 ? 3600 : 2900, polar: 0.62, azim: 2.0 });
    await applyModel(PLACES.demo, model);
    const w = demoWindow();
    S.demoWin = w;
    S.onYear = computeLandingStats;
    setWindow(w);
    S.minute = (S.day?.sunrise ?? 420) + 60;
  } catch (e) {
    console.error(e);
    toast('Не удалось загрузить демо-квартал');
  }
  body.classList.remove('is-booting');
  const fromHash = await openFromHash();
  if (!fromHash) stage.flyTo(landingView(), 3200);
}

boot();
