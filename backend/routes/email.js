const express = require('express');
const { Resend } = require('resend');
const PDFDocument = require('pdfkit');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Helper function to add delay between emails (avoid rate limiting)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Get summary email from app_settings (with fallback)
async function getSummaryEmail() {
  const db = require('../db-loader');
  return new Promise((resolve) => {
    db.get(
      "SELECT value FROM app_settings WHERE key = 'summary_email'",
      [],
      (err, row) => {
        resolve(row?.value || 'cdbhs92@gmail.com');
      }
    );
  });
}

// Initialize Resend
const getResend = () => {
  if (!process.env.RESEND_API_KEY) {
    return null;
  }
  return new Resend(process.env.RESEND_API_KEY);
};

// Fetch ranking data for players in a category/season
async function getRankingDataForCategory(categoryId, season) {
  const db = require('../db-loader');

  return new Promise((resolve) => {
    const query = `
      SELECT
        r.licence,
        r.rank_position,
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
      WHERE r.category_id = $1 AND r.season = $2
    `;

    db.all(query, [categoryId, season], (err, rows) => {
      if (err) {
        console.error('Error fetching ranking data:', err);
        resolve({});
      } else {
        // Build a map by licence (normalized)
        const rankingMap = {};
        (rows || []).forEach(r => {
          const normLicence = (r.licence || '').replace(/\s+/g, '');
          const moyenne = r.cumulated_reprises > 0
            ? (r.cumulated_points / r.cumulated_reprises).toFixed(3)
            : null;
          rankingMap[normLicence] = {
            rank: r.rank_position,
            moyenne: moyenne
          };
        });
        resolve(rankingMap);
      }
    });
  });
}

