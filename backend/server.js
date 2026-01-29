const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

// Validate required environment variables
const requiredEnvVars = ['JWT_SECRET'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0 && process.env.NODE_ENV === 'production') {
  console.error(`FATAL: Missing required environment variables: ${missingEnvVars.join(', ')}`);
  console.error('Server cannot start without these variables in production mode.');
  process.exit(1);
}

// Ensure database directory exists for SQLite (when running locally)
if (!process.env.DATABASE_URL) {
  const dbDir = path.join(__dirname, '../database');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

// Use database loader - automatically selects PostgreSQL or SQLite
const db = require('./db-loader');

// App settings helper for dynamic configuration
const appSettings = require('./utils/app-settings');

const authRoutes = require('./routes/auth');
const playersRoutes = require('./routes/players');
const tournamentsRoutes = require('./routes/tournaments');
const rankingsRoutes = require('./routes/rankings');
const calendarRoutes = require('./routes/calendar');
const clubsRoutes = require('./routes/clubs');
const backupRoutes = require('./routes/backup');
const inscriptionsRoutes = require('./routes/inscriptions');
const emailRoutes = require('./routes/email');
const settingsRoutes = require('./routes/settings');
const emailingRoutes = require('./routes/emailing');
const statisticsRoutes = require('./routes/statistics');
const playerAccountsRoutes = require('./routes/player-accounts');
const activityLogsRoutes = require('./routes/activity-logs');
const announcementsRoutes = require('./routes/announcements');
const referenceDataRoutes = require('./routes/reference-data');
const adminLogsRoutes = require('./routes/admin-logs');
const playerInvitationsRoutes = require('./routes/player-invitations');
const importConfigRoutes = require('./routes/import-config');
const enrollmentRequestsRoutes = require('./routes/enrollment-requests');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Railway - required for rate limiting to work correctly
// Without this, all requests appear to come from Railway's internal proxy IP
app.set('trust proxy', true);

console.log('Railway deployment - using PORT:', PORT);

// Security Middleware
// Helmet - Sets security-related HTTP headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.sheetjs.com", "https://cdn.jsdelivr.net", "https://cdn.quilljs.com"],
      scriptSrcAttr: ["'unsafe-inline'"], // Allow inline onclick handlers
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.quilljs.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://cdn.jsdelivr.net", "https://cdn.quilljs.com"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false // Allow images from external sources
}));

// CORS - Configure allowed origins
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [
      'http://localhost:3000',
      'https://cdbhs-tournament-management-production.up.railway.app'
    ];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: { error: 'Trop de tentatives de connexion. Veuillez réessayer dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  validate: { trustProxy: false } // Disable validation - we trust Railway's proxy
});

// General API rate limiter
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 500, // 500 requests per minute per IP
  message: { error: 'Trop de requêtes. Veuillez réessayer dans quelques instants.' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false } // Disable validation - we trust Railway's proxy
});

// Body parsing middleware
app.use(express.json({ limit: '10mb' })); // Limit JSON payload size
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static frontend files
// Check if frontend folder exists in current directory (Railway) or parent directory (local)
const frontendPath = fs.existsSync(path.join(__dirname, 'frontend'))
  ? path.join(__dirname, 'frontend')
  : path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

// Public endpoint for organization logo (needed for emails)
// Must allow cross-origin access for email clients (Outlook, Gmail, etc.)
app.get('/logo.png', (req, res) => {
  const db = require('./db-loader');
  db.get('SELECT file_data, content_type FROM organization_logo ORDER BY created_at DESC LIMIT 1', [], (err, row) => {
    if (err || !row) {
      return res.status(404).send('Logo not found');
    }
    res.setHeader('Content-Type', row.content_type || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    // Override helmet's restrictive CORP header to allow email clients to load the image
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    const fileData = Buffer.isBuffer(row.file_data) ? row.file_data : Buffer.from(row.file_data);
    res.send(fileData);
  });
});

// API Routes with rate limiting
// Apply strict rate limit only to login/password endpoints, general limit for other auth routes
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/forgot', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password-token', authLimiter);
app.use('/api/auth/reset-with-code', authLimiter);
app.use('/api/auth', apiLimiter, authRoutes); // General limit for other auth routes (/me, /users)
app.use('/api/players', apiLimiter, playersRoutes);
app.use('/api/tournaments', apiLimiter, tournamentsRoutes);
app.use('/api/rankings', apiLimiter, rankingsRoutes);
app.use('/api/calendar', apiLimiter, calendarRoutes);
app.use('/api/clubs', apiLimiter, clubsRoutes);
app.use('/api/backup', apiLimiter, backupRoutes);
app.use('/api/inscriptions', apiLimiter, inscriptionsRoutes);
app.use('/api/email', apiLimiter, emailRoutes);
app.use('/api/settings', apiLimiter, settingsRoutes);
app.use('/api/emailing', apiLimiter, emailingRoutes);
app.use('/api/statistics', apiLimiter, statisticsRoutes);
app.use('/api/player-accounts', apiLimiter, playerAccountsRoutes);
app.use('/api/activity-logs', apiLimiter, activityLogsRoutes);
app.use('/api/announcements', apiLimiter, announcementsRoutes);
app.use('/api/reference-data', apiLimiter, referenceDataRoutes);
app.use('/api/admin-logs', apiLimiter, adminLogsRoutes);
app.use('/api/player-invitations', apiLimiter, playerInvitationsRoutes);
app.use('/api/import-config', apiLimiter, importConfigRoutes);
app.use('/api/enrollment-requests', apiLimiter, enrollmentRequestsRoutes);

// App version endpoint (for automatic update detection)
// INCREMENT THIS VERSION when deploying updates you want users to see
const APP_VERSION = '2026.01.13.1';
app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'cdbhs-tournament-management',
    timestamp: new Date().toISOString()
  });
});

