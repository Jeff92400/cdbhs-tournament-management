// Authentication utility functions for Tournament Management App

// Intercept all fetch responses to handle 401 errors globally
(function() {
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);

    // Only check API calls (not external resources)
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    if (url.startsWith('/api/') && (response.status === 401 || response.status === 403)) {
      console.log('[Auth] API returned 401/403, session expired');
      // Don't redirect for login endpoints
      if (!url.includes('/auth/login') && !url.includes('/auth/forgot')) {
        handleSessionExpired();
      }
    }

    return response;
  };
})();

/**
 * Wrapper for authenticated API calls with automatic 401 handling
 * @param {string} url - The API URL to fetch
 * @param {object} options - Fetch options (method, headers, body, etc.)
 * @returns {Promise<Response>} - The fetch response
 */
async function authFetch(url, options = {}) {
  const token = localStorage.getItem('token');

  if (!token) {
    console.log('[Auth] No token found, redirecting to login');
    handleSessionExpired();
    throw new Error('Session expirée');
  }

  // Add authorization header
  options.headers = {
    ...options.headers,
    'Authorization': `Bearer ${token}`
  };

  const response = await fetch(url, options);

  // Handle server-side token invalidation (401/403)
  if (response.status === 401 || response.status === 403) {
    console.log('[Auth] Server rejected token (401/403), redirecting to login...');
    handleSessionExpired();
    throw new Error('Session expirée');
  }

  return response;
}

/**
 * Handle session expiration - redirect to login with message
 */
function handleSessionExpired() {
  // Clear stored credentials
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  localStorage.removeItem('role');

  // Store message for login page to display
  sessionStorage.setItem('sessionExpiredMessage', 'Votre session a expiré. Veuillez vous reconnecter.');

  // Redirect to login
  window.location.href = '/login.html';
}

/**
 * Check if user is authenticated, redirect to login if not
 * Call this at the start of protected pages
 * @returns {boolean} - True if authenticated
 */
function requireAuth() {
  const token = localStorage.getItem('token');
  if (!token) {
    console.log('[Auth] No token found, redirecting to login');
    window.location.href = '/login.html';
    return false;
  }
  return true;
}

/**
 * Get current user info from localStorage
 * @returns {object|null} - User object with username and role
 */
function getCurrentUser() {
  const token = localStorage.getItem('token');
  if (!token) return null;

  return {
    username: localStorage.getItem('username'),
    role: localStorage.getItem('role')
  };
}

/**
 * Logout user and redirect to login
 */
function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  localStorage.removeItem('role');
  window.location.href = '/login.html';
}
