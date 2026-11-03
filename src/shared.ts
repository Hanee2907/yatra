// Small helpers shared by the globe and the trip view.

import type { Pace } from './planner';

export const HOME = { name: 'Toronto', country: 'Canada', lat: 43.65, lng: -79.38 };

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Wikimedia Commons thumbnail at a given width. */
export const commons = (path: string, width: number) =>
  `https://upload.wikimedia.org/wikipedia/commons/thumb/${path}/${width}px-${path.split('/').pop()}`;

export interface TripParams {
  name: string;
  country: string;
  lat: number;
  lng: number;
  start: string;
  days: number;
  pace: Pace;
  removed: number[];
  /** Set once the trip is saved to the cloud. */
  id?: string;
}

export function tripHash(t: TripParams): string {
  const q = new URLSearchParams({
    n: t.name,
    c: t.country,
    lat: t.lat.toFixed(4),
    lng: t.lng.toFixed(4),
    s: t.start,
    d: String(t.days),
    p: t.pace,
  });
  if (t.removed.length) q.set('r', t.removed.join(','));
  if (t.id) q.set('id', t.id);
  return `#trip?${q}`;
}

export function parseTrip(hash: string): TripParams | null {
  if (!hash.startsWith('#trip?')) return null;
  const q = new URLSearchParams(hash.slice(6));
  const lat = Number(q.get('lat'));
  const lng = Number(q.get('lng'));
  if (!q.get('n') || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const pace = q.get('p');
  return {
    name: q.get('n')!,
    country: q.get('c') ?? '',
    lat,
    lng,
    start: q.get('s') || isoDay(new Date()),
    days: Math.min(10, Math.max(1, Number(q.get('d')) || 3)),
    pace: pace === 'slow' || pace === 'packed' ? pace : 'balanced',
    removed: (q.get('r') ?? '').split(',').map(Number).filter(Boolean),
    id: q.get('id') || undefined,
  };
}

export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

export function prettyDate(iso: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', opts);
}

// ---------- Saved trips ----------

export interface SavedTrip {
  name: string;
  country: string;
  start: string;
  days: number;
  hash: string;
  image?: string;
}

const KEY = 'yatra-trips';

export function savedTrips(): SavedTrip[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as SavedTrip[];
  } catch {
    return [];
  }
}

export function saveTrip(t: SavedTrip): void {
  const list = savedTrips().filter((x) => !(x.name === t.name && x.start === t.start));
  list.unshift(t);
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 12)));
  } catch {
    // storage full or blocked; nothing else to do
  }
}

let toastTimer = 0;
export function toast(msg: string): void {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('on'), 2600);
}
