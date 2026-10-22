// Тайлы данных: сетка 0,012° × 0,007° (≈ 750 м), признаки в том же виде, что отдаёт elementsToFeatures.
// Координаты в тайле — целые числа: миллионные доли градуса от юго-западного угла тайла (≈ 10 см).
// Этот же файл копируется в репозиторий тайлов (svetlaya-storona-data/lib) — node tools/sync-data-lib.mjs.
import { isBuilding, isPart, pickBuildingTags, roadOf, areaKind } from './osm-rules.js';

export const TILE = { w: 0.012, h: 0.007 };
const Q = 1e6;

export const tileIndex = (lon, lat) => [Math.floor(lon / TILE.w), Math.floor(lat / TILE.h)];
export const tileBounds = (ix, iy) => [ix * TILE.w, iy * TILE.h, (ix + 1) * TILE.w, (iy + 1) * TILE.h];

export function tilesForBox(w, s, e, n) {
  const [x0, y0] = tileIndex(w, s);
  const [x1, y1] = tileIndex(e, n);
  const out = [];
  for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) out.push([ix, iy]);
  return out;
}

// ---------- Кодирование и чтение тайла ----------

function enc(flat, ix, iy) {
  const x0 = ix * TILE.w, y0 = iy * TILE.h;
  const out = new Array(flat.length);
  for (let i = 0; i < flat.length; i += 2) {
    out[i] = Math.round((flat[i] - x0) * Q);
    out[i + 1] = Math.round((flat[i + 1] - y0) * Q);
  }
  return out;
}

function dec(arr, ix, iy) {
  const x0 = ix * TILE.w, y0 = iy * TILE.h;
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i += 2) {
    out[i] = x0 + arr[i] / Q;
    out[i + 1] = y0 + arr[i + 1] / Q;
  }
  return out;
}

export function emptyFeatures() {
  return { buildings: [], roads: [], areas: [], trees: [], treeRows: [] };
}

export function encodeTile(f, ix, iy) {
  return {
    v: 1,
    b: f.buildings.map((b) => [b.id, b.isPart ? 1 : 0, b.tags, b.polys.map((p) => [enc(p.outer, ix, iy), ...p.holes.map((h) => enc(h, ix, iy))])]),
    r: f.roads.map((r) => [r.kind, r.w, r.bridge ? 1 : 0, enc(r.pts, ix, iy)]),
    a: f.areas.map((a) => [a.kind, a.seed, a.rings.map((r) => enc(r, ix, iy))]),
    t: enc(f.trees, ix, iy),
    tr: f.treeRows.map((r) => enc(r, ix, iy)),
  };
}

export function decodeTile(j, ix, iy) {
  return {
    buildings: (j.b || []).map(([id, part, tags, polys]) => ({
      id, isPart: !!part, tags,
      polys: polys.map(([outer, ...holes]) => ({ outer: dec(outer, ix, iy), holes: holes.map((h) => dec(h, ix, iy)) })),
    })),
    roads: (j.r || []).map(([kind, w, bridge, pts]) => ({ kind, w, bridge: !!bridge, pts: dec(pts, ix, iy) })),
    areas: (j.a || []).map(([kind, seed, rings]) => ({ kind, seed, rings: rings.map((r) => dec(r, ix, iy)) })),
    trees: dec(j.t || [], ix, iy),
    treeRows: (j.tr || []).map((r) => dec(r, ix, iy)),
  };
}

export function mergeFeatures(list) {
  const out = emptyFeatures();
  const seen = new Set();
  for (const f of list) {
    for (const b of f.buildings) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.buildings.push(b);
    }
    out.roads.push(...f.roads);
    out.areas.push(...f.areas);
    out.trees.push(...f.trees);
    out.treeRows.push(...f.treeRows);
  }
  return out;
}

// ---------- Отсечение по границам тайла ----------

// Линия → куски внутри прямоугольника (Лянг — Барски по каждому отрезку)
export function clipLine(pts, [w, s, e, n]) {
  const pieces = [];
  let cur = null;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i], y0 = pts[i + 1], x1 = pts[i + 2], y1 = pts[i + 3];
    const dx = x1 - x0, dy = y1 - y0;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, x0 - w], [dx, e - x0], [-dy, y0 - s], [dy, n - y0]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { cur = null; continue; }
    const ax = x0 + dx * t0, ay = y0 + dy * t0, bx = x0 + dx * t1, by = y0 + dy * t1;
    if (cur && cur[cur.length - 2] === ax && cur[cur.length - 1] === ay && t0 === 0) cur.push(bx, by);
    else {
      cur = [ax, ay, bx, by];
      pieces.push(cur);
    }
    if (t1 < 1) cur = null;
  }
  return pieces;
}

