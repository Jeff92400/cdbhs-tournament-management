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

    // Add email and password reset columns to users
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expiry TIMESTAMP`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS receive_tournament_alerts BOOLEAN DEFAULT FALSE`);

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

    // Add email and telephone columns to players (migration for inscription validation)
    await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS email TEXT`);
    await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS telephone TEXT`);
    // Add player_app_role column for Player App admin management (joueur/admin)
    await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS player_app_role VARCHAR(20) DEFAULT NULL`);
    // Add player_app_user column to track Player App users (boolean)
    await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS player_app_user BOOLEAN DEFAULT FALSE`);

    // Add GDPR consent columns to players table (migration - January 2026)
    await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS gdpr_consent_date TIMESTAMP`);
    await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS gdpr_consent_version VARCHAR(10)`);

    // Migrate existing admins from player_accounts.is_admin to players.player_app_role
    await client.query(`
      UPDATE players p
      SET player_app_role = 'admin'
      FROM player_accounts pa
      WHERE REPLACE(p.licence, ' ', '') = REPLACE(pa.licence, ' ', '')
        AND pa.is_admin = true
        AND (p.player_app_role IS NULL OR p.player_app_role != 'admin')
    `);

    // Migrate existing player_accounts to mark them as Player App users
    await client.query(`
      UPDATE players p
      SET player_app_user = TRUE
      FROM player_accounts pa
      WHERE REPLACE(p.licence, ' ', '') = REPLACE(pa.licence, ' ', '')
        AND p.player_app_user = FALSE
    `);

    // Set all players without a role to 'joueur', except admins
    await client.query(`
      UPDATE players
      SET player_app_role = 'joueur'
      WHERE player_app_role IS NULL
    `);

    // Ensure Rallet and Hui Bon Hoa are admins
    await client.query(`
      UPDATE players
      SET player_app_role = 'admin'
      WHERE UPPER(last_name) LIKE '%RALLET%' OR UPPER(last_name) LIKE '%HUI BON HOA%'
    `);

    // Populate players email/telephone from inscriptions (batch migration)
    // Uses most recent inscription for each player
    await client.query(`
      UPDATE players p
      SET email = i.email
      FROM (
        SELECT DISTINCT ON (REPLACE(licence, ' ', ''))
          REPLACE(licence, ' ', '') as clean_licence,
          email
        FROM inscriptions
        WHERE email IS NOT NULL AND email != ''
        ORDER BY REPLACE(licence, ' ', ''), timestamp DESC
      ) i
      WHERE REPLACE(p.licence, ' ', '') = i.clean_licence
        AND (p.email IS NULL OR p.email = '')
    `);

    await client.query(`
      UPDATE players p
      SET telephone = i.telephone
      FROM (
        SELECT DISTINCT ON (REPLACE(licence, ' ', ''))
          REPLACE(licence, ' ', '') as clean_licence,
          telephone
        FROM inscriptions
        WHERE telephone IS NOT NULL AND telephone != ''
        ORDER BY REPLACE(licence, ' ', ''), timestamp DESC
      ) i
      WHERE REPLACE(p.licence, ' ', '') = i.clean_licence
        AND (p.telephone IS NULL OR p.telephone = '')
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
        location TEXT,
        UNIQUE(category_id, tournament_number, season)
      )
    `);

    // Add location column if it doesn't exist (migration)
    await client.query(`
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS location TEXT
    `);

    // Add results_email_sent columns (migration for tracking email status)
    await client.query(`
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS results_email_sent BOOLEAN DEFAULT FALSE
    `);
    await client.query(`
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS results_email_sent_at TIMESTAMP
    `);

    // Mark all existing tournaments as results sent (one-time migration for existing data)
    // Only runs if NO tournaments have been marked as sent yet (first deployment)
    const sentCheck = await client.query(`SELECT COUNT(*) as cnt FROM tournaments WHERE results_email_sent = TRUE`);
    if (parseInt(sentCheck.rows[0].cnt) === 0) {
      console.log('Migration: Marking all existing tournaments as results sent');
      await client.query(`
        UPDATE tournaments
        SET results_email_sent = TRUE, results_email_sent_at = CURRENT_TIMESTAMP
        WHERE results_email_sent IS NULL OR results_email_sent = FALSE
      `);
    }

    // Tournament results table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tournament_results (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
        licence TEXT NOT NULL REFERENCES players(licence),
        player_name TEXT,
        position INTEGER DEFAULT 0,
        match_points INTEGER DEFAULT 0,
        moyenne REAL DEFAULT 0,
        serie INTEGER DEFAULT 0,
        points INTEGER DEFAULT 0,
        reprises INTEGER DEFAULT 0,
        UNIQUE(tournament_id, licence)
      )
    `);

    // Add position column if it doesn't exist (migration)
    await client.query(`
      ALTER TABLE tournament_results ADD COLUMN IF NOT EXISTS position INTEGER DEFAULT 0
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
    const clubColumns = ['street', 'city', 'zip_code', 'phone', 'email', 'calendar_code'];
    for (const col of clubColumns) {
      try {
        await client.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS ${col} TEXT`);
      } catch (e) {
        // Column might already exist
      }
    }

    // Initialize default calendar codes for existing clubs
    const defaultCalendarCodes = [
      { name_pattern: '%COURBEVOIE%', code: 'A' },
      { name_pattern: '%BOIS%COLOMBES%', code: 'B' },
      { name_pattern: '%CHATILLON%', code: 'C' },
      { name_pattern: '%Châtillon%', code: 'C' },
      { name_pattern: '%CLAMART%', code: 'D' },
      { name_pattern: '%CLICH%', code: 'E' }
    ];
    for (const mapping of defaultCalendarCodes) {
      await client.query(`
        UPDATE clubs SET calendar_code = $1
        WHERE (name ILIKE $2 OR display_name ILIKE $2) AND calendar_code IS NULL
      `, [mapping.code, mapping.name_pattern]);
    }

    // Club aliases table - maps variant names to canonical club names
    await client.query(`
      CREATE TABLE IF NOT EXISTS club_aliases (
        id SERIAL PRIMARY KEY,
        alias TEXT NOT NULL UNIQUE,
        canonical_name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add email column to club_aliases for club reminder emails
    await client.query(`ALTER TABLE club_aliases ADD COLUMN IF NOT EXISTS email TEXT`);

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

    // Add convocation_sent_at column to tournoi_ext (migration - January 2026)
    await client.query(`ALTER TABLE tournoi_ext ADD COLUMN IF NOT EXISTS convocation_sent_at TIMESTAMP`);

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

    // Add convocation details columns to inscriptions (migration)
    await client.query(`ALTER TABLE inscriptions ADD COLUMN IF NOT EXISTS convocation_poule VARCHAR(10)`);
    await client.query(`ALTER TABLE inscriptions ADD COLUMN IF NOT EXISTS convocation_lieu VARCHAR(255)`);
    await client.query(`ALTER TABLE inscriptions ADD COLUMN IF NOT EXISTS convocation_adresse TEXT`);
    await client.query(`ALTER TABLE inscriptions ADD COLUMN IF NOT EXISTS convocation_heure VARCHAR(10)`);
    await client.query(`ALTER TABLE inscriptions ADD COLUMN IF NOT EXISTS convocation_notes TEXT`);
    await client.query(`ALTER TABLE inscriptions ADD COLUMN IF NOT EXISTS convocation_phone VARCHAR(50)`);

    // Add source column to track inscription origin (ionos import vs player_app)
    await client.query(`ALTER TABLE inscriptions ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'ionos'`);

    // Add statut column to track inscription status (inscrit, désinscrit)
    // Note: forfait is separate - used only after official convocation is sent
    await client.query(`ALTER TABLE inscriptions ADD COLUMN IF NOT EXISTS statut VARCHAR(20) DEFAULT 'inscrit'`);

    // Add unique constraint on (normalized licence, tournoi_id) to prevent duplicates
    // This ensures a player can only be inscribed once per tournament regardless of source
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_licence_tournoi
      ON inscriptions (REPLACE(UPPER(licence), ' ', ''), tournoi_id)
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

    // Category mapping table - maps IONOS category names to internal category IDs
    await client.query(`
      CREATE TABLE IF NOT EXISTS category_mapping (
        id SERIAL PRIMARY KEY,
        ionos_categorie TEXT NOT NULL,
        game_type TEXT NOT NULL,
        category_id INTEGER REFERENCES categories(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(ionos_categorie, game_type)
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
        outro_template TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add outro_template column if it doesn't exist (for existing deployments)
    await client.query(`
      ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS outro_template TEXT
    `);

    // Player contacts table - centralized contact information
    await client.query(`
      CREATE TABLE IF NOT EXISTS player_contacts (
        id SERIAL PRIMARY KEY,
        licence TEXT UNIQUE,
        first_name TEXT,
        last_name TEXT,
        club TEXT,
        email TEXT,
        telephone TEXT,
        rank_libre TEXT,
        rank_cadre TEXT,
        rank_bande TEXT,
        rank_3bandes TEXT,
        statut TEXT DEFAULT 'Actif',
        comments TEXT,
        email_optin INTEGER DEFAULT 1,
        last_contacted TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Email campaigns table - history of sent emails
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_campaigns (
        id SERIAL PRIMARY KEY,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        template_key TEXT,
        recipients_count INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'draft',
        sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        campaign_type TEXT,
        mode TEXT,
        category TEXT,
        tournament_id INTEGER,
        sent_by TEXT,
        test_mode BOOLEAN DEFAULT FALSE
      )
    `);

    // Add new columns if they don't exist (for existing deployments)
    await client.query(`ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS campaign_type TEXT`);
    await client.query(`ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS mode TEXT`);
    await client.query(`ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS category TEXT`);
    await client.query(`ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS tournament_id INTEGER`);
    await client.query(`ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS sent_by TEXT`);
    await client.query(`ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS test_mode BOOLEAN DEFAULT FALSE`);

    // Scheduled emails table - for future email sending
    await client.query(`
      CREATE TABLE IF NOT EXISTS scheduled_emails (
        id SERIAL PRIMARY KEY,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        template_key TEXT,
        image_url TEXT,
        recipient_ids TEXT NOT NULL,
        scheduled_at TIMESTAMP NOT NULL,
        status TEXT DEFAULT 'pending',
        sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        email_type TEXT,
        mode TEXT,
        category TEXT,
        tournament_id INTEGER,
        outro_text TEXT,
        cc_email TEXT,
        custom_data TEXT,
        created_by TEXT
      )
    `);

    // Add columns if they don't exist (migration)
    await client.query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS image_url TEXT`);
    await client.query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS email_type TEXT`);
    await client.query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS mode TEXT`);
    await client.query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS category TEXT`);
    await client.query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS tournament_id INTEGER`);
    await client.query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS outro_text TEXT`);
    await client.query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS cc_email TEXT`);
    await client.query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS custom_data TEXT`);
    await client.query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS created_by TEXT`);
    await client.query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS test_mode BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS test_email TEXT`);

    // Tournament relance tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tournament_relances (
        id SERIAL PRIMARY KEY,
        tournoi_id INTEGER NOT NULL,
        relance_sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        sent_by TEXT,
        recipients_count INTEGER DEFAULT 0,
        UNIQUE(tournoi_id)
      )
    `);

    // Password reset codes table (replaces in-memory storage for security)
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_codes (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        used BOOLEAN DEFAULT FALSE
      )
    `);
    // Create index for faster lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reset_codes_email ON password_reset_codes(email)
    `);

    // Inscription email logs table - history of inscription/désinscription emails
    await client.query(`
      CREATE TABLE IF NOT EXISTS inscription_email_logs (
        id SERIAL PRIMARY KEY,
        email_type TEXT NOT NULL,
        player_email TEXT NOT NULL,
        player_name TEXT,
        tournament_name TEXT,
        mode TEXT,
        category TEXT,
        tournament_date TEXT,
        location TEXT,
        status TEXT DEFAULT 'sent',
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Player accounts table (for Espace Joueur app)
    await client.query(`
      CREATE TABLE IF NOT EXISTS player_accounts (
        id SERIAL PRIMARY KEY,
        licence VARCHAR(50) NOT NULL UNIQUE,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        email_verified BOOLEAN DEFAULT true,
        is_admin BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        last_login TIMESTAMP
      )
    `);

    // Add GDPR consent columns to player_accounts (migration - January 2026)
    await client.query(`ALTER TABLE player_accounts ADD COLUMN IF NOT EXISTS gdpr_consent_date TIMESTAMP`);
    await client.query(`ALTER TABLE player_accounts ADD COLUMN IF NOT EXISTS gdpr_consent_version VARCHAR(10)`);

    // Announcements table (for Player App notifications)
    await client.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        type VARCHAR(20) DEFAULT 'info',
        is_active BOOLEAN DEFAULT TRUE,
        expires_at TIMESTAMP,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add test_licence and target_licence columns for announcements (migration)
    await client.query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS test_licence VARCHAR(20)`);
    await client.query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS target_licence VARCHAR(20)`);

    // Convocation poules table - stores full poule composition when convocations are sent
    await client.query(`
      CREATE TABLE IF NOT EXISTS convocation_poules (
        id SERIAL PRIMARY KEY,
        tournoi_id INTEGER NOT NULL REFERENCES tournoi_ext(tournoi_id),
        poule_number INTEGER NOT NULL,
        licence VARCHAR(50) NOT NULL,
        player_name VARCHAR(255),
        club VARCHAR(255),
        location_name VARCHAR(255),
        location_address TEXT,
        start_time VARCHAR(10),
        player_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tournoi_id, poule_number, licence)
      )
    `);
    // Index for faster lookups by tournament
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_convocation_poules_tournoi ON convocation_poules(tournoi_id)
    `);

    // Game modes reference table (Modes de jeu)
    await client.query(`
      CREATE TABLE IF NOT EXISTS game_modes (
        id SERIAL PRIMARY KEY,
        code VARCHAR(20) NOT NULL UNIQUE,
        display_name VARCHAR(50) NOT NULL,
        color VARCHAR(10) DEFAULT '#1F4788',
        display_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // FFB rankings reference table (Classements FFB)
    await client.query(`
      CREATE TABLE IF NOT EXISTS ffb_rankings (
        id SERIAL PRIMARY KEY,
        code VARCHAR(10) NOT NULL UNIQUE,
        display_name VARCHAR(50) NOT NULL,
        tier VARCHAR(5) NOT NULL,
        level_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
        { game_type: 'LIBRE', level: 'N3', display_name: 'LIBRE - NATIONALE 3' },
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

    // Migration: Rename LIBRE N3GC to LIBRE N3 (one-time fix)
    await client.query(`
      UPDATE categories
      SET level = 'N3', display_name = 'LIBRE - NATIONALE 3'
      WHERE game_type = 'LIBRE' AND level = 'N3GC'
    `);
    // Ensure LIBRE N3 exists
    await client.query(`
      INSERT INTO categories (game_type, level, display_name)
      VALUES ('LIBRE', 'N3', 'LIBRE - NATIONALE 3')
      ON CONFLICT (game_type, level) DO NOTHING
    `);

    // Add is_active and updated_at columns to categories (migration)
    await client.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`);
    await client.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);

    // Add rank_column to game_modes to map mode to player rank column
    await client.query(`ALTER TABLE game_modes ADD COLUMN IF NOT EXISTS rank_column VARCHAR(30)`);
    // Update existing game_modes with their rank_column values
    await client.query(`UPDATE game_modes SET rank_column = 'rank_libre' WHERE UPPER(code) LIKE '%LIBRE%' AND rank_column IS NULL`);
    await client.query(`UPDATE game_modes SET rank_column = 'rank_cadre' WHERE UPPER(code) LIKE '%CADRE%' AND rank_column IS NULL`);
    await client.query(`UPDATE game_modes SET rank_column = 'rank_bande' WHERE UPPER(code) = 'BANDE' OR UPPER(code) = '1BANDE' AND rank_column IS NULL`);
    await client.query(`UPDATE game_modes SET rank_column = 'rank_3bandes' WHERE UPPER(code) LIKE '%3BANDES%' OR UPPER(code) LIKE '%3 BANDES%' AND rank_column IS NULL`);

    // Initialize game_modes reference data
    const gameModeResult = await client.query('SELECT COUNT(*) as count FROM game_modes');
    if (gameModeResult.rows[0].count == 0) {
      const gameModes = [
        { code: 'LIBRE', display_name: 'Libre', color: '#1F4788', display_order: 1, rank_column: 'rank_libre' },
        { code: 'BANDE', display_name: 'Bande', color: '#28a745', display_order: 2, rank_column: 'rank_bande' },
        { code: '3BANDES', display_name: '3 Bandes', color: '#dc3545', display_order: 3, rank_column: 'rank_3bandes' },
        { code: 'CADRE', display_name: 'Cadre', color: '#6f42c1', display_order: 4, rank_column: 'rank_cadre' }
      ];
      for (const mode of gameModes) {
        await client.query(
          'INSERT INTO game_modes (code, display_name, color, display_order, rank_column) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
          [mode.code, mode.display_name, mode.color, mode.display_order, mode.rank_column]
        );
      }
      console.log('Game modes initialized');
    }

    // Initialize ffb_rankings reference data
    const rankingResult = await client.query('SELECT COUNT(*) as count FROM ffb_rankings');
    if (rankingResult.rows[0].count == 0) {
      const rankings = [
        // National
        { code: 'N1', display_name: 'Nationale 1', tier: 'N', level_order: 1 },
        { code: 'N2', display_name: 'Nationale 2', tier: 'N', level_order: 2 },
        { code: 'N3', display_name: 'Nationale 3', tier: 'N', level_order: 3 },
        // Regional
        { code: 'R1', display_name: 'Régionale 1', tier: 'R', level_order: 4 },
        { code: 'R2', display_name: 'Régionale 2', tier: 'R', level_order: 5 },
        { code: 'R3', display_name: 'Régionale 3', tier: 'R', level_order: 6 },
        { code: 'R4', display_name: 'Régionale 4', tier: 'R', level_order: 7 },
        // Departemental
        { code: 'D1', display_name: 'Départementale 1', tier: 'D', level_order: 8 },
        { code: 'D2', display_name: 'Départementale 2', tier: 'D', level_order: 9 },
        { code: 'D3', display_name: 'Départementale 3', tier: 'D', level_order: 10 },
        { code: 'D4', display_name: 'Départementale 4', tier: 'D', level_order: 11 },
        // Non classé
        { code: 'NC', display_name: 'Non Classé', tier: 'NC', level_order: 99 }
      ];
      for (const rank of rankings) {
        await client.query(
          'INSERT INTO ffb_rankings (code, display_name, tier, level_order) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [rank.code, rank.display_name, rank.tier, rank.level_order]
        );
      }
      console.log('FFB rankings initialized');
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

    // Initialize category mappings
    // First, get all existing categories
    const categoriesResult = await client.query('SELECT id, game_type, level FROM categories');
    const categories = categoriesResult.rows;

    // Define IONOS category variations for each internal level
    // Note: N3GC, N3 GC etc. are variations that should map to N3 (not separate categories)
    const categoryVariations = {
      // National levels - N3 includes all GC variations for LIBRE
      'N1': ['N1', 'N 1', 'n1', 'NATIONALE 1', 'Nationale 1'],
      'N2': ['N2', 'N 2', 'n2', 'NATIONALE 2', 'Nationale 2'],
      'N3': ['N3', 'N 3', 'n3', 'NATIONALE 3', 'Nationale 3', 'N3GC', 'N3 GC', 'N 3 GC', 'N3-GC', 'NATIONALE 3 GC', 'n3gc', 'N3 gc'],
      // Regional levels
      'R1': ['R1', 'R 1', 'r1', 'REGIONALE 1', 'Regionale 1', 'Régionale 1'],
      'R2': ['R2', 'R 2', 'r2', 'REGIONALE 2', 'Regionale 2', 'Régionale 2'],
      'R3': ['R3', 'R 3', 'r3', 'REGIONALE 3', 'Regionale 3', 'Régionale 3'],
      'R4': ['R4', 'R 4', 'r4', 'REGIONALE 4', 'Regionale 4', 'Régionale 4'],
      // Departmental levels
      'D1': ['D1', 'D 1', 'd1', 'DEPARTEMENTALE 1', 'Departementale 1', 'Départementale 1'],
      'D2': ['D2', 'D 2', 'd2', 'DEPARTEMENTALE 2', 'Departementale 2', 'Départementale 2'],
      'D3': ['D3', 'D 3', 'd3', 'DEPARTEMENTALE 3', 'Departementale 3', 'Départementale 3']
    };

    for (const category of categories) {
      const baseLevel = category.level.toUpperCase().replace(/\s+/g, ' ').trim();
      const variations = categoryVariations[baseLevel] || [baseLevel];

      for (const variation of variations) {
        await client.query(
          `INSERT INTO category_mapping (ionos_categorie, game_type, category_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (ionos_categorie, game_type) DO UPDATE SET category_id = $3`,
          [variation, category.game_type, category.id]
        );
      }
    }

    // Fix: Ensure ALL N3 variations (including N3GC) map to LIBRE N3
    const libreN3 = categories.find(c => c.game_type === 'LIBRE' && c.level === 'N3');
    if (libreN3) {
      const allN3Variations = ['N3', 'N 3', 'n3', 'NATIONALE 3', 'Nationale 3', 'N3GC', 'N3 GC', 'N 3 GC', 'N3-GC', 'NATIONALE 3 GC', 'n3gc', 'N3 gc'];
      for (const variation of allN3Variations) {
        await client.query(
          `INSERT INTO category_mapping (ionos_categorie, game_type, category_id)
           VALUES ($1, 'LIBRE', $2)
           ON CONFLICT (ionos_categorie, game_type) DO UPDATE SET category_id = $2`,
          [variation, libreN3.id]
        );
      }
      console.log('LIBRE N3 mappings updated - all N3/N3GC variations now map to LIBRE N3');
    }
    console.log('Category mappings initialized');

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

    // Initialize default email templates
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

      // General email template
      const generalBodyTemplate = `Bonjour {player_name},

{message}

Cordialement,
Comite Departemental Billard Hauts-de-Seine`;

      await client.query(
        `INSERT INTO email_templates (template_key, subject_template, body_template)
         VALUES ($1, $2, $3) ON CONFLICT (template_key) DO NOTHING`,
        ['general', 'Information CDBHS', generalBodyTemplate]
      );

      // Information template
      const infoBodyTemplate = `Bonjour {player_name},

Nous souhaitons vous informer de la nouvelle suivante:

{message}

Pour toute question, n'hesitez pas a nous contacter.

Cordialement,
Comite Departemental Billard Hauts-de-Seine`;

      await client.query(
        `INSERT INTO email_templates (template_key, subject_template, body_template)
         VALUES ($1, $2, $3) ON CONFLICT (template_key) DO NOTHING`,
        ['information', 'Information importante - CDBHS', infoBodyTemplate]
      );

      // Reminder template
      const rappelBodyTemplate = `Bonjour {player_name},

Ceci est un rappel concernant:

{message}

Merci de votre attention.

Cordialement,
Comite Departemental Billard Hauts-de-Seine`;

      await client.query(
        `INSERT INTO email_templates (template_key, subject_template, body_template)
         VALUES ($1, $2, $3) ON CONFLICT (template_key) DO NOTHING`,
        ['rappel', 'Rappel - CDBHS', rappelBodyTemplate]
      );

      // Results template (for tournament results email)
      const resultsBodyTemplate = `Bonjour {player_name},

Veuillez trouver ci-joint les résultats du tournoi {tournament}.

{message}

Cordialement,
Comité Départemental Billard Hauts-de-Seine`;

      await client.query(
        `INSERT INTO email_templates (template_key, subject_template, body_template)
         VALUES ($1, $2, $3) ON CONFLICT (template_key) DO NOTHING`,
        ['results', 'Résultats {category} - {tournament}', resultsBodyTemplate]
      );

      // CC Email setting template (stores the default CC email address)
      await client.query(
        `INSERT INTO email_templates (template_key, subject_template, body_template)
         VALUES ($1, $2, $3) ON CONFLICT (template_key) DO NOTHING`,
        ['results_cc_email', 'cdbhs92@gmail.com', '']
      );

      console.log('Default email templates initialized');
    }

    // Ensure results and cc_email templates exist (added later, need to be inserted separately)
    await client.query(
      `INSERT INTO email_templates (template_key, subject_template, body_template)
       VALUES ('results', 'Résultats {category} - {tournament}', 'Bonjour {player_name},\n\nVeuillez trouver ci-joint les résultats du tournoi {tournament}.\n\n{message}\n\nCordialement,\nComité Départemental Billard Hauts-de-Seine')
       ON CONFLICT (template_key) DO NOTHING`
    );
    await client.query(
      `INSERT INTO email_templates (template_key, subject_template, body_template)
       VALUES ('results_cc_email', 'cdbhs92@gmail.com', '')
       ON CONFLICT (template_key) DO NOTHING`
    );

    // Club reminder template
    const clubReminderBody = `Bonjour,

Votre club {club_name} accueille prochainement une compétition du CDBHS.

DÉTAILS DE LA COMPÉTITION:
- Compétition: {category} - {tournament}
- Date: {date}
- Horaire: {time}
- Participants: {num_players} joueur(s)
- Tables nécessaires: {num_tables} table(s)

RAPPELS IMPORTANTS:
- Maître de jeu: Merci de prévoir la présence d'un maître de jeu pour encadrer la compétition
- Arbitrage: Si vous avez des arbitres disponibles, merci de nous le signaler. Sinon, l'autoarbitrage sera mis en place
- Résultats FFB: Les résultats devront être saisis sur le site de la FFB à l'issue de la compétition
- Rafraîchissements: Merci de prévoir des rafraîchissements pour les joueurs

Pour toute question, contactez-nous à l'adresse: cdbhs92@gmail.com

Sportivement,
Le CDBHS`;
    await client.query(
      `INSERT INTO email_templates (template_key, subject_template, body_template)
       VALUES ('club_reminder', 'Rappel Organisation - {category} {tournament}', $1)
       ON CONFLICT (template_key) DO NOTHING`,
      [clubReminderBody]
    );

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
  // Direct query method (Promise-based, returns { rows })
  query: (query, params) => pool.query(query, params),

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
