// The smart planner. Pure functions, no DOM, so every step is testable:
//   1. rank the places worth visiting
//   2. split them into days by area (balanced k-means)
//   3. give rainy days the most indoor places
//   4. order each day into a short route (nearest neighbour + 2-opt)
//   5. schedule it: travel legs, lunch, and a lake or viewpoint at sunset
//   6. offer an indoor Plan B for outdoor stops on rainy days

import { distanceKm, type Attraction, type Day } from './api';

export type Pace = 'slow' | 'balanced' | 'packed';
export type Kind = 'indoor' | 'outdoor';

export interface Stop extends Attraction {
  kind: Kind;
  minutes: number;
  sunset: boolean;
  score: number;
  tag: string;
}

export interface Leg {
  mode: 'walk' | 'ride';
  km: number;
  minutes: number;
}

export type Item =
  | { type: 'stop'; stop: Stop; start: number; end: number; leg: Leg; planB?: Stop }
  | { type: 'lunch'; start: number; end: number }
  | { type: 'free'; start: number; end: number; reason: string };

export interface DayPlan {
  index: number;
  date?: string;
  weather?: Day;
  items: Item[];
  walkKm: number;
}

export const STOPS_PER_DAY: Record<Pace, number> = { slow: 3, balanced: 4, packed: 5 };

const SKIP =
  /school|college|universit|hospital|station|airport|district|village|neighbourhood|suburb|constituency|company|bank|hotel|road|street|highway|tehsil|railway|stadium|census|assembly|lok sabha|municipal|human settlement|city in|town in|area of|locality|ward |cemetery|power plant|dam |office|court|prison|embassy|consulate|apartment|residential|campus|metro|tram|bus /i;

const KINDS: { re: RegExp; tag: string; kind: Kind; minutes: number; weight: number; sunset?: boolean }[] = [
  { re: /museum|gallery/i, tag: 'Museum', kind: 'indoor', minutes: 120, weight: 4 },
  { re: /palace|haveli|mansion|château|chateau/i, tag: 'Palace', kind: 'indoor', minutes: 110, weight: 5 },
  { re: /castle|fort|citadel/i, tag: 'Fort', kind: 'outdoor', minutes: 120, weight: 5, sunset: true },
  { re: /temple|mandir|shrine|gurdwara|pagoda|stupa/i, tag: 'Temple', kind: 'indoor', minutes: 50, weight: 4 },
  { re: /cathedral|church|basilica|chapel|mosque|masjid|synagogue|abbey/i, tag: 'Sacred site', kind: 'indoor', minutes: 45, weight: 4 },
  { re: /lake|lagoon|ghat|waterfront|promenade/i, tag: 'Lake', kind: 'outdoor', minutes: 60, weight: 4, sunset: true },
  { re: /beach|bay|coast/i, tag: 'Beach', kind: 'outdoor', minutes: 90, weight: 4, sunset: true },
  { re: /viewpoint|lookout|hill|peak|mount/i, tag: 'Viewpoint', kind: 'outdoor', minutes: 60, weight: 4, sunset: true },
  { re: /waterfall|falls|gorge|canyon/i, tag: 'Nature', kind: 'outdoor', minutes: 90, weight: 4 },
  { re: /garden|park|botanical|zoo/i, tag: 'Garden', kind: 'outdoor', minutes: 75, weight: 3 },
  { re: /market|bazaar|souk|mall/i, tag: 'Market', kind: 'outdoor', minutes: 75, weight: 3 },
  { re: /bridge|tower|gate|square|plaza|monument|memorial|statue|arch/i, tag: 'Landmark', kind: 'outdoor', minutes: 40, weight: 3 },
  { re: /theatre|theater|opera|aquarium|library/i, tag: 'Culture', kind: 'indoor', minutes: 90, weight: 3 },
];

/** Decides what kind of place this is and how long to spend there. */
export function classify(a: Attraction): Stop | null {
  const text = `${a.title} ${a.description}`;
  if (SKIP.test(text)) return null;
  const k = KINDS.find((x) => x.re.test(text));
  const weight = k?.weight ?? 1;
  return {
    ...a,
    kind: k?.kind ?? 'outdoor',
    minutes: k?.minutes ?? 60,
    sunset: Boolean(k?.sunset),
    tag: k?.tag ?? 'Sight',
    score: weight + (a.description ? 1 : 0) - a.dist * 0.18,
  };
}

