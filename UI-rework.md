Here is the comprehensive design and implementation document. You can feed this directly to an AI agent or developer to execute the changes.

---

# Design & Implementation Plan: Scene Summariser UI Restructure

## 1. Problem Statement

The current user interface for the **SillyTavern-SceneSummariser** extension is functional but "awful" in terms of usability. Snapshots are listed in a raw format that is hard to scan, and actions (View/Edit) rely on clunky browser prompts or unstyled text areas.

The user explicitly wants to mirror the **Lorebook / World Info** UI pattern:

* **Visuals:** Collapsible "accordion" rows for each snapshot.
* **Hierarchy:** A header showing the title and metadata, expanding to reveal the full content and actions.
* **Usability:** Inline editing and clearer action buttons (Regenerate, Copy, Delete).

## 2. Proposed Solution

We will completely rewrite the rendering logic for the snapshot list (`renderSnapshotsList`) and the HTML structure in `settings.html`.

### Key Changes

1. **CSS Styling:** We will inject custom CSS into `settings.html` that replicates the classes used by the Lorebook (e.g., darker headers, lighter bodies, caret icons for expansion) without relying on SillyTavern's internal, potentially changing CSS classes.
2. **Accordion Logic:** We will implement simple event delegation in `index.js` to toggle an `.expanded` class on list items when clicked.
3. **Inline Editing:** Instead of `window.prompt()`, the expanded body will contain a `<textarea>`. The "Edit" button will be replaced by a "Save" button that reads directly from this input.

---

## 3. Implementation Code

### File 1: `data/default-user/extensions/SillyTavern-SceneSummariser/settings.html`

**Action:** Replace the entire content of the file with the code below. This includes the new CSS styles and the restructured container div.

```html
<style>
    /* Lorebook-style Accordion CSS for Scene Summariser */
    .ss-snapshot-item {
        background-color: var(--grey30); /* Standard panel bg */
        border: 1px solid var(--grey40);
        margin-bottom: 5px;
        border-radius: 5px;
        overflow: hidden;
    }

    .ss-snapshot-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 10px;
        background-color: var(--grey20); /* Darker header */
        cursor: pointer;
        user-select: none;
        transition: background-color 0.2s;
    }

    .ss-snapshot-header:hover {
        background-color: var(--grey40);
    }

    .ss-snapshot-header-left {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-grow: 1;
        overflow: hidden;
    }

    .ss-caret {
        transition: transform 0.2s;
        color: var(--grey70);
    }

    /* Rotate caret when parent has 'expanded' class */
    .ss-snapshot-item.expanded .ss-caret {
        transform: rotate(90deg);
    }

    .ss-snapshot-title {
        font-weight: bold;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .ss-snapshot-meta {
        font-size: 0.85em;
        color: var(--grey70);
        margin-left: auto;
        margin-right: 10px;
    }

    .ss-snapshot-body {
        display: none;
        padding: 10px;
        background-color: var(--grey10); /* Darker body for contrast */
        border-top: 1px solid var(--grey40);
    }

    .ss-snapshot-item.expanded .ss-snapshot-body {
        display: block;
    }

    .ss-action-bar {
        display: flex;
        gap: 5px;
        margin-top: 10px;
        flex-wrap: wrap;
    }

    .ss-delete-icon {
        color: var(--smart-theme-red);
        opacity: 0.7;
        transition: opacity 0.2s;
    }
    .ss-delete-icon:hover { opacity: 1; }
    
    .ss-header-buttons {
        margin-left: auto;
    }
</style>

<div id="ss_drawer" class="inline-drawer SillyTavern-SceneSummariser-settingslist">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>Scene Summariser</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down right"></div>
    </div>
    
    <div class="inline-drawer-content">
        <div class="setting_item" style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom: 10px;">
            <label style="display:flex; align-items:center; gap:8px; margin:0;">
                <input type="checkbox" id="ss_enabled" name="enabled" class="ss-setting-input">
                <span>Enable</span>
            </label>
            <div class="ss-header-buttons" style="display:flex; gap:5px; flex-wrap:wrap;">
                <button type="button" class="menu_button" data-ss-action="toggle-settings"><i class="fa-solid fa-gear"></i> Settings</button>
                <button type="button" class="menu_button" data-ss-action="toggle-summary"><i class="fa-solid fa-list"></i> Snapshots</button>
            </div>
        </div>

        <div id="ss_settings_panel" class="ss-panel" style="display:none; padding: 10px; background: var(--grey10); border-radius: 5px; margin-bottom: 10px;">
            <div class="settings_section">
                <h4>General & Generation</h4>
                <div class="setting_item">
                    <label>Summary Prompt</label>
                    <textarea id="ss_summaryPrompt" name="summaryPrompt" class="ss-setting-input text_pole" rows="3" placeholder="Prompt used to generate summaries..."></textarea>
                </div>
                <div class="setting_item">
                    <label>Word limit: <span id="ss_summaryWords_value"></span></label>
                    <input type="range" id="ss_summaryWords" name="summaryWords" class="ss-setting-input" min="50" max="1000" step="10">
                </div>
                <div class="setting_item">
                     <label>Max Snapshots History</label>
                     <input type="number" id="ss_maxSummaries" name="maxSummaries" class="ss-setting-input text_pole" min="1" max="50">
                </div>
                <hr>
                <h4>Injection</h4>
                <div class="setting_item">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <input type="checkbox" id="ss_injectEnabled" name="injectEnabled" class="ss-setting-input">
                        <label for="ss_injectEnabled">Inject active summary into prompt</label>
                    </div>
                </div>
                 <div class="setting_item">
                    <label>Injection Template</label>
                    <textarea id="ss_injectTemplate" name="injectTemplate" class="ss-setting-input text_pole" rows="2" placeholder="[Summary: {{summary}}]"></textarea>
                </div>
                <div class="setting_item">
                     <label>Position: </label>
                     <select id="ss_injectRole" name="injectRole" class="ss-setting-input text_pole select_compact">
                        <option value="0">System</option>
                        <option value="1">User</option>
                        <option value="2">Assistant</option>
                    </select>
                </div>
            </div>
        </div>

        <div id="ss_summary_panel" class="ss-panel">
            <div class="settings_section">
                <h4 style="display:flex; justify-content:space-between; align-items:center;">
                    Snapshots 
                    <small style="font-weight:normal; opacity:0.7; font-size: 0.8em;">(Newest first)</small>
                </h4>
                
                <div id="ss_snapshots_list" class="ss-snapshots-container"></div>
                
                <div id="ss_empty_state" class="ss-empty" style="display:none; text-align:center; padding:20px; color:var(--grey70); border: 1px dashed var(--grey40); border-radius: 5px;">
                    No snapshots found. Generate a summary to begin.
                </div>
            </div>
            
            <div class="settings_section" style="margin-top: 15px;">
                <h4>Current Injection Preview</h4>
                <textarea id="ss_currentSummary" class="text_pole" rows="3" readonly style="width: 100%; resize: vertical; opacity: 0.7; font-size: 0.9em;"></textarea>
                <small>This is the actual text currently visible to the AI (based on your history settings).</small>
            </div>
        </div>
    </div>
</div>

```

