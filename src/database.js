import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

// --- RESOLVING DATABASE STORAGE PATH ---
// We resolve the database file path dynamically. If running in a container with a persistent volume 
// mounted at /app/data (like in a cloud deployment), we store the SQLite file there.
// Otherwise, we default to the local backend/data directory for standard development environments.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = fs.existsSync('/app/data') 
  ? '/app/data/crm.db' 
  : path.join(__dirname, '../data/crm.db');

// Ensure that the target folder exists where the SQLite file will live.
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// --- DATABASE ARCHITECTURE SELECTION ---
// SQLite is selected because it is a lightweight, embedded SQL database that runs serverless 
// and stores relational data in a single file. This simplifies setup and local testing.
// In a large-scale production setup, we would migrate this to PostgreSQL to handle 
// concurrent connections and transaction scaling.
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Database connection failed:', err.message);
  } else {
    console.log(`Connected successfully to SQLite database at: ${DB_PATH}`);
  }
});

/**
 * Executes a SQL query that doesn't return rows (like CREATE, INSERT, UPDATE, DELETE).
 * Wrapped in a Promise to support modern async/await flow.
 */
export const runQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        console.error(`Error executing runQuery: ${sql}`, err);
        reject(err);
      } else {
        // 'this' refers to the statement object. 
        // this.lastID contains the ID of the last inserted row.
        // this.changes contains the number of rows affected.
        resolve({ id: this.lastID, changes: this.changes });
      }
    });
  });
};

/**
 * Retrieves all rows matching a query (SELECT * ...).
 * Wrapped in a Promise for async/await compliance.
 */
export const allQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        console.error(`Error executing allQuery: ${sql}`, err);
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
};

/**
 * Retrieves a single row matching a query (SELECT LIMIT 1 ...).
 * Useful for checking existence or getting single records by ID.
 */
export const getQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        console.error(`Error executing getQuery: ${sql}`, err);
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
};

/**
 * Initializes tables if they do not exist, and seeds mock data.
 * This ensures the application starts with a fully populated and functional dashboard immediately.
 */
