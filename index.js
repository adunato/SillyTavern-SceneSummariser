// Third-party extensions live under /scripts/extensions/third-party/.
// Step three levels up to reach the core helpers.
import { extension_settings, renderExtensionTemplateAsync, getContext } from '../../../extensions.js';
import {
    generateRaw,
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
} from '../../../../script.js';
import { eventSource, event_types } from '../../../../scripts/events.js';

const extensionName = 'SillyTavern-SceneSummariser';
const settingsKey = extensionName;

const defaultSettings = {
    enabled: true,
    autoSummarise: false,
    summaryPrompt: 'Ignore previous instructions. Summarize the most important facts and events in the story so far. If a summary already exists in your memory, use that as a base and expand with new facts. Limit the summary to {{words}} words or less. Your response should include nothing but the summary.',
    summaryWords: 200,
    storeHistory: true,
    maxSummaries: 5,
    debugMode: false,
    injectEnabled: true,
    injectPosition: extension_prompt_types.IN_PROMPT,
    injectDepth: 2,
    injectScan: false,
    injectRole: extension_prompt_roles.SYSTEM,
    injectTemplate: '[Summary: {{summary}}]',
    limitToUnsummarised: false,
    insertSceneBreak: true,
    batchSize: 50,
    maxBatchSummaries: 0,
};

const chatStateDefaults = {
    currentSummary: '',
    summaryCounter: 0,
    lastSummarisedIndex: 0,
    sceneBreakMarkerId: '',
    sceneBreakMesId: null,
    snapshots: [],
};

const legacyStateKeys = Object.keys(chatStateDefaults);

let buttonIntervalId = null;
let isSummarising = false;
let debugMessages = [];
let settingsContainer = null;

function getLatestSnapshot(chatState) {
    if (!chatState?.snapshots?.length) return null;
    return chatState.snapshots[chatState.snapshots.length - 1];
}

function buildSummaryText(chatState, settings) {
    if (!chatState?.snapshots?.length) return '';
    if (settings?.storeHistory) {
        const max = settings.maxSummaries || defaultSettings.maxSummaries;
        const lastSnapshots = chatState.snapshots.slice(-max);
        return lastSnapshots.map(s => `${s.title}: ${s.text}`).join('\n');
    }
    const latest = getLatestSnapshot(chatState);
    return latest?.text || '';
}

function getActiveChatId() {
    const ctx = getContext();
    const chatId = ctx?.getCurrentChatId?.();
    return chatId ?? '__no_chat__';
}

function getActiveIntegrity() {
    const ctx = getContext();
    return ctx?.chatMetadata?.integrity || null;
}

function migrateLegacySnapshot(chatState, settings) {
    // If legacy currentSummary exists and no snapshots yet, create one
    if (chatState.snapshots && chatState.snapshots.length) return;
    const legacySummary = settings.currentSummary || '';
    if (!legacySummary) return;
    const legacyId = chatState.summaryCounter || 0;
    const snapshot = {
        id: legacyId || 1,
        title: `Scene #${legacyId || 1}`,
        text: legacySummary,
        createdAt: Date.now(),
        fromIndex: 0,
        toIndex: 0,
        source: 'legacy',
    };
    chatState.snapshots = [snapshot];
    chatState.summaryCounter = snapshot.id;
}

function pullLegacyState(settings) {
    const legacy = {};
    let found = false;
    for (const key of legacyStateKeys) {
        if (settings[key] !== undefined) {
            legacy[key] = settings[key];
            delete settings[key];
            found = true;
        }
    }
    return found ? legacy : null;
}

function getChatState(chatId = null) {
    ensureSettings();
    const settings = extension_settings[settingsKey];
    const activeChatId = chatId || getActiveChatId();
    const integrity = getActiveIntegrity();

    if (!settings.chatStates[activeChatId]) {
        const legacy = pullLegacyState(settings);
        const integrityState = integrity && settings.chatStatesByIntegrity?.[integrity];

        settings.chatStates[activeChatId] = {
            ...chatStateDefaults,
            ...(integrityState || legacy || {}),
        };
    }

    migrateLegacySnapshot(settings.chatStates[activeChatId], settings);

    // Keep a by-integrity cache so forks that carry integrity can re-use state
    if (integrity) {
        if (!settings.chatStatesByIntegrity) settings.chatStatesByIntegrity = {};
        settings.chatStatesByIntegrity[integrity] = settings.chatStates[activeChatId];
    }

    return settings.chatStates[activeChatId];
}

