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

function isAdmin() {
  return currentRole === 'admin';
}

function isSignedIn() {
  return Boolean(currentUser);
}

/* ---------- session handling ---------- */

async function initAuth() {
  const redirectErrorKey = consumeAuthRedirectError();
  await loadAuthSettings();

  if (!BACKEND_READY) {
    updateAuthUI();
  } else {
    const { data, error } = await db.auth.getSession();
    if (!error) await applySession(data.session);

    db.auth.onAuthStateChange(async (event, session) => {
      // INITIAL_SESSION is already handled above; TOKEN_REFRESHED needs no UI work.
      if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
      await applySession(session);
      renderApp();
    });
  }

  if (redirectErrorKey) {
    openLoginModal();
    setAuthError('login-error', redirectErrorKey);
  }
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

  if (currentUser) {
    const { data, error } = await db
      .from('profiles')
      .select('role')
      .eq('id', currentUser.id)
      .maybeSingle();

    if (!error && data) currentRole = data.role;
  }

  updateAuthUI();
}

function updateAuthUI() {
  const admin = isAdmin();

  document.body.classList.toggle('is-admin', admin);
  document.body.classList.toggle('is-authed', isSignedIn());

  const loginBtn = document.getElementById('btn-admin-login');
  const logoutBtn = document.getElementById('btn-logout');
  const badge = document.getElementById('role-badge');

  if (loginBtn) loginBtn.classList.toggle('hidden', isSignedIn());
  if (logoutBtn) logoutBtn.classList.toggle('hidden', !isSignedIn());

  if (badge) {
    badge.classList.toggle('hidden', !isSignedIn());
    badge.textContent = admin ? t('adminBadge') : t('viewerBadge');
    badge.className = admin
      ? 'hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide bg-pitch-500/15 text-pitch-400 border border-pitch-500/30'
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
  ['login-error', 'login-success', 'signup-error', 'signup-success', 'pw-error'].forEach(id => {
    setAuthError(id, null);
    setAuthNotice(id, null);
  });
}

/** URL Supabase should send users back to after confirming an email. */
function authRedirectUrl() {
  return window.location.origin + window.location.pathname;
}

/* ---------- login / signup modal ---------- */

function openLoginModal() {
  const loginForm = document.getElementById('form-login');
  const signupForm = document.getElementById('form-signup');
  if (loginForm) loginForm.reset();
  if (signupForm) signupForm.reset();
  clearAuthMessages();
  showLoginPanel(true);
  openModal('modal-login');

  const email = document.getElementById('login-email');
  if (email) email.focus();

  if (!BACKEND_READY) setAuthError('login-error', 'authConfigMissing');
}

function showLoginPanel(showLogin) {
  document.getElementById('login-panel').classList.toggle('hidden', !showLogin);
  document.getElementById('signup-panel').classList.toggle('hidden', showLogin);
  clearAuthMessages();
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
    setAuthError('login-error', 'authConfigMissing');
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

    if (!isAdmin()) {
      setAuthError('login-error', 'authNotAdmin');
      return;
    }

    closeModal('modal-login');
    clearAuthMessages();
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
    setAuthError('signup-error', 'authConfigMissing');
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
    setAuthError('login-error', 'authConfigMissing');
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

async function logout() {
  if (BACKEND_READY && db) {
    try { await db.auth.signOut(); } catch (e) { /* ignore */ }
  }
  currentUser = null;
  currentRole = null;
  updateAuthUI();
  closeAllModals();
  const menu = document.getElementById('data-menu');
  if (menu) menu.classList.add('hidden');
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
    setAuthError('pw-error', 'authConfigMissing');
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
