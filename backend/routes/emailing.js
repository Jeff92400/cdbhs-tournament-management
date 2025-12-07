const express = require('express');
const { Resend } = require('resend');
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

// Get available tournaments for filtering (upcoming and recent)
router.get('/tournois', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  db.all(
    `SELECT t.tournoi_id, t.nom, t.mode, t.categorie, t.debut, t.lieu,
            (SELECT COUNT(*) FROM inscriptions i WHERE i.tournoi_id = t.tournoi_id AND i.forfait != 1) as nb_inscrits
     FROM tournoi_ext t
     WHERE t.debut >= date('now', '-30 days')
     ORDER BY t.debut DESC, t.mode, t.categorie`,
    [],
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
  const { recipientIds, subject, body, templateKey } = req.body;

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

        await resend.emails.send({
          from: 'CDBHS <communication@cdbhs.net>',
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
  const { recipientIds, subject, body, templateKey, scheduledAt } = req.body;

  if (!recipientIds || recipientIds.length === 0) {
    return res.status(400).json({ error: 'Aucun destinataire selectionne.' });
  }

  if (!scheduledAt) {
    return res.status(400).json({ error: 'Date et heure requises.' });
  }

  try {
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO scheduled_emails (subject, body, template_key, recipient_ids, scheduled_at, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [subject, body, templateKey || null, JSON.stringify(recipientIds), scheduledAt],
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