export const initDatabase = async () => {
  // 1. Create Customers Table
  // Storing core profile data, along with cached total spent and order counts for segmentation efficiency.
  await runQuery(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL UNIQUE,
      total_spent REAL DEFAULT 0,
      order_count INTEGER DEFAULT 0,
      last_purchase_date TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. Create Orders Table
  // Retaining purchase histories. Includes category to allow segmentation based on interests (e.g. coffee vs fashion).
  await runQuery(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      amount REAL NOT NULL,
      category TEXT NOT NULL, -- e.g. 'Coffee', 'Fashion', 'Beauty'
      purchase_date TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    )
  `);

  // 3. Create Campaigns Table
  // Stores campaign metadata and summarizes logs (sent, delivered, opened, clicked, purchased counts).
  await runQuery(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      channel TEXT NOT NULL, -- 'Email', 'SMS', 'WhatsApp', 'RCS'
      message_template TEXT NOT NULL,
      sent_count INTEGER DEFAULT 0,
      delivered_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      opened_count INTEGER DEFAULT 0,
      read_count INTEGER DEFAULT 0,
      clicked_count INTEGER DEFAULT 0,
      purchased_count INTEGER DEFAULT 0,
      revenue_generated REAL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 4. Create Deliveries Table
  // Log status of each dispatch to a customer. This represents the granular campaign logs.
  // Crucial for capturing the callback status flows (Sent -> Delivered -> Read -> Clicked -> Purchased).
  await runQuery(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER,
      customer_id INTEGER,
      recipient_address TEXT NOT NULL, -- Email, Phone, etc.
      message_content TEXT NOT NULL,
      status TEXT DEFAULT 'sent', -- 'sent', 'delivered', 'failed', 'opened', 'read', 'clicked', 'purchased'
      error_message TEXT,
      last_updated TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    )
  `);

  // 5. Create Queue Jobs Table
  // This is used for async task queue management, retries, and rate limiting execution.
  // Failures and attempts are logged here to demonstrate proper system reliability.
  await runQuery(`
    CREATE TABLE IF NOT EXISTS queue_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL, -- JSON string containing campaign_id, customer_id, channel, target, message
      attempts INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
      error_message TEXT,
      run_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed Customer Data if empty
  const customerCount = await getQuery('SELECT COUNT(*) as count FROM customers');
  if (customerCount.count === 0) {
    console.log('Database empty. Seeding 120+ mock customers and 500+ orders...');

    // Lists of names to construct unique customer names
    const firstNames = [
      'John', 'Jane', 'Alice', 'Bob', 'Charlie', 'David', 'Emma', 'Frank', 'Grace', 'Henry',
      'Isabella', 'Jack', 'Kate', 'Liam', 'Mia', 'Noah', 'Olivia', 'Peter', 'Quinn', 'Ryan',
      'Sophia', 'Thomas', 'Ursula', 'Victor', 'Wendy', 'Xavier', 'Yara', 'Zachary'
    ];
    const lastNames = [
      'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Garcia', 'Rodriguez', 'Wilson',
      'Martinez', 'Anderson', 'Taylor', 'Thomas', 'Hernandez', 'Moore', 'Martin', 'Jackson', 'Thompson', 'White'
    ];

    // Create unique customer list
    const generatedCustomers = [];
    let count = 0;
    // Generate up to 120 unique combinations
    for (let i = 0; i < firstNames.length; i++) {
      for (let j = 0; j < lastNames.length; j++) {
        if (count >= 120) break;
        const name = `${firstNames[i]} ${lastNames[j]}`;
        const email = `${firstNames[i].toLowerCase()}.${lastNames[j].toLowerCase()}@example.com`;
        const phone = `+9198765${String(count).padStart(5, '0')}`;
        generatedCustomers.push({ name, email, phone });
        count++;
      }
      if (count >= 120) break;
    }

    // Insert customers into table
    for (const c of generatedCustomers) {
      await runQuery(
        `INSERT INTO customers (name, email, phone, total_spent, order_count, last_purchase_date) 
         VALUES (?, ?, ?, 0, 0, NULL)`,
        [c.name, c.email, c.phone]
      );
    }

    // Fetch the inserted IDs from sqlite
    const seededCustomers = await allQuery('SELECT id FROM customers');

    // Categories and purchase amounts parameters
    const categories = ['Coffee', 'Fashion', 'Beauty'];
    
    // Seed 550 random orders spread over the last 90 days
    console.log('Generating 550 orders distributed across customers...');
    for (let o = 0; o < 550; o++) {
      // Pick a random customer
      const randomCust = seededCustomers[Math.floor(Math.random() * seededCustomers.length)];
      // Pick a random category
      const category = categories[Math.floor(Math.random() * categories.length)];
      
      // Determine amount based on category type
      let amount = 300;
      if (category === 'Coffee') {
        amount = Math.floor(Math.random() * 400) + 100; // ₹100 - ₹500
      } else if (category === 'Fashion') {
        amount = Math.floor(Math.random() * 3500) + 800; // ₹800 - ₹4300
      } else if (category === 'Beauty') {
        amount = Math.floor(Math.random() * 2000) + 500; // ₹500 - ₹2500
      }

      // Generate random date within the last 90 days
      const daysAgo = Math.floor(Math.random() * 90);
      
      await runQuery(
        `INSERT INTO orders (customer_id, amount, category, purchase_date) 
         VALUES (?, ?, ?, date('now', '-${daysAgo} days'))`,
        [randomCust.id, amount, category]
      );
    }

    // Recalculate customer cached aggregates: spent sum, counts, and last purchase date.
    // This is clean, sets the records correctly, and avoids manual aggregate loops.
    console.log('Recalculating customer profiles with order aggregates...');
    await runQuery(`
      UPDATE customers 
      SET total_spent = (
        SELECT COALESCE(SUM(amount), 0) FROM orders WHERE orders.customer_id = customers.id
      ),
      order_count = (
        SELECT COUNT(*) FROM orders WHERE orders.customer_id = customers.id
      ),
      last_purchase_date = (
        SELECT MAX(purchase_date) FROM orders WHERE orders.customer_id = customers.id
      )
    `);

    console.log('Database successfully seeded with 120 customers and 550 orders.');
  }
};


export default db;
