// Live data from free, key-less sources:
// Photon (OpenStreetMap search), Wikipedia (photos, summaries, nearby places)
// and Open-Meteo (weather, sunrise, sunset, time zone).

export interface Place {
  name: string;
  country: string;
  region?: string;
  lat: number;
  lng: number;
}

export interface Summary {
  title: string;
  extract: string;
  image?: string;
  thumb?: string;
}

export interface Day {
  date: string;
  code: number;
  max: number;
  min: number;
  rain: number;
  sunrise: string;
  sunset: string;
}

export interface Weather {
  timezone: string;
  nowTemp: number;
  nowCode: number;
  days: Day[];
}

export interface Attraction {
  id: number;
  title: string;
  description: string;
  lat: number;
  lng: number;
  image: string;
  dist: number;
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

/** City search, for the "Where to next?" box. */
export async function searchPlaces(q: string): Promise<Place[]> {
  type Photon = {
    features: { geometry: { coordinates: [number, number] }; properties: Record<string, string> }[];
  };
  const data = await json<Photon>(
    `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en&osm_tag=place`,
  );
  const seen = new Set<string>();
  return data.features
    .map((f) => ({
      name: f.properties.name,
      country: f.properties.country ?? '',
      region: f.properties.state,
      lng: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }))
    .filter((p) => {
      const key = `${p.name}|${p.country}`;
      if (!p.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Wikipedia summary with a photo. Tries "City, Region" style titles too. */
export async function citySummary(place: Pick<Place, 'name' | 'region' | 'country'>): Promise<Summary | null> {
  const titles = [place.name, place.region && `${place.name}, ${place.region}`, `${place.name}, ${place.country}`]
    .filter(Boolean) as string[];
  for (const t of titles) {
    try {
      type S = { title: string; extract: string; type: string; thumbnail?: { source: string }; originalimage?: { source: string } };
      const s = await json<S>(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}`);
      if (s.type === 'disambiguation') continue;
      return {
        title: s.title,
        extract: s.extract,
        thumb: s.thumbnail?.source,
        image: s.thumbnail?.source?.replace(/\/\d+px-/, '/960px-') ?? s.originalimage?.source,
      };
    } catch {
      // try the next title
    }
  }
  return null;
}

/** Weather for the next 16 days, with sunrise/sunset in local time. */
export async function weather(lat: number, lng: number): Promise<Weather> {
  type M = {
    timezone: string;
    current: { temperature_2m: number; weather_code: number };
    daily: {
      time: string[];
      weather_code: number[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_probability_max: (number | null)[];
      sunrise: string[];
      sunset: string[];
    };
  };
  const m = await json<M>(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      '&current=temperature_2m,weather_code' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset' +
      '&timezone=auto&forecast_days=16',
  );
  return {
    timezone: m.timezone,
    nowTemp: m.current.temperature_2m,
    nowCode: m.current.weather_code,
    days: m.daily.time.map((date, i) => ({
      date,
      code: m.daily.weather_code[i],
      max: m.daily.temperature_2m_max[i],
      min: m.daily.temperature_2m_min[i],
      rain: m.daily.precipitation_probability_max[i] ?? 0,
      sunrise: m.daily.sunrise[i],
      sunset: m.daily.sunset[i],
    })),
  };
}

/** Notable places near a point, from Wikipedia, with a photo each. */
export async function nearbyAttractions(lat: number, lng: number, radius = 10000): Promise<Attraction[]> {
  type Q = {
    query?: {
      pages: Record<string, {
        pageid: number;
        title: string;
        description?: string;
        coordinates?: { lat: number; lon: number }[];
        thumbnail?: { source: string };
        index?: number;
      }>;
    };
  };
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*' +
    `&generator=geosearch&ggscoord=${lat}|${lng}&ggsradius=${radius}&ggslimit=80` +
    '&prop=coordinates|pageimages|description&piprop=thumbnail&pithumbsize=480&pilimit=80';
  const data = await json<Q>(url);
  const pages = Object.values(data.query?.pages ?? {});
  return pages
    .filter((p) => p.coordinates?.[0] && p.thumbnail)
    .map((p) => {
      const c = p.coordinates![0];
      return {
        id: p.pageid,
        title: p.title,
        description: p.description ?? '',
        lat: c.lat,
        lng: c.lon,
        image: p.thumbnail!.source,
        dist: distanceKm(lat, lng, c.lat, c.lon),
      };
    });
}

export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** WMO weather code to a small icon and label. */
export function weatherIcon(code: number): { icon: string; label: string } {
  if (code === 0) return { icon: '☀', label: 'Clear' };
  if (code <= 2) return { icon: '⛅', label: 'Partly cloudy' };
  if (code === 3) return { icon: '☁', label: 'Cloudy' };
  if (code <= 48) return { icon: '🌫', label: 'Fog' };
  if (code <= 67 || (code >= 80 && code <= 82)) return { icon: '🌧', label: 'Rain' };
  if (code <= 77 || code === 85 || code === 86) return { icon: '❄', label: 'Snow' };
  return { icon: '⛈', label: 'Storm' };
}
