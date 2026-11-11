// Address lookup for the site form. Nominatim (OpenStreetMap) needs no key and is
// acceptable for a demo; a Google Geocoding key can be plugged in later by setting
// GOOGLE_MAPS_API_KEY on a project with that API enabled.
// Public demo: the identifying string carries the project address, never a personal contact.
const UA = 'SiteAssistant/0.1 (site management demo; +https://github.com/AS76/SiteAssistant)';
const MIN_QUERY = 3;
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

export async function searchPlaces(query, { fetchImpl = fetch, apiKey = process.env.GOOGLE_MAPS_API_KEY, now = Date.now() } = {}) {
  const text = String(query || '').trim();
  if (text.length < MIN_QUERY) return [];
  const key = `${apiKey ? 'g' : 'o'}:${text.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL) return hit.value;
  let value = [];
  if (apiKey) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(text)}&language=it&key=${apiKey}`;
    try {
      const response = await fetchImpl(url);
      const payload = await response.json();
      value = payload.status === 'OK'
        ? payload.results.slice(0, 6).map(row => ({ label: row.formatted_address, lat: row.geometry.location.lat, lon: row.geometry.location.lng }))
        : [];
    } catch { value = []; }
  }
  if (!value.length) {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=it&q=${encodeURIComponent(text)}`;
    try {
      const response = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      const payload = await response.json();
      value = (Array.isArray(payload) ? payload : []).map(row => ({ label: row.display_name, lat: Number(row.lat), lon: Number(row.lon) }));
    } catch { value = []; }
  }
  cache.set(key, { at: now, value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}
