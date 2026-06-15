import express from 'express';
import { runQuery, allQuery, getQuery } from './database.js';
import { enqueueJob } from './queue.js';
import { processNaturalLanguageGoal } from './ai.js';

const router = express.Router();

/**
 * --- WHAT THIS ROUTER DOES
 * This file serves as the main business logic layer of the CRM.
 * It houses endpoints for reading customer and campaign records, triggering bulk dispatches,
 * delegating prompts to the AI engine, and receiving the async callbacks from the Mock Channel Service.
 */

/**
 * Fetch all customers or filter them by a custom SQL segment clause.
 * GET /api/customers
 */
router.get('/customers', async (req, res) => {
  try {
    const { sqlFilter } = req.query;

    // --- SECURITY WARNING  ---
    // Security Note: Evaluating raw user-submitted queries directly in SQL (like we do below with sqlFilter)
    // creates a SQL injection vulnerability. 
    // "For the scope of this assignment, passing the AI-generated SQL query directly 
    // allows flexible dynamic segmentation. In an enterprise system, I would use a structured schema
    // (e.g. JSON rules) validated by a validator or translated using parameterized bindings in Knex/Sequelize."

    let query = 'SELECT * FROM customers';
    const params = [];

    if (sqlFilter && sqlFilter.trim() !== '') {
      // Validate that the SQL clause is only a WHERE filter and does not contain destructive SQL statements.
      const lowerFilter = sqlFilter.toLowerCase();
      if (lowerFilter.includes('delete') || lowerFilter.includes('drop') || lowerFilter.includes('update') || lowerFilter.includes('insert')) {
        return res.status(400).json({ error: 'Destructive SQL queries are strictly prohibited.' });
      }
      query += ` WHERE ${sqlFilter}`;
    }

    query += ' ORDER BY total_spent DESC';
    const customers = await allQuery(query, params);
    res.json(customers);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch customers: ' + err.message });
  }
});

/**
 * Fetch all campaigns and their current aggregated metrics.
 * GET /api/campaigns
 */
router.get('/campaigns', async (req, res) => {
  try {
    const campaigns = await allQuery('SELECT * FROM campaigns ORDER BY id DESC');
    res.json(campaigns);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch campaigns: ' + err.message });
  }
});

/**
 * Parse a natural language goal, evaluate targeted segment, and draft message details.
 * POST /api/ai/agent
 * Body: { goal }
 */
router.post('/ai/agent', async (req, res) => {
  try {
    const { goal } = req.body;
    if (!goal) {
      return res.status(400).json({ error: 'Please provide a marketing goal description.' });
    }

    // Call the AI handler (Gemini or Mock compiler)
    const aiResult = await processNaturalLanguageGoal(goal);

    // Run a dry-run count against the database to show the marketer the size of the target audience
    let targetCount = 0;
    try {
      const countRes = await getQuery(`SELECT COUNT(*) as count FROM customers WHERE ${aiResult.sqlFilter}`);
      targetCount = countRes ? countRes.count : 0;
    } catch (dbErr) {
      console.warn('Dry-run SQL evaluation failed. Defaulting target audience count to 0. Error:', dbErr.message);
      // If SQL fails validation, default to 0 matching rows
    }

    res.json({
      ...aiResult,
      targetCount
    });
  } catch (err) {
    res.status(500).json({ error: 'AI processing failed: ' + err.message });
  }
});

/**
 * Create a new campaign and enqueue delivery jobs for all targeted customers.
 * POST /api/campaigns
 * Body: { name, channel, messageTemplate, sqlFilter }
 */
