/**
 * Keeping Betty's place.
 *
 * The iPad sleeps, Safari drops the page, she closes the tab by accident —
 * and without this the board and the running score are simply gone, which
 * looks exactly like the game breaking. Everything needed to put her back
 * where she was goes into local storage after every move.
 *
 * Storage can throw (private browsing, a full quota), and a half-written
 * save must never wedge the game, so every path here fails quietly and the
 * game just starts a fresh board instead.
 */

const KEY = 'bettybridge.save.v1';

export function loadSavedGame() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export function saveGame(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Out of quota or storage is blocked — play on without saving
  }
}

export function clearSavedGame() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do
  }
}

/**
 * Settings, kept apart from the board so that starting a new game never
 * resets how she likes to play.
 */
const PREFS_KEY = 'bettybridge.prefs.v1';

// Bumped when a setting's default changes and a stored answer would quietly
// go on overriding it. Betty decided she does not want weak twos, but her
// iPad had already saved that they were on, so the new default would never
// have reached her. Settings she actually chose are kept; only the ones
// listed here fall back to the new default.
const PREFS_GENERATION = 2;
const RESET_ON_UPGRADE = ['weakTwos'];

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return {};
    if (data.gen === PREFS_GENERATION) return data;
    const migrated = { ...data, gen: PREFS_GENERATION };
    for (const key of RESET_ON_UPGRADE) delete migrated[key];
    return migrated;
  } catch {
    return {};
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, gen: PREFS_GENERATION }));
  } catch {
    // Play on without remembering
  }
}
