import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

// Load environment variables from a .env file (to get GEMINI_API_KEY if available)
dotenv.config();

// Initialize the Google Gen AI client if the key is provided
const apiKey = process.env.GEMINI_API_KEY;
let aiClient = null;
if (apiKey) {
  try {
    aiClient = new GoogleGenerativeAI(apiKey);
    console.log('Gemini API successfully initialized for natural language processing.');
  } catch (err) {
    console.error('Failed to initialize Gemini API client:', err.message);
  }
} else {
  console.log('No GEMINI_API_KEY found. Running in Rule-Based Mock AI fallback mode.');
}

/**
 * --- AI AGENT GATEWAY LAYER ---
 * This gateway layer abstracts the LLM integrations. 
 * If a Gemini API key is configured, it sends structured prompts to Gemini models to parse 
 * natural language goals into SQL targeting parameters, channel suggestions, and templates.
 * If not, it falls back to a regex compiler, keeping the system fully functional without API keys.
 */
export const processNaturalLanguageGoal = async (userPrompt) => {
  const promptLower = userPrompt.toLowerCase();

  // If a Gemini API Key is configured, use structured LLM prompting
  if (aiClient) {
    try {
      const model = aiClient.getGenerativeModel({ model: 'gemini-2.5-flash' });
      
      const systemInstruction = `
        You are Xeno AI, an agentic CRM marketing assistant.
        Your task is to parse a marketer's request or marketing goal and output a structured JSON response.
        
        The database contains a 'customers' table with these columns:
        - id (INTEGER)
        - name (TEXT)
        - email (TEXT)
        - phone (TEXT)
        - total_spent (REAL)
        - order_count (INTEGER)
        - last_purchase_date (TEXT, Format: YYYY-MM-DD)

        The database also contains an 'orders' table with these columns:
        - id (INTEGER)
        - customer_id (INTEGER)
        - amount (REAL)
        - category (TEXT, values: 'Coffee', 'Fashion', 'Beauty')
        - purchase_date (TEXT)

        You must output JSON exactly in this schema:
        {
          "reasoning": "A concise explanation of why this target segment and message was drafted",
          "sqlFilter": "A valid SQLite WHERE clause targeting the 'customers' table (e.g. 'total_spent > 5000' or 'order_count > 5' or 'last_purchase_date < date(\\'now\\', \\'-30 days\\')'). To segment by order categories, you can use subqueries like: 'id IN (SELECT DISTINCT customer_id FROM orders WHERE category = \\'Coffee\\')'",
          "suggestedChannel": "WhatsApp" | "SMS" | "Email" | "RCS",
          "messageTemplate": "The drafted campaign message. Use the {{name}} tag for personalization. Include relevant category theme.",
          "campaignName": "A short descriptive name for this campaign"
        }
        
        Rules:
        1. Always output ONLY valid JSON. No markdown backticks, no comments.
        2. Ensure the SQL where clause is fully valid SQLite syntax.
        3. Make the drafted template very friendly and relevant to the user's category (Fashion/Coffee/Beauty).
      `;

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: `${systemInstruction}\n\nUser request: "${userPrompt}"` }] }]
      });

      const text = result.response.text().trim();
      // Clean markdown code blocks if the LLM outputted them
      const cleanJson = text.replace(/^```json/, '').replace(/```$/, '').trim();
      const parsed = JSON.parse(cleanJson);
      return parsed;
    } catch (err) {
      console.warn('Gemini API call failed, falling back to rule engine:', err.message);
      // Fall through to mock engine if API crashes or limits out
    }
  }

  // --- RULE-BASED COMPILER FALLBACK ---
  // Implements regex and keyword matching to translate Natural Language to SQL & copy drafts.
  console.log('Executing AI fallback rule engine parsing...');
  let sqlFilter = '1=1'; // Default: matches all customers
  let reasoning = 'Generic segment selected based on intent.';
  let suggestedChannel = 'WhatsApp';
  let campaignName = 'General Engagement Campaign';
  let messageTemplate = 'Hello {{name}}! We have exciting new offers for you. Check them out!';

  // 1. Detect Spend threshold queries (e.g. "spent > 5000", "spend more than 3000")
  const spendMatch = promptLower.match(/(?:spent|spend|amount)\s*(?:>\s*|greater than\s*|more than\s*|above\s*|over\s*)(\d+)/i);
  if (spendMatch) {
    const val = spendMatch[1];
    sqlFilter = `total_spent > ${val}`;
    reasoning = `Targeting active spenders who spent more than ₹${val} to reward them with premium offers.`;
    suggestedChannel = 'Email'; // Premium shoppers get rich email campaigns
    campaignName = `High Spenders (>₹${val}) Campaign`;
    messageTemplate = `Hey {{name}}, we see you have spent over ₹${val} with us! To show our appreciation, here is an exclusive 15% discount code: ELITE15.`;
  }

  // 2. Detect Inactive shoppers (e.g. "inactive for 30 days", "not purchased in 45 days")
  const inactiveMatch = promptLower.match(/(?:inactive|not purchased|haven't bought|no order)\s*(?:for\s*|in\s*|since\s*)?(\d+)\s*days/i);
  if (inactiveMatch) {
    const days = inactiveMatch[1];
    sqlFilter = `last_purchase_date < date('now', '-${days} days') OR last_purchase_date IS NULL`;
    reasoning = `Re-engaging shoppers who have been inactive for more than ${days} days to boost retention.`;
    suggestedChannel = 'WhatsApp'; // Quick alerts for cold shoppers
    campaignName = `Re-engage ${days} Days Inactive`;
    messageTemplate = `Hey {{name}}! We've missed you! It has been over ${days} days since your last purchase. Here is a sweet 10% discount on your next visit: WE_MISS_YOU.`;
  }

  // 3. Detect Categories (e.g. "coffee", "fashion", "beauty")
  if (promptLower.includes('coffee')) {
    sqlFilter = `id IN (SELECT DISTINCT customer_id FROM orders WHERE category = 'Coffee')`;
    reasoning = 'Targeting customers who bought Coffee previously to promote recurring orders.';
    suggestedChannel = 'SMS';
    campaignName = 'Coffee Lovers Special';
    messageTemplate = `Hey {{name}}, smells like fresh brew! Get a free espresso with your next bag of coffee beans. Use coupon: BREW26.`;
  } else if (promptLower.includes('fashion') || promptLower.includes('clothes')) {
    sqlFilter = `id IN (SELECT DISTINCT customer_id FROM orders WHERE category = 'Fashion')`;
    reasoning = 'Targeting fashion enthusiasts who showed interest in our clothing catalogs.';
    suggestedChannel = 'Email';
    campaignName = 'Fashion Trends Catalog';
    messageTemplate = `Hi {{name}}, step up your style game! The new Summer Collection is officially live. Get early VIP access here: xeno.co/fashion`;
  } else if (promptLower.includes('beauty') || promptLower.includes('lipstick') || promptLower.includes('skin')) {
    sqlFilter = `id IN (SELECT DISTINCT customer_id FROM orders WHERE category = 'Beauty')`;
    reasoning = 'Targeting skincare and beauty buyers to promote restocks.';
    suggestedChannel = 'RCS';
    campaignName = 'Beauty Restock Reminder';
    messageTemplate = `Gorgeous {{name}}! Time for a beauty refresh? Buy any lipstick today and get a mini cleanser free. Reply YES to order instantly!`;
  }

  // 4. Check for order count (e.g. "more than 5 purchases", "> 5 orders")
  const orderMatch = promptLower.match(/(?:orders|purchases|bought)\s*(?:>\s*|greater than\s*|more than\s*|above\s*)(\d+)/i);
  if (orderMatch) {
    const ords = orderMatch[1];
    sqlFilter = `order_count > ${ords}`;
    reasoning = `Rewarding our loyal VIPs with more than ${ords} orders to lock in long-term loyalty.`;
    suggestedChannel = 'WhatsApp';
    campaignName = `Loyal Customers (> ${ords} orders)`;
    messageTemplate = `Dear {{name}}, you are officially a VIP with over ${ords} orders! Enjoy free shipping forever with code: VIPlife.`;
  }

  return {
    reasoning,
    sqlFilter,
    suggestedChannel,
    messageTemplate,
    campaignName
  };
};
