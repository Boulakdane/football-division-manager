/* ---------------------------------------------------------------
   KickOff Division — authentication & UI roles
   Uses Supabase Auth (email + password). Spectators browse without
   an account; only profiles with role = 'admin' get write controls.
   Actual write protection is enforced by Row Level Security in
   Postgres — hiding buttons is only a UX nicety.
   --------------------------------------------------------------- */
'use strict';

let currentUser = null;
let currentRole = null;
/** Set from Supabase project settings; hides the signup UI when disabled. */
let signupsDisabled = false;
/** True while the visitor is completing a password-recovery link. */
let passwordRecoveryMode = false;

/** Capture before supabase-js consumes and clears the recovery hash. */
const AUTH_RECOVERY_LINK = (() => {
  try {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const query = new URLSearchParams(window.location.search);
    return hash.get('type') === 'recovery' || query.get('type') === 'recovery';
  } catch (err) {
    return false;
  }
})();

/* App-level idle logout. The browser timer is a backstop; visibility and focus
   events also compare wall-clock time, so background throttling cannot keep a
   forgotten session alive indefinitely. */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_CHECK_MS = 30 * 1000;
const IDLE_ACTIVITY_KEY = 'kickoff_last_activity';
let idleLastActivity = Date.now();
let idleLastStored = 0;
let idleCheckTimer = null;
let idleWatcherInstalled = false;
let idleSigningOut = false;

function isAdmin() {
  return currentRole === 'admin' && !passwordRecoveryMode;
}

/** Roadmap B: match-day entry only, never the admin write controls. */
function isScorer() {
  return currentRole === 'scorer' && !passwordRecoveryMode;
}

function isSignedIn() {
  return Boolean(currentUser);
}

/* ---------- session handling ---------- */

async function initAuth() {
  const redirectErrorKey = consumeAuthRedirectError();
  const recoveryLink = AUTH_RECOVERY_LINK && !redirectErrorKey;
  await loadAuthSettings();

  if (!BACKEND_READY) {
    updateAuthUI();
  } else {
    const { data, error } = await db.auth.getSession();
    if (!error) await applySession(data.session);

    db.auth.onAuthStateChange(async (event, session) => {
      // INITIAL_SESSION is already handled above; TOKEN_REFRESHED needs no UI work.
      if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;

      if (event === 'PASSWORD_RECOVERY') {
        if (session && session.user) {
          enterPasswordRecoveryMode();
          await applySession(session);
          openResetPasswordModal();
        } else {
          await applySession(null);
          openLoginModal();
          setAuthError('login-error', 'authResetInvalid');
        }
        renderApp();
        return;
      }

      await applySession(session);
      renderApp();
    });

    // The PASSWORD_RECOVERY event can fire before this listener is attached
    // (during supabase-js initialisation), so the URL flag is the fallback.
    if (recoveryLink && currentUser) {
      enterPasswordRecoveryMode();
      openResetPasswordModal();
    }
  }

  startIdleWatcher();

  if (redirectErrorKey) {
    openLoginModal();
    setAuthError('login-error', redirectErrorKey);
  } else if (recoveryLink && !currentUser) {
    openLoginModal();
    setAuthError('login-error', 'authResetInvalid');
  }
}

function enterPasswordRecoveryMode() {
  passwordRecoveryMode = true;
  updateAuthUI();
}

/** Remove an already-consumed recovery token from the address bar/history. */
function clearRecoveryHash() {
  if (!window.location.hash && !window.location.search) return;
  const url = new URL(window.location.href);
  url.hash = '';
  ['code', 'type'].forEach(key => url.searchParams.delete(key));
  history.replaceState(null, '', url.pathname + url.search);
}

/**
 * Supabase redirects failed confirmation links back with error details in the
 * URL hash/query. Show a friendly message and clean the address bar.
 */
