/* ---------------------------------------------------------------
   Mzab League — application logic
   Rendering, navigation, standings calculation, modals, CRUD and
   JSON import/export. Depends on js/i18n.js and js/store.js.
   --------------------------------------------------------------- */
'use strict';

/* ---------------------------------------------------------------
 * 1. UTILITIES
 * --------------------------------------------------------------- */

/*
 * esc() and contrastTextColor() live in js/domain/format.js and are published
 * on globalThis by js/domain/index.js.
 */

function uid(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
}

function getTeam(id) {
  return appState.teams.find(t => t.id === id);
}

/* toInt() lives in js/domain/format.js and is published on globalThis. */

/**
 * Show both names when the admin entered an Arabic one: Latin first in the
 * English and French UI, Arabic first in the Arabic UI. Falls back to whichever
 * name exists, so older rows and missing translations render normally.
 */
function bilingualName(latin, arabic) {
  const en = String(latin == null ? '' : latin).trim();
  const ar = String(arabic == null ? '' : arabic).trim();
  if (!ar) return en;
  if (!en) return ar;
  return currentLang === 'ar' ? `${ar} (${en})` : `${en} (${ar})`;
}

/** Display name for a team or an audit snapshot (snake_case tolerated). */
function teamDisplayName(team) {
  if (!team) return '';
  return bilingualName(team.name, team.nameAr || team.name_ar);
}

/** Display name for a player or an audit snapshot (snake_case tolerated). */
function playerDisplayName(player) {
  if (!player) return '';
  return bilingualName(player.name, player.nameAr || player.name_ar);
}

/**
 * The stored club crest (a small data URL) or an empty string. Only the image
 * types the uploader produces are accepted, so a hand-edited backup cannot
 * smuggle an external URL or a script URI into an <img src>.
 */
function teamIconSrc(team) {
  const src = team && team.icon ? String(team.icon) : '';
  return /^data:image\/(png|jpeg|webp);base64,/.test(src) ? src : '';
}

/** A crest image, or '' when the club has none. */
function teamIconHtml(team, size, extraClass) {
  const src = teamIconSrc(team);
  if (!src) return '';
  const px = toInt(size, 20);
  return `<img src="${esc(src)}" alt="${esc(teamDisplayName(team))}" width="${px}" height="${px}" loading="lazy" decoding="async" class="rounded-full object-contain bg-slate-900 ring-1 ring-slate-700/70 shrink-0 ${extraClass || ''}" style="width:${px}px;height:${px}px">`;
}

/**
 * Inline marker before a club name: the crest when there is one, otherwise the
 * colour dot the tables always had, so a club without an icon looks unchanged.
 */
function teamMarkerHtml(team, size) {
  const px = toInt(size, 20);
  const src = teamIconSrc(team);
  if (src) return teamIconHtml(team, px);
  return `<span class="w-3 h-3 rounded-full shrink-0" style="background-color:${esc((team && team.color) || '#22c55e')}"></span>`;
}

/**
 * The round badge on fixture cards and squad headers: the crest, or the
 * existing coloured circle with the club code.
 */
function teamCrestHtml(team, size, extraClass) {
  const px = toInt(size, 32);
  const src = teamIconSrc(team);
  if (src) return teamIconHtml(team, px, extraClass);
  const color = (team && team.color) || '#334155';
  return `<span class="rounded-full flex items-center justify-center font-bold text-xs shadow shrink-0 ${extraClass || ''}" style="width:${px}px;height:${px}px;background-color:${esc(color)};color:${esc(contrastTextColor(color))}">${esc((team && team.code) || '?')}</span>`;
}

/** Format a stored ISO date (YYYY-MM-DD) for the active language. */
function formatIsoDate(value) {
  if (!value) return '';
  const date = new Date(String(value).slice(0, 10) + 'T00:00:00');
  return isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString(currentLang, { year: 'numeric', month: 'short', day: 'numeric' });
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.__returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.classList.remove('hidden');
  // Move focus into the dialog so keyboard and screen-reader users land there.
  const focusable = modal.querySelector('input:not([type="hidden"]), select, textarea, button:not([disabled])');
  if (focusable) focusable.focus({ preventScroll: true });
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  const wasOpen = !modal.classList.contains('hidden');
  modal.classList.add('hidden');
  if (wasOpen && modal.__returnFocus && document.contains(modal.__returnFocus)) {
    modal.__returnFocus.focus({ preventScroll: true });
  }
  modal.__returnFocus = null;
}

function closeAllModals() {
  ['modal-match', 'modal-team', 'modal-player', 'modal-season', 'modal-season-rename', 'modal-password', 'modal-reset', 'modal-logout-all', 'modal-login', 'modal-audit', 'modal-trash', 'modal-mfa', 'modal-squad', 'modal-live', 'modal-users', 'modal-import', 'modal-generate', 'modal-shift'].forEach(id => closeModal(id));
}

/** Escape closes the topmost open dialog; Tab stays inside it. */
function trapModalKeyboard(event) {
  const open = Array.from(document.querySelectorAll('div[id^="modal-"]'))
    .filter(modal => !modal.classList.contains('hidden'))
    .pop();
  if (!open) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    if (open.id === 'modal-reset' && typeof cancelPasswordReset === 'function') {
      cancelPasswordReset();
      return;
    }
    closeModal(open.id);
    return;
  }

  if (event.key !== 'Tab') return;

  const focusable = Array.from(open.querySelectorAll(
    'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(el => el.offsetParent !== null);
  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/* ---------- transient toast ---------- */

let toastTimer = null;

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2200);
}

/** Re-render Lucide placeholders created after the initial page load. */
function refreshIcons() {
  if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
}

/* ---------------------------------------------------------------
 * 1b. SHAREABLE VIEW STATE (tab, season, filters, search)
 *     Kept in the query string so a copied URL reopens the
 *     exact view the sender was looking at.
 * --------------------------------------------------------------- */

const URL_STATE_DEFAULTS = { tab: 'standings', round: 'ALL', status: 'ALL', q: '', division: 'd1' };

function currentTabId() {
  const visible = Array.from(document.querySelectorAll('.tab-view'))
    .find(section => !section.classList.contains('hidden'));
  return visible ? visible.id.replace(/^view-/, '') : URL_STATE_DEFAULTS.tab;
}

/** Read the view state stored in the address bar (without touching the DOM). */
function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  return {
    tab: params.get('tab') || '',
    season: params.get('season') || '',
    division: params.get('division') || '',
    round: params.get('round') || '',
    status: params.get('status') || '',
    q: params.get('q') || ''
  };
}

// Captured before the first render, which normalises the address bar.
const INITIAL_URL_STATE = readUrlState();

/** Mirror the current view into the address bar without adding history entries. */
function syncUrlState() {
  if (typeof appState === 'undefined' || !appState) return;

  const url = new URL(window.location.href);

  const write = (key, value, fallback) => {
    if (!value || value === fallback) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  };

  write('tab', currentTabId(), URL_STATE_DEFAULTS.tab);
  write('season', appState.viewSeasonId, appState.activeSeasonId);
  write('division', appState.viewDivisionId, URL_STATE_DEFAULTS.division);

  const roundSelect = document.getElementById('filter-round');
  const statusSelect = document.getElementById('filter-status');
  write('round', roundSelect ? roundSelect.value : '', URL_STATE_DEFAULTS.round);
  write('status', statusSelect ? statusSelect.value : '', URL_STATE_DEFAULTS.status);

  const search = document.getElementById('player-search');
  write('q', search ? search.value.trim() : '', URL_STATE_DEFAULTS.q);

  const next = url.pathname + url.search + url.hash;
  if (next !== window.location.pathname + window.location.search + window.location.hash) {
    history.replaceState(null, '', next);
  }
}

/**
 * Apply a shared link: select the season, restore filters, and open the tab.
 * Called once after the first successful data load.
 */
function applyUrlState() {
  const state = INITIAL_URL_STATE;

  if (state.season && appState.seasonsReady &&
      (appState.seasons || []).some(season => season.id === state.season)) {
    appState.viewSeasonId = state.season;
  }

  if (state.division && appState.divisionsReady &&
      (appState.divisions || []).some(division => division.id === state.division)) {
    appState.viewDivisionId = state.division;
  }

  const roundSelect = document.getElementById('filter-round');
  const statusSelect = document.getElementById('filter-status');
  const search = document.getElementById('player-search');

  if (statusSelect && ['ALL', 'FINISHED', 'SCHEDULED', 'LIVE'].includes(state.status)) {
    statusSelect.value = state.status;
  }
  if (search && state.q) search.value = state.q;

  renderApp();

  // The round options are rebuilt from data, so apply the filter afterwards.
  if (roundSelect && state.round &&
      Array.from(roundSelect.options).some(option => option.value === state.round)) {
    roundSelect.value = state.round;
  }

  if (state.tab && document.getElementById('view-' + state.tab)) {
    switchTab(state.tab);
  }

  renderFixtures();
  renderTeamsView();
  syncUrlState();
}

/** Copy the current (filter-aware) URL to the clipboard. */
async function copyViewLink() {
  syncUrlState();
  const link = window.location.href;
  let copied = false;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(link);
      copied = true;
    }
  } catch (err) {
    copied = false;
  }

  // Fallback for older browsers or blocked clipboard permissions.
  if (!copied) {
    try {
      const field = document.createElement('textarea');
      field.value = link;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.top = '-1000px';
      document.body.appendChild(field);
      field.select();
      copied = document.execCommand('copy');
      document.body.removeChild(field);
    } catch (err) {
      copied = false;
    }
  }

  showToast(copied ? t('linkCopied') : link);
}

/* ---------------------------------------------------------------
 * 1c. EVENT DELEGATION
 *     Markup declares data-action / data-change / data-input /
 *     data-submit instead of inline on* attributes, so the CSP can
 *     keep script-src to 'self' without 'unsafe-inline'.
 * --------------------------------------------------------------- */

const CLICK_ACTIONS = {
  tab: el => switchTab(el.dataset.tab),
  'close-modal': el => closeModal(el.dataset.modal),

  retry: () => retryLoad(),

  'login-modal': () => openLoginModal(),
  logout: () => logout(),
  'logout-all-modal': () => openLogoutAllModal(),
  'logout-all-confirm': () => logoutEverywhere(),
  'password-modal': () => openPasswordModal(),
  'forgot-password': () => openResetRequest(),
  'reset-back': () => showLoginFromReset(),
  'cancel-password-reset': () => cancelPasswordReset(),
  'audit-log': () => openAuditModal(),
  'audit-refresh': () => renderAuditLog(),
  'trash-open': () => openTrashModal(),
  'trash-refresh': () => renderTrash(),
  'users-open': () => openUsersModal(),
  'save-officials': () => saveOfficials(),
  'mfa-open': () => openMfaModal(),
  'mfa-enroll': () => startMfaEnrollment(),
  'mfa-disable': () => disableMfa(),
  'mfa-recovery': () => showMfaRecovery(),
  'restore-team': el => restoreTrashItem('team', el.dataset.id),
  'restore-match': el => restoreTrashItem('match', el.dataset.id),
  'restore-season': el => restoreTrashItem('season', el.dataset.id),
  'toggle-signup': (el, event) => toggleSignup(event),
  'resend-confirmation': (el, event) => resendConfirmation(event),

  'new-match': () => openMatchModal(),
  'edit-match': el => editMatch(el.dataset.id),
  'delete-match': el => deleteMatch(el.dataset.id),
  'bump-score': el => bumpScore(el.dataset.id, el.dataset.side, Number(el.dataset.delta)),
  'live-entry': el => openLiveEntry(el.dataset.id),
  'remove-live-event': el => removeLiveEvent(el.dataset.id),
  'generate-fixtures': () => openGenerateModal(),
  'generate-save': () => saveGeneratedFixtures(),
  'shift-fixtures': () => openShiftModal(),
  'shift-apply': () => applyFixtureShift(),

  'new-team': () => openTeamModal(),
  'edit-team': el => editTeam(el.dataset.id),
  'delete-team': el => deleteTeam(el.dataset.id),
  'choose-team-icon': () => chooseTeamIcon(),
  'clear-team-icon': () => clearTeamIcon(),
  'new-player': el => openPlayerModal(el.dataset.team),
  'edit-player': el => editPlayer(el.dataset.id),
  'delete-player': el => deletePlayer(el.dataset.id),
  'restore-player': el => restorePlayer(el.dataset.id),

  'import-squad': el => openSquadImport(el.dataset.team),
  'squad-template': () => downloadSquadTemplate(),
  'squad-import-confirm': () => confirmSquadImport(),

  'add-event': el => addMatchEvent(el.dataset.side, el.dataset.type),
  'remove-event': el => removeMatchEvent(el.dataset.id),

  'data-menu': el => toggleDataMenu(el),
  'export-json': () => exportData(),
  'export-standings': () => exportStandingsCsv(),
  'export-fixtures': () => exportFixturesCsv(),
  'export-squads': () => exportSquadsCsv(),
  'import-open': () => openImportModal(),
  'import-choose-file': () => chooseImportFile(),
  'import-apply': () => applyImportMerge(),
  'import-replace-open': () => openImportReplace(),
  'import-replace-confirm': () => confirmImportReplace(),
  'reset-data': () => resetData(),

  'new-season': () => openSeasonModal(),
  'rename-season': () => openSeasonRenameModal(),
  'activate-season': () => activateViewedSeason(),
  'delete-season': () => deleteViewedSeason(),

  'clear-filters': () => clearFixtureFilters(),
  'clear-search': () => clearPlayerSearch(),
  'export-calendar': () => exportVisibleCalendar(),
  'export-team-calendar': el => exportTeamCalendar(el.dataset.team),
  'copy-link': () => copyViewLink()
};

const CHANGE_ACTIONS = {
  language: el => changeLanguage(el.value),
  season: el => selectSeason(el.value),
  division: el => selectDivision(el.value),
  'render-fixtures': () => renderFixtures(),
  'match-team-change': () => onMatchTeamChange(),
  'update-event': el => updateMatchEvent(el.dataset.id, el.dataset.field, el.value),
  'import-file': (el, event) => handleImportFile(event),
  'import-remove-missing': el => toggleImportRemoveMissing(el),
  'squad-file': (el, event) => handleSquadFile(event),
  'team-icon': (el, event) => handleTeamIconFile(event),
  'mfa-require': el => toggleRequireMfa(el),
  'live-team': el => { liveEntrySide = el.value === 'away' ? 'away' : 'home'; renderLiveEntry(); },
  'user-role': el => changeUserRole(el.dataset.id, el.value),
  'officials-match': el => {
    usersModalState.matchId = el.value;
    syncOfficialsDraft();
    renderUsersModal();
  },
  'toggle-official': el => {
    if (el.checked) usersModalState.draft.add(el.dataset.id);
    else usersModalState.draft.delete(el.dataset.id);
  }
};

const INPUT_ACTIONS = {
  search: () => renderTeamsView(),
  'update-goal-hint': () => updateMatchGoalHint(),
  'update-event': el => updateMatchEvent(el.dataset.id, el.dataset.field, el.value),
  'import-replace-word': el => onImportReplaceInput(el)
};

const SUBMIT_ACTIONS = {
  'save-match': (el, event) => saveMatch(event),
  'save-team': (el, event) => saveTeam(event),
  'save-season': (el, event) => saveSeason(event),
  'rename-season': (el, event) => saveSeasonRename(event),
  'save-player': (el, event) => savePlayer(event),
  login: (el, event) => handleLogin(event),
  signup: (el, event) => handleSignup(event),
  password: (el, event) => saveNewPassword(event),
  'request-password-reset': (el, event) => requestPasswordReset(event),
  'reset-password': (el, event) => saveRecoveredPassword(event),
  'mfa-verify': (el, event) => handleMfaVerifySubmit(event),
  'mfa-enroll-verify': (el, event) => handleMfaEnrollSubmit(event),
  'save-live-event': (el, event) => saveLiveEvent(event),
  'generate-preview': (el, event) => previewGeneratedFixtures(event),
  'shift-preview': (el, event) => previewFixtureShift(event)
};

/** Walk up from the event target to the nearest element declaring `attr`. */
function closestAction(target, attr) {
  return target instanceof Element ? target.closest('[' + attr + ']') : null;
}

function runDelegated(attr, handlers, event) {
  const el = closestAction(event.target, attr);
  if (!el) return false;
  const handler = handlers[el.getAttribute(attr)];
  if (!handler) return false;
  handler(el, event);
  return true;
}

/** Actions that mutate league data (they need an aal2 session when MFA is required). */
const MFA_GATED_ACTIONS = new Set([
  'new-match', 'edit-match', 'delete-match', 'bump-score',
  'live-entry', 'remove-live-event', 'users-open', 'save-officials',
  'new-team', 'edit-team', 'delete-team',
  'new-player', 'edit-player', 'delete-player', 'restore-player',
  'squad-import-confirm',
  'add-event', 'remove-event',
  'new-season', 'activate-season', 'delete-season', 'rename-season',
  'restore-team', 'restore-match', 'restore-season',
  'audit-log', 'trash-open',
  'generate-fixtures', 'generate-save', 'shift-fixtures', 'shift-apply',
  'import-open', 'import-apply', 'import-replace-confirm',
  'reset-data'
]);

/** Changes that write through an RPC when MFA is required. */
const MFA_GATED_CHANGES = new Set(['user-role']);

document.addEventListener('click', function (event) {
  const actionEl = closestAction(event.target, 'data-action');
  if (actionEl && MFA_GATED_ACTIONS.has(actionEl.dataset.action) &&
      typeof isMfaLocked === 'function' && isMfaLocked()) {
    event.preventDefault();
    openMfaModal();
    return;
  }
  if (runDelegated('data-action', CLICK_ACTIONS, event)) event.preventDefault();
});

document.addEventListener('change', function (event) {
  const changeEl = closestAction(event.target, 'data-change');
  if (changeEl && changeEl.dataset.change === 'import-file' &&
      typeof isMfaLocked === 'function' && isMfaLocked()) {
    changeEl.value = '';
    openMfaModal();
    return;
  }
  if (changeEl && MFA_GATED_CHANGES.has(changeEl.dataset.change) &&
      typeof isMfaLocked === 'function' && isMfaLocked()) {
    openMfaModal();
    if (changeEl.dataset.id) {
      const user = usersModalState.users.find(item => item.id === changeEl.dataset.id);
      if (user) changeEl.value = user.role;
    }
    return;
  }
  runDelegated('data-change', CHANGE_ACTIONS, event);
});

document.addEventListener('input', function (event) {
  runDelegated('data-input', INPUT_ACTIONS, event);
});

document.addEventListener('submit', function (event) {
  const submitEl = closestAction(event.target, 'data-submit');
  if (submitEl && submitEl.dataset.submit.startsWith('save-') &&
      typeof isMfaLocked === 'function' && isMfaLocked()) {
    event.preventDefault();
    openMfaModal();
    return;
  }
  if (runDelegated('data-submit', SUBMIT_ACTIONS, event)) event.preventDefault();
});

/* ---------- season helpers ---------- */

function getSeason(seasonId) {
  return (appState.seasons || []).find(season => season.id === seasonId);
}

function viewedSeason() {
  return getSeason(appState.viewSeasonId);
}

/* ---------- division helpers (roadmap K) ---------- */

function getDivision(divisionId) {
  return (appState.divisions || []).find(division => division.id === divisionId);
}

/** Localised tier name: Division 1 / Division 2 (adding d3 means one i18n key). */
function divisionLabel(divisionId) {
  const key = 'division_' + divisionId;
  const label = t(key);
  if (label && label !== key) return label;
  const division = getDivision(divisionId);
  return division ? division.name : String(divisionId || '');
}

/** The tier selected in the division switcher. */
function viewedDivisionId() {
  return appState.viewDivisionId || (appState.divisions && appState.divisions[0]
    ? appState.divisions[0].id
    : 'd1');
}

/** Clubs currently registered in the viewed division. */
function divisionTeams() {
  const divisionId = viewedDivisionId();
  return appState.teams.filter(team => (team.divisionId || 'd1') === divisionId);
}

function divisionTeamIds() {
  return new Set(divisionTeams().map(team => team.id));
}

/** Turn a rejected team move into a message the admin can act on. */
function saveTeamErrorMessage(error) {
  const message = String((error && error.message) || '');
  if (/cannot change division/i.test(message)) return t('alertTeamDivisionLocked');
  if (error && error.code === 'INTEGRITY_MIGRATION_REQUIRED') return t('alertIntegrityMigration');
  return t('alertSaveFailed');
}

/** True when the visible season is archived (or there is no active season yet). */
function isSeasonReadOnly() {
  if (!appState.seasonsReady) return false;
  return !appState.viewSeasonId || appState.viewSeasonId !== appState.activeSeasonId;
}

/** Matches for the season and division currently selected in the switchers. */
function visibleMatches() {
  const matchSeason = appState.seasonsReady && appState.viewSeasonId;
  const divisionId = viewedDivisionId();
  return appState.matches.filter(match =>
    (!matchSeason || match.seasonId === appState.viewSeasonId) &&
    (match.divisionId || 'd1') === divisionId
  );
}

/** Matches belonging to the one season that can receive new results. */
function activeMatches() {
  if (!appState.seasonsReady) return appState.matches;
  if (!appState.activeSeasonId) return [];
  return appState.matches.filter(match => match.seasonId === appState.activeSeasonId);
}

