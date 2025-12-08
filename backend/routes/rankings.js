const express = require('express');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const db = require('../db-loader');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Debug: check players table
router.get('/debug-player/:licence', authenticateToken, (req, res) => {
  const { licence } = req.params;
  db.all(`SELECT licence, first_name, last_name, LENGTH(licence) as len FROM players WHERE licence LIKE ?`, [`%${licence}%`], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Debug: check rankings table directly
router.get('/debug-rankings-table/:categoryId/:season', authenticateToken, (req, res) => {
  const { categoryId, season } = req.params;
  db.all(`SELECT licence, total_match_points, rank_position FROM rankings WHERE category_id = ? AND season = ? ORDER BY rank_position`, [categoryId, season], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ count: rows.length, rows });
  });
});

// Get rankings by category and season
router.get('/', authenticateToken, (req, res) => {
  const { categoryId, season } = req.query;

  if (!categoryId || !season) {
    return res.status(400).json({ error: 'Category ID and season required' });
  }

  // First, check which tournaments have been played for this category/season
  const tournamentsPlayedQuery = `
    SELECT tournament_number FROM tournaments
    WHERE category_id = ? AND season = ? AND tournament_number <= 3
  `;

  db.all(tournamentsPlayedQuery, [categoryId, season], (err, tournamentRows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    const tournamentsPlayed = {
      t1: tournamentRows.some(t => t.tournament_number === 1),
      t2: tournamentRows.some(t => t.tournament_number === 2),
      t3: tournamentRows.some(t => t.tournament_number === 3)
    };

    // Use LEFT JOIN for players to include ranked players even if not in players table
    // Get player name from tournament_results as fallback
    // Use club_aliases to resolve variant club names to canonical names
    const query = `
      SELECT
        r.rank_position,
        r.licence,
        COALESCE(p.first_name, (SELECT MAX(tr.player_name) FROM tournament_results tr WHERE REPLACE(tr.licence, ' ', '') = r.licence)) as first_name,
        COALESCE(p.last_name, '') as last_name,
        COALESCE(ca.canonical_name, p.club, 'Non renseigné') as club,
        r.total_match_points,
        r.avg_moyenne,
        r.best_serie,
        r.tournament_1_points,
        r.tournament_2_points,
        r.tournament_3_points,
        c.game_type,
        c.level,
        c.display_name,
        clubs.logo_filename as club_logo,
        COALESCE((SELECT SUM(tr.points) FROM tournament_results tr
                  JOIN tournaments t ON tr.tournament_id = t.id
                  WHERE REPLACE(tr.licence, ' ', '') = REPLACE(r.licence, ' ', '')
                  AND t.category_id = r.category_id
                  AND t.season = r.season
                  AND t.tournament_number <= 3), 0) as cumulated_points,
        COALESCE((SELECT SUM(tr.reprises) FROM tournament_results tr
                  JOIN tournaments t ON tr.tournament_id = t.id
                  WHERE REPLACE(tr.licence, ' ', '') = REPLACE(r.licence, ' ', '')
                  AND t.category_id = r.category_id
                  AND t.season = r.season
                  AND t.tournament_number <= 3), 0) as cumulated_reprises,
        CASE WHEN p.licence IS NULL THEN 1 ELSE 0 END as missing_from_players
      FROM rankings r
      LEFT JOIN players p ON REPLACE(r.licence, ' ', '') = REPLACE(p.licence, ' ', '')
      JOIN categories c ON r.category_id = c.id
      LEFT JOIN club_aliases ca ON UPPER(REPLACE(REPLACE(REPLACE(COALESCE(p.club, ''), ' ', ''), '.', ''), '-', ''))
                                 = UPPER(REPLACE(REPLACE(REPLACE(ca.alias, ' ', ''), '.', ''), '-', ''))
      LEFT JOIN clubs ON UPPER(REPLACE(REPLACE(REPLACE(COALESCE(ca.canonical_name, p.club, ''), ' ', ''), '.', ''), '-', ''))
                       = UPPER(REPLACE(REPLACE(REPLACE(clubs.name, ' ', ''), '.', ''), '-', ''))
      WHERE r.category_id = ? AND r.season = ?
      ORDER BY r.rank_position
    `;

    db.all(query, [categoryId, season], (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      // Return rankings with tournaments played info
      res.json({
        rankings: rows,
        tournamentsPlayed
      });
    });
  });
});

// Get all seasons
router.get('/seasons', authenticateToken, (req, res) => {
  db.all('SELECT DISTINCT season FROM tournaments ORDER BY season DESC', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows.map(r => r.season));
  });
});