/** The best places, without near-duplicates (two pages for the same spot). */
export function rank(list: Attraction[], cityName = ''): Stop[] {
  const stops = list
    .filter((a) => a.title.toLowerCase() !== cityName.toLowerCase())
    .map(classify)
    .filter((s): s is Stop => s !== null)
    .sort((a, b) => b.score - a.score);
  const kept: Stop[] = [];
  for (const s of stops) {
    if (!kept.some((k) => distanceKm(k.lat, k.lng, s.lat, s.lng) < 0.08)) kept.push(s);
  }
  return kept;
}

type P = { lat: number; lng: number };
const d = (a: P, b: P) => distanceKm(a.lat, a.lng, b.lat, b.lng);

/**
 * Splits points into k groups by area, with group sizes kept even
 * (no day with 7 stops while another has 1).
 */
export function balancedClusters<T extends P>(points: T[], k: number): T[][] {
  if (k <= 1 || points.length <= k) return k <= 1 ? [points.slice()] : points.map((p) => [p]);
  // Farthest-point start, so it's deterministic and well spread.
  const centers: P[] = [points[0]];
  while (centers.length < k) {
    let best = points[0];
    let bestD = -1;
    for (const p of points) {
      const nd = Math.min(...centers.map((c) => d(c, p)));
      if (nd > bestD) {
        bestD = nd;
        best = p;
      }
    }
    centers.push({ lat: best.lat, lng: best.lng });
  }
  const cap = Math.ceil(points.length / k);
  let groups: T[][] = [];
  for (let iter = 0; iter < 12; iter++) {
    groups = centers.map(() => []);
    // Points that care most about their nearest centre choose first.
    const order = points
      .map((p) => {
        const ds = centers.map((c) => d(c, p)).sort((a, b) => a - b);
        return { p, regret: (ds[1] ?? 0) - ds[0] };
      })
      .sort((a, b) => b.regret - a.regret);
    for (const { p } of order) {
      const byDist = centers.map((c, i) => ({ i, dist: d(c, p) })).sort((a, b) => a.dist - b.dist);
      const slot = byDist.find((x) => groups[x.i].length < cap) ?? byDist[0];
      groups[slot.i].push(p);
    }
    groups.forEach((g, i) => {
      if (g.length) {
        centers[i] = {
          lat: g.reduce((s, p) => s + p.lat, 0) / g.length,
          lng: g.reduce((s, p) => s + p.lng, 0) / g.length,
        };
      }
    });
  }
  return groups.filter((g) => g.length);
}

function routeLength<T extends P>(route: T[], start?: P): number {
  let total = start && route[0] ? d(start, route[0]) : 0;
  for (let i = 1; i < route.length; i++) total += d(route[i - 1], route[i]);
  return total;
}

/** Short route through the points: nearest neighbour, then 2-opt clean-up. */
export function orderRoute<T extends P>(points: T[], start: P): T[] {
  const left = points.slice();
  const route: T[] = [];
  let at: P = start;
  while (left.length) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (d(at, left[i]) < d(at, left[bi])) bi = i;
    at = left[bi];
    route.push(left.splice(bi, 1)[0]);
  }
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < route.length - 1; i++) {
      for (let j = i + 1; j < route.length; j++) {
        const next = route.slice(0, i).concat(route.slice(i, j + 1).reverse(), route.slice(j + 1));
        if (routeLength(next, start) + 1e-9 < routeLength(route, start)) {
          route.splice(0, route.length, ...next);
          improved = true;
        }
      }
    }
  }
  return route;
}

/** Walk short hops, ride longer ones. */
export function leg(from: P, to: P): Leg {
  const km = d(from, to);
  return km <= 2
    ? { mode: 'walk', km, minutes: Math.max(3, Math.round((km / 4.5) * 60)) }
    : { mode: 'ride', km, minutes: Math.round((km / 22) * 60) + 6 };
}

/** Minutes since midnight from an ISO local time like "2027-01-12T17:58". */
export function minutesOf(iso: string): number {
  const [h, m] = iso.slice(11, 16).split(':').map(Number);
  return h * 60 + m;
}