/** Admins may only log/edit matches while the active season is being viewed. */
function canEditMatches() {
  if (typeof isAdmin !== 'function' || !isAdmin()) return false;
  if (!appState.seasonsReady) return true;
  return Boolean(appState.activeSeasonId && appState.viewSeasonId === appState.activeSeasonId);
}

/* ---------- roadmap B: scorer live entry ---------- */

const LIVE_UNDO_WINDOW_MS = 15 * 60 * 1000;

/** YYYY-MM-DD in the browser's timezone, matching the stored local datetime. */
function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return String(value || '').slice(0, 10);
  const pad = part => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function matchIsToday(match) {
  if (!match || !match.datetime) return false;
  return localDateKey(match.datetime) === localDateKey(new Date());
}

/** True when the scorer may act on this fixture at all. */
function liveEntryWindowOpen(match) {
  if (!match || !appState.eventsReady) return false;
  if (match.eventsCounted === false) return false;
  if (appState.seasonsReady && match.seasonId !== appState.activeSeasonId) return false;
  if (match.status === 'LIVE') return true;
  return match.status === 'SCHEDULED' && matchIsToday(match);
}

function isAssignedScorer(matchId) {
  if (typeof isScorer !== 'function' || !isScorer()) return false;
  if (typeof currentUser === 'undefined' || !currentUser) return false;
  return (appState.matchOfficials || [])
    .some(row => row.matchId === matchId && row.userId === currentUser.id);
}

/** Admins may score any live/today fixture; scorers only their assignments. */
function canEnterLive(match) {
  if (!liveEntryWindowOpen(match)) return false;
  if (typeof isAdmin === 'function' && isAdmin()) return true;
  return isAssignedScorer(match.id);
}

function canUndoLiveEvent(event) {
  if (!event || !event.createdAt) return false;
  const match = appState.matches.find(m => m.id === event.matchId);
  if (!liveEntryWindowOpen(match)) return false;
  if (typeof isAdmin === 'function' && isAdmin()) return true;
  if (!isAssignedScorer(event.matchId)) return false;
  const created = new Date(event.createdAt).getTime();
  return !isNaN(created) && Date.now() - created <= LIVE_UNDO_WINDOW_MS;
}

/* ---------- loading / error banners ---------- */

function showDataError(error) {
  const banner = document.getElementById('data-error');
  const message = document.getElementById('data-error-text');
  const missingSchema = error && (
    error.code === 'PGRST205' ||
    /Could not find the table|could not find the table/i.test(error.message || '')
  );

  if (message) {
    message.textContent = t(missingSchema ? 'dbNotInstalledBanner' : 'dataErrorBanner');
  }
  if (banner) banner.classList.remove('hidden');
}

function hideDataError() {
  const banner = document.getElementById('data-error');
  if (banner) banner.classList.add('hidden');
}

/** Show which database the page is talking to (dev or local-production warning). */
function applyEnvironmentNotice() {
  const banner = document.getElementById('env-banner');
  const text = document.getElementById('env-banner-text');
  if (!banner || !text) return;

  const config = window.KICKOFF_CONFIG || {};

  if (config.ENVIRONMENT === 'development') {
    banner.className = 'bg-sky-500/10 border-b border-sky-500/30 text-sky-300 text-xs';
    text.textContent = t('envDevBanner');
  } else if (config.ENV_WARNING === 'localProd') {
    banner.className = 'bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-xs';
    text.textContent = t('envLocalProdBanner');
  } else if (config.ENV_WARNING === 'devMissing') {
    banner.className = 'bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-xs';
    text.textContent = t('envDevMissingBanner');
  } else {
    banner.className = 'hidden border-b text-xs';
    text.textContent = '';
  }
}

async function retryLoad() {
  try {
    await refreshData();
    hideDataError();
    renderApp();
  } catch (e) {
    showDataError(e);
  }
}

/* ---------------------------------------------------------------
 * 2. MAIN RENDERER & TAB NAVIGATION
 * --------------------------------------------------------------- */
function renderSeasonBar() {
  const bar = document.getElementById('season-bar');
  if (!bar) return;

  const supported = Boolean(appState.seasonsReady) || Boolean(appState.divisionsReady);
  bar.classList.toggle('hidden', !supported);

  const seasons = appState.seasons || [];
  const select = document.getElementById('season-select');
  if (select) {
    select.innerHTML = seasons.length
      ? seasons.map(season => `<option value="${esc(season.id)}">${esc(season.name)}${season.isActive ? ' — ' + esc(t('seasonActive')) : ''}</option>`).join('')
      : `<option value="">${esc(t('seasonNone'))}</option>`;
    select.value = appState.viewSeasonId || '';
    select.disabled = seasons.length === 0;
  }

  // Roadmap K: a fixed two-option tier switcher, hidden until the migration
  // has run and until there is more than one tier to choose from.
  const divisions = appState.divisions || [];
  const divisionSwitcher = document.getElementById('division-switcher');
  const divisionSelect = document.getElementById('division-select');
  const showDivisions = Boolean(appState.divisionsReady) && divisions.length > 1;
  if (divisionSwitcher) divisionSwitcher.classList.toggle('hidden', !showDivisions);
  if (divisionSelect && showDivisions) {
    divisionSelect.innerHTML = divisions
      .map(division => `<option value="${esc(division.id)}">${esc(divisionLabel(division.id))}</option>`)
      .join('');
    divisionSelect.value = viewedDivisionId();
  }

  const viewed = viewedSeason();
  const renameBtn = document.getElementById('btn-rename-season');
  if (renameBtn) renameBtn.classList.toggle('hidden', !viewed);
  const readOnly = isSeasonReadOnly();
  document.body.classList.toggle('season-readonly', readOnly);

  const status = document.getElementById('season-status');
  if (status) {
    const showStatus = supported && Boolean(viewed);
    status.classList.toggle('hidden', !showStatus);
    if (viewed) {
      const active = viewed.id === appState.activeSeasonId;
      status.textContent = t(active ? 'seasonActive' : 'seasonArchived');
      status.className = 'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide border ' +
        (active
          ? 'bg-pitch-500/15 text-pitch-400 border-pitch-500/30'
          : 'bg-amber-500/15 text-amber-300 border-amber-500/30');
      status.classList.toggle('hidden', !showStatus);
    }
  }

  const activateBtn = document.getElementById('btn-activate-season');
  if (activateBtn) {
    activateBtn.classList.toggle('hidden', !viewed || viewed.id === appState.activeSeasonId);
  }

  const deleteBtn = document.getElementById('btn-delete-season');
  if (deleteBtn) {
    const hasFixtures = viewed && (appState.matches || []).some(match => match.seasonId === viewed.id);
    const canDelete = Boolean(viewed && viewed.id !== appState.activeSeasonId && !hasFixtures);
    deleteBtn.classList.toggle('hidden', !canDelete);
  }
}

function selectSeason(seasonId) {
  if (!appState.seasonsReady) return;
  if (!(appState.seasons || []).some(season => season.id === seasonId)) return;
  appState.viewSeasonId = seasonId;
  renderApp();
}

/** Roadmap K: switch the fixed Division 1 / Division 2 view. */
function selectDivision(divisionId) {
  if (!appState.divisionsReady) return;
  if (!(appState.divisions || []).some(division => division.id === divisionId)) return;
  appState.viewDivisionId = divisionId;
  renderApp();
}

function renderApp() {
  applyEnvironmentNotice();
  renderSeasonBar();
  renderStandings();
  renderTopScorers();
  renderFixtureFilters();
  renderFixtures();
  renderTeamsView();
  renderStatsBanner();
  if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
  syncUrlState();
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-view').forEach(el => el.classList.add('hidden'));
  const view = document.getElementById('view-' + tabId);
  if (view) view.classList.remove('hidden');

  // Desktop tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const isActive = btn.id === 'nav-' + tabId;
    btn.classList.toggle('bg-slate-800', isActive);
    btn.classList.toggle('text-white', isActive);
    btn.classList.toggle('text-slate-400', !isActive);
    if (isActive) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });

  // Mobile tabs
  document.querySelectorAll('.mob-tab-btn').forEach(btn => {
    const isActive = btn.id === 'mob-nav-' + tabId;
    btn.classList.toggle('text-pitch-400', isActive);
    btn.classList.toggle('text-slate-400', !isActive);
    if (isActive) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });

  syncUrlState();
}

/* ---------------------------------------------------------------
 * 3. LEAGUE STANDINGS (points, W/D/L, goals, GD, form)
 * --------------------------------------------------------------- */
/**
 * Thin adapter over js/domain/standings.js. The pure function takes plain
 * arrays; this one supplies the visible season/division and keeps every
 * rendering call site unchanged.
 */
function calculateStandings() {
  const archived = appState.seasonsReady && appState.viewSeasonId !== appState.activeSeasonId;
  const teams = archived
    ? appState.teams
    : appState.teams.filter(team => (team.divisionId || 'd1') === viewedDivisionId());
  return globalThis.KickOffDomain.calculateStandings({
    teams,
    matches: visibleMatches(),
    archived
  });
}

function formBadge(f) {
  const cls = f === 'W' ? 'bg-pitch-500/20 text-pitch-400 border-pitch-500/30'
            : f === 'D' ? 'bg-slate-500/20 text-slate-400 border-slate-500/30'
                        : 'bg-rose-500/20 text-rose-400 border-rose-500/30';
  return `<span class="w-4 h-4 rounded-full ${cls} text-[9px] font-bold inline-flex items-center justify-center border">${f}</span>`;
}

/** Top scorers in the viewed division (player totals are career totals). */
function renderTopScorers() {
  const list = document.getElementById('top-scorers-list');
  if (!list) return;

  const teamIds = divisionTeamIds();
  const rows = appState.players
    .filter(player => player.isActive !== false && toInt(player.goals) > 0 && teamIds.has(player.teamId))
    .map(player => ({ player, team: getTeam(player.teamId), goals: toInt(player.goals) }))
    .filter(row => row.team)
    .sort((a, b) => b.goals - a.goals || a.player.name.localeCompare(b.player.name))
    .slice(0, 5);

  if (!rows.length) {
    list.innerHTML = `<p class="px-4 py-6 text-center text-xs text-slate-500">${esc(t('emptyTopScorers'))}</p>`;
    return;
  }

  list.innerHTML = rows.map((row, index) => `
    <div class="flex items-center gap-3 px-4 py-2.5">
      <span class="w-5 shrink-0 text-center text-[11px] font-bold text-slate-500">${index + 1}</span>
      ${teamMarkerHtml(row.team, 18)}
      <span class="min-w-0 flex-1 truncate text-sm font-medium text-slate-200">${esc(playerDisplayName(row.player))}</span>
      <span class="shrink-0 text-[10px] font-bold uppercase tracking-wide text-slate-500">${esc(row.team.code)}</span>
      <span class="w-8 shrink-0 text-end text-sm font-extrabold tabular-nums text-white">${row.goals}</span>
    </div>`).join('');
}