function consumeAuthRedirectError() {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  const hashParams = new URLSearchParams(hash);
  const queryParams = new URLSearchParams(window.location.search);

  const error = hashParams.get('error') || queryParams.get('error');
  const errorCode = hashParams.get('error_code') || queryParams.get('error_code');
  const description = hashParams.get('error_description') || queryParams.get('error_description') || '';

  if (!error && !errorCode) return null;

  const expired = errorCode === 'otp_expired' ||
    /expired/i.test(description) ||
    /expired/i.test(error || '');

  const url = new URL(window.location.href);
  ['error', 'error_code', 'error_description', 'sb', 'code'].forEach(key => url.searchParams.delete(key));
  url.hash = '';
  history.replaceState(null, '', url.pathname + url.search);

  return expired ? 'authLinkExpired' : 'authLinkInvalid';
}

/** Read public project settings (no auth needed) to know whether signups are open. */
async function loadAuthSettings() {
  if (!BACKEND_READY) return;

  try {
    const response = await fetch(SUPABASE_URL + '/auth/v1/settings', {
      headers: { apikey: SUPABASE_ANON_KEY }
    });
    if (!response.ok) return;
    const settings = await response.json();
    signupsDisabled = Boolean(settings.disable_signup);
  } catch (err) {
    // Keep signups visible if the settings endpoint is unreachable.
  }
}

async function applySession(session) {
  currentUser = session ? session.user : null;
  currentRole = null;
  if (currentUser) markIdleActivity();

  if (currentUser) {
    const { data, error } = await db
      .from('profiles')
      .select('role')
      .eq('id', currentUser.id)
      .maybeSingle();

    if (!error && data) currentRole = data.role;
  }

  updateAuthUI();

  // Roadmap B: a restored scorer/admin session needs its match assignments
  // before the fixtures can show the live-entry buttons.
  if ((isAdmin() || isScorer()) && typeof refreshOfficials === 'function') {
    try {
      await refreshOfficials();
    } catch (err) {
      console.error('KickOff Division: could not load match officials.', err);
    }
  }

  // Load the two-factor requirement, assurance level and enrolled factors.
  if (typeof refreshMfaState === 'function') await refreshMfaState();
}

