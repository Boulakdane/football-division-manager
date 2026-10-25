/* ---------------------------------------------------------------
   KickOff Division — admin two-factor authentication (TOTP)
   Enrolment and verification use Supabase Auth MFA. The database
   only trusts admin sessions whose JWT carries aal = aal2 once the
   requirement is enabled (see supabase/mfa-migration.sql).
   --------------------------------------------------------------- */
'use strict';

let mfaRequired = false;
let mfaFactors = [];
let currentAal = 'aal1';
let nextAal = 'aal1';
let mfaEnrollmentId = null;
/** Set once the RPC is known to be missing, to avoid repeating 404s. */
let mfaBackendMissing = false;

function resetMfaState() {
  mfaRequired = false;
  mfaFactors = [];
  currentAal = 'aal1';
  nextAal = 'aal1';
  mfaEnrollmentId = null;
}

function hasVerifiedMfaFactor() {
  return mfaFactors.some(factor => factor.status === 'verified');
}

function verifiedMfaFactor() {
  return mfaFactors.find(factor => factor.status === 'verified') || null;
}

/** True when the database will reject this admin's writes until step-up. */
function isMfaLocked() {
  return BACKEND_READY && isAdmin() && mfaRequired && currentAal !== 'aal2';
}

/** Reload the requirement flag, assurance level and enrolled factors. */
let mfaRefreshSeq = 0;

async function refreshMfaState() {
  const seq = ++mfaRefreshSeq;

  if (!BACKEND_READY) {
    resetMfaState();
    if (typeof updateAuthUI === 'function') updateAuthUI();
    return;
  }

  let required = false;
  let factors = [];
  let level = 'aal1';
  let nextLevel = 'aal1';

  if (isSignedIn() && !mfaBackendMissing) {
    try {
      const { data, error } = await db.rpc('admin_mfa_required');
      if (error) {
        if (typeof isMissingFunction === 'function' && isMissingFunction(error)) {
          mfaBackendMissing = true;
        }
      } else if (data === true) {
        required = true;
      }
    } catch (err) {
      // Before supabase/mfa-migration.sql the feature is simply off.
    }
  }

  if (isSignedIn()) {
    try {
      const { data } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
      if (data) {
        level = data.currentLevel || 'aal1';
        nextLevel = data.nextLevel || level;
      }
    } catch (err) { /* ignore */ }

    try {
      const { data, error } = await db.auth.mfa.listFactors();
      if (!error && data) factors = data.all || [];
    } catch (err) { /* ignore */ }
  }

  // A newer refresh may have started (e.g. two auth events at once); only the
  // latest result may touch the UI, otherwise a slow old read overwrites it.
  if (seq !== mfaRefreshSeq) return;

  mfaRequired = required;
  mfaFactors = factors;
  currentAal = level;
  nextAal = nextLevel;

  if (typeof updateAuthUI === 'function') updateAuthUI();
  renderMfaPanel();
}

/* ---------- dialog ---------- */

function openMfaModal() {
  if (typeof closeDataMenu === 'function') closeDataMenu();
  document.getElementById('form-mfa-verify')?.reset();
  document.getElementById('form-mfa-enroll')?.reset();
  mfaEnrollmentId = null;
  const setup = document.getElementById('mfa-enroll-setup');
  const start = document.getElementById('mfa-enroll-start');
  if (setup) setup.classList.add('hidden');
  if (start) start.classList.remove('hidden');
  setMfaError(null);
  openModal('modal-mfa');
  renderMfaPanel();
  refreshMfaState();
}

function setMfaError(message) {
  const el = document.getElementById('mfa-error');
  if (!el) return;
  if (!message) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.textContent = message;
  el.classList.remove('hidden');
}

function renderMfaPanel() {
  const modal = document.getElementById('modal-mfa');
  if (!modal) return;

  const signedInAdmin = isSignedIn() && isAdmin();
  const notice = document.getElementById('mfa-admin-only');
  const verifyPanel = document.getElementById('form-mfa-verify');
  const enrollPanel = document.getElementById('mfa-enroll-panel');
  const managePanel = document.getElementById('mfa-manage-panel');
  const status = document.getElementById('mfa-status');
  const toggle = document.getElementById('mfa-require-toggle');

  if (notice) notice.classList.toggle('hidden', signedInAdmin);
  if (!signedInAdmin) {
    if (verifyPanel) verifyPanel.classList.add('hidden');
    if (enrollPanel) enrollPanel.classList.add('hidden');
    if (managePanel) managePanel.classList.add('hidden');
    if (status) status.textContent = '';
    return;
  }

  const verified = hasVerifiedMfaFactor();
  const steppedUp = currentAal === 'aal2';

  if (verifyPanel) verifyPanel.classList.toggle('hidden', !(verified && !steppedUp));
  if (enrollPanel) enrollPanel.classList.toggle('hidden', verified);
  if (managePanel) managePanel.classList.toggle('hidden', !(verified && steppedUp));

  if (status) {
    if (!verified) status.textContent = t('mfaStatusOff');
    else if (!steppedUp && mfaRequired) status.textContent = t('mfaStatusRequired');
    else if (!steppedUp) status.textContent = t('mfaStatusStepUp');
    else status.textContent = t('mfaStatusActive');
  }

  if (toggle) {
    toggle.checked = mfaRequired;
    toggle.disabled = !(verified && steppedUp);
  }
}

/* ---------- enrolment ---------- */