---

### File 2: `data/default-user/extensions/SillyTavern-SceneSummariser/index.js`

**Action:** Replace the specific UI handling functions (`bindSettingsUI`, `renderSnapshotsList`, `handleSnapshotAction`) within your existing file.

*Note: The Logic for `onSummariseClick`, `getChatState`, etc., remains the same. Only the UI functions below need replacing.*

```javascript
// [EXISTING CODE ABOVE...]

function bindSettingsUI(container) {
    if (!container) return;

    // 1. Standard Input Listeners (Checkbox, Range, Text)
    container.addEventListener('input', (event) => {
        const target = event.target;
        if (!target.classList?.contains('ss-setting-input')) return;

        const { name, type, value, checked } = target;
        if (!name) return;

        let newValue = value;
        if (type === 'checkbox') newValue = !!checked;
        else if (type === 'range' || type === 'number' || type === 'radio') newValue = Number(value);

        extension_settings[settingsKey][name] = newValue;

        // Update Slider Display
        if (name === 'summaryWords') {
            const display = container.querySelector('#ss_summaryWords_value');
            if (display) display.textContent = newValue;
        }

        saveSettingsDebounced();

        // Re-apply injection if configuration changes
        if (['injectEnabled', 'injectPosition', 'injectTemplate', 'injectRole'].includes(name)) {
            applyInjection();
        }
    });

    // 2. Click Delegation for Accordion & Actions
    container.addEventListener('click', async (event) => {
        // A. Toggle Main Panels (Settings vs Snapshots)
        const actionEl = event.target.closest('[data-ss-action]');
        if (actionEl) {
            const action = actionEl.dataset.ssAction;
            if (action === 'toggle-settings') togglePanel(container, '#ss_settings_panel');
            if (action === 'toggle-summary') togglePanel(container, '#ss_summary_panel');
            return;
        }

        // B. Accordion Expansion (Clicking the Header)
        const headerEl = event.target.closest('.ss-snapshot-header');
        // Do not expand if the user clicked an action button inside the header
        if (headerEl && !event.target.closest('.ss-no-propagate')) {
            const item = headerEl.closest('.ss-snapshot-item');
            item.classList.toggle('expanded');
            return;
        }

        // C. Snapshot Actions (Save, Regen, Copy, Delete)
        const snapBtn = event.target.closest('[data-snap-action]');
        if (snapBtn) {
            const action = snapBtn.dataset.snapAction;
            const id = Number(snapBtn.dataset.snapId);
            const chatState = getChatState();
            
            await handleSnapshotAction(action, id, chatState, container);
            
            // Refresh UI and Injection after action
            renderSnapshotsList(container, chatState, extension_settings[settingsKey]);
            const currentSummary = container.querySelector('#ss_currentSummary');
            if (currentSummary) currentSummary.value = buildSummaryText(chatState, extension_settings[settingsKey]);
            applyInjection();
            saveSettingsDebounced();
        }
    });

    // 3. Attach "Summarise Scene" Button Listener (if rendered externally)
    const summariseButton = container.querySelector('#ss_summarise_button');
    if (summariseButton) summariseButton.addEventListener('click', onSummariseClick);
}

function renderSnapshotsList(container, chatState, settings) {
    const list = container?.querySelector('#ss_snapshots_list');
    const emptyState = container?.querySelector('#ss_empty_state');
    if (!list) return;

    list.innerHTML = '';
    const snapshots = chatState?.snapshots || [];

    // Handle Empty State
    if (!snapshots.length) {
        if (emptyState) emptyState.style.display = 'block';
        return;
    } else {
        if (emptyState) emptyState.style.display = 'none';
    }

    // Render Snapshots: Reverse order (Newest first)
    [...snapshots].reverse().forEach((snap) => {
        const dateStr = new Date(snap.createdAt || Date.now()).toLocaleDateString();
        const wordCount = snap.text ? snap.text.split(/\s+/).length : 0;
        const title = snap.title || `Scene #${snap.id}`;

        const item = document.createElement('div');
        item.className = 'ss-snapshot-item'; // Styles defined in settings.html
        item.dataset.id = snap.id;

        item.innerHTML = `
            <div class="ss-snapshot-header">
                <div class="ss-snapshot-header-left">
                    <i class="fa-solid fa-caret-right ss-caret"></i>
                    <span class="ss-snapshot-title" title="${title}">${title}</span>
                </div>
                <div class="ss-snapshot-meta">
                    ${dateStr} · ${wordCount} words
                </div>
                <div class="ss-snapshot-header-actions ss-no-propagate">
                    <i class="fa-solid fa-trash ss-delete-icon" title="Delete Snapshot" data-snap-action="delete" data-snap-id="${snap.id}"></i>
                </div>
            </div>
            <div class="ss-snapshot-body">
                <div class="setting_item">
                    <textarea class="text_pole ss-snap-text" data-id="${snap.id}" rows="6" style="width:100%; font-size:0.9em; font-family:inherit;">${snap.text || ''}</textarea>
                </div>
                <div class="ss-action-bar">
                    <button class="menu_button" data-snap-action="save" data-snap-id="${snap.id}">
                        <i class="fa-solid fa-save"></i> Save Text
                    </button>
                    <button class="menu_button" data-snap-action="regen" data-snap-id="${snap.id}">
                        <i class="fa-solid fa-arrows-rotate"></i> Regenerate
                    </button>
                    <button class="menu_button" data-snap-action="copy" data-snap-id="${snap.id}">
                        <i class="fa-solid fa-copy"></i> Copy
                    </button>
                </div>
            </div>
        `;
        list.appendChild(item);
    });
}

