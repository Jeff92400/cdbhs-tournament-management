const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse');
const fs = require('fs');
const db = require('../db-loader');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Configure multer for file uploads with security restrictions
const upload = multer({
  dest: '/tmp',
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max
  },
  fileFilter: (req, file, cb) => {
    // Only allow CSV files
    const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));
    if (ext === '.csv') {
      cb(null, true);
    } else {
      cb(new Error('Seuls les fichiers CSV sont acceptés'), false);
    }
  }
});

// Import players from CSV
router.post('/import', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Check if only rankings should be updated
  const rankingsOnly = req.body.rankingsOnly === 'true' || req.body.rankingsOnly === true;

  try {
    let fileContent = fs.readFileSync(req.file.path, 'utf-8');

    // Detect delimiter: check if file uses semicolons (IONOS format) or commas
    const firstLine = fileContent.split('\n')[0] || '';
    const semicolonCount = (firstLine.match(/;/g) || []).length;
    const commaCount = (firstLine.match(/,/g) || []).length;
    const delimiter = semicolonCount > commaCount ? ';' : ',';
    console.log(`CSV delimiter detected: "${delimiter}" (semicolons: ${semicolonCount}, commas: ${commaCount})`);

    // Fix CSV format: remove outer quotes and fix double quotes
    // Format: "field1,""field2"",""field3""" becomes field1,"field2","field3"
    const lines = fileContent.split('\n');
    const fixedLines = lines.map(line => {
      line = line.trim();
      if (!line) return line;

      // Remove outer quotes if present (only if the entire line is wrapped)
      if (line.startsWith('"') && line.endsWith('"') && line.indexOf(delimiter) === -1) {
        line = line.slice(1, -1);
      }

      // Replace double double-quotes with single quotes
      line = line.replace(/""/g, '"');

      return line;
    });

    fileContent = fixedLines.join('\n');
    const records = [];

    const parser = parse(fileContent, {
      delimiter: delimiter,
      skip_empty_lines: true,
      quote: '"',
      escape: '"',
      relax_column_count: true,
      relax_quotes: true  // Allow quotes in unquoted fields
    });

    for await (const record of parser) {
      records.push(record);
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let errors = [];
    let notFound = []; // Track players not found in database (for rankings-only mode)

    // Process records using PostgreSQL ON CONFLICT
    for (const record of records) {
      try {
        // Parse CSV format: "licence","club","first_name","last_name","libre","cadre","bande","3bandes","?","?","active"
        if (record.length < 11) continue;

        const licence = record[0]?.replace(/"/g, '').replace(/\s+/g, '').trim();

        // Skip header row (detect by checking if first column looks like a header)
        if (licence.toUpperCase() === 'LICENCE' || licence.toUpperCase() === 'LICENSE') continue;
        const club = record[1]?.replace(/"/g, '').trim();
        const firstName = record[2]?.replace(/"/g, '').trim();
        const lastName = record[3]?.replace(/"/g, '').trim();
        // CSV column order: LICENCE, CLUB, PRENOM, NOM, LIBRE, BANDE, 3 BANDES, BLACKBALL, CADRE, JOUEUR_ID, ACTIF
        //                      0       1      2      3     4      5        6         7        8        9       10
        const rankLibre = record[4]?.replace(/"/g, '').trim() || 'NC';
        const rankBande = record[5]?.replace(/"/g, '').trim() || 'NC';
        const rank3Bandes = record[6]?.replace(/"/g, '').trim() || 'NC';
        // record[7] = BLACKBALL (not used)
        const rankCadre = record[8]?.replace(/"/g, '').trim() || 'NC';
        const isActive = record[10]?.replace(/"/g, '').trim() === '1' ? 1 : 0;

        if (!licence || !firstName || !lastName) continue;

        if (rankingsOnly) {
          // Only update rankings for existing players
          const changes = await new Promise((resolve, reject) => {
            db.run(`
              UPDATE players SET
                rank_libre = $1,
                rank_cadre = $2,
                rank_bande = $3,
                rank_3bandes = $4
              WHERE REPLACE(licence, ' ', '') = REPLACE($5, ' ', '')
            `, [rankLibre, rankCadre, rankBande, rank3Bandes, licence], function(err) {
              if (err) {
                reject(err);
              } else {
                resolve(this.changes);
              }
            });
          });

          if (changes > 0) {
            updated++;
          } else {
            skipped++; // Player not found in database
            notFound.push({
              licence: licence,
              name: `${firstName} ${lastName}`,
              club: club || '',
              rank_libre: rankLibre,
              rank_cadre: rankCadre,
              rank_bande: rankBande,
              rank_3bandes: rank3Bandes
            });
          }
        } else {
          // Full import: check if player exists (with space-normalized licence matching)
          const existingPlayer = await new Promise((resolve, reject) => {
            db.get(`
              SELECT licence FROM players
              WHERE REPLACE(licence, ' ', '') = REPLACE($1, ' ', '')
            `, [licence], (err, row) => {
              if (err) reject(err);
              else resolve(row);
            });
          });

          if (existingPlayer) {
            // Update existing player (using normalized licence match)
            await new Promise((resolve, reject) => {
              db.run(`
                UPDATE players SET
                  club = $1,
                  first_name = $2,
                  last_name = $3,
                  rank_libre = $4,
                  rank_cadre = $5,
                  rank_bande = $6,
                  rank_3bandes = $7,
                  is_active = $8
                WHERE REPLACE(licence, ' ', '') = REPLACE($9, ' ', '')
              `, [club, firstName, lastName, rankLibre, rankCadre, rankBande, rank3Bandes, isActive, licence], function(err) {
                if (err) reject(err);
                else resolve(this.changes);
              });
            });
            updated++;
          } else {
            // Insert new player
            await new Promise((resolve, reject) => {
              db.run(`
                INSERT INTO players (licence, club, first_name, last_name, rank_libre, rank_cadre, rank_bande, rank_3bandes, is_active)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
              `, [licence, club, firstName, lastName, rankLibre, rankCadre, rankBande, rank3Bandes, isActive], function(err) {
                if (err) reject(err);
                else resolve(this.changes);
              });
            });
            imported++;
          }
        }
      } catch (err) {
        errors.push({ record: record[0], error: err.message });
      }
    }

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    // Record import in history
    db.run(`
      INSERT INTO import_history (file_type, record_count, filename, imported_by)
      VALUES ($1, $2, $3, $4)
    `, [rankingsOnly ? 'joueurs_rankings' : 'joueurs', records.length, req.file.originalname, req.user?.username || 'unknown'], (histErr) => {
      if (histErr) console.error('Error recording import history:', histErr);
    });

    if (rankingsOnly) {
      res.json({
        message: 'Rankings update completed',
        updated,
        skipped,
        notFound: notFound.length > 0 ? notFound : undefined,
        errors: errors.length > 0 ? errors : undefined
      });
    } else {
      res.json({
        message: 'Import completed',
        imported,
        updated,
        errors: errors.length > 0 ? errors : undefined
      });
    }

  } catch (error) {
    // Clean up uploaded file
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Import error:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: 'Erreur lors de l\'import du fichier' });
  }
});

// Create a new player
router.post('/', authenticateToken, async (req, res) => {
  const {
    licence,
    first_name,
    last_name,
    club,
    email,
    phone,
    rank_libre,
    rank_cadre,
    rank_bande,
    rank_3bandes,
    player_app_role,
    player_app_user,
    is_active
  } = req.body;

  if (!licence || !first_name || !last_name) {
    return res.status(400).json({ error: 'Licence, prénom et nom sont obligatoires' });
  }

  const normalizedLicence = licence.replace(/\s+/g, '').toUpperCase();

  try {
    // Check if licence already exists
    const existing = await new Promise((resolve, reject) => {
      db.get('SELECT licence FROM players WHERE REPLACE(licence, \' \', \'\') = $1', [normalizedLicence], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (existing) {
      return res.status(409).json({ error: 'Un joueur avec cette licence existe déjà' });
    }

    // Insert new player
    await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO players (licence, first_name, last_name, club, email, telephone, rank_libre, rank_cadre, rank_bande, rank_3bandes, player_app_role, player_app_user, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        normalizedLicence,
        first_name,
        last_name.toUpperCase(),
        club || null,
        email || null,
        phone || null,
        rank_libre || 'NC',
        rank_cadre || 'NC',
        rank_bande || 'NC',
        rank_3bandes || 'NC',
        player_app_role || null,
        player_app_user ? true : false,
        is_active !== false ? 1 : 0
      ], function(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });

    console.log(`Player created: ${normalizedLicence} - ${first_name} ${last_name}`);
    res.status(201).json({ success: true, licence: normalizedLicence });
  } catch (error) {
    console.error('Create player error:', error);
    res.status(500).json({ error: error.message });
  }
});
// Get all players (or filter by active status)
router.get('/', authenticateToken, (req, res) => {
  const { active } = req.query;

  // GDPR consent can come from either players table (admin set) or player_accounts (registration)
  // Use COALESCE to show consent from either source
  let query = `
    SELECT p.*,
      COALESCE(p.gdpr_consent_date, pa.gdpr_consent_date) as gdpr_consent_date,
      COALESCE(p.gdpr_consent_version, pa.gdpr_consent_version) as gdpr_consent_version
    FROM players p
    LEFT JOIN player_accounts pa ON REPLACE(p.licence, ' ', '') = REPLACE(pa.licence, ' ', '')
  `;
  const params = [];

  if (active === 'true') {
    query += ' WHERE p.is_active = 1';
  } else if (active === 'false') {
    query += ' WHERE p.is_active = 0';
  }

  query += ' ORDER BY p.last_name, p.first_name';

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
router.put('/:licence', authenticateToken, async (req, res) => {
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
  if (req.body.player_app_role !== undefined) {
    updates.push('player_app_role = ?');
    // Allow null, 'joueur', or 'admin'
    const role = req.body.player_app_role;
    values.push(role === '' || role === null ? null : role);
  }
  if (req.body.player_app_user !== undefined) {
    updates.push('player_app_user = ?');
    values.push(req.body.player_app_user ? true : false);
  }
  // Handle GDPR consent - store directly in players table
  if (req.body.gdpr_consent !== undefined) {
    if (req.body.gdpr_consent) {
      updates.push('gdpr_consent_date = NOW()');
      updates.push("gdpr_consent_version = '1.0'");
    } else {
      updates.push('gdpr_consent_date = NULL');
      updates.push('gdpr_consent_version = NULL');
    }
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

// Get player account info (for Player App)
router.get('/:licence/account', authenticateToken, (req, res) => {
  const licence = req.params.licence.replace(/\s+/g, '');

  db.get(
    `SELECT id, email, is_admin, last_login, created_at, gdpr_consent_date, gdpr_consent_version
     FROM player_accounts
     WHERE REPLACE(licence, ' ', '') = $1`,
    [licence],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (!row) {
        return res.json({ hasAccount: false, account: null });
      }
      res.json({
        hasAccount: true,
        email: row.email,
        isAdmin: row.is_admin,
        lastLogin: row.last_login,
        createdAt: row.created_at,
        gdpr_consent_date: row.gdpr_consent_date,
        gdpr_consent_version: row.gdpr_consent_version
      });
    }
  );
});

// Reset player account password (admin only)
router.post('/:licence/reset-password', authenticateToken, async (req, res) => {
  const licence = req.params.licence.replace(/\s+/g, '');
  const { newPassword } = req.body;

  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
  }

  try {
    // Check if account exists
    const account = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id FROM player_accounts WHERE REPLACE(licence, ' ', '') = $1`,
        [licence],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!account) {
      return res.status(404).json({ error: 'Ce joueur n\'a pas de compte Player App' });
    }

    // Hash the new password
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update password
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE player_accounts SET password_hash = $1 WHERE id = $2`,
        [passwordHash, account.id],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });

    res.json({ success: true, message: 'Mot de passe réinitialisé' });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Batch: Populate players email/telephone from inscriptions
router.post('/batch/populate-from-inscriptions', authenticateToken, async (req, res) => {
  try {
    // Update emails from most recent inscriptions
    const emailResult = await new Promise((resolve, reject) => {
      db.run(`
        UPDATE players p
        SET email = i.email
        FROM (
          SELECT DISTINCT ON (REPLACE(licence, ' ', ''))
            REPLACE(licence, ' ', '') as clean_licence,
            email
          FROM inscriptions
          WHERE email IS NOT NULL AND email != ''
          ORDER BY REPLACE(licence, ' ', ''), timestamp DESC
        ) i
        WHERE REPLACE(p.licence, ' ', '') = i.clean_licence
          AND (p.email IS NULL OR p.email = '')
      `, [], function(err) {
        if (err) reject(err);
        else resolve(this.changes || 0);
      });
    });

    // Update telephones from most recent inscriptions
    const phoneResult = await new Promise((resolve, reject) => {
      db.run(`
        UPDATE players p
        SET telephone = i.telephone
        FROM (
          SELECT DISTINCT ON (REPLACE(licence, ' ', ''))
            REPLACE(licence, ' ', '') as clean_licence,
            telephone
          FROM inscriptions
          WHERE telephone IS NOT NULL AND telephone != ''
          ORDER BY REPLACE(licence, ' ', ''), timestamp DESC
        ) i
        WHERE REPLACE(p.licence, ' ', '') = i.clean_licence
          AND (p.telephone IS NULL OR p.telephone = '')
      `, [], function(err) {
        if (err) reject(err);
        else resolve(this.changes || 0);
      });
    });

    res.json({
      success: true,
      emailsUpdated: emailResult,
      phonesUpdated: phoneResult,
      message: `${emailResult} emails et ${phoneResult} telephones mis a jour`
    });

  } catch (error) {
    console.error('Batch populate error:', error);
    res.status(500).json({ error: error.message });
  }
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

// Fix duplicate player licence - delete wrong one and update tournament results
router.post('/fix-duplicate-licence', authenticateToken, async (req, res) => {
  const { wrongLicence, correctLicence } = req.body;

  if (!wrongLicence || !correctLicence) {
    return res.status(400).json({ error: 'wrongLicence and correctLicence are required' });
  }

  try {
    // Update tournament_results to use correct licence
    const updateResult = await new Promise((resolve, reject) => {
      db.run(
        `UPDATE tournament_results SET licence = $1 WHERE REPLACE(licence, ' ', '') = REPLACE($2, ' ', '')`,
        [correctLicence, wrongLicence],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });

    // Delete the duplicate player
    const deleteResult = await new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM players WHERE REPLACE(licence, ' ', '') = REPLACE($1, ' ', '')`,
        [wrongLicence],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });

    res.json({
      success: true,
      message: `Fixed: updated ${updateResult} tournament results, deleted ${deleteResult} duplicate player`,
      updatedResults: updateResult,
      deletedPlayers: deleteResult
    });
  } catch (error) {
    console.error('Error fixing duplicate licence:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
