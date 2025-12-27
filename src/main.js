import './index.css'

let hsToken = '';
let openAIKey = '';
let availableObjects = [];
let selectedObjects = [];
let propertiesMap = {}; // { objectType: [properties] }
let selectedProperties = []; // [{ objectType, name, label }]
let visibleProperties = []; // [{ objectType, name, label }]
let storyPath = {
    audience: null,
    goal: null,
    timeframe: null
};

// Theme Toggle Logic
const themeToggle = document.getElementById('theme-toggle');
const themeToggleIcon = document.getElementById('theme-toggle-icon');
const themeToggleText = document.getElementById('theme-toggle-text');

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    if (theme === 'light') {
        themeToggleIcon.innerText = '🌙';
        themeToggleText.innerText = 'Dark Mode';
    } else {
        themeToggleIcon.innerText = '☀️';
        themeToggleText.innerText = 'Light Mode';
    }
}

// Init theme
const savedTheme = localStorage.getItem('theme') || 'dark';
setTheme(savedTheme);

themeToggle.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    setTheme(currentTheme === 'light' ? 'dark' : 'light');
});

const setupSection = document.getElementById('setup-section');
const selectionSection = document.getElementById('selection-section');
const resultsSection = document.getElementById('results-section');
const loader = document.getElementById('loader');
const loaderText = document.getElementById('loader-text');

// 1. Connect and Fetch Objects
document.getElementById('connect-btn').addEventListener('click', async () => {
    hsToken = document.getElementById('hubspot-token').value;
    openAIKey = document.getElementById('openai-key').value;

    if (!hsToken) return alert('Please enter a HubSpot Token');

    showLoader('Connecting to HubSpot...');
    try {
        const response = await fetch('http://localhost:3001/api/hubspot/objects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: hsToken })
        });
        const objects = await response.json();
        if (objects.error) throw new Error(objects.error);

        availableObjects = objects;
        renderObjectList();
        setupSection.classList.add('hidden');
        selectionSection.classList.remove('hidden');
    } catch (err) {
        alert('Connection failed: ' + err.message);
    } finally {
        hideLoader();
    }
});

function renderObjectList() {
    const list = document.getElementById('object-list');
    list.innerHTML = availableObjects.map(obj => `
        <label class="property-item">
            <input type="checkbox" value="${obj.id}" class="object-checkbox">
            <span>${obj.label}</span>
        </label>
    `).join('');

    document.querySelectorAll('.object-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            if (e.target.checked) {
                selectedObjects.push(e.target.value);
            } else {
                selectedObjects = selectedObjects.filter(id => id !== e.target.value);
            }
            document.getElementById('fetch-properties-btn').disabled = selectedObjects.length === 0;
        });
    });
}

// 2. Fetch Properties
document.getElementById('fetch-properties-btn').addEventListener('click', async () => {
    showLoader('Fetching properties and groups for ' + selectedObjects.join(', ') + '...');
    try {
        const response = await fetch('http://localhost:3001/api/hubspot/properties', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: hsToken, objectTypes: selectedObjects })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Server error');

        propertiesMap = data;
        populateGroupFilter();
        renderPropertyList();
        document.getElementById('get-suggestions-btn').disabled = false;
    } catch (err) {
        alert('Failed to fetch properties: ' + err.message);
    } finally {
        hideLoader();
    }
});

function populateGroupFilter() {
    const filter = document.getElementById('group-filter');
    const groups = new Set();

    Object.values(propertiesMap).forEach(data => {
        if (data && data.groups) {
            data.groups.forEach(g => groups.add(JSON.stringify({ name: g.name, label: g.label })));
        }
    });

    filter.innerHTML = '<option value="">All Groups</option>' +
        Array.from(groups)
            .map(g => JSON.parse(g))
            .sort((a, b) => a.label.localeCompare(b.label))
            .map(g => `<option value="${g.name}">${g.label}</option>`)
            .join('');
}

