// Расчёт прямого солнца в окне: аналитическое пересечение луча с призмами домов.
import { sunPosition, sunVector, localToUTC, dayOfYear } from './sun.js';
import { LEVEL_H } from './osm.js';

// Состояния отсчёта
export const NIGHT = 0;   // солнце под горизонтом
export const BEHIND = 1;  // солнце за плоскостью фасада
export const BLOCKED = 2; // луч упирается в дом
export const LIT = 3;     // прямое солнце

const FACADE_COS = Math.cos((80 * Math.PI) / 180); // окно «видит» ±80° от нормали (откосы)

export class Analyzer {
  constructor(model) {
    this.lat = model.lat;
    this.lon = model.lon;
    this.group = model.buildings.map((b) => b.group);
    this.heights = model.buildings.map((b) => b.h);
    this.sunCache = new Map();
    this.items = model.buildings.map((b, i) => ({
      i,
      h: b.h,
      minH: b.minH,
      bbox: b.bbox,
      rings: b.polys.flatMap((p) => [p.outer, ...p.holes]).map((r) => Float64Array.from(r)),
    }));
  }

  // Первый дом на пути луча из (px,py,pz) в направлении (dx,dy,dz). Возвращает {i, t} или null.
  cast(px, py, pz, dx, dy, dz, list = this.items) {
    if (dz <= 0) return null;
    let best = null;
    for (const b of list) {
      if (b.h <= pz) continue;
      const t0 = Math.max(0, (b.minH - pz) / dz);
      const t1 = (b.h - pz) / dz;
      if (t1 <= t0) continue;
      const sx = px + dx * t0, sy = py + dy * t0;
      const ex = px + dx * t1, ey = py + dy * t1;
      const [bx0, by0, bx1, by1] = b.bbox;
      if (Math.max(sx, ex) < bx0 || Math.min(sx, ex) > bx1 || Math.max(sy, ey) < by0 || Math.min(sy, ey) > by1) continue;
      const u = segmentEnters(sx, sy, ex, ey, b.rings);
      if (u < 0) continue;
      const t = t0 + u * (t1 - t0);
      if (!best || t < best.t) best = { i: b.i, t };
    }
    return best;
  }

  // Состояние окна при данном направлении на солнце
  sample(win, v, list) {
    if (v[2] <= 0) return [NIGHT, -1];
    const hl = Math.hypot(v[0], v[1]) || 1;
    if ((v[0] * win.nx + v[1] * win.ny) / hl < FACADE_COS) return [BEHIND, -1];
    const hit = this.cast(win.ox, win.oy, win.z, v[0], v[1], v[2], list);
    return hit ? [BLOCKED, hit.i] : [LIT, -1];
  }

  // Кандидаты в «загораживающие» — только дома выше окна
  candidates(win) {
    return this.items.filter((b) => b.h > win.z);
  }

  prepare(win) {
    return { ...win, ox: win.x + win.nx * 0.35, oy: win.y + win.ny * 0.35 };
  }

  // Подробный разбор одного дня с шагом step минут
  day(winIn, y, m, d, tz, step = 2) {
    const win = this.prepare(winIn);
    const list = this.candidates(win);
    const n = Math.round(1440 / step);
    const state = new Uint8Array(n);
    const blk = new Int32Array(n).fill(-1);
    let sunrise = -1, sunset = -1;
    for (let k = 0; k < n; k++) {
      const min = k * step;
      const p = sunPosition(localToUTC(y, m, d, min, tz), this.lat, this.lon);
      const v = sunVector(p.alt, p.az);
      const [s, b] = this.sample(win, v, list);
      state[k] = s;
      blk[k] = b;
      if (s !== NIGHT) {
        if (sunrise < 0) sunrise = min;
        sunset = min + step;
      }
    }
    const intervals = runs(state, LIT, step);
    const lit = intervals.reduce((s, [a, b]) => s + (b - a), 0);
    const longest = intervals.reduce((s, [a, b]) => Math.max(s, b - a), 0);
    return { step, state, blk, intervals, lit, longest, sunrise, sunset };
  }

  // Направления на солнце для сетки «дни × время» не зависят от окна — считаем один раз
  sunGrid(y, tz, step, dayStep) {
    const key = `${y}|${tz}|${step}|${dayStep}`;
    let g = this.sunCache.get(key);
    if (g) return g;
    const slots = Math.round(1440 / step);
    const days = Math.floor(365 / dayStep);
    g = new Float32Array(days * slots * 3);
    for (let di = 0; di < days; di++) {
      const base = Date.UTC(y, 0, 1) + di * dayStep * 86400000 - tz * 3600000;
      for (let k = 0; k < slots; k++) {
        const p = sunPosition(base + (k * step + step / 2) * 60000, this.lat, this.lon);
        const v = sunVector(p.alt, p.az);
        const o = (di * slots + k) * 3;
        g[o] = v[0]; g[o + 1] = v[1]; g[o + 2] = v[2];
      }
    }
    this.sunCache.set(key, g);
    return g;
  }

