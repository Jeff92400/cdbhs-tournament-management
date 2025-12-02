const express = require('express');
const { authenticateToken, requireAdmin } = require('./auth');

const router = express.Router();

// Get database connection
const getDb = () => require('../db-loader');

// Get all game parameters
router.get('/game-parameters', authenticateToken, (req, res) => {
  const db = getDb();

  db.all(
    `SELECT * FROM game_parameters ORDER BY
      CASE mode
        WHEN 'LIBRE' THEN 1
        WHEN 'CADRE' THEN 2
        WHEN 'BANDE' THEN 3
        WHEN '3BANDES' THEN 4
      END,
      CASE categorie
        WHEN 'N3' THEN 1
        WHEN 'R1' THEN 2
        WHEN 'R2' THEN 3
        WHEN 'R3' THEN 4
        WHEN 'R4' THEN 5
      END`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching game parameters:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

// Get game parameters for a specific mode/category
router.get('/game-parameters/:mode/:categorie', authenticateToken, (req, res) => {
  const db = getDb();
  const { mode, categorie } = req.params;

  db.get(
    'SELECT * FROM game_parameters WHERE mode = $1 AND categorie = $2',
    [mode.toUpperCase(), categorie.toUpperCase()],
    (err, row) => {
      if (err) {
        console.error('Error fetching game parameter:', err);
        return res.status(500).json({ error: err.message });
      }
      if (!row) {
        return res.status(404).json({ error: 'Parameter not found' });
      }
      res.json(row);
    }
  );
});

// Create or update game parameter (admin only)
router.post('/game-parameters', authenticateToken, requireAdmin, (req, res) => {
  const db = getDb();
  const { mode, categorie, coin, distance_normale, distance_reduite, reprises, moyenne_mini, moyenne_maxi } = req.body;

  if (!mode || !categorie || !coin || !distance_normale || !reprises || moyenne_mini === undefined || moyenne_maxi === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  db.run(
    `INSERT INTO game_parameters (mode, categorie, coin, distance_normale, distance_reduite, reprises, moyenne_mini, moyenne_maxi, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
     ON CONFLICT (mode, categorie) DO UPDATE SET
       coin = EXCLUDED.coin,
       distance_normale = EXCLUDED.distance_normale,
       distance_reduite = EXCLUDED.distance_reduite,
       reprises = EXCLUDED.reprises,
       moyenne_mini = EXCLUDED.moyenne_mini,
       moyenne_maxi = EXCLUDED.moyenne_maxi,
       updated_at = CURRENT_TIMESTAMP`,
    [mode.toUpperCase(), categorie.toUpperCase(), coin, distance_normale, distance_reduite || null, reprises, moyenne_mini, moyenne_maxi],
    function(err) {
      if (err) {
        console.error('Error saving game parameter:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json({
        success: true,
        message: 'Game parameter saved',
        id: this.lastID
      });
    }
  );
});

// Update game parameter (admin only)
router.put('/game-parameters/:id', authenticateToken, requireAdmin, (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { coin, distance_normale, distance_reduite, reprises, moyenne_mini, moyenne_maxi } = req.body;

  db.run(
    `UPDATE game_parameters SET
       coin = $1,
       distance_normale = $2,
       distance_reduite = $3,
       reprises = $4,
       moyenne_mini = $5,
       moyenne_maxi = $6,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $7`,
    [coin, distance_normale, distance_reduite || null, reprises, moyenne_mini, moyenne_maxi, id],
    function(err) {
      if (err) {
        console.error('Error updating game parameter:', err);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Parameter not found' });
      }
      res.json({ success: true, message: 'Game parameter updated' });
    }
  );
});

// Delete game parameter (admin only)
router.delete('/game-parameters/:id', authenticateToken, requireAdmin, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  db.run(
    'DELETE FROM game_parameters WHERE id = $1',
    [id],
    function(err) {
      if (err) {
        console.error('Error deleting game parameter:', err);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Parameter not found' });
      }
      res.json({ success: true, message: 'Game parameter deleted' });
    }
  );
});

// ============= EMAIL TEMPLATES =============

// Get email template by key
router.get('/email-template/:key', authenticateToken, (req, res) => {
  const db = getDb();
  const { key } = req.params;

  db.get(
    'SELECT * FROM email_templates WHERE template_key = $1',
    [key],
    (err, row) => {
      if (err) {
        console.error('Error fetching email template:', err);
        return res.status(500).json({ error: err.message });
      }
      if (!row) {
        // Return default template if not found
        return res.json({
          template_key: key,
          subject_template: 'Convocation {category} - {tournament} - {date}',
          body_template: `Bonjour {player_name},

Le CDBHS a le plaisir de vous convier au tournoi suivant.

Veuillez trouver en attachement votre convocation detaillee avec la composition de toutes les poules du tournoi.

En cas d'empechement, merci d'informer des que possible l'equipe en charge du sportif a l'adresse ci-dessous.

Vous aurez noté un changement significatif quant au processus d'invitation et sommes a votre ecoute si vous avez des remarques ou des suggestions.

Nous vous souhaitons une excellente competition.

Cordialement,
Comite Departemental Billard Hauts-de-Seine`
        });
      }
      res.json(row);
    }
  );
});

// Update email template (admin only)
router.put('/email-template/:key', authenticateToken, requireAdmin, (req, res) => {
  const db = getDb();
  const { key } = req.params;
  const { subject_template, body_template } = req.body;

  if (!subject_template || !body_template) {
    return res.status(400).json({ error: 'Subject and body templates are required' });
  }

  db.run(
    `INSERT INTO email_templates (template_key, subject_template, body_template, updated_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (template_key) DO UPDATE SET
       subject_template = EXCLUDED.subject_template,
       body_template = EXCLUDED.body_template,
       updated_at = CURRENT_TIMESTAMP`,
    [key, subject_template, body_template],
    function(err) {
      if (err) {
        console.error('Error updating email template:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, message: 'Email template updated' });
    }
  );
});

module.exports = router;
