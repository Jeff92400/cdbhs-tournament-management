/**
 * Player Invitations Routes
 *
 * Manages invitations for players to register on the Player App
 */

const express = require('express');
const { Resend } = require('resend');
const multer = require('multer');
const { authenticateToken, requireAdmin } = require('./auth');
const db = require('../db-loader');
const appSettings = require('../utils/app-settings');
const { logAdminAction, ACTION_TYPES } = require('../utils/admin-logger');

const router = express.Router();

// Configure multer for PDF uploads (memory storage for database)
const pdfUpload = multer({
  storage: multer.memoryStorage(),
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
const DEFAULT_EMAIL_SUBJECT = "Invitation à l'application joueurs Comité Départemental {organisation_short_name}";
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
    // Count invitations sent
    const invitationStats = await new Promise((resolve, reject) => {
      db.get(`SELECT COUNT(*) as total_sent FROM player_invitations`, [], (err, row) => {
        if (err) reject(err);
        else resolve(row || { total_sent: 0 });
      });
    });

    // Count actual Player App users (signed up) - exclude test accounts
    const playerAccountStats = await new Promise((resolve, reject) => {
      db.get(`SELECT COUNT(*) as signed_up FROM player_accounts WHERE UPPER(licence) NOT LIKE 'TEST%'`, [], (err, row) => {
        if (err) reject(err);
        else resolve(row || { signed_up: 0 });
      });
    });

    // Count pending invitations (sent but player hasn't signed up yet)
    const pendingStats = await new Promise((resolve, reject) => {
      db.get(`
        SELECT COUNT(*) as pending
        FROM player_invitations pi
        WHERE NOT EXISTS (
          SELECT 1 FROM player_accounts pa
          WHERE REPLACE(pa.licence, ' ', '') = REPLACE(pi.licence, ' ', '')
        )
      `, [], (err, row) => {
        if (err) reject(err);
        else resolve(row || { pending: 0 });
      });
    });

    const totalSent = invitationStats.total_sent || 0;
    const signedUp = playerAccountStats.signed_up || 0;
    const pending = pendingStats.pending || 0;

    res.json({
      total_sent: totalSent,
      signed_up: signedUp,
      pending: pending,
      signup_rate: totalSent > 0 ? Math.round(((totalSent - pending) / totalSent) * 100) : 0
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
    const { club, mode, rank, search, exclude_invited } = req.query;

    let query = `
      SELECT pc.id, pc.licence, pc.first_name, pc.last_name, pc.club, pc.email,
             pc.rank_libre, pc.rank_cadre, pc.rank_bande, pc.rank_3bandes,
             pi.id as invitation_id, pi.sent_at, pi.has_signed_up, pi.resend_count
      FROM player_contacts pc
      LEFT JOIN player_invitations pi ON pc.id = pi.player_contact_id
      WHERE pc.email IS NOT NULL
        AND pc.email != ''
        AND pc.email LIKE '%@%'
        AND COALESCE(pc.email_optin, 1) = 1
        AND COALESCE(pc.statut, 'Actif') = 'Actif'
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

    // Filter by game mode (has ranking in that mode)
    if (mode) {
      const modeColumn = {
        'LIBRE': 'rank_libre',
        'CADRE': 'rank_cadre',
        'BANDE': 'rank_bande',
        '3BANDES': 'rank_3bandes'
      }[mode.toUpperCase()];
      if (modeColumn) {
        query += ` AND pc.${modeColumn} IS NOT NULL AND pc.${modeColumn} != ''`;
      }
    }

    // Filter by FFB ranking
    if (rank) {
      query += ` AND (pc.rank_libre = $${paramIndex} OR pc.rank_cadre = $${paramIndex} OR pc.rank_bande = $${paramIndex} OR pc.rank_3bandes = $${paramIndex})`;
      params.push(rank);
      paramIndex++;
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

// Get PDF info (from database)
router.get('/pdf', authenticateToken, async (req, res) => {
  try {
    const pdf = await new Promise((resolve, reject) => {
      db.get('SELECT id, filename, content_type, LENGTH(file_data) as size, created_at FROM invitation_pdf ORDER BY created_at DESC LIMIT 1', [], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (pdf) {
      res.json({
        exists: true,
        filename: pdf.filename,
        size: pdf.size,
        lastModified: pdf.created_at,
        url: '/api/player-invitations/pdf/download'
      });
    } else {
      res.json({ exists: false });
    }
  } catch (error) {
    console.error('Error checking PDF:', error);
    res.status(500).json({ error: 'Erreur lors de la vérification du PDF' });
  }
});

// Download PDF (for viewing)
router.get('/pdf/download', authenticateToken, async (req, res) => {
  try {
    const pdf = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM invitation_pdf ORDER BY created_at DESC LIMIT 1', [], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!pdf) {
      return res.status(404).json({ error: 'PDF non trouvé' });
    }

    res.setHeader('Content-Type', pdf.content_type);
    res.setHeader('Content-Disposition', `inline; filename="${pdf.filename}"`);

    const fileData = Buffer.isBuffer(pdf.file_data) ? pdf.file_data : Buffer.from(pdf.file_data);
    res.send(fileData);
  } catch (error) {
    console.error('Error downloading PDF:', error);
    res.status(500).json({ error: 'Erreur lors du téléchargement du PDF' });
  }
});

// Upload PDF guide (admin only) - stores in database
router.post('/pdf', authenticateToken, requireAdmin, pdfUpload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier PDF fourni' });
    }

    const { originalname, mimetype, buffer } = req.file;
    const uploadedBy = req.user?.username || 'admin';

    // Delete existing PDF and insert new one
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM invitation_pdf', [], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO invitation_pdf (filename, content_type, file_data, uploaded_by) VALUES ($1, $2, $3, $4)',
        [originalname, mimetype, buffer, uploadedBy],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'PDF téléversé avec succès',
      filename: originalname,
      size: req.file.size
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

  // Check if PDF guide is uploaded
  const pdfExists = await new Promise((resolve, reject) => {
    db.get('SELECT id FROM invitation_pdf LIMIT 1', [], (err, row) => {
      if (err) reject(err);
      else resolve(!!row);
    });
  });

  if (!pdfExists) {
    return res.status(400).json({ error: 'Veuillez d\'abord télécharger un guide PDF dans les paramètres avant d\'envoyer des invitations.' });
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

    // Check for PDF attachment (from database)
    let pdfAttachment = null;
    const pdfRow = await new Promise((resolve, reject) => {
      db.get('SELECT filename, file_data FROM invitation_pdf ORDER BY created_at DESC LIMIT 1', [], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (pdfRow) {
      const pdfContent = Buffer.isBuffer(pdfRow.file_data) ? pdfRow.file_data : Buffer.from(pdfRow.file_data);
      pdfAttachment = {
        filename: pdfRow.filename || 'Guide-Application-Joueur.pdf',
        content: pdfContent
      };
      console.log('[Player Invitations] PDF found in DB, size:', pdfContent.length, 'bytes');
    } else {
      console.log('[Player Invitations] No PDF in database');
    }

    const senderName = emailSettings.email_sender_name || 'CDBHS';
    const senderEmail = emailSettings.email_communication || 'communication@cdbhs.net';
    const primaryColor = emailSettings.primary_color || '#1F4788';
    const orgName = emailSettings.organization_name || 'Comité Départemental Billard Hauts-de-Seine';
    const orgShortName = emailSettings.organization_short_name || 'CDBHS';
    const replyToEmail = emailSettings.summary_email || 'cdbhs92@gmail.com';
    const baseUrl = process.env.BASE_URL || 'https://cdbhs-tournament-management-production.up.railway.app';

    // Logo URL - always include, onerror will hide if not found
    // Add cache-busting timestamp to ensure email clients get latest logo
    const logoUrl = `${baseUrl}/logo.png?v=${Date.now()}`;
    console.log('[Player Invitations] Using logo URL:', logoUrl);

    let sentCount = 0;
    let failedCount = 0;
    const errors = [];
    const sentPlayers = [];

    for (const player of players) {
      try {
        const recipientEmail = isTestMode ? test_email : player.email;
        const firstName = player.first_name || 'Joueur';

        // Replace template variables
        const emailBody = templateBody
          .replace(/\{first_name\}/g, firstName)
          .replace(/\{organisation_name\}/g, orgName)
          .replace(/\{organization_name\}/g, orgName)
          .replace(/\{organisation_short_name\}/g, orgShortName)
          .replace(/\{organization_short_name\}/g, orgShortName)
          .replace(/\{organisation_email\}/g, replyToEmail)
          .replace(/\{organization_email\}/g, replyToEmail);

        const emailSubject = templateSubject
          .replace(/\{first_name\}/g, firstName)
          .replace(/\{organisation_name\}/g, orgName)
          .replace(/\{organization_name\}/g, orgName)
          .replace(/\{organisation_short_name\}/g, orgShortName)
          .replace(/\{organization_short_name\}/g, orgShortName)
          .replace(/\{organisation_email\}/g, replyToEmail)
          .replace(/\{organization_email\}/g, replyToEmail);

        // Build HTML email
        const logoHtml = `<img src="${logoUrl}" alt="${orgShortName}" style="height: 60px; margin-bottom: 10px;" onerror="this.style.display='none'">`;

        const htmlBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: ${primaryColor}; color: white; padding: 20px; text-align: center;">
              ${logoHtml}
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
        sentPlayers.push(player);
        await delay(1500); // Rate limiting
      } catch (error) {
        console.error(`Error sending to ${player.email}:`, error.message);
        failedCount++;
        errors.push({ player: `${player.first_name} ${player.last_name}`, error: error.message });
      }
    }

    // Send summary email to organization (only if not test mode and at least one sent)
    if (!isTestMode && sentCount > 0) {
      try {
        const recipientListHtml = sentPlayers.map((p, idx) => `
          <tr style="background: ${idx % 2 === 0 ? '#fff' : '#f8f9fa'};">
            <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${idx + 1}</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${p.first_name} ${p.last_name}</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${p.club || '-'}</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${p.email}</td>
          </tr>
        `).join('');

        const summaryHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
            <div style="background: ${primaryColor}; color: white; padding: 20px; text-align: center;">
              <img src="${logoUrl}" alt="${orgShortName}" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
              <h1 style="margin: 0; font-size: 24px;">📋 Récapitulatif Invitations Player App</h1>
            </div>
            <div style="padding: 20px; background: #f8f9fa; line-height: 1.6;">
              <div style="background: #d4edda; border-left: 4px solid #28a745; padding: 15px; margin-bottom: 20px;">
                <strong>✅ Envoi terminé avec succès</strong><br>
                ${sentCount} invitation(s) envoyée(s) sur ${players.length} joueur(s)
                ${failedCount > 0 ? `<br><span style="color: #dc3545;">${failedCount} échec(s)</span>` : ''}
              </div>

              <h3 style="color: ${primaryColor};">📧 Invitations Envoyées (${sentCount})</h3>
              <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13px;">
                <thead>
                  <tr style="background: ${primaryColor}; color: white;">
                    <th style="padding: 10px; border: 1px solid #ddd;">#</th>
                    <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Joueur</th>
                    <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Club</th>
                    <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Email</th>
                  </tr>
                </thead>
                <tbody>
                  ${recipientListHtml}
                </tbody>
              </table>

              ${errors.length > 0 ? `
                <h3 style="color: #dc3545;">❌ Échecs (${errors.length})</h3>
                <ul style="color: #dc3545;">
                  ${errors.map(e => `<li>${e.player}: ${e.error}</li>`).join('')}
                </ul>
              ` : ''}
            </div>
            <div style="background: ${primaryColor}; color: white; padding: 10px; text-align: center; font-size: 12px;">
              <p style="margin: 0;">${orgShortName} - ${replyToEmail}</p>
            </div>
          </div>
        `;

        await resend.emails.send({
          from: `${senderName} <${senderEmail}>`,
          replyTo: replyToEmail,
          to: [replyToEmail],
          subject: `📋 Récapitulatif - ${sentCount} invitation(s) Player App envoyée(s)`,
          html: summaryHtml
        });

        console.log(`Summary email sent to ${replyToEmail}`);
      } catch (summaryError) {
        console.error('Error sending summary email:', summaryError);
        // Don't fail the whole operation if summary email fails
      }
    }

    // Log the action
    if (!isTestMode && sentCount > 0) {
      logAdminAction({
        req,
        action: ACTION_TYPES.SEND_INVITATION,
        details: `Invitations Player App: ${sentCount} envoyées, ${failedCount} échecs`,
        targetType: 'invitation',
        targetId: null,
        targetName: `${sentCount} invitations`
      });
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
    const baseUrl = process.env.BASE_URL || 'https://cdbhs-tournament-management-production.up.railway.app';

    // Logo URL - always include, onerror will hide if not found
    // Add cache-busting timestamp to ensure email clients get latest logo
    const logoUrl = `${baseUrl}/logo.png?v=${Date.now()}`;
    const logoHtml = `<img src="${logoUrl}" alt="${orgShortName}" style="height: 60px; margin-bottom: 10px;" onerror="this.style.display='none'">`;

    const emailBody = templateBody
      .replace(/\{first_name\}/g, firstName)
      .replace(/\{organisation_name\}/g, orgName)
      .replace(/\{organization_name\}/g, orgName)
      .replace(/\{organisation_short_name\}/g, orgShortName)
      .replace(/\{organization_short_name\}/g, orgShortName)
      .replace(/\{organisation_email\}/g, replyToEmail)
      .replace(/\{organization_email\}/g, replyToEmail);

    let emailSubject = templateSubject
      .replace(/\{first_name\}/g, firstName)
      .replace(/\{organisation_name\}/g, orgName)
      .replace(/\{organization_name\}/g, orgName)
      .replace(/\{organisation_short_name\}/g, orgShortName)
      .replace(/\{organization_short_name\}/g, orgShortName)
      .replace(/\{organisation_email\}/g, replyToEmail)
      .replace(/\{organization_email\}/g, replyToEmail);

    // Add "Rappel amical" prefix for resends
    const reminderCount = (invitation.resend_count || 0) + 1;
    if (reminderCount === 1) {
      emailSubject = `Rappel amical - ${emailSubject}`;
    } else {
      emailSubject = `Rappel amical (${reminderCount}) - ${emailSubject}`;
    }

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: ${primaryColor}; color: white; padding: 20px; text-align: center;">
          ${logoHtml}
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

    // Check for PDF attachment (from database)
    const emailOptions = {
      from: `${senderName} <${senderEmail}>`,
      replyTo: replyToEmail,
      to: [invitation.email],
      subject: emailSubject,
      html: htmlBody
    };

    const pdfRow = await new Promise((resolve, reject) => {
      db.get('SELECT filename, file_data FROM invitation_pdf ORDER BY created_at DESC LIMIT 1', [], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (pdfRow) {
      const pdfContent = Buffer.isBuffer(pdfRow.file_data) ? pdfRow.file_data : Buffer.from(pdfRow.file_data);
      emailOptions.attachments = [{
        filename: pdfRow.filename || 'Guide-Application-Joueur.pdf',
        content: pdfContent
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

// Batch resend invitations (for multiple "En attente" players)
router.post('/resend-batch', authenticateToken, async (req, res) => {
  const { invitation_ids } = req.body;

  if (!invitation_ids || !Array.isArray(invitation_ids) || invitation_ids.length === 0) {
    return res.status(400).json({ error: 'Liste des invitations requise' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'Configuration email manquante (RESEND_API_KEY)' });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    // Get all pending invitations that match the IDs
    const placeholders = invitation_ids.map((_, i) => `$${i + 1}`).join(', ');
    const invitations = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM player_invitations WHERE id IN (${placeholders}) AND has_signed_up IS NOT TRUE`,
        invitation_ids,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    if (invitations.length === 0) {
      return res.json({ success: true, sent: 0, message: 'Aucune invitation en attente à renvoyer' });
    }

    // Get email settings
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

    const orgName = emailSettings.organization_name || 'Comité Départemental Billard Hauts-de-Seine';
    const orgShortName = emailSettings.organization_short_name || 'CDBHS';
    const senderName = emailSettings.email_sender_name || 'CDBHS';
    const senderEmail = emailSettings.email_communication || 'communication@cdbhs.net';
    const primaryColor = emailSettings.primary_color || '#1F4788';
    const replyToEmail = emailSettings.summary_email || 'cdbhs92@gmail.com';
    const baseUrl = process.env.BASE_URL || 'https://cdbhs-tournament-management-production.up.railway.app';
    const logoUrl = `${baseUrl}/logo.png?v=${Date.now()}`;
    const logoHtml = `<img src="${logoUrl}" alt="${orgShortName}" style="height: 60px; margin-bottom: 10px;" onerror="this.style.display='none'">`;

    // Get PDF attachment
    const pdfRow = await new Promise((resolve, reject) => {
      db.get('SELECT filename, file_data FROM invitation_pdf ORDER BY created_at DESC LIMIT 1', [], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    let sentCount = 0;
    let errors = [];

    // Send emails one by one with small delay
    for (const invitation of invitations) {
      try {
        const firstName = invitation.first_name || 'Joueur';

        const emailBody = templateBody
          .replace(/\{first_name\}/g, firstName)
          .replace(/\{organisation_name\}/g, orgName)
          .replace(/\{organization_name\}/g, orgName)
          .replace(/\{organisation_short_name\}/g, orgShortName)
          .replace(/\{organization_short_name\}/g, orgShortName)
          .replace(/\{organisation_email\}/g, replyToEmail)
          .replace(/\{organization_email\}/g, replyToEmail);

        const reminderCount = (invitation.resend_count || 0) + 1;
        let emailSubject = templateSubject
          .replace(/\{first_name\}/g, firstName)
          .replace(/\{organisation_name\}/g, orgName)
          .replace(/\{organization_name\}/g, orgName)
          .replace(/\{organisation_short_name\}/g, orgShortName)
          .replace(/\{organization_short_name\}/g, orgShortName)
          .replace(/\{organisation_email\}/g, replyToEmail)
          .replace(/\{organization_email\}/g, replyToEmail);

        // Add "Rappel amical" prefix for resends
        if (reminderCount === 1) {
          emailSubject = `Rappel amical - ${emailSubject}`;
        } else {
          emailSubject = `Rappel amical (${reminderCount}) - ${emailSubject}`;
        }

        const htmlBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: ${primaryColor}; color: white; padding: 20px; text-align: center;">
              ${logoHtml}
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
          to: [invitation.email],
          subject: emailSubject,
          html: htmlBody
        };

        if (pdfRow) {
          const pdfContent = Buffer.isBuffer(pdfRow.file_data) ? pdfRow.file_data : Buffer.from(pdfRow.file_data);
          emailOptions.attachments = [{
            filename: pdfRow.filename || 'Guide-Application-Joueur.pdf',
            content: pdfContent
          }];
        }

        await resend.emails.send(emailOptions);

        // Update resend count
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE player_invitations SET resend_count = resend_count + 1, last_resent_at = NOW() WHERE id = $1`,
            [invitation.id],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });

        sentCount++;

        // Small delay between emails to avoid rate limiting
        await new Promise(r => setTimeout(r, 100));

      } catch (err) {
        console.error(`Error sending reminder to ${invitation.email}:`, err.message);
        errors.push({ email: invitation.email, error: err.message });
      }
    }

    console.log(`Batch resend: ${sentCount}/${invitations.length} reminders sent`);

    res.json({
      success: true,
      sent: sentCount,
      total: invitations.length,
      errors: errors.length > 0 ? errors : undefined,
      message: `${sentCount} rappel(s) envoyé(s) sur ${invitations.length}`
    });

  } catch (error) {
    console.error('Error in batch resend:', error);
    res.status(500).json({ error: 'Erreur lors de l\'envoi des rappels' });
  }
});

// Sync signed-up status from player_accounts
router.post('/sync-signups', authenticateToken, async (req, res) => {
  try {
    // Get all pending invitations
    const pendingInvitations = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, licence FROM player_invitations WHERE has_signed_up IS NOT TRUE`,
        [],
        (err, rows) => {
          if (err) {
            console.error('Error fetching pending invitations:', err);
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });

    console.log(`Found ${pendingInvitations.length} pending invitations`);

    // Get all player accounts
    const playerAccounts = await new Promise((resolve, reject) => {
      db.all(
        `SELECT licence, created_at FROM player_accounts`,
        [],
        (err, rows) => {
          if (err) {
            console.error('Error fetching player accounts:', err);
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });

    console.log(`Found ${playerAccounts.length} player accounts`);

    // Create a map of normalized licences to created_at
    const accountMap = new Map();
    for (const pa of playerAccounts) {
      if (pa.licence) {
        const normalizedLicence = pa.licence.replace(/\s+/g, '').toUpperCase();
        accountMap.set(normalizedLicence, pa.created_at || new Date().toISOString());
      }
    }

    // Update invitations where player has signed up
    let updatedCount = 0;
    for (const inv of pendingInvitations) {
      if (!inv.licence) continue;

      const normalizedLicence = inv.licence.replace(/\s+/g, '').toUpperCase();
      const signedUpAt = accountMap.get(normalizedLicence);

      if (signedUpAt) {
        console.log(`Updating invitation ${inv.id} for licence ${inv.licence}`);
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE player_invitations SET has_signed_up = TRUE, signed_up_at = $1 WHERE id = $2`,
            [signedUpAt, inv.id],
            function(err) {
              if (err) {
                console.error(`Error updating invitation ${inv.id}:`, err);
                reject(err);
              } else {
                resolve();
              }
            }
          );
        });
        updatedCount++;
      }
    }

    res.json({
      success: true,
      updated: updatedCount,
      message: `${updatedCount} invitation(s) mise(s) à jour`
    });
  } catch (error) {
    console.error('Error syncing signups:', error);
    res.status(500).json({ error: 'Erreur lors de la synchronisation: ' + error.message });
  }
});

// Delete an invitation
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM player_invitations WHERE id = $1',
        [id],
        function(err) {
          if (err) reject(err);
          else resolve({ changes: this.changes });
        }
      );
    });

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Invitation non trouvée' });
    }

    res.json({ success: true, message: 'Invitation supprimée' });
  } catch (error) {
    console.error('Error deleting invitation:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

// Get list of clubs for filtering (from official clubs table only)
router.get('/clubs', authenticateToken, async (req, res) => {
  try {
    const clubs = await new Promise((resolve, reject) => {
      db.all(
        `SELECT name FROM clubs ORDER BY name`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    res.json(clubs.map(c => c.name));
  } catch (error) {
    console.error('Error fetching clubs:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des clubs' });
  }
});

module.exports = router;
