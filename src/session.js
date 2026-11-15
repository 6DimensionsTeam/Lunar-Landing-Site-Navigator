// The user's choices, kept in localStorage so a refresh on any page can rebuild where they were.
const KEY = 'lln-session-v1';

export function loadSession() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}

export function saveSession(patch) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...loadSession(), ...patch })); } catch { /* storage blocked */ }
}
