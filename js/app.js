/* ---------------------------------------------------------------
   KickOff Division — application logic
   Rendering, navigation, standings calculation, modals, CRUD and
   JSON import/export. Depends on js/i18n.js and js/store.js.
   --------------------------------------------------------------- */
'use strict';

/* ---------------------------------------------------------------
 * 1. UTILITIES
 * --------------------------------------------------------------- */

/** Escape user-supplied strings before injecting them into HTML. */
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/**
 * Safely embed a value as a JavaScript string inside an HTML event attribute.
 * JSON.stringify handles quotes/backslashes/newlines; esc keeps the attribute
 * from terminating early.
 */
function jsString(value) {
  return esc(JSON.stringify(String(value == null ? '' : value)));
}

/** Pick black or white text for a team colour with WCAG-friendly contrast. */
function contrastTextColor(color) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!match) return '#ffffff';
  let hex = match[1];
  if (hex.length === 3) hex = hex.split('').map(char => char + char).join('');
  const channel = index => parseInt(hex.slice(index, index + 2), 16) / 255;
  const linear = value => value <= 0.03928
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
  const luminance = 0.2126 * linear(channel(0)) +
    0.7152 * linear(channel(2)) +
    0.0722 * linear(channel(4));
  return luminance > 0.179 ? '#020617' : '#ffffff';
}

function uid(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
}

function getTeam(id) {
  return appState.teams.find(t => t.id === id);
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return isNaN(n) || n < 0 ? (fallback || 0) : n;
}

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function closeAllModals() {
  ['modal-match', 'modal-team', 'modal-player', 'modal-season', 'modal-guide', 'modal-password', 'modal-login'].forEach(id => closeModal(id));
}

/* ---------- season helpers ---------- */

function getSeason(seasonId) {
  return (appState.seasons || []).find(season => season.id === seasonId);
}

function viewedSeason() {
  return getSeason(appState.viewSeasonId);
}

/** True when the visible season is archived (or there is no active season yet). */
function isSeasonReadOnly() {
  if (!appState.seasonsReady) return false;
  return !appState.viewSeasonId || appState.viewSeasonId !== appState.activeSeasonId;
}

/** Matches for the season currently selected in the switcher. */
function visibleMatches() {
  if (!appState.seasonsReady || !appState.viewSeasonId) return appState.matches;
  return appState.matches.filter(match => match.seasonId === appState.viewSeasonId);
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

  const supported = Boolean(appState.seasonsReady);
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

  const viewed = viewedSeason();
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

function renderApp() {
  applyEnvironmentNotice();
  renderSeasonBar();
  renderStandings();
  renderFixtureFilters();
  renderFixtures();
  renderTeamsView();
  renderStatsBanner();
  if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
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
  });

  // Mobile tabs
  document.querySelectorAll('.mob-tab-btn').forEach(btn => {
    const isActive = btn.id === 'mob-nav-' + tabId;
    btn.classList.toggle('text-pitch-400', isActive);
    btn.classList.toggle('text-slate-400', !isActive);
  });
}

/* ---------------------------------------------------------------
 * 3. LEAGUE STANDINGS (points, W/D/L, goals, GD, form)
 * --------------------------------------------------------------- */
function calculateStandings() {
  const stats = {};
  const seasonMatches = visibleMatches();
  const archived = appState.seasonsReady && appState.viewSeasonId !== appState.activeSeasonId;

  // An archived table should not gain clubs that joined in a later season.
  const seasonTeamIds = new Set();
  seasonMatches.forEach(match => {
    seasonTeamIds.add(match.homeId);
    seasonTeamIds.add(match.awayId);
  });
  const teams = archived
    ? appState.teams.filter(team => seasonTeamIds.has(team.id))
    : appState.teams;

  teams.forEach(team => {
    stats[team.id] = {
      team,
      mp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0,
      form: []
    };
  });

  // Only finished matches in the visible season count towards the table
  const finished = seasonMatches
    .filter(m => m.status === 'FINISHED')
    .sort((a, b) => (a.datetime || '').localeCompare(b.datetime || ''));

  finished.forEach(m => {
    const home = stats[m.homeId];
    const away = stats[m.awayId];
    if (!home || !away) return;

    const hs = toInt(m.homeScore);
    const as = toInt(m.awayScore);
    home.mp++; away.mp++;
    home.gf += hs; home.ga += as;
    away.gf += as; away.ga += hs;

    if (hs > as) {
      home.w++; home.pts += 3; home.form.push('W');
      away.l++; away.form.push('L');
    } else if (hs < as) {
      away.w++; away.pts += 3; away.form.push('W');
      home.l++; home.form.push('L');
    } else {
      home.d++; home.pts += 1; home.form.push('D');
      away.d++; away.pts += 1; away.form.push('D');
    }
  });

  const rows = Object.values(stats).map(s => {
    s.gd = s.gf - s.ga;
    s.form = s.form.slice(-5);
    return s;
  });

  // Tie-breakers: points → goal difference → goals scored → wins → name
  rows.sort((a, b) =>
    b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || b.w - a.w ||
    a.team.name.localeCompare(b.team.name)
  );
  return rows;
}

