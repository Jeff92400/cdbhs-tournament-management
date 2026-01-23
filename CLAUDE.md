# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

**CDBHS Tournament Management System** - A French billiards tournament management application for the Comité Départemental de Billard des Hauts-de-Seine. Manages player registrations, tournament results, rankings across 13 categories, and email communications.

**Production URL:** https://cdbhs-tournament-management-production.up.railway.app
**Related App:** Player App (Espace Joueur) in separate repo `cdbhs-player-app` - shares the same PostgreSQL database

## Deployment Workflow

**We work directly in production.** No staging environment.

### Process
1. Work on `main` branch
2. Commit changes with descriptive message
3. **Update version number** in `frontend/login.html` (see Versioning below)
4. Push to deploy: `git push origin main` (auto-deploys to Railway)

## Versioning

**Current Version:** V 2.0.19 01/26

Version is displayed at the bottom of the login screen (`frontend/login.html`).

### Format
`V 2.0.xx mm/yy`
- `2.0` = Major.Minor version (increment minor for significant features)
- `xx` = Patch number (increment for each deployment)
- `mm/yy` = Month/Year of deployment

### Update Process
**IMPORTANT:** Increment the patch number (xx) with each deployment.
- Location: `frontend/login.html` - look for the version div near the bottom
- Example: `V 2.0.0 01/26` → `V 2.0.1 01/26` → `V 2.0.2 02/26`

## Commands

```bash
# Start development (from project root)
cd backend && npm install && npm start

# Or use the root package.json
npm run build   # Install backend dependencies
npm start       # Start server on port 3000
```

## Tech Stack

- **Backend:** Node.js 18+, Express.js, PostgreSQL (Railway)
- **Frontend:** Vanilla HTML/CSS/JS (no build process)
- **Email:** Resend API
- **Auth:** JWT + bcrypt
- **Deployment:** Railway with Nixpacks

## Architecture

```
cdbhs-tournament-management/
├── backend/
│   ├── server.js           # Express entry point, schedulers
│   ├── db-loader.js        # Auto-selects PostgreSQL/SQLite
│   ├── db-postgres.js      # PostgreSQL adapter (production)
│   ├── db.js               # SQLite adapter (local dev)
│   └── routes/             # API route modules
├── frontend/
│   ├── *.html              # Page files (dashboard, rankings, etc.)
│   ├── css/styles.css      # Single shared stylesheet
│   └── js/                 # Shared utilities (auth, clubs)
└── database/               # Local SQLite storage (dev only)
```

## Key Routes (backend/routes/)

| Route | Purpose |
|-------|---------|
| `auth.js` | JWT authentication, password reset |
| `tournaments.js` | Tournament results, CSV import |
| `inscriptions.js` | Player registrations (IONOS + Player App sources) |
| `email.js` | Convocations, results emails via Resend |
| `emailing.js` | Mass campaigns, scheduled emails |
| `rankings.js` | Season rankings calculation |
| `clubs.js` | Club management with aliases |
| `player-accounts.js` | Player App account management |
| `announcements.js` | Global announcements for Player App |
| `player-invitations.js` | Invitation emails for Player App registration |

## Key Frontend Pages

| Page | Purpose |
|------|---------|
| `dashboard.html` | Main hub with stats and alerts |
| `generate-poules.html` | Tournament pools/convocations |
| `rankings.html` | Season rankings by category |
| `emailing.html` | Mass email campaigns |
| `inscriptions-list.html` | Player registrations |
| `player-invitations.html` | Player App invitation management |
| `settings-admin.html` | System administration |

## Database

**Production:** PostgreSQL on Railway (`DATABASE_URL` env var)
**Local dev:** SQLite in `database/billard.db`

Key tables:
- `players` - FFB-licensed players with rankings
- `categories` - 13 competition categories
- `tournoi_ext` / `inscriptions` - External tournaments and registrations
- `convocation_poules` - Stored poule compositions (shared with Player App)
- `player_accounts` - Player App authentication
- `player_invitations` - Tracks invitations sent to players for Player App registration