function logDebug(level, ...args) {
    if (!extension_settings[settingsKey]?.debugMode) return;
    const ts = new Date().toISOString();
    const line = `[${extensionName}][${level.toUpperCase()}] ${ts} ${args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}`;
    debugMessages.push(line);
    if (debugMessages.length > 500) {
        debugMessages = debugMessages.slice(-500);
    }
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

function copyLogs() {
    if (!debugMessages.length) {
        toastr.info('No logs to copy');
        return;
    }
    const text = debugMessages.join('\n');
    navigator.clipboard.writeText(text).then(() => {
        toastr.success('Debug logs copied to clipboard');
    }).catch(err => {
        console.error('Failed to copy logs:', err);
        toastr.error('Failed to copy logs');
    });
}

function ensureSettings() {
    if (!extension_settings[settingsKey]) {
        extension_settings[settingsKey] = {};
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[settingsKey][key] === undefined) {
            extension_settings[settingsKey][key] = value;
        }
    }

    if (!extension_settings[settingsKey].chatStates || typeof extension_settings[settingsKey].chatStates !== 'object') {
        extension_settings[settingsKey].chatStates = {};
    }
    if (!extension_settings[settingsKey].chatStatesByIntegrity || typeof extension_settings[settingsKey].chatStatesByIntegrity !== 'object') {
        extension_settings[settingsKey].chatStatesByIntegrity = {};
    }
}

async function mountSettings() {
    const parent = document.getElementById('extensions_settings');
    if (!parent) {
        console.warn(`[${extensionName}] Could not find #extensions_settings`);
        return;
    }

    const containerId = `extension_settings_${extensionName}`;
    let container = document.getElementById(containerId);
    if (!container) {
        container = document.createElement('div');
        container.id = containerId;
        parent.appendChild(container);
    }
    settingsContainer = container;

    const html = await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'settings');
    container.innerHTML = html;
    bindSettingsUI(container);
    updateSettingsUI(container);
}

function createSummariseButton() {
    const button = document.createElement('div');
    button.id = 'ss_summarise_button';
    // Reuse GG button styling for consistent look/placement
    button.className = 'gg-action-button ss-action-button fa-solid fa-clapperboard';
    button.title = 'Summarise Scene';

    button.addEventListener('click', onSummariseClick);

    return button;
}

/**
 * Place the summarise button beside other action buttons (same row as Guided Response).
 * Falls back to its own container if the Guided Generations container is not present.
 */
function placeSummariseButton() {
    const settings = extension_settings[settingsKey];
    const existing = document.getElementById('ss_summarise_button');

    if (!settings?.enabled) {
        // Remove if present
        if (existing?.parentElement) {
            existing.parentElement.removeChild(existing);
        }
        return false;
    }

    // Prefer the Guided Generations action container if it exists
    let targetContainer = document.getElementById('gg-regular-buttons-container');

    // Fallback: create a tiny container beneath the input if GG isn't present
    if (!targetContainer) {
        const sendForm = document.getElementById('send_form');
        const nonQRFormItems = document.getElementById('nonQRFormItems');
        if (sendForm && nonQRFormItems) {
            targetContainer = document.getElementById('ss-action-button-container');
            if (!targetContainer) {
                targetContainer = document.createElement('div');
                targetContainer.id = 'ss-action-button-container';
                targetContainer.className = 'gg-action-buttons-container';
                nonQRFormItems.parentNode.insertBefore(targetContainer, nonQRFormItems.nextSibling);
            }
        } else {
            return false;
        }
    }

    const button = existing || createSummariseButton();

    // If the button already lives in the right container, do nothing
    if (button.parentElement !== targetContainer) {
        button.remove();
        targetContainer.appendChild(button);
    }

    return true;
}

function startButtonMount() {
    // Try immediately
    let mounted = placeSummariseButton();

    // Retry a few times while the GG toolbar initializes/refreshes
    if (buttonIntervalId) {
        clearInterval(buttonIntervalId);
    }
    buttonIntervalId = setInterval(() => {
        mounted = placeSummariseButton() || mounted;
        // Stop after it has successfully placed once and exists in DOM
        if (mounted && document.getElementById('ss_summarise_button')) {
            clearInterval(buttonIntervalId);
            buttonIntervalId = null;
        }
    }, 1000);

    // Safety stop after 15s
    setTimeout(() => {
        if (buttonIntervalId) {
            clearInterval(buttonIntervalId);
            buttonIntervalId = null;
        }
    }, 15000);
}

