// Saved trips in Firestore. Each visitor gets a quiet anonymous sign-in, so saving needs no account.
// A trip document holds only what is needed to rebuild the plan; places and weather are fetched fresh.

import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, type User } from 'firebase/auth';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { firebaseConfig } from './firebase-config';
import type { Pace } from './planner';
import type { TripParams } from './shared';

export interface CloudTrip extends TripParams {
  id: string;
  owner: string;
  image: string;
}

export const cloudReady = Boolean(firebaseConfig.apiKey);

const app = cloudReady ? initializeApp(firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;

let userPromise: Promise<User> | null = null;

/** The visitor's anonymous account, created the first time it's needed and kept by Firebase after that. */
function user(): Promise<User> {
  if (!auth) return Promise.reject(new Error('Cloud saving is not set up'));
  userPromise ??= new Promise<User>((resolve, reject) => {
    const stop = onAuthStateChanged(auth, (u) => {
      if (u) {
        stop();
        resolve(u);
      }
    });
    signInAnonymously(auth).catch((e) => {
      stop();
      userPromise = null;
      reject(e);
    });
  });
  return userPromise;
}

export async function currentUid(): Promise<string | null> {
  try {
    return (await user()).uid;
  } catch {
    return null;
  }
}

function toDoc(t: TripParams, image: string) {
  return {
    name: t.name.slice(0, 120),
    country: t.country.slice(0, 80),
    lat: t.lat,
    lng: t.lng,
    start: t.start,
    days: t.days,
    pace: t.pace,
    removed: t.removed.slice(0, 200),
    image: image.slice(0, 600),
  };
}

/**
 * Saves the trip. If it is already yours, the saved copy is updated; if it is someone else's
 * (a friend opened your link and changed it), a new copy is saved under their name.
 */
export async function saveCloudTrip(t: TripParams, image = ''): Promise<string> {
  const me = await user();
  const trips = collection(db!, 'trips');
  if (t.id) {
    const existing = await getDoc(doc(trips, t.id));
    if (existing.exists() && existing.data().owner === me.uid) {
      await updateDoc(existing.ref, { ...toDoc(t, image), updated: serverTimestamp() });
      return t.id;
    }
  }
  const ref = await addDoc(trips, { ...toDoc(t, image), owner: me.uid, created: serverTimestamp(), updated: serverTimestamp() });
  return ref.id;
}

export async function loadCloudTrip(id: string): Promise<CloudTrip | null> {
  if (!db) return null;
  const snap = await getDoc(doc(db, 'trips', id));
  if (!snap.exists()) return null;
  const d = snap.data();
  return {
    id,
    owner: String(d.owner),
    name: String(d.name),
    country: String(d.country ?? ''),
    lat: Number(d.lat),
    lng: Number(d.lng),
    start: String(d.start),
    days: Number(d.days),
    pace: (['slow', 'balanced', 'packed'].includes(d.pace) ? d.pace : 'balanced') as Pace,
    removed: Array.isArray(d.removed) ? d.removed.map(Number) : [],
    image: String(d.image ?? ''),
  };
}

/** Trips this visitor has saved, newest first. */
export async function myCloudTrips(): Promise<CloudTrip[]> {
  const me = await user();
  const snap = await getDocs(query(collection(db!, 'trips'), where('owner', '==', me.uid)));
  const list = snap.docs.map((s) => ({ s, at: s.data().updated?.toMillis?.() ?? 0 }));
  list.sort((a, b) => b.at - a.at);
  return Promise.all(list.map(({ s }) => loadCloudTrip(s.id))).then((x) => x.filter((t): t is CloudTrip => t !== null));
}

export async function deleteCloudTrip(id: string): Promise<void> {
  await user();
  await deleteDoc(doc(db!, 'trips', id));
}
