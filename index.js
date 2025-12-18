// Third-party extensions live under /scripts/extensions/third-party/.
// Step three levels up to reach the core helpers.
import { extension_settings, renderExtensionTemplateAsync, getContext } from '../../../extensions.js';
import { generateRaw, saveSettingsDebounced } from '../../../../script.js';

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
    currentSummary: '',
    summaryCounter: 0,
    lastSummarisedIndex: 0,
};

let buttonIntervalId = null;
let isSummarising = false;

function ensureSettings() {
    if (!extension_settings[settingsKey]) {
        extension_settings[settingsKey] = {};
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[settingsKey][key] === undefined) {
            extension_settings[settingsKey][key] = value;
        }
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
        } else if (type === 'range' || type === 'number') {
            newValue = Number(value);
        }

        extension_settings[settingsKey][name] = newValue;

        if (name === 'summaryWords') {
            const display = container.querySelector('#ss_summaryWords_value');
            if (display) display.textContent = newValue;
        }

        saveSettingsDebounced();
    });

    const summariseButton = container.querySelector('#ss_summarise_button');
    if (summariseButton) {
        summariseButton.addEventListener('click', onSummariseClick);
    }
}

function updateSettingsUI(container) {
    if (!container) return;
    const settings = extension_settings[settingsKey] || defaultSettings;

    const setValue = (selector, val) => {
        const el = container.querySelector(selector);
        if (!el) return;
        if (el.type === 'checkbox') {
            el.checked = !!val;
        } else {
            el.value = val ?? '';
        }
    };

    setValue('#ss_enabled', settings.enabled);
    setValue('#ss_autoSummarise', settings.autoSummarise);
    setValue('#ss_summaryPrompt', settings.summaryPrompt);
    setValue('#ss_summaryWords', settings.summaryWords);
    setValue('#ss_storeHistory', settings.storeHistory);
    setValue('#ss_maxSummaries', settings.maxSummaries);
    setValue('#ss_debugMode', settings.debugMode);

    const wordsDisplay = container.querySelector('#ss_summaryWords_value');
    if (wordsDisplay) wordsDisplay.textContent = settings.summaryWords;

    const currentSummary = container.querySelector('#ss_currentSummary');
    if (currentSummary) currentSummary.value = settings.currentSummary || '';
}

async function onSummariseClick() {
    if (isSummarising) return;
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

    const settings = extension_settings[settingsKey];
    const words = settings.summaryWords || defaultSettings.summaryWords;
    const promptTemplate = settings.summaryPrompt || defaultSettings.summaryPrompt;
    const promptText = promptTemplate
        .replace('{{words}}', words)
        .replace('{{summary}}', settings.currentSummary || '');

    // Build chat transcript for context
    const ctx = getContext();
    const chat = ctx?.chat || [];
    const lastIdx = Math.min(settings.lastSummarisedIndex || 0, chat.length);
    const newMessages = chat.slice(lastIdx);

    if (!newMessages.length) {
        console.warn(`[${extensionName}] No new messages since last summary; skipping.`);
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

        // Update stored summary list
        const nextId = (settings.summaryCounter ?? 0) + 1;
        const entry = `Scene #${nextId}: ${cleaned}`;

        const keepHistory = settings.storeHistory !== false;
        let finalSummary = entry;

        if (keepHistory) {
            const existingLines = (settings.currentSummary || '').trim();
            const combined = existingLines ? `${existingLines}\n${entry}` : entry;

            // Enforce max summaries if configured
            const lines = combined.split('\n');
            const max = settings.maxSummaries || defaultSettings.maxSummaries;
            const trimmedLines = lines.slice(-max);
            finalSummary = trimmedLines.join('\n');
        }

        settings.summaryCounter = nextId;
        settings.currentSummary = keepHistory
            ? `${settings.currentSummary ? `${settings.currentSummary}\n` : ''}${entry}`
            : finalSummary;
        settings.lastSummarisedIndex = chat.length;

        const currentSummaryEl = document.getElementById('ss_currentSummary');
        if (currentSummaryEl) {
            currentSummaryEl.value = finalSummary;
        }

        saveSettingsDebounced();
    } catch (error) {
        console.error(`[${extensionName}] Error during summarisation:`, error);
    } finally {
        if (button) {
            button.classList.remove('disabled');
            button.title = originalTitle || 'Summarise Scene';
        }
        isSummarising = false;
    }
}

jQuery(async () => {
    ensureSettings();
    await mountSettings();
    startButtonMount();
});
