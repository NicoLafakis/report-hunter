import './index.css'

const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';

let user = null;
let hsToken = '';
let openAIKey = '';
let availableObjects = [];
let selectedObjects = [];
let propertiesMap = {}; // { objectType: [properties] }
let selectedProperties = []; // [{ objectType, name, label }]
let visibleProperties = []; // [{ objectType, name, label }]
let businessProfile = null;
let suggestions = []; // Store generated suggestions for state persistence

let storyPath = {
    business_focus: null,
    metric_type: null,
    comparison_dimension: null,
    output_format: null
};

// --- AUTH & STATE LOGIC ---

async function checkAuth() {
    try {
        const res = await fetch(`${API_BASE}/api/auth/me`, { credentials: 'include' });
        if (res.ok) {
            user = await res.json();
            onLoginSuccess();
        } else {
            showAuthOverlay();
        }
    } catch (err) {
        showAuthOverlay();
    }
}

function showAuthOverlay() {
    document.getElementById('auth-overlay').classList.remove('hidden');
    document.getElementById('floating-menu-btn').classList.add('hidden');
}

function onLoginSuccess() {
    document.getElementById('auth-overlay').classList.add('hidden');
    document.getElementById('floating-menu-btn').classList.remove('hidden');
    document.getElementById('user-email-display').innerText = user.email;

    if (user.hubspot_token) {
        hsToken = user.hubspot_token;
        document.getElementById('profile-hubspot-token').value = hsToken;
        document.getElementById('hubspot-token').value = hsToken;
    }

    if (user.current_state) {
        restoreState(user.current_state);
    }
}

async function saveState() {
    if (!user) return;
    const state = {
        hsToken,
        selectedObjects,
        selectedProperties,
        businessProfile,
        storyPath,
        suggestions
    };
    await fetch(`${API_BASE}/api/user/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state }),
        credentials: 'include'
    });
}

function restoreState(state) {
    if (!state) return;
    hsToken = state.hsToken || '';
    selectedObjects = state.selectedObjects || [];
    selectedProperties = state.selectedProperties || [];
    businessProfile = state.businessProfile || null;
    storyPath = state.storyPath || { business_focus: null, metric_type: null, comparison_dimension: null, output_format: null };
    suggestions = state.suggestions || [];

    if (hsToken) {
        // If we have a token and selected objects, we can skip the setup
        if (selectedObjects.length > 0) {
            setupSection.classList.add('hidden');
            selectionSection.classList.remove('hidden');
            // Re-fetch objects to populate the list
            fetchObjects().then(() => {
                renderObjectList();
                updateSelectionUI();
                if (selectedProperties.length > 0) {
                    if (businessProfile) {
                        renderBusinessProfile();
                        storySection.classList.remove('hidden');
                        // In a real app we'd restore story steps here too
                    }
                }
                if (suggestions.length > 0) {
                    renderSuggestions(suggestions);
                    resultsSection.classList.remove('hidden');
                }
            });
        }
    }
}

// UI Event Listeners for Auth
async function loadCaptcha() {
    const container = document.getElementById('captcha-container');
    container.innerHTML = 'Loading...';
    try {
        const res = await fetch(`${API_BASE}/api/auth/captcha?t=${Date.now()}`, { credentials: 'include' });
        const svg = await res.text();
        container.innerHTML = svg;
    } catch (err) {
        container.innerHTML = '<small style="color:red">Failed to load</small>';
    }
}

document.getElementById('captcha-container').onclick = loadCaptcha;

document.getElementById('show-signup').onclick = (e) => {
    e.preventDefault();
    document.getElementById('login-form').classList.add('hidden');
    document.getElementById('signup-form').classList.remove('hidden');
    loadCaptcha();
};
document.getElementById('show-login').onclick = (e) => {
    e.preventDefault();
    document.getElementById('signup-form').classList.add('hidden');
    document.getElementById('login-form').classList.remove('hidden');
};

document.getElementById('login-btn').onclick = async () => {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'include'
    });
    const data = await res.json();
    if (res.ok) {
        user = { email, ...data };
        onLoginSuccess();
    } else {
        alert(data.error);
    }
};

document.getElementById('signup-btn').onclick = async () => {
    const email = document.getElementById('signup-email').value;
    const password = document.getElementById('signup-password').value;
    const confirmPassword = document.getElementById('signup-confirm-password').value;
    const captcha = document.getElementById('signup-captcha').value;

    if (!email || !password || !confirmPassword || !captcha) {
        return alert('Please fill in all fields');
    }

    if (password !== confirmPassword) {
        return alert('Passwords do not match');
    }

    const res = await fetch(`${API_BASE}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, confirmPassword, captcha }),
        credentials: 'include'
    });
    const data = await res.json();
    if (res.ok) {
        user = { email };
        onLoginSuccess();
    } else {
        alert(data.error);
        loadCaptcha(); // Refresh captcha on failure
    }
};