function bindSettingsUI(container) {
    if (!container) return;

    // 1) Standard inputs
    container.addEventListener('input', (event) => {
        const target = event.target;
        if (!target.classList?.contains('ss-setting-input')) return;

        const { name, type, value, checked } = target;
        if (!name) return;

        let newValue = value;
        if (type === 'checkbox') newValue = !!checked;
        else if (type === 'range' || type === 'number' || type === 'radio') newValue = Number(value);

        extension_settings[settingsKey][name] = newValue;

        if (name === 'summaryWords') {
            const display = container.querySelector('#ss_summaryWords_value');
            if (display) display.textContent = newValue;
        }

        saveSettingsDebounced();

        if (name === 'injectPosition') {
            updateInjectionVisibility(container);
        }

        if (name === 'limitToUnsummarised') {
            updateContextControlVisibility(container);
        }

        if (name === 'batchSize') {
            const display = container.querySelector('#ss_batchSize_value');
            if (display) display.textContent = newValue;
        }

        if (name === 'maxBatchSummaries') {
            const display = container.querySelector('#ss_maxBatchSummaries_value');
            if (display) display.textContent = newValue;
        }

        if (['injectEnabled', 'injectPosition', 'injectDepth', 'injectScan', 'injectRole', 'injectTemplate'].includes(name)) {
            applyInjection();
        }
    });

    // 1b) Auto-save summary text
    container.addEventListener('input', (event) => {
        if (!event.target.classList.contains('ss-snap-text')) return;
        const id = Number(event.target.dataset.id);
        const chatState = getChatState();
        const snap = chatState.snapshots.find(s => s.id === id);
        if (snap) {
            snap.text = event.target.value;
            saveSettingsDebounced();

            // Refresh preview using full build logic (respects Store History)
            const currentSummary = container.querySelector('#ss_currentSummary');
            if (currentSummary) {
                currentSummary.value = buildSummaryText(chatState, extension_settings[settingsKey]);
            }

            applyInjection();
        }
    });

    // 2) Click delegation
    container.addEventListener('click', async (event) => {
        const actionEl = event.target.closest('[data-ss-action]');
        if (actionEl) {
            const action = actionEl.dataset.ssAction;
            if (action === 'toggle-settings') togglePanel(container, '#ss_settings_panel');
            if (action === 'toggle-summary') togglePanel(container, '#ss_summary_panel');
            return;
        }

        // Accordion header expand/collapse
        const headerEl = event.target.closest('.ss-snapshot-header');
        if (headerEl && !event.target.closest('.ss-no-propagate')) {
            const item = headerEl.closest('.ss-snapshot-item');
            item?.classList.toggle('expanded');
            return;
        }

        // Snapshot actions
        const snapBtn = event.target.closest('[data-snap-action]');
        if (snapBtn) {
            const action = snapBtn.dataset.snapAction;
            const id = Number(snapBtn.dataset.snapId);
            const chatState = getChatState();
            await handleSnapshotAction(action, id, chatState, container);
            renderSnapshotsList(container, chatState, extension_settings[settingsKey]);
            const currentSummary = container.querySelector('#ss_currentSummary');
            if (currentSummary) currentSummary.value = buildSummaryText(chatState, extension_settings[settingsKey]);
            applyInjection();
            saveSettingsDebounced();
        }
    });

    // Debug controls
    container.querySelector('#ss_copyLogs')?.addEventListener('click', async () => {
        const text = debugMessages.join('\n');
        try {
            await navigator.clipboard.writeText(text);
            logDebug('log', 'Debug logs copied to clipboard');
        } catch (err) {
            console.error(`[${extensionName}] Failed to copy logs:`, err);
        }
    });

    container.querySelector('#ss_clearLogs')?.addEventListener('click', () => {
        debugMessages = [];
        logDebug('log', 'Debug logs cleared');
    });

    const summariseButton = container.querySelector('#ss_summarise_button');
    if (summariseButton) {
        summariseButton.addEventListener('click', onSummariseClick);
    }

    const batchSummariseButton = container.querySelector('#ss_batch_summarise_button');
    if (batchSummariseButton) {
        batchSummariseButton.addEventListener('click', onBatchSummariseClick);
    }
}

function togglePanel(container, selector) {
    const panel = container.querySelector(selector);
    if (!panel) return;
    const isHidden = panel.style.display === 'none';
    panel.style.display = isHidden ? '' : 'none';
}