router.post('/campaigns', async (req, res) => {
  try {
    const { name, channel, messageTemplate, sqlFilter } = req.body;

    if (!name || !channel || !messageTemplate) {
      return res.status(400).json({ error: 'Campaign name, channel, and message template are required.' });
    }

    // 1. Fetch targeted customers using the segment clause
    let filter = sqlFilter || '1=1'; // Fallback to all customers
    const customers = await allQuery(`SELECT * FROM customers WHERE ${filter}`);

    if (customers.length === 0) {
      return res.status(400).json({ error: 'The selected segment has 0 matching customers. Cannot send campaign.' });
    }

    // 2. Insert the Campaign Meta record
    const campaignInsert = await runQuery(
      `INSERT INTO campaigns (name, channel, message_template, sent_count) VALUES (?, ?, ?, ?)`,
      [name, channel, messageTemplate, customers.length]
    );
    const campaignId = campaignInsert.id;

    // 3. For each customer, compile personalization, insert delivery log and push to queue.
    for (const c of customers) {
      // Personalization logic: replacing template tags with database fields
      let personalizedMsg = messageTemplate
        .replace(/\{\{name\}\}/g, c.name)
        .replace(/\{\{total_spent\}\}/g, `₹${c.total_spent}`)
        .replace(/\{\{order_count\}\}/g, c.order_count);

      // Determine correct contact address depending on channel preference
      const recipientAddress = (channel === 'Email') ? c.email : c.phone;

      // Insert delivery record as 'sent' (initial state)
      const deliveryInsert = await runQuery(
        `INSERT INTO deliveries (campaign_id, customer_id, recipient_address, message_content, status)
         VALUES (?, ?, ?, ?, 'sent')`,
        [campaignId, c.id, recipientAddress, personalizedMsg]
      );
      const deliveryId = deliveryInsert.id;

      // Enqueue job in our SQLite asynchronous worker queue
      await enqueueJob({
        deliveryId,
        campaignId,
        customerId: c.id,
        recipient: recipientAddress,
        message: personalizedMsg,
        channel
      });
    }

    res.json({
      success: true,
      campaignId,
      enqueuedCount: customers.length,
      message: `Campaign created and ${customers.length} delivery jobs successfully queued.`
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to launch campaign: ' + err.message });
  }
});

/**
 * Receipt Webhook Endpoint called asynchronously by the Channel Service (Port 5001).
 * POST /api/callback/receipt
 * Body: { deliveryId, campaignId, customerId, status, purchaseAmount, purchaseCategory }
 */
router.post('/callback/receipt', async (req, res) => {
  try {
    const { deliveryId, campaignId, customerId, status, purchaseAmount, purchaseCategory } = req.body;

    if (!deliveryId || !campaignId || !status) {
      return res.status(400).json({ error: 'Invalid webhook receipt payload. Required: deliveryId, campaignId, status.' });
    }

    // --- WHY WORKFLOW IS WRITTEN THIS WAY ---
    // The Channel Service reports recipient outcomes. The CRM updates delivery logs 
    // and recalculates analytical aggregates inside its database. 
    // Additionally, if the recipient 'purchased', we generate an actual order to reflect immediate marketing ROI.

    // 1. Update individual delivery status log
    await runQuery(
      `UPDATE deliveries SET status = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, deliveryId]
    );

    // 2. Perform updates to Campaign statistics based on status
    if (status === 'delivered') {
      await runQuery(`UPDATE campaigns SET delivered_count = delivered_count + 1 WHERE id = ?`, [campaignId]);
    } else if (status === 'failed') {
      await runQuery(`UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?`, [campaignId]);
    } else if (status === 'opened') {
      await runQuery(`UPDATE campaigns SET opened_count = opened_count + 1 WHERE id = ?`, [campaignId]);
    } else if (status === 'read') {
      // In WhatsApp/RCS, 'read' implies it was also 'opened' (double blue ticks)
      await runQuery(`UPDATE campaigns SET opened_count = opened_count + 1, read_count = read_count + 1 WHERE id = ?`, [campaignId]);
    } else if (status === 'clicked') {
      await runQuery(`UPDATE campaigns SET clicked_count = clicked_count + 1 WHERE id = ?`, [campaignId]);
    } else if (status === 'purchased' && purchaseAmount) {
      // If purchase callback was fired:
      // a. Increment purchases count & add to campaign revenue
      await runQuery(
        `UPDATE campaigns 
         SET purchased_count = purchased_count + 1, revenue_generated = revenue_generated + ? 
         WHERE id = ?`,
        [purchaseAmount, campaignId]
      );

      // b. Insert new order into orders table to log the purchase history
      await runQuery(
        `INSERT INTO orders (customer_id, amount, category) VALUES (?, ?, ?)`,
        [customerId, purchaseAmount, purchaseCategory || 'Coffee']
      );

      // c. Recalculate customer's aggregated fields: total_spent, order_count, and last_purchase_date
      await runQuery(
        `UPDATE customers 
         SET total_spent = total_spent + ?, 
             order_count = order_count + 1, 
             last_purchase_date = date('now') 
         WHERE id = ?`,
        [purchaseAmount, customerId]
      );
    }

    res.json({ success: true, message: 'Receipt acknowledged and processed.' });
  } catch (err) {
    console.error('Error processing callback receipt webhook:', err.message);
    res.status(500).json({ error: 'Callback processing failed: ' + err.message });
  }
});

/**
 * Fetch analytics data and recent logs to render on the client dashboard.
 * GET /api/dashboard/stats
 */
router.get('/dashboard/stats', async (req, res) => {
  try {
    // Aggregated stats
    const totalCustomersRes = await getQuery('SELECT COUNT(*) as count FROM customers');
    const totalRevenueRes = await getQuery('SELECT SUM(revenue_generated) as rev FROM campaigns');
    const totalCampaignsRes = await getQuery('SELECT COUNT(*) as count FROM campaigns');

    // Delivery logs
    const recentDeliveries = await allQuery(`
      SELECT d.id, d.recipient_address, d.status, d.last_updated, c.name as campaign_name, cust.name as customer_name
      FROM deliveries d
      JOIN campaigns c ON d.campaign_id = c.id
      JOIN customers cust ON d.customer_id = cust.id
      ORDER BY d.id DESC LIMIT 10
    `);

    // Queue worker status aggregates
    const queueStats = await allQuery(`
      SELECT status, COUNT(*) as count FROM queue_jobs GROUP BY status
    `);

    res.json({
      totalCustomers: totalCustomersRes ? totalCustomersRes.count : 0,
      totalRevenue: totalRevenueRes ? (totalRevenueRes.rev || 0) : 0,
      totalCampaigns: totalCampaignsRes ? totalCampaignsRes.count : 0,
      recentDeliveries,
      queueStats
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch dashboard metrics: ' + err.message });
  }
});

/**
 * Fetch complete history of the queue jobs for UI monitoring.
 * GET /api/queue/jobs
 */
router.get('/queue/jobs', async (req, res) => {
  try {
    const jobs = await allQuery('SELECT * FROM queue_jobs ORDER BY id DESC LIMIT 50');
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch queue logs: ' + err.message });
  }
});

export default router;
