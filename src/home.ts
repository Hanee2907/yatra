// The home screen: a living 3D globe with flight arcs from home,
// photo pins, live clocks, a world tour and the destination card.

import { update as updateTweens } from '@tweenjs/tween.js';
import Globe, { type GlobeInstance } from 'globe.gl';
import { citySummary, distanceKm, searchPlaces, weather, weatherIcon, type Place, type Weather } from './api';
import type { Pace } from './planner';
import { $, HOME, addDays, commons, esc, isoDay, prettyDate, savedTrips, tripHash } from './shared';

interface Dest extends Place {
  id: string;
  photo?: string; // Commons path for the featured places
  image?: string; // full URL once known
  tz?: string;
}

const FEATURED: Dest[] = [
  { id: 'udaipur', name: 'Udaipur', country: 'India', region: 'Rajasthan', lat: 24.58, lng: 73.68, tz: 'Asia/Kolkata', photo: '6/6f/Evening_view%2C_City_Palace%2C_Udaipur.jpg' },
  { id: 'kyoto', name: 'Kyoto', country: 'Japan', lat: 35.01, lng: 135.77, tz: 'Asia/Tokyo', photo: '0/0f/Golden_Pavilion_Kinkaku-ji_water_mirror_2024.jpg' },
  { id: 'santorini', name: 'Santorini', country: 'Greece', lat: 36.42, lng: 25.43, tz: 'Europe/Athens', photo: '3/37/Oia_sunset_-_panoramio_%282%29.jpg' },
  { id: 'banff', name: 'Banff', country: 'Canada', region: 'Alberta', lat: 51.18, lng: -115.57, tz: 'America/Edmonton', photo: 'c/c5/Moraine_Lake_17092005.jpg' },
  { id: 'marrakech', name: 'Marrakesh', country: 'Morocco', lat: 31.63, lng: -7.99, tz: 'Africa/Casablanca', photo: '7/79/Djemaa_el_Fna.jpg' },
];
const HOME_PHOTO = '8/8b/Toronto_Skyline_from_Snake_Island%2C_September_11_2026_%2801%29.jpg';
const IMG = './textures/';
const MINT = '#5ef2d6';
const VIOLET = '#a48bff';

const thumb = (d: Dest) => d.image ?? (d.photo ? commons(d.photo, 120) : '');

let world: GlobeInstance;
let dests: Dest[] = FEATURED.slice();
let selected: Dest | null = null;
let days = 4;
let pace: Pace = 'balanced';
let cardWeather: Weather | null = null;
let started = false;

export function startHome(): void {
  if (started) {
    resume();
    return;
  }
  started = true;
  buildGlobe();
  wireSearch();
  wireCard();
  wireTrips();
  renderChips();
  headlineSwap();
  clocks();
  tour();
  updateTripCount();
}

/** Called when coming back from a trip. */
function resume(): void {
  world.resumeAnimation();
  world.width(innerWidth).height(innerHeight);
  updateTripCount();
}

export function pauseHome(): void {
  world?.pauseAnimation();
}

// ---------- Globe ----------

function buildGlobe(): void {
  const el = $('globe');
  world = (Globe as unknown as () => (el: HTMLElement) => GlobeInstance)()(el)
    .width(innerWidth)
    .height(innerHeight)
    .globeImageUrl(IMG + 'earth-blue-marble.jpg')
    .bumpImageUrl(IMG + 'earth-topology.png')
    .backgroundImageUrl(IMG + 'night-sky.png')
    .showAtmosphere(true)
    .atmosphereColor('#7fe9ff')
    .atmosphereAltitude(0.24)
    .arcColor((a: object) =>
      (a as Dest).id === selected?.id ? [MINT, VIOLET] : ['rgba(94,242,214,.06)', 'rgba(94,242,214,.6)'],
    )
    .arcStroke((a: object) => ((a as Dest).id === selected?.id ? 1.15 : 0.45))
    .arcDashLength(0.45)
    .arcDashGap(0.18)
    .arcDashAnimateTime(2600)
    .arcAltitudeAutoScale(0.42)
    .ringColor(() => (t: number) => `rgba(94,242,214,${1 - t})`)
    .ringMaxRadius(3.2)
    .ringPropagationSpeed(1.6)
    .ringRepeatPeriod(1400)
    .htmlAltitude(0.02)
    .htmlElement((o: object) => {
      const d = o as Dest & { home?: boolean };
      const pin = document.createElement('div');
      pin.className = 'pin' + (d.home ? ' home' : '');
      pin.dataset.id = d.id;
      pin.innerHTML = `<img src="${esc(d.home ? commons(HOME_PHOTO, 120) : thumb(d))}" alt=""><span>${esc(d.home ? 'Home · Toronto' : d.name)}</span>`;
      if (!d.home) pin.onclick = () => select(d);
      return pin;
    });
  refreshGlobeData();
  if (import.meta.env.DEV) (window as unknown as { world: GlobeInstance }).world = world;

  const controls = world.controls();
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.45;
  world.pointOfView({ lat: 28, lng: 10, altitude: wide() ? 2.3 : 3 });
  addEventListener('resize', () => world.width(innerWidth).height(innerHeight));
  // Sit the globe beside the headline on wide screens.
  const shift = () => (el.style.transform = wide() ? 'translateX(14%)' : 'translateY(30%)');
  shift();
  addEventListener('resize', shift);
  hideBackPins();
}

