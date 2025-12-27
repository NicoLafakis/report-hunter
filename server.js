require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { OpenAI } = require('openai');
const hubspot = require('@hubspot/api-client');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

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

// 3. AI Story Options (COYA)
app.post('/api/ai/story-options', async (req, res) => {
  const { openaiKey, properties, selectedObjects, currentStep, previousChoices } = req.body;
  const apiKey = openaiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'OpenAI API Key is required' });

  const openai = new OpenAI({ apiKey });

  const steps = {
    audience: "Suggest 4 distinct target Audiences for these reports (e.g. Sales Leadership, Marketing Ops, CFO).",
    goal: `Based on the audience [${previousChoices?.audience}], suggest 4 distinct Reporting Goals (e.g. ROI Analysis, Team Velocity, Lead Attribution).`,
    timeframe: "Suggest 3 relevant Timeframes for this story (e.g. This Quarter vs Last, Month-over-Month, All-time Trends)."
  };

  const prompt = `
    You are a HubSpot Strategy Consultant. 
    Objects: ${selectedObjects.join(', ')}.
    Properties: ${properties.map(p => p.label).join(', ')}.
    
    Current Choice Step: ${currentStep}
    Task: ${steps[currentStep]}
    
    Return ONLY a JSON array of 3-4 objects, each with:
    "id": unique slug,
    "label": human readable title,
    "description": brief context of why this path matters.
  `;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1-mini-2025-04-14',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });
    const content = JSON.parse(response.choices[0].message.content);
    // Support either a root array or a named key
    const options = Array.isArray(content) ? content : (content.options || Object.values(content)[0]);
    res.json(options);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. AI Recommendations (Enhanced with Story Context)
app.post('/api/ai/suggest', async (req, res) => {
  const { openaiKey, properties, selectedObjects, storyContext } = req.body;
  const apiKey = openaiKey || process.env.OPENAI_API_KEY;

  if (!apiKey) return res.status(400).json({ error: 'OpenAI API Key is required' });

  const openai = new OpenAI({ apiKey });

  const prompt = `
    You are a HubSpot Reporting Expert specializing in the Custom Report Builder.
    
    STORY CONTEXT:
    Target Audience: ${storyContext.audience}
    Primary Goal: ${storyContext.goal}
    Timeframe: ${storyContext.timeframe}

    User has selected: ${selectedObjects.join(', ')}.
    Properties:
    ${JSON.stringify(properties, null, 2)}

    Task:
    Suggest up to 20 high-value CUSTOM MULTI-OBJECT REPORTS that align perfectly with the STORY CONTEXT above.
    
    CORE PILLARS (Context Aware):
    1. Totals: Volume-based reporting (Deals closed, Revenue generated).
    2. Traffic: Source and volume of incoming leads/engagements.
    3. Conversions: Rates and velocity of lifecycle stage movements.
    4. ROI: Mapping costs (Marketing Events/Campaigns) to Revenue (Deals).

    For each report, return a JSON object with this EXACT structure:
    {
      "title": "A professional name for the report",
      "description": "The exact business question this report answers",
      "ikea_guide": {
        "step_1_assemblies": "Objects to select and the primary data source",
        "step_2_filters": "Specific filters to apply matching ${storyContext.timeframe}",
        "step_3_axes": {
          "x_axis": "What property to place on the X-axis/Rows",
          "y_axis": "What property/count to place on the Y-axis/Columns/Values",
          "break_by": "Optional 'Break down by' property"
        },
        "step_4_visualization": "The exact chart type to pick",
        "step_5_values": "Any specific frequency or calculation to set"
      },
      "properties_used": ["list", "of", "internal", "names"],
      "apiPayload": {}
    }

    IMPORTANT: Be extremely specific. Focus on BUSINESS VALUE for the ${storyContext.audience} and the goal of ${storyContext.goal}.
    Return ONLY a JSON object with a "reports" key.
  `;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1-mini-2025-04-14',
      messages: [{ role: 'system', content: 'You are a HubSpot API expert.' }, { role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });

    const content = JSON.parse(response.choices[0].message.content);
    res.json(content.reports || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Create Report in HubSpot
app.post('/api/hubspot/create-report', async (req, res) => {
  const { token, payload } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    // The HubSpot Reporting API (V3 Beta) endpoint for creating reports
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

app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
