/* ---------------------------------------------------------------
   KickOff Division — local password gate
   A client-side access gate. The password is salted and hashed
   (PBKDF2-SHA256 when crypto.subtle is available) and stored in
   localStorage. This is NOT server-side security: anyone with
   access to the browser can bypass or reset it.
   --------------------------------------------------------------- */
'use strict';

const AUTH_KEY = 'kickoff_auth';
const AUTH_SESSION_KEY = 'kickoff_auth_session';
const AUTH_ITERATIONS = 150000;
const AUTH_MIN_LENGTH = 6;

/* ---------- helpers ---------- */

function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function randomHex(byteCount) {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function cryptoAvailable() {
  return typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.deriveBits === 'function';
}

/** PBKDF2-SHA256 → hex digest. */
async function pbkdf2Hash(password, saltHex) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: AUTH_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

/**
 * Fallback hash for non-secure contexts (e.g. file://) where crypto.subtle
 * is unavailable. Salted, but NOT cryptographically secure.
 */
function fallbackHash(password, saltHex) {
  const input = saltHex + '|' + password;
  let h1 = 0xdeadbeef ^ saltHex.length;
  let h2 = 0x41c6ce57 ^ saltHex.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/* ---------- credential storage ---------- */

function getCredential() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

async function createCredential(password) {
  const algo = cryptoAvailable() ? 'pbkdf2' : 'fallback';
  const salt = randomHex(16);
  const hash = algo === 'pbkdf2'
    ? await pbkdf2Hash(password, salt)
    : fallbackHash(password, salt);

  const credential = {
    v: 1,
    algo,
    iterations: algo === 'pbkdf2' ? AUTH_ITERATIONS : 0,
    salt,
    hash,
    createdAt: new Date().toISOString()
  };
  localStorage.setItem(AUTH_KEY, JSON.stringify(credential));
  return credential;
}

/** Returns true/false, or null when the credential can't be checked (no crypto.subtle). */
async function verifyPassword(password, credential) {
  let candidate;
  if (credential.algo === 'pbkdf2') {
    if (!cryptoAvailable()) return null;
    candidate = await pbkdf2Hash(password, credential.salt);
  } else {
    candidate = fallbackHash(password, credential.salt);
  }

  if (candidate.length !== credential.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate.charCodeAt(i) ^ credential.hash.charCodeAt(i);
  }
  return diff === 0;
}

/* ---------- session ---------- */

function startSession(credential) {
  sessionStorage.setItem(AUTH_SESSION_KEY, credential.hash);
}

function endSession() {
  sessionStorage.removeItem(AUTH_SESSION_KEY);
}

function sessionValid(credential) {
  return sessionStorage.getItem(AUTH_SESSION_KEY) === credential.hash;
}

/* ---------- UI state ---------- */

function setAuthError(elementId, key) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (!key) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.textContent = t(key);
  el.classList.remove('hidden');
}

function clearAuthErrors() {
  ['setup-error', 'login-error', 'pw-error'].forEach(id => setAuthError(id, null));
}

function lockApp(panel) {
  document.body.classList.add('locked');
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('auth-setup-panel').classList.toggle('hidden', panel !== 'setup');
  document.getElementById('auth-login-panel').classList.toggle('hidden', panel !== 'login');
  clearAuthErrors();

  const focusId = panel === 'setup' ? 'setup-password' : 'login-password';
  const input = document.getElementById(focusId);
  if (input) input.focus();

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function unlockApp() {
  document.body.classList.remove('locked');
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('form-auth-setup').reset();
  document.getElementById('form-auth-login').reset();
  clearAuthErrors();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

/* ---------- flows ---------- */

/** Decide what the user sees on load: setup, login, or unlocked app. */
function initAuth() {
  const credential = getCredential();
  if (!credential) lockApp('setup');
  else if (sessionValid(credential)) unlockApp();
  else lockApp('login');
}

async function handleSetup(e) {
  e.preventDefault();
  const password = document.getElementById('setup-password').value;
  const confirmation = document.getElementById('setup-confirm').value;

  if (password.length < AUTH_MIN_LENGTH) { setAuthError('setup-error', 'authTooShort'); return; }
  if (password !== confirmation) { setAuthError('setup-error', 'authMismatch'); return; }

  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    const credential = await createCredential(password);
    startSession(credential);
    unlockApp();
  } catch (err) {
    setAuthError('setup-error', 'authUnsupported');
  } finally {
    button.disabled = false;
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const password = document.getElementById('login-password').value;
  const credential = getCredential();
  if (!credential) { initAuth(); return; }

  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    const result = await verifyPassword(password, credential);
    if (result === null) {
      setAuthError('login-error', 'authUnsupported');
    } else if (result) {
      startSession(credential);
      unlockApp();
    } else {
      setAuthError('login-error', 'authWrongPassword');
      document.getElementById('login-password').select();
    }
  } finally {
    button.disabled = false;
  }
}

function logout() {
  endSession();
  if (typeof closeAllModals === 'function') closeAllModals();
  document.getElementById('data-menu').classList.add('hidden');
  lockApp('login');
}

/* ---------- change password ---------- */

function openPasswordModal() {
  document.getElementById('form-password').reset();
  setAuthError('pw-error', null);
  openModal('modal-password');
  document.getElementById('pw-current').focus();
}

async function saveNewPassword(e) {
  e.preventDefault();
  const credential = getCredential();
  if (!credential) return;

  const current = document.getElementById('pw-current').value;
  const next = document.getElementById('pw-new').value;
  const confirmation = document.getElementById('pw-confirm').value;

  if (next.length < AUTH_MIN_LENGTH) { setAuthError('pw-error', 'authTooShort'); return; }
  if (next !== confirmation) { setAuthError('pw-error', 'authMismatch'); return; }

  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    const result = await verifyPassword(current, credential);
    if (result === null) { setAuthError('pw-error', 'authUnsupported'); return; }
    if (!result) { setAuthError('pw-error', 'authCurrentWrong'); return; }

    const updated = await createCredential(next);
    startSession(updated);
    closeModal('modal-password');
  } catch (err) {
    setAuthError('pw-error', 'authUnsupported');
  } finally {
    button.disabled = false;
  }
}