function renderPropertyList(textFilter = '', groupFilter = '') {
    const container = document.getElementById('property-list-container');
    container.innerHTML = '';
    visibleProperties = [];

    Object.entries(propertiesMap).forEach(([objType, data]) => {
        const { properties } = data;
        const filteredProps = properties.filter(p => {
            const matchesText = p.label.toLowerCase().includes(textFilter.toLowerCase()) ||
                p.name.toLowerCase().includes(textFilter.toLowerCase());
            const matchesGroup = !groupFilter || p.groupName === groupFilter;
            return matchesText && matchesGroup;
        });

        if (filteredProps.length > 0) {
            const group = document.createElement('div');
            group.innerHTML = `<h4 style="margin: 1rem 0 0.5rem; text-transform: capitalize; color: var(--primary); font-size: 0.9rem; border-bottom: 1px solid var(--border-color);">${objType}</h4>`;

            filteredProps.forEach(prop => {
                visibleProperties.push({ objectType: objType, name: prop.name, label: prop.label });
                const label = document.createElement('label');
                label.className = 'property-item';
                const isChecked = selectedProperties.some(sp => sp.objectType === objType && sp.name === prop.name);
                label.innerHTML = `
                    <input type="checkbox" class="prop-checkbox" data-obj="${objType}" data-name="${prop.name}" data-label="${prop.label}" ${isChecked ? 'checked' : ''}>
                    <span>${prop.label} <small style="color:var(--text-dim)">(${prop.name})</small></span>
                `;
                group.appendChild(label);
            });
            container.appendChild(group);
        }
    });

    document.querySelectorAll('.prop-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const { obj, name, label } = e.target.dataset;
            if (e.target.checked) {
                if (!selectedProperties.some(sp => sp.objectType === obj && sp.name === name)) {
                    selectedProperties.push({ objectType: obj, name, label });
                }
            } else {
                selectedProperties = selectedProperties.filter(sp => !(sp.objectType === obj && sp.name === name));
            }
            updateSelectedCount();
        });
    });
}

document.getElementById('select-all-visible').addEventListener('click', () => {
    visibleProperties.forEach(vp => {
        if (!selectedProperties.some(sp => sp.objectType === vp.objectType && sp.name === vp.name)) {
            selectedProperties.push(vp);
        }
    });
    const textFilter = document.getElementById('property-search').value;
    const groupFilter = document.getElementById('group-filter').value;
    renderPropertyList(textFilter, groupFilter);
    updateSelectedCount();
});

document.getElementById('clear-all-selected').addEventListener('click', () => {
    selectedProperties = [];
    const textFilter = document.getElementById('property-search').value;
    const groupFilter = document.getElementById('group-filter').value;
    renderPropertyList(textFilter, groupFilter);
    updateSelectedCount();
});

document.getElementById('property-search').addEventListener('input', (e) => {
    const textFilter = e.target.value;
    const groupFilter = document.getElementById('group-filter').value;
    renderPropertyList(textFilter, groupFilter);
});

document.getElementById('group-filter').addEventListener('change', (e) => {
    const textFilter = document.getElementById('property-search').value;
    const groupFilter = e.target.value;
    renderPropertyList(textFilter, groupFilter);
});

function updateSelectedCount() {
    document.getElementById('selected-count').innerText = `${selectedProperties.length} properties selected`;
    document.getElementById('start-journey-btn').disabled = selectedProperties.length === 0;
}

// 3. Story Journey Logic (COYA)
document.getElementById('start-journey-btn').addEventListener('click', () => {
    document.getElementById('story-section').classList.remove('hidden');
    document.getElementById('story-section').scrollIntoView({ behavior: 'smooth' });
    fetchStoryStep('audience');
});

async function fetchStoryStep(step) {
    const container = document.getElementById('story-steps-container');
    showLoader(`Defining your ${step}...`);

    try {
        const response = await fetch('http://localhost:3001/api/ai/story-options', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                openaiKey: openAIKey,
                properties: selectedProperties,
                selectedObjects: selectedObjects,
                currentStep: step,
                previousChoices: storyPath
            })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Server error');
        if (!Array.isArray(data)) throw new Error('Expected an array of options but received: ' + JSON.stringify(data));

        renderStoryStep(step, data);
    } catch (err) {
        alert('Failed to fetch story options: ' + err.message);
    } finally {
        hideLoader();
    }
}

function renderStoryStep(step, options) {
    const container = document.getElementById('story-steps-container');

    // Clear subsequent steps if re-selecting
    if (step === 'audience') {
        container.innerHTML = '';
        storyPath = { audience: null, goal: null, timeframe: null };
        document.getElementById('story-final-btn-container').classList.add('hidden');
    }

    const stepDiv = document.createElement('div');
    stepDiv.className = 'story-step';
    stepDiv.innerHTML = `
        <h4 style="text-transform: capitalize; color: var(--primary); margin-bottom: 1rem;">Select ${step}:</h4>
        <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem;">
            ${options.map(opt => `
                <button class="choice-card" data-step="${step}" data-id="${opt.id}" data-label="${opt.label}">
                    <strong>${opt.label}</strong>
                    <p style="font-size: 0.8rem; margin-top: 0.3rem; color: var(--text-dim);">${opt.description}</p>
                </button>
            `).join('')}
        </div>
    `;
    container.appendChild(stepDiv);

    stepDiv.querySelectorAll('.choice-card').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const card = e.currentTarget;
            const chosenId = card.dataset.id;
            const chosenLabel = card.dataset.label;

            // Highlight choice
            stepDiv.querySelectorAll('.choice-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');

            storyPath[step] = chosenLabel;

            // Next step or final
            if (step === 'audience') fetchStoryStep('goal');
            else if (step === 'goal') fetchStoryStep('timeframe');
            else {
                document.getElementById('story-final-btn-container').classList.remove('hidden');
            }
        });
    });
}

