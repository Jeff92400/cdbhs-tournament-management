const express = require('express');
const { Resend } = require('resend');
const { authenticateToken } = require('./auth');

const router = express.Router();

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
  const db = require('../db-loader');
  return new Promise((resolve) => {
    db.get(
      "SELECT value FROM app_settings WHERE key = 'contact_email'",
      [],
      (err, row) => {
        if (row?.value) {
          resolve(row.value);
        } else {
          // Fallback to summary_email
          db.get(
            "SELECT value FROM app_settings WHERE key = 'summary_email'",
            [],
            (err2, row2) => {
              resolve(row2?.value || 'cdbhs92@gmail.com');
            }
          );
        }
      }
    );
  });
}

// Build contact phrase HTML with configurable email
function buildContactPhraseHtml(email) {
  return `<p style="margin-top: 20px; padding: 10px; background: #e8f4f8; border-left: 3px solid #1F4788; font-size: 14px;">
  Pour toute question ou information, écrivez à <a href="mailto:${email}" style="color: #1F4788;">${email}</a>
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
  const { activeOnly, club, mode, category, tournoiId } = req.query;

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

  // Filter by club
  if (club) {
    query += ` AND pc.club = $${paramIndex++}`;
    params.push(club);
  }

  // Filter by game mode (based on rankings)
  if (mode) {
    const modeUpper = mode.toUpperCase();
    if (modeUpper === 'LIBRE') {
      query += ` AND pc.rank_libre IS NOT NULL AND pc.rank_libre != '' AND pc.rank_libre != 'NC'`;
    } else if (modeUpper === 'CADRE') {
      query += ` AND pc.rank_cadre IS NOT NULL AND pc.rank_cadre != '' AND pc.rank_cadre != 'NC'`;
    } else if (modeUpper === 'BANDE') {
      query += ` AND pc.rank_bande IS NOT NULL AND pc.rank_bande != '' AND pc.rank_bande != 'NC'`;
    } else if (modeUpper === '3BANDES') {
      query += ` AND pc.rank_3bandes IS NOT NULL AND pc.rank_3bandes != '' AND pc.rank_3bandes != 'NC'`;
    }
  }

  // Filter by category (N3, R1, R2, etc.)
  if (category && mode) {
    const modeUpper = mode.toUpperCase();
    const catUpper = category.toUpperCase();
    if (modeUpper === 'LIBRE') {
      query += ` AND UPPER(pc.rank_libre) = $${paramIndex++}`;
    } else if (modeUpper === 'CADRE') {
      query += ` AND UPPER(pc.rank_cadre) = $${paramIndex++}`;
    } else if (modeUpper === 'BANDE') {
      query += ` AND UPPER(pc.rank_bande) = $${paramIndex++}`;
    } else if (modeUpper === '3BANDES') {
      query += ` AND UPPER(pc.rank_3bandes) = $${paramIndex++}`;
    }
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
                <img src="data:image/png;base64,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" alt="CDBHS" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
                <h1 style="margin: 0; font-size: 24px;">Comite Departemental Billard Hauts-de-Seine</h1>
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
    console.log('[Tournament-Results] Looking for tournoi_ext match:', {
      game_type: tournament.game_type,
      level: tournament.level,
      tournament_date: tournament.tournament_date
    });

    const matchingTournoi = await new Promise((resolve, reject) => {
      db.get(`
        SELECT te.tournoi_id, te.mode, te.categorie, te.debut
        FROM tournoi_ext te
        WHERE UPPER(te.mode) = UPPER($1)
          AND UPPER(te.categorie) = UPPER($2)
          AND DATE(te.debut) = DATE($3)
        LIMIT 1
      `, [tournament.game_type, tournament.level, tournament.tournament_date], (err, row) => {
        if (err) reject(err);
        else {
          console.log('[Tournament-Results] Matching tournoi_ext found:', row || 'NONE');
          resolve(row);
        }
      });
    });

    // If no match found, log available tournoi_ext for debugging
    if (!matchingTournoi) {
      const availableTournois = await new Promise((resolve, reject) => {
        db.all(`
          SELECT tournoi_id, mode, categorie, debut
          FROM tournoi_ext
          WHERE DATE(debut) = DATE($1)
          LIMIT 10
        `, [tournament.tournament_date], (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      });
      console.log('[Tournament-Results] Available tournoi_ext on same date:', availableTournois);
    }

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
              <img src="data:image/png;base64,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" alt="CDBHS" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
              <h1 style="margin: 0; font-size: 24px;">Résultats - ${tournament.display_name}</h1>
              <p style="margin: 10px 0 0 0; opacity: 0.9;">${tournamentDate}${tournament.location ? ' - ' + tournament.location : ''}</p>
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
              <img src="data:image/png;base64,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" alt="CDBHS" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
              <h1 style="margin: 0; font-size: 24px;">📋 Récapitulatif Envoi Résultats</h1>
              <p style="margin: 10px 0 0 0; opacity: 0.9;">${tournament.display_name}</p>
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
  const { finaleId, introText, outroText, imageUrl, testMode, testEmail, ccEmail } = req.body;

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
          .replace(/\{finale_lieu\}/g, finale.lieu || '')
          .replace(/\{category\}/g, category.display_name || '')
          .replace(/\{rank_position\}/g, finalist.rank_position || '');

        const personalizedOutro = outroText
          .replace(/\{first_name\}/g, finalist.first_name || '')
          .replace(/\{last_name\}/g, finalist.last_name || '');

        const imageHtml = imageUrl ? `<div style="text-align: center; margin: 20px 0;"><img src="${imageUrl}" alt="Image" style="max-width: 100%; height: auto; border-radius: 8px;"></div>` : '';

        const emailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
            <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
              <img src="data:image/png;base64,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" alt="CDBHS" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
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
                <p><strong>Lieu :</strong> ${finale.lieu || 'À confirmer'}</p>
                <p><strong>Catégorie :</strong> ${category.display_name}</p>
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
              <img src="data:image/png;base64,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" alt="CDBHS" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
              <h1 style="margin: 0; font-size: 24px;">📋 Récapitulatif Convocations Finale</h1>
              <p style="margin: 10px 0 0 0; opacity: 0.9;">${category.display_name}</p>
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
              <img src="data:image/png;base64,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" alt="CDBHS" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
              <h1 style="margin: 0; font-size: 24px;">Comité Départemental Billard Hauts-de-Seine</h1>
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
