const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { Resend } = require('resend');
const db = require('../db-loader');
const { authenticateToken } = require('./auth');
const appSettings = require('../utils/app-settings');
const { logAdminAction, ACTION_TYPES } = require('../utils/admin-logger');
const { getColumnMapping } = require('./import-config');

/**
 * Default column mapping for inscriptions imports (named columns)
 * Used when no import profile is configured
 */
const DEFAULT_INSCRIPTIONS_MAPPING = {
  inscription_id: { column: 'INSCRIPTION_ID', type: 'number' },
  tournoi_id: { column: 'TOURNOI_ID', type: 'number' },
  licence: { column: 'LICENCE', type: 'string' },
  joueur_id: { column: 'JOUEUR_ID', type: 'number' },
  email: { column: 'EMAIL', type: 'string' },
  telephone: { column: 'TELEPHONE', type: 'string' },
  timestamp: { column: 'TIMESTAMP', type: 'string' },
  convoque: { column: 'CONVOQUE', type: 'number' },
  forfait: { column: 'FORFAIT', type: 'number' },
  commentaire: { column: 'COMMENTAIRE', type: 'string' }
};

/**
 * Helper to get value from record using mapping configuration (for named columns)
 * Supports both case-insensitive column name matching and index-based mapping
 */
function getMappedValue(record, mapping, fieldName, defaultValue = null) {
  if (!mapping || !mapping[fieldName]) {
    return defaultValue;
  }

  const fieldConfig = mapping[fieldName];
  let value;

  if (typeof fieldConfig.column === 'number') {
    // Index-based mapping (for positional CSV)
    const keys = Object.keys(record);
    value = record[keys[fieldConfig.column]];
  } else {
    // Named column mapping - try exact match first, then case-insensitive
    const colName = fieldConfig.column;
    value = record[colName] || record[colName.toLowerCase()] || record[colName.toUpperCase()];

    // If still not found, try case-insensitive search
    if (value === undefined) {
      const lowerColName = colName.toLowerCase();
      for (const key of Object.keys(record)) {
        if (key.toLowerCase() === lowerColName) {
          value = record[key];
          break;
        }
      }
    }
  }

  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  // Clean string values
  if (typeof value === 'string') {
    value = value.trim();
  }

  // Apply type conversion
  if (fieldConfig.type === 'number') {
    const num = parseInt(value);
    return isNaN(num) ? defaultValue : num;
  } else if (fieldConfig.type === 'decimal') {
    const num = parseFloat(String(value).replace(',', '.'));
    return isNaN(num) ? defaultValue : num;
  } else if (fieldConfig.type === 'boolean') {
    return value === '1' || value === 1 || String(value).toLowerCase() === 'true';
  }

  return value || defaultValue;
}

// Initialize Resend for email notifications
const getResend = () => {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
};

const router = express.Router();

// Configure multer for file uploads with security restrictions
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max
  },
  fileFilter: (req, file, cb) => {
    // Only allow CSV files
    const allowedExtensions = ['.csv'];
    const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Seuls les fichiers CSV sont acceptés'), false);
    }
  }
});

// Helper function to parse date in DD/MM/YYYY format
function parseDate(dateStr) {
  if (!dateStr || dateStr === 'NULL' || dateStr === '') return null;

  // Check if it's DD/MM/YYYY format
  const ddmmyyyy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const [, day, month, year] = ddmmyyyy;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // Check if it's already YYYY-MM-DD
  if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return dateStr;
  }

  return null;
}