## Environment Variables

Required:
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - JWT signing secret
- `RESEND_API_KEY` - Email sending

Optional:
- `PORT` - Server port (default 3000)
- `ALLOWED_ORIGINS` - CORS origins
- `BASE_URL` - For email links

## Development Notes

- All text is in **French**
- Dates: Paris timezone, displayed as DD/MM/YYYY
- Season format: `YYYY-YYYY+1` (e.g., "2024-2025"), September cutoff
- **Dynamic branding colors:** Colors are loaded from `app_settings` table and applied via CSS variables. See "Branding System" section below.
- Licence numbers normalized by removing spaces
- CSV imports use semicolon delimiter
- **Billiard icon:** Never use the American 8-ball emoji (🎱). Always use the French billiard icon image instead: `<img src="images/FrenchBillard-Icon-small.png" alt="" style="height: 24px; width: 24px; vertical-align: middle;">`
- **Test data exclusion:** ALWAYS exclude test accounts from counts and lists. Test accounts have licences starting with "TEST" (case-insensitive). Use `WHERE UPPER(licence) NOT LIKE 'TEST%'` in queries.
- **No hardcoding reference data:** NEVER hardcode values like game modes, FFB rankings, clubs, or categories. Always load them dynamically from the reference tables (`game_modes`, `ffb_rankings`, `clubs`, `categories`) via the API (`/api/reference-data/*`).
- **Helmet security headers:** The helmet middleware sets restrictive headers by default. For public endpoints that need to be accessed by external services (email clients, embeds, etc.), you must override specific headers. Common issue: `Cross-Origin-Resource-Policy: same-origin` blocks email clients from loading images. Fix by adding `res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');` to the endpoint.

## Inscription Sources

- `'ionos'` - CSV import from IONOS system
- `'player_app'` - Self-registration via Player App
- `'manual'` - Admin added via dashboard

**Note:** IONOS will be decommissioned next year; Player App will become the sole source.

## Branding System

The app supports dynamic branding for multi-organization deployment.

### Color Settings (app_settings table)
| Key | Default | Used For |
|-----|---------|----------|
| `primary_color` | #1F4788 | Headers, navbar, buttons, links |
| `secondary_color` | #667eea | Gradients, hover states |
| `accent_color` | #ffc107 | Alerts, warnings, badges |
| `background_color` | #f8f9fa | Email body, page backgrounds |
| `background_secondary_color` | #f5f5f5 | Alternating rows, cards |

### How It Works
1. **CSS Variables:** `frontend/css/styles.css` defines `:root` variables with defaults
2. **branding.js:** Loaded on every page, fetches `/api/settings/branding/colors` and updates CSS variables
3. **Email templates:** Backend routes fetch colors via `appSettings.getSetting('primary_color')`

### Files
- `frontend/js/branding.js` - Fetches colors, updates CSS variables (5-min cache)
- `frontend/css/styles.css` - CSS variables in `:root` section
- `backend/routes/settings.js` - Public `/branding/colors` endpoint

### Adding to New Pages
Include branding.js after styles.css:
```html
<link rel="stylesheet" href="css/styles.css">
<script src="js/branding.js"></script>
```

## See Also

- `backend/CLAUDE.md` - Detailed backend documentation
- `frontend/CLAUDE.md` - Detailed frontend documentation

## TODO / Future Work

- **Email address consolidation:** Replace all hardcoded `cdbhs92@gmail.com` references across email flows with the `summary_email` setting from Organization settings (`app_settings` table). Files to update include: `backend/routes/emailing.js`, `backend/routes/email.js`, `backend/routes/inscriptions.js`, `frontend/emailing.html`, `frontend/generate-poules.html`, and others. The notification email should always be loaded dynamically from the database.