// TEMPORARY: Demo seed endpoint - REMOVE AFTER SEEDING
app.get('/api/seed-demo', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== 'seed-demo-2024') {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  const bcrypt = require('bcrypt');

  try {
    // Create demo admin (upsert - insert or update if exists)
    const hashedPassword = await bcrypt.hash('demo123', 10);

    // First try to delete existing demo user
    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM users WHERE username = $1`, ['demo'], (err) => {
        // Ignore errors - user might not exist
        resolve();
      });
    });

    // Insert demo user
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO users (username, password_hash, email, role, is_active) VALUES ($1, $2, $3, $4, 1)`,
        ['demo', hashedPassword, 'demo@example.com', 'admin'],
        (err) => err ? reject(err) : resolve()
      );
    });

    res.json({
      success: true,
      message: 'Demo admin user created successfully!',
      login: { username: 'demo', password: 'demo123' },
      note: 'For full demo data, call /api/seed-demo-full?secret=seed-demo-2024'
    });
  } catch (error) {
    console.error('Seed error:', error);
    res.status(500).json({ error: error.message });
  }
});

// TEMPORARY: Cleanup duplicate categories created by seed
app.get('/api/cleanup-categories', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== 'seed-demo-2024') {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

  const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });

  try {
    // Wrong game_type values created by seed (codes instead of display names)
    const wrongGameTypes = ['LIBRE', 'BANDE', '3BANDES', '3 BANDES', 'CADRE', '3bandes'];
    let deleted = { categories: 0, tournaments: 0, mappings: 0 };

    for (const wrongType of wrongGameTypes) {
      // Get categories with wrong game_type
      const wrongCats = await dbAll(`SELECT id FROM categories WHERE game_type = $1`, [wrongType]);

      for (const cat of wrongCats) {
        // Delete related records first (handle foreign keys)
        await dbRun(`DELETE FROM category_mapping WHERE category_id = $1`, [cat.id]);
        deleted.mappings++;
        await dbRun(`DELETE FROM tournaments WHERE category_id = $1`, [cat.id]);
        deleted.tournaments++;
        await dbRun(`DELETE FROM categories WHERE id = $1`, [cat.id]);
        deleted.categories++;
      }
    }

    res.json({
      success: true,
      message: 'Cleanup complete',
      deleted
    });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// TEMPORARY: Full demo seed endpoint - creates players, clubs, tournaments, inscriptions
app.get('/api/seed-demo-full', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== 'seed-demo-2024') {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  // Helper functions
  const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

  const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

  const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });

  const randomElement = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const generateLicence = (index) => {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const num = String(100000 + index).slice(1);
    return `D${num}${letters[index % letters.length]}`;
  };

  // Demo data
  const DEMO_CLUBS = [
    { name: 'ACADEMIE BILLARD CLICHY', display_name: 'Académie Billard Clichy', city: 'Clichy' },
    { name: 'BILLARD CLUB BOULOGNE', display_name: 'Billard Club Boulogne', city: 'Boulogne-Billancourt' },
    { name: 'CERCLE BILLARD NEUILLY', display_name: 'Cercle Billard Neuilly', city: 'Neuilly-sur-Seine' },
    { name: 'ASSOCIATION BILLARD LEVALLOIS', display_name: 'Association Billard Levallois', city: 'Levallois-Perret' },
    { name: 'BILLARD CLUB COLOMBES', display_name: 'Billard Club Colombes', city: 'Colombes' },
    { name: 'ENTENTE BILLARD NANTERRE', display_name: 'Entente Billard Nanterre', city: 'Nanterre' },
    { name: 'BILLARD CLUB RUEIL', display_name: 'Billard Club Rueil', city: 'Rueil-Malmaison' },
    { name: 'ACADEMIE CARAMBOLE ASNIERES', display_name: 'Académie Carambole Asnières', city: 'Asnières-sur-Seine' }
  ];

  const FIRST_NAMES = ['Jean', 'Pierre', 'Michel', 'Philippe', 'Alain', 'Bernard', 'Jacques', 'Daniel',
    'Patrick', 'Serge', 'Christian', 'Claude', 'Marc', 'Laurent', 'Stephane', 'Thierry',
    'Francois', 'Eric', 'Pascal', 'Olivier', 'Nicolas', 'David', 'Christophe', 'Didier',
    'Bruno', 'Robert', 'Gilles', 'Andre', 'Gerard', 'Yves', 'Paul', 'Henri',
    'Marie', 'Isabelle', 'Catherine', 'Nathalie', 'Sophie', 'Sandrine', 'Valerie', 'Christine'];

  const LAST_NAMES = ['MARTIN', 'BERNARD', 'THOMAS', 'PETIT', 'ROBERT', 'RICHARD', 'DURAND', 'DUBOIS',
    'MOREAU', 'LAURENT', 'SIMON', 'MICHEL', 'LEFEBVRE', 'LEROY', 'ROUX', 'DAVID',
    'BERTRAND', 'MOREL', 'FOURNIER', 'GIRARD', 'BONNET', 'DUPONT', 'LAMBERT', 'FONTAINE',
    'ROUSSEAU', 'VINCENT', 'MULLER', 'LEFEVRE', 'FAURE', 'ANDRE', 'MERCIER', 'BLANC'];

  const FFB_RANKINGS = ['N1', 'N2', 'N3', 'R1', 'R2', 'R3', 'R4', 'D1', 'D2', 'D3'];

  try {
    let stats = { clubs: 0, players: 0, tournaments: 0, inscriptions: 0, cleared: { tournaments: 0, inscriptions: 0 } };

    // 0. Clear old demo data for fresh seeding
    // Delete inscriptions for demo tournaments (those with 'Tournoi' in the name)
    const demoTournois = await dbAll(`SELECT tournoi_id FROM tournoi_ext WHERE nom LIKE 'Tournoi %'`);
    const demoTournoiIds = demoTournois.map(t => t.tournoi_id);

    if (demoTournoiIds.length > 0) {
      for (const tid of demoTournoiIds) {
        const deleted = await dbRun(`DELETE FROM inscriptions WHERE tournoi_id = $1`, [tid]);
        stats.cleared.inscriptions += deleted.changes || 0;
      }
      for (const tid of demoTournoiIds) {
        await dbRun(`DELETE FROM tournoi_ext WHERE tournoi_id = $1`, [tid]);
        stats.cleared.tournaments++;
      }
    }


    // 1. Create clubs
    for (const club of DEMO_CLUBS) {
      const existing = await dbGet(`SELECT id FROM clubs WHERE name = $1`, [club.name]);
      if (!existing) {
        await dbRun(`INSERT INTO clubs (name, display_name, city) VALUES ($1, $2, $3)`,
          [club.name, club.display_name, club.city]);
        stats.clubs++;
      }
    }

    // 2. Create players
    const existingPlayers = await dbAll(`SELECT licence FROM players WHERE licence LIKE 'D%'`);
    const existingLicences = new Set(existingPlayers.map(p => p.licence));
    const usedNames = new Set();
    const players = [];

    for (let i = 0; i < 80; i++) {
      let firstName, lastName, fullName;
      do {
        firstName = randomElement(FIRST_NAMES);
        lastName = randomElement(LAST_NAMES);
        fullName = `${firstName} ${lastName}`;
      } while (usedNames.has(fullName));
      usedNames.add(fullName);

      const licence = generateLicence(i);
      if (existingLicences.has(licence)) continue;

      const club = randomElement(DEMO_CLUBS);
      players.push({
        licence, first_name: firstName, last_name: lastName, club: club.name,
        rank_libre: randomElement(FFB_RANKINGS), rank_cadre: randomElement(FFB_RANKINGS),
        rank_bande: randomElement(FFB_RANKINGS), rank_3bandes: randomElement(FFB_RANKINGS),
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@demo.com`
      });
    }

    for (const p of players) {
      await dbRun(
        `INSERT INTO players (licence, first_name, last_name, club, rank_libre, rank_cadre, rank_bande, rank_3bandes, email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [p.licence, p.first_name, p.last_name, p.club, p.rank_libre, p.rank_cadre, p.rank_bande, p.rank_3bandes, p.email]
      );
      stats.players++;
    }

    // 3. Create tournaments
    const maxIdResult = await dbGet(`SELECT COALESCE(MAX(tournoi_id), 0) as max_id FROM tournoi_ext`);
    let tournoiId = (maxIdResult?.max_id || 0) + 1;
    const tournaments = [];
    const now = new Date();

    // Use Title Case modes to match game_modes.display_name
    for (const mode of ['Libre', 'Bande', '3 Bandes']) {
      for (const categorie of ['N3', 'R1', 'R2']) {
        for (let t = 1; t <= 3; t++) {
          const tDate = new Date(now);
          tDate.setMonth(tDate.getMonth() + (t - 2)); // T1: -1 month, T2: now, T3: +1 month
          tDate.setDate(randomInt(1, 28));

          tournaments.push({
            tournoi_id: tournoiId++,
            nom: `Tournoi ${t} ${mode} ${categorie}`,
            mode, categorie,
            debut: tDate.toISOString().split('T')[0],
            lieu: randomElement(DEMO_CLUBS.map(c => c.city))
          });
        }
      }
    }

    for (const t of tournaments) {
      await dbRun(
        `INSERT INTO tournoi_ext (tournoi_id, nom, mode, categorie, debut, lieu) VALUES ($1, $2, $3, $4, $5, $6)`,
        [t.tournoi_id, t.nom, t.mode, t.categorie, t.debut, t.lieu]
      );
      stats.tournaments++;
    }

    // 3b. Create internal tournaments for existing categories (for generate-poules season dropdown)
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const currentSeason = currentMonth >= 8 ? `${currentYear}-${currentYear + 1}` : `${currentYear - 1}-${currentYear}`;

    stats.internalTournaments = 0;

    // Get existing categories (don't modify them - they're configured via settings)
    const existingCategories = await dbAll(`SELECT id, game_type, level FROM categories`);

    for (const category of existingCategories) {
      // Create tournaments 1, 2, 3 for current season
      for (let tournamentNum = 1; tournamentNum <= 3; tournamentNum++) {
        const existing = await dbGet(
          `SELECT id FROM tournaments WHERE category_id = $1 AND tournament_number = $2 AND season = $3`,
          [category.id, tournamentNum, currentSeason]
        );

        if (!existing) {
          await dbRun(
            `INSERT INTO tournaments (category_id, tournament_number, season) VALUES ($1, $2, $3)`,
            [category.id, tournamentNum, currentSeason]
          );
          stats.internalTournaments++;
        }
      }
    }

    // 4. Create inscriptions
    const allPlayers = await dbAll(`SELECT licence, email FROM players WHERE licence LIKE 'D%'`);

    for (const tournament of tournaments) {
      const numInscriptions = randomInt(8, 16);
      const shuffled = [...allPlayers].sort(() => Math.random() - 0.5);
      const selected = shuffled.slice(0, Math.min(numInscriptions, shuffled.length));

      for (const player of selected) {
        const existing = await dbGet(
          `SELECT inscription_id FROM inscriptions WHERE tournoi_id = $1 AND licence = $2`,
          [tournament.tournoi_id, player.licence]
        );

        if (!existing) {
          const maxInscId = await dbGet(`SELECT COALESCE(MAX(inscription_id), 0) as max_id FROM inscriptions`);
          const inscriptionId = (maxInscId?.max_id || 0) + 1;

          await dbRun(
            `INSERT INTO inscriptions (inscription_id, tournoi_id, licence, email, source, timestamp)
             VALUES ($1, $2, $3, $4, 'demo', CURRENT_TIMESTAMP)`,
            [inscriptionId, tournament.tournoi_id, player.licence, player.email]
          );
          stats.inscriptions++;
        }
      }
    }

    res.json({
      success: true,
      message: 'Full demo data seeded successfully! Old demo tournaments cleared and fresh data created with current dates.',
      stats,
      login: { username: 'demo', password: 'demo123' }
    });
  } catch (error) {
    console.error('Full seed error:', error);
    res.status(500).json({ error: error.message });
  }
});

