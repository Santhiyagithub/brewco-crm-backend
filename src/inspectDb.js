import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

// Resolve database file path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '../data/crm.db');

// Connect to SQLite
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('❌ Failed to open database:', err.message);
    process.exit(1);
  }
});

// Helper to query all rows
const allQuery = (sql) => {
  return new Promise((resolve, reject) => {
    db.all(sql, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const inspect = async () => {
  console.log('===================================================');
  console.log('       ☕ BREWCO CRM DATABASE INSPECTOR ☕        ');
  console.log('===================================================\n');

  try {
    // 1. Show SQLite Tables
    console.log('📂 SQLite Database Tables:');
    const tables = await allQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    tables.forEach((t) => console.log(`  - ${t.name}`));
    console.log('');

    // 2. Count Records
    const [{ count: custCount }] = await allQuery('SELECT COUNT(*) as count FROM customers');
    const [{ count: ordCount }] = await allQuery('SELECT COUNT(*) as count FROM orders');
    const [{ count: campCount }] = await allQuery('SELECT COUNT(*) as count FROM campaigns');
    const [{ count: delCount }] = await allQuery('SELECT COUNT(*) as count FROM deliveries');
    const [{ count: jobCount }] = await allQuery('SELECT COUNT(*) as count FROM queue_jobs');

    console.log('📊 Record Counts:');
    console.log(`  - Customers: ${custCount}`);
    console.log(`  - Orders: ${ordCount}`);
    console.log(`  - Campaigns: ${campCount}`);
    console.log(`  - Deliveries: ${delCount}`);
    console.log(`  - Queue Jobs: ${jobCount}`);
    console.log('');

    // 3. Show a preview of VIP Customers
    console.log('💎 Top 3 VIP Spenders (Spends > ₹5,000):');
    const vips = await allQuery('SELECT name, total_spent, order_count FROM customers WHERE total_spent > 5000 ORDER BY total_spent DESC LIMIT 3');
    vips.forEach((v) => console.log(`  - ${v.name}: Total Spent: ₹${v.total_spent.toLocaleString('en-IN')}, Orders: ${v.order_count}`));
    console.log('');

    // 4. Show a preview of Campaigns
    console.log('📣 Recent Campaigns Launched:');
    const campaigns = await allQuery('SELECT name, channel, sent_count, revenue_generated FROM campaigns ORDER BY id DESC LIMIT 2');
    if (campaigns.length === 0) {
      console.log('  - No campaigns run yet.');
    } else {
      campaigns.forEach((c) => console.log(`  - "${c.name}" via ${c.channel} | Sent: ${c.sent_count} | Revenue: ₹${c.revenue_generated.toLocaleString('en-IN')}`));
    }

  } catch (err) {
    console.error('❌ Error inspecting database:', err.message);
  } finally {
    db.close();
    console.log('\n===================================================');
  }
};

inspect();
