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
const svgCaptcha = require('svg-captcha');

const app = express();
app.use(cors({ origin: true, credentials: true })); // Allow cookies for JWT
app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.JWT_SECRET || 'captcha-session-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 600000 } // 10 mins
}));

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-12345';
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:GnuPiJPKSdSFsVhNHdqMhojaOVGhjGYN@switchyard.proxy.rlwy.net:35893/railway';

// Database Setup
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false } // Required for some hosted platforms like Railway
});

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
  const captcha = svgCaptcha.create({
    size: 4,
    noise: 2,
    color: true,
    background: '#f0f0f0'
  });
  req.session.captcha = captcha.text.toLowerCase();
  res.type('svg');
  res.status(200).send(captcha.data);
});

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, confirmPassword, captcha } = req.body;

  if (!email || !password || !confirmPassword || !captcha) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }

  if (!req.session.captcha || captcha.toLowerCase() !== req.session.captcha) {
    return res.status(400).json({ error: 'Invalid captcha' });
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

// 4. REVISED: AI Story Options (COYA) - Property-Grounded
app.post('/api/ai/story-options', async (req, res) => {
  const { openaiKey, properties, selectedObjects, currentStep, previousChoices, businessProfile } = req.body;
  const apiKey = openaiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'OpenAI API Key is required' });

  const openai = new OpenAI({ apiKey });

  // Build property summary
  const propertyList = properties.map(p => `${p.label} (${p.name})`).join(', ');
  const profileContext = businessProfile?.inferred_profile
    ? JSON.stringify(businessProfile.inferred_profile, null, 2)
    : 'No profile inference available';

  const stepPrompts = {
    // STEP 1: Business Focus - What area of the business to analyze
    business_focus: `
## STEP 1: BUSINESS FOCUS DISCOVERY

You are helping a user who is UNFAMILIAR with this company understand what reports are possible based solely on property names.

### INFERRED BUSINESS PROFILE
${profileContext}

### AVAILABLE OBJECTS
${selectedObjects.join(', ')}

### AVAILABLE PROPERTIES
${propertyList}

### YOUR TASK
Based on the property names, suggest 4 distinct BUSINESS FOCUS areas that these properties could support reporting on. Each option should represent a different lens through which this company might analyze their data.

DO NOT suggest generic options. Each option must be grounded in SPECIFIC PROPERTIES you see in the list.

For each option, explain:
- What properties make this focus area viable
- What kind of insights this focus would reveal
- Who in the organization would care about this

Return JSON with "options" array containing objects with:
- "id": unique slug (lowercase, hyphenated)
- "label": business focus area name (be specific to what properties allow)
- "description": 1-2 sentences explaining what this focus reveals and its business value
- "grounding_properties": array of 3-5 property names (use the actual property names, not labels) that enable this focus
- "example_question": one specific business question this focus could answer
`,

    // STEP 2: Metric Type - What kind of measurements to make
    metric_type: `
## STEP 2: METRIC TYPE SELECTION

### PREVIOUSLY SELECTED
Business Focus: ${previousChoices?.business_focus}

### INFERRED BUSINESS PROFILE
${profileContext}

### AVAILABLE PROPERTIES
${propertyList}

### YOUR TASK
Given the selected business focus "${previousChoices?.business_focus}", what TYPES OF METRICS can actually be reported on with these properties?

Analyze the properties to determine which of these metric categories are ACTUALLY supported:
- **Volume Metrics**: Counts, totals (requires countable entities)
- **Velocity Metrics**: Speed, time-to-X (requires timestamp properties)
- **Conversion Metrics**: Rates, ratios (requires stage/status properties with progression)
- **Value Metrics**: Revenue, amounts (requires currency/number properties)
- **Distribution Metrics**: Breakdown by category (requires picklist/enum properties)
- **Trend Metrics**: Change over time (requires date properties)
- **Comparison Metrics**: Side-by-side analysis (requires grouping properties like owner, team, region)

ONLY suggest metric types that the ACTUAL PROPERTIES can support. Do not suggest metrics that require properties not in the list.

Return JSON with "options" array containing objects with:
- "id": unique slug
- "label": metric type name
- "description": what this metric type reveals in context of their business focus "${previousChoices?.business_focus}"
- "viable_because": which specific property names (not labels) enable this metric type
- "example_report": one concrete report title using this metric type for the selected focus
`,

    // STEP 3: Comparison Dimension - How to slice the data
    comparison_dimension: `
## STEP 3: COMPARISON DIMENSION SELECTION

### PREVIOUSLY SELECTED
Business Focus: ${previousChoices?.business_focus}
Metric Type: ${previousChoices?.metric_type}

### AVAILABLE PROPERTIES
${propertyList}

### YOUR TASK
Determine what COMPARISON DIMENSIONS are possible with these properties. A comparison dimension is how the user will slice, segment, or group their data to surface insights.

Look for properties that could serve as:
- **Time-based**: date properties for trending (month-over-month, quarter-over-quarter, YoY)
- **Categorical**: picklists, dropdowns for segmentation (by region, by product, by source, by type)
- **Hierarchical**: owner, team, business unit properties for organizational views
- **Lifecycle/Stage**: stage properties for funnel or progression analysis
- **Custom Segments**: boolean or score properties for cohort analysis

Only suggest dimensions that ACTUALLY EXIST in the properties. Be specific about which property enables each dimension.

Return JSON with "options" array containing objects with:
- "id": unique slug
- "label": comparison dimension name (e.g., "By Sales Rep", "Over Time (Monthly)", "By Deal Source")
- "description": how this dimension adds insight when combined with "${previousChoices?.metric_type}" metrics for "${previousChoices?.business_focus}"
- "property_used": the specific property NAME (not label) that enables this comparison
- "insight_example": one specific insight that comparing by this dimension would reveal
`,

    // STEP 4: Output Format - How to present the reports
    output_format: `
## STEP 4: OUTPUT FORMAT & DEPTH

### PREVIOUSLY SELECTED
Business Focus: ${previousChoices?.business_focus}
Metric Type: ${previousChoices?.metric_type}
Comparison Dimension: ${previousChoices?.comparison_dimension}

### YOUR TASK
Based on all previous selections, suggest appropriate OUTPUT FORMATS and DEPTH LEVELS for the reports.

Consider:
- The complexity of the data relationships in their selections
- Whether they need summary views vs. detailed drill-downs
- The likely audience for these reports (executives vs. managers vs. individual contributors)
- HubSpot's available visualization types

Return JSON with "options" array containing objects with:
- "id": unique slug
- "label": format/depth name (e.g., "Executive Snapshot", "Manager's Dashboard", "Detailed Analysis Tables", "Trend Visualizations")
- "description": why this format suits their specific combination of focus, metric, and dimension
- "visualization_types": array of specific HubSpot chart types to use (Bar Chart, Line Chart, Area Chart, Donut Chart, Pie Chart, Table, Single Value, Funnel)
- "report_count_range": object with "min" and "max" indicating how many reports this depth level would generate
- "audience": who would primarily use reports in this format
`
  };

  const prompt = stepPrompts[currentStep];

  if (!prompt) {
    return res.status(400).json({ error: `Unknown step: ${currentStep}. Valid steps are: business_focus, metric_type, comparison_dimension, output_format` });
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1-mini-2025-04-14',
      messages: [
        {
          role: 'system',
          content: 'You are a HubSpot reporting expert helping users discover what reports are POSSIBLE given their specific property configuration. You NEVER suggest options that the properties cannot support. You ALWAYS ground your suggestions in specific property names from the provided list. You are thorough but practical.'
        },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });
    const content = JSON.parse(response.choices[0].message.content);
    const options = content.options || (Array.isArray(content) ? content : Object.values(content)[0]) || [];
    res.json(options);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. REVISED: AI Report Suggestions - Fully Grounded in Properties
app.post('/api/ai/suggest', async (req, res) => {
  const { openaiKey, properties, selectedObjects, storyContext, businessProfile } = req.body;
  const apiKey = openaiKey || process.env.OPENAI_API_KEY;

  if (!apiKey) return res.status(400).json({ error: 'OpenAI API Key is required' });

  const openai = new OpenAI({ apiKey });

  const profileContext = businessProfile?.inferred_profile
    ? JSON.stringify(businessProfile.inferred_profile, null, 2)
    : 'No profile inference available';

  const prompt = `
You are a HubSpot Custom Report Builder expert. Your task is to generate ACTIONABLE report configurations that a user can build in HubSpot's Custom Report Builder RIGHT NOW.

## CRITICAL CONSTRAINT - READ THIS CAREFULLY
You can ONLY suggest reports that use the properties provided below. Do NOT invent properties. Do NOT assume properties exist. Every single property reference in your reports MUST come from the AVAILABLE PROPERTIES list. If you reference a property that is not in the list, the report will fail.

## BUSINESS CONTEXT (Inferred from Properties)
${profileContext}

## USER'S JOURNEY SELECTIONS
- Business Focus: ${storyContext.business_focus}
- Metric Type: ${storyContext.metric_type}
- Comparison Dimension: ${storyContext.comparison_dimension}
- Output Format: ${storyContext.output_format}

## AVAILABLE OBJECTS
${selectedObjects.join(', ')}

## AVAILABLE PROPERTIES (THIS IS YOUR ONLY SOURCE OF TRUTH)
${JSON.stringify(properties, null, 2)}

## YOUR TASK
Generate between 8 and 15 reports that:
1. DIRECTLY ADDRESS the user's selected business focus: "${storyContext.business_focus}"
2. USE the metric type: "${storyContext.metric_type}"
3. SLICE DATA by the comparison dimension: "${storyContext.comparison_dimension}"
4. PRESENT in the format: "${storyContext.output_format}"
5. USE ONLY properties from the AVAILABLE PROPERTIES list above
6. Are IMMEDIATELY ACTIONABLE (user can build these right now in HubSpot)

For each report, provide IKEA-style assembly instructions that assume the user has never built a HubSpot report before. Be extremely specific.

## HUBSPOT REPORT BUILDER CONSTRAINTS (Follow These)
- Data sources must be from the selected objects: ${selectedObjects.join(', ')}
- Cross-object reports require association relationships (e.g., Deals associated with Contacts)
- Time-based filtering uses date properties from the list
- Available Visualizations: Bar Chart, Line Chart, Area Chart, Donut Chart, Pie Chart, Table, Single Value, Funnel
- Available Aggregations: Count of records, Sum, Average, Min, Max
- Grouping is typically limited to 2-3 dimensions
- Filters can use: is, is not, contains, does not contain, is greater than, is less than, is between, is known, is unknown

## OUTPUT FORMAT
Return ONLY a JSON object with a "reports" array. Each report object MUST have this exact structure:

{
  "title": "Specific, descriptive report name that indicates what it measures",
  "business_question": "The exact business question this report answers - phrase it as a question",
  "why_this_matters": "1 sentence explaining the business value specifically for ${storyContext.business_focus}",
  "breeze_prompt": "A highly specific prompt optimized for HubSpot's Breeze AI. It MUST include: 1) The specific HubSpot Object(s), 2) The exact internal property names for metrics and grouping, 3) A clear timeframe (e.g., 'this year', 'last 90 days'), and 4) The desired visualization type (e.g., 'bar chart', 'table', 'line graph'). Format as a direct command. Example: 'Create a bar chart of deals showing the sum of amount grouped by dealstage, filtered by closedate is this quarter.'",
  "confidence": "high|medium|low",
  "confidence_note": "If medium/low, explain what property is missing or being approximated. If high, say 'All required properties available'",
  "ikea_guide": {
    "step_1_data_source": {
      "instruction": "Clear instruction for what to select in the 'Choose your data sources' screen",
      "primary_object": "The main object to select (must be from: ${selectedObjects.join(', ')})",
      "secondary_objects": ["Any additional objects to join - only if needed and available"],
      "association_note": "If multi-object: explain how they connect. If single object: say 'Single object report'"
    },
    "step_2_filters": {
      "instruction": "Clear instruction for the filters to apply",
      "filters": [
        {
          "property": "EXACT property name from the AVAILABLE PROPERTIES list",
          "property_label": "The human-readable label for this property",
          "operator": "is|is not|contains|is greater than|is less than|is between|is known|is unknown",
          "value": "The specific value to filter by OR a description like 'Last 90 days' for date ranges"
        }
      ]
    },
    "step_3_configure": {
      "instruction": "Clear instruction for configuring the chart axes/dimensions",
      "x_axis_or_rows": {
        "property": "EXACT property name from AVAILABLE PROPERTIES",
        "property_label": "Human readable label",
        "grouping": "by day|by week|by month|by quarter|by year|by value (for non-dates)"
      },
      "y_axis_or_values": {
        "aggregation": "Count of records|Sum of [property]|Average of [property]|Min of [property]|Max of [property]",
        "property": "EXACT property name OR 'records' for count",
        "property_label": "Human readable label OR 'Records' for count"
      },
      "break_down_by": {
        "property": "EXACT property name OR null if no breakdown",
        "property_label": "Human readable label OR null"
      }
    },
    "step_4_visualize": {
      "instruction": "Clear instruction for selecting and configuring the visualization",
      "chart_type": "Bar Chart|Line Chart|Area Chart|Donut Chart|Pie Chart|Table|Single Value|Funnel",
      "why_this_chart": "1 sentence explaining why this visualization best represents this data"
    }
  },
  "properties_used": ["Array of EXACT property names used - VERIFY each one exists in AVAILABLE PROPERTIES"],
  "quick_variations": [
    "1 suggestion for a quick modification that would give a different but related insight"
  ]
}

## SELF-CHECK BEFORE RESPONDING
For EACH report, verify:
[ ] Every property in "properties_used" exists in the AVAILABLE PROPERTIES list
[ ] Every property referenced in filters, axes, and breakdowns is in the list
[ ] The primary_object is in the selectedObjects list
[ ] The chart_type makes sense for the data (e.g., don't use Line Chart for non-time-series)
[ ] The business_question aligns with the user's business_focus selection
`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1-mini-2025-04-14',
      messages: [
        {
          role: 'system',
          content: `You are a meticulous HubSpot reporting expert. Your #1 rule: NEVER hallucinate property names. Before including any property in your response, mentally verify it exists in the provided AVAILABLE PROPERTIES list. If a useful report would require a property that doesn't exist, either skip that report OR include it with confidence: "low" and explain what's missing.

You generate reports that are:
1. Immediately buildable with the exact properties provided
2. Aligned with the user's stated business focus and preferences  
3. Clear enough that a HubSpot beginner could follow the instructions
4. Valuable enough that a busy professional would actually use them`
        },
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