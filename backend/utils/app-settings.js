/**
 * App Settings Helper
 *
 * Provides a cached interface to app_settings table for dynamic configuration.
 * Settings are cached with TTL to balance performance and freshness.
 */

// Cache for settings
let settingsCache = null;
let cacheTimestamp = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache TTL

// Default values (fallbacks if database is unavailable)
const defaults = {
  // Legacy settings
  summary_email: 'cdbhs92@gmail.com',
  email_scheduler_hour: '6',

  // Organization settings
  organization_name: 'Comité Départemental de Billard des Hauts-de-Seine',
  organization_short_name: 'CDBHS',

  // Branding settings
  primary_color: '#1F4788',
  secondary_color: '#667EEA',
  accent_color: '#FFC107',
  background_color: '#FFFFFF',
  background_secondary_color: '#F5F5F5',

  // Email settings
  email_communication: 'communication@cdbhs.net',
  email_convocations: 'convocations@cdbhs.net',
  email_noreply: 'noreply@cdbhs.net',
  email_sender_name: 'CDBHS',

  // Season settings
  season_cutoff_month: '8', // September (0-indexed)

  // Ranking settings
  qualification_threshold: '9',
  qualification_small: '4',
  qualification_large: '6',

  // Privacy policy
  privacy_policy: ''
};

/**
 * Load all settings from database into cache
 */
async function loadSettings() {
  const db = require('../db-loader');

  return new Promise((resolve) => {
    db.all('SELECT key, value FROM app_settings', [], (err, rows) => {
      if (err) {
        console.error('Error loading app settings:', err);
        // Return defaults on error
        resolve({ ...defaults });
        return;
      }

      // Convert rows to object and merge with defaults
      const settings = { ...defaults };
      (rows || []).forEach(row => {
        settings[row.key] = row.value;
      });

      // Update cache
      settingsCache = settings;
      cacheTimestamp = Date.now();

      resolve(settings);
    });
  });
}

/**
 * Get all settings (from cache if valid, otherwise reload)
 */
async function getSettings() {
  const now = Date.now();

  // Return cached settings if still valid
  if (settingsCache && cacheTimestamp && (now - cacheTimestamp) < CACHE_TTL) {
    return settingsCache;
  }

  // Reload from database
  return loadSettings();
}

/**
 * Get a single setting by key
 * @param {string} key - Setting key
 * @returns {Promise<string>} Setting value
 */
async function getSetting(key) {
  const settings = await getSettings();
  return settings[key] || defaults[key] || '';
}

/**
 * Get multiple settings at once
 * @param {string[]} keys - Array of setting keys
 * @returns {Promise<Object>} Object with requested settings
 */
async function getSettingsBatch(keys) {
  const settings = await getSettings();
  const result = {};
  keys.forEach(key => {
    result[key] = settings[key] || defaults[key] || '';
  });
  return result;
}

/**
 * Clear the cache (call after updating settings)
 */
function clearCache() {
  settingsCache = null;
  cacheTimestamp = null;
}

/**
 * Get email settings bundle (commonly used together)
 */
async function getEmailSettings() {
  return getSettingsBatch([
    'email_communication',
    'email_convocations',
    'email_noreply',
    'email_sender_name',
    'summary_email',
    'organization_name',
    'organization_short_name'
  ]);
}

/**
 * Get branding settings bundle
 */
async function getBrandingSettings() {
  return getSettingsBatch([
    'primary_color',
    'secondary_color',
    'accent_color',
    'background_color',
    'background_secondary_color',
    'organization_name',
    'organization_short_name'
  ]);
}

/**
 * Get qualification settings bundle
 */
async function getQualificationSettings() {
  const settings = await getSettingsBatch([
    'qualification_threshold',
    'qualification_small',
    'qualification_large'
  ]);

  // Convert to numbers for easier use
  return {
    threshold: parseInt(settings.qualification_threshold, 10) || 9,
    small: parseInt(settings.qualification_small, 10) || 4,
    large: parseInt(settings.qualification_large, 10) || 6
  };
}

module.exports = {
  getSettings,
  getSetting,
  getSettingsBatch,
  clearCache,
  getEmailSettings,
  getBrandingSettings,
  getQualificationSettings,
  defaults
};
