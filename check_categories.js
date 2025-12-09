const { Client } = require('pg');

const sourceUrl = 'postgresql://postgres:imyOAwfvMchJdhoVJKIjUSyoWMxWyXzb@yamabiko.proxy.rlwy.net:18777/railway';
const targetUrl = 'postgresql://postgres:eGsXbbgEflZpXUpTnbaDUbtBsjWzkhdT@metro.proxy.rlwy.net:57331/railway';

async function checkCategories() {
  const source = new Client({ connectionString: sourceUrl });
  const target = new Client({ connectionString: targetUrl });
  
  try {
    await source.connect();
    await target.connect();
    
    console.log('=== CATEGORIES dans SOURCE ===');
    const srcCat = await source.query('SELECT id, game_type, level, display_name FROM categories ORDER BY id');
    srcCat.rows.forEach(r => console.log(`  ${r.id}: ${r.display_name}`));
    
    console.log('\n=== CATEGORIES dans TARGET ===');
    const tgtCat = await target.query('SELECT id, game_type, level, display_name FROM categories ORDER BY id');
    tgtCat.rows.forEach(r => console.log(`  ${r.id}: ${r.display_name}`));
    
    console.log('\n=== RANKINGS par category_id (SOURCE) ===');
    const srcRank = await source.query('SELECT category_id, COUNT(*) as count FROM rankings GROUP BY category_id ORDER BY category_id');
    srcRank.rows.forEach(r => console.log(`  category_id ${r.category_id}: ${r.count} rankings`));
    
    console.log('\n=== RANKINGS par category_id (TARGET) ===');
    const tgtRank = await target.query('SELECT category_id, COUNT(*) as count FROM rankings GROUP BY category_id ORDER BY category_id');
    tgtRank.rows.forEach(r => console.log(`  category_id ${r.category_id}: ${r.count} rankings`));
    
  } finally {
    await source.end();
    await target.end();
  }
}

checkCategories();
