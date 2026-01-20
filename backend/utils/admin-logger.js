/**
 * Admin Activity Logger
 *
 * Utility to log admin/viewer actions in the Tournament Management App
 */

const db = require('../db-postgres');

/**
 * Log an admin action
 *
 * @param {Object} options
 * @param {Object} options.req - Express request object (for user info and IP)
 * @param {string} options.action - Action type (e.g., 'LOGIN', 'IMPORT_TOURNAMENT', 'SEND_EMAIL')
 * @param {string} [options.details] - Additional details about the action
 * @param {string} [options.targetType] - Type of target (e.g., 'tournament', 'player', 'email')
 * @param {string|number} [options.targetId] - ID of the target
 * @param {string} [options.targetName] - Display name of the target
 */
async function logAdminAction({ req, action, details, targetType, targetId, targetName }) {
  try {
    const userId = req.user?.userId || null;
    const username = req.user?.username || 'unknown';
    const userRole = req.user?.role || 'unknown';
    const ipAddress = req.ip || req.connection?.remoteAddress || null;
    const userAgent = req.headers?.['user-agent'] || null;

    await db.run(
      `INSERT INTO admin_activity_logs
       (user_id, username, user_role, action_type, action_details, target_type, target_id, target_name, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [userId, username, userRole, action, details, targetType, targetId?.toString(), targetName, ipAddress, userAgent]
    );
  } catch (error) {
    // Don't throw - logging should not break the main operation
    console.error('Failed to log admin action:', error.message);
  }
}

/**
 * Action type constants
 */
const ACTION_TYPES = {
  // Authentication
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',

  // User management
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_DELETED: 'USER_DELETED',

  // Tournament imports/exports
  IMPORT_TOURNAMENT: 'IMPORT_TOURNAMENT',
  IMPORT_INSCRIPTIONS: 'IMPORT_INSCRIPTIONS',
  EXPORT_DATA: 'EXPORT_DATA',

  // Poules/Convocations
  GENERATE_POULES: 'GENERATE_POULES',
  SAVE_POULES: 'SAVE_POULES',

  // Emails
  SEND_EMAIL: 'SEND_EMAIL',
  SEND_CAMPAIGN: 'SEND_CAMPAIGN',
  SEND_CONVOCATION: 'SEND_CONVOCATION',
  SEND_RESULTS: 'SEND_RESULTS',
  SCHEDULE_EMAIL: 'SCHEDULE_EMAIL',

  // Player/Inscription management
  ADD_INSCRIPTION: 'ADD_INSCRIPTION',
  DELETE_INSCRIPTION: 'DELETE_INSCRIPTION',
  UPDATE_PLAYER: 'UPDATE_PLAYER',

  // Settings
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',

  // Calendar
  UPLOAD_CALENDAR: 'UPLOAD_CALENDAR',
  GENERATE_SEASON: 'GENERATE_SEASON',

  // Maintenance
  RECALCULATE_RANKINGS: 'RECALCULATE_RANKINGS',
  RECALCULATE_MOYENNES: 'RECALCULATE_MOYENNES',

  // Announcements
  CREATE_ANNOUNCEMENT: 'CREATE_ANNOUNCEMENT',
  UPDATE_ANNOUNCEMENT: 'UPDATE_ANNOUNCEMENT',
  DELETE_ANNOUNCEMENT: 'DELETE_ANNOUNCEMENT'
};

module.exports = {
  logAdminAction,
  ACTION_TYPES
};
