import { initDatabase, runQuery, getQuery, allQuery } from '../src/database.js';
import { enqueueJob } from '../src/queue.js';

/**
 * --- INTEGRATION TEST SUITE ---
 * Verifies core SQLite database functionality, seeding processes, and queue ingestion.
 * 
 * Flow:
 * 1. Initialize SQLite database tables.
 * 2. Count seeded customers and orders.
 * 3. Enqueue and verify task queue job writing.
 */
const runTests = async () => {
  console.log('🧪 Starting CRM Backend Integration Tests...');

  try {
    // 1. Test Database Initialization and Seeding
    console.log('Testing Database Init...');
    await initDatabase();
    console.log('✔ Database initialized.');

    // 2. Query Customer Table Count
    const customerCount = await getQuery('SELECT COUNT(*) as count FROM customers');
    console.log(`✔ Customer table query succeeded. Total: ${customerCount.count} customers.`);

    // 3. Query Orders Table Count
    const orderCount = await getQuery('SELECT COUNT(*) as count FROM orders');
    console.log(`✔ Orders table query succeeded. Total: ${orderCount.count} orders.`);

    // 4. Test Enqueuing a Campaign Job
    console.log('Testing Task Queue Enqueue...');
    const initialJobs = await getQuery('SELECT COUNT(*) as count FROM queue_jobs');
    
    await enqueueJob({
      deliveryId: 999,
      campaignId: 888,
      customerId: 1,
      recipient: 'test@example.com',
      message: 'Test message for Alice',
      channel: 'Email'
    });

    const afterJobs = await getQuery('SELECT COUNT(*) as count FROM queue_jobs');
    if (afterJobs.count > initialJobs.count) {
      console.log(`✔ Queue job successfully written to database. Job count: ${afterJobs.count}`);
    } else {
      throw new Error('Queue job was not enqueued.');
    }

    // Clean up test job
    await runQuery('DELETE FROM queue_jobs WHERE payload LIKE "%test@example.com%"');
    console.log('✔ Cleaned up mock test job.');

    console.log('🎉 All CRM backend integration tests PASSED successfully!');
    process.exit(0);

  } catch (err) {
    console.error('❌ Integration test failed with error:', err.message);
    process.exit(1);
  }
};

runTests();