document.getElementById('logout-btn').onclick = async () => {
    await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' });
    window.location.reload();
};

// Profile Drawer Logic
const floatingBtn = document.getElementById('floating-menu-btn');
const drawer = document.getElementById('profile-drawer');
const drawerOverlay = document.getElementById('drawer-overlay');

floatingBtn.onclick = () => {
    drawer.classList.add('open');
    drawerOverlay.classList.add('open');
};

const closeDrawer = () => {
    drawer.classList.remove('open');
    drawerOverlay.classList.remove('open');
};
document.getElementById('close-drawer').onclick = closeDrawer;
drawerOverlay.onclick = closeDrawer;

document.getElementById('save-profile-btn').onclick = async () => {
    const newToken = document.getElementById('profile-hubspot-token').value;
    const res = await fetch(`${API_BASE}/api/user/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hubspotToken: newToken }),
        credentials: 'include'
    });
    if (res.ok) {
        hsToken = newToken;
        document.getElementById('hubspot-token').value = hsToken;
        alert('Profile saved!');
        closeDrawer();
    }
};

document.getElementById('reset-session-btn').onclick = async () => {
    if (confirm('Are you sure you want to reset your session? All selections will be cleared.')) {
        await fetch(`${API_BASE}/api/user/reset`, { method: 'POST', credentials: 'include' });
        window.location.reload();
    }
};

// Store generated suggestions for state persistence
const storyStepMeta = {
    business_focus: {
        title: 'Business Focus',
        emoji: '🎯',
        description: 'What area of the business should we analyze?'
    },
    metric_type: {
        title: 'Metric Type',
        emoji: '📊',
        description: 'What kind of measurements make sense here?'
    },
    comparison_dimension: {
        title: 'Comparison Dimension',
        emoji: '🔀',
        description: 'How should we slice and segment the data?'
    },
    output_format: {
        title: 'Output Format',
        emoji: '📋',
        description: 'How should we present the insights?'
    }
};

const storyStepOrder = ['business_focus', 'metric_type', 'comparison_dimension', 'output_format'];

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
const storySection = document.getElementById('story-section');
const resultsSection = document.getElementById('results-section');
const loader = document.getElementById('loader');
const loaderText = document.getElementById('loader-text');

// 1. Connect and Fetch Objects
async function fetchObjects() {
    try {
        const response = await fetch(`${API_BASE}/api/hubspot/objects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: hsToken }),
            credentials: 'include'
        });
        const objects = await response.json();
        if (objects.error) throw new Error(objects.error);
        availableObjects = objects;
    } catch (err) {
        alert('Connection failed: ' + err.message);
    }
}

document.getElementById('connect-btn').addEventListener('click', async () => {
    hsToken = document.getElementById('hubspot-token').value;
    openAIKey = document.getElementById('openai-key').value;

    if (!hsToken) return alert('Please enter a HubSpot Token');

    showLoader('Connecting to HubSpot...');
    try {
        await fetchObjects();
        renderObjectList();
        setupSection.classList.add('hidden');
        selectionSection.classList.remove('hidden');
        saveState(); // PERSIST
    } catch (err) {
        // already alerted in fetchObjects
    } finally {
        hideLoader();
    }
});

