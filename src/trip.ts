// The trip view: a dark map with each day's route, and the plan beside it.

import maplibregl, { type GeoJSONSource, type Map as MLMap, type Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { citySummary, nearbyAttractions, weather, weatherIcon, type Attraction, type Weather } from './api';
import { clock, packing, plan, type DayPlan, type Item, type Pace } from './planner';
import { $, addDays, esc, parseTrip, prettyDate, saveTrip, toast, tripHash, type TripParams } from './shared';

const DAY_COLORS = ['#5ef2d6', '#a48bff', '#ffb86b', '#6cc4ff', '#ff8fc8', '#c6f36b', '#ffd36b', '#8ff7e4', '#b9a8ff', '#ff9f8f'];

let map: MLMap | null = null;
let mapReady: Promise<void> = Promise.resolve();
let markers: Marker[] = [];
let trip: TripParams;
let days: DayPlan[] = [];
let active = 0;
let cache: { key: string; places: Attraction[]; weather: Weather | null; image?: string } | null = null;

export async function openTrip(hash: string): Promise<boolean> {
  const t = parseTrip(hash);
  if (!t) return false;
  trip = t;
  ensureMap();
  $('t-kicker').textContent = `${t.country ? `${t.country} · ` : ''}${prettyDate(t.start, { month: 'short', day: 'numeric' })} – ${prettyDate(addDays(t.start, t.days - 1), { month: 'short', day: 'numeric' })}`;
  $('t-title').innerHTML = `${t.days} days in <em>${esc(t.name)}</em>`;
  $('t-pace').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.pace === t.pace)));
  $<HTMLInputElement>('t-start').value = t.start;
  $('t-len').textContent = `${t.days} day${t.days > 1 ? 's' : ''}`;

  const key = `${t.lat},${t.lng}`;
  if (cache?.key !== key) {
    loading(true, `Finding the best of ${t.name}…`);
    $('t-timeline').innerHTML = '';
    map!.jumpTo({ center: [t.lng, t.lat], zoom: 11.5 });
    try {
      const [places, w, s] = await Promise.all([
        gather(t.lat, t.lng),
        weather(t.lat, t.lng).catch(() => null),
        citySummary({ name: t.name, country: t.country }).catch(() => null),
      ]);
      cache = { key, places, weather: w, image: s?.thumb };
    } catch {
      loading(true, 'Could not reach the map data. Check your connection and try again.');
      return true;
    }
    loading(false);
  }
  replan();
  return true;
}

/** Nearby places; if the centre is thin, look a little further out too. */
async function gather(lat: number, lng: number): Promise<Attraction[]> {
  const first = await nearbyAttractions(lat, lng);
  if (first.length >= 25) return first;
  const off = 0.09;
  const more = await Promise.allSettled(
    [[off, 0], [-off, 0], [0, off * 1.3], [0, -off * 1.3]].map(([a, b]) => nearbyAttractions(lat + a, lng + b)),
  );
  const all = new Map(first.map((p) => [p.id, p]));
  more.forEach((r) => r.status === 'fulfilled' && r.value.forEach((p) => all.has(p.id) || all.set(p.id, { ...p, dist: p.dist + 3 })));
  return [...all.values()];
}

function replan(): void {
  if (!cache) return;
  const dates = Array.from({ length: trip.days }, (_, i) => addDays(trip.start, i));
  const forecast = dates.map((dt) => cache!.weather?.days.find((x) => x.date === dt));
  const result = plan({
    attractions: cache.places,
    cityName: trip.name,
    center: { lat: trip.lat, lng: trip.lng },
    days: trip.days,
    pace: trip.pace,
    forecast,
    dates,
    removed: trip.removed,
  });
  days = result.days;
  if (active >= days.length) active = 0;
  const stops = days.reduce((n, d) => n + d.items.filter((i) => i.type === 'stop').length, 0);
  if (!stops) {
    $('t-timeline').innerHTML = `<li class="block">We couldn't find enough well-documented places around ${esc(trip.name)}. Try a nearby bigger city.</li>`;
  }
  renderDays();
  renderDay();
  renderPacking();
  drawRoutes();
}

