const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse');
const fs = require('fs');
const db = require('../db-loader');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  dest: '/tmp',
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max
  },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));
    if (ext === '.csv') {
      cb(null, true);
    } else {
      cb(new Error('Seuls les fichiers CSV sont acceptés'), false);
    }
  }
});

// Define required fields for each import type
const IMPORT_FIELD_DEFINITIONS = {
  players: [
    { field: 'licence', label: 'Licence', required: true, description: 'Numéro de licence FFB' },
    { field: 'club', label: 'Club', required: false, description: 'Nom du club' },
    { field: 'prenom', label: 'Prénom', required: true, description: 'Prénom du joueur' },
    { field: 'nom', label: 'Nom', required: true, description: 'Nom de famille' },
    { field: 'rank_libre', label: 'Classement Libre', required: false, description: 'Classement FFB en Libre' },
    { field: 'rank_bande', label: 'Classement Bande', required: false, description: 'Classement FFB en Bande' },
    { field: 'rank_3bandes', label: 'Classement 3 Bandes', required: false, description: 'Classement FFB en 3 Bandes' },
    { field: 'rank_cadre', label: 'Classement Cadre', required: false, description: 'Classement FFB en Cadre' },
    { field: 'is_active', label: 'Actif', required: false, description: '1 = actif, 0 = inactif' }
  ],
  tournaments: [
    { field: 'classement', label: 'Classement', required: false, description: 'Position dans le tournoi' },
    { field: 'licence', label: 'Licence', required: true, description: 'Numéro de licence' },
    { field: 'joueur', label: 'Nom Joueur', required: true, description: 'Nom complet du joueur' },
    { field: 'pts_match', label: 'Points Match', required: true, description: 'Points de match gagnés' },
    { field: 'moyenne', label: 'Moyenne', required: false, description: 'Moyenne générale' },
    { field: 'reprises', label: 'Reprises', required: false, description: 'Nombre de reprises' },
    { field: 'serie', label: 'Meilleure Série', required: false, description: 'Meilleure série' },
    { field: 'points', label: 'Points', required: false, description: 'Points au jeu (caramboles)' }
  ],
  inscriptions: [
    { field: 'licence', label: 'Licence', required: true, description: 'Numéro de licence' },
    { field: 'nom', label: 'Nom', required: true, description: 'Nom du joueur' },
    { field: 'prenom', label: 'Prénom', required: false, description: 'Prénom du joueur' },
    { field: 'email', label: 'Email', required: false, description: 'Adresse email' },
    { field: 'telephone', label: 'Téléphone', required: false, description: 'Numéro de téléphone' },
    { field: 'club', label: 'Club', required: false, description: 'Nom du club' }
  ]
};

// Get field definitions for an import type
router.get('/:type/fields', authenticateToken, (req, res) => {
  const { type } = req.params;
  const fields = IMPORT_FIELD_DEFINITIONS[type];

  if (!fields) {
    return res.status(404).json({ error: `Type d'import inconnu: ${type}` });
  }

  res.json(fields);
});

// Get all import profiles
router.get('/', authenticateToken, (req, res) => {
  db.all('SELECT * FROM import_profiles ORDER BY import_type', [], (err, rows) => {
    if (err) {
      console.error('Error fetching import profiles:', err);
      return res.status(500).json({ error: err.message });
    }

    // Parse JSONB fields
    const profiles = (rows || []).map(row => ({
      ...row,
      column_mappings: typeof row.column_mappings === 'string'
        ? JSON.parse(row.column_mappings)
        : row.column_mappings,
      transformations: row.transformations
        ? (typeof row.transformations === 'string' ? JSON.parse(row.transformations) : row.transformations)
        : null
    }));

    res.json(profiles);
  });
});

// Get profile for specific import type
router.get('/:type', authenticateToken, (req, res) => {
  const { type } = req.params;

  db.get('SELECT * FROM import_profiles WHERE import_type = $1', [type], (err, row) => {
    if (err) {
      console.error('Error fetching import profile:', err);
      return res.status(500).json({ error: err.message });
    }

    if (!row) {
      // Return default empty profile if not found
      return res.json({
        import_type: type,
        delimiter: ';',
        has_header: true,
        column_mappings: {},
        transformations: null
      });
    }

    // Parse JSONB fields
    res.json({
      ...row,
      column_mappings: typeof row.column_mappings === 'string'
        ? JSON.parse(row.column_mappings)
        : row.column_mappings,
      transformations: row.transformations
        ? (typeof row.transformations === 'string' ? JSON.parse(row.transformations) : row.transformations)
        : null
    });
  });
});

