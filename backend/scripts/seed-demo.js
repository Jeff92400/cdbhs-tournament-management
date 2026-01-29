/**
 * Demo Data Seed Script
 *
 * Populates the database with fictional demo data for training purposes.
 * Run with: node backend/scripts/seed-demo.js
 *
 * WARNING: This will add demo data to the target database!
 */

const bcrypt = require('bcrypt');

// Get database connection
const db = require('../db-loader');

// Demo configuration
const DEMO_ADMIN = {
  username: 'demo',
  password: 'demo123',
  email: 'demo@example.com',
  role: 'admin'
};

// Sample clubs
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

// Sample player names (fictional)
const FIRST_NAMES = [
  'Jean', 'Pierre', 'Michel', 'Philippe', 'Alain', 'Bernard', 'Jacques', 'Daniel',
  'Patrick', 'Serge', 'Christian', 'Claude', 'Marc', 'Laurent', 'Stephane', 'Thierry',
  'Francois', 'Eric', 'Pascal', 'Olivier', 'Nicolas', 'David', 'Christophe', 'Didier',
  'Bruno', 'Robert', 'Gilles', 'Andre', 'Gerard', 'Yves', 'Paul', 'Henri',
  'Marie', 'Isabelle', 'Catherine', 'Nathalie', 'Sophie', 'Sandrine', 'Valerie', 'Christine'
];

const LAST_NAMES = [
  'MARTIN', 'BERNARD', 'THOMAS', 'PETIT', 'ROBERT', 'RICHARD', 'DURAND', 'DUBOIS',
  'MOREAU', 'LAURENT', 'SIMON', 'MICHEL', 'LEFEBVRE', 'LEROY', 'ROUX', 'DAVID',
  'BERTRAND', 'MOREL', 'FOURNIER', 'GIRARD', 'BONNET', 'DUPONT', 'LAMBERT', 'FONTAINE',
  'ROUSSEAU', 'VINCENT', 'MULLER', 'LEFEVRE', 'FAURE', 'ANDRE', 'MERCIER', 'BLANC'
];

// FFB ranking levels
const FFB_RANKINGS = ['N1', 'N2', 'N3', 'R1', 'R2', 'R3', 'R4', 'D1', 'D2', 'D3'];

// Helper functions
function randomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateLicence(index) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const num = String(100000 + index).slice(1);
  return `D${num}${letters[index % letters.length]}`;
}

// Get current season
function getCurrentSeason() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  return month >= 8 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

// Promise wrapper for db.run
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// Promise wrapper for db.get
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Promise wrapper for db.all
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