// ---------- Plan panel ----------

function renderDays(): void {
  $('t-days').innerHTML = days
    .map((d, i) => {
      const w = d.weather;
      const label = d.date ? prettyDate(d.date, { weekday: 'short', day: 'numeric' }) : '';
      const wx = w ? `${weatherIcon(w.code).icon} ${Math.round(w.max)}°` : '—';
      return `<button class="day-tab" role="tab" aria-selected="${i === active}" data-i="${i}"><b><span class="dot" style="background:${DAY_COLORS[i % 10]}"></span>Day ${i + 1}</b>${label} · ${wx}</button>`;
    })
    .join('');
}

function renderDay(): void {
  const d = days[active];
  if (!d) return;
  const stops = d.items.filter((i): i is Extract<Item, { type: 'stop' }> => i.type === 'stop');
  const w = d.weather;
  const last = d.items[d.items.length - 1];
  const chips = [
    `${stops.length} stops`,
    `${d.walkKm.toFixed(1)} km on foot`,
    last ? `back by ${clock(last.end)}` : '',
    w ? `${weatherIcon(w.code).label} · ${Math.round(w.min)}–${Math.round(w.max)}°` : 'Forecast not out yet',
  ].filter(Boolean);
  $('t-summary').innerHTML =
    chips.map((c) => `<span>${esc(c)}</span>`).join('') + (w && w.rain >= 50 ? `<span class="wet">🌧 ${w.rain}% rain · indoor-first day</span>` : '');

  let n = 0;
  $('t-timeline').innerHTML = d.items
    .map((it, i) => {
      const delay = `style="animation-delay:${i * 60}ms"`;
      if (it.type === 'lunch') return `<li class="block" ${delay}>🍽 <b>${clock(it.start)}</b> Lunch nearby · 1 h</li>`;
      if (it.type === 'free') return `<li class="block" ${delay}>☕ <b>${clock(it.start)} – ${clock(it.end)}</b> ${esc(it.reason)}</li>`;
      n++;
      const s = it.stop;
      const legText = it.leg.mode === 'walk' ? `🚶 ${it.leg.minutes} min walk · ${it.leg.km.toFixed(1)} km` : `🚕 ${it.leg.minutes} min ride · ${it.leg.km.toFixed(1)} km`;
      const sunset = s.sunset && i === d.items.length - 1;
      const planB = it.planB
        ? `<div class="planb"><img src="${esc(it.planB.image)}" alt=""><span><b>Plan B if it pours:</b> ${esc(it.planB.title)}</span></div>`
        : '';
      return `<li><div class="leg">${legText}${n === 1 ? ' from the centre' : ''}</div>
        <div class="stop" data-id="${s.id}" ${delay}>
          <img src="${esc(s.image)}" alt="" loading="lazy">
          <div>
            <span class="time">${clock(it.start)} – ${clock(it.end)}</span>
            <b>${n}. ${esc(s.title)}</b>
            <p>${esc(s.description || 'A local favourite worth a look.')}</p>
            <div class="tags">
              <span class="tag ${s.kind === 'indoor' ? 'in' : ''}">${s.kind === 'indoor' ? '⌂ Indoor' : '☀ Outdoor'}</span>
              <span class="tag">${esc(s.tag)}</span>
              ${sunset ? '<span class="tag sun">🌅 Golden hour</span>' : ''}
              <button class="tag-btn" data-swap="${s.id}" title="Swap for another place">↻ Swap</button>
            </div>
          </div>
        </div>${planB}</li>`;
    })
    .join('');
  highlightDay();
}

function renderPacking(): void {
  const list = packing(days, trip.country !== 'Canada');
  $('t-packing').innerHTML = list.map((p) => `<li>${esc(p.item)}<span>${esc(p.why)}</span></li>`).join('');
}

function loading(on: boolean, text = ''): void {
  $('loading').hidden = !on;
  if (text) $('loading-text').textContent = text;
}

/** Changing pace or swapping a place updates the URL, which re-plans. */
function update(next: Partial<TripParams>): void {
  trip = { ...trip, ...next };
  history.replaceState(null, '', tripHash(trip));
  replan();
}

