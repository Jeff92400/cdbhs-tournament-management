const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse');
const path = require('path');
const fs = require('fs');
const db = require('../db-loader');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Configure multer for file uploads
let upload;
try {
  const uploadsDir = path.join(__dirname, '../uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  upload = multer({ dest: uploadsDir });
  console.log('Multer configured successfully, uploads dir:', uploadsDir);
} catch (error) {
  console.error('Error configuring multer:', error);
  // Create a dummy upload middleware
  upload = { single: () => (req, res, next) => next() };
}

// Get all categories
router.get('/categories', authenticateToken, (req, res) => {
  db.all('SELECT * FROM categories ORDER BY game_type, level', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Validate tournament CSV and check for unknown players
router.post('/validate', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    let fileContent = fs.readFileSync(req.file.path, 'utf-8');

    // Fix CSV format
    const lines = fileContent.split('\n');
    const fixedLines = lines.map(line => {
      line = line.trim();
      if (!line) return line;
      if (line.startsWith('"') && line.endsWith('"')) {
        line = line.slice(1, -1);
      }
      line = line.replace(/""/g, '"');
      return line;
    });

    fileContent = fixedLines.join('\n');
    const records = [];

    const parser = parse(fileContent, {
      delimiter: ';',
      skip_empty_lines: true,
      quote: '"',
      escape: '"',
      relax_column_count: true
    });

    for await (const record of parser) {
      records.push(record);
    }

    // Check for unknown players
    const unknownPlayers = [];
    const checkedLicences = new Set();

    for (const record of records) {
      try {
        if (record[0]?.includes('Classt') || record[0]?.includes('Licence')) continue;

        const licence = record[1]?.replace(/"/g, '').replace(/ /g, '').trim();
        const playerName = record[2]?.replace(/"/g, '').trim();

        if (!licence || !playerName) continue;
        if (checkedLicences.has(licence)) continue;

        checkedLicences.add(licence);

        // Check if player exists by licence OR name
        const existsQuery = `
          SELECT licence, first_name, last_name
          FROM players
          WHERE REPLACE(licence, ' ', '') = ?
             OR (UPPER(first_name || ' ' || last_name) = UPPER(?)
                 OR UPPER(last_name || ' ' || first_name) = UPPER(?))
        `;

        await new Promise((resolve) => {
          db.get(existsQuery, [licence, playerName, playerName], (err, player) => {
            if (err) {
              console.error('Error checking player:', err);
              resolve();
              return;
            }

            if (!player) {
              // Player doesn't exist
              const nameParts = playerName.split(' ');
              const lastName = nameParts[0] || '';
              const firstName = nameParts.slice(1).join(' ') || '';

              unknownPlayers.push({
                licence,
                firstName,
                lastName,
                fullName: playerName
              });
            }
            resolve();
          });
        });
      } catch (err) {
        console.error('Error parsing record:', err);
      }
    }

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    if (unknownPlayers.length > 0) {
      return res.json({
        status: 'validation_required',
        unknownPlayers
      });
    } else {
      return res.json({
        status: 'ready',
        message: 'All players exist, ready to import'
      });
    }

  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: error.message });
  }
});

// Batch create players
router.post('/create-players', authenticateToken, async (req, res) => {
  const { players } = req.body;

  if (!players || !Array.isArray(players)) {
    return res.status(400).json({ error: 'Players array required' });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO players (licence, first_name, last_name, club, is_active)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (licence) DO UPDATE SET
        club = EXCLUDED.club
    `);

    let created = 0;
    let createError = null;

    for (const player of players) {
      await new Promise((resolve) => {
        stmt.run(player.licence, player.firstName, player.lastName, player.club, (err) => {
          if (err && !createError) {
            createError = err;
            console.error('Error creating player:', err);
          } else {
            created++;
          }
          resolve();
        });
      });
    }

    stmt.finalize((err) => {
      if (err || createError) {
        return res.status(500).json({ error: 'Error creating players' });
      }
      res.json({ message: `${created} players created successfully` });
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check if tournament exists (for warning before overwrite)
router.get('/check-exists', authenticateToken, (req, res) => {
  const { categoryId, tournamentNumber, season } = req.query;

  if (!categoryId || !tournamentNumber || !season) {
    return res.status(400).json({ error: 'Category ID, tournament number, and season required' });
  }

  const query = `
    SELECT t.id, t.tournament_date, t.import_date, c.display_name,
           COUNT(tr.id) as player_count
    FROM tournaments t
    JOIN categories c ON t.category_id = c.id
    LEFT JOIN tournament_results tr ON tr.tournament_id = t.id
    WHERE t.category_id = $1 AND t.tournament_number = $2 AND t.season = $3
    GROUP BY t.id, t.tournament_date, t.import_date, c.display_name
  `;

  db.get(query, [categoryId, tournamentNumber, season], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (row) {
      res.json({
        exists: true,
        tournament: {
          id: row.id,
          categoryName: row.display_name,
          tournamentNumber: tournamentNumber,
          season: season,
          tournamentDate: row.tournament_date,
          importDate: row.import_date,
          playerCount: row.player_count
        }
      });
    } else {
      res.json({ exists: false });
    }
  });
});

// Import tournament results from CSV
router.post('/import', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const { categoryId, tournamentNumber, season, tournamentDate } = req.body;

  if (!categoryId || !tournamentNumber || !season) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Category, tournament number, and season required' });
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
      delimiter: ';',
      skip_empty_lines: true,
      quote: '"',
      escape: '"',
      relax_column_count: true
    });

    for await (const record of parser) {
      records.push(record);
    }

    // Start transaction
    db.serialize(() => {
      // Create or get tournament
      db.run(
        `INSERT INTO tournaments (category_id, tournament_number, season, tournament_date)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(category_id, tournament_number, season) DO UPDATE SET
           tournament_date = ?,
           import_date = CURRENT_TIMESTAMP
         RETURNING id`,
        [categoryId, tournamentNumber, season, tournamentDate, tournamentDate],
        function(err) {
          if (err) {
            fs.unlinkSync(req.file.path);
            return res.status(500).json({ error: err.message });
          }

          const tournamentId = this.lastID;

          // If UPDATE was triggered, get the existing tournament ID
          db.get(
            'SELECT id FROM tournaments WHERE category_id = ? AND tournament_number = ? AND season = ?',
            [categoryId, tournamentNumber, season],
            (err, row) => {
              if (err) {
                fs.unlinkSync(req.file.path);
                return res.status(500).json({ error: err.message });
              }

              const finalTournamentId = row ? row.id : tournamentId;

              // Delete existing results for this tournament
              db.run('DELETE FROM tournament_results WHERE tournament_id = ?', [finalTournamentId], (err) => {
                if (err) {
                  fs.unlinkSync(req.file.path);
                  return res.status(500).json({ error: err.message });
                }

                // Insert tournament results
                let imported = 0;
                let errors = [];

                // First, ensure all players exist in the players table
                const playerStmt = db.prepare(`
                  INSERT INTO players (licence, first_name, last_name, club, is_active)
                  VALUES (?, ?, ?, ?, 1)
                  ON CONFLICT (licence) DO NOTHING
                `);

                // Parse and create players first
                let playerInsertCount = 0;
                let playerInsertTotal = 0;
                let playerInsertError = null;

                for (const record of records) {
                  try {
                    // Skip header row
                    if (record[0]?.includes('Classt') || record[0]?.includes('Licence')) continue;

                    const licence = record[1]?.replace(/"/g, '').replace(/ /g, '').trim(); // Remove spaces
                    const playerName = record[2]?.replace(/"/g, '').trim();

                    if (!licence || !playerName) continue;

                    // Split player name into first and last name
                    // Tournament CSV format: "LASTNAME FIRSTNAME"
                    const nameParts = playerName.split(' ');
                    const lastName = nameParts[0] || '';
                    const firstName = nameParts.slice(1).join(' ') || '';

                    playerInsertTotal++;

                    // Note: Tournament CSV doesn't include club info
                    // Club will be set when importing JOUEURS.csv separately
                    playerStmt.run(licence, firstName, lastName, 'Club inconnu', (err) => {
                      if (err && !playerInsertError) {
                        playerInsertError = err;
                        console.error('Error creating player:', err);
                      }
                      playerInsertCount++;

                      // Check if all player inserts are done
                      if (playerInsertCount === playerInsertTotal) {
                        // All players created, now finalize and insert tournament results
                        playerStmt.finalize((finalizeErr) => {
                          if (finalizeErr) {
                            console.error('Error finalizing player statement:', finalizeErr);
                          }
                          insertTournamentResults();
                        });
                      }
                    });
                  } catch (err) {
                    console.error('Error parsing player record:', err);
                  }
                }

                // If no players to insert, skip directly to tournament results
                if (playerInsertTotal === 0) {
                  playerStmt.finalize(() => {
                    insertTournamentResults();
                  });
                }

                function insertTournamentResults() {

                  // Now insert tournament results
                  const stmt = db.prepare(`
                    INSERT INTO tournament_results (tournament_id, licence, player_name, match_points, moyenne, serie, points, reprises)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  `);

                  for (const record of records) {
                    try {
                      // Skip header row
                      if (record[0]?.includes('Classt') || record[0]?.includes('Licence')) continue;

                      // Parse CSV format from the tournament results
                      // Column B (index 1): Licence
                      // Column C (index 2): Joueur
                      // Column E (index 4): Pts match (match points)
                      // Column G (index 6): Moyenne (3.10)
                      // Column I (index 8): Reprises
                      // Column J (index 9): Série
                      // Column M (index 12): Points (R) - game points
                      const licence = record[1]?.replace(/"/g, '').replace(/ /g, '').trim(); // Remove spaces
                      const playerName = record[2]?.replace(/"/g, '').trim();
                      const matchPoints = parseInt(record[4]?.replace(/"/g, '').trim()) || 0;
                      const moyenneStr = record[6]?.replace(/"/g, '').replace(',', '.').trim();
                      const moyenne = parseFloat(moyenneStr) || 0;
                      const reprises = parseInt(record[8]?.replace(/"/g, '').trim()) || 0;
                      const serie = parseInt(record[9]?.replace(/"/g, '').trim()) || 0;
                      const points = parseInt(record[12]?.replace(/"/g, '').trim()) || 0;

                      if (!licence || !playerName) continue;

                      stmt.run(finalTournamentId, licence, playerName, matchPoints, moyenne, serie, points, reprises, (err) => {
                        if (err) {
                          errors.push({ licence, error: err.message });
                        } else {
                          imported++;
                        }
                      });
                    } catch (err) {
                      errors.push({ record: record[0], error: err.message });
                    }
                  }

                  stmt.finalize((err) => {
                    if (err) {
                      fs.unlinkSync(req.file.path);
                      return res.status(500).json({ error: 'Error finalizing import' });
                    }

                    // Recalculate rankings for this category and season
                    recalculateRankings(categoryId, season, () => {
                      // Clean up uploaded file
                      fs.unlinkSync(req.file.path);

                      res.json({
                        message: 'Tournament imported successfully',
                        tournamentId: finalTournamentId,
                        imported,
                        errors: errors.length > 0 ? errors : undefined
                      });
                    });
                  });
                } // Close insertTournamentResults function
              });
            }
          );
        }
      );
    });

  } catch (error) {
    // Clean up uploaded file
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: error.message });
  }
});

// Recalculate rankings for a category and season
function recalculateRankings(categoryId, season, callback) {
  // Get all tournament results for this category and season
  // Exclude finale (tournament_number = 4) from ranking calculation
  // Ranking order: 1) match points DESC, 2) cumulative moyenne DESC, 3) best serie DESC
  const query = `
    SELECT
      REPLACE(tr.licence, ' ', '') as licence,
      tr.player_name,
      SUM(tr.match_points) as total_match_points,
      SUM(tr.points) as total_points,
      SUM(tr.reprises) as total_reprises,
      CASE
        WHEN SUM(tr.reprises) > 0 THEN CAST(SUM(tr.points) AS FLOAT) / CAST(SUM(tr.reprises) AS FLOAT)
        ELSE 0
      END as avg_moyenne,
      MAX(tr.serie) as best_serie,
      MAX(CASE WHEN t.tournament_number = 1 THEN tr.match_points ELSE 0 END) as t1_points,
      MAX(CASE WHEN t.tournament_number = 2 THEN tr.match_points ELSE 0 END) as t2_points,
      MAX(CASE WHEN t.tournament_number = 3 THEN tr.match_points ELSE 0 END) as t3_points
    FROM tournament_results tr
    JOIN tournaments t ON tr.tournament_id = t.id
    WHERE t.category_id = ? AND t.season = ? AND t.tournament_number <= 3
    GROUP BY REPLACE(tr.licence, ' ', ''), tr.player_name
    ORDER BY total_match_points DESC, avg_moyenne DESC, best_serie DESC
  `;

  db.all(query, [categoryId, season], (err, results) => {
    if (err) {
      console.error('Error calculating rankings:', err);
      return callback(err);
    }

    // Delete existing rankings
    db.run('DELETE FROM rankings WHERE category_id = ? AND season = ?', [categoryId, season], (err) => {
      if (err) {
        console.error('Error deleting old rankings:', err);
        return callback(err);
      }

      // Insert new rankings with positions
      const stmt = db.prepare(`
        INSERT INTO rankings (
          category_id, season, licence, total_match_points, avg_moyenne, best_serie,
          rank_position, tournament_1_points, tournament_2_points, tournament_3_points
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let insertCount = 0;
      let insertError = null;

      if (results.length === 0) {
        stmt.finalize(() => callback(null));
        return;
      }

      results.forEach((result, index) => {
        stmt.run(
          categoryId,
          season,
          result.licence,
          result.total_match_points,
          result.avg_moyenne,
          result.best_serie,
          index + 1,
          result.t1_points,
          result.t2_points,
          result.t3_points,
          (err) => {
            if (err && !insertError) {
              insertError = err;
              console.error('Error inserting ranking:', err);
            }
            insertCount++;

            // After all inserts are done, finalize
            if (insertCount === results.length) {
              stmt.finalize((finalizeErr) => {
                callback(insertError || finalizeErr);
              });
            }
          }
        );
      });
    });
  });
}

// Get all tournaments
router.get('/', authenticateToken, (req, res) => {
  console.log('GET /api/tournaments called, season:', req.query.season);
  const { season } = req.query;

  let query = `
    SELECT
      t.id,
      t.tournament_number,
      t.season,
      t.tournament_date,
      t.import_date,
      t.location,
      c.id as category_id,
      c.game_type,
      c.level,
      c.display_name,
      COUNT(tr.id) as player_count
    FROM tournaments t
    JOIN categories c ON t.category_id = c.id
    LEFT JOIN tournament_results tr ON tr.tournament_id = t.id
  `;

  const params = [];
  if (season) {
    query += ' WHERE t.season = ?';
    params.push(season);
  }

  query += ' GROUP BY t.id, t.tournament_number, t.season, t.tournament_date, t.import_date, t.location, c.id, c.game_type, c.level, c.display_name ORDER BY t.import_date DESC';

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error('Error fetching tournaments:', err);
      return res.status(500).json({ error: err.message });
    }
    console.log('Tournaments fetched successfully:', rows.length, 'tournaments');
    res.json(rows);
  });
});