// Generate PDF convocation for a specific player - includes ALL poules
async function generatePlayerConvocationPDF(player, tournamentInfo, allPoules, locations, gameParams, selectedDistance, rankingData = {}) {
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
      const isFinale = tournamentInfo.tournamentNum === '4' || tournamentInfo.tournamentNum === 'Finale' || tournamentInfo.isFinale;
      const tournamentLabel = isFinale ? 'FINALE DEPARTEMENTALE' : `TOURNOI N°${tournamentInfo.tournamentNum}`;
      const headerColor = isFinale ? '#D4AF37' : primaryColor; // Gold for finals
      const headerTextColor = isFinale ? '#1F4788' : 'white';
      doc.rect(40, y, pageWidth, 45).fill(headerColor);
      doc.fillColor(headerTextColor).fontSize(22).font('Helvetica-Bold')
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
        y += 12;

        // Line 3: Explanation of Moyenne and Classement columns
        doc.fillColor('#666666').fontSize(8).font('Helvetica-Oblique')
           .text(`Les colonnes Moyenne et Classement en face du nom de chaque joueur correspondent aux positions cumulees a la suite du dernier tournoi joue`, 40, y, { width: pageWidth, align: 'center' });
        y += 15;
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
        const isFinalePoule = tournamentInfo.isFinale && allPoules.length === 1;
        let pouleTitle;
        if (isFinalePoule) {
          pouleTitle = isPlayerPoule ? 'POULE UNIQUE (VOTRE POULE)' : 'POULE UNIQUE';
        } else if (isPlayerPoule) {
          pouleTitle = `POULE ${poule.number} (VOTRE POULE)`;
        } else {
          pouleTitle = `POULE ${poule.number}`;
        }
        doc.rect(40, y, pageWidth, 22).fill(pouleColor);
        doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
           .text(pouleTitle, 50, y + 5);
        y += 26;

        // Table headers - with ranking columns
        doc.rect(40, y, pageWidth, 20).fill(secondaryColor);
        doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
        doc.text('#', 45, y + 5, { width: 20 });
        doc.text('Licence', 65, y + 5, { width: 60 });
        doc.text('Nom', 130, y + 5, { width: 100 });
        doc.text('Prenom', 235, y + 5, { width: 80 });
        doc.text('Club', 320, y + 5, { width: 120 });
        doc.text('Moy.', 445, y + 5, { width: 40, align: 'center' });
        doc.text('Class.', 490, y + 5, { width: 40, align: 'center' });
        y += 22;

        // Players
        poule.players.forEach((p, pIndex) => {
          const isCurrentPlayer = p.licence === player.licence;
          const isEven = pIndex % 2 === 0;
          const rowColor = isCurrentPlayer ? '#E3F2FD' : (isEven ? '#FFFFFF' : lightGray);

          // Get ranking info for this player
          const normLicence = (p.licence || '').replace(/\s+/g, '');
          const playerRanking = rankingData[normLicence] || {};

          doc.rect(40, y, pageWidth, 20).fill(rowColor);
          doc.fillColor('#333333').fontSize(8).font(isCurrentPlayer ? 'Helvetica-Bold' : 'Helvetica');
          doc.text(String(pIndex + 1), 45, y + 5, { width: 20 });
          doc.text(p.licence || '', 65, y + 5, { width: 60 });
          doc.text((p.last_name || '').toUpperCase(), 130, y + 5, { width: 100 });
          doc.text(p.first_name || '', 235, y + 5, { width: 80 });
          doc.font('Helvetica').fontSize(7).text(p.club || '', 320, y + 6, { width: 120 });
          // Moyenne and Classement columns
          doc.font(isCurrentPlayer ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
          doc.text(playerRanking.moyenne || '-', 445, y + 5, { width: 40, align: 'center' });
          doc.text(playerRanking.rank ? String(playerRanking.rank) : '-', 490, y + 5, { width: 40, align: 'center' });
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

// Generate NEUTRAL/SUMMARY PDF (no personalization) - for printing/sharing
async function generateSummaryConvocationPDF(tournamentInfo, allPoules, locations, gameParams, selectedDistance, rankingData = {}) {
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
      const lightGray = '#F8F9FA';

      // Helper to get location for a poule
      const getLocationForPoule = (poule) => {
        const locNum = poule.locationNum || '1';
        return locations.find(l => l.locationNum === locNum) || locations[0] || { name: 'A definir', startTime: '14:00' };
      };

      const pageWidth = doc.page.width - 80;
      let y = 40;

      // Header - CONVOCATION
      const isFinale = tournamentInfo.tournamentNum === '4' || tournamentInfo.tournamentNum === 'Finale' || tournamentInfo.isFinale;
      const tournamentLabel = isFinale ? 'FINALE DEPARTEMENTALE' : `TOURNOI N°${tournamentInfo.tournamentNum}`;
      const headerColor = isFinale ? '#D4AF37' : primaryColor; // Gold for finals
      const headerTextColor = isFinale ? '#1F4788' : 'white';
      doc.rect(40, y, pageWidth, 45).fill(headerColor);
      doc.fillColor(headerTextColor).fontSize(22).font('Helvetica-Bold')
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
        y += 12;

        // Line 3: Explanation of Moyenne and Classement columns
        doc.fillColor('#666666').fontSize(8).font('Helvetica-Oblique')
           .text(`Les colonnes Moyenne et Classement en face du nom de chaque joueur correspondent aux positions cumulees a la suite du dernier tournoi joue`, 40, y, { width: pageWidth, align: 'center' });
        y += 20;
      } else {
        y += 10;
      }

      // NO personalized player box - go straight to poules

      // ALL POULES
      for (const poule of allPoules) {
        // Check if we need a new page
        const estimatedHeight = 80 + (poule.players.length * 22);
        if (y + estimatedHeight > doc.page.height - 60) {
          doc.addPage();
          y = 40;
        }

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
        const isFinalePoule = tournamentInfo.isFinale && allPoules.length === 1;
        const pouleTitleText = isFinalePoule ? 'POULE UNIQUE' : `POULE ${poule.number}`;
        doc.rect(40, y, pageWidth, 22).fill(primaryColor);
        doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
           .text(pouleTitleText, 50, y + 5);
        y += 26;

        // Table headers - with ranking columns
        doc.rect(40, y, pageWidth, 20).fill(secondaryColor);
        doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
        doc.text('#', 45, y + 5, { width: 20 });
        doc.text('Licence', 65, y + 5, { width: 60 });
        doc.text('Nom', 130, y + 5, { width: 100 });
        doc.text('Prenom', 235, y + 5, { width: 80 });
        doc.text('Club', 320, y + 5, { width: 120 });
        doc.text('Moy.', 445, y + 5, { width: 40, align: 'center' });
        doc.text('Class.', 490, y + 5, { width: 40, align: 'center' });
        y += 22;

        // Players
        poule.players.forEach((p, pIndex) => {
          const isEven = pIndex % 2 === 0;
          const rowColor = isEven ? '#FFFFFF' : lightGray;

          // Get ranking info for this player
          const normLicence = (p.licence || '').replace(/\s+/g, '');
          const playerRanking = rankingData[normLicence] || {};

          doc.rect(40, y, pageWidth, 20).fill(rowColor);
          doc.fillColor('#333333').fontSize(8).font('Helvetica');
          doc.text(String(pIndex + 1), 45, y + 5, { width: 20 });
          doc.text(p.licence || '', 65, y + 5, { width: 60 });
          doc.text((p.last_name || '').toUpperCase(), 130, y + 5, { width: 100 });
          doc.text(p.first_name || '', 235, y + 5, { width: 80 });
          doc.fontSize(7).text(p.club || '', 320, y + 6, { width: 120 });
          // Moyenne and Classement columns
          doc.fontSize(8);
          doc.text(playerRanking.moyenne || '-', 445, y + 5, { width: 40, align: 'center' });
          doc.text(playerRanking.rank ? String(playerRanking.rank) : '-', 490, y + 5, { width: 40, align: 'center' });
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

// Default email template (fallback)
const DEFAULT_EMAIL_TEMPLATE = {
  subject: 'Convocation {category} - {tournament} - {date}',
  body: `Bonjour {player_name},

Le CDBHS a le plaisir de vous convier au tournoi suivant.

Veuillez trouver en attachement votre convocation detaillee avec la composition de toutes les poules du tournoi.

En cas d'empechement, merci d'informer des que possible l'equipe en charge du sportif a l'adresse ci-dessous.

Vous aurez noté un changement significatif quant au processus d'invitation et sommes a votre ecoute si vous avez des remarques ou des suggestions.

Nous vous souhaitons une excellente competition.

Cordialement,
Comite Departemental Billard Hauts-de-Seine`
};

// Default finale convocation template (fallback)
const DEFAULT_FINALE_EMAIL_TEMPLATE = {
  subject: 'Convocation Finale Départementale {category} - {date}',
  body: `Bonjour {player_name},

Suite aux trois tournois de la saison, nous avons le plaisir de vous informer que vous êtes qualifié(e) pour la Finale Départementale.

Veuillez trouver en attachement votre convocation detaillee avec la liste des finalistes.

En cas d'empêchement, merci de nous prévenir dès que possible à l'adresse ci-dessous.

Nous vous souhaitons une excellente finale !

Sportivement,
Comité Départemental Billard Hauts-de-Seine`
};

// Fetch email template from database
async function getEmailTemplate(templateType = 'convocation') {
  const db = require('../db-loader');

  // Determine which default template to use
  const defaultTemplate = templateType === 'convocation-finale'
    ? DEFAULT_FINALE_EMAIL_TEMPLATE
    : DEFAULT_EMAIL_TEMPLATE;

  return new Promise((resolve) => {
    db.get(
      'SELECT * FROM email_templates WHERE template_key = $1',
      [templateType],
      (err, row) => {
        if (err || !row) {
          resolve(defaultTemplate);
        } else {
          resolve({
            subject: row.subject_template,
            body: row.body_template
          });
        }
      }
    );
  });
}

// Replace template variables with actual values
function replaceTemplateVariables(template, variables) {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }
  return result;
}

// Send convocation emails
router.post('/send-convocations', authenticateToken, async (req, res) => {
  const { players, poules, category, season, tournament, tournamentDate, locations, sendToAll, specialNote, gameParams, selectedDistance, mockRankingData, isFinale } = req.body;

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({
      error: 'Email not configured. Please set RESEND_API_KEY environment variable.'
    });
  }

  console.log('Using Resend API for email sending');
  console.log(`Competition type: ${isFinale ? 'FINALE' : 'TOURNAMENT'}`);

  // Fetch email template - use finale template if isFinale
  const templateType = isFinale ? 'convocation-finale' : 'convocation';
  const emailTemplate = await getEmailTemplate(templateType);

  // Fetch ranking data for this category/season (or use mock data for testing)
  let rankingData = {};
  if (mockRankingData) {
    // Use provided mock data for testing
    rankingData = mockRankingData;
    console.log('Using mock ranking data for testing');
  } else if (category.id) {
    // Fetch real ranking data
    rankingData = await getRankingDataForCategory(category.id, season);
    console.log(`Fetched ranking data for ${Object.keys(rankingData).length} players`);
  }

  const results = {
    sent: [],
    failed: [],
    skipped: []
  };

  const tournamentLabel = (isFinale || tournament === 'Finale' || tournament === '4') ? 'Finale Departementale' : `Tournoi ${tournament}`;
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
          date: tournamentDate,
          isFinale: isFinale
        },
        poules,
        locations,
        gameParams,
        selectedDistance,
        rankingData
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

      // Prepare template variables
      const templateVariables = {
        player_name: `${player.first_name} ${player.last_name}`,
        first_name: player.first_name,
        last_name: player.last_name,
        category: category.display_name,
        tournament: tournamentLabel,
        date: dateStr,
        time: playerLocation?.startTime?.replace(':', 'H') || '14H00',
        location: playerLocation?.name || 'A definir',
        poule: playerPoule.pouleNumber
      };

      // Generate subject and body from template
      const emailSubject = replaceTemplateVariables(emailTemplate.subject, templateVariables);
      const emailBodyText = replaceTemplateVariables(emailTemplate.body, templateVariables);
      // Convert newlines to <br> for HTML
      const emailBodyHtml = emailBodyText.replace(/\n/g, '<br>');

      // Send email using Resend (no CC - summary email sent at the end)
      const emailResult = await resend.emails.send({
        from: 'CDBHS Convocations <convocations@cdbhs.net>',
        replyTo: 'cdbhs92@gmail.com',
        to: [player.email],
        subject: emailSubject,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
              <h1 style="margin: 0; font-size: 24px;">CONVOCATION</h1>
            </div>

            <div style="padding: 20px; background: #f8f9fa;">
              ${specialNoteHtml}

              <div style="margin-bottom: 20px; padding: 15px; background: white; border-radius: 4px; border-left: 4px solid #1F4788;">
                <p style="margin: 5px 0;"><strong>Categorie :</strong> ${category.display_name}</p>
                <p style="margin: 5px 0;"><strong>Competition :</strong> ${tournamentLabel}</p>
                <p style="margin: 5px 0;"><strong>Date :</strong> ${dateStr}</p>
                <p style="margin: 5px 0;"><strong>Heure :</strong> ${playerLocation?.startTime?.replace(':', 'H') || '14H00'}</p>
                <p style="margin: 5px 0;"><strong>Lieu :</strong> ${playerLocation?.name || 'A definir'}</p>
                ${fullAddress ? `<p style="margin: 5px 0; color: #666;">${fullAddress}</p>` : ''}
                <p style="margin: 5px 0;"><strong>Votre poule :</strong> ${playerPoule.pouleNumber}</p>
              </div>

              <div style="line-height: 1.6;">
                ${emailBodyHtml}
              </div>
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

  // Send summary email after all individual emails
  const summaryEmailAddress = await getSummaryEmail();
  if (results.sent.length > 0 && summaryEmailAddress) {
    try {
      // Build recipient list HTML
      const recipientListHtml = results.sent.map((r, idx) =>
        `<tr style="background: ${idx % 2 === 0 ? 'white' : '#f8f9fa'};">
          <td style="padding: 8px; border: 1px solid #ddd;">${idx + 1}</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${r.name}</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${r.email}</td>
        </tr>`
      ).join('');

      // Build poules summary
      const poulesSummaryHtml = poules.map(poule => {
        const locNum = poule.locationNum || '1';
        const loc = locations.find(l => l.locationNum === locNum) || locations[0];
        return `<div style="margin-bottom: 15px; padding: 10px; background: #f8f9fa; border-radius: 4px;">
          <strong>Poule ${poule.number}</strong> - ${loc?.name || 'Lieu non défini'} (${loc?.startTime || '13:30'})
          <div style="font-size: 12px; color: #666; margin-top: 5px;">
            ${poule.players.map(p => `${p.first_name} ${p.last_name}`).join(', ')}
          </div>
        </div>`;
      }).join('');

      const summaryHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
          <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
            <img src="https://cdbhs-tournament-management-production.up.railway.app/images/billiard-icon.png" alt="CDBHS" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
            <h1 style="margin: 0; font-size: 24px;">📋 Récapitulatif Convocations</h1>
            <p style="margin: 10px 0 0 0; opacity: 0.9;">${category.display_name}</p>
          </div>
          <div style="padding: 20px; background: #f8f9fa; line-height: 1.6;">
            <div style="background: #d4edda; border-left: 4px solid #28a745; padding: 15px; margin-bottom: 20px;">
              <strong>✅ Envoi terminé avec succès</strong><br>
              ${results.sent.length} convocation(s) envoyée(s) sur ${players.length} joueur(s)
              ${results.failed.length > 0 ? `<br><span style="color: #dc3545;">${results.failed.length} échec(s)</span>` : ''}
              ${results.skipped.length > 0 ? `<br><span style="color: #856404;">${results.skipped.length} ignoré(s) (pas d'email)</span>` : ''}
            </div>

            <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ddd;">
              <h3 style="margin-top: 0; color: #1F4788;">📍 Informations du Tournoi</h3>
              <p><strong>Catégorie :</strong> ${category.display_name}</p>
              <p><strong>Compétition :</strong> ${tournamentLabel}</p>
              <p><strong>Date :</strong> ${dateStr}</p>
              ${specialNote ? `<p style="color: #856404;"><strong>Note spéciale :</strong> ${specialNote}</p>` : ''}
            </div>

            <h3 style="color: #1F4788;">📧 Convocations Envoyées (${results.sent.length})</h3>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13px;">
              <thead>
                <tr style="background: #1F4788; color: white;">
                  <th style="padding: 10px; border: 1px solid #ddd;">#</th>
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Joueur</th>
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Email</th>
                </tr>
              </thead>
              <tbody>
                ${recipientListHtml}
              </tbody>
            </table>

            <h3 style="color: #28a745;">🎱 Composition des Poules (${poules.length})</h3>
            ${poulesSummaryHtml}
          </div>
          <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">
            <p style="margin: 0;">CDBHS - cdbhs92@gmail.com</p>
          </div>
        </div>
      `;

      await resend.emails.send({
        from: 'CDBHS Convocations <convocations@cdbhs.net>',
        replyTo: 'cdbhs92@gmail.com',
        to: [summaryEmailAddress],
        subject: `📋 Récapitulatif - Convocations ${category.display_name} - ${tournamentLabel} - ${dateStr}`,
        html: summaryHtml
      });

      console.log(`Summary email sent to ${summaryEmailAddress}`);
    } catch (summaryError) {
      console.error('Error sending summary email:', summaryError);
      // Don't fail the whole operation if summary email fails
    }
  }

  res.json({
    success: true,
    message: `Emails envoyes: ${results.sent.length}, Echecs: ${results.failed.length}, Ignores: ${results.skipped.length}${results.sent.length > 0 ? ' + récapitulatif envoyé' : ''}`,
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
      replyTo: 'cdbhs92@gmail.com',
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
    // 1. Create 6 test players with ranking info
    const players = [
      { licence: 'TEST001', first_name: 'John', last_name: 'Doe-1', club: 'Courbevoie', rank: 1, moyenne: '2.098' },
      { licence: 'TEST002', first_name: 'John', last_name: 'Doe-2', club: 'Courbevoie', rank: 2, moyenne: '2.057' },
      { licence: 'TEST003', first_name: 'John', last_name: 'Doe-3', club: 'Clichy', rank: 3, moyenne: '2.697' },
      { licence: 'TEST004', first_name: 'John', last_name: 'Doe-4', club: 'Clichy', rank: 4, moyenne: '1.856' },
      { licence: 'TEST005', first_name: 'John', last_name: 'Doe-5', club: 'Clamart', rank: 5, moyenne: '1.542' },
      { licence: 'TEST006', first_name: 'John', last_name: 'Doe-6', club: 'Clamart', rank: 6, moyenne: '1.234' }
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

    // Build mock ranking data map to return for testing
    const mockRankingData = {};
    players.forEach(p => {
      mockRankingData[p.licence] = {
        rank: p.rank,
        moyenne: p.moyenne
      };
    });

    res.json({
      success: true,
      message: 'Test data created: 6 players, 1 tournament (ID 9999), 6 inscriptions',
      tournament_id: 9999,
      mockRankingData: mockRankingData
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

// Generate summary/neutral PDF (for printing - no personalization)
router.post('/generate-summary-pdf', authenticateToken, async (req, res) => {
  const { poules, category, season, tournament, tournamentDate, locations, gameParams, selectedDistance, mockRankingData, isFinale } = req.body;

  try {
    const db = require('../db-loader');

    // Determine if this is a finale
    const isFinaleCompetition = isFinale || tournament === 'Finale' || tournament === '4';

    // Build tournament info
    const tournamentInfo = {
      categoryName: category.display_name,
      tournamentNum: tournament,
      season: season,
      date: tournamentDate,
      isFinale: isFinaleCompetition
    };

    // Get ranking data
    let rankingData = {};
    if (mockRankingData) {
      rankingData = mockRankingData;
    } else if (category.id) {
      rankingData = await getRankingDataForCategory(category.id, season);
    }

    // Generate PDF
    const pdfBuffer = await generateSummaryConvocationPDF(
      tournamentInfo,
      poules,
      locations || [],
      gameParams,
      selectedDistance,
      rankingData
    );

    // Send PDF
    res.setHeader('Content-Type', 'application/pdf');
    const filename = `Convocation_${category.display_name.replace(/\s+/g, '_')}_T${tournament}_${season}.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);

  } catch (error) {
    console.error('Error generating summary PDF:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
