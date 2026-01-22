// App Branding Utilities - Dynamic logo and organization name loading

const DEFAULT_LOGO_PATH = 'images/FrenchBillard-Icon-small.png';
const DEFAULT_ORG_NAME = 'CDB';

/**
 * Initialize app branding (favicon + header)
 * Call this on page load for authenticated pages
 */
async function initAppBranding() {
  try {
    // Try to load organization logo, fallback to default
    const logoUrl = await getOrganizationLogoUrl();

    // Update favicon with cache-busting
    updateFavicon(logoUrl);

    // Update header icon if element exists
    const headerIcon = document.getElementById('app-header-icon');
    if (headerIcon) {
      headerIcon.src = logoUrl;
      headerIcon.onerror = function() {
        this.src = DEFAULT_LOGO_PATH;
      };
    }

    // Update organization name if element exists
    const orgNameEl = document.getElementById('app-org-name');
    if (orgNameEl) {
      const orgName = await getOrganizationShortName();
      orgNameEl.textContent = (orgName || DEFAULT_ORG_NAME) + ' Tournois';
    }
  } catch (error) {
    console.log('[Branding] Error loading branding, using defaults:', error);
    updateFavicon(DEFAULT_LOGO_PATH);
  }
}

/**
 * Get organization logo URL, returns default if not available
 */
async function getOrganizationLogoUrl() {
  try {
    const token = localStorage.getItem('token');
    const response = await fetch('/api/settings/organization-logo', {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    });

    if (response.ok) {
      const data = await response.json();
      if (data.url) {
        // Add cache-busting timestamp
        const cacheBuster = data.lastModified ? new Date(data.lastModified).getTime() : Date.now();
        return data.url + '?v=' + cacheBuster;
      }
    }
  } catch (error) {
    console.log('[Branding] Could not fetch org logo:', error);
  }

  return DEFAULT_LOGO_PATH;
}

/**
 * Get organization short name from settings
 */
async function getOrganizationShortName() {
  try {
    const token = localStorage.getItem('token');
    if (!token) return null;

    const response = await fetch('/api/settings/app/organization_short_name', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (response.ok) {
      const data = await response.json();
      return data.value || null;
    }
  } catch (error) {
    console.log('[Branding] Could not fetch org name:', error);
  }

  return null;
}

/**
 * Update the page favicon
 */
function updateFavicon(url) {
  let link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/png';
  link.href = url;
}

/**
 * Initialize branding for public pages (no auth required)
 * Uses /logo.png public endpoint for dynamic logo
 * Also fetches organization name from public branding endpoint
 */
async function initPublicBranding() {
  // Use the public /logo.png endpoint with cache-busting
  const logoUrl = '/logo.png?v=' + Date.now();

  updateFavicon(logoUrl);

  const headerIcon = document.getElementById('app-header-icon');
  if (headerIcon) {
    headerIcon.src = logoUrl;
    headerIcon.onerror = function() {
      this.src = DEFAULT_LOGO_PATH;
    };
  }

  // Fetch organization name from public branding endpoint
  try {
    const response = await fetch('/api/settings/branding/colors');
    if (response.ok) {
      const data = await response.json();
      const orgNameEl = document.getElementById('app-org-name');
      if (orgNameEl && data.organization_short_name) {
        orgNameEl.textContent = data.organization_short_name;
      }
    }
  } catch (error) {
    console.log('[Branding] Could not fetch org name for public page:', error);
  }
}

// Auto-initialize on DOM ready if token exists
document.addEventListener('DOMContentLoaded', function() {
  const token = localStorage.getItem('token');
  if (token) {
    // Authenticated page - load dynamic branding
    initAppBranding();
  }
  // Public pages should call initPublicBranding() manually if needed
});