async function startMfaEnrollment() {
  setMfaError(null);

  // Remove half-finished attempts so the authenticator only sees one factor.
  for (const factor of mfaFactors.filter(f => f.status !== 'verified')) {
    try { await db.auth.mfa.unenroll({ factorId: factor.id }); } catch (err) { /* ignore */ }
  }

  const { data, error } = await db.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'KickOff Division admin'
  });
  if (error || !data || !data.totp) {
    setMfaError(t('mfaSaveFailed'));
    return;
  }

  mfaEnrollmentId = data.id;
  const setup = document.getElementById('mfa-enroll-setup');
  const start = document.getElementById('mfa-enroll-start');
  if (setup) setup.classList.remove('hidden');
  if (start) start.classList.add('hidden');

  const secret = document.getElementById('mfa-secret');
  if (secret) secret.textContent = data.totp.secret || '';

  const qr = document.getElementById('mfa-qr');
  const qrCode = data.totp.qr_code || '';
  if (qr) {
    // GoTrue returns a data URI; only that form is shown (CSP img-src data:).
    if (/^data:image\//.test(qrCode)) {
      qr.src = qrCode;
      qr.classList.remove('hidden');
    } else {
      qr.removeAttribute('src');
      qr.classList.add('hidden');
    }
  }

  document.getElementById('mfa-enroll-code')?.focus();
}

async function handleMfaEnrollSubmit(event) {
  event.preventDefault();
  setMfaError(null);

  if (!mfaEnrollmentId) {
    setMfaError(t('mfaSaveFailed'));
    return;
  }

  const input = document.getElementById('mfa-enroll-code');
  const code = (input ? input.value : '').replace(/\D/g, '');
  if (code.length !== 6) {
    setMfaError(t('mfaError'));
    return;
  }

  const button = event.target.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const challenge = await db.auth.mfa.challenge({ factorId: mfaEnrollmentId });
    if (challenge.error) {
      setMfaError(t('mfaSaveFailed'));
      return;
    }

    const verified = await db.auth.mfa.verify({
      factorId: mfaEnrollmentId,
      challengeId: challenge.data.id,
      code
    });
    if (verified.error) {
      setMfaError(t('mfaError'));
      return;
    }
    await adoptMfaSession(verified.data);

    mfaEnrollmentId = null;
    document.getElementById('form-mfa-enroll')?.reset();
    await refreshMfaState();
    showToast(t('mfaEnabled'));
  } finally {
    if (button) button.disabled = false;
  }
}

/* ---------- step-up ---------- */

async function handleMfaVerifySubmit(event) {
  event.preventDefault();
  setMfaError(null);

  const factor = verifiedMfaFactor();
  if (!factor) {
    setMfaError(t('mfaSaveFailed'));
    return;
  }

  const input = document.getElementById('mfa-verify-code');
  const code = (input ? input.value : '').replace(/\D/g, '');
  if (code.length !== 6) {
    setMfaError(t('mfaError'));
    return;
  }

  const button = event.target.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const challenge = await db.auth.mfa.challenge({ factorId: factor.id });
    if (challenge.error) {
      setMfaError(t('mfaSaveFailed'));
      return;
    }

    const verified = await db.auth.mfa.verify({
      factorId: factor.id,
      challengeId: challenge.data.id,
      code
    });
    if (verified.error) {
      setMfaError(t('mfaError'));
      return;
    }
    await adoptMfaSession(verified.data);

    document.getElementById('form-mfa-verify')?.reset();
    await refreshMfaState();
    // A step-up can turn an aal1 admin into a writable one, which means their
    // match assignments (roadmap B) were never read at page load.
    if (typeof refreshOfficials === 'function' && (isAdmin() || isScorer())) {
      try {
        await refreshOfficials();
      } catch (err) {
        console.error('KickOff Division: could not load match officials.', err);
      }
    }
    showToast(t('mfaVerified'));
  } finally {
    if (button) button.disabled = false;
  }
}

/** Make sure the aal2 tokens returned by verify() are the active session. */
async function adoptMfaSession(data) {
  if (!data || !data.access_token || !data.refresh_token) return;
  try {
    await db.auth.setSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token
    });
  } catch (err) { /* the client usually stores it already */ }
}

/* ---------- require toggle + disable ---------- */

async function toggleRequireMfa(checkbox) {
  const required = Boolean(checkbox && checkbox.checked);
  setMfaError(null);

  try {
    const { error } = await db.rpc('set_require_admin_mfa', { p_required: required });
    if (error) throw error;
    mfaRequired = required;
    showToast(t(required ? 'mfaRequireOn' : 'mfaRequireOff'));
  } catch (err) {
    if (checkbox) checkbox.checked = !required;
    if (typeof isMissingFunction === 'function' && isMissingFunction(err)) {
      setMfaError(t('mfaUnavailable'));
    } else {
      setMfaError(t('mfaSaveFailed'));
    }
  }

  renderMfaPanel();
  if (typeof updateAuthUI === 'function') updateAuthUI();
}

async function disableMfa() {
  const factors = mfaFactors.slice();
  if (!factors.length) return;
  if (!confirm(t('mfaConfirmDisable'))) return;

  setMfaError(null);

  if (mfaRequired) {
    const { error } = await db.rpc('set_require_admin_mfa', { p_required: false });
    if (error) {
      setMfaError(t('mfaSaveFailed'));
      return;
    }
    mfaRequired = false;
  }

  for (const factor of factors) {
    const { error } = await db.auth.mfa.unenroll({ factorId: factor.id });
    if (error) {
      setMfaError(t('mfaSaveFailed'));
      return;
    }
  }

  mfaEnrollmentId = null;
  await refreshMfaState();
  showToast(t('mfaDisabled'));
}

function showMfaRecovery() {
  alert(t('mfaRecoveryHelp'));
}