// Initial Auth Check
checkAuth();

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
        const response = await fetch(`${API_BASE}/api/hubspot/properties`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: hsToken, objectTypes: selectedObjects }),
            credentials: 'include'
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
                visibleProperties.push({ objectType: objType, name: prop.name, label: prop.label, type: prop.type });
                const label = document.createElement('label');
                label.className = 'property-item';
                const isChecked = selectedProperties.some(sp => sp.objectType === objType && sp.name === prop.name);
                label.innerHTML = `
                    <input type="checkbox" class="prop-checkbox" data-obj="${objType}" data-name="${prop.name}" data-label="${prop.label}" data-type="${prop.type || ''}" ${isChecked ? 'checked' : ''}>
                    <span>${prop.label} <small style="color:var(--text-dim)">(${prop.name})</small></span>
                `;
                group.appendChild(label);
            });
            container.appendChild(group);
        }
    });

    document.querySelectorAll('.prop-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const { obj, name, label, type } = e.target.dataset;
            if (e.target.checked) {
                if (!selectedProperties.some(sp => sp.objectType === obj && sp.name === name)) {
                    selectedProperties.push({ objectType: obj, name, label, type });
                }
            } else {
                selectedProperties = selectedProperties.filter(sp => !(sp.objectType === obj && sp.name === name));
            }
            updateSelectedCount();
            saveState();
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

// 3. NEW: Business Profile Inference (runs before story journey)
async function inferBusinessProfile() {
    showLoader('🔍 Analyzing properties to understand your business context...');
    try {
        const response = await fetch(`${API_BASE}/api/ai/profile-inference`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                openaiKey: openAIKey,
                properties: selectedProperties,
                selectedObjects: selectedObjects
            }),
            credentials: 'include'
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Server error');

        businessProfile = data;
        displayBusinessProfileSummary(data);
        return data;
    } catch (err) {
        console.warn('Profile inference failed, continuing without:', err.message);
        businessProfile = null;
        return null;
    } finally {
        hideLoader();
    }
}

// NEW: Display the inferred business profile to the user
function displayBusinessProfileSummary(profile) {
    const container = document.getElementById('story-steps-container');

    if (!profile || !profile.inferred_profile) {
        container.innerHTML = `
            <div class="glass-card" style="margin-bottom: 1.5rem; background: rgba(255, 193, 7, 0.1); border-color: rgba(255, 193, 7, 0.3);">
                <p style="margin: 0; color: var(--text-dim);">
                    ⚠️ Could not infer business context from properties. Proceeding with generic options.
                </p>
            </div>
        `;
        return;
    }

    const { inferred_profile, data_richness, business_questions_possible } = profile;

    container.innerHTML = `
        <div class="glass-card" style="margin-bottom: 1.5rem; background: rgba(var(--primary-rgb), 0.05); border-color: rgba(var(--primary-rgb), 0.2);">
            <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem;">
                <span style="font-size: 1.5rem;">🔮</span>
                <h4 style="margin: 0; color: var(--primary);">Business Context Detected</h4>
                <span class="selected-badge" style="font-size: 0.7rem;">${inferred_profile.industry_confidence?.toUpperCase() || 'MEDIUM'} CONFIDENCE</span>
            </div>
            
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1rem;">
                <div style="background: var(--bg-color); padding: 0.75rem; border-radius: 6px;">
                    <small style="color: var(--text-dim); text-transform: uppercase; font-size: 0.7rem;">Industry</small>
                    <div style="font-weight: 600; margin-top: 0.25rem;">${inferred_profile.industry || 'Unknown'}</div>
                    ${inferred_profile.industry_signals ? `<small style="color: var(--text-dim);">Signals: ${inferred_profile.industry_signals.slice(0, 3).join(', ')}</small>` : ''}
                </div>
                <div style="background: var(--bg-color); padding: 0.75rem; border-radius: 6px;">
                    <small style="color: var(--text-dim); text-transform: uppercase; font-size: 0.7rem;">Sales Motion</small>
                    <div style="font-weight: 600; margin-top: 0.25rem; text-transform: capitalize;">${inferred_profile.sales_motion || 'Unknown'}</div>
                </div>
                <div style="background: var(--bg-color); padding: 0.75rem; border-radius: 6px;">
                    <small style="color: var(--text-dim); text-transform: uppercase; font-size: 0.7rem;">Data Maturity</small>
                    <div style="font-weight: 600; margin-top: 0.25rem; text-transform: capitalize;">${inferred_profile.operational_maturity || 'Unknown'}</div>
                </div>
                <div style="background: var(--bg-color); padding: 0.75rem; border-radius: 6px;">
                    <small style="color: var(--text-dim); text-transform: uppercase; font-size: 0.7rem;">Richest Data</small>
                    <div style="font-weight: 600; margin-top: 0.25rem; text-transform: capitalize;">${data_richness?.strongest_object || 'N/A'}</div>
                </div>
            </div>

            ${business_questions_possible && business_questions_possible.length > 0 ? `
                <details style="margin-top: 0.5rem;">
                    <summary style="cursor: pointer; color: var(--text-dim); font-size: 0.85rem;">
                        📋 ${business_questions_possible.length} answerable questions detected
                    </summary>
                    <ul style="margin: 0.5rem 0 0 1.5rem; color: var(--text-dim); font-size: 0.85rem;">
                        ${business_questions_possible.slice(0, 5).map(q => `<li style="margin-bottom: 0.25rem;">${q}</li>`).join('')}
                    </ul>
                </details>
            ` : ''}
        </div>
    `;
}

