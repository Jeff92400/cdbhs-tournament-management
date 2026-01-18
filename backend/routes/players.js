const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse');
const fs = require('fs');
const db = require('../db-loader');
const { authenticateToken } = require('./auth');

const router = express.Router();

/**
 * Normalize a club name to its canonical form from the clubs table
 * Uses club_aliases for lookup, falls back to exact match in clubs table
 * @param {string} rawClubName - Raw club name from import
 * @returns {Promise<string>} - Canonical club name or original if not found
 */
async function normalizeClubName(rawClubName) {
  if (!rawClubName) return rawClubName;

  // Normalize for comparison: remove spaces, dots, hyphens, uppercase
  const normalized = rawClubName.toUpperCase().replace(/[\s.\-]/g, '');

  return new Promise((resolve, reject) => {
    // First try to find via club_aliases
    db.get(
      `SELECT ca.canonical_name
       FROM club_aliases ca
       INNER JOIN clubs c ON ca.canonical_name = c.name
       WHERE UPPER(REPLACE(REPLACE(REPLACE(ca.alias, ' ', ''), '.', ''), '-', '')) = $1
       LIMIT 1`,
      [normalized],
      (err, row) => {
        if (err) {
          console.error('Error looking up club alias:', err);
          resolve(rawClubName); // Fallback to original
        } else if (row) {
          resolve(row.canonical_name);
        } else {
          // No alias found, try direct match in clubs table
          db.get(
            `SELECT name FROM clubs
             WHERE UPPER(REPLACE(REPLACE(REPLACE(name, ' ', ''), '.', ''), '-', '')) = $1
             LIMIT 1`,
            [normalized],
            (err2, row2) => {
              if (err2 || !row2) {
                resolve(rawClubName); // No match, keep original
              } else {
                resolve(row2.name);
              }
            }
          );
        }
      }
    );
  });
}

/**
 * Load game modes with rank_column mapping from database
 * Returns object: { 'LIBRE': 'rank_libre', 'BANDE': 'rank_bande', ... }
 */
async function loadGameModeRankColumns() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT code, display_name, rank_column FROM game_modes WHERE rank_column IS NOT NULL`,
      [],
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const mapping = {};
          (rows || []).forEach(row => {
            // Map by code (normalized) and display_name for flexibility
            const normalizedCode = row.code.toUpperCase().replace(/\s+/g, '');
            mapping[normalizedCode] = row.rank_column;
            mapping[row.display_name.toUpperCase()] = row.rank_column;
          });
          resolve(mapping);
        }
      }
    );
  });
}

/**
 * Get all active game modes from database
 * Returns array: [{ id, code, display_name, color, display_order }, ...]
 */
async function getAllGameModes() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, code, display_name, color, display_order
       FROM game_modes
       WHERE is_active = true
       ORDER BY display_order`,
      [],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

/**
 * Get player rankings from player_rankings table
 * Returns object keyed by game_mode_id: { 1: { ranking: 'R1', code: 'LIBRE', display_name: 'Libre' }, ... }
 */
async function getPlayerRankings(licence) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT pr.game_mode_id, pr.ranking, gm.code, gm.display_name, gm.color
       FROM player_rankings pr
       JOIN game_modes gm ON pr.game_mode_id = gm.id
       WHERE REPLACE(pr.licence, ' ', '') = REPLACE($1, ' ', '')`,
      [licence],
      (err, rows) => {
        if (err) reject(err);
        else {
          const rankings = {};
          (rows || []).forEach(row => {
            rankings[row.game_mode_id] = {
              ranking: row.ranking,
              code: row.code,
              display_name: row.display_name,
              color: row.color
            };
          });
          resolve(rankings);
        }
      }
    );
  });
}

/**
 * Save player rankings to player_rankings table
 * @param {string} licence - Player licence
 * @param {object} rankings - Object keyed by game_mode_id: { 1: 'R1', 2: 'NC', ... }
 */
async function savePlayerRankings(licence, rankings) {
  const normalizedLicence = licence.replace(/\s+/g, '');

  for (const [gameModeId, ranking] of Object.entries(rankings)) {
    // Skip if not a valid game mode ID (number)
    if (!gameModeId || isNaN(parseInt(gameModeId))) continue;

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO player_rankings (licence, game_mode_id, ranking, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (licence, game_mode_id)
         DO UPDATE SET ranking = $3, updated_at = CURRENT_TIMESTAMP`,
        [normalizedLicence, parseInt(gameModeId), ranking || null],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }
}

