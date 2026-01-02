/**
 * Player Accounts Routes
 *
 * Manage player accounts for the Player App (Espace Joueur)
 *
 * GET    /api/player-accounts     - List all player accounts
 * POST   /api/player-accounts     - Create a new player account
 * PUT    /api/player-accounts/:id - Update a player account
 * DELETE /api/player-accounts/:id - Delete a player account
 */

const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const db = require('../db-loader');

/**
 * GET /api/player-accounts
 * List all player accounts with player info
 */
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT pa.id, pa.licence, pa.email, pa.is_admin, pa.email_verified,
             pa.created_at, pa.last_login,
             CONCAT(p.first_name, ' ', p.last_name) as player_name,
             p.club
      FROM player_accounts pa
      LEFT JOIN players p ON REPLACE(pa.licence, ' ', '') = REPLACE(p.licence, ' ', '')
      ORDER BY pa.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error loading player accounts:', error);
    res.status(500).json({ error: 'Failed to load player accounts' });
  }
});

/**
 * POST /api/player-accounts
 * Create a new player account
 */
router.post('/', async (req, res) => {
  try {
    const { licence, email, password, isAdmin } = req.body;

    if (!licence || !email || !password) {
      return res.status(400).json({ error: 'Licence, email et mot de passe requis' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
    }

    // Check if player exists
    const playerResult = await db.query(
      `SELECT * FROM players WHERE REPLACE(licence, ' ', '') = REPLACE($1, ' ', '')`,
      [licence]
    );

    if (playerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Licence non trouvée dans la base joueurs' });
    }

    // Check if account already exists
    const existingResult = await db.query(
      `SELECT id FROM player_accounts
       WHERE REPLACE(licence, ' ', '') = REPLACE($1, ' ', '') OR LOWER(email) = LOWER($2)`,
      [licence, email]
    );

    if (existingResult.rows.length > 0) {
      return res.status(409).json({ error: 'Un compte existe déjà pour cette licence ou cet email' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create account
    const insertResult = await db.query(
      `INSERT INTO player_accounts (licence, email, password_hash, email_verified, is_admin)
       VALUES ($1, $2, $3, true, $4)
       RETURNING id`,
      [licence.toUpperCase(), email, passwordHash, isAdmin || false]
    );

    res.status(201).json({
      success: true,
      id: insertResult.rows[0].id,
      message: 'Compte créé avec succès'
    });

  } catch (error) {
    console.error('Error creating player account:', error);
    res.status(500).json({ error: 'Erreur lors de la création du compte' });
  }
});

/**
 * PUT /api/player-accounts/:id
 * Update a player account (admin status)
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { isAdmin } = req.body;

    if (isAdmin === undefined) {
      return res.status(400).json({ error: 'Paramètre isAdmin requis' });
    }

    const result = await db.query(
      `UPDATE player_accounts SET is_admin = $1 WHERE id = $2 RETURNING id`,
      [isAdmin, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Compte non trouvé' });
    }

    res.json({ success: true, message: 'Compte mis à jour' });

  } catch (error) {
    console.error('Error updating player account:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

/**
 * DELETE /api/player-accounts/:id
 * Delete a player account
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `DELETE FROM player_accounts WHERE id = $1 RETURNING licence`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Compte non trouvé' });
    }

    res.json({ success: true, message: 'Compte supprimé' });

  } catch (error) {
    console.error('Error deleting player account:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

module.exports = router;
