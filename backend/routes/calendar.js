const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const db = require('../db-loader');
const { authenticateToken, requireAdmin, JWT_SECRET } = require('./auth');

const router = express.Router();

// Configure multer for memory storage (we'll save to database)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        file.mimetype === 'application/vnd.ms-excel') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and Excel files are allowed'), false);
    }
  }
});

// Middleware to authenticate via query param or header (for iframe loading)
function authenticateTokenFlexible(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Upload calendar (admin only)
router.post('/upload', authenticateToken, requireAdmin, upload.single('calendar'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const { originalname, mimetype, buffer } = req.file;
  const uploadedBy = req.user.username || 'admin';

  // Delete existing calendar and insert new one
  db.run('DELETE FROM calendar', [], (err) => {
    if (err) {
      console.error('Error deleting old calendar:', err);
    }

    db.run(
      'INSERT INTO calendar (filename, content_type, file_data, uploaded_by) VALUES ($1, $2, $3, $4)',
      [originalname, mimetype, buffer, uploadedBy],
      function(err) {
        if (err) {
          console.error('Error saving calendar:', err);
          return res.status(500).json({ error: 'Error saving calendar file' });
        }

        res.json({
          message: 'Calendar uploaded successfully',
          filename: originalname
        });
      }
    );
  });
});

// View calendar (all authenticated users)
router.get('/view', authenticateTokenFlexible, (req, res) => {
  db.get('SELECT * FROM calendar ORDER BY created_at DESC LIMIT 1', [], (err, row) => {
    if (err) {
      console.error('Error fetching calendar:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Calendar not found' });
    }

    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Content-Disposition', `inline; filename="${row.filename}"`);

    // Handle both Buffer and raw data
    const fileData = Buffer.isBuffer(row.file_data) ? row.file_data : Buffer.from(row.file_data);
    res.send(fileData);
  });
});

// Download calendar
router.get('/download', authenticateToken, (req, res) => {
  db.get('SELECT * FROM calendar ORDER BY created_at DESC LIMIT 1', [], (err, row) => {
    if (err) {
      console.error('Error fetching calendar:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Calendar not found' });
    }

    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);

    const fileData = Buffer.isBuffer(row.file_data) ? row.file_data : Buffer.from(row.file_data);
    res.send(fileData);
  });
});

// Public calendar access (no authentication required - for Player App)
// Enable CORS for this public endpoint
router.options('/public', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Disposition');
  res.status(204).end();
});

router.head('/public', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Disposition');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  db.get('SELECT content_type, filename FROM calendar ORDER BY created_at DESC LIMIT 1', [], (err, row) => {
    if (err || !row) {
      return res.status(404).end();
    }
    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Content-Disposition', `inline; filename="${row.filename}"`);
    res.status(200).end();
  });
});

router.get('/public', (req, res) => {
  // CORS headers for cross-origin access from Player App
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Disposition');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  db.get('SELECT * FROM calendar ORDER BY created_at DESC LIMIT 1', [], (err, row) => {
    if (err) {
      console.error('Error fetching calendar:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!row) {
      return res.status(404).send('<html><body style="font-family: Arial; text-align: center; padding: 50px;"><h2>Calendrier non disponible</h2><p>Le calendrier n\'a pas encore été publié.</p></body></html>');
    }

    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Content-Disposition', `inline; filename="${row.filename}"`);

    const fileData = Buffer.isBuffer(row.file_data) ? row.file_data : Buffer.from(row.file_data);
    res.send(fileData);
  });
});

// Check if calendar exists
router.get('/info', authenticateToken, (req, res) => {
  db.get('SELECT id, filename, content_type, uploaded_by, created_at FROM calendar ORDER BY created_at DESC LIMIT 1', [], (err, row) => {
    if (err) {
      console.error('Error fetching calendar info:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!row) {
      return res.json({ exists: false });
    }

    res.json({
      exists: true,
      filename: row.filename,
      contentType: row.content_type,
      uploadedBy: row.uploaded_by,
      uploadedAt: row.created_at
    });
  });
});

module.exports = router;
