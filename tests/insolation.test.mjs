// Расчёт солнца в окне на синтетическом квартале, где ответ известен заранее
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer, NIGHT, BEHIND, BLOCKED, LIT, floorsOf, floorZ, judgeNorm } from '../js/insolation.js';
import { sunVector, sunPosition, localToUTC } from '../js/sun.js';

const RAD = Math.PI / 180;
const v = (altDeg, azDeg) => sunVector(altDeg * RAD, azDeg * RAD);
const box = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];

function building(id, ring, h, minH = 0) {
  const xs = ring.filter((_, i) => i % 2 === 0), ys = ring.filter((_, i) => i % 2 === 1);
  const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return { id, group: id, polys: [{ outer: ring, holes: [] }], bbox, cx: (bbox[0] + bbox[2]) / 2, cy: (bbox[1] + bbox[3]) / 2, h, minH, levels: Math.round(h / 3), src: 'height' };
}

// Окно на южном фасаде пятиэтажки (0, 0), в 40 м южнее — башня 200 м
const home = building(1, box(-10, 0, 10, 20), 15);
const tower = building(2, box(-20, -60, 20, -40), 200);
const model = (lat, list) => ({ lat, lon: 37.6, buildings: list });
const win = { x: 0, y: 0, nx: 0, ny: -1, z: floorZ(2) };

test('окно видит солнце, закрытое башней, — тень с указанием дома', () => {
  const an = new Analyzer(model(55.75, [home, tower]));
  const w = an.prepare(win);
  const [s, b] = an.sample(w, v(57, 180), an.items);
  assert.equal(s, BLOCKED);
  assert.equal(an.items[b].h, 200);
});

test('солнце с юго-востока проходит мимо башни', () => {
  const an = new Analyzer(model(55.75, [home, tower]));
  assert.equal(an.sample(an.prepare(win), v(30, 120), an.items)[0], LIT);
});

test('солнце с севера — за стеной, под горизонтом — ночь', () => {
  const an = new Analyzer(model(55.75, [home, tower]));
  const w = an.prepare(win);
  assert.equal(an.sample(w, v(30, 20), an.items)[0], BEHIND);
  assert.equal(an.sample(w, v(-1, 180), an.items)[0], NIGHT);
});

test('лоджия 1,2 м отсекает высокое солнце плитой и косое — боковыми стенками', () => {
  const an = new Analyzer(model(55.75, [home]));
  const open = an.prepare(win);
  const loggia = an.prepare({ ...win, outdoor: 'loggia', depth: 1.2 });
  assert.equal(an.sample(open, v(57, 180), an.items)[0], LIT);
  assert.equal(an.sample(loggia, v(57, 180), an.items)[0], BEHIND, 'плита сверху');
  assert.equal(an.sample(loggia, v(30, 180), an.items)[0], LIT, 'низкое солнце в лоб проходит');
  assert.equal(an.sample(loggia, v(20, 120), an.items)[0], BEHIND, 'боковая стенка при 60°');
  assert.equal(an.sample(loggia, v(20, 135), an.items)[0], LIT, 'при 45° проходит');
});

test('лоджия нулевой глубины не меняет результат', () => {
  const an = new Analyzer(model(55.75, [home, tower]));
  const a = an.year(win, 2026, 3, 30, 7).litHours;
  const b = an.year({ ...win, outdoor: 'loggia', depth: 0 }, 2026, 3, 30, 7).litHours;
  assert.equal(a, b);
});

test('норма: зоны, расчётный день и отсечка по ГОСТ Р 57795-2017 п. 3.17', () => {
  const cases = [
    [55.75, 'center', 120, [3, 22], 60],
    [60.0, 'north', 150, [3, 22], 90],
    [45.0, 'south', 90, [1, 22], 60],
  ];
  for (const [lat, zone, need, date, cut] of cases) {
    const n = new Analyzer(model(lat, [home])).norm(win, 2026, 3);
    assert.equal(n.zone, zone, `зона для ${lat}`);
    assert.equal(n.need, need);
    assert.deepEqual(n.date, date);
    assert.equal(n.cut, cut, `отсечка для ${lat}`);
  }
});

test('южное окно без соседей проходит норму, за башней — нет', () => {
  assert.equal(new Analyzer(model(55.75, [home])).norm(win, 2026, 3).pass, true);
  const wall = building(3, box(-80, -30, 80, -20), 120);
  assert.equal(new Analyzer(model(55.75, [home, wall])).norm(win, 2026, 3).pass, false);
});

test('норма «на грани»: хватает по точному восходу, но не по инсоляционному графику', () => {
  // Окно видит солнце от восхода, пока оно не уйдёт за плоскость фасада (80° от нормали) в 8:23.
  // По точному восходу учитывается с 6:17 — 2 ч 6 мин, по графику с 6:29 — 1 ч 54 мин
  const end = sunPosition(localToUTC(2026, 3, 22, 8 * 60 + 23, 3), 55.75, 37.6).az / RAD;
  const th = (end - 80) * RAD;
  const n = new Analyzer(model(55.75, [])).norm({ x: 0, y: 0, nx: Math.sin(th), ny: Math.cos(th), z: 10 }, 2026, 3);
  assert.equal(n.pass, true);
  assert.equal(n.edge, true);
  assert.ok(n.chartShift >= 5 && n.chartShift <= 20, `сдвиг графика ${n.chartShift} мин`);
  assert.equal(new Analyzer(model(55.75, [home])).norm(win, 2026, 3).edge, false, 'южное окно с запасом');
});

test('прерывистая инсоляция: +30 мин в сумме и отрезок не короче часа', () => {
  assert.equal(judgeNorm([[400, 470], [500, 580]], 0, 1440, 120).pass, true);
  assert.equal(judgeNorm([[400, 470], [500, 580]], 0, 1440, 120).mode, 'broken');
  assert.equal(judgeNorm([[400, 450], [500, 600]], 0, 1440, 120).pass, true, '50 + 100: самый длинный ≥ 60');
  assert.equal(judgeNorm([[400, 455], [500, 555], [600, 650]], 0, 1440, 120).pass, false, 'все отрезки короче часа');
});

test('этажи по высоте этажа самого дома', () => {
  assert.deepEqual({ ...floorsOf({ h: 213, levels: 52, minH: 0 }), fh: undefined }, { lo: 1, hi: 52, fh: undefined });
  assert.ok(Math.abs(floorsOf({ h: 213, levels: 52, minH: 0 }).fh - 4.096) < 0.01);
  assert.deepEqual(floorsOf({ h: 213, levels: 5, minH: 0 }), { lo: 1, hi: 71, fh: 3 }, 'битые данные — типовой этаж');
  assert.equal(floorsOf({ h: 213, levels: 52, minH: 120 }).lo, 30, 'верхняя часть башни');
  assert.equal(floorZ(1, 3), 1.5);
});