function renderStandings() {
  const tbody = document.getElementById('standings-table-body');
  const rows = calculateStandings();

  if (rows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="12" class="py-10 px-4 text-center">
          <i data-lucide="shield-plus" class="w-9 h-9 mx-auto mb-2 text-slate-600"></i>
          <p class="font-medium text-sm text-slate-300">${esc(t('noTeamsFound'))}</p>
          <p class="text-xs text-slate-500 mt-1">${esc(t('emptyNoTeamsHint'))}</p>
          <button data-action="new-team" class="admin-only mt-4 px-3 py-1.5 bg-pitch-600 hover:bg-pitch-500 text-white rounded-lg text-xs font-medium inline-flex items-center gap-1.5 transition">
            <i data-lucide="plus" class="w-3.5 h-3.5"></i> ${esc(t('btnAddTeam'))}
          </button>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = rows.map((s, i) => {
    const rank = i + 1;
    let rankBadge = 'bg-slate-800 text-slate-400';
    if (rank === 1) rankBadge = 'bg-amber-500/20 text-amber-400 border border-amber-500/30';
    else if (rank === 2) rankBadge = 'bg-slate-300/20 text-slate-200';
    else if (rank === 3) rankBadge = 'bg-amber-700/20 text-amber-500';

    const gdClass = s.gd > 0 ? 'text-pitch-400' : s.gd < 0 ? 'text-rose-400' : 'text-slate-400';
    const gdText = s.gd > 0 ? '+' + s.gd : s.gd;
    const ppg = s.mp > 0 ? (s.pts / s.mp).toFixed(2) : '0.00';

    return `
      <tr class="hover:bg-slate-800/40 transition">
        <td class="py-3 px-4 text-center">
          <span class="w-6 h-6 inline-flex items-center justify-center rounded-lg text-xs font-bold ${rankBadge}">${rank}</span>
        </td>
        <td class="py-3 px-4 font-semibold text-white">
          <span class="flex items-center gap-2.5">
            ${teamMarkerHtml(s.team, 20)}
            <span class="truncate max-w-[140px] sm:max-w-none">${esc(teamDisplayName(s.team))}</span>
            <span class="text-[10px] text-slate-400 font-normal uppercase hidden sm:inline">(${esc(s.team.code)})</span>
          </span>
        </td>
        <td class="py-3 px-3 text-center text-slate-300 font-medium">${s.mp}</td>
        <td class="py-3 px-3 text-center text-slate-300">${s.w}</td>
        <td class="py-3 px-3 text-center text-slate-400">${s.d}</td>
        <td class="py-3 px-3 text-center text-slate-400">${s.l}</td>
        <td class="py-3 px-3 text-center text-slate-400 hidden sm:table-cell">${s.gf}</td>
        <td class="py-3 px-3 text-center text-slate-400 hidden sm:table-cell">${s.ga}</td>
        <td class="py-3 px-3 text-center font-medium ${gdClass}">${gdText}</td>
        <td class="py-3 px-4 text-center font-extrabold text-white bg-slate-800/30">${s.pts}</td>
        <td class="py-3 px-3 text-center text-slate-400 hidden md:table-cell">${ppg}</td>
        <td class="py-3 px-4 text-center">
          <div class="flex items-center justify-center gap-1">${s.form.length ? s.form.map(formBadge).join('') : '<span class="text-slate-600 text-[10px]">-</span>'}</div>
        </td>
      </tr>`;
  }).join('');
}

/* ---------------------------------------------------------------
 * 3b. MATCH EVENTS (goals and cards with minutes)
 * --------------------------------------------------------------- */
let matchEventDraft = [];

/** Roadmap B live-entry dialog state. */
let liveEntryMatchId = null;
let liveEntrySide = 'home';
let liveEntrySaving = false;

/** Roadmap B Users & roles dialog state. */
let usersModalState = { loading: false, users: [], error: '', matchId: '', draft: new Set() };

function getMatchEvents(matchId) {
  return (appState.matchEvents || []).filter(event => event.matchId === matchId);
}

function playersForTeam(teamId) {
  return appState.players
    .filter(player => player.teamId === teamId && player.isActive !== false)
    .slice()
    .sort((a, b) => (toInt(a.num) - toInt(b.num)) || a.name.localeCompare(b.name));
}

/* formatEventMinute() lives in js/domain/standings.js (published on globalThis). */

/** Marker shown in the match timeline: ball for goals, coloured card otherwise. */
function matchEventMarker(event) {
  if (event.type === 'yellow' || event.type === 'red') {
    const red = event.type === 'red';
    return `<span class="inline-block w-2 h-3 rounded-[2px] ${red ? 'bg-rose-500' : 'bg-amber-400'}" aria-hidden="true"></span>`;
  }
  return `<span aria-hidden="true" class="text-[10px] leading-none">⚽</span>`;
}

/** One chronological row of the match timeline. */
function matchEventTimelineRow(event) {
  const player = appState.players.find(item => item.id === event.playerId);
  const team = getTeam(event.teamId);
  const name = esc(player ? playerDisplayName(player) : t('unknownPlayer'));
  const minute = formatEventMinute(event.minute);
  const label = t(event.type === 'red' ? 'eventRed' : event.type === 'yellow' ? 'eventYellow' : 'eventGoal');

  return `
    <li class="flex items-center gap-2 text-[11px] leading-5" title="${esc(label)}">
      <span class="w-7 shrink-0 text-end font-mono text-[10px] tabular-nums text-slate-500">${esc(minute)}</span>
      <span class="w-3 shrink-0 flex items-center justify-center">${matchEventMarker(event)}</span>
      <span class="min-w-0 flex-1 truncate text-slate-200">${name}</span>
      <span class="sr-only">${esc(label)}</span>
      <span class="shrink-0 text-[9px] font-bold uppercase tracking-wide text-slate-500">${esc(team ? team.code : '')}</span>
    </li>`;
}

/** Render structured events as a timeline, or fall back to the legacy free-text scorers field. */
function renderMatchEventSummary(match) {
  const events = getMatchEvents(match.id);

  if (events.length) {
    const ordered = events.slice().sort((a, b) => toInt(a.minute) - toInt(b.minute));
    const goals = ordered.filter(event => event.type === 'goal').length;
    const cards = ordered.length - goals;
    const summary = [
      goals ? `${goals} ${t(goals === 1 ? 'statGoalSingular' : 'statGoalsShort')}` : '',
      cards ? `${cards} ${t(cards === 1 ? 'statCardSingular' : 'statCardsShort')}` : ''
    ].filter(Boolean).join(' · ');

    return `<div class="mt-2 pt-2 border-t border-slate-700/40">
      <div class="flex items-center justify-between gap-2 mb-1">
        <span class="text-[9px] font-bold uppercase tracking-wider text-slate-500">${esc(t('lblTimeline'))}</span>
        <span class="text-[9px] tabular-nums text-slate-500">${esc(summary)}</span>
      </div>
      <ol class="space-y-0.5">${ordered.map(matchEventTimelineRow).join('')}</ol>
    </div>`;
  }

  if (match.scorersText) {
    return `<div class="mt-2 pt-2 border-t border-slate-700/40 text-[11px] text-slate-400 flex items-center gap-1.5">
      <i data-lucide="activity" class="w-3.5 h-3.5 text-pitch-400 shrink-0"></i>
      <span class="truncate">${esc(match.scorersText)}</span>
    </div>`;
  }

  // Finished match without any recorded detail: nudge the admin instead of leaving a blank card.
  if (match.status === 'FINISHED' && appState.eventsReady) {
    return `<div class="admin-only mt-2 pt-2 border-t border-slate-700/40 text-[10px] text-slate-500 flex items-center gap-1.5">
      <i data-lucide="clipboard-list" class="w-3 h-3 shrink-0"></i>
      <span>${esc(t('noEventsRecorded'))}</span>
    </div>`;
  }

  return '';
}

/** Thin adapter: the pure helper takes the player list explicitly. */
function summarizeEventsForText(events, homeId, awayId) {
  return globalThis.KickOffDomain.summarizeEventsForText(events, homeId, awayId, appState.players);
}

function collectMatchEvents(matchId) {
  if (!appState.eventsReady) return [];
  const homeId = document.getElementById('match-home-team').value;
  const awayId = document.getElementById('match-away-team').value;

  return matchEventDraft.map(event => {
    const player = appState.players.find(item => item.id === event.playerId);
    if (!player || player.teamId !== event.teamId) {
      throw new Error('Invalid player');
    }
    if (event.teamId !== homeId && event.teamId !== awayId) {
      throw new Error('Invalid team');
    }
    const minute = toInt(event.minute);
    if (!minute || minute < 1 || minute > 130) {
      throw new Error('Invalid minute');
    }
    return {
      id: event.id || uid('e'),
      matchId,
      teamId: event.teamId,
      playerId: event.playerId,
      type: ['goal', 'yellow', 'red'].includes(event.type) ? event.type : 'goal',
      minute
    };
  });
}

/* ---------------------------------------------------------------
 * 4. FIXTURES & RESULTS (filters, cards, live score updates)
 * --------------------------------------------------------------- */
function renderFixtureFilters() {
  const select = document.getElementById('filter-round');
  const previous = select.value || 'ALL';

  const rounds = [...new Set(visibleMatches().map(m => m.round))]
    .sort((a, b) => a - b);

  select.innerHTML = `<option value="ALL">${esc(t('optAllMatchdays'))}</option>` +
    rounds.map(r => `<option value="${r}">${esc(t('matchdayPrefix'))} ${r}</option>`).join('');

  select.value = rounds.map(String).includes(previous) ? previous : 'ALL';
}

function renderFixtures() {
  const container = document.getElementById('fixtures-container');
  const roundFilter = document.getElementById('filter-round').value;
  const statusFilter = document.getElementById('filter-status').value;
  const clearButton = document.getElementById('btn-clear-filters');
  const filtering = roundFilter !== 'ALL' || statusFilter !== 'ALL';

  if (clearButton) clearButton.classList.toggle('hidden', !filtering);

  const seasonMatches = visibleMatches();
  let matches = seasonMatches.slice();
  if (roundFilter !== 'ALL') matches = matches.filter(m => String(m.round) === roundFilter);
  if (statusFilter !== 'ALL') matches = matches.filter(m => m.status === statusFilter);

  matches.sort((a, b) =>
    (a.round - b.round) || (a.datetime || '').localeCompare(b.datetime || '')
  );

  if (matches.length === 0) {
    // Distinguish "nothing scheduled yet" from "nothing matches these filters".
    container.innerHTML = filtering ? `
      <div class="col-span-full bg-slate-800/30 border border-slate-800 rounded-xl p-8 text-center">
        <i data-lucide="filter-x" class="w-8 h-8 mx-auto mb-2 text-slate-600"></i>
        <p class="font-medium text-sm text-slate-300">${esc(t('emptyFiltered'))}</p>
        <p class="text-xs text-slate-500 mt-1">${esc(t('emptyFilteredHint'))}</p>
        <button data-action="clear-filters" class="mt-4 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 transition">
          <i data-lucide="x" class="w-3.5 h-3.5"></i> ${esc(t('btnClearFilters'))}
        </button>
      </div>` : `
      <div class="col-span-full bg-slate-800/30 border border-slate-800 rounded-xl p-8 text-center">
        <i data-lucide="calendar-plus" class="w-8 h-8 mx-auto mb-2 text-slate-600"></i>
        <p class="font-medium text-sm text-slate-300">${esc(t('emptyNoFixtures'))}</p>
        <p class="text-xs text-slate-500 mt-1">${esc(t('emptyNoFixturesHint'))}</p>
        <button data-action="new-match" class="admin-only season-write mt-4 px-3 py-1.5 bg-pitch-600 hover:bg-pitch-500 text-white rounded-lg text-xs font-medium inline-flex items-center gap-1.5 transition">
          <i data-lucide="plus" class="w-3.5 h-3.5"></i> ${esc(t('btnLogFirstMatch'))}
        </button>
      </div>`;
    refreshIcons();
    syncUrlState();
    return;
  }

  // Highlight the soonest fixture that has not kicked off yet.
  const now = Date.now();
  const nextMatch = seasonMatches
    .filter(m => m.status === 'SCHEDULED')
    .slice()
    .sort((a, b) => {
      const aTime = a.datetime ? new Date(a.datetime).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.datetime ? new Date(b.datetime).getTime() : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    })
    .find(m => !m.datetime || new Date(m.datetime).getTime() >= now - 6 * 60 * 60 * 1000);

  container.innerHTML = matches.map(m => {
    const home = getTeam(m.homeId) || { name: '?', code: '??', color: '#334155' };
    const away = getTeam(m.awayId) || { name: '?', code: '??', color: '#334155' };
    const isNext = Boolean(nextMatch && nextMatch.id === m.id);

    const badge = m.status === 'FINISHED'
      ? `<span class="bg-slate-700/60 text-slate-300 text-[10px] font-bold px-2 py-0.5 rounded border border-slate-600">${esc(t('optFinished'))}</span>`
      : m.status === 'LIVE'
      ? `<span class="bg-rose-500/20 text-rose-400 text-[10px] font-bold px-2 py-0.5 rounded border border-rose-500/30 animate-pulse flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-rose-400 animate-ping"></span>${esc(t('optLiveNow'))}</span>`
      : `<span class="bg-blue-500/20 text-blue-400 text-[10px] font-bold px-2 py-0.5 rounded border border-blue-500/30">${esc(t('optUpcoming'))}</span>`;

    const nextBadge = isNext
      ? `<span class="bg-pitch-500/15 text-pitch-400 text-[10px] font-bold px-2 py-0.5 rounded border border-pitch-500/30 flex items-center gap-1"><i data-lucide="clock" class="w-2.5 h-2.5"></i>${esc(t('badgeNextUp'))}</span>`
      : '';

    const matchDate = m.datetime
      ? new Date(m.datetime).toLocaleString(currentLang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';

    const scoreBlock = m.status === 'SCHEDULED'
      ? `<span class="text-xs font-bold text-slate-400 bg-slate-900 px-2 py-1 rounded">${esc(t('lblVs'))}</span>`
      : `<span class="text-xl font-extrabold text-white tracking-wider bg-slate-900/80 px-2.5 py-1 rounded border border-slate-700">${toInt(m.homeScore)} - ${toInt(m.awayScore)}</span>`;

    // Live matches get quick +1 steppers for instant live score logging
    const liveSteppers = m.status === 'LIVE' ? `
      <div class="admin-only season-write flex items-center justify-center gap-3 mt-1.5">
        <button data-action="bump-score" data-id="${esc(m.id)}" data-side="home" data-delta="1" class="w-6 h-6 rounded bg-pitch-600/80 hover:bg-pitch-500 text-white text-xs font-bold transition" title="+1">+</button>
        <button data-action="bump-score" data-id="${esc(m.id)}" data-side="away" data-delta="1" class="w-6 h-6 rounded bg-pitch-600/80 hover:bg-pitch-500 text-white text-xs font-bold transition" title="+1">+</button>
      </div>` : '';

    const scorers = renderMatchEventSummary(m);

    // Roadmap B: scorers get the narrow live-entry dialog on assigned
    // fixtures; admins get the same button on every live/today fixture.
    const liveEntryButton = canEnterLive(m)
      ? `<button data-action="live-entry" data-id="${esc(m.id)}" class="px-2.5 py-1 bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 rounded text-xs font-semibold flex items-center gap-1 transition">
           <i data-lucide="activity" class="w-3 h-3"></i> ${esc(t('btnLiveEntry'))}
         </button>`
      : '';

    return `
      <div class="bg-slate-800/60 border ${isNext ? 'border-pitch-500/40' : 'border-slate-700/70'} rounded-xl p-4 shadow-sm hover:border-slate-600 transition flex flex-col justify-between">
        <div class="flex justify-between items-center text-xs text-slate-400 mb-3 pb-2 border-b border-slate-700/50 gap-2">
          <span class="font-medium text-slate-300 truncate">${esc(t('matchdayPrefix'))} ${m.round} • ${esc(m.venue || '')}</span>
          <div class="flex items-center gap-2 shrink-0">
            ${nextBadge}
            <span>${esc(matchDate)}</span>
            ${badge}
          </div>
        </div>

        <div class="grid grid-cols-7 items-center gap-2 my-2 text-center">
          <div class="col-span-3 flex flex-col items-center">
            ${teamCrestHtml(home, 32, 'mb-1')}
            <span class="font-semibold text-sm text-white truncate max-w-full">${esc(teamDisplayName(home))}</span>
          </div>
          <div class="col-span-1 flex flex-col items-center justify-center">
            ${scoreBlock}
            ${liveSteppers}
          </div>
          <div class="col-span-3 flex flex-col items-center">
            ${teamCrestHtml(away, 32, 'mb-1')}
            <span class="font-semibold text-sm text-white truncate max-w-full">${esc(teamDisplayName(away))}</span>
          </div>
        </div>

        ${scorers}

        <div class="mt-3 pt-2 border-t border-slate-700/50 flex flex-wrap justify-end items-center gap-2">
          ${liveEntryButton}
          <div class="admin-only season-write flex items-center gap-2">
            <button data-action="edit-match" data-id="${esc(m.id)}" class="px-2.5 py-1 text-slate-300 hover:text-white bg-slate-700/50 hover:bg-slate-700 rounded text-xs flex items-center gap-1 transition">
              <i data-lucide="edit-3" class="w-3 h-3"></i> ${esc(t('editAction'))}
            </button>
            <button data-action="delete-match" data-id="${esc(m.id)}" class="px-2 py-1 text-rose-400 hover:bg-rose-500/20 rounded text-xs transition" aria-label="${esc(t('ariaDeleteMatch'))}" title="${esc(t('ariaDeleteMatch'))}">
              <i data-lucide="trash-2" class="w-3 h-3"></i>
            </button>
          </div>
        </div>
      </div>`;
  }).join('');

  refreshIcons();
  syncUrlState();
}

/** Reset both fixture filters and re-render. */
function clearFixtureFilters() {
  const roundSelect = document.getElementById('filter-round');
  const statusSelect = document.getElementById('filter-status');
  if (roundSelect) roundSelect.value = 'ALL';
  if (statusSelect) statusSelect.value = 'ALL';
  renderFixtures();
}

/** Quick live-score update from fixture cards (used for LIVE matches). */
async function bumpScore(matchId, side, delta) {
  if (!canEditMatches()) {
    alert(t('alertArchiveReadOnly'));
    return;
  }

  const match = appState.matches.find(m => m.id === matchId);
  if (!match) return;
  if (appState.seasonsReady && match.seasonId !== appState.activeSeasonId) {
    alert(t('alertArchiveReadOnly'));
    return;
  }

  const key = side === 'home' ? 'homeScore' : 'awayScore';
  const previous = toInt(match[key]);
  match[key] = Math.max(0, previous + delta);

  try {
    await dbSaveMatch(match);
    await refreshData();
    renderApp();
  } catch (e) {
    match[key] = previous;
    renderApp();
    alert(t('alertSaveFailed'));
  }
}

/* ---------------------------------------------------------------
 * 4b. LIVE MATCH ENTRY (roadmap B)
 *     A scorer records one goal/card at a time through a narrow RPC.
 *     The server enforces assignment, the live/today window and the
 *     undo limit; this dialog only mirrors those rules.
 * --------------------------------------------------------------- */

function openLiveEntry(matchId) {
  const match = appState.matches.find(m => m.id === matchId);
  if (!match) return;
  if (!canEnterLive(match)) {
    alert(t('liveEntryClosed'));
    return;
  }
  liveEntryMatchId = matchId;
  liveEntrySide = 'home';
  openModal('modal-live');
  renderLiveEntry();
}

function refreshLiveEntryIfOpen() {
  const modal = document.getElementById('modal-live');
  if (modal && !modal.classList.contains('hidden')) renderLiveEntry();
}

function renderLiveEntry() {
  const body = document.getElementById('live-entry-body');
  if (!body) return;

  const match = appState.matches.find(m => m.id === liveEntryMatchId);
  if (!match) {
    body.innerHTML = `<p class="text-xs text-slate-400">${esc(t('liveEntryClosed'))}</p>`;
    return;
  }

  const home = getTeam(match.homeId) || { name: '?', code: '??' };
  const away = getTeam(match.awayId) || { name: '?', code: '??' };
  const allowed = canEnterLive(match);
  const events = getMatchEvents(match.id).slice()
    .sort((a, b) => toInt(a.minute) - toInt(b.minute));

  const eventRows = events.length
    ? events.map(event => {
        const player = appState.players.find(item => item.id === event.playerId);
        const typeKey = event.type === 'red' ? 'eventRed' : event.type === 'yellow' ? 'eventYellow' : 'eventGoal';
        const undoButton = canUndoLiveEvent(event)
          ? `<button type="button" data-action="remove-live-event" data-id="${esc(event.id)}"
                     class="w-6 h-6 rounded text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 flex items-center justify-center transition"
                     title="${esc(t('liveEntryUndo'))}" aria-label="${esc(t('liveEntryUndo'))}">
               <i data-lucide="undo-2" class="w-3 h-3"></i>
             </button>`
          : (allowed && event.createdAt
              ? `<span class="w-6 h-6 flex items-center justify-center text-slate-600" title="${esc(t('liveEntryUndoClosed'))}">
                   <i data-lucide="lock" class="w-3 h-3"></i>
                 </span>`
              : '');
        return `<li class="flex items-center gap-2 text-[11px] leading-5">
          <span class="w-8 shrink-0 text-end font-mono text-[10px] tabular-nums text-slate-500">${esc(formatEventMinute(event.minute))}</span>
          <span class="w-3 shrink-0 flex items-center justify-center">${matchEventMarker(event)}</span>
          <span class="min-w-0 flex-1 truncate text-slate-200">${esc(player ? playerDisplayName(player) : t('unknownPlayer'))}</span>
          <span class="shrink-0 text-[10px] text-slate-500">${esc(t(typeKey))}</span>
          ${undoButton}
        </li>`;
      }).join('')
    : `<li class="py-3 text-center text-[11px] text-slate-500">${esc(t('liveEntryEmpty'))}</li>`;

  const teamId = liveEntrySide === 'away' ? match.awayId : match.homeId;
  const players = playersForTeam(teamId);
  const lastMinute = events.reduce((max, event) => Math.max(max, toInt(event.minute)), 0);
  const nextMinute = Math.min(130, Math.max(1, lastMinute + 1));
  const score = match.status === 'SCHEDULED'
    ? t('lblVs')
    : `${toInt(match.homeScore)} - ${toInt(match.awayScore)}`;

  const playerOptions = players
    .map(player => `<option value="${esc(player.id)}">${esc(`#${toInt(player.num)} ${playerDisplayName(player)}`)}</option>`)
    .join('');

  const form = allowed ? `
    <form data-submit="save-live-event" class="space-y-3 border-t border-slate-800 pt-3">
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="text-[11px] font-medium text-slate-400 block mb-1" for="live-entry-team">${esc(t('liveEntryTeam'))}</label>
          <select id="live-entry-team" data-change="live-team" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:border-pitch-500">
            <option value="home" ${liveEntrySide === 'home' ? 'selected' : ''}>${esc(teamDisplayName(home))}</option>
            <option value="away" ${liveEntrySide === 'away' ? 'selected' : ''}>${esc(teamDisplayName(away))}</option>
          </select>
        </div>
        <div>
          <label class="text-[11px] font-medium text-slate-400 block mb-1" for="live-entry-player">${esc(t('liveEntryPlayer'))}</label>
          <select id="live-entry-player" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:border-pitch-500">
            ${playerOptions}
          </select>
        </div>
        <div>
          <label class="text-[11px] font-medium text-slate-400 block mb-1" for="live-entry-type">${esc(t('liveEntryType'))}</label>
          <select id="live-entry-type" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:border-pitch-500">
            <option value="goal">${esc(t('eventGoal'))}</option>
            <option value="yellow">${esc(t('eventYellow'))}</option>
            <option value="red">${esc(t('eventRed'))}</option>
          </select>
        </div>
        <div>
          <label class="text-[11px] font-medium text-slate-400 block mb-1" for="live-entry-minute">${esc(t('liveEntryMinute'))}</label>
          <input id="live-entry-minute" type="number" min="1" max="130" value="${nextMinute}" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white text-center focus:border-pitch-500">
        </div>
      </div>
      ${players.length ? '' : `<p class="text-[11px] text-amber-300">${esc(t('liveEntryNoPlayers'))}</p>`}
      <button type="submit" ${players.length ? '' : 'disabled'} class="w-full px-3 py-2 bg-pitch-600 hover:bg-pitch-500 text-white rounded-lg text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 transition">
        <i data-lucide="plus" class="w-3.5 h-3.5"></i> ${esc(t('liveEntryAdd'))}
      </button>
    </form>` : `<p class="text-[11px] text-slate-500 border-t border-slate-800 pt-3">${esc(t('liveEntryClosed'))}</p>`;

  body.innerHTML = `
    <div class="flex items-center justify-between gap-3 rounded-xl bg-slate-950/60 border border-slate-800 px-3 py-2">
      <span class="min-w-0 flex-1 flex items-center gap-1.5 text-sm font-semibold text-white">
        ${teamCrestHtml(home, 24)}
        <span class="min-w-0 truncate">${esc(teamDisplayName(home))}</span>
      </span>
      <span class="shrink-0 text-lg font-extrabold tracking-wider text-white">${esc(score)}</span>
      <span class="min-w-0 flex-1 flex items-center justify-end gap-1.5 text-sm font-semibold text-white">
        <span class="min-w-0 truncate">${esc(teamDisplayName(away))}</span>
        ${teamCrestHtml(away, 24)}
      </span>
    </div>
    <p class="text-[11px] text-slate-500 leading-relaxed">${esc(t('liveEntryHint'))}</p>
    <ol class="space-y-0.5 rounded-xl bg-slate-950/40 border border-slate-800 px-3 py-2">${eventRows}</ol>
    ${form}`;

  refreshIcons();
}

async function saveLiveEvent(event) {
  event.preventDefault();
  if (liveEntrySaving) return;

  const match = appState.matches.find(m => m.id === liveEntryMatchId);
  if (!match || !canEnterLive(match)) {
    alert(t('liveEntryClosed'));
    return;
  }

  const button = event.target.querySelector('button[type="submit"]');
  const side = document.getElementById('live-entry-team').value === 'away' ? 'away' : 'home';
  const teamId = side === 'away' ? match.awayId : match.homeId;
  const playerId = document.getElementById('live-entry-player').value;
  const type = document.getElementById('live-entry-type').value;
  const minute = toInt(document.getElementById('live-entry-minute').value);

  if (!playerId) {
    alert(t('liveEntryNoPlayers'));
    return;
  }
  if (!['goal', 'yellow', 'red'].includes(type) || minute < 1 || minute > 130) {
    alert(t('alertInvalidMatchEvent'));
    return;
  }

  liveEntrySaving = true;
  if (button) button.disabled = true;
  try {
    await dbRecordLiveEvent(match.id, teamId, playerId, type, minute);
    await refreshData();
    renderApp();
    renderLiveEntry();
    showToast(t('liveEntrySaved'));
  } catch (err) {
    alert(t('alertLiveEntryFailed'));
  } finally {
    liveEntrySaving = false;
    if (button && button.isConnected) button.disabled = false;
  }
}

async function removeLiveEvent(eventId) {
  const stored = (appState.matchEvents || []).find(event => event.id === eventId);
  if (!stored) return;
  if (!canUndoLiveEvent(stored)) {
    alert(t('alertLiveEntryUndoFailed'));
    return;
  }
  if (!confirm(t('confirmRemoveLiveEvent'))) return;

  try {
    await dbRemoveLiveEvent(eventId);
    await refreshData();
    renderApp();
    renderLiveEntry();
    showToast(t('liveEntryRemoved'));
  } catch (err) {
    alert(t('alertLiveEntryUndoFailed'));
  }
}

/* ---------------------------------------------------------------
 * 5. TEAMS & PLAYER ROSTERS
 * --------------------------------------------------------------- */
function renderTeamsView() {
  const container = document.getElementById('teams-container');
  const query = (document.getElementById('player-search').value || '').trim().toLowerCase();
  const teams = divisionTeams();

  if (teams.length === 0) {
    container.innerHTML = `
      <div class="col-span-full bg-slate-800/30 border border-slate-800 rounded-xl p-8 text-center">
        <i data-lucide="shield-plus" class="w-8 h-8 mx-auto mb-2 text-slate-600"></i>
        <p class="font-medium text-sm text-slate-300">${esc(t('emptyDivisionTeams'))}</p>
        <p class="text-xs text-slate-500 mt-1">${esc(t('emptyDivisionTeamsHint'))}</p>
        <button data-action="new-team" class="admin-only mt-4 px-3 py-1.5 bg-pitch-600 hover:bg-pitch-500 text-white rounded-lg text-xs font-medium inline-flex items-center gap-1.5 transition">
          <i data-lucide="plus" class="w-3.5 h-3.5"></i> ${esc(t('btnAddTeam'))}
        </button>
      </div>`;
    refreshIcons();
    syncUrlState();
    return;
  }

  container.innerHTML = teams.map(team => {
    const allSquad = appState.players.filter(p => p.teamId === team.id);
    let squad = allSquad.filter(p => p.isActive !== false);
    let archived = (typeof isAdmin === 'function' && isAdmin())
      ? allSquad.filter(p => p.isActive === false)
      : [];
    if (query) {
      const teamMatches = team.name.toLowerCase().includes(query) ||
        String(team.nameAr || '').toLowerCase().includes(query);
      const playerMatches = p => p.name.toLowerCase().includes(query) ||
        String(p.nameAr || '').toLowerCase().includes(query);
      if (!teamMatches) {
        squad = squad.filter(playerMatches);
        archived = archived.filter(playerMatches);
      }
      if (!teamMatches && squad.length === 0 && archived.length === 0) return '';
    }
    const totalSquad = squad.length;

    return `
      <div class="bg-slate-800/60 border border-slate-700/70 rounded-xl overflow-hidden shadow-sm flex flex-col">
        <div class="bg-slate-900/80 p-4 border-b border-slate-700 flex justify-between items-center gap-2">
          <div class="flex items-center gap-3 min-w-0">
            ${teamIconSrc(team)
              ? teamIconHtml(team, 40)
              : `<div class="w-2 h-8 rounded-full shrink-0" style="background-color:${esc(team.color || '#22c55e')}"></div>`}
            <div class="min-w-0">
              <h3 class="font-bold text-base text-white truncate">${esc(teamDisplayName(team))}</h3>
              <p class="text-xs text-slate-400">${totalSquad} ${esc(t('lblPlayers'))} • ${esc(team.code)} • <span class="text-pitch-400">${esc(divisionLabel(team.divisionId))}</span></p>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button data-action="export-team-calendar" data-team="${esc(team.id)}" class="p-1.5 text-slate-500 hover:text-pitch-400 rounded transition" aria-label="${esc(t('btnCalendarTeam').replace('{team}', teamDisplayName(team)))}" title="${esc(t('btnCalendarTeam').replace('{team}', teamDisplayName(team)))}">
              <i data-lucide="calendar-plus" class="w-4 h-4"></i>
            </button>
            <div class="admin-only flex items-center gap-2 shrink-0">
              <button data-action="import-squad" data-team="${esc(team.id)}" class="p-1.5 text-slate-500 hover:text-pitch-400 rounded transition" aria-label="${esc(t('btnImportSquad'))}" title="${esc(t('btnImportSquad'))}">
                <i data-lucide="file-spreadsheet" class="w-4 h-4"></i>
              </button>
              <button data-action="new-player" data-team="${esc(team.id)}" class="px-2.5 py-1.5 bg-pitch-600/20 text-pitch-400 hover:bg-pitch-600/30 border border-pitch-500/30 rounded-lg text-xs font-medium flex items-center gap-1 transition">
                <i data-lucide="user-plus" class="w-3.5 h-3.5"></i> ${esc(t('btnAddPlayer'))}
              </button>
              <button data-action="edit-team" data-id="${esc(team.id)}" class="p-1.5 text-slate-500 hover:text-white rounded transition" aria-label="${esc(t('editAction'))}" title="${esc(t('editAction'))}">
                <i data-lucide="edit-3" class="w-4 h-4"></i>
              </button>
              <button data-action="delete-team" data-id="${esc(team.id)}" class="p-1.5 text-slate-500 hover:text-rose-400 rounded transition" aria-label="${esc(t('ariaDeleteTeam'))}" title="${esc(t('ariaDeleteTeam'))}">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            </div>
          </div>
        </div>

        <div class="p-3 flex-1 overflow-x-auto">
          ${squad.length === 0 ? `
            <p class="text-xs text-slate-400 text-center py-4">${esc(t('noPlayersFound'))}</p>
          ` : `
            <table class="w-full text-left rtl:text-right text-xs">
              <thead class="text-slate-400 border-b border-slate-700/60">
                <tr>
                  <th class="pb-2 w-8">#</th>
                  <th class="pb-2">${esc(t('thPlayer'))}</th>
                  ${appState.profilesReady ? `<th class="pb-2 text-center admin-only">${esc(t('thLicense'))}</th>` : ''}
                  <th class="pb-2 text-center">${esc(t('lblPosition'))}</th>
                  <th class="pb-2 text-center">${esc(t('lblGoals'))}</th>
                  <th class="pb-2 text-center">${esc(t('thCards'))}</th>
                  <th class="pb-2 ltr:text-right rtl:text-left">${esc(t('thAction'))}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-700/40">
                ${squad.map(p => `
                  <tr class="hover:bg-slate-800/40">
                    <td class="py-2 text-slate-400 font-medium">${esc(p.num)}</td>
                    <td class="py-2 font-semibold text-slate-200">${esc(playerDisplayName(p))}</td>
                    ${appState.profilesReady ? `<td class="py-2 text-center admin-only">
                      <div class="text-slate-300">${esc(p.licenseId || '—')}</div>
                      ${p.birthDate ? `<div class="text-[10px] text-slate-500">${esc(formatIsoDate(p.birthDate))}</div>` : ''}
                    </td>` : ''}
                    <td class="py-2 text-center">
                      <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-700 text-slate-300">${esc(p.pos)}</span>
                    </td>
                    <td class="py-2 text-center font-bold text-pitch-400">${toInt(p.goals)}</td>
                    <td class="py-2 text-center">
                      <span class="inline-flex items-center gap-1 justify-center">
                        ${toInt(p.yellow) > 0 ? `<span class="w-2.5 h-3 bg-amber-400 rounded-sm inline-block"></span><span class="text-[10px] text-slate-400">${toInt(p.yellow)}</span>` : ''}
                        ${toInt(p.red) > 0 ? `<span class="w-2.5 h-3 bg-rose-500 rounded-sm inline-block"></span><span class="text-[10px] text-slate-400">${toInt(p.red)}</span>` : ''}
                        ${toInt(p.yellow) === 0 && toInt(p.red) === 0 ? '<span class="text-slate-600">-</span>' : ''}
                      </span>
                    </td>
                    <td class="py-2 ltr:text-right rtl:text-left whitespace-nowrap">
                      <span class="admin-only">
                        <button data-action="edit-player" data-id="${esc(p.id)}" class="text-slate-500 hover:text-white p-1" aria-label="${esc(t('editAction'))}" title="${esc(t('editAction'))}"><i data-lucide="edit-3" class="w-3.5 h-3.5"></i></button>
                        <button data-action="delete-player" data-id="${esc(p.id)}" class="text-slate-500 hover:text-rose-400 p-1" aria-label="${esc(t('ariaDeletePlayer'))}" title="${esc(t('ariaDeletePlayer'))}"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
                      </span>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>`}
          ${archived.length ? `
            <div class="mt-3 pt-3 border-t border-slate-700/60 admin-only">
              <p class="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-2">${esc(t('archivedPlayers'))}</p>
              <div class="space-y-1">
                ${archived.map(p => `
                  <div class="flex items-center justify-between gap-2 text-[11px] text-slate-400">
                    <span class="truncate">${esc(playerDisplayName(p))} <span class="text-slate-600">#${esc(p.num)}</span></span>
                    <button data-action="restore-player" data-id="${esc(p.id)}" class="text-pitch-400 hover:text-pitch-300 px-1.5 py-0.5 rounded border border-pitch-500/30 shrink-0">${esc(t('btnRestorePlayer'))}</button>
                  </div>`).join('')}
              </div>
            </div>` : ''}
        </div>
      </div>`;
  }).join('');

  // A search that matches nobody should say so instead of leaving a blank grid.
  if (query && container.children.length === 0) {
    container.innerHTML = `
      <div class="col-span-full bg-slate-800/30 border border-slate-800 rounded-xl p-8 text-center">
        <i data-lucide="search-x" class="w-8 h-8 mx-auto mb-2 text-slate-600"></i>
        <p class="font-medium text-sm text-slate-300">${esc(t('emptyNoSearchResults'))}</p>
        <button data-action="clear-search" class="mt-4 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 transition">
          <i data-lucide="x" class="w-3.5 h-3.5"></i> ${esc(t('btnClearSearch'))}
        </button>
      </div>`;
  }

  refreshIcons();
  syncUrlState();
}

/** Reset the squad search box. */
function clearPlayerSearch() {
  const search = document.getElementById('player-search');
  if (search) search.value = '';
  renderTeamsView();
}

/* ---------------------------------------------------------------
 * 6. STATS BANNER
 * --------------------------------------------------------------- */
function renderStatsBanner() {
  const finished = visibleMatches().filter(m => m.status === 'FINISHED');
  const totalGoals = finished.reduce((sum, m) => sum + toInt(m.homeScore) + toInt(m.awayScore), 0);
  const teamIds = divisionTeamIds();

  document.getElementById('stat-teams-count').textContent = divisionTeams().length;
  document.getElementById('stat-matches-played').textContent = finished.length;
  document.getElementById('stat-total-goals').textContent = totalGoals;

  const scorers = appState.players
    .filter(player => teamIds.has(player.teamId))
    .slice()
    .sort((a, b) => toInt(b.goals) - toInt(a.goals));
  document.getElementById('stat-top-scorer').textContent =
    scorers.length && toInt(scorers[0].goals) > 0 ? `${playerDisplayName(scorers[0])} (${toInt(scorers[0].goals)})` : '--';
}

/* ---------------------------------------------------------------
 * 7. MATCH MODAL (schedule, log result, edit, live)
 * --------------------------------------------------------------- */
function openMatchModal(matchId) {
  if (!canEditMatches()) {
    alert(t('alertArchiveReadOnly'));
    return;
  }
  if (appState.seasonsReady && !appState.activeSeasonId) {
    alert(t('alertNoActiveSeason'));
    return;
  }

  let existingDivisionId = viewedDivisionId();
  if (matchId) {
    const existing = appState.matches.find(m => m.id === matchId);
    if (!existing) return;
    if (appState.seasonsReady && existing.seasonId !== appState.activeSeasonId) {
      alert(t('alertArchiveReadOnly'));
      return;
    }
    existingDivisionId = existing.divisionId || existingDivisionId;
  }

  const divisionTeamsForMatch = appState.teams
    .filter(team => (team.divisionId || 'd1') === existingDivisionId);
  if (divisionTeamsForMatch.length < 2) {
    alert(t('alertMinDivisionTeams'));
    openTeamModal();
    return;
  }

  const homeSelect = document.getElementById('match-home-team');
  const awaySelect = document.getElementById('match-away-team');
  const teamOptions = divisionTeamsForMatch.map(team => `<option value="${esc(team.id)}">${esc(teamDisplayName(team))}</option>`).join('');
  homeSelect.innerHTML = teamOptions;
  awaySelect.innerHTML = teamOptions;

  document.getElementById('form-match').reset();
  document.getElementById('match-id').value = '';

  // Sensible defaults for a new fixture
  const divisionActive = activeMatches().filter(m => (m.divisionId || 'd1') === existingDivisionId);
  const nextRound = divisionActive.reduce((max, m) => Math.max(max, toInt(m.round)), 0) + 1;
  document.getElementById('match-round').value = Math.max(1, nextRound);
  document.getElementById('match-status').value = 'SCHEDULED';
  document.getElementById('match-home-score').value = 0;
  document.getElementById('match-away-score').value = 0;
  document.getElementById('match-datetime').value = new Date().toISOString().slice(0, 16);
  awaySelect.selectedIndex = Math.min(1, divisionTeamsForMatch.length - 1);

  document.getElementById('match-modal-title').textContent = t('modalMatchTitle');

  matchEventDraft = matchId
    ? getMatchEvents(matchId).map(event => ({ ...event }))
    : [];

  if (matchId) prefillMatchModal(matchId);
  renderMatchEventsEditor();
  openModal('modal-match');
}

function prefillMatchModal(matchId) {
  const m = appState.matches.find(x => x.id === matchId);
  if (!m) return;

  document.getElementById('match-id').value = m.id;
  document.getElementById('match-round').value = m.round;
  document.getElementById('match-status').value = m.status;
  document.getElementById('match-datetime').value = m.datetime || '';
  document.getElementById('match-venue').value = m.venue || '';
  document.getElementById('match-home-team').value = m.homeId;
  document.getElementById('match-away-team').value = m.awayId;
  document.getElementById('match-home-score').value = toInt(m.homeScore);
  document.getElementById('match-away-score').value = toInt(m.awayScore);
  document.getElementById('match-scorers-text').value = m.scorersText || '';
  document.getElementById('match-modal-title').textContent = t('modalMatchEditTitle');
}

function renderMatchEventsEditor() {
  const section = document.getElementById('match-events-section');
  const migration = document.getElementById('match-events-migration');
  const legacy = document.getElementById('match-scorers-legacy-wrap');
  if (!section || !migration || !legacy) return;

  const ready = Boolean(appState.eventsReady);
  section.classList.toggle('hidden', !ready);
  migration.classList.toggle('hidden', ready);
  legacy.classList.toggle('hidden', ready);

  const note = document.getElementById('match-events-stats-note');
  if (note) {
    const matchId = document.getElementById('match-id').value;
    const existing = matchId ? appState.matches.find(match => match.id === matchId) : null;
    const showNote = ready && Boolean(existing && existing.eventsCounted === false);
    note.classList.toggle('hidden', !showNote);
    note.textContent = showNote ? t('matchEventsLegacyStats') : '';
  }

  if (!ready) return;
  renderMatchEventPanel('home');
  renderMatchEventPanel('away');
  updateMatchGoalHint();
}

function renderMatchEventPanel(side) {
  const select = document.getElementById(`match-${side}-team`);
  const title = document.getElementById(`match-events-${side}-title`);
  const list = document.getElementById(`match-events-${side}`);
  if (!select || !title || !list) return;

  const teamId = select.value;
  const team = getTeam(teamId);
  const players = playersForTeam(teamId);
  title.textContent = team ? teamDisplayName(team) : '';

  if (!team) return;

  const events = matchEventDraft.filter(event => event.teamId === teamId);
  if (!events.length) {
    list.innerHTML = `<p class="text-[11px] text-slate-500 py-1">${esc(t(players.length ? 'noMatchEvents' : 'noPlayersFound'))}</p>`;
    return;
  }

  list.innerHTML = events.map(event => {
    const knownPlayer = players.some(player => player.id === event.playerId);
    const eventPlayer = appState.players.find(player => player.id === event.playerId);
    let options = '';
    if (!knownPlayer && eventPlayer) {
      // Existing history can still reference an archived player. Keep it
      // selectable so editing the match does not silently drop the event.
      options += `<option value="${esc(eventPlayer.id)}" selected>${esc(`#${eventPlayer.num} ${playerDisplayName(eventPlayer)}`)} (${esc(t('playerArchived'))})</option>`;
    } else if (!knownPlayer) {
      options += `<option value="">${esc(t('unknownPlayer'))}</option>`;
    }
    options += players.map(player => `<option value="${esc(player.id)}" ${player.id === event.playerId ? 'selected' : ''}>${esc(`#${player.num} ${playerDisplayName(player)}`)}</option>`).join('');

    return `<div class="flex flex-col gap-1.5 rounded-lg border border-slate-700/60 bg-slate-900/50 p-2">
      <select data-change="update-event" data-id="${esc(event.id)}" data-field="playerId" aria-label="${esc(t('thPlayer'))}" class="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-white focus:border-pitch-500">
        ${options}
      </select>
      <div class="flex items-center gap-1.5">
        <select data-change="update-event" data-id="${esc(event.id)}" data-field="type" aria-label="${esc(t('lblMatchEvents'))}" class="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-white focus:border-pitch-500">
          <option value="goal" ${event.type === 'goal' ? 'selected' : ''}>${esc(t('eventGoal'))}</option>
          <option value="yellow" ${event.type === 'yellow' ? 'selected' : ''}>${esc(t('eventYellow'))}</option>
          <option value="red" ${event.type === 'red' ? 'selected' : ''}>${esc(t('eventRed'))}</option>
        </select>
        <input type="number" min="1" max="130" value="${esc(event.minute)}" data-input="update-event" data-id="${esc(event.id)}" data-field="minute" aria-label="${esc(t('lblMinute'))}" class="w-14 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-white text-center focus:border-pitch-500">
        <span class="text-[10px] text-slate-500">'</span>
        <button type="button" data-action="remove-event" data-id="${esc(event.id)}" aria-label="${esc(t('btnRemove'))}" class="ml-auto rtl:ml-0 rtl:mr-auto w-6 h-6 rounded text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 text-base leading-none">&times;</button>
      </div>
    </div>`;
  }).join('');
}

function updateMatchGoalHint() {
  const hint = document.getElementById('match-goal-hint');
  if (!hint || !appState.eventsReady) return;

  const homeId = document.getElementById('match-home-team').value;
  const awayId = document.getElementById('match-away-team').value;
  const goals = teamId => matchEventDraft.filter(event => event.teamId === teamId && event.type === 'goal').length;
  const homeScore = toInt(document.getElementById('match-home-score').value);
  const awayScore = toInt(document.getElementById('match-away-score').value);
  const mismatch = goals(homeId) !== homeScore || goals(awayId) !== awayScore;

  hint.textContent = mismatch ? t('eventGoalMismatch') : '';
}

function onMatchTeamChange() {
  const homeId = document.getElementById('match-home-team').value;
  const awayId = document.getElementById('match-away-team').value;
  const validTeams = new Set([homeId, awayId]);

  matchEventDraft = matchEventDraft.filter(event => {
    if (!validTeams.has(event.teamId)) return false;
    const player = appState.players.find(item => item.id === event.playerId);
    return Boolean(player && player.teamId === event.teamId);
  });

  renderMatchEventsEditor();
}

function addMatchEvent(side, type) {
  const select = document.getElementById(`match-${side}-team`);
  const teamId = select ? select.value : '';
  const players = playersForTeam(teamId);
  if (!players.length) {
    alert(t('alertNoPlayersForTeam'));
    return;
  }

  matchEventDraft.push({
    id: uid('e'),
    matchId: document.getElementById('match-id').value || '',
    teamId,
    playerId: players[0].id,
    type: type === 'yellow' || type === 'red' ? type : 'goal',
    minute: 1
  });
  renderMatchEventsEditor();
}

function updateMatchEvent(eventId, field, value) {
  const event = matchEventDraft.find(item => item.id === eventId);
  if (!event) return;

  if (field === 'minute') {
    event.minute = value === '' ? '' : toInt(value);
  } else if (field === 'type') {
    event.type = ['goal', 'yellow', 'red'].includes(value) ? value : 'goal';
  } else if (field === 'playerId') {
    event.playerId = value;
  }

  updateMatchGoalHint();
}

function removeMatchEvent(eventId) {
  matchEventDraft = matchEventDraft.filter(event => event.id !== eventId);
  renderMatchEventsEditor();
}

function editMatch(matchId) {
  openMatchModal(matchId);
}

async function saveMatch(e) {
  e.preventDefault();

  if (!canEditMatches()) {
    alert(t('alertArchiveReadOnly'));
    return;
  }

  const id = document.getElementById('match-id').value;
  const homeId = document.getElementById('match-home-team').value;
  const awayId = document.getElementById('match-away-team').value;
  const round = toInt(document.getElementById('match-round').value, 1) || 1;

  if (id) {
    const existing = appState.matches.find(m => m.id === id);
    if (existing && appState.seasonsReady && existing.seasonId !== appState.activeSeasonId) {
      alert(t('alertArchiveReadOnly'));
      return;
    }
  }

  if (homeId === awayId) {
    alert(t('alertSameTeam'));
    return;
  }

  // Prevent duplicate fixtures for the same matchday in the active season
  const duplicate = activeMatches().some(m =>
    m.id !== id && toInt(m.round) === round &&
    ((m.homeId === homeId && m.awayId === awayId) || (m.homeId === awayId && m.awayId === homeId))
  );
  if (duplicate) {
    alert(t('alertDuplicate'));
    return;
  }

  const matchId = id || uid('m');
  const existing = id ? appState.matches.find(m => m.id === id) : null;
  let events = [];

  if (appState.eventsReady) {
    try {
      events = collectMatchEvents(matchId);
    } catch (err) {
      alert(t('alertInvalidMatchEvent'));
      return;
    }
  }

  const legacyText = document.getElementById('match-scorers-text').value.trim();
  let scorersText = legacyText;
  if (appState.eventsReady) {
    if (events.length) {
      scorersText = summarizeEventsForText(events, homeId, awayId);
    } else if (existing && getMatchEvents(existing.id).length) {
      scorersText = '';
    } else {
      scorersText = existing ? (existing.scorersText || '') : '';
    }
  }

  const matchData = {
    id: matchId,
    seasonId: appState.seasonsReady ? appState.activeSeasonId : null,
    divisionId: existing
      ? (existing.divisionId || viewedDivisionId())
      : ((getTeam(homeId) || {}).divisionId || viewedDivisionId()),
    round,
    status: document.getElementById('match-status').value,
    datetime: document.getElementById('match-datetime').value,
    venue: document.getElementById('match-venue').value.trim(),
    homeId,
    awayId,
    homeScore: toInt(document.getElementById('match-home-score').value),
    awayScore: toInt(document.getElementById('match-away-score').value),
    scorersText,
    eventsCounted: existing ? existing.eventsCounted !== false : true
  };

  try {
    await dbSaveMatch(matchData, appState.eventsReady ? events : undefined);
    closeModal('modal-match');
    await refreshData();
    renderApp();
  } catch (err) {
    alert(t('alertSaveFailed'));
  }
}

async function deleteMatch(matchId) {
  if (!canEditMatches()) {
    alert(t('alertArchiveReadOnly'));
    return;
  }

  const match = appState.matches.find(m => m.id === matchId);
  if (!match) return;
  if (appState.seasonsReady && match.seasonId !== appState.activeSeasonId) {
    alert(t('alertArchiveReadOnly'));
    return;
  }

  if (!confirm(t('confirmDeleteMatch'))) return;
  try {
    await dbDeleteMatch(matchId);
    await refreshData();
    renderApp();
  } catch (err) {
    alert(t('alertSaveFailed'));
  }
}

/* ---------------------------------------------------------------
 * 8. TEAM MODAL (add / edit / delete)
 * --------------------------------------------------------------- */

/* ---------------------------------------------------------------
 * 8a. TEAM ICON (task I)
 *     The chosen file is decoded, fitted into a 128px square and
 *     re-encoded in the browser before it is saved. Re-encoding
 *     strips EXIF (including any GPS position), refuses SVG by
 *     MIME type and keeps the row small enough for the database
 *     check constraint. The image only ever leaves the device as
 *     that row, so no bucket and no new CSP origin are needed.
 * --------------------------------------------------------------- */
const TEAM_ICON_MAX_INPUT_BYTES = 5 * 1024 * 1024;
const TEAM_ICON_MAX_SIDE = 4096;
const TEAM_ICON_SIZE = 128;
const TEAM_ICON_MAX_LENGTH = 100000;

/** Pending icon for the open team modal: a data URL, or null. */
let teamIconDraft = null;
let teamIconBusy = false;

function teamIconError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** Decode a File into an ImageBitmap (preferred) or an HTMLImageElement. */
function decodeTeamIconFile(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file, { imageOrientation: 'from-image' });
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(teamIconError('decode')); };
    image.src = url;
  });
}

/** Validate, resize and re-encode a picked file. Returns a small data URL. */
async function prepareTeamIcon(file) {
  const type = file && file.type ? file.type : '';
  if (!/^image\/(png|jpeg|webp)$/.test(type)) throw teamIconError('type');
  if (file.size > TEAM_ICON_MAX_INPUT_BYTES) throw teamIconError('size');

  let bitmap;
  try {
    bitmap = await decodeTeamIconFile(file);
  } catch (err) {
    throw teamIconError('decode');
  }

  try {
    const width = bitmap.width;
    const height = bitmap.height;
    if (!width || !height) throw teamIconError('decode');
    if (width > TEAM_ICON_MAX_SIDE || height > TEAM_ICON_MAX_SIDE) throw teamIconError('size');

    const canvas = document.createElement('canvas');
    canvas.width = TEAM_ICON_SIZE;
    canvas.height = TEAM_ICON_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw teamIconError('decode');

    // Fit the whole crest inside the square instead of cropping its edges.
    const scale = Math.min(TEAM_ICON_SIZE / width, TEAM_ICON_SIZE / height);
    const drawWidth = Math.max(1, Math.round(width * scale));
    const drawHeight = Math.max(1, Math.round(height * scale));
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      bitmap,
      Math.round((TEAM_ICON_SIZE - drawWidth) / 2),
      Math.round((TEAM_ICON_SIZE - drawHeight) / 2),
      drawWidth,
      drawHeight
    );

    // WebP keeps the payload tiny; older Safari falls back to PNG.
    let dataUrl = canvas.toDataURL('image/webp', 0.85);
    if (!/^data:image\/webp;base64,/.test(dataUrl)) {
      dataUrl = canvas.toDataURL('image/png');
    }
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl) || dataUrl.length > TEAM_ICON_MAX_LENGTH) {
      throw teamIconError('size');
    }
    return dataUrl;
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

function renderTeamIconPreview() {
  const box = document.getElementById('team-icon-preview');
  const remove = document.getElementById('team-icon-remove');
  if (!box) return;
  if (teamIconBusy) {
    box.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 text-slate-400 animate-spin"></i>';
  } else if (teamIconDraft) {
    box.innerHTML = `<img src="${esc(teamIconDraft)}" alt="" class="w-full h-full object-contain">`;
  } else {
    box.innerHTML = '<i data-lucide="image" class="w-5 h-5 text-slate-600"></i>';
  }
  if (remove) remove.classList.toggle('hidden', !teamIconDraft || teamIconBusy);
  refreshIcons();
}

async function handleTeamIconFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = ''; // allow choosing the same file again
  if (!file) return;

  teamIconBusy = true;
  renderTeamIconPreview();
  try {
    teamIconDraft = await prepareTeamIcon(file);
  } catch (err) {
    const code = err && err.code;
    alert(t(code === 'type'
      ? 'alertIconType'
      : code === 'size' ? 'alertIconTooLarge' : 'alertIconFailed'));
  } finally {
    teamIconBusy = false;
    renderTeamIconPreview();
  }
}

function chooseTeamIcon() {
  const input = document.getElementById('team-icon');
  if (input) input.click();
}

function clearTeamIcon() {
  teamIconDraft = null;
  const input = document.getElementById('team-icon');
  if (input) input.value = '';
  renderTeamIconPreview();
}

/** Fill the division select and hide it until the divisions migration has run. */
function prepareTeamDivisionField(selectedId) {
  const wrap = document.getElementById('team-division-wrap');
  const divisionSelect = document.getElementById('team-division');
  if (wrap) wrap.classList.toggle('hidden', !appState.divisionsReady);
  if (divisionSelect) {
    divisionSelect.innerHTML = (appState.divisions || [])
      .map(division => `<option value="${esc(division.id)}">${esc(divisionLabel(division.id))}</option>`)
      .join('');
    divisionSelect.disabled = !appState.divisionsReady;
    divisionSelect.value = selectedId || viewedDivisionId();
  }
}

function openTeamModal() {
  document.getElementById('form-team').reset();
  document.getElementById('team-id').value = '';
  document.getElementById('team-color').value = '#16a34a';
  document.getElementById('team-modal-title').textContent = t('modalTeamTitle');
  teamIconDraft = null;
  renderTeamIconPreview();
  prepareTeamDivisionField(null);
  openModal('modal-team');
}

function editTeam(teamId) {
  const team = getTeam(teamId);
  if (!team) return;

  document.getElementById('form-team').reset();
  document.getElementById('team-id').value = team.id;
  document.getElementById('team-name').value = team.name;
  document.getElementById('team-name-ar').value = team.nameAr || '';
  document.getElementById('team-code').value = team.code || '';
  document.getElementById('team-color').value = team.color || '#16a34a';
  document.getElementById('team-modal-title').textContent = t('modalTeamEditTitle');
  teamIconDraft = teamIconSrc(team) || null;
  renderTeamIconPreview();
  prepareTeamDivisionField(team.divisionId);
  openModal('modal-team');
}

async function saveTeam(e) {
  e.preventDefault();
  const id = document.getElementById('team-id').value;
  const existing = id ? appState.teams.find(team => team.id === id) : null;
  const divisionSelect = document.getElementById('team-division');
  const divisionId = (appState.divisionsReady && divisionSelect && divisionSelect.value)
    ? divisionSelect.value
    : (existing ? existing.divisionId : viewedDivisionId());
  const teamData = {
    id: id || uid('t'),
    name: document.getElementById('team-name').value.trim(),
    nameAr: document.getElementById('team-name-ar').value.trim() || null,
    icon: teamIconDraft,
    code: document.getElementById('team-code').value.trim().toUpperCase(),
    color: document.getElementById('team-color').value,
    divisionId
  };

  if (!teamData.name) {
    alert(t('alertNameRequired'));
    return;
  }
  if (teamData.nameAr && teamData.nameAr.length > 100) {
    alert(t('alertNameArTooLong'));
    return;
  }
  // The image is prepared before the save button is used; this only guards a
  // click that lands while a large file is still being decoded.
  if (teamIconBusy) {
    alert(t('alertIconProcessing'));
    return;
  }
  // Before the task I migration a direct write cannot carry the column, so
  // fail loudly instead of silently saving the club without its new crest.
  if (teamData.icon && !TEAM_ICONS_READY) {
    alert(t('alertIconMigration'));
    return;
  }

  try {
    const divisionChanged = Boolean(
      existing && appState.divisionsReady &&
      (existing.divisionId || 'd1') !== divisionId
    );
    if (divisionChanged) {
      // Guarded move first: the database refuses the change while the club
      // still has fixtures in the active season, before anything is written.
      await dbSetTeamDivision(teamData.id, divisionId);
      await dbSaveTeam(teamData);
    } else {
      await dbSaveTeam(teamData);
    }
    // Follow a moved club so the admin sees the result of their action.
    if (appState.divisionsReady && divisionId !== viewedDivisionId()) {
      appState.viewDivisionId = divisionId;
    }
    closeModal('modal-team');
    await refreshData();
    renderApp();
  } catch (err) {
    alert(saveTeamErrorMessage(err));
  }
}

async function deleteTeam(teamId) {
  const fixtureCount = appState.matches.filter(m => m.homeId === teamId || m.awayId === teamId).length;
  if (!confirm(t(fixtureCount ? 'confirmDeleteTeamHistory' : 'confirmDeleteTeam'))) return;
  try {
    // delete_team reverses this club's event contributions to opponent
    // totals before Postgres cascades players, fixtures and events.
    await dbDeleteTeam(teamId);
    await refreshData();
    renderApp();
  } catch (err) {
    alert(t(err && err.code === 'INTEGRITY_MIGRATION_REQUIRED'
      ? 'alertIntegrityMigration'
      : 'alertSaveFailed'));
  }
}

/* ---------------------------------------------------------------
 * 9. PLAYER MODAL (add / edit / delete)
 * --------------------------------------------------------------- */

/**
 * Goals and cards a player already has in match events. Mirrors
 * v_player_stats in the database: only events on visible fixtures whose
 * events_counted flag is true are part of the total.
 */
function playerEventTotals(playerId) {
  const totals = { goals: 0, yellow: 0, red: 0 };
  if (!playerId || !appState.eventsReady) return totals;

  const counted = new Set(
    (appState.matches || [])
      .filter(match => match.eventsCounted !== false)
      .map(match => match.id)
  );

  (appState.matchEvents || []).forEach(event => {
    if (event.playerId !== playerId || !counted.has(event.matchId)) return;
    if (event.type === 'goal') totals.goals += 1;
    else if (event.type === 'yellow') totals.yellow += 1;
    else if (event.type === 'red') totals.red += 1;
  });

  return totals;
}

/** The localized "cannot go below the events" message, including the counts. */
function totalsBelowEventsMessage(counts) {
  const format = value => new Intl.NumberFormat(currentLang).format(value);
  return t('alertPlayerTotalsBelowEvents')
    .replace('{goals}', format(counts.goals))
    .replace('{yellow}', format(counts.yellow))
    .replace('{red}', format(counts.red));
}

function openPlayerModal(teamId) {
  document.getElementById('form-player').reset();
  document.getElementById('player-id').value = '';
  document.getElementById('player-team-id').value = teamId;
  document.getElementById('player-number').value = 10;
  document.getElementById('player-goals').value = 0;
  document.getElementById('player-yellows').value = 0;
  document.getElementById('player-reds').value = 0;
  document.getElementById('player-modal-title').textContent = t('modalPlayerTitle');
  openModal('modal-player');
}

function editPlayer(playerId) {
  const p = appState.players.find(x => x.id === playerId);
  if (!p) return;

  document.getElementById('form-player').reset();
  document.getElementById('player-id').value = p.id;
  document.getElementById('player-team-id').value = p.teamId;
  document.getElementById('player-name').value = p.name;
  document.getElementById('player-name-ar').value = p.nameAr || '';
  document.getElementById('player-license').value = p.licenseId || '';
  document.getElementById('player-birth-date').value = p.birthDate || '';
  document.getElementById('player-position').value = p.pos || 'MID';
  document.getElementById('player-number').value = toInt(p.num, 10) || 10;
  document.getElementById('player-goals').value = toInt(p.goals);
  document.getElementById('player-yellows').value = toInt(p.yellow);
  document.getElementById('player-reds').value = toInt(p.red);
  document.getElementById('player-modal-title').textContent = t('modalPlayerEditTitle');
  openModal('modal-player');
}

async function savePlayer(e) {
  e.preventDefault();
  const id = document.getElementById('player-id').value;
  const playerData = {
    id: id || uid('p'),
    teamId: document.getElementById('player-team-id').value,
    name: document.getElementById('player-name').value.trim(),
    nameAr: document.getElementById('player-name-ar').value.trim() || null,
    licenseId: document.getElementById('player-license').value.trim() || null,
    birthDate: document.getElementById('player-birth-date').value || null,
    pos: document.getElementById('player-position').value,
    num: toInt(document.getElementById('player-number').value, 10) || 10,
    goals: toInt(document.getElementById('player-goals').value),
    yellow: toInt(document.getElementById('player-yellows').value),
    red: toInt(document.getElementById('player-reds').value)
  };

  if (!playerData.name) {
    alert(t('alertNameRequired'));
    return;
  }
  if (playerData.nameAr && playerData.nameAr.length > 100) {
    alert(t('alertNameArTooLong'));
    return;
  }
  if (playerData.licenseId && playerData.licenseId.length > 50) {
    alert(t('alertLicenseTooLong'));
    return;
  }
  if (playerData.birthDate && playerData.birthDate > new Date().toISOString().slice(0, 10)) {
    alert(t('alertBirthDateFuture'));
    return;
  }

  const existing = id ? appState.players.find(player => player.id === id) : null;
  if (existing && existing.teamId !== playerData.teamId &&
      (appState.matchEvents || []).some(event => event.playerId === id)) {
    alert(t('alertPlayerTransferEvents'));
    return;
  }
  playerData.isActive = existing ? existing.isActive !== false : true;

  // A manual edit cannot drop below what the events already record. The
  // database enforces the same rule; this is the friendly version, with the
  // counts the admin needs.
  const eventCounts = playerEventTotals(playerData.id);
  if (playerData.goals < eventCounts.goals ||
      playerData.yellow < eventCounts.yellow ||
      playerData.red < eventCounts.red) {
    alert(totalsBelowEventsMessage(eventCounts));
    return;
  }

  try {
    await dbSavePlayer(playerData);
    closeModal('modal-player');
    await refreshData();
    renderApp();
  } catch (err) {
    if (err && err.code === 'PLAYER_TOTALS_BELOW_EVENTS') {
      alert(totalsBelowEventsMessage(playerEventTotals(playerData.id)));
      return;
    }
    if (err && String(err.code) === '23505' && /license/i.test(String(err.message || ''))) {
      alert(t('alertLicenseTaken'));
      return;
    }
    alert(t('alertSaveFailed'));
  }
}

async function deletePlayer(playerId) {
  const hasEvents = (appState.matchEvents || []).some(event => event.playerId === playerId);

  if (hasEvents) {
    if (!confirm(t('confirmArchivePlayer'))) return;
    try {
      await dbArchivePlayer(playerId);
      await refreshData();
      renderApp();
    } catch (err) {
      alert(t(err && err.code === 'INTEGRITY_MIGRATION_REQUIRED'
        ? 'alertIntegrityMigration'
        : 'alertSaveFailed'));
    }
    return;
  }

  if (!confirm(t('confirmDeletePlayer'))) return;
  try {
    await dbDeletePlayer(playerId);
    await refreshData();
    renderApp();
  } catch (err) {
    if (err && err.code === 'PLAYER_HAS_HISTORY') {
      // The database refused the hard delete because events still reference
      // the player. Fall back to archiving, which hides them but keeps history.
      try {
        await dbArchivePlayer(playerId);
        await refreshData();
        renderApp();
        alert(t('alertPlayerArchived'));
      } catch (archiveErr) {
        alert(t(archiveErr && archiveErr.code === 'INTEGRITY_MIGRATION_REQUIRED'
          ? 'alertIntegrityMigration'
          : 'alertSaveFailed'));
      }
      return;
    }
    alert(t('alertSaveFailed'));
  }
}

async function restorePlayer(playerId) {
  if (!confirm(t('confirmRestorePlayer'))) return;
  try {
    await dbRestorePlayer(playerId);
    await refreshData();
    renderApp();
  } catch (err) {
    alert(t(err && err.code === 'INTEGRITY_MIGRATION_REQUIRED'
      ? 'alertIntegrityMigration'
      : 'alertSaveFailed'));
  }
}

/* ---------------------------------------------------------------
 * 9b. SQUAD IMPORT (Excel / CSV)
 *     Reads and checks the file in the browser (js/squad-import.js),
 *     shows a preview, then adds every valid row in one transaction
 *     through public.add_players(). Errors are translated from codes.
 * --------------------------------------------------------------- */

let squadImportState = null;

function openSquadImport(teamId) {
  const team = getTeam(teamId);
  if (!team) return;
  if (typeof isAdmin !== 'function' || !isAdmin()) return;
  if (!BACKEND_READY) {
    alert(t(authUnavailableKey()));
    return;
  }
  if (typeof SquadImport === 'undefined') {
    alert(t('squadImportUnavailable'));
    return;
  }

  squadImportState = { teamId: team.id, analysis: null };

  document.getElementById('squad-team-name').textContent = teamDisplayName(team);
  document.getElementById('squad-file-name').textContent = '';
  const input = document.getElementById('squad-file');
  if (input) input.value = '';
  document.getElementById('squad-preview').classList.add('hidden');
  document.getElementById('squad-rows').innerHTML = '';
  document.getElementById('squad-progress').classList.add('hidden');
  setSquadError('');
  setSquadImportEnabled(false);
  const importButton = document.getElementById('squad-import-btn');
  if (importButton) importButton.textContent = t('squadImport');
  openModal('modal-squad');
}

async function handleSquadFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = ''; // allow choosing the same file again
  if (!file || !squadImportState) return;

  document.getElementById('squad-file-name').textContent = file.name;
  document.getElementById('squad-preview').classList.add('hidden');
  document.getElementById('squad-progress').classList.remove('hidden');
  setSquadError('');
  setSquadImportEnabled(false);
  squadImportState.analysis = null;

  try {
    const sheets = await SquadImport.readFile(file);
    const existing = appState.players.filter(player => player.teamId === squadImportState.teamId);
    const analysis = SquadImport.analyze(sheets, existing);
    document.getElementById('squad-progress').classList.add('hidden');

    if (!analysis.headerFound) {
      setSquadError(t('squadHeaderMissing'));
      return;
    }
    squadImportState.analysis = analysis;
    renderSquadPreview();
  } catch (err) {
    document.getElementById('squad-progress').classList.add('hidden');
    setSquadError(t(squadFileErrorKey(err)));
  }
}

function squadFileErrorKey(error) {
  switch (error && error.code) {
    case 'TOO_LARGE': return 'squadFileTooLarge';
    case 'XLS_UNSUPPORTED': return 'squadXlsUnsupported';
    case 'NOT_XLSX': return 'squadNotXlsx';
    case 'ENCRYPTED': return 'squadEncrypted';
    case 'NO_DECOMPRESSION': return 'squadNoDecompression';
    case 'EMPTY': return 'squadFileEmpty';
    default: return 'squadFileUnreadable';
  }
}

function setSquadError(message) {
  const el = document.getElementById('squad-error');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function setSquadImportEnabled(enabled) {
  const button = document.getElementById('squad-import-btn');
  if (!button) return;
  button.disabled = !enabled;
  button.classList.toggle('opacity-50', !enabled);
  button.classList.toggle('cursor-not-allowed', !enabled);
}

/** Translate one parser issue. Unknown codes fall back to a generic warning. */
function squadIssueText(issue) {
  const key = 'squadIssue' + issue.code.charAt(0).toUpperCase() + issue.code.slice(1);
  let text = t(key);
  if (text === key) text = t('squadIssueUnknown');
  const params = issue.params || {};
  const fieldKey = params.field
    ? 'squadField' + params.field.charAt(0).toUpperCase() + params.field.slice(1)
    : '';
  const field = fieldKey ? t(fieldKey) : '';
  return text
    .replace('{value}', params.value == null ? '' : String(params.value))
    .replace('{line}', String(toInt(params.line)))
    .replace('{num}', String(toInt(params.num)))
    .replace('{player}', params.player == null ? '' : String(params.player))
    .replace('{max}', String(toInt(params.max)))
    .replace('{field}', field === fieldKey ? '' : field);
}

const SQUAD_STATUS_STYLES = {
  ok: 'bg-pitch-600/15 text-pitch-400 border-pitch-500/30',
  warn: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  skip: 'bg-slate-700/50 text-slate-300 border-slate-600',
  error: 'bg-rose-500/15 text-rose-300 border-rose-500/30'
};

const SQUAD_STATUS_KEYS = {
  ok: 'squadStatusOk',
  warn: 'squadStatusWarn',
  skip: 'squadStatusSkip',
  error: 'squadStatusError'
};

function renderSquadPreview() {
  const state = squadImportState;
  const preview = document.getElementById('squad-preview');
  const rowsBody = document.getElementById('squad-rows');
  if (!preview || !rowsBody || !state || !state.analysis) return;

  const analysis = state.analysis;
  const counts = analysis.counts;
  const number = new Intl.NumberFormat(currentLang);

  document.getElementById('squad-summary').textContent = t('squadSummary')
    .replace('{total}', number.format(counts.total))
    .replace('{ready}', number.format(counts.ok + counts.warn))
    .replace('{skip}', number.format(counts.skip))
    .replace('{error}', number.format(counts.error));

  rowsBody.innerHTML = analysis.rows.map(row => {
    const issues = row.issues.map(squadIssueText).join('; ');
    return `<tr class="border-t border-slate-800/80 align-top">
      <td class="py-1.5 pe-2 text-slate-500">${toInt(row.line)}</td>
      <td class="py-1.5 pe-2 text-slate-200 font-medium">${esc(bilingualName(row.name, row.nameAr) || '—')}</td>
      <td class="py-1.5 pe-2 text-center text-slate-400">${esc(row.pos)}</td>
      <td class="py-1.5 pe-2 text-center text-slate-400">${esc(row.num)}</td>
      <td class="py-1.5">
        <span class="inline-block px-1.5 py-0.5 rounded border text-[10px] font-semibold ${SQUAD_STATUS_STYLES[row.status]}">${esc(t(SQUAD_STATUS_KEYS[row.status]))}</span>
        ${issues ? `<span class="block mt-0.5 text-[10px] leading-snug text-slate-400">${esc(issues)}</span>` : ''}
      </td>
    </tr>`;
  }).join('');

  preview.classList.remove('hidden');
  setSquadImportEnabled(analysis.canImport);
}

function refreshSquadPreviewIfOpen() {
  const modal = document.getElementById('modal-squad');
  if (modal && !modal.classList.contains('hidden') && squadImportState) renderSquadPreview();
}

function downloadSquadTemplate() {
  if (typeof SquadImport === 'undefined') return;
  const template = SquadImport.template(currentLang);
  const blob = new Blob([template.text], { type: template.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = template.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function confirmSquadImport() {
  const state = squadImportState;
  if (!state || !state.analysis || !state.analysis.canImport) return;

  const button = document.getElementById('squad-import-btn');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = t('squadImporting');
  setSquadError('');

  try {
    const result = await dbAddPlayers(state.teamId, state.analysis.toAdd);
    const added = typeof result === 'number' ? result : state.analysis.toAdd.length;
    closeModal('modal-squad');
    await refreshData();
    renderApp();
    showToast(t('squadImported').replace('{n}', new Intl.NumberFormat(currentLang).format(added)));
  } catch (err) {
    console.error('Squad import failed', err);
    setSquadError(t(err && err.code === 'SQUAD_IMPORT_MIGRATION_REQUIRED'
      ? 'squadImportMigration'
      : 'squadImportFailed'));
    button.disabled = false;
    button.textContent = label;
  }
}

/* ---------------------------------------------------------------
 * 9b. SEASONS (create, switch, reactivate)
 * --------------------------------------------------------------- */
function openSeasonModal() {
  if (!appState.seasonsReady) return;
  if (typeof isAdmin !== 'function' || !isAdmin()) return;
  if (!BACKEND_READY) {
    alert(t(authUnavailableKey()));
    return;
  }

  document.getElementById('form-season').reset();

  const year = new Date().getFullYear();
  const alreadyUsed = (appState.seasons || []).some(season => season.name.includes(String(year)));
  document.getElementById('season-name').value = `${alreadyUsed ? year + 1 : year} Season`;
  document.getElementById('season-start').value = new Date().toISOString().slice(0, 10);
  document.getElementById('season-end').value = '';

  openModal('modal-season');
  document.getElementById('season-name').focus();
}

async function saveSeason(e) {
  e.preventDefault();

  if (typeof isAdmin !== 'function' || !isAdmin()) return;

  const name = document.getElementById('season-name').value.trim();
  const startDate = document.getElementById('season-start').value;
  const endDate = document.getElementById('season-end').value;

  if (!name) {
    alert(t('alertSeasonName'));
    return;
  }
  if (startDate && endDate && endDate < startDate) {
    alert(t('alertSeasonDates'));
    return;
  }

  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    const newId = await dbCreateSeason(name, startDate, endDate);
    closeModal('modal-season');
    await refreshData();
    appState.viewSeasonId = newId;
    hideDataError();
    renderApp();
  } catch (err) {
    if (err && (err.code === 'PGRST202' || /Could not find the function/i.test(err.message || ''))) {
      alert(t('alertSeasonMigration'));
    } else {
      alert(t('alertSaveFailed'));
    }
  } finally {
    button.disabled = false;
  }
}

function openSeasonRenameModal() {
  if (!appState.seasonsReady) return;
  if (typeof isAdmin !== 'function' || !isAdmin()) return;
  if (!BACKEND_READY) {
    alert(t(authUnavailableKey()));
    return;
  }

  const season = viewedSeason();
  if (!season) return;

  document.getElementById('form-season-rename').reset();
  document.getElementById('season-rename-id').value = season.id;
  const input = document.getElementById('season-rename-name');
  input.value = season.name || '';

  openModal('modal-season-rename');
  input.focus();
  input.select();
}

async function saveSeasonRename(e) {
  e.preventDefault();

  if (typeof isAdmin !== 'function' || !isAdmin()) return;

  const seasonId = document.getElementById('season-rename-id').value;
  const season = (appState.seasons || []).find(item => item.id === seasonId);
  const name = document.getElementById('season-rename-name').value.trim();

  if (!season) return;
  if (!name) {
    alert(t('alertSeasonName'));
    return;
  }
  if (name.length > 100) {
    alert(t('alertSeasonNameTooLong'));
    return;
  }
  if (name === season.name) {
    closeModal('modal-season-rename');
    return;
  }

  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    await dbRenameSeason(season.id, name);
    closeModal('modal-season-rename');
    await refreshData();
    hideDataError();
    renderApp();
    showToast(t('seasonRenamed'));
  } catch (err) {
    alert(t('alertSeasonRenameFailed'));
  } finally {
    button.disabled = false;
  }
}

async function activateViewedSeason() {
  if (typeof isAdmin !== 'function' || !isAdmin() || !BACKEND_READY) return;

  const season = viewedSeason();
  if (!season || season.id === appState.activeSeasonId) return;
  if (!confirm(t('confirmActivateSeason'))) return;

  try {
    await dbActivateSeason(season.id);
    await refreshData();
    appState.viewSeasonId = season.id;
    hideDataError();
    renderApp();
  } catch (err) {
    if (err && (err.code === 'PGRST202' || /Could not find the function/i.test(err.message || ''))) {
      alert(t('alertSeasonMigration'));
    } else {
      alert(t('alertSaveFailed'));
    }
  }
}

async function deleteViewedSeason() {
  if (typeof isAdmin !== 'function' || !isAdmin() || !BACKEND_READY) return;

  const season = viewedSeason();
  if (!season) return;
  if (season.id === appState.activeSeasonId) {
    alert(t('alertDeleteActiveSeason'));
    return;
  }
  if ((appState.matches || []).some(match => match.seasonId === season.id)) {
    alert(t('alertDeleteSeasonFixtures'));
    return;
  }
  if (!confirm(t('confirmDeleteSeason'))) return;

  try {
    await dbDeleteSeason(season.id);
    appState.viewSeasonId = appState.activeSeasonId;
    await refreshData();
    hideDataError();
    renderApp();
  } catch (err) {
    alert(t('alertDeleteSeasonFailed'));
  }
}

/* ---------------------------------------------------------------
 * 10. DATA: export / import / reset & misc UI
 * --------------------------------------------------------------- */
/* ---------- activity log (admin) ---------- */

const AUDIT_ACTION_KEYS = {
  INSERT: 'auditActionInsert',
  UPDATE: 'auditActionUpdate',
  DELETE: 'auditActionDelete',
  RESTORE: 'auditActionRestore',
  IMPORT: 'auditActionImport',
  SECURITY: 'auditActionSecurity'
};

const AUDIT_ACTION_STYLES = {
  INSERT: 'bg-pitch-500/15 text-pitch-400 border-pitch-500/30',
  UPDATE: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  DELETE: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  RESTORE: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  IMPORT: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  SECURITY: 'bg-violet-500/15 text-violet-300 border-violet-500/30'
};

const AUDIT_ENTITY_KEYS = {
  seasons: 'auditEntitySeasons',
  teams: 'auditEntityTeams',
  players: 'auditEntityPlayers',
  matches: 'auditEntityMatches',
  match_events: 'auditEntityEvents',
  profiles: 'auditEntityUsers',
  match_officials: 'auditEntityOfficials',
  security: 'auditEntitySecurity',
  all: 'auditEntityAll'
};

function auditEntityName(entity) {
  return t(AUDIT_ENTITY_KEYS[entity] || 'auditEntityAll');
}

function auditTime(iso) {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '';
  const locale = currentLang === 'fr' ? 'fr-FR' : (currentLang === 'ar' ? 'ar' : 'en-GB');
  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Best-effort, human-readable label for the changed record. */
function auditEntityLabel(entry) {
  const snapshot = entry.after || entry.before || {};

  switch (entry.entity) {
    case 'seasons':
      return snapshot.name || entry.entityId || auditEntityName('seasons');

    case 'teams':
      if (!snapshot.name) return entry.entityId || auditEntityName('teams');
      return snapshot.code
        ? `${teamDisplayName(snapshot)} (${snapshot.code})`
        : teamDisplayName(snapshot);

    case 'players': {
      if (!snapshot.name) return entry.entityId || auditEntityName('players');
      const team = getTeam(snapshot.team_id);
      return team ? `${playerDisplayName(snapshot)} · ${teamDisplayName(team)}` : playerDisplayName(snapshot);
    }

    case 'matches': {
      const home = getTeam(snapshot.home_id);
      const away = getTeam(snapshot.away_id);
      const homeName = home ? teamDisplayName(home) : (snapshot.home_id || '?');
      const awayName = away ? teamDisplayName(away) : (snapshot.away_id || '?');
      const score = `${snapshot.home_score == null ? 0 : snapshot.home_score}–${snapshot.away_score == null ? 0 : snapshot.away_score}`;
      const round = snapshot.round == null ? '?' : snapshot.round;
      return `${homeName} ${score} ${awayName} · ${t('matchdayPrefix')} ${round}`;
    }

    case 'match_events': {
      const typeKey = snapshot.event_type === 'goal'
        ? 'auditEventGoal'
        : (snapshot.event_type === 'yellow' ? 'auditEventYellow' : 'auditEventRed');
      const player = appState.players.find(p => p.id === snapshot.player_id);
      const playerName = player ? playerDisplayName(player) : (snapshot.player_id || '?');
      return `${t(typeKey)} ${snapshot.minute == null ? '?' : snapshot.minute}' · ${playerName}`;
    }

    default:
      return entry.summary || entry.entityId || entry.entity;
  }
}

function renderAuditEntry(entry) {
  const actionLabel = AUDIT_ACTION_KEYS[entry.action]
    ? t(AUDIT_ACTION_KEYS[entry.action])
    : entry.action;
  const badgeStyle = AUDIT_ACTION_STYLES[entry.action] || 'bg-slate-700/40 text-slate-300 border-slate-600';
  const primary = entry.action === 'IMPORT'
    ? (entry.summary || t('auditActionImport'))
    : auditEntityLabel(entry);
  const meta = [
    auditEntityName(entry.entity),
    auditTime(entry.at),
    entry.actorEmail || t('auditDatabaseActor')
  ].filter(Boolean).join(' · ');

  return `
    <div class="flex items-start gap-3 p-3 bg-slate-800/40 border border-slate-800 rounded-lg">
      <span class="shrink-0 px-2 py-0.5 rounded border text-[10px] font-semibold ${badgeStyle}">${esc(actionLabel)}</span>
      <div class="min-w-0 flex-1">
        <p class="text-slate-200 font-medium break-words">${esc(primary)}</p>
        <p class="text-[11px] text-slate-500 mt-0.5 break-words">${esc(meta)}</p>
      </div>
    </div>`;
}

function closeDataMenu() {
  const menu = document.getElementById('data-menu');
  if (!menu) return;
  menu.classList.add('hidden');
  const opener = document.querySelector('[aria-controls="data-menu"]');
  if (opener) opener.setAttribute('aria-expanded', 'false');
}

function openAuditModal() {
  closeDataMenu();
  openModal('modal-audit');
  renderAuditLog();
}

function renderAuditLog() {
  const list = document.getElementById('audit-list');
  const modal = document.getElementById('modal-audit');
  if (!list || !modal) return;

  if (!BACKEND_READY) {
    list.innerHTML = `<div class="p-4 rounded-xl bg-amber-400/10 border border-amber-400/20 text-amber-200 leading-relaxed">${esc(t('auditUnavailable'))}</div>`;
    return;
  }

  list.innerHTML = `<p class="py-6 text-center text-slate-500">${esc(t('auditLoading'))}</p>`;

  dbListAuditLog(50)
    .then(entries => {
      if (modal.classList.contains('hidden')) return;
      if (entries === null) {
        list.innerHTML = `<div class="p-4 rounded-xl bg-amber-400/10 border border-amber-400/20 text-amber-200 leading-relaxed">${esc(t('auditUnavailable'))}</div>`;
        return;
      }
      if (!entries.length) {
        list.innerHTML = `<p class="py-6 text-center text-slate-500">${esc(t('auditEmpty'))}</p>`;
        return;
      }
      list.innerHTML = entries.map(renderAuditEntry).join('');
    })
    .catch(error => {
      console.error('Mzab League: could not load the activity log.', error);
      list.innerHTML = `<p class="py-6 text-center text-rose-400">${esc(t('auditError'))}</p>`;
    });
}

/** Re-render the open activity dialog after a language switch. */
function refreshAuditLogIfOpen() {
  const modal = document.getElementById('modal-audit');
  if (modal && !modal.classList.contains('hidden')) renderAuditLog();
}

/* ---------- users & roles (admin, roadmap B) ---------- */

function usersMatchLabel(match) {
  const home = getTeam(match.homeId);
  const away = getTeam(match.awayId);
  const date = match.datetime
    ? new Date(match.datetime).toLocaleDateString(currentLang, { month: 'short', day: 'numeric' })
    : '';
  const name = `${home ? teamDisplayName(home) : '?'} – ${away ? teamDisplayName(away) : '?'}`;
  return date ? `${name} · ${date}` : name;
}

function syncOfficialsDraft() {
  const scorerIds = new Set(
    usersModalState.users.filter(user => user.role === 'scorer').map(user => user.id)
  );
  usersModalState.draft = new Set(
    (appState.matchOfficials || [])
      .filter(row => row.matchId === usersModalState.matchId && scorerIds.has(row.userId))
      .map(row => row.userId)
  );
}

function openUsersModal() {
  if (typeof isAdmin !== 'function' || !isAdmin()) return;
  closeDataMenu();
  usersModalState = { loading: true, users: [], error: '', matchId: '', draft: new Set() };
  openModal('modal-users');
  renderUsersModal();

  dbListUsers()
    .then(users => {
      if (users === null) {
        usersModalState = { loading: false, users: [], error: 'usersMigration', matchId: '', draft: new Set() };
        renderUsersModal();
        return;
      }
      const matches = activeMatches().slice().sort((a, b) =>
        (toInt(a.round) - toInt(b.round)) ||
        (a.datetime || '').localeCompare(b.datetime || '')
      );
      const preferred = matches.find(match => match.status === 'LIVE') ||
        matches.find(match => match.status === 'SCHEDULED' && matchIsToday(match)) ||
        matches[0] || null;
      usersModalState = {
        loading: false,
        users,
        error: '',
        matchId: preferred ? preferred.id : '',
        draft: new Set()
      };
      syncOfficialsDraft();
      renderUsersModal();
    })
    .catch(err => {
      console.error('Mzab League: could not load users.', err);
      usersModalState = { loading: false, users: [], error: 'usersLoadFailed', matchId: '', draft: new Set() };
      renderUsersModal();
    });
}

function renderUsersModal() {
  const body = document.getElementById('users-body');
  if (!body) return;

  if (usersModalState.loading) {
    body.innerHTML = `<p class="py-6 text-center text-slate-500">${esc(t('usersLoading'))}</p>`;
    return;
  }
  if (usersModalState.error) {
    body.innerHTML = `<div class="p-4 rounded-xl bg-amber-400/10 border border-amber-400/20 text-amber-200 leading-relaxed text-xs">${esc(t(usersModalState.error))}</div>`;
    return;
  }
  if (!usersModalState.users.length) {
    body.innerHTML = `<p class="py-6 text-center text-slate-500">${esc(t('usersEmpty'))}</p>`;
    return;
  }

  const selfId = typeof currentUser !== 'undefined' && currentUser ? currentUser.id : null;
  const roleLabel = role => t(role === 'admin' ? 'adminBadge' : role === 'scorer' ? 'scorerBadge' : 'viewerBadge');

  const userRows = usersModalState.users.map(user => {
    const options = ['viewer', 'scorer', 'admin'].map(role =>
      `<option value="${role}" ${user.role === role ? 'selected' : ''}>${esc(roleLabel(role))}</option>`
    ).join('');
    const self = user.id === selfId;
    return `
      <div class="flex items-center gap-3 px-3 py-2 bg-slate-800/40 border border-slate-800 rounded-lg">
        <div class="min-w-0 flex-1">
          <p class="text-xs text-slate-200 font-medium truncate">${esc(user.email || user.id)}</p>
          ${self ? `<p class="text-[10px] text-slate-500">${esc(t('usersSelf'))}</p>` : ''}
        </div>
        <select data-change="user-role" data-id="${esc(user.id)}" ${self ? 'disabled' : ''}
                class="shrink-0 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-white focus:border-pitch-500 disabled:opacity-60 disabled:cursor-not-allowed">
          ${options}
        </select>
      </div>`;
  }).join('');

  const matches = activeMatches().slice().sort((a, b) =>
    (toInt(a.round) - toInt(b.round)) ||
    (a.datetime || '').localeCompare(b.datetime || '')
  );

  const matchSelect = matches.length
    ? `<select data-change="officials-match" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:border-pitch-500">
         ${matches.map(match => `<option value="${esc(match.id)}" ${match.id === usersModalState.matchId ? 'selected' : ''}>${esc(usersMatchLabel(match))}</option>`).join('')}
       </select>`
    : `<p class="text-[11px] text-slate-500">${esc(t('usersNoMatches'))}</p>`;

  const scorers = usersModalState.users.filter(user => user.role === 'scorer');
  const scorerBoxes = scorers.length
    ? scorers.map(user => `
        <label class="flex items-center gap-2 px-3 py-2 bg-slate-800/40 border border-slate-800 rounded-lg cursor-pointer hover:border-slate-700">
          <input type="checkbox" data-change="toggle-official" data-id="${esc(user.id)}"
                 ${usersModalState.draft.has(user.id) ? 'checked' : ''}
                 class="rounded border-slate-600 bg-slate-900 text-pitch-500 focus:ring-pitch-500">
          <span class="min-w-0 flex-1 truncate text-xs text-slate-200">${esc(user.email || user.id)}</span>
        </label>`).join('')
    : `<p class="text-[11px] text-slate-500 leading-relaxed">${esc(t('usersNoScorers'))}</p>`;

  body.innerHTML = `
    <section class="space-y-2">
      <div class="flex items-center justify-between px-3 text-[10px] uppercase tracking-wide text-slate-500">
        <span>${esc(t('usersEmail'))}</span><span>${esc(t('usersRole'))}</span>
      </div>
      <div class="space-y-2 max-h-56 overflow-y-auto pe-1">${userRows}</div>
    </section>

    <section class="space-y-2 border-t border-slate-800 pt-4">
      <h4 class="text-[11px] uppercase tracking-wide font-semibold text-slate-400">${esc(t('usersMatchHeading'))}</h4>
      <p class="text-[10px] uppercase tracking-wide text-slate-500">${esc(t('usersMatch'))}</p>
      ${matchSelect}
      <p class="text-[11px] uppercase tracking-wide font-semibold text-slate-500 pt-1">${esc(t('usersScorersHeading'))}</p>
      <div class="space-y-1.5 max-h-48 overflow-y-auto pe-1">${scorerBoxes}</div>
      <button data-action="save-officials" ${matches.length ? '' : 'disabled'}
              class="w-full px-3 py-2 bg-pitch-600 hover:bg-pitch-500 text-white rounded-lg text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 transition">
        <i data-lucide="save" class="w-3.5 h-3.5"></i> ${esc(t('usersSaveOfficials'))}
      </button>
    </section>`;

  refreshIcons();
}

async function changeUserRole(userId, role) {
  if (typeof isAdmin !== 'function' || !isAdmin()) return;
  if (typeof currentUser !== 'undefined' && currentUser && userId === currentUser.id && role !== 'admin') {
    alert(t('alertRoleFailed'));
    renderUsersModal();
    return;
  }

  try {
    await dbSetUserRole(userId, role);
    const user = usersModalState.users.find(item => item.id === userId);
    if (user) user.role = role;
    syncOfficialsDraft();
    renderUsersModal();
    showToast(t('usersRoleSaved'));
  } catch (err) {
    console.error('Mzab League: could not change the role.', err);
    alert(t('alertRoleFailed'));
    renderUsersModal();
  }
}

async function saveOfficials() {
  if (typeof isAdmin !== 'function' || !isAdmin() || !usersModalState.matchId) return;
  const userIds = Array.from(usersModalState.draft);

  try {
    await dbSetMatchOfficials(usersModalState.matchId, userIds);
    await refreshData();
    syncOfficialsDraft();
    renderApp();
    renderUsersModal();
    showToast(t('usersOfficialsSaved'));
  } catch (err) {
    console.error('Mzab League: could not save the officials.', err);
    alert(t('alertOfficialsFailed'));
  }
}

/** Re-render the open Users & roles dialog after a language switch. */
function refreshUsersIfOpen() {
  const modal = document.getElementById('modal-users');
  if (modal && !modal.classList.contains('hidden') && !usersModalState.loading && !usersModalState.error) {
    renderUsersModal();
  }
}

/* ---------- recently deleted (admin) ---------- */

function openTrashModal() {
  closeDataMenu();
  openModal('modal-trash');
  renderTrash();
}

function renderTrashItem(kind, id, label, meta, iconHtml) {
  return `
    <div class="flex items-center gap-3 p-3 bg-slate-800/40 border border-slate-800 rounded-lg">
      ${iconHtml || ''}
      <div class="min-w-0 flex-1">
        <p class="text-slate-200 font-medium break-words">${esc(label)}</p>
        <p class="text-[11px] text-slate-500 mt-0.5 break-words">${esc(meta)}</p>
      </div>
      <button data-action="restore-${kind}" data-id="${esc(id)}"
              class="shrink-0 px-3 py-1.5 bg-pitch-600/20 text-pitch-400 hover:bg-pitch-600/30 border border-pitch-500/30 rounded-lg text-[11px] font-semibold transition">
        ${esc(t('trashRestore'))}
      </button>
    </div>`;
}

function renderTrashSection(titleKey, items) {
  if (!items.length) return '';
  return `
    <section class="space-y-2">
      <h4 class="text-[11px] uppercase tracking-wide font-semibold text-slate-400">${esc(t(titleKey))}</h4>
      ${items.join('')}
    </section>`;
}

function renderTrash() {
  const list = document.getElementById('trash-list');
  const modal = document.getElementById('modal-trash');
  if (!list || !modal) return;

  if (!BACKEND_READY) {
    list.innerHTML = `<div class="p-4 rounded-xl bg-amber-400/10 border border-amber-400/20 text-amber-200 leading-relaxed">${esc(t('trashUnavailable'))}</div>`;
    return;
  }

  list.innerHTML = `<p class="py-6 text-center text-slate-500">${esc(t('trashLoading'))}</p>`;

  dbListDeleted()
    .then(trash => {
      if (modal.classList.contains('hidden')) return;
      if (trash === null) {
        list.innerHTML = `<div class="p-4 rounded-xl bg-amber-400/10 border border-amber-400/20 text-amber-200 leading-relaxed">${esc(t('trashUnavailable'))}</div>`;
        return;
      }

      const teams = Array.isArray(trash.teams) ? trash.teams : [];
      const matches = Array.isArray(trash.matches) ? trash.matches : [];
      const seasons = Array.isArray(trash.seasons) ? trash.seasons : [];
      if (!teams.length && !matches.length && !seasons.length) {
        list.innerHTML = `<p class="py-6 text-center text-slate-500">${esc(t('trashEmpty'))}</p>`;
        return;
      }

      const sections = [];
      sections.push(renderTrashSection('trashTeams', teams.map(team => {
        const name = bilingualName(team.name, team.nameAr);
        const label = team.code ? `${name} (${team.code})` : name;
        const meta = [
          `${team.playerCount || 0} ${t('trashPlayers')}`,
          `${team.matchCount || 0} ${t('trashFixtures')}`,
          `${t('trashDeletedAt')} ${auditTime(team.deletedAt)}`
        ].join(' · ');
        return renderTrashItem('team', team.id, label, meta, teamIconHtml({ name, icon: team.icon }, 32));
      })));

      sections.push(renderTrashSection('trashMatches', matches.map(match => {
        const home = bilingualName(match.homeName, match.homeNameAr) || '?';
        const away = bilingualName(match.awayName, match.awayNameAr) || '?';
        const label = `${home} ${match.homeScore == null ? 0 : match.homeScore}–${match.awayScore == null ? 0 : match.awayScore} ${away}`;
        const meta = [
          `${t('matchdayPrefix')} ${match.round == null ? '?' : match.round}`,
          `${t('trashDeletedAt')} ${auditTime(match.deletedAt)}`
        ].join(' · ');
        return renderTrashItem('match', match.id, label, meta);
      })));

      sections.push(renderTrashSection('trashSeasons', seasons.map(season => {
        const meta = `${t('trashDeletedAt')} ${auditTime(season.deletedAt)}`;
        return renderTrashItem('season', season.id, season.name || season.id, meta);
      })));

      list.innerHTML = sections.join('');
    })
    .catch(error => {
      console.error('Mzab League: could not load the deleted items.', error);
      list.innerHTML = `<p class="py-6 text-center text-rose-400">${esc(t('trashError'))}</p>`;
    });
}

async function restoreTrashItem(kind, id) {
  const restore = {
    team: dbRestoreTeam,
    match: dbRestoreMatch,
    season: dbRestoreSeason
  }[kind];
  if (!restore) return;

  try {
    await restore(id);
    await refreshData();
    renderApp();
    showToast(t({
      team: 'trashRestoredTeam',
      match: 'trashRestoredMatch',
      season: 'trashRestoredSeason'
    }[kind]));
    renderTrash();
  } catch (err) {
    const message = String(err && err.message ? err.message : '');
    let key = 'trashRestoreFailed';
    if (err && err.code === 'SOFT_DELETE_MIGRATION_REQUIRED') key = 'alertSoftDeleteMigration';
    else if (/Restore the teams/i.test(message)) key = 'trashRestoreTeamFirst';
    else if (/Restore the season/i.test(message)) key = 'trashRestoreSeasonFirst';
    alert(t(key));
    renderTrash();
  }
}

/** Re-render the open trash dialog after a language switch. */
function refreshTrashIfOpen() {
  const modal = document.getElementById('modal-trash');
  if (modal && !modal.classList.contains('hidden')) renderTrash();
}

function toggleDataMenu(button) {
  const menu = document.getElementById('data-menu');
  if (!menu) return;
  const willOpen = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !willOpen);
  const opener = button || document.querySelector('[aria-controls="data-menu"]');
  if (opener) opener.setAttribute('aria-expanded', String(willOpen));
}

// Close the settings dropdown when clicking anywhere else
document.addEventListener('click', function (e) {
  const menu = document.getElementById('data-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  // Clicks on the toggle are handled by the delegation dispatcher above.
  if (menu.contains(e.target)) return;
  if (e.target instanceof Element && e.target.closest('[data-action="data-menu"]')) return;
  menu.classList.add('hidden');
  const opener = document.querySelector('[aria-controls="data-menu"]');
  if (opener) opener.setAttribute('aria-expanded', 'false');
});

function exportData() {
  // Only league data belongs in a backup; omit transient view state.
  const payload = {
    seasons: appState.seasons,
    teams: appState.teams,
    players: appState.players,
    matches: appState.matches,
    matchEvents: appState.matchEvents || []
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `kickoff_division_backup_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- CSV exports (current season) ---------- */

/* csvEscape() lives in js/domain/format.js (published on globalThis). */

function downloadCsv(filename, rows) {
  const csv = '\uFEFF' + rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvSeasonSuffix() {
  const season = viewedSeason();
  const name = season && season.name ? season.name.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') : '';
  if (name) return name;
  return season && season.id ? String(season.id).replace(/[^\w-]+/g, '_') : 'season';
}

function buildStandingsCsvRows() {
  const season = viewedSeason();
  const seasonName = season ? season.name : '';
  const rows = calculateStandings();
  return [
    [t('seasonLabel'), t('thPos'), t('thClub'), t('thMP'), t('thW'), t('thD'), t('thL'), t('thGF'), t('thGA'), t('thGD'), t('thPts'), t('thForm')],
    ...rows.map((row, index) => [
      seasonName,
      index + 1,
      teamDisplayName(row.team),
      row.mp,
      row.w,
      row.d,
      row.l,
      row.gf,
      row.ga,
      row.gd,
      row.pts,
      row.form.join(' ')
    ])
  ];
}

function exportStandingsCsv() {
  downloadCsv(`kickoff_standings_${csvSeasonSuffix()}.csv`, buildStandingsCsvRows());
}

function buildFixturesCsvRows() {
  const season = viewedSeason();
  const seasonName = season ? season.name : '';
  const teamName = id => teamDisplayName(getTeam(id)) || id;
  const matches = visibleMatches().slice().sort((a, b) =>
    (a.round - b.round) || (a.datetime || '').localeCompare(b.datetime || '')
  );

  return [
    [t('seasonLabel'), t('lblRound'), t('lblDateTime'), t('lblHomeTeam'), t('csvHomeScore'), t('csvAwayScore'), t('lblAwayTeam'), t('lblStatus'), t('lblVenue'), t('csvScorers')],
    ...matches.map(match => {
      const events = getMatchEvents(match.id);
      const eventSummary = events.length ? summarizeEventsForText(events, match.homeId, match.awayId) : '';
      return [
        seasonName,
        match.round,
        match.datetime || '',
        teamName(match.homeId),
        match.homeScore == null ? 0 : match.homeScore,
        match.awayScore == null ? 0 : match.awayScore,
        teamName(match.awayId),
        match.status,
        match.venue || '',
        eventSummary || match.scorersText || ''
      ];
    })
  ];
}

function exportFixturesCsv() {
  downloadCsv(`kickoff_fixtures_${csvSeasonSuffix()}.csv`, buildFixturesCsvRows());
}

function buildSquadsCsvRows() {
  const season = viewedSeason();
  const seasonName = season ? season.name : '';
  const teamName = id => teamDisplayName(getTeam(id)) || id;
  const players = appState.players
    .filter(player => player.isActive !== false)
    .slice()
    .sort((a, b) =>
      teamName(a.teamId).localeCompare(teamName(b.teamId)) || (a.num || 0) - (b.num || 0)
    );
  // Licence numbers and birth dates are personal data, so the columns only
  // appear for an admin whose session can read player_profiles.
  const withProfiles = Boolean(appState.profilesReady);

  return [
    [
      t('seasonLabel'), t('csvTeam'), t('thPlayer'), t('lblPosition'), t('lblJerseyNum'),
      t('lblGoals'), t('lblYellowCards'), t('lblRedCards'),
      ...(withProfiles ? [t('thLicense'), t('lblBirthDate')] : [])
    ],
    ...players.map(player => [
      seasonName,
      teamName(player.teamId),
      playerDisplayName(player),
      player.pos,
      player.num,
      player.goals,
      player.yellow,
      player.red,
      ...(withProfiles ? [player.licenseId || '', player.birthDate || ''] : [])
    ])
  ];
}

function exportSquadsCsv() {
  downloadCsv(`kickoff_squads_${csvSeasonSuffix()}.csv`, buildSquadsCsvRows());
}

/* ---------- calendar export (.ics) ---------- */

/* buildCalendar() lives in js/domain/ics.js (published on globalThis). */

function downloadIcs(filename, text) {
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function icsFileSlug(value) {
  return String(value == null ? '' : value)
    .replace(/[^\w-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Map one fixture to the plain event object the domain builder expects. */
function calendarEventForMatch(match) {
  const homeName = teamDisplayName(getTeam(match.homeId)) || String(match.homeId || '');
  const awayName = teamDisplayName(getTeam(match.awayId)) || String(match.awayId || '');
  const finished = match.status === 'FINISHED' && match.homeScore != null && match.awayScore != null;
  const season = viewedSeason();

  const summary = finished
    ? `${homeName} ${toInt(match.homeScore)}–${toInt(match.awayScore)} ${awayName}`
    : `${homeName} ${t('calendarVersus')} ${awayName}`;

  const description = [
    `${divisionLabel(match.divisionId)} · ${t('lblRound')} ${toInt(match.round)}`,
    season && season.name ? season.name : '',
    match.venue ? `${t('lblVenue')}: ${match.venue}` : '',
    finished ? `${t('lblStatus')}: ${t('optFinished')}` : ''
  ].filter(Boolean).join('\n');

  return {
    uid: `match-${match.id}@mzab-league.github.io`,
    start: match.datetime || '',
    summary,
    description,
    location: match.venue || ''
  };
}

/** Build the .ics for the given fixtures and hand it to the browser. */
function exportCalendar(matches, label) {
  const domain = globalThis.KickOffDomain;
  if (!domain || typeof domain.buildCalendar !== 'function') return;

  const season = viewedSeason();
  const name = [t('appTitle'), season && season.name, label].filter(Boolean).join(' — ');
  const result = domain.buildCalendar({
    name,
    events: (matches || []).map(calendarEventForMatch)
  });

  if (!result.written) {
    showToast(t('calendarNoFixtures'));
    return;
  }

  const seasonSlug = icsFileSlug(season && season.name) || 'season';
  downloadIcs(`mzab_league_${seasonSlug}_${icsFileSlug(label) || 'fixtures'}.ics`, result.text);

  // Counts are left out on purpose: "1 fixtures" would be wrong in English and
  // the number is visible in the calendar anyway. The skipped hint only says
  // that some fixtures had no date, which is the part a supporter cannot see.
  showToast(t('calendarSaved') + (result.skipped ? ' ' + t('calendarSkipped') : ''));
}

function sortForCalendar(matches) {
  return matches.slice().sort((a, b) =>
    (a.round - b.round) || (a.datetime || '').localeCompare(b.datetime || '')
  );
}

/** Export exactly what the fixtures view is showing (division + filters). */
function exportVisibleCalendar() {
  const roundFilter = document.getElementById('filter-round');
  const statusFilter = document.getElementById('filter-status');
  const round = roundFilter ? roundFilter.value : 'ALL';
  const status = statusFilter ? statusFilter.value : 'ALL';

  let matches = visibleMatches();
  if (round !== 'ALL') matches = matches.filter(match => String(match.round) === round);
  if (status !== 'ALL') matches = matches.filter(match => match.status === status);

  exportCalendar(sortForCalendar(matches), divisionLabel(viewedDivisionId()));
}

/** Export one club's fixtures from the season and division being viewed. */
function exportTeamCalendar(teamId) {
  const team = getTeam(teamId);
  if (!team) return;
  const matches = visibleMatches()
    .filter(match => match.homeId === teamId || match.awayId === teamId);
  exportCalendar(sortForCalendar(matches), teamDisplayName(team));
}

/**
 * Validate an imported JSON payload before sending it to Postgres.
 * Returns a normalized copy, or null when the schema/relations are invalid.
 */
function validateImport(data) {
  if (!data || typeof data !== 'object') return null;
  if (!Array.isArray(data.teams) || !Array.isArray(data.matches)) return null;
  if (data.seasons !== undefined && !Array.isArray(data.seasons)) return null;
  if (data.matchEvents !== undefined && !Array.isArray(data.matchEvents)) return null;

  const teams = data.teams;
  const players = Array.isArray(data.players) ? data.players : [];
  const matches = data.matches;
  const seasons = Array.isArray(data.seasons) ? data.seasons : [];
  const matchEvents = Array.isArray(data.matchEvents) ? data.matchEvents : [];
  const ids = new Set();
  const seasonIds = new Set();
  const playerIds = new Set();
  const matchIds = new Set();

  for (const team of teams) {
    if (!team || typeof team.id !== 'string' || !team.id || typeof team.name !== 'string' || !team.name) return null;
    if (ids.has(team.id)) return null;
    ids.add(team.id);
  }

  for (const season of seasons) {
    if (!season || typeof season.id !== 'string' || !season.id) return null;
    if (typeof season.name !== 'string' || !season.name.trim()) return null;
    if (seasonIds.has(season.id)) return null;
    seasonIds.add(season.id);
  }

  for (const player of players) {
    if (!player || typeof player.id !== 'string' || !player.id) return null;
    if (!ids.has(player.teamId) || typeof player.name !== 'string' || !player.name) return null;
    if (player.isActive !== undefined && typeof player.isActive !== 'boolean') return null;
    if (playerIds.has(player.id)) return null;
    playerIds.add(player.id);
  }

  for (const match of matches) {
    if (!match || typeof match.id !== 'string' || !match.id) return null;
    if (!ids.has(match.homeId) || !ids.has(match.awayId) || match.homeId === match.awayId) return null;
    // Season references are optional in old backups, but must be valid when supplied.
    if (seasons.length && match.seasonId && !seasonIds.has(match.seasonId)) return null;
    if (match.eventsCounted !== undefined && typeof match.eventsCounted !== 'boolean') return null;
    if (matchIds.has(match.id)) return null;
    matchIds.add(match.id);
  }

  const eventIds = new Set();
  for (const event of matchEvents) {
    if (!event || typeof event.id !== 'string' || !event.id) return null;
    if (eventIds.has(event.id)) return null;
    eventIds.add(event.id);
    if (!matchIds.has(event.matchId) || !ids.has(event.teamId) || !playerIds.has(event.playerId)) return null;
    if (!['goal', 'yellow', 'red'].includes(event.type)) return null;
    const minute = Number(event.minute);
    if (!Number.isInteger(minute) || minute < 1 || minute > 130) return null;

    const match = matches.find(item => item.id === event.matchId);
    if (!match || (event.teamId !== match.homeId && event.teamId !== match.awayId)) return null;
    const player = players.find(item => item.id === event.playerId);
    if (!player || player.teamId !== event.teamId) return null;
  }

  return normalizeState(data);
}

/* ---------- merge import (roadmap H) ---------- */

const IMPORT_REPLACE_WORD = 'REPLACE';
const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
const IMPORT_ENTITIES = [
  ['seasons', 'importEntitySeasons'],
  ['teams', 'importEntityTeams'],
  ['players', 'importEntityPlayers'],
  ['matches', 'importEntityMatches'],
  ['events', 'importEntityEvents']
];
const IMPORT_DETAIL_GROUPS = [
  ['addedItems', 'importDetailsAdded'],
  ['changedItems', 'importDetailsChanged'],
  ['removedItems', 'importDetailsRemoved']
];

const importState = {
  data: null,
  fileName: '',
  removeMissing: false,
  preview: null,
  checksum: '',
  idempotencyKey: '',
  replaceWord: '',
  replaceReady: false,
  busy: false
};

function importFormatCount(value) {
  return new Intl.NumberFormat(currentLang).format(Number(value) || 0);
}

/** A fresh idempotency key per previewed upload; a retry of the same preview reuses it. */
function importIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'import-' + crypto.randomUUID();
  }
  return 'import-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function chooseImportFile() {
  if (importState.busy) return;
  const input = document.getElementById('import-merge-file');
  if (input) input.click();
}

function openImportModal() {
  resetImportState();
  openModal('modal-import');
}

function setImportError(message) {
  const el = document.getElementById('import-error');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function setImportBusy(busy) {
  importState.busy = Boolean(busy);
  const apply = document.getElementById('import-apply');
  if (apply) apply.disabled = importState.busy || !importState.preview;
  const checkbox = document.getElementById('import-remove-missing');
  if (checkbox) {
    checkbox.disabled = importState.busy;
    checkbox.checked = importState.removeMissing;
  }
  const confirm = document.getElementById('import-replace-confirm');
  if (confirm) confirm.disabled = importState.busy || !importState.replaceReady;
  const file = document.getElementById('import-merge-file');
  if (file) file.disabled = importState.busy;
}

function resetImportState() {
  importState.data = null;
  importState.fileName = '';
  importState.removeMissing = false;
  importState.preview = null;
  importState.checksum = '';
  importState.idempotencyKey = '';
  importState.replaceWord = '';
  importState.replaceReady = false;
  importState.busy = false;

  const name = document.getElementById('import-file-name');
  if (name) name.textContent = '';
  const input = document.getElementById('import-replace-word');
  if (input) input.value = '';
  const panel = document.getElementById('import-replace-panel');
  if (panel) panel.classList.add('hidden');
  setImportError('');
  renderImportPreview();
}

function readImportFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => resolve(String((event.target && event.target.result) || ''));
    reader.onerror = () => reject(new Error(t('importReadError')));
    reader.readAsText(file);
  });
}

async function handleImportFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = ''; // allow choosing the same file again
  if (!file) return;

  setImportError('');
  importState.data = null;
  importState.preview = null;
  importState.checksum = '';
  importState.idempotencyKey = '';
  importState.removeMissing = false;
  importState.replaceReady = false;
  importState.fileName = file.name;
  const name = document.getElementById('import-file-name');
  if (name) name.textContent = file.name;
  const panel = document.getElementById('import-replace-panel');
  if (panel) panel.classList.add('hidden');
  renderImportPreview();

  if (file.size > IMPORT_MAX_BYTES) {
    setImportError(t('importFileTooLarge'));
    return;
  }

  setImportBusy(true);
  try {
    const text = await readImportFile(file);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(t('importInvalidFile'));
    }
    const data = validateImport(parsed);
    if (!data) throw new Error(t('importInvalidFile'));
    if ((data.matchEvents || []).length && !appState.eventsReady) {
      throw new Error(t('matchEventsImportBlocked'));
    }
    importState.data = data;
    await refreshImportPreview();
  } catch (err) {
    setImportError(importErrorMessage(err));
    renderImportPreview();
  } finally {
    setImportBusy(false);
  }
}

/**
 * Compare the chosen backup with the live data. Nothing is written; the RPC is
 * read-only and returns the counts, the capped entity lists and the checksum
 * that import_merge() verifies before applying.
 */
async function refreshImportPreview() {
  if (!importState.data) return;
  setImportError('');
  importState.preview = null;
  importState.checksum = '';
  importState.idempotencyKey = '';
  setImportBusy(true);
  renderImportPreview();
  try {
    const preview = await dbImportPreview(importState.data, importState.removeMissing);
    importState.preview = preview;
    importState.checksum = preview && preview.checksum ? preview.checksum : '';
    importState.idempotencyKey = importIdempotencyKey();
  } catch (err) {
    setImportError(importErrorMessage(err));
  } finally {
    setImportBusy(false);
    renderImportPreview();
  }
}

function toggleImportRemoveMissing(el) {
  if (importState.busy) {
    el.checked = importState.removeMissing;
    return;
  }
  importState.removeMissing = Boolean(el.checked);
  refreshImportPreview();
}

/** Every live row is changed, unchanged or removed; added rows do not exist yet. */
function importLiveRowCount(preview) {
  if (!preview || !preview.tables) return 0;
  return Object.values(preview.tables).reduce((sum, table) =>
    sum +
    (Number(table.changed) || 0) +
    (Number(table.unchanged) || 0) +
    (Number(table.removed) || 0), 0);
}

function renderImportReplaceCount() {
  const panel = document.getElementById('import-replace-panel');
  const el = document.getElementById('import-replace-count');
  if (!panel || !el || panel.classList.contains('hidden')) return;
  // Without a preview (e.g. the merge migration is missing) the count is unknown.
  el.textContent = importState.preview
    ? t('importReplaceCount').replace('{n}', importFormatCount(importLiveRowCount(importState.preview)))
    : '';
}

function renderImportPreview() {
  const previewEl = document.getElementById('import-preview');
  if (!previewEl) return;
  const preview = importState.preview;
  previewEl.classList.toggle('hidden', !preview);

  const replaceOpen = document.getElementById('import-replace-open');
  // Keep disaster recovery reachable from a parsed file even when the merge
  // migration has not been applied yet.
  if (replaceOpen) replaceOpen.classList.toggle('hidden', !preview && !importState.data);
  const summaryEl = document.getElementById('import-summary');
  const body = document.getElementById('import-diff-body');
  const details = document.getElementById('import-diff-details');
  const checksumEl = document.getElementById('import-checksum');
  if (body) body.replaceChildren();
  if (details) details.replaceChildren();

  if (!preview) {
    if (summaryEl) summaryEl.textContent = '';
    if (checksumEl) checksumEl.textContent = '';
    setImportBusy(importState.busy);
    return;
  }

  const totals = preview.totals || {};
  if (summaryEl) {
    summaryEl.textContent = t('importSummary')
      .replace('{added}', importFormatCount(totals.added))
      .replace('{changed}', importFormatCount(totals.changed))
      .replace('{removed}', importFormatCount(totals.removed));
  }

  if (body) {
    const colours = { added: 'text-emerald-300', changed: 'text-amber-300', removed: 'text-rose-300', unchanged: 'text-slate-500' };
    for (const [key, labelKey] of IMPORT_ENTITIES) {
      const diff = preview.tables && preview.tables[key];
      if (!diff) continue;
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      nameCell.className = 'py-1 text-slate-300';
      nameCell.textContent = t(labelKey);
      row.appendChild(nameCell);
      for (const field of ['added', 'changed', 'removed', 'unchanged']) {
        const cell = document.createElement('td');
        const count = Number(diff[field]) || 0;
        cell.className = 'py-1 text-end tabular-nums ' + (count ? colours[field] : 'text-slate-600');
        cell.textContent = importFormatCount(count);
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
  }

  if (details) {
    for (const [key, labelKey] of IMPORT_ENTITIES) {
      const diff = preview.tables && preview.tables[key];
      if (!diff) continue;
      const hasItems = IMPORT_DETAIL_GROUPS.some(([field]) =>
        Array.isArray(diff[field]) && diff[field].length > 0
      );
      if (!hasItems) continue;

      const box = document.createElement('details');
      box.className = 'rounded-lg bg-slate-800/40 border border-slate-700 px-2.5 py-1.5';
      const title = document.createElement('summary');
      title.className = 'cursor-pointer text-slate-300';
      title.textContent = t(labelKey);
      box.appendChild(title);

      for (const [field, groupKey] of IMPORT_DETAIL_GROUPS) {
        const items = Array.isArray(diff[field]) ? diff[field] : [];
        if (!items.length) continue;
        const line = document.createElement('p');
        line.className = 'mt-1 leading-relaxed';
        const label = document.createElement('span');
        label.className = 'text-slate-300';
        label.textContent = t(groupKey) + ': ';
        line.appendChild(label);
        const names = items.slice(0, 10).map(item => (item && (item.label || item.id)) || '?');
        line.appendChild(document.createTextNode(names.join(', ') + (items.length > 10 ? ' …' : '')));
        box.appendChild(line);
      }
      details.appendChild(box);
    }
  }

  if (checksumEl) {
    checksumEl.textContent = preview.checksum
      ? t('importChecksum').replace('{hash}', preview.checksum)
      : '';
  }
  renderImportReplaceCount();
  setImportBusy(importState.busy);
}

function refreshImportIfOpen() {
  const modal = document.getElementById('modal-import');
  if (!modal || modal.classList.contains('hidden') || importState.busy) return;
  renderImportPreview();
}

async function applyImportMerge() {
  if (!importState.data || !importState.preview || importState.busy) return;
  setImportBusy(true);
  setImportError('');
  try {
    const result = await dbImportMerge(
      importState.data,
      importState.idempotencyKey,
      importState.removeMissing,
      importState.checksum
    );
    await refreshData();
    renderApp();
    closeModal('modal-import');
    if (result && result.replayed) {
      showToast(t('importReplayToast'));
    } else {
      showToast(importResultMessage(result));
    }
    resetImportState();
  } catch (err) {
    setImportError(importErrorMessage(err));
  } finally {
    setImportBusy(false);
  }
}

function importResultMessage(result) {
  const totals = (result && result.totals) || {};
  return t('importApplied')
    .replace('{added}', importFormatCount(totals.added))
    .replace('{changed}', importFormatCount(totals.changed))
    .replace('{removed}', importFormatCount(totals.removed));
}

function importErrorMessage(err) {
  if (err && err.code === 'MERGE_IMPORT_MIGRATION_REQUIRED') return t('importMigrationError');
  const message = String((err && err.message) || err || '').trim();
  if (/changed after the preview/i.test(message)) return t('importStalePreview');
  if (/already used for a different backup/i.test(message)) return t('importKeyReused');
  if (/Only admins/i.test(message) || /permission denied/i.test(message)) return t('importAdminOnly');
  return message || t('alertImportError');
}

function openImportReplace() {
  if (!importState.data || importState.busy) return;
  const panel = document.getElementById('import-replace-panel');
  if (!panel) return;
  panel.classList.remove('hidden');
  importState.replaceWord = '';
  importState.replaceReady = false;
  renderImportReplaceCount();
  const input = document.getElementById('import-replace-word');
  if (input) {
    input.value = '';
    input.focus({ preventScroll: true });
  }
  setImportBusy(false);
}

function onImportReplaceInput(el) {
  importState.replaceWord = el.value;
  importState.replaceReady = el.value.trim() === IMPORT_REPLACE_WORD;
  const confirm = document.getElementById('import-replace-confirm');
  if (confirm) confirm.disabled = importState.busy || !importState.replaceReady;
}

/**
 * Disaster recovery: replace everything. Still available, but behind MFA at the
 * dispatcher and a typed confirmation here; the current data is downloaded first.
 */
async function confirmImportReplace() {
  if (!importState.data || !importState.replaceReady || importState.busy) return;
  setImportBusy(true);
  setImportError('');
  try {
    exportData();
    await dbReplaceAll(importState.data);
    await refreshData();
    renderApp();
    closeModal('modal-import');
    showToast(t('importReplaced'));
    resetImportState();
  } catch (err) {
    setImportError(importErrorMessage(err));
  } finally {
    setImportBusy(false);
  }
}

async function resetData() {
  if (!confirm(t('confirmReset'))) return;

  try {
    await dbReplaceAll(normalizeState(JSON.parse(JSON.stringify(DEFAULT_DATA))));
    await refreshData();
    renderApp();
  } catch (err) {
    alert(t('alertSaveFailed'));
  }
}

/* ---------------------------------------------------------------
 * 10b. FIXTURE GENERATOR + RESCHEDULE (roadmap F)
 *      The plan is built in js/domain/schedule.js and previewed
 *      here. public.create_fixtures() and shift_fixture_rounds()
 *      are the only write paths, and each takes one transaction.
 * --------------------------------------------------------------- */

const FIXTURE_WARNING_KEYS = {
  ODD_TEAMS: 'generateWarnOddTeams',
  BLACKOUT_MOVED: 'generateWarnBlackout',
  SLOTS_REUSED: 'generateWarnSlots',
  BALANCE_UNREPAIRED: 'generateWarnBalance'
};

const fixturePlanState = { plan: null, skipped: 0, busy: false };
const fixtureShiftState = { preview: null, busy: false };

/** Pairing key that ignores which club is at home. */
function fixturePairKey(match) {
  return [String(match.homeId), String(match.awayId)].sort().join('|');
}

/** Live fixtures of the active season in the division on screen. */
function activeDivisionMatches() {
  const divisionId = viewedDivisionId();
  return activeMatches().filter(match => (match.divisionId || 'd1') === divisionId);
}

/** A sensible first matchday: the season start if it is still ahead, else today. */
function fixtureStartDateDefault() {
  const today = localDateKey(new Date());
  const season = getSeason(appState.activeSeasonId);
  const start = season && /^\d{4}-\d{2}-\d{2}$/.test(season.startDate) ? season.startDate : '';
  return start && start > today ? start : today;
}

function fixtureDateTimeLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  return isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString(currentLang, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

/** Map a rejected generate/shift call to a translated, actionable message. */
function fixturePlanErrorMessage(error) {
  if (error && error.code === 'FIXTURES_MIGRATION_REQUIRED') return t('fixturesMigration');
  const message = String((error && error.message) || error || '');
  if (/Only admins|permission denied/i.test(message)) return t('fixturesAdminOnly');
  if (/Only unplayed, empty fixtures can be replaced/i.test(message)) return t('generateReplaceBlocked');
  if (/pairing already has a fixture/i.test(message)) return t('generatePairingExists');
  if (/Only unplayed fixtures can be rescheduled/i.test(message)) return t('shiftPlayedBlockedGeneric');
  if (/active season/i.test(message)) return t('alertArchiveReadOnly');
  return t('generateSaveFailed');
}

/* ---------- generator ---------- */

function openGenerateModal() {
  if (!canEditMatches()) {
    alert(t('alertArchiveReadOnly'));
    return;
  }
  if (!BACKEND_READY) {
    alert(t('fixturesBackendRequired'));
    return;
  }
  if (appState.seasonsReady && !appState.activeSeasonId) {
    alert(t('alertNoActiveSeason'));
    return;
  }
  if (divisionTeams().length < 2) {
    alert(t('alertMinDivisionTeams'));
    openTeamModal();
    return;
  }

  resetFixturePlan();
  const division = document.getElementById('generate-division');
  if (division) division.textContent = divisionLabel(viewedDivisionId());
  const season = getSeason(appState.activeSeasonId);
  const seasonName = document.getElementById('generate-season');
  if (seasonName) seasonName.textContent = season ? season.name : '';
  const start = document.getElementById('generate-start');
  if (start) start.value = fixtureStartDateDefault();
  openModal('modal-generate');
}

function resetFixturePlan() {
  fixturePlanState.plan = null;
  fixturePlanState.skipped = 0;
  fixturePlanState.busy = false;
  const form = document.getElementById('form-generate');
  if (form) form.reset();
  setGenerateError('');
  setGenerateBusy(false);
  renderGeneratePreview();
}

function setGenerateError(message) {
  const el = document.getElementById('generate-error');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function setGenerateBusy(busy) {
  fixturePlanState.busy = Boolean(busy);
  const save = document.getElementById('generate-save');
  if (save) save.disabled = fixturePlanState.busy || !fixturePlanState.plan;
  const submit = document.querySelector('#form-generate button[type="submit"]');
  if (submit) submit.disabled = fixturePlanState.busy;
}

function renderGeneratePreview() {
  const preview = document.getElementById('generate-preview');
  if (!preview) return;
  const plan = fixturePlanState.plan;
  preview.classList.toggle('hidden', !plan);

  const summary = document.getElementById('generate-summary');
  const skipped = document.getElementById('generate-skipped');
  const warnings = document.getElementById('generate-warnings');
  const list = document.getElementById('generate-list');
  if (summary) summary.textContent = '';
  if (skipped) {
    skipped.textContent = '';
    skipped.classList.add('hidden');
  }
  if (warnings) {
    warnings.replaceChildren();
    warnings.classList.add('hidden');
  }
  if (list) list.replaceChildren();
  setGenerateBusy(fixturePlanState.busy);
  if (!plan) return;

  const first = plan.matches[0];
  const last = plan.matches[plan.matches.length - 1];
  if (summary) {
    summary.textContent = t('generateSummary')
      .replace('{matches}', String(plan.matches.length))
      .replace('{rounds}', String(plan.rounds))
      .replace('{first}', formatIsoDate(first.datetime.slice(0, 10)))
      .replace('{last}', formatIsoDate(last.datetime.slice(0, 10)));
  }

  if (skipped && fixturePlanState.skipped > 0) {
    skipped.textContent = t('generateSkippedExisting')
      .replace('{count}', String(fixturePlanState.skipped));
    skipped.classList.remove('hidden');
  }

  if (warnings && plan.warnings && plan.warnings.length) {
    for (const code of plan.warnings) {
      const key = FIXTURE_WARNING_KEYS[code];
      if (!key) continue;
      const item = document.createElement('li');
      item.textContent = t(key);
      warnings.appendChild(item);
    }
    warnings.classList.toggle('hidden', warnings.childElementCount === 0);
  }

  if (!list) return;
  const byRound = new Map();
  for (const match of plan.matches) {
    if (!byRound.has(match.round)) byRound.set(match.round, []);
    byRound.get(match.round).push(match);
  }
  for (const [round, matches] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
    const box = document.createElement('div');
    box.className = 'rounded-lg border border-slate-700 bg-slate-800/40 p-2';
    const heading = document.createElement('p');
    heading.className = 'text-[11px] font-semibold text-slate-300';
    heading.textContent = t('generateRoundHeading')
      .replace('{round}', String(round))
      .replace('{date}', formatIsoDate(matches[0].datetime.slice(0, 10)));
    box.appendChild(heading);
    for (const match of matches) {
      const row = document.createElement('p');
      row.className = 'text-[11px] text-slate-400 mt-0.5 break-words';
      const time = match.datetime ? match.datetime.slice(11, 16) : '';
      const venue = match.venue ? ` · ${match.venue}` : '';
      row.textContent = `${teamDisplayName(getTeam(match.homeId))} – ${teamDisplayName(getTeam(match.awayId))} · ${time}${venue}`;
      box.appendChild(row);
    }
    list.appendChild(box);
  }
}

function previewGeneratedFixtures(event) {
  event.preventDefault();
  if (fixturePlanState.busy) return;
  if (!canEditMatches()) {
    alert(t('alertArchiveReadOnly'));
    return;
  }

  const domain = globalThis.KickOffDomain;
  if (!domain || typeof domain.generateFixtures !== 'function') {
    setGenerateError(t('generateUnavailable'));
    return;
  }

  const teamIds = divisionTeams().map(team => team.id);
  if (teamIds.length < 2) {
    setGenerateError(t('alertMinDivisionTeams'));
    return;
  }

  const replaceExisting = Boolean(document.getElementById('generate-replace').checked);
  const options = {
    teamIds,
    doubleRound: Boolean(document.getElementById('generate-double').checked),
    startDate: document.getElementById('generate-start').value,
    intervalDays: Number(document.getElementById('generate-interval').value),
    kickoffTimes: document.getElementById('generate-times').value,
    venues: document.getElementById('generate-venues').value,
    blackoutDates: document.getElementById('generate-blackout').value,
    minRestDays: Number(document.getElementById('generate-rest').value),
    maxConsecutive: Number(document.getElementById('generate-max').value)
  };

  let plan;
  try {
    plan = domain.generateFixtures(options);
  } catch (error) {
    console.error('Mzab League: could not build the fixture plan.', error);
    fixturePlanState.plan = null;
    fixturePlanState.skipped = 0;
    setGenerateError(t('generateInvalid'));
    renderGeneratePreview();
    return;
  }

  let matches = plan.matches;
  let skipped = 0;
  if (!replaceExisting) {
    // The RPC refuses a pairing that already has a fixture. Skip those here so
    // an admin can fill the gaps without replacing the games already played.
    const existing = new Set(activeDivisionMatches().map(fixturePairKey));
    matches = plan.matches.filter(match => !existing.has(fixturePairKey(match)));
    skipped = plan.matches.length - matches.length;
  }

  if (!matches.length) {
    fixturePlanState.plan = null;
    fixturePlanState.skipped = skipped;
    setGenerateError(t('generateNothingNew'));
    renderGeneratePreview();
    return;
  }

  fixturePlanState.plan = {
    seasonId: appState.activeSeasonId,
    replaceExisting,
    rounds: new Set(matches.map(match => match.round)).size,
    warnings: plan.warnings,
    matches
  };
  fixturePlanState.skipped = skipped;
  setGenerateError('');
  renderGeneratePreview();
}

async function saveGeneratedFixtures() {
  const plan = fixturePlanState.plan;
  if (!plan || fixturePlanState.busy) return;
  if (!canEditMatches()) {
    alert(t('alertArchiveReadOnly'));
    return;
  }

  setGenerateBusy(true);
  setGenerateError('');
  try {
    const result = await dbCreateFixtures(plan);
    const created = result && Number(result.created) ? Number(result.created) : plan.matches.length;
    closeModal('modal-generate');
    await refreshData();
    renderApp();
    showToast(t('generateSaved').replace('{count}', String(created)));
    resetFixturePlan();
  } catch (error) {
    console.error('Mzab League: could not save the fixture plan.', error);
    setGenerateError(fixturePlanErrorMessage(error));
    setGenerateBusy(false);
  }
}

function refreshFixturePlanIfOpen() {
  const modal = document.getElementById('modal-generate');
  if (!modal || modal.classList.contains('hidden')) return;
  renderGeneratePreview();
}

/* ---------- reschedule helper ---------- */

function openShiftModal() {
  if (!canEditMatches()) {
    alert(t('alertArchiveReadOnly'));
    return;
  }
  if (!BACKEND_READY) {
    alert(t('fixturesBackendRequired'));
    return;
  }
  if (appState.seasonsReady && !appState.activeSeasonId) {
    alert(t('alertNoActiveSeason'));
    return;
  }

  resetFixtureShift();
  const division = document.getElementById('shift-division');
  if (division) division.textContent = divisionLabel(viewedDivisionId());

  // Start at the first round that has no result yet.
  const played = activeDivisionMatches()
    .filter(match => match.status !== 'SCHEDULED' || toInt(match.homeScore) > 0 || toInt(match.awayScore) > 0)
    .map(match => toInt(match.round));
  const from = document.getElementById('shift-from');
  if (from) from.value = String(played.length ? Math.max(...played) + 1 : 1);
  openModal('modal-shift');
}

function resetFixtureShift() {
  fixtureShiftState.preview = null;
  fixtureShiftState.busy = false;
  const form = document.getElementById('form-shift');
  if (form) form.reset();
  setShiftError('');
  setShiftBusy(false);
  renderShiftPreview();
}

function setShiftError(message) {
  const el = document.getElementById('shift-error');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function setShiftBusy(busy) {
  fixtureShiftState.busy = Boolean(busy);
  const apply = document.getElementById('shift-apply');
  if (apply) apply.disabled = fixtureShiftState.busy || !fixtureShiftState.preview;
  const submit = document.querySelector('#form-shift button[type="submit"]');
  if (submit) submit.disabled = fixtureShiftState.busy;
}

function renderShiftPreview() {
  const preview = document.getElementById('shift-preview');
  if (!preview) return;
  const state = fixtureShiftState.preview;
  preview.classList.toggle('hidden', !state);

  const summary = document.getElementById('shift-summary');
  const list = document.getElementById('shift-list');
  if (list) list.replaceChildren();
  setShiftBusy(fixtureShiftState.busy);
  if (!state) {
    if (summary) summary.textContent = '';
    return;
  }

  if (summary) {
    summary.textContent = t('shiftSummary')
      .replace('{count}', String(state.matches.length))
      .replace('{first}', fixtureDateTimeLabel(state.matches[0].datetime))
      .replace('{last}', fixtureDateTimeLabel(state.matches[state.matches.length - 1].datetime));
  }

  if (!list) return;
  for (const match of state.matches) {
    const row = document.createElement('p');
    row.className = 'break-words';
    row.textContent = `${teamDisplayName(getTeam(match.homeId))} – ${teamDisplayName(getTeam(match.awayId))} · ${fixtureDateTimeLabel(match.datetime)}`;
    list.appendChild(row);
  }
}

function previewFixtureShift(event) {
  event.preventDefault();
  if (fixtureShiftState.busy) return;
  if (!canEditMatches()) {
    alert(t('alertArchiveReadOnly'));
    return;
  }

  const from = Number(document.getElementById('shift-from').value);
  const days = Number(document.getElementById('shift-days').value);
  if (!Number.isInteger(from) || from < 1 || from > 1000) {
    setShiftError(t('shiftInvalidRound'));
    return;
  }
  if (!Number.isInteger(days) || days === 0 || Math.abs(days) > 365) {
    setShiftError(t('shiftInvalidDays'));
    return;
  }

  const affected = activeDivisionMatches().filter(match => toInt(match.round) >= from);
  if (!affected.length) {
    setShiftError(t('shiftNoFixtures'));
    fixtureShiftState.preview = null;
    renderShiftPreview();
    return;
  }

  const blocked = affected.filter(match =>
    match.status !== 'SCHEDULED' || toInt(match.homeScore) > 0 || toInt(match.awayScore) > 0
  );
  if (blocked.length) {
    setShiftError(t('shiftPlayedBlocked').replace('{count}', String(blocked.length)));
    fixtureShiftState.preview = null;
    renderShiftPreview();
    return;
  }

  const domain = globalThis.KickOffDomain;
  if (!domain || typeof domain.shiftRounds !== 'function') {
    setShiftError(t('generateUnavailable'));
    return;
  }

  let shifted;
  try {
    shifted = domain.shiftRounds(affected, from, days);
  } catch (error) {
    console.error('Mzab League: could not build the reschedule preview.', error);
    setShiftError(t('shiftInvalidDays'));
    return;
  }

  fixtureShiftState.preview = {
    seasonId: appState.activeSeasonId,
    divisionId: viewedDivisionId(),
    from,
    days,
    matches: shifted.matches
      .filter(match => toInt(match.round) >= from)
      .sort((a, b) => (a.round - b.round) || a.datetime.localeCompare(b.datetime))
  };
  setShiftError('');
  renderShiftPreview();
}

async function applyFixtureShift() {
  const state = fixtureShiftState.preview;
  if (!state || fixtureShiftState.busy) return;
  if (!canEditMatches()) {
    alert(t('alertArchiveReadOnly'));
    return;
  }

  setShiftBusy(true);
  setShiftError('');
  try {
    const result = await dbShiftFixtureRounds(state.seasonId, state.divisionId, state.from, state.days);
    const moved = result && Number(result.shifted) ? Number(result.shifted) : state.matches.length;
    closeModal('modal-shift');
    await refreshData();
    renderApp();
    showToast(t('shiftApplied').replace('{count}', String(moved)));
    resetFixtureShift();
  } catch (error) {
    console.error('Mzab League: could not reschedule the fixtures.', error);
    setShiftError(fixturePlanErrorMessage(error));
    setShiftBusy(false);
  }
}

function refreshFixtureShiftIfOpen() {
  const modal = document.getElementById('modal-shift');
  if (!modal || modal.classList.contains('hidden')) return;
  renderShiftPreview();
}

/* ---------------------------------------------------------------
 * 11. INITIALIZATION
 * --------------------------------------------------------------- */
window.addEventListener('DOMContentLoaded', async function () {
  applyLanguage();
  switchTab('standings');
  renderApp();

  document.addEventListener('keydown', trapModalKeyboard);

  initBackend();

  if (!BACKEND_READY) {
    // Configuration missing, malformed, or the Supabase CDN failed to load.
    console.warn('Mzab League: running in read-only demo mode (Supabase not configured).');
    applyUrlState();
  } else {
    try {
      await refreshData();
      hideDataError();
    } catch (err) {
      showDataError(err);
    }
    renderApp();
    applyUrlState();
  }

  await initAuth();
});