// 4. Start Journey - Now includes profile inference
document.getElementById('start-journey-btn').addEventListener('click', async () => {
    document.getElementById('story-section').classList.remove('hidden');
    document.getElementById('story-section').scrollIntoView({ behavior: 'smooth' });

    // Reset story path
    storyPath = {
        business_focus: null,
        metric_type: null,
        comparison_dimension: null,
        output_format: null
    };

    // First, infer business profile
    await inferBusinessProfile();

    // Then start the COYA journey
    fetchStoryStep('business_focus');
});

// 5. UPDATED: Story Step Fetching
async function fetchStoryStep(step) {
    const container = document.getElementById('story-steps-container');
    const meta = storyStepMeta[step];
    showLoader(`${meta.emoji} ${meta.description}`);

    try {
        const response = await fetch(`${API_BASE}/api/ai/story-options`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                openaiKey: openAIKey,
                properties: selectedProperties,
                selectedObjects: selectedObjects,
                currentStep: step,
                previousChoices: storyPath,
                businessProfile: businessProfile
            }),
            credentials: 'include'
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

// 6. UPDATED: Render Story Step with enhanced UI
function renderStoryStep(step, options) {
    const container = document.getElementById('story-steps-container');
    const meta = storyStepMeta[step];
    const stepIndex = storyStepOrder.indexOf(step);

    // If this is the first step after profile, keep the profile summary
    // Otherwise, we're adding to existing steps
    if (step === 'business_focus') {
        // Keep any existing profile summary, just add after it
        const existingProfile = container.querySelector('.glass-card');
        if (existingProfile) {
            // Profile exists, add after it
        } else {
            // No profile, start fresh
        }
    }

    // Remove any steps after this one (in case user is re-selecting)
    const existingSteps = container.querySelectorAll('.story-step');
    existingSteps.forEach(el => {
        const elStep = el.dataset.step;
        if (storyStepOrder.indexOf(elStep) >= stepIndex) {
            el.remove();
        }
    });

    // Clear selections for this step and all after
    storyStepOrder.slice(stepIndex).forEach(s => {
        storyPath[s] = null;
    });

    // Hide the final button
    document.getElementById('story-final-btn-container').classList.add('hidden');

    const stepDiv = document.createElement('div');
    stepDiv.className = 'story-step';
    stepDiv.dataset.step = step;

    stepDiv.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem;">
            <div style="background: var(--primary); color: var(--btn-text); width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.9rem;">
                ${stepIndex + 1}
            </div>
            <div>
                <h4 style="margin: 0; color: var(--primary);">${meta.title}</h4>
                <small style="color: var(--text-dim);">${meta.description}</small>
            </div>
        </div>
        <div class="choice-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem;">
            ${options.map(opt => `
                <button class="choice-card" data-step="${step}" data-id="${opt.id}" data-label="${opt.label}">
                    <strong style="display: block; margin-bottom: 0.3rem;">${opt.label}</strong>
                    <p style="font-size: 0.8rem; margin: 0; color: var(--text-dim);">${opt.description}</p>
                    ${opt.grounding_properties ? `
                        <div style="margin-top: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.25rem;">
                            ${opt.grounding_properties.slice(0, 3).map(p => `
                                <span style="background: rgba(var(--primary-rgb), 0.15); color: var(--primary); padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.65rem;">${p}</span>
                            `).join('')}
                        </div>
                    ` : ''}
                    ${opt.example_question ? `
                        <div style="margin-top: 0.5rem; font-style: italic; font-size: 0.75rem; color: var(--text-dim);">
                            "${opt.example_question}"
                        </div>
                    ` : ''}
                    ${opt.example_report ? `
                        <div style="margin-top: 0.5rem; font-style: italic; font-size: 0.75rem; color: var(--text-dim);">
                            → ${opt.example_report}
                        </div>
                    ` : ''}
                </button>
            `).join('')}
        </div>
    `;

    container.appendChild(stepDiv);

    // Attach click handlers
    stepDiv.querySelectorAll('.choice-card').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const card = e.currentTarget;
            const chosenId = card.dataset.id;
            const chosenLabel = card.dataset.label;

            // Highlight choice
            stepDiv.querySelectorAll('.choice-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');

            storyPath[step] = chosenLabel;
            saveState();

            // Determine next step
            const nextStepIndex = stepIndex + 1;
            if (nextStepIndex < storyStepOrder.length) {
                fetchStoryStep(storyStepOrder[nextStepIndex]);
            } else {
                // All steps complete - show final button
                document.getElementById('story-final-btn-container').classList.remove('hidden');
                document.getElementById('story-final-btn-container').scrollIntoView({ behavior: 'smooth' });
            }
        });
    });
}

// 7. Final Hunt - Now includes all new context
document.getElementById('get-suggestions-btn').addEventListener('click', async () => {
    showLoader('🔍 AI is hunting for story-driven report configurations...');
    try {
        const response = await fetch(`${API_BASE}/api/ai/suggest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                openaiKey: openAIKey,
                properties: selectedProperties,
                selectedObjects: selectedObjects,
                storyContext: storyPath,
                businessProfile: businessProfile
            }),
            credentials: 'include'
        });
        const data = await response.json();
        suggestions = data; // Save to global for state persistence
        if (!response.ok) throw new Error(suggestions.error || 'Server error');
        if (!Array.isArray(suggestions)) throw new Error('Expected an array of suggestions');

        renderSuggestions(suggestions);
        const resultsSection = document.getElementById('results-section');
        resultsSection.classList.remove('hidden');
        resultsSection.scrollIntoView({ behavior: 'smooth' });
        saveState();
    } catch (err) {
        alert('AI Suggestion failed: ' + err.message);
    } finally {
        hideLoader();
    }
});