export function clock(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = Math.round(min % 60);
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** Times for one day: start at 9, lunch around 12:30, save the sunset spot for golden hour. */
export function schedule(route: Stop[], hotel: P, sunsetMin = 18 * 60): Item[] {
  const items: Item[] = [];
  let t = 9 * 60;
  let at: P = hotel;
  let lunched = false;
  route.forEach((stop, i) => {
    const l = leg(at, stop);
    t += l.minutes;
    if (!lunched && t >= 12 * 60 + 30) {
      items.push({ type: 'lunch', start: t, end: t + 60 });
      t += 60;
      lunched = true;
    }
    const last = i === route.length - 1;
    if (last && stop.sunset && t < sunsetMin - 75) {
      items.push({ type: 'free', start: t, end: sunsetMin - 75, reason: 'Free time before golden hour' });
      t = sunsetMin - 75;
    }
    items.push({ type: 'stop', stop, start: t, end: t + stop.minutes, leg: l });
    t += stop.minutes;
    at = stop;
  });
  return items;
}

export interface PlanInput {
  attractions: Attraction[];
  cityName: string;
  center: P;
  days: number;
  pace: Pace;
  /** Weather for each trip day, when the forecast reaches that far. */
  forecast?: (Day | undefined)[];
  dates?: string[];
  removed?: number[];
}

export function plan(input: PlanInput): { days: DayPlan[]; pool: Stop[] } {
  const ranked = rank(input.attractions, input.cityName).filter((s) => !input.removed?.includes(s.id));
  const want = input.days * STOPS_PER_DAY[input.pace];
  const chosen = ranked.slice(0, want);
  const pool = ranked.slice(want);
  const groups = balancedClusters(chosen, Math.min(input.days, Math.max(1, chosen.length)));

  // Rainiest days get the groups with the most indoor places.
  const indoorShare = (g: Stop[]) => g.filter((s) => s.kind === 'indoor').length / g.length;
  const dayOrder = Array.from({ length: input.days }, (_, i) => i).sort(
    (a, b) => (input.forecast?.[b]?.rain ?? 0) - (input.forecast?.[a]?.rain ?? 0),
  );
  const groupOrder = groups.slice().sort((a, b) => indoorShare(b) - indoorShare(a));
  const byDay: Stop[][] = Array.from({ length: input.days }, () => []);
  dayOrder.forEach((dayIndex, i) => (byDay[dayIndex] = groupOrder[i] ?? []));

  const used = new Set<number>();
  const days = byDay.map((group, index) => {
    const w = input.forecast?.[index];
    let route = orderRoute(group, input.center);
    const sunsetSpot = route.find((s) => s.sunset);
    if (sunsetSpot) route = route.filter((s) => s !== sunsetSpot).concat(sunsetSpot);
    const items = schedule(route, input.center, w ? minutesOf(w.sunset) : 18 * 60);
    if (w && w.rain >= 50) {
      for (const it of items) {
        if (it.type !== 'stop' || it.stop.kind !== 'outdoor') continue;
        const alt = pool
          .filter((p) => p.kind === 'indoor' && !used.has(p.id))
          .sort((a, b) => d(a, it.stop) - d(b, it.stop))[0];
        if (alt) {
          it.planB = alt;
          used.add(alt.id);
        }
      }
    }
    const walkKm = items.reduce((s, it) => s + (it.type === 'stop' && it.leg.mode === 'walk' ? it.leg.km : 0), 0);
    return { index, date: input.dates?.[index], weather: w, items, walkKm };
  });
  return { days, pool };
}

/** A packing list that follows the forecast and the kind of places you'll visit. */
export function packing(days: DayPlan[], international: boolean): { item: string; why: string }[] {
  const list: { item: string; why: string }[] = [];
  const ws = days.map((x) => x.weather).filter((w): w is Day => Boolean(w));
  const minT = ws.length ? Math.min(...ws.map((w) => w.min)) : null;
  const maxT = ws.length ? Math.max(...ws.map((w) => w.max)) : null;
  const rainy = ws.filter((w) => w.rain >= 40).length;
  const stops = days.flatMap((x) => x.items).filter((i): i is Extract<Item, { type: 'stop' }> => i.type === 'stop');
  const walk = Math.max(0, ...days.map((x) => x.walkKm));
  if (international) list.push({ item: 'Passport and visa', why: 'International trip' });
  if (minT !== null && minT < 15) list.push({ item: 'Warm layer', why: `Down to ${Math.round(minT)}° at night` });
  if (minT !== null && minT < 3) list.push({ item: 'Gloves and a hat', why: 'Near freezing' });
  if (maxT !== null && maxT > 27) list.push({ item: 'Sunscreen and sunglasses', why: `Up to ${Math.round(maxT)}°` });
  if (rainy) list.push({ item: 'Umbrella', why: `Rain likely on ${rainy} day${rainy > 1 ? 's' : ''}` });
  if (stops.some((s) => s.stop.tag === 'Temple' || s.stop.tag === 'Sacred site')) {
    list.push({ item: 'Scarf or shawl', why: 'Cover shoulders at sacred sites' });
  }
  if (walk > 4) list.push({ item: 'Comfy walking shoes', why: `Up to ${walk.toFixed(1)} km on foot a day` });
  if (stops.some((s) => s.stop.tag === 'Beach')) list.push({ item: 'Swimwear', why: 'Beach on the plan' });
  list.push({ item: 'Power bank', why: 'Maps and photos all day' });
  return list;
}