async function handleSnapshotAction(action, snapshotId, chatState, container) {
    const settings = extension_settings[settingsKey];
    const snapIndex = chatState.snapshots.findIndex(s => s.id === snapshotId);
    if (snapIndex === -1) return;
    
    const snap = chatState.snapshots[snapIndex];

    if (action === 'delete') {
        if (confirm(`Are you sure you want to delete "${snap.title || 'this snapshot'}"?`)) {
            chatState.snapshots.splice(snapIndex, 1);
            logDebug('log', `Deleted snapshot ${snapshotId}`);
        }
    } 
    else if (action === 'save') {
        // Read directly from the textarea in the DOM
        const textarea = container.querySelector(`.ss-snap-text[data-id="${snapshotId}"]`);
        if (textarea) {
            snap.text = textarea.value;
            
            // Visual feedback on the button
            const btn = container.querySelector(`button[data-snap-action="save"][data-snap-id="${snapshotId}"]`);
            if (btn) {
                const originalHtml = btn.innerHTML;
                btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved!';
                setTimeout(() => btn.innerHTML = originalHtml, 1500);
            }
            logDebug('log', `Saved edits for snapshot ${snapshotId}`);
        }
    }
    else if (action === 'copy') {
        try {
            await navigator.clipboard.writeText(snap.text || '');
            // Optional: You could add a toastr.success here if available in your env
        } catch (err) {
            console.error('Copy failed', err);
        }
    }
    else if (action === 'regen') {
        const btn = container.querySelector(`button[data-snap-action="regen"][data-snap-id="${snapshotId}"]`);
        
        // UI Loading State
        if(btn) {
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
            btn.disabled = true;
        }
        
        await regenerateSnapshot(snap, settings, chatState);
        
        // Restore Button
        if(btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Regenerate';
        }
    }
}
// [EXISTING CODE BELOW...]

```
