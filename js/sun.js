// Положение солнца (классические формулы низкой точности, ~0.1°) и часовые пояса.

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;

const toDays = (ms) => ms / DAY_MS - 0.5 + J1970 - J2000;

function sunCoords(d) {
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  return {
    dec: Math.asin(Math.sin(OBLIQUITY) * Math.sin(L)),
    ra: Math.atan2(Math.sin(L) * Math.cos(OBLIQUITY), Math.cos(L)),
  };
}

// Возвращает высоту над горизонтом и азимут (от севера по часовой стрелке), в радианах.
export function sunPosition(ms, lat, lon) {
  const d = toDays(ms);
  const phi = RAD * lat;
  const c = sunCoords(d);
  const H = RAD * (280.16 + 360.9856235 * d) + RAD * lon - c.ra;
  const alt = Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H));
  const azS = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(c.dec) * Math.cos(phi));
  return { alt, az: azS + Math.PI };
}

// Единичный вектор на солнце: x — восток, y — север, z — вверх.
export function sunVector(alt, az) {
  const ch = Math.cos(alt);
  return [Math.sin(az) * ch, Math.cos(az) * ch, Math.sin(alt)];
}

// Местное время (минуты от полуночи) → миллисекунды UTC
export function localToUTC(y, m, d, minutes, offsetH) {
  return Date.UTC(y, m, d, 0, 0) + minutes * 60000 - offsetH * 3600000;
}

// ---------- Часовые пояса ----------
// Внешние сервисы часовых поясов из России доступны не всегда, поэтому для регионов РФ — таблица.
const RU_TZ = [
  [2, /калинингр/],
  [4, /самар|удмурт|ульянов|саратов|астрахан/],
  [5, /башкор|курган|оренбург|перм|свердлов|тюмен|челяб|ханты|югр|ямал/],
  [7, /алтай|кемеров|кузбасс|красноярск|новосибирск|томск|хакас|тыва|тува/],
  [6, /(^|[^т])омск/],
  [8, /иркутск|бурят/],
  [9, /забайкал|амурск|якут|саха/],
  [10, /приморск|хабаровск|еврейск|владивосток/],
  [11, /магадан|сахалин/],
  [12, /камчат|чукот/],
];

export function guessUtcOffset(lat, lon, region = '', country = '') {
  const r = region.toLowerCase();
  const isRU = /^ru$/i.test(country) || /россия|russia/i.test(country);
  if (isRU || (lon > 19 && lon < 180 && lat > 41 && lat < 82 && r)) {
    for (const [off, re] of RU_TZ) if (re.test(r)) return { offset: off, exact: true };
    if (isRU) return { offset: 3, exact: true };
  }
  return { offset: Math.round(lon / 15), exact: false };
}

export function formatOffset(o) {
  return `UTC${o >= 0 ? '+' : '−'}${Math.abs(o)}`;
}

// ---------- Даты ----------
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа',
  'сентября', 'октября', 'ноября', 'декабря'];
export const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export function dayOfYear(y, m, d) {
  return Math.round((Date.UTC(y, m, d) - Date.UTC(y, 0, 1)) / DAY_MS);
}
export function dateFromDoy(y, doy) {
  const t = new Date(Date.UTC(y, 0, 1) + doy * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}
export function fmtTime(min) {
  min = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
export function fmtDur(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} мин`;
  if (!m) return `${h} ч`;
  return `${h} ч ${m} мин`;
}
