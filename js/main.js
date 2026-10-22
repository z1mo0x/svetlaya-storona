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
import { CONFIG } from './config.js';

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
  floors: null,
  calc: 0,
  load: 0,
  heroVisible: true,
  last: {},
  outdoor: 'none', // что у окна: ничего, лоджия или балкон этажом выше — запоминаем между окнами
  depth: 1.2,
  maxHours: null,
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
    goal('place_loaded', { buildings: model.buildings.length, source: model.source });
    const w = autoWindow(prefer);
    if (w) setWindow(w, { source: prefer?.exact ? 'link' : 'auto' });
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
function setWindow(w, { fly = false, source } = {}) {
  const b = S.model.buildings[w.i];
  const [lo, hi, fh] = floorRange(b);
  const L = Math.hypot(w.nx, w.ny) || 1;
  const win = {
    ...w, nx: w.nx / L, ny: w.ny / L, floor: clamp(Math.round(w.floor), lo, hi), lo, hi, fh, group: b.group,
    outdoor: w.outdoor ?? S.outdoor, depth: w.depth ?? S.depth,
  };
  win.z = floorZ(win.floor, fh);
  S.win = win;
  body.classList.add('has-win');
  stage.setTint('target', b.group);
  stage.setWindow({ ...win, label: `${win.floor} этаж` });
  renderWindowPanel();
  recompute(true);
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
  recompute(true);
  updateTime();
  updateHash();
  goal('outdoor_change', { kind, depth: S.depth });
}

function clearWindow() {
  S.win = null;
  S.yr = S.norm = null;
  S.floors = null;
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
  recompute(false);
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
  stage.rebuildBuildings();
  if (S.win) setWindow({ ...S.win });
  if (!$('#focusCard').hidden && S.focus === i) renderFocus(i);
}

function checkEdge() {
  const far = S.win && Math.hypot(S.win.x, S.win.y) > S.model.R * 0.55;
  $('#edgeNote').hidden = !far || S.mode !== 'app';
}