  // Солнечный календарь на год: дни × отсчёты времени
  year(winIn, y, tz, step = 10, dayStep = 1) {
    const win = this.prepare(winIn);
    const list = this.candidates(win);
    const slots = Math.round(1440 / step);
    const days = Math.floor(365 / dayStep);
    const sun = this.sunGrid(y, tz, step, dayStep);
    const grid = new Uint8Array(days * slots);
    const perDay = new Float32Array(days);
    const blockers = new Map();
    const v = [0, 0, 0];
    let potential = 0, litTotal = 0;
    for (let di = 0; di < days; di++) {
      for (let k = 0; k < slots; k++) {
        const o = (di * slots + k) * 3;
        v[0] = sun[o]; v[1] = sun[o + 1]; v[2] = sun[o + 2];
        const [s, b] = this.sample(win, v, list);
        grid[di * slots + k] = s;
        if (s === LIT) { perDay[di] += step; litTotal += step; potential++; }
        else if (s === BLOCKED) {
          potential++;
          const g = this.group[b];
          const e = blockers.get(g) || { i: b, c: 0 };
          e.c++;
          if (this.heights[b] > this.heights[e.i]) e.i = b;
          blockers.set(g, e);
        }
      }
    }
    const top = [...blockers.entries()]
      .sort((a, b) => b[1].c - a[1].c)
      .slice(0, 5)
      .map(([group, e]) => ({ i: e.i, group, share: e.c / Math.max(1, potential) }));
    return { step, days, dayStep, slots, grid, perDay, litHours: (litTotal * dayStep) / 60, top, potential };
  }

  // Проверка по нормативу (ориентир по СанПиН 1.2.3685-21)
  norm(winIn, y, tz) {
    const lat = this.lat;
    const zone = lat > 58 ? 'north' : lat >= 48 ? 'center' : 'south';
    const need = zone === 'north' ? 150 : zone === 'center' ? 120 : 90;
    const date = zone === 'south' ? [1, 22] : [3, 22]; // 22 февраля или 22 апреля
    const cut = zone === 'south' ? 90 : 60; // первые/последние минуты после восхода/перед закатом не учитываются
    const r = this.day(winIn, y, date[0], date[1], tz, 1);
    const from = r.sunrise + cut, to = r.sunset - cut;
    const parts = r.intervals
      .map(([a, b]) => [Math.max(a, from), Math.min(b, to)])
      .filter(([a, b]) => b > a);
    const total = parts.reduce((s, [a, b]) => s + b - a, 0);
    const longest = parts.reduce((s, [a, b]) => Math.max(s, b - a), 0);
    let pass = longest >= need;
    let mode = 'continuous';
    if (!pass && parts.length > 1 && total >= need + 30 && longest >= 60) { pass = true; mode = 'broken'; }
    return { zone, need, date, total, longest, pass, mode, parts };
  }

  // Сравнение этажей: часов прямого солнца в год (по отсчётам каждые 4 дня)
  async floors(winIn, y, tz, onFloor, isStale) {
    const out = [];
    const lo = winIn.lo, hi = Math.min(winIn.hi, lo + 119);
    for (let f = lo; f <= hi; f++) {
      if (isStale?.()) return null;
      const w = { ...winIn, z: floorZ(f, winIn.fh), floor: f };
      const yr = this.year(w, y, tz, 15, 4);
      out.push({ floor: f, hours: yr.litHours });
      onFloor?.(out);
      if (f % 3 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  }
}

// Высота этажа берётся из данных дома: башня в 213 м и 52 этажа — это 4,1 м на этаж, а не типовые 3 м
export function floorsOf(b) {
  let fh = b.h / Math.max(1, b.levels);
  let top = b.levels;
  if (!(fh >= 2.6 && fh <= 6)) {
    // этажность не сходится с высотой — считаем по типовому этажу
    fh = LEVEL_H;
    top = Math.max(1, Math.round(b.h / LEVEL_H));
  }
  const lo = Math.floor(b.minH / fh + 0.01) + 1;
  return { lo, hi: Math.max(lo, top), fh };
}

// Высота центра окна над землёй
export function floorZ(floor, fh = LEVEL_H) {
  return (floor - 0.5) * fh;
}

function runs(state, value, step) {
  const out = [];
  let start = -1;
  for (let k = 0; k <= state.length; k++) {
    const on = k < state.length && state[k] === value;
    if (on && start < 0) start = k;
    if (!on && start >= 0) {
      out.push([start * step, k * step]);
      start = -1;
    }
  }
  return out;
}

// Где отрезок S→E входит в многоугольник (с дырами, правило чёт-нечет).
// Возвращает долю пути u∈[0,1] до входа или -1.
function segmentEnters(sx, sy, ex, ey, rings) {
  if (pointIn(sx, sy, rings)) return 0;
  const rx = ex - sx, ry = ey - sy;
  let best = 2;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const ax = r[j], ay = r[j + 1];
      const qx = r[i] - ax, qy = r[i + 1] - ay;
      const den = rx * qy - ry * qx;
      if (den === 0) continue;
      const wx = ax - sx, wy = ay - sy;
      const u = (wx * qy - wy * qx) / den;
      if (u < 0 || u > 1 || u >= best) continue;
      const v = (wx * ry - wy * rx) / den;
      if (v < 0 || v > 1) continue;
      best = u;
    }
  }
  return best <= 1 ? best : -1;
}

function pointIn(x, y, rings) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const yi = r[i + 1], yj = r[j + 1];
      if (yi > y !== yj > y && x < ((r[j] - r[i]) * (y - yi)) / (yj - yi) + r[i]) inside = !inside;
    }
  }
  return inside;
}

export { dayOfYear };
