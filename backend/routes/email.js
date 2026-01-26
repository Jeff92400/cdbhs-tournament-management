const express = require('express');
const path = require('path');
const fs = require('fs');
const { Resend } = require('resend');
const PDFDocument = require('pdfkit');
const { authenticateToken } = require('./auth');
const appSettings = require('../utils/app-settings');
const { logAdminAction, ACTION_TYPES } = require('../utils/admin-logger');

const router = express.Router();

// French billiard icon as base64 data URI (embedded in email to avoid external image blocking)
const FRENCH_BILLARD_ICON_BASE64 = 'data:image/png;base64,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';
const FRENCH_BILLARD_ICON_IMG = `<img src="${FRENCH_BILLARD_ICON_BASE64}" alt="🎯" style="height: 18px; width: 18px; vertical-align: middle;">`;

// Helper function to add delay between emails (avoid rate limiting)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Get organization logo as buffer from database (for PDFs)
async function getOrganizationLogoBuffer() {
  const db = require('../db-loader');
  return new Promise((resolve) => {
    db.get('SELECT file_data, content_type FROM organization_logo ORDER BY created_at DESC LIMIT 1', [], (err, row) => {
      if (err || !row) {
        // Fallback to static French billiard icon
        const fallbackPath = path.join(__dirname, '../../frontend/images/FrenchBillard-Icon-small.png');
        if (fs.existsSync(fallbackPath)) {
          resolve(fs.readFileSync(fallbackPath));
        } else {
          resolve(null);
        }
        return;
      }
      const buffer = Buffer.isBuffer(row.file_data) ? row.file_data : Buffer.from(row.file_data);
      resolve(buffer);
    });
  });
}

// Get summary email from app_settings (with fallback)
async function getSummaryEmail() {
  return appSettings.getSetting('summary_email');
}

// Get contact email from app_settings (with fallback)
async function getContactEmail() {
  return appSettings.getSetting('summary_email'); // Uses summary_email as contact
}

// Get all email-related settings at once (for templates)
async function getEmailTemplateSettings() {
  const settings = await appSettings.getSettingsBatch([
    'primary_color',
    'secondary_color',
    'accent_color',
    'email_noreply',
    'email_convocations',
    'email_sender_name',
    'organization_name',
    'organization_short_name',
    'summary_email'
  ]);
  return settings;
}

// Build email header HTML with dynamic settings
function buildEmailHeader(title, settings) {
  const primaryColor = settings.primary_color || '#1F4788';
  return `<div style="background: ${primaryColor}; color: white; padding: 20px; text-align: center;">
    <h1 style="margin: 0; font-size: 24px;">${title}</h1>
  </div>`;
}

// Generate finale match schedule based on number of players
// Returns HTML table with match schedule
function generateFinaleMatchScheduleHtml(numPlayers, players, primaryColor = '#1F4788') {
  // Build player name lookup by position (1-indexed)
  const getPlayerName = (pos) => {
    const p = players[pos - 1];
    return p ? `${p.first_name} ${p.last_name}` : `Joueur ${pos}`;
  };

  let matchesHtml = '';
  let tableInfo = '';

  if (numPlayers === 3) {
    // 3 players: simple round robin
    tableInfo = '1 table';
    const matches = [
      { num: 1, p1: 1, p2: 2 },
      { num: 2, p1: 1, p2: 3 },
      { num: 3, p1: 2, p2: 3 }
    ];
    matchesHtml = matches.map((m, idx) => `
      <tr style="background: ${idx % 2 === 0 ? 'white' : '#f8f9fa'};">
        <td style="padding: 8px; border: 1px solid #ddd; text-align: center; font-weight: bold;">${m.num}</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${getPlayerName(m.p1)}</td>
        <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">vs</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${getPlayerName(m.p2)}</td>
      </tr>
    `).join('');
  } else if (numPlayers === 4) {
    // 4 players on 2 tables
    tableInfo = '2 tables';
    const matches = [
      { num: 1, p1: 2, p2: 3 },
      { num: 2, p1: 1, p2: 4 },
      { num: 3, p1: 3, p2: 4, note: '(perdants M1 & M2)' },
      { num: 4, p1: 1, p2: 2, note: '(gagnants M1 & M2)' },
      { num: 5, p1: 1, p2: 3, note: '(restant joueur 1)' },
      { num: 6, p1: 2, p2: 4, note: '(restant joueur 4)' }
    ];
    matchesHtml = matches.map((m, idx) => `
      <tr style="background: ${idx % 2 === 0 ? 'white' : '#f8f9fa'};">
        <td style="padding: 8px; border: 1px solid #ddd; text-align: center; font-weight: bold;">${m.num}</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${getPlayerName(m.p1)}</td>
        <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">vs</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${getPlayerName(m.p2)}</td>
      </tr>
    `).join('');
  } else if (numPlayers >= 6) {
    // 6 players on 3 tables - show by table
    tableInfo = '3 tables';
    const table1 = [
      { p1: 1, p2: 6 }, { p1: 2, p2: 3 }, { p1: 1, p2: 4 }, { p1: 5, p2: 6 }, { p1: 4, p2: 5 }
    ];
    const table2 = [
      { p1: 2, p2: 5 }, { p1: 4, p2: 6 }, { p1: 3, p2: 5 }, { p1: 1, p2: 3 }, { p1: 1, p2: 2 }
    ];
    const table3 = [
      { p1: 3, p2: 4 }, { p1: 1, p2: 5 }, { p1: 2, p2: 6 }, { p1: 2, p2: 4 }, { p1: 3, p2: 6 }
    ];

    const buildTableHtml = (tableName, matches) => {
      return `
        <div style="flex: 1; min-width: 180px;">
          <h4 style="margin: 0 0 8px 0; color: ${primaryColor}; text-align: center;">${tableName}</h4>
          <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
            ${matches.map((m, idx) => `
              <tr style="background: ${idx % 2 === 0 ? 'white' : '#f8f9fa'};">
                <td style="padding: 6px; border: 1px solid #ddd;">${getPlayerName(m.p1)}</td>
                <td style="padding: 6px; border: 1px solid #ddd; text-align: center;">vs</td>
                <td style="padding: 6px; border: 1px solid #ddd;">${getPlayerName(m.p2)}</td>
              </tr>
            `).join('')}
          </table>
        </div>
      `;
    };

    return `
      <div style="margin: 20px 0; padding: 15px; background: white; border-radius: 8px; border: 1px solid #ddd;">
        <h3 style="margin: 0 0 10px 0; color: ${primaryColor};">🏆 Programme des Matchs (${tableInfo})</h3>
        <p style="margin: 0 0 15px 0; font-size: 13px; color: #666;">Tous contre tous - chaque joueur affronte tous les autres</p>
        <div style="display: flex; gap: 15px; flex-wrap: wrap;">
          ${buildTableHtml('Table 1', table1)}
          ${buildTableHtml('Table 2', table2)}
          ${buildTableHtml('Table 3', table3)}
        </div>
      </div>
    `;
  } else {
    return ''; // No schedule for other numbers
  }

  // Return standard table format for 3 and 4 players
  return `
    <div style="margin: 20px 0; padding: 15px; background: white; border-radius: 8px; border: 1px solid #ddd;">
      <h3 style="margin: 0 0 10px 0; color: ${primaryColor};">🏆 Programme des Matchs (${tableInfo})</h3>
      <p style="margin: 0 0 15px 0; font-size: 13px; color: #666;">Tous contre tous - chaque joueur affronte tous les autres</p>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="background: ${primaryColor}; color: white;">
            <th style="padding: 8px; border: 1px solid #ddd;">Match</th>
            <th style="padding: 8px; border: 1px solid #ddd;">Joueur</th>
            <th style="padding: 8px; border: 1px solid #ddd;"></th>
            <th style="padding: 8px; border: 1px solid #ddd;">Joueur</th>
          </tr>
        </thead>
        <tbody>
          ${matchesHtml}
        </tbody>
      </table>
    </div>
  `;
}

// Build email footer HTML with dynamic settings
function buildEmailFooter(settings) {
  const primaryColor = settings.primary_color || '#1F4788';
  const orgName = settings.organization_name || 'Comité Départemental de Billard des Hauts-de-Seine';
  const shortName = settings.organization_short_name || 'CDBHS';
  return `<div style="background: ${primaryColor}; color: white; padding: 10px; text-align: center; font-size: 12px;">
    <p style="margin: 0;">${shortName} - ${orgName}</p>
  </div>`;
}

// Build "from" address for emails
function buildFromAddress(settings, type = 'noreply') {
  const senderName = settings.email_sender_name || 'CDBHS';
  let email;
  switch (type) {
    case 'convocations':
      email = settings.email_convocations || 'convocations@cdbhs.net';
      break;
    default:
      email = settings.email_noreply || 'noreply@cdbhs.net';
  }
  return `${senderName} <${email}>`;
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

// Fetch ranking data by category display name (fallback when category_id is not available)
async function getRankingDataByCategoryName(categoryDisplayName, season) {
  const db = require('../db-loader');

  return new Promise((resolve) => {
    // First find the category_id by matching display_name
    const normalizedName = (categoryDisplayName || '').toUpperCase().replace(/\s+/g, ' ').trim();

    db.get(
      `SELECT id FROM categories WHERE UPPER(REPLACE(display_name, '  ', ' ')) = $1`,
      [normalizedName],
      (err, cat) => {
        if (err || !cat) {
          // Try partial match
          db.get(
            `SELECT id FROM categories WHERE UPPER(display_name) LIKE $1`,
            [`%${normalizedName}%`],
            (err2, cat2) => {
              if (err2 || !cat2) {
                console.log(`[Ranking] No category found for: ${normalizedName}`);
                resolve({});
              } else {
                console.log(`[Ranking] Found category by partial match: ${cat2.id}`);
                getRankingDataForCategory(cat2.id, season).then(resolve);
              }
            }
          );
        } else {
          console.log(`[Ranking] Found category by exact match: ${cat.id}`);
          getRankingDataForCategory(cat.id, season).then(resolve);
        }
      }
    );
  });
}

// Generate match schedule for a poule based on its size
// For 4 players: 1v4, 2v3 first (based on seeding), then winners vs winners, losers vs losers
// For 5 players: 1v5, 2v4 first, then J3 plays losers, finally winners play
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
  // For other sizes, no fixed schedule displayed
  return [];
}

