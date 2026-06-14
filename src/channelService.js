import express from 'express';

const router = express.Router();

// --- DECOUPLED SERVICE ARCHITECTURE ---
// In an enterprise design, the CRM and messaging channels are separate. 
// A CRM shouldn't block its main thread waiting for a messaging API provider to reply.
// Here, this Channel Service router models a third-party gateway (like Twilio or Sendgrid).
// It runs independently, receives dispatch commands via HTTP, returns immediate 202 status, 
// and asynchronously triggers recipient behavioral events (delivery, open, click, purchase) 
// using Node.js timers, calling back the CRM receipt webhook URL.

/**
 * Endpoint called by the CRM Queue Worker to dispatch a campaign message.
 * POST /channel/send
 * Body: { deliveryId, campaignId, customerId, recipient, message, channel }
 */
router.post('/send', (req, res) => {
  const { deliveryId, campaignId, customerId, recipient, message, channel } = req.body;

  // Validate incoming payload
  if (!deliveryId || !campaignId || !customerId || !recipient || !message || !channel) {
    return res.status(400).json({ error: 'Missing mandatory dispatch fields.' });
  }

  console.log(`[Channel Service] Accepted dispatch for ${channel} delivery ID: ${deliveryId} to ${recipient}`);

  // Return immediate 202 Accepted (Standard for async callback brokers)
  res.status(202).json({ status: 'queued', deliveryId });

  // --- RECIPIENT SIMULATION ENGINE ---
  // We use setTimeout triggers to simulate how real users interact with campaigns over time.
  // We model delivery rates and drop-offs for WhatsApp, SMS, Email, and RCS.
  
  // 1. Simulating DELIVERY STATUS (Happens after 400ms - 1s)
  setTimeout(() => {
    // 92% success rate, 8% failure (e.g. wrong number, network offline)
    const isDelivered = Math.random() > 0.08;
    const finalStatus = isDelivered ? 'delivered' : 'failed';

    sendCallback(deliveryId, campaignId, customerId, finalStatus);

    if (!isDelivered) return; // If delivery failed, stop lifecycle

    // 2. Simulating OPEN / READ STATUS (Happens after 1s - 2.5s)
    setTimeout(() => {
      // Channels have different open rates: WhatsApp & RCS are high (~85%), Email is lower (~30%), SMS is (~70%)
      let openProbability = 0.70;
      if (channel === 'WhatsApp' || channel === 'RCS') openProbability = 0.85;
      if (channel === 'Email') openProbability = 0.35;

      const isOpened = Math.random() < openProbability;
      if (!isOpened) return; // Stop if customer ignores the message

      // 'read' for WhatsApp/RCS/SMS, 'opened' for Email
      const openStatus = (channel === 'Email') ? 'opened' : 'read';
      sendCallback(deliveryId, campaignId, customerId, openStatus);

      // 3. Simulating CLICK / CTR STATUS (Happens after 1.5s - 3.5s)
      setTimeout(() => {
        // High personalization yields higher click-through rates. Average CTR 35%.
        const isClicked = Math.random() < 0.40;
        if (!isClicked) return; // Stop if customer clicks nothing

        sendCallback(deliveryId, campaignId, customerId, 'clicked');

        // 4. Simulating PURCHASE CONVERSION (Happens after 2s - 4.5s)
        setTimeout(() => {
          // Average conversion rate from clicks is ~25%.
          const isPurchased = Math.random() < 0.25;
          if (!isPurchased) return;

          // Generate a purchase amount based on typical items (coffee: ₹150-500, beauty/fashion: ₹800-4000)
          let purchaseAmount = 350; // default
          let category = 'Coffee'; // default

          const msgLower = message.toLowerCase();
          if (msgLower.includes('coffee') || msgLower.includes('espresso') || msgLower.includes('brew')) {
            purchaseAmount = Math.floor(Math.random() * 450) + 150; // ₹150 - ₹600
            category = 'Coffee';
          } else if (msgLower.includes('fashion') || msgLower.includes('catalog') || msgLower.includes('style') || msgLower.includes('summer')) {
            purchaseAmount = Math.floor(Math.random() * 3500) + 1200; // ₹1200 - ₹4700
            category = 'Fashion';
          } else if (msgLower.includes('beauty') || msgLower.includes('skincare') || msgLower.includes('lipstick') || msgLower.includes('cleanser')) {
            purchaseAmount = Math.floor(Math.random() * 2000) + 800; // ₹800 - ₹2800
            category = 'Beauty';
          } else {
            // Random general purchase
            purchaseAmount = Math.floor(Math.random() * 1500) + 300; // ₹300 - ₹1800
            category = ['Coffee', 'Fashion', 'Beauty'][Math.floor(Math.random() * 3)];
          }

          sendCallback(deliveryId, campaignId, customerId, 'purchased', purchaseAmount, category);

        }, Math.random() * 2500 + 2000); // Purchase delay

      }, Math.random() * 2000 + 1500); // Click delay

    }, Math.random() * 1500 + 1000); // Open delay

  }, Math.random() * 600 + 400); // Delivery delay
});

/**
 * Fires an HTTP POST request back to the CRM Receipt API.
 */
const sendCallback = async (deliveryId, campaignId, customerId, status, purchaseAmount = null, purchaseCategory = null) => {
  try {
    const body = {
      deliveryId,
      campaignId,
      customerId,
      status,
      purchaseAmount,
      purchaseCategory
    };

    console.log(`[Channel Service Callback] Dispatching status: '${status}' for delivery ID: ${deliveryId}`);

    // Read the CRM URL dynamically from environment variables for flexible hosting
    const CRM_URL = process.env.CRM_URL || 'http://localhost:5000';
    const response = await fetch(`${CRM_URL}/api/callback/receipt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      console.error(`[Channel Service Callback] CRM returned error status: ${response.status}`);
    }
  } catch (err) {
    console.error(`[Channel Service Callback] Failed to deliver webhook back to CRM. Refused connection:`, err.message);
  }
};

export default router;
