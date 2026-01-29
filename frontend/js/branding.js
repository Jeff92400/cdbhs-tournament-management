// Branding - Dynamic color loading for Tournament Management App
// Fetches colors from API and updates CSS variables

(function() {
  'use strict';

  const API_URL = '/api/settings/branding/colors';
  const CACHE_KEY = 'branding_colors';
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // Map API keys to CSS variable names
  const colorMapping = {
    primary_color: '--color-primary',
    secondary_color: '--color-secondary',
    accent_color: '--color-accent',
    background_color: '--color-bg-primary',
    background_secondary_color: '--color-bg-secondary'
  };

  // Check cache first
  function getCachedColors() {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const { colors, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < CACHE_TTL) {
          return colors;
        }
      }
    } catch (e) {
      // Ignore cache errors
    }
    return null;
  }

  // Save to cache
  function setCachedColors(colors) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        colors,
        timestamp: Date.now()
      }));
    } catch (e) {
      // Ignore cache errors
    }
  }

  // Apply colors to CSS variables
  function applyColors(colors) {
    const root = document.documentElement;
    for (const [apiKey, cssVar] of Object.entries(colorMapping)) {
      if (colors[apiKey]) {
        root.style.setProperty(cssVar, colors[apiKey]);
      }
    }

    // Also set secondary-dark as a darker shade of secondary
    if (colors.secondary_color) {
      // Use the secondary color directly for secondary-dark gradient
      // In most cases, the gradient uses two different colors
      root.style.setProperty('--color-secondary-dark', colors.secondary_color);
    }
  }

  // Load colors from API
  async function loadColors() {
    // Try cache first for instant display
    const cached = getCachedColors();
    if (cached) {
      applyColors(cached);
    }

    // Fetch fresh colors (will update if different)
    try {
      const response = await fetch(API_URL);
      if (response.ok) {
        const colors = await response.json();
        applyColors(colors);
        setCachedColors(colors);
      }
    } catch (error) {
      console.log('[Branding] Could not fetch colors:', error.message);
      // CSS defaults will be used
    }
  }

  // Initialize immediately
  loadColors();

  // Also run on DOMContentLoaded in case script is in head
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadColors);
  }

  // ============= CSV IMPORT FEATURE TOGGLE =============
  // Hide/show CSV import buttons based on organization setting

  const CSV_CACHE_KEY = 'csv_imports_enabled';

  // List of import pages that should be blocked when CSV imports are disabled
  const CSV_IMPORT_PAGES = [
    'import-players.html',
    'import-tournament.html',
    'import-inscriptions.html',
    'import-external.html',
    'import-config.html',
    'import-tournois.html'
  ];

  // Check if CSV imports are enabled (cached value)
  function isCsvImportsEnabled() {
    try {
      const cached = localStorage.getItem(CSV_CACHE_KEY);
      if (cached !== null) {
        return cached === '1';
      }
    } catch (e) {}
    return true; // Default to enabled
  }

  // Check if current page is a CSV import page
  function isOnCsvImportPage() {
    const currentPage = window.location.pathname.split('/').pop();
    return CSV_IMPORT_PAGES.includes(currentPage);
  }

  // Redirect from import pages if CSV imports are disabled
  function checkCsvImportPageAccess() {
    if (!isCsvImportsEnabled() && isOnCsvImportPage()) {
      window.location.href = 'settings.html';
    }
  }

  // Apply CSV import visibility to elements with class 'csv-import-btn'
  function applyCsvImportVisibility() {
    const enabled = isCsvImportsEnabled();
    // Hide elements when CSV disabled
    document.querySelectorAll('.csv-import-btn').forEach(el => {
      el.style.display = enabled ? '' : 'none';
    });
    // Show alternate elements when CSV disabled
    document.querySelectorAll('.csv-import-disabled-only').forEach(el => {
      el.style.display = enabled ? 'none' : '';
    });
    // Also check page access
    checkCsvImportPageAccess();
  }

  // Fetch and cache CSV import setting
  async function loadCsvImportSetting() {
    try {
      const response = await fetch('/api/settings/branding/csv-imports');
      if (response.ok) {
        const data = await response.json();
        const enabled = data.enable_csv_imports !== '0';
        localStorage.setItem(CSV_CACHE_KEY, enabled ? '1' : '0');
        applyCsvImportVisibility();
      }
    } catch (error) {
      console.log('[Branding] Could not fetch CSV import setting:', error.message);
    }
  }

  // Check access immediately using cached value
  checkCsvImportPageAccess();

  // Load CSV setting and apply visibility
  loadCsvImportSetting();

  // Also run on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      applyCsvImportVisibility();
      loadCsvImportSetting();
    });
  } else {
    applyCsvImportVisibility();
  }

  // Export for use by other scripts
  window.applyCsvImportVisibility = applyCsvImportVisibility;
  window.isCsvImportsEnabled = isCsvImportsEnabled;
})();
