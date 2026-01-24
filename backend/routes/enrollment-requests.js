/**
 * Enrollment Requests Routes
 *
 * Admin endpoints for managing player enrollment requests
 *
 * GET    /api/enrollment-requests             - List all requests (filterable by status)
 * PUT    /api/enrollment-requests/:id/approve - Approve a request
 * PUT    /api/enrollment-requests/:id/reject  - Reject a request
 * DELETE /api/enrollment-requests/:id         - Delete a request
 */

const express = require('express');
const router = express.Router();
const db = require('../db-loader');
const { authenticateToken, requireAdmin } = require('./auth');
const { logAdminAction, ACTION_TYPES } = require('../utils/admin-logger');
const { Resend } = require('resend');
const appSettings = require('../utils/app-settings');

// Initialize Resend for direct email sending
const getResend = () => {
  if (!process.env.RESEND_API_KEY) {
    console.log('[EMAIL] RESEND_API_KEY not configured');
    return null;
  }
  return new Resend(process.env.RESEND_API_KEY);
};

// Get email settings from database
async function getEmailSettings() {
  const settings = {};
  settings.primary_color = await appSettings.getSetting('primary_color') || '#1F4788';
  settings.sender_name = await appSettings.getSetting('email_sender_name') || 'CDBHS';
  settings.email_from = await appSettings.getSetting('email_noreply') || 'noreply@cdbhs.net';
  settings.org_short_name = await appSettings.getSetting('organization_short_name') || 'CDBHS';
  settings.contact_email = await appSettings.getSetting('summary_email') || '';
  return settings;
}

/**
 * GET /api/enrollment-requests/debug-announcements/:licence
 * Debug endpoint to check announcements for a player (PUBLIC - no auth)
 */
