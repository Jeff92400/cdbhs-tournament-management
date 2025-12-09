const express = require('express');
const { Resend } = require('resend');
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

// Default email template for general communications
const DEFAULT_GENERAL_TEMPLATE = {
  subject: 'Information CDBHS',
  body: `Bonjour {player_name},

{message}

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

  db.all(
    `SELECT DISTINCT club FROM player_contacts WHERE club IS NOT NULL AND club != '' ORDER BY club`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching clubs:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json((rows || []).map(r => r.club));
    }
  );
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
  const { recipientIds, subject, body, templateKey, imageUrl } = req.body;

  const resend = getResend();
  if (!resend) {
    return res.status(500).json({
      error: 'Email non configure. Veuillez definir RESEND_API_KEY.'
    });
  }

  if (!recipientIds || recipientIds.length === 0) {
    return res.status(400).json({ error: 'Aucun destinataire selectionne.' });
  }

  try {
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

    const results = {
      sent: [],
      failed: [],
      skipped: []
    };

    // Create campaign record
    const campaignId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO email_campaigns (subject, body, template_key, recipients_count, status)
         VALUES ($1, $2, $3, $4, 'sending')`,
        [subject, body, templateKey || null, recipientIds.length],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    // Send emails
    for (const recipient of recipients) {
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
        const emailBodyHtml = emailBody.replace(/\n/g, '<br>');

        // Build optional image HTML
        const imageHtml = imageUrl ? `<div style="text-align: center; margin: 20px 0;"><img src="${imageUrl}" alt="Image" style="max-width: 100%; height: auto; border-radius: 8px;"></div>` : '';

        await resend.emails.send({
          from: 'CDBHS <communication@cdbhs.net>',
          replyTo: 'cdbhs92@gmail.com',
          to: [recipient.email],
          subject: emailSubject,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
                <img src="https://cdbhs-tournament-management-production.up.railway.app/images/billiard-icon.png" alt="CDBHS" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
                <h1 style="margin: 0; font-size: 24px;">Comite Departemental Billard Hauts-de-Seine</h1>
              </div>
              <div style="padding: 20px; background: #f8f9fa; line-height: 1.6;">
                ${imageHtml}
                ${emailBodyHtml}
              </div>
              <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">
                <p style="margin: 0;">CDBHS - cdbhs92@gmail.com</p>
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

    res.json({
      success: true,
      message: `Emails envoyes: ${results.sent.length}, Echecs: ${results.failed.length}, Ignores: ${results.skipped.length}`,
      results,
      campaignId
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

// Get scheduled emails
router.get('/scheduled', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  db.all(
    `SELECT * FROM scheduled_emails WHERE status = 'pending' ORDER BY scheduled_at`,
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

    for (const scheduled of scheduledEmails) {
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
          const emailBodyHtml = emailBody.replace(/\n/g, '<br>');

          await resend.emails.send({
            from: 'CDBHS <communication@cdbhs.net>',
            replyTo: 'cdbhs92@gmail.com',
            to: [recipient.email],
            subject: emailSubject,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
                  <h1 style="margin: 0; font-size: 24px;">CDBHS</h1>
                </div>
                <div style="padding: 20px; background: #f8f9fa; line-height: 1.6;">
                  ${emailBodyHtml}
                </div>
                <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">
                  <p style="margin: 0;">Comite Departemental Billard Hauts-de-Seine - cdbhs92@gmail.com</p>
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
          `INSERT INTO email_campaigns (subject, body, template_key, recipients_count, sent_count, failed_count, status, sent_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'completed', CURRENT_TIMESTAMP)`,
          [scheduled.subject, scheduled.body, scheduled.template_key, recipientIds.length, sentCount, failedCount],
          () => resolve()
        );
      });
    }

    res.json({
      success: true,
      message: `${processedCount} email(s) programme(s) traite(s).`
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

    // Get tournament results with emails from player_contacts
    // Use stored position from import
    const results = await new Promise((resolve, reject) => {
      db.all(`
        SELECT tr.*,
               pc.email,
               pc.first_name as contact_first_name,
               pc.last_name as contact_last_name
        FROM tournament_results tr
        LEFT JOIN player_contacts pc ON REPLACE(tr.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
        WHERE tr.tournament_id = $1
        ORDER BY tr.position ASC
      `, [id], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Get ranking data for this mode/category (use stored rank_position)
    const rankings = await new Promise((resolve, reject) => {
      db.all(`
        SELECT r.*, p.first_name, p.last_name,
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

    // Get tournament results with emails (use stored position from import)
    const results = await new Promise((resolve, reject) => {
      db.all(`
        SELECT tr.*, pc.email, pc.first_name, pc.last_name
        FROM tournament_results tr
        LEFT JOIN player_contacts pc ON REPLACE(tr.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
        WHERE tr.tournament_id = $1
        ORDER BY tr.position ASC
      `, [tournamentId], (err, rows) => {
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

    // Create campaign record
    const campaignId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO email_campaigns (subject, body, template_key, recipients_count, status)
         VALUES ($1, $2, 'tournament_results', $3, 'sending')`,
        [`Résultats - ${tournament.display_name}`, introText, results.filter(r => r.email).length],
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
              <td style="padding: 10px; text-align: left; border: 1px solid #ddd; font-weight: ${fontWeight};">${arrow}${r.player_name}</td>
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
              <img src="https://cdbhs-tournament-management-production.up.railway.app/images/billiard-icon.png" alt="CDBHS" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
              <h1 style="margin: 0; font-size: 24px;">Résultats - ${tournament.display_name}</h1>
              <p style="margin: 10px 0 0 0; opacity: 0.9;">${tournamentDate}${tournament.location ? ' - ' + tournament.location : ''}</p>
            </div>
            <div style="padding: 20px; background: #f8f9fa; line-height: 1.6;">
              ${imageHtml}
              <p>${personalizedIntro.replace(/\n/g, '<br>')}</p>

              <h3 style="color: #1F4788; margin-top: 30px;">Résultats du Tournoi</h3>
              ${resultsTableHtml.replace('{{RESULTS_ROWS}}', resultsRows)}

              <p style="margin-top: 30px; font-style: italic; color: #555;">Après les rencontres ci-dessus, le classement général pour la finale départementale est le suivant :</p>

              <h3 style="color: #28a745; margin-top: 15px;">Classement Général ${tournament.display_name}</h3>
              ${rankingsTableHtml.replace('{{RANKINGS_ROWS}}', rankingsRows)}

              ${qualificationMessage}

              <p style="margin-top: 30px;">${personalizedOutro.replace(/\n/g, '<br>')}</p>
            </div>
            <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">
              <p style="margin: 0;">CDBHS - cdbhs92@gmail.com</p>
            </div>
          </div>
        `;

        const emailOptions = {
          from: 'CDBHS <communication@cdbhs.net>',
          replyTo: 'cdbhs92@gmail.com',
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
              <td style="padding: 8px; border: 1px solid #ddd;">${r.player_name}</td>
              <td style="padding: 8px; text-align: center; border: 1px solid #ddd;">${r.match_points || '-'}</td>
              <td style="padding: 8px; text-align: center; border: 1px solid #ddd;">${moyenne}</td>
            </tr>
          `;
        }).join('');

        const summaryHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
            <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
              <img src="https://cdbhs-tournament-management-production.up.railway.app/images/billiard-icon.png" alt="CDBHS" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
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
              <p style="margin: 0;">CDBHS - cdbhs92@gmail.com</p>
            </div>
          </div>
        `;

        await resend.emails.send({
          from: 'CDBHS <communication@cdbhs.net>',
          replyTo: 'cdbhs92@gmail.com',
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
    const mode = finale.mode.toUpperCase();
    const categoryLevel = finale.categorie.toUpperCase();

    // Find matching category
    const category = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM categories
         WHERE UPPER(game_type) = $1
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

    // Find category
    const mode = finale.mode.toUpperCase();
    const categoryLevel = finale.categorie.toUpperCase();

    const category = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM categories WHERE UPPER(game_type) = $1 AND (UPPER(level) = $2 OR UPPER(level) LIKE $3)`,
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

    // Create campaign record
    const campaignId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO email_campaigns (subject, body, template_key, recipients_count, status)
         VALUES ($1, $2, 'finale_convocation', $3, 'sending')`,
        [`Convocation Finale - ${category.display_name}`, introText, finalists.filter(f => f.email).length],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    // In test mode, send to test email only
    const participantsToEmail = testMode ? [{ ...finalists[0], email: testEmail }] : finalists;

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
              <img src="https://cdbhs-tournament-management-production.up.railway.app/images/billiard-icon.png" alt="CDBHS" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
              <h1 style="margin: 0; font-size: 24px;">🏆 Convocation Finale Départementale</h1>
              <p style="margin: 10px 0 0 0; opacity: 0.9;">${category.display_name}</p>
            </div>
            <div style="padding: 20px; background: #f8f9fa; line-height: 1.6;">
              ${imageHtml}

              <div style="background: #d4edda; border-left: 4px solid #28a745; padding: 15px; margin-bottom: 20px;">
                <strong>🎉 Félicitations ${finalist.first_name || ''} !</strong><br>
                Vous êtes qualifié(e) pour la finale départementale !
              </div>

              <p>${personalizedIntro.replace(/\n/g, '<br>')}</p>

              <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0; border: 1px solid #ddd;">
                <h3 style="margin-top: 0; color: #1F4788;">📍 Informations de la Finale</h3>
                <p><strong>Date :</strong> ${finaleFormattedDate}</p>
                <p><strong>Lieu :</strong> ${finale.lieu || 'À confirmer'}</p>
                <p><strong>Catégorie :</strong> ${category.display_name}</p>
              </div>

              <h3 style="color: #28a745;">Liste des Finalistes</h3>
              ${finalistsTableHtml}

              <p style="margin-top: 30px;">${personalizedOutro.replace(/\n/g, '<br>')}</p>
            </div>
            <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">
              <p style="margin: 0;">CDBHS - cdbhs92@gmail.com</p>
            </div>
          </div>
        `;

        const emailOptions = {
          from: 'CDBHS <communication@cdbhs.net>',
          replyTo: 'cdbhs92@gmail.com',
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
              <img src="https://cdbhs-tournament-management-production.up.railway.app/images/billiard-icon.png" alt="CDBHS" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
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
              <p style="margin: 0;">CDBHS - cdbhs92@gmail.com</p>
            </div>
          </div>
        `;

        await resend.emails.send({
          from: 'CDBHS <communication@cdbhs.net>',
          replyTo: 'cdbhs92@gmail.com',
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

module.exports = router;
module.exports.syncContacts = syncContacts;