function updateAuthUI() {
  const admin = isAdmin();
  const scorer = isScorer();
  const mfaLocked = typeof isMfaLocked === 'function' && isMfaLocked();

  document.body.classList.toggle('is-admin', admin);
  document.body.classList.toggle('is-scorer', scorer);
  document.body.classList.toggle('is-authed', isSignedIn());
  document.body.classList.toggle('mfa-locked', mfaLocked);

  const loginBtn = document.getElementById('btn-admin-login');
  const logoutBtn = document.getElementById('btn-logout');
  const badge = document.getElementById('role-badge');
  const mfaBtn = document.getElementById('btn-mfa-verify');

  if (loginBtn) loginBtn.classList.toggle('hidden', isSignedIn());
  if (logoutBtn) logoutBtn.classList.toggle('hidden', !isSignedIn());
  if (mfaBtn) mfaBtn.classList.toggle('hidden', !mfaLocked);

  if (badge) {
    badge.classList.toggle('hidden', !isSignedIn());
    badge.textContent = admin
      ? t('adminBadge')
      : scorer ? t('scorerBadge') : t('viewerBadge');
    if (admin && mfaLocked) badge.textContent += ' · 2FA';
    badge.title = mfaLocked ? t('mfaStatusRequired') : '';
    badge.className = admin
      ? 'hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide bg-pitch-500/15 text-pitch-400 border border-pitch-500/30'
      : scorer
        ? 'hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide bg-amber-400/15 text-amber-300 border border-amber-400/30'
        : 'hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide bg-slate-700/60 text-slate-300 border border-slate-600';
    badge.classList.toggle('hidden', !isSignedIn());
  }

  const demoBanner = document.getElementById('demo-banner');
  if (demoBanner) demoBanner.classList.toggle('hidden', BACKEND_READY);

  const signupToggle = document.getElementById('btn-show-signup');
  if (signupToggle) signupToggle.classList.toggle('hidden', signupsDisabled);

  if (signupsDisabled) {
    const signupPanel = document.getElementById('signup-panel');
    if (signupPanel && !signupPanel.classList.contains('hidden')) showLoginPanel(true);
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

/* ---------- error helpers ---------- */

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

function setAuthNotice(elementId, key) {
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

function clearAuthMessages() {
  ['login-error', 'login-success', 'signup-error', 'signup-success', 'pw-error',
    'reset-error', 'reset-success', 'reset-pw-error'].forEach(id => {
    setAuthError(id, null);
    setAuthNotice(id, null);
  });
}

/** URL Supabase should send users back to after confirming an email. */
function authRedirectUrl() {
  // Preserve an explicit environment choice so a recovery link opened from
  // ?env=dev (or ?env=prod) returns to the same Supabase project.
  const env = new URLSearchParams(window.location.search).get('env');
  const query = (env === 'dev' || env === 'prod') ? '?env=' + env : '';
  return window.location.origin + window.location.pathname + query;
}

/* ---------- login / signup modal ---------- */

function openLoginModal() {
  const loginForm = document.getElementById('form-login');
  const signupForm = document.getElementById('form-signup');
  const resetForm = document.getElementById('form-reset-request');
  if (loginForm) loginForm.reset();
  if (signupForm) signupForm.reset();
  if (resetForm) resetForm.reset();
  passwordRecoveryMode = false;
  clearAuthMessages();
  showLoginPanel(true);
  openModal('modal-login');

  const email = document.getElementById('login-email');
  if (email) email.focus();

  if (!BACKEND_READY) setAuthError('login-error', authUnavailableKey());
}

/** Switch between the login, signup and forgotten-password panels. */
function showAuthPanel(panel) {
  const panels = {
    login: 'login-panel',
    signup: 'signup-panel',
    reset: 'reset-request-panel'
  };

  Object.entries(panels).forEach(([name, id]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', name !== panel);
  });

  const titleKeys = {
    login: 'adminLogin',
    signup: 'authSignupTitle',
    reset: 'authResetRequestTitle'
  };
  const title = document.getElementById('auth-modal-title');
  if (title && titleKeys[panel]) {
    title.dataset.i18n = titleKeys[panel];
    title.textContent = t(titleKeys[panel]);
  }

  clearAuthMessages();
}

function showLoginPanel(showLogin) {
  showAuthPanel(showLogin ? 'login' : 'signup');
}

function toggleSignup(e) {
  if (e) e.preventDefault();

  if (signupsDisabled) {
    showLoginPanel(true);
    setAuthError('login-error', 'authSignupDisabled');
    return;
  }

  const signupVisible = !document.getElementById('signup-panel').classList.contains('hidden');
  showLoginPanel(signupVisible);
  const focusId = signupVisible ? 'login-email' : 'signup-email';
  const input = document.getElementById(focusId);
  if (input) input.focus();
}

async function handleLogin(e) {
  e.preventDefault();
  clearAuthMessages();

  if (!BACKEND_READY) {
    setAuthError('login-error', authUnavailableKey());
    return;
  }

  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) return;

  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
      setAuthError('login-error', 'authLoginInvalid');
      return;
    }

    await applySession(data.session);

    try {
      await refreshData();
      renderApp();
    } catch (err) {
      showDataError(err);
    }

    if (!isAdmin() && !isScorer()) {
      setAuthError('login-error', 'authNotAdmin');
      return;
    }

    closeModal('modal-login');
    clearAuthMessages();

    // A password-only admin session cannot write while two-factor is
    // required, so ask for the code straight away.
    if (typeof isMfaLocked === 'function' && isMfaLocked()) openMfaModal();
  } catch (err) {
    setAuthError('login-error', 'authLoginInvalid');
  } finally {
    button.disabled = false;
  }
}

