const express = require('express');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Helper to get current season
function getCurrentSeason() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  // Season runs Sept-June
  if (month >= 8) {
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
}

// Get available seasons
router.get('/seasons', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  db.all(
    `SELECT DISTINCT season FROM tournaments ORDER BY season DESC`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching seasons:', err);
        return res.status(500).json({ error: err.message });
      }
      const seasons = (rows || []).map(r => r.season);
      // Add current season if not in list
      const currentSeason = getCurrentSeason();
      if (!seasons.includes(currentSeason)) {
        seasons.unshift(currentSeason);
      }
      res.json(seasons);
    }
  );
});

// Get available categories for dropdowns
router.get('/categories', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season } = req.query;
  const targetSeason = season || getCurrentSeason();

  const query = `
    SELECT DISTINCT
      c.id,
      c.display_name,
      c.game_type,
      c.level
    FROM categories c
    JOIN tournaments t ON t.category_id = c.id
    WHERE t.season = $1
    ORDER BY c.game_type, c.level
  `;

  db.all(query, [targetSeason], (err, rows) => {
    if (err) {
      console.error('Error fetching categories:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

// ==================== CLUB STATISTICS ====================

// Get club rankings by wins (position = 1) per game mode
router.get('/clubs/wins', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season } = req.query;
  const targetSeason = season || getCurrentSeason();

  const query = `
    SELECT
      p.club,
      c.game_type,
      COUNT(*) as wins
    FROM tournament_results tr
    JOIN tournaments t ON tr.tournament_id = t.id
    JOIN categories c ON t.category_id = c.id
    JOIN players p ON REPLACE(tr.licence, ' ', '') = REPLACE(p.licence, ' ', '')
    WHERE t.season = $1
      AND tr.position = 1
      AND p.club IS NOT NULL AND p.club != ''
    GROUP BY p.club, c.game_type
    ORDER BY c.game_type, wins DESC
  `;

  db.all(query, [targetSeason], (err, rows) => {
    if (err) {
      console.error('Error fetching club wins:', err);
      return res.status(500).json({ error: err.message });
    }

    // Group by game_type
    const result = {};
    (rows || []).forEach(row => {
      if (!result[row.game_type]) {
        result[row.game_type] = [];
      }
      result[row.game_type].push({
        club: row.club,
        wins: row.wins
      });
    });

    res.json(result);
  });
});

// Get club rankings by podiums (position <= 3) per game mode
router.get('/clubs/podiums', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season } = req.query;
  const targetSeason = season || getCurrentSeason();

  const query = `
    SELECT
      COALESCE(ca.canonical_name, p.club) as club,
      c.game_type,
      SUM(CASE WHEN tr.position = '1' THEN 1 ELSE 0 END) as gold,
      SUM(CASE WHEN tr.position = '2' THEN 1 ELSE 0 END) as silver,
      SUM(CASE WHEN tr.position = '3' THEN 1 ELSE 0 END) as bronze,
      SUM(CASE WHEN tr.position IN ('1', '2', '3') THEN 1 ELSE 0 END) as podiums
    FROM tournament_results tr
    JOIN tournaments t ON tr.tournament_id = t.id
    JOIN categories c ON t.category_id = c.id
    JOIN players p ON REPLACE(tr.licence, ' ', '') = REPLACE(p.licence, ' ', '')
    LEFT JOIN club_aliases ca ON UPPER(REPLACE(REPLACE(REPLACE(p.club, ' ', ''), '.', ''), '-', ''))
                                = UPPER(REPLACE(REPLACE(REPLACE(ca.alias, ' ', ''), '.', ''), '-', ''))
    WHERE t.season = $1
      AND tr.position IN ('1', '2', '3')
      AND p.club IS NOT NULL AND p.club != ''
    GROUP BY COALESCE(ca.canonical_name, p.club), c.game_type
    ORDER BY c.game_type, podiums DESC
  `;

  db.all(query, [targetSeason], (err, rows) => {
    if (err) {
      console.error('Error fetching club podiums:', err);
      return res.status(500).json({ error: err.message });
    }

    // Group by game_type
    const result = {};
    (rows || []).forEach(row => {
      if (!result[row.game_type]) {
        result[row.game_type] = [];
      }
      result[row.game_type].push({
        club: row.club,
        podiums: row.podiums,
        gold: row.gold,
        silver: row.silver,
        bronze: row.bronze
      });
    });

    res.json(result);
  });
});