// Helper function to parse datetime in DD/MM/YYYY HH:MM format
function parseDateTime(dateTimeStr) {
  if (!dateTimeStr || dateTimeStr === 'NULL' || dateTimeStr === '') return null;

  // Check if it's DD/MM/YYYY HH:MM format
  const match = dateTimeStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    const [, day, month, year, hour, minute, second = '00'] = match;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute}:${second}`;
  }

  // Return as-is if already in ISO format
  return dateTimeStr;
}

// Import tournoi_ext from CSV
router.post('/tournoi/import', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const fileContent = fs.readFileSync(req.file.path, 'utf-8');
    const records = [];

    // Auto-detect delimiter (semicolon or comma)
    const firstLine = fileContent.split('\n')[0];
    const delimiter = firstLine.includes(';') ? ';' : ',';

    const parser = parse(fileContent, {
      delimiter: delimiter,
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true
    });

    for await (const record of parser) {
      records.push(record);
    }

    let imported = 0;
    let updated = 0;
    let errors = [];

    for (const record of records) {
      try {
        // Map CSV columns to database fields (handle various column name formats)
        const tournoiId = parseInt(record.TOURNOI_ID || record.tournoi_id);
        const nom = record.NOM || record.nom || '';
        const mode = record.MODE || record.mode || '';
        const categorie = record.CATEGORIE || record.categorie || '';
        const taille = parseInt(record.TAILLE || record.taille) || null;
        const debut = parseDate(record.DEBUT || record.debut);
        const fin = parseDate(record.FIN || record.fin);
        const grandCoin = parseInt(record.GRAND_COIN || record.grand_coin) || 0;
        const tailleCadre = record.TAILLE_CADRE || record.taille_cadre || null;
        const lieu = record.LIEU || record.lieu || '';

        if (!tournoiId || !nom || !mode || !categorie) {
          errors.push({ tournoiId, error: 'Missing required fields' });
          continue;
        }

        const query = `
          INSERT INTO tournoi_ext (tournoi_id, nom, mode, categorie, taille, debut, fin, grand_coin, taille_cadre, lieu)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT(tournoi_id) DO UPDATE SET
            nom = EXCLUDED.nom,
            mode = EXCLUDED.mode,
            categorie = EXCLUDED.categorie,
            taille = EXCLUDED.taille,
            debut = EXCLUDED.debut,
            fin = EXCLUDED.fin,
            grand_coin = EXCLUDED.grand_coin,
            taille_cadre = EXCLUDED.taille_cadre,
            lieu = EXCLUDED.lieu
        `;

        await new Promise((resolve, reject) => {
          db.run(query, [tournoiId, nom, mode, categorie, taille, debut || null, fin || null, grandCoin, tailleCadre, lieu], function(err) {
            if (err) {
              reject(err);
            } else {
              if (this.changes > 0) updated++;
              else imported++;
              resolve();
            }
          });
        });
        imported++;
      } catch (err) {
        errors.push({ record: record.TOURNOI_ID || record.tournoi_id, error: err.message });
      }
    }

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    // Record import in history
    const historyQuery = `
      INSERT INTO import_history (file_type, record_count, filename, imported_by)
      VALUES ($1, $2, $3, $4)
    `;
    db.run(historyQuery, ['tournois', records.length, req.file.originalname, req.user?.username || 'unknown'], (err) => {
      if (err) console.error('Error recording import history:', err);
    });

    res.json({
      message: 'Import completed',
      imported,
      updated,
      total: records.length,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: error.message });
  }
});

// Import inscriptions from CSV
router.post('/import', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    // Load configurable column mapping, fall back to defaults
    let columnMapping;
    try {
      const profileConfig = await getColumnMapping('inscriptions');
      columnMapping = profileConfig?.mappings || DEFAULT_INSCRIPTIONS_MAPPING;
      console.log(`Using ${profileConfig ? 'configured' : 'default'} column mapping for inscriptions import`);
    } catch (err) {
      console.log('Error loading inscriptions column mapping, using defaults:', err.message);
      columnMapping = DEFAULT_INSCRIPTIONS_MAPPING;
    }

    const fileContent = fs.readFileSync(req.file.path, 'utf-8');
    const records = [];

    // Auto-detect delimiter (semicolon or comma)
    const firstLine = fileContent.split('\n')[0];
    const delimiter = firstLine.includes(';') ? ';' : ',';

    const parser = parse(fileContent, {
      delimiter: delimiter,
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true
    });

    for await (const record of parser) {
      records.push(record);
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let skippedDetails = [];
    let errors = [];
    let seasonImported = 0;

    // Get current season (Sept-Aug cycle)
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-11
    const currentSeason = currentMonth >= 8
      ? `${currentYear}-${currentYear + 1}`
      : `${currentYear - 1}-${currentYear}`;

    // Pre-fetch all tournaments to determine season
    const tournoiMap = await new Promise((resolve, reject) => {
      db.all('SELECT tournoi_id, debut FROM tournoi_ext', [], (err, rows) => {
        if (err) reject(err);
        else {
          const map = {};
          rows.forEach(t => { map[t.tournoi_id] = t; });
          resolve(map);
        }
      });
    });

    // Helper to get season for a tournament
    const getSeasonForTournoi = (tournoiId) => {
      const tournoi = tournoiMap[tournoiId];
      if (!tournoi || !tournoi.debut) return null;
      const date = new Date(tournoi.debut);
      const year = date.getFullYear();
      const month = date.getMonth();
      return month >= 8 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
    };

    // Track last generated ID for collision handling within this import session
    let lastGeneratedId = 0;

    for (const record of records) {
      try {
        // Map CSV columns to database fields using configurable mapping
        const inscriptionId = getMappedValue(record, columnMapping, 'inscription_id', null);
        const joueurId = getMappedValue(record, columnMapping, 'joueur_id', null);
        const tournoiId = getMappedValue(record, columnMapping, 'tournoi_id', null);
        const timestampRaw = getMappedValue(record, columnMapping, 'timestamp', null);
        const timestamp = parseDateTime(timestampRaw);
        const email = getMappedValue(record, columnMapping, 'email', '');
        const telephone = getMappedValue(record, columnMapping, 'telephone', '');
        const licenceRaw = getMappedValue(record, columnMapping, 'licence', '');
        const licence = licenceRaw ? licenceRaw.replace(/\s+/g, '').trim() : '';
        const convoque = getMappedValue(record, columnMapping, 'convoque', 0);
        const forfait = getMappedValue(record, columnMapping, 'forfait', 0);
        const commentaire = getMappedValue(record, columnMapping, 'commentaire', '');

        if (!inscriptionId || !tournoiId) {
          errors.push({ inscriptionId, error: 'Missing required fields' });
          continue;
        }

        // Check if an inscription already exists for this licence + tournament
        const existingInscription = await new Promise((resolve, reject) => {
          db.get(
            `SELECT i.inscription_id, i.source, t.nom as tournoi_nom, p.last_name as player_nom, p.first_name as player_prenom
             FROM inscriptions i
             LEFT JOIN tournoi_ext t ON i.tournoi_id = t.tournoi_id
             LEFT JOIN players p ON REPLACE(UPPER(p.licence), ' ', '') = REPLACE(UPPER(i.licence), ' ', '')
             WHERE REPLACE(UPPER(i.licence), ' ', '') = REPLACE(UPPER($1), ' ', '')
             AND i.tournoi_id = $2`,
            [licence, tournoiId],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });

        // Check if inscription_id already exists for a DIFFERENT licence/tournament (ID collision)
        const idCollision = await new Promise((resolve, reject) => {
          db.get(
            `SELECT inscription_id, licence, tournoi_id, source FROM inscriptions WHERE inscription_id = $1`,
            [inscriptionId],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });

        if (idCollision && (!existingInscription || idCollision.inscription_id !== existingInscription.inscription_id)) {
          // inscription_id exists but for a different licence/tournament - this is an ID collision from IONOS
          console.warn(`[IONOS Import] ID collision detected: inscription_id=${inscriptionId} already used for licence=${idCollision.licence}, tournoi=${idCollision.tournoi_id}. New record: licence=${licence}, tournoi=${tournoiId}`);

          // Update the existing record if it's from IONOS, otherwise skip
          if (idCollision.source === 'ionos') {
            // IONOS reassigned this ID - update the existing record with new data
            console.log(`[IONOS Import] Updating ID collision record (source=ionos): ${inscriptionId}`);
            const updateCollisionQuery = `
              UPDATE inscriptions SET
                joueur_id = $1,
                tournoi_id = $2,
                timestamp = $3,
                email = $4,
                telephone = $5,
                licence = $6,
                convoque = $7,
                forfait = $8,
                commentaire = $9
              WHERE inscription_id = $10
            `;
            await new Promise((resolve, reject) => {
              db.run(updateCollisionQuery, [joueurId, tournoiId, timestamp, email, telephone, licence, convoque, forfait, commentaire, inscriptionId], function(err) {
                if (err) reject(err);
                else resolve();
              });
            });
            updated++;
          } else {
            // ID collision with protected source - insert with a new generated ID
            // Find max inscription_id and add offset to generate unique ID within INTEGER range
            const maxIdResult = await new Promise((resolve, reject) => {
              db.get(`SELECT MAX(inscription_id) as max_id FROM inscriptions`, [], (err, row) => {
                if (err) reject(err);
                else resolve(row);
              });
            });
            // Use the higher of: max from DB, or last generated in this session (for multiple collisions)
            const baseId = Math.max(maxIdResult?.max_id || 10000, lastGeneratedId);
            const newId = baseId + 1;
            lastGeneratedId = newId;
            console.log(`[IONOS Import] ID collision with protected source ${idCollision.source}, inserting with new ID: ${newId}`);
            const insertWithNewIdQuery = `
              INSERT INTO inscriptions (inscription_id, joueur_id, tournoi_id, timestamp, email, telephone, licence, convoque, forfait, commentaire, source)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ionos')
            `;
            try {
              await new Promise((resolve, reject) => {
                db.run(insertWithNewIdQuery, [newId, joueurId, tournoiId, timestamp, email, telephone, licence, convoque, forfait, commentaire], function(err) {
                  if (err) {
                    console.error(`[IONOS Import] Insert with new ID failed: ${err.message}`);
                    reject(err);
                  } else {
                    console.log(`[IONOS Import] Insert with new ID successful`);
                    resolve();
                  }
                });
              });
              imported++;
            } catch (insertErr) {
              // Unique constraint on licence+tournoi means player already registered
              if (insertErr.message && (insertErr.message.includes('unique') || insertErr.message.includes('UNIQUE') || insertErr.message.includes('duplicate'))) {
                console.warn(`[IONOS Import] Player ${licence} already registered for tournament ${tournoiId}`);
                skipped++;
              } else {
                throw insertErr;
              }
            }
          }
          continue;
        }

        if (existingInscription) {
          if (existingInscription.source === 'player_app' || existingInscription.source === 'manual') {
            // Player already registered via Player App or manually - skip IONOS import
            skipped++;
            const playerName = existingInscription.player_nom
              ? `${existingInscription.player_prenom || ''} ${existingInscription.player_nom}`.trim()
              : null;
            skippedDetails.push({
              licence,
              playerName,
              tournoiId,
              tournoiNom: existingInscription.tournoi_nom || `Tournoi ${tournoiId}`,
              source: existingInscription.source
            });
            continue;
          }

          // Existing IONOS record - update it (even if different inscription_id)
          const updateQuery = `
            UPDATE inscriptions SET
              joueur_id = $1,
              timestamp = $2,
              email = $3,
              telephone = $4,
              convoque = $5,
              forfait = GREATEST(forfait, $6),
              commentaire = $7
            WHERE inscription_id = $8
          `;
          await new Promise((resolve, reject) => {
            db.run(updateQuery, [joueurId, timestamp, email, telephone, convoque, forfait, commentaire, existingInscription.inscription_id], function(err) {
              if (err) reject(err);
              else resolve();
            });
          });
          updated++;
        } else {
          // New inscription - insert (or update if inscription_id already exists with different licence/tournoi)
          // Only update on conflict if existing record is from IONOS (protect manual and player_app)
          console.log(`[IONOS Import] Inserting new inscription: id=${inscriptionId}, licence=${licence}, tournoi=${tournoiId}`);
          const insertQuery = `
            INSERT INTO inscriptions (inscription_id, joueur_id, tournoi_id, timestamp, email, telephone, licence, convoque, forfait, commentaire, source)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ionos')
            ON CONFLICT (inscription_id) DO UPDATE SET
              joueur_id = EXCLUDED.joueur_id,
              tournoi_id = EXCLUDED.tournoi_id,
              timestamp = EXCLUDED.timestamp,
              email = EXCLUDED.email,
              telephone = EXCLUDED.telephone,
              licence = EXCLUDED.licence,
              convoque = EXCLUDED.convoque,
              forfait = GREATEST(inscriptions.forfait, EXCLUDED.forfait),
              commentaire = EXCLUDED.commentaire,
              source = 'ionos'
            WHERE inscriptions.source = 'ionos'
          `;
          try {
            await new Promise((resolve, reject) => {
              db.run(insertQuery, [inscriptionId, joueurId, tournoiId, timestamp, email, telephone, licence, convoque, forfait, commentaire], function(err) {
                if (err) {
                  console.error(`[IONOS Import] Insert failed for id=${inscriptionId}: ${err.message}`);
                  reject(err);
                } else {
                  console.log(`[IONOS Import] Insert successful for id=${inscriptionId}, changes=${this.changes}`);
                  resolve();
                }
              });
            });
            imported++;
          } catch (insertErr) {
            // Check if it's a unique constraint violation on licence+tournoi
            if (insertErr.message && insertErr.message.includes('unique') || insertErr.message.includes('UNIQUE')) {
              console.error(`[IONOS Import] Unique constraint violation for licence=${licence}, tournoi=${tournoiId}. Record may exist with different inscription_id.`);
              errors.push({ inscriptionId, licence, tournoiId, error: `Duplicate: licence ${licence} already exists for tournament ${tournoiId}` });
            } else {
              throw insertErr;
            }
          }
        }
        // Track season imports
        if (getSeasonForTournoi(tournoiId) === currentSeason) {
          seasonImported++;
        }
      } catch (err) {
        errors.push({ record: record.INSCRIPTION_ID || record.inscription_id, error: err.message });
      }
    }

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    // Record import in history
    const historyQuery = `
      INSERT INTO import_history (file_type, record_count, filename, imported_by)
      VALUES ($1, $2, $3, $4)
    `;
    db.run(historyQuery, ['inscriptions', records.length, req.file.originalname, req.user?.username || 'unknown'], (err) => {
      if (err) console.error('Error recording import history:', err);
    });

    res.json({
      message: 'Import completed',
      imported,
      updated,
      skipped,
      skippedDetails: skippedDetails.length > 0 ? skippedDetails : undefined,
      total: records.length,
      seasonImported,
      currentSeason,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: error.message });
  }
});

// DIAGNOSTIC: Find orphaned inscriptions (inscriptions whose tournoi_id doesn't match expected)
router.get('/diagnostic/n3-inscriptions', authenticateToken, async (req, res) => {
  try {
    // Get all LIBRE N3 tournaments
    const tournaments = await new Promise((resolve, reject) => {
      db.all(`
        SELECT tournoi_id, nom, mode, categorie, debut
        FROM tournoi_ext
        WHERE UPPER(mode) = 'LIBRE' AND UPPER(categorie) LIKE '%N3%'
        ORDER BY debut DESC
      `, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Get all inscriptions that might be related to N3 tournaments
    const inscriptions = await new Promise((resolve, reject) => {
      db.all(`
        SELECT i.inscription_id, i.tournoi_id, i.licence, i.forfait,
               t.nom as tournoi_nom, t.mode, t.categorie
        FROM inscriptions i
        LEFT JOIN tournoi_ext t ON i.tournoi_id = t.tournoi_id
        WHERE t.mode IS NULL
           OR (UPPER(t.mode) = 'LIBRE' AND UPPER(t.categorie) LIKE '%N3%')
        ORDER BY i.tournoi_id
      `, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    res.json({
      tournaments,
      inscriptions,
      summary: {
        tournament_count: tournaments.length,
        inscription_count: inscriptions.length,
        orphaned: inscriptions.filter(i => !i.tournoi_nom).length
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all external tournaments
router.get('/tournoi', authenticateToken, async (req, res) => {
  const { mode, categorie } = req.query;

  let query = 'SELECT * FROM tournoi_ext';
  const params = [];
  const conditions = [];

  if (mode) {
    // Use mode_mapping table to find all IONOS mode variations for this game_type
    // First, get all ionos_mode values that map to this game_type
    try {
      const mappingQuery = 'SELECT ionos_mode FROM mode_mapping WHERE game_type = $1';
      const mappingResult = await new Promise((resolve, reject) => {
        db.all(mappingQuery, [mode], (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      });

      if (mappingResult.length > 0) {
        // Match any of the mapped ionos_mode values
        const placeholders = mappingResult.map((_, i) => `$${params.length + i + 1}`).join(', ');
        conditions.push(`UPPER(mode) IN (${placeholders})`);
        mappingResult.forEach(m => params.push(m.ionos_mode.toUpperCase()));
      } else {
        // Fallback: direct matching with space removal
        conditions.push(`UPPER(REPLACE(mode, ' ', '')) = UPPER(REPLACE($${params.length + 1}, ' ', ''))`);
        params.push(mode);
      }
    } catch (err) {
      // Fallback on error
      conditions.push(`UPPER(REPLACE(mode, ' ', '')) = UPPER(REPLACE($${params.length + 1}, ' ', ''))`);
      params.push(mode);
    }
  }
  if (categorie) {
    // Use category_mapping table to find all IONOS category variations
    try {
      const catMappingQuery = mode
        ? 'SELECT DISTINCT ionos_categorie FROM category_mapping WHERE UPPER(ionos_categorie) = UPPER($1) OR category_id IN (SELECT category_id FROM category_mapping WHERE UPPER(ionos_categorie) = UPPER($1) AND UPPER(game_type) = UPPER($2))'
        : 'SELECT DISTINCT ionos_categorie FROM category_mapping WHERE UPPER(ionos_categorie) = UPPER($1) OR category_id IN (SELECT category_id FROM category_mapping WHERE UPPER(ionos_categorie) = UPPER($1))';

      const catMappingParams = mode ? [categorie, mode] : [categorie];
      const catMappingResult = await new Promise((resolve, reject) => {
        db.all(catMappingQuery, catMappingParams, (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      });

      if (catMappingResult.length > 0) {
        // Match any of the mapped category variations
        const placeholders = catMappingResult.map((_, i) => `$${params.length + i + 1}`).join(', ');
        conditions.push(`UPPER(categorie) IN (${placeholders})`);
        catMappingResult.forEach(m => params.push(m.ionos_categorie.toUpperCase()));
      } else {
        // Fallback: direct case-insensitive matching
        conditions.push(`UPPER(categorie) = UPPER($${params.length + 1})`);
        params.push(categorie);
      }
    } catch (err) {
      // Fallback on error
      conditions.push(`UPPER(categorie) = UPPER($${params.length + 1})`);
      params.push(categorie);
    }
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY debut DESC, mode, categorie';

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Get last import dates for all file types
router.get('/last-import', authenticateToken, (req, res) => {
  // Get the most recent import for each file type from import_history
  const query = `
    SELECT DISTINCT ON (file_type)
      file_type,
      import_date,
      record_count,
      filename,
      imported_by
    FROM import_history
    ORDER BY file_type, import_date DESC
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      // Fallback to old method if import_history table doesn't exist yet
      console.error('Error fetching import history, falling back to old method:', err);

      // Fallback: get max created_at from each table
      const fallbackQuery = `
        SELECT
          'inscriptions' as file_type,
          MAX(created_at) as import_date,
          COUNT(*) as record_count
        FROM inscriptions
        UNION ALL
        SELECT
          'tournois' as file_type,
          MAX(created_at) as import_date,
          COUNT(*) as record_count
        FROM tournoi_ext
        UNION ALL
        SELECT
          'joueurs' as file_type,
          NULL as import_date,
          COUNT(*) as record_count
        FROM players
      `;

      db.all(fallbackQuery, [], (fallbackErr, fallbackRows) => {
        if (fallbackErr) {
          return res.status(500).json({ error: fallbackErr.message });
        }

        const result = {};
        (fallbackRows || []).forEach(row => {
          result[row.file_type] = {
            importDate: row.import_date,
            recordCount: row.record_count
          };
        });
        res.json(result);
      });
      return;
    }

    // Transform rows to object keyed by file_type
    const result = {};
    (rows || []).forEach(row => {
      result[row.file_type] = {
        importDate: row.import_date,
        recordCount: row.record_count,
        filename: row.filename,
        importedBy: row.imported_by
      };
    });

    res.json(result);
  });
});