// TEMPORARY: Normalize game modes across all tables
app.get('/api/normalize-modes', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== 'seed-demo-2024') {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

  const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });

  try {
    // Uppercase values to delete/normalize
    const wrongModes = ['LIBRE', 'BANDE', '3 BANDES', '3BANDES', 'CADRE'];
    const stats = { deletedCategories: 0, deletedTournaments: 0, deletedMappings: 0, updatedTournois: 0 };

    // 1. Delete duplicate categories with uppercase game_type
    // (keep the Title Case ones that already exist)
    // Must delete in order: tournaments -> category_mapping -> categories
    for (const wrongMode of wrongModes) {
      // First delete tournaments referencing these categories
      let result = await dbRun(`DELETE FROM tournaments WHERE category_id IN (SELECT id FROM categories WHERE game_type = $1)`, [wrongMode]);
      stats.deletedTournaments += result.changes || 0;

      // Then delete category_mapping references
      result = await dbRun(`DELETE FROM category_mapping WHERE category_id IN (SELECT id FROM categories WHERE game_type = $1)`, [wrongMode]);
      stats.deletedMappings += result.changes || 0;

      // Finally delete the categories
      result = await dbRun(`DELETE FROM categories WHERE game_type = $1`, [wrongMode]);
      stats.deletedCategories += result.changes || 0;
    }

    // 2. Normalize tournoi_ext.mode to Title Case
    const modeMapping = {
      'LIBRE': 'Libre',
      'BANDE': 'Bande',
      '3 BANDES': '3 Bandes',
      '3BANDES': '3 Bandes',
      'CADRE': 'Cadre'
    };

    for (const [upper, canonical] of Object.entries(modeMapping)) {
      const result = await dbRun(`UPDATE tournoi_ext SET mode = $1 WHERE mode = $2`, [canonical, upper]);
      stats.updatedTournois += result.changes || 0;
    }

    // 3. List remaining categories for verification
    const remainingCategories = await dbAll(`SELECT DISTINCT game_type FROM categories ORDER BY game_type`);

    res.json({
      success: true,
      message: 'Uppercase modes deleted, tournaments normalized',
      stats,
      remainingGameTypes: remainingCategories.map(c => c.game_type)
    });
  } catch (error) {
    console.error('Normalize error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve frontend pages
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'login.html'));
});

