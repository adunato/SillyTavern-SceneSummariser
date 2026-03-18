import { getContext } from '../../../../../extensions.js';
import { defaultSettings } from '../constants.js';
import { logDebug } from '../utils/logger.js';
import { getSSMemoryFileName, writeSSMemoriesFile } from '../storage/memoryFileHandler.js';
import { getActiveChatId } from '../state/stateManager.js';

export function parseExtractionResponse(raw) {
    const text = (raw || '').trim();
    const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i);
    const titleMatch = text.match(/<title>([\s\S]*?)<\/title>/i);
    const descMatch = text.match(/<description>([\s\S]*?)<\/description>/i);
    const memoryBlocksRaw = [...text.matchAll(/<memor(?:y|ies)>([\s\S]*?)<\/memor(?:y|ies)>/gi)];

    let summaryText = summaryMatch ? summaryMatch[1].trim() : text;
    let title = titleMatch ? titleMatch[1].trim() : '';
    let description = descMatch ? descMatch[1].trim() : '';
    
    // 1. Remove any <memory>, <title>, or <description> blocks (including content) that might be inside the summaryText
    summaryText = summaryText.replace(/<memor(?:y|ies)>[\s\S]*?<\/memor(?:y|ies)>/gi, '').trim();
    summaryText = summaryText.replace(/<title>[\s\S]*?<\/title>/gi, '').trim();
    summaryText = summaryText.replace(/<description>[\s\S]*?<\/description>/gi, '').trim();
    
    // 2. Strip any residual or malformed tags (just the tags, keep content)
    summaryText = summaryText.replace(/<\/?summary>/gi, '').trim();
    summaryText = summaryText.replace(/<\/?memor(?:y|ies)>/gi, '').trim();
    summaryText = summaryText.replace(/<\/?title>/gi, '').trim();
    summaryText = summaryText.replace(/<\/?description>/gi, '').trim();
    
    const blocks = [];

    for (const blockMatch of memoryBlocksRaw) {
        const lines = blockMatch[1].split('\n').map(l => l.trim()).filter(l => l);
        if (lines.length === 0 || lines.some(l => l === 'NO_NEW_MEMORIES')) continue;

        let currentBlock = null;

        for (const line of lines) {
            if (line.startsWith('- ') || line.startsWith('* ')) {
                const bulletText = line.slice(2).trim();
                
                // Check if this bullet is a header: starts with [
                if (bulletText.startsWith('[')) {
                    // Start a new block
                    if (currentBlock && currentBlock.bullets.length > 0) {
                        blocks.push(currentBlock);
                    }
                    
                    let characters = [];
                    const bracketMatch = bulletText.match(/^\[(.*?)\]/);
                    if (bracketMatch) {
                        const inside = bracketMatch[1];
                        const charPart = inside.split(/—|-/)[0]; // get text before the dash
                        if (charPart) {
                            characters = charPart.split(',').map(c => c.trim()).filter(c => c);
                        }
                    }

                    currentBlock = {
                        header: bulletText,
                        characters: characters,
                        bullets: []
                    };
                    continue;
                }
                
                // If it's not a header, add to current block
                if (currentBlock) {
                    currentBlock.bullets.push(bulletText);
                } else {
                    // Fallback for bullets without a header
                    currentBlock = {
                        header: '[General]',
                        characters: [],
                        bullets: [bulletText]
                    };
                }
            }
        }
        
        if (currentBlock && currentBlock.bullets.length > 0) {
            blocks.push(currentBlock);
        }
    }
    
    return { summaryText, blocks, title, description };
}

/**
 * Builds the LLM prompt for the current summarisation pass.
 * When memoryExtractionEnabled is true, uses memoryPrompt (combined template).
 * When false, falls back to summaryPrompt (legacy behaviour).
 * @param {string} transcript Chat transcript text.
 * @param {object} settings Extension settings.
 * @param {string} previousSummaryText Concatenated previous snapshot texts.
 * @param {object} [chatState={}] The current chat state to extract existing memories.
 * @returns {string}
 */
export function buildExtractionPrompt(transcript, settings, previousSummaryText, chatState = {}) {
    const ctx = getContext();
    const charName = ctx?.name2 || 'Character';
    const words = settings.summaryWords || defaultSettings.summaryWords;
    const enabled = settings.memoryExtractionEnabled ?? defaultSettings.memoryExtractionEnabled;
    const template = enabled
        ? (settings.memoryPrompt || defaultSettings.memoryPrompt)
        : (settings.summaryPrompt || defaultSettings.summaryPrompt);

    const existingMemories = (chatState.memories && chatState.memories.length > 0)
        ? chatState.memories.map(m => `- ${m.text}`).join('\n')
        : 'None';

    return template
        .replace(/\{\{words\}\}/g, words)
        .replace(/\{\{summary\}\}/g, previousSummaryText || '')
        .replace(/\{\{last_messages\}\}/g, transcript || '(no messages)')
        .replace(/\{\{charName\}\}/g, charName)
        .replace(/\{\{existingMemories\}\}/g, existingMemories);
}

/**
 * Prunes the oldest memories from chatState.memories[] when maxMemories is set.
 * @param {object} chatState
 * @param {object} settings
 */
export function pruneMemories(chatState, settings) {
    const max = Number(settings.maxMemories ?? defaultSettings.maxMemories);
    if (max <= 0) return;
    while (chatState.memories.length > max) chatState.memories.shift();
}

export function getLatestSnapshot(chatState) {
    if (!chatState?.snapshots?.length) return null;
    return chatState.snapshots[chatState.snapshots.length - 1];
}

export function buildSummaryText(chatState, settings) {
    if (!chatState?.snapshots?.length) return '';
    if (settings?.storeHistory) {
        const max = settings.maxSummaries !== undefined ? settings.maxSummaries : defaultSettings.maxSummaries;
        let lastSnapshots = chatState.snapshots;
        if (max > 0) {
            lastSnapshots = chatState.snapshots.slice(-max);
        }
        return lastSnapshots.map(s => `${s.title}: ${s.text}`).join('\n');
    }
    const latest = getLatestSnapshot(chatState);
    return latest ? `${latest.title}: ${latest.text}` : '';
}

/**
 * Purges memories that are not associated with any existing snapshot.
 * Useful for cleaning up orphans from older versions or failed deletions.
 * @param {object} chatState 
 */
export async function reconcileMemories(chatState) {
    if (!chatState.memories?.length) return;

    const snapshotTitles = new Set(chatState.snapshots.map(s => s.title));
    const initialCount = chatState.memories.length;
    
    // Filter out memories whose label is missing or doesn't match an existing snapshot
    chatState.memories = chatState.memories.filter(m => m.chatLabel && snapshotTitles.has(m.chatLabel));

    if (chatState.memories.length !== initialCount) {
        logDebug('log', `Reconciliation: Purged ${initialCount - chatState.memories.length} orphaned memories.`);
        const ctx = getContext();
        // @ts-ignore
        const avatar = ctx?.characters?.[ctx?.characterId]?.avatar
            // @ts-ignore
            || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined);
        
        if (avatar) {
            const fileName = getSSMemoryFileName(getActiveChatId());
            await writeSSMemoriesFile(avatar, fileName, chatState.memories);
        }
    }
}
