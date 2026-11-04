# Privacy and retention policy

**Status:** adopted 2026-11-04 (task J, plan section 22.11).
**Owner:** the league maintainer.
**Review:** every 12 months, or before a new personal-data feature ships (player photos, youth
leagues, public accounts).

This document explains what Mzab League stores, what it publishes, how long it keeps it, and how a
player, parent or account holder can ask for a correction or removal. It describes the application
as built; it is not legal advice. The league should confirm the applicable rules with its own
adviser, in particular Algeria's Law 18-07 and the GDPR if it has visitors in the European Union.

## 1. Roles

- The **league maintainer** decides what is published and is the contact for requests.
- **Supabase** hosts the database and authentication; **GitHub** hosts the static site and the
  scheduled backup. They are processors, not owners of the data.
- **Club officials and admins** enter squads, results and optional player details.

## 2. What is public

Anyone can read the league's public views and tables:

| Data | Examples | Why it is public |
|---|---|---|
| Club identity | club name (Latin and optional Arabic), crest | The league table is the product |
| Player identity | player name (Latin required, Arabic optional), shirt number, position, club, active/archived flag | Identifies who scored or was booked |
| Match data | fixtures, dates, venues, scores, status | Public results |
| Match events | goal, assist, yellow/red card, minute | Explains the score and the player totals |
| Season data | season name, divisions, archived tables | History |

The public player table does **not** contain a licence number, birth date, address, phone number,
email or photo. Player photos are not implemented.

## 3. What is admin-only

These values are protected by row-level security and by table grants; anonymous visitors and
ordinary signed-in users cannot read them:

- `player_profiles.license_id` (licence number) and `player_profiles.birth_date` (birth date),
  readable and writable only by an admin.
- `profiles.email` (the sign-in address of an admin, scorer or viewer), visible to that account and
  to admins.
- `audit_log.actor_email` and the rest of the activity log, visible to admins.
- Match official assignments (`match_officials`), visible to the assigned scorer and to admins.

Admin-only values are included in the encrypted backup because a restore must reproduce the
database exactly.

## 4. Browser storage and cookies

The app sets no advertising or analytics cookies and loads no third-party script.

| Key | Where | Purpose | Lifetime |
|---|---|---|---|
| `kickoff_lang` | `localStorage` | Remembers the chosen language (EN/FR/AR) | Until the visitor clears it |
| Supabase session | `localStorage` | Keeps an admin or scorer signed in | Until sign-out or token expiry |

"Follow a team" is also kept on the device only. Follower lists are never written to the database.

## 5. Retention

| Data | Where | Retention | Who can purge |
|---|---|---|---|
| Active season: clubs, players, fixtures, events | Supabase | While the league runs | Maintainer |
| Archived seasons and results | Supabase | Kept indefinitely as league history | Maintainer |
| Trash: soft-deleted seasons, clubs and fixtures (`deleted_at`) | Supabase | 90 days, then purge | Maintainer (SQL) |
| Archived players (`is_active = false`) | Supabase | Kept with their history; anonymised on request | Maintainer |
| `player_profiles` (licence, birth date) | Supabase | While the player exists; deleted with the player | Maintainer |
| Audit log (hash-chained) | Supabase | Kept indefinitely; deleting a row breaks `audit_verify_chain()` | Maintainer (archive the whole chain, then start a new one) |
| Encrypted backup `backup.kob` | GitHub Actions artifacts | 90 days (`retention-days: 90`) | GitHub repository admin |
| Off-site backup copy | Maintainer's storage | 12 months recommended | Maintainer |
| Sign-in accounts (`auth.users`, `profiles`) | Supabase | While the account exists; deleting the user cascades to `profiles` | Maintainer |
| GitHub Actions logs | GitHub | 90 days (public-repository default) | GitHub repository admin |

The trash and the backup artifacts are the only automatic limits. Everything else is purged by the
maintainer with a reviewed SQL statement, never by a visitor.

## 6. Correction and removal

A player, parent or account holder asks the league maintainer through the contact address published
with the league. The target response time is 30 days.

- **Wrong public detail** (name spelling, shirt number, club): an admin edits it. Results do not
  change.
- **Removal of a player with match history:** the row is **anonymised**, not deleted. The name
  becomes `Player <shirt number>`, the Arabic name is cleared, the player is archived
  (`is_active = false`) and the admin-only `player_profiles` row is deleted. Goals, cards and
  results stay correct because the events still point at the row.
- **Removal of a player with no match history:** an admin may hard-delete the row.
- **Account removal:** the maintainer deletes the auth user; `profiles` and `match_officials` rows
  cascade.
- **A public issue is not a private channel.** Do not put names, birth dates, licence numbers or
  contact details in a GitHub issue. Use the league's private contact address.

A dedicated in-app "Privacy" link and a published contact address are follow-ups; until they exist,
the league's usual communication channel is the contact point.

## 7. Youth and school leagues

The league currently runs senior teams. If a youth or school competition is added:

- publish initials, or a first name plus a surname initial, instead of a full name;
- do not publish a birth date or a photo;
- record guardian consent before the first fixture is published;
- treat the whole competition as higher risk and review this policy before it starts.

## 8. Security measures that support this policy

- Row-level security and a grant layer that refuses every anonymous write.
- Admin-only tables for the most sensitive fields, with no anonymous `SELECT` grant.
- A hash-chained, append-only audit log that makes a silent rewrite visible.
- An encrypted daily backup whose contents are validated and restored in a drill.
- A strict content-security policy with no third-party script or analytics origin.

## 9. Requests and complaints

Send a correction or removal request to the maintainer's published contact address. Include the
club, the player's shirt number and the change requested; do not send a birth date or licence number
by email unless the maintainer asks for it to verify identity. If the answer is unsatisfactory, the
requester may contact the local data-protection authority.
