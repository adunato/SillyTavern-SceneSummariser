import { extensionName, state } from './src/constants.js';
import { logDebug } from './src/utils/logger.js';
import { ensureSettings } from './src/state/stateManager.js';
import { mountSettings, updateSettingsUI } from './src/ui/settingsUI.js';
import { startButtonMount } from './src/ui/buttons.js';
import { applyInjection, filterContextInterceptor, handleSemanticRetrieval } from './src/core/injector.js';
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
        
        // Main hook for semantic retrieval
        eventSource?.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, async () => {
            console.log(`[${extensionName}] GENERATE_BEFORE_COMBINE_PROMPTS event detected.`);
            await handleSemanticRetrieval();
        });

        // Backup hook for modded versions or different flows
        eventSource?.on(event_types.GENERATION_STARTED, async () => {
            console.log(`[${extensionName}] GENERATION_STARTED event detected.`);
            await handleSemanticRetrieval();
        });

        logDebug('log', 'Registered prompt filter listeners (migrated to generate_interceptor)');
    } catch (err) {
        console.error(`[${extensionName}] Failed to register event listeners:`, err);
    }
});

// Expose the interceptor globally matching the name in manifest.json
window['SceneSummariser_filterContextInterceptor'] = filterContextInterceptor;
