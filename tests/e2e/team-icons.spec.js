'use strict';

/*
 * Task I (first half): each club can have a crest, stored inline as a data URL.
 *
 * The REST calls are answered locally, so this runs without a hosted project
 * and without the task I migration being applied. It proves that:
 *   * a stored crest is rendered in the standings, the fixture card and the
 *     team dialog, while a club without one keeps the old colour marker;
 *   * the file picker re-encodes a real PNG in the browser, refuses SVG by
 *     type and refuses a mislabelled SVG that cannot be decoded;
 *   * only a data URL is ever used as an image source (no external host), and
 *     the strict CSP is unchanged.
 */

const { test, expect } = require('@playwright/test');

// A real 64x64 RGBA PNG (a filled circle), the same one in data/examples.
const PNG_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAvElEQVR42u3bsRHCMBBEUVdBUbRJoUtIwjAYJFknveDHnnmZ7dvj9rgfOzfyYTlZeYA0rgxAOjctQAY3DUAu7jKATNZQgEzaEIBMXleAFKkLQIrVFCBFawKQ4v0FkEX6CSCLBeAMQBYNwDcAWTwAnwCySQDeAWSzAAAA8ALIpgEAAAAAAAAAAAAAsDuAt0EAAAD4KgzAjxEAfo4CcCABwJGUMzmHkk5lHUs7lzeYMJkxmjKbM5w0nTWeXr0nmIz1xrmkf+AAAAAASUVORK5CYII=';

const TEAMS = [
  {
    id: 't1', name: 'Spartan FC', name_ar: null, icon: PNG_ICON,
    code: 'SFC', color: '#3b82f6', division_id: 'd1'
  },
  {
    id: 't2', name: 'Titan United', name_ar: null, icon: null,
    code: 'TTN', color: '#10b981', division_id: 'd1'
  }
];

const PLAYERS = [
  {
    id: 'p1', team_id: 't1', name: 'David Silva', name_ar: null, pos: 'MID', num: 10,
    legacy_goals: 1, legacy_yellow: 0, legacy_red: 0, is_active: true
  }
];

const DERIVED = PLAYERS.map(player => ({
  player_id: player.id,
  team_id: player.team_id,
  name: player.name,
  name_ar: player.name_ar,
  pos: player.pos,
  num: player.num,
  is_active: true,
  legacy_goals: player.legacy_goals,
  legacy_yellow: 0,
  legacy_red: 0,
  event_goals: 0,
  event_yellow: 0,
  event_red: 0,
  goals: player.legacy_goals,
  yellow: 0,
  red: 0,
  division_id: 'd1'
}));

const DIVISIONS = [
  { id: 'd1', name: 'Division 1', sort_order: 1 },
  { id: 'd2', name: 'Division 2', sort_order: 2 }
];

const SEASONS = [
  {
    id: 's1', name: '2026 Season', start_date: '2026-08-01', end_date: '2027-05-31',
    is_active: true, created_at: '2026-08-01T00:00:00.000Z'
  }
];

const MATCHES = [
  {
    id: 'm1', season_id: 's1', division_id: 'd1', round: 1, home_id: 't1', away_id: 't2',
    home_score: 1, away_score: 0, status: 'FINISHED', datetime: '2026-10-03T15:00',
    venue: '', scorers_text: '', events_counted: true
  }
];

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'apikey, authorization, content-type, prefer, range, x-client-info, accept-profile, content-profile',
  'access-control-expose-headers': 'content-range, content-profile',
  'access-control-max-age': '600'
};

function jsonHeaders(extra) {
  return { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra };
}

async function mockData(page, tables) {
  await page.route('**/rest/v1/**', async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }

    const url = new URL(request.url());
    const table = url.pathname.split('/rest/v1/')[1] || '';
    const rows = tables[table];
    if (!rows) {
      await route.fulfill({
        status: 404,
        headers: jsonHeaders(),
        body: JSON.stringify({
          code: 'PGRST205',
          details: null,
          hint: null,
          message: `Could not find the table 'public.${table}' in the schema cache`
        })
      });
      return;
    }

    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 1000);
    const slice = rows.slice(offset, offset + limit);
    const range = slice.length
      ? `${offset}-${offset + slice.length - 1}/${rows.length}`
      : `*/${rows.length}`;

    await route.fulfill({
      status: 200,
      headers: jsonHeaders({ 'content-range': range }),
      body: JSON.stringify(slice)
    });
  });

  await page.route('**/auth/v1/settings', route =>
    route.fulfill({
      status: 200,
      headers: jsonHeaders(),
      body: JSON.stringify({ disable_signup: true, external: {} })
    })
  );
}