async function handleSignup(e) {
  e.preventDefault();
  clearAuthMessages();

  if (signupsDisabled) {
    setAuthError('signup-error', 'authSignupDisabled');
    return;
  }

  if (!BACKEND_READY) {
    setAuthError('signup-error', authUnavailableKey());
    return;
  }

  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const confirmation = document.getElementById('signup-confirm').value;

  if (password.length < 6) { setAuthError('signup-error', 'authTooShort'); return; }
  if (password !== confirmation) { setAuthError('signup-error', 'authMismatch'); return; }

  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: authRedirectUrl() }
    });
    if (error) {
      setAuthError('signup-error', 'authSignupFailed');
      return;
    }

    if (data.session) {
      await applySession(data.session);
      setAuthNotice('signup-success', 'authSignupDone');
    } else {
      // Email confirmation is enabled in the Supabase project
      setAuthNotice('signup-success', 'authSignupConfirm');
    }
    document.getElementById('form-signup').reset();
  } catch (err) {
    setAuthError('signup-error', 'authSignupFailed');
  } finally {
    button.disabled = false;
  }
}

async function resendConfirmation(event) {
  clearAuthMessages();

  if (!BACKEND_READY) {
    setAuthError('login-error', authUnavailableKey());
    return;
  }

  const email = document.getElementById('login-email').value.trim();
  if (!email) {
    setAuthError('login-error', 'authEmailRequired');
    return;
  }

  const button = event && event.currentTarget ? event.currentTarget : null;
  if (button) button.disabled = true;

  try {
    const { error } = await db.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: authRedirectUrl() }
    });

    if (error) {
      const message = (error.message || '').toLowerCase();
      if (message.includes('already confirmed')) {
        setAuthError('login-error', 'authAlreadyConfirmed');
      } else if (error.status === 429 || message.includes('rate limit')) {
        setAuthError('login-error', 'authTooManyRequests');
      } else {
        setAuthError('login-error', 'authResendFailed');
      }
      return;
    }

    setAuthNotice('login-success', 'authResendSent');
  } catch (err) {
    setAuthError('login-error', 'authResendFailed');
  } finally {
    if (button) button.disabled = false;
  }
}

function openResetRequest() {
  const loginEmail = document.getElementById('login-email');
  const resetEmail = document.getElementById('reset-email');
  if (loginEmail && resetEmail) resetEmail.value = loginEmail.value.trim();
  showAuthPanel('reset');
  if (resetEmail) resetEmail.focus();
}

function showLoginFromReset() {
  showAuthPanel('login');
  const email = document.getElementById('login-email');
  if (email) email.focus();
}

async function requestPasswordReset(e) {
  e.preventDefault();
  clearAuthMessages();

  if (!BACKEND_READY) {
    setAuthError('reset-error', authUnavailableKey());
    return;
  }

  const email = document.getElementById('reset-email').value.trim();
  if (!email) {
    setAuthError('reset-error', 'authEmailRequired');
    return;
  }

  const button = e.target.querySelector('button[type="submit"]');
  if (button) button.disabled = true;

  try {
    const { error } = await db.auth.resetPasswordForEmail(email, {
      redirectTo: authRedirectUrl()
    });

    if (error) {
      const message = (error.message || '').toLowerCase();
      if (error.status === 429 || message.includes('rate limit')) {
        setAuthError('reset-error', 'authTooManyRequests');
        return;
      }
      if (!error.status || error.status >= 500) {
        setAuthError('reset-error', 'authResetFailed');
        return;
      }
      // 4xx responses stay generic so the form cannot be used to discover
      // whether an address has an account.
    }

    setAuthNotice('reset-success', 'authResetSent');
  } catch (err) {
    setAuthError('reset-error', 'authResetFailed');
  } finally {
    if (button) button.disabled = false;
  }
}

/** Open the "choose a new password" dialog after a recovery link is opened. */
function openResetPasswordModal() {
  if (!currentUser) {
    openLoginModal();
    setAuthError('login-error', 'authResetInvalid');
    return;
  }

  passwordRecoveryMode = true;
  clearRecoveryHash();
  const form = document.getElementById('form-reset-password');
  if (form) form.reset();
  clearAuthMessages();
  closeModal('modal-login');
  updateAuthUI();
  openModal('modal-reset');

  const input = document.getElementById('reset-new');
  if (input) input.focus();
}

