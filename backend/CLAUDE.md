# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CDBHS Tournament Management backend - a French billiards (Comité Départemental de Billard des Hauts-de-Seine) tournament ranking system. Manages player registrations, tournament results, rankings across 13 categories, and email communications.

**Related App:** Player App (Espace Joueur) in separate repo `cdbhs-player-app` - shares the same database.

## Commands

```bash
# Install dependencies
npm install

# Start production server
npm start

# Start development server with hot reload
npm run dev

# Backup SQLite database (local only)
npm run backup
```

## Architecture

### Database Layer
- **db-loader.js**: Auto-selects database based on `DATABASE_URL` env var
  - With `DATABASE_URL`: Uses PostgreSQL (`db-postgres.js`) - production on Railway
  - Without: Uses SQLite (`db.js`) - local development, stores in `../database/billard.db`
- Both database modules expose the same interface with `db.run()`, `db.get()`, `db.all()` methods
- PostgreSQL uses `$1, $2...` placeholders; SQLite compatibility layer handles this

### Server (server.js)
- Express server with Helmet security, CORS, rate limiting
- Mounts all API routes under `/api/*`
- Contains email scheduler logic (runs every 5 minutes) and tournament alert system (hourly)
- Auto-syncs contacts on startup via `routes/emailing.syncContacts()`

### Route Modules (routes/)
| Route | Purpose |
|-------|---------|
| `auth.js` | JWT authentication, password reset with 6-digit codes, user management |
| `tournaments.js` | CSV import of tournament results, category management |
| `inscriptions.js` | Player registrations (dual source: IONOS CSV + Player App), convocation management |
| `email.js` | Convocation emails, tournament results emails via Resend API, `/save-poules` endpoint |
| `emailing.js` | Mass emailing campaigns, scheduled emails, contact sync |
| `announcements.js` | Global announcements for Player App (CRUD + public `/active` endpoint) |
| `player-accounts.js` | Player App (Espace Joueur) account management |
| `player-invitations.js` | Invitation emails for Player App registration with PDF attachments |
| `rankings.js` | Season rankings calculation across categories |
| `clubs.js` | Club management with aliases for name normalization |
| `statistics.js` | Player and tournament statistics |

### Key Database Tables
- `players`: FFB-licensed players with rankings in 4 disciplines (Libre, Cadre, Bande, 3 Bandes)
- `categories`: 13 competition categories by game type and level
- `tournaments` / `tournament_results`: Internal tournament tracking (T1, T2, T3 per category)
- `tournoi_ext` / `inscriptions`: External tournament definitions and player registrations
  - `inscriptions.source`: `'ionos'` (CSV import), `'player_app'` (self-registration), or `'manual'` (admin via Ajouter button)
  - Unique constraint on `(normalized_licence, tournoi_id)` prevents duplicate registrations
  - IONOS import handles ID collisions: if inscription_id already used by protected source, generates new sequential ID
  - **IONOS will be decommissioned next year** - Player App will become sole source, allowing major code simplification
- `convocation_poules`: Stores full poule composition when convocations are sent
  - Shared with Player App so players can view all poules for their tournament
  - Columns: `tournoi_id`, `poule_number`, `licence`, `player_name`, `club`, `location_name`, `location_address`, `start_time`, `player_order`
- `player_accounts`: Separate auth for Player App with `player_app_role` (joueur/admin)
- `player_invitations`: Tracks invitation emails sent to players for Player App registration
  - Links to `player_contacts` table, stores sent_at, sent_by, has_signed_up status
  - Supports resend tracking with `resend_count` and `last_resent_at`
  - Syncs `has_signed_up` by comparing licences with `player_accounts` table
- `announcements`: Global notifications displayed in Player App (title, message, type, expiry)
- `email_campaigns` / `scheduled_emails`: Email tracking and scheduling

### Authentication
- Admin dashboard: JWT tokens via `routes/auth.js`, requires `JWT_SECRET` env var
- Player App: Separate `player_accounts` table with bcrypt passwords
- Middleware: `authenticateToken` from `routes/auth.js` for protected routes

### Email System
- Uses Resend API (`RESEND_API_KEY` env var)
- From addresses: `communication@cdbhs.net`, `convocations@cdbhs.net`
- Templates support variables: `{player_name}`, `{first_name}`, `{club}`, `{category}`, etc.
- Scheduled emails processed by `processScheduledEmails()` in server.js
- **CRITICAL - Variable ordering in email routes:** When modifying email routes in `emailing.js` or `email.js`, always define `primaryColor`, `senderName`, `emailFrom` and other settings variables BEFORE using them in helper functions like `buildContactPhraseHtml(contactEmail, primaryColor)`. The async `appSettings.getSetting()` calls must complete before their values are used. This bug has caused email failures multiple times - always verify variable declaration order when touching email code.

## Environment Variables

Required:
- `JWT_SECRET`: Secret for JWT signing (no fallback in production)
- `DATABASE_URL`: PostgreSQL connection string (Railway provides this)
- `RESEND_API_KEY`: For email sending

Optional:
- `PORT`: Server port (default 3000)
- `ALLOWED_ORIGINS`: Comma-separated CORS origins
- `BASE_URL`: For email links (default Railway URL)

## Development Notes

- All dates handled in Paris timezone for scheduling
- Season format: `YYYY-YYYY+1` (e.g., "2024-2025"), determined by September cutoff
- Licence numbers are normalized by removing spaces for comparisons
- CSV files use semicolon delimiter, imported via multer
- **Test data exclusion:** ALWAYS exclude test accounts from counts, lists, and statistics. Test accounts have licences starting with "TEST" (case-insensitive). Use `WHERE UPPER(licence) NOT LIKE 'TEST%'` in queries.
- **No hardcoding reference data:** NEVER hardcode values like game modes, FFB rankings, clubs, or categories. Always load them dynamically from the reference tables (`game_modes`, `ffb_rankings`, `clubs`, `categories`).

## Future Cleanup (2025-2026 Season)

When IONOS is fully deprecated, the following can be removed for maintainability:
- `routes/inscriptions.js`: Remove `/import` endpoint and CSV parsing logic (~300 lines)
- `source` column handling and conflict resolution logic
- ID collision detection and generation code
- Import history tracking (`import_history` table)
- Frontend IONOS import UI components
- Related documentation and error handling

### Hidden Settings Sections (to be deleted)
The following sections in `frontend/settings-admin.html` are hidden and should be fully removed:
- **"Correspondances de catégories IONOS"** (`#categoryMappingsSection`) - IONOS category mappings, no longer needed
- **"Alias des Clubs"** (`#clubAliasesSection`) - Club name aliases, player data now standardized
- Also remove related backend routes in `routes/clubs.js` (alias endpoints) and `category_mappings` table
