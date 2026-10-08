// Подсказки адресов: Photon (komoot) — быстрый геокодер по данным OSM с поддержкой CORS.

const PHOTON = 'https://photon.komoot.io/api/';

export async function suggest(query, { signal, near } = {}) {
  const params = new URLSearchParams({ q: query, limit: '7' });
  if (near) {
    params.set('lat', near.lat);
    params.set('lon', near.lon);
  }
  const res = await fetch(`${PHOTON}?${params}`, { signal });
  if (!res.ok) throw new Error(`Геокодер ответил ${res.status}`);
  const data = await res.json();
  const seen = new Set();
  return data.features
    .map((f) => {
      const p = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      const line1 = [p.street, p.housenumber].filter(Boolean).join(', ') || p.name || '';
      const place = p.city || p.town || p.village || p.district || '';
      const line2 = [p.name && p.street ? p.name : '', place, p.state !== place ? p.state : '', p.country]
        .filter(Boolean)
        .join(' · ');
      return {
        title: line1 || place,
        subtitle: line2,
        lat,
        lon,
        region: p.state || p.city || '',
        country: p.countrycode || p.country || '',
        isHouse: !!p.housenumber || p.osm_key === 'building',
      };
    })
    .filter((r) => {
      const k = `${r.title}|${r.subtitle}`;
      if (!r.title || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.isHouse - a.isHouse);
}