// Main seed function
async function seedDemoData() {
  console.log('='.repeat(60));
  console.log('DEMO DATA SEED SCRIPT');
  console.log('='.repeat(60));
  console.log('');

  const season = getCurrentSeason();
  console.log(`Current season: ${season}`);
  console.log('');

  try {
    // 1. Create demo admin user
    console.log('1. Creating demo admin user...');
    const hashedPassword = await bcrypt.hash(DEMO_ADMIN.password, 10);

    // Check if demo user exists
    const existingUser = await dbGet(`SELECT id FROM users WHERE username = $1`, [DEMO_ADMIN.username]);

    if (existingUser) {
      await dbRun(`UPDATE users SET password_hash = $1, email = $2, role = $3, is_active = 1 WHERE username = $4`,
        [hashedPassword, DEMO_ADMIN.email, DEMO_ADMIN.role, DEMO_ADMIN.username]);
      console.log(`   Updated existing admin: ${DEMO_ADMIN.username}`);
    } else {
      await dbRun(
        `INSERT INTO users (username, password_hash, email, role, is_active) VALUES ($1, $2, $3, $4, 1)`,
        [DEMO_ADMIN.username, hashedPassword, DEMO_ADMIN.email, DEMO_ADMIN.role]
      );
      console.log(`   Created admin: ${DEMO_ADMIN.username} / ${DEMO_ADMIN.password}`);
    }
    console.log('');

    // 2. Create clubs
    console.log('2. Creating demo clubs...');
    let clubsCreated = 0;

    for (const club of DEMO_CLUBS) {
      const existing = await dbGet(`SELECT id FROM clubs WHERE name = $1`, [club.name]);
      if (!existing) {
        await dbRun(
          `INSERT INTO clubs (name, display_name, city) VALUES ($1, $2, $3)`,
          [club.name, club.display_name, club.city]
        );
        clubsCreated++;
      }
    }
    console.log(`   Created ${clubsCreated} new clubs (${DEMO_CLUBS.length - clubsCreated} already existed)`);
    console.log('');

    // 3. Create demo players
    console.log('3. Creating demo players...');
    const players = [];
    const usedNames = new Set();

    // Check existing demo players
    const existingPlayers = await dbAll(`SELECT licence FROM players WHERE licence LIKE 'D%'`);
    const existingLicences = new Set(existingPlayers.map(p => p.licence));

    for (let i = 0; i < 80; i++) {
      let firstName, lastName, fullName;
      do {
        firstName = randomElement(FIRST_NAMES);
        lastName = randomElement(LAST_NAMES);
        fullName = `${firstName} ${lastName}`;
      } while (usedNames.has(fullName));
      usedNames.add(fullName);

      const club = randomElement(DEMO_CLUBS);
      const licence = generateLicence(i);

      // Skip if player already exists
      if (existingLicences.has(licence)) continue;

      players.push({
        licence,
        first_name: firstName,
        last_name: lastName,
        club: club.name,
        rank_libre: randomElement(FFB_RANKINGS),
        rank_cadre: randomElement(FFB_RANKINGS),
        rank_bande: randomElement(FFB_RANKINGS),
        rank_3bandes: randomElement(FFB_RANKINGS),
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@demo.com`
      });
    }

    for (const p of players) {
      await dbRun(
        `INSERT INTO players (licence, first_name, last_name, club, rank_libre, rank_cadre, rank_bande, rank_3bandes, email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [p.licence, p.first_name, p.last_name, p.club, p.rank_libre, p.rank_cadre, p.rank_bande, p.rank_3bandes, p.email]
      );
    }
    console.log(`   Created ${players.length} new players`);
    console.log('');

    // 4. Create demo tournaments (external)
    console.log('4. Creating demo tournaments...');

    const tournaments = [];
    const now = new Date();

    // Get max tournoi_id
    const maxIdResult = await dbGet(`SELECT COALESCE(MAX(tournoi_id), 0) as max_id FROM tournoi_ext`);
    let tournoiId = (maxIdResult?.max_id || 0) + 1;

    // Create T1, T2, T3 for each mode/category combination
    // Use Title Case to match game_modes.display_name
    for (const mode of ['Libre', 'Bande', '3 Bandes']) {
      for (const categorie of ['N3', 'R1', 'R2']) {
        const locations = DEMO_CLUBS.map(c => c.city);

        // T1 - 2 months ago
        const t1Date = new Date(now);
        t1Date.setMonth(t1Date.getMonth() - 2);
        t1Date.setDate(randomInt(1, 28));

        // T2 - 1 month ago
        const t2Date = new Date(now);
        t2Date.setMonth(t2Date.getMonth() - 1);
        t2Date.setDate(randomInt(1, 28));

        // T3 - in 2 weeks
        const t3Date = new Date(now);
        t3Date.setDate(t3Date.getDate() + randomInt(10, 20));

        const tournamentSet = [
          { nom: `Tournoi 1 ${mode} ${categorie}`, date: t1Date },
          { nom: `Tournoi 2 ${mode} ${categorie}`, date: t2Date },
          { nom: `Tournoi 3 ${mode} ${categorie}`, date: t3Date }
        ];

        for (const t of tournamentSet) {
          tournaments.push({
            tournoi_id: tournoiId++,
            nom: t.nom,
            mode,
            categorie,
            debut: t.date.toISOString().split('T')[0],
            lieu: randomElement(locations)
          });
        }
      }
    }

    for (const t of tournaments) {
      await dbRun(
        `INSERT INTO tournoi_ext (tournoi_id, nom, mode, categorie, debut, lieu)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [t.tournoi_id, t.nom, t.mode, t.categorie, t.debut, t.lieu]
      );
    }
    console.log(`   Created ${tournaments.length} tournaments`);
    console.log('');

    // 5. Create demo inscriptions
    console.log('5. Creating demo inscriptions...');
    let inscriptionCount = 0;

    // Get all players for inscriptions
    const allPlayers = await dbAll(`SELECT licence, first_name, last_name, club, email FROM players WHERE licence LIKE 'D%'`);

    for (const tournament of tournaments) {
      // Select random players for this tournament
      const numInscriptions = randomInt(8, 16);
      const shuffled = [...allPlayers].sort(() => Math.random() - 0.5);
      const selected = shuffled.slice(0, Math.min(numInscriptions, shuffled.length));

      for (const player of selected) {
        // Check if inscription exists
        const existing = await dbGet(
          `SELECT inscription_id FROM inscriptions WHERE tournoi_id = $1 AND licence = $2`,
          [tournament.tournoi_id, player.licence]
        );

        if (!existing) {
          // Get next inscription_id
          const maxInscId = await dbGet(`SELECT COALESCE(MAX(inscription_id), 0) as max_id FROM inscriptions`);
          const inscriptionId = (maxInscId?.max_id || 0) + 1;

          await dbRun(
            `INSERT INTO inscriptions (inscription_id, tournoi_id, licence, email, source, timestamp)
             VALUES ($1, $2, $3, $4, 'demo', CURRENT_TIMESTAMP)`,
            [inscriptionId, tournament.tournoi_id, player.licence, player.email]
          );
          inscriptionCount++;
        }
      }
    }
    console.log(`   Created ${inscriptionCount} inscriptions`);
    console.log('');

    // 6. Summary
    console.log('='.repeat(60));
    console.log('DEMO DATA SEED COMPLETE');
    console.log('='.repeat(60));
    console.log('');
    console.log('Summary:');
    console.log(`  - Admin account: ${DEMO_ADMIN.username} / ${DEMO_ADMIN.password}`);
    console.log(`  - Clubs: ${DEMO_CLUBS.length}`);
    console.log(`  - Players: ${players.length} new`);
    console.log(`  - Tournaments: ${tournaments.length}`);
    console.log(`  - Inscriptions: ${inscriptionCount}`);
    console.log('');
    console.log('The demo environment is ready for training!');
    console.log('');

  } catch (error) {
    console.error('Error seeding demo data:', error);
    process.exit(1);
  }

  process.exit(0);
}

// Run the seed
seedDemoData();