router.get('/debug-announcements/:licence', async (req, res) => {
  try {
    const { licence } = req.params;
    const normalizedLicence = licence.replace(/\s+/g, '').toUpperCase();

    const result = await db.query(`
      SELECT id, title, message, type, is_active, expires_at, target_licence, created_at
      FROM announcements
      WHERE UPPER(REPLACE(COALESCE(target_licence, ''), ' ', '')) = $1
      ORDER BY created_at DESC
      LIMIT 10
    `, [normalizedLicence]);

    res.json({
      licence: normalizedLicence,
      count: result.rows.length,
      announcements: result.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// All routes below require authentication and admin role
router.use(authenticateToken);
router.use(requireAdmin);

// Helper function to send approval email directly via Resend
async function sendApprovalEmail(request) {
  console.log(`[APPROVAL EMAIL] Starting email send to ${request.player_email}`);

  const resend = getResend();
  if (!resend) {
    console.log('[APPROVAL EMAIL] Resend not configured, skipping email');
    return { success: false, reason: 'resend_not_configured' };
  }

  try {
    const settings = await getEmailSettings();
    console.log(`[APPROVAL EMAIL] Using sender: ${settings.sender_name} <${settings.email_from}>`);

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
                      Bonjour <strong>${request.player_name}</strong>,
                    </p>
                    <p style="font-size: 16px; color: #333333; margin: 0 0 20px 0;">
                      Bonne nouvelle ! Votre demande d'inscription a été <strong style="color: #28a745;">acceptée</strong>.
                    </p>
                    <table style="width: 100%; background-color: #d4edda; border-radius: 8px; padding: 20px; margin: 20px 0;">
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Mode de jeu :</strong> ${request.game_mode_name || '-'}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Catégorie :</strong> ${request.requested_ranking || '-'}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Tournoi :</strong> ${request.tournament_number || '-'}
                        </td>
                      </tr>
                    </table>
                    <p style="font-size: 16px; color: #333333; margin: 20px 0;">
                      Vous recevrez une convocation avec les détails (lieu, heure, poule) quelques jours avant la compétition.
                    </p>
                    <p style="font-size: 16px; color: #333333; margin: 20px 0 0 0;">
                      Cordialement,<br>
                      <strong>${settings.org_short_name}</strong>
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="background-color: #f8f9fa; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; font-size: 12px; color: #666666;">
                    ${settings.contact_email ? `Contact : <a href="mailto:${settings.contact_email}" style="color: ${settings.primary_color};">${settings.contact_email}</a>` : ''}
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
      from: `${settings.sender_name} <${settings.email_from}>`,
      to: request.player_email,
      subject: `Demande acceptée - ${request.game_mode_name} ${request.requested_ranking} T${request.tournament_number}`,
      html: emailHtml
    });

    console.log(`[APPROVAL EMAIL] Email sent successfully to ${request.player_email}`);
    return { success: true };
  } catch (error) {
    console.error('[APPROVAL EMAIL] Error sending email:', error.message);
    return { success: false, reason: 'exception', error: error.message };
  }
}

// Helper function to send rejection email directly via Resend
async function sendRejectionEmail(request, reason) {
  console.log(`[REJECTION EMAIL] Starting email send to ${request.player_email}`);

  const resend = getResend();
  if (!resend) {
    console.log('[REJECTION EMAIL] Resend not configured, skipping email');
    return { success: false, reason: 'resend_not_configured' };
  }

  try {
    const settings = await getEmailSettings();
    console.log(`[REJECTION EMAIL] Using sender: ${settings.sender_name} <${settings.email_from}>`);

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
                      Bonjour <strong>${request.player_name}</strong>,
                    </p>
                    <p style="font-size: 16px; color: #333333; margin: 0 0 20px 0;">
                      Nous sommes au regret de vous informer que votre demande d'inscription a été <strong style="color: #dc3545;">refusée</strong>.
                    </p>
                    <table style="width: 100%; background-color: #f8d7da; border-radius: 8px; padding: 20px; margin: 20px 0;">
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Mode de jeu :</strong> ${request.game_mode_name || '-'}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Catégorie :</strong> ${request.requested_ranking || '-'}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 20px;">
                          <strong>Tournoi :</strong> ${request.tournament_number || '-'}
                        </td>
                      </tr>
                      ${reason ? `<tr><td style="padding: 8px 20px;"><strong>Raison :</strong> ${reason}</td></tr>` : ''}
                    </table>
                    <p style="font-size: 16px; color: #333333; margin: 20px 0;">
                      Si vous avez des questions, n'hésitez pas à nous contacter.
                    </p>
                    <p style="font-size: 16px; color: #333333; margin: 20px 0 0 0;">
                      Cordialement,<br>
                      <strong>${settings.org_short_name}</strong>
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="background-color: #f8f9fa; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; font-size: 12px; color: #666666;">
                    ${settings.contact_email ? `Contact : <a href="mailto:${settings.contact_email}" style="color: ${settings.primary_color};">${settings.contact_email}</a>` : ''}
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
      from: `${settings.sender_name} <${settings.email_from}>`,
      to: request.player_email,
      subject: `Demande refusée - ${request.game_mode_name} ${request.requested_ranking} T${request.tournament_number}`,
      html: emailHtml
    });

    console.log(`[REJECTION EMAIL] Email sent successfully to ${request.player_email}`);
    return { success: true };
  } catch (error) {
    console.error('[REJECTION EMAIL] Error sending email:', error.message);
    return { success: false, reason: 'exception', error: error.message };
  }
}

/**
 * GET /api/enrollment-requests
 * List all enrollment requests with optional status and season filter
 */
router.get('/', async (req, res) => {
  try {
    const { status, season, limit = 100, offset = 0 } = req.query;

    // Calculate season date range (season format: "2024-2025")
    let seasonStart = null;
    let seasonEnd = null;
    if (season) {
      const [startYear] = season.split('-').map(Number);
      seasonStart = `${startYear}-09-01`;
      seasonEnd = `${startYear + 1}-08-31`;
    }

    let sql = `
      SELECT er.*, gm.display_name as game_mode_display
      FROM enrollment_requests er
      LEFT JOIN game_modes gm ON er.game_mode_id = gm.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (seasonStart && seasonEnd) {
      sql += ` AND er.created_at >= $${paramIndex++} AND er.created_at <= $${paramIndex++}`;
      params.push(seasonStart, seasonEnd);
    }

    if (status) {
      sql += ` AND er.status = $${paramIndex++}`;
      params.push(status);
    }

    sql += ` ORDER BY
      CASE er.status
        WHEN 'pending' THEN 1
        WHEN 'approved' THEN 2
        WHEN 'rejected' THEN 3
        WHEN 'convoked' THEN 4
        WHEN 'deleted' THEN 5
      END,
      er.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(sql, params);

    // Get counts by status for the selected season
    let countSql = `
      SELECT status, COUNT(*) as count
      FROM enrollment_requests
      WHERE 1=1
    `;
    const countParams = [];
    let countParamIndex = 1;

    if (seasonStart && seasonEnd) {
      countSql += ` AND created_at >= $${countParamIndex++} AND created_at <= $${countParamIndex++}`;
      countParams.push(seasonStart, seasonEnd);
    }

    countSql += ` GROUP BY status`;

    const countResult = await db.query(countSql, countParams);
    const counts = {};
    (countResult.rows || []).forEach(row => {
      counts[row.status] = parseInt(row.count);
    });

    res.json({
      requests: result.rows || [],
      counts: counts,
      total: (result.rows || []).length,
      limit: parseInt(limit),
      offset: parseInt(offset),
      season: season
    });

  } catch (error) {
    console.error('Error fetching enrollment requests:', error);
    res.status(500).json({ error: 'Failed to fetch enrollment requests' });
  }
});

/**
 * DELETE /api/enrollment-requests/purge
 * Permanently delete all 'deleted' enrollment requests for a season
 */
router.delete('/purge', async (req, res) => {
  console.log('[PURGE] Purge endpoint called');
  try {
    const { season } = req.query;
    console.log(`[PURGE] Season: ${season}`);

    if (!season) {
      return res.status(400).json({ error: 'Season is required' });
    }

    // Calculate season date range
    const [startYear] = season.split('-').map(Number);
    const seasonStart = `${startYear}-09-01`;
    const seasonEnd = `${startYear + 1}-08-31`;
    console.log(`[PURGE] Date range: ${seasonStart} to ${seasonEnd}`);

    // Count before purging
    const countResult = await db.query(`
      SELECT COUNT(*) as count
      FROM enrollment_requests
      WHERE status = 'deleted'
        AND created_at >= $1 AND created_at <= $2
    `, [seasonStart, seasonEnd]);

    const countToPurge = parseInt(countResult.rows[0]?.count || 0);
    console.log(`[PURGE] Count to purge: ${countToPurge}`);

    if (countToPurge === 0) {
      return res.json({ success: true, purged: 0, message: 'Aucune demande à purger' });
    }

    // Permanently delete
    await db.query(`
      DELETE FROM enrollment_requests
      WHERE status = 'deleted'
        AND created_at >= $1 AND created_at <= $2
    `, [seasonStart, seasonEnd]);

    // Log admin action (non-blocking)
    try {
      logAdminAction({
        req,
        action: 'enrollment_requests_purged',
        details: `Purged ${countToPurge} deleted enrollment requests for season ${season}`,
        targetType: 'enrollment_request',
        targetId: 'bulk',
        targetName: `Season ${season}`
      });
    } catch (logErr) {
      console.error('[PURGE] Failed to log admin action:', logErr.message);
    }

    console.log(`[PURGE] Successfully purged ${countToPurge} deleted enrollment requests for season ${season}`);

    res.json({
      success: true,
      purged: countToPurge,
      message: `${countToPurge} demande(s) purgée(s)`
    });

  } catch (error) {
    console.error('[PURGE] Error purging enrollment requests:', error.message);
    console.error('[PURGE] Stack:', error.stack);
    res.status(500).json({ error: 'Failed to purge enrollment requests', details: error.message });
  }
});

// Debug route to check route matching
router.all('/test-route', (req, res) => {
  res.json({ route: 'test-route', method: req.method });
});

/**
 * PUT /api/enrollment-requests/:id/approve
 * Approve an enrollment request and create inscription
 */
router.put('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;

    // Get the request
    const requestResult = await db.query(
      'SELECT * FROM enrollment_requests WHERE id = $1',
      [id]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const request = requestResult.rows[0];

    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Request is not pending' });
    }

    // Find the matching tournament for this season
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    let seasonStart, seasonEnd;
    if (month >= 8) {
      seasonStart = `${year}-09-01`;
      seasonEnd = `${year + 1}-08-31`;
    } else {
      seasonStart = `${year - 1}-09-01`;
      seasonEnd = `${year}-08-31`;
    }

    // Find the tournament matching mode, category, and tournament number
    const tournamentNum = request.tournament_number;
    const tournamentResult = await db.query(`
      SELECT tournoi_id, nom, mode, categorie, debut, lieu
      FROM tournoi_ext
      WHERE UPPER(mode) LIKE UPPER($1)
        AND UPPER(categorie) = UPPER($2)
        AND debut >= $3 AND debut <= $4
        AND (UPPER(nom) LIKE $5
             OR UPPER(nom) LIKE $6
             OR UPPER(nom) LIKE $7)
        AND UPPER(nom) NOT LIKE '%FINALE%'
        AND (status IS NULL OR status != 'cancelled')
      ORDER BY debut ASC
      LIMIT 1
    `, [
      '%' + request.game_mode_name + '%',
      request.requested_ranking,
      seasonStart,
      seasonEnd,
      '%T' + tournamentNum + '%',
      '%TOURNOI ' + tournamentNum + '%',
      '%TOUR ' + tournamentNum + '%'
    ]);

    let tournamentId = null;
    let tournamentInfo = null;

    if (tournamentResult.rows.length > 0) {
      tournamentInfo = tournamentResult.rows[0];
      tournamentId = tournamentInfo.tournoi_id;

      // Check if player is already inscribed
      const existingInscription = await db.query(
        `SELECT inscription_id FROM inscriptions
         WHERE REPLACE(UPPER(licence), ' ', '') = REPLACE(UPPER($1), ' ', '')
           AND tournoi_id = $2`,
        [request.licence, tournamentId]
      );

      if (existingInscription.rows.length === 0) {
        // Create inscription
        // Get the next inscription_id
        const maxIdResult = await db.query('SELECT COALESCE(MAX(inscription_id), 0) + 1 as next_id FROM inscriptions');
        const nextId = maxIdResult.rows[0].next_id;

        await db.query(`
          INSERT INTO inscriptions (inscription_id, licence, tournoi_id, email, timestamp, source, statut)
          VALUES ($1, $2, $3, $4, NOW(), 'player_app', 'inscrit')
        `, [nextId, request.licence, tournamentId, request.player_email]);

        console.log(`Created inscription for ${request.player_name} in tournament ${tournamentId}`);
      }
    }

    // Add player to rankings with 0 points if not already present
    // This is non-blocking - if it fails, the approval still proceeds
    try {
      // Find the matching category
      const categoryResult = await db.query(`
        SELECT id FROM categories
        WHERE UPPER(game_type) = UPPER($1)
          AND UPPER(level) = UPPER($2)
      `, [request.game_mode_name, request.requested_ranking]);

      if (categoryResult.rows.length > 0) {
        const categoryId = categoryResult.rows[0].id;

        // Determine current season
        const seasonYear = month >= 8 ? year : year - 1;
        const currentSeason = `${seasonYear}-${seasonYear + 1}`;

        // Check if player exists in players table (required for foreign key)
        const playerExists = await db.query(`
          SELECT licence FROM players
          WHERE REPLACE(UPPER(licence), ' ', '') = REPLACE(UPPER($1), ' ', '')
        `, [request.licence]);

        if (playerExists.rows.length > 0) {
          const actualLicence = playerExists.rows[0].licence;

          // Check if player already has a ranking for this category/season
          const existingRanking = await db.query(`
            SELECT id FROM rankings
            WHERE REPLACE(UPPER(licence), ' ', '') = REPLACE(UPPER($1), ' ', '')
              AND category_id = $2
              AND season = $3
          `, [request.licence, categoryId, currentSeason]);

          if (existingRanking.rows.length === 0) {
            // Get current max rank position for this category/season
            const maxRankResult = await db.query(`
              SELECT COALESCE(MAX(rank_position), 0) as max_rank
              FROM rankings
              WHERE category_id = $1 AND season = $2
            `, [categoryId, currentSeason]);
            const newRankPosition = maxRankResult.rows[0].max_rank + 1;

            // Insert ranking with 0 points (player starts at bottom)
            await db.query(`
              INSERT INTO rankings (category_id, season, licence, total_match_points, avg_moyenne, best_serie, rank_position, tournament_1_points, tournament_2_points, tournament_3_points)
              VALUES ($1, $2, $3, 0, 0, 0, $4, NULL, NULL, NULL)
            `, [categoryId, currentSeason, actualLicence, newRankPosition]);

            console.log(`Added ${request.player_name} to rankings for category ${categoryId} (${request.game_mode_name} ${request.requested_ranking}) at position ${newRankPosition}`);
          }
        } else {
          console.log(`Player ${request.licence} not found in players table - skipping ranking creation`);
        }
      }
    } catch (rankingError) {
      // Don't fail the approval if ranking creation fails
      console.error('Error adding player to rankings (non-blocking):', rankingError.message);
    }

    // Also add to player_rankings table for tournament eligibility checks
    // This allows the player to see and inscribe to ALL tournaments in this category (T1, T2, T3)
    try {
      const existingPlayerRanking = await db.query(`
        SELECT id FROM player_rankings
        WHERE REPLACE(licence, ' ', '') = REPLACE($1, ' ', '')
        AND game_mode_id = $2
      `, [request.licence, request.game_mode_id]);

      if (existingPlayerRanking.rows.length === 0) {
        await db.query(`
          INSERT INTO player_rankings (licence, game_mode_id, ranking)
          VALUES ($1, $2, $3)
        `, [request.licence, request.game_mode_id, request.requested_ranking]);

        console.log(`Added player_ranking for ${request.player_name}: ${request.game_mode_name} ${request.requested_ranking}`);
      } else {
        // Update existing ranking if it's different (shouldn't happen normally)
        await db.query(`
          UPDATE player_rankings
          SET ranking = $1
          WHERE REPLACE(licence, ' ', '') = REPLACE($2, ' ', '')
          AND game_mode_id = $3
        `, [request.requested_ranking, request.licence, request.game_mode_id]);

        console.log(`Updated player_ranking for ${request.player_name}: ${request.game_mode_name} ${request.requested_ranking}`);
      }
    } catch (playerRankingError) {
      console.error('Error adding player_ranking (non-blocking):', playerRankingError.message);
    }

    // Update request status to approved
    await db.query(`
      UPDATE enrollment_requests
      SET status = 'approved',
          processed_at = NOW(),
          processed_by = $1
      WHERE id = $2
    `, [req.user.username || req.user.email || 'admin', id]);

    // Log admin action
    logAdminAction({
      req,
      action: 'enrollment_request_approved',
      details: `Approved enrollment request for ${request.player_name}: ${request.game_mode_name} ${request.requested_ranking} T${request.tournament_number}`,
      targetType: 'enrollment_request',
      targetId: id.toString(),
      targetName: `${request.player_name} - ${request.game_mode_name} ${request.requested_ranking}`
    });

    // Create in-app notification for the player
    // IMPORTANT: Must match Player App normalization: remove spaces AND uppercase
    const normalizedLicence = request.licence.replace(/\s+/g, '').toUpperCase();
    console.log(`[APPROVAL] Creating announcement for licence: ${normalizedLicence}`);

    let announcementCreated = false;
    let announcementError = null;
    try {
      const annResult = await db.query(
        `INSERT INTO announcements (title, message, type, is_active, created_by, target_licence)
         VALUES ($1, $2, $3, TRUE, $4, $5)
         RETURNING id`,
        [
          'Demande acceptée',
          `Votre demande d'inscription en ${request.game_mode_name} ${request.requested_ranking} (Tournoi ${request.tournament_number}) a été acceptée.`,
          'info',
          req.user.username || 'admin',
          normalizedLicence
        ]
      );
      announcementCreated = true;
      console.log(`[APPROVAL] Announcement created with id=${annResult.rows[0]?.id} for ${normalizedLicence}`);
    } catch (annErr) {
      announcementError = annErr.message;
      console.error('[APPROVAL] Failed to create announcement:', annErr.message, annErr.stack);
    }

    // Send approval email to player
    let emailResult = null;
    try {
      emailResult = await sendApprovalEmail(request);
    } catch (err) {
      console.error('[APPROVAL] Failed to send approval email:', err);
      emailResult = { success: false, reason: 'exception', error: err.message };
    }

    res.json({
      success: true,
      message: 'Demande approuvée',
      inscriptionCreated: tournamentId !== null,
      tournament: tournamentInfo,
      announcementCreated,
      announcementError,
      targetLicence: normalizedLicence,
      emailResult
    });

  } catch (error) {
    console.error('Error approving enrollment request:', error);
    res.status(500).json({ error: 'Failed to approve request' });
  }
});