// Generate PDF convocation for a specific player - includes ALL poules
async function generatePlayerConvocationPDF(player, tournamentInfo, allPoules, locations, gameParams, selectedDistance, rankingData = {}, brandingSettings = {}) {
  // Fetch logo before entering Promise to avoid async issues
  let logoBuffer = null;
  try {
    logoBuffer = await getOrganizationLogoBuffer();
  } catch (err) {
    console.log('Logo not found for PDF:', err.message);
  }

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

      // Colors and branding (from settings or defaults)
      const primaryColor = brandingSettings.primary_color || '#1F4788';
      const secondaryColor = brandingSettings.secondary_color || '#667EEA';
      const accentColor = brandingSettings.accent_color || '#FFC107';
      const orgName = brandingSettings.organization_name || 'Comite Departemental Billard';
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
      const headerTextColor = isFinale ? primaryColor : 'white';
      doc.rect(40, y, pageWidth, 45).fill(headerColor);

      // Add organization logo on left side of header (logoBuffer fetched before Promise)
      if (logoBuffer) {
        try {
          doc.image(logoBuffer, 48, y + 5, { width: 35 });
        } catch (err) {
          console.log('Error adding logo to PDF:', err.message);
        }
      }

      // Title text - offset to avoid logo overlap, slightly smaller font
      doc.fillColor(headerTextColor).fontSize(20).font('Helvetica-Bold')
         .text(`CONVOCATION ${tournamentLabel}`, 90, y + 14, { width: pageWidth - 60, align: 'center' });
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
           .text(`La moyenne qualificative pour cette catégorie est entre ${parseFloat(gameParams.moyenne_mini).toFixed(3)} et ${parseFloat(gameParams.moyenne_maxi).toFixed(3)}`, 40, y, { width: pageWidth, align: 'center' });
        y += 12;

        // Line 3: Explanation of Moyenne and Classement columns
        doc.fillColor('#666666').fontSize(8).font('Helvetica-Oblique')
           .text(`Les colonnes Moyenne et Classement en face du nom de chaque joueur correspondent aux positions cumulées à la suite du dernier tournoi joué`, 40, y, { width: pageWidth, align: 'center' });
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
        doc.text('Prenom', 130, y + 5, { width: 80 });
        doc.text('Nom', 215, y + 5, { width: 100 });
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
          doc.text(p.first_name || '', 130, y + 5, { width: 80 });
          doc.text((p.last_name || '').toUpperCase(), 215, y + 5, { width: 100 });
          doc.font('Helvetica').fontSize(7).text(p.club || '', 320, y + 6, { width: 120 });
          // Moyenne and Classement columns
          doc.font(isCurrentPlayer ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
          doc.text(playerRanking.moyenne || '-', 445, y + 5, { width: 40, align: 'center' });
          doc.text(playerRanking.rank ? String(playerRanking.rank) : '-', 490, y + 5, { width: 40, align: 'center' });
          y += 20;
        });

        // Add match schedule for poules
        const pouleSize = poule.players.length;

        // For finales: round-robin format (tous contre tous)
        if (isFinale && (pouleSize === 3 || pouleSize === 4 || pouleSize === 6)) {
          y += 8;

          // Define finale matches based on player count
          let finaleMatches = [];
          let tableInfo = '';

          if (pouleSize === 3) {
            tableInfo = '(1 table)';
            finaleMatches = [
              { p1: 1, p2: 2 },
              { p1: 1, p2: 3 },
              { p1: 2, p2: 3 }
            ];
          } else if (pouleSize === 4) {
            tableInfo = '(2 tables)';
            finaleMatches = [
              { p1: 2, p2: 3 },
              { p1: 1, p2: 4 },
              { p1: 3, p2: 4 },
              { p1: 1, p2: 2 },
              { p1: 1, p2: 3 },
              { p1: 2, p2: 4 }
            ];
          } else if (pouleSize === 6) {
            tableInfo = '(3 tables)';
            // 6 players: round-robin across 3 tables in rounds
            finaleMatches = [
              // Round 1
              { p1: 1, p2: 6, table: 1 }, { p1: 2, p2: 5, table: 2 }, { p1: 3, p2: 4, table: 3 },
              // Round 2
              { p1: 2, p2: 3, table: 1 }, { p1: 4, p2: 6, table: 2 }, { p1: 1, p2: 5, table: 3 },
              // Round 3
              { p1: 1, p2: 4, table: 1 }, { p1: 3, p2: 5, table: 2 }, { p1: 2, p2: 6, table: 3 },
              // Round 4
              { p1: 5, p2: 6, table: 1 }, { p1: 1, p2: 3, table: 2 }, { p1: 2, p2: 4, table: 3 },
              // Round 5
              { p1: 4, p2: 5, table: 1 }, { p1: 1, p2: 2, table: 2 }, { p1: 3, p2: 6, table: 3 }
            ];
          }

          // Calculate height needed
          const matchScheduleHeight = 25 + (finaleMatches.length * 14);
          if (y + matchScheduleHeight > doc.page.height - 60) {
            doc.addPage();
            y = 40;
          }

          // Header - gold for finale
          doc.rect(40, y, pageWidth, 20).fill('#D4AF37');
          doc.fillColor(primaryColor).fontSize(10).font('Helvetica-Bold')
             .text(`PROGRAMME DES MATCHS ${tableInfo} - Tous contre tous`, 50, y + 5, { width: pageWidth - 20 });
          y += 22;

          // Match rows
          finaleMatches.forEach((match, idx) => {
            const bgColor = idx % 2 === 0 ? '#FFFFFF' : '#F5F5F5';
            doc.rect(40, y, pageWidth, 14).fill(bgColor);

            const p1 = poule.players[match.p1 - 1];
            const p2 = poule.players[match.p2 - 1];
            const p1Name = p1 ? `${p1.first_name || ''} ${(p1.last_name || '').toUpperCase()}`.trim() : `Joueur ${match.p1}`;
            const p2Name = p2 ? `${p2.first_name || ''} ${(p2.last_name || '').toUpperCase()}`.trim() : `Joueur ${match.p2}`;

            doc.fillColor('#666666').fontSize(8).font('Helvetica');
            const matchLabel = match.table ? `T${match.table}:` : `${idx + 1}:`;
            doc.text(matchLabel, 50, y + 3, { width: 25 });
            doc.font('Helvetica').fillColor('#333333')
               .text(`${p1Name}  vs  ${p2Name}`, 80, y + 3, { width: 400 });
            y += 14;
          });

        } else if (pouleSize === 4 || pouleSize === 5) {
          // Regular tournament: knockout-style matches
          const matches = generateMatchSchedule(pouleSize);
          if (matches.length > 0) {
            y += 8;

            // Check if we need a new page for match schedule
            const matchScheduleHeight = 20 + (matches.length * 16);
            if (y + matchScheduleHeight > doc.page.height - 60) {
              doc.addPage();
              y = 40;
            }

            // Match schedule header
            doc.rect(40, y, pageWidth, 18).fill('#E8E8E8');
            doc.fillColor('#333333').fontSize(9).font('Helvetica-Bold')
               .text('ORDRE DES MATCHS', 50, y + 4);
            y += 20;

            // Match rows
            matches.forEach((match, idx) => {
              const matchNum = idx + 1;
              const bgColor = idx % 2 === 0 ? '#FFFFFF' : '#F5F5F5';
              doc.rect(40, y, pageWidth, 15).fill(bgColor);

              doc.fillColor('#666666').fontSize(8).font('Helvetica');
              doc.text(`Match ${matchNum}:`, 50, y + 3, { width: 50 });

              if (match.dynamic) {
                // Dynamic match (depends on previous results)
                doc.font('Helvetica-Oblique').fillColor('#888888')
                   .text(match.description, 105, y + 3, { width: 400 });
              } else {
                // Fixed match - show player names
                const p1 = poule.players[match.player1 - 1];
                const p2 = poule.players[match.player2 - 1];
                if (p1 && p2) {
                  const p1Name = `${p1.first_name || ''} ${(p1.last_name || '').toUpperCase()}`.trim();
                  const p2Name = `${p2.first_name || ''} ${(p2.last_name || '').toUpperCase()}`.trim();
                  doc.font('Helvetica').fillColor('#333333')
                     .text(`${p1Name}  vs  ${p2Name}`, 105, y + 3, { width: 400 });
                }
              }
              y += 15;
            });
          }
        }

        y += 15;
      }

      // Note at the bottom (only for regular tournaments, not finales)
      if (y + 60 > doc.page.height - 40) {
        doc.addPage();
        y = 40;
      }

      if (!isFinale) {
        doc.fillColor('#666666').fontSize(9).font('Helvetica-Oblique')
           .text("Les joueurs d'un meme club jouent ensemble au 1er tour", 40, y, { width: pageWidth, align: 'center' });
        y += 25;
      }

      // Footer
      doc.fillColor('#999999').fontSize(9).font('Helvetica-Oblique')
         .text(`${orgName} - ${new Date().toLocaleDateString('fr-FR')}`,
                40, y, { width: pageWidth, align: 'center' });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