// Get most active clubs (total participations)
router.get('/clubs/participations', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season } = req.query;
  const targetSeason = season || getCurrentSeason();

  const query = `
    SELECT
      COALESCE(ca.canonical_name, p.club) as club,
      COUNT(DISTINCT tr.licence) as unique_players,
      COUNT(*) as total_participations
    FROM tournament_results tr
    JOIN tournaments t ON tr.tournament_id = t.id
    JOIN players p ON REPLACE(tr.licence, ' ', '') = REPLACE(p.licence, ' ', '')
    LEFT JOIN club_aliases ca ON UPPER(REPLACE(REPLACE(REPLACE(p.club, ' ', ''), '.', ''), '-', ''))
                                = UPPER(REPLACE(REPLACE(REPLACE(ca.alias, ' ', ''), '.', ''), '-', ''))
    WHERE t.season = $1
      AND p.club IS NOT NULL AND p.club != ''
    GROUP BY COALESCE(ca.canonical_name, p.club)
    ORDER BY total_participations DESC
    LIMIT 10
  `;

  db.all(query, [targetSeason], (err, rows) => {
    if (err) {
      console.error('Error fetching club participations:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

// Get best average moyenne by club per game mode
router.get('/clubs/moyenne', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season } = req.query;
  const targetSeason = season || getCurrentSeason();

  const query = `
    SELECT
      p.club,
      c.game_type,
      AVG(tr.moyenne) as avg_moyenne,
      COUNT(*) as participations
    FROM tournament_results tr
    JOIN tournaments t ON tr.tournament_id = t.id
    JOIN categories c ON t.category_id = c.id
    JOIN players p ON REPLACE(tr.licence, ' ', '') = REPLACE(p.licence, ' ', '')
    WHERE t.season = $1
      AND p.club IS NOT NULL AND p.club != ''
      AND tr.moyenne > 0
    GROUP BY p.club, c.game_type
    HAVING COUNT(*) >= 3
    ORDER BY c.game_type, avg_moyenne DESC
  `;

  db.all(query, [targetSeason], (err, rows) => {
    if (err) {
      console.error('Error fetching club moyenne:', err);
      return res.status(500).json({ error: err.message });
    }

    // Group by game_type
    const result = {};
    (rows || []).forEach(row => {
      if (!result[row.game_type]) {
        result[row.game_type] = [];
      }
      result[row.game_type].push({
        club: row.club,
        avg_moyenne: parseFloat(row.avg_moyenne.toFixed(3)),
        participations: row.participations
      });
    });

    res.json(result);
  });
});

// ==================== PLAYER STATISTICS ====================

// Get most active players
router.get('/players/active', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season, limit } = req.query;
  const targetSeason = season || getCurrentSeason();
  const resultLimit = parseInt(limit) || 10;

  const query = `
    SELECT
      tr.licence,
      COALESCE(p.first_name || ' ' || p.last_name, tr.player_name) as player_name,
      p.club,
      COUNT(*) as competitions,
      COUNT(DISTINCT c.game_type) as game_types_played
    FROM tournament_results tr
    JOIN tournaments t ON tr.tournament_id = t.id
    JOIN categories c ON t.category_id = c.id
    LEFT JOIN players p ON REPLACE(tr.licence, ' ', '') = REPLACE(p.licence, ' ', '')
    WHERE t.season = $1
    GROUP BY tr.licence, COALESCE(p.first_name || ' ' || p.last_name, tr.player_name), p.club
    ORDER BY competitions DESC
    LIMIT $2
  `;

  db.all(query, [targetSeason, resultLimit], (err, rows) => {
    if (err) {
      console.error('Error fetching active players:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

// Get players with most wins by category
router.get('/players/wins', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season, category_id } = req.query;
  const targetSeason = season || getCurrentSeason();

  if (category_id) {
    const query = `
      SELECT
        tr.licence,
        COALESCE(p.first_name || ' ' || p.last_name, tr.player_name) as player_name,
        p.club,
        c.display_name as category,
        COUNT(*) as wins
      FROM tournament_results tr
      JOIN tournaments t ON tr.tournament_id = t.id
      JOIN categories c ON t.category_id = c.id
      LEFT JOIN players p ON REPLACE(tr.licence, ' ', '') = REPLACE(p.licence, ' ', '')
      WHERE t.season = $1 AND CAST(tr.position AS INTEGER) = 1 AND c.id = $2
      GROUP BY tr.licence, COALESCE(p.first_name || ' ' || p.last_name, tr.player_name), p.club, c.display_name
      ORDER BY wins DESC
      LIMIT 10
    `;

    db.all(query, [targetSeason, category_id], (err, rows) => {
      if (err) {
        console.error('Error fetching player wins:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows || []);
    });
  } else {
    res.json([]);
  }
});

// Get players with best moyenne by category
router.get('/players/moyenne', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season, category_id } = req.query;
  const targetSeason = season || getCurrentSeason();

  // If category_id is provided, filter by specific category
  if (category_id) {
    const query = `
      SELECT
        tr.licence,
        COALESCE(p.first_name || ' ' || p.last_name, tr.player_name) as player_name,
        p.club,
        c.display_name as category,
        AVG(tr.moyenne) as avg_moyenne,
        MAX(tr.moyenne) as best_moyenne,
        COUNT(*) as tournaments
      FROM tournament_results tr
      JOIN tournaments t ON tr.tournament_id = t.id
      JOIN categories c ON t.category_id = c.id
      LEFT JOIN players p ON REPLACE(tr.licence, ' ', '') = REPLACE(p.licence, ' ', '')
      WHERE t.season = $1 AND tr.moyenne > 0 AND c.id = $2
      GROUP BY tr.licence, COALESCE(p.first_name || ' ' || p.last_name, tr.player_name), p.club, c.display_name
      ORDER BY avg_moyenne DESC
      LIMIT 10
    `;

    db.all(query, [targetSeason, category_id], (err, rows) => {
      if (err) {
        console.error('Error fetching player moyenne:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json((rows || []).map(row => ({
        licence: row.licence,
        player_name: row.player_name,
        club: row.club,
        category: row.category,
        avg_moyenne: parseFloat(row.avg_moyenne.toFixed(3)),
        best_moyenne: parseFloat(row.best_moyenne.toFixed(3)),
        tournaments: row.tournaments
      })));
    });
  } else {
    // Return empty if no category selected
    res.json([]);
  }
});

// Get players with best serie by category
router.get('/players/serie', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season, category_id } = req.query;
  const targetSeason = season || getCurrentSeason();

  // If category_id is provided, filter by specific category
  if (category_id) {
    const query = `
      SELECT
        tr.licence,
        COALESCE(p.first_name || ' ' || p.last_name, tr.player_name) as player_name,
        p.club,
        c.display_name as category,
        MAX(tr.serie) as best_serie,
        t.tournament_number
      FROM tournament_results tr
      JOIN tournaments t ON tr.tournament_id = t.id
      JOIN categories c ON t.category_id = c.id
      LEFT JOIN players p ON REPLACE(tr.licence, ' ', '') = REPLACE(p.licence, ' ', '')
      WHERE t.season = $1 AND tr.serie > 0 AND c.id = $2
      GROUP BY tr.licence, COALESCE(p.first_name || ' ' || p.last_name, tr.player_name), p.club, c.display_name, t.tournament_number
      ORDER BY best_serie DESC
      LIMIT 10
    `;

    db.all(query, [targetSeason, category_id], (err, rows) => {
      if (err) {
        console.error('Error fetching player serie:', err);
        return res.status(500).json({ error: err.message });
      }

      // Remove duplicates (keep best serie per player)
      const seen = new Set();
      const result = [];
      (rows || []).forEach(row => {
        if (!seen.has(row.licence)) {
          seen.add(row.licence);
          result.push({
            licence: row.licence,
            player_name: row.player_name,
            club: row.club,
            category: row.category,
            best_serie: row.best_serie,
            tournament: `T${row.tournament_number}`
          });
        }
      });

      res.json(result);
    });
  } else {
    // Return empty if no category selected
    res.json([]);
  }
});

