const express = require('express');
const { Resend } = require('resend');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticateToken } = require('./auth');
const appSettings = require('../utils/app-settings');
const { logAdminAction, ACTION_TYPES } = require('../utils/admin-logger');

const router = express.Router();

// Configure multer for email image uploads
const imageStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../frontend/images/uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, `email-image-${timestamp}${ext}`);
  }
});

const imageUpload = multer({
  storage: imageStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: function (req, file, cb) {
    const filetypes = /jpeg|jpg|png|gif|webp/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype || file.mimetype.startsWith('image/')) {
      return cb(null, true);
    }
    cb(new Error('Only image files are allowed'));
  }
});

// Helper function to add delay between emails (avoid rate limiting)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to convert email addresses to mailto links in HTML
function convertEmailsToMailtoLinks(text) {
  // Match email addresses and convert to mailto links
  return text.replace(
    /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
    '<a href="mailto:$1" style="color: #1F4788;">$1</a>'
  );
}

// Get contact email from app_settings (with fallback to summary_email)
async function getContactEmail() {
  return appSettings.getSetting('summary_email');
}

// Get all email-related settings at once (for templates)
async function getEmailTemplateSettings() {
  const settings = await appSettings.getSettingsBatch([
    'primary_color',
    'secondary_color',
    'accent_color',
    'email_noreply',
    'email_convocations',
    'email_communication',
    'email_sender_name',
    'organization_name',
    'organization_short_name',
    'summary_email'
  ]);
  return settings;
}

// Build "from" address for emails
function buildFromAddress(settings, type = 'noreply') {
  const senderName = settings.email_sender_name || 'CDBHS';
  let email;
  switch (type) {
    case 'convocations':
      email = settings.email_convocations || 'convocations@cdbhs.net';
      break;
    case 'communication':
      email = settings.email_communication || 'communication@cdbhs.net';
      break;
    default:
      email = settings.email_noreply || 'noreply@cdbhs.net';
  }
  return `${senderName} <${email}>`;
}

// Build contact phrase HTML with configurable email and color
function buildContactPhraseHtml(email, primaryColor = '#1F4788') {
  return `<p style="margin-top: 20px; padding: 10px; background: #e8f4f8; border-left: 3px solid ${primaryColor}; font-size: 14px;">
  Pour toute question ou information, écrivez à <a href="mailto:${email}" style="color: ${primaryColor};">${email}</a>
</p>`;
}

// Helper function to parse dates that might be in French format (DD/MM/YYYY)
function parseDateSafe(dateStr) {
  if (!dateStr) return null;

  // If it's already a Date object, return it
  if (dateStr instanceof Date) return dateStr;

  // Check if it's in DD/MM/YYYY format
  const frenchMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (frenchMatch) {
    const [, day, month, year] = frenchMatch;
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  }

  // Try ISO format (YYYY-MM-DD) or other standard formats
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  return null;
}

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

// Upload image for email (supports pasted screenshots)
router.post('/upload-image', authenticateToken, imageUpload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucune image fournie' });
    }

    // Build the public URL for the uploaded image
    const baseUrl = process.env.BASE_URL || 'https://cdbhs-tournament-management-production.up.railway.app';
    const imageUrl = `${baseUrl}/images/uploads/${req.file.filename}`;

    res.json({
      success: true,
      url: imageUrl,
      filename: req.file.filename
    });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ error: 'Erreur lors du téléchargement de l\'image' });
  }
});

// API endpoint to get summary email
router.get('/summary-email', authenticateToken, async (req, res) => {
  try {
    const email = await getSummaryEmail();
    res.json({ email });
  } catch (error) {
    res.json({ email: 'cdbhs92@gmail.com' });
  }
});