// Seed import_history with initial data (admin utility)
router.post('/seed-import-history', authenticateToken, (req, res) => {
  // Only allow admins
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  // Insert initial records for yesterday to bootstrap the system
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString();

  const fileTypes = ['inscriptions', 'tournois', 'joueurs'];
  let inserted = 0;
  let errors = [];

  const insertQuery = `
    INSERT INTO import_history (file_type, import_date, record_count, filename, imported_by)
    VALUES ($1, $2, 0, 'Initial seed', 'system')
    ON CONFLICT DO NOTHING
  `;

  let completed = 0;
  fileTypes.forEach(fileType => {
    db.run(insertQuery, [fileType, yesterdayStr], (err) => {
      if (err) {
        errors.push({ fileType, error: err.message });
      } else {
        inserted++;
      }
      completed++;

      if (completed === fileTypes.length) {
        res.json({
          message: `Seeded import_history with ${inserted} records`,
          inserted,
          errors: errors.length > 0 ? errors : undefined
        });
      }
    });
  });
});

// Get upcoming tournaments (for the current weekend and next weekend)
// IMPORTANT: This route must be BEFORE /tournoi/:id to avoid :id catching "upcoming"
router.get('/tournoi/upcoming', authenticateToken, (req, res) => {
  // Get today's date
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Start from tomorrow (today's tournaments are being played)
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Get the next Sunday (end of current weekend) and the following Sunday (end of next weekend)
  const daysUntilSunday = (7 - tomorrow.getDay()) % 7;
  const thisSunday = new Date(tomorrow);
  thisSunday.setDate(tomorrow.getDate() + daysUntilSunday);

  const nextSunday = new Date(thisSunday);
  nextSunday.setDate(thisSunday.getDate() + 7);

  // Format dates for SQL
  const startDate = tomorrow.toISOString().split('T')[0];
  const endDate = nextSunday.toISOString().split('T')[0];

  console.log(`Fetching upcoming tournaments from ${startDate} to ${endDate}`);

  const query = `
    SELECT t.*,
           COUNT(CASE WHEN i.inscription_id IS NOT NULL AND (i.forfait IS NULL OR i.forfait != 1) AND (i.statut IS NULL OR i.statut != 'désinscrit') THEN 1 END) as inscrit_count
    FROM tournoi_ext t
    LEFT JOIN inscriptions i ON t.tournoi_id = i.tournoi_id
    WHERE t.debut >= $1 AND t.debut <= $2
    AND LOWER(t.nom) NOT LIKE '%finale%'
    GROUP BY t.tournoi_id
    ORDER BY t.debut ASC, t.mode, t.categorie
  `;

  db.all(query, [startDate, endDate], (err, rows) => {
    if (err) {
      console.error('Error fetching upcoming tournaments:', err);
      return res.status(500).json({ error: err.message });
    }

    console.log(`Found ${(rows || []).length} upcoming tournaments`);
    res.json(rows || []);
  });
});

// Get upcoming finals (within next 4 weeks)
router.get('/finales/upcoming', authenticateToken, async (req, res) => {
  try {
    // Get qualification settings for determining finalist counts
    const qualificationSettings = await appSettings.getQualificationSettings();

    // Get today's date
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Look 4 weeks ahead for finals
    const fourWeeksLater = new Date(today);
    fourWeeksLater.setDate(today.getDate() + 28);

    // Format dates for SQL
    const startDate = today.toISOString().split('T')[0];
    const endDate = fourWeeksLater.toISOString().split('T')[0];

    console.log(`Fetching upcoming finals from ${startDate} to ${endDate}`);

    // Get current season
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth();
    const season = currentMonth >= 8 ? `${currentYear}-${currentYear + 1}` : `${currentYear - 1}-${currentYear}`;

    // Get basic finals data
    const finalsQuery = `
      SELECT t.*
      FROM tournoi_ext t
      WHERE t.debut >= $1 AND t.debut <= $2
      AND LOWER(t.nom) LIKE '%finale%'
      ORDER BY t.debut ASC, t.mode, t.categorie
    `;

    const finals = await new Promise((resolve, reject) => {
      db.all(finalsQuery, [startDate, endDate], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    console.log(`Found ${finals.length} upcoming finals`);

    // For each final, calculate finalist counts
    const enrichedFinals = await Promise.all(finals.map(async (final) => {
      try {
        // Map mode and categorie to find category
        // Note: categories table stores levels like "N3" or "N3GC", not "NATIONALE 3"
        const gameType = final.mode?.toUpperCase();
        const categoryLevel = final.categorie?.toUpperCase(); // Use directly, e.g., "N3"

        console.log(`Processing final: mode=${final.mode}, categorie=${final.categorie} -> gameType=${gameType}, categoryLevel=${categoryLevel}, season=${season}`);

        // Find matching category
        const category = await new Promise((resolve, reject) => {
          db.get(
            `SELECT * FROM categories WHERE UPPER(game_type) = $1 AND (UPPER(level) = $2 OR UPPER(level) LIKE $3)`,
            [gameType, categoryLevel, `${categoryLevel}%`],
            (err, row) => {
              if (err) {
                console.error(`Category query error:`, err);
                reject(err);
              } else {
                console.log(`Category found:`, row ? `id=${row.id}, game_type=${row.game_type}, level=${row.level}` : 'NONE');
                resolve(row);
              }
            }
          );
        });

        if (!category) {
          console.log(`No category found for ${gameType} - ${categoryLevel}`);
          return { ...final, finalist_count: 0, inscribed_finalist_count: 0 };
        }

        // Get rankings for this category to determine finalists
        const rankings = await new Promise((resolve, reject) => {
          db.all(
            `SELECT r.licence FROM rankings r WHERE r.category_id = $1 AND r.season = $2 ORDER BY r.rank_position ASC`,
            [category.id, season],
            (err, rows) => {
              if (err) {
                console.error(`Rankings query error:`, err);
                reject(err);
              } else {
                console.log(`Rankings found: ${(rows || []).length} players for category_id=${category.id}, season=${season}`);
                resolve(rows || []);
              }
            }
          );
        });

        // Determine number of finalists based on configured thresholds
        const numFinalists = rankings.length >= qualificationSettings.threshold
          ? qualificationSettings.large
          : qualificationSettings.small;
        const finalistLicences = rankings.slice(0, numFinalists).map(r => r.licence?.replace(/\s/g, ''));
        console.log(`Finalists: ${finalistLicences.length} (top ${numFinalists} of ${rankings.length})`);

        // Get inscriptions for this tournament
        const inscriptions = await new Promise((resolve, reject) => {
          db.all(
            `SELECT licence FROM inscriptions WHERE tournoi_id = $1 AND (forfait IS NULL OR forfait != 1)`,
            [final.tournoi_id],
            (err, rows) => {
              if (err) {
                console.error(`Inscriptions query error:`, err);
                reject(err);
              } else {
                console.log(`Inscriptions found: ${(rows || []).length} for tournoi_id=${final.tournoi_id}`);
                resolve(rows || []);
              }
            }
          );
        });

        // Count how many finalists are inscribed
        const inscribedLicences = inscriptions.map(i => i.licence?.replace(/\s/g, ''));
        const inscribedFinalistCount = finalistLicences.filter(l => inscribedLicences.includes(l)).length;
        console.log(`Result: ${inscribedFinalistCount}/${finalistLicences.length} finalists inscribed`);

        return {
          ...final,
          finalist_count: finalistLicences.length,
          inscribed_finalist_count: inscribedFinalistCount
        };
      } catch (err) {
        console.error(`Error processing final ${final.tournoi_id}:`, err);
        return { ...final, finalist_count: 0, inscribed_finalist_count: 0 };
      }
    }));

    res.json(enrichedFinals);
  } catch (err) {
    console.error('Error fetching upcoming finals:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get a specific external tournament
router.get('/tournoi/:id', authenticateToken, (req, res) => {
  db.get('SELECT * FROM tournoi_ext WHERE tournoi_id = $1', [req.params.id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    res.json(row);
  });
});

// Get inscriptions for a specific tournament
router.get('/tournoi/:id/inscriptions', authenticateToken, (req, res) => {
  const query = `
    SELECT
      i.*,
      p.first_name,
      p.last_name,
      p.club
    FROM inscriptions i
    LEFT JOIN players p ON REPLACE(i.licence, ' ', '') = REPLACE(p.licence, ' ', '')
    WHERE i.tournoi_id = $1
    ORDER BY i.timestamp ASC
  `;

  db.all(query, [req.params.id], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Get all inscriptions
router.get('/', authenticateToken, (req, res) => {
  const { tournoi_id, licence, source } = req.query;

  let query = `
    SELECT
      i.*,
      t.nom as tournoi_nom,
      t.mode,
      t.categorie,
      p.first_name,
      p.last_name,
      p.club
    FROM inscriptions i
    LEFT JOIN tournoi_ext t ON i.tournoi_id = t.tournoi_id
    LEFT JOIN players p ON REPLACE(i.licence, ' ', '') = REPLACE(p.licence, ' ', '')
  `;

  const params = [];
  const conditions = [];

  if (tournoi_id) {
    conditions.push(`i.tournoi_id = $${params.length + 1}`);
    params.push(tournoi_id);
  }
  if (licence) {
    conditions.push(`REPLACE(i.licence, ' ', '') = REPLACE($${params.length + 1}, ' ', '')`);
    params.push(licence);
  }
  if (source) {
    conditions.push(`i.source = $${params.length + 1}`);
    params.push(source);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY i.timestamp DESC';

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Create a new inscription manually (admin only)
router.post('/create', authenticateToken, async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { tournoi_id, licence, email, telephone, convoque, forfait, commentaire } = req.body;

  if (!tournoi_id || !licence) {
    return res.status(400).json({ error: 'tournoi_id and licence are required' });
  }

  try {
    // Get the next inscription_id
    const maxIdResult = await new Promise((resolve, reject) => {
      db.get('SELECT MAX(inscription_id) as max_id FROM inscriptions', [], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    const nextId = (maxIdResult?.max_id || 0) + 1;

    // Clean up licence (remove spaces)
    const cleanLicence = (licence || '').replace(/\s+/g, '').trim();

    // Insert the new inscription
    await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO inscriptions (inscription_id, tournoi_id, licence, email, telephone, convoque, forfait, commentaire, timestamp, source)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), 'manual')
      `, [nextId, tournoi_id, cleanLicence, email || null, telephone || null, convoque || 0, forfait || 0, commentaire || null], function(err) {
        if (err) reject(err);
        else resolve({ id: nextId, changes: this.changes });
      });
    });

    // Log the action
    logAdminAction({
      req,
      action: ACTION_TYPES.ADD_INSCRIPTION,
      details: `Inscription manuelle ajoutée: licence ${cleanLicence} au tournoi ${tournoi_id}`,
      targetType: 'inscription',
      targetId: nextId,
      targetName: cleanLicence
    });

    res.json({
      success: true,
      message: 'Inscription created successfully',
      inscription_id: nextId
    });

  } catch (error) {
    console.error('Error creating inscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete all tournoi_ext
router.delete('/tournoi/all', authenticateToken, (req, res) => {
  db.run('DELETE FROM tournoi_ext', [], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({
      success: true,
      message: `${this.changes} tournaments deleted`,
      deleted: this.changes
    });
  });
});

// Delete all inscriptions
router.delete('/all', authenticateToken, (req, res) => {
  db.run('DELETE FROM inscriptions', [], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({
      success: true,
      message: `${this.changes} inscriptions deleted`,
      deleted: this.changes
    });
  });
});

// Generate Excel file with poules
router.post('/generate-poules', authenticateToken, async (req, res) => {
  const { category, season, tournament, players, poules, config, tournamentDate, tournamentLieu } = req.body;

  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Poules');

    // Title with tournament date
    const tournamentLabel = tournament === '4' ? 'Finale Départementale' : `Tournoi ${tournament}`;
    const dateStr = tournamentDate ? new Date(tournamentDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    const titleText = dateStr ? `${category.display_name} - ${tournamentLabel} - ${dateStr}` : `${category.display_name} - ${tournamentLabel}`;

    worksheet.mergeCells('A1:F1');
    worksheet.getCell('A1').value = titleText;
    worksheet.getCell('A1').font = { size: 18, bold: true, color: { argb: 'FF1F4788' } };
    worksheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    worksheet.getCell('A1').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE7F3FF' }
    };
    worksheet.getRow(1).height = 35;

    // Subtitle
    worksheet.mergeCells('A2:F2');
    const exportDate = new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });
    worksheet.getCell('A2').value = `Saison ${season} • Généré le ${exportDate}`;
    worksheet.getCell('A2').font = { size: 11, italic: true, color: { argb: 'FF666666' } };
    worksheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
    worksheet.getRow(2).height = 20;

    // Summary
    worksheet.getCell('A4').value = 'Résumé:';
    worksheet.getCell('A4').font = { bold: true };
    worksheet.getCell('A5').value = `Nombre de joueurs: ${players.length}`;
    worksheet.getCell('A6').value = `Configuration: ${config.description}`;
    worksheet.getCell('A7').value = `Tables nécessaires: ${config.tables}`;

    // Poules section
    let currentRow = 9;

    poules.forEach((poule, pouleIndex) => {
      // Poule header
      worksheet.mergeCells(`A${currentRow}:F${currentRow}`);
      worksheet.getCell(`A${currentRow}`).value = `Poule ${poule.number} (${poule.players.length} joueurs)`;
      worksheet.getCell(`A${currentRow}`).font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
      worksheet.getCell(`A${currentRow}`).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1F4788' }
      };
      worksheet.getCell(`A${currentRow}`).alignment = { horizontal: 'center', vertical: 'middle' };
      worksheet.getRow(currentRow).height = 25;
      currentRow++;

      // Column headers for this poule (apply style only to columns A-F)
      const headerRow = worksheet.getRow(currentRow);
      headerRow.values = ['#', 'Nom', 'Prénom', 'Club', 'Licence', 'Classement Initial'];
      ['A', 'B', 'C', 'D', 'E', 'F'].forEach(col => {
        const cell = worksheet.getCell(`${col}${currentRow}`);
        cell.font = { bold: true };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFD3D3D3' }
        };
      });
      currentRow++;

      // Players in this poule
      poule.players.forEach((player, playerIndex) => {
        const row = worksheet.getRow(currentRow);
        row.values = [
          playerIndex + 1,
          `${player.last_name} (${player.finalRank || player.originalRank})`,
          player.first_name,
          player.club || '',
          player.licence,
          `#${player.finalRank || player.originalRank}`
        ];

        // Highlight new players (only columns A-F)
        if (player.isNew) {
          ['A', 'B', 'C', 'D', 'E', 'F'].forEach(col => {
            worksheet.getCell(`${col}${currentRow}`).fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFFFF3E0' }
            };
          });
        }

        currentRow++;
      });

      // Add match schedule for this poule
      currentRow++;
      worksheet.getCell(`A${currentRow}`).value = 'Rencontres:';
      worksheet.getCell(`A${currentRow}`).font = { bold: true, italic: true };
      currentRow++;

      const matches = generateMatchSchedule(poule.players.length);
      matches.forEach((match, matchIndex) => {
        worksheet.getCell(`A${currentRow}`).value = `Match ${matchIndex + 1}:`;

        // Handle dynamic matches (where opponent depends on previous match results)
        if (match.dynamic) {
          worksheet.getCell(`B${currentRow}`).value = match.description;
          worksheet.getCell(`B${currentRow}`).font = { italic: true, color: { argb: 'FF666666' } };
        } else {
          const p1 = poule.players[match.player1 - 1];
          const p2 = poule.players[match.player2 - 1];
          if (p1 && p2) {
            worksheet.getCell(`B${currentRow}`).value = `${p1.last_name} ${p1.first_name} (${p1.finalRank || p1.originalRank || '-'})`;
            worksheet.getCell(`C${currentRow}`).value = 'vs';
            worksheet.getCell(`D${currentRow}`).value = `${p2.last_name} ${p2.first_name} (${p2.finalRank || p2.originalRank || '-'})`;
          }
        }
        currentRow++;
      });

      currentRow += 2; // Space before next poule
    });

    // Complete player list
    currentRow += 2;
    worksheet.mergeCells(`A${currentRow}:F${currentRow}`);
    worksheet.getCell(`A${currentRow}`).value = 'Liste complète des joueurs (ordre de classement)';
    worksheet.getCell(`A${currentRow}`).font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getCell(`A${currentRow}`).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF28A745' }
    };
    worksheet.getCell(`A${currentRow}`).alignment = { horizontal: 'center', vertical: 'middle' };
    worksheet.getRow(currentRow).height = 25;
    currentRow++;

    // Headers (apply style only to columns A-F)
    worksheet.getRow(currentRow).values = ['Rang', 'Nom', 'Prénom', 'Club', 'Licence', 'Poule'];
    ['A', 'B', 'C', 'D', 'E', 'F'].forEach(col => {
      const cell = worksheet.getCell(`${col}${currentRow}`);
      cell.font = { bold: true };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD3D3D3' }
      };
    });
    currentRow++;

    // All players
    players.forEach((player, index) => {
      // Find which poule this player is in
      let pouleNum = '-';
      poules.forEach(poule => {
        if (poule.players.find(p => p.licence === player.licence)) {
          pouleNum = poule.number;
        }
      });

      const row = worksheet.getRow(currentRow);
      row.values = [
        player.finalRank,
        player.last_name,
        player.first_name,
        player.club || '',
        player.licence,
        `Poule ${pouleNum}`
      ];

      if (player.isNew) {
        ['A', 'B', 'C', 'D', 'E', 'F'].forEach(col => {
          worksheet.getCell(`${col}${currentRow}`).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFF3E0' }
          };
        });
      }

      currentRow++;
    });

    // Set column widths
    worksheet.columns = [
      { width: 8 },   // #/Rang
      { width: 20 },  // Nom
      { width: 18 },  // Prénom
      { width: 30 },  // Club
      { width: 12 },  // Licence
      { width: 18 }   // Classement/Poule
    ];

    // ============= SECOND WORKSHEET: CONVOCATION =============
    const convocationSheet = workbook.addWorksheet('Convocation');

    // Get game parameters for this category
    let gameParams = null;
    try {
      const gameParamsResult = await db.query(
        'SELECT * FROM game_parameters WHERE mode = $1 AND categorie = $2',
        [category.mode, category.categorie]
      );
      if (gameParamsResult.rows.length > 0) {
        gameParams = gameParamsResult.rows[0];
      }
    } catch (e) {
      console.log('Could not fetch game parameters:', e.message);
    }

    // Get ranking data for players
    let rankingData = {};
    if (req.body.mockRankingData) {
      rankingData = req.body.mockRankingData;
    } else {
      try {
        const rankingResult = await db.query(`
          SELECT r.licence, r.rank_position,
            COALESCE((SELECT SUM(tr.points) FROM tournament_results tr
              JOIN tournaments t ON tr.tournament_id = t.id
              WHERE REPLACE(tr.licence, ' ', '') = REPLACE(r.licence, ' ', '')
              AND t.category_id = r.category_id AND t.season = r.season
              AND t.tournament_number <= 3), 0) as cumulated_points,
            COALESCE((SELECT SUM(tr.reprises) FROM tournament_results tr
              JOIN tournaments t ON tr.tournament_id = t.id
              WHERE REPLACE(tr.licence, ' ', '') = REPLACE(r.licence, ' ', '')
              AND t.category_id = r.category_id AND t.season = r.season
              AND t.tournament_number <= 3), 0) as cumulated_reprises
          FROM rankings r WHERE r.category_id = $1 AND r.season = $2
        `, [category.id, season]);

        rankingResult.rows.forEach(row => {
          const moyenne = row.cumulated_reprises > 0
            ? (row.cumulated_points / row.cumulated_reprises).toFixed(3)
            : '-';
          rankingData[row.licence.replace(/\s/g, '')] = {
            rank: row.rank_position,
            moyenne: moyenne
          };
        });
      } catch (e) {
        console.log('Could not fetch ranking data:', e.message);
      }
    }

    let convRow = 1;

    // Title
    convocationSheet.mergeCells(`A${convRow}:H${convRow}`);
    convocationSheet.getCell(`A${convRow}`).value = titleText;
    convocationSheet.getCell(`A${convRow}`).font = { size: 16, bold: true, color: { argb: 'FF1F4788' } };
    convocationSheet.getCell(`A${convRow}`).alignment = { horizontal: 'center', vertical: 'middle' };
    convocationSheet.getCell(`A${convRow}`).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE7F3FF' }
    };
    convocationSheet.getRow(convRow).height = 30;
    convRow++;

    // Lieu if available
    if (tournamentLieu) {
      convocationSheet.mergeCells(`A${convRow}:H${convRow}`);
      convocationSheet.getCell(`A${convRow}`).value = tournamentLieu;
      convocationSheet.getCell(`A${convRow}`).font = { size: 11, italic: true, color: { argb: 'FF666666' } };
      convocationSheet.getCell(`A${convRow}`).alignment = { horizontal: 'center' };
      convRow++;
    }

    // Game parameters
    if (gameParams) {
      convRow++;
      const distance = gameParams.distance_reduite || gameParams.distance_normale;
      const coinLabel = gameParams.coin === 'GC' ? 'Grand Coin' : 'Petit Coin';

      convocationSheet.mergeCells(`A${convRow}:H${convRow}`);
      convocationSheet.getCell(`A${convRow}`).value = `${distance} points  /  ${coinLabel}  /  en ${gameParams.reprises} reprises`;
      convocationSheet.getCell(`A${convRow}`).font = { size: 11, bold: true };
      convocationSheet.getCell(`A${convRow}`).alignment = { horizontal: 'center' };
      convRow++;

      convocationSheet.mergeCells(`A${convRow}:H${convRow}`);
      convocationSheet.getCell(`A${convRow}`).value = `La moyenne qualificative pour cette catégorie est entre ${parseFloat(gameParams.moyenne_mini).toFixed(3)} et ${parseFloat(gameParams.moyenne_maxi).toFixed(3)}`;
      convocationSheet.getCell(`A${convRow}`).font = { size: 10, italic: true, color: { argb: 'FF666666' } };
      convocationSheet.getCell(`A${convRow}`).alignment = { horizontal: 'center' };
      convRow++;

      convocationSheet.mergeCells(`A${convRow}:H${convRow}`);
      convocationSheet.getCell(`A${convRow}`).value = `Les colonnes Moyenne et Classement en face du nom de chaque joueur correspondent aux positions cumulées à la suite du dernier tournoi joué`;
      convocationSheet.getCell(`A${convRow}`).font = { size: 9, italic: true, color: { argb: 'FF666666' } };
      convocationSheet.getCell(`A${convRow}`).alignment = { horizontal: 'center' };
      convRow++;
    }

    convRow++;

    // All Poules
    poules.forEach((poule) => {
      // Poule header
      convocationSheet.mergeCells(`A${convRow}:H${convRow}`);
      convocationSheet.getCell(`A${convRow}`).value = `POULE ${poule.number}`;
      convocationSheet.getCell(`A${convRow}`).font = { size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
      convocationSheet.getCell(`A${convRow}`).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1F4788' }
      };
      convocationSheet.getCell(`A${convRow}`).alignment = { horizontal: 'center', vertical: 'middle' };
      convocationSheet.getRow(convRow).height = 22;
      convRow++;

      // Column headers
      const headers = ['#', 'Nom', 'Prénom', 'Club', 'Licence', 'Moy.', 'Class.'];
      const headerCols = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
      headerCols.forEach((col, idx) => {
        convocationSheet.getCell(`${col}${convRow}`).value = headers[idx];
        convocationSheet.getCell(`${col}${convRow}`).font = { bold: true, size: 10 };
        convocationSheet.getCell(`${col}${convRow}`).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE0E0E0' }
        };
        convocationSheet.getCell(`${col}${convRow}`).alignment = { horizontal: 'center' };
      });
      convRow++;

      // Players in poule
      poule.players.forEach((player, idx) => {
        const licenceKey = (player.licence || '').replace(/\s/g, '');
        const playerRanking = rankingData[licenceKey] || {};

        convocationSheet.getCell(`A${convRow}`).value = idx + 1;
        convocationSheet.getCell(`B${convRow}`).value = player.last_name;
        convocationSheet.getCell(`C${convRow}`).value = player.first_name;
        convocationSheet.getCell(`D${convRow}`).value = player.club || '';
        convocationSheet.getCell(`E${convRow}`).value = player.licence;
        convocationSheet.getCell(`F${convRow}`).value = playerRanking.moyenne || '-';
        convocationSheet.getCell(`G${convRow}`).value = playerRanking.rank ? `#${playerRanking.rank}` : '-';

        // Center align numeric columns
        ['A', 'F', 'G'].forEach(col => {
          convocationSheet.getCell(`${col}${convRow}`).alignment = { horizontal: 'center' };
        });

        convRow++;
      });

      convRow++; // Space between poules
    });

    // Set column widths for convocation sheet
    convocationSheet.columns = [
      { width: 5 },   // #
      { width: 18 },  // Nom
      { width: 15 },  // Prénom
      { width: 25 },  // Club
      { width: 12 },  // Licence
      { width: 10 },  // Moy.
      { width: 10 }   // Class.
    ];

    // ============= END CONVOCATION WORKSHEET =============

    // Send file
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    const filename = `Poules_${category.display_name.replace(/\s+/g, '_')}_T${tournament}_${season}.xlsx`;
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Excel generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to generate match schedule based on poule size
function generateMatchSchedule(pouleSize) {
  if (pouleSize === 3) {
    return [
      { player1: 2, player2: 3, description: 'Joueur 2 vs Joueur 3' },
      { player1: 1, player2: 0, description: 'Joueur 1 vs Perdant Match 1', dynamic: true },
      { player1: 1, player2: 0, description: 'Joueur 1 vs Gagnant Match 1', dynamic: true }
    ];
  } else if (pouleSize === 4) {
    return [
      { player1: 1, player2: 4, description: 'Joueur 1 vs Joueur 4' },
      { player1: 2, player2: 3, description: 'Joueur 2 vs Joueur 3' },
      { player1: 0, player2: 0, description: 'Perdants Match 1 et 2', dynamic: true },
      { player1: 0, player2: 0, description: 'Gagnants Match 1 et 2', dynamic: true }
    ];
  } else if (pouleSize === 5) {
    return [
      { player1: 1, player2: 5, description: 'Joueur 1 vs Joueur 5' },
      { player1: 2, player2: 4, description: 'Joueur 2 vs Joueur 4' },
      { player1: 3, player2: 0, description: 'Joueur 3 vs Perdant Match 1', dynamic: true },
      { player1: 3, player2: 0, description: 'Joueur 3 vs Perdant Match 2', dynamic: true },
      { player1: 0, player2: 0, description: 'Gagnants Match 1 et 2', dynamic: true }
    ];
  }
  // Default: round-robin for other sizes
  const matches = [];
  for (let i = 1; i <= pouleSize; i++) {
    for (let j = i + 1; j <= pouleSize; j++) {
      matches.push({ player1: i, player2: j });
    }
  }
  return matches;
}

// Create a new tournament (admin only)
router.post('/tournoi', authenticateToken, async (req, res) => {
  // Check admin role
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { nom, mode, categorie, taille, debut, fin, grand_coin, taille_cadre, lieu } = req.body;

  if (!nom || !mode || !categorie) {
    return res.status(400).json({ error: 'nom, mode, and categorie are required' });
  }

  try {
    // Get the next tournoi_id
    const maxIdResult = await new Promise((resolve, reject) => {
      db.get('SELECT MAX(tournoi_id) as max_id FROM tournoi_ext', [], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    const nextId = (maxIdResult?.max_id || 0) + 1;

    // Insert the new tournament
    await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO tournoi_ext (tournoi_id, nom, mode, categorie, taille, debut, fin, grand_coin, taille_cadre, lieu)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [nextId, nom, mode, categorie, taille || null, debut || null, fin || null, grand_coin || 0, taille_cadre || null, lieu || null], function(err) {
        if (err) reject(err);
        else resolve({ id: nextId, changes: this.changes });
      });
    });

    res.json({
      success: true,
      message: 'Tournament created successfully',
      tournoi_id: nextId
    });

  } catch (error) {
    console.error('Error creating tournament:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update a tournament (admin only)
router.put('/tournoi/:id', authenticateToken, async (req, res) => {
  // Check admin role
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { id } = req.params;
  const { nom, mode, categorie, taille, debut, fin, grand_coin, taille_cadre, lieu, status, notify_on_changes } = req.body;

  try {
    // Get current tournament data to detect date change
    const currentTournament = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM tournoi_ext WHERE tournoi_id = $1', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!currentTournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    // Check if date changed
    const oldDate = currentTournament.debut ? new Date(currentTournament.debut).toISOString().split('T')[0] : null;
    const newDate = debut ? new Date(debut).toISOString().split('T')[0] : null;
    const dateChanged = oldDate !== newDate && oldDate && newDate;

    // Check if location changed
    const oldLieu = (currentTournament.lieu || '').trim();
    const newLieu = (lieu || '').trim();
    const locationChanged = oldLieu !== newLieu && newLieu;

    // Check if status is being changed to cancelled
    const statusChangedToCancelled = status === 'cancelled' && currentTournament.status !== 'cancelled';

    // Update the tournament
    const query = `
      UPDATE tournoi_ext SET
        nom = $1,
        mode = $2,
        categorie = $3,
        taille = $4,
        debut = $5,
        fin = $6,
        grand_coin = $7,
        taille_cadre = $8,
        lieu = $9,
        status = $10,
        notify_on_changes = $11
      WHERE tournoi_id = $12
    `;

    // Determine new status and notify_on_changes values
    const newStatus = status !== undefined ? status : (currentTournament.status || 'active');
    const newNotifyOnChanges = notify_on_changes !== undefined ? notify_on_changes : (currentTournament.notify_on_changes !== false);

    await new Promise((resolve, reject) => {
      db.run(query, [nom, mode, categorie, taille || null, debut || null, fin || null, grand_coin || 0, taille_cadre, lieu, newStatus, newNotifyOnChanges, id], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });

    // Send email notifications only if:
    // 1. Date or location changed AND
    // 2. notify_on_changes is enabled (check the CURRENT value, before update) AND
    // 3. Status is not being changed to cancelled
    let emailsSent = 0;
    const shouldNotify = currentTournament.notify_on_changes !== false; // Default to true if null/undefined

    if ((dateChanged || locationChanged) && shouldNotify && !statusChangedToCancelled) {
      emailsSent = await sendTournamentChangeNotifications(id, currentTournament, {
        nom, mode, categorie, debut, lieu
      }, {
        dateChanged,
        locationChanged,
        oldDate,
        newDate,
        oldLieu,
        newLieu
      });
    }

    // Log if tournament was cancelled
    if (statusChangedToCancelled) {
      logAdminAction({
        req,
        action: ACTION_TYPES.CANCEL_TOURNAMENT,
        details: `Tournoi annulé: ${nom} (${mode} ${categorie})`,
        targetType: 'tournament',
        targetId: id,
        targetName: `${nom} - ${mode} ${categorie}`
      });
    }

    // Build response message
    let changeMessage = '';
    if (statusChangedToCancelled) {
      changeMessage = 'Tournoi marqué comme annulé.';
    } else if (dateChanged || locationChanged) {
      if (!shouldNotify) {
        changeMessage = 'Notifications désactivées pour ce tournoi.';
      } else if (dateChanged && locationChanged) {
        changeMessage = `${emailsSent} notification(s) envoyée(s) pour le changement de date et lieu.`;
      } else if (dateChanged) {
        changeMessage = `${emailsSent} notification(s) envoyée(s) pour le changement de date.`;
      } else if (locationChanged) {
        changeMessage = `${emailsSent} notification(s) envoyée(s) pour le changement de lieu.`;
      }
    }

    res.json({
      success: true,
      message: changeMessage
        ? `Tournoi mis à jour. ${changeMessage}`
        : 'Tournoi mis à jour'
    });

  } catch (error) {
    console.error('Error updating tournament:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send email notifications to inscribed players when tournament date or location changes
 */
async function sendTournamentChangeNotifications(tournoiId, oldTournament, newData, changes) {
  const resend = getResend();
  if (!resend) {
    console.log('[Tournament Change] Resend not configured, skipping notifications');
    return 0;
  }

  const { dateChanged, locationChanged, oldDate, newDate, oldLieu, newLieu } = changes;

  try {
    // Get all inscribed players with emails for this tournament
    const inscriptions = await new Promise((resolve, reject) => {
      db.all(`
        SELECT i.*, p.first_name, p.last_name,
               COALESCE(i.email, p.email) as player_email
        FROM inscriptions i
        LEFT JOIN players p ON REPLACE(i.licence, ' ', '') = REPLACE(p.licence, ' ', '')
        WHERE i.tournoi_id = $1
          AND COALESCE(i.email, p.email) IS NOT NULL
          AND COALESCE(i.email, p.email) LIKE '%@%'
      `, [tournoiId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    if (inscriptions.length === 0) {
      console.log('[Tournament Change] No players with email to notify');
      return 0;
    }

    // Format dates for display
    const formatDate = (dateStr) => {
      if (!dateStr) return '';
      const date = new Date(dateStr);
      return date.toLocaleDateString('fr-FR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });
    };

    const tournamentName = `${newData.nom || oldTournament.nom} - ${newData.mode} ${newData.categorie}`;

    // Build email subject based on what changed
    let emailSubject = '⚠️ ';
    if (dateChanged && locationChanged) {
      emailSubject += 'Changement de date et lieu';
    } else if (dateChanged) {
      emailSubject += 'Changement de date';
    } else {
      emailSubject += 'Changement de lieu';
    }
    emailSubject += ` - ${tournamentName}`;

    // Build header text
    let headerText = '⚠️ ';
    if (dateChanged && locationChanged) {
      headerText += 'Changement de Date et Lieu';
    } else if (dateChanged) {
      headerText += 'Changement de Date';
    } else {
      headerText += 'Changement de Lieu';
    }

    // Build intro text
    let introText = 'Nous vous informons que ';
    if (dateChanged && locationChanged) {
      introText += 'la date et le lieu du tournoi auquel vous êtes inscrit(e) ont été modifiés';
    } else if (dateChanged) {
      introText += 'la date du tournoi auquel vous êtes inscrit(e) a été modifiée';
    } else {
      introText += 'le lieu du tournoi auquel vous êtes inscrit(e) a été modifié';
    }
    introText += ' :';

    let sentCount = 0;

    for (const inscription of inscriptions) {
      const playerName = inscription.first_name && inscription.last_name
        ? `${inscription.first_name} ${inscription.last_name}`
        : inscription.nom || 'Joueur';

      // Build the changes section
      let changesHtml = '';

      if (dateChanged) {
        const oldDateFormatted = formatDate(oldDate);
        const newDateFormatted = formatDate(newDate);
        changesHtml += `
          <p style="margin: 5px 0; color: #dc3545;"><strong>❌ Ancienne date :</strong> ${oldDateFormatted}</p>
          <p style="margin: 5px 0; color: #28a745;"><strong>✅ Nouvelle date :</strong> ${newDateFormatted}</p>
        `;
      }

      if (locationChanged) {
        changesHtml += `
          <p style="margin: 5px 0; color: #dc3545;"><strong>❌ Ancien lieu :</strong> ${oldLieu || 'Non défini'}</p>
          <p style="margin: 5px 0; color: #28a745;"><strong>✅ Nouveau lieu :</strong> ${newLieu}</p>
        `;
      }

      // If only date changed, show current location
      if (dateChanged && !locationChanged) {
        const currentLocation = newData.lieu || oldTournament.lieu || 'Lieu à confirmer';
        changesHtml = `<p style="margin: 5px 0;"><strong>📍 Lieu :</strong> ${currentLocation}</p>` + changesHtml;
      }

      // If only location changed, show current date
      if (locationChanged && !dateChanged) {
        const currentDate = formatDate(newData.debut || oldTournament.debut);
        changesHtml = `<p style="margin: 5px 0;"><strong>📅 Date :</strong> ${currentDate}</p>` + changesHtml;
      }

      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #1F4788 0%, #667eea 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">${headerText}</h1>
          </div>

          <div style="padding: 30px; background: #f8f9fa;">
            <p>Bonjour ${playerName},</p>

            <p>${introText}</p>

            <div style="background: white; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
              <h3 style="margin: 0 0 10px 0; color: #1F4788;">${tournamentName}</h3>
              ${changesHtml}
            </div>

            <p>Si ce changement vous empêche de participer, merci de nous en informer dès que possible en répondant à cet email.</p>

            <p style="margin-top: 30px;">
              Sportivement,<br>
              <strong>Comité Départemental Billard Hauts-de-Seine</strong>
            </p>
          </div>

          <div style="background: #1F4788; color: white; padding: 15px; text-align: center; font-size: 12px;">
            <p style="margin: 0;">Cet email a été envoyé automatiquement suite à une modification de calendrier.</p>
          </div>
        </div>
      `;

      try {
        await resend.emails.send({
          from: 'CDBHS <convocations@cdbhs.net>',
          to: inscription.player_email,
          subject: emailSubject,
          html: emailHtml
        });
        sentCount++;
        console.log(`[Tournament Change] Email sent to ${inscription.player_email}`);

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (emailError) {
        console.error(`[Tournament Change] Failed to send to ${inscription.player_email}:`, emailError.message);
      }
    }

    console.log(`[Tournament Change] Sent ${sentCount}/${inscriptions.length} notifications for tournament ${tournoiId}`);
    return sentCount;

  } catch (error) {
    console.error('[Tournament Change] Error sending notifications:', error);
    return 0;
  }
}

// Update an inscription (admin only)
router.put('/:id', authenticateToken, (req, res) => {
  // Check admin role
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { id } = req.params;
  const { licence, email, telephone, convoque, forfait, statut, commentaire, source } = req.body;

  const query = `
    UPDATE inscriptions SET
      licence = $1,
      email = $2,
      telephone = $3,
      convoque = $4,
      forfait = $5,
      statut = $6,
      commentaire = $7,
      source = $8
    WHERE inscription_id = $9
  `;

  db.run(query, [licence, email, telephone, convoque || 0, forfait || 0, statut || 'inscrit', commentaire, source || 'ionos', id], function(err) {
    if (err) {
      console.error('Error updating inscription:', err);
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Inscription not found' });
    }
    res.json({ success: true, message: 'Inscription updated' });
  });
});

// Desinscription - mark a player as désinscrit (all users can do this, pre-convocation)
// This is different from forfait which is only used after official convocation
router.put('/:id/desinscription', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { statut } = req.body; // 'désinscrit' or 'inscrit' (to undo)

  const newStatut = statut || 'désinscrit';

  if (!['inscrit', 'désinscrit'].includes(newStatut)) {
    return res.status(400).json({ error: 'Statut invalide. Utilisez "inscrit" ou "désinscrit".' });
  }

  try {
    // Get inscription details with player and tournament info for the email
    const inscriptionDetails = await new Promise((resolve, reject) => {
      db.get(`
        SELECT i.*, t.nom as tournoi_nom, t.mode, t.categorie, t.debut, t.lieu,
               p.first_name, p.last_name
        FROM inscriptions i
        LEFT JOIN tournoi_ext t ON i.tournoi_id = t.tournoi_id
        LEFT JOIN players p ON REPLACE(i.licence, ' ', '') = REPLACE(p.licence, ' ', '')
        WHERE i.inscription_id = $1
      `, [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!inscriptionDetails) {
      return res.status(404).json({ error: 'Inscription not found' });
    }

    // Update the statut
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE inscriptions SET statut = $1 WHERE inscription_id = $2`,
        [newStatut, id],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });

    // Send cancellation email if marking as désinscrit and player has email
    if (newStatut === 'désinscrit' && inscriptionDetails.email) {
      const resend = getResend();
      if (resend) {
        try {
          // Load email settings for dynamic branding
          const emailSettings = await appSettings.getSettingsBatch([
            'email_noreply',
            'email_sender_name',
            'organization_name',
            'summary_email'
          ]);
          const senderName = emailSettings.email_sender_name || 'CDB';
          const senderEmail = emailSettings.email_noreply || 'noreply@cdbhs.net';
          const orgName = emailSettings.organization_name || 'Comité Départemental de Billard';
          const contactEmail = emailSettings.summary_email || '';

          const dateStr = inscriptionDetails.debut
            ? new Date(inscriptionDetails.debut).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
            : 'Date à définir';

          const playerName = inscriptionDetails.first_name && inscriptionDetails.last_name
            ? `${inscriptionDetails.first_name} ${inscriptionDetails.last_name}`
            : 'Joueur';

          const tournamentName = inscriptionDetails.tournoi_nom || `${inscriptionDetails.mode || ''} ${inscriptionDetails.categorie || ''}`.trim();

          const emailBody = `Bonjour ${playerName},

Nous avons bien pris en compte votre désinscription du tournoi suivant :

Tournoi : ${tournamentName}
Mode : ${inscriptionDetails.mode || ''}
Catégorie : ${inscriptionDetails.categorie || ''}
Date : ${dateStr}
Lieu : ${inscriptionDetails.lieu || 'Non défini'}

Si cette désinscription est une erreur, veuillez contacter le comité via "Contact"${contactEmail ? ` ou par email ${contactEmail}` : ''}.

Sportivement,
${orgName}`;

          await resend.emails.send({
            from: `${senderName} <${senderEmail}>`,
            replyTo: contactEmail || undefined,
            to: [inscriptionDetails.email],
            subject: `Confirmation de désinscription - ${inscriptionDetails.mode || ''} ${inscriptionDetails.categorie || ''}`,
            html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: #dc3545; color: white; padding: 20px; text-align: center;">
                <h2 style="margin: 0;">Désinscription confirmée</h2>
              </div>
              <div style="padding: 20px; background: #f8f9fa;">
                ${emailBody.replace(/\n/g, '<br>')}
              </div>
            </div>`
          });
          console.log(`Desinscription email sent to ${inscriptionDetails.email}`);
        } catch (emailError) {
          console.error('Error sending desinscription email:', emailError);
          // Don't fail the desinscription if email fails
        }
      }
    }

    res.json({
      success: true,
      message: newStatut === 'désinscrit' ? 'Joueur désinscrit' : 'Inscription rétablie',
      statut: newStatut,
      emailSent: newStatut === 'désinscrit' && !!inscriptionDetails.email
    });

  } catch (err) {
    console.error('Error updating inscription statut:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Delete a single inscription (admin only)
router.delete('/:id', authenticateToken, async (req, res) => {
  // Check admin role
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { id } = req.params;

  try {
    // First get the inscription details for logging
    const inscription = await new Promise((resolve, reject) => {
      db.get('SELECT licence, tournoi_id FROM inscriptions WHERE inscription_id = $1', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!inscription) {
      return res.status(404).json({ error: 'Inscription not found' });
    }

    // Delete the inscription
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM inscriptions WHERE inscription_id = $1', [id], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });

    // Log the action
    logAdminAction({
      req,
      action: ACTION_TYPES.DELETE_INSCRIPTION,
      details: `Inscription supprimée: licence ${inscription.licence} du tournoi ${inscription.tournoi_id}`,
      targetType: 'inscription',
      targetId: id,
      targetName: inscription.licence
    });

    res.json({ success: true, message: 'Inscription deleted', deleted: 1 });
  } catch (err) {
    console.error('Error deleting inscription:', err);
    res.status(500).json({ error: err.message });
  }
});

// TEMPORARY: Create test finale data for testing the finale convocation workflow
router.post('/create-test-finale', authenticateToken, async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    // Get the LIBRE R2 category ID
    const category = await new Promise((resolve, reject) => {
      db.get(`
        SELECT id FROM categories WHERE UPPER(game_type) = 'LIBRE' AND UPPER(level) = 'R2' LIMIT 1
      `, [], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    const categoryId = category?.id || 1;

    // Create test finale tournament
    await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO tournoi_ext (tournoi_id, nom, mode, categorie, debut, fin, lieu, taille)
        VALUES (99901, 'Finale Départementale', 'LIBRE', 'R2', '2025-12-15', '2025-12-15', 'Courbevoie', 280)
        ON CONFLICT (tournoi_id) DO UPDATE SET
          nom = EXCLUDED.nom,
          mode = EXCLUDED.mode,
          categorie = EXCLUDED.categorie,
          debut = EXCLUDED.debut
      `, [], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Get 6 players - try players with rankings in LIBRE R2 first, then any active players
    let players = await new Promise((resolve, reject) => {
      db.all(`
        SELECT DISTINCT p.licence, p.first_name, p.last_name, p.club, r.rank_position
        FROM players p
        INNER JOIN rankings r ON REPLACE(p.licence, ' ', '') = REPLACE(r.licence, ' ', '')
        WHERE r.category_id = $1 AND r.season = '2025-2026'
        ORDER BY r.rank_position ASC
        LIMIT 6
      `, [categoryId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Fallback: if no ranked players found, get any active players
    if (players.length === 0) {
      players = await new Promise((resolve, reject) => {
        db.all(`
          SELECT p.licence, p.first_name, p.last_name, p.club
          FROM players p
          WHERE p.is_active = 1
          LIMIT 6
        `, [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      });
    }

    if (players.length === 0) {
      return res.status(400).json({ error: 'No players found in database to create test finale' });
    }

    // Create inscriptions for these players
    let inscriptionId = 999010;
    for (const p of players) {
      await new Promise((resolve, reject) => {
        db.run(`
          INSERT INTO inscriptions (inscription_id, tournoi_id, licence, email, convoque, forfait, timestamp)
          VALUES ($1, 99901, $2, 'jeff_rallet@hotmail.com', 1, 0, NOW())
          ON CONFLICT (inscription_id) DO NOTHING
        `, [inscriptionId, p.licence], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      inscriptionId++;
    }

    res.json({
      success: true,
      message: `Test finale created (ID: 99901) with ${players.length} inscriptions`,
      finale: {
        tournoi_id: 99901,
        nom: 'Finale Départementale',
        mode: 'LIBRE',
        categorie: 'R2',
        debut: '2025-12-15'
      },
      categoryId: categoryId,
      players: players.map(p => ({ name: `${p.first_name} ${p.last_name}`, licence: p.licence, rank: p.rank_position }))
    });

  } catch (error) {
    console.error('Error creating test finale:', error);
    res.status(500).json({ error: error.message });
  }
});

// TEMPORARY: Delete test finale data
router.delete('/delete-test-finale', authenticateToken, async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM inscriptions WHERE inscription_id BETWEEN 999010 AND 999020', [], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await new Promise((resolve, reject) => {
      db.run('DELETE FROM tournoi_ext WHERE tournoi_id = 99901', [], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({ success: true, message: 'Test finale data deleted' });

  } catch (error) {
    console.error('Error deleting test finale:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== TEST: SET CONVOCATION DETAILS ====================

// Test endpoint to manually set convocation details for testing
router.post('/test-set-convocation/:id', authenticateToken, async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { id } = req.params;
  const { poule, lieu, adresse, heure, notes } = req.body;

  try {
    await new Promise((resolve, reject) => {
      db.run(`
        UPDATE inscriptions SET
          convoque = 1,
          convocation_poule = $1,
          convocation_lieu = $2,
          convocation_adresse = $3,
          convocation_heure = $4,
          convocation_notes = $5
        WHERE inscription_id = $6
      `, [
        poule || 'A',
        lieu || 'Billard Club de Châtillon',
        adresse || '15 rue de la Mairie 92320 Châtillon',
        heure || '14:00',
        notes || null,
        id
      ], function(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });

    res.json({ success: true, message: `Convocation details set for inscription ${id}` });
  } catch (error) {
    console.error('Error setting convocation details:', error);
    res.status(500).json({ error: error.message });
  }
});

// Restore convoque=1 for inscriptions that have convocation details stored
router.post('/restore-convoque/:mode/:categorie', authenticateToken, async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { mode, categorie } = req.params;

  try {
    // Find tournament matching mode/categorie that's upcoming
    const tournament = await new Promise((resolve, reject) => {
      db.get(`
        SELECT tournoi_id, nom FROM tournoi_ext
        WHERE UPPER(mode) LIKE UPPER($1)
          AND UPPER(categorie) LIKE UPPER($2)
          AND debut >= date('now')
        ORDER BY debut ASC
        LIMIT 1
      `, [`%${mode}%`, `%${categorie}%`], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!tournament) {
      return res.status(404).json({ error: `No upcoming tournament found for ${mode} ${categorie}` });
    }

    // Update all inscriptions that have convocation_poule set (meaning convocation was sent)
    const result = await new Promise((resolve, reject) => {
      db.run(`
        UPDATE inscriptions
        SET convoque = 1
        WHERE tournoi_id = $1
          AND convocation_poule IS NOT NULL
      `, [tournament.tournoi_id], function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      });
    });

    res.json({
      success: true,
      tournament: tournament.nom,
      tournoi_id: tournament.tournoi_id,
      restored: result.changes,
      message: `Restored convoque=1 for ${result.changes} inscriptions`
    });
  } catch (error) {
    console.error('Error restoring convoque:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get recent inscriptions with convocation details (for testing)
router.get('/test-recent-inscriptions', authenticateToken, async (req, res) => {
  try {
    const inscriptions = await new Promise((resolve, reject) => {
      db.all(`
        SELECT i.inscription_id, i.licence, i.tournoi_id, i.convoque,
               i.convocation_poule, i.convocation_lieu, i.convocation_heure,
               t.nom as tournoi_nom, t.debut
        FROM inscriptions i
        LEFT JOIN tournoi_ext t ON i.tournoi_id = t.tournoi_id
        ORDER BY t.debut DESC
        LIMIT 20
      `, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    res.json(inscriptions || []);
  } catch (error) {
    console.error('Error fetching inscriptions:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== TOURNAMENT RELANCES ====================

// Get upcoming tournaments (within 2 weeks) that need relances
router.get('/upcoming-relances', authenticateToken, async (req, res) => {
  try {
    // Get qualification settings for determining finalist counts
    const qualificationSettings = await appSettings.getQualificationSettings();

    const today = new Date();
    const oneWeekFromNow = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    const twoWeeksFromNow = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);

    // Calculate current season
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth();
    const season = currentMonth >= 8 ? `${currentYear}-${currentYear + 1}` : `${currentYear - 1}-${currentYear}`;

    // Get upcoming tournaments between 7-14 days away (relance window)
    // Tournaments disappear once they're less than 7 days away
    const tournois = await new Promise((resolve, reject) => {
      db.all(`
        SELECT t.*,
               (SELECT COUNT(*) FROM inscriptions i WHERE i.tournoi_id = t.tournoi_id AND (i.forfait IS NULL OR i.forfait != 1) AND (i.statut IS NULL OR i.statut != 'désinscrit')) as inscription_count,
               r.relance_sent_at, r.sent_by, r.recipients_count as relance_recipients
        FROM tournoi_ext t
        LEFT JOIN tournament_relances r ON t.tournoi_id = r.tournoi_id
        WHERE t.debut >= $1 AND t.debut <= $2
        ORDER BY t.debut ASC
      `, [oneWeekFromNow.toISOString().split('T')[0], twoWeeksFromNow.toISOString().split('T')[0]], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // For finales, check if all qualified players are inscribed
    const enrichedTournois = await Promise.all(tournois.map(async (t) => {
      const isFinale = t.nom && t.nom.toUpperCase().includes('FINALE');

      if (!isFinale) {
        return { ...t, isFinale: false };
      }

      // For finales, get finalist count and inscribed count
      try {
        const gameType = t.mode?.toUpperCase();
        const categoryLevel = t.categorie?.toUpperCase();

        // Find matching category
        const category = await new Promise((resolve, reject) => {
          db.get(
            `SELECT * FROM categories WHERE UPPER(game_type) = $1 AND (UPPER(level) = $2 OR UPPER(level) LIKE $3)`,
            [gameType, categoryLevel, `${categoryLevel}%`],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });

        if (!category) {
          return { ...t, isFinale: true, finalist_count: 0, inscribed_finalist_count: 0 };
        }

        // Get rankings for this category
        const rankings = await new Promise((resolve, reject) => {
          db.all(
            `SELECT r.licence FROM rankings r WHERE r.category_id = $1 AND r.season = $2 ORDER BY r.rank_position ASC`,
            [category.id, season],
            (err, rows) => {
              if (err) reject(err);
              else resolve(rows || []);
            }
          );
        });

        // Determine number of finalists based on configured thresholds
        const numFinalists = rankings.length >= qualificationSettings.threshold
          ? qualificationSettings.large
          : qualificationSettings.small;
        const finalistLicences = rankings.slice(0, numFinalists).map(r => r.licence?.replace(/\s/g, ''));

        // Get inscriptions for this tournament (non-forfait)
        const inscriptions = await new Promise((resolve, reject) => {
          db.all(
            `SELECT licence FROM inscriptions WHERE tournoi_id = $1 AND (forfait IS NULL OR forfait != 1)`,
            [t.tournoi_id],
            (err, rows) => {
              if (err) reject(err);
              else resolve(rows || []);
            }
          );
        });

        // Count how many finalists are inscribed
        const inscribedLicences = inscriptions.map(i => i.licence?.replace(/\s/g, ''));
        const inscribedFinalistCount = finalistLicences.filter(l => inscribedLicences.includes(l)).length;

        return {
          ...t,
          isFinale: true,
          finalist_count: finalistLicences.length,
          inscribed_finalist_count: inscribedFinalistCount
        };
      } catch (err) {
        console.error(`Error enriching finale ${t.tournoi_id}:`, err);
        return { ...t, isFinale: true, finalist_count: 0, inscribed_finalist_count: 0 };
      }
    }));

    // Filter to only those without sent relances AND not fully inscribed finales
    const needsRelance = enrichedTournois.filter(t => {
      // Already sent - don't need relance
      if (t.relance_sent_at) return false;

      // For finales: exclude if all finalists are inscribed (100%)
      if (t.isFinale && t.finalist_count > 0 && t.inscribed_finalist_count >= t.finalist_count) {
        return false;
      }

      return true;
    });

    res.json({
      all_upcoming: enrichedTournois,
      needs_relance: needsRelance,
      today: today.toISOString().split('T')[0],
      window_start: oneWeekFromNow.toISOString().split('T')[0],
      window_end: twoWeeksFromNow.toISOString().split('T')[0]
    });

  } catch (error) {
    console.error('Error fetching upcoming relances:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark relance by mode/category/type (auto-find the tournament)
// NOTE: This route MUST come BEFORE /relances/:tournoi_id to avoid Express matching 'mark-by-type' as a tournoi_id
router.post('/relances/mark-by-type', authenticateToken, async (req, res) => {
  const { mode, category, relanceType, recipients_count } = req.body;
  const sent_by = req.user.username;

  if (!mode || !category || !relanceType) {
    return res.status(400).json({ error: 'Mode, category, and relanceType are required' });
  }

  try {
    const today = new Date();
    // Use 4 weeks window to catch tournaments that might be relanced earlier
    const fourWeeksFromNow = new Date(today.getTime() + 28 * 24 * 60 * 60 * 1000);

    // Determine tournament number based on relanceType
    let tournamentNamePattern;
    if (relanceType === 't2') {
      tournamentNamePattern = '%Tournoi 2%';
    } else if (relanceType === 't3') {
      tournamentNamePattern = '%Tournoi 3%';
    } else if (relanceType === 'finale') {
      tournamentNamePattern = '%Finale%';
    } else {
      return res.status(400).json({ error: 'Invalid relanceType' });
    }

    // Find the matching upcoming tournament (flexible category match: N3 matches N3 or N3 GC)
    const categoryUpper = category.toUpperCase();
    const tournament = await new Promise((resolve, reject) => {
      db.get(`
        SELECT tournoi_id FROM tournoi_ext
        WHERE UPPER(mode) = UPPER($1)
          AND (UPPER(categorie) = $2 OR UPPER(categorie) LIKE $3)
          AND UPPER(nom) LIKE UPPER($4)
          AND debut >= $5 AND debut <= $6
        ORDER BY debut ASC
        LIMIT 1
      `, [mode, categoryUpper, categoryUpper + ' %', tournamentNamePattern, today.toISOString().split('T')[0], fourWeeksFromNow.toISOString().split('T')[0]], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!tournament) {
      console.log(`No matching tournament found for ${mode} ${category} ${relanceType}`);
      return res.json({ success: true, message: 'No matching tournament found to mark', marked: false });
    }

    // Mark the relance
    await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO tournament_relances (tournoi_id, sent_by, recipients_count)
        VALUES ($1, $2, $3)
        ON CONFLICT (tournoi_id) DO UPDATE SET
          relance_sent_at = CURRENT_TIMESTAMP,
          sent_by = $2,
          recipients_count = $3
      `, [tournament.tournoi_id, sent_by, recipients_count || 0], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    console.log(`Relance marked for tournament ${tournament.tournoi_id} (${mode} ${category} ${relanceType})`);
    res.json({ success: true, message: 'Relance marked as sent', marked: true, tournoi_id: tournament.tournoi_id });

  } catch (error) {
    console.error('Error marking relance by type:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark a tournament relance as sent (by tournoi_id)
router.post('/relances/:tournoi_id', authenticateToken, async (req, res) => {
  const { tournoi_id } = req.params;
  const { recipients_count } = req.body;
  const sent_by = req.user.username;

  try {
    await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO tournament_relances (tournoi_id, sent_by, recipients_count)
        VALUES ($1, $2, $3)
        ON CONFLICT (tournoi_id) DO UPDATE SET
          relance_sent_at = CURRENT_TIMESTAMP,
          sent_by = $2,
          recipients_count = $3
      `, [tournoi_id, sent_by, recipients_count || 0], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({ success: true, message: 'Relance marked as sent' });

  } catch (error) {
    console.error('Error marking relance as sent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all sent relances
router.get('/relances', authenticateToken, async (req, res) => {
  try {
    const relances = await new Promise((resolve, reject) => {
      db.all(`
        SELECT r.*, t.nom, t.mode, t.categorie, t.debut
        FROM tournament_relances r
        JOIN tournoi_ext t ON r.tournoi_id = t.tournoi_id
        ORDER BY r.relance_sent_at DESC
      `, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    res.json(relances);

  } catch (error) {
    console.error('Error fetching relances:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== POULE SIMULATION ====================

/**
 * GET /api/inscriptions/tournoi/:id/simulation
 * Get poule simulation for a tournament (auto-generated based on inscriptions)
 * Available to all authenticated users
 */
router.get('/tournoi/:id/simulation', authenticateToken, async (req, res) => {
  try {
    // Get qualification settings for determining finalist counts
    const qualificationSettings = await appSettings.getQualificationSettings();

    // Get tournament details
    const tournament = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM tournoi_ext WHERE tournoi_id = $1', [req.params.id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    // Check if simulation should be available (> 7 days before tournament)
    const tournamentDate = new Date(tournament.debut);
    const now = new Date();
    const daysUntil = (tournamentDate - now) / (1000 * 60 * 60 * 24);

    if (daysUntil < 7) {
      return res.json({
        available: false,
        reason: 'simulation_disabled',
        message: 'La simulation n\'est plus disponible à moins de 7 jours de la compétition.'
      });
    }

    // Get inscriptions with player details
    const inscriptions = await new Promise((resolve, reject) => {
      db.all(`
        SELECT i.*, p.first_name, p.last_name, p.club,
               p.rank_libre, p.rank_bande, p.rank_3bandes, p.rank_cadre
        FROM inscriptions i
        LEFT JOIN players p ON REPLACE(i.licence, ' ', '') = REPLACE(p.licence, ' ', '')
        WHERE i.tournoi_id = $1
      `, [req.params.id], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Filter out forfaits and désinscrit players
    let activeInscriptions = inscriptions.filter(i => i.forfait !== 1 && i.statut !== 'désinscrit');

    // For Finales, filter to only include qualified finalists
    const isFinale = tournament.nom && tournament.nom.toUpperCase().includes('FINALE');
    if (isFinale) {
      // Get season from tournament date
      const tournamentDate = new Date(tournament.debut);
      const year = tournamentDate.getFullYear();
      const month = tournamentDate.getMonth();
      const season = month >= 8 ? `${year}-${year + 1}` : `${year - 1}-${year}`;

      // Get category for this tournament
      const gameType = tournament.mode?.toUpperCase();
      const categoryLevel = tournament.categorie?.toUpperCase();

      const category = await new Promise((resolve, reject) => {
        db.get(
          `SELECT * FROM categories WHERE UPPER(game_type) = $1 AND (UPPER(level) = $2 OR UPPER(level) LIKE $3)`,
          [gameType, categoryLevel, `${categoryLevel}%`],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (category) {
        // Get rankings for this category to determine finalists
        const rankings = await new Promise((resolve, reject) => {
          db.all(
            `SELECT r.licence FROM rankings r WHERE r.category_id = $1 AND r.season = $2 ORDER BY r.rank_position ASC`,
            [category.id, season],
            (err, rows) => {
              if (err) reject(err);
              else resolve(rows || []);
            }
          );
        });

        // Determine number of finalists based on configured thresholds
        const numFinalists = rankings.length >= qualificationSettings.threshold
          ? qualificationSettings.large
          : qualificationSettings.small;
        const finalistLicences = rankings.slice(0, numFinalists).map(r => r.licence?.replace(/\s/g, ''));

        // Filter inscriptions to only include finalists
        activeInscriptions = activeInscriptions.filter(i => {
          const licenceNorm = i.licence?.replace(/\s/g, '');
          return finalistLicences.includes(licenceNorm);
        });
      }
    }

    if (activeInscriptions.length < 3) {
      return res.json({
        available: false,
        reason: 'not_enough_players',
        message: `Pas assez de joueurs inscrits (${activeInscriptions.length}/3 minimum)`,
        inscriptionCount: activeInscriptions.length
      });
    }

    // Get CDBHS rankings for this category (same as official poule generation)
    // Map tournament mode to categories.game_type (same mapping as generate-poules.html)
    const modeToGameType = {
      'LIBRE': 'LIBRE',
      '3BANDES': '3BANDES',
      '3 BANDES': '3BANDES',
      'BANDE': 'BANDE',
      'BANDES': 'BANDE',
      '1BANDE': 'BANDE',
      '1 BANDE': 'BANDE',
      'CADRE': 'CADRE'
    };

    // Categories table stores level as 'R2', 'N3', etc. (short form)
    // No mapping needed - use rawLevel directly

    const rawMode = tournament.mode?.toUpperCase();
    const rawLevel = tournament.categorie?.toUpperCase();
    const gameType = modeToGameType[rawMode] || rawMode;
    const categoryLevel = rawLevel; // DB stores 'R2', 'N3', etc.

    // Get season from tournament date
    const tDate = new Date(tournament.debut);
    const tYear = tDate.getFullYear();
    const tMonth = tDate.getMonth();
    const currentSeason = tMonth >= 8 ? `${tYear}-${tYear + 1}` : `${tYear - 1}-${tYear}`;

    // Get category - now using mapped values that match the categories table
    const simCategory = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM categories
         WHERE UPPER(game_type) = $1 AND UPPER(level) = $2`,
        [gameType, categoryLevel],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    console.log(`Simulation: mode=${rawMode}->${gameType}, categorie=${rawLevel}->${categoryLevel}, season=${currentSeason}, category found=${!!simCategory}`);

    // Get CDBHS rankings for sorting
    let cdbhsRankings = [];
    if (simCategory) {
      cdbhsRankings = await new Promise((resolve, reject) => {
        db.all(
          `SELECT r.licence, r.rank_position, p.first_name, p.last_name, p.club
           FROM rankings r
           LEFT JOIN players p ON REPLACE(r.licence, ' ', '') = REPLACE(p.licence, ' ', '')
           WHERE r.category_id = $1 AND r.season = $2
           ORDER BY r.rank_position ASC`,
          [simCategory.id, currentSeason],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });
      console.log(`Simulation: category_id=${simCategory.id}, found ${cdbhsRankings.length} rankings`);
    } else {
      console.log(`Simulation: No category found for ${gameType} ${categoryLevel}`);
    }

    // Create a map of licence -> CDBHS rank position
    const cdbhsRankMap = {};
    cdbhsRankings.forEach(r => {
      const licNorm = r.licence?.replace(/\s/g, '');
      if (licNorm) cdbhsRankMap[licNorm] = r.rank_position;
    });

    // Separate ranked and new players
    const rankedPlayers = [];
    const newPlayers = [];

    activeInscriptions.forEach(insc => {
      const licNorm = insc.licence?.replace(/\s/g, '');
      const cdbhsPosition = cdbhsRankMap[licNorm];

      const playerData = {
        licence: insc.licence,
        first_name: insc.first_name || '',
        last_name: insc.last_name || '',
        club: insc.club || '',
        timestamp: insc.timestamp // Keep timestamp for sorting new players
      };

      if (cdbhsPosition) {
        rankedPlayers.push({
          ...playerData,
          rank: cdbhsPosition,
          rank_display: `#${cdbhsPosition}`,
          isNew: false
        });
      } else {
        newPlayers.push({
          ...playerData,
          rank: null,
          rank_display: 'Nouveau',
          isNew: true
        });
      }
    });

    // Sort ranked players by CDBHS position (ascending - #1 first)
    rankedPlayers.sort((a, b) => a.rank - b.rank);

    // Sort new players by inscription timestamp (earliest first)
    newPlayers.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Combine: ranked players first, then new players by timestamp
    const playersWithRanks = [...rankedPlayers, ...newPlayers];

    // Assign final rank (1, 2, 3... for display)
    playersWithRanks.forEach((p, idx) => {
      p.finalRank = idx + 1;
    });

    // Get poule configuration
    const config = getSimulationPouleConfig(playersWithRanks.length);

    // Distribute players using serpentine algorithm
    const poules = distributeSimulationSerpentine(playersWithRanks, config.poules);

    res.json({
      available: true,
      tournament: {
        id: tournament.tournoi_id,
        nom: tournament.nom,
        mode: tournament.mode,
        categorie: tournament.categorie,
        date: tournament.debut,
        lieu: tournament.lieu
      },
      simulation: {
        generated_at: new Date().toISOString(),
        player_count: playersWithRanks.length,
        config_description: config.description,
        poules: poules.map(p => ({
          number: p.number,
          players: p.players.map(player => ({
            first_name: player.first_name,
            last_name: player.last_name,
            club: player.club,
            rank_display: player.rank_display,
            isNew: player.isNew,
            seed: player.finalRank || player.originalRank
          }))
        }))
      },
      disclaimer: 'SIMULATION - Cette répartition est indicative et peut différer de la convocation officielle.'
    });

  } catch (error) {
    console.error('Get poule simulation error:', error);
    res.status(500).json({ error: 'Failed to generate simulation' });
  }
});

// Poule configuration for simulation
const SIMULATION_POULE_CONFIG = {
  3: { poules: [3], tables: 1 },
  4: { poules: [4], tables: 2 },
  5: { poules: [5], tables: 2 },
  6: { poules: [3, 3], tables: 2 },
  7: { poules: [3, 4], tables: 3 },
  8: { poules: [3, 5], tables: 3 },
  9: { poules: [3, 3, 3], tables: 3 },
  10: { poules: [3, 3, 4], tables: 4 },
  11: { poules: [3, 3, 5], tables: 4 },
  12: { poules: [3, 3, 3, 3], tables: 4 },
  13: { poules: [3, 3, 3, 4], tables: 5 },
  14: { poules: [3, 3, 3, 5], tables: 5 },
  15: { poules: [3, 3, 3, 3, 3], tables: 5 },
  16: { poules: [3, 3, 3, 3, 4], tables: 6 },
  17: { poules: [3, 3, 3, 3, 5], tables: 6 },
  18: { poules: [3, 3, 3, 3, 3, 3], tables: 6 },
  19: { poules: [3, 3, 3, 3, 3, 4], tables: 7 },
  20: { poules: [3, 3, 3, 3, 3, 5], tables: 7 }
};

function getSimulationPouleConfig(numPlayers) {
  if (numPlayers < 3) {
    return { poules: [], tables: 0, description: 'Pas assez de joueurs' };
  }
  if (numPlayers > 20) {
    const base = Math.floor(numPlayers / 3);
    const remainder = numPlayers % 3;
    const poules = Array(base).fill(3);
    if (remainder === 1) {
      poules[poules.length - 1] = 4;
    } else if (remainder === 2) {
      poules[poules.length - 1] = 5;
    }
    return {
      poules,
      tables: poules.length + 1,
      description: formatSimulationPouleDescription(poules)
    };
  }
  const config = SIMULATION_POULE_CONFIG[numPlayers];
  return { ...config, description: formatSimulationPouleDescription(config.poules) };
}

function formatSimulationPouleDescription(poules) {
  if (poules.length === 0) return '-';
  if (poules.length === 1) return `1 poule de ${poules[0]}`;
  const counts = {};
  poules.forEach(size => { counts[size] = (counts[size] || 0) + 1; });
  const parts = [];
  Object.keys(counts).sort((a, b) => a - b).forEach(size => {
    const count = counts[size];
    parts.push(`${count} poule${count > 1 ? 's' : ''} de ${size}`);
  });
  return `${parts.join(' et ')} (${poules.length} poules)`;
}

function distributeSimulationSerpentine(players, pouleSizes) {
  const numPoules = pouleSizes.length;
  const poules = pouleSizes.map((size, i) => ({ number: i + 1, size, players: [] }));
  let playerIndex = 0;
  let round = 0;
  while (playerIndex < players.length) {
    const isLeftToRight = round % 2 === 0;
    for (let i = 0; i < numPoules && playerIndex < players.length; i++) {
      const pouleIndex = isLeftToRight ? i : (numPoules - 1 - i);
      const poule = poules[pouleIndex];
      if (poule.players.length < poule.size) {
        poules[pouleIndex].players.push({ ...players[playerIndex], originalRank: playerIndex + 1 });
        playerIndex++;
      }
    }
    round++;
  }
  return poules;
}

// Update all past inscriptions to convoqué (admin only, one-time utility)
router.post('/bulk-convoque-past', authenticateToken, async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { beforeDate } = req.body;
  const cutoffDate = beforeDate || '2026-01-03';

  try {
    // Count affected rows first
    const countResult = await new Promise((resolve, reject) => {
      db.get(`
        SELECT COUNT(*) as cnt FROM inscriptions i
        JOIN tournoi_ext t ON i.tournoi_id = t.tournoi_id
        WHERE t.debut < $1
        AND (i.convoque = 0 OR i.convoque IS NULL)
        AND (i.forfait = 0 OR i.forfait IS NULL)
        AND (i.statut IS NULL OR i.statut != 'désinscrit')
      `, [cutoffDate], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    console.log(`Will update ${countResult.cnt} inscriptions to convoqué`);

    // Update all inscriptions for past tournaments
    const updateResult = await new Promise((resolve, reject) => {
      db.run(`
        UPDATE inscriptions SET convoque = 1
        WHERE tournoi_id IN (SELECT tournoi_id FROM tournoi_ext WHERE debut < $1)
        AND (convoque = 0 OR convoque IS NULL)
        AND (forfait = 0 OR forfait IS NULL)
        AND (statut IS NULL OR statut != 'désinscrit')
      `, [cutoffDate], function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      });
    });

    res.json({
      success: true,
      message: `Updated ${updateResult.changes} inscriptions to convoqué`,
      beforeDate: cutoffDate,
      affected: updateResult.changes
    });

  } catch (error) {
    console.error('Error bulk updating inscriptions:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