// ---------- Расчёты ----------
function recompute(withFloors) {
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
    drawHeat($('#heat'), S.yr, dayOfYear(y, S.date.m, S.date.d));
    if (S.onYear) {
      const f = S.onYear;
      S.onYear = null;
      f();
    }
  }).catch((e) => console.error(e));
  if (withFloors) {
    S.floors = null;
    renderFloors([]);
    calc.floors(S.win, y, S.tz, (arr) => {
      if (token !== S.calc) return;
      S.floors = arr;
      renderFloors(arr);
    }).then((arr) => {
      if (arr && token === S.calc) {
        S.floors = arr;
        renderFloors(arr);
      }
    }).catch((e) => console.error(e));
  } else renderFloors(S.floors || []);
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
  $('#normBadge').textContent = n.pass ? 'Норма выполняется' : 'Норма не выполняется';
  const zone = { north: 'северная', center: 'центральная', south: 'южная' }[n.zone];
  const date = n.zone === 'south' ? '22 февраля' : '22 апреля';
  let t = `Расчётный день — ${date}, ${zone} зона: нужно <b>${fmtDur(n.need)}</b> подряд. У окна — <b>${fmtDur(n.longest)}</b> непрерывно`;
  t += n.parts.length > 1 ? `, всего <b>${fmtDur(n.total)}</b>.` : '.';
  if (n.mode === 'broken') t += ' Засчитано как прерывистая инсоляция.';
  t += n.cut === 90
    ? ' Полтора часа после восхода и перед закатом не учитываются (ГОСТ Р 57795-2017).'
    : ' Первый час после восхода и последний перед закатом не учитываются (ГОСТ Р 57795-2017).';
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
      <span class="b-meta">${lv} ${plural(lv, ['этаж', 'этажа', 'этажей'])} · ${dist} м от окна</span>
      <span class="b-share">${Math.round(t.share * 100)}%</span>
      <span class="b-bar"><i style="--v:${(t.share / max).toFixed(3)}"></i></span>
    </li>`;
  }).join('');
}

function renderFloors(arr) {
  const box = $('#floors');
  if (!S.win) return;
  const n = S.win.hi - S.win.lo + 1;
  const max = Math.max(1, ...arr.map((a) => a.hours));
  const every = n > 40 ? 10 : n > 20 ? 5 : n > 10 ? 2 : 1;
  let html = '';
  for (let f = S.win.lo; f <= S.win.hi; f++) {
    const a = arr.find((x) => x.floor === f);
    const v = a ? Math.max(0.03, a.hours / max) : 0.03;
    const label = f === S.win.lo || f === S.win.hi || f % every === 0 ? `<span>${f}</span>` : '';
    html += `<button type="button" data-floor="${f}" class="${f === S.win.floor ? 'cur' : ''}" aria-label="${f} этаж${a ? `, ${Math.round(a.hours)} часов солнца в год` : ''}"><i style="--v:${v.toFixed(3)}"></i>${label}</button>`;
  }
  const cur = arr.find((x) => x.floor === S.win.floor);
  html += `<span class="floors-tip">${cur ? `${S.win.floor} этаж — ${Math.round(cur.hours).toLocaleString('ru-RU')} ч` : arr.length < n ? 'считаем…' : ''}</span>`;
  box.innerHTML = html;
}

function groupLevels(g) {
  const list = stage.groups.get(g) || [];
  return Math.max(...list.map((i) => floorsOf(S.model.buildings[i]).hi));
}

function shortName(b) {
  if (!b) return 'дом';
  return b.name || b.addr || capital(TYPE_NAMES[b.type] || 'здание');
}

// ---------- Холсты ----------
function drawHeat(cv, yr, markDoy) {
  if (!cv || !yr) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = cv.clientWidth, H = cv.clientHeight;
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
  $('#focusKind').textContent = capital(TYPE_NAMES[b.type] || 'здание');
  $('#focusTitle').textContent = b.name || b.addr || 'Без адреса';
  $('#focusOut').textContent = parts > 1 ? groupLevels(b.group) : b.levels;
  $$('#focusCard .stepper button').forEach((x) => (x.disabled = parts > 1));
  $('#focusNote').textContent = parts > 1
    ? `Сложное здание из ${parts} частей — высоты частей взяты из OSM.`
    : b.src === 'guess'
      ? 'Этажность не указана в OSM — мы подставили типовую. Поправьте, если знаете точно.'
      : b.src === 'user' ? 'Этажность задана вами. Расчёт уже обновлён.' : `Высота ${Math.round(b.h)} м по данным OSM.`;
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
  const isDemo = Math.abs(lat - PLACES.demo.lat) < 1e-4 && Math.abs(lon - PLACES.demo.lon) < 1e-4;
  if (isDemo) {
    if (prefer) {
      const win = autoWindow(prefer);
      if (win) setWindow(win, { source: 'link' });
    }
    flyToWindow();
  } else {
    const ru = lat > 41 && lat < 82 && lon > 19;
    await loadPlace({ title: p.get('n') || 'Выбранное место', lat, lon, region: p.get('n') || '', country: ru ? 'ru' : '' }, prefer);
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
  }));
  $('#sides').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sector]');
    if (b) setSide(+b.dataset.sector);
  });
  $$('#outdoorSeg button').forEach((b) => b.addEventListener('click', () => setOutdoor(b.dataset.outdoor)));

  // Проверка интереса к отчёту: без оплаты, просто считаем, сколько людям это нужно
  $('#reportBtn').addEventListener('click', () => {
    goal('report_interest', { floor: S.win?.floor, verdict: $('#verdict').dataset.level });
    $('#reportBtn').hidden = true;
    $('#reportThanks').hidden = false;
    if (CONFIG.telegramUrl) {
      $('#reportTg').innerHTML = `. Новости — в <a href="${CONFIG.telegramUrl}" target="_blank" rel="noopener">Telegram-канале</a>`;
    }
  });
  $('#focusClose').addEventListener('click', hideFocus);

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

  $('#floors').addEventListener('click', (e) => {
    const b = e.target.closest('[data-floor]');
    if (b) setFloor(+b.dataset.floor);
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
    if (e.key === 'Escape') hideFocus();
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
