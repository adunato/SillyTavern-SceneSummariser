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
 * @returns {object}
 */
function getBaseVectorPayload() {
    const vectorSettings = extension_settings?.vectors || {};
    return {
        source: vectorSettings.source || 'extras',
        ...vectorSettings
    };
}

/**
 * Inserts memory items into the dedicated vector collection.
 * @param {string} collectionId
 * @param {{ text: string, metadata: object }[]} items
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

        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        console.log(`[${extensionName}] [vectorHandler] Inserted ${items.length} items into ${collectionId}`);
    } catch (err) {
        console.error(`[${extensionName}] [vectorHandler] Failed to insert vectors:`, err);
    }
}

/**
 * Queries the dedicated vector collection for relevant memories.
 */
export async function queryVectorCollection(collectionId, searchText, topK, threshold) {
    if (!searchText) return [];
    
    // 0 = unlimited (we use 1000 as a safe high bound for the backend)
    const actualTopK = topK > 0 ? topK : 1000;

    console.log(`[${extensionName}] [vectorHandler] Querying ${collectionId} | topK: ${topK} (effective: ${actualTopK}) | threshold: ${threshold}`);
    console.log(`[${extensionName}] [vectorHandler] Query text: "${searchText.substring(0, 100)}..."`);

    try {
        const payload = {
            ...getBaseVectorPayload(),
            collectionId,
            searchText,
            topK: actualTopK,
            threshold
        };

        const response = await fetch('/api/vector/query', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            if (response.status === 404) {
                console.log(`[${extensionName}] [vectorHandler] Collection not found (404).`);
                return [];
            }
            throw new Error(`Server error: ${response.status}`);
        }

        const data = await response.json();
        const results = data.metadata || [];
        
        console.log(`[${extensionName}] [vectorHandler] Query returned ${results.length} results.`);
        if (results.length > 0 && data.scores) {
            results.forEach((r, i) => {
                console.log(`[${extensionName}] [vectorHandler]   #${i+1} [Score: ${data.scores[i].toFixed(3)}] ${r.text.substring(0, 60)}...`);
            });
        }
        return results;
    } catch (err) {
        console.error(`[${extensionName}] [vectorHandler] Query failed:`, err);
        return [];
    }
}

/**
 * Purges the entire vector collection for this chat.
 */
export async function purgeVectorCollection(collectionId) {
    try {
        const response = await fetch('/api/vector/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ ...getBaseVectorPayload(), collectionId }),
        });
        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        console.log(`[${extensionName}] [vectorHandler] Purged ${collectionId}`);
    } catch (err) {
        console.error(`[${extensionName}] [vectorHandler] Purge failed:`, err);
    }
}