// Save/update profile for import type
router.put('/:type', authenticateToken, (req, res) => {
  const { type } = req.params;
  const { delimiter, has_header, column_mappings, transformations } = req.body;

  if (!column_mappings || typeof column_mappings !== 'object') {
    return res.status(400).json({ error: 'column_mappings est obligatoire' });
  }

  // Validate that required fields are mapped
  const fieldDefs = IMPORT_FIELD_DEFINITIONS[type];
  if (fieldDefs) {
    const missingRequired = fieldDefs
      .filter(f => f.required)
      .filter(f => !column_mappings[f.field] || column_mappings[f.field].column === undefined);

    if (missingRequired.length > 0) {
      return res.status(400).json({
        error: `Champs obligatoires non mappés: ${missingRequired.map(f => f.label).join(', ')}`
      });
    }
  }

  // Check if profile exists
  db.get('SELECT id FROM import_profiles WHERE import_type = $1', [type], (err, row) => {
    if (err) {
      console.error('Error checking profile:', err);
      return res.status(500).json({ error: err.message });
    }

    const mappingsJson = JSON.stringify(column_mappings);
    const transformsJson = transformations ? JSON.stringify(transformations) : null;

    if (row) {
      // Update existing
      db.run(
        `UPDATE import_profiles
         SET delimiter = $1, has_header = $2, column_mappings = $3, transformations = $4, updated_at = CURRENT_TIMESTAMP
         WHERE import_type = $5`,
        [delimiter || ';', has_header !== false, mappingsJson, transformsJson, type],
        function(err) {
          if (err) {
            console.error('Error updating profile:', err);
            return res.status(500).json({ error: err.message });
          }
          res.json({ success: true, message: 'Profil mis à jour' });
        }
      );
    } else {
      // Insert new
      db.run(
        `INSERT INTO import_profiles (import_type, delimiter, has_header, column_mappings, transformations)
         VALUES ($1, $2, $3, $4, $5)`,
        [type, delimiter || ';', has_header !== false, mappingsJson, transformsJson],
        function(err) {
          if (err) {
            console.error('Error creating profile:', err);
            return res.status(500).json({ error: err.message });
          }
          res.json({ success: true, message: 'Profil créé' });
        }
      );
    }
  });
});