function formBadge(f) {
  const cls = f === 'W' ? 'bg-pitch-500/20 text-pitch-400 border-pitch-500/30'
            : f === 'D' ? 'bg-slate-500/20 text-slate-400 border-slate-500/30'
                        : 'bg-rose-500/20 text-rose-400 border-rose-500/30';
  return `<span class="w-4 h-4 rounded-full ${cls} text-[9px] font-bold inline-flex items-center justify-center border">${f}</span>`;
}

function renderStandings() {
  const tbody = document.getElementById('standings-table-body');
  const rows = calculateStandings();

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="py-8 text-center text-slate-400">${esc(t('noTeamsFound'))}</td></tr>`;
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

    return `
      <tr class="hover:bg-slate-800/40 transition">
        <td class="py-3 px-4 text-center">
          <span class="w-6 h-6 inline-flex items-center justify-center rounded-lg text-xs font-bold ${rankBadge}">${rank}</span>
        </td>
        <td class="py-3 px-4 font-semibold text-white">
          <span class="flex items-center gap-2.5">
            <span class="w-3 h-3 rounded-full shrink-0" style="background-color:${esc(s.team.color || '#22c55e')}"></span>
            <span class="truncate max-w-[140px] sm:max-w-none">${esc(s.team.name)}</span>
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

function getMatchEvents(matchId) {
  return (appState.matchEvents || []).filter(event => event.matchId === matchId);
}

function playersForTeam(teamId) {
  return appState.players
    .filter(player => player.teamId === teamId)
    .slice()
    .sort((a, b) => (toInt(a.num) - toInt(b.num)) || a.name.localeCompare(b.name));
}

function formatEventMinute(minute) {
  const value = toInt(minute);
  return value ? `${value}'` : '';
}

function matchEventChip(event) {
  const player = appState.players.find(item => item.id === event.playerId);
  const name = esc(player ? player.name : t('unknownPlayer'));
  const minute = formatEventMinute(event.minute);
  const minuteHtml = minute ? `<span class="text-slate-500">${esc(minute)}</span>` : '';

  if (event.type === 'yellow' || event.type === 'red') {
    const red = event.type === 'red';
    return `<span class="inline-flex items-center gap-1" title="${esc(t(red ? 'eventRed' : 'eventYellow'))}">
      <span class="inline-block w-2 h-3 rounded-[2px] ${red ? 'bg-rose-500' : 'bg-amber-400'}" aria-hidden="true"></span>
      <span class="sr-only">${esc(t(red ? 'eventRed' : 'eventYellow'))}: </span>
      <span>${name}</span>${minuteHtml}
    </span>`;
  }

  return `<span class="inline-flex items-center gap-1" title="${esc(t('eventGoal'))}">
    <span aria-hidden="true">⚽</span>
    <span class="sr-only">${esc(t('eventGoal'))}: </span>
    <span>${name}</span>${minuteHtml}
  </span>`;
}

/** Render structured events, or fall back to the legacy free-text scorers field. */
function renderMatchEventSummary(match) {
  const events = getMatchEvents(match.id);
  if (events.length) {
    const teamRow = (teamId) => {
      const team = getTeam(teamId);
      if (!team) return '';
      const teamEvents = events
        .filter(event => event.teamId === teamId)
        .slice()
        .sort((a, b) => toInt(a.minute) - toInt(b.minute));
      if (!teamEvents.length) return '';
      return `<div class="flex items-start gap-2 text-[11px] text-slate-300">
        <span class="w-8 shrink-0 font-bold uppercase text-slate-400">${esc(team.code || '')}</span>
        <span class="flex flex-wrap gap-x-2 gap-y-1 min-w-0">${teamEvents.map(matchEventChip).join('')}</span>
      </div>`;
    };

    return `<div class="mt-2 pt-2 border-t border-slate-700/40 space-y-1.5">
      ${teamRow(match.homeId)}
      ${teamRow(match.awayId)}
    </div>`;
  }

  if (!match.scorersText) return '';
  return `<div class="mt-2 pt-2 border-t border-slate-700/40 text-[11px] text-slate-400 flex items-center gap-1.5">
    <i data-lucide="activity" class="w-3.5 h-3.5 text-pitch-400 shrink-0"></i>
    <span class="truncate">${esc(match.scorersText)}</span>
  </div>`;
}

function summarizeEventsForText(events, homeId, awayId) {
  const playerName = id => {
    const player = appState.players.find(item => item.id === id);
    return player ? player.name : '?';
  };
  const teamText = teamId => events
    .filter(event => event.teamId === teamId)
    .slice()
    .sort((a, b) => toInt(a.minute) - toInt(b.minute))
    .map(event => {
      const suffix = event.type === 'yellow' ? ' (Y)' : event.type === 'red' ? ' (R)' : '';
      return `${playerName(event.playerId)} ${formatEventMinute(event.minute)}${suffix}`;
    })
    .join(', ');

  return [teamText(homeId), teamText(awayId)].filter(Boolean).join(' - ');
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

  let matches = visibleMatches().slice();
  if (roundFilter !== 'ALL') matches = matches.filter(m => String(m.round) === roundFilter);
  if (statusFilter !== 'ALL') matches = matches.filter(m => m.status === statusFilter);

  matches.sort((a, b) =>
    (a.round - b.round) || (a.datetime || '').localeCompare(b.datetime || '')
  );

  if (matches.length === 0) {
    container.innerHTML = `
      <div class="col-span-full bg-slate-800/30 border border-slate-800 rounded-xl p-8 text-center text-slate-400">
        <i data-lucide="calendar-x" class="w-8 h-8 mx-auto mb-2 text-slate-600"></i>
        <p class="font-medium text-sm">${esc(t('noMatchesFound'))}</p>
      </div>`;
    return;
  }

  container.innerHTML = matches.map(m => {
    const home = getTeam(m.homeId) || { name: '?', code: '??', color: '#334155' };
    const away = getTeam(m.awayId) || { name: '?', code: '??', color: '#334155' };

    const badge = m.status === 'FINISHED'
      ? `<span class="bg-slate-700/60 text-slate-300 text-[10px] font-bold px-2 py-0.5 rounded border border-slate-600">${esc(t('optFinished'))}</span>`
      : m.status === 'LIVE'
      ? `<span class="bg-rose-500/20 text-rose-400 text-[10px] font-bold px-2 py-0.5 rounded border border-rose-500/30 animate-pulse">${esc(t('optLiveNow'))}</span>`
      : `<span class="bg-blue-500/20 text-blue-400 text-[10px] font-bold px-2 py-0.5 rounded border border-blue-500/30">${esc(t('optUpcoming'))}</span>`;

    const matchDate = m.datetime
      ? new Date(m.datetime).toLocaleString(currentLang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';

    const scoreBlock = m.status === 'SCHEDULED'
      ? `<span class="text-xs font-bold text-slate-400 bg-slate-900 px-2 py-1 rounded">${esc(t('lblVs'))}</span>`
      : `<span class="text-xl font-extrabold text-white tracking-wider bg-slate-900/80 px-2.5 py-1 rounded border border-slate-700">${toInt(m.homeScore)} - ${toInt(m.awayScore)}</span>`;

    // Live matches get quick +1 steppers for instant live score logging
    const liveSteppers = m.status === 'LIVE' ? `
      <div class="admin-only season-write flex items-center justify-center gap-3 mt-1.5">
        <button onclick="bumpScore(${jsString(m.id)},'home',1)" class="w-6 h-6 rounded bg-pitch-600/80 hover:bg-pitch-500 text-white text-xs font-bold transition" title="+1">+</button>
        <button onclick="bumpScore(${jsString(m.id)},'away',1)" class="w-6 h-6 rounded bg-pitch-600/80 hover:bg-pitch-500 text-white text-xs font-bold transition" title="+1">+</button>
      </div>` : '';

    const scorers = renderMatchEventSummary(m);

    return `
      <div class="bg-slate-800/60 border border-slate-700/70 rounded-xl p-4 shadow-sm hover:border-slate-600 transition flex flex-col justify-between">
        <div class="flex justify-between items-center text-xs text-slate-400 mb-3 pb-2 border-b border-slate-700/50 gap-2">
          <span class="font-medium text-slate-300 truncate">${esc(t('matchdayPrefix'))} ${m.round} • ${esc(m.venue || '')}</span>
          <div class="flex items-center gap-2 shrink-0">
            <span>${esc(matchDate)}</span>
            ${badge}
          </div>
        </div>

        <div class="grid grid-cols-7 items-center gap-2 my-2 text-center">
          <div class="col-span-3 flex flex-col items-center">
            <span class="w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs mb-1 shadow" style="background-color:${esc(home.color || '#334155')};color:${esc(contrastTextColor(home.color || '#334155'))}">${esc(home.code || 'H')}</span>
            <span class="font-semibold text-sm text-white truncate max-w-full">${esc(home.name)}</span>
          </div>
          <div class="col-span-1 flex flex-col items-center justify-center">
            ${scoreBlock}
            ${liveSteppers}
          </div>
          <div class="col-span-3 flex flex-col items-center">
            <span class="w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs mb-1 shadow" style="background-color:${esc(away.color || '#334155')};color:${esc(contrastTextColor(away.color || '#334155'))}">${esc(away.code || 'A')}</span>
            <span class="font-semibold text-sm text-white truncate max-w-full">${esc(away.name)}</span>
          </div>
        </div>

        ${scorers}

        <div class="admin-only season-write mt-3 pt-2 border-t border-slate-700/50 flex justify-end gap-2">
          <button onclick="editMatch(${jsString(m.id)})" class="px-2.5 py-1 text-slate-300 hover:text-white bg-slate-700/50 hover:bg-slate-700 rounded text-xs flex items-center gap-1 transition">
            <i data-lucide="edit-3" class="w-3 h-3"></i> ${esc(t('editAction'))}
          </button>
          <button onclick="deleteMatch(${jsString(m.id)})" class="px-2 py-1 text-rose-400 hover:bg-rose-500/20 rounded text-xs transition">
            <i data-lucide="trash-2" class="w-3 h-3"></i>
          </button>
        </div>
      </div>`;
  }).join('');
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
 * 5. TEAMS & PLAYER ROSTERS
 * --------------------------------------------------------------- */
function renderTeamsView() {
  const container = document.getElementById('teams-container');
  const query = (document.getElementById('player-search').value || '').trim().toLowerCase();

  if (appState.teams.length === 0) {
    container.innerHTML = `
      <div class="col-span-full bg-slate-800/30 border border-slate-800 rounded-xl p-8 text-center text-slate-400">
        <i data-lucide="shield-alert" class="w-8 h-8 mx-auto mb-2 text-slate-600"></i>
        <p class="font-medium text-sm">${esc(t('noTeamsFound'))}</p>
      </div>`;
    return;
  }

  container.innerHTML = appState.teams.map(team => {
    let squad = appState.players.filter(p => p.teamId === team.id);
    if (query) {
      const teamMatches = team.name.toLowerCase().includes(query);
      squad = teamMatches ? squad : squad.filter(p => p.name.toLowerCase().includes(query));
      if (!teamMatches && squad.length === 0) return '';
    }
    const totalSquad = appState.players.filter(p => p.teamId === team.id).length;

    return `
      <div class="bg-slate-800/60 border border-slate-700/70 rounded-xl overflow-hidden shadow-sm flex flex-col">
        <div class="bg-slate-900/80 p-4 border-b border-slate-700 flex justify-between items-center gap-2">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-2 h-8 rounded-full shrink-0" style="background-color:${esc(team.color || '#22c55e')}"></div>
            <div class="min-w-0">
              <h3 class="font-bold text-base text-white truncate">${esc(team.name)}</h3>
              <p class="text-xs text-slate-400">${totalSquad} ${esc(t('lblPlayers'))} • ${esc(team.code)}</p>
            </div>
          </div>
          <div class="admin-only flex items-center gap-2 shrink-0">
            <button onclick="openPlayerModal(${jsString(team.id)})" class="px-2.5 py-1.5 bg-pitch-600/20 text-pitch-400 hover:bg-pitch-600/30 border border-pitch-500/30 rounded-lg text-xs font-medium flex items-center gap-1 transition">
              <i data-lucide="user-plus" class="w-3.5 h-3.5"></i> ${esc(t('btnAddPlayer'))}
            </button>
            <button onclick="editTeam(${jsString(team.id)})" class="p-1.5 text-slate-500 hover:text-white rounded transition">
              <i data-lucide="edit-3" class="w-4 h-4"></i>
            </button>
            <button onclick="deleteTeam(${jsString(team.id)})" class="p-1.5 text-slate-500 hover:text-rose-400 rounded transition">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
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
                    <td class="py-2 font-semibold text-slate-200">${esc(p.name)}</td>
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
                        <button onclick="editPlayer(${jsString(p.id)})" class="text-slate-500 hover:text-white p-1"><i data-lucide="edit-3" class="w-3.5 h-3.5"></i></button>
                        <button onclick="deletePlayer(${jsString(p.id)})" class="text-slate-500 hover:text-rose-400 p-1"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
                      </span>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>`}
        </div>
      </div>`;
  }).join('');
}

/* ---------------------------------------------------------------
 * 6. STATS BANNER
 * --------------------------------------------------------------- */
function renderStatsBanner() {
  const finished = visibleMatches().filter(m => m.status === 'FINISHED');
  const totalGoals = finished.reduce((sum, m) => sum + toInt(m.homeScore) + toInt(m.awayScore), 0);

  document.getElementById('stat-teams-count').textContent = appState.teams.length;
  document.getElementById('stat-matches-played').textContent = finished.length;
  document.getElementById('stat-total-goals').textContent = totalGoals;

  const scorers = appState.players.slice().sort((a, b) => toInt(b.goals) - toInt(a.goals));
  document.getElementById('stat-top-scorer').textContent =
    scorers.length && toInt(scorers[0].goals) > 0 ? `${scorers[0].name} (${toInt(scorers[0].goals)})` : '--';
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

  if (matchId) {
    const existing = appState.matches.find(m => m.id === matchId);
    if (!existing) return;
    if (appState.seasonsReady && existing.seasonId !== appState.activeSeasonId) {
      alert(t('alertArchiveReadOnly'));
      return;
    }
  }

  if (appState.teams.length < 2) {
    alert(t('alertMinTeams'));
    openTeamModal();
    return;
  }

  const homeSelect = document.getElementById('match-home-team');
  const awaySelect = document.getElementById('match-away-team');
  const teamOptions = appState.teams.map(team => `<option value="${esc(team.id)}">${esc(team.name)}</option>`).join('');
  homeSelect.innerHTML = teamOptions;
  awaySelect.innerHTML = teamOptions;

  document.getElementById('form-match').reset();
  document.getElementById('match-id').value = '';

  // Sensible defaults for a new fixture
  const nextRound = activeMatches().reduce((max, m) => Math.max(max, toInt(m.round)), 0) + 1;
  document.getElementById('match-round').value = Math.max(1, nextRound);
  document.getElementById('match-status').value = 'SCHEDULED';
  document.getElementById('match-home-score').value = 0;
  document.getElementById('match-away-score').value = 0;
  document.getElementById('match-datetime').value = new Date().toISOString().slice(0, 16);
  awaySelect.selectedIndex = Math.min(1, appState.teams.length - 1);

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
  title.textContent = team ? team.name : '';

  if (!team || !players.length) {
    list.innerHTML = `<p class="text-[11px] text-slate-500 py-1">${esc(t('noPlayersFound'))}</p>`;
    return;
  }

  const events = matchEventDraft.filter(event => event.teamId === teamId);
  if (!events.length) {
    list.innerHTML = `<p class="text-[11px] text-slate-500 py-1">${esc(t('noMatchEvents'))}</p>`;
    return;
  }

  list.innerHTML = events.map(event => {
    const knownPlayer = players.some(player => player.id === event.playerId);
    const options = (knownPlayer ? '' : `<option value="">${esc(t('unknownPlayer'))}</option>`) +
      players.map(player => `<option value="${esc(player.id)}" ${player.id === event.playerId ? 'selected' : ''}>${esc(`#${player.num} ${player.name}`)}</option>`).join('');

    return `<div class="flex flex-col gap-1.5 rounded-lg border border-slate-700/60 bg-slate-900/50 p-2">
      <select onchange="updateMatchEvent(${jsString(event.id)}, 'playerId', this.value)" aria-label="${esc(t('thPlayer'))}" class="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-white focus:border-pitch-500">
        ${options}
      </select>
      <div class="flex items-center gap-1.5">
        <select onchange="updateMatchEvent(${jsString(event.id)}, 'type', this.value)" aria-label="${esc(t('lblMatchEvents'))}" class="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-white focus:border-pitch-500">
          <option value="goal" ${event.type === 'goal' ? 'selected' : ''}>${esc(t('eventGoal'))}</option>
          <option value="yellow" ${event.type === 'yellow' ? 'selected' : ''}>${esc(t('eventYellow'))}</option>
          <option value="red" ${event.type === 'red' ? 'selected' : ''}>${esc(t('eventRed'))}</option>
        </select>
        <input type="number" min="1" max="130" value="${esc(event.minute)}" oninput="updateMatchEvent(${jsString(event.id)}, 'minute', this.value)" aria-label="${esc(t('lblMinute'))}" class="w-14 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-white text-center focus:border-pitch-500">
        <span class="text-[10px] text-slate-500">'</span>
        <button type="button" onclick="removeMatchEvent(${jsString(event.id)})" aria-label="${esc(t('btnRemove'))}" class="ml-auto rtl:ml-0 rtl:mr-auto w-6 h-6 rounded text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 text-base leading-none">&times;</button>
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
function openTeamModal() {
  document.getElementById('form-team').reset();
  document.getElementById('team-id').value = '';
  document.getElementById('team-color').value = '#16a34a';
  document.getElementById('team-modal-title').textContent = t('modalTeamTitle');
  openModal('modal-team');
}

function editTeam(teamId) {
  const team = getTeam(teamId);
  if (!team) return;

  document.getElementById('form-team').reset();
  document.getElementById('team-id').value = team.id;
  document.getElementById('team-name').value = team.name;
  document.getElementById('team-code').value = team.code || '';
  document.getElementById('team-color').value = team.color || '#16a34a';
  document.getElementById('team-modal-title').textContent = t('modalTeamEditTitle');
  openModal('modal-team');
}

async function saveTeam(e) {
  e.preventDefault();
  const id = document.getElementById('team-id').value;
  const teamData = {
    id: id || uid('t'),
    name: document.getElementById('team-name').value.trim(),
    code: document.getElementById('team-code').value.trim().toUpperCase(),
    color: document.getElementById('team-color').value
  };

  if (!teamData.name) {
    alert(t('alertNameRequired'));
    return;
  }

  try {
    await dbSaveTeam(teamData);
    closeModal('modal-team');
    await refreshData();
    renderApp();
  } catch (err) {
    alert(t('alertSaveFailed'));
  }
}

async function deleteTeam(teamId) {
  const fixtureCount = appState.matches.filter(m => m.homeId === teamId || m.awayId === teamId).length;
  if (!confirm(t(fixtureCount ? 'confirmDeleteTeamHistory' : 'confirmDeleteTeam'))) return;
  try {
    // Players and matches are removed by ON DELETE CASCADE in Postgres.
    // With seasons enabled this also removes the club's archived fixtures.
    await dbDeleteTeam(teamId);
    await refreshData();
    renderApp();
  } catch (err) {
    alert(t('alertSaveFailed'));
  }
}

/* ---------------------------------------------------------------
 * 9. PLAYER MODAL (add / edit / delete)
 * --------------------------------------------------------------- */
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

  const existing = id ? appState.players.find(player => player.id === id) : null;
  if (existing && existing.teamId !== playerData.teamId &&
      (appState.matchEvents || []).some(event => event.playerId === id)) {
    alert(t('alertPlayerTransferEvents'));
    return;
  }

  try {
    await dbSavePlayer(playerData);
    closeModal('modal-player');
    await refreshData();
    renderApp();
  } catch (err) {
    alert(t('alertSaveFailed'));
  }
}

async function deletePlayer(playerId) {
  const hasEvents = (appState.matchEvents || []).some(event => event.playerId === playerId);
  if (!confirm(t(hasEvents ? 'confirmDeletePlayerEvents' : 'confirmDeletePlayer'))) return;
  try {
    await dbDeletePlayer(playerId);
    await refreshData();
    renderApp();
  } catch (err) {
    alert(t('alertSaveFailed'));
  }
}

/* ---------------------------------------------------------------
 * 9b. SEASONS (create, switch, reactivate)
 * --------------------------------------------------------------- */
function openSeasonModal() {
  if (!appState.seasonsReady) return;
  if (typeof isAdmin !== 'function' || !isAdmin()) return;
  if (!BACKEND_READY) {
    alert(t('authConfigMissing'));
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
function openGuideModal() {
  openModal('modal-guide');
}

function toggleDataMenu(e) {
  if (e) e.stopPropagation();
  document.getElementById('data-menu').classList.toggle('hidden');
}

// Close the settings dropdown when clicking anywhere else
document.addEventListener('click', function (e) {
  const menu = document.getElementById('data-menu');
  if (!menu.classList.contains('hidden') && !menu.contains(e.target)) {
    menu.classList.add('hidden');
  }
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

function csvEscape(value) {
  let text = String(value == null ? '' : value);
  // Stop spreadsheet formula execution when an exported cell begins with a
  // formula marker. Numeric values are left untouched so negative scores stay numeric.
  if (typeof value === 'string' && /^[=+\-@\t\r\n]/.test(text)) {
    text = "'" + text;
  }
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

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
      row.team.name,
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
  const teamName = id => (getTeam(id) || {}).name || id;
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
  const teamName = id => (getTeam(id) || {}).name || id;
  const players = appState.players.slice().sort((a, b) =>
    teamName(a.teamId).localeCompare(teamName(b.teamId)) || (a.num || 0) - (b.num || 0)
  );

  return [
    [t('seasonLabel'), t('csvTeam'), t('thPlayer'), t('lblPosition'), t('lblJerseyNum'), t('lblGoals'), t('lblYellowCards'), t('lblRedCards')],
    ...players.map(player => [
      seasonName,
      teamName(player.teamId),
      player.name,
      player.pos,
      player.num,
      player.goals,
      player.yellow,
      player.red
    ])
  ];
}

function exportSquadsCsv() {
  downloadCsv(`kickoff_squads_${csvSeasonSuffix()}.csv`, buildSquadsCsvRows());
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

function importData(event) {
  const file = event.target.files[0];
  event.target.value = ''; // allow re-importing the same file
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async function (e) {
    try {
      const imported = validateImport(JSON.parse(e.target.result));
      if (!imported) throw new Error('Invalid schema');
      if ((imported.matchEvents || []).length && !appState.eventsReady) {
        alert(t('matchEventsImportBlocked'));
        return;
      }

      await dbReplaceAll(imported);
      await refreshData();
      renderApp();
    } catch (err) {
      alert(t('alertImportError'));
    }
  };
  reader.readAsText(file);
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
 * 11. INITIALIZATION
 * --------------------------------------------------------------- */
window.addEventListener('DOMContentLoaded', async function () {
  applyLanguage();
  switchTab('standings');
  renderApp();

  initBackend();

  if (!BACKEND_READY) {
    // Configuration missing, malformed, or the Supabase CDN failed to load.
    console.warn('KickOff Division: running in read-only demo mode (Supabase not configured).');
  } else {
    try {
      await refreshData();
      hideDataError();
    } catch (err) {
      showDataError(err);
    }
    renderApp();
  }

  await initAuth();
});
