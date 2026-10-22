// Тайлы: кодирование, отсечение и сквозной путь «GeoJSON → тайлы → модель» против разбора OSM API
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TILE, tileIndex, tileBounds, encodeTile, decodeTile, mergeFeatures, clipLine, clipRing, addToTiles, fromGeoJSON, emptyFeatures,
} from '../js/tile-format.js';
import { parseOSM, featuresToModel, makeProjection } from '../js/osm.js';

// Центр квартала ровно на границе тайлов — так проверяется склейка соседних тайлов
const LON = 37.596, LAT = 55.755;
const proj = makeProjection(LAT, LON);
const ll = (x, y) => { const [lat, lon] = proj.toLatLon(x, y); return [lon, lat]; };
const square = (x0, y0, x1, y1) => [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)];

test('кодирование тайла сохраняет координаты с точностью ~10 см', () => {
  const [ix, iy] = tileIndex(LON + 0.001, LAT + 0.001);
  const f = emptyFeatures();
  f.buildings.push({ id: 1, isPart: false, tags: { building: 'yes', height: '20' }, polys: [{ outer: [LON + 0.001, LAT + 0.001, LON + 0.002, LAT + 0.001, LON + 0.002, LAT + 0.002], holes: [] }] });
  f.trees.push(LON + 0.0015, LAT + 0.0015);
  const back = decodeTile(JSON.parse(JSON.stringify(encodeTile(f, ix, iy))), ix, iy);
  back.buildings[0].polys[0].outer.forEach((v, i) => assert.ok(Math.abs(v - f.buildings[0].polys[0].outer[i]) < 1e-6));
  assert.equal(back.buildings[0].tags.height, '20');
  assert.ok(Math.abs(back.trees[0] - f.trees[0]) < 1e-6);
});

test('отсечение линии и кольца по тайлу', () => {
  const b = [0, 0, 10, 10];
  assert.deepEqual(clipLine([-5, 5, 15, 5], b), [[0, 5, 10, 5]]);
  assert.deepEqual(clipLine([-5, -5, -1, -1], b), []);
  assert.equal(clipLine([1, 1, 5, 5, 9, 1], b).length, 1, 'ломаная внутри — один кусок');
  assert.deepEqual(clipLine([5, 5, 15, 5, 15, 8, 5, 8], b), [[5, 5, 10, 5], [10, 8, 5, 8]], 'вышла и вернулась — два куска');
  const r = clipRing([-5, 2, 5, 2, 5, 8, -5, 8], b);
  const xs = r.filter((_, i) => i % 2 === 0);
  assert.equal(Math.min(...xs), 0);
  assert.equal(clipRing([20, 20, 30, 20, 30, 30], b), null);
});

test('GeoJSON из osmium → тайлы → модель совпадает с разбором OSM API', () => {
  // Те же объекты в двух видах: элементы OSM API и GeoJSON, как его отдаёт osmium export -a type,id
  const geo = [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(-30, -20, 10, 20)] }, properties: { '@type': 'way', '@id': 100, building: 'yes', height: '60', name: 'Башня' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(-25, -15, 5, 15)] }, properties: { '@type': 'way', '@id': 101, 'building:part': 'yes', 'building:levels': '20' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(40, -40, 120, 40), square(60, -20, 100, 20)] }, properties: { '@type': 'relation', '@id': 300, type: 'multipolygon', building: 'apartments', 'building:levels': '6' } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: square(-120, 50, -110, 60) }, properties: { '@type': 'way', '@id': 400, building: 'garage' } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [ll(-300, -60), ll(300, -60)] }, properties: { '@type': 'way', '@id': 500, highway: 'residential' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [square(-200, 100, 200, 200)] }, properties: { '@type': 'way', '@id': 600, leisure: 'park' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: ll(150, -100) }, properties: { '@type': 'node', '@id': 700, natural: 'tree' } },
  ];
  const tiles = new Map();
  for (const g of geo) addToTiles(tiles, fromGeoJSON(g));
  assert.ok(tiles.size >= 2, 'объекты легли в несколько тайлов');
  const decoded = [...tiles.entries()].map(([k, f]) => {
    const [ix, iy] = k.split('/').map(Number);
    return decodeTile(JSON.parse(JSON.stringify(encodeTile(f, ix, iy))), ix, iy);
  });
  const fromTiles = featuresToModel(mergeFeatures(decoded), LAT, LON);

  // Те же объекты как элементы OSM API
  let nid = 1;
  const nodes = [];
  const way = (coords) => coords.slice(0, -1).map(([lon, lat]) => { nodes.push({ type: 'node', id: nid, lat, lon }); return nid++; });
  const closed = (coords) => { const ids = way(coords); return [...ids, ids[0]]; };
  const els = [
    { type: 'way', id: 100, nodes: closed(square(-30, -20, 10, 20)), tags: geo[0].properties },
    { type: 'way', id: 101, nodes: closed(square(-25, -15, 5, 15)), tags: geo[1].properties },
    { type: 'way', id: 200, nodes: closed(square(40, -40, 120, 40)) },
    { type: 'way', id: 201, nodes: closed(square(60, -20, 100, 20)) },
    { type: 'relation', id: 300, tags: geo[2].properties, members: [{ type: 'way', ref: 200, role: 'outer' }, { type: 'way', ref: 201, role: 'inner' }] },
    { type: 'way', id: 400, nodes: closed(square(-120, 50, -110, 60)), tags: geo[3].properties },
  ];
  const fromApi = parseOSM([...nodes, ...els], LAT, LON);

  const sig = (m) => m.buildings.map((b) => `${b.id}:${b.h}:${b.levels}:${b.polys[0].holes.length}:${b.group}`).sort();
  assert.deepEqual(sig(fromTiles), sig(fromApi));
  assert.ok(fromTiles.roads.length >= 2, 'дорога через границу тайлов разрезана');
  assert.ok(fromTiles.areas.length >= 2, 'парк через границу тайлов разрезан');
  assert.equal(TILE.w, 0.012);
  assert.deepEqual(tileBounds(...tileIndex(LON + 1e-9, LAT)).map((v) => +v.toFixed(6))[0], 37.596);
});
