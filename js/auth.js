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

function isAdmin() {
  return currentRole === 'admin';
}

function isSignedIn() {
  return Boolean(currentUser);
}

/* ---------- session handling ---------- */

async function initAuth() {
  if (!BACKEND_READY) {
    updateAuthUI();
    return;
  }

  const { data, error } = await db.auth.getSession();
  if (!error) await applySession(data.session);

  db.auth.onAuthStateChange(async (event, session) => {
    // INITIAL_SESSION is already handled above; TOKEN_REFRESHED needs no UI work.
    if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
    await applySession(session);
    renderApp();
  });
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
  ['login-error', 'signup-error', 'signup-success', 'pw-error'].forEach(id => {
    setAuthError(id, null);
    setAuthNotice(id, null);
  });
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
    const { data, error } = await db.auth.signUp({ email, password });
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
