import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initDatabase } from './database.js';
import crmRouter from './crm.js';
import channelRouter from './channelService.js';
import { triggerQueueRunner } from './queue.js';

// Load environmental parameters
dotenv.config();

// Initialize the SQLite tables and seed data before mounting the routers
const startup = async () => {
  try {
    console.log('Starting CRM initialization workflow...');
    await initDatabase();
    console.log('Database schema checked and mock data seeded.');

    // --- WHY TWO PORT BINDINGS ARE CREATED: INTERVIEW PREPARATION ---
    // Instead of bundling everything on a single port, we spin up two separate Express application 
    // listeners. This enforces actual network boundaries between the CRM and the Channel Service.
    // The CRM runs on Port 5000. The Channel Service runs on Port 5001.
    // They communicate solely using HTTP requests, which mimics real SaaS systems (like CRM -> Twilio).

    // 1. CRM Service App Instance (Port 5000)
    const crmApp = express();
    crmApp.use(cors({ origin: '*' })); // Enable Cross-Origin Resource Sharing for all origins
    crmApp.use(express.json());       // Parse incoming application/json body elements
    
    // Mount the CRM endpoints
    crmApp.use('/api', crmRouter);

    const crmPort = process.env.PORT || 5000;
    crmApp.listen(crmPort, () => {
      console.log('===================================================');
      console.log(`  CRM Backend Service running at port: ${crmPort}`);
      console.log('===================================================');
    });

    // 2. Channel Service App Instance (Port 5001)
    const channelApp = express();
    channelApp.use(cors({ origin: '*' })); // Enable Cross-Origin Resource Sharing
    channelApp.use(express.json());       // Parse JSON body elements
    
    // Mount the Mock Delivery Simulator endpoints
    channelApp.use('/channel', channelRouter);

    channelApp.listen(5001, () => {
      console.log('===================================================');
      console.log('  Mock Channel Service running at http://localhost:5001');
      console.log('===================================================');
    });

    // 3. Launch the Background Queue processor
    // If there were any pending/stalled jobs from a previous process termination, 
    // this recovers and dispatches them safely.
    triggerQueueRunner();

  } catch (err) {
    console.error('Critical boot error occurred on startup:', err);
    process.exit(1);
  }
};

startup();
