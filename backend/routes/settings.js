const express = require('express');
const multer = require('multer');
const { authenticateToken, requireAdmin } = require('./auth');
const appSettings = require('../utils/app-settings');

const router = express.Router();

// Configure multer for logo uploads (memory storage for database)
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith('image/')) {
      return cb(null, true);
    }
    cb(new Error('Seuls les fichiers image sont acceptés'));
  }
});

// Get database connection
const getDb = () => require('../db-loader');

// ==================== PUBLIC ENDPOINTS (NO AUTH) ====================

// Get branding colors (public - needed for login page)
router.get('/branding/colors', async (req, res) => {
  const db = getDb();

  const colorKeys = [
    'primary_color',
    'secondary_color',
    'accent_color',
    'background_color',
    'background_secondary_color'
  ];

  const placeholders = colorKeys.map((_, i) => `$${i + 1}`).join(',');

  db.all(
    `SELECT key, value FROM app_settings WHERE key IN (${placeholders})`,
    colorKeys,
    (err, rows) => {
      if (err) {
        console.error('Error fetching branding colors:', err);
        return res.status(500).json({ error: err.message });
      }

      // Convert to object with defaults
      const colors = {
        primary_color: '#1F4788',
        secondary_color: '#667eea',
        accent_color: '#ffc107',
        background_color: '#f8f9fa',
        background_secondary_color: '#f5f5f5'
      };

      for (const row of rows || []) {
        if (row.value) colors[row.key] = row.value;
      }

      res.json(colors);
    }
  );
});

// ==================== AUTHENTICATED ENDPOINTS ====================

