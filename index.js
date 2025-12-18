// Third-party extensions live under /scripts/extensions/third-party/.
// Step three levels up to reach the core helpers.
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';

const extensionName = 'SillyTavern-SceneSummariser';
const settingsKey = extensionName;

const defaultSettings = {
    enabled: true,
    showSummariseButton: true,
    autoSummarise: false,
    showToolbar: false,
    summaryStyle: 'concise',
    storeHistory: false,
    maxSummaries: 5,
    debugMode: false,
};

let buttonIntervalId = null;

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
}

function createSummariseButton() {
    const button = document.createElement('div');
    button.id = 'ss_summarise_button';
    // Reuse GG button styling for consistent look/placement
    button.className = 'gg-action-button ss-action-button fa-solid fa-clapperboard';
    button.title = 'Summarise Scene';

    button.addEventListener('click', () => {
        console.log(`[${extensionName}] Summarise Scene clicked (placeholder).`);
    });

    return button;
}

/**
 * Place the summarise button beside other action buttons (same row as Guided Response).
 * Falls back to its own container if the Guided Generations container is not present.
 */
function placeSummariseButton() {
    if (!extension_settings[settingsKey]?.enabled || !extension_settings[settingsKey]?.showSummariseButton) {
        return false;
    }

    const existing = document.getElementById('ss_summarise_button');

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

jQuery(async () => {
    ensureSettings();
    await mountSettings();
    startButtonMount();
});
