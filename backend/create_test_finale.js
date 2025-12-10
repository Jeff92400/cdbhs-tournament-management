const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://postgres:imyOAwfvMchJdhoVJKIjUSyoWMxWyXzb@crossover.proxy.rlwy.net:47072/railway'
});

async function createTestFinales() {
  try {
    await client.connect();
    
    // Create test finales
    const result = await client.query(`
      INSERT INTO tournoi_ext (tournoi_id, nom, mode, categorie, debut, fin, lieu, taille)
      VALUES 
        (99901, 'Finale Départementale', 'LIBRE', 'R2', '2025-12-15', '2025-12-15', 'Courbevoie', 280),
        (99902, 'Finale Départementale', 'CADRE', 'R3', '2025-12-20', '2025-12-20', 'Clichy', 280)
      ON CONFLICT (tournoi_id) DO UPDATE SET
        nom = EXCLUDED.nom,
        mode = EXCLUDED.mode,
        categorie = EXCLUDED.categorie,
        debut = EXCLUDED.debut
      RETURNING *;
    `);
    
    console.log('Test finales created:', result.rows);
    
    // Get some active players to create inscriptions
    const players = await client.query(`
      SELECT licence FROM players WHERE is_active = true LIMIT 6
    `);
    
    console.log('Found players:', players.rows.length);
    
    // Create inscriptions for the first finale
    for (let i = 0; i < players.rows.length; i++) {
      const p = players.rows[i];
      try {
        await client.query(`
          INSERT INTO inscriptions (tournoi_id, licence, email, convoque, forfait, timestamp)
          VALUES (99901, $1, 'jeff_rallet@hotmail.com', 1, 0, NOW())
          ON CONFLICT DO NOTHING
        `, [p.licence]);
      } catch (e) {
        // Ignore duplicate errors
      }
    }
    
    console.log('Test inscriptions created for finale 99901');
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await client.end();
  }
}

createTestFinales();
