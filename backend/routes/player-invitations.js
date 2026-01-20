/**
 * Player Invitations Routes
 *
 * Manages invitations for players to register on the Player App
 */

const express = require('express');
const { Resend } = require('resend');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticateToken, requireAdmin } = require('./auth');
const db = require('../db-loader');
const appSettings = require('../utils/app-settings');

const router = express.Router();

// Configure multer for PDF uploads
const pdfStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../frontend/documents');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Use a fixed name for the invitation guide PDF
    cb(null, 'player-invitation-guide.pdf');
  }
});

const pdfUpload = multer({
  storage: pdfStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: function (req, file, cb) {
    if (file.mimetype === 'application/pdf') {
      return cb(null, true);
    }
    cb(new Error('Seuls les fichiers PDF sont acceptés'));
  }
});

// Helper function to add delay between emails
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Default email template
const DEFAULT_EMAIL_SUBJECT = "Invitation à l'application joueurs Comité Départemental";
const DEFAULT_EMAIL_BODY = `Cher {first_name}

Merci d'avoir accepté d'utiliser l'application destinée aux joueurs du 92. Elle fait partie de la refonte totale que nous avons effectuée pour remplacer l'existant, c'est-à-dire le site web du {organisation_name}.

Nous sommes en cours de diffusion progressive durant cette saison pour un usage généralisé au début de la saison prochaine.

Tu trouveras ci-joint un document décrivant rapidement les fonctionnalités de cette application (qui fonctionne sur PC/Mac ou mobile iOS/Android) et la manière de l'installer. Si tu rencontres la moindre difficulté, n'hésite pas à m'envoyer un email directement ou via l'application qui dispose d'une fonction « contact ».

Nous sommes bien sûr preneurs de toute anomalie que tu pourrais découvrir, mais aussi de suggestions qui contribueraient à une meilleure expérience pour les utilisateurs.

Bon usage de ce nouvel outil et nous restons à disposition pour toute demande de support.

Bien cordialement
Le comité sportif du {organisation_name}

https://cdbhs-player-app-production.up.railway.app/`;

// Get invitation statistics
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const stats = await new Promise((resolve, reject) => {
      db.get(`
        SELECT
          COUNT(*) as total_sent,
          SUM(CASE WHEN has_signed_up = TRUE OR has_signed_up = 1 THEN 1 ELSE 0 END) as signed_up,
          SUM(CASE WHEN has_signed_up = FALSE OR has_signed_up = 0 OR has_signed_up IS NULL THEN 1 ELSE 0 END) as pending
        FROM player_invitations
      `, [], (err, row) => {
        if (err) reject(err);
        else resolve(row || { total_sent: 0, signed_up: 0, pending: 0 });
      });
    });

    res.json({
      total_sent: stats.total_sent || 0,
      signed_up: stats.signed_up || 0,
      pending: stats.pending || 0,
      signup_rate: stats.total_sent > 0 ? Math.round((stats.signed_up / stats.total_sent) * 100) : 0
    });
  } catch (error) {
    console.error('Error fetching invitation stats:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des statistiques' });
  }
});

// List all invitations with filters
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { club, status, search, limit = 100, offset = 0 } = req.query;

    let query = `
      SELECT pi.*,
             pc.email as contact_email, pc.telephone
      FROM player_invitations pi
      LEFT JOIN player_contacts pc ON pi.player_contact_id = pc.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (club) {
      query += ` AND pi.club = $${paramIndex++}`;
      params.push(club);
    }

    if (status === 'signed_up') {
      query += ` AND (pi.has_signed_up = TRUE OR pi.has_signed_up = 1)`;
    } else if (status === 'pending') {
      query += ` AND (pi.has_signed_up = FALSE OR pi.has_signed_up = 0 OR pi.has_signed_up IS NULL)`;
    }

    if (search) {
      query += ` AND (pi.first_name ILIKE $${paramIndex} OR pi.last_name ILIKE $${paramIndex} OR pi.email ILIKE $${paramIndex} OR pi.licence ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY pi.sent_at DESC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const invitations = await new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Get total count for pagination
    let countQuery = `SELECT COUNT(*) as total FROM player_invitations pi WHERE 1=1`;
    const countParams = [];
    let countParamIndex = 1;

    if (club) {
      countQuery += ` AND pi.club = $${countParamIndex++}`;
      countParams.push(club);
    }
    if (status === 'signed_up') {
      countQuery += ` AND (pi.has_signed_up = TRUE OR pi.has_signed_up = 1)`;
    } else if (status === 'pending') {
      countQuery += ` AND (pi.has_signed_up = FALSE OR pi.has_signed_up = 0 OR pi.has_signed_up IS NULL)`;
    }
    if (search) {
      countQuery += ` AND (pi.first_name ILIKE $${countParamIndex} OR pi.last_name ILIKE $${countParamIndex} OR pi.email ILIKE $${countParamIndex} OR pi.licence ILIKE $${countParamIndex})`;
      countParams.push(`%${search}%`);
    }

    const countResult = await new Promise((resolve, reject) => {
      db.get(countQuery, countParams, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    res.json({
      invitations,
      total: countResult?.total || 0
    });
  } catch (error) {
    console.error('Error fetching invitations:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des invitations' });
  }
});

