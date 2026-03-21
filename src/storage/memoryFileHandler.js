import { extensionName } from '../constants.js';
import { logDebug } from '../utils/logger.js';
import { extension_settings, getContext } from '../../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../../script.js';
import {
    uploadFileAttachment,
    getFileAttachment,
    deleteFileFromServer,
} from '../../../../../../scripts/chats.js';
import { getStringHash, convertTextToBase64 } from '../../../../../../scripts/utils.js';
import { getActiveChatId } from '../state/stateManager.js';

/**
 * Persists all memories in the chatState to the Data Bank.
 * Handles both 1-on-1 chats and group chats, dispatching facts to individual character files based on prefixes.
 * @param {object} chatState 
 */
export async function persistMemoriesForChat(chatState) {
    const ctx = getContext();
    const chatId = getActiveChatId();
    
    if (ctx?.groupId && Array.isArray(ctx?.groups) && Array.isArray(ctx?.characters)) {
        const group = ctx.groups.find(g => g.id === ctx.groupId);
        if (group && Array.isArray(group.members)) {
            for (const avatar of group.members) {
                const char = ctx.characters.find(c => c.avatar === avatar);
                if (char && char.name) {
                    const fileName = getSSMemoryFileName(chatId);
                    await writeSSMemoriesFile(avatar, fileName, chatState.snapshots, char.name);
                }
            }
            return;
        }
    }

    const avatar = ctx?.characters?.[ctx?.characterId]?.avatar
        // @ts-ignore
        || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined)
        || ctx?.avatar;
    
    if (avatar) {
        const fileName = getSSMemoryFileName(chatId);
        await writeSSMemoriesFile(avatar, fileName, chatState.snapshots);
    }
}

/**
 * Returns the Data Bank filename used to store extracted memories for a given chat.
 * @param {string} chatId
 * @returns {string}
 */
