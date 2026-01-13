const express = require('express');
const { authenticateToken, requireAdmin } = require('./auth');

const router = express.Router();

// Get database connection
const getDb = () => require('../db-loader');

// Get audience count (number of Player App users)
router.get('/audience-count', authenticateToken, (req, res) => {
  const db = getDb();

  db.get(
    `SELECT COUNT(*) as count FROM player_accounts`,
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
// If licence query param is provided, also show test announcements for that licence
router.get('/active', (req, res) => {
  const db = getDb();
  const { licence } = req.query;

  // Normalize licence (remove spaces)
  const normalizedLicence = licence ? licence.replace(/\s+/g, '') : null;

  db.all(
    `SELECT id, title, message, type, created_at, test_licence
     FROM announcements
     WHERE is_active = TRUE
       AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
       AND (
         test_licence IS NULL
         OR REPLACE(test_licence, ' ', '') = $1
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
  const { title, message, type, expires_at, test_licence } = req.body;
  const created_by = req.user?.username || 'admin';

  if (!title || !message) {
    return res.status(400).json({ error: 'Title and message are required' });
  }

  const announcementType = type || 'info';
  // Normalize test_licence if provided
  const normalizedTestLicence = test_licence ? test_licence.replace(/\s+/g, '') : null;

  db.run(
    `INSERT INTO announcements (title, message, type, expires_at, created_by, test_licence)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [title, message, announcementType, expires_at || null, created_by, normalizedTestLicence],
    function(err) {
      if (err) {
        console.error('Error creating announcement:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json({
        success: true,
        message: normalizedTestLicence ? `Announcement test created for ${normalizedTestLicence}` : 'Announcement created',
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

module.exports = router;