async function saveRecoveredPassword(e) {
  e.preventDefault();
  clearAuthMessages();

  if (!BACKEND_READY || !currentUser) {
    setAuthError('reset-pw-error', 'authResetInvalid');
    return;
  }

  const next = document.getElementById('reset-new').value;
  const confirmation = document.getElementById('reset-confirm').value;

  if (next.length < 6) { setAuthError('reset-pw-error', 'authTooShort'); return; }
  if (next !== confirmation) { setAuthError('reset-pw-error', 'authMismatch'); return; }

  const button = e.target.querySelector('button[type="submit"]');
  if (button) button.disabled = true;

  try {
    const { error } = await db.auth.updateUser({ password: next });
    if (error) {
      const message = (error.message || '').toLowerCase();
      const key = /expired|invalid|session/.test(message) ? 'authResetInvalid' : 'authResetUpdateFailed';
      setAuthError('reset-pw-error', key);
      return;
    }

    // Invalidate every existing session, including any attacker who already
    // had the old password. Fall back to a local sign-out if the global call
    // is unavailable.
    try {
      const { error: signOutError } = await db.auth.signOut({ scope: 'global' });
      if (signOutError) await db.auth.signOut({ scope: 'local' });
    } catch (err) {
      try { await db.auth.signOut({ scope: 'local' }); } catch (ignored) { /* ignore */ }
    }

    currentUser = null;
    currentRole = null;
    passwordRecoveryMode = false;
    clearIdleActivity();
    if (typeof resetMfaState === 'function') resetMfaState();
    updateAuthUI();
    closeAllModals();
    openLoginModal();
    setAuthNotice('login-success', 'authResetDone');
  } catch (err) {
    setAuthError('reset-pw-error', 'authResetUpdateFailed');
  } finally {
    if (button) button.disabled = false;
  }
}

async function cancelPasswordReset() {
  passwordRecoveryMode = false;
  closeModal('modal-reset');
  await logout();
  openLoginModal();
  setAuthError('login-error', 'authResetCancelled');
}

async function logout(noticeKey) {
  if (BACKEND_READY && db) {
    // End this browser session only. Password recovery deliberately uses the
    // global scope to revoke every existing session after a credential change.
    try { await db.auth.signOut({ scope: 'local' }); } catch (e) { /* ignore */ }
  }
  currentUser = null;
  currentRole = null;
  passwordRecoveryMode = false;
  clearIdleActivity();
  if (typeof resetMfaState === 'function') resetMfaState();
  updateAuthUI();
  closeAllModals();
  const menu = document.getElementById('data-menu');
  if (menu) menu.classList.add('hidden');
  if (noticeKey && typeof showToast === 'function') showToast(t(noticeKey));
}

/* ---------- sign out everywhere (global revocation) ---------- */

function openLogoutAllModal() {
  if (!isSignedIn()) {
    openLoginModal();
    return;
  }
  if (typeof closeDataMenu === 'function') closeDataMenu();
  setAuthError('logout-all-error', null);
  const confirm = document.querySelector('#modal-logout-all [data-action="logout-all-confirm"]');
  if (confirm) confirm.disabled = false;
  openModal('modal-logout-all');
}

async function logoutEverywhere() {
  if (!BACKEND_READY || !db) {
    setAuthError('logout-all-error', authUnavailableKey());
    return;
  }
  if (!currentUser) {
    openLoginModal();
    return;
  }

  const confirm = document.querySelector('#modal-logout-all [data-action="logout-all-confirm"]');
  if (confirm) confirm.disabled = true;
  setAuthError('logout-all-error', null);

  try {
    const { error } = await db.auth.signOut({ scope: 'global' });
    if (error) {
      setAuthError('logout-all-error', 'authLogoutAllFailed');
      return;
    }

    currentUser = null;
    currentRole = null;
    passwordRecoveryMode = false;
    clearIdleActivity();
    if (typeof resetMfaState === 'function') resetMfaState();
    updateAuthUI();
    closeAllModals();
    openLoginModal();
    setAuthNotice('login-success', 'authLogoutAllDone');
  } catch (err) {
    setAuthError('logout-all-error', 'authLogoutAllFailed');
  } finally {
    if (confirm) confirm.disabled = false;
  }
}