// Generate NEUTRAL/SUMMARY PDF (no personalization) - for printing/sharing
async function generateSummaryConvocationPDF(tournamentInfo, allPoules, locations, gameParams, selectedDistance, rankingData = {}, brandingSettings = {}) {
  // Fetch logo before entering Promise to avoid async issues
  let logoBuffer = null;
  try {
    logoBuffer = await getOrganizationLogoBuffer();
  } catch (err) {
    console.log('Logo not found for PDF:', err.message);
  }

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

      // Colors and branding (from settings or defaults)
      const primaryColor = brandingSettings.primary_color || '#1F4788';
      const secondaryColor = brandingSettings.secondary_color || '#667EEA';
      const accentColor = brandingSettings.accent_color || '#FFC107';
      const orgName = brandingSettings.organization_name || 'Comite Departemental Billard';
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
      const headerTextColor = isFinale ? primaryColor : 'white';
      doc.rect(40, y, pageWidth, 45).fill(headerColor);

      // Add organization logo on left side of header (logoBuffer fetched before Promise)
      if (logoBuffer) {
        try {
          doc.image(logoBuffer, 48, y + 5, { width: 35 });
        } catch (err) {
          console.log('Error adding logo to PDF:', err.message);
        }
      }

      // Title text - offset to avoid logo overlap, slightly smaller font
      doc.fillColor(headerTextColor).fontSize(20).font('Helvetica-Bold')
         .text(`CONVOCATION ${tournamentLabel}`, 90, y + 14, { width: pageWidth - 60, align: 'center' });
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
           .text(`La moyenne qualificative pour cette catégorie est entre ${parseFloat(gameParams.moyenne_mini).toFixed(3)} et ${parseFloat(gameParams.moyenne_maxi).toFixed(3)}`, 40, y, { width: pageWidth, align: 'center' });
        y += 12;

        // Line 3: Explanation of Moyenne and Classement columns
        doc.fillColor('#666666').fontSize(8).font('Helvetica-Oblique')
           .text(`Les colonnes Moyenne et Classement en face du nom de chaque joueur correspondent aux positions cumulées à la suite du dernier tournoi joué`, 40, y, { width: pageWidth, align: 'center' });
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

        // Add match schedule for poules
        const pouleSize = poule.players.length;

        // For finales: round-robin format (tous contre tous)
        if (isFinale && (pouleSize === 3 || pouleSize === 4 || pouleSize === 6)) {
          y += 8;

          // Define finale matches based on player count
          let finaleMatches = [];
          let tableInfo = '';

          if (pouleSize === 3) {
            tableInfo = '(1 table)';
            finaleMatches = [
              { p1: 1, p2: 2 },
              { p1: 1, p2: 3 },
              { p1: 2, p2: 3 }
            ];
          } else if (pouleSize === 4) {
            tableInfo = '(2 tables)';
            finaleMatches = [
              { p1: 2, p2: 3 },
              { p1: 1, p2: 4 },
              { p1: 3, p2: 4 },
              { p1: 1, p2: 2 },
              { p1: 1, p2: 3 },
              { p1: 2, p2: 4 }
            ];
          } else if (pouleSize === 6) {
            tableInfo = '(3 tables)';
            // 6 players: round-robin across 3 tables in rounds
            finaleMatches = [
              // Round 1
              { p1: 1, p2: 6, table: 1 }, { p1: 2, p2: 5, table: 2 }, { p1: 3, p2: 4, table: 3 },
              // Round 2
              { p1: 2, p2: 3, table: 1 }, { p1: 4, p2: 6, table: 2 }, { p1: 1, p2: 5, table: 3 },
              // Round 3
              { p1: 1, p2: 4, table: 1 }, { p1: 3, p2: 5, table: 2 }, { p1: 2, p2: 6, table: 3 },
              // Round 4
              { p1: 5, p2: 6, table: 1 }, { p1: 1, p2: 3, table: 2 }, { p1: 2, p2: 4, table: 3 },
              // Round 5
              { p1: 4, p2: 5, table: 1 }, { p1: 1, p2: 2, table: 2 }, { p1: 3, p2: 6, table: 3 }
            ];
          }

          // Calculate height needed
          const matchScheduleHeight = 25 + (finaleMatches.length * 14);
          if (y + matchScheduleHeight > doc.page.height - 60) {
            doc.addPage();
            y = 40;
          }

          // Header - gold for finale
          doc.rect(40, y, pageWidth, 20).fill('#D4AF37');
          doc.fillColor(primaryColor).fontSize(10).font('Helvetica-Bold')
             .text(`PROGRAMME DES MATCHS ${tableInfo} - Tous contre tous`, 50, y + 5, { width: pageWidth - 20 });
          y += 22;

          // Match rows
          finaleMatches.forEach((match, idx) => {
            const bgColor = idx % 2 === 0 ? '#FFFFFF' : '#F5F5F5';
            doc.rect(40, y, pageWidth, 14).fill(bgColor);

            const p1 = poule.players[match.p1 - 1];
            const p2 = poule.players[match.p2 - 1];
            const p1Name = p1 ? `${p1.first_name || ''} ${(p1.last_name || '').toUpperCase()}`.trim() : `Joueur ${match.p1}`;
            const p2Name = p2 ? `${p2.first_name || ''} ${(p2.last_name || '').toUpperCase()}`.trim() : `Joueur ${match.p2}`;

            doc.fillColor('#666666').fontSize(8).font('Helvetica');
            const matchLabel = match.table ? `T${match.table}:` : `${idx + 1}:`;
            doc.text(matchLabel, 50, y + 3, { width: 25 });
            doc.font('Helvetica').fillColor('#333333')
               .text(`${p1Name}  vs  ${p2Name}`, 80, y + 3, { width: 400 });
            y += 14;
          });

        } else if (pouleSize === 4 || pouleSize === 5) {
          // Regular tournament: knockout-style matches
          const matches = generateMatchSchedule(pouleSize);
          if (matches.length > 0) {
            y += 8;

            // Check if we need a new page for match schedule
            const matchScheduleHeight = 20 + (matches.length * 16);
            if (y + matchScheduleHeight > doc.page.height - 60) {
              doc.addPage();
              y = 40;
            }

            // Match schedule header
            doc.rect(40, y, pageWidth, 18).fill('#E8E8E8');
            doc.fillColor('#333333').fontSize(9).font('Helvetica-Bold')
               .text('ORDRE DES MATCHS', 50, y + 4);
            y += 20;

            // Match rows
            matches.forEach((match, idx) => {
              const matchNum = idx + 1;
              const bgColor = idx % 2 === 0 ? '#FFFFFF' : '#F5F5F5';
              doc.rect(40, y, pageWidth, 15).fill(bgColor);

              doc.fillColor('#666666').fontSize(8).font('Helvetica');
              doc.text(`Match ${matchNum}:`, 50, y + 3, { width: 50 });

              if (match.dynamic) {
                // Dynamic match (depends on previous results)
                doc.font('Helvetica-Oblique').fillColor('#888888')
                   .text(match.description, 105, y + 3, { width: 400 });
              } else {
                // Fixed match - show player names
                const p1 = poule.players[match.player1 - 1];
                const p2 = poule.players[match.player2 - 1];
                if (p1 && p2) {
                  const p1Name = `${p1.first_name || ''} ${(p1.last_name || '').toUpperCase()}`.trim();
                  const p2Name = `${p2.first_name || ''} ${(p2.last_name || '').toUpperCase()}`.trim();
                  doc.font('Helvetica').fillColor('#333333')
                     .text(`${p1Name}  vs  ${p2Name}`, 105, y + 3, { width: 400 });
                }
              }
              y += 15;
            });
          }
        }

        y += 15;
      }

      // Note at the bottom (only for regular tournaments, not finales)
      if (y + 60 > doc.page.height - 40) {
        doc.addPage();
        y = 40;
      }

      if (!isFinale) {
        doc.fillColor('#666666').fontSize(9).font('Helvetica-Oblique')
           .text("Les joueurs d'un meme club jouent ensemble au 1er tour", 40, y, { width: pageWidth, align: 'center' });
        y += 25;
      }

      // Footer
      doc.fillColor('#999999').fontSize(9).font('Helvetica-Oblique')
         .text(`${orgName} - ${new Date().toLocaleDateString('fr-FR')}`,
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

Le {organization_short_name} a le plaisir de vous convier au tournoi suivant.

Veuillez trouver en attachement votre convocation detaillee avec la composition de toutes les poules du tournoi.

En cas d'empechement, merci d'informer des que possible l'equipe en charge du sportif a l'adresse ci-dessous.

Vous aurez noté un changement significatif quant au processus d'invitation et sommes a votre ecoute si vous avez des remarques ou des suggestions.

Nous vous souhaitons une excellente competition.

Cordialement,
{organization_name}`
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
{organization_name}`
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
  const { players, poules, category, season, tournament, tournamentDate, tournoiId, locations, sendToAll, specialNote, gameParams, selectedDistance, mockRankingData, isFinale, isTestMode, skipSavePoules } = req.body;

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
    // Fetch real ranking data by category ID
    rankingData = await getRankingDataForCategory(category.id, season);
    console.log(`Fetched ranking data for ${Object.keys(rankingData).length} players by category ID`);
  } else if (category.display_name) {
    // Fallback: try to find category by name and fetch ranking data
    console.log(`[Ranking] No category ID, trying to find by name: ${category.display_name}`);
    rankingData = await getRankingDataByCategoryName(category.display_name, season);
    console.log(`Fetched ranking data for ${Object.keys(rankingData).length} players by category name`);
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

  // Create campaign record for history tracking
  const db = require('../db-loader');
  const campaignSubject = `Convocation ${category.display_name} - ${tournamentLabel}`;
  const campaignBody = `Convocations pour ${category.display_name} - ${tournamentLabel} - ${dateStr}`;

  // Determine campaign type - finale_convocation enables relance functionality
  const campaignType = isFinale ? 'finale_convocation' : 'convocation';
  // Extract mode (game type) from category display name (e.g., "CADRE NATIONALE 3" -> "CADRE")
  const categoryMode = category.display_name?.split(' ')[0] || '';
  // Extract level from category (e.g., "CADRE NATIONALE 3" -> "NATIONALE 3" or use short form)
  const categoryLevel = category.short_name || category.display_name?.replace(categoryMode, '').trim() || '';
  const sentBy = req.user?.username || 'unknown';

  let campaignId = null;
  try {
    campaignId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO email_campaigns (subject, body, template_key, recipients_count, status, campaign_type, mode, category, tournament_id, sent_by, test_mode)
         VALUES ($1, $2, $3, $4, 'sending', $5, $6, $7, $8, $9, false)`,
        [campaignSubject, campaignBody, campaignType, players.length, campaignType, categoryMode, categoryLevel, tournoiId || null, sentBy],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
    console.log('Campaign record created with ID:', campaignId, 'type:', campaignType);
  } catch (campaignError) {
    console.error('Error creating campaign record:', campaignError);
    // Continue anyway - don't block email sending if campaign recording fails
  }

  // Get contact email and branding settings once for all emails
  const contactEmail = await getContactEmail();
  const emailSettings = await getEmailTemplateSettings();
  const primaryColor = emailSettings.primary_color || '#1F4788';
  const orgShortName = emailSettings.organization_short_name || 'CDBHS';

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
        rankingData,
        emailSettings // Pass branding settings for PDF colors
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
        poule: playerPoule.pouleNumber,
        organization_name: emailSettings.organization_name || 'Comité Départemental de Billard',
        organization_short_name: emailSettings.organization_short_name || 'CDB',
        organization_email: emailSettings.summary_email || contactEmail
      };

      // Generate subject and body from template
      const emailSubject = replaceTemplateVariables(emailTemplate.subject, templateVariables);
      const emailBodyText = replaceTemplateVariables(emailTemplate.body, templateVariables);
      // Convert newlines to <br> for HTML
      const emailBodyHtml = emailBodyText.replace(/\n/g, '<br>');

      // Send email using Resend (no CC - summary email sent at the end)
      const emailResult = await resend.emails.send({
        from: buildFromAddress(emailSettings, 'noreply'),
        replyTo: contactEmail,
        to: [player.email],
        subject: emailSubject,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: ${primaryColor}; color: white; padding: 20px; text-align: center;">
              <h1 style="margin: 0; font-size: 24px;">CONVOCATION</h1>
            </div>

            <div style="padding: 20px; background: #f8f9fa;">
              ${specialNoteHtml}

              <div style="margin-bottom: 20px; padding: 15px; background: white; border-radius: 4px; border-left: 4px solid ${primaryColor};">
                <p style="margin: 5px 0;"><strong>Categorie :</strong> ${category.display_name}</p>
                <p style="margin: 5px 0;"><strong>Competition :</strong> ${tournamentLabel}</p>
                <p style="margin: 5px 0;"><strong>Date :</strong> ${dateStr}</p>
                <p style="margin: 5px 0;"><strong>Heure :</strong> ${playerLocation?.startTime?.replace(':', 'H') || '14H00'}</p>
                <p style="margin: 5px 0;"><strong>Lieu :</strong> ${playerLocation?.name || 'A definir'}</p>
                ${fullAddress ? `<p style="margin: 5px 0; color: #666;">📍 ${fullAddress}</p>` : ''}
                ${playerLocation?.phone ? `<p style="margin: 5px 0; color: #666;">📞 ${playerLocation.phone}</p>` : ''}
                <p style="margin: 5px 0;"><strong>Votre poule :</strong> ${playerPoule.pouleNumber}</p>
              </div>

              ${isFinale ? generateFinaleMatchScheduleHtml(playerPoule.players.length, playerPoule.players, primaryColor) : ''}

              <div style="line-height: 1.6;">
                ${emailBodyHtml}
              </div>

              <p style="margin-top: 20px; padding: 10px; background: #fff3cd; border-left: 4px solid #ffc107; font-size: 13px;">
                📧 <strong>Contact :</strong> Pour toute question ou en cas d'empêchement, contactez-nous à
                <a href="mailto:${contactEmail}" style="color: ${primaryColor};">${contactEmail}</a>
              </p>
            </div>

            <div style="background: ${primaryColor}; color: white; padding: 10px; text-align: center; font-size: 12px;">
              <p style="margin: 0;">${orgShortName} - <a href="mailto:${contactEmail}" style="color: white;">${contactEmail}</a></p>
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
          <div style="background: ${primaryColor}; color: white; padding: 20px; text-align: center;">
            <img src="${baseUrl}/logo.png?v=${Date.now()}" alt="${orgShortName}" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
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
              <h3 style="margin-top: 0; color: ${primaryColor};">📍 Informations du Tournoi</h3>
              <p><strong>Catégorie :</strong> ${category.display_name}</p>
              <p><strong>Compétition :</strong> ${tournamentLabel}</p>
              <p><strong>Date :</strong> ${dateStr}</p>
              ${specialNote ? `<p style="color: #856404;"><strong>Note spéciale :</strong> ${specialNote}</p>` : ''}
            </div>

            <h3 style="color: ${primaryColor};">📧 Convocations Envoyées (${results.sent.length})</h3>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13px;">
              <thead>
                <tr style="background: ${primaryColor}; color: white;">
                  <th style="padding: 10px; border: 1px solid #ddd;">#</th>
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Joueur</th>
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Email</th>
                </tr>
              </thead>
              <tbody>
                ${recipientListHtml}
              </tbody>
            </table>

            <h3 style="color: #28a745;">🎯 Composition des Poules (${poules.length})</h3>
            ${poulesSummaryHtml}
          </div>
          <div style="background: ${primaryColor}; color: white; padding: 10px; text-align: center; font-size: 12px;">
            <p style="margin: 0;">${orgShortName} - ${summaryEmailAddress}</p>
          </div>
        </div>
      `;

      await resend.emails.send({
        from: buildFromAddress(emailSettings, 'noreply'),
        replyTo: contactEmail,
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

  // Update campaign record with results
  if (campaignId) {
    try {
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE email_campaigns
           SET sent_count = $1, failed_count = $2, status = 'completed', sent_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [results.sent.length, results.failed.length, campaignId],
          function(err) {
            if (err) {
              console.error('Database error updating campaign:', err);
              reject(err);
            } else {
              console.log(`Campaign ${campaignId} updated: sent=${results.sent.length}, failed=${results.failed.length}, status=completed`);
              resolve();
            }
          }
        );
      });
    } catch (updateError) {
      console.error('Error updating campaign record:', updateError);
    }
  }

  // Update convoque status and store convocation details for players who received their convocation email
  // Skip in test mode to avoid modifying real data
  if (tournoiId && results.sent.length > 0 && !isTestMode && !skipSavePoules) {
    try {
      // Get players who received emails with their convocation details
      const sentPlayers = players.filter(p => results.sent.some(s => s.email === p.email));

      for (const player of sentPlayers) {
        // Find which poule and location this player is in
        let playerPouleNumber = null;
        let playerLocation = null;

        // Normalize licence for comparison (remove spaces)
        const playerLicenceNorm = (player.licence || '').replace(/\s+/g, '');

        for (const poule of poules) {
          const found = poule.players.find(p => (p.licence || '').replace(/\s+/g, '') === playerLicenceNorm);
          if (found) {
            playerPouleNumber = poule.number;
            const locNum = poule.locationNum || '1';
            playerLocation = locations.find(l => l.locationNum === locNum) || locations[0];
            break;
          }
        }

        // Build full address
        const fullAddress = playerLocation
          ? [playerLocation.street, playerLocation.zip_code, playerLocation.city].filter(Boolean).join(' ')
          : '';

        // Update inscription with convocation details
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE inscriptions
             SET convoque = 1,
                 convocation_poule = $1,
                 convocation_lieu = $2,
                 convocation_adresse = $3,
                 convocation_heure = $4,
                 convocation_notes = $5,
                 convocation_phone = $6
             WHERE tournoi_id = $7
             AND REPLACE(licence, ' ', '') = REPLACE($8, ' ', '')`,
            [
              playerPouleNumber ? String(playerPouleNumber) : null,
              playerLocation?.name || null,
              fullAddress || null,
              playerLocation?.startTime || null,
              specialNote || null,
              playerLocation?.phone || null,
              tournoiId,
              player.licence
            ],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
      }

      console.log(`Updated convoque status and convocation details for ${sentPlayers.length} players in tournament ${tournoiId}`);

      // Skip saving poules in test mode
      if (!isTestMode && !skipSavePoules) {
        // Save full poule composition to convocation_poules table
        // First, clear any existing poule data for this tournament
        await new Promise((resolve, reject) => {
          db.run(
            `DELETE FROM convocation_poules WHERE tournoi_id = $1`,
            [tournoiId],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });

        // Insert all players from all poules
        for (const poule of poules) {
          const locNum = poule.locationNum || '1';
          const loc = locations.find(l => l.locationNum === locNum) || locations[0];
          const fullAddress = loc ? [loc.street, loc.zip_code, loc.city].filter(Boolean).join(' ') : '';

          for (let i = 0; i < poule.players.length; i++) {
            const p = poule.players[i];
            await new Promise((resolve, reject) => {
              db.run(
                `INSERT INTO convocation_poules (tournoi_id, poule_number, licence, player_name, club, location_name, location_address, start_time, player_order)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (tournoi_id, poule_number, licence) DO UPDATE SET
                   player_name = $4, club = $5, location_name = $6, location_address = $7, start_time = $8, player_order = $9`,
                [
                  tournoiId,
                  poule.number,
                  p.licence,
                  `${p.first_name} ${p.last_name}`,
                  p.club || '',
                  loc?.name || '',
                  fullAddress,
                  loc?.startTime || '',
                  i + 1
                ],
                (err) => {
                  if (err) reject(err);
                  else resolve();
                }
              );
            });
          }
        }
        console.log(`Saved ${poules.reduce((sum, p) => sum + p.players.length, 0)} players across ${poules.length} poules for tournament ${tournoiId}`);
      } else {
        console.log('Test mode - skipping poule save to database');
      }

      // Mark convocation as sent on tournoi_ext (skip in test mode)
      if (!isTestMode && !skipSavePoules) {
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE tournoi_ext SET convocation_sent_at = CURRENT_TIMESTAMP WHERE tournoi_id = $1`,
            [tournoiId],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
        console.log(`Marked convocation_sent_at for tournament ${tournoiId}`);
      }

    } catch (convoqueError) {
      console.error('Error updating convoque status:', convoqueError);
      // Don't fail the whole operation if convoque update fails
    }
  }

  // Log the convocation action
  logAdminAction({
    req,
    action: ACTION_TYPES.SEND_CONVOCATION,
    details: `Convocations ${category.display_name} - ${tournamentLabel}: ${results.sent.length} envoyés, ${results.failed.length} échecs, ${results.skipped.length} ignorés`,
    targetType: 'tournament',
    targetId: tournoiId,
    targetName: `${category.display_name} - ${tournamentLabel}`
  });

  res.json({
    success: true,
    message: `Emails envoyes: ${results.sent.length}, Echecs: ${results.failed.length}, Ignores: ${results.skipped.length}${results.sent.length > 0 ? ' + récapitulatif envoyé' : ''}`,
    results
  });
});

