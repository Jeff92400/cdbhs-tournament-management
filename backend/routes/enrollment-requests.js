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
const fetch = require('node-fetch');

// API key for internal email calls
const API_KEY = process.env.PLAYER_APP_API_KEY;

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

// Helper function to send approval email via email route (same pattern as acknowledgment)
async function sendApprovalEmail(request) {
  if (!API_KEY) {
    console.log('[APPROVAL] API_KEY not configured, skipping email');
    return;
  }

  try {
    const response = await fetch(`http://localhost:${process.env.PORT || 3000}/api/email/enrollment-approved`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_email: request.player_email,
        player_name: request.player_name,
        game_mode: request.game_mode_name,
        requested_ranking: request.requested_ranking,
        tournament_number: request.tournament_number,
        api_key: API_KEY
      })
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('[APPROVAL] Failed to send email:', error);
    } else {
      console.log(`[APPROVAL] Email sent to ${request.player_email}`);
    }
  } catch (error) {
    console.error('[APPROVAL] Error sending email:', error.message);
  }
}

// Helper function to send rejection email directly via Resend
// Helper function to send rejection email via email route
async function sendRejectionEmail(request, reason) {
  if (!API_KEY) {
    console.log('[REJECTION] API_KEY not configured, skipping email');
    return;
  }

  try {
    const response = await fetch(`http://localhost:${process.env.PORT || 3000}/api/email/enrollment-rejected`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_email: request.player_email,
        player_name: request.player_name,
        game_mode: request.game_mode_name,
        requested_ranking: request.requested_ranking,
        tournament_number: request.tournament_number,
        rejection_reason: reason,
        api_key: API_KEY
      })
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('[REJECTION] Failed to send email:', error);
    } else {
      console.log(`[REJECTION] Email sent to ${request.player_email}`);
    }
  } catch (error) {
    console.error('[REJECTION] Error sending email:', error.message);
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
  try {
    const { season } = req.query;

    if (!season) {
      return res.status(400).json({ error: 'Season is required' });
    }

    // Calculate season date range
    const [startYear] = season.split('-').map(Number);
    const seasonStart = `${startYear}-09-01`;
    const seasonEnd = `${startYear + 1}-08-31`;

    // Count before purging
    const countResult = await db.query(`
      SELECT COUNT(*) as count
      FROM enrollment_requests
      WHERE status = 'deleted'
        AND created_at >= $1 AND created_at <= $2
    `, [seasonStart, seasonEnd]);

    const countToPurge = parseInt(countResult.rows[0]?.count || 0);

    if (countToPurge === 0) {
      return res.json({ success: true, purged: 0, message: 'Aucune demande à purger' });
    }

    // Permanently delete
    await db.query(`
      DELETE FROM enrollment_requests
      WHERE status = 'deleted'
        AND created_at >= $1 AND created_at <= $2
    `, [seasonStart, seasonEnd]);

    // Log admin action
    logAdminAction(
      req.user.id,
      req.user.username,
      req.user.role,
      'enrollment_requests_purged',
      `Purged ${countToPurge} deleted enrollment requests for season ${season}`,
      'enrollment_request',
      'bulk',
      `Season ${season}`,
      req
    );

    console.log(`[PURGE] Purged ${countToPurge} deleted enrollment requests for season ${season}`);

    res.json({
      success: true,
      purged: countToPurge,
      message: `${countToPurge} demande(s) purgée(s)`
    });

  } catch (error) {
    console.error('Error purging enrollment requests:', error);
    res.status(500).json({ error: 'Failed to purge enrollment requests' });
  }
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
    const tournamentResult = await db.query(`
      SELECT tournoi_id, nom, mode, categorie, debut, lieu
      FROM tournoi_ext
      WHERE UPPER(mode) LIKE UPPER($1)
        AND UPPER(categorie) = UPPER($2)
        AND debut >= $3 AND debut <= $4
        AND (UPPER(nom) LIKE '%T${request.tournament_number}%'
             OR UPPER(nom) LIKE '%TOURNOI ${request.tournament_number}%'
             OR UPPER(nom) LIKE '%TOUR ${request.tournament_number}%')
        AND UPPER(nom) NOT LIKE '%FINALE%'
        AND (status IS NULL OR status != 'cancelled')
      ORDER BY debut ASC
      LIMIT 1
    `, ['%' + request.game_mode_name + '%', request.requested_ranking, seasonStart, seasonEnd]);

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
    logAdminAction(
      req.user.id,
      req.user.username,
      req.user.role,
      'enrollment_request_approved',
      `Approved enrollment request for ${request.player_name}: ${request.game_mode_name} ${request.requested_ranking} T${request.tournament_number}`,
      'enrollment_request',
      id.toString(),
      `${request.player_name} - ${request.game_mode_name} ${request.requested_ranking}`,
      req
    );

    // Create in-app notification for the player
    const normalizedLicence = request.licence.replace(/\s+/g, '');
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

    // Send approval email to player (non-blocking)
    sendApprovalEmail(request).catch(err => {
      console.error('[APPROVAL] Failed to send approval email:', err);
    });

    res.json({
      success: true,
      message: 'Demande approuvée',
      inscriptionCreated: tournamentId !== null,
      tournament: tournamentInfo,
      announcementCreated,
      announcementError,
      targetLicence: normalizedLicence
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
    logAdminAction(
      req.user.id,
      req.user.username,
      req.user.role,
      'enrollment_request_rejected',
      `Rejected enrollment request for ${request.player_name}: ${request.game_mode_name} ${request.requested_ranking} T${request.tournament_number}${reason ? ' - Reason: ' + reason : ''}`,
      'enrollment_request',
      id.toString(),
      `${request.player_name} - ${request.game_mode_name} ${request.requested_ranking}`,
      req
    );

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

    // Get the request for logging
    const requestResult = await db.query(
      'SELECT * FROM enrollment_requests WHERE id = $1',
      [id]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const request = requestResult.rows[0];

    // If the request was approved, we need to also delete the inscription and ranking
    if (request.status === 'approved') {
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
      const tournamentResult = await db.query(`
        SELECT tournoi_id
        FROM tournoi_ext
        WHERE UPPER(mode) LIKE UPPER($1)
          AND UPPER(categorie) = UPPER($2)
          AND debut >= $3 AND debut <= $4
          AND (UPPER(nom) LIKE '%T${request.tournament_number}%'
               OR UPPER(nom) LIKE '%TOURNOI ${request.tournament_number}%'
               OR UPPER(nom) LIKE '%TOUR ${request.tournament_number}%')
          AND UPPER(nom) NOT LIKE '%FINALE%'
          AND (status IS NULL OR status != 'cancelled')
        ORDER BY debut ASC
        LIMIT 1
      `, ['%' + request.game_mode_name + '%', request.requested_ranking, seasonStart, seasonEnd]);

      if (tournamentResult.rows.length > 0) {
        const tournamentId = tournamentResult.rows[0].tournoi_id;

        // Delete the inscription
        await db.query(`
          DELETE FROM inscriptions
          WHERE REPLACE(UPPER(licence), ' ', '') = REPLACE(UPPER($1), ' ', '')
            AND tournoi_id = $2
            AND source = 'player_app'
        `, [request.licence, tournamentId]);

        console.log(`Deleted inscription for ${request.player_name} from tournament ${tournamentId}`);
      }

      // Delete the ranking record if it exists
      const categoryResult = await db.query(`
        SELECT id FROM categories
        WHERE UPPER(game_type) = UPPER($1)
          AND UPPER(level) = UPPER($2)
      `, [request.game_mode_name, request.requested_ranking]);

      if (categoryResult.rows.length > 0) {
        const categoryId = categoryResult.rows[0].id;
        const seasonYear = month >= 8 ? year : year - 1;
        const currentSeason = `${seasonYear}-${seasonYear + 1}`;

        await db.query(`
          DELETE FROM rankings
          WHERE REPLACE(UPPER(licence), ' ', '') = REPLACE(UPPER($1), ' ', '')
            AND category_id = $2
            AND season = $3
            AND total_match_points = 0
        `, [request.licence, categoryId, currentSeason]);

        console.log(`Deleted ranking for ${request.player_name} in category ${categoryId}`);
      }

      // Also delete the player_ranking record
      await db.query(`
        DELETE FROM player_rankings
        WHERE REPLACE(licence, ' ', '') = REPLACE($1, ' ', '')
        AND game_mode_id = $2
      `, [request.licence, request.game_mode_id]);

      console.log(`Deleted player_ranking for ${request.player_name} in game mode ${request.game_mode_id}`);
    }

    // Soft delete - mark as deleted instead of removing
    await db.query(`
      UPDATE enrollment_requests
      SET status = 'deleted',
          processed_at = NOW(),
          processed_by = $1
      WHERE id = $2
    `, [req.user.username || req.user.email || 'admin', id]);

    // Log admin action
    logAdminAction(
      req.user.id,
      req.user.username,
      req.user.role,
      'enrollment_request_deleted',
      `Deleted enrollment request for ${request.player_name}: ${request.game_mode_name} ${request.requested_ranking} T${request.tournament_number} (status was: ${request.status})`,
      'enrollment_request',
      id.toString(),
      `${request.player_name} - ${request.game_mode_name} ${request.requested_ranking}`,
      req
    );

    res.json({
      success: true,
      message: 'Demande supprimée'
    });

  } catch (error) {
    console.error('Error deleting enrollment request:', error);
    res.status(500).json({ error: 'Failed to delete request' });
  }
});

module.exports = router;