export function getSSMemoryFileName(chatId) {
    const safeChatId = String(chatId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `ss-memories-${safeChatId}.md`;
}

/**
 * Finds the attachment record for a SceneSummariser memory file in a character's Data Bank.
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
 * Reads the content of a SceneSummariser memory file from the Data Bank.
 * @param {string} avatar
 * @param {string} fileName
 * @returns {Promise<string>}
 */
export async function readSSMemoriesFile(avatar, fileName) {
    const attachment = findSSMemoryAttachment(avatar, fileName);
    if (!attachment) return '';
    try {
        return (await getFileAttachment(attachment.url)) || '';
    } catch (err) {
        logDebug('error', 'Failed to read memory file', err?.message || err);
        return '';
    }
}

/**
 * Appends a new <memory> block to the Data Bank file, rewriting the file via uploadFileAttachment.
 * Mirrors CharMemory's writeMemoriesForCharacter pattern.
 * @param {string} avatar
 * @param {string} fileName
 * @param {string} newBlockMarkdown
 */
export async function appendSSMemoriesBlock(avatar, fileName, newBlockMarkdown) {
    console.log(`[${extensionName}] appendSSMemoriesBlock called for avatar: ${avatar}, fileName: ${fileName}`);
    if (!extension_settings.character_attachments) extension_settings.character_attachments = {};
    if (!Array.isArray(extension_settings.character_attachments[avatar])) {
        extension_settings.character_attachments[avatar] = [];
    }

    const existing = await readSSMemoriesFile(avatar, fileName);
    // Ensure dash formatting even if incoming markdown uses stars
    const cleanedBlock = newBlockMarkdown.replace(/^\* /gm, '- ');
    const newContent = existing
        ? `${existing.trimEnd()}\n\n${cleanedBlock}`
        : cleanedBlock;

    console.log(`[${extensionName}] appendSSMemoriesBlock: newContent length: ${newContent.length}`);

    // Delete old file if present
    const oldAttachment = findSSMemoryAttachment(avatar, fileName);
    if (oldAttachment) {
        console.log(`[${extensionName}] appendSSMemoriesBlock: deleting old attachment at ${oldAttachment.url}`);
        try { await deleteFileFromServer(oldAttachment.url, true); } catch (_) { /* ignore */ }
        extension_settings.character_attachments[avatar] =
            extension_settings.character_attachments[avatar].filter(a => a.url !== oldAttachment.url);
    }

    // Upload new file
    const base64Data = convertTextToBase64(newContent);
    const slug = getStringHash(fileName);
    const uniqueFileName = `${Date.now()}_${slug}.txt`;
    const fileUrl = await uploadFileAttachment(uniqueFileName, base64Data);
    if (!fileUrl) {
        console.error(`[${extensionName}] appendSSMemoriesBlock: uploadFileAttachment returned no URL`);
        logDebug('error', 'appendSSMemoriesBlock: uploadFileAttachment returned no URL');
        return;
    }

    console.log(`[${extensionName}] appendSSMemoriesBlock: uploaded new file to ${fileUrl}`);

    extension_settings.character_attachments[avatar].push({
        url: fileUrl,
        size: newContent.length,
        name: fileName,
        created: Date.now(),
    });
    saveSettingsDebounced();
    logDebug('log', `Memory file updated: ${fileName} (${newContent.length} bytes)`);
    console.log(`[${extensionName}] appendSSMemoriesBlock: state updated. Total attachments for avatar: ${extension_settings.character_attachments[avatar].length}`);
}

/**
 * Rebuilds and overwrites the entire Data Bank memory file from the current chatState index.
 * Used after manual edits or deletions.
 * @param {string} avatar The character's avatar path (used as the Data Bank key).
 * @param {string} fileName The file name to use.
 * @param {object[]} snapshots List of snapshot objects from chatState.
 * @param {string} [characterName] The character's name to filter facts by. If not provided, writes all facts.
 */
export async function writeSSMemoriesFile(avatar, fileName, snapshots, characterName = null) {
    console.log(`[${extensionName}] writeSSMemoriesFile called for avatar: ${avatar}, fileName: ${fileName}, filter: ${characterName}`);
    if (!extension_settings.character_attachments) extension_settings.character_attachments = {};
    if (!Array.isArray(extension_settings.character_attachments[avatar])) {
        extension_settings.character_attachments[avatar] = [];
    }

    const blocks = [];

    for (const snapshot of snapshots) {
        if (snapshot.memories && snapshot.memories.length > 0) {
            const timestamp = new Date(snapshot.createdAt || Date.now()).toISOString().slice(0, 16).replace('T', ' ');
            
            // Filter facts for the target character if provided
            let filteredMemories = snapshot.memories;
            if (characterName) {
                filteredMemories = snapshot.memories.filter(mem => {
                    const match = mem.match(/^([^:]+):/);
                    if (match) {
                        const chars = match[1].split(',').map(c => c.trim()).filter(c => c);
                        return chars.includes(characterName);
                    }
                    return false; // If no prefix, it's malformed or legacy; exclude it from group writes
                });
            }

            if (filteredMemories.length > 0) {
                const bullets = filteredMemories.map(t => `- ${t}`).join('\n');
                blocks.push(`<memory chat="${snapshot.title}" date="${timestamp}">\n${bullets}\n</memory>`);
            }
        }
    }

    if (!blocks.length) {
        // If no memories, delete the file
        const oldAttachment = findSSMemoryAttachment(avatar, fileName);
        if (oldAttachment) {
            console.log(`[${extensionName}] writeSSMemoriesFile: deleting empty attachment at ${oldAttachment.url}`);
            try { deleteFileFromServer(oldAttachment.url, true); } catch (_) { /* ignore */ }
            extension_settings.character_attachments[avatar] =
                extension_settings.character_attachments[avatar].filter(a => a.url !== oldAttachment.url);
            saveSettingsDebounced();
        }
        return;
    }

    const newContent = blocks.join('\n\n');
    console.log(`[${extensionName}] writeSSMemoriesFile: generated newContent length: ${newContent.length}`);

    // Delete old file
    const oldAttachment = findSSMemoryAttachment(avatar, fileName);
    if (oldAttachment) {
        console.log(`[${extensionName}] writeSSMemoriesFile: deleting old attachment at ${oldAttachment.url}`);
        try { await deleteFileFromServer(oldAttachment.url, true); } catch (_) { /* ignore */ }
        extension_settings.character_attachments[avatar] =
            extension_settings.character_attachments[avatar].filter(a => a.url !== oldAttachment.url);
    }

    // Upload new file
    const base64Data = convertTextToBase64(newContent);
    const slug = getStringHash(fileName);
    const uniqueFileName = `${Date.now()}_${slug}.txt`;
    const fileUrl = await uploadFileAttachment(uniqueFileName, base64Data);
    if (!fileUrl) {
        console.error(`[${extensionName}] writeSSMemoriesFile: uploadFileAttachment returned no URL`);
        logDebug('error', 'writeSSMemoriesFile: uploadFileAttachment returned no URL');
        return;
    }

    console.log(`[${extensionName}] writeSSMemoriesFile: uploaded new file to ${fileUrl}`);

    extension_settings.character_attachments[avatar].push({
        url: fileUrl,
        size: newContent.length,
        name: fileName,
        created: Date.now(),
    });
    saveSettingsDebounced();
    logDebug('log', `Memory file rebuilt: ${fileName} (${newContent.length} bytes)`);
    console.log(`[${extensionName}] writeSSMemoriesFile: state updated. Total attachments for avatar: ${extension_settings.character_attachments[avatar].length}`);
}