export function wireTrip(): void {
  $('t-back').onclick = () => (location.hash = '');
  const setLength = (n: number) => {
    const days = Math.min(10, Math.max(1, n));
    if (days !== trip.days) location.hash = tripHash({ ...trip, days });
  };
  $('t-minus').onclick = () => setLength(trip.days - 1);
  $('t-plus').onclick = () => setLength(trip.days + 1);
  $<HTMLInputElement>('t-start').onchange = (e) => {
    const start = (e.target as HTMLInputElement).value;
    if (start) location.hash = tripHash({ ...trip, start });
  };
  $('t-pace').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (b && b.dataset.pace !== trip.pace) update({ pace: b.dataset.pace as Pace });
  };
  $('t-days').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    active = Number(b.dataset.i);
    renderDays();
    renderDay();
    fitDay();
  };
  $('t-timeline').onclick = (e) => {
    const target = e.target as HTMLElement;
    const swap = target.closest<HTMLButtonElement>('[data-swap]');
    if (swap) {
      update({ removed: [...trip.removed, Number(swap.dataset.swap)] });
      toast('Swapped in another place');
      return;
    }
    const stop = target.closest<HTMLElement>('.stop');
    if (stop) focusStop(Number(stop.dataset.id));
  };
  $('t-timeline').onmouseover = (e) => {
    const stop = (e.target as HTMLElement).closest<HTMLElement>('.stop');
    markers.forEach((m) => m.getElement().classList.toggle('hl', m.getElement().dataset.id === stop?.dataset.id));
  };
  $('t-share').onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Link copied. Anyone with it sees this exact plan.');
    } catch {
      toast('Copy the address bar to share this plan');
    }
  };
  $('t-save').onclick = () => {
    saveTrip({ name: trip.name, country: trip.country, start: trip.start, days: trip.days, hash: tripHash(trip), image: cache?.image });
    toast(`Saved. Find it under My trips.`);
  };
}

// ---------- Map ----------

function ensureMap(): void {
  if (map) {
    map.resize();
    return;
  }
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/positron',
    center: [trip.lng, trip.lat],
    zoom: 11.5,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  mapReady = new Promise((resolve) => map!.once('load', () => resolve()));
  mapReady.then(darken);
}

/** Recolour the light basemap into a deep night palette. */
function darken(): void {
  const m = map!;
  for (const layer of m.getStyle().layers ?? []) {
    const id = layer.id;
    try {
      if (layer.type === 'background') m.setPaintProperty(id, 'background-color', '#070b1c');
      else if (layer.type === 'fill') {
        const color = /water/.test(id) ? '#0c1838' : /park|wood|grass|landcover/.test(id) ? '#0b1c22' : /building/.test(id) ? '#121834' : '#0a0f24';
        m.setPaintProperty(id, 'fill-color', color);
        if (/building/.test(id)) m.setPaintProperty(id, 'fill-outline-color', '#1a2246');
      } else if (layer.type === 'line') {
        const major = /motorway|trunk|primary|major/.test(id);
        m.setPaintProperty(id, 'line-color', /water|river/.test(id) ? '#13244d' : /boundary/.test(id) ? '#2c3566' : major ? '#2a3360' : '#1a2146');
      } else if (layer.type === 'symbol') {
        m.setPaintProperty(id, 'text-color', /place|city|town/.test(id) ? '#c9d4ff' : '#7f8bbd');
        m.setPaintProperty(id, 'text-halo-color', '#070b1c');
        m.setPaintProperty(id, 'icon-opacity', 0.25);
      }
    } catch {
      // some layers don't have that paint property
    }
  }
}

