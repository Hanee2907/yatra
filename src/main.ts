import './style.css';
import { pauseHome, startHome } from './home';
import { $, toast, tripHash } from './shared';
import { openTrip, resizeMap, wireTrip } from './trip';

wireTrip();

/** #t/<id> opens a saved trip, #trip?… shows a plan, anything else shows the globe. */
async function route(): Promise<void> {
  if (location.hash.startsWith('#t/')) {
    const id = location.hash.slice(3);
    const { loadCloudTrip } = await import('./cloud');
    const saved = await loadCloudTrip(id).catch(() => null);
    if (saved) {
      history.replaceState(null, '', tripHash(saved));
    } else {
      toast("That trip link doesn't exist any more");
      history.replaceState(null, '', location.pathname);
    }
  }
  const isTrip = location.hash.startsWith('#trip?');
  $('home').hidden = isTrip;
  $('trip').hidden = !isTrip;
  if (isTrip) {
    pauseHome();
    const ok = await openTrip(location.hash);
    if (ok) {
      resizeMap();
      return;
    }
    location.hash = '';
    return;
  }
  startHome();
}

addEventListener('hashchange', route);
route();
