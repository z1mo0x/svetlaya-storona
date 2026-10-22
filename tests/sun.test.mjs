// Положение солнца сверяем с геометрией: в истинный полдень высота = 90° − широта ± наклон оси (23,44°)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunPosition, localToUTC, guessUtcOffset } from '../js/sun.js';

const DEG = 180 / Math.PI;
const MOSCOW = [55.7558, 37.6173];

// Максимум высоты за день с шагом в минуту — это и есть истинный полдень
function noon(y, m, d, lat, lon, tz) {
  let best = { alt: -Infinity };
  for (let min = 600; min <= 900; min++) {
    const p = sunPosition(localToUTC(y, m, d, min, tz), lat, lon);
    if (p.alt > best.alt) best = { ...p, min };
  }
  return { alt: best.alt * DEG, az: best.az * DEG, min: best.min };
}

test('летнее солнцестояние в Москве: высота в полдень ≈ 57,7°, солнце на юге', () => {
  const n = noon(2026, 5, 21, ...MOSCOW, 3);
  assert.ok(Math.abs(n.alt - (90 - MOSCOW[0] + 23.44)) < 0.3, `высота ${n.alt}`);
  assert.ok(Math.abs(n.az - 180) < 2, `азимут ${n.az}`);
});

test('зимнее солнцестояние в Москве: высота в полдень ≈ 10,8°', () => {
  const n = noon(2026, 11, 22, ...MOSCOW, 3);
  assert.ok(Math.abs(n.alt - (90 - MOSCOW[0] - 23.44)) < 0.3, `высота ${n.alt}`);
});

test('ночью солнце под горизонтом', () => {
  const p = sunPosition(localToUTC(2026, 11, 22, 0, 3), ...MOSCOW);
  assert.ok(p.alt < 0);
});

test('часовые пояса РФ по региону', () => {
  assert.equal(guessUtcOffset(56.84, 60.6, 'Свердловская область', 'ru').offset, 5);
  assert.equal(guessUtcOffset(56.48, 84.95, 'Томская область', 'ru').offset, 7);
  assert.equal(guessUtcOffset(54.99, 73.37, 'Омская область', 'ru').offset, 6);
  assert.equal(guessUtcOffset(55.75, 37.6, 'Москва', 'ru').offset, 3);
});
