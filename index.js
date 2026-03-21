import { extensionName, state } from './src/constants.js';
import { logDebug } from './src/utils/logger.js';
import { ensureSettings } from './src/state/stateManager.js';
import { mountSettings, updateSettingsUI } from './src/ui/settingsUI.js';
import { startButtonMount } from './src/ui/buttons.js';
import { applyInjection, filterContextInterceptor } from './src/core/injector.js';
import { eventSource, event_types } from '../../../../scripts/events.js';

function onChatChanged() {
    logDebug('log', 'Chat changed, refreshing chat-scoped state');
    updateSettingsUI(state.settingsContainer);
    applyInjection();
}

jQuery(async () => {
    ensureSettings();
    await mountSettings();
    startButtonMount();
    try {
        eventSource?.on(event_types.CHAT_CHANGED, onChatChanged);
        logDebug('log', 'Registered prompt filter listeners (migrated to generate_interceptor)');
    } catch (err) {
        console.error(`[${extensionName}] Failed to register event listeners:`, err);
    }
});

// Expose the interceptor globally matching the name in manifest.json
window['SceneSummariser_filterContextInterceptor'] = filterContextInterceptor;