// Get candidates for invitation (players with email who haven't been invited or need resend)
router.get('/candidates', authenticateToken, async (req, res) => {
  try {
    const { club, search, exclude_invited } = req.query;

    let query = `
      SELECT pc.id, pc.licence, pc.first_name, pc.last_name, pc.club, pc.email,
             pi.id as invitation_id, pi.sent_at, pi.has_signed_up, pi.resend_count
      FROM player_contacts pc
      LEFT JOIN player_invitations pi ON pc.id = pi.player_contact_id
      WHERE pc.email IS NOT NULL
        AND pc.email != ''
        AND pc.email LIKE '%@%'
        AND COALESCE(pc.email_optin, 1) = 1
    `;
    const params = [];
    let paramIndex = 1;

    // Exclude players who already have a Player App account
    query += ` AND NOT EXISTS (
      SELECT 1 FROM player_accounts pa
      WHERE REPLACE(pa.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
    )`;

    if (club) {
      query += ` AND pc.club = $${paramIndex++}`;
      params.push(club);
    }

    if (search) {
      query += ` AND (pc.first_name ILIKE $${paramIndex} OR pc.last_name ILIKE $${paramIndex} OR pc.email ILIKE $${paramIndex} OR pc.licence ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (exclude_invited === 'true') {
      query += ` AND pi.id IS NULL`;
    }

    query += ` ORDER BY pc.club, pc.last_name, pc.first_name`;

    const candidates = await new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    res.json(candidates);
  } catch (error) {
    console.error('Error fetching candidates:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des candidats' });
  }
});

// Get email template
router.get('/template', authenticateToken, async (req, res) => {
  try {
    const template = await new Promise((resolve, reject) => {
      db.get(
        "SELECT value FROM app_settings WHERE key = 'player_invitation_email_template'",
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row?.value);
        }
      );
    });

    const subject = await new Promise((resolve, reject) => {
      db.get(
        "SELECT value FROM app_settings WHERE key = 'player_invitation_email_subject'",
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row?.value);
        }
      );
    });

    res.json({
      subject: subject || DEFAULT_EMAIL_SUBJECT,
      body: template || DEFAULT_EMAIL_BODY
    });
  } catch (error) {
    console.error('Error fetching template:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération du template' });
  }
});

// Update email template (admin only)
router.put('/template', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { subject, body } = req.body;

    if (!subject || !body) {
      return res.status(400).json({ error: 'Le sujet et le corps du message sont requis' });
    }

    // Save subject
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO app_settings (key, value) VALUES ('player_invitation_email_subject', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [subject],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Save body
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO app_settings (key, value) VALUES ('player_invitation_email_template', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [body],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    appSettings.clearCache();

    res.json({ success: true, message: 'Template mis à jour' });
  } catch (error) {
    console.error('Error updating template:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du template' });
  }
});

// Get PDF info
router.get('/pdf', authenticateToken, async (req, res) => {
  try {
    const pdfPath = path.join(__dirname, '../../frontend/documents/player-invitation-guide.pdf');

    if (fs.existsSync(pdfPath)) {
      const stats = fs.statSync(pdfPath);
      res.json({
        exists: true,
        filename: 'player-invitation-guide.pdf',
        size: stats.size,
        lastModified: stats.mtime,
        url: '/documents/player-invitation-guide.pdf'
      });
    } else {
      res.json({ exists: false });
    }
  } catch (error) {
    console.error('Error checking PDF:', error);
    res.status(500).json({ error: 'Erreur lors de la vérification du PDF' });
  }
});

// Upload PDF guide (admin only)
router.post('/pdf', authenticateToken, requireAdmin, pdfUpload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier PDF fourni' });
    }

    res.json({
      success: true,
      message: 'PDF téléversé avec succès',
      filename: 'player-invitation-guide.pdf',
      size: req.file.size,
      url: '/documents/player-invitation-guide.pdf'
    });
  } catch (error) {
    console.error('Error uploading PDF:', error);
    res.status(500).json({ error: 'Erreur lors du téléversement du PDF' });
  }
});

// Send invitation emails
router.post('/send', authenticateToken, async (req, res) => {
  const { player_contact_ids, test_email } = req.body;

  if (!player_contact_ids || !Array.isArray(player_contact_ids) || player_contact_ids.length === 0) {
    return res.status(400).json({ error: 'Aucun joueur sélectionné' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'Configuration email manquante (RESEND_API_KEY)' });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const isTestMode = !!test_email;

  try {
    // Get email settings
    const emailSettings = await appSettings.getSettingsBatch([
      'primary_color', 'email_communication', 'email_sender_name',
      'organization_name', 'organization_short_name', 'summary_email'
    ]);

    // Get email template
    const templateSubject = await new Promise((resolve, reject) => {
      db.get(
        "SELECT value FROM app_settings WHERE key = 'player_invitation_email_subject'",
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row?.value || DEFAULT_EMAIL_SUBJECT);
        }
      );
    });

    const templateBody = await new Promise((resolve, reject) => {
      db.get(
        "SELECT value FROM app_settings WHERE key = 'player_invitation_email_template'",
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row?.value || DEFAULT_EMAIL_BODY);
        }
      );
    });

    // Get players to invite
    const placeholders = player_contact_ids.map((_, i) => `$${i + 1}`).join(',');
    const players = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM player_contacts WHERE id IN (${placeholders})`,
        player_contact_ids,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    if (players.length === 0) {
      return res.status(400).json({ error: 'Aucun joueur trouvé' });
    }

    // Check for PDF attachment
    const pdfPath = path.join(__dirname, '../../frontend/documents/player-invitation-guide.pdf');
    let pdfAttachment = null;

    if (fs.existsSync(pdfPath)) {
      const pdfContent = fs.readFileSync(pdfPath);
      pdfAttachment = {
        filename: 'Guide-Application-Joueur.pdf',
        content: pdfContent.toString('base64')
      };
    }

    const senderName = emailSettings.email_sender_name || 'CDBHS';
    const senderEmail = emailSettings.email_communication || 'communication@cdbhs.net';
    const primaryColor = emailSettings.primary_color || '#1F4788';
    const orgName = emailSettings.organization_name || 'Comité Départemental Billard Hauts-de-Seine';
    const orgShortName = emailSettings.organization_short_name || 'CDBHS';
    const replyToEmail = emailSettings.summary_email || 'cdbhs92@gmail.com';

    let sentCount = 0;
    let failedCount = 0;
    const errors = [];

    for (const player of players) {
      try {
        const recipientEmail = isTestMode ? test_email : player.email;
        const firstName = player.first_name || 'Joueur';

        // Replace template variables
        const emailBody = templateBody
          .replace(/\{first_name\}/g, firstName)
          .replace(/\{organisation_name\}/g, orgName)
          .replace(/\{organization_name\}/g, orgName);

        const emailSubject = templateSubject
          .replace(/\{first_name\}/g, firstName)
          .replace(/\{organisation_name\}/g, orgName)
          .replace(/\{organization_name\}/g, orgName);

        // Build HTML email
        const htmlBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: ${primaryColor}; color: white; padding: 20px; text-align: center;">
              <img src="https://cdbhs-tournament-management-production.up.railway.app/images/billiard-icon.png" alt="${orgShortName}" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
              <h1 style="margin: 0; font-size: 24px;">${orgName}</h1>
            </div>
            <div style="padding: 20px; background: #f8f9fa;">
              ${emailBody.replace(/\n/g, '<br>')}
            </div>
            <div style="background: ${primaryColor}; color: white; padding: 10px; text-align: center; font-size: 12px;">
              ${orgShortName} - ${replyToEmail}
            </div>
          </div>
        `;

        const emailOptions = {
          from: `${senderName} <${senderEmail}>`,
          replyTo: replyToEmail,
          to: [recipientEmail],
          subject: emailSubject,
          html: htmlBody
        };

        // Add PDF attachment if available
        if (pdfAttachment) {
          emailOptions.attachments = [{
            filename: pdfAttachment.filename,
            content: pdfAttachment.content
          }];
        }

        await resend.emails.send(emailOptions);

        // If not test mode, record the invitation
        if (!isTestMode) {
          // Check if already invited
          const existing = await new Promise((resolve, reject) => {
            db.get(
              'SELECT id, resend_count FROM player_invitations WHERE player_contact_id = $1',
              [player.id],
              (err, row) => {
                if (err) reject(err);
                else resolve(row);
              }
            );
          });

          if (existing) {
            // Update resend count
            await new Promise((resolve, reject) => {
              db.run(
                `UPDATE player_invitations
                 SET resend_count = resend_count + 1, last_resent_at = NOW()
                 WHERE id = $1`,
                [existing.id],
                (err) => {
                  if (err) reject(err);
                  else resolve();
                }
              );
            });
          } else {
            // Create new invitation record
            await new Promise((resolve, reject) => {
              db.run(
                `INSERT INTO player_invitations
                 (player_contact_id, licence, email, first_name, last_name, club, sent_by_user_id, sent_by_username)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [player.id, player.licence, player.email, player.first_name, player.last_name, player.club, req.user?.userId, req.user?.username],
                (err) => {
                  if (err) reject(err);
                  else resolve();
                }
              );
            });
          }
        }

        sentCount++;
        await delay(1500); // Rate limiting
      } catch (error) {
        console.error(`Error sending to ${player.email}:`, error.message);
        failedCount++;
        errors.push({ player: `${player.first_name} ${player.last_name}`, error: error.message });
      }
    }

    res.json({
      success: true,
      sent: sentCount,
      failed: failedCount,
      test_mode: isTestMode,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Error sending invitations:', error);
    res.status(500).json({ error: 'Erreur lors de l\'envoi des invitations' });
  }
});

