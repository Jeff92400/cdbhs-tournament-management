const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse');
const fs = require('fs');
const db = require('../db-loader');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({ dest: '/tmp' });

// Import players from CSV
router.post('/import', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    let fileContent = fs.readFileSync(req.file.path, 'utf-8');

    // Fix CSV format: remove outer quotes and fix double quotes
    // Format: "field1,""field2"",""field3""" becomes field1,"field2","field3"
    const lines = fileContent.split('\n');
    const fixedLines = lines.map(line => {
      line = line.trim();
      if (!line) return line;

      // Remove outer quotes if present
      if (line.startsWith('"') && line.endsWith('"')) {
        line = line.slice(1, -1);
      }

      // Replace double double-quotes with single quotes
      line = line.replace(/""/g, '"');

      return line;
    });

    fileContent = fixedLines.join('\n');
    const records = [];

    const parser = parse(fileContent, {
      delimiter: ',',
      skip_empty_lines: true,
      quote: '"',
      escape: '"',
      relax_column_count: true
    });

    for await (const record of parser) {
      records.push(record);
    }

    let imported = 0;
    let updated = 0;
    let errors = [];

    const stmt = db.prepare(`
      INSERT INTO players (licence, club, first_name, last_name, rank_libre, rank_cadre, rank_bande, rank_3bandes, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(licence) DO UPDATE SET
        club = excluded.club,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        rank_libre = excluded.rank_libre,
        rank_cadre = excluded.rank_cadre,
        rank_bande = excluded.rank_bande,
        rank_3bandes = excluded.rank_3bandes,
        is_active = excluded.is_active
    `);

    for (const record of records) {
      try {
        // Parse CSV format: "licence","club","first_name","last_name","libre","cadre","bande","3bandes","?","?","active"
        if (record.length < 11) continue;

        const licence = record[0]?.replace(/"/g, '').replace(/\s+/g, '').trim();
        const club = record[1]?.replace(/"/g, '').trim();
        const firstName = record[2]?.replace(/"/g, '').trim();
        const lastName = record[3]?.replace(/"/g, '').trim();
        const rankLibre = record[4]?.replace(/"/g, '').trim() || 'NC';
        const rankCadre = record[5]?.replace(/"/g, '').trim() || 'NC';
        const rankBande = record[6]?.replace(/"/g, '').trim() || 'NC';
        const rank3Bandes = record[7]?.replace(/"/g, '').trim() || 'NC';
        const isActive = record[10]?.replace(/"/g, '').trim() === '1' ? 1 : 0;

        if (!licence || !firstName || !lastName) continue;

        stmt.run(licence, club, firstName, lastName, rankLibre, rankCadre, rankBande, rank3Bandes, isActive, (err) => {
          if (err) {
            if (err.message.includes('UNIQUE constraint')) {
              updated++;
            } else {
              errors.push({ licence, error: err.message });
            }
          } else {
            imported++;
          }
        });
      } catch (err) {
        errors.push({ record: record[0], error: err.message });
      }
    }

    stmt.finalize((err) => {
      // Clean up uploaded file
      fs.unlinkSync(req.file.path);

      if (err) {
        return res.status(500).json({ error: 'Error finalizing import' });
      }

      // Record import in history
      const historyQuery = `
        INSERT INTO import_history (file_type, record_count, filename, imported_by)
        VALUES ($1, $2, $3, $4)
      `;
      db.run(historyQuery, ['joueurs', records.length, req.file.originalname, req.user?.username || 'unknown'], (histErr) => {
        if (histErr) console.error('Error recording import history:', histErr);
      });

      res.json({
        message: 'Import completed',
        imported,
        updated,
        errors: errors.length > 0 ? errors : undefined
      });
    });

  } catch (error) {
    // Clean up uploaded file
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: error.message });
  }
});

// Get all players (or filter by active status)
router.get('/', authenticateToken, (req, res) => {
  const { active } = req.query;

  let query = 'SELECT * FROM players';
  const params = [];

  if (active === 'true') {
    query += ' WHERE is_active = 1';
  } else if (active === 'false') {
    query += ' WHERE is_active = 0';
  }

  query += ' ORDER BY last_name, first_name';

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Create a single player
router.post('/', authenticateToken, (req, res) => {
  const { licence, club, first_name, last_name, rank_libre, rank_cadre, rank_bande, rank_3bandes, is_active } = req.body;

  // Validate required fields
  if (!licence || !first_name || !last_name) {
    return res.status(400).json({ error: 'Licence, first name, and last name are required' });
  }

  const stmt = db.prepare(`
    INSERT INTO players (licence, club, first_name, last_name, rank_libre, rank_cadre, rank_bande, rank_3bandes, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(licence) DO UPDATE SET
      club = excluded.club,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      rank_libre = excluded.rank_libre,
      rank_cadre = excluded.rank_cadre,
      rank_bande = excluded.rank_bande,
      rank_3bandes = excluded.rank_3bandes,
      is_active = excluded.is_active
  `);

  stmt.run(
    licence.replace(/\s+/g, '').trim(),
    club || '',
    first_name.trim(),
    last_name.trim(),
    rank_libre || 'NC',
    rank_cadre || 'NC',
    rank_bande || 'NC',
    rank_3bandes || 'NC',
    is_active !== undefined ? is_active : 1,
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({
        success: true,
        message: this.changes > 0 ? 'Player updated' : 'Player created',
        licence: licence.replace(/\s+/g, '').trim()
      });
    }
  );

  stmt.finalize();
});

// Get player by licence
router.get('/:licence', authenticateToken, (req, res) => {
  db.get("SELECT * FROM players WHERE REPLACE(licence, ' ', '') = REPLACE(?, ' ', '')", [req.params.licence], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Player not found' });
    }
    res.json(row);
  });
});

// Update player club name
// Update player (all fields)
router.put('/:licence', authenticateToken, (req, res) => {
  const { licence } = req.params;
  const { club, first_name, last_name, rank_libre, rank_cadre, rank_bande, rank_3bandes, is_active } = req.body;

  // Build dynamic UPDATE query based on provided fields
  const updates = [];
  const values = [];

  if (club !== undefined) {
    updates.push('club = ?');
    values.push(club);
  }
  if (first_name !== undefined) {
    updates.push('first_name = ?');
    values.push(first_name);
  }
  if (last_name !== undefined) {
    updates.push('last_name = ?');
    values.push(last_name);
  }
  if (rank_libre !== undefined) {
    updates.push('rank_libre = ?');
    values.push(rank_libre || null);
  }
  if (rank_cadre !== undefined) {
    updates.push('rank_cadre = ?');
    values.push(rank_cadre || null);
  }
  if (rank_bande !== undefined) {
    updates.push('rank_bande = ?');
    values.push(rank_bande || null);
  }
  if (rank_3bandes !== undefined) {
    updates.push('rank_3bandes = ?');
    values.push(rank_3bandes || null);
  }
  if (is_active !== undefined) {
    updates.push('is_active = ?');
    values.push(is_active ? 1 : 0);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  values.push(licence);

  const query = `UPDATE players SET ${updates.join(', ')} WHERE REPLACE(licence, ' ', '') = REPLACE(?, ' ', '')`;

  db.run(query, values, function(err) {
    if (err) {
      console.error('Update player error:', err);
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Player not found' });
    }
    res.json({ success: true, message: 'Player updated successfully' });
  });
});

// Legacy endpoint - update club only (for backwards compatibility)
router.put('/:licence/club', authenticateToken, (req, res) => {
  const { licence } = req.params;
  const { club } = req.body;

  if (club === undefined || club === null) {
    return res.status(400).json({ error: 'Club name is required' });
  }

  const query = 'UPDATE players SET club = ? WHERE REPLACE(licence, \' \', \'\') = REPLACE(?, \' \', \'\')';

  db.run(query, [club, licence], function(err) {
    if (err) {
      console.error('Update club error:', err);
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Player not found' });
    }
    res.json({ success: true, club });
  });
});

// Delete all players (admin only - requires password confirmation)
router.delete('/all', authenticateToken, (req, res) => {
  db.run('DELETE FROM players', [], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({
      success: true,
      message: `${this.changes} players deleted`,
      deleted: this.changes
    });
  });
});

// Get player tournament history
router.get('/:licence/history', authenticateToken, (req, res) => {
  const query = `
    SELECT
      t.season,
      c.game_type,
      c.level,
      c.display_name,
      t.tournament_number,
      tr.match_points,
      tr.moyenne,
      tr.serie,
      r.total_match_points,
      r.rank_position
    FROM tournament_results tr
    JOIN tournaments t ON tr.tournament_id = t.id
    JOIN categories c ON t.category_id = c.id
    LEFT JOIN rankings r ON r.category_id = c.id AND REPLACE(r.licence, ' ', '') = REPLACE(tr.licence, ' ', '') AND r.season = t.season
    WHERE REPLACE(tr.licence, ' ', '') = REPLACE(?, ' ', '')
    ORDER BY t.season DESC, c.game_type, c.level, t.tournament_number
  `;

  db.all(query, [req.params.licence], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

module.exports = router;