// Get tournament results by ID
router.get('/:id/results', authenticateToken, (req, res) => {
  const tournamentId = req.params.id;
  console.log('Getting tournament results for ID:', tournamentId);

  // Get tournament info
  db.get(
    `SELECT t.*, c.display_name, c.game_type, c.level
     FROM tournaments t
     JOIN categories c ON t.category_id = c.id
     WHERE t.id = ?`,
    [tournamentId],
    (err, tournament) => {
      if (err) {
        console.error('Error fetching tournament:', err);
        return res.status(500).json({ error: err.message });
      }

      if (!tournament) {
        console.log('Tournament not found for ID:', tournamentId);
        return res.status(404).json({ error: 'Tournament not found' });
      }

      console.log('Tournament found:', tournament);

      // Get tournament results with club name
      db.all(
        `SELECT tr.*, p.club as club_name, c.logo_filename as club_logo
         FROM tournament_results tr
         LEFT JOIN players p ON tr.licence = p.licence
         LEFT JOIN clubs c ON REPLACE(REPLACE(REPLACE(UPPER(p.club), ' ', ''), '.', ''), '-', '') = REPLACE(REPLACE(REPLACE(UPPER(c.name), ' ', ''), '.', ''), '-', '')
         WHERE tr.tournament_id = ?
         ORDER BY tr.match_points DESC, tr.moyenne DESC`,
        [tournamentId],
        (err, results) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }

          res.json({
            tournament,
            results
          });
        }
      );
    }
  );
});