// Resend invitation to a specific player
router.post('/resend/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'Configuration email manquante (RESEND_API_KEY)' });
  }

  try {
    // Get the invitation
    const invitation = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM player_invitations WHERE id = $1', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!invitation) {
      return res.status(404).json({ error: 'Invitation non trouvée' });
    }

    // Resend by calling the send endpoint internally
    req.body = {
      player_contact_ids: [invitation.player_contact_id]
    };

    // Forward to send handler (this will handle the rest)
    const result = await new Promise((resolve) => {
      // Create a mock response to capture the result
      const mockRes = {
        json: (data) => resolve({ status: 200, data }),
        status: (code) => ({
          json: (data) => resolve({ status: code, data })
        })
      };

      // We need to manually do what send does for a single resend
      // This is a simplified version
      resolve({ status: 200, data: { success: true } });
    });

    // Actually send the email using the logic from /send
    const resend = new Resend(process.env.RESEND_API_KEY);

    const emailSettings = await appSettings.getSettingsBatch([
      'primary_color', 'email_communication', 'email_sender_name',
      'organization_name', 'organization_short_name', 'summary_email'
    ]);

    const templateSubject = await new Promise((resolve, reject) => {
      db.get(
        "SELECT value FROM app_settings WHERE key = 'player_invitation_email_subject'",
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row?.value || DEFAULT_EMAIL_SUBJECT);
        }
      );
    });

    const templateBody = await new Promise((resolve, reject) => {
      db.get(
        "SELECT value FROM app_settings WHERE key = 'player_invitation_email_template'",
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row?.value || DEFAULT_EMAIL_BODY);
        }
      );
    });

    const firstName = invitation.first_name || 'Joueur';
    const orgName = emailSettings.organization_name || 'Comité Départemental Billard Hauts-de-Seine';
    const orgShortName = emailSettings.organization_short_name || 'CDBHS';
    const senderName = emailSettings.email_sender_name || 'CDBHS';
    const senderEmail = emailSettings.email_communication || 'communication@cdbhs.net';
    const primaryColor = emailSettings.primary_color || '#1F4788';
    const replyToEmail = emailSettings.summary_email || 'cdbhs92@gmail.com';

    const emailBody = templateBody
      .replace(/\{first_name\}/g, firstName)
      .replace(/\{organisation_name\}/g, orgName)
      .replace(/\{organization_name\}/g, orgName);

    const emailSubject = templateSubject
      .replace(/\{first_name\}/g, firstName)
      .replace(/\{organisation_name\}/g, orgName)
      .replace(/\{organization_name\}/g, orgName);

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: ${primaryColor}; color: white; padding: 20px; text-align: center;">
          <img src="https://cdbhs-tournament-management-production.up.railway.app/images/billiard-icon.png" alt="${orgShortName}" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
          <h1 style="margin: 0; font-size: 24px;">${orgName}</h1>
        </div>
        <div style="padding: 20px; background: #f8f9fa;">
          ${emailBody.replace(/\n/g, '<br>')}
        </div>
        <div style="background: ${primaryColor}; color: white; padding: 10px; text-align: center; font-size: 12px;">
          ${orgShortName} - ${replyToEmail}
        </div>
      </div>
    `;

    // Check for PDF attachment
    const pdfPath = path.join(__dirname, '../../frontend/documents/player-invitation-guide.pdf');
    const emailOptions = {
      from: `${senderName} <${senderEmail}>`,
      replyTo: replyToEmail,
      to: [invitation.email],
      subject: emailSubject,
      html: htmlBody
    };

    if (fs.existsSync(pdfPath)) {
      const pdfContent = fs.readFileSync(pdfPath);
      emailOptions.attachments = [{
        filename: 'Guide-Application-Joueur.pdf',
        content: pdfContent.toString('base64')
      }];
    }

    await resend.emails.send(emailOptions);

    // Update resend count
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE player_invitations
         SET resend_count = resend_count + 1, last_resent_at = NOW()
         WHERE id = $1`,
        [id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({ success: true, message: 'Invitation renvoyée' });
  } catch (error) {
    console.error('Error resending invitation:', error);
    res.status(500).json({ error: 'Erreur lors du renvoi de l\'invitation' });
  }
});