// Get most consistent players (played all 3 tournaments in a category)
router.get('/players/consistent', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season } = req.query;
  const targetSeason = season || getCurrentSeason();

  const query = `
    SELECT
      tr.licence,
      COALESCE(p.first_name || ' ' || p.last_name, tr.player_name) as player_name,
      p.club,
      c.display_name as category,
      c.game_type,
      COUNT(DISTINCT t.tournament_number) as tournaments_in_category,
      AVG(tr.position) as avg_position
    FROM tournament_results tr
    JOIN tournaments t ON tr.tournament_id = t.id
    JOIN categories c ON t.category_id = c.id
    LEFT JOIN players p ON REPLACE(tr.licence, ' ', '') = REPLACE(p.licence, ' ', '')
    WHERE t.season = $1
    GROUP BY tr.licence, COALESCE(p.first_name || ' ' || p.last_name, tr.player_name), p.club, c.id, c.display_name, c.game_type
    HAVING COUNT(DISTINCT t.tournament_number) = 3
    ORDER BY avg_position ASC
  `;

  db.all(query, [targetSeason], (err, rows) => {
    if (err) {
      console.error('Error fetching consistent players:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

// Get players with best progression (T1 to T3)
router.get('/players/progression', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season } = req.query;
  const targetSeason = season || getCurrentSeason();

  const query = `
    WITH player_tournaments AS (
      SELECT
        tr.licence,
        COALESCE(p.first_name || ' ' || p.last_name, tr.player_name) as player_name,
        p.club,
        c.display_name as category,
        c.game_type,
        t.tournament_number,
        tr.position,
        tr.moyenne
      FROM tournament_results tr
      JOIN tournaments t ON tr.tournament_id = t.id
      JOIN categories c ON t.category_id = c.id
      LEFT JOIN players p ON REPLACE(tr.licence, ' ', '') = REPLACE(p.licence, ' ', '')
      WHERE t.season = $1
    ),
    progression AS (
      SELECT
        pt1.licence,
        pt1.player_name,
        pt1.club,
        pt1.category,
        pt1.game_type,
        pt1.position as t1_position,
        pt3.position as t3_position,
        pt1.position - pt3.position as position_improvement,
        pt3.moyenne - pt1.moyenne as moyenne_improvement
      FROM player_tournaments pt1
      JOIN player_tournaments pt3 ON pt1.licence = pt3.licence
        AND pt1.category = pt3.category
        AND pt1.tournament_number = 1
        AND pt3.tournament_number = 3
    )
    SELECT * FROM progression
    WHERE position_improvement > 0
    ORDER BY position_improvement DESC, moyenne_improvement DESC
    LIMIT 10
  `;

  db.all(query, [targetSeason], (err, rows) => {
    if (err) {
      console.error('Error fetching player progression:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

// ==================== GENERAL STATISTICS ====================

// Get participation stats (inscriptions vs actual participation)
router.get('/general/participation', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season } = req.query;
  const targetSeason = season || getCurrentSeason();

  // Get season date range
  const [startYear] = targetSeason.split('-');
  const seasonStart = `${startYear}-09-01`;
  const seasonEnd = `${parseInt(startYear) + 1}-06-30`;

  const query = `
    SELECT
      te.mode as game_type,
      COUNT(DISTINCT i.inscription_id) as total_inscriptions,
      SUM(CASE WHEN i.forfait = 1 THEN 1 ELSE 0 END) as forfaits,
      SUM(CASE WHEN i.forfait = 0 OR i.forfait IS NULL THEN 1 ELSE 0 END) as participated
    FROM inscriptions i
    JOIN tournoi_ext te ON i.tournoi_id = te.tournoi_id
    WHERE te.debut >= $1 AND te.debut <= $2
    GROUP BY te.mode
    ORDER BY te.mode
  `;

  db.all(query, [seasonStart, seasonEnd], (err, rows) => {
    if (err) {
      console.error('Error fetching participation stats:', err);
      return res.status(500).json({ error: err.message });
    }

    const result = (rows || []).map(row => ({
      game_type: row.game_type,
      total_inscriptions: row.total_inscriptions,
      forfaits: row.forfaits,
      participated: row.participated,
      forfait_rate: row.total_inscriptions > 0
        ? ((row.forfaits / row.total_inscriptions) * 100).toFixed(1) + '%'
        : '0%'
    }));

    res.json(result);
  });
});

// Get participants per category
router.get('/general/categories', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season } = req.query;
  const targetSeason = season || getCurrentSeason();

  const query = `
    SELECT
      c.display_name as category,
      c.game_type,
      c.level,
      COUNT(DISTINCT tr.licence) as unique_players,
      COUNT(*) as total_participations,
      COUNT(DISTINCT t.id) as tournaments_played
    FROM tournament_results tr
    JOIN tournaments t ON tr.tournament_id = t.id
    JOIN categories c ON t.category_id = c.id
    WHERE t.season = $1
    GROUP BY c.id, c.display_name, c.game_type, c.level
    ORDER BY c.game_type, unique_players DESC
  `;

  db.all(query, [targetSeason], (err, rows) => {
    if (err) {
      console.error('Error fetching category stats:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

// Get tournaments by location
router.get('/general/locations', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season } = req.query;
  const targetSeason = season || getCurrentSeason();

  const query = `
    SELECT
      t.location,
      COUNT(DISTINCT t.id) as tournaments_hosted,
      COUNT(tr.id) as total_participants
    FROM tournaments t
    LEFT JOIN tournament_results tr ON t.id = tr.tournament_id
    WHERE t.season = $1 AND t.location IS NOT NULL AND t.location != ''
    GROUP BY t.location
    ORDER BY tournaments_hosted DESC
  `;

  db.all(query, [targetSeason], (err, rows) => {
    if (err) {
      console.error('Error fetching location stats:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

// Get summary stats for dashboard
router.get('/summary', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season } = req.query;
  const targetSeason = season || getCurrentSeason();

  const queries = {
    totalTournaments: `
      SELECT COUNT(DISTINCT id) as count FROM tournaments WHERE season = $1
    `,
    totalPlayers: `
      SELECT COUNT(DISTINCT licence) as count FROM tournament_results tr
      JOIN tournaments t ON tr.tournament_id = t.id WHERE t.season = $1
    `,
    totalParticipations: `
      SELECT COUNT(*) as count FROM tournament_results tr
      JOIN tournaments t ON tr.tournament_id = t.id WHERE t.season = $1
    `
  };

  try {
    const results = {};

    for (const [key, query] of Object.entries(queries)) {
      const row = await new Promise((resolve, reject) => {
        db.get(query, [targetSeason], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      results[key] = row?.count || 0;
    }

    res.json(results);
  } catch (error) {
    console.error('Error fetching summary stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get new players this season (first time playing)
router.get('/players/new', authenticateToken, async (req, res) => {
  const db = require('../db-loader');
  const { season } = req.query;
  const targetSeason = season || getCurrentSeason();

  const query = `
    WITH first_appearance AS (
      SELECT
        tr.licence,
        MIN(t.season) as first_season
      FROM tournament_results tr
      JOIN tournaments t ON tr.tournament_id = t.id
      GROUP BY tr.licence
    )
    SELECT
      tr.licence,
      COALESCE(p.first_name || ' ' || p.last_name, tr.player_name) as player_name,
      p.club,
      COUNT(*) as tournaments_played
    FROM tournament_results tr
    JOIN tournaments t ON tr.tournament_id = t.id
    JOIN first_appearance fa ON tr.licence = fa.licence
    LEFT JOIN players p ON REPLACE(tr.licence, ' ', '') = REPLACE(p.licence, ' ', '')
    WHERE t.season = $1 AND fa.first_season = $1
    GROUP BY tr.licence, COALESCE(p.first_name || ' ' || p.last_name, tr.player_name), p.club
    ORDER BY tournaments_played DESC
    LIMIT 20
  `;

  db.all(query, [targetSeason], (err, rows) => {
    if (err) {
      console.error('Error fetching new players:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

// Get veteran players (most seasons played)
router.get('/players/veterans', authenticateToken, async (req, res) => {
  const db = require('../db-loader');

  const query = `
    SELECT
      tr.licence,
      COALESCE(p.first_name || ' ' || p.last_name, MAX(tr.player_name)) as player_name,
      p.club,
      COUNT(DISTINCT t.season) as seasons_played,
      MIN(t.season) as first_season,
      MAX(t.season) as last_season
    FROM tournament_results tr
    JOIN tournaments t ON tr.tournament_id = t.id
    LEFT JOIN players p ON REPLACE(tr.licence, ' ', '') = REPLACE(p.licence, ' ', '')
    GROUP BY tr.licence, p.first_name, p.last_name, p.club
    ORDER BY seasons_played DESC
    LIMIT 20
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error fetching veteran players:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

module.exports = router;
