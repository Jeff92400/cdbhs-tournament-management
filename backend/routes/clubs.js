const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db-loader');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Configure multer for logo uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../frontend/images/clubs');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Generate filename: remove spaces and special chars
    const filename = file.originalname.replace(/\s+/g, '_').replace(/[^\w.-]/g, '_');
    cb(null, filename);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: function (req, file, cb) {
    const filetypes = /jpeg|jpg|png|gif/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only image files are allowed'));
  }
});

// Get all clubs
router.get('/', authenticateToken, (req, res) => {
  db.all('SELECT * FROM clubs ORDER BY name', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Get club by ID
router.get('/:id', authenticateToken, (req, res) => {
  db.get('SELECT * FROM clubs WHERE id = ?', [req.params.id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Club not found' });
    }
    res.json(row);
  });
});

// Add new club
router.post('/', authenticateToken, upload.single('logo'), (req, res) => {
  const { name, display_name, street, city, zip_code, phone, email } = req.body;
  const logo_filename = req.file ? req.file.filename : null;

  if (!name || !display_name) {
    return res.status(400).json({ error: 'Name and display name are required' });
  }

  db.run(
    'INSERT INTO clubs (name, display_name, logo_filename, street, city, zip_code, phone, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [name, display_name, logo_filename, street || null, city || null, zip_code || null, phone || null, email || null],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(400).json({ error: 'Club name already exists' });
        }
        return res.status(500).json({ error: err.message });
      }
      res.json({
        id: this.lastID,
        name,
        display_name,
        logo_filename,
        street,
        city,
        zip_code,
        phone,
        email
      });
    }
  );
});

// Update club
router.put('/:id', authenticateToken, upload.single('logo'), (req, res) => {
  const { name, display_name, street, city, zip_code, phone, email } = req.body;
  const clubId = req.params.id;

  // Get current club data
  db.get('SELECT * FROM clubs WHERE id = ?', [clubId], (err, club) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!club) {
      return res.status(404).json({ error: 'Club not found' });
    }

    const newLogoFilename = req.file ? req.file.filename : club.logo_filename;
    const newName = name || club.name;
    const newDisplayName = display_name || club.display_name;
    const newStreet = street !== undefined ? street : club.street;
    const newCity = city !== undefined ? city : club.city;
    const newZipCode = zip_code !== undefined ? zip_code : club.zip_code;
    const newPhone = phone !== undefined ? phone : club.phone;
    const newEmail = email !== undefined ? email : club.email;

    db.run(
      'UPDATE clubs SET name = ?, display_name = ?, logo_filename = ?, street = ?, city = ?, zip_code = ?, phone = ?, email = ? WHERE id = ?',
      [newName, newDisplayName, newLogoFilename, newStreet, newCity, newZipCode, newPhone, newEmail, clubId],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Club name already exists' });
          }
          return res.status(500).json({ error: err.message });
        }

        // Delete old logo if a new one was uploaded
        if (req.file && club.logo_filename && club.logo_filename !== newLogoFilename) {
          const oldLogoPath = path.join(__dirname, '../../frontend/images/clubs', club.logo_filename);
          if (fs.existsSync(oldLogoPath)) {
            fs.unlinkSync(oldLogoPath);
          }
        }

        res.json({
          id: clubId,
          name: newName,
          display_name: newDisplayName,
          logo_filename: newLogoFilename,
          street: newStreet,
          city: newCity,
          zip_code: newZipCode,
          phone: newPhone,
          email: newEmail
        });
      }
    );
  });
});

// Delete club
router.delete('/:id', authenticateToken, (req, res) => {
  const clubId = req.params.id;

  // Get club data to delete logo file
  db.get('SELECT * FROM clubs WHERE id = ?', [clubId], (err, club) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!club) {
      return res.status(404).json({ error: 'Club not found' });
    }

    db.run('DELETE FROM clubs WHERE id = ?', [clubId], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      // Delete logo file if exists
      if (club.logo_filename) {
        const logoPath = path.join(__dirname, '../../frontend/images/clubs', club.logo_filename);
        if (fs.existsSync(logoPath)) {
          fs.unlinkSync(logoPath);
        }
      }

      res.json({ success: true, message: 'Club deleted' });
    });
  });
});

// ==================== CLUB ALIASES ====================

// Get all aliases
router.get('/aliases/list', authenticateToken, (req, res) => {
  db.all('SELECT * FROM club_aliases ORDER BY alias', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

// Get all aliases with club info
router.get('/aliases/with-clubs', authenticateToken, (req, res) => {
  db.all(`
    SELECT ca.*, c.display_name, c.logo_filename
    FROM club_aliases ca
    LEFT JOIN clubs c ON UPPER(REPLACE(REPLACE(REPLACE(ca.canonical_name, ' ', ''), '.', ''), '-', ''))
                       = UPPER(REPLACE(REPLACE(REPLACE(c.name, ' ', ''), '.', ''), '-', ''))
    ORDER BY ca.alias
  `, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

// Add new alias
router.post('/aliases', authenticateToken, (req, res) => {
  const { alias, canonical_name } = req.body;

  if (!alias || !canonical_name) {
    return res.status(400).json({ error: 'Alias and canonical_name are required' });
  }

  db.run(
    'INSERT INTO club_aliases (alias, canonical_name) VALUES ($1, $2)',
    [alias.trim(), canonical_name.trim()],
    function(err) {
      if (err) {
        if (err.message && err.message.includes('UNIQUE')) {
          return res.status(400).json({ error: 'This alias already exists' });
        }
        return res.status(500).json({ error: err.message });
      }
      res.json({
        id: this.lastID,
        alias: alias.trim(),
        canonical_name: canonical_name.trim()
      });
    }
  );
});

// Delete alias
router.delete('/aliases/:id', authenticateToken, (req, res) => {
  db.run('DELETE FROM club_aliases WHERE id = $1', [req.params.id], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true, message: 'Alias deleted' });
  });
});

// Resolve club name - returns canonical name if alias exists
router.get('/resolve/:name', authenticateToken, (req, res) => {
  const clubName = req.params.name;

  // First check if it's an alias
  db.get(
    'SELECT canonical_name FROM club_aliases WHERE UPPER(REPLACE(REPLACE(REPLACE(alias, \' \', \'\'), \'.\', \'\'), \'-\', \'\')) = UPPER(REPLACE(REPLACE(REPLACE($1, \' \', \'\'), \'.\', \'\'), \'-\', \'\'))',
    [clubName],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({
        original: clubName,
        resolved: row ? row.canonical_name : clubName,
        isAlias: !!row
      });
    }
  );
});

module.exports = router;
