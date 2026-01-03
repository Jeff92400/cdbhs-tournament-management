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
router.get('/', (req, res) => {
  const query = `
    SELECT pa.id, pa.licence, pa.email, pa.is_admin, pa.email_verified,
           pa.created_at, pa.last_login,
           CONCAT(p.first_name, ' ', p.last_name) as player_name,
           p.club
    FROM player_accounts pa
    LEFT JOIN players p ON REPLACE(pa.licence, ' ', '') = REPLACE(p.licence, ' ', '')
    ORDER BY pa.created_at DESC
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error loading player accounts:', err);
      return res.status(500).json({ error: 'Failed to load player accounts' });
    }
    res.json(rows || []);
  });
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

    // Password validation - strong: 8+ chars, uppercase, number, special char
    if (password.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caracteres' });
    }
    if (!/[A-Z]/.test(password)) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins une majuscule' });
    }
    if (!/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins un chiffre' });
    }
    if (!/[!@#$%^&*(),.?":{}|<>_\-+=\[\]\\\/~`]/.test(password)) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins un caractere special' });
    }

    // Check if player exists
    db.get(
      `SELECT * FROM players WHERE REPLACE(licence, ' ', '') = REPLACE($1, ' ', '')`,
      [licence],
      async (err, player) => {
        if (err) {
          console.error('Error checking player:', err);
          return res.status(500).json({ error: 'Erreur lors de la vérification du joueur' });
        }

        if (!player) {
          return res.status(404).json({ error: 'Licence non trouvée dans la base joueurs' });
        }

        // Check if account already exists
        db.get(
          `SELECT id FROM player_accounts WHERE REPLACE(licence, ' ', '') = REPLACE($1, ' ', '') OR LOWER(email) = LOWER($2)`,
          [licence, email],
          async (err, existing) => {
            if (err) {
              console.error('Error checking existing account:', err);
              return res.status(500).json({ error: 'Erreur lors de la vérification' });
            }

            if (existing) {
              return res.status(409).json({ error: 'Un compte existe déjà pour cette licence ou cet email' });
            }

            // Hash password
            const passwordHash = await bcrypt.hash(password, 10);

            // Create account
            db.run(
              `INSERT INTO player_accounts (licence, email, password_hash, email_verified, is_admin)
               VALUES ($1, $2, $3, true, $4)`,
              [licence.toUpperCase(), email, passwordHash, isAdmin || false],
              function(err) {
                if (err) {
                  console.error('Error creating account:', err);
                  return res.status(500).json({ error: 'Erreur lors de la création du compte' });
                }

                res.status(201).json({
                  success: true,
                  id: this.lastID,
                  message: 'Compte créé avec succès'
                });
              }
            );
          }
        );
      }
    );

  } catch (error) {
    console.error('Error creating player account:', error);
    res.status(500).json({ error: 'Erreur lors de la création du compte' });
  }
});

/**
 * PUT /api/player-accounts/:id
 * Update a player account (admin status or password)
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { isAdmin, password } = req.body;

  // Must have at least one field to update
  if (isAdmin === undefined && !password) {
    return res.status(400).json({ error: 'Paramètre isAdmin ou password requis' });
  }

  try {
    // Handle password update
    if (password) {
      // Password validation - strong: 8+ chars, uppercase, number, special char
      if (password.length < 8) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caracteres' });
      }
      if (!/[A-Z]/.test(password)) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins une majuscule' });
      }
      if (!/[0-9]/.test(password)) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins un chiffre' });
      }
      if (!/[!@#$%^&*(),.?":{}|<>_\-+=\[\]\\\/~`]/.test(password)) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins un caractere special' });
      }

      const passwordHash = await bcrypt.hash(password, 10);

      db.run(
        `UPDATE player_accounts SET password_hash = $1 WHERE id = $2`,
        [passwordHash, id],
        function(err) {
          if (err) {
            console.error('Error updating player password:', err);
            return res.status(500).json({ error: 'Erreur lors de la mise à jour du mot de passe' });
          }

          if (this.changes === 0) {
            return res.status(404).json({ error: 'Compte non trouvé' });
          }

          res.json({ success: true, message: 'Mot de passe mis à jour' });
        }
      );
      return;
    }

    // Handle admin status update
    db.run(
      `UPDATE player_accounts SET is_admin = $1 WHERE id = $2`,
      [isAdmin, id],
      function(err) {
        if (err) {
          console.error('Error updating player account:', err);
          return res.status(500).json({ error: 'Erreur lors de la mise à jour' });
        }

        if (this.changes === 0) {
          return res.status(404).json({ error: 'Compte non trouvé' });
        }

        res.json({ success: true, message: 'Compte mis à jour' });
      }
    );
  } catch (error) {
    console.error('Error in player account update:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

/**
 * DELETE /api/player-accounts/:id
 * Delete a player account
 */
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  db.run(
    `DELETE FROM player_accounts WHERE id = $1`,
    [id],
    function(err) {
      if (err) {
        console.error('Error deleting player account:', err);
        return res.status(500).json({ error: 'Erreur lors de la suppression' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'Compte non trouvé' });
      }

      res.json({ success: true, message: 'Compte supprimé' });
    }
  );
});

module.exports = router;