function renderSnapshotsList(container, chatState, settings) {
    const list = container?.querySelector('#ss_snapshots_list');
    const emptyState = container?.querySelector('#ss_empty_state');
    if (!list) return;
    list.innerHTML = '';
    const snapshots = chatState?.snapshots || [];

    if (!snapshots.length) {
        if (emptyState) emptyState.style.display = 'block';
        return;
    } else if (emptyState) {
        emptyState.style.display = 'none';
    }

    // Oldest first
    [...snapshots].forEach((snap) => {
        const title = snap.title || `Scene #${snap.id}`;

        const item = document.createElement('div');
        item.className = 'ss-snapshot-item'; // Default state is collapsed (no 'expanded' class)
        item.dataset.id = snap.id;

        item.innerHTML = `
            <div class="inline-drawer wide100p">
                <div class="inline-drawer-header ss-snapshot-header">
                    <div class="inline-drawer-toggle inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    <div class="ss-snapshot-header-content">
                         <div class="ss-snapshot-title text_pole textarea_compact" title="${title}">${title}</div>
                         <div class="ss-header-actions ss-no-propagate">
                               <i class="menu_button fa-solid fa-arrows-rotate ss-action-icon" title="Regenerate" data-snap-action="regen" data-snap-id="${snap.id}"></i>
                               <i class="menu_button fa-solid fa-copy ss-action-icon" title="Copy Text" data-snap-action="copy" data-snap-id="${snap.id}"></i>
                               <i class="menu_button fa-solid fa-trash-can ss-delete-icon ss-action-icon" title="Delete Snapshot" data-snap-action="delete" data-snap-id="${snap.id}"></i>
                         </div>
                    </div>
                </div>
                <div class="inline-drawer-content ss-snapshot-content">
                    <div class="setting_item">
                        <textarea class="text_pole ss-snap-text" data-id="${snap.id}" rows="6" style="width:100%; font-size:0.9em; font-family:inherit;">${snap.text || ''}</textarea>
                    </div>
                    </div>
                    <!-- Save button removed; auto-save is active -->
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
        if (confirm(`Delete "${snap.title || 'this snapshot'}"?`)) {
            chatState.snapshots.splice(snapIndex, 1);
            logDebug('log', `Deleted snapshot ${snapshotId}`);
        }
    } else if (action === 'copy') {
        try {
            await navigator.clipboard.writeText(snap.text || '');
        } catch (err) {
            console.error('Copy failed', err);
        }
    } else if (action === 'regen') {
        const icon = container.querySelector(`i[data-snap-action="regen"][data-snap-id="${snapshotId}"]`);
        if (icon) {
            icon.classList.remove('fa-arrows-rotate');
            icon.classList.add('fa-spinner', 'fa-spin');
            icon.style.pointerEvents = 'none';
        }
        await regenerateSnapshot(snap, settings, chatState);
        if (icon) {
            icon.classList.remove('fa-spinner', 'fa-spin');
            icon.classList.add('fa-arrows-rotate');
            icon.style.pointerEvents = '';
        }
    }
}

async function regenerateSnapshot(snapshot, settings, chatState) {
    const ctx = getContext();
    const chat = ctx?.chat || [];
    const start = Math.max(0, snapshot.fromIndex || 0);
    const end = Math.min(chat.length, snapshot.toIndex || chat.length);
    const slice = chat.slice(start, end);
    const name1 = ctx?.name1 || 'User';
    const name2 = ctx?.name2 || 'Character';
    const transcript = slice
        .filter(m => !m.extra?.scene_summariser_marker)
        .map((m) => {
            const speaker = m.name || (m.is_user ? name1 : name2);
            return `${speaker}: ${m.mes || ''}`.trim();
        })
        .join('\n');

    const words = settings.summaryWords || defaultSettings.summaryWords;
    const promptTemplate = settings.summaryPrompt || defaultSettings.summaryPrompt;

    // Fix: Only use summaries prior to this one as context
    const snapshotIndex = chatState.snapshots.findIndex(s => s.id === snapshot.id);
    const previousSnapshots = snapshotIndex > -1 ? chatState.snapshots.slice(0, snapshotIndex) : [];
    const previousSummaryText = previousSnapshots.map(s => `${s.title}: ${s.text}`).join('\n');

    const prompt = promptTemplate
        .replace('{{words}}', words)
        .replace('{{summary}}', previousSummaryText || '')
        .replace('{{last_messages}}', transcript || '(no messages)');

    try {
        const result = await generateRaw({ prompt, trimNames: false });
        let cleaned = (result || '').trim();
        if (cleaned.startsWith(prompt.trim())) {
            cleaned = cleaned.substring(prompt.trim().length).trim();
        }

        snapshot.text = cleaned;
        snapshot.createdAt = Date.now();
        logDebug('log', `Regenerated snapshot ${snapshot.id}`);
    } catch (err) {
        console.error(`[${extensionName}] Failed to regenerate snapshot`, err);
        logDebug('error', 'Regenerate failed', err?.message || err);
    }
}


function updateSettingsUI(container) {
    if (!container) return;
    const settings = extension_settings[settingsKey] || defaultSettings;
    const chatState = getChatState();

    const setValue = (selector, val) => {
        const el = container.querySelector(selector);
        if (!el) return;
        if (el.type === 'checkbox') {
            el.checked = !!val;
        } else if (el.type === 'radio') {
            el.checked = String(el.value) === String(val);
        } else {
            el.value = val ?? '';
        }
    };

    setValue('#ss_enabled', settings.enabled ?? defaultSettings.enabled);
    setValue('#ss_autoSummarise', settings.autoSummarise ?? defaultSettings.autoSummarise);
    setValue('#ss_summaryPrompt', settings.summaryPrompt ?? defaultSettings.summaryPrompt);
    setValue('#ss_summaryWords', settings.summaryWords ?? defaultSettings.summaryWords);
    setValue('#ss_storeHistory', settings.storeHistory ?? defaultSettings.storeHistory);
    setValue('#ss_maxSummaries', settings.maxSummaries ?? defaultSettings.maxSummaries);
    setValue('#ss_debugMode', settings.debugMode ?? defaultSettings.debugMode);
    setValue('#ss_injectEnabled', settings.injectEnabled ?? defaultSettings.injectEnabled);
    setValue('#ss_injectDepth', settings.injectDepth ?? defaultSettings.injectDepth);
    setValue('#ss_injectScan', settings.injectScan ?? defaultSettings.injectScan);
    setValue('#ss_injectRole', settings.injectRole ?? defaultSettings.injectRole);
    setValue('#ss_injectTemplate', settings.injectTemplate ?? defaultSettings.injectTemplate);
    setValue('#ss_limitToUnsummarised', settings.limitToUnsummarised ?? defaultSettings.limitToUnsummarised);
    setValue('#ss_insertSceneBreak', settings.insertSceneBreak ?? defaultSettings.insertSceneBreak);
    setValue('#ss_batchSize', settings.batchSize ?? defaultSettings.batchSize);
    setValue('#ss_maxBatchSummaries', settings.maxBatchSummaries ?? defaultSettings.maxBatchSummaries);

    // Radio for position
    const radios = container.querySelectorAll('input[name="injectPosition"]');
    radios.forEach(r => r.checked = String(r.value) === String(settings.injectPosition));

    updateInjectionVisibility(container);
    updateContextControlVisibility(container);

    const wordsDisplay = container.querySelector('#ss_summaryWords_value');
    if (wordsDisplay) wordsDisplay.textContent = settings.summaryWords ?? defaultSettings.summaryWords;

    const batchSizeDisplay = container.querySelector('#ss_batchSize_value');
    if (batchSizeDisplay) batchSizeDisplay.textContent = settings.batchSize ?? defaultSettings.batchSize;

    const maxBatchSummariesDisplay = container.querySelector('#ss_maxBatchSummaries_value');
    if (maxBatchSummariesDisplay) maxBatchSummariesDisplay.textContent = settings.maxBatchSummaries ?? defaultSettings.maxBatchSummaries;

    const currentSummary = container.querySelector('#ss_currentSummary');
    if (currentSummary) currentSummary.value = buildSummaryText(chatState, settings);

    renderSnapshotsList(container, chatState, settings);

    applyInjection();
    logDebug('log', 'Settings UI updated');
}

function updateInjectionVisibility(container) {
    if (!container) return;
    const settings = extension_settings[settingsKey];
    const isInChat = String(settings.injectPosition) === '1'; // IN_CHAT

    const depthInput = container.querySelector('#ss_injectDepth');
    const roleSelect = container.querySelector('#ss_injectRole');

    if (depthInput) {
        depthInput.disabled = !isInChat;
        depthInput.style.opacity = isInChat ? '1' : '0.5';
    }
    if (roleSelect) {
        roleSelect.disabled = !isInChat;
        roleSelect.style.opacity = isInChat ? '1' : '0.5';
    }
}

function updateContextControlVisibility(container) {
    if (!container) return;
    const settings = extension_settings[settingsKey];
    // limitToUnsummarised controls whether we are trimming at all.
    // trimAfterSceneBreak is a refinement of HOW we trim.
    // However, trimAfterSceneBreak creates a visual marker which is also controlled by insertSceneBreak.

    // Logic: 
    // If limitToUnsummarised is OFF, then trimAfterSceneBreak does nothing relevant to the prompt (though it might still run logic).
    // Let's visualy imply dependency: trimAfterSceneBreak is only relevant if limitToUnsummarised is ON.

    const limitCheckbox = container.querySelector('#ss_limitToUnsummarised');
    // trimAfterSceneBreak removed as per user request (strict filtering enforced)
}

async function onSummariseClick() {
    if (isSummarising) return;
    ensureSettings();
    if (!extension_settings[settingsKey]?.enabled) {
        console.warn(`[${extensionName}] Summariser disabled.`);
        return;
    }
    isSummarising = true;

    const button = document.getElementById('ss_summarise_button');
    const originalTitle = button?.title;
    if (button) {
        button.classList.add('disabled');
        button.title = 'Summarising...';
    }
    logDebug('log', 'Summarise clicked');

    const settings = extension_settings[settingsKey];
    const chatState = getChatState();
    const words = settings.summaryWords || defaultSettings.summaryWords;
    const promptTemplate = settings.summaryPrompt || defaultSettings.summaryPrompt;

    // Pass ALL summaries to the generation prompt so the AI has full context,
    // regardless of the injection limit (maxSummaries).
    const allSummaries = (chatState.snapshots || [])
        .map(s => `${s.title || 'Scene #' + s.id}: ${s.text}`)
        .join('\n');

    const promptText = promptTemplate
        .replace('{{words}}', words)
        .replace('{{summary}}', allSummaries);

    // Build chat transcript for context
    const ctx = getContext();
    const chat = ctx?.chat || [];
    const lastIdx = Math.min(chatState.lastSummarisedIndex || 0, chat.length);
    const newMessages = chat.slice(lastIdx);

    if (!newMessages.length) {
        console.warn(`[${extensionName}] No new messages since last summary; skipping.`);
        logDebug('warn', 'No new messages since last summary; skipping');
        if (button) {
            button.classList.remove('disabled');
            button.title = originalTitle || 'Summarise Scene';
        }
        isSummarising = false;
        return;
    }

    const name1 = ctx?.name1 || 'User';
    const name2 = ctx?.name2 || 'Character';

    logDebug('log', `Summarising with names: name1="${name1}", name2="${name2}"`);
    if (newMessages.length > 0) {
        const sample = newMessages[0];
        logDebug('log', `Sample message: name="${sample.name}", is_user=${sample.is_user}, mes="${(sample.mes || '').substring(0, 20)}..."`);
    }

    const transcript = newMessages
        .filter(m => !m.extra?.scene_summariser_marker)
        .slice(-50) // limit to most recent chunk to keep prompt small
        .map((m) => {
            const speaker = m.name || (m.is_user ? name1 : name2);
            return `${speaker}: ${m.mes || ''}`.trim();
        })
        .join('\n');

    const prompt = promptText
        .replace('{{last_messages}}', transcript || '(no new messages)')
        + (!promptText.includes('{{last_messages}}') ? `\n\nChat history:\n${transcript}` : '');

    try {
        const result = await generateRaw({ prompt, trimNames: false });
        let cleaned = (result || '').trim();
        if (cleaned.startsWith(prompt.trim())) {
            cleaned = cleaned.substring(prompt.trim().length).trim();
        }
        logDebug('log', 'LLM summary result', cleaned);

        // Update stored snapshot list
        const nextId = (chatState.summaryCounter ?? 0) + 1;
        const snapshot = {
            id: nextId,
            title: `Scene #${nextId}`,
            text: cleaned,
            createdAt: Date.now(),
            fromIndex: lastIdx,
            toIndex: chat.length,
            source: 'manual',
            words,
        };

        chatState.summaryCounter = nextId;
        chatState.snapshots = chatState.snapshots || [];
        chatState.snapshots.push(snapshot);
        // Do not truncate snapshots here; we want to keep all history for the next summarisation.
        // maxSummaries will be applied during injection via buildSummaryText.
        chatState.lastSummarisedIndex = chat.length;

        if (settings.insertSceneBreak) {
            await insertSceneBreakMarker(nextId);
        }

        updateSettingsUI(settingsContainer);

        applyInjection();
        saveSettingsDebounced();
    } catch (error) {
        console.error(`[${extensionName}] Error during summarisation:`, error);
        logDebug('error', 'Summarisation error', error?.message || error);
        toastr.error('Summarisation error: ' + (error?.message || error));
    } finally {
        if (button) {
            button.classList.remove('disabled');
            button.title = originalTitle || 'Summarise Scene';
        }
        isSummarising = false;
    }
}

