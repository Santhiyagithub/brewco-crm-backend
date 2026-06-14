import { runQuery, allQuery } from './database.js';

// Global variable representing whether the queue runner is currently active.
let isRunning = false;
let queueTimeout = null;

// --- DB-BACKED TASK QUEUE DESIGN ---
// At scale, this would use a specialized messaging broker like RabbitMQ or BullMQ with Redis.
// For self-contained single-instance deployments, we utilize an asynchronous polling worker 
// running against the SQLite 'queue_jobs' table. This implements the transactional outbox pattern:
// 1. Transactional safety - Campaign creation and job enqueuing happen in the same DB transaction.
// 2. Retry mechanisms - Failed requests back off exponentially and retry up to 3 times.
// 3. Rate limiting - Sequential processing with throttled polling prevents downstream service overload.
// 4. Observability - Tasks are persisted in the database, allowing real-time monitoring of queue states.

/**
 * Adds a new campaign delivery task to the database queue.
 */
export const enqueueJob = async (payload) => {
  const payloadStr = JSON.stringify(payload);
  // We initialize run_at with current timestamp so it is ready to execute immediately.
  await runQuery(
    `INSERT INTO queue_jobs (payload, status, attempts, run_at) VALUES (?, 'pending', 0, datetime('now'))`,
    [payloadStr]
  );
  
  // Trigger the processing cycle immediately if it is not already running.
  triggerQueueRunner();
};

/**
 * Triggers the background worker. If already running, do nothing to avoid concurrent overlapping processes.
 */
export const triggerQueueRunner = () => {
  if (isRunning) return;
  isRunning = true;
  processNextJob();
};

/**
 * Core loop of the queue worker. Processes one job, then schedules the next.
 */
const processNextJob = async () => {
  try {
    // 1. Fetch the oldest pending job that is scheduled to run (run_at <= now)
    const job = await getNextPendingJob();
    
    if (!job) {
      // No pending scheduled jobs. Stop the runner loop.
      isRunning = false;
      return;
    }

    console.log(`[Queue Worker] Processing job ID: ${job.id}, Attempt: ${job.attempts + 1}`);

    // 2. Mark the job as processing to avoid double consumption (simulates locking)
    await runQuery(
      `UPDATE queue_jobs SET status = 'processing', attempts = attempts + 1 WHERE id = ?`,
      [job.id]
    );

    const payload = JSON.parse(job.payload);

    // 3. Send the dispatch request to the Mock Channel Service (Port 5001)
    const success = await sendToChannelService(payload);

    if (success) {
      // Job succeeded. Update status.
      await runQuery(
        `UPDATE queue_jobs SET status = 'completed', error_message = NULL WHERE id = ?`,
        [job.id]
      );
      console.log(`[Queue Worker] Job ID ${job.id} completed successfully.`);
    } else {
      // Job failed. Check if we should retry.
      const maxAttempts = 3;
      if (job.attempts + 1 < maxAttempts) {
        // --- EXPONENTIAL BACKOFF LOGIC ---
        // Backoff formula: 2^(attempts) seconds delay.
        // Attempt 1 fails (job.attempts becomes 1): 2^1 = 2 seconds delay.
        // Attempt 2 fails (job.attempts becomes 2): 2^2 = 4 seconds delay.
        const backoffSeconds = Math.pow(2, job.attempts + 1);
        
        await runQuery(
          `UPDATE queue_jobs 
           SET status = 'pending', 
               run_at = datetime('now', '+${backoffSeconds} seconds'), 
               error_message = 'Failed connection. Retry #${job.attempts + 1} backoff ${backoffSeconds}s scheduled' 
           WHERE id = ?`,
          [job.id]
        );
        console.warn(`[Queue Worker] Job ID ${job.id} failed. Exponential backoff scheduled in ${backoffSeconds}s.`);
      } else {
        // Exceeded attempts limit. Mark as failed.
        await runQuery(
          `UPDATE queue_jobs SET status = 'failed', error_message = 'Exceeded maximum retries (3)' WHERE id = ?`,
          [job.id]
        );
        console.error(`[Queue Worker] Job ID ${job.id} permanently failed after 3 attempts.`);
        
        // Also update the delivery status to failed
        await runQuery(
          `UPDATE deliveries SET status = 'failed', error_message = 'Failed to deliver to channel service after 3 attempts' WHERE id = ?`,
          [payload.deliveryId]
        );
        
        // Update campaign counts
        await runQuery(
          `UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?`,
          [payload.campaignId]
        );
      }
    }
  } catch (err) {
    console.error('[Queue Worker] Error in queue processing step:', err.message);
  }

  // 4. Rate-limiting interval: Wait 150ms before polling.
  // This prevents tight-loop database CPU burning and implements queue rate limits.
  queueTimeout = setTimeout(() => {
    processNextJob();
  }, 150);
};

/**
 * Gets the next pending job from the database that is ready to run.
 */
const getNextPendingJob = () => {
  return new Promise((resolve, reject) => {
    // Select the first pending job whose scheduled execution time (run_at) has passed.
    // FIFO execution path.
    allQuery(`
      SELECT * FROM queue_jobs 
      WHERE status = 'pending' 
        AND (run_at IS NULL OR run_at <= datetime('now')) 
      ORDER BY id ASC LIMIT 1
    `)
      .then((rows) => resolve(rows[0] || null))
      .catch(reject);
  });
};


/**
 * Communicates with the simulated Channel Service on Port 5001 via HTTP POST.
 */
const sendToChannelService = async (payload) => {
  try {
    // CRM sends data to the Channel Service endpoint
    const response = await fetch('http://localhost:5001/channel/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        deliveryId: payload.deliveryId,
        campaignId: payload.campaignId,
        customerId: payload.customerId,
        recipient: payload.recipient,
        message: payload.message,
        channel: payload.channel
      })
    });

    if (response.ok) {
      return true;
    } else {
      const errorText = await response.text();
      console.error(`[Queue Worker] Channel Service returned non-200 status: ${response.status} - ${errorText}`);
      return false;
    }
  } catch (err) {
    console.error('[Queue Worker] Channel Service connection refused/network timeout:', err.message);
    return false;
  }
};