// Export rankings to Excel
router.get('/export', authenticateToken, async (req, res) => {
  const { categoryId, season } = req.query;

  if (!categoryId || !season) {
    return res.status(400).json({ error: 'Category ID and season required' });
  }

  // First, check which tournaments have been played
  const tournamentsPlayedQuery = `
    SELECT tournament_number FROM tournaments
    WHERE category_id = ? AND season = ? AND tournament_number <= 3
  `;

  const tournamentRows = await new Promise((resolve, reject) => {
    db.all(tournamentsPlayedQuery, [categoryId, season], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });

  const tournamentsPlayed = {
    t1: tournamentRows.some(t => t.tournament_number === 1),
    t2: tournamentRows.some(t => t.tournament_number === 2),
    t3: tournamentRows.some(t => t.tournament_number === 3)
  };

  // Use LEFT JOIN for players to include ranked players even if not in players table
  // Use club_aliases to resolve variant club names to canonical names
  const query = `
    SELECT
      r.rank_position,
      r.licence,
      COALESCE(p.first_name, (SELECT MAX(tr.player_name) FROM tournament_results tr WHERE REPLACE(tr.licence, ' ', '') = r.licence)) as first_name,
      COALESCE(p.last_name, '') as last_name,
      COALESCE(ca.canonical_name, p.club, 'Non renseigné') as club,
      r.total_match_points,
      r.avg_moyenne,
      r.best_serie,
      r.tournament_1_points,
      r.tournament_2_points,
      r.tournament_3_points,
      c.game_type,
      c.level,
      c.display_name,
      clubs.logo_filename as club_logo,
      COALESCE((SELECT SUM(tr.points) FROM tournament_results tr
                JOIN tournaments t ON tr.tournament_id = t.id
                WHERE REPLACE(tr.licence, ' ', '') = REPLACE(r.licence, ' ', '')
                AND t.category_id = r.category_id
                AND t.season = r.season
                AND t.tournament_number <= 3), 0) as cumulated_points,
      COALESCE((SELECT SUM(tr.reprises) FROM tournament_results tr
                JOIN tournaments t ON tr.tournament_id = t.id
                WHERE REPLACE(tr.licence, ' ', '') = REPLACE(r.licence, ' ', '')
                AND t.category_id = r.category_id
                AND t.season = r.season
                AND t.tournament_number <= 3), 0) as cumulated_reprises
    FROM rankings r
    LEFT JOIN players p ON REPLACE(r.licence, ' ', '') = REPLACE(p.licence, ' ', '')
    JOIN categories c ON r.category_id = c.id
    LEFT JOIN club_aliases ca ON UPPER(REPLACE(REPLACE(REPLACE(COALESCE(p.club, ''), ' ', ''), '.', ''), '-', ''))
                               = UPPER(REPLACE(REPLACE(REPLACE(ca.alias, ' ', ''), '.', ''), '-', ''))
    LEFT JOIN clubs ON UPPER(REPLACE(REPLACE(REPLACE(COALESCE(ca.canonical_name, p.club, ''), ' ', ''), '.', ''), '-', ''))
                     = UPPER(REPLACE(REPLACE(REPLACE(clubs.name, ' ', ''), '.', ''), '-', ''))
    WHERE r.category_id = ? AND r.season = ?
    ORDER BY r.rank_position
  `;

  db.all(query, [categoryId, season], async (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No rankings found' });
    }

    try {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Classement');

      const categoryName = rows[0].display_name;

      // Add billiard ball image
      const imagePath = path.join(__dirname, '../../frontend/images/billiard-icon.png');

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
      worksheet.mergeCells('B1:M1');
      worksheet.getCell('B1').value = `CLASSEMENT ${categoryName.toUpperCase()}`;
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
      worksheet.mergeCells('A2:M2');
      const exportDate = new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });
      worksheet.getCell('A2').value = `Saison ${season} • Exporté le ${exportDate}`;
      worksheet.getCell('A2').font = { size: 11, italic: true, color: { argb: 'FF666666' } };
      worksheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
      worksheet.getRow(2).height = 20;

      // Headers - Row 4
      worksheet.getRow(4).values = [
        'Position',
        'Licence',
        'Prénom',
        'Nom',
        'Club',
        '', // Empty header for logo column
        'T1',
        'T2',
        'T3',
        'Total Pts Match',
        'Total Points',
        'Total Reprises',
        'Moyenne',
        'Meilleure Série'
      ];

      // Style headers (only columns 1-14)
      worksheet.getRow(4).height = 28;
      for (let col = 1; col <= 14; col++) {
        const cell = worksheet.getRow(4).getCell(col);
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF1F4788' }
        };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          bottom: { style: 'medium', color: { argb: 'FF1F4788' } }
        };
      }

      // Helper to format tournament points:
      // - Tournament not played → "-"
      // - Tournament played but player absent (null) → "*"
      // - Tournament played and player participated → show points
      const formatTournamentPoints = (points, tournamentPlayed) => {
        if (!tournamentPlayed) return '-';
        if (points === null) return '*';
        return points;
      };

      // Check if legend is needed (any absent players from PLAYED tournaments)
      const hasAbsentPlayers = rows.some(r =>
        (tournamentsPlayed.t1 && r.tournament_1_points === null) ||
        (tournamentsPlayed.t2 && r.tournament_2_points === null) ||
        (tournamentsPlayed.t3 && r.tournament_3_points === null)
      );

      // Add legend if needed
      if (hasAbsentPlayers) {
        worksheet.mergeCells('A3:M3');
        worksheet.getCell('A3').value = '(*) Non-participation au tournoi concerné';
        worksheet.getCell('A3').font = { size: 10, italic: true, color: { argb: 'FF666666' } };
        worksheet.getCell('A3').alignment = { horizontal: 'left', vertical: 'middle' };
      }

      // Calculate number of qualified players for the final
      // Rule: < 9 players → 4 qualified, >= 9 players → 6 qualified
      const totalPlayers = rows.length;
      const qualifiedCount = totalPlayers < 9 ? 4 : 6;

      // Data
      rows.forEach((row, index) => {
        const moyenne = row.cumulated_reprises > 0
          ? (row.cumulated_points / row.cumulated_reprises).toFixed(3)
          : '0.000';

        const excelRow = worksheet.addRow([
          row.rank_position,
          row.licence,
          row.first_name,
          row.last_name,
          row.club,
          '', // Empty cell for logo
          formatTournamentPoints(row.tournament_1_points, tournamentsPlayed.t1),
          formatTournamentPoints(row.tournament_2_points, tournamentsPlayed.t2),
          formatTournamentPoints(row.tournament_3_points, tournamentsPlayed.t3),
          row.total_match_points,
          row.cumulated_points,
          row.cumulated_reprises,
          moyenne,
          row.best_serie || 0
        ]);

        // Green highlighting for qualified players (only columns 1-14)
        if (row.rank_position <= qualifiedCount) {
          // Light green background for qualified players - apply to each cell individually
          for (let col = 1; col <= 14; col++) {
            excelRow.getCell(col).fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFE8F5E9' }  // Light green
            };
            excelRow.getCell(col).font = { bold: true, size: 11 };
          }
          // Green position number
          excelRow.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF2E7D32' } };
          excelRow.getCell(1).value = `✓ ${row.rank_position}`;
        } else {
          // Alternate row colors for non-qualified (only columns 1-14)
          const bgColor = index % 2 === 0 ? 'FFF8F9FA' : 'FFFFFFFF';
          for (let col = 1; col <= 14; col++) {
            excelRow.getCell(col).fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: bgColor }
            };
          }
        }

        // Center alignment for numeric columns and logo column
        [1, 6, 7, 8, 9, 10, 11, 12, 13, 14].forEach(col => {
          excelRow.getCell(col).alignment = { horizontal: 'center', vertical: 'middle' };
        });

        // Left alignment for licence, names, and club
        [2, 3, 4, 5].forEach(col => {
          excelRow.getCell(col).alignment = { horizontal: 'left', vertical: 'middle' };
        });

        // Add row height
        excelRow.height = 22;

        // Add club logo in dedicated logo column if available
        if (row.club_logo) {
          const clubLogoPath = path.join(__dirname, '../../frontend/images/clubs', row.club_logo);
          if (fs.existsSync(clubLogoPath)) {
            try {
              const logoImageId = workbook.addImage({
                filename: clubLogoPath,
                extension: row.club_logo.split('.').pop(),
              });

              // Position logo in dedicated Logo column (column F)
              const rowNumber = excelRow.number;
              worksheet.addImage(logoImageId, {
                tl: { col: 5.1, row: rowNumber - 1 + 0.15 },
                ext: { width: 18, height: 18 }
              });
            } catch (err) {
              console.log(`Could not add club logo for ${row.first_name} ${row.last_name}:`, err.message);
            }
          }
        }
      });

      // Column widths
      worksheet.columns = [
        { width: 12 },  // Position
        { width: 15 },  // Licence
        { width: 18 },  // Prénom
        { width: 18 },  // Nom
        { width: 32 },  // Club
        { width: 4 },   // Logo
        { width: 8 },   // T1
        { width: 8 },   // T2
        { width: 8 },   // T3
        { width: 14 },  // Total Pts Match
        { width: 12 },  // Total Points
        { width: 14 },  // Total Reprises
        { width: 12 },  // Moyenne
        { width: 14 }   // Meilleure Série
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

      // Create filename: "Classement Bande R2, 2025-2026.xlsx"
      const filename = `Classement ${categoryName}, ${season}.xlsx`;

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
  });
});

module.exports = router;
