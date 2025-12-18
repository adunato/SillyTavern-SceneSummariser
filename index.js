// Third-party extensions live under /scripts/extensions/third-party/.
// Step three levels up to reach the core helpers.
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';

const extensionName = 'SillyTavern-SceneSummariser';
const settingsKey = extensionName;

const defaultSettings = {
    enabled: true,
    autoSummarise: false,
    showToolbar: false,
    summaryStyle: 'concise',
    storeHistory: false,
    maxSummaries: 5,
    debugMode: false,
};

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

jQuery(async () => {
    ensureSettings();
    await mountSettings();
});
