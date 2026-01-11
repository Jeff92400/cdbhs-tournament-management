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
| `email.js` | Convocation emails, tournament results emails via Resend API |
| `emailing.js` | Mass emailing campaigns, scheduled emails, contact sync |
| `player-accounts.js` | Player App (Espace Joueur) account management |
| `rankings.js` | Season rankings calculation across categories |
| `clubs.js` | Club management with aliases for name normalization |
| `statistics.js` | Player and tournament statistics |

### Key Database Tables
- `players`: FFB-licensed players with rankings in 4 disciplines (Libre, Cadre, Bande, 3 Bandes)
- `categories`: 13 competition categories by game type and level
- `tournaments` / `tournament_results`: Internal tournament tracking (T1, T2, T3 per category)
- `tournoi_ext` / `inscriptions`: External tournament definitions and player registrations
  - `inscriptions.source`: `'ionos'` (CSV import) or `'player_app'` (self-registration)
  - Unique constraint on `(normalized_licence, tournoi_id)` prevents duplicate registrations
  - IONOS will be decommissioned; Player App will become sole source
- `player_accounts`: Separate auth for Player App with `player_app_role` (joueur/admin)
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
