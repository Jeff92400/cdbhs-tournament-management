const express = require('express');
const { Resend } = require('resend');
const ExcelJS = require('exceljs');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Helper function to add delay between emails (avoid rate limiting)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Initialize Resend
const getResend = () => {
  if (!process.env.RESEND_API_KEY) {
    return null;
  }
  return new Resend(process.env.RESEND_API_KEY);
};

// Generate Excel attachment for a specific player - includes ALL poules
async function generatePlayerConvocation(player, tournamentInfo, allPoules, locations) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Convocation');

  // Page setup
  sheet.pageSetup = {
    paperSize: 9,
    orientation: 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 1
  };

  // Colors
  const colors = {
    primary: 'FF1F4788',
    secondary: 'FF667EEA',
    accent: 'FFFFC107',
    red: 'FFDC3545',
    white: 'FFFFFFFF',
    light: 'FFF8F9FA',
    highlight: 'FFE3F2FD'
  };

  // Column widths
  sheet.columns = [
    { width: 10 },
    { width: 16 },
    { width: 28 },
    { width: 24 },
    { width: 45 }
  ];

  const blackBorder = {
    top: { style: 'thin', color: { argb: 'FF000000' } },
    left: { style: 'thin', color: { argb: 'FF000000' } },
    bottom: { style: 'thin', color: { argb: 'FF000000' } },
    right: { style: 'thin', color: { argb: 'FF000000' } }
  };

  // Find player's poule
  let playerPouleNumber = null;
  for (const poule of allPoules) {
    if (poule.players.find(p => p.licence === player.licence)) {
      playerPouleNumber = poule.number;
      break;
    }
  }

  let row = 1;

  // Header - CONVOCATION with tournament number
  const tournamentLabel = tournamentInfo.tournamentNum === '4' ? 'FINALE DÉPARTEMENTALE' : `TOURNOI N°${tournamentInfo.tournamentNum}`;
  sheet.mergeCells(`A${row}:E${row}`);
  sheet.getCell(`A${row}`).value = `CONVOCATION ${tournamentLabel}`;
  sheet.getCell(`A${row}`).font = { size: 24, bold: true, color: { argb: colors.white } };
  sheet.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.primary } };
  sheet.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getCell(`A${row}`).border = blackBorder;
  sheet.getRow(row).height = 50;
  row++;

  // Season
  sheet.mergeCells(`A${row}:E${row}`);
  sheet.getCell(`A${row}`).value = `SAISON ${tournamentInfo.season}`;
  sheet.getCell(`A${row}`).font = { size: 16, bold: true, color: { argb: colors.white } };
  sheet.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.secondary } };
  sheet.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getCell(`A${row}`).border = blackBorder;
  sheet.getRow(row).height = 35;
  row++;

  // Empty row
  sheet.getRow(row).height = 10;
  row++;

  // Date - prominent in red
  sheet.mergeCells(`A${row}:E${row}`);
  const dateStr = tournamentInfo.date
    ? new Date(tournamentInfo.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()
    : 'DATE À DÉFINIR';
  sheet.getCell(`A${row}`).value = dateStr;
  sheet.getCell(`A${row}`).font = { size: 18, bold: true, color: { argb: colors.red } };
  sheet.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getCell(`A${row}`).border = blackBorder;
  sheet.getRow(row).height = 40;
  row++;

  // Empty row
  sheet.getRow(row).height = 10;
  row++;

  // Category
  sheet.mergeCells(`A${row}:E${row}`);
  sheet.getCell(`A${row}`).value = tournamentInfo.categoryName;
  sheet.getCell(`A${row}`).font = { size: 16, bold: true, color: { argb: colors.white } };
  sheet.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.secondary } };
  sheet.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getCell(`A${row}`).border = blackBorder;
  sheet.getRow(row).height = 35;
  row++;

  // Empty row
  sheet.getRow(row).height = 10;
  row++;

  // Player info box - highlight their assignment
  sheet.mergeCells(`A${row}:E${row}`);
  sheet.getCell(`A${row}`).value = `${player.first_name} ${player.last_name} - Vous êtes en POULE ${playerPouleNumber}`.toUpperCase();
  sheet.getCell(`A${row}`).font = { size: 14, bold: true, color: { argb: colors.primary } };
  sheet.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.highlight } };
  sheet.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getCell(`A${row}`).border = blackBorder;
  sheet.getRow(row).height = 35;
  row++;

  // Space before poules
  row++;

  // Helper to get location for a poule
  const getLocationForPoule = (poule) => {
    const locNum = poule.locationNum || '1';
    return locations.find(l => l.locationNum === locNum) || locations[0] || { name: 'À définir', startTime: '14:00' };
  };

  // ALL POULES
  for (const poule of allPoules) {
    const isPlayerPoule = poule.number === playerPouleNumber;
    const loc = getLocationForPoule(poule);
    const locName = loc?.name || 'À définir';
    const locStreet = loc?.street || '';
    const locZipCode = loc?.zip_code || '';
    const locCity = loc?.city || '';
    const fullAddress = [locStreet, locZipCode, locCity].filter(Boolean).join(' ');
    const locPhone = loc?.phone || '';
    const locEmail = loc?.email || '';
    const locTime = loc?.startTime || '14:00';

    // Location header bar
    sheet.mergeCells(`A${row}:E${row}`);
    sheet.getCell(`A${row}`).value = `📍 ${locName.toUpperCase()}`;
    sheet.getCell(`A${row}`).font = { size: 12, bold: true, color: { argb: 'FF333333' } };
    sheet.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.accent } };
    sheet.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getCell(`A${row}`).border = blackBorder;
    sheet.getRow(row).height = 28;
    row++;

    // Address + time on one line
    sheet.mergeCells(`A${row}:E${row}`);
    const addressTimeText = [fullAddress, `🕐 ${locTime.replace(':', 'H')}`].filter(Boolean).join('  •  ');
    sheet.getCell(`A${row}`).value = addressTimeText;
    sheet.getCell(`A${row}`).font = { size: 11, color: { argb: 'FF333333' } };
    sheet.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.accent } };
    sheet.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getCell(`A${row}`).border = blackBorder;
    sheet.getRow(row).height = 24;
    row++;

    // Poule title - highlight if player's poule
    sheet.mergeCells(`A${row}:E${row}`);
    const pouleTitle = isPlayerPoule ? `⭐ POULE ${poule.number} (VOTRE POULE)` : `POULE ${poule.number}`;
    sheet.getCell(`A${row}`).value = pouleTitle;
    sheet.getCell(`A${row}`).font = { size: 13, bold: true, color: { argb: colors.white } };
    sheet.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isPlayerPoule ? 'FF28A745' : colors.primary } };
    sheet.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    sheet.getCell(`A${row}`).border = blackBorder;
    sheet.getRow(row).height = 28;
    row++;

    // Table headers
    const headers = ['#', 'Licence', 'Nom', 'Prénom', 'Club'];
    headers.forEach((header, i) => {
      const col = String.fromCharCode(65 + i);
      sheet.getCell(`${col}${row}`).value = header;
      sheet.getCell(`${col}${row}`).font = { size: 10, bold: true, color: { argb: colors.white } };
      sheet.getCell(`${col}${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.secondary } };
      sheet.getCell(`${col}${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
      sheet.getCell(`${col}${row}`).border = blackBorder;
    });
    sheet.getRow(row).height = 24;
    row++;

    // Players with alternating colors
    poule.players.forEach((p, pIndex) => {
      const isCurrentPlayer = p.licence === player.licence;
      const isEven = pIndex % 2 === 0;
      const rowColor = isCurrentPlayer ? colors.highlight : (isEven ? colors.white : colors.light);

      sheet.getCell(`A${row}`).value = p.finalRank || pIndex + 1;
      sheet.getCell(`B${row}`).value = p.licence || '';
      sheet.getCell(`C${row}`).value = (p.last_name || '').toUpperCase();
      sheet.getCell(`C${row}`).font = { bold: isCurrentPlayer, size: 10 };
      sheet.getCell(`D${row}`).value = p.first_name || '';
      sheet.getCell(`D${row}`).font = { size: 10 };
      sheet.getCell(`E${row}`).value = p.club || '';
      sheet.getCell(`E${row}`).font = { size: 9 };

      ['A', 'B', 'C', 'D', 'E'].forEach(col => {
        sheet.getCell(`${col}${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowColor } };
        sheet.getCell(`${col}${row}`).border = blackBorder;
        sheet.getCell(`${col}${row}`).alignment = { vertical: 'middle' };
      });
      sheet.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
      sheet.getCell(`B${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
      sheet.getRow(row).height = 22;
      row++;
    });

    // Space between poules
    row++;
  }

  // Note
  sheet.mergeCells(`A${row}:E${row}`);
  sheet.getCell(`A${row}`).value = "ℹ️ Les joueurs d'un même club jouent ensemble au 1er tour";
  sheet.getCell(`A${row}`).font = { size: 10, italic: true, color: { argb: 'FF666666' } };
  sheet.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(row).height = 22;
  row += 2;

  // Footer
  sheet.mergeCells(`A${row}:E${row}`);
  sheet.getCell(`A${row}`).value = `Comité Départemental Billard Hauts-de-Seine • ${new Date().toLocaleDateString('fr-FR')}`;
  sheet.getCell(`A${row}`).font = { size: 10, italic: true, color: { argb: 'FF999999' } };
  sheet.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(row).height = 22;

  return workbook;
}

// Send convocation emails
router.post('/send-convocations', authenticateToken, async (req, res) => {
  const { players, poules, category, season, tournament, tournamentDate, locations, sendToAll } = req.body;

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({
      error: 'Email not configured. Please set RESEND_API_KEY environment variable.'
    });
  }

  console.log('Using Resend API for email sending');

  const results = {
    sent: [],
    failed: [],
    skipped: []
  };

  const tournamentLabel = tournament === '4' ? 'Finale Départementale' : `Tournoi ${tournament}`;
  const dateStr = tournamentDate
    ? new Date(tournamentDate).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : 'Date à définir';

  // Process each player
  for (const player of players) {
    // Skip if no email
    if (!player.email || !player.email.includes('@')) {
      results.skipped.push({
        name: `${player.first_name} ${player.last_name}`,
        reason: 'Pas d\'email valide'
      });
      continue;
    }

    // Find which poule this player is in
    let playerPoule = null;
    let playerLocation = null;
    for (const poule of poules) {
      const found = poule.players.find(p => p.licence === player.licence);
      if (found) {
        playerPoule = {
          pouleNumber: poule.number,
          players: poule.players
        };
        // Get location for this poule
        const locNum = poule.locationNum || '1';
        playerLocation = locations.find(l => l.locationNum === locNum) || locations[0];
        break;
      }
    }

    if (!playerPoule) {
      results.skipped.push({
        name: `${player.first_name} ${player.last_name}`,
        reason: 'Joueur non trouvé dans les poules'
      });
      continue;
    }

    try {
      // Generate personalized Excel with ALL poules
      const workbook = await generatePlayerConvocation(
        player,
        {
          categoryName: category.display_name,
          season,
          tournamentNum: tournament,
          date: tournamentDate
        },
        poules,
        locations
      );

      const buffer = await workbook.xlsx.writeBuffer();
      const base64Content = buffer.toString('base64');

      // Send email using Resend
      const emailResult = await resend.emails.send({
        from: 'CDBHS Convocations <convocations@cdbhs.net>',
        to: [player.email],
        cc: ['cdbhs92@gmail.com'],
        subject: `Convocation ${category.display_name} - ${tournamentLabel} - ${dateStr}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
              <h1 style="margin: 0; font-size: 24px;">CONVOCATION</h1>
            </div>

            <div style="padding: 20px; background: #f8f9fa;">
              <p style="font-size: 16px;">Bonjour <strong>${player.first_name} ${player.last_name}</strong>,</p>

              <p>Le CDBHS a le plaisir de vous convier au tournoi suivant :</p>

              <p style="margin: 5px 0;"><strong>Catégorie :</strong> ${category.display_name}</p>
              <p style="margin: 5px 0;"><strong>Compétition :</strong> ${tournamentLabel}</p>
              <p style="margin: 5px 0;"><strong>Date :</strong> ${dateStr}</p>
              <p style="margin: 5px 0;"><strong>Heure :</strong> ${playerLocation?.startTime?.replace(':', 'H') || '14H00'}</p>
              <p style="margin: 5px 0;"><strong>Lieu :</strong> ${playerLocation?.name || 'À définir'}</p>
              ${playerLocation?.street ? `<p style="margin: 5px 0; color: #666;">${[playerLocation.street, playerLocation.zip_code, playerLocation.city].filter(Boolean).join(' ')}</p>` : ''}
              <p style="margin: 5px 0;"><strong>Votre poule est la :</strong> ${playerPoule.pouleNumber}</p>

              <p style="margin-top: 15px;">Veuillez trouver en attachement votre convocation détaillée avec la composition de toutes les poules du tournoi.</p>

              <p>En cas d'empêchement, merci d'informer dès que possible l'équipe en charge du sportif à l'adresse ci-dessous.</p>

              <p>Nous vous souhaitons une excellente compétition.</p>

              <p style="margin-top: 20px;">Cordialement,<br><strong>Comité Départemental Billard Hauts-de-Seine</strong></p>
            </div>

            <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">
              <p style="margin: 0;">CDBHS - cdbhs92@gmail.com</p>
            </div>
          </div>
        `,
        attachments: [{
          filename: `Convocation_${player.last_name}_${player.first_name}_${category.display_name.replace(/\s+/g, '_')}_T${tournament}.xlsx`,
          content: base64Content
        }]
      });

      console.log('Email sent:', emailResult);

      results.sent.push({
        name: `${player.first_name} ${player.last_name}`,
        email: player.email
      });

      // Add delay between emails to avoid rate limiting (1.5 seconds)
      await delay(1500);

    } catch (error) {
      console.error(`Error sending email to ${player.email}:`, error);
      results.failed.push({
        name: `${player.first_name} ${player.last_name}`,
        email: player.email,
        error: error.message
      });
    }
  }

  res.json({
    success: true,
    message: `Emails envoyés: ${results.sent.length}, Échecs: ${results.failed.length}, Ignorés: ${results.skipped.length}`,
    results
  });
});

// Test email configuration
router.post('/test', authenticateToken, async (req, res) => {
  const { testEmail } = req.body;

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({
      error: 'Email not configured. Please set RESEND_API_KEY environment variable.'
    });
  }

  try {
    const result = await resend.emails.send({
      from: 'CDBHS Convocations <convocations@cdbhs.net>',
      to: [testEmail || 'cdbhs92@gmail.com'],
      subject: 'Test - Configuration Email CDBHS',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2 style="color: #1F4788;">Configuration Email Réussie</h2>
          <p>Ce message confirme que la configuration email du système CDBHS fonctionne correctement.</p>
          <p>Date du test: ${new Date().toLocaleString('fr-FR')}</p>
        </div>
      `
    });

    console.log('Test email result:', result);
    res.json({ success: true, message: 'Email de test envoyé avec succès', result });
  } catch (error) {
    console.error('Email test error:', error);
    res.status(500).json({ error: error.message });
  }
});

// TEMPORARY: Create test data for email testing
router.post('/create-test-data', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  try {
    // 1. Create 6 test players
    const players = [
      { licence: 'TEST001', first_name: 'John', last_name: 'Doe-1', club: 'Courbevoie' },
      { licence: 'TEST002', first_name: 'John', last_name: 'Doe-2', club: 'Courbevoie' },
      { licence: 'TEST003', first_name: 'John', last_name: 'Doe-3', club: 'Clichy' },
      { licence: 'TEST004', first_name: 'John', last_name: 'Doe-4', club: 'Clichy' },
      { licence: 'TEST005', first_name: 'John', last_name: 'Doe-5', club: 'Clamart' },
      { licence: 'TEST006', first_name: 'John', last_name: 'Doe-6', club: 'Clamart' }
    ];

    for (const p of players) {
      await new Promise((resolve, reject) => {
        db.run(`
          INSERT INTO players (licence, first_name, last_name, club, is_active, rank_libre, rank_cadre, rank_bande, rank_3bandes)
          VALUES ($1, $2, $3, $4, 1, 'R1', 'NC', 'NC', 'NC')
          ON CONFLICT (licence) DO UPDATE SET
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            club = EXCLUDED.club,
            rank_libre = EXCLUDED.rank_libre
        `, [p.licence, p.first_name, p.last_name, p.club], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    // 2. Create test tournament (tournoi_ext)
    await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO tournoi_ext (tournoi_id, nom, mode, categorie, debut, fin, lieu, taille)
        VALUES (9999, 'TOURNOI 1', 'LIBRE', 'R1', '2025-12-06', '2025-12-06', 'Courbevoie', 280)
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

    // 3. Create 6 inscriptions
    const inscriptions = [
      { id: 2333, licence: 'TEST001', email: 'jeff_rallet@hotmail.com', timestamp: '2025-12-01 19:00:00' },
      { id: 2334, licence: 'TEST002', email: 'jeanmarc.huibonhoa@gmail.com', timestamp: '2025-12-01 19:10:00' },
      { id: 2335, licence: 'TEST003', email: 'jeff_rallet@hotmail.com', timestamp: '2025-12-01 19:20:00' },
      { id: 2336, licence: 'TEST004', email: 'jeanmarc.huibonhoa@gmail.com', timestamp: '2025-12-01 19:30:00' },
      { id: 2337, licence: 'TEST005', email: 'jeff_rallet@hotmail.com', timestamp: '2025-12-01 19:40:00' },
      { id: 2338, licence: 'TEST006', email: 'jeanmarc.huibonhoa@gmail.com', timestamp: '2025-12-01 19:50:00' }
    ];

    for (const i of inscriptions) {
      await new Promise((resolve, reject) => {
        db.run(`
          INSERT INTO inscriptions (inscription_id, tournoi_id, licence, email, convoque, forfait, timestamp)
          VALUES ($1, 9999, $2, $3, 1, 0, $4)
          ON CONFLICT (inscription_id) DO UPDATE SET
            licence = EXCLUDED.licence,
            email = EXCLUDED.email
        `, [i.id, i.licence, i.email, i.timestamp], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    res.json({
      success: true,
      message: 'Test data created: 6 players, 1 tournament (ID 9999), 6 inscriptions',
      tournament_id: 9999
    });

  } catch (error) {
    console.error('Error creating test data:', error);
    res.status(500).json({ error: error.message });
  }
});

// TEMPORARY: Delete test data
router.delete('/delete-test-data', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  try {
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM inscriptions WHERE inscription_id BETWEEN 2333 AND 2338', [], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await new Promise((resolve, reject) => {
      db.run('DELETE FROM tournoi_ext WHERE tournoi_id = 9999', [], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await new Promise((resolve, reject) => {
      db.run("DELETE FROM players WHERE licence LIKE 'TEST%'", [], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({ success: true, message: 'Test data deleted' });

  } catch (error) {
    console.error('Error deleting test data:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