// Export tournament results to Excel
router.get('/:id/export', authenticateToken, async (req, res) => {
  const tournamentId = req.params.id;
  const ExcelJS = require('exceljs');

  // Get tournament info
  db.get(
    `SELECT t.*, c.display_name, c.game_type, c.level
     FROM tournaments t
     JOIN categories c ON t.category_id = c.id
     WHERE t.id = ?`,
    [tournamentId],
    async (err, tournament) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      if (!tournament) {
        return res.status(404).json({ error: 'Tournament not found' });
      }

      // Get tournament results with club name and logo
      db.all(
        `SELECT tr.*, p.club as club_name, c.logo_filename as club_logo
         FROM tournament_results tr
         LEFT JOIN players p ON tr.licence = p.licence
         LEFT JOIN clubs c ON REPLACE(REPLACE(REPLACE(UPPER(p.club), ' ', ''), '.', ''), '-', '') = REPLACE(REPLACE(REPLACE(UPPER(c.name), ' ', ''), '.', ''), '-', '')
         WHERE tr.tournament_id = ?
         ORDER BY tr.match_points DESC, tr.moyenne DESC`,
        [tournamentId],
        async (err, results) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }

          try {
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Résultats');

            // Add billiard ball image
            const imagePath = path.join(__dirname, '../frontend/images/billiard-icon.png');

            try {
              const imageId = workbook.addImage({
                filename: imagePath,
                extension: 'png',
              });

              worksheet.addImage(imageId, {
                tl: { col: 0, row: 0 },
                ext: { width: 80, height: 45 }
              });
            } catch (err) {
              console.log('Image not found, using text icon instead');
            }

            // Title - Row 1
            worksheet.mergeCells('B1:J1');
            worksheet.getCell('B1').value = `RÉSULTATS ${tournament.display_name.toUpperCase()}`;
            worksheet.getCell('B1').font = { size: 18, bold: true, color: { argb: 'FF1F4788' } };
            worksheet.getCell('B1').alignment = { horizontal: 'center', vertical: 'middle' };
            worksheet.getCell('B1').fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFE7F3FF' }
            };
            worksheet.getCell('A1').fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFE7F3FF' }
            };
            worksheet.getRow(1).height = 35;

            // Subtitle - Row 2
            worksheet.mergeCells('A2:J2');
            const tournamentDate = tournament.tournament_date
              ? new Date(tournament.tournament_date).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })
              : '';
            const tournamentLabel = tournament.tournament_number === 4 ? 'Finale Départementale' : `Tournoi ${tournament.tournament_number}`;
            worksheet.getCell('A2').value = `${tournamentLabel} • Saison ${tournament.season}${tournamentDate ? ' • ' + tournamentDate : ''}`;
            worksheet.getCell('A2').font = { size: 11, italic: true, color: { argb: 'FF666666' } };
            worksheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
            worksheet.getRow(2).height = 20;

            // Add podium section for finale
            if (tournament.tournament_number === 4 && results.length >= 3) {
              // Podium section in Row 3
              worksheet.mergeCells('A3:J3');
              worksheet.getCell('A3').value = '🏆 PODIUM DE LA FINALE 🏆';
              worksheet.getCell('A3').font = { size: 14, bold: true, color: { argb: 'FFFFD700' } };
              worksheet.getCell('A3').alignment = { horizontal: 'center', vertical: 'middle' };
              worksheet.getCell('A3').fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF1F4788' }
              };
              worksheet.getRow(3).height = 25;

              // Podium positions - Rows 4-6
              const medals = ['🥇', '🥈', '🥉'];
              const podiumColors = ['FFFFD700', 'FFC0C0C0', 'FFCD7F32'];
              const positions = ['1er', '2ème', '3ème'];

              for (let i = 0; i < 3; i++) {
                const row = 4 + i;
                const result = results[i];
                const moyenne = result.reprises > 0 ? (result.points / result.reprises).toFixed(3) : '0.000';
                const clubName = result.club_name || 'N/A';

                worksheet.mergeCells(`A${row}:J${row}`);
                worksheet.getCell(`A${row}`).value = `${medals[i]} ${positions[i]} - ${result.player_name} • ${result.match_points} pts • Moy: ${moyenne} • Meilleure Série: ${result.serie} • ${clubName}`;
                worksheet.getCell(`A${row}`).font = { size: 12, bold: true };
                worksheet.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
                worksheet.getCell(`A${row}`).fill = {
                  type: 'pattern',
                  pattern: 'solid',
                  fgColor: { argb: podiumColors[i] }
                };
                worksheet.getRow(row).height = 30;
              }

              // Add separator
              worksheet.getRow(7).height = 5;
            }

            // Headers - Row 4 for regular, Row 8 for finale
            const headerRow = tournament.tournament_number === 4 ? 8 : 4;
            worksheet.getRow(headerRow).values = [
              'Position',
              'Licence',
              'Joueur',
              'Club',
              '', // Empty header for logo column
              'Pts Match',
              'Points',
              'Reprises',
              'Moyenne',
              'Meilleure Série'
            ];

            // Style headers
            worksheet.getRow(headerRow).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            worksheet.getRow(headerRow).fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FF1F4788' }
            };
            worksheet.getRow(headerRow).alignment = { horizontal: 'center', vertical: 'middle' };
            worksheet.getRow(headerRow).height = 28;
            worksheet.getRow(headerRow).border = {
              bottom: { style: 'medium', color: { argb: 'FF1F4788' } }
            };

            // Data
            results.forEach((result, index) => {
              const moyenne = result.reprises > 0
                ? (result.points / result.reprises).toFixed(3)
                : '0.000';

              const excelRow = worksheet.addRow([
                index + 1,
                result.licence,
                result.player_name,
                result.club_name || 'N/A',
                '', // Empty cell for logo
                result.match_points,
                result.points,
                result.reprises,
                moyenne,
                result.serie
              ]);

              // Podium colors for top 3
              if (index === 0) {
                // Gold
                excelRow.fill = {
                  type: 'pattern',
                  pattern: 'solid',
                  fgColor: { argb: 'FFFFD700' }
                };
                excelRow.font = { bold: true, size: 11 };
                excelRow.getCell(1).value = '🥇 1';
              } else if (index === 1) {
                // Silver
                excelRow.fill = {
                  type: 'pattern',
                  pattern: 'solid',
                  fgColor: { argb: 'FFC0C0C0' }
                };
                excelRow.font = { bold: true, size: 11 };
                excelRow.getCell(1).value = '🥈 2';
              } else if (index === 2) {
                // Bronze
                excelRow.fill = {
                  type: 'pattern',
                  pattern: 'solid',
                  fgColor: { argb: 'FFCD7F32' }
                };
                excelRow.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
                excelRow.getCell(1).value = '🥉 3';
              } else {
                // Alternate row colors
                if (index % 2 === 0) {
                  excelRow.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFF8F9FA' }
                  };
                } else {
                  excelRow.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFFFFFFF' }
                  };
                }
              }

              // Center alignment for numeric columns and logo column
              [1, 5, 6, 7, 8, 9, 10].forEach(col => {
                excelRow.getCell(col).alignment = { horizontal: 'center', vertical: 'middle' };
              });

              // Left alignment for licence, player name, and club
              [2, 3, 4].forEach(col => {
                excelRow.getCell(col).alignment = { horizontal: 'left', vertical: 'middle' };
              });

              excelRow.height = 22;

              // Add club logo in dedicated logo column if available
              if (result.club_logo) {
                const clubLogoPath = path.join(__dirname, '../../frontend/images/clubs', result.club_logo);
                if (fs.existsSync(clubLogoPath)) {
                  try {
                    const logoImageId = workbook.addImage({
                      filename: clubLogoPath,
                      extension: result.club_logo.split('.').pop(),
                    });

                    // Position logo in dedicated Logo column (column E)
                    const rowNumber = excelRow.number;
                    worksheet.addImage(logoImageId, {
                      tl: { col: 4.1, row: rowNumber - 1 + 0.15 },
                      ext: { width: 18, height: 18 }
                    });
                  } catch (err) {
                    console.log(`Could not add club logo for ${result.player_name}:`, err.message);
                  }
                }
              }
            });

            // Column widths
            worksheet.columns = [
              { width: 12 },  // Position
              { width: 15 },  // Licence
              { width: 30 },  // Joueur
              { width: 35 },  // Club
              { width: 4 },   // Logo
              { width: 12 },  // Pts Match
              { width: 12 },  // Points
              { width: 12 },  // Reprises
              { width: 12 },  // Moyenne
              { width: 16 }   // Meilleure Série
            ];

            // Borders for all data cells
            worksheet.eachRow((row, rowNumber) => {
              if (rowNumber >= 4) {
                row.eachCell((cell) => {
                  cell.border = {
                    top: { style: 'thin', color: { argb: 'FFD3D3D3' } },
                    left: { style: 'thin', color: { argb: 'FFD3D3D3' } },
                    bottom: { style: 'thin', color: { argb: 'FFD3D3D3' } },
                    right: { style: 'thin', color: { argb: 'FFD3D3D3' } }
                  };
                });
              }
            });

            // Send file
            res.setHeader(
              'Content-Type',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );

            // Format date as dd_mm_yyyy
            const dateStr = tournament.tournament_date
              ? new Date(tournament.tournament_date).toLocaleDateString('fr-FR').replace(/\//g, '_')
              : '';

            // Determine tournament label (T1, T2, T3, or Finale)
            const filenameTournamentLabel = tournament.tournament_number === 4 ? 'Finale' : `T${tournament.tournament_number}`;

            // Create filename: "T1, Bande R2, 15_10_2025.xlsx"
            const filename = `${filenameTournamentLabel}, ${tournament.display_name}, ${dateStr}.xlsx`;

            res.setHeader(
              'Content-Disposition',
              `attachment; filename="${filename}"`
            );

            await workbook.xlsx.write(res);
            res.end();

          } catch (error) {
            console.error('Excel export error:', error);
            res.status(500).json({ error: error.message });
          }
        }
      );
    }
  );
});