// Get all game parameters (with display_name from game_modes)
router.get('/game-parameters', authenticateToken, async (req, res) => {
  const db = getDb();

  try {
    // First get game modes mapping
    const gameModes = await new Promise((resolve, reject) => {
      db.all('SELECT code, display_name, display_order FROM game_modes', [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Create a lookup map (normalize codes for matching)
    const modeMap = {};
    gameModes.forEach(gm => {
      const normalizedCode = gm.code.toUpperCase().replace(/\s+/g, '');
      modeMap[normalizedCode] = { display_name: gm.display_name, display_order: gm.display_order };
      // Also map by display_name for flexibility
      modeMap[gm.display_name.toUpperCase().replace(/\s+/g, '')] = { display_name: gm.display_name, display_order: gm.display_order };
    });

    // Get game parameters
    const params = await new Promise((resolve, reject) => {
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
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // Enrich params with mode display names
    const enrichedParams = params.map(param => {
      const normalizedMode = param.mode.toUpperCase().replace(/\s+/g, '');
      const modeInfo = modeMap[normalizedMode] || {};
      return {
        ...param,
        mode_display_name: modeInfo.display_name || param.mode,
        display_order: modeInfo.display_order
      };
    });

    res.json(enrichedParams);
  } catch (error) {
    console.error('Error fetching game parameters:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get game parameters for a specific mode/category
router.get('/game-parameters/:mode/:categorie', authenticateToken, (req, res) => {
  const db = getDb();
  const { mode, categorie } = req.params;

  // Normalize: uppercase and preserve spaces as stored in DB
  const normalizedMode = decodeURIComponent(mode).toUpperCase();
  const normalizedCategorie = decodeURIComponent(categorie).toUpperCase();

  db.get(
    'SELECT * FROM game_parameters WHERE UPPER(mode) = $1 AND UPPER(categorie) = $2',
    [normalizedMode, normalizedCategorie],
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

// ============= APP SETTINGS =============

// Initialize app_settings table if not exists
const initAppSettings = async () => {
  const db = getDb();
  return new Promise((resolve) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `, [], async (err) => {
      if (err) console.error('Error creating app_settings table:', err);

      // Default settings to initialize
      const defaultSettings = [
        // Legacy settings
        ['summary_email', 'cdbhs92@gmail.com'],
        ['email_scheduler_hour', '6'],

        // Organization settings
        ['organization_name', 'Comité Départemental de Billard des Hauts-de-Seine'],
        ['organization_short_name', 'CDBHS'],

        // Branding settings
        ['primary_color', '#1F4788'],
        ['secondary_color', '#667EEA'],
        ['accent_color', '#FFC107'],
        ['background_color', '#FFFFFF'],
        ['background_secondary_color', '#F5F5F5'],

        // Email settings
        ['email_communication', 'communication@cdbhs.net'],
        ['email_convocations', 'convocations@cdbhs.net'],
        ['email_noreply', 'noreply@cdbhs.net'],
        ['email_sender_name', 'CDBHS'],

        // Season settings
        ['season_cutoff_month', '8'], // September (0-indexed: 8 = September)

        // Ranking settings
        ['qualification_threshold', '9'],
        ['qualification_small', '4'],
        ['qualification_large', '6'],

        // Privacy policy (default placeholder)
        ['privacy_policy', '']
      ];

      // Insert default values using INSERT OR IGNORE / ON CONFLICT
      for (const [key, value] of defaultSettings) {
        await new Promise((res) => {
          db.run(
            `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
            [key, value],
            () => res()
          );
        });
      }

      resolve();
    });
  });
};

// Initialize tournament_types table
const initTournamentTypes = async () => {
  const db = getDb();
  return new Promise((resolve) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS tournament_types (
        id SERIAL PRIMARY KEY,
        tournament_number INTEGER NOT NULL UNIQUE,
        code TEXT NOT NULL,
        display_name TEXT NOT NULL,
        include_in_ranking BOOLEAN DEFAULT TRUE
      )
    `, [], async (err) => {
      if (err) console.error('Error creating tournament_types table:', err);

      // Default tournament types
      const defaultTypes = [
        [1, 'T1', 'Tournoi 1', true],
        [2, 'T2', 'Tournoi 2', true],
        [3, 'T3', 'Tournoi 3', true],
        [4, 'FINALE', 'Finale Départementale', false]
      ];

      for (const [num, code, displayName, includeInRanking] of defaultTypes) {
        await new Promise((res) => {
          db.run(
            `INSERT INTO tournament_types (tournament_number, code, display_name, include_in_ranking)
             VALUES ($1, $2, $3, $4) ON CONFLICT (tournament_number) DO NOTHING`,
            [num, code, displayName, includeInRanking],
            () => res()
          );
        });
      }

      resolve();
    });
  });
};

// Get a setting by key
router.get('/app/:key', authenticateToken, async (req, res) => {
  const db = getDb();
  const { key } = req.params;

  await initAppSettings();

  db.get(
    'SELECT * FROM app_settings WHERE key = $1',
    [key],
    (err, row) => {
      if (err) {
        console.error('Error fetching setting:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(row || { key, value: null });
    }
  );
});

// Update a setting (admin only)
router.put('/app/:key', authenticateToken, requireAdmin, async (req, res) => {
  const db = getDb();
  const { key } = req.params;
  const { value } = req.body;

  await initAppSettings();

  db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
    [key, value],
    function(err) {
      if (err) {
        console.error('Error updating setting:', err);
        return res.status(500).json({ error: err.message });
      }
      // Clear settings cache so other routes pick up the change
      appSettings.clearCache();
      res.json({ success: true, message: 'Setting updated' });
    }
  );
});

// Get all app settings at once
router.get('/app-all', authenticateToken, async (req, res) => {
  const db = getDb();

  await initAppSettings();

  db.all(
    'SELECT key, value FROM app_settings',
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching all settings:', err);
        return res.status(500).json({ error: err.message });
      }
      // Convert to object for easier use
      const settings = {};
      (rows || []).forEach(row => {
        settings[row.key] = row.value;
      });
      res.json(settings);
    }
  );
});

// Update multiple settings at once (admin only)
router.put('/app-bulk', authenticateToken, requireAdmin, async (req, res) => {
  const db = getDb();
  const settings = req.body; // Object with key-value pairs

  await initAppSettings();

  try {
    for (const [key, value] of Object.entries(settings)) {
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
          [key, value],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    }
    // Clear settings cache so other routes pick up the changes
    appSettings.clearCache();
    res.json({ success: true, message: 'Settings updated' });
  } catch (err) {
    console.error('Error updating settings:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============= TOURNAMENT TYPES =============

// Get all tournament types
router.get('/tournament-types', authenticateToken, async (req, res) => {
  const db = getDb();

  await initTournamentTypes();

  db.all(
    'SELECT * FROM tournament_types ORDER BY tournament_number',
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching tournament types:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

// Update a tournament type (admin only)
router.put('/tournament-types/:id', authenticateToken, requireAdmin, async (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { code, display_name, include_in_ranking } = req.body;

  await initTournamentTypes();

  db.run(
    `UPDATE tournament_types SET code = $1, display_name = $2, include_in_ranking = $3 WHERE id = $4`,
    [code, display_name, include_in_ranking, id],
    function(err) {
      if (err) {
        console.error('Error updating tournament type:', err);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Tournament type not found' });
      }
      res.json({ success: true, message: 'Tournament type updated' });
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
        // Return default template if not found (uses organization variables for customization)
        return res.json({
          template_key: key,
          subject_template: 'Convocation {category} - {tournament} - {date}',
          body_template: `Bonjour {player_name},

Le {organization_short_name} a le plaisir de vous convier au tournoi suivant.

Veuillez trouver en attachement votre convocation detaillee avec la composition de toutes les poules du tournoi.

En cas d'empechement, merci d'informer des que possible l'equipe en charge du sportif a l'adresse ci-dessous.

Vous aurez noté un changement significatif quant au processus d'invitation et sommes a votre ecoute si vous avez des remarques ou des suggestions.

Nous vous souhaitons une excellente competition.

Cordialement,
{organization_name}`
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

// ============= CATEGORY MAPPINGS =============

// Get all category mappings
router.get('/category-mappings', authenticateToken, (req, res) => {
  const db = getDb();

  db.all(
    `SELECT cm.*, c.level, c.display_name
     FROM category_mapping cm
     LEFT JOIN categories c ON cm.category_id = c.id
     ORDER BY cm.game_type, cm.ionos_categorie`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching category mappings:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

// Get category mappings grouped by game_type and category
router.get('/category-mappings/grouped', authenticateToken, (req, res) => {
  const db = getDb();

  db.all(
    `SELECT cm.*, c.level, c.display_name
     FROM category_mapping cm
     LEFT JOIN categories c ON cm.category_id = c.id
     ORDER BY cm.game_type, c.level, cm.ionos_categorie`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching category mappings:', err);
        return res.status(500).json({ error: err.message });
      }

      // Group by game_type and category
      const grouped = {};
      (rows || []).forEach(row => {
        const key = `${row.game_type}-${row.category_id}`;
        if (!grouped[key]) {
          grouped[key] = {
            game_type: row.game_type,
            category_id: row.category_id,
            level: row.level,
            display_name: row.display_name,
            variations: []
          };
        }
        grouped[key].variations.push({
          id: row.id,
          ionos_categorie: row.ionos_categorie
        });
      });

      res.json(Object.values(grouped));
    }
  );
});

// Add a new category mapping (admin only)
router.post('/category-mappings', authenticateToken, requireAdmin, (req, res) => {
  const db = getDb();
  const { ionos_categorie, game_type, category_id } = req.body;

  if (!ionos_categorie || !game_type || !category_id) {
    return res.status(400).json({ error: 'ionos_categorie, game_type, and category_id are required' });
  }

  db.run(
    `INSERT INTO category_mapping (ionos_categorie, game_type, category_id)
     VALUES ($1, $2, $3)`,
    [ionos_categorie.trim(), game_type.toUpperCase(), category_id],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint') || err.message.includes('unique constraint')) {
          return res.status(409).json({ error: 'This mapping already exists' });
        }
        console.error('Error adding category mapping:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, id: this.lastID, message: 'Category mapping added' });
    }
  );
});

// Delete a category mapping (admin only)
router.delete('/category-mappings/:id', authenticateToken, requireAdmin, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  db.run(
    'DELETE FROM category_mapping WHERE id = $1',
    [id],
    function(err) {
      if (err) {
        console.error('Error deleting category mapping:', err);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Mapping not found' });
      }
      res.json({ success: true, message: 'Category mapping deleted' });
    }
  );
});

// Get all categories (for dropdown)
router.get('/categories', authenticateToken, (req, res) => {
  const db = getDb();

  db.all(
    `SELECT * FROM categories ORDER BY game_type, level`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching categories:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    }
  );
});

// Lookup category by IONOS values (used during matching)
router.get('/category-mappings/lookup', authenticateToken, (req, res) => {
  const db = getDb();
  const { ionos_categorie, game_type } = req.query;

  if (!ionos_categorie || !game_type) {
    return res.status(400).json({ error: 'ionos_categorie and game_type are required' });
  }

  db.get(
    `SELECT cm.*, c.level, c.display_name
     FROM category_mapping cm
     JOIN categories c ON cm.category_id = c.id
     WHERE UPPER(cm.ionos_categorie) = UPPER($1) AND UPPER(cm.game_type) = UPPER($2)`,
    [ionos_categorie.trim(), game_type.trim()],
    (err, row) => {
      if (err) {
        console.error('Error looking up category mapping:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(row || null);
    }
  );
});

// ==================== Organization Logo ====================

// Get logo info
router.get('/organization-logo', authenticateToken, (req, res) => {
  const db = getDb();

  db.get('SELECT id, filename, content_type, LENGTH(file_data) as size, created_at FROM organization_logo ORDER BY created_at DESC LIMIT 1', [], (err, row) => {
    if (err) {
      console.error('Error checking logo:', err);
      return res.status(500).json({ error: 'Erreur lors de la vérification du logo' });
    }

    if (row) {
      res.json({
        exists: true,
        filename: row.filename,
        size: row.size,
        lastModified: row.created_at,
        url: '/api/settings/organization-logo/download'
      });
    } else {
      res.json({ exists: false });
    }
  });
});

// Download/view logo (public for email rendering)
router.get('/organization-logo/download', (req, res) => {
  const db = getDb();

  db.get('SELECT * FROM organization_logo ORDER BY created_at DESC LIMIT 1', [], (err, row) => {
    if (err) {
      console.error('Error fetching logo:', err);
      return res.status(500).json({ error: 'Erreur' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Logo non trouvé' });
    }

    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day

    const fileData = Buffer.isBuffer(row.file_data) ? row.file_data : Buffer.from(row.file_data);
    res.send(fileData);
  });
});

// Upload logo (admin only)
router.post('/organization-logo', authenticateToken, requireAdmin, logoUpload.single('logo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier fourni' });
  }

  const db = getDb();
  const { originalname, mimetype, buffer } = req.file;
  const uploadedBy = req.user?.username || 'admin';

  // Delete existing logo and insert new one
  db.run('DELETE FROM organization_logo', [], (err) => {
    if (err) {
      console.error('Error deleting old logo:', err);
    }

    db.run(
      'INSERT INTO organization_logo (filename, content_type, file_data, uploaded_by) VALUES ($1, $2, $3, $4)',
      [originalname, mimetype, buffer, uploadedBy],
      function(err) {
        if (err) {
          console.error('Error saving logo:', err);
          return res.status(500).json({ error: 'Erreur lors de l\'enregistrement du logo' });
        }

        appSettings.clearCache();

        res.json({
          success: true,
          message: 'Logo téléversé avec succès',
          filename: originalname,
          size: req.file.size
        });
      }
    );
  });
});

// Delete logo (admin only)
router.delete('/organization-logo', authenticateToken, requireAdmin, (req, res) => {
  const db = getDb();

  db.run('DELETE FROM organization_logo', [], function(err) {
    if (err) {
      console.error('Error deleting logo:', err);
      return res.status(500).json({ error: 'Erreur lors de la suppression du logo' });
    }

    appSettings.clearCache();

    res.json({ success: true, message: 'Logo supprimé' });
  });
});

module.exports = router;
