const { Client } = require('pg');

const targetUrl = 'postgresql://postgres:eGsXbbgEflZpXUpTnbaDUbtBsjWzkhdT@metro.proxy.rlwy.net:57331/railway';

async function checkPlayers() {
  const client = new Client({ connectionString: targetUrl });
  
  try {
    await client.connect();
    
    // Check players count
    const players = await client.query('SELECT COUNT(*) as count FROM players');
    console.log('Joueurs dans TARGET:', players.rows[0].count);
    
    // Check if rankings have matching players
    const orphanRankings = await client.query(`
      SELECT r.licence, r.category_id 
      FROM rankings r 
      LEFT JOIN players p ON r.licence = p.licence 
      WHERE p.licence IS NULL 
      LIMIT 10
    `);
    console.log('Rankings orphelins (sans joueur):', orphanRankings.rows.length);
    if (orphanRankings.rows.length > 0) {
      console.log('Exemples:', orphanRankings.rows);
    }
    
    // Check one specific ranking for category 11
    const sample = await client.query(`
      SELECT r.*, p.first_name, p.last_name 
      FROM rankings r 
      LEFT JOIN players p ON r.licence = p.licence 
      WHERE r.category_id = 11 
      LIMIT 3
    `);
    console.log('\nExemple rankings category 11:');
    sample.rows.forEach(r => console.log(`  ${r.licence}: ${r.first_name} ${r.last_name} - rank ${r.rank_position}`));
    
  } finally {
    await client.end();
  }
}

checkPlayers();