async function onBatchSummariseClick() {
    if (isSummarising) return;
    ensureSettings();
    if (!extension_settings[settingsKey]?.enabled) {
        console.warn(`[${extensionName}] Summariser disabled.`);
        return;
    }

    const settings = extension_settings[settingsKey];
    const batchSize = Number(settings.batchSize || defaultSettings.batchSize);

    if (!confirm(`This will delete all existing Scene Summaries and generate new ones in batches of ${batchSize} messages from the beginning of the chat. Proceed?`)) {
        return;
    }

    isSummarising = true;

    const button = document.getElementById('ss_batch_summarise_button');
    const originalText = button?.innerHTML;
    if (button) {
        button.classList.add('disabled');
        button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Initializing Batch...';
    }
    logDebug('log', 'Batch Summarise clicked');

    const chatState = getChatState();
    const words = settings.summaryWords || defaultSettings.summaryWords;
    const promptTemplate = settings.summaryPrompt || defaultSettings.summaryPrompt;

    // Reset state
    chatState.snapshots = [];
    chatState.summaryCounter = 0;
    chatState.lastSummarisedIndex = 0;

    const ctx = getContext();
    const fullChat = ctx?.chat || [];

    // Filter out existing scene markers but keep original indexes for references
    // Better to filter content that we send, but keep index tracking aligned with original array
    const validMessages = [];
    for (let i = 0; i < fullChat.length; i++) {
        if (!fullChat[i].extra?.scene_summariser_marker) {
            validMessages.push({ msg: fullChat[i], originalIndex: i });
        }
    }

    if (!validMessages.length) {
        if (button) {
            button.classList.remove('disabled');
            button.innerHTML = originalText;
        }
        isSummarising = false;
        toastr.info('No messages to summarise.');
        return;
    }

    const name1 = ctx?.name1 || 'User';
    const name2 = ctx?.name2 || 'Character';

    // Create batches
    let batches = [];
    for (let i = 0; i < validMessages.length; i += batchSize) {
        batches.push(validMessages.slice(i, i + batchSize));
    }

    const maxBatchSummaries = Number(settings.maxBatchSummaries || defaultSettings.maxBatchSummaries);
    if (maxBatchSummaries > 0 && batches.length > maxBatchSummaries) {
        // Keep the most recent ones if we exceed the limit
        batches = batches.slice(-maxBatchSummaries);
    }

    const totalBatches = batches.length;
    let successCount = 0;

    for (let i = 0; i < totalBatches; i++) {
        const batch = batches[i];
        if (!batch.length) continue;

        if (button) {
            button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Batch ${i + 1} of ${totalBatches}...`;
        }

        const allSummariesContext = (chatState.snapshots || [])
            .map(s => `${s.title || 'Scene #' + s.id}: ${s.text}`)
            .join('\n');

        const promptText = promptTemplate
            .replace('{{words}}', words)
            .replace('{{summary}}', allSummariesContext);

        const transcript = batch
            .map(({ msg }) => {
                const speaker = msg.name || (msg.is_user ? name1 : name2);
                return `${speaker}: ${msg.mes || ''}`.trim();
            })
            .join('\n');

        const prompt = promptText
            .replace('{{last_messages}}', transcript || '(no new messages)')
            + (!promptText.includes('{{last_messages}}') ? `\n\nChat history:\n${transcript}` : '');

        try {
            const result = await generateRaw({ prompt, trimNames: false });
            let cleaned = (result || '').trim();
            if (cleaned.startsWith(prompt.trim())) {
                cleaned = cleaned.substring(prompt.trim().length).trim();
            }
            logDebug('log', `LLM batch summary result ${i + 1}/${totalBatches}`, cleaned);

            // Update stored snapshot list
            const nextId = (chatState.summaryCounter ?? 0) + 1;

            // Getting the original index bounds for this batch
            const batchFromIndex = batch[0].originalIndex;
            const batchToIndex = batch[batch.length - 1].originalIndex + 1; // exclusive end

            const snapshot = {
                id: nextId,
                title: `Scene #${nextId}`,
                text: cleaned,
                createdAt: Date.now(),
                fromIndex: batchFromIndex,
                toIndex: batchToIndex,
                source: 'batch',
                words,
            };

            chatState.summaryCounter = nextId;
            chatState.snapshots.push(snapshot);
            chatState.lastSummarisedIndex = batchToIndex;

            // We do NOT call insertSceneBreakMarker here to avoid spamming the chat log on batches,
            // or perhaps optionally we could? For now skip it to keep chat clean.
            successCount++;

            // Update UI dynamically to show the new snapshot
            updateSettingsUI(settingsContainer);
        } catch (error) {
            console.error(`[${extensionName}] Error during batch summarisation (batch ${i + 1}):`, error);
            logDebug('error', `Batch ${i + 1} error`, error?.message || error);
            toastr.error(`Error generating batch ${i + 1}. Stopping.`);
            break; // Stop remaining batches on error
        }
    }

    if (button) {
        button.classList.remove('disabled');
        button.innerHTML = originalText;
    }

    if (successCount > 0) {
        toastr.success(`Successfully generated ${successCount} summaries.`);
    }

    applyInjection();
    saveSettingsDebounced();
    isSummarising = false;
}