/**
 * PUT /api/enrollment-requests/:id/reject
 * Reject an enrollment request
 */
router.put('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    // Get the request
    const requestResult = await db.query(
      'SELECT * FROM enrollment_requests WHERE id = $1',
      [id]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const request = requestResult.rows[0];

    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Request is not pending' });
    }

    // Update request status to rejected
    await db.query(`
      UPDATE enrollment_requests
      SET status = 'rejected',
          rejection_reason = $1,
          processed_at = NOW(),
          processed_by = $2
      WHERE id = $3
    `, [reason || null, req.user.username || req.user.email || 'admin', id]);

    // Log admin action
    logAdminAction({
      req,
      action: 'enrollment_request_rejected',
      details: `Rejected enrollment request for ${request.player_name}: ${request.game_mode_name} ${request.requested_ranking} T${request.tournament_number}${reason ? ' - Reason: ' + reason : ''}`,
      targetType: 'enrollment_request',
      targetId: id.toString(),
      targetName: `${request.player_name} - ${request.game_mode_name} ${request.requested_ranking}`
    });

    // Create in-app notification for the player
    const normalizedLicence = request.licence.replace(/\s+/g, '');
    console.log(`[REJECTION] Creating announcement for licence: ${normalizedLicence}`);

    const rejectionMessage = reason
      ? `Votre demande d'inscription en ${request.game_mode_name} ${request.requested_ranking} (Tournoi ${request.tournament_number}) a été refusée. Raison : ${reason}`
      : `Votre demande d'inscription en ${request.game_mode_name} ${request.requested_ranking} (Tournoi ${request.tournament_number}) a été refusée.`;

    try {
      await db.query(
        `INSERT INTO announcements (title, message, type, is_active, created_by, target_licence)
         VALUES ($1, $2, $3, TRUE, $4, $5)`,
        [
          'Demande refusée',
          rejectionMessage,
          'warning',
          req.user.username || 'admin',
          normalizedLicence
        ]
      );
      console.log(`[REJECTION] Announcement created successfully for ${normalizedLicence}`);
    } catch (annErr) {
      console.error('[REJECTION] Failed to create announcement:', annErr.message);
    }

    // Send rejection email to player (non-blocking)
    sendRejectionEmail(request, reason).catch(err => {
      console.error('Failed to send rejection email:', err);
    });

    res.json({
      success: true,
      message: 'Demande refusée'
    });

  } catch (error) {
    console.error('Error rejecting enrollment request:', error);
    res.status(500).json({ error: 'Failed to reject request' });
  }
});

