// Разбор данных OSM: части зданий заменяют контур, дворы остаются дырами
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOSM, makeProjection } from '../js/osm.js';

const LAT = 55.75, LON = 37.6;
const proj = makeProjection(LAT, LON);
let nid = 1;
const nodes = [];
// Квадрат в метрах относительно центра → id узлов (замкнутый контур)
function square(x0, y0, x1, y1) {
  const ids = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => {
    const [lat, lon] = proj.toLatLon(x, y);
    nodes.push({ type: 'node', id: nid, lat, lon });
    return nid++;
  });
  return [...ids, ids[0]];
}

const outline = { type: 'way', id: 100, nodes: square(-20, -20, 20, 20), tags: { building: 'yes', height: '60', name: 'Башня' } };
const part = { type: 'way', id: 101, nodes: square(-15, -15, 15, 15), tags: { 'building:part': 'yes', 'building:levels': '20' } };
const courtOuter = { type: 'way', id: 200, nodes: square(60, -40, 140, 40) };
const courtInner = { type: 'way', id: 201, nodes: square(80, -20, 120, 20) };
const courtyard = {
  type: 'relation', id: 300, tags: { type: 'multipolygon', building: 'apartments', 'building:levels': '6' },
  members: [{ type: 'way', ref: 200, role: 'outer' }, { type: 'way', ref: 201, role: 'inner' }],
};
const shed = { type: 'way', id: 400, nodes: square(-100, 50, -95, 55), tags: { building: 'garage' } };

const model = parseOSM([...nodes, outline, part, courtOuter, courtInner, courtyard, shed], LAT, LON);
const byId = (id) => model.buildings.find((b) => b.id === id);

test('контур с частями не выдавливается, часть получает его имя', () => {
  assert.equal(byId(100), undefined);
  const p = byId(101);
  assert.ok(p);
  assert.equal(p.levels, 20);
  assert.equal(p.h, 60);
  assert.equal(p.name, 'Башня');
  assert.equal(p.group, 100);
});

test('дом-колодец: внутренний двор остаётся дырой', () => {
  const c = byId(300);
  assert.ok(c);
  assert.equal(c.polys.length, 1);
  assert.equal(c.polys[0].holes.length, 1);
  assert.equal(c.h, 18);
  assert.equal(c.src, 'levels');
});

test('дом без высоты получает типовую и помечен как угаданный', () => {
  const g = byId(400);
  assert.ok(g);
  assert.equal(g.src, 'guess');
  assert.equal(g.levels, 1);
});