const wide = () => innerWidth > 860;

function refreshGlobeData(): void {
  world
    .arcsData(dests.map((d) => ({ id: d.id, startLat: HOME.lat, startLng: HOME.lng, endLat: d.lat, endLng: d.lng })))
    .ringsData([HOME, ...dests])
    .htmlElementsData([{ ...HOME, id: 'home', home: true }, ...dests]);
}

function restyleArcs(): void {
  world.arcColor(world.arcColor()).arcStroke(world.arcStroke());
  document.querySelectorAll<HTMLElement>('.pin').forEach((p) => p.classList.toggle('on', p.dataset.id === selected?.id));
}

/** globe.gl draws HTML pins even on the far side, so hide those each frame. */
function hideBackPins(): void {
  const el = $('globe');
  const getCoords = (world as unknown as { getCoords: (a: number, b: number, c: number) => { x: number; y: number; z: number } }).getCoords;
  const tick = () => {
    if (!$('home').hidden) {
      const cam = world.camera().position;
      const camLen = Math.hypot(cam.x, cam.y, cam.z);
      for (const d of [{ ...HOME, id: 'home' }, ...dests]) {
        const p = getCoords(d.lat, d.lng, 0);
        const facing = (p.x * cam.x + p.y * cam.y + p.z * cam.z) / (Math.hypot(p.x, p.y, p.z) * camLen);
        const pin = el.querySelector<HTMLElement>(`.pin[data-id="${d.id}"]`);
        if (pin) {
          const show = facing > 0.15;
          pin.style.opacity = show ? '1' : '0';
          pin.style.pointerEvents = show ? 'auto' : 'none';
        }
      }
    }
    // globe.gl starts camera flights on the shared tween group, which its renderer no longer updates.
    updateTweens();
    requestAnimationFrame(tick);
  };
  tick();
}

// ---------- Selecting a destination ----------

async function select(d: Dest): Promise<void> {
  if (!dests.some((x) => x.id === d.id)) {
    dests = [...FEATURED, d];
    refreshGlobeData();
  }
  selected = d;
  world.controls().autoRotate = false;
  restyleArcs();
  world.pointOfView(wide() ? { lat: d.lat - 4, lng: d.lng + 34, altitude: 1.25 } : { lat: d.lat - 18, lng: d.lng, altitude: 1.7 }, 2200);
  $('hero').classList.add('away');
  $('clocks').style.opacity = '0';
  fillCard(d);
  setTimeout(() => selected === d && $('card').classList.add('on'), 700);
}

function closeCard(): void {
  selected = null;
  $('card').classList.remove('on');
  $('hero').classList.remove('away');
  $('clocks').style.opacity = '1';
  restyleArcs();
  world.pointOfView({ lat: 28, lng: 10, altitude: wide() ? 2.3 : 3 }, 1800);
  setTimeout(() => !selected && (world.controls().autoRotate = true), 1800);
}

