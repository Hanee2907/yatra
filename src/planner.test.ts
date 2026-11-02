import { describe, expect, it } from 'vitest';
import type { Attraction, Day } from './api';
import { balancedClusters, classify, clock, leg, orderRoute, packing, plan, rank, schedule } from './planner';

const at = (id: number, title: string, lat: number, lng: number, description = ''): Attraction => ({
  id, title, description, lat, lng, image: 'x.jpg', dist: 1,
});

describe('classify and rank', () => {
  it('knows what kind of place it is', () => {
    expect(classify(at(1, 'City Palace', 0, 0, 'palace in Udaipur'))!.kind).toBe('indoor');
    expect(classify(at(2, 'Lake Pichola', 0, 0, 'artificial lake'))!.sunset).toBe(true);
    expect(classify(at(3, 'Udaipur railway station', 0, 0))).toBeNull();
  });

  it('drops the city itself and near-duplicates', () => {
    const r = rank([at(1, 'Udaipur', 0, 0), at(2, 'Jag Mandir', 24.57, 73.68, 'palace'), at(3, 'Jag Mandir Palace', 24.5701, 73.6801, 'palace')], 'Udaipur');
    expect(r.map((s) => s.id)).toEqual([2]);
  });
});

describe('balancedClusters', () => {
  it('splits two far-apart areas into two even days', () => {
    const west = [0, 1, 2].map((i) => at(i, `w${i}`, 10, 10 + i * 0.001));
    const east = [3, 4, 5].map((i) => at(i, `e${i}`, 10, 11 + i * 0.001));
    const groups = balancedClusters([...west, ...east], 2);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.length === 3)).toBe(true);
    expect(groups.every((g) => g.every((p) => p.title[0] === g[0].title[0]))).toBe(true);
  });

  it('never makes one day much heavier than another', () => {
    const pts = Array.from({ length: 10 }, (_, i) => at(i, `p${i}`, 10 + (i < 8 ? 0 : 1), 10 + i * 0.0001));
    const sizes = balancedClusters(pts, 2).map((g) => g.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });
});

describe('orderRoute', () => {
  it('visits points in a sensible line instead of zig-zagging', () => {
    const pts = [at(1, 'c', 0, 0.02), at(2, 'a', 0, 0), at(3, 'd', 0, 0.03), at(4, 'b', 0, 0.01)];
    const r = orderRoute(pts, { lat: 0, lng: -0.01 });
    expect(r.map((p) => p.title).join('')).toBe('abcd');
  });
});

describe('leg and schedule', () => {
  it('walks short hops and rides long ones', () => {
    expect(leg({ lat: 0, lng: 0 }, { lat: 0, lng: 0.01 }).mode).toBe('walk');
    expect(leg({ lat: 0, lng: 0 }, { lat: 0, lng: 0.1 }).mode).toBe('ride');
  });

  it('adds lunch and keeps the sunset spot for golden hour', () => {
    const stops = [
      classify(at(1, 'City Museum', 0, 0.001, 'museum'))!,
      classify(at(2, 'Old Fort', 0, 0.002, 'fort'))!,
      classify(at(3, 'Sunset Lake', 0, 0.003, 'lake'))!,
    ];
    const items = schedule(stops, { lat: 0, lng: 0 }, 18 * 60);
    expect(items.some((i) => i.type === 'lunch')).toBe(true);
    const lake = items.find((i) => i.type === 'stop' && i.stop.id === 3)!;
    expect(lake.start).toBe(18 * 60 - 75);
    expect(clock(lake.start)).toBe('4:45 pm');
  });
});

const day = (rain: number): Day => ({ date: '2027-01-12', code: rain > 50 ? 61 : 0, max: 29, min: 12, rain, sunrise: '2027-01-12T07:00', sunset: '2027-01-12T18:00' });

describe('plan', () => {
  const places = [
    at(1, 'Royal Museum', 10, 10, 'museum'), at(2, 'Grand Palace', 10, 10.002, 'palace'), at(3, 'Old Temple', 10, 10.004, 'temple'),
    at(4, 'Blue Lake', 10, 10.3, 'lake'), at(5, 'Rose Garden', 10, 10.302, 'garden'), at(6, 'High Fort', 10, 10.304, 'fort'),
    at(7, 'Art Gallery', 10, 10.01, 'gallery'), at(8, 'Spice Market', 10, 10.31, 'market'),
  ];

  it('gives the rainy day the indoor area', () => {
    const { days } = plan({ attractions: places, cityName: 'X', center: { lat: 10, lng: 10.15 }, days: 2, pace: 'balanced', forecast: [day(0), day(80)] });
    const indoor = (i: number) => days[i].items.filter((x) => x.type === 'stop' && x.stop.kind === 'indoor').length;
    expect(indoor(1)).toBeGreaterThan(indoor(0));
  });

  it('respects the pace and removed places', () => {
    const { days } = plan({ attractions: places, cityName: 'X', center: { lat: 10, lng: 10.15 }, days: 2, pace: 'slow', removed: [1] });
    const ids = days.flatMap((x) => x.items).flatMap((i) => (i.type === 'stop' ? [i.stop.id] : []));
    expect(ids).toHaveLength(6);
    expect(ids).not.toContain(1);
  });

  it('builds a packing list from the forecast and the places', () => {
    const { days } = plan({ attractions: places, cityName: 'X', center: { lat: 10, lng: 10.15 }, days: 2, pace: 'balanced', forecast: [day(0), day(80)] });
    const items = packing(days, true).map((p) => p.item);
    expect(items).toContain('Passport and visa');
    expect(items).toContain('Umbrella');
    expect(items).toContain('Scarf or shawl');
    expect(items).toContain('Sunscreen and sunglasses');
  });
});
