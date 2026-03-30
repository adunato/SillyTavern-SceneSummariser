import { getChatState, ensureSettings } from '../state/stateManager.js';
import { buildSummaryText, getLatestSnapshot } from './engine.js';
import { extension_settings } from '../../../../../extensions.js';
import { settingsKey } from '../constants.js';

/**
 * Returns the full summary text as it would be injected into the prompt.
 * @returns {string} The summary text.
 */
export function getCurrentSummary() {
    ensureSettings();
    const settings = extension_settings[settingsKey];
    const chatState = getChatState();
    return buildSummaryText(chatState, settings);
}

/**
 * Returns the most recent snapshot data.
 * @returns {Object|null} The latest snapshot.
 */
export function getLatestSnapshotData() {
    ensureSettings();
    const chatState = getChatState();
    return getLatestSnapshot(chatState);
}

/**
 * Returns the array of memories recalled via semantic retrieval.
 * @returns {Array} List of recalled memories.
 */
export function getCurrentRecalledMemories() {
    ensureSettings();
    const chatState = getChatState();
    return chatState.currentSemanticResults || [];
}
