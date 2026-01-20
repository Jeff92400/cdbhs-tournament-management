# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

**CDBHS Tournament Management System** - A French billiards tournament management application for the Comité Départemental de Billard des Hauts-de-Seine. Manages player registrations, tournament results, rankings across 13 categories, and email communications.

**Production URL:** https://cdbhs-tournament-management-production.up.railway.app
**Staging URL:** https://cdbhs-tournament-management-staging.up.railway.app
**Related App:** Player App (Espace Joueur) in separate repo `cdbhs-player-app` - shares the same PostgreSQL database

## Deployment Workflow

### Branches
- `main` → Production (auto-deploys to Railway production)
- `staging` → Staging environment (auto-deploys to Railway staging)

### Development Process
1. **Create feature branch** from `staging`:
   ```bash
   git checkout staging
   git pull origin staging
   git checkout -b feature/my-feature
   ```

2. **Make changes**, commit with descriptive message

3. **Push and merge to staging**:
   ```bash
   git push origin feature/my-feature
   git checkout staging
   git merge feature/my-feature
   git push
   ```

4. **Test on staging URL** - verify changes work correctly

5. **Deploy to production** (if staging tests pass):
   ```bash
   git checkout main
   git merge staging
   git push
   ```

### Quick Hotfix (urgent production bugs)
```bash
git checkout main
git checkout -b hotfix/fix-name
# ... fix ...
git push origin hotfix/fix-name
git checkout main && git merge hotfix/fix-name && git push
git checkout staging && git merge main && git push  # Keep staging in sync
```

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
- CSS primary color: `#1F4788` (CDBHS blue)
- Licence numbers normalized by removing spaces
- CSV imports use semicolon delimiter
- **Billiard icon:** Never use the American 8-ball emoji (🎱). Always use the French billiard icon image instead: `<img src="images/FrenchBillard-Icon-small.png" alt="" style="height: 24px; width: 24px; vertical-align: middle;">`

## Inscription Sources

- `'ionos'` - CSV import from IONOS system
- `'player_app'` - Self-registration via Player App
- `'manual'` - Admin added via dashboard

**Note:** IONOS will be decommissioned next year; Player App will become the sole source.

## See Also

- `backend/CLAUDE.md` - Detailed backend documentation
- `frontend/CLAUDE.md` - Detailed frontend documentation
