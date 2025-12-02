const express = require('express');
const { Resend } = require('resend');
const PDFDocument = require('pdfkit');
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

// Generate PDF convocation for a specific player - includes ALL poules
async function generatePlayerConvocationPDF(player, tournamentInfo, allPoules, locations, gameParams, selectedDistance) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        bufferPages: true
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Colors
      const primaryColor = '#1F4788';
      const secondaryColor = '#667EEA';
      const accentColor = '#FFC107';
      const redColor = '#DC3545';
      const greenColor = '#28A745';
      const lightGray = '#F8F9FA';

      // Find player's poule
      let playerPouleNumber = null;
      for (const poule of allPoules) {
        if (poule.players.find(p => p.licence === player.licence)) {
          playerPouleNumber = poule.number;
          break;
        }
      }

      // Helper to get location for a poule
      const getLocationForPoule = (poule) => {
        const locNum = poule.locationNum || '1';
        return locations.find(l => l.locationNum === locNum) || locations[0] || { name: 'A definir', startTime: '14:00' };
      };

      const pageWidth = doc.page.width - 80;
      let y = 40;

      // Header - CONVOCATION
      const tournamentLabel = tournamentInfo.tournamentNum === '4' ? 'FINALE DEPARTEMENTALE' : `TOURNOI N${tournamentInfo.tournamentNum}`;
      doc.rect(40, y, pageWidth, 45).fill(primaryColor);
      doc.fillColor('white').fontSize(22).font('Helvetica-Bold')
         .text(`CONVOCATION ${tournamentLabel}`, 40, y + 12, { width: pageWidth, align: 'center' });
      y += 50;

      // Season
      doc.rect(40, y, pageWidth, 30).fill(secondaryColor);
      doc.fillColor('white').fontSize(14).font('Helvetica-Bold')
         .text(`SAISON ${tournamentInfo.season}`, 40, y + 8, { width: pageWidth, align: 'center' });
      y += 40;

      // Date - prominent in red
      const dateStr = tournamentInfo.date
        ? new Date(tournamentInfo.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()
        : 'DATE A DEFINIR';
      doc.fillColor(redColor).fontSize(16).font('Helvetica-Bold')
         .text(dateStr, 40, y, { width: pageWidth, align: 'center' });
      y += 30;

      // Category
      doc.rect(40, y, pageWidth, 30).fill(secondaryColor);
      doc.fillColor('white').fontSize(14).font('Helvetica-Bold')
         .text(tournamentInfo.categoryName, 40, y + 8, { width: pageWidth, align: 'center' });
      y += 35;

      // Game parameters info (if available)
      if (gameParams) {
        const distance = selectedDistance === 'reduite' && gameParams.distance_reduite
          ? gameParams.distance_reduite
          : gameParams.distance_normale;
        const coinLabel = gameParams.coin === 'GC' ? 'Grand Coin' : 'Petit Coin';

        // Line 1: Distance / Coin / Reprises
        doc.fillColor('#333333').fontSize(10).font('Helvetica-Bold')
           .text(`${distance} points  /  ${coinLabel}  /  en ${gameParams.reprises} reprises`, 40, y, { width: pageWidth, align: 'center' });
        y += 15;

        // Line 2: Moyenne qualificative
        doc.fillColor('#666666').fontSize(9).font('Helvetica-Oblique')
           .text(`La moyenne qualificative pour cette categorie est entre ${parseFloat(gameParams.moyenne_mini).toFixed(3)} et ${parseFloat(gameParams.moyenne_maxi).toFixed(3)}`, 40, y, { width: pageWidth, align: 'center' });
        y += 20;
      } else {
        y += 5;
      }

      // Player info box - highlight their assignment
      doc.rect(40, y, pageWidth, 35).fill('#E3F2FD');
      doc.fillColor(primaryColor).fontSize(12).font('Helvetica-Bold')
         .text(`${player.first_name} ${player.last_name} - Vous etes en POULE ${playerPouleNumber}`.toUpperCase(),
                40, y + 10, { width: pageWidth, align: 'center' });
      y += 50;

      // ALL POULES
      for (const poule of allPoules) {
        // Check if we need a new page
        const estimatedHeight = 80 + (poule.players.length * 22);
        if (y + estimatedHeight > doc.page.height - 60) {
          doc.addPage();
          y = 40;
        }

        const isPlayerPoule = poule.number === playerPouleNumber;
        const loc = getLocationForPoule(poule);
        const locName = loc?.name || 'A definir';
        const locStreet = loc?.street || '';
        const locZipCode = loc?.zip_code || '';
        const locCity = loc?.city || '';
        const fullAddress = [locStreet, locZipCode, locCity].filter(Boolean).join(' ');
        const locTime = loc?.startTime || '14:00';

        // Location header bar
        doc.rect(40, y, pageWidth, 24).fill(accentColor);
        doc.fillColor('#333333').fontSize(10).font('Helvetica-Bold')
           .text(`${locName.toUpperCase()}`, 50, y + 6);
        doc.font('Helvetica').text(`${fullAddress}  -  ${locTime.replace(':', 'H')}`,
           250, y + 6, { width: pageWidth - 220, align: 'right' });
        y += 28;

        // Poule title
        const pouleColor = isPlayerPoule ? greenColor : primaryColor;
        const pouleTitle = isPlayerPoule ? `POULE ${poule.number} (VOTRE POULE)` : `POULE ${poule.number}`;
        doc.rect(40, y, pageWidth, 22).fill(pouleColor);
        doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
           .text(pouleTitle, 50, y + 5);
        y += 26;

        // Table headers
        doc.rect(40, y, pageWidth, 20).fill(secondaryColor);
        doc.fillColor('white').fontSize(9).font('Helvetica-Bold');
        doc.text('#', 45, y + 5, { width: 25 });
        doc.text('Licence', 70, y + 5, { width: 70 });
        doc.text('Nom', 145, y + 5, { width: 120 });
        doc.text('Prenom', 270, y + 5, { width: 100 });
        doc.text('Club', 375, y + 5, { width: 160 });
        y += 22;

        // Players
        poule.players.forEach((p, pIndex) => {
          const isCurrentPlayer = p.licence === player.licence;
          const isEven = pIndex % 2 === 0;
          const rowColor = isCurrentPlayer ? '#E3F2FD' : (isEven ? '#FFFFFF' : lightGray);

          doc.rect(40, y, pageWidth, 20).fill(rowColor);
          doc.fillColor('#333333').fontSize(9).font(isCurrentPlayer ? 'Helvetica-Bold' : 'Helvetica');
          doc.text(String(pIndex + 1), 45, y + 5, { width: 25 });
          doc.text(p.licence || '', 70, y + 5, { width: 70 });
          doc.text((p.last_name || '').toUpperCase(), 145, y + 5, { width: 120 });
          doc.text(p.first_name || '', 270, y + 5, { width: 100 });
          doc.font('Helvetica').fontSize(8).text(p.club || '', 375, y + 6, { width: 160 });
          y += 20;
        });

        y += 15;
      }

      // Note at the bottom
      if (y + 60 > doc.page.height - 40) {
        doc.addPage();
        y = 40;
      }

      doc.fillColor('#666666').fontSize(9).font('Helvetica-Oblique')
         .text("Les joueurs d'un meme club jouent ensemble au 1er tour", 40, y, { width: pageWidth, align: 'center' });
      y += 25;

      // Footer
      doc.fillColor('#999999').fontSize(9).font('Helvetica-Oblique')
         .text(`Comite Departemental Billard Hauts-de-Seine - ${new Date().toLocaleDateString('fr-FR')}`,
                40, y, { width: pageWidth, align: 'center' });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

// Send convocation emails
router.post('/send-convocations', authenticateToken, async (req, res) => {
  const { players, poules, category, season, tournament, tournamentDate, locations, sendToAll, specialNote, gameParams, selectedDistance } = req.body;

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

  const tournamentLabel = tournament === '4' ? 'Finale Departementale' : `Tournoi ${tournament}`;
  const dateStr = tournamentDate
    ? new Date(tournamentDate).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : 'Date a definir';

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
        reason: 'Joueur non trouve dans les poules'
      });
      continue;
    }

    try {
      // Generate personalized PDF with ALL poules
      const pdfBuffer = await generatePlayerConvocationPDF(
        player,
        {
          categoryName: category.display_name,
          season,
          tournamentNum: tournament,
          date: tournamentDate
        },
        poules,
        locations,
        gameParams,
        selectedDistance
      );

      const base64Content = pdfBuffer.toString('base64');

      // Build full address
      const fullAddress = playerLocation?.street
        ? [playerLocation.street, playerLocation.zip_code, playerLocation.city].filter(Boolean).join(' ')
        : '';

      // Build special note HTML if provided
      const specialNoteHtml = specialNote
        ? `<div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 15px; margin-bottom: 20px;">
             <p style="margin: 0; color: #856404;">${specialNote.replace(/\n/g, '<br>')}</p>
           </div>`
        : '';

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
              ${specialNoteHtml}

              <p style="font-size: 16px;">Bonjour <strong>${player.first_name} ${player.last_name}</strong>,</p>

              <p>Le CDBHS a le plaisir de vous convier au tournoi suivant :</p>

              <p style="margin: 5px 0;"><strong>Categorie :</strong> ${category.display_name}</p>
              <p style="margin: 5px 0;"><strong>Competition :</strong> ${tournamentLabel}</p>
              <p style="margin: 5px 0;"><strong>Date :</strong> ${dateStr}</p>
              <p style="margin: 5px 0;"><strong>Heure :</strong> ${playerLocation?.startTime?.replace(':', 'H') || '14H00'}</p>
              <p style="margin: 5px 0;"><strong>Lieu :</strong> ${playerLocation?.name || 'A definir'}</p>
              ${fullAddress ? `<p style="margin: 5px 0; color: #666;">${fullAddress}</p>` : ''}
              <p style="margin: 5px 0;"><strong>Votre poule est la :</strong> ${playerPoule.pouleNumber}</p>

              <p style="margin-top: 15px;">Veuillez trouver en attachement votre convocation detaillee avec la composition de toutes les poules du tournoi.</p>

              <p>En cas d'empechement, merci d'informer des que possible l'equipe en charge du sportif a l'adresse ci-dessous.</p>

              <p>Vous aurez noté un changement notable quant au processus d'invitation et sommes a votre ecoute si vous avez des remarques ou des suggestions.</p>

              <p>Nous vous souhaitons une excellente competition.</p>

              <p style="margin-top: 20px;">Cordialement,<br><strong>Comite Departemental Billard Hauts-de-Seine</strong></p>
            </div>

            <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">
              <p style="margin: 0;">CDBHS - cdbhs92@gmail.com</p>
            </div>
          </div>
        `,
        attachments: [{
          filename: `Convocation_${player.last_name}_${player.first_name}_${category.display_name.replace(/\s+/g, '_')}_T${tournament}.pdf`,
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
    message: `Emails envoyes: ${results.sent.length}, Echecs: ${results.failed.length}, Ignores: ${results.skipped.length}`,
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
          <h2 style="color: #1F4788;">Configuration Email Reussie</h2>
          <p>Ce message confirme que la configuration email du systeme CDBHS fonctionne correctement.</p>
          <p>Date du test: ${new Date().toLocaleString('fr-FR')}</p>
        </div>
      `
    });

    console.log('Test email result:', result);
    res.json({ success: true, message: 'Email de test envoye avec succes', result });
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