// Delete tournament
router.delete('/:id', authenticateToken, (req, res) => {
  const tournamentId = req.params.id;

  // First get tournament info for recalculating rankings
  db.get('SELECT category_id, season FROM tournaments WHERE id = ?', [tournamentId], (err, tournament) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    // Delete tournament results first (foreign key constraint)
    db.run('DELETE FROM tournament_results WHERE tournament_id = ?', [tournamentId], (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      // Delete tournament
      db.run('DELETE FROM tournaments WHERE id = ?', [tournamentId], (err) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        // Recalculate rankings for this category and season
        recalculateRankings(tournament.category_id, tournament.season, (err) => {
          if (err) {
            return res.status(500).json({ error: 'Tournament deleted but rankings recalculation failed' });
          }

          res.json({ message: 'Tournament deleted successfully' });
        });
      });
    });
  });
});

// Recalculate all rankings for a specific category and season (admin utility)
router.post('/recalculate-rankings', authenticateToken, (req, res) => {
  const { categoryId, season } = req.body;

  if (!categoryId || !season) {
    return res.status(400).json({ error: 'Category ID and season required' });
  }

  recalculateRankings(categoryId, season, (err) => {
    if (err) {
      return res.status(500).json({ error: 'Rankings recalculation failed: ' + err.message });
    }
    res.json({ message: 'Rankings recalculated successfully' });
  });
});

