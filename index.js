import { extensionName, state } from './src/constants.js';
import { logDebug } from './src/utils/logger.js';
import { ensureSettings } from './src/state/stateManager.js';
import { mountSettings, updateSettingsUI } from './src/ui/settingsUI.js';
import { startButtonMount } from './src/ui/buttons.js';
import { applyInjection, filterContextInterceptor } from './src/core/injector.js';
import { eventSource, event_types } from '../../../../scripts/events.js';

console.log(`[${extensionName}] Loading index.js...`);

function onChatChanged() {
    console.log(`[${extensionName}] [Event] onChatChanged triggered`);
    logDebug('log', 'Chat changed, refreshing chat-scoped state');
    updateSettingsUI(state.settingsContainer);
    applyInjection();
}

jQuery(async () => {
    console.log(`[${extensionName}] jQuery document ready. Initializing...`);
    ensureSettings();
    await mountSettings();
    startButtonMount();
    try {
        eventSource?.on(event_types.CHAT_CHANGED, onChatChanged);
        console.log(`[${extensionName}] Registered CHAT_CHANGED listener.`);
    } catch (err) {
        console.error(`[${extensionName}] Failed to register event listeners:`, err);
    }
});

// Expose the interceptor globally matching the name in manifest.json
window['SceneSummariser_filterContextInterceptor'] = function(...args) {
    console.log(`[${extensionName}] [Hook] SceneSummariser_filterContextInterceptor called by SillyTavern!`);
    return filterContextInterceptor(...args);
};
console.log(`[${extensionName}] Exposed SceneSummariser_filterContextInterceptor to window.`);

