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
 * Load game modes with rank_column mapping from database
 * Returns array of { code, display_name, rank_column }
 */
async function loadGameModes() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT code, display_name, rank_column FROM game_modes WHERE rank_column IS NOT NULL AND is_active = true ORDER BY display_order`,
      [],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

/**
 * GET /api/player-accounts
 * List player accounts with player info
 * Optional query params:
 * - search: Filter by name, licence, or email (min 2 chars required)
 */
router.get('/', (req, res) => {
  const { search } = req.query;

  // If no search query, return empty array (require search to list accounts)
  if (!search || search.trim().length < 2) {
    return res.json([]);
  }

  const searchTerm = `%${search.trim()}%`;

  const query = `
    SELECT pa.id, pa.licence, pa.email, pa.is_admin, pa.email_verified,
           pa.created_at, pa.last_login,
           CONCAT(p.first_name, ' ', p.last_name) as player_name,
           p.club
    FROM player_accounts pa
    LEFT JOIN players p ON REPLACE(pa.licence, ' ', '') = REPLACE(p.licence, ' ', '')
    WHERE UPPER(pa.licence) LIKE UPPER($1)
       OR UPPER(pa.email) LIKE UPPER($1)
       OR UPPER(CONCAT(p.first_name, ' ', p.last_name)) LIKE UPPER($1)
    ORDER BY pa.created_at DESC
    LIMIT 20
  `;

  db.all(query, [searchTerm], (err, rows) => {
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

/**
 * GET /api/player-accounts/:licence/calendar.ics
 * Generate iCalendar file with tournaments for player's eligible categories
 */
router.get('/:licence/calendar.ics', async (req, res) => {
  const { licence } = req.params;
  const normalizedLicence = (licence || '').replace(/\s+/g, '');

  try {
    // Load game modes with rank_column mapping
    const gameModes = await loadGameModes();

    // Build dynamic SELECT for rank columns
    const rankColumns = gameModes.map(gm => gm.rank_column).filter(Boolean);
    const rankColumnsSQL = rankColumns.length > 0 ? ', ' + rankColumns.join(', ') : '';

    // Get player info and their moyennes dynamically
    const player = await new Promise((resolve, reject) => {
      db.get(`
        SELECT licence, first_name, last_name${rankColumnsSQL}
        FROM players
        WHERE REPLACE(licence, ' ', '') = $1
      `, [normalizedLicence], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!player) {
      return res.status(404).json({ error: 'Joueur non trouvé' });
    }

    // Build eligible categories directly from player's rank values
    // The player's category for a game mode IS their rank value (R3, R4, N3, etc.)
    const eligibleCategories = [];
    for (const gm of gameModes) {
      if (gm.rank_column && player[gm.rank_column]) {
        const rankValue = player[gm.rank_column];
        // Skip NC (not classified) or empty values
        if (rankValue && rankValue.toUpperCase() !== 'NC') {
          eligibleCategories.push({
            mode: gm.display_name, // Use display_name to match tournament.mode
            categorie: rankValue.toUpperCase()
          });
        }
      }
    }

    if (eligibleCategories.length === 0) {
      return res.status(404).json({ error: 'Aucune catégorie éligible trouvée' });
    }

    // Get current season (but only future tournaments from today)
    const now = new Date();
    const today = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const currentYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
    const seasonEnd = `${currentYear + 1}-08-31`;

    // Build query for eligible tournaments (only future ones)
    const categoryConditions = eligibleCategories.map((_, i) =>
      `(UPPER(REPLACE(mode, ' ', '')) = UPPER(REPLACE($${i * 2 + 3}, ' ', '')) AND UPPER(categorie) = UPPER($${i * 2 + 4}))`
    ).join(' OR ');

    const queryParams = [today, seasonEnd];
    eligibleCategories.forEach(cat => {
      queryParams.push(cat.mode, cat.categorie);
    });

    const tournaments = await new Promise((resolve, reject) => {
      db.all(`
        SELECT tournoi_id, nom, mode, categorie, debut, lieu
        FROM tournoi_ext
        WHERE debut >= $1 AND debut <= $2
          AND (${categoryConditions})
        ORDER BY debut ASC
      `, queryParams, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Generate iCalendar content
    const playerName = `${player.first_name} ${player.last_name}`;
    const icsContent = generateICalendar(tournaments, playerName, eligibleCategories);

    // Set headers for file download
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="CDBHS_${normalizedLicence}.ics"`);
    res.send(icsContent);

  } catch (error) {
    console.error('Error generating calendar:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Generate iCalendar format content
 */
function generateICalendar(tournaments, playerName, eligibleCategories) {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  let ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CDBHS//Calendrier Tournois//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:CDBHS - Tournois ${playerName}`,
    'X-WR-TIMEZONE:Europe/Paris'
  ];

  // Add timezone definition
  ics.push(
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Paris',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE'
  );

  // Add events for each tournament
  for (const tournament of tournaments) {
    const eventDate = new Date(tournament.debut);
    const dateStr = eventDate.toISOString().split('T')[0].replace(/-/g, '');
    const uid = `tournament-${tournament.tournoi_id}@cdbhs.net`;

    // Determine if it's a finale
    const isFinale = (tournament.nom || '').toLowerCase().includes('finale');
    const title = isFinale
      ? `🏆 FINALE ${tournament.mode} ${tournament.categorie}`
      : `${tournament.nom} - ${tournament.mode} ${tournament.categorie}`;

    const location = tournament.lieu || 'Lieu à confirmer';
    const description = `Tournoi CDBHS\\n${tournament.mode} - ${tournament.categorie}\\nLieu: ${location}`;

    ics.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${timestamp}`,
      `DTSTART;VALUE=DATE:${dateStr}`,
      `DTEND;VALUE=DATE:${dateStr}`,
      `SUMMARY:${escapeIcsText(title)}`,
      `DESCRIPTION:${escapeIcsText(description)}`,
      `LOCATION:${escapeIcsText(location)}`,
      'TRANSP:OPAQUE',
      'END:VEVENT'
    );
  }

  ics.push('END:VCALENDAR');
  return ics.join('\r\n');
}

/**
 * Escape special characters for iCalendar format
 */
function escapeIcsText(text) {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * GET /api/player-accounts/tournament/:id/calendar.ics
 * Generate iCalendar file for a single tournament
 * Public endpoint - no auth required
 */
router.get('/tournament/:id/calendar.ics', async (req, res) => {
  const { id } = req.params;

  try {
    // Get tournament info
    const tournament = await new Promise((resolve, reject) => {
      db.get(`
        SELECT tournoi_id, nom, mode, categorie, debut, lieu
        FROM tournoi_ext
        WHERE tournoi_id = $1
      `, [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!tournament) {
      return res.status(404).json({ error: 'Tournoi non trouvé' });
    }

    // Generate single-event iCalendar
    const icsContent = generateSingleTournamentICS(tournament);

    // Set headers for file download
    const safeName = (tournament.nom || 'tournoi').replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="CDBHS_${safeName}.ics"`);
    res.send(icsContent);

  } catch (error) {
    console.error('Error generating single tournament calendar:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Generate iCalendar for a single tournament
 */
function generateSingleTournamentICS(tournament) {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  const eventDate = new Date(tournament.debut);
  const dateStr = eventDate.toISOString().split('T')[0].replace(/-/g, '');
  const uid = `tournament-${tournament.tournoi_id}@cdbhs.net`;

  // Determine if it's a finale
  const isFinale = (tournament.nom || '').toLowerCase().includes('finale');
  const title = isFinale
    ? `🏆 FINALE ${tournament.mode} ${tournament.categorie}`
    : `${tournament.nom} - ${tournament.mode} ${tournament.categorie}`;

  const location = tournament.lieu || 'Lieu à confirmer';
  const description = `Tournoi CDBHS\\n${tournament.mode} - ${tournament.categorie}\\nLieu: ${location}`;

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CDBHS//Calendrier Tournois//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(title)}`,
    'X-WR-TIMEZONE:Europe/Paris',
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Paris',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${timestamp}`,
    `DTSTART;VALUE=DATE:${dateStr}`,
    `DTEND;VALUE=DATE:${dateStr}`,
    `SUMMARY:${escapeIcsText(title)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    `LOCATION:${escapeIcsText(location)}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR'
  ];

  return ics.join('\r\n');
}

/**
 * GET /api/player-accounts/convocation/:inscriptionId/calendar.ics
 * Generate iCalendar file for a convocation (with specific time and location)
 * Public endpoint - no auth required
 */
router.get('/convocation/:inscriptionId/calendar.ics', async (req, res) => {
  const { inscriptionId } = req.params;

  try {
    // Get inscription with convocation details and tournament info
    const inscription = await new Promise((resolve, reject) => {
      db.get(`
        SELECT i.inscription_id, i.licence, i.convocation_poule, i.convocation_lieu,
               i.convocation_adresse, i.convocation_heure, i.convocation_notes,
               t.tournoi_id, t.nom, t.mode, t.categorie, t.debut, t.lieu,
               p.first_name, p.last_name
        FROM inscriptions i
        JOIN tournoi_ext t ON i.tournoi_id = t.tournoi_id
        LEFT JOIN players p ON REPLACE(i.licence, ' ', '') = REPLACE(p.licence, ' ', '')
        WHERE i.inscription_id = $1
      `, [inscriptionId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!inscription) {
      return res.status(404).json({ error: 'Convocation non trouvée' });
    }

    // Generate single-event iCalendar with convocation details
    const icsContent = generateConvocationICS(inscription);

    // Set headers for file download
    const safeName = (inscription.nom || 'convocation').replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="CDBHS_Convocation_${safeName}.ics"`);
    res.send(icsContent);

  } catch (error) {
    console.error('Error generating convocation calendar:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Generate iCalendar for a convocation (with time and specific location)
 */
function generateConvocationICS(inscription) {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  const eventDate = new Date(inscription.debut);
  const uid = `convocation-${inscription.inscription_id}@cdbhs.net`;

  // Determine if it's a finale
  const isFinale = (inscription.nom || '').toLowerCase().includes('finale');
  const title = isFinale
    ? `🏆 FINALE ${inscription.mode} ${inscription.categorie}`
    : `${inscription.nom} - ${inscription.mode} ${inscription.categorie}`;

  // Use convocation location if available, otherwise tournament location
  const location = inscription.convocation_lieu || inscription.lieu || 'Lieu à confirmer';
  const address = inscription.convocation_adresse || '';
  const fullLocation = address ? `${location}, ${address}` : location;

  // Build description with convocation details
  let descriptionParts = [
    `Tournoi CDBHS`,
    `${inscription.mode} - ${inscription.categorie}`
  ];

  if (inscription.convocation_poule) {
    descriptionParts.push(`Poule: ${inscription.convocation_poule}`);
  }
  descriptionParts.push(`Lieu: ${fullLocation}`);
  if (inscription.convocation_notes) {
    descriptionParts.push(`Note: ${inscription.convocation_notes}`);
  }

  const description = descriptionParts.join('\\n');

  // Handle time if available
  let dtStart, dtEnd;
  if (inscription.convocation_heure) {
    // Parse time (format: "HH:MM" or "HH:MM:SS")
    const [hours, minutes] = inscription.convocation_heure.split(':').map(Number);
    eventDate.setHours(hours, minutes, 0);

    // Format as local time with timezone
    const dateStr = eventDate.toISOString().split('T')[0].replace(/-/g, '');
    const timeStr = `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}00`;
    dtStart = `DTSTART;TZID=Europe/Paris:${dateStr}T${timeStr}`;

    // End time: assume 6 hours for a tournament
    const endDate = new Date(eventDate);
    endDate.setHours(endDate.getHours() + 6);
    const endDateStr = endDate.toISOString().split('T')[0].replace(/-/g, '');
    const endTimeStr = `${String(endDate.getHours()).padStart(2, '0')}${String(endDate.getMinutes()).padStart(2, '0')}00`;
    dtEnd = `DTEND;TZID=Europe/Paris:${endDateStr}T${endTimeStr}`;
  } else {
    // All-day event
    const dateStr = eventDate.toISOString().split('T')[0].replace(/-/g, '');
    dtStart = `DTSTART;VALUE=DATE:${dateStr}`;
    dtEnd = `DTEND;VALUE=DATE:${dateStr}`;
  }

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CDBHS//Convocation Tournoi//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(title)}`,
    'X-WR-TIMEZONE:Europe/Paris',
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Paris',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${timestamp}`,
    dtStart,
    dtEnd,
    `SUMMARY:${escapeIcsText(title)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    `LOCATION:${escapeIcsText(fullLocation)}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR'
  ];

  return ics.join('\r\n');
}

module.exports = router;
