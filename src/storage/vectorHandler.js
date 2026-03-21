import { extensionName } from '../constants.js';
import { logDebug } from '../utils/logger.js';
import { extension_settings } from '../../../../../extensions.js';
import { getRequestHeaders } from '../../../../../../script.js';
import { getActiveChatId } from '../state/stateManager.js';

/**
 * Returns the unique vector collection ID for the current chat.
 * @returns {string}
 */
export function getChatCollectionId() {
    const chatId = getActiveChatId() || 'default';
    const safeChatId = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `scene_summariser_${safeChatId}`;
}

/**
 * Constructs the base request body needed for Vector Storage backend API calls.
 * We piggyback off the user's existing Vector Storage extension settings to know which embedding model to use.
 * @returns {object}
 */
function getBaseVectorPayload() {
    const vectorSettings = extension_settings?.vectors || {};
    return {
        source: vectorSettings.source || 'extras',
        // Send the raw settings so the backend can extract the correct model based on 'source'
        ...vectorSettings
    };
}

/**
 * Inserts memory items into the dedicated vector collection.
 * @param {string} collectionId
 * @param {{ id: string, text: string }[]} items
 */
export async function insertVectorItems(collectionId, items) {
    if (!items || items.length === 0) return;

    try {
        const payload = {
            ...getBaseVectorPayload(),
            collectionId,
            items
        };

        const response = await fetch('/api/vector/insert', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error(`Server returned ${response.status} ${response.statusText}`);
        }

        logDebug('log', `[vectorHandler] Inserted ${items.length} items into ${collectionId}`);
    } catch (err) {
        logDebug('error', `[vectorHandler] Failed to insert vectors: ${err.message}`);
        console.error(`[${extensionName}] Failed to insert vectors:`, err);
    }
}

/**
 * Queries the dedicated vector collection for relevant memories.
 * @param {string} collectionId
 * @param {string} searchText
 * @param {number} topK
 * @param {number} threshold
 * @returns {Promise<object[]>} Array of metadata objects { text: string, ... }
 */
export async function queryVectorCollection(collectionId, searchText, topK, threshold) {
    if (!searchText || topK <= 0) return [];

    try {
        logDebug('log', `[vectorHandler] Querying collection: ${collectionId}`);
        logDebug('log', `[vectorHandler] Query Text (first 50 chars): "${searchText.substring(0, 50).replace(/\n/g, ' ')}..."`);
        logDebug('log', `[vectorHandler] Parameters: topK=${topK}, threshold=${threshold}`);

        const payload = {
            ...getBaseVectorPayload(),
            collectionId,
            searchText,
            topK,
            threshold
        };

        const response = await fetch('/api/vector/query', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            // Silently ignore 404s or empty index errors
            if (response.status === 404) {
                logDebug('log', '[vectorHandler] Collection not found (404). Index might be empty.');
                return [];
            }
            throw new Error(`Server returned ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        const results = data.metadata || [];
        logDebug('log', `[vectorHandler] Query successful. Found ${results.length} relevant memories.`);
        if (results.length > 0) {
            results.forEach((r, i) => {
                logDebug('log', `[vectorHandler]   Result #${i + 1}: (Score: ${data.scores ? data.scores[i] : 'N/A'}) "${r.text.substring(0, 100)}..."`);
            });
        }
        return results;
    } catch (err) {
        logDebug('error', `[vectorHandler] Failed to query vectors: ${err.message}`);
        return [];
    }
}

/**
 * Purges the entire vector collection for this chat.
 * @param {string} collectionId
 */
export async function purgeVectorCollection(collectionId) {
    try {
        const payload = {
            ...getBaseVectorPayload(),
            collectionId
        };

        const response = await fetch('/api/vector/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error(`Server returned ${response.status} ${response.statusText}`);
        }

        logDebug('log', `[vectorHandler] Purged collection ${collectionId}`);
    } catch (err) {
        logDebug('error', `[vectorHandler] Failed to purge vectors: ${err.message}`);
    }
}