/* ---------- idle logout ---------- */

function markIdleActivity() {
  const now = Date.now();
  idleLastActivity = now;
  // Anonymous tabs must not keep an authenticated session alive.
  if (!currentUser) return;
  // Share activity between signed-in tabs so a background tab cannot sign out
  // a session the user is still using elsewhere. Throttle storage writes.
  if (now - idleLastStored < 5000) return;
  idleLastStored = now;
  try { localStorage.setItem(IDLE_ACTIVITY_KEY, String(now)); } catch (err) { /* ignore */ }
}

function lastIdleActivity() {
  const now = Date.now();
  // If the wall clock moved backwards, do not wait for it to catch up.
  if (idleLastActivity > now) idleLastActivity = now;

  let stored = 0;
  try {
    const parsed = Number(localStorage.getItem(IDLE_ACTIVITY_KEY));
    // A future timestamp is invalid and must not extend the session forever.
    if (Number.isFinite(parsed) && parsed <= now) stored = parsed;
  } catch (err) { /* ignore */ }

  return Math.max(idleLastActivity, stored);
}

function clearIdleActivity() {
  idleLastActivity = Date.now();
  idleLastStored = 0;
  try { localStorage.removeItem(IDLE_ACTIVITY_KEY); } catch (err) { /* ignore */ }
}

function checkIdleTimeout() {
  if (!currentUser || idleSigningOut) return;
  if (Date.now() - lastIdleActivity() >= IDLE_TIMEOUT_MS) idleLogout();
}

async function idleLogout() {
  if (!currentUser || idleSigningOut) return;
  idleSigningOut = true;
  try {
    await logout('authIdleLogout');
  } finally {
    idleSigningOut = false;
  }
}

function startIdleWatcher() {
  if (idleWatcherInstalled) return;
  idleWatcherInstalled = true;
  markIdleActivity();

  ['pointerdown', 'keydown', 'touchstart'].forEach(type => {
    document.addEventListener(type, markIdleActivity, { passive: true });
  });
  window.addEventListener('scroll', markIdleActivity, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    checkIdleTimeout();
    markIdleActivity();
  });

  window.addEventListener('focus', () => {
    checkIdleTimeout();
    markIdleActivity();
  });

  idleCheckTimer = setInterval(checkIdleTimeout, IDLE_CHECK_MS);
}

/* ---------- change password ---------- */

function openPasswordModal() {
  if (!isSignedIn()) return;
  document.getElementById('form-password').reset();
  clearAuthMessages();
  openModal('modal-password');
  document.getElementById('pw-new').focus();
}

async function saveNewPassword(e) {
  e.preventDefault();
  clearAuthMessages();

  if (!BACKEND_READY || !isSignedIn()) {
    setAuthError('pw-error', authUnavailableKey());
    return;
  }

  const current = document.getElementById('pw-current').value;
  const next = document.getElementById('pw-new').value;
  const confirmation = document.getElementById('pw-confirm').value;

  if (next.length < 6) { setAuthError('pw-error', 'authTooShort'); return; }
  if (next !== confirmation) { setAuthError('pw-error', 'authMismatch'); return; }

  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    // Re-authenticate to verify the current password
    const check = await db.auth.signInWithPassword({
      email: currentUser.email,
      password: current
    });
    if (check.error) {
      setAuthError('pw-error', 'authCurrentWrong');
      return;
    }

    const { error } = await db.auth.updateUser({ password: next });
    if (error) {
      setAuthError('pw-error', 'authSaveFailed');
      return;
    }

    closeModal('modal-password');
  } catch (err) {
    setAuthError('pw-error', 'authSaveFailed');
  } finally {
    button.disabled = false;
  }
}
