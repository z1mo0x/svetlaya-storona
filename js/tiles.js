// Загрузка квартала: сначала свои тайлы (GitHub Pages), если город покрыт; иначе — OSM API.
import { CONFIG } from './config.js';
import { tilesForBox, decodeTile, mergeFeatures } from './tile-format.js';
import { fetchOSM, elementsToFeatures, makeProjection } from './osm.js';

// ?data=http://localhost:5174/_tiles — подменить источник тайлов при проверке
const base = (new URLSearchParams(location.search).get('data') || CONFIG.dataUrl || '').replace(/\/$/, '');
let manifestP = null;

function manifest() {
  if (!base) return Promise.resolve(null);
  manifestP ??= fetch(`${base}/index.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return manifestP;
}

function boxAround(lat, lon, half) {
  const p = makeProjection(lat, lon);
  const dLat = half / p.mLat, dLon = half / p.mLon;
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

async function fromTiles(box, { signal, onProgress }) {
  const m = await manifest();
  if (!m) return null;
  const [w, s, e, n] = box;
  const covered = (m.cities || []).some(({ bbox: [cw, cs, ce, cn] }) => w >= cw && s >= cs && e <= ce && n <= cn);
  if (!covered) return null;
  const list = tilesForBox(w, s, e, n);
  let done = 0;
  const parts = await Promise.all(list.map(async ([ix, iy]) => {
    const r = await fetch(`${base}/t/${ix}/${iy}.json`, { signal });
    onProgress?.(++done / list.length);
    if (r.status === 404) return null; // пустой тайл: поле, вода
    if (!r.ok) throw new Error(`Тайл ${ix}/${iy}: ${r.status}`);
    return decodeTile(await r.json(), ix, iy);
  }));
  return mergeFeatures(parts.filter(Boolean));
}

// → { features, source: 'tiles' | 'osm' }
export async function loadFeatures(lat, lon, half = 470, opts = {}) {
  try {
    const f = await fromTiles(boxAround(lat, lon, half), opts);
    if (f) return { features: f, source: 'tiles' };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn('Тайлы недоступны, загружаем из OSM API', e.message || e);
  }
  const els = await fetchOSM(lat, lon, half, opts);
  return { features: elementsToFeatures(els), source: 'osm' };
}