// Recalculate ALL rankings for all categories and seasons (admin utility)
router.post('/recalculate-all-rankings', authenticateToken, async (req, res) => {
  try {
    // Get all unique category/season combinations
    const query = `
      SELECT DISTINCT t.category_id, t.season
      FROM tournaments t
      ORDER BY t.season DESC, t.category_id
    `;

    db.all(query, [], async (err, combinations) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      let recalculated = 0;
      let errors = [];

      for (const combo of combinations) {
        await new Promise((resolve) => {
          recalculateRankings(combo.category_id, combo.season, (err) => {
            if (err) {
              errors.push({ categoryId: combo.category_id, season: combo.season, error: err.message });
            } else {
              recalculated++;
            }
            resolve();
          });
        });
      }

      res.json({
        message: `Recalculated rankings for ${recalculated} category/season combinations`,
        recalculated,
        errors: errors.length > 0 ? errors : undefined
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update tournament (location, date, etc.)
router.put('/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { location, tournament_date } = req.body;

  // Build update query dynamically
  const updates = [];
  const params = [];

  if (location !== undefined) {
    updates.push('location = ?');
    params.push(location);
  }
  if (tournament_date !== undefined) {
    updates.push('tournament_date = ?');
    params.push(tournament_date);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  params.push(id);

  db.run(
    `UPDATE tournaments SET ${updates.join(', ')} WHERE id = ?`,
    params,
    function(err) {
      if (err) {
        console.error('Error updating tournament:', err);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Tournament not found' });
      }
      res.json({ success: true, message: 'Tournament updated successfully' });
    }
  );
});

module.exports = router;