/**
 * CSV column mapping for FFB export format
 * Maps CSV column index to game mode code
 */
const CSV_COLUMN_TO_MODE = {
  4: 'LIBRE',
  5: 'BANDE',
  6: '3BANDES',
  8: 'CADRE'
};

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

    // Load game mode rank column mappings dynamically
    const rankColumnMap = await loadGameModeRankColumns();

    // Process records using PostgreSQL ON CONFLICT
    for (const record of records) {
      try {
        // Parse CSV format: "licence","club","first_name","last_name","libre","cadre","bande","3bandes","?","?","active"
        if (record.length < 11) continue;

        const licence = record[0]?.replace(/"/g, '').replace(/\s+/g, '').trim();

        // Skip header row (detect by checking if first column looks like a header)
        if (licence.toUpperCase() === 'LICENCE' || licence.toUpperCase() === 'LICENSE') continue;
        const rawClub = record[1]?.replace(/"/g, '').trim();
        const club = await normalizeClubName(rawClub); // Normalize to canonical name from clubs table
        const firstName = record[2]?.replace(/"/g, '').trim();
        const lastName = record[3]?.replace(/"/g, '').trim();
        const isActive = record[10]?.replace(/"/g, '').trim() === '1' ? 1 : 0;

        // Extract rankings from CSV using dynamic column mapping
        // CSV column order: LICENCE, CLUB, PRENOM, NOM, LIBRE, BANDE, 3 BANDES, BLACKBALL, CADRE, JOUEUR_ID, ACTIF
        //                      0       1      2      3     4      5        6         7        8        9       10
        const csvRankings = {};
        for (const [colIndex, modeCode] of Object.entries(CSV_COLUMN_TO_MODE)) {
          const value = record[parseInt(colIndex)]?.replace(/"/g, '').trim() || 'NC';
          const rankColumn = rankColumnMap[modeCode];
          if (rankColumn) {
            csvRankings[rankColumn] = value;
          }
        }

        if (!licence || !firstName || !lastName) continue;

        if (rankingsOnly) {
          // Only update rankings for existing players - build dynamic UPDATE
          const setClauses = Object.keys(csvRankings).map((col, i) => `${col} = $${i + 1}`);
          const values = Object.values(csvRankings);
          values.push(licence);

          const changes = await new Promise((resolve, reject) => {
            db.run(`
              UPDATE players SET ${setClauses.join(', ')}
              WHERE REPLACE(licence, ' ', '') = REPLACE($${values.length}, ' ', '')
            `, values, function(err) {
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
            const notFoundEntry = {
              licence: licence,
              name: `${firstName} ${lastName}`,
              club: club || ''
            };
            // Add rankings dynamically
            Object.entries(csvRankings).forEach(([col, val]) => {
              notFoundEntry[col] = val;
            });
            notFound.push(notFoundEntry);
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
            // Update existing player - build dynamic UPDATE
            const rankCols = Object.keys(csvRankings);
            const baseValues = [club, firstName, lastName];
            const rankValues = Object.values(csvRankings);
            const allValues = [...baseValues, ...rankValues, isActive, licence];

            const rankSetClauses = rankCols.map((col, i) => `${col} = $${4 + i}`);

            await new Promise((resolve, reject) => {
              db.run(`
                UPDATE players SET
                  club = $1,
                  first_name = $2,
                  last_name = $3,
                  ${rankSetClauses.join(', ')},
                  is_active = $${4 + rankCols.length}
                WHERE REPLACE(licence, ' ', '') = REPLACE($${5 + rankCols.length}, ' ', '')
              `, allValues, function(err) {
                if (err) reject(err);
                else resolve(this.changes);
              });
            });
            updated++;
          } else {
            // Insert new player - build dynamic INSERT
            const rankCols = Object.keys(csvRankings);
            const rankValues = Object.values(csvRankings);
            const allCols = ['licence', 'club', 'first_name', 'last_name', ...rankCols, 'is_active'];
            const allValues = [licence, club, firstName, lastName, ...rankValues, isActive];
            const placeholders = allValues.map((_, i) => `$${i + 1}`);

            await new Promise((resolve, reject) => {
              db.run(`
                INSERT INTO players (${allCols.join(', ')})
                VALUES (${placeholders.join(', ')})
              `, allValues, function(err) {
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
    player_rankings: newPlayerRankings,  // New format: { game_mode_id: 'ranking_value', ... }
    rankings, // Old dynamic format: { rank_libre: 'value', ... }
    rank_libre, // Legacy support
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

    // Get all game modes for building legacy columns
    const gameModes = await getAllGameModes();

    // Build rankings for legacy columns (for backward compatibility)
    const legacyRankings = {};

    if (newPlayerRankings && typeof newPlayerRankings === 'object') {
      // New format: keyed by game_mode_id
      for (const mode of gameModes) {
        const ranking = newPlayerRankings[mode.id] || 'NC';
        const rankColumn = `rank_${mode.code.toLowerCase().replace(/\s+/g, '')}`;
        // Only set if it's one of the 4 original columns
        if (['rank_libre', 'rank_cadre', 'rank_bande', 'rank_3bandes'].includes(rankColumn)) {
          legacyRankings[rankColumn] = ranking;
        }
      }
    } else if (rankings && typeof rankings === 'object') {
      // Old dynamic format
      const rankColumnMap = await loadGameModeRankColumns();
      const validRankColumns = Object.values(rankColumnMap);
      for (const [col, val] of Object.entries(rankings)) {
        if (validRankColumns.includes(col)) {
          legacyRankings[col] = val || 'NC';
        }
      }
    } else {
      // Legacy format - individual fields
      if (rank_libre !== undefined) legacyRankings.rank_libre = rank_libre || 'NC';
      if (rank_cadre !== undefined) legacyRankings.rank_cadre = rank_cadre || 'NC';
      if (rank_bande !== undefined) legacyRankings.rank_bande = rank_bande || 'NC';
      if (rank_3bandes !== undefined) legacyRankings.rank_3bandes = rank_3bandes || 'NC';
    }

    // Set default NC for any missing legacy rank columns
    ['rank_libre', 'rank_cadre', 'rank_bande', 'rank_3bandes'].forEach(col => {
      if (!legacyRankings[col]) {
        legacyRankings[col] = 'NC';
      }
    });

    // Normalize club name to canonical form from clubs table
    const normalizedClub = club ? await normalizeClubName(club) : null;

    // Build INSERT for players table
    const baseCols = ['licence', 'first_name', 'last_name', 'club', 'email', 'telephone'];
    const baseValues = [
      normalizedLicence,
      first_name,
      last_name.toUpperCase(),
      normalizedClub,
      email || null,
      phone || null
    ];

    const rankCols = Object.keys(legacyRankings);
    const rankValues = Object.values(legacyRankings);

    const endCols = ['player_app_role', 'player_app_user', 'is_active'];
    const endValues = [
      player_app_role || null,
      player_app_user ? true : false,
      is_active !== false ? 1 : 0
    ];

    const allCols = [...baseCols, ...rankCols, ...endCols];
    const allValues = [...baseValues, ...rankValues, ...endValues];
    const placeholders = allValues.map((_, i) => `$${i + 1}`);

    await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO players (${allCols.join(', ')})
        VALUES (${placeholders.join(', ')})
      `, allValues, function(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });

    // Also save to player_rankings table
    if (newPlayerRankings && typeof newPlayerRankings === 'object') {
      // New format: save directly
      await savePlayerRankings(normalizedLicence, newPlayerRankings);
    } else {
      // Build player_rankings from legacy data
      const rankingsToSave = {};
      for (const mode of gameModes) {
        const rankColumn = `rank_${mode.code.toLowerCase().replace(/\s+/g, '')}`;
        if (legacyRankings[rankColumn]) {
          rankingsToSave[mode.id] = legacyRankings[rankColumn];
        }
      }
      if (Object.keys(rankingsToSave).length > 0) {
        await savePlayerRankings(normalizedLicence, rankingsToSave);
      }
    }

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

// Note: Duplicate POST route removed - use the main POST / endpoint above

// Find duplicate players (same first_name + last_name)
// MUST be before /:licence route to avoid being caught by it
router.get('/duplicates', authenticateToken, async (req, res) => {
  try {
    const duplicates = await new Promise((resolve, reject) => {
      db.all(`
        SELECT UPPER(first_name) as first_name, UPPER(last_name) as last_name,
               COUNT(*) as count,
               STRING_AGG(licence, ', ') as licences
        FROM players
        GROUP BY UPPER(first_name), UPPER(last_name)
        HAVING COUNT(*) > 1
        ORDER BY last_name, first_name
      `, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    res.json({
      count: duplicates.length,
      duplicates: duplicates
    });
  } catch (error) {
    console.error('Error finding duplicates:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get player by licence
router.get('/:licence', authenticateToken, async (req, res) => {
  try {
    const player = await new Promise((resolve, reject) => {
      db.get("SELECT * FROM players WHERE REPLACE(licence, ' ', '') = REPLACE($1, ' ', '')", [req.params.licence], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    // Get rankings from player_rankings table
    const rankings = await getPlayerRankings(req.params.licence);

    // Return player with rankings from new table
    res.json({
      ...player,
      player_rankings: rankings  // New format: { game_mode_id: { ranking, code, display_name, color } }
    });
  } catch (err) {
    console.error('Get player error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update player (all fields)
router.put('/:licence', authenticateToken, async (req, res) => {
  const { licence } = req.params;
  const {
    club, first_name, last_name, is_active,
    player_rankings: newPlayerRankings,  // New format: { game_mode_id: 'ranking_value', ... }
    rankings, rank_libre, rank_cadre, rank_bande, rank_3bandes  // Legacy support
  } = req.body;

  try {
    // Build dynamic UPDATE query based on provided fields
    const updates = [];
    const values = [];

    if (club !== undefined) {
      // Normalize club name to canonical form from clubs table
      const normalizedClub = club ? await normalizeClubName(club) : null;
      updates.push('club = ?');
      values.push(normalizedClub);
    }
    if (first_name !== undefined) {
      updates.push('first_name = ?');
      values.push(first_name);
    }
    if (last_name !== undefined) {
      updates.push('last_name = ?');
      values.push(last_name);
    }

    // Handle new player_rankings format (from dynamic form)
    if (newPlayerRankings && typeof newPlayerRankings === 'object') {
      // Save to player_rankings table
      await savePlayerRankings(licence, newPlayerRankings);

      // Also update legacy columns for backward compatibility
      const gameModes = await getAllGameModes();
      for (const mode of gameModes) {
        const ranking = newPlayerRankings[mode.id];
        if (ranking !== undefined) {
          const rankColumn = `rank_${mode.code.toLowerCase().replace(/\s+/g, '')}`;
          // Only update if column exists (for the 4 original modes)
          if (['rank_libre', 'rank_cadre', 'rank_bande', 'rank_3bandes'].includes(rankColumn)) {
            updates.push(`${rankColumn} = ?`);
            values.push(ranking || null);
          }
        }
      }
    } else if (rankings && typeof rankings === 'object') {
      // Old dynamic format (keyed by column name)
      const rankColumnMap = await loadGameModeRankColumns();
      const validRankColumns = Object.values(rankColumnMap);
      for (const [col, val] of Object.entries(rankings)) {
        if (validRankColumns.includes(col)) {
          updates.push(`${col} = ?`);
          values.push(val || null);
        }
      }
    } else {
      // Legacy format support (individual rank fields)
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

    // If only player_rankings was provided and no other updates, still return success
    if (updates.length === 0 && newPlayerRankings) {
      return res.json({ success: true, message: 'Player rankings updated successfully' });
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
  } catch (error) {
    console.error('Update player error:', error);
    res.status(500).json({ error: error.message });
  }
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

    // Delete rankings for the wrong licence first (foreign key constraint)
    const deleteRankings = await new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM rankings WHERE REPLACE(licence, ' ', '') = REPLACE($1, ' ', '')`,
        [wrongLicence],
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
      message: `Fixed: updated ${updateResult} tournament results, deleted ${deleteRankings} rankings, deleted ${deleteResult} duplicate player`,
      updatedResults: updateResult,
      deletedRankings: deleteRankings,
      deletedPlayers: deleteResult
    });
  } catch (error) {
    console.error('Error fixing duplicate licence:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