async function drawRoutes(): Promise<void> {
  await mapReady;
  const m = map!;
  const features = days.map((d, i) => ({
    type: 'Feature' as const,
    properties: { day: i, color: DAY_COLORS[i % 10] },
    geometry: {
      type: 'LineString' as const,
      coordinates: [[trip.lng, trip.lat], ...d.items.flatMap((it) => (it.type === 'stop' ? [[it.stop.lng, it.stop.lat]] : []))],
    },
  }));
  const data = { type: 'FeatureCollection' as const, features };
  const src = m.getSource('routes') as GeoJSONSource | undefined;
  if (src) src.setData(data);
  else {
    m.addSource('routes', { type: 'geojson', data });
    m.addLayer({ id: 'routes-glow', type: 'line', source: 'routes', paint: { 'line-color': ['get', 'color'], 'line-width': 10, 'line-blur': 8, 'line-opacity': 0.35 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    m.addLayer({ id: 'routes', type: 'line', source: 'routes', paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-dasharray': [1.5, 1.2] }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
  }

  markers.forEach((mk) => mk.remove());
  markers = [];
  const hotel = document.createElement('div');
  hotel.className = 'mpin';
  hotel.style.cssText = `width:18px;height:18px;background:#fff;box-shadow:0 0 0 6px rgba(255,255,255,.18),0 0 24px #fff`;
  hotel.title = `${trip.name} centre`;
  markers.push(new maplibregl.Marker({ element: hotel }).setLngLat([trip.lng, trip.lat]).addTo(m));
  days.forEach((d, di) => {
    let n = 0;
    d.items.forEach((it) => {
      if (it.type !== 'stop') return;
      n++;
      const el = document.createElement('div');
      el.className = 'mpin';
      el.dataset.id = String(it.stop.id);
      el.dataset.day = String(di);
      el.style.backgroundImage = `url("${it.stop.image.replace(/"/g, '%22')}")`;
      el.style.boxShadow = `0 0 0 5px ${DAY_COLORS[di % 10]}66, 0 10px 20px -6px rgba(0,0,0,.7)`;
      el.innerHTML = `<i style="background:${DAY_COLORS[di % 10]}">${n}</i>`;
      el.title = it.stop.title;
      el.onclick = () => {
        if (active !== di) {
          active = di;
          renderDays();
          renderDay();
        }
        focusStop(it.stop.id);
      };
      markers.push(new maplibregl.Marker({ element: el }).setLngLat([it.stop.lng, it.stop.lat]).addTo(m));
    });
  });
  highlightDay();
  fitDay();
}

function highlightDay(): void {
  if (!map?.getLayer('routes')) return;
  const op = ['case', ['==', ['get', 'day'], active], 1, 0.18] as unknown as number;
  map.setPaintProperty('routes', 'line-opacity', op);
  map.setPaintProperty('routes-glow', 'line-opacity', ['case', ['==', ['get', 'day'], active], 0.4, 0] as unknown as number);
  markers.forEach((mk) => {
    const el = mk.getElement();
    if (el.dataset.day) {
      el.style.opacity = el.dataset.day === String(active) ? '1' : '0.35';
      el.style.zIndex = el.dataset.day === String(active) ? '2' : '1';
    }
  });
}

function fitDay(): void {
  const d = days[active];
  if (!map || !d) return;
  const pts = d.items.flatMap((it) => (it.type === 'stop' ? [[it.stop.lng, it.stop.lat] as [number, number]] : []));
  if (!pts.length) return;
  const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
  pts.forEach((p) => b.extend(p));
  b.extend([trip.lng, trip.lat]);
  const wide = innerWidth > 860;
  map.fitBounds(b, {
    padding: wide ? { left: 500, right: 80, top: 80, bottom: 80 } : { left: 40, right: 40, top: 60, bottom: innerHeight * 0.6 },
    maxZoom: 15,
    duration: 1400,
  });
}

function focusStop(id: number): void {
  const mk = markers.find((m) => m.getElement().dataset.id === String(id));
  if (!mk || !map) return;
  map.flyTo({ center: mk.getLngLat(), zoom: 15, duration: 1200, offset: innerWidth > 860 ? [220, 0] : [0, -innerHeight * 0.25] });
  markers.forEach((m) => m.getElement().classList.toggle('hl', m === mk));
  document.querySelectorAll('.stop').forEach((s) => s.classList.toggle('hl', (s as HTMLElement).dataset.id === String(id)));
  document.querySelector(`.stop[data-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function resizeMap(): void {
  map?.resize();
}