/**
 * DELETE /api/enrollment-requests/:id
 * Soft delete an enrollment request (marks as 'deleted')
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`[DELETE] Starting delete for enrollment request ${id}`);

    // Get the request for logging
    const requestResult = await db.query(
      'SELECT * FROM enrollment_requests WHERE id = $1',
      [id]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const request = requestResult.rows[0];
    console.log(`[DELETE] Found request:`, JSON.stringify(request, null, 2));

    // If the request was approved, we need to also delete the inscription and ranking
    if (request.status === 'approved') {
      console.log(`[DELETE] Request was approved, cleaning up inscriptions and rankings...`);

      // Find and delete the inscription that was created
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();
      let seasonStart, seasonEnd;
      if (month >= 8) {
        seasonStart = `${year}-09-01`;
        seasonEnd = `${year + 1}-08-31`;
      } else {
        seasonStart = `${year - 1}-09-01`;
        seasonEnd = `${year}-08-31`;
      }

      // Find the tournament that matches (same logic as approve)
      // Use parameterized query for tournament_number
      const tournamentNum = request.tournament_number;
      console.log(`[DELETE] Looking for tournament: mode=${request.game_mode_name}, ranking=${request.requested_ranking}, T${tournamentNum}`);

      const tournamentResult = await db.query(`
        SELECT tournoi_id
        FROM tournoi_ext
        WHERE UPPER(mode) LIKE UPPER($1)
          AND UPPER(categorie) = UPPER($2)
          AND debut >= $3 AND debut <= $4
          AND (UPPER(nom) LIKE $5
               OR UPPER(nom) LIKE $6
               OR UPPER(nom) LIKE $7)
          AND UPPER(nom) NOT LIKE '%FINALE%'
          AND (status IS NULL OR status != 'cancelled')
        ORDER BY debut ASC
        LIMIT 1
      `, [
        '%' + request.game_mode_name + '%',
        request.requested_ranking,
        seasonStart,
        seasonEnd,
        '%T' + tournamentNum + '%',
        '%TOURNOI ' + tournamentNum + '%',
        '%TOUR ' + tournamentNum + '%'
      ]);

      if (tournamentResult.rows.length > 0) {
        const tournamentId = tournamentResult.rows[0].tournoi_id;
        console.log(`[DELETE] Found tournament ${tournamentId}, deleting inscription...`);

        // Delete the inscription
        await db.query(`
          DELETE FROM inscriptions
          WHERE REPLACE(UPPER(licence), ' ', '') = REPLACE(UPPER($1), ' ', '')
            AND tournoi_id = $2
            AND source = 'player_app'
        `, [request.licence, tournamentId]);

        console.log(`[DELETE] Deleted inscription for ${request.player_name} from tournament ${tournamentId}`);
      } else {
        console.log(`[DELETE] No matching tournament found`);
      }

      // Delete the ranking record if it exists
      console.log(`[DELETE] Looking for category: game_type=${request.game_mode_name}, level=${request.requested_ranking}`);
      const categoryResult = await db.query(`
        SELECT id FROM categories
        WHERE UPPER(game_type) = UPPER($1)
          AND UPPER(level) = UPPER($2)
      `, [request.game_mode_name, request.requested_ranking]);

      if (categoryResult.rows.length > 0) {
        const categoryId = categoryResult.rows[0].id;
        const seasonYear = month >= 8 ? year : year - 1;
        const currentSeason = `${seasonYear}-${seasonYear + 1}`;

        console.log(`[DELETE] Found category ${categoryId}, deleting ranking for season ${currentSeason}...`);
        await db.query(`
          DELETE FROM rankings
          WHERE REPLACE(UPPER(licence), ' ', '') = REPLACE(UPPER($1), ' ', '')
            AND category_id = $2
            AND season = $3
            AND total_match_points = 0
        `, [request.licence, categoryId, currentSeason]);

        console.log(`[DELETE] Deleted ranking for ${request.player_name} in category ${categoryId}`);
      } else {
        console.log(`[DELETE] No matching category found`);
      }

      // Also delete the player_ranking record
      console.log(`[DELETE] Deleting player_ranking for game_mode_id=${request.game_mode_id}...`);
      await db.query(`
        DELETE FROM player_rankings
        WHERE REPLACE(licence, ' ', '') = REPLACE($1, ' ', '')
        AND game_mode_id = $2
      `, [request.licence, request.game_mode_id]);

      console.log(`[DELETE] Deleted player_ranking for ${request.player_name} in game mode ${request.game_mode_id}`);
    }

    // Soft delete - mark as deleted instead of removing
    console.log(`[DELETE] Marking request as deleted...`);
    await db.query(`
      UPDATE enrollment_requests
      SET status = 'deleted',
          processed_at = NOW(),
          processed_by = $1
      WHERE id = $2
    `, [req.user.username || req.user.email || 'admin', id]);

    // Log admin action
    logAdminAction({
      req,
      action: 'enrollment_request_deleted',
      details: `Deleted enrollment request for ${request.player_name}: ${request.game_mode_name} ${request.requested_ranking} T${request.tournament_number} (status was: ${request.status})`,
      targetType: 'enrollment_request',
      targetId: id.toString(),
      targetName: `${request.player_name} - ${request.game_mode_name} ${request.requested_ranking}`
    });

    console.log(`[DELETE] Successfully deleted enrollment request ${id}`);
    res.json({
      success: true,
      message: 'Demande supprimée'
    });

  } catch (error) {
    console.error('[DELETE] Error deleting enrollment request:', error.message);
    console.error('[DELETE] Stack:', error.stack);
    res.status(500).json({ error: 'Failed to delete request', details: error.message });
  }
});

module.exports = router;