// 8. UPDATED: Render Suggestions with enhanced structure (Accordion Mode)
function renderSuggestions(suggestions) {
    const container = document.getElementById('suggestions-container');

    // Group by confidence
    const highConfidence = suggestions.filter(s => s.confidence === 'high');
    const mediumConfidence = suggestions.filter(s => s.confidence === 'medium');
    const lowConfidence = suggestions.filter(s => s.confidence === 'low' || !s.confidence);

    const renderGroup = (reports, title, emoji, isFirstAvailableGroup) => {
        if (reports.length === 0) return '';
        return `
            <div style="margin-bottom: 2rem;">
                <h3 style="color: var(--text-dim); margin-bottom: 1rem; font-size: 1rem;">
                    ${emoji} ${title} (${reports.length})
                </h3>
                <div class="accordion-group">
                    ${reports.map((s, idx) => renderReportCard(s, idx, isFirstAvailableGroup && idx === 0)).join('')}
                </div>
            </div>
        `;
    };

    container.innerHTML = `
        <div style="margin-bottom: 2rem; padding: 1rem; background: rgba(var(--primary-rgb), 0.05); border-radius: 8px; border: 1px solid rgba(var(--primary-rgb), 0.2);">
            <div style="display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;">
                <span style="font-size: 1.5rem;">📊</span>
                <div style="flex: 1;">
                    <strong>Your Reporting Story</strong>
                    <div style="font-size: 0.85rem; color: var(--text-dim); margin-top: 0.25rem;">
                        ${storyPath.business_focus || 'Discovery'} → ${storyPath.metric_type || 'Analysis'} → ${storyPath.comparison_dimension || 'Insight'} → ${storyPath.output_format || 'Report'}
                    </div>
                </div>
                <span class="selected-badge">${suggestions.length} REPORTS</span>
            </div>
        </div>
        ${renderGroup(highConfidence, 'Ready to Build', '✅', true)}
        ${renderGroup(mediumConfidence, 'May Need Adjustment', '⚠️', highConfidence.length === 0)}
        ${renderGroup(lowConfidence, 'Requires Additional Properties', '📝', highConfidence.length === 0 && mediumConfidence.length === 0)}
    `;

    // Attach Accordion Toggle Logic
    const toggleLinks = container.querySelectorAll('.report-header');
    toggleLinks.forEach(header => {
        header.addEventListener('click', () => {
            const currentCard = header.closest('.report-suggestion');
            const currentContent = currentCard.querySelector('.report-content');
            const currentIcon = header.querySelector('.accordion-icon');

            const isCurrentlyHidden = currentContent.classList.contains('hidden');

            // Collapse all reports in the entire suggestions container
            container.querySelectorAll('.report-content').forEach(content => {
                content.classList.add('hidden');
            });
            container.querySelectorAll('.accordion-icon').forEach(icon => {
                icon.innerText = '▼';
            });

            // If it was hidden, expand it
            if (isCurrentlyHidden) {
                currentContent.classList.remove('hidden');
                currentIcon.innerText = '▲';
                // Scroll into view if needed
                currentCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        });
    });
}

function renderReportCard(s, idx, isExpanded) {
    const confidenceColors = {
        high: 'rgba(63, 185, 80, 0.15)',
        medium: 'rgba(255, 193, 7, 0.15)',
        low: 'rgba(255, 122, 89, 0.15)'
    };
    const confidenceBorder = {
        high: 'rgba(63, 185, 80, 0.3)',
        medium: 'rgba(255, 193, 7, 0.3)',
        low: 'rgba(255, 122, 89, 0.3)'
    };

    return `
        <div class="report-suggestion" style="border-left: 3px solid ${confidenceBorder[s.confidence] || confidenceBorder.medium}; padding: 0; overflow: hidden;">
            <div class="report-header" style="padding: 1.5rem; cursor: pointer; display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; transition: background 0.2s;">
                <div style="flex: 1;">
                    <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.25rem;">
                         <h3 style="margin: 0; color: var(--primary); font-size: 1.1rem;">${s.title}</h3>
                         <span class="selected-badge" style="font-size: 0.6rem; background: ${confidenceColors[s.confidence] || confidenceColors.medium}; white-space: nowrap; padding: 0.1rem 0.4rem;">
                            ${s.confidence?.toUpperCase() || 'MEDIUM'}
                        </span>
                    </div>
                    <p style="color: var(--text-dim); margin: 0; font-size: 0.9rem;">${s.business_question}</p>
                </div>
                <span class="accordion-icon" style="color: var(--primary); font-size: 1.2rem; font-weight: bold;">
                    ${isExpanded ? '▲' : '▼'}
                </span>
            </div>
            
            <div class="report-content ${isExpanded ? '' : 'hidden'}" style="padding: 0 1.5rem 1.5rem 1.5rem;">
                ${s.why_this_matters ? `
                    <p style="background: var(--bg-color); padding: 0.5rem 0.75rem; border-radius: 4px; font-size: 0.85rem; margin-bottom: 1rem;">
                        💡 ${s.why_this_matters}
                    </p>
                ` : ''}

                ${s.confidence_note && s.confidence !== 'high' ? `
                    <p style="background: ${confidenceColors[s.confidence]}; padding: 0.5rem 0.75rem; border-radius: 4px; font-size: 0.8rem; margin-bottom: 1rem; border: 1px solid ${confidenceBorder[s.confidence]};">
                        ⚠️ ${s.confidence_note}
                    </p>
                ` : ''}

                ${s.breeze_prompt ? `
                    <div style="margin-bottom: 1.5rem; background: rgba(var(--primary-rgb), 0.1); border: 1px dashed var(--primary); padding: 1rem; border-radius: 8px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; gap: 1rem;">
                            <span style="font-size: 0.75rem; font-weight: 700; color: var(--primary); text-transform: uppercase; letter-spacing: 0.05em;">🌬️ Breeze AI Prompt</span>
                            <button class="btn" style="padding: 0.2rem 0.5rem; font-size: 0.7rem; white-space: nowrap;" onclick="event.stopPropagation(); copyToClipboard(this, \`${s.breeze_prompt.replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`)">
                                Copy Prompt
                            </button>
                        </div>
                        <p style="margin: 0; font-size: 0.9rem; font-style: italic; color: var(--text-color); line-height: 1.4;">
                            "${s.breeze_prompt}"
                        </p>
                    </div>
                ` : ''}

                <div class="ikea-steps" style="display: grid; gap: 0.75rem;">
                    <div class="step-card">
                        <div class="step-num">1</div>
                        <div class="step-content">
                            <strong>Data Source</strong>
                            <p>${s.ikea_guide.step_1_data_source.instruction}</p>
                            <div style="margin-top: 0.5rem; font-size: 0.8rem;">
                                <span style="background: var(--bg-color); padding: 0.2rem 0.5rem; border-radius: 3px; margin-right: 0.25rem;">
                                    ${s.ikea_guide.step_1_data_source.primary_object}
                                </span>
                                ${s.ikea_guide.step_1_data_source.secondary_objects?.map(o => `
                                    <span style="background: var(--bg-color); padding: 0.2rem 0.5rem; border-radius: 3px; margin-right: 0.25rem;">+ ${o}</span>
                                `).join('') || ''}
                            </div>
                        </div>
                    </div>

                    <div class="step-card">
                        <div class="step-num">2</div>
                        <div class="step-content">
                            <strong>Filters</strong>
                            <p>${s.ikea_guide.step_2_filters.instruction}</p>
                            ${s.ikea_guide.step_2_filters.filters?.length > 0 ? `
                                <div style="margin-top: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.5rem;">
                                    ${s.ikea_guide.step_2_filters.filters.map(f => `
                                        <code style="background: var(--bg-color); padding: 0.2rem 0.5rem; border-radius: 3px; font-size: 0.75rem;">
                                            ${f.property_label} ${f.operator} ${f.value}
                                        </code>
                                    `).join('')}
                                </div>
                            ` : ''}
                        </div>
                    </div>

                    <div class="step-card">
                        <div class="step-num">3</div>
                        <div class="step-content">
                            <strong>Configure Axes</strong>
                            <p>${s.ikea_guide.step_3_configure.instruction}</p>
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.5rem; font-size: 0.8rem;">
                                <div style="background: var(--bg-color); padding: 0.5rem; border-radius: 4px;">
                                    <small style="color: var(--primary); text-transform: uppercase; font-size: 0.65rem;">X-Axis / Rows</small>
                                    <div>${s.ikea_guide.step_3_configure.x_axis_or_rows?.property_label || 'N/A'}</div>
                                    <small style="color: var(--text-dim);">${s.ikea_guide.step_3_configure.x_axis_or_rows?.grouping || ''}</small>
                                </div>
                                <div style="background: var(--bg-color); padding: 0.5rem; border-radius: 4px;">
                                    <small style="color: var(--primary); text-transform: uppercase; font-size: 0.65rem;">Y-Axis / Values</small>
                                    <div>${s.ikea_guide.step_3_configure.y_axis_or_values?.aggregation || 'Count'}</div>
                                    <small style="color: var(--text-dim);">${s.ikea_guide.step_3_configure.y_axis_or_values?.property_label || 'Records'}</small>
                                </div>
                                ${s.ikea_guide.step_3_configure.break_down_by?.property ? `
                                    <div style="background: var(--bg-color); padding: 0.5rem; border-radius: 4px; grid-column: span 2;">
                                        <small style="color: var(--primary); text-transform: uppercase; font-size: 0.65rem;">Break Down By</small>
                                        <div>${s.ikea_guide.step_3_configure.break_down_by.property_label}</div>
                                    </div>
                                ` : ''}
                            </div>
                        </div>
                    </div>

                    <div class="step-card">
                        <div class="step-num">4</div>
                        <div class="step-content">
                            <strong>Visualize</strong>
                            <p>${s.ikea_guide.step_4_visualize.instruction}</p>
                            <div style="margin-top: 0.5rem;">
                                <span style="background: var(--primary); color: var(--btn-text); padding: 0.25rem 0.75rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600;">
                                    ${s.ikea_guide.step_4_visualize.chart_type}
                                </span>
                                <small style="color: var(--text-dim); margin-left: 0.5rem;">${s.ikea_guide.step_4_visualize.why_this_chart}</small>
                            </div>
                        </div>
                    </div>
                </div>

                ${s.quick_variations && s.quick_variations.length > 0 ? `
                    <div style="margin-top: 1rem; padding: 0.75rem; background: rgba(var(--primary-rgb), 0.05); border-radius: 6px;">
                        <small style="color: var(--primary); font-weight: 600;">💡 Quick Variations</small>
                        <ul style="margin: 0.5rem 0 0 1rem; padding: 0; font-size: 0.8rem; color: var(--text-dim);">
                            ${s.quick_variations.map(v => `<li>${v}</li>`).join('')}
                        </ul>
                    </div>
                ` : ''}

                <div style="margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--border-color); display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;">
                    <button class="btn btn-primary" onclick="window.open('https://app.hubspot.com/reports-list', '_blank')">
                        Open HubSpot Report Builder
                    </button>
                    <details style="flex: 1; min-width: 200px;">
                        <summary style="cursor: pointer; color: var(--text-dim); font-size: 0.75rem;">Properties Used (${s.properties_used?.length || 0})</summary>
                        <div style="margin-top: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.25rem;">
                            ${s.properties_used?.map(p => `
                                <code style="background: var(--bg-color); padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.7rem;">${p}</code>
                            `).join('') || 'None specified'}
                        </div>
                    </details>
                </div>
            </div>
        </div>
    `;
}

function showLoader(text) {
    loaderText.innerText = text;
    loader.classList.remove('hidden');
}

function hideLoader() {
    loader.classList.add('hidden');
}

// Global utility for clipboard
window.copyToClipboard = (btn, text) => {
    navigator.clipboard.writeText(text).then(() => {
        const originalText = btn.innerText;
        btn.innerText = 'Copied!';
        btn.style.background = 'var(--primary)';
        btn.style.color = 'white';
        setTimeout(() => {
            btn.innerText = originalText;
            btn.style.background = '';
            btn.style.color = '';
        }, 2000);
    });
};