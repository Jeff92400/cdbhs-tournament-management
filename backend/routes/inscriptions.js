const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse');
const fs = require('fs');
const ExcelJS = require('exceljs');
const db = require('../db-loader');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

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
        // Map CSV columns to database fields
        const inscriptionId = parseInt(record.INSCRIPTION_ID || record.inscription_id);
        const joueurId = parseInt(record.JOUEUR_ID || record.joueur_id) || null;
        const tournoiId = parseInt(record.TOURNOI_ID || record.tournoi_id);
        const timestamp = parseDateTime(record.TIMESTAMP || record.timestamp);
        const email = record.EMAIL || record.email || '';
        const telephone = record.TELEPHONE || record.telephone || '';
        const licence = (record.LICENCE || record.licence || '').replace(/\s+/g, '').trim();
        const convoque = parseInt(record.CONVOQUE || record.convoque) || 0;
        const forfait = parseInt(record.FORFAIT || record.forfait) || 0;
        const commentaire = record.COMMENTAIRE || record.commentaire || '';

        if (!inscriptionId || !tournoiId) {
          errors.push({ inscriptionId, error: 'Missing required fields' });
          continue;
        }

        const query = `
          INSERT INTO inscriptions (inscription_id, joueur_id, tournoi_id, timestamp, email, telephone, licence, convoque, forfait, commentaire)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT(inscription_id) DO UPDATE SET
            joueur_id = EXCLUDED.joueur_id,
            tournoi_id = EXCLUDED.tournoi_id,
            timestamp = EXCLUDED.timestamp,
            email = EXCLUDED.email,
            telephone = EXCLUDED.telephone,
            licence = EXCLUDED.licence,
            convoque = EXCLUDED.convoque,
            forfait = EXCLUDED.forfait,
            commentaire = EXCLUDED.commentaire
        `;

        await new Promise((resolve, reject) => {
          db.run(query, [inscriptionId, joueurId, tournoiId, timestamp, email, telephone, licence, convoque, forfait, commentaire], function(err) {
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
    // Case-insensitive matching for categorie
    conditions.push(`UPPER(categorie) = UPPER($${params.length + 1})`);
    params.push(categorie);
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
           COALESCE(COUNT(CASE WHEN i.forfait != 1 OR i.forfait IS NULL THEN 1 END), 0) as inscrit_count
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
router.get('/finales/upcoming', authenticateToken, (req, res) => {
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

  // Finals are identified by name containing "Finale" (case insensitive)
  const query = `
    SELECT t.*,
           COALESCE(COUNT(CASE WHEN i.forfait != 1 OR i.forfait IS NULL THEN 1 END), 0) as inscrit_count
    FROM tournoi_ext t
    LEFT JOIN inscriptions i ON t.tournoi_id = i.tournoi_id
    WHERE t.debut >= $1 AND t.debut <= $2
    AND LOWER(t.nom) LIKE '%finale%'
    GROUP BY t.tournoi_id
    ORDER BY t.debut ASC, t.mode, t.categorie
  `;

  db.all(query, [startDate, endDate], (err, rows) => {
    if (err) {
      console.error('Error fetching upcoming finals:', err);
      return res.status(500).json({ error: err.message });
    }

    console.log(`Found ${(rows || []).length} upcoming finals`);
    res.json(rows || []);
  });
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
  const { tournoi_id, licence } = req.query;

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
      convocationSheet.getCell(`A${convRow}`).value = `La moyenne qualificative pour cette categorie est entre ${parseFloat(gameParams.moyenne_mini).toFixed(3)} et ${parseFloat(gameParams.moyenne_maxi).toFixed(3)}`;
      convocationSheet.getCell(`A${convRow}`).font = { size: 10, italic: true, color: { argb: 'FF666666' } };
      convocationSheet.getCell(`A${convRow}`).alignment = { horizontal: 'center' };
      convRow++;

      convocationSheet.mergeCells(`A${convRow}:H${convRow}`);
      convocationSheet.getCell(`A${convRow}`).value = `Les colonnes Moyenne et Classement en face du nom de chaque joueur correspondent aux positions cumulees a la suite du dernier tournoi joue`;
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

// Update a tournament (admin only)
router.put('/tournoi/:id', authenticateToken, (req, res) => {
  // Check admin role
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { id } = req.params;
  const { nom, mode, categorie, taille, debut, fin, grand_coin, taille_cadre, lieu } = req.body;

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
      lieu = $9
    WHERE tournoi_id = $10
  `;

  db.run(query, [nom, mode, categorie, taille || null, debut || null, fin || null, grand_coin || 0, taille_cadre, lieu, id], function(err) {
    if (err) {
      console.error('Error updating tournament:', err);
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    res.json({ success: true, message: 'Tournament updated' });
  });
});

// Update an inscription (admin only)
router.put('/:id', authenticateToken, (req, res) => {
  // Check admin role
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { id } = req.params;
  const { licence, email, telephone, convoque, forfait, commentaire } = req.body;

  const query = `
    UPDATE inscriptions SET
      licence = $1,
      email = $2,
      telephone = $3,
      convoque = $4,
      forfait = $5,
      commentaire = $6
    WHERE inscription_id = $7
  `;

  db.run(query, [licence, email, telephone, convoque || 0, forfait || 0, commentaire, id], function(err) {
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

module.exports = router;