let cardToken = 0;
async function fillCard(d: Dest): Promise<void> {
  const token = ++cardToken;
  const img = $<HTMLImageElement>('c-img');
  img.src = d.photo ? commons(d.photo, 960) : d.image ?? '';
  img.alt = d.name;
  $('c-kicker').textContent = `${d.country || 'Somewhere new'} · from ${HOME.name}`;
  $('c-name').textContent = d.name;
  $('c-extract').textContent = 'Reading about it…';
  const km = distanceKm(HOME.lat, HOME.lng, d.lat, d.lng);
  const flight = km < 300 ? `${Math.max(1, Math.round(km / 80))} h drive` : `≈ ${Math.round(km / 830 + 0.6)} h flight`;
  renderFacts([['Getting there', flight], ['Local time', '…'], ['Right now', '…'], ['Sunset', '…']]);
  $('c-week').innerHTML = '';
  cardWeather = null;

  const [summary, w] = await Promise.allSettled([citySummary(d), weather(d.lat, d.lng)]);
  if (token !== cardToken) return;
  if (summary.status === 'fulfilled' && summary.value) {
    const firstTwo = summary.value.extract.split(/(?<=\.)\s+/).slice(0, 2).join(' ');
    $('c-extract').textContent = firstTwo;
    if (!d.photo && summary.value.image) {
      img.src = summary.value.image;
      d.image = summary.value.thumb;
      refreshGlobeData();
      restyleArcs();
    }
  } else {
    $('c-extract').textContent = `${d.name}${d.region ? `, ${d.region}` : ''} — let's see what's worth your days there.`;
  }
  if (w.status === 'fulfilled') {
    cardWeather = w.value;
    d.tz = w.value.timezone;
    const today = w.value.days[0];
    const local = new Date().toLocaleTimeString('en-US', { timeZone: w.value.timezone, hour: 'numeric', minute: '2-digit' });
    const sunset = new Date(today.sunset).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    renderFacts([
      ['Getting there', flight],
      ['Local time', local],
      ['Right now', `${Math.round(w.value.nowTemp)}° ${weatherIcon(w.value.nowCode).icon}`],
      ['Sunset', sunset],
    ]);
    renderWeek();
  }
}

function renderFacts(facts: [string, string][]): void {
  $('c-facts').innerHTML = facts.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');
}

/** Seven forecast days from the chosen start date, with rainy ones tinted. */
function renderWeek(): void {
  const start = $<HTMLInputElement>('c-start').value;
  const list = cardWeather?.days.filter((x) => x.date >= start).slice(0, 7) ?? [];
  $('c-week').innerHTML = list.length
    ? list
        .map((x, i) => {
          const inTrip = i < days;
          return `<div class="${x.rain >= 50 ? 'rain' : ''}" style="${inTrip ? '' : 'opacity:.45'}" title="${weatherIcon(x.code).label}, ${x.rain}% rain">${prettyDate(x.date, { weekday: 'narrow' })}<b>${weatherIcon(x.code).icon}</b>${Math.round(x.max)}°</div>`;
        })
        .join('')
    : '';
}

function wireCard(): void {
  const start = $<HTMLInputElement>('c-start');
  start.value = addDays(isoDay(new Date()), 7);
  start.min = isoDay(new Date());
  start.onchange = renderWeek;
  const setDays = (n: number) => {
    days = Math.min(10, Math.max(1, n));
    $('c-days').textContent = `${days} day${days > 1 ? 's' : ''}`;
    renderWeek();
  };
  $('c-minus').onclick = () => setDays(days - 1);
  $('c-plus').onclick = () => setDays(days + 1);
  setDays(days);
  $('c-pace').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    pace = b.dataset.pace as Pace;
    $('c-pace').querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  };
  $('c-close').onclick = () => {
    stopTour();
    closeCard();
  };
  $('c-plan').onclick = () => {
    if (!selected) return;
    stopTour();
    location.hash = tripHash({
      name: selected.name,
      country: selected.country,
      lat: selected.lat,
      lng: selected.lng,
      start: start.value || isoDay(new Date()),
      days,
      pace,
      removed: [],
    });
  };
  addEventListener('keydown', (e) => e.key === 'Escape' && selected && !$('home').hidden && closeCard());
}

// ---------- Search ----------

function wireSearch(): void {
  const input = $<HTMLInputElement>('q');
  const results = $('results');
  let found: Place[] = [];
  let timer = 0;
  let token = 0;

  const show = () => {
    results.hidden = !found.length;
    results.innerHTML = found
      .map((p, i) => `<li><button type="button" data-i="${i}">${esc(p.name)} <small>${esc([p.region, p.country].filter(Boolean).join(', '))}</small></button></li>`)
      .join('');
  };
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      found = [];
      return show();
    }
    const t = ++token;
    try {
      const list = await searchPlaces(q);
      if (t === token) {
        found = list;
        show();
      }
    } catch {
      // keep the old results if the search hiccups
    }
  };
  const pick = (p: Place) => {
    found = [];
    show();
    input.value = '';
    input.blur();
    stopTour();
    const featured = FEATURED.find((f) => f.name === p.name && f.country === p.country);
    select(featured ?? { ...p, id: `q-${p.lat.toFixed(2)}-${p.lng.toFixed(2)}` });
  };

  input.oninput = () => {
    clearTimeout(timer);
    timer = window.setTimeout(run, 250);
  };
  $('search').onsubmit = async (e) => {
    e.preventDefault();
    if (!found.length) await run();
    if (found[0]) pick(found[0]);
  };
  results.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (b) pick(found[Number(b.dataset.i)]);
  };
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.hero')) results.hidden = true;
  });
}

