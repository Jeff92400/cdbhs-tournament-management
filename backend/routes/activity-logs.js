/**
 * Activity Logs Routes
 *
 * GET /api/activity-logs - Get activity logs with filters
 */

const express = require('express');
const router = express.Router();
const db = require('../db-postgres');
const { authenticateToken, requireViewer, requireAdmin } = require('./auth');

/**
 * GET /api/activity-logs
 * Get activity logs with optional filters
 *
 * Query params:
 * - startDate: Filter from this date (ISO string)
 * - endDate: Filter to this date (ISO string)
 * - actionType: Filter by action type (comma-separated for multiple)
 * - name: Filter by player name (partial match)
 * - licence: Filter by player licence
 * - limit: Max records to return (default 100)
 * - offset: Pagination offset (default 0)
 */
router.get('/', authenticateToken, requireViewer, async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      actionType,
      name,
      licence,
      limit = 100,
      offset = 0
    } = req.query;

    let query = `
      SELECT
        id,
        licence,
        user_email,
        user_name,
        action_type,
        action_status,
        target_type,
        target_id,
        target_name,
        details,
        ip_address,
        user_agent,
        app_source,
        created_at
      FROM activity_logs
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
      params.push(endDate);
      paramIndex++;
    }

    if (actionType) {
      const actionTypes = actionType.split(',').map(t => t.trim());
      query += ` AND action_type = ANY($${paramIndex})`;
      params.push(actionTypes);
      paramIndex++;
    }

    if (name) {
      query += ` AND user_name ILIKE $${paramIndex}`;
      params.push(`%${name}%`);
      paramIndex++;
    }

    if (licence) {
      query += ` AND licence = $${paramIndex}`;
      params.push(licence);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC`;

    // Get total count for pagination
    const countQuery = query.replace(
      /SELECT[\s\S]*?FROM/,
      'SELECT COUNT(*) as total FROM'
    ).replace(/ORDER BY[\s\S]*$/, '');

    const countResult = await db.query(countQuery, params);
    const total = parseInt(countResult.rows[0]?.total || 0);

    // Apply pagination
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    res.json({
      logs: result.rows,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

  } catch (error) {
    console.error('Get activity logs error:', error);
    res.status(500).json({ error: 'Failed to get activity logs' });
  }
});

/**
 * GET /api/activity-logs/action-types
 * Get list of all action types for filtering
 */
router.get('/action-types', authenticateToken, requireViewer, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT DISTINCT action_type
      FROM activity_logs
      ORDER BY action_type
    `);

    res.json(result.rows.map(r => r.action_type));
  } catch (error) {
    console.error('Get action types error:', error);
    res.status(500).json({ error: 'Failed to get action types' });
  }
});

/**
 * GET /api/activity-logs/stats
 * Get activity statistics
 */
router.get('/stats', authenticateToken, requireViewer, async (req, res) => {
  try {
    const { days = 7 } = req.query;

    // Actions per day for the last N days
    const dailyStats = await db.query(`
      SELECT
        DATE(created_at) as date,
        action_type,
        COUNT(*) as count
      FROM activity_logs
      WHERE created_at >= NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY DATE(created_at), action_type
      ORDER BY date DESC, action_type
    `);

    // Total counts by action type
    const totals = await db.query(`
      SELECT
        action_type,
        COUNT(*) as count
      FROM activity_logs
      WHERE created_at >= NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY action_type
      ORDER BY count DESC
    `);

    // Recent active users
    const activeUsers = await db.query(`
      SELECT
        licence,
        user_email,
        user_name,
        COUNT(*) as action_count,
        MAX(created_at) as last_activity
      FROM activity_logs
      WHERE created_at >= NOW() - INTERVAL '${parseInt(days)} days'
        AND licence IS NOT NULL
      GROUP BY licence, user_email, user_name
      ORDER BY action_count DESC
      LIMIT 10
    `);

    res.json({
      daily: dailyStats.rows,
      totals: totals.rows,
      activeUsers: activeUsers.rows
    });

  } catch (error) {
    console.error('Get activity stats error:', error);
    res.status(500).json({ error: 'Failed to get activity stats' });
  }
});

/**
 * DELETE /api/activity-logs
 * Clear activity logs (admin only)
 * Supports optional date range filtering
 *
 * Body params (optional):
 * - startDate: Delete from this date
 * - endDate: Delete to this date
 */
router.delete('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.body || {};

    let query = 'DELETE FROM activity_logs WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (startDate) {
      query += ` AND created_at >= $${paramIndex}`;
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      query += ` AND created_at <= $${paramIndex}`;
      params.push(endDate);
      paramIndex++;
    }

    const result = await db.query(query, params);

    const rangeInfo = startDate || endDate
      ? ` (${startDate || 'debut'} - ${endDate || 'fin'})`
      : ' (tous)';
    console.log(`Activity logs cleared by admin: ${req.user.email}${rangeInfo} - ${result.rowCount} deleted`);

    res.json({
      success: true,
      message: 'Les logs ont été supprimés',
      deleted: result.rowCount
    });
  } catch (error) {
    console.error('Clear activity logs error:', error);
    res.status(500).json({ error: 'Failed to clear activity logs' });
  }
});

module.exports = router;
