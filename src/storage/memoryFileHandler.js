import { extensionName } from '../constants.js';
import { logDebug } from '../utils/logger.js';
import { extension_settings } from '../../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../../script.js';
import {
    uploadFileAttachment,
    getFileAttachment,
    deleteFileFromServer,
} from '../../../../../../scripts/chats.js';
import { getStringHash, convertTextToBase64 } from '../../../../../../scripts/utils.js';

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
 * @param {string} avatar
 * @param {string} fileName
 * @param {object[]} memories List of memory objects from chatState.
 */
export async function writeSSMemoriesFile(avatar, fileName, memories) {
    console.log(`[${extensionName}] writeSSMemoriesFile called for avatar: ${avatar}, fileName: ${fileName}, memories count: ${memories.length}`);
    if (!extension_settings.character_attachments) extension_settings.character_attachments = {};
    if (!Array.isArray(extension_settings.character_attachments[avatar])) {
        extension_settings.character_attachments[avatar] = [];
    }

    if (!memories.length) {
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

    // Group memories by scene label and then by block header
    const blocks = [];
    const grouped = {};
    for (const m of memories) {
        const sceneLabel = m.chatLabel || 'Memory Index';
        const blockHeader = m.blockHeader || '[General]';
        
        if (!grouped[sceneLabel]) grouped[sceneLabel] = {};
        if (!grouped[sceneLabel][blockHeader]) grouped[sceneLabel][blockHeader] = [];
        
        grouped[sceneLabel][blockHeader].push(m.text);
    }

    for (const [sceneLabel, headers] of Object.entries(grouped)) {
        const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        let allBulletsText = '';
        for (const [header, texts] of Object.entries(headers)) {
            allBulletsText += `- ${header}\n` + texts.map(t => `- ${t}`).join('\n') + '\n';
        }
        blocks.push(`<memory chat="${sceneLabel}" date="${timestamp}">\n${allBulletsText.trim()}\n</memory>`);
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