// Preview CSV with current/proposed mapping
router.post('/:type/preview', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier fourni' });
  }

  const { type } = req.params;

  try {
    let fileContent = fs.readFileSync(req.file.path, 'utf-8');

    // Detect delimiter
    const firstLine = fileContent.split('\n')[0] || '';
    const semicolonCount = (firstLine.match(/;/g) || []).length;
    const commaCount = (firstLine.match(/,/g) || []).length;
    const tabCount = (firstLine.match(/\t/g) || []).length;

    let detectedDelimiter = ';';
    if (commaCount > semicolonCount && commaCount > tabCount) {
      detectedDelimiter = ',';
    } else if (tabCount > semicolonCount && tabCount > commaCount) {
      detectedDelimiter = '\t';
    }

    // Fix CSV format issues
    const lines = fileContent.split('\n');
    const fixedLines = lines.map(line => {
      line = line.trim();
      if (!line) return line;
      if (line.startsWith('"') && line.endsWith('"') && line.indexOf(detectedDelimiter) === -1) {
        line = line.slice(1, -1);
      }
      line = line.replace(/""/g, '"');
      return line;
    });

    fileContent = fixedLines.join('\n');
    const records = [];

    const parser = parse(fileContent, {
      delimiter: detectedDelimiter,
      skip_empty_lines: true,
      quote: '"',
      escape: '"',
      relax_column_count: true,
      relax_quotes: true
    });

    for await (const record of parser) {
      records.push(record);
    }

    // Clean up
    fs.unlinkSync(req.file.path);

    if (records.length === 0) {
      return res.status(400).json({ error: 'Le fichier est vide' });
    }

    // Extract headers (first row) and sample data (next 5 rows)
    const headers = records[0].map((h, i) => ({
      index: i,
      value: h?.trim() || `Colonne ${i + 1}`,
      sample: records.slice(1, 6).map(r => r[i]?.trim() || '')
    }));

    const sampleRows = records.slice(1, 6);

    // Suggest mappings based on header names
    const suggestedMappings = {};
    const fieldDefs = IMPORT_FIELD_DEFINITIONS[type] || [];

    headers.forEach((header, index) => {
      const headerLower = header.value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

      fieldDefs.forEach(field => {
        const fieldLower = field.field.toLowerCase();
        const labelLower = field.label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

        // Check for matches
        if (headerLower === fieldLower ||
            headerLower === labelLower ||
            headerLower.includes(fieldLower) ||
            fieldLower.includes(headerLower)) {
          if (!suggestedMappings[field.field]) {
            suggestedMappings[field.field] = { column: index, type: 'string' };
          }
        }
      });
    });

    // Get existing profile for comparison
    db.get('SELECT * FROM import_profiles WHERE import_type = $1', [type], (err, existingProfile) => {
      res.json({
        detected_delimiter: detectedDelimiter,
        total_rows: records.length - 1, // Exclude header
        headers,
        sample_rows: sampleRows,
        suggested_mappings: suggestedMappings,
        existing_profile: existingProfile ? {
          delimiter: existingProfile.delimiter,
          has_header: existingProfile.has_header,
          column_mappings: typeof existingProfile.column_mappings === 'string'
            ? JSON.parse(existingProfile.column_mappings)
            : existingProfile.column_mappings
        } : null
      });
    });

  } catch (error) {
    // Clean up uploaded file
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Preview error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'analyse du fichier: ' + error.message });
  }
});

// Delete profile
router.delete('/:type', authenticateToken, (req, res) => {
  const { type } = req.params;

  db.run('DELETE FROM import_profiles WHERE import_type = $1', [type], function(err) {
    if (err) {
      console.error('Error deleting profile:', err);
      return res.status(500).json({ error: err.message });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Profil non trouvé' });
    }

    res.json({ success: true, message: 'Profil supprimé' });
  });
});

// Export helper function to get column mapping (for use in other routes)
async function getColumnMapping(importType) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT column_mappings, delimiter, has_header FROM import_profiles WHERE import_type = $1',
      [importType],
      (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          const mappings = typeof row.column_mappings === 'string'
            ? JSON.parse(row.column_mappings)
            : row.column_mappings;
          resolve({
            mappings,
            delimiter: row.delimiter || ';',
            hasHeader: row.has_header !== false
          });
        } else {
          // Return null if no profile - caller should use defaults
          resolve(null);
        }
      }
    );
  });
}

// Export helper to get value from record using mapping
function getValueFromMapping(record, mapping, fieldName) {
  if (!mapping || !mapping[fieldName]) {
    return null;
  }

  const fieldConfig = mapping[fieldName];
  let value;

  if (typeof fieldConfig.column === 'number') {
    // Column index mapping
    value = record[fieldConfig.column];
  } else if (typeof fieldConfig.column === 'string') {
    // Named column mapping (for CSVs with headers)
    // This requires the caller to pass a headers array and use that to find the index
    value = null; // Will be handled by caller
  }

  if (value === undefined || value === null) {
    return null;
  }

  // Clean the value
  value = value.replace(/"/g, '').trim();

  // Apply type conversion
  if (fieldConfig.type === 'number') {
    const num = parseInt(value);
    return isNaN(num) ? 0 : num;
  } else if (fieldConfig.type === 'decimal') {
    const num = parseFloat(value.replace(',', '.'));
    return isNaN(num) ? 0 : num;
  } else if (fieldConfig.type === 'boolean') {
    return value === '1' || value.toLowerCase() === 'true';
  }

  return value;
}

module.exports = router;
module.exports.getColumnMapping = getColumnMapping;
module.exports.getValueFromMapping = getValueFromMapping;