test('a team crest renders inline, the fallback stays, and uploads are re-encoded', async ({ page }) => {
  const consoleErrors = [];
  const externalRequests = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', request => {
    if (request.resourceType() !== 'image') return;
    const url = request.url();
    if (/^https?:/i.test(url) && !url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
      externalRequests.push(url);
    }
  });

  await mockData(page, {
    teams: TEAMS,
    players: PLAYERS,
    seasons: SEASONS,
    matches: MATCHES,
    match_events: [],
    v_player_stats: DERIVED,
    divisions: DIVISIONS
  });

  await page.goto('/?env=dev');
  await expect(page.locator('#standings-table-body tr').first()).toBeVisible();
  await expect(page.locator('#data-error')).toBeHidden();

  // The crest is an inline image; the club without one keeps the colour dot.
  const spartanRow = page.locator('#standings-table-body tr', { hasText: 'Spartan FC' });
  const crest = spartanRow.locator('img');
  await expect(crest).toHaveAttribute('src', PNG_ICON);
  const naturalWidth = await crest.evaluate(async img => {
    await img.decode();
    return img.naturalWidth;
  });
  expect(naturalWidth).toBe(64);

  const titanRow = page.locator('#standings-table-body tr', { hasText: 'Titan United' });
  await expect(titanRow.locator('img')).toHaveCount(0);

  // Fixture cards use the same crest and fall back to the code circle.
  await page.locator('#nav-fixtures').click();
  await expect(page.locator('#view-fixtures')).toBeVisible();
  const fixture = page.locator('#fixtures-container > div').first();
  await expect(fixture.locator('img')).toHaveAttribute('src', PNG_ICON);
  await expect(fixture).toContainText('TTN');

  // The team dialog previews the stored crest and clears it again.
  await page.evaluate(() => editTeam('t1'));
  await expect(page.locator('#modal-team')).toBeVisible();
  await expect(page.locator('#team-icon-preview img')).toHaveAttribute('src', PNG_ICON);
  await page.locator('#team-icon-remove').click();
  await expect(page.locator('#team-icon-preview img')).toHaveCount(0);
  await page.evaluate(() => closeModal('modal-team'));

  // A real PNG is re-encoded to a small data URL in the browser.
  const prepared = await page.evaluate(async base64 => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], 'crest.png', { type: 'image/png' });
    const dataUrl = await prepareTeamIcon(file);
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    return {
      prefix: dataUrl.slice(0, 16),
      length: dataUrl.length,
      width: image.naturalWidth,
      height: image.naturalHeight
    };
  }, PNG_ICON.replace(/^data:image\/png;base64,/, ''));
  expect(prepared.prefix).toMatch(/^data:image\/(webp|png)/);
  expect(prepared.length).toBeLessThan(100000);
  expect(prepared.width).toBe(128);
  expect(prepared.height).toBe(128);

  // SVG is refused by type, and a mislabelled SVG fails to decode.
  const rejected = await page.evaluate(async () => {
    const catchCode = async file => {
      try {
        await prepareTeamIcon(file);
        return 'accepted';
      } catch (err) {
        return err && err.code ? err.code : 'unknown';
      }
    };
    return {
      svg: await catchCode(new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], 'crest.svg', { type: 'image/svg+xml' })),
      mislabelled: await catchCode(new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], 'crest.png', { type: 'image/png' })),
      external: teamIconSrc({ icon: 'https://example.com/crest.png' })
    };
  });
  expect(rejected.svg).toBe('type');
  expect(rejected.mislabelled).toBe('decode');
  expect(rejected.external).toBe('');

  // The admin JSON payload carries the crest; the CSP still has no image host.
  const payload = await page.evaluate(() =>
    buildAtomicImportPayload(appState).teams.find(team => team.id === 't1').icon
  );
  expect(payload).toBe(PNG_ICON);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("img-src 'self' data:");
  expect(csp).not.toContain('img-src *');

  // No image ever went to an external host.
  expect(externalRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
