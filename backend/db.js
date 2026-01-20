const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const DB_PATH = path.join(__dirname, '../database/billard.db');

// Create database connection
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database');
    initializeDatabase();
  }
});

// Initialize database schema
function initializeDatabase() {
  db.serialize(() => {
    // Admin table
    db.run(`
      CREATE TABLE IF NOT EXISTS admin (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Players table
    db.run(`
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Categories table (13 categories)
    db.run(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_type TEXT NOT NULL,
        level TEXT NOT NULL,
        display_name TEXT NOT NULL,
        UNIQUE(game_type, level)
      )
    `);

    // Tournaments table
    db.run(`
      CREATE TABLE IF NOT EXISTS tournaments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL,
        tournament_number INTEGER NOT NULL,
        season TEXT NOT NULL,
        import_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        tournament_date DATETIME,
        location TEXT,
        FOREIGN KEY (category_id) REFERENCES categories(id),
        UNIQUE(category_id, tournament_number, season)
      )
    `);

    // Add results_email_sent columns to tournaments (migration for existing databases)
    db.run(`ALTER TABLE tournaments ADD COLUMN results_email_sent INTEGER DEFAULT 0`, [], (err) => {
      // Ignore error if column already exists
    });
    db.run(`ALTER TABLE tournaments ADD COLUMN results_email_sent_at DATETIME`, [], (err) => {
      // Ignore error if column already exists
    });

    // Tournament results table
    db.run(`
      CREATE TABLE IF NOT EXISTS tournament_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tournament_id INTEGER NOT NULL,
        licence TEXT NOT NULL,
        player_name TEXT,
        match_points INTEGER DEFAULT 0,
        moyenne REAL DEFAULT 0,
        serie INTEGER DEFAULT 0,
        FOREIGN KEY (tournament_id) REFERENCES tournaments(id),
        FOREIGN KEY (licence) REFERENCES players(licence),
        UNIQUE(tournament_id, licence)
      )
    `);

    // Rankings table (cumulative)
    db.run(`
      CREATE TABLE IF NOT EXISTS rankings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL,
        season TEXT NOT NULL,
        licence TEXT NOT NULL,
        total_match_points INTEGER DEFAULT 0,
        avg_moyenne REAL DEFAULT 0,
        best_serie INTEGER DEFAULT 0,
        rank_position INTEGER,
        tournament_1_points INTEGER DEFAULT 0,
        tournament_2_points INTEGER DEFAULT 0,
        tournament_3_points INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES categories(id),
        FOREIGN KEY (licence) REFERENCES players(licence),
        UNIQUE(category_id, season, licence)
      )
    `);

    // Clubs table
    db.run(`
      CREATE TABLE IF NOT EXISTS clubs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        logo_filename TEXT,
        street TEXT,
        city TEXT,
        zip_code TEXT,
        phone TEXT,
        email TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add new columns to clubs if they don't exist (migration for existing databases)
    const clubColumns = ['street', 'city', 'zip_code', 'phone', 'email'];
    clubColumns.forEach(col => {
      db.run(`ALTER TABLE clubs ADD COLUMN ${col} TEXT`, [], (err) => {
        // Ignore error if column already exists
      });
    });

    // Player contacts table - centralized contact information
    db.run(`
      CREATE TABLE IF NOT EXISTS player_contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        last_contacted DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Email campaigns table - history of sent emails
    db.run(`
      CREATE TABLE IF NOT EXISTS email_campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        template_key TEXT,
        recipients_count INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'draft',
        sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Scheduled emails table - for future email sending
    db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        template_key TEXT,
        recipient_ids TEXT NOT NULL,
        scheduled_at DATETIME NOT NULL,
        status TEXT DEFAULT 'pending',
        sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Password reset codes table (replaces in-memory storage for security)
    db.run(`
      CREATE TABLE IF NOT EXISTS password_reset_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        used INTEGER DEFAULT 0
      )
    `);
    // Create index for faster lookups
    db.run(`CREATE INDEX IF NOT EXISTS idx_reset_codes_email ON password_reset_codes(email)`);

    // Inscription email logs table - history of inscription/désinscription emails
    db.run(`
      CREATE TABLE IF NOT EXISTS inscription_email_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Player invitations table - tracks invitations sent to players to join the Player App
    db.run(`
      CREATE TABLE IF NOT EXISTS player_invitations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_contact_id INTEGER NOT NULL,
        licence TEXT NOT NULL,
        email TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        club TEXT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        sent_by_user_id INTEGER,
        sent_by_username TEXT,
        has_signed_up INTEGER DEFAULT 0,
        signed_up_at DATETIME,
        resend_count INTEGER DEFAULT 0,
        last_resent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (player_contact_id) REFERENCES player_contacts(id)
      )
    `);
    // Create indexes for faster lookups
    db.run(`CREATE INDEX IF NOT EXISTS idx_player_invitations_licence ON player_invitations(REPLACE(licence, ' ', ''))`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_player_invitations_email ON player_invitations(email)`);

    // Initialize default admin password (admin123 - should be changed)
    db.get('SELECT COUNT(*) as count FROM admin', [], (err, row) => {
      if (!err && row.count === 0) {
        const defaultPassword = 'admin123';
        bcrypt.hash(defaultPassword, 10, (err, hash) => {
          if (!err) {
            db.run('INSERT INTO admin (password_hash) VALUES (?)', [hash]);
            console.log('Default admin password created: admin123');
            console.log('Please change it after first login!');
          }
        });
      }
    });

    // Initialize categories
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

    db.get('SELECT COUNT(*) as count FROM categories', [], (err, row) => {
      if (!err && row.count === 0) {
        const stmt = db.prepare('INSERT INTO categories (game_type, level, display_name) VALUES (?, ?, ?)');
        categories.forEach(cat => {
          stmt.run(cat.game_type, cat.level, cat.display_name);
        });
        stmt.finalize();
        console.log('Categories initialized');
      }
    });

    // Initialize default clubs
    const defaultClubs = [
      { name: 'Châtillon', display_name: 'Billard Club de Châtillon', logo_filename: 'S_C_M_C_BILLARD_CLUB.png' },
      { name: 'A DE BILLARD COURBEVOIE LA DEFENSE', display_name: 'A DE BILLARD COURBEVOIE LA DEFENSE', logo_filename: 'A_DE_BILLARD_COURBEVOIE_LA_DEFENSE.png' },
      { name: 'BILLARD BOIS COLOMBES', display_name: 'BILLARD BOIS COLOMBES', logo_filename: 'BILLARD_BOIS_COLOMBES.png' },
      { name: 'BILLARD CLUB CLICHOIS', display_name: 'BILLARD CLUB CLICHOIS', logo_filename: 'BILLARD_CLUB_CLICHOIS.png' },
      { name: 'BILLARD CLUB LA GARENNE CLAMART', display_name: 'BILLARD CLUB LA GARENNE CLAMART', logo_filename: 'BILLARD_CLUB_LA_GARENNE_CLAMART.png' },
      { name: 'S C M C BILLARD CLUB', display_name: 'S C M C BILLARD CLUB', logo_filename: 'S_C_M_C_BILLARD_CLUB.png' }
    ];

    db.get('SELECT COUNT(*) as count FROM clubs', [], (err, row) => {
      if (!err && row.count === 0) {
        const stmt = db.prepare('INSERT INTO clubs (name, display_name, logo_filename) VALUES (?, ?, ?)');
        defaultClubs.forEach(club => {
          stmt.run(club.name, club.display_name, club.logo_filename);
        });
        stmt.finalize();
        console.log('Default clubs initialized');
      }
    });
  });
}

module.exports = db;
