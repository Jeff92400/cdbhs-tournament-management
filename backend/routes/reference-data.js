const express = require('express');
const { authenticateToken, requireAdmin } = require('./auth');

const router = express.Router();

// Get database connection
const getDb = () => require('../db-loader');

// ==================== GAME MODES ====================

// Get all game modes
router.get('/game-modes', authenticateToken, (req, res) => {
  const db = getDb();
  const { active_only } = req.query;

  let query = 'SELECT * FROM game_modes';
  if (active_only === 'true') {
    query += ' WHERE is_active = TRUE';
  }
  query += ' ORDER BY display_order, display_name';

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error fetching game modes:', err);
      return res.status(500).json({ error: 'Erreur lors de la récupération des modes de jeu' });
    }
    res.json(rows || []);
  });
});

// Get single game mode
router.get('/game-modes/:id', authenticateToken, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  db.get('SELECT * FROM game_modes WHERE id = $1', [id], (err, row) => {
    if (err) {
      console.error('Error fetching game mode:', err);
      return res.status(500).json({ error: 'Erreur lors de la récupération du mode de jeu' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Mode de jeu non trouvé' });
    }
    res.json(row);
  });
});

// Create game mode
router.post('/game-modes', authenticateToken, (req, res) => {
  const db = getDb();
  const { code, display_name, color, display_order, rank_column } = req.body;

  if (!code || !display_name) {
    return res.status(400).json({ error: 'Code et nom sont requis' });
  }

  db.run(
    `INSERT INTO game_modes (code, display_name, color, display_order, rank_column)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [code.toUpperCase(), display_name, color || '#1F4788', display_order || 0, rank_column || null],
    function(err) {
      if (err) {
        console.error('Error creating game mode:', err);
        if (err.message.includes('UNIQUE') || err.message.includes('unique')) {
          return res.status(400).json({ error: 'Ce code existe déjà' });
        }
        return res.status(500).json({ error: 'Erreur lors de la création du mode de jeu' });
      }
      res.json({ success: true, id: this.lastID, message: 'Mode de jeu créé' });
    }
  );
});

// Update game mode
router.put('/game-modes/:id', authenticateToken, (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { code, display_name, color, display_order, is_active, rank_column } = req.body;

  if (!code || !display_name) {
    return res.status(400).json({ error: 'Code et nom sont requis' });
  }

  // First get the old values to update categories
  db.get('SELECT code, display_name FROM game_modes WHERE id = $1', [id], (err, oldMode) => {
    if (err) {
      console.error('Error fetching game mode:', err);
      return res.status(500).json({ error: 'Erreur lors de la récupération' });
    }

    if (!oldMode) {
      return res.status(404).json({ error: 'Mode de jeu non trouvé' });
    }

    const oldCode = oldMode.code;
    const oldDisplayName = oldMode.display_name;

    db.run(
      `UPDATE game_modes
       SET code = $1, display_name = $2, color = $3, display_order = $4, is_active = $5, rank_column = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7`,
      [code.toUpperCase(), display_name, color || '#1F4788', display_order || 0, is_active !== false, rank_column || null, id],
      function(err) {
        if (err) {
          console.error('Error updating game mode:', err);
          if (err.message.includes('UNIQUE') || err.message.includes('unique')) {
            return res.status(400).json({ error: 'Ce code existe déjà' });
          }
          return res.status(500).json({ error: 'Erreur lors de la mise à jour du mode de jeu' });
        }
        if (this.changes === 0) {
          return res.status(404).json({ error: 'Mode de jeu non trouvé' });
        }

        // Check if code or display_name changed
        const codeChanged = oldCode.toUpperCase() !== code.toUpperCase();
        const displayNameChanged = oldDisplayName.toUpperCase() !== display_name.toUpperCase();

        if (codeChanged || displayNameChanged) {
          // Update categories that match OLD code or OLD display_name
          // Set game_type to NEW display_name
          db.run(
            `UPDATE categories SET game_type = $1
             WHERE UPPER(game_type) = UPPER($2) OR UPPER(game_type) = UPPER($3)`,
            [display_name, oldDisplayName, oldCode],
            (err) => {
              if (err) {
                console.error('Error updating categories game_type:', err);
              }

              // Also update display_name in categories to reflect new game_type
              db.run(
                `UPDATE categories SET display_name = $1 || ' - ' || level WHERE UPPER(game_type) = UPPER($2)`,
                [display_name, display_name],
                (err) => {
                  if (err) {
                    console.error('Error updating categories display_name:', err);
                  }
                  res.json({ success: true, message: 'Mode de jeu mis à jour (catégories synchronisées)' });
                }
              );
            }
          );
        } else {
          res.json({ success: true, message: 'Mode de jeu mis à jour' });
        }
      }
    );
  });
});

// Delete game mode
router.delete('/game-modes/:id', authenticateToken, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  // Check if used in categories first
  db.get(
    `SELECT COUNT(*) as count FROM categories c
     JOIN game_modes gm ON UPPER(c.game_type) = UPPER(gm.code)
     WHERE gm.id = $1`,
    [id],
    (err, row) => {
      if (err) {
        console.error('Error checking game mode usage:', err);
        return res.status(500).json({ error: 'Erreur lors de la vérification' });
      }

      if (row && row.count > 0) {
        return res.status(400).json({
          error: `Ce mode de jeu est utilisé par ${row.count} catégorie(s). Désactivez-le plutôt.`
        });
      }

      db.run('DELETE FROM game_modes WHERE id = $1', [id], function(err) {
        if (err) {
          console.error('Error deleting game mode:', err);
          return res.status(500).json({ error: 'Erreur lors de la suppression' });
        }
        if (this.changes === 0) {
          return res.status(404).json({ error: 'Mode de jeu non trouvé' });
        }
        res.json({ success: true, message: 'Mode de jeu supprimé' });
      });
    }
  );
});

// ==================== FFB RANKINGS ====================

// Get all FFB rankings
router.get('/ffb-rankings', authenticateToken, (req, res) => {
  const db = getDb();
  const { active_only } = req.query;

  let query = 'SELECT * FROM ffb_rankings';
  if (active_only === 'true') {
    query += ' WHERE is_active = TRUE';
  }
  query += ' ORDER BY level_order, code';

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error fetching FFB rankings:', err);
      return res.status(500).json({ error: 'Erreur lors de la récupération des classements' });
    }
    res.json(rows || []);
  });
});

// Get single FFB ranking
router.get('/ffb-rankings/:id', authenticateToken, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  db.get('SELECT * FROM ffb_rankings WHERE id = $1', [id], (err, row) => {
    if (err) {
      console.error('Error fetching FFB ranking:', err);
      return res.status(500).json({ error: 'Erreur lors de la récupération du classement' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Classement non trouvé' });
    }
    res.json(row);
  });
});

// Create FFB ranking
router.post('/ffb-rankings', authenticateToken, (req, res) => {
  const db = getDb();
  const { code, display_name, tier, level_order } = req.body;

  if (!code || !display_name || !tier) {
    return res.status(400).json({ error: 'Code, nom et tier sont requis' });
  }

  db.run(
    `INSERT INTO ffb_rankings (code, display_name, tier, level_order)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [code.toUpperCase(), display_name, tier.toUpperCase(), level_order || 0],
    function(err) {
      if (err) {
        console.error('Error creating FFB ranking:', err);
        if (err.message.includes('UNIQUE') || err.message.includes('unique')) {
          return res.status(400).json({ error: 'Ce code existe déjà' });
        }
        return res.status(500).json({ error: 'Erreur lors de la création du classement' });
      }
      res.json({ success: true, id: this.lastID, message: 'Classement créé' });
    }
  );
});

// Update FFB ranking
router.put('/ffb-rankings/:id', authenticateToken, (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { code, display_name, tier, level_order, is_active } = req.body;

  if (!code || !display_name || !tier) {
    return res.status(400).json({ error: 'Code, nom et tier sont requis' });
  }

  db.run(
    `UPDATE ffb_rankings
     SET code = $1, display_name = $2, tier = $3, level_order = $4, is_active = $5, updated_at = CURRENT_TIMESTAMP
     WHERE id = $6`,
    [code.toUpperCase(), display_name, tier.toUpperCase(), level_order || 0, is_active !== false, id],
    function(err) {
      if (err) {
        console.error('Error updating FFB ranking:', err);
        if (err.message.includes('UNIQUE') || err.message.includes('unique')) {
          return res.status(400).json({ error: 'Ce code existe déjà' });
        }
        return res.status(500).json({ error: 'Erreur lors de la mise à jour du classement' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Classement non trouvé' });
      }
      res.json({ success: true, message: 'Classement mis à jour' });
    }
  );
});

// Delete FFB ranking
router.delete('/ffb-rankings/:id', authenticateToken, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  // Check if used in categories first
  db.get(
    `SELECT COUNT(*) as count FROM categories c
     JOIN ffb_rankings fr ON UPPER(c.level) = UPPER(fr.code)
     WHERE fr.id = $1`,
    [id],
    (err, row) => {
      if (err) {
        console.error('Error checking FFB ranking usage:', err);
        return res.status(500).json({ error: 'Erreur lors de la vérification' });
      }

      if (row && row.count > 0) {
        return res.status(400).json({
          error: `Ce classement est utilisé par ${row.count} catégorie(s). Désactivez-le plutôt.`
        });
      }

      db.run('DELETE FROM ffb_rankings WHERE id = $1', [id], function(err) {
        if (err) {
          console.error('Error deleting FFB ranking:', err);
          return res.status(500).json({ error: 'Erreur lors de la suppression' });
        }
        if (this.changes === 0) {
          return res.status(404).json({ error: 'Classement non trouvé' });
        }
        res.json({ success: true, message: 'Classement supprimé' });
      });
    }
  );
});

// ==================== CATEGORIES (enhanced view) ====================

// Get all categories with game mode and ranking info
router.get('/categories', authenticateToken, (req, res) => {
  const db = getDb();

  const query = `
    SELECT
      c.id,
      c.game_type,
      c.level,
      c.display_name,
      c.is_active,
      gm.id as game_mode_id,
      gm.display_name as game_mode_name,
      gm.color as game_mode_color,
      fr.id as ranking_id,
      fr.display_name as ranking_name,
      fr.tier as ranking_tier
    FROM categories c
    LEFT JOIN game_modes gm ON UPPER(c.game_type) = UPPER(gm.display_name)
                            OR UPPER(c.game_type) = UPPER(gm.code)
    LEFT JOIN ffb_rankings fr ON UPPER(c.level) = UPPER(fr.code)
    ORDER BY gm.display_order, fr.level_order
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error fetching categories:', err);
      return res.status(500).json({ error: 'Erreur lors de la récupération des catégories' });
    }
    res.json(rows || []);
  });
});

// Create category from game mode + FFB ranking
router.post('/categories', authenticateToken, (req, res) => {
  const db = getDb();
  const { game_mode_code, ranking_code, display_name } = req.body;

  if (!game_mode_code || !ranking_code) {
    return res.status(400).json({ error: 'Mode de jeu et classement sont requis' });
  }

  // Get game mode display name for the category
  db.get('SELECT display_name FROM game_modes WHERE code = $1', [game_mode_code.toUpperCase()], (err, gameMode) => {
    if (err) {
      console.error('Error fetching game mode:', err);
      return res.status(500).json({ error: 'Erreur lors de la récupération du mode de jeu' });
    }

    if (!gameMode) {
      return res.status(400).json({ error: 'Mode de jeu non trouvé' });
    }

    // Verify ranking exists
    db.get('SELECT code FROM ffb_rankings WHERE code = $1', [ranking_code.toUpperCase()], (err, ranking) => {
      if (err) {
        console.error('Error fetching ranking:', err);
        return res.status(500).json({ error: 'Erreur lors de la récupération du classement' });
      }

      if (!ranking) {
        return res.status(400).json({ error: 'Classement non trouvé' });
      }

      // Create category with game_type = game mode display_name, level = ranking code
      const categoryDisplayName = display_name || `${gameMode.display_name} ${ranking_code.toUpperCase()}`;

      db.run(
        `INSERT INTO categories (game_type, level, display_name)
         VALUES ($1, $2, $3)`,
        [gameMode.display_name, ranking_code.toUpperCase(), categoryDisplayName],
        function(err) {
          if (err) {
            console.error('Error creating category:', err);
            if (err.message.includes('UNIQUE') || err.message.includes('unique')) {
              return res.status(400).json({ error: 'Cette catégorie existe déjà' });
            }
            return res.status(500).json({ error: 'Erreur lors de la création de la catégorie' });
          }
          res.json({ success: true, id: this.lastID, message: 'Catégorie créée' });
        }
      );
    });
  });
});

// Update category (status)
router.put('/categories/:id', authenticateToken, (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { is_active, display_name } = req.body;

  db.run(
    `UPDATE categories
     SET is_active = $1, display_name = COALESCE($2, display_name), updated_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [is_active, display_name, id],
    function(err) {
      if (err) {
        console.error('Error updating category:', err);
        return res.status(500).json({ error: 'Erreur lors de la mise à jour de la catégorie' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Catégorie non trouvée' });
      }
      res.json({ success: true, message: 'Catégorie mise à jour' });
    }
  );
});

// Delete category
router.delete('/categories/:id', authenticateToken, (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);

    console.log('Deleting category with id:', id);

    if (isNaN(id)) {
      return res.status(400).json({ error: 'ID invalide' });
    }

    // First delete from category_mapping (foreign key reference)
    db.run('DELETE FROM category_mapping WHERE category_id = $1', [id], function(err) {
      if (err) {
        console.error('Error deleting category_mapping:', err);
        // Continue anyway - mapping might not exist
      }

      // Then delete the category
      db.run('DELETE FROM categories WHERE id = $1', [id], function(err) {
        if (err) {
          console.error('Error deleting category:', err);
          return res.status(500).json({ error: 'Erreur lors de la suppression: ' + err.message });
        }
        if (this.changes === 0) {
          return res.status(404).json({ error: 'Catégorie non trouvée' });
        }
        res.json({ success: true, message: 'Catégorie supprimée' });
      });
    });
  } catch (error) {
    console.error('Unexpected error in delete category:', error);
    res.status(500).json({ error: 'Erreur inattendue: ' + error.message });
  }
});

// Sync orphaned categories with game modes
router.post('/categories/sync', authenticateToken, async (req, res) => {
  const db = getDb();

  try {
    // First, get all game modes
    const gameModes = await new Promise((resolve, reject) => {
      db.all('SELECT code, display_name FROM game_modes', [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Get all categories
    const categories = await new Promise((resolve, reject) => {
      db.all('SELECT id, game_type, level, display_name FROM categories', [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    let updatedCount = 0;

    for (const cat of categories) {
      const catGameType = (cat.game_type || '').toUpperCase().replace(/ /g, '');

      // Try to find matching game mode
      const matchingMode = gameModes.find(gm => {
        const gmCode = (gm.code || '').toUpperCase().replace(/ /g, '');
        const gmName = (gm.display_name || '').toUpperCase().replace(/ /g, '');
        return catGameType === gmCode || catGameType === gmName;
      });

      if (matchingMode) {
        // Check if update is needed (game_type doesn't exactly match display_name)
        if (cat.game_type !== matchingMode.display_name) {
          const newDisplayName = `${matchingMode.display_name} - ${cat.level}`;

          await new Promise((resolve, reject) => {
            db.run(
              'UPDATE categories SET game_type = $1, display_name = $2 WHERE id = $3',
              [matchingMode.display_name, newDisplayName, cat.id],
              (err) => {
                if (err) reject(err);
                else resolve();
              }
            );
          });
          updatedCount++;
        }
      }
    }

    res.json({
      success: true,
      message: `Synchronisation terminée: ${updatedCount} catégorie(s) mise(s) à jour`,
      updatedCount
    });

  } catch (error) {
    console.error('Error syncing categories:', error);
    res.status(500).json({ error: 'Erreur lors de la synchronisation' });
  }
});

module.exports = router;