// Кольцо → кольцо внутри прямоугольника (Сазерленд — Ходжман) или null
export function clipRing(ring, [w, s, e, n]) {
  let pts = [];
  for (let i = 0; i < ring.length; i += 2) pts.push([ring[i], ring[i + 1]]);
  const edges = [
    (p) => p[0] >= w, (p) => p[0] <= e, (p) => p[1] >= s, (p) => p[1] <= n,
  ];
  const cross = [
    (a, b) => [w, a[1] + ((b[1] - a[1]) * (w - a[0])) / (b[0] - a[0])],
    (a, b) => [e, a[1] + ((b[1] - a[1]) * (e - a[0])) / (b[0] - a[0])],
    (a, b) => [a[0] + ((b[0] - a[0]) * (s - a[1])) / (b[1] - a[1]), s],
    (a, b) => [a[0] + ((b[0] - a[0]) * (n - a[1])) / (b[1] - a[1]), n],
  ];
  for (let k = 0; k < 4 && pts.length; k++) {
    const inside = edges[k];
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i];
      const ia = inside(a), ib = inside(b);
      if (ib) {
        if (!ia) next.push(cross[k](a, b));
        next.push(b);
      } else if (ia) next.push(cross[k](a, b));
    }
    pts = next;
  }
  if (pts.length < 3) return null;
  return pts.flat();
}

const bboxFlat = (flat) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] < x0) x0 = flat[i];
    if (flat[i] > x1) x1 = flat[i];
    if (flat[i + 1] < y0) y0 = flat[i + 1];
    if (flat[i + 1] > y1) y1 = flat[i + 1];
  }
  return [x0, y0, x1, y1];
};

// ---------- Раскладка признаков по тайлам ----------

// tiles: Map 'ix/iy' → признаки тайла
export function addToTiles(tiles, f) {
  const get = (ix, iy) => {
    const k = `${ix}/${iy}`;
    let t = tiles.get(k);
    if (!t) tiles.set(k, (t = emptyFeatures()));
    return t;
  };
  // дом — целиком в тайл, где центр его рамки
  for (const b of f.buildings) {
    const [x0, y0, x1, y1] = bboxFlat(b.polys.flatMap((p) => p.outer));
    get(...tileIndex((x0 + x1) / 2, (y0 + y1) / 2)).buildings.push(b);
  }
  for (const r of f.roads) {
    const [x0, y0, x1, y1] = bboxFlat(r.pts);
    for (const [ix, iy] of tilesForBox(x0, y0, x1, y1)) {
      for (const piece of clipLine(r.pts, tileBounds(ix, iy))) get(ix, iy).roads.push({ ...r, pts: piece });
    }
  }
  for (const row of f.treeRows) {
    const [x0, y0, x1, y1] = bboxFlat(row);
    for (const [ix, iy] of tilesForBox(x0, y0, x1, y1)) {
      for (const piece of clipLine(row, tileBounds(ix, iy))) get(ix, iy).treeRows.push(piece);
    }
  }
  for (const a of f.areas) {
    const [x0, y0, x1, y1] = bboxFlat(a.rings.flat());
    for (const [ix, iy] of tilesForBox(x0, y0, x1, y1)) {
      const rings = a.rings.map((r) => clipRing(r, tileBounds(ix, iy))).filter(Boolean);
      if (rings.length) get(ix, iy).areas.push({ ...a, rings });
    }
  }
  for (let i = 0; i < f.trees.length; i += 2) get(...tileIndex(f.trees[i], f.trees[i + 1])).trees.push(f.trees[i], f.trees[i + 1]);
}

// ---------- Признаки из GeoJSON (osmium export -a type,id) ----------

const flatRing = (coords) => {
  const n = coords.length > 1 && coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1]
    ? coords.length - 1 : coords.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push(coords[i][0], coords[i][1]);
  return out;
};
const flatLine = (coords) => coords.flatMap((c) => [c[0], c[1]]);

function polygonsOf(g) {
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  // замкнутая линия с тегами площади — тоже многоугольник
  if (g.type === 'LineString') {
    const c = g.coordinates;
    if (c.length >= 4 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1]) return [[c]];
  }
  return null;
}

export function fromGeoJSON(feature, f = emptyFeatures()) {
  const p = feature.properties || {};
  const g = feature.geometry;
  if (!g) return f;
  const type = p['@type'];
  const rawId = Number(p['@id']);
  const id = type === 'relation' ? -rawId : rawId;
  if (g.type === 'Point') {
    if (p.natural === 'tree') f.trees.push(g.coordinates[0], g.coordinates[1]);
    return f;
  }
  if (isBuilding(p)) {
    const polys = polygonsOf(g);
    if (polys) {
      f.buildings.push({
        id, tags: pickBuildingTags(p), isPart: isPart(p),
        polys: polys.map(([outer, ...holes]) => ({ outer: flatRing(outer), holes: holes.map(flatRing) })).filter((x) => x.outer.length >= 6),
      });
    }
    return f;
  }
  if (g.type === 'LineString') {
    const road = roadOf(p);
    if (road) { f.roads.push({ ...road, pts: flatLine(g.coordinates) }); return f; }
    if (p.natural === 'tree_row') { f.treeRows.push(flatLine(g.coordinates)); return f; }
  }
  const kind = areaKind(p);
  if (kind) {
    const polys = polygonsOf(g);
    if (polys) f.areas.push({ kind, seed: rawId, rings: polys.flat().map(flatRing).filter((r) => r.length >= 6) });
  }
  return f;
}
