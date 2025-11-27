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
router.get('/tournoi', authenticateToken, (req, res) => {
  const { mode, categorie } = req.query;

  let query = 'SELECT * FROM tournoi_ext';
  const params = [];
  const conditions = [];

  if (mode) {
    // Case-insensitive matching for mode
    conditions.push(`UPPER(mode) = UPPER($${params.length + 1})`);
    params.push(mode);
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

module.exports = router;
