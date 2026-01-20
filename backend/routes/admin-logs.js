/**
 * Admin Activity Logs Routes
 *
 * GET /api/admin-logs - Get admin activity logs with filters
 * GET /api/admin-logs/stats - Get quick statistics
 * GET /api/admin-logs/action-types - Get list of action types
 */

const express = require('express');
const router = express.Router();
const db = require('../db-loader');
const { authenticateToken, requireAdmin } = require('./auth');

/**
 * GET /api/admin-logs
 * Get admin activity logs with optional filters
 */
router.get('/', authenticateToken, requireAdmin, (req, res) => {
  const {
    startDate,
    endDate,
    actionType,
    username,
    limit = 100,
    offset = 0
  } = req.query;

  let query = `
    SELECT
      id,
      user_id,
      username,
      user_role,
      action_type,
      action_details,
      target_type,
      target_id,
      target_name,
      ip_address,
      created_at
    FROM admin_activity_logs
    WHERE 1=1
  `;
  const params = [];
  let paramIndex = 1;

  if (startDate) {
    query += ` AND created_at >= $${paramIndex}`;
    params.push(startDate);
    paramIndex++;
  }

  if (endDate) {
    query += ` AND created_at <= $${paramIndex}`;
    params.push(endDate + ' 23:59:59');
    paramIndex++;
  }

  if (actionType) {
    const actionTypes = actionType.split(',').map(t => t.trim());
    query += ` AND action_type = ANY($${paramIndex})`;
    params.push(actionTypes);
    paramIndex++;
  }

  if (username) {
    query += ` AND username ILIKE $${paramIndex}`;
    params.push(`%${username}%`);
    paramIndex++;
  }

  // Get total count for pagination
  const countQuery = query.replace(
    /SELECT[\s\S]*?FROM/,
    'SELECT COUNT(*) as total FROM'
  );

  db.get(countQuery, params, (err, countResult) => {
    if (err) {
      console.error('Error counting admin logs:', err);
      return res.status(500).json({ error: 'Erreur lors de la récupération des logs' });
    }

    const total = parseInt(countResult?.total || 0);

    // Add ordering and pagination
    const finalQuery = query + ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    const finalParams = [...params, parseInt(limit), parseInt(offset)];

    db.all(finalQuery, finalParams, (err, logs) => {
      if (err) {
        console.error('Error fetching admin logs:', err);
        return res.status(500).json({ error: 'Erreur lors de la récupération des logs' });
      }

      res.json({
        logs: logs || [],
        total,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
    });
  });
});

/**
 * GET /api/admin-logs/stats
 * Get quick statistics for dashboard
 */
router.get('/stats', authenticateToken, requireAdmin, (req, res) => {
  // Last 7 days stats
  db.get(`
    SELECT
      COUNT(*) FILTER (WHERE action_type = 'LOGIN_SUCCESS' AND created_at >= NOW() - INTERVAL '7 days') as logins,
      COUNT(*) FILTER (WHERE action_type LIKE 'IMPORT%' AND created_at >= NOW() - INTERVAL '7 days') as imports,
      COUNT(*) FILTER (WHERE action_type LIKE 'SEND%' AND created_at >= NOW() - INTERVAL '7 days') as emails,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as total_actions
    FROM admin_activity_logs
  `, [], (err, stats) => {
    if (err) {
      console.error('Error fetching admin logs stats:', err);
      return res.status(500).json({ error: 'Erreur lors de la récupération des statistiques' });
    }

    // Active users
    db.all(`
      SELECT DISTINCT username, user_role, MAX(created_at) as last_activity
      FROM admin_activity_logs
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY username, user_role
      ORDER BY last_activity DESC
    `, [], (err, activeUsers) => {
      if (err) {
        console.error('Error fetching active users:', err);
        return res.status(500).json({ error: 'Erreur lors de la récupération des statistiques' });
      }

      res.json({
        logins: parseInt(stats?.logins || 0),
        imports: parseInt(stats?.imports || 0),
        emails: parseInt(stats?.emails || 0),
        totalActions: parseInt(stats?.total_actions || 0),
        activeUsers: activeUsers || []
      });
    });
  });
});

/**
 * GET /api/admin-logs/action-types
 * Get list of distinct action types for filtering
 */
router.get('/action-types', authenticateToken, requireAdmin, (req, res) => {
  db.all(`
    SELECT DISTINCT action_type, COUNT(*) as count
    FROM admin_activity_logs
    GROUP BY action_type
    ORDER BY count DESC
  `, [], (err, actionTypes) => {
    if (err) {
      console.error('Error fetching action types:', err);
      return res.status(500).json({ error: 'Erreur lors de la récupération des types d\'actions' });
    }

    res.json(actionTypes || []);
  });
});

/**
 * DELETE /api/admin-logs
 * Clear old logs (admin only, with date range)
 */
router.delete('/', authenticateToken, requireAdmin, (req, res) => {
  const { beforeDate } = req.body;

  if (!beforeDate) {
    return res.status(400).json({ error: 'Date requise' });
  }

  db.run(
    'DELETE FROM admin_activity_logs WHERE created_at < $1',
    [beforeDate],
    function(err) {
      if (err) {
        console.error('Error deleting admin logs:', err);
        return res.status(500).json({ error: 'Erreur lors de la suppression des logs' });
      }

      res.json({
        message: 'Logs supprimés',
        deleted: this.changes || 0
      });
    }
  );
});

module.exports = router;
