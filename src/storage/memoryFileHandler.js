import { extensionName } from '../constants.js';
import { logDebug } from '../utils/logger.js';
import { extension_settings, getContext } from '../../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../../script.js';
import { getStringHash } from '../../../../../utils.js';
import { deleteFileFromServer } from '../../../../../../scripts/chats.js';
import { getActiveChatId } from '../state/stateManager.js';
import { getChatCollectionId, insertVectorItems, listVectorHashes, deleteVectorItems } from './vectorHandler.js';

/**
 * Returns the Data Bank filename used to store extracted memories for a given chat.
 */
export function getLegacySSMemoryFileName(chatId) {
    const safeChatId = String(chatId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `ss-memories-${safeChatId}.md`;
}

export function findSSMemoryAttachment(avatar, fileName) {
    const attachments = extension_settings.character_attachments?.[avatar];
    if (!Array.isArray(attachments)) return null;
    return attachments.find(a => a.name === fileName) || null;
}

export async function cleanupLegacyDataBankFiles() {
    const ctx = getContext();
    const chatId = getActiveChatId();
    const fileName = getLegacySSMemoryFileName(chatId);
    const avatarsToCheck = [];

    if (ctx?.groupId && Array.isArray(ctx?.groups) && Array.isArray(ctx?.characters)) {
        const group = ctx.groups.find(g => g.id === ctx.groupId);
        if (group?.members) avatarsToCheck.push(...group.members);
    } else {
        const avatar = ctx?.characters?.[ctx?.characterId]?.avatar || ctx?.avatar;
        if (avatar) avatarsToCheck.push(avatar);
    }

    let deletedAny = false;
    for (const avatar of avatarsToCheck) {
        const oldAttachment = findSSMemoryAttachment(avatar, fileName);
        if (oldAttachment) {
            try { await deleteFileFromServer(oldAttachment.url, true); } catch (_) {}
            extension_settings.character_attachments[avatar] = extension_settings.character_attachments[avatar].filter(a => a.url !== oldAttachment.url);
            deletedAny = true;
        }
    }
    if (deletedAny) {
        saveSettingsDebounced();
        console.log(`[${extensionName}] Legacy Data Bank files cleaned up.`);
    }
}

/**
 * Persists all memories in the chatState to the standalone vector collection.
 * Uses incremental indexing (hash-based) to avoid redundant embedding generations.
 */
export async function persistMemoriesForChat(chatState) {
    await cleanupLegacyDataBankFiles();
    const collectionId = getChatCollectionId();

    // 1. Get existing hashes in the collection
    const existingHashes = await listVectorHashes(collectionId);
    const existingHashesSet = new Set(existingHashes.map(h => Number(h)));

    const currentItems = [];
    const currentHashesSet = new Set();

    // 2. Map current snapshots to vector items with composite hashes
    if (Array.isArray(chatState.snapshots)) {
        for (const snapshot of chatState.snapshots) {
            if (Array.isArray(snapshot.memories)) {
                snapshot.memories.forEach((memText, index) => {
                    if (!memText.trim()) return;

                    const text = `${snapshot.title}:\n- ${memText}`;
                    // Use a composite hash of snapshot ID and memory content
                    const hash = getStringHash(`${snapshot.id}_${memText}`);
                    
                    // Extract character associations (e.g. "Char1, Char2: fact")
                    const charMatch = memText.match(/^([^:]+):/);
                    const characters = charMatch 
                        ? charMatch[1].split(',').map(c => c.trim()).filter(c => c)
                        : [];

                    currentHashesSet.add(hash);
                    currentItems.push({
                        text,
                        hash,
                        index,
                        metadata: {
                            snapshotId: snapshot.id,
                            fact: memText,
                            characters: characters // Store as explicit array for filtering
                        }
                    });
                });
            }
        }
    }

    // 3. Identify items to insert (those not in existingHashesSet)
    const itemsToInsert = currentItems.filter(item => !existingHashesSet.has(item.hash));

    // 4. Identify hashes to delete (those in existingHashesSet but not in currentHashesSet)
    const hashesToDelete = Array.from(existingHashesSet).filter(hash => !currentHashesSet.has(hash));

    // 5. Perform updates
    if (hashesToDelete.length > 0) {
        logDebug('log', `[vectorHandler] Deleting ${hashesToDelete.length} obsolete items.`);
        await deleteVectorItems(collectionId, hashesToDelete);
    }

    if (itemsToInsert.length > 0) {
        logDebug('log', `[vectorHandler] Inserting ${itemsToInsert.length} new items.`);
        await insertVectorItems(collectionId, itemsToInsert);
    }

    if (hashesToDelete.length === 0 && itemsToInsert.length === 0) {
        logDebug('log', '[vectorHandler] No changes to vector storage needed.');
    }
}