function renderChips(): void {
  $('chips').innerHTML = FEATURED.map((d) => `<button data-id="${d.id}"><img src="${thumb(d)}" alt="">${d.name}</button>`).join('');
  $('chips').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    stopTour();
    select(FEATURED.find((f) => f.id === b.dataset.id)!);
  };
}

// ---------- Attention: headline, clocks, tour ----------

function headlineSwap(): void {
  const swap = $('swap');
  let i = 1;
  setInterval(() => {
    if ($('home').hidden) return;
    swap.classList.add('out');
    setTimeout(() => {
      i = (i + 1) % FEATURED.length;
      swap.textContent = `${FEATURED[i].name}.`;
      swap.classList.remove('out');
    }, 450);
  }, 2600);
}

/** Local time and light in a few places, using real sunrise and sunset. */
function clocks(): void {
  const shown = FEATURED.slice(0, 3);
  const sun = new Map<string, { rise: number; set: number }>();
  shown.forEach((d) =>
    weather(d.lat, d.lng)
      .then((w) => {
        const t = w.days[0];
        const mins = (iso: string) => Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
        sun.set(d.id, { rise: mins(t.sunrise), set: mins(t.sunset) });
        draw();
      })
      .catch(() => undefined),
  );
  const phase = (d: Dest, min: number) => {
    const s = sun.get(d.id) ?? { rise: 6 * 60 + 30, set: 18 * 60 + 30 };
    if (min < s.rise - 30 || min > s.set + 30) return 'night';
    if (min < s.rise + 60) return 'sunrise';
    if (min > s.set - 60) return 'golden hour';
    return 'daytime';
  };
  const draw = () => {
    const now = new Date();
    $('clocks').innerHTML = shown
      .map((d) => {
        const time = now.toLocaleTimeString('en-US', { timeZone: d.tz, hour: 'numeric', minute: '2-digit' });
        const [h, m] = now.toLocaleTimeString('en-GB', { timeZone: d.tz, hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
        return `<div class="clock glass"><img src="${thumb(d)}" alt=""><div><b>${d.name}</b> <span>${time}</span><br><i>${phase(d, h * 60 + m)}</i></div></div>`;
      })
      .join('');
  };
  draw();
  setInterval(draw, 20000);
}

let touring = true;
let tourTimer = 0;

function tour(): void {
  const el = $('tour');
  const next = $('tour-next');
  let i = 0;
  const step = () => {
    if (!touring) return;
    if (!$('home').hidden) select(FEATURED[i % FEATURED.length]);
    i++;
    next.textContent = `next: ${FEATURED[i % FEATURED.length].name}`;
    el.classList.remove('run');
    void el.offsetWidth;
    el.classList.add('run');
    tourTimer = window.setTimeout(step, 7000);
  };
  next.textContent = `first: ${FEATURED[0].name}`;
  el.style.setProperty('--tour-ms', '5000ms');
  el.classList.add('run');
  tourTimer = window.setTimeout(() => {
    el.style.setProperty('--tour-ms', '7000ms');
    step();
  }, 5000);
  $('globe').addEventListener('pointerdown', stopTour);
  $('q').addEventListener('focus', stopTour);
  el.onclick = () => {
    if (touring) return stopTour();
    touring = true;
    $('tour-label').textContent = '✦ World tour';
    step();
  };
}

function stopTour(): void {
  if (!touring) return;
  touring = false;
  clearTimeout(tourTimer);
  $('tour').classList.remove('run');
  $('tour-label').textContent = '✦ Tour paused';
  $('tour-next').textContent = 'tap to resume';
}

// ---------- Saved trips ----------

function updateTripCount(): void {
  $('trip-count').textContent = String(savedTrips().length);
}

function wireTrips(): void {
  const pop = $('trips-pop');
  $('nav-trips').onclick = (e) => {
    e.stopPropagation();
    const list = savedTrips();
    pop.innerHTML = list.length
      ? list
          .map((t) => `<a href="${esc(t.hash)}"><span><b>${esc(t.name)}</b><br><small>${esc(t.country)}</small></span><small>${prettyDate(t.start, { month: 'short', day: 'numeric' })} · ${t.days} d</small></a>`)
          .join('')
      : '<p>No saved trips yet. Pick a city, plan it, and hit Save.</p>';
    pop.hidden = !pop.hidden;
  };
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('#trips-pop')) pop.hidden = true;
  });
}
