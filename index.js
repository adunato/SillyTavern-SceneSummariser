// Third-party extensions live under /scripts/extensions/third-party/.
// Step three levels up to reach the core helpers.
import { extension_settings, renderExtensionTemplateAsync, getContext } from '../../../extensions.js';
import {
    generateRaw,
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    eventSource,
    event_types,
} from '../../../../script.js';

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
    trimAfterSceneBreak: true,
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

    container.addEventListener('input', (event) => {
        const target = event.target;
        if (!target.classList?.contains('ss-setting-input')) return;

        const { name, type, value, checked } = target;
        if (!name) return;

        let newValue = value;
        if (type === 'checkbox') {
            newValue = !!checked;
        } else if (type === 'range' || type === 'number' || type === 'radio') {
            newValue = Number(value);
        }

        extension_settings[settingsKey][name] = newValue;

        if (name === 'summaryWords') {
            const display = container.querySelector('#ss_summaryWords_value');
            if (display) display.textContent = newValue;
        }

        saveSettingsDebounced();

        const injectFields = ['injectEnabled', 'injectPosition', 'injectDepth', 'injectScan', 'injectRole', 'injectTemplate'];
        if (injectFields.includes(name)) {
            applyInjection();
        }

        if (name === 'limitToUnsummarised') {
            logDebug('log', 'Updated limitToUnsummarised', newValue);
        }

        if (name === 'insertSceneBreak' || name === 'trimAfterSceneBreak') {
            logDebug('log', `Updated ${name}`, newValue);
        }
    });

    container.addEventListener('click', async (event) => {
        const actionEl = event.target.closest('[data-ss-action]');
        if (!actionEl) return;
        const action = actionEl.dataset.ssAction;
        const snapshotId = Number(actionEl.dataset.ssId);
        if (action === 'toggle-settings') {
            togglePanel(container, '#ss_settings_panel');
            return;
        }
        if (action === 'toggle-summary') {
            togglePanel(container, '#ss_summary_panel');
            return;
        }
        const chatState = getChatState();
        if (Number.isFinite(snapshotId)) {
            await handleSnapshotAction(action, snapshotId, chatState);
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
}

function togglePanel(container, selector) {
    const panel = container.querySelector(selector);
    if (!panel) return;
    const isHidden = panel.style.display === 'none';
    panel.style.display = isHidden ? '' : 'none';
}

function renderSnapshotsList(container, chatState, settings) {
    const list = container?.querySelector('#ss_snapshots_list');
    if (!list) return;
    list.innerHTML = '';
    const snapshots = chatState?.snapshots || [];
    if (!snapshots.length) {
        const empty = document.createElement('div');
        empty.className = 'ss-empty';
        empty.textContent = 'No snapshots yet. Click Summarise to create one.';
        list.appendChild(empty);
        return;
    }
    snapshots.slice().forEach((snap) => {
        const row = document.createElement('div');
        row.className = 'ss-snapshot-row';
        row.innerHTML = `
            <div class="ss-snapshot-meta">
                <strong>${snap.title || `Scene #${snap.id}`}</strong>
                <small>${new Date(snap.createdAt || Date.now()).toLocaleString()} · ${snap.fromIndex ?? 0}-${snap.toIndex ?? 0}</small>
            </div>
            <div class="ss-snapshot-actions">
                <button class="menu_button btn-secondary" data-ss-action="view" data-ss-id="${snap.id}">View</button>
                <button class="menu_button btn-secondary" data-ss-action="edit" data-ss-id="${snap.id}">Edit</button>
                <button class="menu_button btn-secondary" data-ss-action="regen" data-ss-id="${snap.id}">Regenerate</button>
                <button class="menu_button btn-secondary" data-ss-action="copy" data-ss-id="${snap.id}">Copy</button>
                <button class="menu_button btn-danger" data-ss-action="delete" data-ss-id="${snap.id}">Delete</button>
            </div>
        `;
        list.appendChild(row);
    });
}

async function handleSnapshotAction(action, snapshotId, chatState) {
    const settings = extension_settings[settingsKey];
    const snapIndex = chatState.snapshots.findIndex(s => s.id === snapshotId);
    if (snapIndex === -1) return;
    const snap = chatState.snapshots[snapIndex];
    if (action === 'view') {
        const currentSummaryEl = document.getElementById('ss_currentSummary');
        if (currentSummaryEl) currentSummaryEl.value = snap.text || '';
        logDebug('log', `Viewed snapshot ${snapshotId}`);
    } else if (action === 'edit') {
        const updated = window.prompt('Edit snapshot text:', snap.text || '');
        if (updated !== null) {
            snap.text = updated;
            logDebug('log', `Edited snapshot ${snapshotId}`);
        }
    } else if (action === 'delete') {
        chatState.snapshots.splice(snapIndex, 1);
        logDebug('log', `Deleted snapshot ${snapshotId}`);
    } else if (action === 'copy') {
        try {
            await navigator.clipboard.writeText(snap.text || '');
            logDebug('log', `Copied snapshot ${snapshotId}`);
        } catch (err) {
            console.error(`[${extensionName}] Copy failed`, err);
        }
    } else if (action === 'regen') {
        await regenerateSnapshot(snap, settings, chatState);
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
        .map((m) => {
            const speaker = m.name || (m.is_user ? name1 : name2);
            return `${speaker}: ${m.mes || ''}`.trim();
        })
        .join('\n');

    const words = settings.summaryWords || defaultSettings.summaryWords;
    const promptTemplate = settings.summaryPrompt || defaultSettings.summaryPrompt;
    const prompt = promptTemplate
        .replace('{{words}}', words)
        .replace('{{summary}}', snapshot.text || '')
        .replace('{{last_messages}}', transcript || '(no messages)');

    try {
        const result = await generateRaw({ prompt });
        snapshot.text = (result || '').trim();
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
    setValue('#ss_trimAfterSceneBreak', settings.trimAfterSceneBreak ?? defaultSettings.trimAfterSceneBreak);

    // Radio for position
    const radios = container.querySelectorAll('input[name="injectPosition"]');
    radios.forEach(r => r.checked = String(r.value) === String(settings.injectPosition));

    const wordsDisplay = container.querySelector('#ss_summaryWords_value');
    if (wordsDisplay) wordsDisplay.textContent = settings.summaryWords ?? defaultSettings.summaryWords;

    const currentSummary = container.querySelector('#ss_currentSummary');
    if (currentSummary) currentSummary.value = buildSummaryText(chatState, settings);

    renderSnapshotsList(container, chatState, settings);

    applyInjection();
    logDebug('log', 'Settings UI updated');
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
    const promptText = promptTemplate
        .replace('{{words}}', words)
        .replace('{{summary}}', buildSummaryText(chatState, settings));

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

    const transcript = newMessages
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
        const result = await generateRaw({ prompt });
        const cleaned = (result || '').trim();
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
        const max = settings.maxSummaries || defaultSettings.maxSummaries;
        if (chatState.snapshots.length > max) {
            chatState.snapshots = chatState.snapshots.slice(-max);
        }
        chatState.lastSummarisedIndex = chat.length;

        const currentSummaryEl = document.getElementById('ss_currentSummary');
        if (currentSummaryEl) currentSummaryEl.value = buildSummaryText(chatState, settings);

        if (settings.insertSceneBreak) {
            await insertSceneBreakMarker();
        }

        applyInjection();
        saveSettingsDebounced();
    } catch (error) {
        console.error(`[${extensionName}] Error during summarisation:`, error);
        logDebug('error', 'Summarisation error', error?.message || error);
    } finally {
        if (button) {
            button.classList.remove('disabled');
            button.title = originalTitle || 'Summarise Scene';
        }
        isSummarising = false;
    }
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

async function insertSceneBreakMarker() {
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
    logDebug('log', 'Inserted scene break marker', markerId, messageId);
}

jQuery(async () => {
    ensureSettings();
    await mountSettings();
    startButtonMount();
    try {
        eventSource?.on(event_types.CHAT_COMPLETION_PROMPT_READY, filterChatCompletionPrompt);
        eventSource?.on(event_types.CHAT_CHANGED, onChatChanged);
        logDebug('log', 'Registered prompt filter listener');
    } catch (err) {
        console.error(`[${extensionName}] Failed to register prompt filter:`, err);
    }
});

function onChatChanged() {
    logDebug('log', 'Chat changed, refreshing chat-scoped state');
    updateSettingsUI(settingsContainer);
    applyInjection();
}
function replacePromptMessages(eventData, newMessages) {
    // Mutate in-place so upstream references (chatCompletion) see the change
    eventData.chat.splice(0, eventData.chat.length, ...newMessages);
}

function filterChatCompletionPrompt(eventData) {
    ensureSettings();
    const settings = extension_settings[settingsKey];
    const chatState = getChatState();
    if (!settings?.limitToUnsummarised) return;
    if (!Array.isArray(eventData?.chat)) return;

    // Prefer precise trim using scene break marker if available
    if (settings.trimAfterSceneBreak && chatState.sceneBreakMarkerId && chatState.sceneBreakMesId !== null) {
        const markerIndex = eventData.chat.findIndex(m =>
            m?.mesid === chatState.sceneBreakMesId ||
            m?.extra?.marker_id === chatState.sceneBreakMarkerId ||
            (typeof m?.mes === 'string' && m.mes.includes(chatState.sceneBreakMarkerId))
        );

        if (markerIndex !== -1 && markerIndex < eventData.chat.length - 1) {
            const trimmed = eventData.chat.slice(markerIndex + 1);
            replacePromptMessages(eventData, trimmed);
            logDebug('log', `Trimmed prompt after marker (mesid=${chatState.sceneBreakMesId}) to ${trimmed.length} messages`);
            return;
        } else {
            logDebug('warn', 'Marker not found in prompt; falling back to unsummarised slice');
        }
    }

    // Fallback: slice by lastSummarisedIndex
    const ctx = getContext();
    const chat = ctx?.chat || [];
    const lastIdx = Math.min(chatState.lastSummarisedIndex || 0, chat.length);
    const sliced = chat.slice(lastIdx);

    if (!sliced.length) {
        logDebug('warn', 'No messages after last summary; clearing prompt messages');
        replacePromptMessages(eventData, []);
        return;
    }

    replacePromptMessages(eventData, sliced);
    logDebug('log', `Trimmed chat prompt to ${sliced.length} messages (after last summary index=${lastIdx})`);
}
