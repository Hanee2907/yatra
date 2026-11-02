import './style.css';
import { pauseHome, startHome } from './home';
import { $ } from './shared';
import { openTrip, resizeMap, wireTrip } from './trip';

wireTrip();

/** #trip?… shows a plan; anything else shows the globe. */
async function route(): Promise<void> {
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