// Helper to check if campaign was already sent manually
async function checkIfAlreadySentManually(db, emailType, mode, category, tournamentId) {
  return new Promise((resolve, reject) => {
    let query = `SELECT id FROM email_campaigns
                 WHERE campaign_type = $1
                   AND status IN ('completed', 'sending')
                   AND (test_mode = FALSE OR test_mode IS NULL)`;
    const params = [emailType];
    let paramIndex = 2;

    if (mode) {
      query += ` AND (mode = $${paramIndex++} OR mode IS NULL)`;
      params.push(mode);
    }
    if (category) {
      query += ` AND (category = $${paramIndex++} OR category IS NULL)`;
      params.push(category);
    }
    if (tournamentId) {
      query += ` AND tournament_id = $${paramIndex++}`;
      params.push(tournamentId);
    }

    query += ' LIMIT 1';

    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(!!row);
    });
  });
}

// Process templated scheduled emails (relance, results, finale)
async function processTemplatedScheduledEmail(db, resend, scheduled, delay) {
  const emailType = scheduled.email_type;
  console.log(`[Email Scheduler] Processing templated email ${scheduled.id} (${emailType})`);

  // Get dynamic settings for qualification thresholds and email branding
  const qualificationSettings = await appSettings.getQualificationSettings();
  const emailSettings = await appSettings.getSettingsBatch([
    'primary_color', 'email_communication', 'email_sender_name',
    'organization_name', 'organization_short_name', 'summary_email'
  ]);

  let recipients = [];
  let templateVariables = {};

  // Fetch recipients based on email type
  if (emailType.startsWith('relance_')) {
    // Parse custom data for template
    const customData = scheduled.custom_data ? JSON.parse(scheduled.custom_data) : {};

    // Look up category from database for proper display_name
    const mode = (scheduled.mode || '').toUpperCase();
    const categoryLevel = (scheduled.category || '').toUpperCase();

    const categoryRow = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM categories WHERE UPPER(game_type) = $1 AND (UPPER(level) = $2 OR UPPER(level) LIKE $3)`,
        [mode, categoryLevel, categoryLevel + '%'],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    const categoryDisplayName = categoryRow?.display_name || `${scheduled.mode} ${scheduled.category}`;

    // For relance_finale, get qualified players with their rankings
    if (emailType === 'relance_finale') {
      // Check that convocation has been sent before allowing relance finale
      const convocationSent = await new Promise((resolve, reject) => {
        db.get(
          `SELECT id, sent_at FROM email_campaigns
           WHERE campaign_type = 'finale_convocation'
           AND UPPER(mode) = $1
           AND (UPPER(category) = $2 OR UPPER(category) LIKE $3)
           AND status = 'completed'
           AND (test_mode = false OR test_mode IS NULL)
           ORDER BY sent_at DESC LIMIT 1`,
          [mode, categoryLevel, categoryLevel + '%'],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (!convocationSent) {
        console.log(`[Email Scheduler] Skipping relance_finale for ${mode} ${categoryLevel}: convocation not sent yet`);
        await new Promise((resolve) => {
          db.run(`UPDATE scheduled_emails SET status = 'failed', error_message = 'Convocation non envoyée' WHERE id = $1`, [scheduled.id], () => resolve());
        });
        return;
      }

      // Get current season
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth();
      const season = currentMonth >= 8 ? `${currentYear}-${currentYear + 1}` : `${currentYear - 1}-${currentYear}`;

      // Fetch ranked players
      const allRankings = await new Promise((resolve, reject) => {
        db.all(
          `SELECT r.*,
                  pc.id as contact_id, pc.first_name, pc.last_name, pc.email, pc.club,
                  COALESCE(pc.first_name || ' ' || pc.last_name, r.licence) as player_name
           FROM rankings r
           LEFT JOIN player_contacts pc ON REPLACE(r.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
           WHERE r.season = $1 AND r.category_id = $2
           ORDER BY r.rank_position ASC`,
          [season, categoryRow?.id],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      const qualifiedCount = allRankings.length < qualificationSettings.threshold
        ? qualificationSettings.small
        : qualificationSettings.large;
      recipients = allRankings.filter(r => r.rank_position <= qualifiedCount && r.email);

      // Fetch finale info from tournoi_ext if not in customData
      let finaleDate = customData.finale_date || '';
      let finaleLieu = customData.finale_lieu || '';

      if (!finaleDate || !finaleLieu) {
        const finale = await new Promise((resolve, reject) => {
          db.get(
            `SELECT * FROM tournoi_ext
             WHERE UPPER(mode) = $1
             AND (UPPER(categorie) = $2 OR UPPER(categorie) LIKE $3)
             AND debut >= $4
             ORDER BY debut ASC LIMIT 1`,
            [mode, categoryLevel, categoryLevel + '%', new Date().toISOString().split('T')[0]],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });

        if (finale) {
          if (!finaleDate && finale.debut) {
            finaleDate = new Date(finale.debut).toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
          }
          if (!finaleLieu && finale.lieu) {
            finaleLieu = finale.lieu;
          }
        }
      }

      // Auto-calculate deadline (7 days before finale) if not provided
      let deadlineDate = customData.deadline_date || '';
      if (!deadlineDate && finaleDate) {
        const finaleMatch = finaleDate.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
        if (finaleMatch) {
          const [_, day, month, year] = finaleMatch;
          const finaleDateTime = new Date(year, month - 1, day);
          finaleDateTime.setDate(finaleDateTime.getDate() - 7);
          deadlineDate = finaleDateTime.toLocaleDateString('fr-FR');
        }
      }

      templateVariables = {
        category: categoryDisplayName,
        qualified_count: qualifiedCount.toString(),
        finale_date: finaleDate,
        finale_lieu: finaleLieu,
        deadline_date: deadlineDate
      };
    } else {
      // For T2/T3 relances, get all contacts
      recipients = await new Promise((resolve, reject) => {
        db.all(
          `SELECT * FROM player_contacts WHERE email IS NOT NULL AND email LIKE '%@%'`,
          [],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      templateVariables = {
        category: categoryDisplayName,
        tournament_date: customData.tournament_date || '',
        tournament_lieu: customData.tournament_lieu || '',
        finale_date: customData.finale_date || '',
        finale_lieu: customData.finale_lieu || '',
        deadline_date: customData.deadline_date || ''
      };
    }

  } else if (emailType === 'tournament_results' && scheduled.tournament_id) {
    // Get tournament participants
    const tournament = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM tournaments WHERE id = $1`, [scheduled.tournament_id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!tournament) throw new Error('Tournament not found');

    const results = await new Promise((resolve, reject) => {
      db.all(
        `SELECT tr.*, pc.email, pc.first_name, pc.last_name
         FROM tournament_results tr
         LEFT JOIN player_contacts pc ON REPLACE(tr.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
         WHERE tr.tournament_id = $1`,
        [scheduled.tournament_id],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    recipients = results.filter(r => r.email && r.email.includes('@'));
    templateVariables = {
      tournament_name: tournament.display_name || tournament.name,
      tournament_date: tournament.tournament_date ? new Date(tournament.tournament_date).toLocaleDateString('fr-FR') : ''
    };

  } else if (emailType === 'finale_convocation' && scheduled.tournament_id) {
    // Get finale finalists - simplified version
    const finale = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM tournoi_ext WHERE tournoi_id = $1`, [scheduled.tournament_id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!finale) throw new Error('Finale not found');

    // Get contacts for this mode/category
    recipients = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM player_contacts WHERE email IS NOT NULL AND email LIKE '%@%'`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    templateVariables = {
      finale_date: finale.debut ? new Date(finale.debut).toLocaleDateString('fr-FR') : '',
      finale_lieu: finale.lieu || ''
    };
  }

  // Handle test mode - send only to test email
  const isTestMode = scheduled.test_mode === true || scheduled.test_mode === 1;
  if (isTestMode && scheduled.test_email) {
    console.log(`[Email Scheduler] TEST MODE - sending to ${scheduled.test_email} instead of ${recipients.length} recipients`);
    // Use a single fake recipient with test email
    recipients = [{
      email: scheduled.test_email,
      first_name: 'Test',
      last_name: 'User',
      club: 'Test Club'
    }];
  }

  if (recipients.length === 0) {
    console.log(`[Email Scheduler] No recipients for scheduled email ${scheduled.id}`);
    await new Promise((resolve) => {
      db.run(`UPDATE scheduled_emails SET status = 'completed', sent_at = CURRENT_TIMESTAMP WHERE id = $1`, [scheduled.id], () => resolve());
    });
    return;
  }

  console.log(`[Email Scheduler] Sending to ${recipients.length} recipients`);

  let sentCount = 0;
  let failedCount = 0;

  for (const recipient of recipients) {
    try {
      // Replace template variables
      let emailBody = (scheduled.body || '')
        .replace(/\{player_name\}/g, `${recipient.first_name || ''} ${recipient.last_name || ''}`.trim())
        .replace(/\{first_name\}/g, recipient.first_name || '')
        .replace(/\{last_name\}/g, recipient.last_name || '')
        .replace(/\{club\}/g, recipient.club || '')
        .replace(/\{category\}/g, templateVariables.category || '')
        .replace(/\{rank_position\}/g, recipient.rank_position?.toString() || '')
        .replace(/\{total_points\}/g, recipient.total_match_points?.toString() || '')
        .replace(/\{qualified_count\}/g, templateVariables.qualified_count || '')
        .replace(/\{tournament_date\}/g, templateVariables.tournament_date || '')
        .replace(/\{tournament_lieu\}/g, templateVariables.tournament_lieu || '')
        .replace(/\{finale_date\}/g, templateVariables.finale_date || '')
        .replace(/\{finale_lieu\}/g, templateVariables.finale_lieu || '')
        .replace(/\{deadline_date\}/g, templateVariables.deadline_date || '');

      let emailSubject = (scheduled.subject || '')
        .replace(/\{category\}/g, templateVariables.category || '')
        .replace(/\{tournament_date\}/g, templateVariables.tournament_date || '');

      const outroText = scheduled.outro_text || '';
      const imageHtml = scheduled.image_url ? `<div style="text-align: center; margin: 20px 0;"><img src="${scheduled.image_url}" alt="Image" style="max-width: 100%; height: auto; border-radius: 8px;"></div>` : '';

      const primaryColor = emailSettings.primary_color || '#1F4788';
      const senderName = emailSettings.email_sender_name || 'CDBHS';
      const senderEmail = emailSettings.email_communication || 'communication@cdbhs.net';
      const replyToEmail = emailSettings.summary_email || 'cdbhs92@gmail.com';
      const orgName = emailSettings.organization_name || 'Comité Départemental Billard Hauts-de-Seine';
      const orgShortName = emailSettings.organization_short_name || 'CDBHS';

      await resend.emails.send({
        from: `${senderName} <${senderEmail}>`,
        replyTo: replyToEmail,
        to: [recipient.email],
        cc: scheduled.cc_email ? [scheduled.cc_email] : undefined,
        subject: emailSubject,
        html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto;">
          <div style="background: ${primaryColor}; color: white; padding: 20px; text-align: center;">
            <img src="${baseUrl}/logo.png?v=${Date.now()}" alt="${orgShortName}" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
            <h1 style="margin: 0; font-size: 24px;">${orgName}</h1>
          </div>
          <div style="padding: 20px; background: #f8f9fa;">
            ${imageHtml}
            ${emailBody.replace(/\n/g, '<br>')}
            ${outroText ? `<br><br>${outroText.replace(/\n/g, '<br>')}` : ''}
          </div>
          <div style="background: ${primaryColor}; color: white; padding: 10px; text-align: center; font-size: 12px;">${orgShortName} - ${replyToEmail}</div>
        </div>`
      });

      sentCount++;
      await delay(1500);
    } catch (error) {
      console.error(`[Email Scheduler] Error sending to ${recipient.email}:`, error.message);
      failedCount++;
    }
  }

  // Update status
  await new Promise((resolve, reject) => {
    db.run(`UPDATE scheduled_emails SET status = 'completed', sent_at = CURRENT_TIMESTAMP WHERE id = $1`, [scheduled.id], function(err) {
      if (err) {
        console.error(`[Email Scheduler] Error updating status for ${scheduled.id}:`, err.message);
        reject(err);
      } else {
        console.log(`[Email Scheduler] Status updated to 'completed' for ${scheduled.id}, rows affected: ${this.changes}`);
        resolve();
      }
    });
  });

  // Create campaign record
  await new Promise((resolve) => {
    db.run(
      `INSERT INTO email_campaigns (subject, body, template_key, recipients_count, sent_count, failed_count, status, sent_at, campaign_type, mode, category, tournament_id, sent_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', CURRENT_TIMESTAMP, $7, $8, $9, $10, $11)`,
      [scheduled.subject, scheduled.body, scheduled.template_key, recipients.length, sentCount, failedCount, scheduled.email_type, scheduled.mode, scheduled.category, scheduled.tournament_id, scheduled.created_by || 'scheduled'],
      () => resolve()
    );
  });

  console.log(`[Email Scheduler] Completed ${scheduled.id}: ${sentCount} sent, ${failedCount} failed`);
}

// Tournament alerts - check for upcoming tournaments and notify opted-in users
async function checkTournamentAlerts() {
  const { Resend } = require('resend');
  const db = require('./db-loader');

  if (!process.env.RESEND_API_KEY) {
    console.log('[Tournament Alerts] Skipped - no RESEND_API_KEY');
    return;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  // Get dynamic settings for email branding
  const emailSettings = await appSettings.getSettingsBatch([
    'primary_color', 'email_convocations', 'email_sender_name',
    'organization_short_name'
  ]);

  try {
    console.log('[Tournament Alerts] Checking for upcoming tournaments...');

    // Get Paris time
    const now = new Date();
    const parisNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const currentHour = parisNow.getHours();

    // Only send alerts once per day, at 9 AM Paris time
    if (currentHour !== 9) {
      console.log(`[Tournament Alerts] Skipping - current hour is ${currentHour}, alerts sent at 9 AM`);
      return;
    }

    // Check if we already sent an alert today (prevent duplicates on server restart)
    const todayStart = new Date(parisNow);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(parisNow);
    todayEnd.setHours(23, 59, 59, 999);

    const lastAlertSent = await new Promise((resolve, reject) => {
      db.get(`
        SELECT sent_at FROM email_campaigns
        WHERE campaign_type = 'tournament_alert'
          AND sent_at >= $1 AND sent_at <= $2
        LIMIT 1
      `, [todayStart.toISOString(), todayEnd.toISOString()], (err, row) => {
        if (err) {
          console.error('[Tournament Alerts] Error checking last alert:', err);
          reject(err);
        } else {
          resolve(row);
        }
      });
    });

    if (lastAlertSent) {
      console.log(`[Tournament Alerts] Already sent today at ${lastAlertSent.sent_at}, skipping`);
      return;
    }

    console.log('[Tournament Alerts] No alert sent today, proceeding...');

    // Insert a placeholder record FIRST to prevent duplicate sends on concurrent restarts
    await new Promise((resolve) => {
      db.run(`
        INSERT INTO email_campaigns (subject, body, template_key, recipients_count, sent_count, failed_count, status, sent_at, campaign_type)
        VALUES ('Tournament Alert - Pending', 'Pending', 'tournament_alert', 0, 0, 0, 'pending', CURRENT_TIMESTAMP, 'tournament_alert')
      `, [], () => resolve());
    });

    const today = new Date();
    const twoWeeksFromNow = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);

    // Get upcoming tournaments that need relances
    const tournamentsNeeding = await new Promise((resolve, reject) => {
      db.all(`
        SELECT t.*
        FROM tournoi_ext t
        LEFT JOIN tournament_relances r ON t.tournoi_id = r.tournoi_id
        WHERE t.debut >= $1 AND t.debut <= $2 AND r.tournoi_id IS NULL
        ORDER BY t.debut ASC
      `, [today.toISOString().split('T')[0], twoWeeksFromNow.toISOString().split('T')[0]], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    if (tournamentsNeeding.length === 0) {
      console.log('[Tournament Alerts] No tournaments needing relances in the next 2 weeks');
      return;
    }

    console.log(`[Tournament Alerts] Found ${tournamentsNeeding.length} tournament(s) needing relances`);

    // Get users opted-in for alerts with valid email
    const usersToNotify = await new Promise((resolve, reject) => {
      db.all(`
        SELECT id, username, email FROM users
        WHERE receive_tournament_alerts = true AND email IS NOT NULL AND email != '' AND is_active = 1
      `, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    if (usersToNotify.length === 0) {
      console.log('[Tournament Alerts] No users opted-in for tournament alerts');
      return;
    }

    console.log(`[Tournament Alerts] Notifying ${usersToNotify.length} user(s)`);

    // Build tournament list HTML
    const tournamentListHtml = tournamentsNeeding.map(t => {
      const dateObj = new Date(t.debut);
      const dateStr = dateObj.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const daysLeft = Math.ceil((dateObj - new Date()) / (1000 * 60 * 60 * 24));
      const lieuStr = t.lieu ? ` - <span style="color: #17a2b8;">${t.lieu}</span>` : '';

      return `
        <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin-bottom: 10px; border-left: 4px solid #ffc107;">
          <strong style="color: #333;">${t.nom}</strong><br>
          <span style="color: #666;">${t.mode} ${t.categorie} - ${dateStr}${lieuStr}</span><br>
          <span style="color: ${daysLeft <= 7 ? '#dc3545' : '#856404'}; font-weight: bold;">
            Dans ${daysLeft} jour${daysLeft > 1 ? 's' : ''}
          </span>
        </div>
      `;
    }).join('');

    const baseUrl = process.env.BASE_URL || 'https://cdbhs-tournament-management-production.up.railway.app';

    // Send email to each opted-in user
    const primaryColor = emailSettings.primary_color || '#1F4788';
    const senderName = emailSettings.email_sender_name || 'CDBHS';
    const senderEmail = emailSettings.email_convocations || 'convocations@cdbhs.net';
    const orgShortName = emailSettings.organization_short_name || 'CDBHS';

    for (const user of usersToNotify) {
      try {
        await resend.emails.send({
          from: `${senderName} <${senderEmail}>`,
          to: user.email,
          subject: `⚠️ ${tournamentsNeeding.length} tournoi(s) à relancer - ${orgShortName}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="background: ${primaryColor}; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
                <h1 style="margin: 0; font-size: 24px;">Rappel Tournois ${orgShortName}</h1>
              </div>
              <div style="background: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px;">
                <p>Bonjour ${user.username},</p>
                <p>Les tournois suivants approchent et les <strong>relances n'ont pas encore été envoyées</strong> :</p>
                ${tournamentListHtml}
                <p style="margin-top: 20px;">
                  <a href="${baseUrl}/dashboard.html" style="background: #28a745; color: white; padding: 12px 25px; text-decoration: none; border-radius: 6px; display: inline-block;">
                    Accéder au tableau de bord
                  </a>
                </p>
                <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
                <p style="color: #666; font-size: 12px;">
                  Vous recevez cet email car vous avez activé les alertes de tournois dans vos paramètres.
                  <br>Pour vous désabonner, modifiez vos paramètres sur ${baseUrl}/settings.html
                </p>
              </div>
            </div>
          `
        });

        console.log(`[Tournament Alerts] Email sent to ${user.email}`);
      } catch (error) {
        console.error(`[Tournament Alerts] Error sending to ${user.email}:`, error.message);
      }
    }

    // Update the pending record to completed
    await new Promise((resolve) => {
      db.run(`
        UPDATE email_campaigns
        SET subject = $1, body = $2, recipients_count = $3, sent_count = $3, status = 'completed'
        WHERE campaign_type = 'tournament_alert' AND status = 'pending'
      `, [`Rappel Tournois - ${tournamentsNeeding.length} tournoi(s)`, 'Auto-generated tournament alert', usersToNotify.length], () => resolve());
    });

    console.log('[Tournament Alerts] Completed');

  } catch (error) {
    console.error('[Tournament Alerts] Error:', error.message);
  }
}

// Email scheduler - check and send scheduled emails
// Exposed globally for manual triggering via API
async function processScheduledEmails() {
  const { Resend } = require('resend');
  const db = require('./db-loader');

  console.log('[Email Scheduler] Starting processScheduledEmails...');

  if (!process.env.RESEND_API_KEY) {
    console.log('[Email Scheduler] No RESEND_API_KEY configured');
    return { status: 'error', message: 'No RESEND_API_KEY configured' };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // Get dynamic settings for email branding
  const emailSettings = await appSettings.getSettingsBatch([
    'primary_color', 'email_communication', 'email_sender_name',
    'organization_name', 'organization_short_name', 'summary_email'
  ]);

  try {
    // Get all pending emails
    const allPending = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM scheduled_emails WHERE status = 'pending'`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    console.log(`[Email Scheduler] Found ${allPending.length} pending email(s)`);

    if (allPending.length === 0) {
      return { status: 'ok', message: 'No pending emails', pending: 0, due: 0, processed: 0 };
    }

    // Get current Paris time
    const now = new Date();
    const parisNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    console.log(`[Email Scheduler] Paris time: ${parisNow.toLocaleString('fr-FR')}`);

    // Filter emails that are due (scheduled_at <= now Paris time)
    const scheduledEmails = allPending.filter(email => {
      // Handle scheduled_at as Date object or string
      let scheduledDate;
      if (email.scheduled_at instanceof Date) {
        scheduledDate = email.scheduled_at;
      } else if (typeof email.scheduled_at === 'string') {
        const scheduledStr = email.scheduled_at.replace('Z', '').replace('.000', '');
        scheduledDate = new Date(scheduledStr);
      } else {
        console.log(`[Email Scheduler] Email ${email.id}: invalid scheduled_at type: ${typeof email.scheduled_at}`);
        return false;
      }
      const isDue = scheduledDate <= parisNow;
      console.log(`[Email Scheduler] Email ${email.id}: scheduled=${scheduledDate.toLocaleString('fr-FR')}, now=${parisNow.toLocaleString('fr-FR')}, isDue=${isDue}`);
      return isDue;
    });

    if (scheduledEmails.length === 0) {
      console.log('[Email Scheduler] No emails due yet');
      return { status: 'ok', message: 'No emails due yet', pending: allPending.length, due: 0, processed: 0 };
    }

    console.log(`[Email Scheduler] Processing ${scheduledEmails.length} scheduled email(s)`);

    for (const scheduled of scheduledEmails) {
      const isTestMode = scheduled.test_mode === true || scheduled.test_mode === 1;

      // Check if this email type was already sent manually (block if so) - but NOT for test mode
      if (scheduled.email_type && !isTestMode) {
        const alreadySent = await checkIfAlreadySentManually(
          db,
          scheduled.email_type,
          scheduled.mode,
          scheduled.category,
          scheduled.tournament_id
        );

        if (alreadySent) {
          // Block this scheduled email
          await new Promise((resolve) => {
            db.run(
              `UPDATE scheduled_emails SET status = 'blocked' WHERE id = $1`,
              [scheduled.id],
              () => resolve()
            );
          });
          console.log(`[Email Scheduler] Blocked scheduled email ${scheduled.id} (${scheduled.email_type}) - already manually sent`);
          continue;
        }
      }

      const recipientIds = JSON.parse(scheduled.recipient_ids || '[]');

      // For templated emails (relance, results, finale), recipients need to be fetched dynamically
      if (scheduled.email_type && recipientIds.length === 0) {
        try {
          await processTemplatedScheduledEmail(db, resend, scheduled, delay);
        } catch (error) {
          console.error(`[Email Scheduler] Error processing templated email ${scheduled.id}:`, error.message);
          await new Promise((resolve) => {
            db.run(`UPDATE scheduled_emails SET status = 'failed' WHERE id = $1`, [scheduled.id], () => resolve());
          });
        }
        continue;
      }

      // Get recipients for custom emails
      const placeholders = recipientIds.map((_, i) => `$${i + 1}`).join(',');
      const recipients = await new Promise((resolve, reject) => {
        db.all(
          `SELECT * FROM player_contacts WHERE id IN (${placeholders})`,
          recipientIds,
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      let sentCount = 0;

      for (const recipient of recipients) {
        if (!recipient.email || !recipient.email.includes('@')) continue;

        try {
          const emailBody = scheduled.body
            .replace(/\{player_name\}/g, `${recipient.first_name} ${recipient.last_name}`)
            .replace(/\{first_name\}/g, recipient.first_name || '')
            .replace(/\{last_name\}/g, recipient.last_name || '')
            .replace(/\{club\}/g, recipient.club || '');

          const emailSubject = scheduled.subject
            .replace(/\{player_name\}/g, `${recipient.first_name} ${recipient.last_name}`)
            .replace(/\{first_name\}/g, recipient.first_name || '')
            .replace(/\{last_name\}/g, recipient.last_name || '');

          // Build optional image HTML
          const imageHtml = scheduled.image_url ? `<div style="text-align: center; margin: 20px 0;"><img src="${scheduled.image_url}" alt="Image" style="max-width: 100%; height: auto; border-radius: 8px;"></div>` : '';

          const primaryColor = emailSettings.primary_color || '#1F4788';
          const senderName = emailSettings.email_sender_name || 'CDBHS';
          const senderEmail = emailSettings.email_communication || 'communication@cdbhs.net';
          const orgName = emailSettings.organization_name || 'Comite Departemental Billard Hauts-de-Seine';
          const orgShortName = emailSettings.organization_short_name || 'CDBHS';
          const replyToEmail = emailSettings.summary_email || 'cdbhs92@gmail.com';

          await resend.emails.send({
            from: `${senderName} <${senderEmail}>`,
            to: [recipient.email],
            subject: emailSubject,
            html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto;">
              <div style="background: ${primaryColor}; color: white; padding: 20px; text-align: center;">
                <img src="${baseUrl}/logo.png?v=${Date.now()}" alt="${orgShortName}" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
                <h1 style="margin: 0; font-size: 24px;">${orgName}</h1>
              </div>
              <div style="padding: 20px; background: #f8f9fa;">${imageHtml}${emailBody.replace(/\n/g, '<br>')}</div>
              <div style="background: ${primaryColor}; color: white; padding: 10px; text-align: center; font-size: 12px;">${orgShortName} - ${replyToEmail}</div>
            </div>`
          });

          sentCount++;
          await delay(1500);
        } catch (error) {
          console.error(`[Email Scheduler] Error sending to ${recipient.email}:`, error.message);
        }
      }

      // Update scheduled email status
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE scheduled_emails SET status = 'completed', sent_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [scheduled.id],
          function(err) {
            if (err) {
              console.error(`[Email Scheduler] Error updating status for ${scheduled.id}:`, err.message);
              reject(err);
            } else {
              console.log(`[Email Scheduler] Status updated to 'completed' for ${scheduled.id}, rows affected: ${this.changes}`);
              resolve();
            }
          }
        );
      });

      console.log(`[Email Scheduler] Sent ${sentCount}/${recipientIds.length} emails for scheduled ID ${scheduled.id}`);
    }

    return { status: 'ok', message: `Processed ${scheduledEmails.length} email(s)`, pending: allPending.length, due: scheduledEmails.length, processed: scheduledEmails.length };

  } catch (error) {
    console.error('[Email Scheduler] Error:', error.message, error.stack);
    return { status: 'error', message: error.message, stack: error.stack };
  }
}

// Expose for manual triggering via API
global.processScheduledEmails = processScheduledEmails;

// Start server
app.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const networkInterfaces = os.networkInterfaces();
  let localIP = 'localhost';

  // Find the local network IP
  for (const interfaceName in networkInterfaces) {
    for (const iface of networkInterfaces[interfaceName]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        break;
      }
    }
  }

  console.log(`
╔════════════════════════════════════════════╗
║  French Billiard Ranking System           ║
║  Server running on:                       ║
║  - Local: http://localhost:${PORT}            ║
║  - Network: http://${localIP}:${PORT}${' '.repeat(Math.max(0, 10 - localIP.length))} ║
╚════════════════════════════════════════════╝
  `);

  // Start email scheduler - check every 5 minutes and process any past-due emails
  setInterval(async () => {
    await processScheduledEmails();
  }, 300000); // Check every 5 minutes (300000ms)
  console.log('[Email Scheduler] Started - checking for scheduled emails every 5 minutes');

  // Also run once immediately on startup (after 30 seconds to let DB settle)
  setTimeout(() => processScheduledEmails(), 30000);

  // Tournament alerts scheduler - check every hour for upcoming tournaments
  setInterval(async () => {
    await checkTournamentAlerts();
  }, 3600000); // Check every hour (3600000ms)
  console.log('[Tournament Alerts] Started - checking for upcoming tournaments every hour');

  // Also run tournament alerts check on startup (after 60 seconds)
  setTimeout(() => checkTournamentAlerts(), 60000);

  // Auto-sync contacts on startup (after a short delay to ensure DB is ready)
  setTimeout(async () => {
    try {
      const { syncContacts } = require('./routes/emailing');
      await syncContacts();
      console.log('[Contacts] Auto-sync completed on startup');
    } catch (error) {
      console.error('[Contacts] Auto-sync failed:', error.message);
    }
  }, 5000);
});

module.exports = app;
