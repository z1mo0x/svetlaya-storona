// Загрузка и разбор данных OpenStreetMap в компактную модель квартала.
// Координаты модели — метры в локальной плоскости: x — на восток, y — на север.

export const LEVEL_H = 3;
const OSM_API = 'https://api.openstreetmap.org/api/0.6/map.json';

export function makeProjection(lat0, lon0) {
  const f = (lat0 * Math.PI) / 180;
  const mLat = 111132.954 - 559.822 * Math.cos(2 * f) + 1.175 * Math.cos(4 * f);
  const mLon = 111412.84 * Math.cos(f) - 93.5 * Math.cos(3 * f);
  return {
    mLat,
    mLon,
    toXY: (lat, lon) => [(lon - lon0) * mLon, (lat - lat0) * mLat],
    toLatLon: (x, y) => [lat0 + y / mLat, lon0 + x / mLon],
  };
}

// ---------- Загрузка ----------

async function fetchBox(bb, signal, depth = 0) {
  const url = `${OSM_API}?bbox=${bb.map((v) => v.toFixed(6)).join(',')}`;
  const res = await fetch(url, { signal });
  if (res.status === 400 && depth < 2) {
    // слишком много объектов — делим прямоугольник на четыре
    const [w, s, e, n] = bb;
    const mx = (w + e) / 2, my = (s + n) / 2;
    const sub = [[w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n]];
    const parts = await Promise.all(sub.map((b) => fetchBox(b, signal, depth + 1)));
    return parts.flat();
  }
  if (res.status === 429) throw new Error('rate');
  if (!res.ok) throw new Error(`OSM API ответил ${res.status}`);
  const json = await res.json();
  return json.elements || [];
}

export async function fetchOSM(lat, lon, half = 470, { signal, onProgress } = {}) {
  const proj = makeProjection(lat, lon);
  const dLat = half / proj.mLat, dLon = half / proj.mLon;
  const boxes = [[-1, -1], [0, -1], [-1, 0], [0, 0]].map(([a, b]) => [
    lon + a * dLon, lat + b * dLat, lon + (a + 1) * dLon, lat + (b + 1) * dLat,
  ]);
  let done = 0;
  const parts = await Promise.all(
    boxes.map(async (bb) => {
      const els = await fetchBox(bb, signal);
      onProgress?.(++done / boxes.length);
      return els;
    }),
  );
  const seen = new Map();
  for (const els of parts) for (const e of els) seen.set(e.type[0] + e.id, e);
  return [...seen.values()];
}

// ---------- Геометрия ----------

export function pointInRings(x, y, rings) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += (r[j] - r[i]) * (r[j + 1] + r[i + 1]);
  return a / 2;
}

function bboxOf(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      if (r[i] < x0) x0 = r[i];
      if (r[i] > x1) x1 = r[i];
      if (r[i + 1] < y0) y0 = r[i + 1];
      if (r[i + 1] > y1) y1 = r[i + 1];
    }
  }
  return [x0, y0, x1, y1];
}