// Check if a campaign was already sent
router.get('/check-campaign', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { campaign_type, mode, category, tournament_id } = req.query;

  if (!campaign_type) {
    return res.status(400).json({ error: 'campaign_type required' });
  }

  try {
    // Only check for real sends (not test mode)
    // Check both 'completed' and 'sending' status (sending means it was started)
    let query = `SELECT id, subject, sent_count, recipients_count, sent_at, created_at, sent_by, mode, category
                 FROM email_campaigns
                 WHERE campaign_type = $1
                   AND status IN ('completed', 'sending')
                   AND (test_mode = FALSE OR test_mode IS NULL)`;
    const params = [campaign_type];
    let paramIndex = 2;

    // Mode/category matching: if provided, match OR allow NULL (for manually tagged records)
    if (mode) {
      query += ` AND (mode = $${paramIndex++} OR mode IS NULL)`;
      params.push(mode);
    }
    if (category) {
      query += ` AND (category = $${paramIndex++} OR category IS NULL)`;
      params.push(category);
    }
    if (tournament_id) {
      query += ` AND tournament_id = $${paramIndex++}`;
      params.push(tournament_id);
    }

    query += ' ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 1';

    const campaign = await new Promise((resolve, reject) => {
      db.get(query, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (campaign) {
      res.json({
        alreadySent: true,
        lastSent: campaign.sent_at || campaign.created_at,
        sentBy: campaign.sent_by,
        recipientCount: campaign.sent_count || campaign.recipients_count,
        subject: campaign.subject
      });
    } else {
      res.json({ alreadySent: false });
    }
  } catch (error) {
    console.error('Error checking campaign:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get count of campaigns to purge (before current season) - Admin only
router.get('/campaigns/purge-count', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  // Check if user is admin
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  // Check if we're past June 30th
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth(); // 0-11

  // Season ends June 30th, so purge is only allowed after that
  // Before July (month < 6), we're still in the season
  if (currentMonth < 6) { // Before July
    return res.json({
      allowed: false,
      message: 'La purge n\'est possible qu\'après le 30 juin',
      count: 0
    });
  }

  // Calculate previous season start (September 1st of previous year)
  const previousSeasonStart = `${currentYear - 1}-09-01`;

  try {
    const result = await new Promise((resolve, reject) => {
      db.get(
        `SELECT COUNT(*) as count FROM email_campaigns WHERE sent_at < $1 OR (sent_at IS NULL AND created_at < $1)`,
        [previousSeasonStart],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    res.json({
      allowed: true,
      count: result.count,
      beforeDate: previousSeasonStart
    });
  } catch (error) {
    console.error('Error counting campaigns to purge:', error);
    res.status(500).json({ error: error.message });
  }
});

// Purge old campaigns (before current season) - Admin only
router.delete('/campaigns/purge', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  // Check if user is admin
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  // Check if we're past June 30th
  const now = new Date();
  const currentMonth = now.getMonth();

  if (currentMonth < 6) {
    return res.status(400).json({ error: 'La purge n\'est possible qu\'après le 30 juin' });
  }

  const currentYear = now.getFullYear();
  const previousSeasonStart = `${currentYear - 1}-09-01`;

  try {
    const result = await new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM email_campaigns WHERE sent_at < $1 OR (sent_at IS NULL AND created_at < $1)`,
        [previousSeasonStart],
        function(err) {
          if (err) reject(err);
          else resolve({ deleted: this.changes });
        }
      );
    });

    console.log(`[Purge] Deleted ${result.deleted} old email campaigns before ${previousSeasonStart}`);
    res.json({
      success: true,
      deleted: result.deleted,
      message: `${result.deleted} enregistrement(s) supprimé(s)`
    });
  } catch (error) {
    console.error('Error purging campaigns:', error);
    res.status(500).json({ error: error.message });
  }
});

// Initialize Resend
const getResend = () => {
  if (!process.env.RESEND_API_KEY) {
    return null;
  }
  return new Resend(process.env.RESEND_API_KEY);
};

// Default email template for general communications
const DEFAULT_GENERAL_TEMPLATE = {
  subject: 'Information CDBHS',
  body: `Bonjour {player_name},

{message}

Pour toute question ou information, écrivez à cdbhs92@gmail.com

Cordialement,
Comite Departemental Billard Hauts-de-Seine`
};

// Fetch email template from database
async function getEmailTemplate(templateKey = 'general') {
  const db = require('../db-loader');

  return new Promise((resolve) => {
    db.get(
      'SELECT * FROM email_templates WHERE template_key = $1',
      [templateKey],
      (err, row) => {
        if (err || !row) {
          resolve(DEFAULT_GENERAL_TEMPLATE);
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

// ==================== SYNC HELPER ====================

// Sync contacts from players and inscriptions - can be called from anywhere
async function syncContacts() {
  const db = require('../db-loader');

  // First, sync all players (normalize licence by removing spaces)
  await new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO player_contacts (licence, first_name, last_name, club, rank_libre, rank_cadre, rank_bande, rank_3bandes, statut)
      SELECT REPLACE(p.licence, ' ', ''), p.first_name, p.last_name, p.club, p.rank_libre, p.rank_cadre, p.rank_bande, p.rank_3bandes,
             CASE WHEN p.is_active = 1 THEN 'Actif' ELSE 'Inactif' END
      FROM players p
      ON CONFLICT (licence) DO UPDATE SET
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        club = EXCLUDED.club,
        rank_libre = EXCLUDED.rank_libre,
        rank_cadre = EXCLUDED.rank_cadre,
        rank_bande = EXCLUDED.rank_bande,
        rank_3bandes = EXCLUDED.rank_3bandes,
        statut = EXCLUDED.statut,
        updated_at = CURRENT_TIMESTAMP
    `, [], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // Then, update emails and phones from inscriptions (take the most recent, only if not empty)
  // Use REPLACE to normalize licence comparison (handle spaces)
  await new Promise((resolve, reject) => {
    db.run(`
      UPDATE player_contacts
      SET email = COALESCE(
        (SELECT i.email FROM inscriptions i
         WHERE REPLACE(i.licence, ' ', '') = REPLACE(player_contacts.licence, ' ', '')
         AND i.email IS NOT NULL AND i.email != '' AND i.email LIKE '%@%'
         ORDER BY i.timestamp DESC LIMIT 1),
        player_contacts.email
      ),
      telephone = COALESCE(
        (SELECT i.telephone FROM inscriptions i
         WHERE REPLACE(i.licence, ' ', '') = REPLACE(player_contacts.licence, ' ', '')
         AND i.telephone IS NOT NULL AND i.telephone != ''
         ORDER BY i.timestamp DESC LIMIT 1),
        player_contacts.telephone
      ),
      updated_at = CURRENT_TIMESTAMP
    `, [], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  return true;
}


// ==================== CONTACTS MANAGEMENT ====================

// Get all player contacts with filters
router.get('/contacts', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { activeOnly, club, mode, category, tournoiId, playerAppUsers } = req.query;

  let query = `
    SELECT pc.* FROM player_contacts pc
    WHERE pc.email_optin = 1 AND pc.email IS NOT NULL AND pc.email != '' AND pc.email LIKE '%@%'
  `;
  const params = [];
  let paramIndex = 1;

  // Filter by active status
  if (activeOnly === 'true' || activeOnly === '1') {
    query += ` AND pc.statut = 'Actif'`;
  }

  // Filter by Player App users (those with accounts in player_accounts)
  if (playerAppUsers === 'true' || playerAppUsers === '1') {
    query += ` AND REPLACE(pc.licence, ' ', '') IN (SELECT REPLACE(pa.licence, ' ', '') FROM player_accounts pa)`;
  }

  // Filter by club using club_aliases for proper canonical name resolution
  if (club) {
    // Match either:
    // 1. Player's club resolves to same canonical name as selected club
    // 2. Direct normalized match if no alias exists
    // Note: LIMIT 1 prevents error when multiple aliases match (shouldn't happen but safety first)
    query += ` AND (
      COALESCE(
        (SELECT ca.canonical_name FROM club_aliases ca
         WHERE UPPER(REPLACE(REPLACE(REPLACE(ca.alias, ' ', ''), '.', ''), '-', ''))
             = UPPER(REPLACE(REPLACE(REPLACE(pc.club, ' ', ''), '.', ''), '-', ''))
         LIMIT 1),
        pc.club
      ) = COALESCE(
        (SELECT ca2.canonical_name FROM club_aliases ca2
         WHERE UPPER(REPLACE(REPLACE(REPLACE(ca2.alias, ' ', ''), '.', ''), '-', ''))
             = UPPER(REPLACE(REPLACE(REPLACE($${paramIndex++}, ' ', ''), '.', ''), '-', ''))
         LIMIT 1),
        $${paramIndex++}
      )
    )`;
    params.push(club, club);
  }

  // Filter by game mode (based on rankings)
  // Normalize mode: remove spaces and convert to uppercase for comparison
  const modeNormalized = mode ? mode.toUpperCase().replace(/ /g, '') : '';

  // Dynamic rank_column lookup from game_modes table
  let rankColumn = null;
  if (modeNormalized) {
    const gameModeResult = await new Promise((resolve, reject) => {
      db.get(
        `SELECT rank_column FROM game_modes WHERE UPPER(REPLACE(code, ' ', '')) = $1`,
        [modeNormalized],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (gameModeResult && gameModeResult.rank_column) {
      rankColumn = gameModeResult.rank_column;
      query += ` AND pc.${rankColumn} IS NOT NULL AND pc.${rankColumn} != '' AND pc.${rankColumn} != 'NC'`;
    }
  }

  // Filter by category (N3, R1, R2, etc.)
  if (category && rankColumn) {
    const catUpper = category.toUpperCase();
    query += ` AND UPPER(pc.${rankColumn}) = $${paramIndex++}`;
    params.push(catUpper);
  }

  // Filter by tournament (players registered) - normalize licence comparison
  if (tournoiId) {
    query += ` AND REPLACE(pc.licence, ' ', '') IN (SELECT REPLACE(i.licence, ' ', '') FROM inscriptions i WHERE i.tournoi_id = $${paramIndex++} AND i.forfait != 1)`;
    params.push(parseInt(tournoiId));
  }

  query += ` ORDER BY pc.last_name, pc.first_name`;

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error('Error fetching contacts:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

// Get all player contacts (including those without email optin)
router.get('/contacts/all', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  db.all(
    `SELECT * FROM player_contacts ORDER BY last_name, first_name`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching all contacts:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

// Update a contact
router.put('/contacts/:id', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { id } = req.params;
  const { email, telephone, statut, comments, email_optin } = req.body;

  db.run(
    `UPDATE player_contacts
     SET email = $1, telephone = $2, statut = $3, comments = $4, email_optin = $5, updated_at = CURRENT_TIMESTAMP
     WHERE id = $6`,
    [email, telephone, statut, comments, email_optin, id],
    function(err) {
      if (err) {
        console.error('Error updating contact:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, changes: this.changes });
    }
  );
});

// Sync contacts from players and inscriptions tables (manual trigger)
router.post('/contacts/sync', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  try {
    await syncContacts();

    // Get count of synced contacts
    const countResult = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM player_contacts', [], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    const withEmailCount = await new Promise((resolve, reject) => {
      db.get("SELECT COUNT(*) as count FROM player_contacts WHERE email IS NOT NULL AND email != '' AND email LIKE '%@%'", [], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    res.json({
      success: true,
      message: `Synchronisation terminee. ${countResult.count} contacts (${withEmailCount.count} avec email valide).`
    });

  } catch (error) {
    console.error('Error syncing contacts:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get available tournaments for filtering (current season: Sept - June)
router.get('/tournois', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  // Calculate current season dates
  // Season runs from September 1st to June 30th
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth(); // 0-11

  let seasonStart, seasonEnd;
  if (currentMonth >= 8) {
    // September or later: current season is currentYear-Sept to nextYear-June
    seasonStart = `${currentYear}-09-01`;
    seasonEnd = `${currentYear + 1}-06-30`;
  } else {
    // Before September: current season is previousYear-Sept to currentYear-June
    seasonStart = `${currentYear - 1}-09-01`;
    seasonEnd = `${currentYear}-06-30`;
  }

  db.all(
    `SELECT t.tournoi_id, t.nom, t.mode, t.categorie, t.debut, t.lieu,
            (SELECT COUNT(*) FROM inscriptions i WHERE i.tournoi_id = t.tournoi_id AND i.forfait != 1) as nb_inscrits
     FROM tournoi_ext t
     WHERE t.debut >= $1 AND t.debut <= $2
     ORDER BY t.debut ASC, t.mode, t.categorie`,
    [seasonStart, seasonEnd],
    (err, rows) => {
      if (err) {
        console.error('Error fetching tournois:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

// Get distinct clubs for filter dropdown
router.get('/clubs', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  // Return canonical club names from club_aliases (no duplicates)
  db.all(
    `SELECT DISTINCT canonical_name FROM club_aliases WHERE canonical_name IS NOT NULL ORDER BY canonical_name`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching clubs:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json((rows || []).map(r => r.canonical_name));
    }
  );
});

// Get clubs with their emails (for management)
router.get('/clubs-with-emails', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  db.all(
    `SELECT DISTINCT canonical_name, email FROM club_aliases WHERE canonical_name IS NOT NULL ORDER BY canonical_name`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching clubs with emails:', err);
        return res.status(500).json({ error: err.message });
      }
      // Group by canonical_name to get unique clubs with their email
      const clubsMap = {};
      (rows || []).forEach(r => {
        if (!clubsMap[r.canonical_name]) {
          clubsMap[r.canonical_name] = { name: r.canonical_name, email: r.email || '' };
        } else if (r.email && !clubsMap[r.canonical_name].email) {
          // If this alias has an email but the existing entry doesn't, use this one
          clubsMap[r.canonical_name].email = r.email;
        }
      });
      res.json(Object.values(clubsMap));
    }
  );
});

// Update club email
router.put('/clubs/:clubName/email', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { clubName } = req.params;
  const { email } = req.body;

  // Validate email format if provided
  if (email && !email.includes('@')) {
    return res.status(400).json({ error: 'Format email invalide' });
  }

  try {
    // Update email for all aliases of this club
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE club_aliases SET email = $1 WHERE canonical_name = $2`,
        [email || null, clubName],
        function(err) {
          if (err) reject(err);
          else resolve({ changes: this.changes });
        }
      );
    });

    console.log(`[Club Email] Updated email for ${clubName}: ${email || '(removed)'}`);
    res.json({ success: true, message: 'Email mis à jour' });
  } catch (error) {
    console.error('Error updating club email:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get club email by location name (for club reminders)
router.get('/club-email/:locationName', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { locationName } = req.params;

  try {
    // Try to find a matching club by canonical name or alias
    const result = await new Promise((resolve, reject) => {
      db.get(
        `SELECT canonical_name, email FROM club_aliases
         WHERE (UPPER(canonical_name) = UPPER($1) OR UPPER(alias) = UPPER($1))
         AND email IS NOT NULL AND email != ''
         LIMIT 1`,
        [locationName],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (result) {
      res.json({ found: true, clubName: result.canonical_name, email: result.email });
    } else {
      res.json({ found: false });
    }
  } catch (error) {
    console.error('Error fetching club email:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get ranking categories for filter dropdown (categories that have rankings)
router.get('/ranking-categories', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  // Get categories that have rankings in the current season
  const query = `
    SELECT DISTINCT c.id, c.game_type, c.level, c.display_name,
           (SELECT COUNT(*) FROM rankings r WHERE r.category_id = c.id AND r.season = (SELECT MAX(season) FROM rankings)) as player_count
    FROM categories c
    WHERE c.id IN (SELECT DISTINCT category_id FROM rankings WHERE season = (SELECT MAX(season) FROM rankings))
    ORDER BY c.game_type, c.level
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error fetching ranking categories:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

// Get contacts from rankings by category
router.get('/ranking-contacts', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { categoryId } = req.query;

  if (!categoryId) {
    return res.status(400).json({ error: 'Category ID required' });
  }

  // Get current season
  const seasonQuery = `SELECT MAX(season) as season FROM rankings`;

  db.get(seasonQuery, [], (err, seasonRow) => {
    if (err) {
      console.error('Error fetching season:', err);
      return res.status(500).json({ error: err.message });
    }

    const season = seasonRow?.season;
    if (!season) {
      return res.json([]);
    }

    // Get players from rankings joined with player_contacts for email info
    const query = `
      SELECT DISTINCT
        pc.id,
        pc.licence,
        pc.first_name,
        pc.last_name,
        pc.email,
        pc.club,
        pc.statut,
        pc.email_optin,
        r.rank_position,
        c.display_name as category_name
      FROM rankings r
      LEFT JOIN player_contacts pc ON REPLACE(r.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
      JOIN categories c ON r.category_id = c.id
      WHERE r.category_id = $1 AND r.season = $2
        AND pc.email IS NOT NULL AND pc.email != '' AND pc.email LIKE '%@%'
      ORDER BY r.rank_position
    `;

    db.all(query, [categoryId, season], (err, rows) => {
      if (err) {
        console.error('Error fetching ranking contacts:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    });
  });
});

// ==================== EMAIL TEMPLATES ====================

// Get all email templates
router.get('/templates', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  db.all(
    'SELECT * FROM email_templates ORDER BY template_key',
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching templates:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

// Get a specific template
router.get('/templates/:key', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { key } = req.params;

  db.get(
    'SELECT * FROM email_templates WHERE template_key = $1',
    [key],
    (err, row) => {
      if (err) {
        console.error('Error fetching template:', err);
        return res.status(500).json({ error: err.message });
      }
      if (!row) {
        return res.status(404).json({ error: 'Template not found' });
      }
      res.json(row);
    }
  );
});

// Create or update a template
router.put('/templates/:key', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { key } = req.params;
  const { subject_template, body_template } = req.body;

  db.run(
    `INSERT INTO email_templates (template_key, subject_template, body_template)
     VALUES ($1, $2, $3)
     ON CONFLICT (template_key) DO UPDATE SET
       subject_template = EXCLUDED.subject_template,
       body_template = EXCLUDED.body_template,
       updated_at = CURRENT_TIMESTAMP`,
    [key, subject_template, body_template],
    function(err) {
      if (err) {
        console.error('Error saving template:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true });
    }
  );
});

// ==================== SEND EMAILS ====================

// Send emails immediately
router.post('/send', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { recipientIds, subject, body, templateKey, imageUrl, testMode, testEmail, ccEmail } = req.body;

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({
      error: 'Email non configure. Veuillez definir RESEND_API_KEY.'
    });
  }

  // In test mode, we allow sending without recipients (use placeholder data)
  if ((!recipientIds || recipientIds.length === 0) && !testMode) {
    return res.status(400).json({ error: 'Aucun destinataire selectionne.' });
  }

  // Validate test mode
  if (testMode && (!testEmail || !testEmail.includes('@'))) {
    return res.status(400).json({ error: 'Mode Test: adresse email invalide.' });
  }

  try {
    // Get recipients (or use placeholder for test mode without selection)
    let recipients = [];
    if (recipientIds && recipientIds.length > 0) {
      const placeholders = recipientIds.map((_, i) => `$${i + 1}`).join(',');
      recipients = await new Promise((resolve, reject) => {
        db.all(
          `SELECT * FROM player_contacts WHERE id IN (${placeholders})`,
          recipientIds,
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });
    }

    // In test mode without contacts, use placeholder data
    if (testMode && recipients.length === 0) {
      recipients = [{
        id: 0,
        first_name: 'Test',
        last_name: 'Utilisateur',
        email: testEmail,
        club: 'Club Test',
        licence: 'TEST-001'
      }];
    }

    const results = {
      sent: [],
      failed: [],
      skipped: []
    };

    // Create campaign record
    const sentBy = req.user?.username || 'unknown';
    const campaignId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO email_campaigns (subject, body, template_key, recipients_count, status, sent_by)
         VALUES ($1, $2, $3, $4, 'sending', $5)
         RETURNING id`,
        [subject, body, templateKey || null, testMode ? 1 : (recipientIds ? recipientIds.length : 0), sentBy],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    // In test mode, only send to the test email address
    const recipientsToEmail = testMode
      ? [{ ...recipients[0], email: testEmail, first_name: 'TEST', last_name: 'MODE' }]
      : recipients;

    // Get contact email for the contact phrase
    const contactEmail = await getContactEmail();
    const contactPhraseHtml = buildContactPhraseHtml(contactEmail);

    // Send emails
    for (const recipient of recipientsToEmail) {
      if (!recipient.email || !recipient.email.includes('@')) {
        results.skipped.push({
          name: `${recipient.first_name} ${recipient.last_name}`,
          reason: 'Email invalide'
        });
        continue;
      }

      try {
        // Prepare template variables
        const templateVariables = {
          player_name: `${recipient.first_name} ${recipient.last_name}`,
          first_name: recipient.first_name,
          last_name: recipient.last_name,
          club: recipient.club || '',
          message: body
        };

        const emailSubject = replaceTemplateVariables(subject, templateVariables);
        const emailBody = replaceTemplateVariables(body, templateVariables);
        const emailBodyHtml = convertEmailsToMailtoLinks(emailBody.replace(/\n/g, '<br>'));

        // Build optional image HTML
        const imageHtml = imageUrl ? `<div style="text-align: center; margin: 20px 0;"><img src="${imageUrl}" alt="Image" style="max-width: 100%; height: auto; border-radius: 8px;"></div>` : '';

        await resend.emails.send({
          from: 'CDBHS <noreply@cdbhs.net>',
          replyTo: contactEmail,
          to: [recipient.email],
          subject: emailSubject,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
                <img src="${baseUrl}/logo.png" alt="Logo" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
                <h1 style="margin: 0; font-size: 24px;">${await appSettings.get('organization_name') || 'Comité Départemental de Billard'}</h1>
              </div>
              <div style="padding: 20px; background: #f8f9fa; line-height: 1.6;">
                ${imageHtml}
                ${emailBodyHtml}
                ${contactPhraseHtml}
              </div>
              <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">
                <p style="margin: 0;">CDBHS - <a href="mailto:${contactEmail}" style="color: white;">${contactEmail}</a></p>
              </div>
            </div>
          `
        });

        results.sent.push({
          name: `${recipient.first_name} ${recipient.last_name}`,
          email: recipient.email
        });

        // Update last_contacted
        await new Promise((resolve) => {
          db.run(
            'UPDATE player_contacts SET last_contacted = CURRENT_TIMESTAMP WHERE id = $1',
            [recipient.id],
            () => resolve()
          );
        });

        // Delay between emails
        await delay(1500);

      } catch (error) {
        console.error(`Error sending email to ${recipient.email}:`, error);
        results.failed.push({
          name: `${recipient.first_name} ${recipient.last_name}`,
          email: recipient.email,
          error: error.message
        });
      }
    }

    // Update campaign record
    await new Promise((resolve) => {
      db.run(
        `UPDATE email_campaigns
         SET sent_count = $1, failed_count = $2, status = 'completed', sent_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [results.sent.length, results.failed.length, campaignId],
        () => resolve()
      );
    });

    // Send summary email if requested and not in test mode
    let summarySent = false;
    if (ccEmail && ccEmail.includes('@') && !testMode && results.sent.length > 0) {
      try {
        const recipientsList = results.sent.map(r => `- ${r.name} (${r.email})`).join('\n');
        const summaryHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
              <h1 style="margin: 0; font-size: 20px;">Récapitulatif d'envoi</h1>
            </div>
            <div style="padding: 20px; background: #f8f9fa;">
              <h2 style="color: #1F4788; margin-top: 0;">Sujet: ${subject}</h2>
              <p><strong>Destinataires (${results.sent.length}):</strong></p>
              <ul style="background: white; padding: 15px 15px 15px 35px; border-radius: 4px; margin: 10px 0;">
                ${results.sent.map(r => `<li>${r.name} - ${r.email}</li>`).join('')}
              </ul>
              ${results.failed.length > 0 ? `
                <p style="color: #dc3545;"><strong>Échecs (${results.failed.length}):</strong></p>
                <ul style="background: #fff5f5; padding: 15px 15px 15px 35px; border-radius: 4px; margin: 10px 0;">
                  ${results.failed.map(r => `<li>${r.name} - ${r.email}: ${r.error}</li>`).join('')}
                </ul>
              ` : ''}
              <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">
              <p><strong>Contenu envoyé:</strong></p>
              <div style="background: white; padding: 15px; border-radius: 4px; border-left: 4px solid #1F4788;">
                ${body.replace(/\n/g, '<br>')}
              </div>
            </div>
          </div>
        `;

        await resend.emails.send({
          from: 'CDBHS <noreply@cdbhs.net>',
          to: [ccEmail],
          subject: `[Récap] ${subject}`,
          html: summaryHtml
        });
        summarySent = true;
        console.log(`Summary email sent to ${ccEmail}`);
      } catch (summaryError) {
        console.error('Error sending summary email:', summaryError);
      }
    }

    const message = testMode
      ? `MODE TEST: Email envoyé uniquement à ${testEmail}`
      : `Emails envoyés: ${results.sent.length}, Échecs: ${results.failed.length}, Ignorés: ${results.skipped.length}${summarySent ? ' + récapitulatif envoyé' : ''}`;

    // Log email campaign send
    if (!testMode) {
      logAdminAction({
        req,
        action: ACTION_TYPES.SEND_CAMPAIGN,
        details: `Campagne "${subject}" - ${results.sent.length} envoyés, ${results.failed.length} échecs`,
        targetType: 'campaign',
        targetId: campaignId,
        targetName: subject
      });
    }

    res.json({
      success: true,
      message,
      results,
      campaignId,
      testMode
    });

  } catch (error) {
    console.error('Error sending emails:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SCHEDULED EMAILS ====================

// Schedule an email for later
router.post('/schedule', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { recipientIds, subject, body, templateKey, imageUrl, scheduledAt } = req.body;

  if (!recipientIds || recipientIds.length === 0) {
    return res.status(400).json({ error: 'Aucun destinataire selectionne.' });
  }

  if (!scheduledAt) {
    return res.status(400).json({ error: 'Date et heure requises.' });
  }

  try {
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO scheduled_emails (subject, body, template_key, image_url, recipient_ids, scheduled_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [subject, body, templateKey || null, imageUrl || null, JSON.stringify(recipientIds), scheduledAt],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    res.json({
      success: true,
      message: `Email programme pour le ${new Date(scheduledAt).toLocaleString('fr-FR')}`
    });

  } catch (error) {
    console.error('Error scheduling email:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get scheduled emails (all statuses, sorted by most recent)
router.get('/scheduled', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  db.all(
    `SELECT * FROM scheduled_emails ORDER BY scheduled_at DESC LIMIT 50`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching scheduled emails:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

// Manually trigger the scheduler (for testing)
router.post('/trigger-scheduler', authenticateToken, async (req, res) => {
  try {
    // Import processScheduledEmails from server
    const result = await global.processScheduledEmails();
    res.json({ success: true, message: 'Scheduler triggered', result });
  } catch (error) {
    console.error('Error triggering scheduler:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// Update a scheduled email (change date/time)
router.put('/scheduled/:id', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { id } = req.params;
  const { scheduled_at } = req.body;

  if (!scheduled_at) {
    return res.status(400).json({ error: 'Date requise' });
  }

  db.run(
    `UPDATE scheduled_emails SET scheduled_at = $1 WHERE id = $2 AND status = 'pending'`,
    [scheduled_at, id],
    function(err) {
      if (err) {
        console.error('Error updating scheduled email:', err);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Email non trouvé ou déjà traité' });
      }
      res.json({ success: true });
    }
  );
});

// Cancel a scheduled email
router.delete('/scheduled/:id', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { id } = req.params;

  db.run(
    `UPDATE scheduled_emails SET status = 'cancelled' WHERE id = $1`,
    [id],
    function(err) {
      if (err) {
        console.error('Error cancelling scheduled email:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true });
    }
  );
});

// Schedule a relance email
router.post('/schedule-relance', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { relanceType, mode, category, subject, intro, outro, imageUrl, scheduledAt, ccEmail, customData, testMode, testEmail } = req.body;

  if (!relanceType || !mode || !category || !subject || !intro || !scheduledAt) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }

  if (testMode && !testEmail) {
    return res.status(400).json({ error: 'Email de test requis en mode test' });
  }

  // Replace {category} placeholder in subject
  const categoryLabel = `${mode} ${category}`;
  const finalSubject = subject.replace(/\{category\}/g, categoryLabel);

  try {
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO scheduled_emails (subject, body, template_key, image_url, recipient_ids, scheduled_at, status, email_type, mode, category, outro_text, cc_email, custom_data, created_by, test_mode, test_email)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [finalSubject, intro, `relance_${relanceType}`, imageUrl || null, '[]', scheduledAt, `relance_${relanceType}`, mode, category, outro || null, ccEmail || null, JSON.stringify(customData || {}), req.user?.username || 'unknown', testMode || false, testEmail || null],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    const modeLabel = testMode ? ' (MODE TEST)' : '';
    res.json({ success: true, message: `Relance programmée pour le ${new Date(scheduledAt).toLocaleString('fr-FR')}${modeLabel}` });
  } catch (error) {
    console.error('Error scheduling relance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Schedule results email
router.post('/schedule-results', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { tournamentId, introText, outroText, imageUrl, scheduledAt, ccEmail, testMode, testEmail } = req.body;

  if (!tournamentId || !scheduledAt) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }

  if (testMode && !testEmail) {
    return res.status(400).json({ error: 'Email de test requis en mode test' });
  }

  try {
    // Get tournament info with category display_name for subject
    const tournament = await new Promise((resolve, reject) => {
      db.get(`SELECT t.*, c.display_name, c.game_type, c.level
              FROM tournaments t
              JOIN categories c ON t.category_id = c.id
              WHERE t.id = $1`, [tournamentId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!tournament) {
      return res.status(404).json({ error: 'Tournoi non trouvé' });
    }

    const tournamentLabel = `T${tournament.tournament_number} ${tournament.season}`;
    const subject = `Résultats - ${tournament.display_name} - ${tournamentLabel}`;

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO scheduled_emails (subject, body, template_key, image_url, recipient_ids, scheduled_at, status, email_type, mode, category, tournament_id, outro_text, cc_email, created_by, test_mode, test_email)
         VALUES ($1, $2, 'tournament_results', $3, $4, $5, 'pending', 'tournament_results', $6, $7, $8, $9, $10, $11, $12, $13)`,
        [subject, introText || '', imageUrl || null, '[]', scheduledAt, tournament.game_type, tournament.level, tournamentId, outroText || null, ccEmail || null, req.user?.username || 'unknown', testMode || false, testEmail || null],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    const modeLabel = testMode ? ' (MODE TEST)' : '';
    res.json({ success: true, message: `Résultats programmés pour le ${new Date(scheduledAt).toLocaleString('fr-FR')}${modeLabel}` });
  } catch (error) {
    console.error('Error scheduling results:', error);
    res.status(500).json({ error: error.message });
  }
});

// Schedule finale convocation email
router.post('/schedule-finale-convocation', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { finaleId, introText, outroText, imageUrl, scheduledAt, ccEmail, testMode, testEmail } = req.body;

  if (!finaleId || !scheduledAt) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }

  if (testMode && !testEmail) {
    return res.status(400).json({ error: 'Email de test requis en mode test' });
  }

  try {
    // Get finale info
    const finale = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM tournoi_ext WHERE tournoi_id = $1`, [finaleId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!finale) {
      return res.status(404).json({ error: 'Finale non trouvée' });
    }

    const subject = `Convocation Finale - ${finale.mode} ${finale.categorie}`;

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO scheduled_emails (subject, body, template_key, image_url, recipient_ids, scheduled_at, status, email_type, mode, category, tournament_id, outro_text, cc_email, created_by, test_mode, test_email)
         VALUES ($1, $2, 'finale_convocation', $3, $4, $5, 'pending', 'finale_convocation', $6, $7, $8, $9, $10, $11, $12, $13)`,
        [subject, introText || '', imageUrl || null, '[]', scheduledAt, finale.mode, finale.categorie, finaleId, outroText || null, ccEmail || null, req.user?.username || 'unknown', testMode || false, testEmail || null],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    const modeLabel = testMode ? ' (MODE TEST)' : '';
    res.json({ success: true, message: `Convocation finale programmée pour le ${new Date(scheduledAt).toLocaleString('fr-FR')}${modeLabel}` });
  } catch (error) {
    console.error('Error scheduling finale convocation:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to check if a campaign was already manually sent
async function checkIfAlreadySent(db, emailType, mode, category, tournamentId) {
  return new Promise((resolve, reject) => {
    let query = `SELECT id FROM email_campaigns
                 WHERE campaign_type = $1
                   AND status IN ('completed', 'sending')
                   AND (test_mode = FALSE OR test_mode IS NULL)`;
    const params = [emailType];
    let paramIndex = 2;

    if (mode) {
      query += ` AND (mode = $${paramIndex++} OR mode IS NULL)`;
      params.push(mode);
    }
    if (category) {
      query += ` AND (category = $${paramIndex++} OR category IS NULL)`;
      params.push(category);
    }
    if (tournamentId) {
      query += ` AND tournament_id = $${paramIndex++}`;
      params.push(tournamentId);
    }

    query += ' LIMIT 1';

    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(!!row);
    });
  });
}

// Process scheduled emails (to be called by a scheduler/cron job)
router.post('/process-scheduled', async (req, res) => {
  const db = require('../db-loader');

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({
      error: 'Email non configure.'
    });
  }

  try {
    // Get emails that are due
    const scheduledEmails = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM scheduled_emails
         WHERE status = 'pending' AND scheduled_at <= CURRENT_TIMESTAMP`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    const processedCount = scheduledEmails.length;
    let blockedCount = 0;

    // Get configurable contact email
    const contactEmail = await getContactEmail();
    const contactPhraseHtml = buildContactPhraseHtml(contactEmail);

    for (const scheduled of scheduledEmails) {
      // Check if this type of email was already manually sent
      if (scheduled.email_type) {
        const alreadySent = await checkIfAlreadySent(
          db,
          scheduled.email_type,
          scheduled.mode,
          scheduled.category,
          scheduled.tournament_id
        );

        if (alreadySent) {
          // Block this scheduled email
          await new Promise((resolve) => {
            db.run(
              `UPDATE scheduled_emails SET status = 'blocked' WHERE id = $1`,
              [scheduled.id],
              () => resolve()
            );
          });
          blockedCount++;
          console.log(`Blocked scheduled email ${scheduled.id} - already manually sent`);
          continue;
        }
      }

      const recipientIds = JSON.parse(scheduled.recipient_ids);

      // Get recipients
      const placeholders = recipientIds.map((_, i) => `$${i + 1}`).join(',');
      const recipients = await new Promise((resolve, reject) => {
        db.all(
          `SELECT * FROM player_contacts WHERE id IN (${placeholders})`,
          recipientIds,
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      let sentCount = 0;
      let failedCount = 0;

      // Send emails
      for (const recipient of recipients) {
        if (!recipient.email || !recipient.email.includes('@')) {
          continue;
        }

        try {
          const templateVariables = {
            player_name: `${recipient.first_name} ${recipient.last_name}`,
            first_name: recipient.first_name,
            last_name: recipient.last_name,
            club: recipient.club || '',
            message: scheduled.body
          };

          const emailSubject = replaceTemplateVariables(scheduled.subject, templateVariables);
          const emailBody = replaceTemplateVariables(scheduled.body, templateVariables);
          const emailBodyHtml = convertEmailsToMailtoLinks(emailBody.replace(/\n/g, '<br>'));

          await resend.emails.send({
            from: 'CDBHS <noreply@cdbhs.net>',
            replyTo: contactEmail,
            to: [recipient.email],
            subject: emailSubject,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
                  <h1 style="margin: 0; font-size: 24px;">CDBHS</h1>
                </div>
                <div style="padding: 20px; background: #f8f9fa; line-height: 1.6;">
                  ${emailBodyHtml}
                  ${contactPhraseHtml}
                </div>
                <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">
                  <p style="margin: 0;">Comite Departemental Billard Hauts-de-Seine - <a href="mailto:${contactEmail}" style="color: white;">${contactEmail}</a></p>
                </div>
              </div>
            `
          });

          sentCount++;

          // Update last_contacted
          await new Promise((resolve) => {
            db.run(
              'UPDATE player_contacts SET last_contacted = CURRENT_TIMESTAMP WHERE id = $1',
              [recipient.id],
              () => resolve()
            );
          });

          await delay(1500);

        } catch (error) {
          console.error(`Error sending scheduled email to ${recipient.email}:`, error);
          failedCount++;
        }
      }

      // Update scheduled email status
      await new Promise((resolve) => {
        db.run(
          `UPDATE scheduled_emails SET status = 'completed', sent_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [scheduled.id],
          () => resolve()
        );
      });

      // Create campaign record
      await new Promise((resolve) => {
        db.run(
          `INSERT INTO email_campaigns (subject, body, template_key, recipients_count, sent_count, failed_count, status, sent_at, sent_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'completed', CURRENT_TIMESTAMP, $7)`,
          [scheduled.subject, scheduled.body, scheduled.template_key, recipientIds.length, sentCount, failedCount, scheduled.created_by || 'scheduled'],
          () => resolve()
        );
      });
    }

    res.json({
      success: true,
      message: `${processedCount} email(s) programmé(s) traité(s)${blockedCount > 0 ? `, ${blockedCount} bloqué(s)` : ''}.`
    });

  } catch (error) {
    console.error('Error processing scheduled emails:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== TOURNAMENT RESULTS EMAILS ====================

// Get tournament results with participant emails
router.get('/tournament-results/:id', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { id } = req.params;

  try {
    // Get tournament details with category info
    const tournament = await new Promise((resolve, reject) => {
      db.get(`
        SELECT t.*, c.display_name, c.game_type, c.level
        FROM tournaments t
        JOIN categories c ON t.category_id = c.id
        WHERE t.id = $1
      `, [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!tournament) {
      return res.status(404).json({ error: 'Tournoi non trouvé' });
    }

    // Find the matching tournoi_ext based on mode, category and date
    // This allows us to get the email from the inscription for THIS specific tournament
    const matchingTournoi = await new Promise((resolve, reject) => {
      db.get(`
        SELECT te.tournoi_id
        FROM tournoi_ext te
        WHERE UPPER(REPLACE(te.mode, ' ', '')) = UPPER(REPLACE($1, ' ', ''))
          AND UPPER(REPLACE(te.categorie, ' ', '')) = UPPER(REPLACE($2, ' ', ''))
          AND DATE(te.debut) = DATE($3)
        LIMIT 1
      `, [tournament.game_type, tournament.level, tournament.tournament_date], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    // Get tournament results with emails
    // Priority: 1) Email from inscription for THIS tournament, 2) Email from players table, 3) Email from player_contacts
    const results = await new Promise((resolve, reject) => {
      db.all(`
        SELECT tr.*,
               COALESCE(
                 CASE WHEN insc.email IS NOT NULL AND insc.email != '' AND insc.email LIKE '%@%' THEN insc.email END,
                 CASE WHEN p.email IS NOT NULL AND p.email != '' AND p.email LIKE '%@%' THEN p.email END,
                 CASE WHEN pc.email IS NOT NULL AND pc.email != '' AND pc.email LIKE '%@%' THEN pc.email END
               ) as email,
               pc.first_name as contact_first_name,
               pc.last_name as contact_last_name
        FROM tournament_results tr
        LEFT JOIN players p ON REPLACE(tr.licence, ' ', '') = REPLACE(p.licence, ' ', '')
        LEFT JOIN player_contacts pc ON REPLACE(tr.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
        LEFT JOIN inscriptions insc ON REPLACE(tr.licence, ' ', '') = REPLACE(insc.licence, ' ', '')
          AND insc.tournoi_id = $2
        WHERE tr.tournament_id = $1
        ORDER BY tr.position ASC
      `, [id, matchingTournoi?.tournoi_id || -1], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Get ranking data for this mode/category (use stored rank_position)
    const rankings = await new Promise((resolve, reject) => {
      db.all(`
        SELECT r.*, p.first_name, p.last_name,
               COALESCE(p.first_name || ' ' || p.last_name, r.licence) as player_name,
               COALESCE(
                 CASE WHEN p.email IS NOT NULL AND p.email != '' AND p.email LIKE '%@%' THEN p.email END,
                 CASE WHEN pc.email IS NOT NULL AND pc.email != '' AND pc.email LIKE '%@%' THEN pc.email END
               ) as email
        FROM rankings r
        LEFT JOIN players p ON REPLACE(r.licence, ' ', '') = REPLACE(p.licence, ' ', '')
        LEFT JOIN player_contacts pc ON REPLACE(r.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
        WHERE r.season = $1 AND r.category_id = $2
        ORDER BY r.rank_position ASC
      `, [tournament.season, tournament.category_id], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    const emailCount = results.filter(r => r.email && r.email.includes('@')).length;

    res.json({
      tournament,
      results: results.map((r, idx) => ({
        position: idx + 1,
        player_name: r.player_name,
        licence: r.licence,
        points: r.points,
        email: r.email
      })),
      rankings: rankings.map(r => ({
        position: r.rank_position,
        player_name: r.player_name,
        licence: r.licence,
        total_points: r.total_match_points,
        email: r.email
      })),
      emailCount
    });

  } catch (error) {
    console.error('Error fetching tournament results:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send tournament results email to all participants
router.post('/send-results', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { tournamentId, introText, outroText, imageUrl, testMode, testEmail, ccEmail } = req.body;

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({
      error: 'Email non configuré. Veuillez définir RESEND_API_KEY.'
    });
  }

  // Validate test mode
  if (testMode && (!testEmail || !testEmail.includes('@'))) {
    return res.status(400).json({ error: 'Email de test invalide.' });
  }

  try {
    // Get tournament details with category info
    const tournament = await new Promise((resolve, reject) => {
      db.get(`
        SELECT t.*, c.display_name, c.game_type, c.level
        FROM tournaments t
        JOIN categories c ON t.category_id = c.id
        WHERE t.id = $1
      `, [tournamentId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!tournament) {
      return res.status(404).json({ error: 'Tournoi non trouvé' });
    }

    // Find the matching tournoi_ext based on mode, category and date
    // This allows us to get the email from the inscription for THIS specific tournament
    const matchingTournoi = await new Promise((resolve, reject) => {
      db.get(`
        SELECT te.tournoi_id
        FROM tournoi_ext te
        WHERE UPPER(te.mode) = UPPER($1)
          AND UPPER(te.categorie) = UPPER($2)
          AND DATE(te.debut) = DATE($3)
        LIMIT 1
      `, [tournament.game_type, tournament.level, tournament.tournament_date], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    console.log('Matching tournoi_ext for results email:', matchingTournoi,
                'mode:', tournament.game_type, 'cat:', tournament.level, 'date:', tournament.tournament_date);

    // Get tournament results with emails
    // Priority: 1) Email from inscription for THIS tournament, 2) Email from player_contacts
    const results = await new Promise((resolve, reject) => {
      db.all(`
        SELECT tr.*,
               COALESCE(insc.email, pc.email) as email,
               pc.first_name, pc.last_name,
               COALESCE(pc.first_name || ' ' || pc.last_name, tr.player_name) as display_name
        FROM tournament_results tr
        LEFT JOIN player_contacts pc ON REPLACE(tr.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
        LEFT JOIN inscriptions insc ON REPLACE(tr.licence, ' ', '') = REPLACE(insc.licence, ' ', '')
          AND insc.tournoi_id = $2
          AND insc.email IS NOT NULL AND insc.email != '' AND insc.email LIKE '%@%'
        WHERE tr.tournament_id = $1
        ORDER BY tr.position ASC
      `, [tournamentId, matchingTournoi?.tournoi_id || -1], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Get general rankings for this category (use stored rank_position)
    const rankings = await new Promise((resolve, reject) => {
      db.all(`
        SELECT r.*, p.first_name as rank_first_name, p.last_name as rank_last_name,
               COALESCE(p.first_name || ' ' || p.last_name, r.licence) as player_name,
               pc.email
        FROM rankings r
        LEFT JOIN players p ON REPLACE(r.licence, ' ', '') = REPLACE(p.licence, ' ', '')
        LEFT JOIN player_contacts pc ON REPLACE(r.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
        WHERE r.season = $1 AND r.category_id = $2
        ORDER BY r.rank_position ASC
      `, [tournament.season, tournament.category_id], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Build results HTML table
    const resultsTableHtml = `
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
        <thead>
          <tr style="background: #1F4788; color: white;">
            <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Pos</th>
            <th style="padding: 12px; text-align: left; border: 1px solid #ddd;">Joueur</th>
            <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Total Pts Match</th>
            <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Moyenne</th>
          </tr>
        </thead>
        <tbody>
          {{RESULTS_ROWS}}
        </tbody>
      </table>
    `;

    // Build rankings HTML table
    const rankingsTableHtml = `
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
        <thead>
          <tr style="background: #28a745; color: white;">
            <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Pos</th>
            <th style="padding: 12px; text-align: left; border: 1px solid #ddd;">Joueur</th>
            <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Total Pts Match</th>
            <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Moyenne</th>
          </tr>
        </thead>
        <tbody>
          {{RANKINGS_ROWS}}
        </tbody>
      </table>
    `;

    const sentResults = { sent: [], failed: [], skipped: [] };
    const tournamentDate = tournament.tournament_date ? new Date(tournament.tournament_date).toLocaleDateString('fr-FR') : '';

    // Create campaign record with tracking info
    const campaignId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO email_campaigns (subject, body, template_key, recipients_count, status, campaign_type, mode, category, tournament_id, sent_by, test_mode)
         VALUES ($1, $2, 'tournament_results', $3, 'sending', 'tournament_results', $4, $5, $6, $7, $8)
         RETURNING id`,
        [`Résultats - ${tournament.display_name}`, introText, results.filter(r => r.email).length,
         tournament.game_type, tournament.level, tournamentId, req.user?.username || 'unknown', testMode ? true : false],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    // Check if there are results
    if (results.length === 0) {
      return res.status(400).json({ error: 'Aucun résultat trouvé pour ce tournoi.' });
    }

    // In test mode, only send to the test email using first participant data
    const participantsToEmail = testMode ? [{ ...results[0], email: testEmail }] : results;

    // Get configurable contact email
    const contactEmail = await getContactEmail();
    const contactPhraseHtml = buildContactPhraseHtml(contactEmail);

    // Send email to each participant with email
    for (const participant of participantsToEmail) {
      if (!participant.email || !participant.email.includes('@')) {
        sentResults.skipped.push({
          name: participant.player_name,
          reason: 'Email invalide ou manquant'
        });
        continue;
      }

      try {
        // Build personalized results table (highlight current player)
        const resultsRows = results.map(r => {
          const isCurrentPlayer = r.licence === participant.licence;
          const bgColor = isCurrentPlayer ? '#FFF3CD' : (r.position % 2 === 0 ? '#f8f9fa' : 'white');
          const fontWeight = isCurrentPlayer ? 'bold' : 'normal';
          const arrow = isCurrentPlayer ? '▶ ' : '';
          // Calculate moyenne from points/reprises (Moyenne R), not the stored CSV value
          const moyenne = r.reprises > 0 ? (r.points / r.reprises).toFixed(3) : '-';
          return `
            <tr style="background: ${bgColor};">
              <td style="padding: 10px; text-align: center; border: 1px solid #ddd; font-weight: ${fontWeight};">${r.position}</td>
              <td style="padding: 10px; text-align: left; border: 1px solid #ddd; font-weight: ${fontWeight};">${arrow}${r.display_name}</td>
              <td style="padding: 10px; text-align: center; border: 1px solid #ddd; font-weight: ${fontWeight};">${r.match_points || '-'}</td>
              <td style="padding: 10px; text-align: center; border: 1px solid #ddd; font-weight: ${fontWeight};">${moyenne}</td>
            </tr>
          `;
        }).join('');

        // Build personalized rankings table (highlight current player)
        const rankingsRows = rankings.map(r => {
          const isCurrentPlayer = r.licence === participant.licence;
          const bgColor = isCurrentPlayer ? '#FFF3CD' : (r.rank_position % 2 === 0 ? '#f8f9fa' : 'white');
          const fontWeight = isCurrentPlayer ? 'bold' : 'normal';
          const arrow = isCurrentPlayer ? '▶ ' : '';
          const avgMoyenne = r.avg_moyenne ? r.avg_moyenne.toFixed(3) : '-';
          return `
            <tr style="background: ${bgColor};">
              <td style="padding: 10px; text-align: center; border: 1px solid #ddd; font-weight: ${fontWeight};">${r.rank_position}</td>
              <td style="padding: 10px; text-align: left; border: 1px solid #ddd; font-weight: ${fontWeight};">${arrow}${r.player_name}</td>
              <td style="padding: 10px; text-align: center; border: 1px solid #ddd; font-weight: ${fontWeight};">${r.total_match_points || '-'}</td>
              <td style="padding: 10px; text-align: center; border: 1px solid #ddd; font-weight: ${fontWeight};">${avgMoyenne}</td>
            </tr>
          `;
        }).join('');

        // Find player position in rankings (use stored rank_position)
        const playerRanking = rankings.find(r => r.licence === participant.licence);
        const playerRankingPosition = playerRanking ? playerRanking.rank_position : '-';

        // Determine qualification status for the final
        // Rule: < 9 players → 4 qualified, >= 9 players → 6 qualified
        const qualifiedCount = rankings.length < 9 ? 4 : 6;
        const isQualified = playerRanking && playerRanking.rank_position <= qualifiedCount;
        const isFinalTournament = tournament.tournament_number === 3;

        let qualificationMessage;
        if (isFinalTournament) {
          // After T3: definitive selection
          qualificationMessage = isQualified
            ? `<p style="margin-top: 20px; padding: 15px; background: #d4edda; border-left: 4px solid #28a745; color: #155724;">
                🎉 <strong>Félicitations ! Vous êtes sélectionné(e) pour la finale départementale !</strong>
              </p>`
            : `<p style="margin-top: 20px; padding: 15px; background: #f8d7da; border-left: 4px solid #dc3545; color: #721c24;">
                Malheureusement, vous n'êtes pas sélectionné(e) pour la finale départementale.
              </p>`;
        } else {
          // After T1 or T2: provisional status
          qualificationMessage = isQualified
            ? `<p style="margin-top: 20px; padding: 15px; background: #d4edda; border-left: 4px solid #28a745; color: #155724;">
                ✅ <strong>Vous êtes à ce stade de la compétition éligible pour la finale départementale.</strong>
              </p>`
            : `<p style="margin-top: 20px; padding: 15px; background: #fff3cd; border-left: 4px solid #ffc107; color: #856404;">
                Malheureusement, vous n'êtes pas, à ce stade de la compétition, éligible pour la finale départementale.
              </p>`;
        }

        // Replace template variables
        const personalizedIntro = introText
          .replace(/\{first_name\}/g, participant.first_name || participant.player_name.split(' ')[0] || '')
          .replace(/\{last_name\}/g, participant.last_name || '')
          .replace(/\{tournament_name\}/g, tournament.display_name)
          .replace(/\{tournament_date\}/g, tournamentDate)
          .replace(/\{tournament_lieu\}/g, tournament.location || '')
          .replace(/\{player_position\}/g, participant.position)
          .replace(/\{player_points\}/g, participant.points || '-')
          .replace(/\{ranking_position\}/g, playerRankingPosition || '-');

        const personalizedOutro = outroText
          .replace(/\{first_name\}/g, participant.first_name || '')
          .replace(/\{last_name\}/g, participant.last_name || '');

        // Build optional image HTML
        const imageHtml = imageUrl ? `<div style="text-align: center; margin: 20px 0;"><img src="${imageUrl}" alt="Image" style="max-width: 100%; height: auto; border-radius: 8px;"></div>` : '';

        // Build final email HTML
        const emailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
            <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
              <img src="${baseUrl}/logo.png" alt="Logo" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
              <h1 style="margin: 0; font-size: 24px;">${await appSettings.get('organization_name') || 'Comité Départemental de Billard'}</h1>
              <p style="margin: 10px 0 0 0; opacity: 0.9;">Résultats - ${tournament.display_name}</p>
              <p style="margin: 5px 0 0 0; opacity: 0.8; font-size: 14px;">${tournamentDate}${tournament.location ? ' - ' + tournament.location : ''}</p>
            </div>
            <div style="padding: 20px; background: #f8f9fa; line-height: 1.6;">
              ${imageHtml}
              <p>${convertEmailsToMailtoLinks(personalizedIntro.replace(/\n/g, '<br>'))}</p>

              <h3 style="color: #1F4788; margin-top: 30px;">Résultats du Tournoi</h3>
              ${resultsTableHtml.replace('{{RESULTS_ROWS}}', resultsRows)}

              <p style="margin-top: 30px; font-style: italic; color: #555;">Après les rencontres ci-dessus, le classement général pour la finale départementale est le suivant :</p>

              <h3 style="color: #28a745; margin-top: 15px;">Classement Général ${tournament.display_name}</h3>
              ${rankingsTableHtml.replace('{{RANKINGS_ROWS}}', rankingsRows)}

              ${qualificationMessage}

              ${contactPhraseHtml}
              <p style="margin-top: 30px;">${convertEmailsToMailtoLinks(personalizedOutro.replace(/\n/g, '<br>'))}</p>
            </div>
            <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">
              <p style="margin: 0;">CDBHS - <a href="mailto:${contactEmail}" style="color: white;">${contactEmail}</a></p>
            </div>
          </div>
        `;

        const emailOptions = {
          from: 'CDBHS <noreply@cdbhs.net>',
          replyTo: contactEmail,
          to: [participant.email],
          subject: `Résultats - ${tournament.display_name} - ${tournamentDate}`,
          html: emailHtml
        };

        // CC removed from individual emails - summary email sent at the end instead

        await resend.emails.send(emailOptions);

        sentResults.sent.push({
          name: participant.player_name,
          email: participant.email
        });

        // Update last_contacted
        await new Promise((resolve) => {
          db.run(
            'UPDATE player_contacts SET last_contacted = CURRENT_TIMESTAMP WHERE REPLACE(licence, \' \', \'\') = $1',
            [participant.licence.replace(/ /g, '')],
            () => resolve()
          );
        });

        await delay(1500);

      } catch (error) {
        console.error(`Error sending results to ${participant.email}:`, error);
        sentResults.failed.push({
          name: participant.player_name,
          email: participant.email,
          error: error.message
        });
      }
    }

    // Update campaign record
    await new Promise((resolve) => {
      db.run(
        `UPDATE email_campaigns
         SET sent_count = $1, failed_count = $2, status = 'completed', sent_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [sentResults.sent.length, sentResults.failed.length, campaignId],
        () => resolve()
      );
    });

    // Send summary email to CC address (if provided and not in test mode)
    if (ccEmail && ccEmail.includes('@') && !testMode && sentResults.sent.length > 0) {
      try {
        // Build recipient list HTML
        const recipientListHtml = sentResults.sent.map((r, idx) =>
          `<tr style="background: ${idx % 2 === 0 ? 'white' : '#f8f9fa'};">
            <td style="padding: 8px; border: 1px solid #ddd;">${idx + 1}</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${r.name}</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${r.email}</td>
          </tr>`
        ).join('');

        // Build full results table for summary
        const fullResultsRows = results.map(r => {
          const moyenne = r.reprises > 0 ? (r.points / r.reprises).toFixed(3) : '-';
          return `
            <tr style="background: ${r.position % 2 === 0 ? '#f8f9fa' : 'white'};">
              <td style="padding: 8px; text-align: center; border: 1px solid #ddd;">${r.position}</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${r.display_name}</td>
              <td style="padding: 8px; text-align: center; border: 1px solid #ddd;">${r.match_points || '-'}</td>
              <td style="padding: 8px; text-align: center; border: 1px solid #ddd;">${moyenne}</td>
            </tr>
          `;
        }).join('');

        const summaryHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
            <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
              <img src="${baseUrl}/logo.png" alt="Logo" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
              <h1 style="margin: 0; font-size: 24px;">${await appSettings.get('organization_name') || 'Comité Départemental de Billard'}</h1>
              <p style="margin: 10px 0 0 0; opacity: 0.9;">📋 Récapitulatif Envoi Résultats - ${tournament.display_name}</p>
            </div>
            <div style="padding: 20px; background: #f8f9fa; line-height: 1.6;">
              <div style="background: #d4edda; border-left: 4px solid #28a745; padding: 15px; margin-bottom: 20px;">
                <strong>✅ Envoi terminé avec succès</strong><br>
                ${sentResults.sent.length} email(s) envoyé(s) sur ${results.length} participant(s)
                ${sentResults.failed.length > 0 ? `<br><span style="color: #dc3545;">${sentResults.failed.length} échec(s)</span>` : ''}
                ${sentResults.skipped.length > 0 ? `<br><span style="color: #856404;">${sentResults.skipped.length} ignoré(s) (pas d'email)</span>` : ''}
              </div>

              <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ddd;">
                <h3 style="margin-top: 0; color: #1F4788;">📍 Informations du Tournoi</h3>
                <p><strong>Tournoi :</strong> ${tournament.display_name}</p>
                <p><strong>Date :</strong> ${tournamentDate}</p>
                <p><strong>Lieu :</strong> ${tournament.location || '-'}</p>
              </div>

              <h3 style="color: #1F4788;">📧 Liste des Destinataires (${sentResults.sent.length})</h3>
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

              <h3 style="color: #28a745;">🏆 Résultats du Tournoi</h3>
              <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                  <tr style="background: #28a745; color: white;">
                    <th style="padding: 10px; border: 1px solid #ddd;">Pos</th>
                    <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Joueur</th>
                    <th style="padding: 10px; border: 1px solid #ddd;">Pts Match</th>
                    <th style="padding: 10px; border: 1px solid #ddd;">Moyenne</th>
                  </tr>
                </thead>
                <tbody>
                  ${fullResultsRows}
                </tbody>
              </table>
            </div>
            <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">
              <p style="margin: 0;">CDBHS - <a href="mailto:${contactEmail}" style="color: white;">${contactEmail}</a></p>
            </div>
          </div>
        `;

        await resend.emails.send({
          from: 'CDBHS <noreply@cdbhs.net>',
          replyTo: contactEmail,
          to: [ccEmail],
          subject: `📋 Récapitulatif - Résultats ${tournament.display_name} - ${tournamentDate}`,
          html: summaryHtml
        });

        console.log(`Summary email sent to ${ccEmail}`);
      } catch (summaryError) {
        console.error('Error sending summary email:', summaryError);
        // Don't fail the whole operation if summary email fails
      }
    }

    const message = testMode
      ? `Email de test envoyé à ${testEmail}`
      : `Résultats envoyés: ${sentResults.sent.length}, Échecs: ${sentResults.failed.length}, Ignorés: ${sentResults.skipped.length}${ccEmail ? ' + récapitulatif envoyé' : ''}`;

    // Mark tournament results as sent (only if not test mode and at least one email was sent)
    if (!testMode && sentResults.sent.length > 0) {
      await new Promise((resolve) => {
        db.run(
          `UPDATE tournaments SET results_email_sent = $1, results_email_sent_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [true, tournamentId],
          () => resolve()
        );
      });
    }

    // Log results email send
    if (!testMode) {
      logAdminAction({
        req,
        action: ACTION_TYPES.SEND_RESULTS,
        details: `Résultats ${tournament.display_name} - ${sentResults.sent.length} envoyés`,
        targetType: 'tournament',
        targetId: tournamentId,
        targetName: tournament.display_name
      });
    }

    res.json({
      success: true,
      message,
      results: sentResults,
      testMode
    });

  } catch (error) {
    console.error('Error sending tournament results:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== FINALES & FINALISTS ====================

// Get finales for current season (tournament_number = 4 or contains "FINALE" in name)
router.get('/finales', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  // Calculate current season dates
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  let seasonStart, seasonEnd;
  if (currentMonth >= 8) {
    seasonStart = `${currentYear}-09-01`;
    seasonEnd = `${currentYear + 1}-06-30`;
  } else {
    seasonStart = `${currentYear - 1}-09-01`;
    seasonEnd = `${currentYear}-06-30`;
  }

  db.all(
    `SELECT t.tournoi_id, t.nom, t.mode, t.categorie, t.debut, t.fin, t.lieu,
            (SELECT COUNT(*) FROM inscriptions i WHERE i.tournoi_id = t.tournoi_id AND i.forfait != 1) as nb_inscrits
     FROM tournoi_ext t
     WHERE (t.debut >= $1 AND t.debut <= $2)
       AND (UPPER(t.nom) LIKE '%FINALE%' OR UPPER(t.nom) LIKE '%FINAL%')
     ORDER BY t.debut ASC, t.mode, t.categorie`,
    [seasonStart, seasonEnd],
    (err, rows) => {
      if (err) {
        console.error('Error fetching finales:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

// Get finalists for a specific finale (qualified players from ranking after T3)
router.get('/finalists/:finaleId', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { finaleId } = req.params;

  try {
    // Get the finale details to determine mode/category
    const finale = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM tournoi_ext WHERE tournoi_id = $1`,
        [finaleId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!finale) {
      return res.status(404).json({ error: 'Finale non trouvée' });
    }

    // Determine the season from finale date
    const finaleDate = new Date(finale.debut);
    const finaleYear = finaleDate.getFullYear();
    const finaleMonth = finaleDate.getMonth();

    let season;
    if (finaleMonth >= 8) {
      season = `${finaleYear}-${finaleYear + 1}`;
    } else {
      season = `${finaleYear - 1}-${finaleYear}`;
    }

    // Find the category in our system
    // Map mode: LIBRE, CADRE, BANDE, 3BANDES
    // Map category: N3, R1, R2, R3, etc.
    // Normalize mode: remove spaces and accents for comparison
    const mode = finale.mode.toUpperCase().replace(/\s+/g, '');
    const categoryLevel = finale.categorie.toUpperCase();

    // Find matching category (compare without spaces)
    const category = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM categories
         WHERE UPPER(REPLACE(game_type, ' ', '')) = $1
           AND (UPPER(level) = $2 OR UPPER(level) LIKE $3)`,
        [mode, categoryLevel, categoryLevel + '%'],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!category) {
      return res.status(404).json({ error: `Catégorie non trouvée: ${mode} - ${categoryLevel}` });
    }

    // Get rankings for this category/season (final ranking after T3)
    const rankings = await new Promise((resolve, reject) => {
      db.all(
        `SELECT r.*,
                p.first_name, p.last_name,
                COALESCE(p.first_name || ' ' || p.last_name, r.licence) as player_name,
                pc.email, pc.telephone
         FROM rankings r
         LEFT JOIN players p ON REPLACE(r.licence, ' ', '') = REPLACE(p.licence, ' ', '')
         LEFT JOIN player_contacts pc ON REPLACE(r.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
         WHERE r.season = $1 AND r.category_id = $2
         ORDER BY r.rank_position ASC`,
        [season, category.id],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // Determine qualified count: <9 players → 4 qualified, >=9 players → 6 qualified
    const totalPlayers = rankings.length;
    const qualifiedCount = totalPlayers < 9 ? 4 : 6;

    // Get only qualified players (top N)
    const finalists = rankings
      .filter(r => r.rank_position <= qualifiedCount)
      .map(r => ({
        licence: r.licence,
        player_name: r.player_name,
        first_name: r.first_name,
        last_name: r.last_name,
        rank_position: r.rank_position,
        total_match_points: r.total_match_points,
        avg_moyenne: r.avg_moyenne,
        email: r.email,
        telephone: r.telephone
      }));

    const emailCount = finalists.filter(f => f.email && f.email.includes('@')).length;

    res.json({
      finale: {
        tournoi_id: finale.tournoi_id,
        nom: finale.nom,
        mode: finale.mode,
        categorie: finale.categorie,
        date: finale.debut,
        lieu: finale.lieu
      },
      category: {
        id: category.id,
        display_name: category.display_name,
        game_type: category.game_type,
        level: category.level
      },
      season,
      totalPlayers,
      qualifiedCount,
      finalists,
      emailCount
    });

  } catch (error) {
    console.error('Error fetching finalists:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send finale convocation emails to finalists
router.post('/send-finale-convocation', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { finaleId, finaleHeure, introText, outroText, imageUrl, testMode, testEmail, ccEmail } = req.body;

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({
      error: 'Email non configuré. Veuillez définir RESEND_API_KEY.'
    });
  }

  if (testMode && (!testEmail || !testEmail.includes('@'))) {
    return res.status(400).json({ error: 'Email de test invalide.' });
  }

  try {
    // Get finale details
    const finale = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM tournoi_ext WHERE tournoi_id = $1`, [finaleId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!finale) {
      return res.status(404).json({ error: 'Finale non trouvée' });
    }

    // Determine season
    const finaleDate = new Date(finale.debut);
    const finaleYear = finaleDate.getFullYear();
    const finaleMonth = finaleDate.getMonth();
    const season = finaleMonth >= 8 ? `${finaleYear}-${finaleYear + 1}` : `${finaleYear - 1}-${finaleYear}`;

    // Find category (normalize mode: remove spaces for comparison)
    const mode = finale.mode.toUpperCase().replace(/\s+/g, '');
    const categoryLevel = finale.categorie.toUpperCase();

    const category = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM categories WHERE UPPER(REPLACE(game_type, ' ', '')) = $1 AND (UPPER(level) = $2 OR UPPER(level) LIKE $3)`,
        [mode, categoryLevel, categoryLevel + '%'],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!category) {
      return res.status(404).json({ error: `Catégorie non trouvée: ${mode} - ${categoryLevel}` });
    }

    // Get finalists
    const rankings = await new Promise((resolve, reject) => {
      db.all(
        `SELECT r.*, p.first_name, p.last_name,
                COALESCE(p.first_name || ' ' || p.last_name, r.licence) as player_name,
                pc.email, pc.telephone
         FROM rankings r
         LEFT JOIN players p ON REPLACE(r.licence, ' ', '') = REPLACE(p.licence, ' ', '')
         LEFT JOIN player_contacts pc ON REPLACE(r.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
         WHERE r.season = $1 AND r.category_id = $2
         ORDER BY r.rank_position ASC`,
        [season, category.id],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    const qualifiedCount = rankings.length < 9 ? 4 : 6;
    const finalists = rankings.filter(r => r.rank_position <= qualifiedCount);

    if (finalists.length === 0) {
      return res.status(400).json({ error: 'Aucun finaliste trouvé' });
    }

    const sentResults = { sent: [], failed: [], skipped: [] };
    const finaleFormattedDate = finale.debut ? new Date(finale.debut).toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '';

    // Create campaign record with tracking info
    const campaignId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO email_campaigns (subject, body, template_key, recipients_count, status, campaign_type, mode, category, tournament_id, sent_by, test_mode)
         VALUES ($1, $2, 'finale_convocation', $3, 'sending', 'finale_convocation', $4, $5, $6, $7, $8)
         RETURNING id`,
        [`Convocation Finale - ${category.display_name}`, introText, finalists.filter(f => f.email).length,
         finale.mode, finale.categorie, finaleId, req.user?.username || 'unknown', testMode ? true : false],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    // In test mode, send to test email only
    const participantsToEmail = testMode ? [{ ...finalists[0], email: testEmail }] : finalists;

    // Get configurable contact email
    const contactEmail = await getContactEmail();
    const contactPhraseHtml = buildContactPhraseHtml(contactEmail);

    for (const finalist of participantsToEmail) {
      if (!finalist.email || !finalist.email.includes('@')) {
        sentResults.skipped.push({
          name: finalist.player_name,
          reason: 'Email invalide ou manquant'
        });
        continue;
      }

      try {
        // Build finalists table for email
        const finalistsTableRows = finalists.map(f => {
          const isCurrentPlayer = f.licence === finalist.licence;
          const bgColor = isCurrentPlayer ? '#FFF3CD' : (f.rank_position % 2 === 0 ? '#f8f9fa' : 'white');
          const fontWeight = isCurrentPlayer ? 'bold' : 'normal';
          const arrow = isCurrentPlayer ? '▶ ' : '';
          return `
            <tr style="background: ${bgColor};">
              <td style="padding: 10px; text-align: center; border: 1px solid #ddd; font-weight: ${fontWeight};">${f.rank_position}</td>
              <td style="padding: 10px; text-align: left; border: 1px solid #ddd; font-weight: ${fontWeight};">${arrow}${f.player_name}</td>
              <td style="padding: 10px; text-align: center; border: 1px solid #ddd; font-weight: ${fontWeight};">${f.total_match_points || '-'}</td>
              <td style="padding: 10px; text-align: center; border: 1px solid #ddd; font-weight: ${fontWeight};">${f.avg_moyenne ? f.avg_moyenne.toFixed(3) : '-'}</td>
            </tr>
          `;
        }).join('');

        const finalistsTableHtml = `
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
            <thead>
              <tr style="background: #28a745; color: white;">
                <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Pos</th>
                <th style="padding: 12px; text-align: left; border: 1px solid #ddd;">Joueur</th>
                <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Total Pts Match</th>
                <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Moyenne</th>
              </tr>
            </thead>
            <tbody>
              ${finalistsTableRows}
            </tbody>
          </table>
        `;

        // Replace template variables
        const personalizedIntro = introText
          .replace(/\{first_name\}/g, finalist.first_name || finalist.player_name.split(' ')[0] || '')
          .replace(/\{last_name\}/g, finalist.last_name || '')
          .replace(/\{player_name\}/g, finalist.player_name || '')
          .replace(/\{finale_name\}/g, finale.nom || '')
          .replace(/\{finale_date\}/g, finaleFormattedDate)
          .replace(/\{finale_heure\}/g, finaleHeure || '')
          .replace(/\{finale_lieu\}/g, finale.lieu || '')
          .replace(/\{category\}/g, category.display_name || '')
          .replace(/\{rank_position\}/g, finalist.rank_position || '');

        const personalizedOutro = outroText
          .replace(/\{first_name\}/g, finalist.first_name || '')
          .replace(/\{last_name\}/g, finalist.last_name || '');

        const imageHtml = imageUrl ? `<div style="text-align: center; margin: 20px 0;"><img src="${imageUrl}" alt="Image" style="max-width: 100%; height: auto; border-radius: 8px;"></div>` : '';

        // Base URL for ICS calendar link
        const baseUrl = process.env.BASE_URL || 'https://cdbhs-tournament-management-production.up.railway.app';

        const emailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
            <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
              <img src="${baseUrl}/logo.png" alt="CDBHS" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
              <h1 style="margin: 0; font-size: 24px;">🏆 Convocation Finale Départementale</h1>
              <p style="margin: 10px 0 0 0; opacity: 0.9;">${category.display_name}</p>
            </div>
            <div style="padding: 20px; background: #f8f9fa; line-height: 1.6;">
              ${imageHtml}

              <div style="background: #d4edda; border-left: 4px solid #28a745; padding: 15px; margin-bottom: 20px;">
                <strong>🎉 Félicitations ${finalist.first_name || ''} !</strong><br>
                Vous êtes qualifié(e) pour la finale départementale !
              </div>

              <p>${convertEmailsToMailtoLinks(personalizedIntro.replace(/\n/g, '<br>'))}</p>

              <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0; border: 1px solid #ddd;">
                <h3 style="margin-top: 0; color: #1F4788;">📍 Informations de la Finale</h3>
                <p><strong>Date :</strong> ${finaleFormattedDate}</p>
                <p><strong>Heure :</strong> ${finaleHeure || 'À confirmer'}</p>
                <p><strong>Lieu :</strong> ${finale.lieu || 'À confirmer'}</p>
                <p><strong>Catégorie :</strong> ${category.display_name}</p>
                <p style="margin-top: 15px; text-align: center;">
                  <a href="${baseUrl}/api/player-accounts/tournament/${finale.tournoi_id}/calendar.ics" style="display: inline-block; background: #1F4788; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-size: 14px;">📅 Ajouter à mon calendrier</a>
                </p>
              </div>

              <h3 style="color: #28a745;">Liste des Finalistes</h3>
              ${finalistsTableHtml}

              ${contactPhraseHtml}
              <p style="margin-top: 30px;">${convertEmailsToMailtoLinks(personalizedOutro.replace(/\n/g, '<br>'))}</p>
            </div>
            <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">
              <p style="margin: 0;">CDBHS - <a href="mailto:${contactEmail}" style="color: white;">${contactEmail}</a></p>
            </div>
          </div>
        `;

        const emailOptions = {
          from: 'CDBHS <noreply@cdbhs.net>',
          replyTo: contactEmail,
          to: [finalist.email],
          subject: `🏆 Convocation Finale - ${category.display_name} - ${finaleFormattedDate}`,
          html: emailHtml
        };

        // CC removed from individual emails - summary email sent at the end instead

        await resend.emails.send(emailOptions);

        sentResults.sent.push({
          name: finalist.player_name,
          email: finalist.email
        });

        await new Promise((resolve) => {
          db.run(
            'UPDATE player_contacts SET last_contacted = CURRENT_TIMESTAMP WHERE REPLACE(licence, \' \', \'\') = $1',
            [finalist.licence.replace(/ /g, '')],
            () => resolve()
          );
        });

        await delay(1500);

      } catch (error) {
        console.error(`Error sending finale convocation to ${finalist.email}:`, error);
        sentResults.failed.push({
          name: finalist.player_name,
          email: finalist.email,
          error: error.message
        });
      }
    }

    // Update campaign
    await new Promise((resolve) => {
      db.run(
        `UPDATE email_campaigns SET sent_count = $1, failed_count = $2, status = 'completed', sent_at = CURRENT_TIMESTAMP WHERE id = $3`,
        [sentResults.sent.length, sentResults.failed.length, campaignId],
        () => resolve()
      );
    });

    // Send summary email to CC address (if provided and not in test mode)
    if (ccEmail && ccEmail.includes('@') && !testMode && sentResults.sent.length > 0) {
      try {
        // Build recipient list HTML
        const recipientListHtml = sentResults.sent.map((r, idx) =>
          `<tr style="background: ${idx % 2 === 0 ? 'white' : '#f8f9fa'};">
            <td style="padding: 8px; border: 1px solid #ddd;">${idx + 1}</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${r.name}</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${r.email}</td>
          </tr>`
        ).join('');

        // Build finalists table for summary
        const finalistsTableRows = finalists.map(f =>
          `<tr style="background: ${f.rank_position % 2 === 0 ? '#f8f9fa' : 'white'};">
            <td style="padding: 8px; text-align: center; border: 1px solid #ddd;">${f.rank_position}</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${f.player_name}</td>
            <td style="padding: 8px; text-align: center; border: 1px solid #ddd;">${f.total_match_points || '-'}</td>
            <td style="padding: 8px; text-align: center; border: 1px solid #ddd;">${f.avg_moyenne ? f.avg_moyenne.toFixed(3) : '-'}</td>
            <td style="padding: 8px; text-align: center; border: 1px solid #ddd;">${f.email ? '✅' : '❌'}</td>
          </tr>`
        ).join('');

        const summaryHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
            <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
              <img src="${baseUrl}/logo.png" alt="Logo" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
              <h1 style="margin: 0; font-size: 24px;">${await appSettings.get('organization_name') || 'Comité Départemental de Billard'}</h1>
              <p style="margin: 10px 0 0 0; opacity: 0.9;">📋 Récapitulatif Convocations Finale - ${category.display_name}</p>
            </div>
            <div style="padding: 20px; background: #f8f9fa; line-height: 1.6;">
              <div style="background: #d4edda; border-left: 4px solid #28a745; padding: 15px; margin-bottom: 20px;">
                <strong>✅ Envoi terminé avec succès</strong><br>
                ${sentResults.sent.length} convocation(s) envoyée(s) sur ${finalists.length} finaliste(s)
                ${sentResults.failed.length > 0 ? `<br><span style="color: #dc3545;">${sentResults.failed.length} échec(s)</span>` : ''}
                ${sentResults.skipped.length > 0 ? `<br><span style="color: #856404;">${sentResults.skipped.length} ignoré(s) (pas d'email)</span>` : ''}
              </div>

              <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ddd;">
                <h3 style="margin-top: 0; color: #1F4788;">📍 Informations de la Finale</h3>
                <p><strong>Finale :</strong> ${finale.nom}</p>
                <p><strong>Catégorie :</strong> ${category.display_name}</p>
                <p><strong>Date :</strong> ${finaleFormattedDate}</p>
                <p><strong>Lieu :</strong> ${finale.lieu || 'À confirmer'}</p>
              </div>

              <h3 style="color: #1F4788;">📧 Convocations Envoyées (${sentResults.sent.length})</h3>
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

              <h3 style="color: #28a745;">🏆 Liste des Finalistes</h3>
              <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                  <tr style="background: #28a745; color: white;">
                    <th style="padding: 10px; border: 1px solid #ddd;">Pos</th>
                    <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Joueur</th>
                    <th style="padding: 10px; border: 1px solid #ddd;">Pts Match</th>
                    <th style="padding: 10px; border: 1px solid #ddd;">Moyenne</th>
                    <th style="padding: 10px; border: 1px solid #ddd;">Email</th>
                  </tr>
                </thead>
                <tbody>
                  ${finalistsTableRows}
                </tbody>
              </table>
            </div>
            <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">
              <p style="margin: 0;">CDBHS - <a href="mailto:${contactEmail}" style="color: white;">${contactEmail}</a></p>
            </div>
          </div>
        `;

        await resend.emails.send({
          from: 'CDBHS <noreply@cdbhs.net>',
          replyTo: contactEmail,
          to: [ccEmail],
          subject: `📋 Récapitulatif - Convocations Finale ${category.display_name} - ${finaleFormattedDate}`,
          html: summaryHtml
        });

        console.log(`Summary email sent to ${ccEmail}`);
      } catch (summaryError) {
        console.error('Error sending summary email:', summaryError);
      }
    }

    const message = testMode
      ? `Email de test envoyé à ${testEmail}`
      : `Convocations envoyées: ${sentResults.sent.length}, Échecs: ${sentResults.failed.length}, Ignorés: ${sentResults.skipped.length}${ccEmail ? ' + récapitulatif envoyé' : ''}`;

    res.json({
      success: true,
      message,
      results: sentResults,
      testMode
    });

  } catch (error) {
    console.error('Error sending finale convocations:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CAMPAIGN HISTORY ====================

// Get email campaign history
router.get('/history', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  db.all(
    `SELECT * FROM email_campaigns ORDER BY created_at DESC LIMIT 50`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching campaign history:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

// Update campaign (for editing type)
router.put('/campaigns/:id', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { id } = req.params;
  const { campaign_type } = req.body;

  try {
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE email_campaigns SET campaign_type = $1 WHERE id = $2`,
        [campaign_type, id],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating campaign:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== RELANCES INSCRIPTIONS ====================

// Default templates for relances
const DEFAULT_RELANCE_TEMPLATES = {
  relance_t2: {
    subject: 'Inscription T2 {category} - Confirmez votre participation',
    intro: `Bonjour {first_name},

Vous avez participé au premier tournoi {category} qui s'est déroulé le {t1_date} où vous avez terminé à la {t1_position}ème place.

Le deuxième tournoi de la saison aura lieu le {tournament_date} à {tournament_lieu}.

Pour participer, merci de confirmer votre inscription en répondant à cet email avant le {deadline_date}.`,
    outro: `Pour toute question ou information, écrivez à cdbhs92@gmail.com

Sportivement,
Le Comité Départemental de Billard des Hauts-de-Seine`
  },
  relance_t3: {
    subject: 'Inscription T3 {category} - Confirmez votre participation',
    intro: `Bonjour {first_name},

Vous êtes actuellement classé(e) {rank_position}ème au classement général {category} avec {total_points} points match.

Le troisième et dernier tournoi qualificatif aura lieu le {tournament_date} à {tournament_lieu}.

Ce tournoi est déterminant pour la qualification à la finale départementale. Pour participer, merci de confirmer votre inscription en répondant à cet email avant le {deadline_date}.`,
    outro: `Pour toute question ou information, écrivez à cdbhs92@gmail.com

Sportivement,
Le Comité Départemental de Billard des Hauts-de-Seine`
  },
  relance_finale: {
    subject: 'Confirmation participation Finale {category}',
    intro: `Bonjour {first_name},

Félicitations ! Vous êtes qualifié(e) pour la finale départementale {category} !

Vous avez terminé {rank_position}ème au classement général avec {total_points} points match, ce qui vous place parmi les {qualified_count} finalistes.

La finale aura lieu le {finale_date} à {finale_lieu}.

Merci de confirmer votre participation en répondant à cet email avant le {deadline_date}.`,
    outro: `Nous comptons sur votre présence !

Pour toute question ou information, écrivez à cdbhs92@gmail.com

Sportivement,
Le Comité Départemental de Billard des Hauts-de-Seine`
  }
};

// Get relance templates
router.get('/relance-templates', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  try {
    // Get all relance templates from database
    const templates = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM email_templates WHERE template_key LIKE 'relance_%'`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // Build result with defaults for missing templates
    const result = {};
    for (const key of ['relance_t2', 'relance_t3', 'relance_finale']) {
      const dbTemplate = templates.find(t => t.template_key === key);
      if (dbTemplate) {
        result[key] = {
          subject: dbTemplate.subject_template,
          intro: dbTemplate.body_template,
          outro: dbTemplate.outro_template || DEFAULT_RELANCE_TEMPLATES[key].outro
        };
      } else {
        result[key] = DEFAULT_RELANCE_TEMPLATES[key];
      }
    }

    res.json(result);
  } catch (error) {
    console.error('Error fetching relance templates:', error);
    res.json(DEFAULT_RELANCE_TEMPLATES);
  }
});

// Save relance template
router.put('/relance-templates/:key', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { key } = req.params;
  const { subject, intro, outro } = req.body;

  if (!['relance_t2', 'relance_t3', 'relance_finale'].includes(key)) {
    return res.status(400).json({ error: 'Invalid template key' });
  }

  try {
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO email_templates (template_key, subject_template, body_template, outro_template)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (template_key) DO UPDATE SET
           subject_template = EXCLUDED.subject_template,
           body_template = EXCLUDED.body_template,
           outro_template = EXCLUDED.outro_template,
           updated_at = CURRENT_TIMESTAMP`,
        [key, subject, intro, outro],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error saving relance template:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get next tournament info for relance (T2, T3, or Finale)
router.get('/next-tournament', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { mode, category, relanceType } = req.query;

  if (!mode || !category || !relanceType) {
    return res.status(400).json({ error: 'Mode, category, and relanceType required' });
  }

  try {
    // Get current season
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const season = currentMonth >= 8 ? `${currentYear}-${currentYear + 1}` : `${currentYear - 1}-${currentYear}`;


    // Find the category (flexible match: N3 matches N3 or N3GC)
    const categoryUpper = category.toUpperCase();
    const categoryRow = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM categories WHERE UPPER(game_type) = $1 AND (UPPER(level) = $2 OR UPPER(level) LIKE $3)`,
        [mode.toUpperCase(), categoryUpper, categoryUpper + '%'],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!categoryRow) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Determine which tournament number to look for based on relance type
    let tournamentNumber;
    if (relanceType === 't2') {
      tournamentNumber = 2;
    } else if (relanceType === 't3') {
      tournamentNumber = 3;
    } else if (relanceType === 'finale') {
      tournamentNumber = 4; // Finale is tournament 4
    } else {
      return res.status(400).json({ error: 'Invalid relance type' });
    }

    // Search in tournoi_ext for planned tournaments
    // First get all IONOS mode variations for this game_type from mode_mapping
    const modeMappings = await new Promise((resolve, reject) => {
      db.all(
        'SELECT ionos_mode FROM mode_mapping WHERE game_type = $1',
        [mode],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // Build mode matching condition
    let modeCondition;
    let modeParams = [];
    if (modeMappings.length > 0) {
      const placeholders = modeMappings.map((_, i) => `$${i + 1}`).join(', ');
      modeCondition = `UPPER(mode) IN (${placeholders})`;
      modeParams = modeMappings.map(m => m.ionos_mode.toUpperCase());
    } else {
      modeCondition = 'UPPER(mode) = $1';
      modeParams = [mode.toUpperCase()];
    }

    // Match by mode, category, and name pattern
    // Tournaments can be named "T2", "T3", "TOURNOI 2", "TOURNOI 3", etc.
    let nameCondition;
    if (relanceType === 't2') {
      nameCondition = "(UPPER(nom) LIKE '%T2%' OR UPPER(nom) LIKE '%TOURNOI 2%' OR UPPER(nom) LIKE '%TOURNOI2%')";
    } else if (relanceType === 't3') {
      nameCondition = "(UPPER(nom) LIKE '%T3%' OR UPPER(nom) LIKE '%TOURNOI 3%' OR UPPER(nom) LIKE '%TOURNOI3%')";
    } else {
      nameCondition = "(UPPER(nom) LIKE '%FINALE%' OR UPPER(nom) LIKE '%FINAL%')";
    }

    // Build the full query
    const catParamIdx = modeParams.length + 1;

    const tournament = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM tournoi_ext
         WHERE ${modeCondition} AND UPPER(categorie) = $${catParamIdx}
         AND ${nameCondition}
         ORDER BY debut DESC LIMIT 1`,
        [...modeParams, category.toUpperCase()],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!tournament) {
      return res.json({
        found: false,
        message: `Tournoi ${relanceType === 'finale' ? 'Finale' : 'T' + tournamentNumber} non trouvé dans la base de données`
      });
    }

    res.json({
      found: true,
      tournament_date: tournament.debut,
      location: tournament.lieu,
      tournament_name: tournament.nom,
      category: categoryRow.display_name
    });

  } catch (error) {
    console.error('Error fetching next tournament:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get T1 participants for T2 relance (players who played T1 in a specific mode/category)
router.get('/t1-participants', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { mode, category } = req.query;

  if (!mode || !category) {
    return res.status(400).json({ error: 'Mode and category required' });
  }

  try {
    // Find T1 tournament for this mode/category in current season
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    let season;
    if (currentMonth >= 8) {
      season = `${currentYear}-${currentYear + 1}`;
    } else {
      season = `${currentYear - 1}-${currentYear}`;
    }

    // Find the category (flexible match: N3 matches N3 or N3GC)
    const categoryUpper = category.toUpperCase();
    const categoryRow = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM categories WHERE UPPER(game_type) = $1 AND (UPPER(level) = $2 OR UPPER(level) LIKE $3)`,
        [mode.toUpperCase(), categoryUpper, categoryUpper + '%'],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!categoryRow) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Get T1 tournament (tournament_number = 1)
    const t1Tournament = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM tournaments WHERE category_id = $1 AND season = $2 AND tournament_number = 1`,
        [categoryRow.id, season],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!t1Tournament) {
      return res.json({ tournament: null, participants: [], message: 'T1 tournament not found for this category/season' });
    }

    // Get participants from tournament_results
    const participants = await new Promise((resolve, reject) => {
      db.all(
        `SELECT tr.*,
                pc.id as contact_id, pc.first_name, pc.last_name, pc.email, pc.club, pc.email_optin
         FROM tournament_results tr
         LEFT JOIN player_contacts pc ON REPLACE(tr.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
         WHERE tr.tournament_id = $1
         ORDER BY tr.position ASC`,
        [t1Tournament.id],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // Get T2 tournament info if exists
    const t2Tournament = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM tournaments WHERE category_id = $1 AND season = $2 AND tournament_number = 2`,
        [categoryRow.id, season],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    // Also try to get T2 from tournoi_ext
    const t2External = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM tournoi_ext
         WHERE UPPER(mode) = $1 AND UPPER(categorie) = $2
         AND UPPER(nom) LIKE '%T2%'
         ORDER BY debut DESC LIMIT 1`,
        [mode.toUpperCase(), category.toUpperCase()],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    res.json({
      t1Tournament: {
        id: t1Tournament.id,
        date: t1Tournament.tournament_date,
        location: t1Tournament.location,
        category: categoryRow.display_name
      },
      t2Tournament: t2Tournament || t2External ? {
        date: t2Tournament?.tournament_date || t2External?.debut,
        location: t2Tournament?.location || t2External?.lieu
      } : null,
      participants: participants.map(p => ({
        licence: p.licence,
        player_name: p.player_name,
        first_name: p.first_name,
        last_name: p.last_name,
        email: p.email,
        club: p.club,
        contact_id: p.contact_id,
        t1_position: p.position,
        t1_points: p.match_points,
        email_optin: p.email_optin
      })),
      emailCount: participants.filter(p => p.email && p.email.includes('@')).length
    });

  } catch (error) {
    console.error('Error fetching T1 participants:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get ranking players for T3 relance
router.get('/ranking-for-relance', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { mode, category } = req.query;

  if (!mode || !category) {
    return res.status(400).json({ error: 'Mode and category required' });
  }

  try {
    // Determine current season
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    let season;
    if (currentMonth >= 8) {
      season = `${currentYear}-${currentYear + 1}`;
    } else {
      season = `${currentYear - 1}-${currentYear}`;
    }

    // Find the category (flexible match: N3 matches N3 or N3GC)
    const categoryUpper = category.toUpperCase();
    const categoryRow = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM categories WHERE UPPER(game_type) = $1 AND (UPPER(level) = $2 OR UPPER(level) LIKE $3)`,
        [mode.toUpperCase(), categoryUpper, categoryUpper + '%'],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!categoryRow) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Get T3 tournament info if exists
    const t3Tournament = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM tournaments WHERE category_id = $1 AND season = $2 AND tournament_number = 3`,
        [categoryRow.id, season],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    // Also try to get T3 from tournoi_ext
    const t3External = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM tournoi_ext
         WHERE UPPER(mode) = $1 AND UPPER(categorie) = $2
         AND UPPER(nom) LIKE '%T3%'
         ORDER BY debut DESC LIMIT 1`,
        [mode.toUpperCase(), category.toUpperCase()],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    // Get all players in the ranking
    const rankings = await new Promise((resolve, reject) => {
      db.all(
        `SELECT r.*,
                pc.id as contact_id, pc.first_name, pc.last_name, pc.email, pc.club, pc.email_optin,
                COALESCE(pc.first_name || ' ' || pc.last_name, r.licence) as player_name
         FROM rankings r
         LEFT JOIN player_contacts pc ON REPLACE(r.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
         WHERE r.season = $1 AND r.category_id = $2
         ORDER BY r.rank_position ASC`,
        [season, categoryRow.id],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    res.json({
      category: categoryRow,
      t3Tournament: t3Tournament || t3External ? {
        date: t3Tournament?.tournament_date || t3External?.debut,
        location: t3Tournament?.location || t3External?.lieu
      } : null,
      participants: rankings.map(r => ({
        licence: r.licence,
        player_name: r.player_name,
        first_name: r.first_name,
        last_name: r.last_name,
        email: r.email,
        club: r.club,
        contact_id: r.contact_id,
        rank_position: r.rank_position,
        total_points: r.total_match_points,
        avg_moyenne: r.avg_moyenne,
        email_optin: r.email_optin
      })),
      emailCount: rankings.filter(r => r.email && r.email.includes('@')).length
    });

  } catch (error) {
    console.error('Error fetching ranking for relance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get qualified players for finale relance
router.get('/finale-qualified', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { mode, category } = req.query;

  if (!mode || !category) {
    return res.status(400).json({ error: 'Mode and category required' });
  }

  try {
    // Determine current season
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    let season;
    if (currentMonth >= 8) {
      season = `${currentYear}-${currentYear + 1}`;
    } else {
      season = `${currentYear - 1}-${currentYear}`;
    }

    // Find the category (flexible match: N3 matches N3 or N3GC)
    const categoryUpper = category.toUpperCase();
    const categoryRow = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM categories WHERE UPPER(game_type) = $1 AND (UPPER(level) = $2 OR UPPER(level) LIKE $3)`,
        [mode.toUpperCase(), categoryUpper, categoryUpper + '%'],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!categoryRow) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Check that convocation has been sent - try new format first, then legacy
    let convocationSent = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id, sent_at FROM email_campaigns
         WHERE campaign_type = 'finale_convocation'
         AND UPPER(mode) = $1
         AND (UPPER(category) = $2 OR UPPER(category) LIKE $3)
         AND status IN ('completed', 'sending')
         AND (test_mode = false OR test_mode IS NULL)
         ORDER BY sent_at DESC LIMIT 1`,
        [mode.toUpperCase(), categoryUpper, categoryUpper + '%'],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    // Fallback: check for older campaigns without campaign_type but with matching subject (legacy format)
    if (!convocationSent) {
      convocationSent = await new Promise((resolve, reject) => {
        db.get(
          `SELECT id, sent_at FROM email_campaigns
           WHERE UPPER(subject) LIKE '%' || $1 || '%FINALE DEPARTEMENTALE%'
           AND status IN ('completed', 'sending')
           AND (test_mode = false OR test_mode IS NULL)
           ORDER BY sent_at DESC LIMIT 1`,
          [mode.toUpperCase()],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });
    }

    // Get finale from tournoi_ext
    const finale = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM tournoi_ext
         WHERE UPPER(mode) = $1 AND UPPER(categorie) = $2
         AND (UPPER(nom) LIKE '%FINALE%' OR UPPER(nom) LIKE '%FINAL%')
         ORDER BY debut DESC LIMIT 1`,
        [mode.toUpperCase(), category.toUpperCase()],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    // Get all players in the ranking
    const rankings = await new Promise((resolve, reject) => {
      db.all(
        `SELECT r.*,
                pc.id as contact_id, pc.first_name, pc.last_name, pc.email, pc.club, pc.email_optin,
                COALESCE(pc.first_name || ' ' || pc.last_name, r.licence) as player_name
         FROM rankings r
         LEFT JOIN player_contacts pc ON REPLACE(r.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
         WHERE r.season = $1 AND r.category_id = $2
         ORDER BY r.rank_position ASC`,
        [season, categoryRow.id],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // Determine qualified count: <9 players → 4 qualified, >=9 players → 6 qualified
    const qualifiedCount = rankings.length < 9 ? 4 : 6;
    const qualified = rankings.filter(r => r.rank_position <= qualifiedCount);

    // Calculate deadline date (7 days before finale)
    let deadlineDate = null;
    let finaleFormattedDate = null;
    if (finale && finale.debut) {
      const finaleDateTime = new Date(finale.debut);
      finaleFormattedDate = finaleDateTime.toLocaleDateString('fr-FR');
      const deadline = new Date(finaleDateTime);
      deadline.setDate(deadline.getDate() - 7);
      deadlineDate = deadline.toISOString().split('T')[0]; // YYYY-MM-DD format for input field
    }

    res.json({
      category: categoryRow,
      finale: finale ? {
        tournoi_id: finale.tournoi_id,
        nom: finale.nom,
        date: finale.debut,
        location: finale.lieu,
        formattedDate: finaleFormattedDate
      } : null,
      deadlineDate,
      qualifiedCount,
      totalInRanking: rankings.length,
      convocationRequired: !convocationSent,
      participants: qualified.map(r => ({
        licence: r.licence,
        player_name: r.player_name,
        first_name: r.first_name,
        last_name: r.last_name,
        email: r.email,
        club: r.club,
        contact_id: r.contact_id,
        rank_position: r.rank_position,
        total_points: r.total_match_points,
        avg_moyenne: r.avg_moyenne,
        email_optin: r.email_optin
      })),
      emailCount: qualified.filter(r => r.email && r.email.includes('@')).length
    });

  } catch (error) {
    console.error('Error fetching finale qualified:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send relance emails
router.post('/send-relance', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { relanceType, mode, category, subject, intro, outro, imageUrl, testMode, testEmail, ccEmail, customData, selectedLicences } = req.body;

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({
      error: 'Email non configuré. Veuillez définir RESEND_API_KEY.'
    });
  }

  if (!['t2', 't3', 'finale'].includes(relanceType)) {
    return res.status(400).json({ error: 'Type de relance invalide' });
  }

  if (testMode && (!testEmail || !testEmail.includes('@'))) {
    return res.status(400).json({ error: 'Email de test invalide.' });
  }

  try {
    // Get participants based on relance type
    let participants = [];
    let tournamentInfo = {};

    if (relanceType === 't2') {
      const response = await new Promise((resolve) => {
        // Simulate internal API call by reusing the logic
        const req2 = { query: { mode, category } };
        // We'll fetch directly here
        resolve(null);
      });

      // Fetch T1 participants directly
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth();
      const season = currentMonth >= 8 ? `${currentYear}-${currentYear + 1}` : `${currentYear - 1}-${currentYear}`;

      // Flexible category match: N3 matches N3 or N3GC
      const categoryUpper = category.toUpperCase();
      const categoryRow = await new Promise((resolve, reject) => {
        db.get(
          `SELECT * FROM categories WHERE UPPER(game_type) = $1 AND (UPPER(level) = $2 OR UPPER(level) LIKE $3)`,
          [mode.toUpperCase(), categoryUpper, categoryUpper + '%'],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (!categoryRow) {
        return res.status(404).json({ error: 'Category not found' });
      }

      const t1Tournament = await new Promise((resolve, reject) => {
        db.get(
          `SELECT * FROM tournaments WHERE category_id = $1 AND season = $2 AND tournament_number = 1`,
          [categoryRow.id, season],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (!t1Tournament) {
        return res.status(404).json({ error: 'T1 tournament not found' });
      }

      participants = await new Promise((resolve, reject) => {
        db.all(
          `SELECT tr.*,
                  pc.id as contact_id, pc.first_name, pc.last_name, pc.email, pc.club
           FROM tournament_results tr
           LEFT JOIN player_contacts pc ON REPLACE(tr.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
           WHERE tr.tournament_id = $1
           ORDER BY tr.position ASC`,
          [t1Tournament.id],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      // Calculate deadline (tournament date - 7 days)
      let deadlineDate = '';
      if (customData?.tournament_date) {
        const tournamentDate = parseDateSafe(customData.tournament_date);
        if (tournamentDate) {
          const deadline = new Date(tournamentDate);
          deadline.setDate(deadline.getDate() - 7);
          deadlineDate = deadline.toLocaleDateString('fr-FR');
        }
      }

      tournamentInfo = {
        category: categoryRow.display_name,
        t1_date: t1Tournament.tournament_date ? new Date(t1Tournament.tournament_date).toLocaleDateString('fr-FR') : '',
        tournament_date: customData?.tournament_date || '',
        tournament_lieu: customData?.tournament_lieu || '',
        deadline_date: deadlineDate
      };

    } else if (relanceType === 't3') {
      // Fetch ranking players
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth();
      const season = currentMonth >= 8 ? `${currentYear}-${currentYear + 1}` : `${currentYear - 1}-${currentYear}`;

      // Flexible category match: N3 matches N3 or N3GC
      const categoryUpper = category.toUpperCase();
      const categoryRow = await new Promise((resolve, reject) => {
        db.get(
          `SELECT * FROM categories WHERE UPPER(game_type) = $1 AND (UPPER(level) = $2 OR UPPER(level) LIKE $3)`,
          [mode.toUpperCase(), categoryUpper, categoryUpper + '%'],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (!categoryRow) {
        return res.status(404).json({ error: 'Category not found' });
      }

      participants = await new Promise((resolve, reject) => {
        db.all(
          `SELECT r.*,
                  pc.id as contact_id, pc.first_name, pc.last_name, pc.email, pc.club,
                  COALESCE(pc.first_name || ' ' || pc.last_name, r.licence) as player_name
           FROM rankings r
           LEFT JOIN player_contacts pc ON REPLACE(r.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
           WHERE r.season = $1 AND r.category_id = $2
           ORDER BY r.rank_position ASC`,
          [season, categoryRow.id],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      // Calculate deadline (tournament date - 7 days)
      let deadlineDate = '';
      if (customData?.tournament_date) {
        const tournamentDate = parseDateSafe(customData.tournament_date);
        if (tournamentDate) {
          const deadline = new Date(tournamentDate);
          deadline.setDate(deadline.getDate() - 7);
          deadlineDate = deadline.toLocaleDateString('fr-FR');
        }
      }

      tournamentInfo = {
        category: categoryRow.display_name,
        tournament_date: customData?.tournament_date || '',
        tournament_lieu: customData?.tournament_lieu || '',
        deadline_date: deadlineDate
      };

    } else if (relanceType === 'finale') {
      // Fetch finale qualified
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth();
      const season = currentMonth >= 8 ? `${currentYear}-${currentYear + 1}` : `${currentYear - 1}-${currentYear}`;

      // Flexible category match: N3 matches N3 or N3GC
      const categoryUpper = category.toUpperCase();
      const categoryRow = await new Promise((resolve, reject) => {
        db.get(
          `SELECT * FROM categories WHERE UPPER(game_type) = $1 AND (UPPER(level) = $2 OR UPPER(level) LIKE $3)`,
          [mode.toUpperCase(), categoryUpper, categoryUpper + '%'],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (!categoryRow) {
        return res.status(404).json({ error: 'Category not found' });
      }

      // Check that convocation has been sent before allowing relance finale (skip in test mode)
      if (!testMode) {
        // First try to find a campaign with proper campaign_type field (new format)
        let convocationSent = await new Promise((resolve, reject) => {
          db.get(
            `SELECT id, sent_at FROM email_campaigns
             WHERE campaign_type = 'finale_convocation'
             AND UPPER(mode) = $1
             AND (UPPER(category) = $2 OR UPPER(category) LIKE $3)
             AND status IN ('completed', 'sending')
             AND (test_mode = false OR test_mode IS NULL)
             ORDER BY sent_at DESC LIMIT 1`,
            [mode.toUpperCase(), categoryUpper, categoryUpper + '%'],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });

        // Fallback: check for older campaigns without campaign_type but with matching subject (legacy format)
        if (!convocationSent) {
          convocationSent = await new Promise((resolve, reject) => {
            db.get(
              `SELECT id, sent_at FROM email_campaigns
               WHERE (subject LIKE '%' || $1 || '%Finale Departementale%'
                      OR subject LIKE '%Convocation Finale - %' || $1 || '%')
               AND status IN ('completed', 'sending')
               AND (test_mode = false OR test_mode IS NULL)
               ORDER BY sent_at DESC LIMIT 1`,
              [mode.toUpperCase()],
              (err, row) => {
                if (err) reject(err);
                else resolve(row);
              }
            );
          });
        }

        if (!convocationSent) {
          return res.status(400).json({
            error: 'La convocation finale doit être envoyée avant de pouvoir envoyer une relance. Veuillez d\'abord envoyer la convocation aux finalistes.'
          });
        }
      }

      const allRankings = await new Promise((resolve, reject) => {
        db.all(
          `SELECT r.*,
                  pc.id as contact_id, pc.first_name, pc.last_name, pc.email, pc.club,
                  COALESCE(pc.first_name || ' ' || pc.last_name, r.licence) as player_name
           FROM rankings r
           LEFT JOIN player_contacts pc ON REPLACE(r.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
           WHERE r.season = $1 AND r.category_id = $2
           ORDER BY r.rank_position ASC`,
          [season, categoryRow.id],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      const qualifiedCount = allRankings.length < 9 ? 4 : 6;
      participants = allRankings.filter(r => r.rank_position <= qualifiedCount);

      // Try to get finale info from tournoi_ext if not provided in customData
      let finaleDate = customData?.finale_date || '';
      let finaleLieu = customData?.finale_lieu || '';
      let deadlineDate = customData?.deadline_date || '';

      // Auto-fetch from tournoi_ext if not provided
      if (!finaleDate || !finaleLieu) {
        const finale = await new Promise((resolve, reject) => {
          db.get(
            `SELECT * FROM tournoi_ext
             WHERE UPPER(mode) = $1
             AND (UPPER(categorie) = $2 OR UPPER(categorie) LIKE $3)
             AND debut >= $4
             ORDER BY debut ASC LIMIT 1`,
            [mode.toUpperCase(), categoryUpper, categoryUpper + '%', new Date().toISOString().split('T')[0]],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });

        if (finale) {
          if (!finaleDate && finale.debut) {
            finaleDate = new Date(finale.debut).toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
          }
          if (!finaleLieu && finale.lieu) {
            finaleLieu = finale.lieu;
          }
        }
      }

      // Auto-calculate deadline (7 days before finale) if not provided
      if (!deadlineDate && finaleDate) {
        // Try to parse the finale date to calculate deadline
        const finaleMatch = finaleDate.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
        if (finaleMatch) {
          const [_, day, month, year] = finaleMatch;
          const finaleDateTime = new Date(year, month - 1, day);
          finaleDateTime.setDate(finaleDateTime.getDate() - 7);
          deadlineDate = finaleDateTime.toLocaleDateString('fr-FR');
        }
      }

      tournamentInfo = {
        category: categoryRow.display_name,
        qualified_count: qualifiedCount,
        finale_date: finaleDate,
        finale_lieu: finaleLieu,
        deadline_date: deadlineDate
      };
    }

    if (participants.length === 0) {
      return res.status(400).json({ error: 'Aucun participant trouvé' });
    }

    // Filter participants by selectedLicences if provided (not in test mode)
    if (!testMode && selectedLicences && Array.isArray(selectedLicences) && selectedLicences.length > 0) {
      participants = participants.filter(p => {
        const participantLicence = (p.licence || '').replace(/\s/g, '');
        return selectedLicences.some(sl => (sl || '').replace(/\s/g, '') === participantLicence);
      });

      if (participants.length === 0) {
        return res.status(400).json({ error: 'Aucun participant sélectionné' });
      }
    }

    const results = { sent: [], failed: [], skipped: [] };

    // Replace {category} in subject for logging (use display_name from tournamentInfo)
    const logSubject = subject.replace(/\{category\}/g, tournamentInfo.category || category);

    // Create campaign record with tracking info
    const campaignId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO email_campaigns (subject, body, template_key, recipients_count, status, campaign_type, mode, category, sent_by, test_mode)
         VALUES ($1, $2, $3, $4, 'sending', $5, $6, $7, $8, $9)
         RETURNING id`,
        [logSubject, intro, `relance_${relanceType}`, testMode ? 1 : participants.filter(p => p.email).length,
         `relance_${relanceType}`, mode, category, req.user?.username || 'unknown', testMode ? true : false],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    // In test mode, only send to test email
    const recipientsToEmail = testMode
      ? [{ ...participants[0], email: testEmail }]
      : participants.filter(p => p.email && p.email.includes('@'));

    // Get configurable contact email
    const contactEmail = await getContactEmail();
    const contactPhraseHtml = buildContactPhraseHtml(contactEmail);

    for (const participant of recipientsToEmail) {
      if (!participant.email || !participant.email.includes('@')) {
        results.skipped.push({
          name: participant.player_name || `${participant.first_name} ${participant.last_name}`,
          reason: 'Email invalide'
        });
        continue;
      }

      try {
        // Build template variables
        const variables = {
          first_name: participant.first_name || '',
          last_name: participant.last_name || '',
          player_name: participant.player_name || `${participant.first_name} ${participant.last_name}`,
          club: participant.club || '',
          category: tournamentInfo.category || '',
          t1_position: participant.position || participant.t1_position || '',
          t1_points: participant.match_points || participant.t1_points || '',
          t1_date: tournamentInfo.t1_date || '',
          rank_position: participant.rank_position || '',
          total_points: participant.total_match_points || participant.total_points || '',
          tournament_date: tournamentInfo.tournament_date || '',
          tournament_lieu: tournamentInfo.tournament_lieu || '',
          finale_date: tournamentInfo.finale_date || '',
          finale_lieu: tournamentInfo.finale_lieu || '',
          deadline_date: tournamentInfo.deadline_date || '',
          qualified_count: tournamentInfo.qualified_count || ''
        };

        // Replace variables in subject, intro, outro
        let emailSubject = subject;
        let emailIntro = intro;
        let emailOutro = outro;

        for (const [key, value] of Object.entries(variables)) {
          const regex = new RegExp(`\\{${key}\\}`, 'g');
          emailSubject = emailSubject.replace(regex, value);
          emailIntro = emailIntro.replace(regex, value);
          emailOutro = emailOutro.replace(regex, value);
        }

        const imageHtml = imageUrl ? `<div style="text-align: center; margin: 20px 0;"><img src="${imageUrl}" alt="Image" style="max-width: 100%; height: auto; border-radius: 8px;"></div>` : '';

        const emailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
              <img src="${baseUrl}/logo.png" alt="Logo" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
              <h1 style="margin: 0; font-size: 24px;">${await appSettings.get('organization_name') || 'Comité Départemental de Billard'}</h1>
            </div>
            <div style="padding: 20px; background: #f8f9fa; line-height: 1.6;">
              ${imageHtml}
              <p>${convertEmailsToMailtoLinks(emailIntro.replace(/\n/g, '<br>'))}</p>
              ${contactPhraseHtml}
              <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">
              <p>${convertEmailsToMailtoLinks(emailOutro.replace(/\n/g, '<br>'))}</p>
            </div>
            <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">
              <p style="margin: 0;">CDBHS - <a href="mailto:${contactEmail}" style="color: white;">${contactEmail}</a></p>
            </div>
          </div>
        `;

        await resend.emails.send({
          from: 'CDBHS <noreply@cdbhs.net>',
          replyTo: contactEmail,
          to: [participant.email],
          subject: emailSubject,
          html: emailHtml
        });

        results.sent.push({
          name: participant.player_name || `${participant.first_name} ${participant.last_name}`,
          email: participant.email
        });

        // Update last_contacted
        if (participant.contact_id) {
          await new Promise((resolve) => {
            db.run(
              'UPDATE player_contacts SET last_contacted = CURRENT_TIMESTAMP WHERE id = $1',
              [participant.contact_id],
              () => resolve()
            );
          });
        }

        await delay(1500);

      } catch (error) {
        console.error(`Error sending relance to ${participant.email}:`, error);
        results.failed.push({
          name: participant.player_name || `${participant.first_name} ${participant.last_name}`,
          email: participant.email,
          error: error.message
        });
      }
    }

    // Update campaign
    await new Promise((resolve) => {
      console.log(`[Relance] Updating campaign ${campaignId}: sent=${results.sent.length}, failed=${results.failed.length}`);
      db.run(
        `UPDATE email_campaigns SET sent_count = $1, failed_count = $2, status = 'completed', sent_at = CURRENT_TIMESTAMP WHERE id = $3`,
        [results.sent.length, results.failed.length, campaignId],
        (err) => {
          if (err) console.error('[Relance] Error updating campaign status:', err);
          else console.log(`[Relance] Campaign ${campaignId} marked as completed`);
          resolve();
        }
      );
    });

    // Send summary if requested
    if (ccEmail && ccEmail.includes('@') && !testMode && results.sent.length > 0) {
      try {
        const recipientListHtml = results.sent.map((r, idx) =>
          `<tr style="background: ${idx % 2 === 0 ? 'white' : '#f8f9fa'};">
            <td style="padding: 8px; border: 1px solid #ddd;">${idx + 1}</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${r.name}</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${r.email}</td>
          </tr>`
        ).join('');

        const relanceTypeLabels = { t2: 'T2', t3: 'T3', finale: 'Finale' };

        const summaryHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
              <h1 style="margin: 0; font-size: 20px;">Récapitulatif Relance ${relanceTypeLabels[relanceType]}</h1>
              <p style="margin: 10px 0 0 0;">${mode} ${category}</p>
            </div>
            <div style="padding: 20px; background: #f8f9fa;">
              <div style="background: #d4edda; border-left: 4px solid #28a745; padding: 15px; margin-bottom: 20px;">
                <strong>✅ ${results.sent.length} relance(s) envoyée(s)</strong>
                ${results.failed.length > 0 ? `<br><span style="color: #dc3545;">${results.failed.length} échec(s)</span>` : ''}
              </div>
              <h3>Destinataires</h3>
              <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                  <tr style="background: #1F4788; color: white;">
                    <th style="padding: 8px; border: 1px solid #ddd;">#</th>
                    <th style="padding: 8px; border: 1px solid #ddd;">Joueur</th>
                    <th style="padding: 8px; border: 1px solid #ddd;">Email</th>
                  </tr>
                </thead>
                <tbody>${recipientListHtml}</tbody>
              </table>
            </div>
          </div>
        `;

        await resend.emails.send({
          from: 'CDBHS <noreply@cdbhs.net>',
          to: [ccEmail],
          subject: `Récap Relance ${relanceTypeLabels[relanceType]} - ${mode} ${category}`,
          html: summaryHtml
        });
      } catch (summaryError) {
        console.error('Error sending summary:', summaryError);
      }
    }

    const message = testMode
      ? `Email de test envoyé à ${testEmail}`
      : `Relances envoyées: ${results.sent.length}, Échecs: ${results.failed.length}${ccEmail ? ' + récapitulatif' : ''}`;

    res.json({
      success: true,
      message,
      results,
      testMode
    });

  } catch (error) {
    console.error('Error sending relance:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
module.exports.syncContacts = syncContacts;
