import { extensionName } from '../constants.js';
import { logDebug } from '../utils/logger.js';
import { extension_settings, getContext } from '../../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../../script.js';
import { deleteFileFromServer } from '../../../../../../scripts/chats.js';
import { getActiveChatId } from '../state/stateManager.js';
import { getChatCollectionId, insertVectorItems, purgeVectorCollection } from './vectorHandler.js';

/**
 * Returns the Data Bank filename used to store extracted memories for a given chat.
 * (Used for migration/cleanup)
 * @param {string} chatId
 * @returns {string}
 */
export function getLegacySSMemoryFileName(chatId) {
    const safeChatId = String(chatId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `ss-memories-${safeChatId}.md`;
}

/**
 * Finds the attachment record for a legacy memory file in a character's Data Bank.
 * @param {string} avatar
 * @param {string} fileName
 * @returns {object|null}
 */
export function findSSMemoryAttachment(avatar, fileName) {
    const attachments = extension_settings.character_attachments?.[avatar];
    if (!Array.isArray(attachments)) return null;
    return attachments.find(a => a.name === fileName) || null;
}

/**
 * Deletes legacy Data Bank markdown files and their attachment references.
 */
export async function cleanupLegacyDataBankFiles() {
    const ctx = getContext();
    const chatId = getActiveChatId();
    const fileName = getLegacySSMemoryFileName(chatId);
    
    const avatarsToCheck = [];

    if (ctx?.groupId && Array.isArray(ctx?.groups) && Array.isArray(ctx?.characters)) {
        const group = ctx.groups.find(g => g.id === ctx.groupId);
        if (group && Array.isArray(group.members)) {
            avatarsToCheck.push(...group.members);
        }
    } else {
        const avatar = ctx?.characters?.[ctx?.characterId]?.avatar
            // @ts-ignore
            || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined)
            || ctx?.avatar;
        if (avatar) avatarsToCheck.push(avatar);
    }

    let deletedAny = false;
    for (const avatar of avatarsToCheck) {
        if (!extension_settings.character_attachments?.[avatar]) continue;
        
        const oldAttachment = findSSMemoryAttachment(avatar, fileName);
        if (oldAttachment) {
            logDebug('log', `[cleanupLegacyDataBankFiles] Deleting legacy file at ${oldAttachment.url}`);
            try { await deleteFileFromServer(oldAttachment.url, true); } catch (_) { /* ignore */ }
            extension_settings.character_attachments[avatar] =
                extension_settings.character_attachments[avatar].filter(a => a.url !== oldAttachment.url);
            deletedAny = true;
        }
    }

    if (deletedAny) {
        saveSettingsDebounced();
        logDebug('log', '[cleanupLegacyDataBankFiles] Cleaned up legacy Data Bank files.');
    }
}

/**
 * Persists all memories in the chatState to the standalone vector collection.
 * Replaces the legacy Data Bank file generation.
 * @param {object} chatState 
 */
export async function persistMemoriesForChat(chatState) {
    // 1. Clean up any lingering legacy files
    await cleanupLegacyDataBankFiles();

    const collectionId = getChatCollectionId();
    
    // 2. Purge existing vector collection to ensure clean state
    await purgeVectorCollection(collectionId);

    // 3. Rebuild items list
    const items = [];
    
    if (Array.isArray(chatState.snapshots)) {
        for (const snapshot of chatState.snapshots) {
            if (Array.isArray(snapshot.memories) && snapshot.memories.length > 0) {
                for (let i = 0; i < snapshot.memories.length; i++) {
                    const memText = snapshot.memories[i];
                    if (!memText.trim()) continue;

                    // Tag with metadata in the text so we can parse it out if needed,
                    // or just store the plain text.
                    const text = `${snapshot.title}:\n- ${memText}`;
                    items.push({
                        text: text
                    });
                }
            }
        }
    }

    // 4. Insert into vector DB
    if (items.length > 0) {
        await insertVectorItems(collectionId, items);
        logDebug('log', `[persistMemoriesForChat] Rebuilt vector collection with ${items.length} items.`);
    } else {
        logDebug('log', '[persistMemoriesForChat] No memories to persist. Collection left empty.');
    }
}
