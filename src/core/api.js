import { getChatState, ensureSettings } from '../state/stateManager.js';
import { buildSummaryText, getLatestSnapshot } from './engine.js';
import { extension_settings } from '../../../../../extensions.js';
import { settingsKey, extensionName } from '../constants.js';

/**
 * Returns the full summary text as it would be injected into the prompt.
 * @returns {string} The summary text.
 */
export function getCurrentSummary() {
    ensureSettings();
    const settings = extension_settings[settingsKey];
    const chatState = getChatState();
    const summary = buildSummaryText(chatState, settings);
    console.log(`[${extensionName}] API: getCurrentSummary called. Length: ${summary?.length || 0}`);
    return summary;
}

/**
 * Returns the most recent snapshot data.
 * @returns {Object|null} The latest snapshot.
 */
export function getLatestSnapshotData() {
    ensureSettings();
    const chatState = getChatState();
    const snapshot = getLatestSnapshot(chatState);
    console.log(`[${extensionName}] API: getLatestSnapshotData called. Found: ${!!snapshot}`);
    return snapshot;
}

/**
 * Returns the array of memories recalled via semantic retrieval.
 * @returns {Array} List of recalled memories.
 */
export function getCurrentRecalledMemories() {
    ensureSettings();
    const chatState = getChatState();
    const results = chatState.currentSemanticResults || [];
    console.log(`[${extensionName}] API: getCurrentRecalledMemories called. Results: ${results.length}`);
    return results;
}