// Склеивает отрезки (массивы id узлов) в замкнутые кольца.
// tolerant — для воды и парков: недостающие куски вне выборки замыкаем по ближайшим концам.
function assembleRings(chains, coordOf, tolerant) {
  const open = [];
  const rings = [];
  for (const c of chains) {
    if (c.length < 2) continue;
    if (c[0] === c[c.length - 1] && c.length >= 4) rings.push(c);
    else open.push(c.slice());
  }
  const unclosed = [];
  while (open.length) {
    let cur = open.shift();
    let grew = true;
    while (cur[0] !== cur[cur.length - 1] && grew) {
      grew = false;
      const end = cur[cur.length - 1];
      for (let i = 0; i < open.length; i++) {
        const o = open[i];
        if (o[0] === end) cur = cur.concat(o.slice(1));
        else if (o[o.length - 1] === end) cur = cur.concat(o.slice(0, -1).reverse());
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (cur[0] === cur[cur.length - 1] && cur.length >= 4) rings.push(cur);
    else unclosed.push(cur);
  }
  const out = rings.map((r) => toFlat(r.slice(0, -1), coordOf)).filter(Boolean);
  if (tolerant && unclosed.length) {
    let pieces = unclosed.map((c) => toFlat(c, coordOf)).filter(Boolean);
    while (pieces.length) {
      let cur = pieces.shift();
      while (pieces.length) {
        const ex = cur[cur.length - 2], ey = cur[cur.length - 1];
        let best = -1, bestD = Infinity, rev = false;
        pieces.forEach((p, i) => {
          const d0 = (p[0] - ex) ** 2 + (p[1] - ey) ** 2;
          const d1 = (p[p.length - 2] - ex) ** 2 + (p[p.length - 1] - ey) ** 2;
          if (d0 < bestD) { bestD = d0; best = i; rev = false; }
          if (d1 < bestD) { bestD = d1; best = i; rev = true; }
        });
        const close = (cur[0] - ex) ** 2 + (cur[1] - ey) ** 2;
        if (close <= bestD) break;
        let p = pieces.splice(best, 1)[0];
        if (rev) p = reverseFlat(p);
        cur = concatFlat(cur, p);
      }
      if (cur.length >= 6) out.push(cur);
    }
  }
  return out;
}

function toFlat(ids, coordOf) {
  const a = [];
  for (const id of ids) {
    const p = coordOf(id);
    if (p) a.push(p[0], p[1]);
  }
  return a.length >= 6 ? a : null;
}
function reverseFlat(a) {
  const r = [];
  for (let i = a.length - 2; i >= 0; i -= 2) r.push(a[i], a[i + 1]);
  return r;
}
function concatFlat(a, b) {
  return a.concat(b);
}

// ---------- Теги ----------

function num(v) {
  if (v == null) return NaN;
  const m = String(v).replace(',', '.').match(/-?\d+(\.\d+)?/g);
  if (!m) return NaN;
  return Math.max(...m.map(Number));
}

const GUESS_LEVELS = {
  house: 2, detached: 2, semidetached_house: 2, terrace: 2, bungalow: 1, cabin: 1, farm: 2,
  garage: 1, garages: 1, shed: 1, hut: 1, kiosk: 1, carport: 1, service: 1, transformer_tower: 1,
  toilets: 1, roof: 1, greenhouse: 1, parking: 3, gatehouse: 1,
  apartments: 5, residential: 5, dormitory: 5, hotel: 6, office: 5, commercial: 3, retail: 2,
  industrial: 2, warehouse: 2, school: 3, kindergarten: 2, university: 4, college: 3,
  hospital: 5, public: 3, civic: 3, church: 2, cathedral: 3, construction: 5,
};
const SKIP_BUILDING = new Set(['no', 'entrance', 'underground', 'collapsed', 'demolished', 'razed']);

function buildingInfo(tags) {
  const type = tags.building && tags.building !== 'yes' ? tags.building : tags['building:part'] || 'yes';
  let h = num(tags.height);
  let levels = num(tags['building:levels']);
  const roofLevels = num(tags['roof:levels']) || 0;
  let src = 'height';
  if (!(h > 0)) {
    if (levels > 0) {
      h = levels * LEVEL_H + roofLevels * 1.5;
      src = 'levels';
    } else {
      levels = GUESS_LEVELS[type] ?? 3;
      h = levels * LEVEL_H;
      src = 'guess';
    }
  }
  if (!(levels > 0)) levels = Math.max(1, Math.round(h / LEVEL_H));
  let minH = num(tags.min_height);
  if (!(minH >= 0)) minH = (num(tags['building:min_level']) || 0) * LEVEL_H;
  if (type === 'roof' && minH === 0) minH = Math.max(0, h - 0.6);
  if (minH >= h) minH = Math.max(0, h - 1);
  const street = tags['addr:street'] || '';
  const house = tags['addr:housenumber'] || '';
  return {
    type,
    h: Math.round(h * 10) / 10,
    minH: Math.round(minH * 10) / 10,
    levels: Math.round(levels),
    src,
    name: tags.name || '',
    addr: street && house ? `${street}, ${house}` : house ? `дом ${house}` : '',
  };
}

const ROAD_W = {
  motorway: 22, trunk: 20, primary: 16, secondary: 13, tertiary: 11, unclassified: 8,
  residential: 8, living_street: 6, service: 4.5, pedestrian: 6, track: 3.5, busway: 8,
  motorway_link: 9, trunk_link: 9, primary_link: 9, secondary_link: 8, tertiary_link: 7,
  footway: 2.4, path: 2, cycleway: 2.4, steps: 2.4, bridleway: 2,
};

function areaKind(t) {
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.waterway === 'dock' ||
      t.landuse === 'reservoir' || t.landuse === 'basin') return 'water';
  if (['park', 'garden', 'playground', 'dog_park', 'nature_reserve'].includes(t.leisure)) return 'park';
  if (['grass', 'forest', 'meadow', 'recreation_ground', 'village_green', 'cemetery', 'allotments',
       'flowerbed', 'orchard', 'plant_nursery'].includes(t.landuse)) return t.landuse === 'forest' ? 'wood' : 'park';
  if (['wood', 'scrub', 'grassland', 'heath'].includes(t.natural)) return t.natural === 'wood' ? 'wood' : 'park';
  if (['pitch', 'track', 'stadium'].includes(t.leisure)) return 'pitch';
  if ((t.highway === 'pedestrian' && t.area === 'yes') || t.place === 'square' || t.amenity === 'parking' ||
      t['area:highway']) return 'paved';
  return null;
}

// Детерминированный генератор, чтобы деревья в парках стояли одинаково при каждой загрузке.
function rng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// ---------- Разбор ----------

export function parseOSM(elements, lat0, lon0, R = 430) {
  const proj = makeProjection(lat0, lon0);
  const nodes = new Map(), ways = new Map(), rels = [];
  for (const e of elements) {
    if (e.type === 'node') nodes.set(e.id, e);
    else if (e.type === 'way') ways.set(e.id, e);
    else if (e.type === 'relation') rels.push(e);
  }
  const cache = new Map();
  const coordOf = (id) => {
    let p = cache.get(id);
    if (!p) {
      const n = nodes.get(id);
      if (!n) return null;
      p = proj.toXY(n.lat, n.lon);
      cache.set(id, p);
    }
    return p;
  };

  const raw = []; // здания и части до фильтрации
  const areas = [];
  const roads = [];
  const treePts = [];
  const usedAsMember = new Set();

  const isBuilding = (t) => t && ((t.building && !SKIP_BUILDING.has(t.building)) ||
    (t['building:part'] && t['building:part'] !== 'no')) && t.location !== 'underground' &&
    !(num(t.layer) < 0 && !t.height && !t['building:levels']);

  // Мультиполигоны
  for (const r of rels) {
    const t = r.tags || {};
    if (t.type !== 'multipolygon' && t.type !== 'building') continue;
    const outerW = [], innerW = [];
    for (const m of r.members || []) {
      if (m.type !== 'way') continue;
      const w = ways.get(m.ref);
      if (!w) continue;
      (m.role === 'inner' ? innerW : outerW).push(w.nodes);
    }
    if (isBuilding(t)) {
      const outers = assembleRings(outerW, coordOf, false);
      const inners = assembleRings(innerW, coordOf, false);
      if (!outers.length) continue;
      raw.push({ id: r.id, tags: t, polys: groupPolys(outers, inners), isPart: !!t['building:part'] && !t.building });
      for (const m of r.members || []) if (m.type === 'way') usedAsMember.add(m.ref);
      continue;
    }
    const kind = areaKind(t);
    if (kind) {
      const outers = assembleRings(outerW, coordOf, true);
      const inners = assembleRings(innerW, coordOf, true);
      if (outers.length) areas.push({ kind, rings: [...outers, ...inners], seed: r.id });
    }
  }

  for (const w of ways.values()) {
    const t = w.tags;
    if (!t) continue;
    const closed = w.nodes.length >= 4 && w.nodes[0] === w.nodes[w.nodes.length - 1];
    if (isBuilding(t) && closed) {
      const ring = toFlat(w.nodes.slice(0, -1), coordOf);
      if (ring) raw.push({ id: w.id, tags: t, polys: [{ outer: ring, holes: [] }], isPart: !!t['building:part'] && !t.building });
      continue;
    }
    if (t.highway && ROAD_W[t.highway] && t.area !== 'yes' && t.tunnel !== 'yes' && t.covered !== 'yes' &&
        t.tunnel !== 'building_passage') {
      const pts = toFlat(w.nodes, coordOf) || (w.nodes.length === 2 ? toFlatLoose(w.nodes, coordOf) : null);
      if (pts) roads.push({ pts, w: num(t.width) > 0 ? Math.min(num(t.width), 40) : ROAD_W[t.highway], kind: t.highway, bridge: t.bridge === 'yes' });
      continue;
    }
    if (t.railway && ['rail', 'light_rail', 'tram', 'subway', 'monorail'].includes(t.railway) && t.tunnel !== 'yes') {
      const pts = toFlat(w.nodes, coordOf) || toFlatLoose(w.nodes, coordOf);
      if (pts) roads.push({ pts, w: t.railway === 'tram' ? 2.2 : 3.4, kind: 'rail' });
      continue;
    }
    if (t.natural === 'tree_row') {
      const pts = toFlatLoose(w.nodes, coordOf);
      if (pts) sampleLine(pts, 8, treePts);
      continue;
    }
    const kind = areaKind(t);
    if (kind && closed) {
      const ring = toFlat(w.nodes.slice(0, -1), coordOf);
      if (ring) areas.push({ kind, rings: [ring], seed: w.id });
    }
  }

  for (const n of nodes.values()) {
    if (n.tags && n.tags.natural === 'tree') {
      const p = coordOf(n.id);
      treePts.push(p[0], p[1]);
    }
  }

  // Контуры, у которых есть части (building:part), не рисуем — их заменяют части.
  const outlines = raw.filter((b) => !b.isPart);
  const parts = raw.filter((b) => b.isPart);
  for (const b of raw) {
    b.rings = b.polys.flatMap((p) => [p.outer, ...p.holes]);
    b.bbox = bboxOf(b.polys.map((p) => p.outer));
    b.cx = (b.bbox[0] + b.bbox[2]) / 2;
    b.cy = (b.bbox[1] + b.bbox[3]) / 2;
  }
  for (const p of parts) {
    // точка внутри части: центр рамки может промахнуться для «Г»-образных — берём середину первого ребра со смещением
    const probe = innerPoint(p);
    for (const o of outlines) {
      const [x0, y0, x1, y1] = o.bbox;
      if (probe[0] < x0 || probe[0] > x1 || probe[1] < y0 || probe[1] > y1) continue;
      if (pointInRings(probe[0], probe[1], o.rings)) {
        o.hasParts = true;
        p.group = o.id;
        p.parentTags = o.tags;
        break;
      }
    }
  }

  const buildings = [];
  for (const b of raw) {
    if (b.hasParts) continue;
    if (Math.hypot(b.cx, b.cy) > R) continue;
    const area = b.polys.reduce((s, p) => s + Math.abs(ringArea(p.outer)), 0);
    if (area < 4) continue;
    const info = buildingInfo(b.tags);
    if (b.parentTags) {
      const pi = buildingInfo(b.parentTags);
      if (!info.addr) info.addr = pi.addr;
      if (!info.name) info.name = pi.name;
      if (info.src === 'guess' && pi.src !== 'guess') {
        // часть без высоты — берём высоту контура
        info.h = pi.h;
        info.levels = pi.levels;
        info.src = pi.src;
      }
    }
    buildings.push({
      id: b.id,
      group: b.group || b.id,
      polys: b.polys,
      bbox: b.bbox,
      cx: b.cx,
      cy: b.cy,
      ...info,
    });
  }

  // Деревья: настоящие из OSM + посадки в парках и лесах
  const R2 = R + 40;
  const trees = [];
  const pushTree = (x, y, s) => {
    if (Math.hypot(x, y) > R2 - 6) return;
    trees.push(x, y, s);
  };
  for (let i = 0; i < treePts.length; i += 2) pushTree(treePts[i], treePts[i + 1], 0.9 + ((i * 7919) % 13) / 30);
  let budget = 2600 - trees.length / 3;
  for (const a of areas) {
    if (a.kind !== 'park' && a.kind !== 'wood') continue;
    const outer = a.rings[0];
    const [x0, y0, x1, y1] = bboxOf([outer]);
    const area = Math.abs(ringArea(outer));
    if (area < 150) continue;
    const density = a.kind === 'wood' ? 1 / 55 : 1 / 140;
    const count = Math.min(Math.round(area * density), 400);
    const rand = rng(a.seed);
    for (let k = 0; k < count * 2 && budget > 0; k++) {
      const x = x0 + rand() * (x1 - x0), y = y0 + rand() * (y1 - y0);
      if (!pointInRings(x, y, a.rings)) continue;
      if (Math.hypot(x, y) > R2 - 6) continue;
      if (hitsBuilding(x, y, buildings)) continue;
      pushTree(x, y, 0.75 + rand() * 0.6);
      budget--;
    }
  }

  return {
    lat: lat0,
    lon: lon0,
    R,
    R2,
    buildings,
    roads: roads.filter((r) => nearDisc(r.pts, R2 + 60)),
    areas: areas.filter((a) => a.rings.some((r) => nearDisc(r, R2 + 400))),
    trees,
  };
}

function toFlatLoose(ids, coordOf) {
  const a = [];
  for (const id of ids) {
    const p = coordOf(id);
    if (p) a.push(p[0], p[1]);
  }
  return a.length >= 4 ? a : null;
}

function sampleLine(pts, step, out) {
  for (let i = 0; i < pts.length - 2; i += 2) {
    const x0 = pts[i], y0 = pts[i + 1], x1 = pts[i + 2], y1 = pts[i + 3];
    const L = Math.hypot(x1 - x0, y1 - y0);
    for (let d = 0; d < L; d += step) out.push(x0 + ((x1 - x0) * d) / L, y0 + ((y1 - y0) * d) / L);
  }
}

function nearDisc(pts, r) {
  for (let i = 0; i < pts.length; i += 2) if (Math.hypot(pts[i], pts[i + 1]) < r) return true;
  return false;
}

function hitsBuilding(x, y, buildings) {
  for (const b of buildings) {
    const [x0, y0, x1, y1] = b.bbox;
    if (x < x0 - 3 || x > x1 + 3 || y < y0 - 3 || y > y1 + 3) continue;
    return true;
  }
  return false;
}

function groupPolys(outers, inners) {
  const polys = outers.map((o) => ({ outer: o, holes: [] }));
  for (const h of inners) {
    const p = polys.find((pp) => pointInRings(h[0], h[1], [pp.outer]));
    if (p) p.holes.push(h);
  }
  return polys;
}

function innerPoint(b) {
  const r = b.polys[0].outer;
  const [x0, y0, x1, y1] = b.bbox;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  if (pointInRings(cx, cy, b.rings)) return [cx, cy];
  // треугольник из трёх соседних вершин — его центр почти всегда внутри
  for (let i = 0; i + 5 < r.length; i += 2) {
    const px = (r[i] + r[i + 2] + r[i + 4]) / 3, py = (r[i + 1] + r[i + 3] + r[i + 5]) / 3;
    if (pointInRings(px, py, b.rings)) return [px, py];
  }
  return [r[0], r[1]];
}

// ---------- Компактная сериализация (для демо-файла) ----------

const q = (v) => Math.round(v * 10) / 10;
export function packModel(m) {
  return {
    lat: m.lat, lon: m.lon, R: m.R, R2: m.R2,
    buildings: m.buildings.map((b) => ({
      ...b,
      polys: b.polys.map((p) => ({ outer: p.outer.map(q), holes: p.holes.map((h) => h.map(q)) })),
      bbox: b.bbox.map(q), cx: q(b.cx), cy: q(b.cy),
    })),
    roads: m.roads.map((r) => ({ ...r, pts: r.pts.map(q) })),
    areas: m.areas.map((a) => ({ kind: a.kind, rings: a.rings.map((r) => r.map(q)) })),
    trees: m.trees.map(q),
  };
}
