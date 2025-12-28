require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { OpenAI } = require('openai');
const hubspot = require('@hubspot/api-client');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const svgCaptcha = require('svg-captcha');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // Required for secure cookies on Railway

app.use(cors({ origin: true, credentials: true })); // Allow cookies for JWT
app.use(express.json());
app.use(cookieParser());

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-12345';
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:GnuPiJPKSdSFsVhNHdqMhojaOVGhjGYN@switchyard.proxy.rlwy.net:35893/railway';

// Database Setup
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false } // Required for some hosted platforms like Railway
});

// Use Postgres for session storage to survive restarts on Railway
app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'sessions',
    createTableIfMissing: true
  }),
  name: 'report_hunter_sid',
  secret: JWT_SECRET,
  resave: true,
  saveUninitialized: true,
  rolling: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 1000 // 1 hour
  }
}));

app.use(express.static(path.join(__dirname, 'dist')));

// Initialize Database Tables
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        hubspot_token TEXT,
        current_state JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database tables initialized');
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    client.release();
  }
}
initDb();

// JWT Middleware
const authenticateToken = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Access denied. Please login.' });

  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(400).json({ error: 'Invalid token' });
  }
};

// --- AUTH ENDPOINTS ---

app.get('/api/auth/captcha', (req, res) => {
  const captcha = svgCaptcha.createMathExpr({
    size: 4,
    noise: 3,
    color: true,
    background: '#f8f8f8'
  });

  // The 'text' in math mode is the numeric answer
  req.session.captcha = captcha.text;

  req.session.save((err) => {
    if (err) {
      console.error('Captcha session save error:', err);
      return res.status(500).send('Session error');
    }
    res.type('svg');
    res.status(200).send(captcha.data);
  });
});

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, confirmPassword, captcha } = req.body;

  console.log(`Signup attempt: ${email}, Captcha Input: ${captcha}, Session Captcha: ${req.session.captcha}`);

  if (!email || !password || !confirmPassword || !captcha) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }

  if (!req.session.captcha || captcha.toLowerCase() !== req.session.captcha) {
    return res.status(400).json({ error: 'Invalid captcha. Please try again.' });
  }

  // Clear captcha after use
  req.session.captcha = null;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id',
      [email, hashedPassword]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ message: 'User created' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'User not found' });

    const user = result.rows[0];
    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) return res.status(400).json({ error: 'Invalid password' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ message: 'Logged in', hasToken: !!user.hubspot_token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out' });
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT email, hubspot_token, current_state FROM users WHERE id = $1', [req.user.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PROFILE & STATE ENDPOINTS ---

app.post('/api/user/profile', authenticateToken, async (req, res) => {
  const { hubspotToken } = req.body;
  try {
    await pool.query('UPDATE users SET hubspot_token = $1 WHERE id = $2', [hubspotToken, req.user.id]);
    res.json({ message: 'HubSpot token updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/state', authenticateToken, async (req, res) => {
  const { state } = req.body;
  try {
    await pool.query('UPDATE users SET current_state = $1 WHERE id = $2', [state, req.user.id]);
    res.json({ message: 'State saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/reset', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE users SET current_state = NULL WHERE id = $1', [req.user.id]);
    res.json({ message: 'State reset' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper to get HubSpot Client
const getHSClient = (token) => new hubspot.Client({ accessToken: token });

// 1. Fetch Objects (Standard and Custom)
app.post('/api/hubspot/objects', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    const hubspotClient = getHSClient(token);
    // Standard objects
    const standardObjects = [
      { id: 'contacts', label: 'Contacts' },
      { id: 'companies', label: 'Companies' },
      { id: 'deals', label: 'Deals' },
      { id: 'tickets', label: 'Tickets' },
      { id: 'marketing_events', label: 'Marketing Events' }
    ];

    // Try to fetch custom objects
    let customObjects = [];
    try {
      const schemas = await hubspotClient.crm.schemas.coreApi.getAll();
      customObjects = schemas.results.map(s => ({ id: s.objectTypeId, label: s.labels.plural || s.name }));
    } catch (e) {
      console.log('Error fetching custom objects:', e.message);
    }

    res.json([...standardObjects, ...customObjects]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Fetch Properties and Groups for selected objects
app.post('/api/hubspot/properties', async (req, res) => {
  const { token, objectTypes } = req.body;
  try {
    const hubspotClient = getHSClient(token);
    const results = {};

    for (const objType of objectTypes) {
      // Fetch properties
      const propertiesResponse = await hubspotClient.crm.properties.coreApi.getAll(objType);
      // Fetch groups
      const groupsResponse = await hubspotClient.crm.properties.groupsApi.getAll(objType);

      results[objType] = {
        properties: propertiesResponse.results
          .filter(p => !p.hidden)
          .map(p => ({
            name: p.name,
            label: p.label,
            groupName: p.groupName,
            type: p.type,
            fieldType: p.fieldType
          })),
        groups: groupsResponse.results.map(g => ({
          name: g.name,
          label: g.label
        }))
      };
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. NEW: Business Profile Inference (Pre-flight analysis)
app.post('/api/ai/profile-inference', async (req, res) => {
  const { openaiKey, properties, selectedObjects } = req.body;
  const apiKey = openaiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'OpenAI API Key is required' });

  const openai = new OpenAI({ apiKey });

  const prompt = `
You are a HubSpot implementation expert who can reverse-engineer a company's business model, industry, and operational focus purely from their CRM property names.

## OBJECTS SELECTED
${selectedObjects.join(', ')}

## PROPERTY NAMES TO ANALYZE
${JSON.stringify(properties.map(p => ({ name: p.name, label: p.label, type: p.type || 'unknown' })), null, 2)}

## YOUR TASK
Analyze these property names to infer:

1. **Industry Vertical**: What industry does this company likely operate in? Look for domain-specific terminology:
   - SaaS indicators: "mrr", "arr", "churn", "subscription", "renewal", "seats", "usage"
   - Healthcare: "patient", "diagnosis", "provider", "referral", "insurance"
   - Real Estate: "listing", "sqft", "property_type", "mortgage", "escrow"
   - Manufacturing: "sku", "inventory", "batch", "bom", "supplier"
   - Financial Services: "aum", "portfolio", "risk_score", "compliance"
   - E-commerce: "cart", "order_value", "shipping", "sku", "return"
   - Agency/Services: "retainer", "billable", "project", "deliverable", "scope"

2. **Sales Motion**: What's their likely go-to-market approach?
   - Enterprise (long cycles): "stakeholder", "procurement", "rfp", "champion"
   - PLG (product-led): "trial", "activation", "usage_score", "freemium"
   - Transactional: "cart", "checkout", "order"
   - Channel/Partner: "partner", "referral_source", "commission"

3. **Operational Maturity**: How sophisticated is their HubSpot usage?
   - Basic: Mostly default properties, few custom fields
   - Intermediate: Custom properties for key processes
   - Advanced: Calculated fields, lead scoring, lifecycle automation

4. **Data Richness Zones**: Which objects have the most custom/meaningful properties?

5. **Reporting Opportunities**: Based on the properties, what types of reports are ACTUALLY POSSIBLE?
   - Revenue reporting: Need deal amount, close date, pipeline stage
   - Activity tracking: Need activity timestamps, types, outcomes
   - Attribution: Need source, campaign, first/last touch properties
   - Lifecycle: Need lifecycle stage, conversion dates
   - Product usage: Need usage metrics, feature adoption properties

Return ONLY a JSON object with this structure:
{
  "inferred_profile": {
    "industry": "string - best guess at industry",
    "industry_confidence": "high|medium|low",
    "industry_signals": ["list of property names that led to this inference"],
    "sales_motion": "enterprise|plg|transactional|channel|hybrid",
    "sales_motion_signals": ["property names indicating this"],
    "operational_maturity": "basic|intermediate|advanced",
    "maturity_signals": ["property names indicating this"]
  },
  "data_richness": {
    "strongest_object": "which object has most meaningful custom properties",
    "weakest_object": "which object has least custom data",
    "cross_object_potential": "high|medium|low - can objects be meaningfully joined?"
  },
  "reportable_dimensions": [
    {
      "dimension": "e.g., Revenue Analysis, Lead Attribution, Activity Tracking",
      "feasibility": "high|medium|low",
      "required_properties": ["properties needed for this dimension"],
      "missing_properties": ["properties that would improve this dimension"]
    }
  ],
  "business_questions_possible": [
    "List of 5-8 specific business questions that CAN be answered with these properties"
  ]
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1-mini-2025-04-14',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1
    });
    const content = JSON.parse(response.choices[0].message.content);
    res.json(content);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. NEW: Dashboard Proposal (Role-Based)
app.post('/api/ai/propose-dashboard', async (req, res) => {
  const { openaiKey, properties, selectedObjects, businessProfile } = req.body;
  const apiKey = openaiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'OpenAI API Key is required' });

  const openai = new OpenAI({ apiKey });

  // Build property summary
  const propertyList = properties.map(p => `${p.label} (${p.name})`).join(', ');
  const profileContext = businessProfile?.inferred_profile
    ? JSON.stringify(businessProfile.inferred_profile, null, 2)
    : 'No profile inference available';

  const prompt = `
You are an expert HubSpot Consultant. 
Your goal is to propose a high-impact Dashboard for a client based on their available data.

## CLIENT CONTEXT
${profileContext}

## AVAILABLE OBJECTS
${selectedObjects.join(', ')}

## AVAILABLE PROPERTIES
${propertyList}

## YOUR TASK
1. **Adopt a Role**: Based on the inferred industry and data, decide what role you are playing (e.g., "SaaS Sales Ops Leader", "Marketing Attribution Specialist", "Service Efficiency Expert").
2. **Propose a Dashboard**: Create a list of 6-12 cohesive reports that belong on a SINGLE dashboard.
   - The dashboard should tell a story (e.g., "Full Funnel Visibility" or "Rep Performance Scorecard").
   - DO NOT suggest random reports. They must fit together.
3. **Verify Feasibility**: ONLY suggest reports that can be built with the AVAILABLE PROPERTIES.

## OUTPUT FORMAT
Return JSON:
{
  "role": "The role you are assuming",
  "dashboard_title": "A catchy title for the dashboard",
  "dashboard_description": "2 sentences explaining the goal of this dashboard",
  "proposed_reports": [
    {
      "id": "unique_slug",
      "title": "Report Title",
      "description": "What this shows and why it matters",
      "metric_type": "Volume|Velocity|Conversion|Value|Distribution|Trend|Comparison",
      "visual_style": "Bar|Line|Table|etc"
    }
  ]
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1-mini-2025-04-14',
      messages: [
        { role: 'system', content: 'You are a helpful HubSpot expert.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    });
    const content = JSON.parse(response.choices[0].message.content);
    res.json(content);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. NEW: Refine Proposal (Chat-based)
app.post('/api/ai/refine-proposal', async (req, res) => {
  const { openaiKey, currentProposal, userFeedback, properties } = req.body;
  const apiKey = openaiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'OpenAI API Key is required' });

  const openai = new OpenAI({ apiKey });

  const prompt = `
You are refining a HubSpot Dashboard Proposal based on user feedback.

## CURRENT PROPOSAL
Role: ${currentProposal.role}
Title: ${currentProposal.dashboard_title}
Reports:
${JSON.stringify(currentProposal.proposed_reports, null, 2)}

## USER FEEDBACK
"${userFeedback}"

## AVAILABLE PROPERTIES
(Assume same properties as before, do not hallucinate new ones)

## YOUR TASK
Update the "proposed_reports" list based on the feedback.
- If user says "remove X", remove it.
- If user says "add Y", add a new report entry that feasible.
- If user says "change focus to Z", rewrite the list.
- User might also want to change the "role" or "dashboard_title".

## OUTPUT FORMAT
Return the FULL JSON object structure again (Role, Title, Description, Reports), but updated.
`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1-mini-2025-04-14',
      messages: [
        { role: 'system', content: 'You are a helpful HubSpot expert refining a proposal.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    });
    const content = JSON.parse(response.choices[0].message.content);
    res.json(content);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. UPDATED: Generate Final Guides (Based on Approved List)
app.post('/api/ai/suggest', async (req, res) => {
  const { openaiKey, properties, selectedObjects, approvedReports, businessProfile } = req.body;
  const apiKey = openaiKey || process.env.OPENAI_API_KEY;

  if (!apiKey) return res.status(400).json({ error: 'OpenAI API Key is required' });

  const openai = new OpenAI({ apiKey });

  const prompt = `
You are a HubSpot Custom Report Builder expert. 
Your task is to generate DETAILED BUILDING INSTRUCTIONS for a list of approved reports.

## CONSTRAINT
You can ONLY suggest reports that use the properties provided below. 

## AVAILABLE OBJECTS
${selectedObjects.join(', ')}

## AVAILABLE PROPERTIES
${JSON.stringify(properties, null, 2)}

## APPROVED REPORTS TO BUILD
${JSON.stringify(approvedReports, null, 2)}

## YOUR TASK
For EACH report in the "Approved Reports" list, generate the full technical configuration.

## OUTPUT FORMAT
Return ONLY a JSON object with a "reports" array. Each report object MUST have this exact structure:

{
  "title": "Use the title from the approved list",
  "business_question": "The exact business question this report answers",
  "why_this_matters": "Business value explanation",
  "breeze_prompt": "Specific prompt for HubSpot AI (Object, Metric, Grouping, Filter, Visual)",
  "confidence": "high|medium|low",
  "ikea_guide": {
    "step_1_data_source": { "instruction": "...", "primary_object": "...", "secondary_objects": ["..."] },
    "step_2_filters": { "instruction": "...", "filters": [ { "property": "...", "operator": "...", "value": "..." } ] },
    "step_3_configure": { "instruction": "...", "x_axis_or_rows": {...}, "y_axis_or_values": {...}, "break_down_by": {...} },
    "step_4_visualize": { "instruction": "...", "chart_type": "..." }
  },
  "properties_used": ["..."]
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1-mini-2025-04-14',
      messages: [
        { role: 'system', content: 'You are a HubSpot reporting expert.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.15
    });

    const content = JSON.parse(response.choices[0].message.content);
    res.json(content.reports || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Create Report in HubSpot (unchanged)
app.post('/api/hubspot/create-report', async (req, res) => {
  const { token, payload } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    const response = await axios.post('https://api.hubapi.com/reporting/v3/reports', payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Report Creation Error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.listen(PORT, () => console.log(`Report Hunter Backend running on http://localhost:${PORT}`));