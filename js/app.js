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
  ['modal-match', 'modal-team', 'modal-player', 'modal-guide', 'modal-password', 'modal-login'].forEach(id => closeModal(id));
}

/* ---------- loading / error banners ---------- */

function showDataError() {
  const banner = document.getElementById('data-error');
  if (banner) banner.classList.remove('hidden');
}

function hideDataError() {
  const banner = document.getElementById('data-error');
  if (banner) banner.classList.add('hidden');
}

async function retryLoad() {
  try {
    await refreshData();
    hideDataError();
    renderApp();
  } catch (e) {
    showDataError();
  }
}

/* ---------------------------------------------------------------
 * 2. MAIN RENDERER & TAB NAVIGATION
 * --------------------------------------------------------------- */
function renderApp() {
  renderStandings();
  renderFixtureFilters();
  renderFixtures();
  renderTeamsView();
  renderStatsBanner();
  lucide.createIcons();
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
  appState.teams.forEach(team => {
    stats[team.id] = {
      team,
      mp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0,
      form: []
    };
  });

  // Only finished matches count towards the table
  const finished = appState.matches
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
    tbody.innerHTML = `<tr><td colspan="11" class="py-8 text-center text-slate-500">${esc(t('noTeamsFound'))}</td></tr>`;
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
            <span class="text-[10px] text-slate-500 font-normal uppercase hidden sm:inline">(${esc(s.team.code)})</span>
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
 * 4. FIXTURES & RESULTS (filters, cards, live score updates)
 * --------------------------------------------------------------- */
function renderFixtureFilters() {
  const select = document.getElementById('filter-round');
  const previous = select.value || 'ALL';

  const rounds = [...new Set(appState.matches.map(m => m.round))]
    .sort((a, b) => a - b);

  select.innerHTML = `<option value="ALL">${esc(t('optAllMatchdays'))}</option>` +
    rounds.map(r => `<option value="${r}">${esc(t('matchdayPrefix'))} ${r}</option>`).join('');

  select.value = rounds.map(String).includes(previous) ? previous : 'ALL';
}

function renderFixtures() {
  const container = document.getElementById('fixtures-container');
  const roundFilter = document.getElementById('filter-round').value;
  const statusFilter = document.getElementById('filter-status').value;

  let matches = appState.matches.slice();
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
      ? `<span class="text-xs font-bold text-slate-500 bg-slate-900 px-2 py-1 rounded">${esc(t('lblVs'))}</span>`
      : `<span class="text-xl font-extrabold text-white tracking-wider bg-slate-900/80 px-2.5 py-1 rounded border border-slate-700">${toInt(m.homeScore)} - ${toInt(m.awayScore)}</span>`;

    // Live matches get quick +1 steppers for instant live score logging
    const liveSteppers = m.status === 'LIVE' ? `
      <div class="admin-only flex items-center justify-center gap-3 mt-1.5">
        <button onclick="bumpScore('${esc(m.id)}','home',1)" class="w-6 h-6 rounded bg-pitch-600/80 hover:bg-pitch-500 text-white text-xs font-bold transition" title="+1">+</button>
        <button onclick="bumpScore('${esc(m.id)}','away',1)" class="w-6 h-6 rounded bg-pitch-600/80 hover:bg-pitch-500 text-white text-xs font-bold transition" title="+1">+</button>
      </div>` : '';

    const scorers = m.scorersText ? `
      <div class="mt-2 pt-2 border-t border-slate-700/40 text-[11px] text-slate-400 flex items-center gap-1.5">
        <i data-lucide="activity" class="w-3.5 h-3.5 text-pitch-400 shrink-0"></i>
        <span class="truncate">${esc(m.scorersText)}</span>
      </div>` : '';

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
            <span class="w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs text-white mb-1 shadow" style="background-color:${esc(home.color || '#334155')}">${esc(home.code || 'H')}</span>
            <span class="font-semibold text-sm text-white truncate max-w-full">${esc(home.name)}</span>
          </div>
          <div class="col-span-1 flex flex-col items-center justify-center">
            ${scoreBlock}
            ${liveSteppers}
          </div>
          <div class="col-span-3 flex flex-col items-center">
            <span class="w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs text-white mb-1 shadow" style="background-color:${esc(away.color || '#334155')}">${esc(away.code || 'A')}</span>
            <span class="font-semibold text-sm text-white truncate max-w-full">${esc(away.name)}</span>
          </div>
        </div>

        ${scorers}

        <div class="admin-only mt-3 pt-2 border-t border-slate-700/50 flex justify-end gap-2">
          <button onclick="editMatch('${esc(m.id)}')" class="px-2.5 py-1 text-slate-300 hover:text-white bg-slate-700/50 hover:bg-slate-700 rounded text-xs flex items-center gap-1 transition">
            <i data-lucide="edit-3" class="w-3 h-3"></i> ${esc(t('editAction'))}
          </button>
          <button onclick="deleteMatch('${esc(m.id)}')" class="px-2 py-1 text-rose-400 hover:bg-rose-500/20 rounded text-xs transition">
            <i data-lucide="trash-2" class="w-3 h-3"></i>
          </button>
        </div>
      </div>`;
  }).join('');
}

/** Quick live-score update from fixture cards (used for LIVE matches). */
async function bumpScore(matchId, side, delta) {
  const match = appState.matches.find(m => m.id === matchId);
  if (!match) return;

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
            <button onclick="openPlayerModal('${esc(team.id)}')" class="px-2.5 py-1.5 bg-pitch-600/20 text-pitch-400 hover:bg-pitch-600/30 border border-pitch-500/30 rounded-lg text-xs font-medium flex items-center gap-1 transition">
              <i data-lucide="user-plus" class="w-3.5 h-3.5"></i> ${esc(t('btnAddPlayer'))}
            </button>
            <button onclick="editTeam('${esc(team.id)}')" class="p-1.5 text-slate-500 hover:text-white rounded transition">
              <i data-lucide="edit-3" class="w-4 h-4"></i>
            </button>
            <button onclick="deleteTeam('${esc(team.id)}')" class="p-1.5 text-slate-500 hover:text-rose-400 rounded transition">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        </div>

        <div class="p-3 flex-1 overflow-x-auto">
          ${squad.length === 0 ? `
            <p class="text-xs text-slate-500 text-center py-4">${esc(t('noPlayersFound'))}</p>
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
                        <button onclick="editPlayer('${esc(p.id)}')" class="text-slate-500 hover:text-white p-1"><i data-lucide="edit-3" class="w-3.5 h-3.5"></i></button>
                        <button onclick="deletePlayer('${esc(p.id)}')" class="text-slate-500 hover:text-rose-400 p-1"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
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
  const finished = appState.matches.filter(m => m.status === 'FINISHED');
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
  const nextRound = appState.matches.reduce((max, m) => Math.max(max, toInt(m.round)), 0) + 1;
  document.getElementById('match-round').value = Math.max(1, nextRound);
  document.getElementById('match-status').value = 'SCHEDULED';
  document.getElementById('match-home-score').value = 0;
  document.getElementById('match-away-score').value = 0;
  document.getElementById('match-datetime').value = new Date().toISOString().slice(0, 16);
  awaySelect.selectedIndex = Math.min(1, appState.teams.length - 1);

  document.getElementById('match-modal-title').textContent = t('modalMatchTitle');

  if (matchId) prefillMatchModal(matchId);
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

function editMatch(matchId) {
  openMatchModal(matchId);
}

async function saveMatch(e) {
  e.preventDefault();
  const id = document.getElementById('match-id').value;
  const homeId = document.getElementById('match-home-team').value;
  const awayId = document.getElementById('match-away-team').value;
  const round = toInt(document.getElementById('match-round').value, 1) || 1;

  if (homeId === awayId) {
    alert(t('alertSameTeam'));
    return;
  }

  // Prevent duplicate fixtures for the same matchday
  const duplicate = appState.matches.some(m =>
    m.id !== id && toInt(m.round) === round &&
    ((m.homeId === homeId && m.awayId === awayId) || (m.homeId === awayId && m.awayId === homeId))
  );
  if (duplicate) {
    alert(t('alertDuplicate'));
    return;
  }

  const matchData = {
    id: id || uid('m'),
    round,
    status: document.getElementById('match-status').value,
    datetime: document.getElementById('match-datetime').value,
    venue: document.getElementById('match-venue').value.trim(),
    homeId,
    awayId,
    homeScore: toInt(document.getElementById('match-home-score').value),
    awayScore: toInt(document.getElementById('match-away-score').value),
    scorersText: document.getElementById('match-scorers-text').value.trim()
  };

  try {
    await dbSaveMatch(matchData);
    closeModal('modal-match');
    await refreshData();
    renderApp();
  } catch (err) {
    alert(t('alertSaveFailed'));
  }
}

async function deleteMatch(matchId) {
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
  if (!confirm(t('confirmDeleteTeam'))) return;
  try {
    // Players and matches are removed by ON DELETE CASCADE in Postgres
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
  if (!confirm(t('confirmDeletePlayer'))) return;
  try {
    await dbDeletePlayer(playerId);
    await refreshData();
    renderApp();
  } catch (err) {
    alert(t('alertSaveFailed'));
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
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(appState, null, 2));
  const anchor = document.createElement('a');
  anchor.setAttribute('href', dataStr);
  anchor.setAttribute('download', `kickoff_division_backup_${new Date().toISOString().slice(0, 10)}.json`);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Validate an imported JSON payload before sending it to Postgres.
 * Returns a normalized copy, or null when the schema/relations are invalid.
 */
function validateImport(data) {
  if (!data || !Array.isArray(data.teams) || !Array.isArray(data.matches)) return null;

  const teams = data.teams;
  const players = Array.isArray(data.players) ? data.players : [];
  const matches = data.matches;
  const ids = new Set();

  for (const team of teams) {
    if (!team || typeof team.id !== 'string' || !team.id || typeof team.name !== 'string' || !team.name) return null;
    if (ids.has(team.id)) return null;
    ids.add(team.id);
  }

  for (const player of players) {
    if (!player || typeof player.id !== 'string' || !player.id) return null;
    if (!ids.has(player.teamId) || typeof player.name !== 'string' || !player.name) return null;
  }

  for (const match of matches) {
    if (!match || typeof match.id !== 'string' || !match.id) return null;
    if (!ids.has(match.homeId) || !ids.has(match.awayId) || match.homeId === match.awayId) return null;
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
      showDataError();
    }
    renderApp();
  }

  await initAuth();
});
