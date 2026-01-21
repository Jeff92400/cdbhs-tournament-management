# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CDBHS Tournament Management frontend - Admin dashboard for French billiards tournament management. Vanilla HTML/CSS/JS with no build process.

## Architecture

### No Build System
- Static HTML files served directly by Express backend
- No npm, no bundler, no transpilation
- Edit HTML/CSS/JS files directly - changes are immediate

### File Structure
```
frontend/
├── css/styles.css      # Single shared stylesheet
├── js/
│   ├── auth-utils.js   # Authentication utilities (401 handling)
│   └── club-utils.js   # Shared club logo utilities
├── images/
│   ├── clubs/          # Club logo PNGs
│   └── billiard-icon.png
└── *.html              # Page files
```

### Key Pages
| Page | Purpose |
|------|---------|
| `login.html` | Authentication entry point |
| `dashboard.html` | Main hub with stats, quick actions, alerts |
| `rankings.html` | Season rankings by category |
| `generate-poules.html` | Tournament pools/convocations management |
| `tournaments-list.html` | Completed tournaments (internal T1/T2/T3) |
| `tournois-list.html` | External tournaments from IONOS |
| `inscriptions-list.html` | Player registrations management |
| `emailing.html` | Mass email campaigns, templates |
| `settings.html` / `settings-admin.html` | User and system settings |
| `player-accounts.html` | Player App account management |

### Authentication Pattern
All authenticated pages include `auth-utils.js` and follow this pattern:
```html
<script src="js/auth-utils.js"></script>
<script>
  const API_URL = '/api';

  // Redirect if not authenticated
  if (!requireAuth()) {
    throw new Error('Not authenticated');
  }
  const token = localStorage.getItem('token');

  // API calls include Bearer token
  fetch(`${API_URL}/endpoint`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
</script>
```

### Auth Utilities (js/auth-utils.js)
- **Global 401 interceptor**: Automatically catches 401/403 on all `/api/` calls and redirects to login
- `requireAuth()` - Checks token exists, redirects to login if not
- `authFetch(url, options)` - Fetch wrapper that adds Authorization header
- `handleSessionExpired()` - Clears storage, sets message, redirects to login
- `getCurrentUser()` - Returns `{username, role}` from localStorage
- `logout()` - Clears auth and redirects to login

**Session expired flow**: When any API returns 401/403, user sees "Votre session a expiré" on login page.

### Role-Based UI
- Admin-only elements use class `admin-only`
- JS checks `localStorage.getItem('userRole')` to show/hide
- Roles: `admin`, `editor`, `viewer`

### Shared Utilities (js/club-utils.js)
- `loadClubsFromDatabase()` - Fetches clubs on page load
- `getClubLogoHTML(clubName, options)` - Returns HTML with logo + name
- `getClubInfo(clubName)` - Returns `{logo, displayName}`
- `normalizeClubName(name)` - Normalizes for matching

### CSS Conventions
- **Colors are dynamic** - use CSS variables: `var(--color-primary)`, `var(--color-secondary)`, etc.
- Default primary: `#1F4788`, secondary: `#667eea`, accent: `#ffc107`
- Gradient: `linear-gradient(135deg, var(--color-secondary) 0%, var(--color-secondary-dark) 100%)`
- Button variants: `.btn`, `.btn-success`, `.btn-danger`
- Cards: `.card` class for content sections
- Navigation: `.navbar`, `.nav-links`, `.nav-tooltip`
- **branding.js** loads colors from API and updates CSS variables on page load

### Common Patterns

**Show/hide messages:**
```javascript
document.getElementById('errorMessage').textContent = 'Error text';
document.getElementById('errorMessage').style.display = 'block';
```

**Table rendering:**
```javascript
tbody.innerHTML = data.map(item => `
  <tr>
    <td>${item.field}</td>
  </tr>
`).join('');
```

**Image fallback:**
```html
<img src="path.png" onerror="this.style.display='none'">
```

## Development Notes

- All text is in French
- Dates displayed in French format (DD/MM/YYYY)
- Season format displayed as "2024-2025"
- Club logos are PNGs in `images/clubs/`, matched by normalized name
- **Billiard icon:** Never use the American 8-ball emoji (🎱). This is a French billiards app (carambole). Always use the French billiard icon:
  ```html
  <img src="images/FrenchBillard-Icon-small.png" alt="" style="height: 24px; width: 24px; vertical-align: middle;">
  ```
