// Правила разбора тегов OpenStreetMap: что считать домом, дорогой, парком, водой.
// Этот же файл копируется в репозиторий тайлов (svetlaya-storona-data/lib) — правьте здесь
// и синхронизируйте командой node tools/sync-data-lib.mjs.

export function num(v) {
  if (v == null) return NaN;
  const m = String(v).replace(',', '.').match(/-?\d+(\.\d+)?/g);
  if (!m) return NaN;
  return Math.max(...m.map(Number));
}

const SKIP_BUILDING = new Set(['no', 'entrance', 'underground', 'collapsed', 'demolished', 'razed']);

export function isBuilding(t) {
  return !!t && ((t.building && !SKIP_BUILDING.has(t.building)) ||
    (t['building:part'] && t['building:part'] !== 'no')) && t.location !== 'underground' &&
    !(num(t.layer) < 0 && !t.height && !t['building:levels']);
}

export function isPart(t) {
  return !!t['building:part'] && !t.building;
}

// Только теги, нужные для высоты и подписей, — тайлы от этого заметно меньше
const BUILDING_TAGS = ['building', 'building:part', 'height', 'min_height', 'building:levels', 'building:min_level',
  'roof:levels', 'name', 'addr:street', 'addr:housenumber'];

export function pickBuildingTags(t) {
  const out = {};
  for (const k of BUILDING_TAGS) if (t[k] != null) out[k] = t[k];
  return out;
}

export const ROAD_W = {
  motorway: 22, trunk: 20, primary: 16, secondary: 13, tertiary: 11, unclassified: 8,
  residential: 8, living_street: 6, service: 4.5, pedestrian: 6, track: 3.5, busway: 8,
  motorway_link: 9, trunk_link: 9, primary_link: 9, secondary_link: 8, tertiary_link: 7,
  footway: 2.4, path: 2, cycleway: 2.4, steps: 2.4, bridleway: 2,
};
const RAIL = new Set(['rail', 'light_rail', 'tram', 'subway', 'monorail']);

// Дорога или рельсы: { kind, w, bridge } или null
export function roadOf(t) {
  if (t.highway && ROAD_W[t.highway] && t.area !== 'yes' && t.tunnel !== 'yes' && t.covered !== 'yes' &&
      t.tunnel !== 'building_passage') {
    return { kind: t.highway, w: num(t.width) > 0 ? Math.min(num(t.width), 40) : ROAD_W[t.highway], bridge: t.bridge === 'yes' };
  }
  if (t.railway && RAIL.has(t.railway) && t.tunnel !== 'yes') {
    return { kind: 'rail', w: t.railway === 'tram' ? 2.2 : 3.4, bridge: t.bridge === 'yes' };
  }
  return null;
}

export function areaKind(t) {
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