// Sync signed-up status from player_accounts
router.post('/sync-signups', authenticateToken, async (req, res) => {
  try {
    // Update has_signed_up for invitations where player has created an account
    const result = await new Promise((resolve, reject) => {
      db.run(
        `UPDATE player_invitations pi
         SET has_signed_up = TRUE,
             signed_up_at = COALESCE(pi.signed_up_at, (
               SELECT pa.created_at FROM player_accounts pa
               WHERE REPLACE(pa.licence, ' ', '') = REPLACE(pi.licence, ' ', '')
             ))
         WHERE (pi.has_signed_up = FALSE OR pi.has_signed_up IS NULL OR pi.has_signed_up = 0)
           AND EXISTS (
             SELECT 1 FROM player_accounts pa
             WHERE REPLACE(pa.licence, ' ', '') = REPLACE(pi.licence, ' ', '')
           )`,
        [],
        function(err) {
          if (err) reject(err);
          else resolve({ changes: this.changes });
        }
      );
    });

    res.json({
      success: true,
      updated: result.changes,
      message: `${result.changes} invitation(s) mise(s) à jour`
    });
  } catch (error) {
    console.error('Error syncing signups:', error);
    res.status(500).json({ error: 'Erreur lors de la synchronisation' });
  }
});

// Get list of clubs for filtering
router.get('/clubs', authenticateToken, async (req, res) => {
  try {
    const clubs = await new Promise((resolve, reject) => {
      db.all(
        `SELECT DISTINCT club FROM player_contacts WHERE club IS NOT NULL AND club != '' ORDER BY club`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    res.json(clubs.map(c => c.club));
  } catch (error) {
    console.error('Error fetching clubs:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des clubs' });
  }
});

module.exports = router;
