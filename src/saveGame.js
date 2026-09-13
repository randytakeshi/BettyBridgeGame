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
