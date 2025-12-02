const { Pool } = require('pg');
const bcrypt = require('bcrypt');

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Test connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to PostgreSQL:', err.message);
  } else {
    console.log('Connected to PostgreSQL database');
    release();
    initializeDatabase();
  }
});

// Initialize database schema
async function initializeDatabase() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Admin table (legacy - kept for backwards compatibility)
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin (
        id SERIAL PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Users table with roles
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer',
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      )
    `);

    // Players table
    await client.query(`
      CREATE TABLE IF NOT EXISTS players (
        licence TEXT PRIMARY KEY,
        club TEXT,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        rank_libre TEXT,
        rank_cadre TEXT,
        rank_bande TEXT,
        rank_3bandes TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Categories table
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        game_type TEXT NOT NULL,
        level TEXT NOT NULL,
        display_name TEXT NOT NULL,
        UNIQUE(game_type, level)
      )
    `);

    // Tournaments table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tournaments (
        id SERIAL PRIMARY KEY,
        category_id INTEGER NOT NULL REFERENCES categories(id),
        tournament_number INTEGER NOT NULL,
        season TEXT NOT NULL,
        import_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        tournament_date TIMESTAMP,
        UNIQUE(category_id, tournament_number, season)
      )
    `);

    // Tournament results table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tournament_results (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
        licence TEXT NOT NULL REFERENCES players(licence),
        player_name TEXT,
        match_points INTEGER DEFAULT 0,
        moyenne REAL DEFAULT 0,
        serie INTEGER DEFAULT 0,
        points INTEGER DEFAULT 0,
        reprises INTEGER DEFAULT 0,
        UNIQUE(tournament_id, licence)
      )
    `);

    // Rankings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS rankings (
        id SERIAL PRIMARY KEY,
        category_id INTEGER NOT NULL REFERENCES categories(id),
        season TEXT NOT NULL,
        licence TEXT NOT NULL REFERENCES players(licence),
        total_match_points INTEGER DEFAULT 0,
        avg_moyenne REAL DEFAULT 0,
        best_serie INTEGER DEFAULT 0,
        rank_position INTEGER,
        tournament_1_points INTEGER DEFAULT 0,
        tournament_2_points INTEGER DEFAULT 0,
        tournament_3_points INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(category_id, season, licence)
      )
    `);

    // Clubs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS clubs (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        logo_filename TEXT,
        street TEXT,
        city TEXT,
        zip_code TEXT,
        phone TEXT,
        email TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add new columns to clubs if they don't exist (migration)
    const clubColumns = ['street', 'city', 'zip_code', 'phone', 'email'];
    for (const col of clubColumns) {
      try {
        await client.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS ${col} TEXT`);
      } catch (e) {
        // Column might already exist
      }
    }

    // External tournament definitions table (from CDBHS external DB)
    await client.query(`
      CREATE TABLE IF NOT EXISTS tournoi_ext (
        tournoi_id INTEGER PRIMARY KEY,
        nom TEXT NOT NULL,
        mode TEXT NOT NULL,
        categorie TEXT NOT NULL,
        taille INTEGER,
        debut DATE,
        fin DATE,
        grand_coin INTEGER DEFAULT 0,
        taille_cadre TEXT,
        lieu TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Player inscriptions table (from CDBHS external DB)
    await client.query(`
      CREATE TABLE IF NOT EXISTS inscriptions (
        inscription_id INTEGER PRIMARY KEY,
        joueur_id INTEGER,
        tournoi_id INTEGER REFERENCES tournoi_ext(tournoi_id),
        timestamp TIMESTAMP NOT NULL,
        email TEXT,
        telephone TEXT,
        licence TEXT,
        convoque INTEGER DEFAULT 0,
        forfait INTEGER DEFAULT 0,
        commentaire TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Calendar storage table
    await client.query(`
      CREATE TABLE IF NOT EXISTS calendar (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        file_data BYTEA NOT NULL,
        uploaded_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Mode mapping table - maps IONOS mode names to internal game_type
    await client.query(`
      CREATE TABLE IF NOT EXISTS mode_mapping (
        id SERIAL PRIMARY KEY,
        ionos_mode TEXT NOT NULL UNIQUE,
        game_type TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Import history table - tracks all file imports from IONOS
    await client.query(`
      CREATE TABLE IF NOT EXISTS import_history (
        id SERIAL PRIMARY KEY,
        file_type TEXT NOT NULL,
        import_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        record_count INTEGER DEFAULT 0,
        filename TEXT,
        imported_by TEXT
      )
    `);

    // Game parameters table - stores rules for each mode/category combination
    await client.query(`
      CREATE TABLE IF NOT EXISTS game_parameters (
        id SERIAL PRIMARY KEY,
        mode TEXT NOT NULL,
        categorie TEXT NOT NULL,
        coin TEXT NOT NULL DEFAULT 'PC',
        distance_normale INTEGER NOT NULL,
        distance_reduite INTEGER,
        reprises INTEGER NOT NULL,
        moyenne_mini DECIMAL(6,3) NOT NULL,
        moyenne_maxi DECIMAL(6,3) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(mode, categorie)
      )
    `);

    // Email templates table - stores configurable email content
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_templates (
        id SERIAL PRIMARY KEY,
        template_key TEXT NOT NULL UNIQUE,
        subject_template TEXT NOT NULL,
        body_template TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query('COMMIT');

    // Initialize default admin (legacy)
    const adminResult = await client.query('SELECT COUNT(*) as count FROM admin');
    if (adminResult.rows[0].count == 0) {
      const defaultPassword = 'admin123';
      const hash = await bcrypt.hash(defaultPassword, 10);
      await client.query('INSERT INTO admin (password_hash) VALUES ($1)', [hash]);
      console.log('Default admin password created: admin123');
      console.log('Please change it after first login!');
    }

    // Initialize default admin user in users table
    const usersResult = await client.query('SELECT COUNT(*) as count FROM users');
    if (usersResult.rows[0].count == 0) {
      const defaultPassword = 'admin123';
      const hash = await bcrypt.hash(defaultPassword, 10);
      await client.query(
        'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
        ['admin', hash, 'admin']
      );
      console.log('Default admin user created: username=admin, password=admin123');
      console.log('Please change it after first login!');
    }

    // Initialize categories
    const catResult = await client.query('SELECT COUNT(*) as count FROM categories');
    if (catResult.rows[0].count == 0) {
      const categories = [
        { game_type: 'LIBRE', level: 'N3GC', display_name: 'LIBRE - NATIONALE 3 GC' },
        { game_type: 'LIBRE', level: 'R1', display_name: 'LIBRE - REGIONALE 1' },
        { game_type: 'LIBRE', level: 'R2', display_name: 'LIBRE - REGIONALE 2' },
        { game_type: 'LIBRE', level: 'R3', display_name: 'LIBRE - REGIONALE 3' },
        { game_type: 'LIBRE', level: 'R4', display_name: 'LIBRE - REGIONALE 4' },
        { game_type: 'CADRE', level: 'N3', display_name: 'CADRE - NATIONALE 3' },
        { game_type: 'CADRE', level: 'R1', display_name: 'CADRE - REGIONALE 1' },
        { game_type: 'BANDE', level: 'N3', display_name: 'BANDE - NATIONALE 3' },
        { game_type: 'BANDE', level: 'R1', display_name: 'BANDE - REGIONALE 1' },
        { game_type: 'BANDE', level: 'R2', display_name: 'BANDE - REGIONALE 2' },
        { game_type: '3BANDES', level: 'N3', display_name: '3 BANDES - NATIONALE 3' },
        { game_type: '3BANDES', level: 'R1', display_name: '3 BANDES - REGIONALE 1' },
        { game_type: '3BANDES', level: 'R2', display_name: '3 BANDES - REGIONALE 2' }
      ];

      for (const cat of categories) {
        await client.query(
          'INSERT INTO categories (game_type, level, display_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [cat.game_type, cat.level, cat.display_name]
        );
      }
      console.log('Categories initialized');
    }

    // Initialize mode mappings (IONOS mode names -> internal game_type)
    const modeMappings = [
      // LIBRE variations
      { ionos_mode: 'Libre', game_type: 'LIBRE' },
      { ionos_mode: 'LIBRE', game_type: 'LIBRE' },
      { ionos_mode: 'libre', game_type: 'LIBRE' },
      // CADRE variations
      { ionos_mode: 'Cadre', game_type: 'CADRE' },
      { ionos_mode: 'CADRE', game_type: 'CADRE' },
      { ionos_mode: 'cadre', game_type: 'CADRE' },
      // BANDE variations (1 bande)
      { ionos_mode: 'Bande', game_type: 'BANDE' },
      { ionos_mode: 'BANDE', game_type: 'BANDE' },
      { ionos_mode: 'bande', game_type: 'BANDE' },
      { ionos_mode: '1 Bande', game_type: 'BANDE' },
      { ionos_mode: '1 BANDE', game_type: 'BANDE' },
      { ionos_mode: '1 bande', game_type: 'BANDE' },
      { ionos_mode: '1Bande', game_type: 'BANDE' },
      { ionos_mode: '1BANDE', game_type: 'BANDE' },
      // 3 BANDES variations
      { ionos_mode: '3 Bandes', game_type: '3BANDES' },
      { ionos_mode: '3 BANDES', game_type: '3BANDES' },
      { ionos_mode: '3 bandes', game_type: '3BANDES' },
      { ionos_mode: '3Bandes', game_type: '3BANDES' },
      { ionos_mode: '3BANDES', game_type: '3BANDES' },
      { ionos_mode: '3bandes', game_type: '3BANDES' }
    ];

    for (const mapping of modeMappings) {
      await client.query(
        'INSERT INTO mode_mapping (ionos_mode, game_type) VALUES ($1, $2) ON CONFLICT (ionos_mode) DO NOTHING',
        [mapping.ionos_mode, mapping.game_type]
      );
    }
    console.log('Mode mappings initialized');

    // Initialize game parameters (if empty)
    const gameParamsResult = await client.query('SELECT COUNT(*) as count FROM game_parameters');
    if (gameParamsResult.rows[0].count == 0) {
      const gameParams = [
        // LIBRE
        { mode: 'LIBRE', categorie: 'N3', coin: 'GC', distance_normale: 150, distance_reduite: null, reprises: 25, moyenne_mini: 6.000, moyenne_maxi: 8.990 },
        { mode: 'LIBRE', categorie: 'R1', coin: 'PC', distance_normale: 120, distance_reduite: null, reprises: 30, moyenne_mini: 4.000, moyenne_maxi: 5.990 },
        { mode: 'LIBRE', categorie: 'R2', coin: 'PC', distance_normale: 80, distance_reduite: null, reprises: 30, moyenne_mini: 2.300, moyenne_maxi: 3.990 },
        { mode: 'LIBRE', categorie: 'R3', coin: 'PC', distance_normale: 60, distance_reduite: null, reprises: 30, moyenne_mini: 1.200, moyenne_maxi: 2.290 },
        { mode: 'LIBRE', categorie: 'R4', coin: 'PC', distance_normale: 40, distance_reduite: null, reprises: 40, moyenne_mini: 0.000, moyenne_maxi: 1.200 },
        // CADRE
        { mode: 'CADRE', categorie: 'N3', coin: 'PC', distance_normale: 120, distance_reduite: null, reprises: 25, moyenne_mini: 4.500, moyenne_maxi: 7.490 },
        { mode: 'CADRE', categorie: 'R1', coin: 'PC', distance_normale: 80, distance_reduite: null, reprises: 25, moyenne_mini: 0.000, moyenne_maxi: 4.490 },
        // BANDE
        { mode: 'BANDE', categorie: 'N3', coin: 'PC', distance_normale: 60, distance_reduite: null, reprises: 30, moyenne_mini: 1.800, moyenne_maxi: 2.570 },
        { mode: 'BANDE', categorie: 'R1', coin: 'PC', distance_normale: 50, distance_reduite: null, reprises: 30, moyenne_mini: 1.100, moyenne_maxi: 1.790 },
        { mode: 'BANDE', categorie: 'R2', coin: 'PC', distance_normale: 30, distance_reduite: null, reprises: 30, moyenne_mini: 0.000, moyenne_maxi: 1.090 },
        // 3 BANDES
        { mode: '3BANDES', categorie: 'N3', coin: 'PC', distance_normale: 25, distance_reduite: 20, reprises: 60, moyenne_mini: 0.400, moyenne_maxi: 0.580 },
        { mode: '3BANDES', categorie: 'R1', coin: 'PC', distance_normale: 20, distance_reduite: 15, reprises: 60, moyenne_mini: 0.250, moyenne_maxi: 0.399 },
        { mode: '3BANDES', categorie: 'R2', coin: 'PC', distance_normale: 15, distance_reduite: null, reprises: 60, moyenne_mini: 0.000, moyenne_maxi: 0.250 }
      ];

      for (const param of gameParams) {
        await client.query(
          `INSERT INTO game_parameters (mode, categorie, coin, distance_normale, distance_reduite, reprises, moyenne_mini, moyenne_maxi)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (mode, categorie) DO NOTHING`,
          [param.mode, param.categorie, param.coin, param.distance_normale, param.distance_reduite, param.reprises, param.moyenne_mini, param.moyenne_maxi]
        );
      }
      console.log('Game parameters initialized');
    }

    // Initialize default email template
    const emailTemplateResult = await client.query('SELECT COUNT(*) as count FROM email_templates');
    if (emailTemplateResult.rows[0].count == 0) {
      const defaultBodyTemplate = `Bonjour {player_name},

Le CDBHS a le plaisir de vous convier au tournoi suivant.

Veuillez trouver en attachement votre convocation detaillee avec la composition de toutes les poules du tournoi.

En cas d'empechement, merci d'informer des que possible l'equipe en charge du sportif a l'adresse ci-dessous.

Vous aurez noté un changement significatif quant au processus d'invitation et sommes a votre ecoute si vous avez des remarques ou des suggestions.

Nous vous souhaitons une excellente competition.

Cordialement,
Comite Departemental Billard Hauts-de-Seine`;

      await client.query(
        `INSERT INTO email_templates (template_key, subject_template, body_template)
         VALUES ($1, $2, $3) ON CONFLICT (template_key) DO NOTHING`,
        ['convocation', 'Convocation {category} - {tournament} - {date}', defaultBodyTemplate]
      );
      console.log('Default email template initialized');
    }

    // Initialize default clubs
    const clubResult = await client.query('SELECT COUNT(*) as count FROM clubs');
    if (clubResult.rows[0].count == 0) {
      const defaultClubs = [
        { name: 'Châtillon', display_name: 'Billard Club de Châtillon', logo_filename: 'S_C_M_C_BILLARD_CLUB.png' },
        { name: 'A DE BILLARD COURBEVOIE LA DEFENSE', display_name: 'A DE BILLARD COURBEVOIE LA DEFENSE', logo_filename: 'A_DE_BILLARD_COURBEVOIE_LA_DEFENSE.png' },
        { name: 'BILLARD BOIS COLOMBES', display_name: 'BILLARD BOIS COLOMBES', logo_filename: 'BILLARD_BOIS_COLOMBES.png' },
        { name: 'BILLARD CLUB CLICHOIS', display_name: 'BILLARD CLUB CLICHOIS', logo_filename: 'BILLARD_CLUB_CLICHOIS.png' },
        { name: 'BILLARD CLUB LA GARENNE CLAMART', display_name: 'BILLARD CLUB LA GARENNE CLAMART', logo_filename: 'BILLARD_CLUB_LA_GARENNE_CLAMART.png' },
        { name: 'S C M C BILLARD CLUB', display_name: 'S C M C BILLARD CLUB', logo_filename: 'S_C_M_C_BILLARD_CLUB.png' }
      ];

      for (const club of defaultClubs) {
        await client.query(
          'INSERT INTO clubs (name, display_name, logo_filename) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [club.name, club.display_name, club.logo_filename]
        );
      }
      console.log('Default clubs initialized');
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error initializing database:', err);
  } finally {
    client.release();
  }
}

// Wrapper to make PostgreSQL API compatible with SQLite
const db = {
  // For SELECT queries that return multiple rows
  all: (query, params, callback) => {
    // Convert SQLite ? placeholders to PostgreSQL $1, $2, etc.
    let pgQuery = query;
    let pgParams = params;
    let paramIndex = 1;
    pgQuery = query.replace(/\?/g, () => `$${paramIndex++}`);

    pool.query(pgQuery, pgParams)
      .then(result => callback(null, result.rows))
      .catch(err => callback(err));
  },

  // For SELECT queries that return a single row
  get: (query, params, callback) => {
    let pgQuery = query;
    let paramIndex = 1;
    pgQuery = query.replace(/\?/g, () => `$${paramIndex++}`);

    pool.query(pgQuery, params)
      .then(result => callback(null, result.rows[0]))
      .catch(err => callback(err));
  },

  // For INSERT/UPDATE/DELETE queries
  run: (query, params, callback) => {
    let pgQuery = query;
    let paramIndex = 1;
    pgQuery = query.replace(/\?/g, () => `$${paramIndex++}`);

    pool.query(pgQuery, params)
      .then(result => {
        if (callback) {
          // Call callback with 'this' context containing lastID and changes
          const context = {
            lastID: result.rows[0]?.id,
            changes: result.rowCount
          };
          callback.call(context, null);
        }
      })
      .catch(err => {
        if (callback) callback(err);
      });
  },

  // For prepared statements (serialize operations)
  serialize: (callback) => {
    callback();
  },

  // For prepared statements
  prepare: (query) => {
    // Convert SQLite ? placeholders to PostgreSQL $1, $2, etc.
    let paramIndex = 1;
    const pgQuery = query.replace(/\?/g, () => `$${paramIndex++}`);

    const statement = {
      run: (...args) => {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        const params = args;

        pool.query(pgQuery, params)
          .then(result => {
            if (callback) {
              // Call callback with 'this' context containing lastID and changes
              const context = {
                lastID: result.rows[0]?.id,
                changes: result.rowCount
              };
              callback.call(context, null);
            }
          })
          .catch(err => {
            if (callback) callback(err);
          });
      },

      finalize: (callback) => {
        // In PostgreSQL, there's nothing to finalize for a prepared statement
        // Just call the callback immediately
        if (callback) {
          setImmediate(callback);
        }
      }
    };

    return statement;
  }
};

module.exports = db;