// Save poule composition without sending emails (for testing or backfilling)
router.post('/save-poules', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { tournoiId, poules, locations } = req.body;

  if (!tournoiId || !poules || !Array.isArray(poules)) {
    return res.status(400).json({ error: 'tournoiId and poules array required' });
  }

  try {
    // Clear existing poule data for this tournament
    await new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM convocation_poules WHERE tournoi_id = $1`,
        [tournoiId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Insert all players from all poules
    let totalPlayers = 0;
    for (const poule of poules) {
      const locNum = poule.locationNum || '1';
      const loc = locations ? locations.find(l => l.locationNum === locNum) || locations[0] : null;
      const fullAddress = loc ? [loc.street, loc.zip_code, loc.city].filter(Boolean).join(' ') : '';

      for (let i = 0; i < poule.players.length; i++) {
        const p = poule.players[i];
        // Handle different name formats: first_name/last_name, name, or player_name
        let playerName = p.name || p.player_name || '';
        if (p.first_name && p.last_name) {
          playerName = `${p.first_name} ${p.last_name}`;
        } else if (p.last_name && !p.first_name) {
          playerName = p.last_name;
        }
        await new Promise((resolve, reject) => {
          db.run(
            `INSERT INTO convocation_poules (tournoi_id, poule_number, licence, player_name, club, location_name, location_address, start_time, player_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (tournoi_id, poule_number, licence) DO UPDATE SET
               player_name = $4, club = $5, location_name = $6, location_address = $7, start_time = $8, player_order = $9`,
            [
              tournoiId,
              poule.number,
              p.licence,
              playerName,
              p.club || '',
              loc?.name || '',
              fullAddress,
              loc?.startTime || '',
              i + 1
            ],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
        totalPlayers++;
      }
    }

    console.log(`[Save Poules] Saved ${totalPlayers} players across ${poules.length} poules for tournament ${tournoiId}`);

    res.json({
      success: true,
      message: `${totalPlayers} joueurs sauvegardés dans ${poules.length} poule(s)`,
      totalPlayers,
      totalPoules: poules.length
    });

  } catch (error) {
    console.error('Error saving poules:', error);
    res.status(500).json({ error: 'Failed to save poules' });
  }
});

// Send club reminder email when hosting a tournament
router.post('/send-club-reminder', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const {
    clubName,        // Name of the club hosting
    clubEmail,       // Email of the club (if already known)
    category,        // Category display name
    tournament,      // Tournament number (1, 2, 3, Finale)
    tournamentDate,  // Date of tournament
    tournoiId,       // Tournament ID for duplicate tracking
    startTime,       // Start time
    numPlayers,      // Number of participants
    numTables,       // Number of tables needed
    ccEmail          // CC to organization
  } = req.body;

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({ error: 'Email non configuré' });
  }

  try {
    // Get email settings for organization branding
    const emailSettings = await getEmailTemplateSettings();
    const orgShortName = emailSettings.organization_short_name || 'CDB';
    const orgName = emailSettings.organization_name || orgShortName;
    const primaryColor = emailSettings.primary_color || '#1F4788';
    const baseUrl = process.env.BASE_URL || 'https://cdbhs-tournament-management-production.up.railway.app';

    // Check if we already sent a reminder for this tournament + club combination
    if (tournoiId && clubName) {
      const existingReminder = await new Promise((resolve, reject) => {
        db.get(
          `SELECT id FROM email_campaigns
           WHERE campaign_type = 'club_reminder'
           AND tournament_id = $1
           AND body LIKE $2
           AND status = 'completed'`,
          [tournoiId, `%${clubName}%`],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (existingReminder) {
        console.log(`[Club Reminder] Already sent to ${clubName} for tournament ${tournoiId}, skipping`);
        return res.json({
          success: false,
          skipped: true,
          alreadySent: true,
          message: `Rappel déjà envoyé au club ${clubName} pour ce tournoi`
        });
      }
    }

    // Find club email if not provided
    let emailToSend = clubEmail;
    if (!emailToSend && clubName) {
      const clubResult = await new Promise((resolve, reject) => {
        db.get(
          `SELECT email FROM club_aliases
           WHERE (UPPER(canonical_name) = UPPER($1) OR UPPER(alias) = UPPER($1))
           AND email IS NOT NULL AND email != ''
           LIMIT 1`,
          [clubName],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });
      if (clubResult) {
        emailToSend = clubResult.email;
      }
    }

    if (!emailToSend) {
      return res.json({
        success: false,
        skipped: true,
        message: `Pas d'email configuré pour le club ${clubName}`
      });
    }

    // Format date
    const dateStr = tournamentDate
      ? new Date(tournamentDate).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : 'Date à confirmer';

    // Build tournament label
    const tournamentLabel = tournament === 'Finale' || tournament === '4'
      ? 'Finale Départementale'
      : `Tournoi ${tournament}`;

    // Fetch template from database
    const template = await new Promise((resolve, reject) => {
      db.get(
        `SELECT subject_template, body_template FROM email_templates WHERE template_key = 'club_reminder'`,
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    // Default template if not found in DB
    const defaultSubject = 'Rappel Organisation - {category} {tournament}';
    const defaultBody = `Bonjour,

Votre club {club_name} accueille prochainement une compétition du {organization_short_name}.

DÉTAILS DE LA COMPÉTITION:
- Compétition: {category} - {tournament}
- Date: {date}
- Horaire: {time}
- Participants: {num_players} joueur(s)
- Tables nécessaires: {num_tables} table(s)

RAPPELS IMPORTANTS:
- Maître de jeu: Merci de prévoir la présence d'un maître de jeu pour encadrer la compétition
- Arbitrage: Si vous avez des arbitres disponibles, merci de nous le signaler. Sinon, l'autoarbitrage sera mis en place
- Résultats FFB: Les résultats devront être saisis sur le site de la FFB à l'issue de la compétition
- Rafraîchissements: Merci de prévoir des rafraîchissements pour les joueurs

Pour toute question, contactez-nous à l'adresse : {organization_email}

Sportivement,
Le {organization_short_name}`;

    // Get subject and body from template or defaults
    let subjectTemplate = template?.subject_template || defaultSubject;
    let bodyTemplate = template?.body_template || defaultBody;

    // Apply variable substitution
    const variables = {
      '{club_name}': clubName,
      '{category}': category,
      '{tournament}': tournamentLabel,
      '{date}': dateStr,
      '{time}': startTime || '14H00',
      '{num_players}': numPlayers,
      '{num_tables}': numTables,
      '{organization_name}': orgName,
      '{organization_short_name}': orgShortName,
      '{organization_email}': emailSettings.summary_email || ccEmail || 'contact@' + (emailSettings.email_noreply?.split('@')[1] || 'cdbhs.net')
    };

    let subject = subjectTemplate;
    let bodyText = bodyTemplate;
    for (const [key, value] of Object.entries(variables)) {
      subject = subject.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), value);
      bodyText = bodyText.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), value);
    }

    // Convert plain text template to HTML email
    const bodyHtml = bodyText
      .split('\n\n')
      .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
      .join('');

    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: ${primaryColor}; color: white; padding: 20px; text-align: center;">
          <img src="${baseUrl}/logo.png?v=${Date.now()}" alt="" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
          <h1 style="margin: 0; font-size: 24px;">${orgShortName}</h1>
        </div>
        <div style="padding: 20px; background: #f8f9fa; line-height: 1.6;">
          ${bodyHtml}
        </div>
        <div style="background: ${primaryColor}; color: white; padding: 15px; text-align: center; font-size: 12px;">
          ${orgName}
        </div>
      </div>
    `;

    // Send the email
    const recipients = [emailToSend];
    if (ccEmail) {
      recipients.push(ccEmail);
    }

    await resend.emails.send({
      from: buildFromAddress(emailSettings, 'convocations'),
      to: recipients,
      subject: subject,
      html: emailBody
    });

    // Log to email_campaigns (include tournament_id for duplicate tracking)
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO email_campaigns (subject, body, template_key, recipients_count, sent_count, failed_count, status, sent_at, campaign_type, mode, category, tournament_id, sent_by)
         VALUES ($1, $2, 'club_reminder', 1, 1, 0, 'completed', CURRENT_TIMESTAMP, 'club_reminder', $3, $4, $5, $6)`,
        [subject, `Rappel envoyé à ${clubName} (${emailToSend})`, category.split(' ')[0], category, tournoiId || null, req.user?.username || 'system'],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    console.log(`[Club Reminder] Sent to ${clubName} (${emailToSend}) for ${category} ${tournamentLabel}`);

    res.json({
      success: true,
      message: `Rappel envoyé au club ${clubName}`,
      email: emailToSend
    });

  } catch (error) {
    console.error('Error sending club reminder:', error);
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

    // Get branding settings
    const brandingSettings = await appSettings.getSettingsBatch([
      'primary_color', 'secondary_color', 'accent_color'
    ]);

    // Generate PDF
    const pdfBuffer = await generateSummaryConvocationPDF(
      tournamentInfo,
      poules,
      locations || [],
      gameParams,
      selectedDistance,
      rankingData,
      brandingSettings
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

// ============ INSCRIPTION EMAIL LOGS ============

// Get inscription/desinscription email logs (for admin view)
router.get('/inscription-logs', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { type, status, from, to, player } = req.query;

  let query = 'SELECT * FROM inscription_email_logs WHERE 1=1';
  const params = [];
  let paramIndex = 1;

  if (type) {
    query += ` AND email_type = $${paramIndex++}`;
    params.push(type);
  }
  if (status) {
    query += ` AND status = $${paramIndex++}`;
    params.push(status);
  }
  if (from) {
    query += ` AND created_at >= $${paramIndex++}`;
    params.push(from);
  }
  if (to) {
    query += ` AND created_at <= $${paramIndex++}`;
    params.push(to + ' 23:59:59');
  }
  if (player) {
    query += ` AND (LOWER(player_name) LIKE LOWER($${paramIndex++}) OR LOWER(player_email) LIKE LOWER($${paramIndex++}))`;
    params.push(`%${player}%`, `%${player}%`);
  }

  query += ' ORDER BY created_at DESC LIMIT 200';

  try {
    const logs = await new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    res.json(logs);
  } catch (error) {
    console.error('Error fetching inscription email logs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete inscription email log (admin only)
router.delete('/inscription-logs/:id', authenticateToken, async (req, res) => {
  // Check if user is admin
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const db = require('../db-loader');
  const { id } = req.params;

  try {
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM inscription_email_logs WHERE id = $1', [id], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting inscription email log:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ INSCRIPTION CONFIRMATION EMAILS (for Player App) ============

// Helper function to look up club phone by location name (accent-insensitive)
async function getClubPhoneByLocation(locationName) {
  if (!locationName) return null;

  const db = require('../db-loader');

  return new Promise((resolve) => {
    // Normalize: lowercase, remove accents
    const normalizedLocation = locationName.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    db.all('SELECT name, city, phone FROM clubs WHERE phone IS NOT NULL AND phone != \'\'', [], (err, clubs) => {
      if (err || !clubs) {
        resolve(null);
        return;
      }

      for (const club of clubs) {
        const normalizedName = (club.name || '').toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const normalizedCity = (club.city || '').toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

        // Check if location matches club name or city
        if (normalizedName.includes(normalizedLocation) ||
            normalizedLocation.includes(normalizedName) ||
            normalizedCity === normalizedLocation ||
            normalizedCity.includes(normalizedLocation) ||
            normalizedLocation.includes(normalizedCity)) {
          resolve(club.phone);
          return;
        }
      }

      resolve(null);
    });
  });
}

// Default templates for inscription confirmations
const DEFAULT_INSCRIPTION_CONFIRMATION_TEMPLATE = {
  subject: 'Confirmation d\'inscription - {tournament_name}',
  body: `Bonjour {player_name},

Votre inscription a bien été enregistrée pour la compétition suivante :

📅 Compétition : {tournament_name}
🎯 Mode : {mode} - {category}
📆 Date : {tournament_date}
📍 Lieu : {location}

Vous recevrez une convocation avec les détails (horaires, poules) quelques jours avant la compétition.

En cas d'empêchement, merci de vous désinscrire via l'application ou de nous prévenir par email.

Sportivement,
{organization_name}`
};

const DEFAULT_INSCRIPTION_CANCELLATION_TEMPLATE = {
  subject: 'Confirmation de désinscription - {mode} {category}',
  body: `Bonjour {player_name},

Nous avons bien pris en compte votre désinscription du tournoi suivant :

Tournoi : {tournament_name}
Mode : {mode}
Catégorie : {category}
Date : {tournament_date}
Lieu : {location}

Si cette désinscription est une erreur, veuillez contacter le comité via "Contact" ou par email à {organization_email}.

Sportivement,
{organization_name}`
};

// Send inscription confirmation email (called by Player App)
router.post('/inscription-confirmation', async (req, res) => {
  const { player_email, player_name, tournament_name, mode, category, tournament_date, location, api_key } = req.body;

  // Verify API key (shared secret between apps)
  if (api_key !== process.env.PLAYER_APP_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({ error: 'Email not configured' });
  }

  if (!player_email || !player_name || !tournament_name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Load email settings for dynamic branding
    const emailSettings = await getEmailTemplateSettings();
    const contactEmail = await getContactEmail();
    const template = DEFAULT_INSCRIPTION_CONFIRMATION_TEMPLATE;

    // Look up club phone from location name
    const locationPhone = await getClubPhoneByLocation(location);

    // Replace template variables
    const dateStr = tournament_date
      ? new Date(tournament_date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : 'Date à définir';

    const variables = {
      player_name,
      tournament_name,
      mode: mode || '',
      category: category || '',
      tournament_date: dateStr,
      location: location || 'Lieu à définir',
      organization_name: emailSettings.organization_name || 'Comité Départemental de Billard',
      organization_short_name: emailSettings.organization_short_name || 'CDB',
      organization_email: emailSettings.summary_email || contactEmail
    };

    const subject = replaceTemplateVariables(template.subject, variables);
    const bodyText = replaceTemplateVariables(template.body, variables);
    const bodyHtml = bodyText.replace(/\n/g, '<br>').replace(/🎯/g, FRENCH_BILLARD_ICON_IMG);

    await resend.emails.send({
      from: buildFromAddress(emailSettings, 'noreply'),
      replyTo: contactEmail,
      to: [player_email],
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #28a745; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">Inscription Confirmée</h1>
          </div>
          <div style="padding: 20px; background: #f8f9fa;">
            <div style="margin-bottom: 20px; padding: 15px; background: white; border-radius: 4px; border-left: 4px solid #28a745;">
              <p style="margin: 5px 0;"><strong>Tournoi :</strong> ${tournament_name}</p>
              <p style="margin: 5px 0;"><strong>Mode :</strong> ${mode || '-'}</p>
              <p style="margin: 5px 0;"><strong>Catégorie :</strong> ${category || '-'}</p>
              <p style="margin: 5px 0;"><strong>Date :</strong> ${dateStr}</p>
              <p style="margin: 5px 0;"><strong>Lieu :</strong> ${location || 'À définir'}</p>
              ${locationPhone ? `<p style="margin: 5px 0; color: #666;">📞 ${locationPhone}</p>` : ''}
            </div>
            <div style="line-height: 1.6;">
              ${bodyHtml}
            </div>
          </div>
          ${buildEmailFooter(emailSettings)}
        </div>
      `
    });

    // Log email to database
    const db = require('../db-loader');
    db.run(
      `INSERT INTO inscription_email_logs (email_type, player_email, player_name, tournament_name, mode, category, tournament_date, location, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sent')`,
      ['inscription', player_email, player_name, tournament_name, mode || '', category || '', dateStr, location || ''],
      (err) => { if (err) console.error('Error logging inscription email:', err); }
    );

    console.log(`Inscription confirmation email sent to ${player_email} for ${tournament_name}`);
    res.json({ success: true, message: 'Confirmation email sent' });

  } catch (error) {
    console.error('Error sending inscription confirmation:', error);
    // Log failed email
    const db = require('../db-loader');
    const dateStr = tournament_date
      ? new Date(tournament_date).toLocaleDateString('fr-FR')
      : '';
    db.run(
      `INSERT INTO inscription_email_logs (email_type, player_email, player_name, tournament_name, mode, category, tournament_date, location, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'failed', $9)`,
      ['inscription', player_email, player_name, tournament_name, mode || '', category || '', dateStr, location || '', error.message],
      () => {}
    );
    res.status(500).json({ error: error.message });
  }
});

// Send inscription cancellation email (called by Player App)
router.post('/inscription-cancellation', async (req, res) => {
  const { player_email, player_name, tournament_name, mode, category, tournament_date, location, api_key } = req.body;

  // Verify API key (shared secret between apps)
  if (api_key !== process.env.PLAYER_APP_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({ error: 'Email not configured' });
  }

  if (!player_email || !player_name || !tournament_name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Load email settings for dynamic branding
    const emailSettings = await getEmailTemplateSettings();
    const contactEmail = await getContactEmail();
    const template = DEFAULT_INSCRIPTION_CANCELLATION_TEMPLATE;

    // Look up club phone from location name
    const locationPhone = await getClubPhoneByLocation(location);

    // Replace template variables
    const dateStr = tournament_date
      ? new Date(tournament_date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : 'Date à définir';

    const variables = {
      player_name,
      tournament_name,
      mode: mode || '',
      category: category || '',
      tournament_date: dateStr,
      location: location || 'Non défini',
      organization_name: emailSettings.organization_name || 'Comité Départemental de Billard',
      organization_short_name: emailSettings.organization_short_name || 'CDB',
      organization_email: emailSettings.summary_email || contactEmail
    };

    const subject = replaceTemplateVariables(template.subject, variables);
    const bodyText = replaceTemplateVariables(template.body, variables);
    const bodyHtml = bodyText.replace(/\n/g, '<br>').replace(/🎯/g, FRENCH_BILLARD_ICON_IMG);

    await resend.emails.send({
      from: buildFromAddress(emailSettings, 'noreply'),
      replyTo: contactEmail,
      to: [player_email],
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #dc3545; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">Désinscription Confirmée</h1>
          </div>
          <div style="padding: 20px; background: #f8f9fa;">
            <div style="margin-bottom: 20px; padding: 15px; background: white; border-radius: 4px; border-left: 4px solid #dc3545;">
              <p style="margin: 5px 0;">📅 <strong>Tournoi :</strong> ${tournament_name}</p>
              <p style="margin: 5px 0;">${FRENCH_BILLARD_ICON_IMG} <strong>Mode :</strong> ${mode || '-'}</p>
              <p style="margin: 5px 0;">🏆 <strong>Catégorie :</strong> ${category || '-'}</p>
              <p style="margin: 5px 0;">📆 <strong>Date :</strong> ${dateStr}</p>
              <p style="margin: 5px 0;">📍 <strong>Lieu :</strong> ${location || 'Non défini'}</p>
              ${locationPhone ? `<p style="margin: 5px 0; color: #666;">📞 ${locationPhone}</p>` : ''}
            </div>
            <div style="line-height: 1.6;">
              ${bodyHtml}
            </div>
          </div>
          ${buildEmailFooter(emailSettings)}
        </div>
      `
    });

    // Log email to database
    const db = require('../db-loader');
    db.run(
      `INSERT INTO inscription_email_logs (email_type, player_email, player_name, tournament_name, mode, category, tournament_date, location, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sent')`,
      ['desinscription', player_email, player_name, tournament_name, mode || '', category || '', dateStr, location || ''],
      (err) => { if (err) console.error('Error logging desinscription email:', err); }
    );

    console.log(`Inscription cancellation email sent to ${player_email} for ${tournament_name}`);
    res.json({ success: true, message: 'Cancellation email sent' });

  } catch (error) {
    console.error('Error sending inscription cancellation:', error);
    // Log failed email
    const db = require('../db-loader');
    const dateStr = tournament_date
      ? new Date(tournament_date).toLocaleDateString('fr-FR')
      : '';
    db.run(
      `INSERT INTO inscription_email_logs (email_type, player_email, player_name, tournament_name, mode, category, tournament_date, location, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'failed', $9)`,
      ['desinscription', player_email, player_name, tournament_name, mode || '', category || '', dateStr, location || '', error.message],
      () => {}
    );
    res.status(500).json({ error: error.message });
  }
});

// Send contact message from Player App (called by Player App)
router.post('/contact', async (req, res) => {
  const { player_email, player_name, player_licence, player_club, subject, message, api_key, attachments } = req.body;

  // Verify API key (shared secret between apps)
  if (api_key !== process.env.PLAYER_APP_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({ error: 'Email not configured' });
  }

  if (!player_email || !player_name || !subject || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Load email settings for dynamic branding
    const emailSettings = await getEmailTemplateSettings();
    const primaryColor = emailSettings.primary_color || '#1F4788';
    const shortName = emailSettings.organization_short_name || 'CDBHS';
    const contactEmail = await getContactEmail();

    // Prepare email attachments
    const emailAttachments = (attachments || []).map(att => ({
      filename: att.filename,
      content: Buffer.from(att.content, 'base64')
    }));

    const attachmentInfo = emailAttachments.length > 0
      ? `<div style="margin-top: 15px; padding: 10px; background: #e3f2fd; border-radius: 4px;">
           <p style="margin: 0; color: #1565c0;"><strong>📎 ${emailAttachments.length} pièce(s) jointe(s)</strong></p>
         </div>`
      : '';

    // Send email to organization
    await resend.emails.send({
      from: `${shortName} Espace Joueur <${emailSettings.email_noreply || 'noreply@cdbhs.net'}>`,
      replyTo: player_email,
      to: [contactEmail],
      subject: `[Espace Joueur] ${subject}`,
      attachments: emailAttachments,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: ${primaryColor}; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">Message depuis l'Espace Joueur</h1>
          </div>
          <div style="padding: 20px; background: #f8f9fa;">
            <div style="margin-bottom: 20px; padding: 15px; background: white; border-radius: 4px; border-left: 4px solid ${primaryColor};">
              <p style="margin: 5px 0;"><strong>De :</strong> ${player_name}</p>
              <p style="margin: 5px 0;"><strong>Email :</strong> <a href="mailto:${player_email}">${player_email}</a></p>
              <p style="margin: 5px 0;"><strong>Licence :</strong> ${player_licence}</p>
              <p style="margin: 5px 0;"><strong>Club :</strong> ${player_club}</p>
              <p style="margin: 5px 0;"><strong>Sujet :</strong> ${subject}</p>
            </div>
            <div style="background: white; padding: 15px; border-radius: 4px;">
              <h3 style="margin-top: 0;">Message :</h3>
              <p style="white-space: pre-wrap;">${message}</p>
              ${attachmentInfo}
            </div>
          </div>
          ${buildEmailFooter(emailSettings)}
        </div>
      `
    });

    // Send confirmation email to player
    await resend.emails.send({
      from: buildFromAddress(emailSettings, 'noreply'),
      replyTo: contactEmail,
      to: [player_email],
      subject: `Confirmation - Votre message a bien été envoyé`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #28a745; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">Message Envoyé ✓</h1>
          </div>
          <div style="padding: 20px; background: #f8f9fa;">
            <p style="margin-bottom: 20px;">Bonjour ${player_name},</p>
            <p style="margin-bottom: 20px;">Votre message a bien été transmis au ${shortName}. Nous vous répondrons dans les meilleurs délais.</p>
            <div style="margin-bottom: 20px; padding: 15px; background: white; border-radius: 4px; border-left: 4px solid #28a745;">
              <p style="margin: 5px 0;"><strong>Sujet :</strong> ${subject}</p>
              <p style="margin: 10px 0 5px 0;"><strong>Votre message :</strong></p>
              <p style="white-space: pre-wrap; color: #666; margin: 0;">${message}</p>
            </div>
            <p style="color: #666; font-size: 0.9rem;">Si vous avez besoin d'une réponse urgente, vous pouvez nous contacter directement à <a href="mailto:${contactEmail}">${contactEmail}</a></p>
          </div>
          ${buildEmailFooter(emailSettings)}
        </div>
      `
    });

    console.log(`Contact email sent from ${player_email}: ${subject} (+ confirmation to player)`);
    res.json({ success: true, message: 'Contact email sent' });

  } catch (error) {
    console.error('Error sending contact email:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ FORFAIT MANAGEMENT ============

/**
 * GET /api/email/poules/upcoming
 * Get tournaments with saved poules in the next 7 days
 */
router.get('/poules/upcoming', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  try {
    // Get tournaments with saved poules in the next 7 days
    const tournaments = await new Promise((resolve, reject) => {
      db.all(`
        SELECT DISTINCT
          cp.tournoi_id,
          t.nom as tournament_name,
          t.mode,
          t.categorie,
          t.debut as tournament_date,
          t.lieu,
          COUNT(DISTINCT cp.licence) as player_count,
          COUNT(DISTINCT cp.poule_number) as poule_count
        FROM convocation_poules cp
        JOIN tournoi_ext t ON cp.tournoi_id = t.tournoi_id
        WHERE t.debut >= CURRENT_DATE
          AND t.debut <= CURRENT_DATE + INTERVAL '7 days'
        GROUP BY cp.tournoi_id, t.nom, t.mode, t.categorie, t.debut, t.lieu
        ORDER BY t.debut ASC
      `, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    res.json(tournaments);
  } catch (error) {
    console.error('Error fetching upcoming tournaments with poules:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/email/poules/categories
 * Get categories that have tournaments with sent convocations (not yet played)
 */
router.get('/poules/categories', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  try {
    const categories = await new Promise((resolve, reject) => {
      db.all(`
        SELECT DISTINCT t.mode, t.categorie
        FROM convocation_poules cp
        JOIN tournoi_ext t ON cp.tournoi_id = t.tournoi_id
        WHERE t.debut >= CURRENT_DATE - INTERVAL '1 day'
          AND t.convocation_sent_at IS NOT NULL
        ORDER BY t.mode, t.categorie
      `, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    res.json(categories);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/email/poules/by-category
 * Get tournaments with sent convocations by category
 */
router.get('/poules/by-category', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { mode, categorie } = req.query;

  try {
    let sql = `
      SELECT DISTINCT
        cp.tournoi_id,
        t.nom as tournament_name,
        t.mode,
        t.categorie,
        t.debut as tournament_date,
        t.lieu,
        t.convocation_sent_at,
        COUNT(DISTINCT cp.licence) as player_count
      FROM convocation_poules cp
      JOIN tournoi_ext t ON cp.tournoi_id = t.tournoi_id
      WHERE t.debut >= CURRENT_DATE - INTERVAL '1 day'
        AND t.convocation_sent_at IS NOT NULL
    `;
    const params = [];

    if (mode) {
      params.push(mode);
      sql += ` AND UPPER(t.mode) = UPPER($${params.length})`;
    }
    if (categorie) {
      params.push(categorie);
      sql += ` AND UPPER(t.categorie) = UPPER($${params.length})`;
    }

    sql += ` GROUP BY cp.tournoi_id, t.nom, t.mode, t.categorie, t.debut, t.lieu, t.convocation_sent_at ORDER BY t.debut ASC`;

    const tournaments = await new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    res.json(tournaments);
  } catch (error) {
    console.error('Error fetching tournaments by category:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/email/fix-corrupted-names
 * One-time fix for corrupted player names (undefined undefined)
 */
router.post('/fix-corrupted-names', authenticateToken, async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const db = require('../db-loader');

  try {
    // Fix corrupted names by joining with players table
    const result = await new Promise((resolve, reject) => {
      db.run(`
        UPDATE convocation_poules
        SET player_name = (
          SELECT CONCAT(p.last_name, ' ', p.first_name)
          FROM players p
          WHERE REPLACE(p.licence, ' ', '') = REPLACE(convocation_poules.licence, ' ', '')
        )
        WHERE player_name = 'undefined undefined'
          OR player_name IS NULL
          OR player_name = ''
          OR player_name LIKE '%undefined%'
      `, [], function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      });
    });

    console.log(`[Fix Names] Updated ${result.changes} corrupted player names`);
    res.json({ success: true, updated: result.changes });
  } catch (error) {
    console.error('Error fixing names:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/email/poules/:tournoiId
 * Get saved poules for a tournament
 * NOTE: This wildcard route must come AFTER specific routes like /upcoming, /categories, /by-category
 */
router.get('/poules/:tournoiId', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { tournoiId } = req.params;

  try {
    // Get tournament info
    const tournament = await new Promise((resolve, reject) => {
      db.get(`
        SELECT tournoi_id, nom, mode, categorie, debut, lieu
        FROM tournoi_ext
        WHERE tournoi_id = $1
      `, [tournoiId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    // Get saved poules
    const poules = await new Promise((resolve, reject) => {
      db.all(`
        SELECT
          poule_number,
          licence,
          player_name,
          club,
          location_name,
          location_address,
          start_time,
          player_order
        FROM convocation_poules
        WHERE tournoi_id = $1
        ORDER BY poule_number, player_order
      `, [tournoiId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Get forfait status from inscriptions
    const forfaits = await new Promise((resolve, reject) => {
      db.all(`
        SELECT licence, forfait
        FROM inscriptions
        WHERE tournoi_id = $1 AND forfait = 1
      `, [tournoiId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    const forfaitLicences = new Set(forfaits.map(f => f.licence?.replace(/\s/g, '')));

    // Group by poule number and add forfait status
    const poulesGrouped = {};
    poules.forEach(p => {
      if (!poulesGrouped[p.poule_number]) {
        poulesGrouped[p.poule_number] = {
          number: p.poule_number,
          location_name: p.location_name,
          location_address: p.location_address,
          start_time: p.start_time,
          players: []
        };
      }
      poulesGrouped[p.poule_number].players.push({
        ...p,
        isForfait: forfaitLicences.has(p.licence?.replace(/\s/g, ''))
      });
    });

    res.json({
      tournament,
      poules: Object.values(poulesGrouped)
    });
  } catch (error) {
    console.error('Error fetching poules:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/email/poules/:tournoiId/regenerate
 * Regenerate poules after marking forfaits
 */
router.post('/poules/:tournoiId/regenerate', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { tournoiId } = req.params;
  const { forfaitLicences, replacementPlayer, locations, previewOnly } = req.body;

  try {
    // Get tournament info
    const tournament = await new Promise((resolve, reject) => {
      db.get(`
        SELECT tournoi_id, nom, mode, categorie, debut, lieu
        FROM tournoi_ext
        WHERE tournoi_id = $1
      `, [tournoiId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    // Get the category_id from mode and categorie
    // Normalize mode: '3 BANDES' -> '3BANDES', 'LIBRE' -> 'LIBRE', etc.
    const normalizedMode = (tournament.mode || '').replace(/\s+/g, '').toUpperCase();
    const normalizedCategorie = (tournament.categorie || '').toUpperCase();
    console.log('Looking for category:', { mode: tournament.mode, normalizedMode, categorie: normalizedCategorie });

    const category = await new Promise((resolve, reject) => {
      db.get(`
        SELECT id, game_type, level FROM categories
        WHERE UPPER(REPLACE(game_type, ' ', '')) = $1 AND UPPER(level) = $2
      `, [normalizedMode, normalizedCategorie], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    console.log('Found category:', category);

    // Determine current season (September cutoff)
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const season = month >= 9 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
    console.log('Season:', season);

    // Fetch current rankings for this category
    let rankings = [];
    if (category) {
      rankings = await new Promise((resolve, reject) => {
        db.all(`
          SELECT r.licence, r.rank_position,
                 COALESCE(p.first_name, '') as first_name,
                 COALESCE(p.last_name, '') as last_name
          FROM rankings r
          LEFT JOIN players p ON REPLACE(r.licence, ' ', '') = REPLACE(p.licence, ' ', '')
          WHERE r.category_id = $1 AND r.season = $2
          ORDER BY r.rank_position
        `, [category.id, season], (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      });
      console.log('Found rankings:', rankings.length);
    } else {
      console.log('No category found - cannot lookup rankings');
    }

    // Create a map of licence -> rank_position for quick lookup
    const rankingMap = new Map();
    rankings.forEach(r => {
      const normLicence = r.licence?.replace(/\s/g, '');
      rankingMap.set(normLicence, r.rank_position);
    });

    // Get location info from stored poules (if any)
    const storedPoules = await new Promise((resolve, reject) => {
      db.all(`
        SELECT location_name, location_address, start_time
        FROM convocation_poules
        WHERE tournoi_id = $1
        LIMIT 1
      `, [tournoiId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    const locationInfo = storedPoules.length > 0 ? {
      name: storedPoules[0].location_name,
      address: storedPoules[0].location_address,
      startTime: storedPoules[0].start_time
    } : null;

    // Use provided locations or default
    const pouleLocations = locations || (locationInfo ? [{
      locationNum: '1',
      name: locationInfo.name,
      address: locationInfo.address,
      startTime: locationInfo.startTime
    }] : []);

    // Get ALL inscribed players from inscriptions table (not from stored poules)
    // This ensures reinstated players like Eric are included
    const forfaitSet = new Set((forfaitLicences || []).map(l => l?.replace(/\s/g, '')));

    const inscribedPlayers = await new Promise((resolve, reject) => {
      db.all(`
        SELECT i.licence, p.last_name, p.first_name, p.club
        FROM inscriptions i
        LEFT JOIN players p ON REPLACE(i.licence, ' ', '') = REPLACE(p.licence, ' ', '')
        WHERE i.tournoi_id = $1
          AND (i.statut IS NULL OR i.statut = 'inscrit')
          AND (i.forfait IS NULL OR i.forfait = 0)
          AND UPPER(i.licence) NOT LIKE 'TEST%'
      `, [tournoiId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Transform to expected format and filter out newly selected forfaits
    let activePlayers = inscribedPlayers
      .filter(p => !forfaitSet.has(p.licence?.replace(/\s/g, '')))
      .map(p => ({
        licence: p.licence,
        player_name: `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.licence,
        club: p.club || ''
      }));

    // Remove duplicates (same player might appear in list)
    const seenLicences = new Set();
    activePlayers = activePlayers.filter(p => {
      const normLicence = p.licence?.replace(/\s/g, '');
      if (seenLicences.has(normLicence)) return false;
      seenLicences.add(normLicence);
      return true;
    });

    // Add replacement player if provided
    if (replacementPlayer) {
      activePlayers.push({
        licence: replacementPlayer.licence,
        player_name: replacementPlayer.name || `${replacementPlayer.first_name} ${replacementPlayer.last_name}`,
        club: replacementPlayer.club
      });
    }

    // Sort players by their ranking position
    // Ranked players first (sorted by rank), then nouveaux at the end
    activePlayers = activePlayers.map(p => {
      const normLicence = p.licence?.replace(/\s/g, '');
      const rank = rankingMap.get(normLicence);
      return {
        ...p,
        rank: rank || null,
        isNouveau: rank === undefined || rank === null
      };
    });

    // Sort: ranked players by rank_position, then nouveaux at end
    activePlayers.sort((a, b) => {
      if (a.isNouveau && b.isNouveau) return 0;
      if (a.isNouveau) return 1; // nouveaux go to end
      if (b.isNouveau) return -1;
      return a.rank - b.rank;
    });

    // If preview only, don't save to database
    if (!previewOnly) {
      // Mark forfait players in inscriptions table
      for (const licence of (forfaitLicences || [])) {
        await new Promise((resolve, reject) => {
          db.run(`
            UPDATE inscriptions
            SET forfait = 1
            WHERE tournoi_id = $1 AND REPLACE(licence, ' ', '') = REPLACE($2, ' ', '')
          `, [tournoiId, licence], (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
    }

    // Poule configuration - same as frontend
    const POULE_CONFIG = {
      3: [3], 4: [4], 5: [5],
      6: [3, 3], 7: [3, 4], 8: [3, 5],
      9: [3, 3, 3], 10: [3, 3, 4], 11: [3, 3, 5],
      12: [3, 3, 3, 3], 13: [3, 3, 3, 4], 14: [3, 3, 3, 5],
      15: [3, 3, 3, 3, 3], 16: [3, 3, 3, 3, 4], 17: [3, 3, 3, 3, 5],
      18: [3, 3, 3, 3, 3, 3], 19: [3, 3, 3, 3, 3, 4], 20: [3, 3, 3, 3, 3, 5]
    };

    // Get poule sizes for player count
    const playerCount = activePlayers.length;
    let pouleSizes;
    if (playerCount < 3) {
      pouleSizes = [];
    } else if (playerCount > 20) {
      const base = Math.floor(playerCount / 3);
      const remainder = playerCount % 3;
      pouleSizes = Array(base).fill(3);
      if (remainder === 1) pouleSizes[pouleSizes.length - 1] = 4;
      else if (remainder === 2) pouleSizes[pouleSizes.length - 1] = 5;
    } else {
      pouleSizes = POULE_CONFIG[playerCount] || [];
    }

    // Create poules with sizes
    const numPoules = pouleSizes.length;
    const newPoules = pouleSizes.map((size, i) => ({
      number: i + 1,
      size: size,
      players: [],
      locationNum: '1'
    }));

    // Distribute players using serpentine (same as frontend)
    let playerIndex = 0;
    let row = 0;
    while (playerIndex < activePlayers.length && numPoules > 0) {
      const isLeftToRight = row % 2 === 0;
      for (let i = 0; i < numPoules && playerIndex < activePlayers.length; i++) {
        const pouleIndex = isLeftToRight ? i : (numPoules - 1 - i);
        const poule = newPoules[pouleIndex];
        if (poule.players.length < poule.size) {
          poule.players.push(activePlayers[playerIndex]);
          playerIndex++;
        }
      }
      row++;
    }

    // Save new poules to database only if not preview
    if (!previewOnly) {
      await new Promise((resolve, reject) => {
        db.run(`DELETE FROM convocation_poules WHERE tournoi_id = $1`, [tournoiId], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      for (const poule of newPoules) {
        const loc = pouleLocations.find(l => l.locationNum === poule.locationNum) || pouleLocations[0];
        for (let i = 0; i < poule.players.length; i++) {
          const player = poule.players[i];
          await new Promise((resolve, reject) => {
            db.run(`
              INSERT INTO convocation_poules (tournoi_id, poule_number, licence, player_name, club, location_name, location_address, start_time, player_order)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `, [tournoiId, poule.number, player.licence, player.player_name, player.club, loc?.name || '', loc?.address || '', loc?.startTime || '', i], (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
        }
      }
    }

    // Log the action (only if not preview)
    if (!previewOnly) {
      logAdminAction({
        req,
        action: ACTION_TYPES.REGENERATE_POULES,
        details: `Poules régénérées: ${newPoules.length} poules, ${activePlayers.length} joueurs (${(forfaitLicences || []).length} forfaits)`,
        targetType: 'tournament',
        targetId: tournoiId,
        targetName: `Tournoi ${tournoiId}`
      });
    }

    res.json({
      success: true,
      preview: previewOnly || false,
      message: previewOnly ? 'Preview generated (not saved)' : 'Poules regenerated',
      playerCount: activePlayers.length,
      pouleCount: newPoules.length,
      poules: newPoules.map(p => ({
        number: p.number,
        players: p.players.map(pl => ({
          licence: pl.licence,
          name: pl.player_name,
          club: pl.club,
          rank: pl.rank,
          isNouveau: pl.isNouveau
        }))
      }))
    });
  } catch (error) {
    console.error('Error regenerating poules:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ ENROLLMENT REQUEST EMAILS ============

/**
 * POST /api/email/enrollment-acknowledgment
 * Send acknowledgment email to player when they submit an enrollment request
 */
router.post('/enrollment-acknowledgment', async (req, res) => {
  const { player_email, player_name, game_mode, requested_ranking, tournament_number, api_key } = req.body;

  // Verify API key (shared secret between apps)
  if (api_key !== process.env.PLAYER_APP_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({ error: 'Email not configured' });
  }

  if (!player_email || !player_name || !game_mode || !requested_ranking) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Load email settings for dynamic branding
    const emailSettings = await getEmailTemplateSettings();
    const contactEmail = await getContactEmail();
    const primaryColor = emailSettings.primary_color || '#1F4788';
    const senderName = emailSettings.email_sender_name || 'CDBHS';
    const emailFrom = emailSettings.email_noreply || 'noreply@cdbhs.net';
    const orgShortName = emailSettings.organization_short_name || 'CDBHS';

    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f5f5f5;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; background-color: #f5f5f5;">
          <tr>
            <td align="center" style="padding: 20px;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <tr>
                  <td style="background: linear-gradient(135deg, ${primaryColor}, #667eea); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
                    <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Confirmation de votre demande</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 30px;">
                    <p style="font-size: 16px; color: #333333; margin: 0 0 20px 0;">
                      Bonjour <strong>${player_name}</strong>,
                    </p>
                    <p style="font-size: 16px; color: #333333; margin: 0 0 20px 0;">
                      Votre demande d'inscription a bien été enregistrée :
                    </p>
                    <table style="width: 100%; background-color: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px 0;">
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Mode de jeu :</strong> ${game_mode}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Catégorie :</strong> ${requested_ranking}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Tournoi :</strong> ${tournament_number}
                        </td>
                      </tr>
                    </table>
                    <p style="font-size: 16px; color: #333333; margin: 20px 0;">
                      Nous reviendrons vers vous rapidement.
                    </p>
                    <p style="font-size: 16px; color: #333333; margin: 20px 0 0 0;">
                      Cordialement,<br>
                      <strong>${orgShortName}</strong>
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="background-color: #f8f9fa; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; font-size: 12px; color: #666666;">
                    ${contactEmail ? `Contact : <a href="mailto:${contactEmail}" style="color: ${primaryColor};">${contactEmail}</a>` : ''}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    await resend.emails.send({
      from: `${senderName} <${emailFrom}>`,
      to: player_email,
      subject: `Confirmation de votre demande d'inscription - ${orgShortName}`,
      html: emailHtml
    });

    console.log(`Enrollment acknowledgment email sent to ${player_email}`);
    res.json({ success: true });

  } catch (error) {
    console.error('Error sending enrollment acknowledgment email:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

/**
 * POST /api/email/enrollment-notification
 * Send notification email to org when a player submits an enrollment request
 */
router.post('/enrollment-notification', async (req, res) => {
  const { player_name, player_licence, player_email, player_club, game_mode, current_ranking, requested_ranking, tournament_number, api_key } = req.body;

  // Verify API key (shared secret between apps)
  if (api_key !== process.env.PLAYER_APP_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({ error: 'Email not configured' });
  }

  if (!player_name || !player_email || !game_mode || !requested_ranking) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Load email settings for dynamic branding
    const emailSettings = await getEmailTemplateSettings();
    const summaryEmail = emailSettings.summary_email || 'cdbhs92@gmail.com';
    const primaryColor = emailSettings.primary_color || '#1F4788';
    const senderName = emailSettings.email_sender_name || 'CDBHS';
    const emailFrom = emailSettings.email_noreply || 'noreply@cdbhs.net';

    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f5f5f5;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; background-color: #f5f5f5;">
          <tr>
            <td align="center" style="padding: 20px;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <tr>
                  <td style="background: linear-gradient(135deg, ${primaryColor}, #667eea); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
                    <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Nouvelle demande d'inscription</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 30px;">
                    <p style="font-size: 16px; color: #333333; margin: 0 0 20px 0;">
                      Le joueur suivant souhaite s'inscrire à une compétition :
                    </p>

                    <h3 style="color: ${primaryColor}; margin: 20px 0 10px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">
                      Informations joueur
                    </h3>
                    <table style="width: 100%; background-color: #f8f9fa; border-radius: 8px; padding: 15px;">
                      <tr>
                        <td style="padding: 8px 20px;"><strong>Nom :</strong> ${player_name}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;"><strong>Licence :</strong> ${player_licence || 'Non renseignée'}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;"><strong>Club :</strong> ${player_club || 'Non renseigné'}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;"><strong>Email :</strong> <a href="mailto:${player_email}" style="color: ${primaryColor};">${player_email}</a></td>
                      </tr>
                    </table>

                    <h3 style="color: ${primaryColor}; margin: 20px 0 10px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">
                      Demande d'inscription
                    </h3>
                    <table style="width: 100%; background-color: #e3f2fd; border-radius: 8px; padding: 15px;">
                      <tr>
                        <td style="padding: 8px 20px;"><strong>Mode de jeu :</strong> ${game_mode}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;"><strong>Classement actuel :</strong> ${current_ranking || 'Non classé'}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;"><strong>Catégorie demandée :</strong> ${requested_ranking}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;"><strong>Tournoi :</strong> ${tournament_number}</td>
                      </tr>
                    </table>

                    <p style="font-size: 14px; color: #666666; margin: 20px 0 0 0; text-align: center;">
                      → Gérez cette demande dans l'application Tournois
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    await resend.emails.send({
      from: `${senderName} <${emailFrom}>`,
      to: summaryEmail,
      subject: `Nouvelle demande d'inscription - ${player_name}`,
      html: emailHtml
    });

    console.log(`Enrollment notification email sent to ${summaryEmail}`);
    res.json({ success: true });

  } catch (error) {
    console.error('Error sending enrollment notification email:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

/**
 * POST /api/email/enrollment-approved
 * Send email to player when their enrollment request is approved
 * Accepts either api_key (for internal calls) or Authorization header
 */
router.post('/enrollment-approved', async (req, res) => {
  const { player_email, player_name, game_mode, requested_ranking, tournament_number, tournament_name, tournament_date, api_key } = req.body;

  // Verify auth - accept either API key or Authorization header
  const authHeader = req.headers['authorization'];
  const validApiKey = api_key && api_key === process.env.PLAYER_APP_API_KEY;
  if (!authHeader && !validApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({ error: 'Email not configured' });
  }

  if (!player_email || !player_name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const emailSettings = await getEmailTemplateSettings();
    const contactEmail = await getContactEmail();
    const primaryColor = emailSettings.primary_color || '#1F4788';
    const senderName = emailSettings.email_sender_name || 'CDBHS';
    const emailFrom = emailSettings.email_noreply || 'noreply@cdbhs.net';
    const orgShortName = emailSettings.organization_short_name || 'CDBHS';

    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f5f5f5;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; background-color: #f5f5f5;">
          <tr>
            <td align="center" style="padding: 20px;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <tr>
                  <td style="background: linear-gradient(135deg, #28a745, #20c997); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
                    <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Demande acceptée !</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 30px;">
                    <p style="font-size: 16px; color: #333333; margin: 0 0 20px 0;">
                      Bonjour <strong>${player_name}</strong>,
                    </p>
                    <p style="font-size: 16px; color: #333333; margin: 0 0 20px 0;">
                      Bonne nouvelle ! Votre demande d'inscription a été <strong style="color: #28a745;">acceptée</strong>.
                    </p>
                    <table style="width: 100%; background-color: #d4edda; border-radius: 8px; padding: 20px; margin: 20px 0;">
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Mode de jeu :</strong> ${game_mode || '-'}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Catégorie :</strong> ${requested_ranking || '-'}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Tournoi :</strong> ${tournament_number || '-'}
                        </td>
                      </tr>
                    </table>
                    <p style="font-size: 16px; color: #333333; margin: 20px 0;">
                      Vous recevrez une convocation avec les détails (lieu, heure, poule) quelques jours avant la compétition.
                    </p>
                    <p style="font-size: 16px; color: #333333; margin: 20px 0 0 0;">
                      Cordialement,<br>
                      <strong>${orgShortName}</strong>
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="background-color: #f8f9fa; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; font-size: 12px; color: #666666;">
                    ${contactEmail ? `Contact : <a href="mailto:${contactEmail}" style="color: ${primaryColor};">${contactEmail}</a>` : ''}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    await resend.emails.send({
      from: `${senderName} <${emailFrom}>`,
      to: player_email,
      subject: `Demande acceptée - ${game_mode} ${requested_ranking} T${tournament_number}`,
      html: emailHtml
    });

    console.log(`Enrollment approved email sent to ${player_email}`);
    res.json({ success: true });

  } catch (error) {
    console.error('Error sending enrollment approved email:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

/**
 * POST /api/email/enrollment-rejected
 * Send email to player when their enrollment request is rejected
 * Accepts either api_key (for internal calls) or Authorization header
 */
router.post('/enrollment-rejected', async (req, res) => {
  const { player_email, player_name, game_mode, requested_ranking, tournament_number, rejection_reason, api_key } = req.body;

  // Verify auth - accept either API key or Authorization header
  const authHeader = req.headers['authorization'];
  const validApiKey = api_key && api_key === process.env.PLAYER_APP_API_KEY;
  if (!authHeader && !validApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({ error: 'Email not configured' });
  }

  if (!player_email || !player_name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const emailSettings = await getEmailTemplateSettings();
    const contactEmail = await getContactEmail();
    const primaryColor = emailSettings.primary_color || '#1F4788';
    const senderName = emailSettings.email_sender_name || 'CDBHS';
    const emailFrom = emailSettings.email_noreply || 'noreply@cdbhs.net';
    const orgShortName = emailSettings.organization_short_name || 'CDBHS';

    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f5f5f5;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; background-color: #f5f5f5;">
          <tr>
            <td align="center" style="padding: 20px;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <tr>
                  <td style="background: linear-gradient(135deg, #dc3545, #c82333); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
                    <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Demande refusée</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 30px;">
                    <p style="font-size: 16px; color: #333333; margin: 0 0 20px 0;">
                      Bonjour <strong>${player_name}</strong>,
                    </p>
                    <p style="font-size: 16px; color: #333333; margin: 0 0 20px 0;">
                      Nous sommes au regret de vous informer que votre demande d'inscription a été <strong style="color: #dc3545;">refusée</strong>.
                    </p>
                    <table style="width: 100%; background-color: #f8d7da; border-radius: 8px; padding: 20px; margin: 20px 0;">
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Mode de jeu :</strong> ${game_mode || '-'}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Catégorie :</strong> ${requested_ranking || '-'}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Tournoi :</strong> ${tournament_number || '-'}
                        </td>
                      </tr>
                      ${rejection_reason ? `
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Motif :</strong> ${rejection_reason}
                        </td>
                      </tr>
                      ` : ''}
                    </table>
                    <p style="font-size: 16px; color: #333333; margin: 20px 0;">
                      Si vous avez des questions, n'hésitez pas à nous contacter.
                    </p>
                    <p style="font-size: 16px; color: #333333; margin: 20px 0 0 0;">
                      Cordialement,<br>
                      <strong>${orgShortName}</strong>
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="background-color: #f8f9fa; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; font-size: 12px; color: #666666;">
                    ${contactEmail ? `Contact : <a href="mailto:${contactEmail}" style="color: ${primaryColor};">${contactEmail}</a>` : ''}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    await resend.emails.send({
      from: `${senderName} <${emailFrom}>`,
      to: player_email,
      subject: `Demande refusée - ${game_mode} ${requested_ranking} T${tournament_number}`,
      html: emailHtml
    });

    console.log(`Enrollment rejected email sent to ${player_email}`);
    res.json({ success: true });

  } catch (error) {
    console.error('Error sending enrollment rejected email:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

module.exports = router;
