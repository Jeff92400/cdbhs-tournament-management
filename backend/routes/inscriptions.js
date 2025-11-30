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

    // ==========================================
    // CONVOCATION WORKSHEET
    // ==========================================
    const convocationSheet = workbook.addWorksheet('Convocation');
    const locations = req.body.locations || [];

    // Get location info for each poule
    const getLocationForPoule = (poule) => {
      const locNum = poule.locationNum || '1';
      return locations.find(l => l.locationNum === locNum) || locations[0] || null;
    };

    // HEADER: Season
    convocationSheet.mergeCells('A1:F1');
    convocationSheet.getCell('A1').value = `SAISON ${season}`;
    convocationSheet.getCell('A1').font = { size: 16, bold: true };
    convocationSheet.getCell('A1').alignment = { horizontal: 'center' };
    convocationSheet.getRow(1).height = 30;

    // HEADER: Date in red
    convocationSheet.mergeCells('A3:F3');
    const dateStrFull = tournamentDate
      ? new Date(tournamentDate).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()
      : 'DATE À DÉFINIR';
    convocationSheet.getCell('A3').value = dateStrFull;
    convocationSheet.getCell('A3').font = { size: 14, bold: true, color: { argb: 'FFFF0000' } };
    convocationSheet.getCell('A3').alignment = { horizontal: 'center' };
    convocationSheet.getRow(3).height = 25;

    // HEADER: Tournament info
    convocationSheet.mergeCells('A5:C5');
    convocationSheet.getCell('A5').value = `TOURNOI N° ${tournament}`;
    convocationSheet.getCell('A5').font = { size: 12, bold: true };
    convocationSheet.getCell('A5').border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

    convocationSheet.mergeCells('D5:F5');
    convocationSheet.getCell('D5').value = category.display_name;
    convocationSheet.getCell('D5').font = { size: 12, bold: true };
    convocationSheet.getCell('D5').border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

    let convRow = 8;

    // Each poule with its location
    poules.forEach((poule, pouleIndex) => {
      const loc = getLocationForPoule(poule);
      const locName = loc?.name || tournamentLieu || 'À définir';
      const locStreet = loc?.street || '';
      const locZipCode = loc?.zip_code || '';
      const locCity = loc?.city || '';
      const fullAddress = [locName, locStreet, locZipCode, locCity].filter(Boolean).join(' ');
      const locPhone = loc?.phone || '';
      const locEmail = loc?.email || '';
      const locTime = loc?.startTime || '14:00';

      // "Au Club de" header
      convocationSheet.mergeCells(`A${convRow}:B${convRow}`);
      convocationSheet.getCell(`A${convRow}`).value = 'Au Club de';
      convocationSheet.getCell(`A${convRow}`).font = { bold: true };
      convocationSheet.getCell(`A${convRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
      convocationSheet.getCell(`A${convRow}`).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

      convocationSheet.mergeCells(`C${convRow}:F${convRow}`);
      convocationSheet.getCell(`C${convRow}`).value = fullAddress.toUpperCase();
      convocationSheet.getCell(`C${convRow}`).font = { bold: true };
      convocationSheet.getCell(`C${convRow}`).alignment = { horizontal: 'center' };
      convocationSheet.getCell(`C${convRow}`).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      convRow++;

      // Heure + Téléphone + Mail row
      convocationSheet.getCell(`A${convRow}`).value = 'Heure';
      convocationSheet.getCell(`A${convRow}`).font = { bold: true };
      convocationSheet.getCell(`A${convRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
      convocationSheet.getCell(`A${convRow}`).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

      convocationSheet.getCell(`B${convRow}`).value = locTime.replace(':', 'H');
      convocationSheet.getCell(`B${convRow}`).font = { bold: true, color: { argb: 'FFFF0000' } };
      convocationSheet.getCell(`B${convRow}`).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

      convocationSheet.getCell(`C${convRow}`).value = `Téléphone  ${locPhone}`;
      convocationSheet.getCell(`C${convRow}`).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

      convocationSheet.mergeCells(`D${convRow}:F${convRow}`);
      convocationSheet.getCell(`D${convRow}`).value = `Mail  ${locEmail}`;
      convocationSheet.getCell(`D${convRow}`).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      convRow++;

      // POULE header
      convocationSheet.mergeCells(`A${convRow}:F${convRow}`);
      convocationSheet.getCell(`A${convRow}`).value = `POULE ${poule.number}`;
      convocationSheet.getCell(`A${convRow}`).font = { bold: true };
      convocationSheet.getCell(`A${convRow}`).alignment = { horizontal: 'left' };
      convRow++;

      // Column headers
      const headerCols = ['Rang', 'n° licence', 'Nom', 'Prénom', 'n°', 'CLUB'];
      headerCols.forEach((header, i) => {
        const col = String.fromCharCode(65 + i); // A, B, C, D, E, F
        convocationSheet.getCell(`${col}${convRow}`).value = header;
        convocationSheet.getCell(`${col}${convRow}`).font = { bold: true, size: 10 };
        convocationSheet.getCell(`${col}${convRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3D3D3' } };
        convocationSheet.getCell(`${col}${convRow}`).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });
      convRow++;

      // Players
      poule.players.forEach((player) => {
        convocationSheet.getCell(`A${convRow}`).value = player.finalRank || player.originalRank;
        convocationSheet.getCell(`A${convRow}`).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

        convocationSheet.getCell(`B${convRow}`).value = player.licence;
        convocationSheet.getCell(`B${convRow}`).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

        convocationSheet.getCell(`C${convRow}`).value = player.last_name?.toUpperCase();
        convocationSheet.getCell(`C${convRow}`).font = { bold: true };
        convocationSheet.getCell(`C${convRow}`).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

        convocationSheet.getCell(`D${convRow}`).value = player.first_name?.toUpperCase();
        convocationSheet.getCell(`D${convRow}`).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

        convocationSheet.getCell(`E${convRow}`).value = ''; // n° - placeholder
        convocationSheet.getCell(`E${convRow}`).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

        convocationSheet.getCell(`F${convRow}`).value = player.club?.toUpperCase() || '';
        convocationSheet.getCell(`F${convRow}`).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

        convRow++;
      });

      // Note about same club players
      if (pouleIndex < poules.length - 1) {
        convocationSheet.mergeCells(`A${convRow}:F${convRow}`);
        convocationSheet.getCell(`A${convRow}`).value = "Les joueurs d'un même club jouent ensemble au 1er tour";
        convocationSheet.getCell(`A${convRow}`).font = { italic: true, size: 10, color: { argb: 'FF666666' } };
        convocationSheet.getCell(`A${convRow}`).alignment = { horizontal: 'center' };
        convRow += 2;
      }
    });

    // Set convocation column widths
    convocationSheet.columns = [
      { width: 8 },   // Rang
      { width: 12 },  // Licence
      { width: 18 },  // Nom
      { width: 15 },  // Prénom
      { width: 8 },   // n°
      { width: 25 }   // Club
    ];

    // ==========================================
    // CONVOCATION V2 - IMPROVED DESIGN
    // ==========================================
    const convV2 = workbook.addWorksheet('Convocation v2');

    // Page setup for A4 printing - fit everything on 1 page
    convV2.pageSetup = {
      paperSize: 9,  // A4
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,  // Force to 1 page
      margins: {
        left: 0.4,
        right: 0.4,
        top: 0.4,
        bottom: 0.4,
        header: 0.2,
        footer: 0.2
      }
    };

    // Define colors
    const colors = {
      primary: 'FF1F4788',      // Dark blue
      secondary: 'FF667EEA',    // Purple
      accent: 'FFFFC107',       // Yellow/Gold
      light: 'FFF8F9FA',        // Light gray
      white: 'FFFFFFFF',
      red: 'FFDC3545',
      darkText: 'FF333333',
      lightText: 'FF666666'
    };

    // Set column widths - enlarged for better A4 coverage
    convV2.columns = [
      { width: 10 },   // A - Rang
      { width: 16 },   // B - Licence
      { width: 28 },   // C - Nom
      { width: 24 },   // D - Prénom
      { width: 45 },   // E - Club
      { width: 5 }     // F - empty/padding
    ];

    // Define standard black border for all cells
    const blackBorder = {
      top: { style: 'thin', color: { argb: 'FF000000' } },
      left: { style: 'thin', color: { argb: 'FF000000' } },
      bottom: { style: 'thin', color: { argb: 'FF000000' } },
      right: { style: 'thin', color: { argb: 'FF000000' } }
    };

    let v2Row = 1;

    // === HEADER SECTION ===
    // Convocation title
    convV2.mergeCells(`A${v2Row}:E${v2Row}`);
    convV2.getCell(`A${v2Row}`).value = `CONVOCATION TOURNOI N°${tournament}`;
    convV2.getCell(`A${v2Row}`).font = { size: 24, bold: true, color: { argb: colors.white } };
    convV2.getCell(`A${v2Row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.primary } };
    convV2.getCell(`A${v2Row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    convV2.getCell(`A${v2Row}`).border = blackBorder;
    convV2.getRow(v2Row).height = 50;
    v2Row++;

    // Season banner
    convV2.mergeCells(`A${v2Row}:E${v2Row}`);
    convV2.getCell(`A${v2Row}`).value = `SAISON ${season}`;
    convV2.getCell(`A${v2Row}`).font = { size: 16, bold: true, color: { argb: colors.white } };
    convV2.getCell(`A${v2Row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.secondary } };
    convV2.getCell(`A${v2Row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    convV2.getCell(`A${v2Row}`).border = blackBorder;
    convV2.getRow(v2Row).height = 35;
    v2Row++;

    // Empty row
    convV2.getRow(v2Row).height = 15;
    v2Row++;

    // Date - prominent display
    convV2.mergeCells(`A${v2Row}:E${v2Row}`);
    const v2DateStr = tournamentDate
      ? new Date(tournamentDate).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()
      : 'DATE À DÉFINIR';
    convV2.getCell(`A${v2Row}`).value = v2DateStr;
    convV2.getCell(`A${v2Row}`).font = { size: 18, bold: true, color: { argb: colors.red } };
    convV2.getCell(`A${v2Row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    convV2.getCell(`A${v2Row}`).border = blackBorder;
    convV2.getRow(v2Row).height = 35;
    v2Row++;

    // Empty row
    convV2.getRow(v2Row).height = 15;
    v2Row++;

    // Category info box (full width since tournament number is now in title)
    convV2.mergeCells(`A${v2Row}:E${v2Row}`);
    convV2.getCell(`A${v2Row}`).value = category.display_name;
    convV2.getCell(`A${v2Row}`).font = { size: 16, bold: true, color: { argb: colors.white } };
    convV2.getCell(`A${v2Row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.secondary } };
    convV2.getCell(`A${v2Row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    convV2.getCell(`A${v2Row}`).border = blackBorder;
    convV2.getRow(v2Row).height = 35;
    v2Row++;

    // Space before poules
    v2Row += 1;

    // === POULES SECTION ===
    poules.forEach((poule, pouleIndex) => {
      const loc = getLocationForPoule(poule);
      const locName = loc?.name || tournamentLieu || 'À définir';
      const locStreet = loc?.street || '';
      const locZipCode = loc?.zip_code || '';
      const locCity = loc?.city || '';
      const fullAddress = [locStreet, locZipCode, locCity].filter(Boolean).join(' ');
      const locPhone = loc?.phone || '';
      const locEmail = loc?.email || '';
      const locTime = loc?.startTime || '14:00';

      // Location header bar
      convV2.mergeCells(`A${v2Row}:E${v2Row}`);
      convV2.getCell(`A${v2Row}`).value = `📍 ${locName.toUpperCase()}`;
      convV2.getCell(`A${v2Row}`).font = { size: 14, bold: true, color: { argb: colors.darkText } };
      convV2.getCell(`A${v2Row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.accent } };
      convV2.getCell(`A${v2Row}`).alignment = { horizontal: 'center', vertical: 'middle' };
      convV2.getCell(`A${v2Row}`).border = blackBorder;
      convV2.getRow(v2Row).height = 32;
      v2Row++;

      // Address line
      if (fullAddress) {
        convV2.mergeCells(`A${v2Row}:E${v2Row}`);
        convV2.getCell(`A${v2Row}`).value = fullAddress;
        convV2.getCell(`A${v2Row}`).font = { size: 12, color: { argb: colors.darkText } };
        convV2.getCell(`A${v2Row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.accent } };
        convV2.getCell(`A${v2Row}`).alignment = { horizontal: 'center', vertical: 'middle' };
        convV2.getCell(`A${v2Row}`).border = blackBorder;
        convV2.getRow(v2Row).height = 26;
        v2Row++;
      }

      // Time and contact info row
      convV2.getCell(`A${v2Row}`).value = '🕐';
      convV2.getCell(`A${v2Row}`).alignment = { horizontal: 'center', vertical: 'middle' };
      convV2.getCell(`A${v2Row}`).border = blackBorder;
      convV2.getCell(`B${v2Row}`).value = locTime.replace(':', 'H');
      convV2.getCell(`B${v2Row}`).font = { size: 14, bold: true, color: { argb: colors.red } };
      convV2.getCell(`B${v2Row}`).alignment = { vertical: 'middle' };
      convV2.getCell(`B${v2Row}`).border = blackBorder;
      convV2.getCell(`C${v2Row}`).value = locPhone ? `📞 ${locPhone}` : '';
      convV2.getCell(`C${v2Row}`).font = { size: 11, color: { argb: colors.lightText } };
      convV2.getCell(`C${v2Row}`).alignment = { vertical: 'middle' };
      convV2.getCell(`C${v2Row}`).border = blackBorder;
      convV2.mergeCells(`D${v2Row}:E${v2Row}`);
      convV2.getCell(`D${v2Row}`).value = locEmail ? `✉️ ${locEmail}` : '';
      convV2.getCell(`D${v2Row}`).font = { size: 11, color: { argb: colors.lightText } };
      convV2.getCell(`D${v2Row}`).alignment = { vertical: 'middle' };
      convV2.getCell(`D${v2Row}`).border = blackBorder;
      convV2.getRow(v2Row).height = 28;
      v2Row++;

      // Poule title
      convV2.mergeCells(`A${v2Row}:E${v2Row}`);
      convV2.getCell(`A${v2Row}`).value = `POULE ${poule.number}`;
      convV2.getCell(`A${v2Row}`).font = { size: 14, bold: true, color: { argb: colors.white } };
      convV2.getCell(`A${v2Row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.primary } };
      convV2.getCell(`A${v2Row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      convV2.getCell(`A${v2Row}`).border = blackBorder;
      convV2.getRow(v2Row).height = 30;
      v2Row++;

      // Table headers
      const v2Headers = ['#', 'Licence', 'Nom', 'Prénom', 'Club'];
      v2Headers.forEach((header, i) => {
        const col = String.fromCharCode(65 + i);
        convV2.getCell(`${col}${v2Row}`).value = header;
        convV2.getCell(`${col}${v2Row}`).font = { size: 11, bold: true, color: { argb: colors.white } };
        convV2.getCell(`${col}${v2Row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.secondary } };
        convV2.getCell(`${col}${v2Row}`).alignment = { horizontal: 'center', vertical: 'middle' };
        convV2.getCell(`${col}${v2Row}`).border = blackBorder;
      });
      convV2.getRow(v2Row).height = 28;
      v2Row++;

      // Players with alternating colors
      poule.players.forEach((player, pIndex) => {
        const isEven = pIndex % 2 === 0;
        const rowColor = isEven ? colors.white : colors.light;

        convV2.getCell(`A${v2Row}`).value = player.finalRank || '';
        convV2.getCell(`B${v2Row}`).value = player.licence || '';
        convV2.getCell(`C${v2Row}`).value = (player.last_name || '').toUpperCase();
        convV2.getCell(`C${v2Row}`).font = { bold: true, size: 11 };
        convV2.getCell(`D${v2Row}`).value = player.first_name || '';
        convV2.getCell(`D${v2Row}`).font = { size: 11 };
        convV2.getCell(`E${v2Row}`).value = player.club || '';
        convV2.getCell(`E${v2Row}`).font = { size: 10 };

        // Apply styling to all cells in row
        ['A', 'B', 'C', 'D', 'E'].forEach(col => {
          convV2.getCell(`${col}${v2Row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowColor } };
          convV2.getCell(`${col}${v2Row}`).border = blackBorder;
          convV2.getCell(`${col}${v2Row}`).alignment = { vertical: 'middle' };
        });
        convV2.getCell(`A${v2Row}`).alignment = { horizontal: 'center', vertical: 'middle' };
        convV2.getCell(`B${v2Row}`).alignment = { horizontal: 'center', vertical: 'middle' };
        convV2.getRow(v2Row).height = 26;
        v2Row++;
      });

      // Note about same club
      convV2.mergeCells(`A${v2Row}:E${v2Row}`);
      convV2.getCell(`A${v2Row}`).value = "ℹ️ Les joueurs d'un même club jouent ensemble au 1er tour";
      convV2.getCell(`A${v2Row}`).font = { size: 10, italic: true, color: { argb: colors.lightText } };
      convV2.getCell(`A${v2Row}`).alignment = { horizontal: 'center', vertical: 'middle' };
      convV2.getRow(v2Row).height = 24;
      v2Row += 2;
    });

    // Footer
    v2Row++;
    convV2.mergeCells(`A${v2Row}:E${v2Row}`);
    convV2.getCell(`A${v2Row}`).value = `Document généré le ${new Date().toLocaleDateString('fr-FR')} • CDBHS`;
    convV2.getCell(`A${v2Row}`).font = { size: 10, italic: true, color: { argb: colors.lightText } };
    convV2.getCell(`A${v2Row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    convV2.getRow(v2Row).height = 25;

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

// Get upcoming tournaments (for the current weekend and next weekend)
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

  // Format dates for SQL - use ISO format for proper PostgreSQL date comparison
  const startDate = tomorrow.toISOString().split('T')[0];
  const endDate = nextSunday.toISOString().split('T')[0];

  console.log(`Fetching upcoming tournaments from ${startDate} to ${endDate}`);

  // Simple query first to get tournaments, then we'll count inscriptions
  const query = `
    SELECT * FROM tournoi_ext
    WHERE debut >= $1 AND debut <= $2
    ORDER BY debut ASC, mode, categorie
  `;

  db.all(query, [startDate, endDate], (err, rows) => {
    if (err) {
      console.error('Error fetching upcoming tournaments:', err);
      return res.status(500).json({ error: err.message });
    }

    // Add inscrit_count as 0 for now (can be enhanced later)
    const results = (rows || []).map(row => ({
      ...row,
      inscrit_count: 0
    }));

    console.log(`Found ${results.length} upcoming tournaments`);
    res.json(results);
  });
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

module.exports = router;
