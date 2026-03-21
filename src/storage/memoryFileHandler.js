import { extensionName } from '../constants.js';
import { logDebug } from '../utils/logger.js';
import { extension_settings, getContext } from '../../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../../script.js';
import { deleteFileFromServer } from '../../../../../../scripts/chats.js';
import { getActiveChatId } from '../state/stateManager.js';
import { getChatCollectionId, insertVectorItems, purgeVectorCollection } from './vectorHandler.js';

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
 */
export async function persistMemoriesForChat(chatState) {
    await cleanupLegacyDataBankFiles();
    const collectionId = getChatCollectionId();
    await purgeVectorCollection(collectionId);

    const items = [];
    if (Array.isArray(chatState.snapshots)) {
        for (const snapshot of chatState.snapshots) {
            if (Array.isArray(snapshot.memories)) {
                for (const memText of snapshot.memories) {
                    if (!memText.trim()) continue;
                    // Store text for search, and snapshotId in metadata for deduplication
                    items.push({
                        text: `${snapshot.title}:\n- ${memText}`,
                        metadata: {
                            snapshotId: snapshot.id,
                            fact: memText
                        }
                    });
                }
            }
        }
    }

    if (items.length > 0) {
        await insertVectorItems(collectionId, items);
    }
}