function applyInjection() {
    const settings = extension_settings[settingsKey];
    const chatState = getChatState();
    if (!settings || !settings.injectEnabled || !settings.enabled) {
        try {
            setExtensionPrompt(extensionName, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
        } catch (err) {
            console.error(`[${extensionName}] Failed to clear injection:`, err);
        }
        return;
    }

    const position = Number(settings.injectPosition ?? extension_prompt_types.IN_PROMPT);
    if (position === extension_prompt_types.NONE) {
        try {
            setExtensionPrompt(extensionName, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
        } catch (err) {
            console.error(`[${extensionName}] Failed to clear injection (NONE):`, err);
        }
        return;
    }

    const ctx = getContext();
    const chat = ctx?.chat || [];
    const lastIdx = Math.min(chatState.lastSummarisedIndex || 0, chat.length);
    const newMessages = chat.slice(lastIdx);
    const name1 = ctx?.name1 || 'User';
    const name2 = ctx?.name2 || 'Character';
    const transcript = newMessages
        .slice(-50)
        .map((m) => {
            const speaker = m.name || (m.is_user ? name1 : name2);
            return `${speaker}: ${m.mes || ''}`.trim();
        })
        .join('\n');

    const template = settings.injectTemplate || defaultSettings.injectTemplate;
    const value = template
        .replace('{{summary}}', buildSummaryText(chatState, settings))
        .replace('{{last_messages}}', transcript)
        .replace('{{words}}', settings.summaryWords ?? defaultSettings.summaryWords);

    const depth = Number(settings.injectDepth ?? 2);
    const scan = !!settings.injectScan;
    const role = Number(settings.injectRole ?? extension_prompt_roles.SYSTEM);

    try {
        setExtensionPrompt(extensionName, value, position, depth, scan, role);
        logDebug('log', `Injection updated (pos=${position}, depth=${depth}, scan=${scan}, role=${role})`);
    } catch (err) {
        console.error(`[${extensionName}] Failed to set injection prompt:`, err);
        logDebug('error', 'Failed to set injection prompt', err?.message || err);
    }
}

async function insertSceneBreakMarker(snapshotId) {
    const ctx = getContext();
    if (!ctx || !Array.isArray(ctx.chat)) return;
    const chatState = getChatState();

    const markerId = `scene-break-${Date.now()}`;
    const markerHtml = `<details class="scene-summary-break" data-marker-id="${markerId}"><summary>📑 Scene Summary Boundary</summary><div>Summaries above; new messages below.</div></details>`;
    const message = {
        name: extensionName,
        is_user: false,
        is_system: true,
        mes: markerHtml,
        extra: {
            scene_summariser_marker: true,
            marker_id: markerId,
            snapshot_id: snapshotId,
        },
        send_date: Date.now(),
    };

    ctx.chat.push(message);
    const messageId = ctx.chat.length - 1;
    try {
        await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'extension');
        ctx.addOneMessage(message);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
        if (typeof ctx.saveChat === 'function') {
            await ctx.saveChat();
        }
    } catch (err) {
        console.error(`[${extensionName}] Failed to add scene break marker:`, err);
    }

    chatState.sceneBreakMarkerId = markerId;
    chatState.sceneBreakMesId = messageId;
    logDebug('log', 'Inserted scene break marker', markerId, messageId, snapshotId);
}

jQuery(async () => {
    ensureSettings();
    await mountSettings();
    startButtonMount();
    try {
        // logDebug('log', `eventSource available: ${!!eventSource}`);
        // eventSource?.on(event_types.CHAT_COMPLETION_PROMPT_READY, filterChatCompletionPrompt);
        // eventSource?.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, filterTextCompletionPrompt);
        eventSource?.on(event_types.CHAT_CHANGED, onChatChanged);
        logDebug('log', 'Registered prompt filter listeners (migrated to generate_interceptor)');
    } catch (err) {
        console.error(`[${extensionName}] Failed to register prompt filter:`, err);
    }
});

function onChatChanged() {
    logDebug('log', 'Chat changed, refreshing chat-scoped state');
    updateSettingsUI(settingsContainer);
    applyInjection();
}

/**
 * Context interceptor for filtering messages
 * @param {object[]} chat The chat array to filter
 * @param {number} maxContext The maximum context size (unused here but passed by ST)
 * @param {function} abort Function to abort generation
 * @param {string} type Generation type ('chat', 'text', 'quiet', etc)
 */
async function filterContextInterceptor(chat, maxContext, abort, type) {
    if (type === 'quiet') return; // Don't interfere with internal quiet prompts

    ensureSettings();
    const settings = extension_settings[settingsKey];
    logDebug('log', `filterContextInterceptor called. limitToUnsummarised=${settings?.limitToUnsummarised}`);

    if (!settings?.limitToUnsummarised) return;

    let markerIndex = -1;
    // Scan BACKWARDS for the marker
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];

        // 1. Check Metadata (Robust)
        const isMetadataMarker = m?.extra?.scene_summariser_marker;
        if (isMetadataMarker) {
            markerIndex = i;
            logDebug('log', `Found context cutoff marker (Metadata) at index ${i}`);
            break;
        }

        // 2. Check Content (Fallback)
        const content = m?.mes || '';
        if (content.includes('scene-summary-break') || content.includes('Scene Summary Boundary')) {
            markerIndex = i;
            logDebug('log', `Found context cutoff marker (Content) at index ${i}`);
            break;
        }
    }

    if (markerIndex !== -1) {
        logDebug('log', `Filtering request. Found marker at ${markerIndex}. Keeping messages AFTER this index.`);
        // Mutate the chat array directly - splice out everything from 0 up to (and including) markerIndex
        // We want to KEEP messages starting from markerIndex + 1
        // So we remove (markerIndex + 1) items from the start.
        chat.splice(0, markerIndex + 1);
    } else {
        logDebug('log', 'Limit enabled but no marker found. Sending full context.');
    }
}

// Expose the interceptor globally matching the name in manifest.json
window['SceneSummariser_filterContextInterceptor'] = filterContextInterceptor;
