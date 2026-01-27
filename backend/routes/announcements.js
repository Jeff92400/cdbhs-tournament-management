const express = require('express');
const { authenticateToken, requireAdmin } = require('./auth');

const router = express.Router();

// Get database connection
const getDb = () => require('../db-loader');

// Get audience count (number of Player App users, excluding test accounts)
router.get('/audience-count', authenticateToken, (req, res) => {
  const db = getDb();

  db.get(
    `SELECT COUNT(*) as count
     FROM player_accounts pa
     LEFT JOIN players p ON REPLACE(pa.licence, ' ', '') = REPLACE(p.licence, ' ', '')
     WHERE p.player_app_role IS NULL OR p.player_app_role != 'test'`,
    [],
    (err, row) => {
      if (err) {
        console.error('Error fetching audience count:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json({ count: row?.count || 0 });
    }
  );
});

// Get all announcements (includes inactive)
router.get('/', authenticateToken, (req, res) => {
  const db = getDb();

  db.all(
    `SELECT * FROM announcements ORDER BY created_at DESC`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching announcements:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

// Get active announcements (public - for Player App)
// If licence query param is provided, also show test/targeted announcements for that licence
router.get('/active', (req, res) => {
  const db = getDb();
  const { licence } = req.query;

  // Normalize licence (remove spaces)
  const normalizedLicence = licence ? licence.replace(/\s+/g, '') : null;

  db.all(
    `SELECT id, title, message, type, created_at, test_licence, target_licence
     FROM announcements
     WHERE is_active = TRUE
       AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
       AND (
         (test_licence IS NULL AND target_licence IS NULL)
         OR REPLACE(test_licence, ' ', '') = $1
         OR REPLACE(target_licence, ' ', '') = $1
       )
     ORDER BY created_at DESC`,
    [normalizedLicence],
    (err, rows) => {
      if (err) {
        console.error('Error fetching active announcements:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

// Create announcement
router.post('/', authenticateToken, (req, res) => {
  const db = getDb();
  const { title, message, type, expires_at, test_licence, target_licence } = req.body;
  const created_by = req.user?.username || 'admin';

  if (!title || !message) {
    return res.status(400).json({ error: 'Title and message are required' });
  }

  const announcementType = type || 'info';
  // Normalize licences if provided
  const normalizedTestLicence = test_licence ? test_licence.replace(/\s+/g, '') : null;
  const normalizedTargetLicence = target_licence ? target_licence.replace(/\s+/g, '') : null;

  db.run(
    `INSERT INTO announcements (title, message, type, expires_at, created_by, test_licence, target_licence)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [title, message, announcementType, expires_at || null, created_by, normalizedTestLicence, normalizedTargetLicence],
    function(err) {
      if (err) {
        console.error('Error creating announcement:', err);
        return res.status(500).json({ error: err.message });
      }
      let msg = 'Announcement created';
      if (normalizedTestLicence) msg = `Announcement test created for ${normalizedTestLicence}`;
      else if (normalizedTargetLicence) msg = `Personal message sent to ${normalizedTargetLicence}`;

      res.json({
        success: true,
        message: msg,
        id: this.lastID
      });
    }
  );
});

// Update announcement
router.put('/:id', authenticateToken, (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { title, message, type, is_active, expires_at } = req.body;

  if (!title || !message) {
    return res.status(400).json({ error: 'Title and message are required' });
  }

  db.run(
    `UPDATE announcements
     SET title = $1, message = $2, type = $3, is_active = $4, expires_at = $5
     WHERE id = $6`,
    [title, message, type || 'info', is_active !== false, expires_at || null, id],
    function(err) {
      if (err) {
        console.error('Error updating announcement:', err);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Announcement not found' });
      }
      res.json({ success: true, message: 'Announcement updated' });
    }
  );
});

// Toggle announcement active status
router.patch('/:id/toggle', authenticateToken, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  db.run(
    `UPDATE announcements SET is_active = NOT is_active WHERE id = $1`,
    [id],
    function(err) {
      if (err) {
        console.error('Error toggling announcement:', err);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Announcement not found' });
      }
      res.json({ success: true, message: 'Announcement status toggled' });
    }
  );
});

// Delete announcement
router.delete('/:id', authenticateToken, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  db.run(
    'DELETE FROM announcements WHERE id = $1',
    [id],
    function(err) {
      if (err) {
        console.error('Error deleting announcement:', err);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Announcement not found' });
      }
      res.json({ success: true, message: 'Announcement deleted' });
    }
  );
});

// Purge announcements (bulk delete based on criteria)
router.post('/purge', authenticateToken, async (req, res) => {
  const db = getDb();
  const { criteria, dateFrom, dateTo } = req.body;

  // criteria: 'expired', 'inactive', 'date_range', 'all_inactive_and_expired'
  if (!criteria) {
    return res.status(400).json({ error: 'Criteria required' });
  }

  let query = '';
  let params = [];

  try {
    switch (criteria) {
      case 'expired':
        // Delete all expired announcements (expires_at < now)
        query = 'DELETE FROM announcements WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP';
        break;

      case 'inactive':
        // Delete all inactive announcements
        query = 'DELETE FROM announcements WHERE is_active = FALSE';
        break;

      case 'all_inactive_and_expired':
        // Delete both inactive and expired
        query = `DELETE FROM announcements WHERE is_active = FALSE OR (expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP)`;
        break;

      case 'date_range':
        // Delete announcements created between two dates
        if (!dateFrom || !dateTo) {
          return res.status(400).json({ error: 'dateFrom and dateTo required for date_range criteria' });
        }
        query = 'DELETE FROM announcements WHERE created_at >= $1 AND created_at <= $2';
        params = [dateFrom, dateTo + ' 23:59:59'];
        break;

      default:
        return res.status(400).json({ error: 'Invalid criteria' });
    }

    // First count how many will be deleted
    const countQuery = query.replace('DELETE FROM', 'SELECT COUNT(*) as count FROM');
    const countResult = await new Promise((resolve, reject) => {
      db.get(countQuery, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    const toDeleteCount = countResult?.count || 0;

    if (toDeleteCount === 0) {
      return res.json({ success: true, deleted: 0, message: 'Aucune annonce correspondant aux critères' });
    }

    // Execute deletion
    await new Promise((resolve, reject) => {
      db.run(query, params, function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });

    console.log(`Purged ${toDeleteCount} announcements with criteria: ${criteria}`);
    res.json({
      success: true,
      deleted: toDeleteCount,
      message: `${toDeleteCount} annonce(s) supprimée(s)`
    });

  } catch (err) {
    console.error('Error purging announcements:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