// 4. Final Hunt
document.getElementById('get-suggestions-btn').addEventListener('click', async () => {
    showLoader('AI is hunting for story-driven insights...');
    try {
        const response = await fetch('http://localhost:3001/api/ai/suggest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                openaiKey: openAIKey,
                properties: selectedProperties,
                selectedObjects: selectedObjects,
                storyContext: storyPath
            })
        });
        const suggestions = await response.json();
        if (!response.ok) throw new Error(suggestions.error || 'Server error');
        if (!Array.isArray(suggestions)) throw new Error('Expected an array of suggestions');

        renderSuggestions(suggestions);
        const resultsSection = document.getElementById('results-section');
        resultsSection.classList.remove('hidden');
        resultsSection.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
        alert('AI Suggestion failed: ' + err.message);
    } finally {
        hideLoader();
    }
});

function renderSuggestions(suggestions) {
    const container = document.getElementById('suggestions-container');
    container.innerHTML = suggestions.map((s, idx) => `
        <div class="report-suggestion" id="suggestion-${idx}">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
                <h3 style="margin: 0; color: var(--primary);">${s.title}</h3>
                <span class="selected-badge" style="font-size: 0.7rem;">REPORT ASSEMBLY GUIDE</span>
            </div>
            <p style="color: var(--text-dim); margin-bottom: 1.5rem; font-style: italic;">"${s.description}"</p>
            
            <div class="ikea-steps" style="display: grid; gap: 1rem;">
                <div class="step-card">
                    <div class="step-num">1</div>
                    <div class="step-content">
                        <strong>The Foundation (Objects)</strong>
                        <p>${s.ikea_guide.step_1_assemblies}</p>
                    </div>
                </div>

                <div class="step-card">
                    <div class="step-num">2</div>
                    <div class="step-content">
                        <strong>Refine Your View (Filters)</strong>
                        <p>${s.ikea_guide.step_2_filters}</p>
                    </div>
                </div>

                <div class="step-card">
                    <div class="step-num">3</div>
                    <div class="step-content">
                        <strong>The Layout (Axes)</strong>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.5rem; font-size: 0.85rem;">
                            <div style="background: #0d1117; padding: 0.5rem; border-radius: 4px;">
                                <small style="color: var(--primary)">X-AXIS / ROWS</small>
                                <div>${s.ikea_guide.step_3_axes.x_axis}</div>
                            </div>
                            <div style="background: #0d1117; padding: 0.5rem; border-radius: 4px;">
                                <small style="color: var(--primary)">Y-AXIS / VALUES</small>
                                <div>${s.ikea_guide.step_3_axes.y_axis}</div>
                            </div>
                            ${s.ikea_guide.step_3_axes.break_by ? `
                            <div style="background: #0d1117; padding: 0.5rem; border-radius: 4px; grid-column: span 2;">
                                <small style="color: var(--primary)">BREAK DOWN BY</small>
                                <div>${s.ikea_guide.step_3_axes.break_by}</div>
                            </div>` : ''}
                        </div>
                    </div>
                </div>

                <div class="step-card">
                    <div class="step-num">4</div>
                    <div class="step-content">
                        <strong>Visualization & Maths</strong>
                        <p>${s.ikea_guide.step_4_visualization} • ${s.ikea_guide.step_5_values}</p>
                    </div>
                </div>
            </div>

            <div style="margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border-color); display: flex; gap: 1rem; align-items: center;">
                 <button class="btn btn-primary" onclick="window.open('https://app.hubspot.com/reports-list', '_blank')">
                    Open HubSpot Report Builder
                </button>
                <details style="flex: 1;">
                    <summary style="cursor: pointer; color: var(--text-dim); font-size: 0.75rem;">Technical Data</summary>
                    <pre style="background: #000; padding: 0.5rem; border-radius: 4px; font-size: 0.7rem; margin-top: 0.5rem;"><code>${s.properties_used.join(', ')}</code></pre>
                </details>
            </div>
        </div>
    `).join('');
}
// Attach listeners for create buttons
document.querySelectorAll('.create-report-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
        const idx = e.target.dataset.idx;
        const payload = suggestions[idx].apiPayload;

        showLoader('Creating report in HubSpot...');
        try {
            const response = await fetch('http://localhost:3001/api/hubspot/create-report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: hsToken, payload })
            });
            const result = await response.json();
            if (result.error) throw new Error(JSON.stringify(result.error));

            alert('Success! Report created with ID: ' + (result.id || 'N/A'));
        } catch (err) {
            console.error(err);
            alert('Report Creation Failed: ' + err.message);
        } finally {
            hideLoader();
        }
    });
});

function showLoader(text) {
    loaderText.innerText = text;
    loader.classList.remove('hidden');
}

function hideLoader() {
    loader.classList.add('hidden');
}
