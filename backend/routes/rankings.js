const express = require('express');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const db = require('../db-loader');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Get rankings by category and season
router.get('/', authenticateToken, (req, res) => {
  const { categoryId, season } = req.query;

  if (!categoryId || !season) {
    return res.status(400).json({ error: 'Category ID and season required' });
  }

  const query = `
    SELECT
      r.rank_position,
      r.licence,
      p.first_name,
      p.last_name,
      p.club,
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
    JOIN players p ON REPLACE(r.licence, ' ', '') = REPLACE(p.licence, ' ', '')
    JOIN categories c ON r.category_id = c.id
    LEFT JOIN clubs ON REPLACE(REPLACE(REPLACE(UPPER(p.club), ' ', ''), '.', ''), '-', '') = REPLACE(REPLACE(REPLACE(UPPER(clubs.name), ' ', ''), '.', ''), '-', '')
    WHERE r.category_id = ? AND r.season = ?
    ORDER BY r.rank_position
  `;

  db.all(query, [categoryId, season], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
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

  const query = `
    SELECT
      r.rank_position,
      r.licence,
      p.first_name,
      p.last_name,
      p.club,
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
    JOIN players p ON REPLACE(r.licence, ' ', '') = REPLACE(p.licence, ' ', '')
    JOIN categories c ON r.category_id = c.id
    LEFT JOIN clubs ON REPLACE(REPLACE(REPLACE(UPPER(p.club), ' ', ''), '.', ''), '-', '') = REPLACE(REPLACE(REPLACE(UPPER(clubs.name), ' ', ''), '.', ''), '-', '')
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

      // Style headers with gradient-like effect
      worksheet.getRow(4).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      worksheet.getRow(4).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1F4788' }
      };
      worksheet.getRow(4).alignment = { horizontal: 'center', vertical: 'middle' };
      worksheet.getRow(4).height = 28;
      worksheet.getRow(4).border = {
        bottom: { style: 'medium', color: { argb: 'FF1F4788' } }
      };

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
          row.tournament_1_points,
          row.tournament_2_points,
          row.tournament_3_points,
          row.total_match_points,
          row.cumulated_points,
          row.cumulated_reprises,
          moyenne,
          row.best_serie || 0
        ]);

        // Podium colors for top 3
        if (row.rank_position === 1) {
          // Gold
          excelRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFD700' }
          };
          excelRow.font = { bold: true, size: 11 };
          excelRow.getCell(1).value = '🥇 1';
        } else if (row.rank_position === 2) {
          // Silver
          excelRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFC0C0C0' }
          };
          excelRow.font = { bold: true, size: 11 };
          excelRow.getCell(1).value = '🥈 2';
        } else if (row.rank_position === 3) {
          // Bronze
          excelRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFCD7F32' }
          };
          excelRow.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
          excelRow.getCell(1).value = '🥉 3';
        } else {
          // Alternate row colors for others
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
