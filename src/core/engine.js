import { getContext } from '../../../../../extensions.js';
import { defaultSettings } from '../constants.js';
import { logDebug } from '../utils/logger.js';
import { getActiveChatId } from '../state/stateManager.js';

export function parseExtractionResponse(raw) {
    const text = (raw || '').trim();
    const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i);
    const titleMatch = text.match(/<title>([\s\S]*?)<\/title>/i);
    const descMatch = text.match(/<description>([\s\S]*?)<\/description>/i);
    const memoryMatch = text.match(/<memor(?:y|ies)>([\s\S]*?)<\/memor(?:y|ies)>/i);

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
    
    const memories = [];

    if (memoryMatch) {
        const lines = memoryMatch[1].split('\n').map(l => l.trim()).filter(l => l);
        if (!lines.some(l => l === 'NO_NEW_MEMORIES')) {
            for (const line of lines) {
                if (line.startsWith('- ') || line.startsWith('* ')) {
                    const bulletText = line.slice(2).trim();
                    if (bulletText) memories.push(bulletText);
                }
            }
        }
    }
    
    return { summaryText, memories, title, description };
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
    
    let charNames = ctx?.name2 || 'Character';
    if (ctx?.groupId && Array.isArray(ctx?.groups) && Array.isArray(ctx?.characters)) {
        const group = ctx.groups.find(g => g.id === ctx.groupId);
        if (group && Array.isArray(group.members)) {
            const memberNames = group.members.map(avatar => {
                const char = ctx.characters.find(c => c.avatar === avatar);
                return char ? char.name : null;
            }).filter(Boolean);
            if (memberNames.length > 0) {
                charNames = memberNames.join(', ');
            }
        }
    }

    const words = settings.summaryWords || defaultSettings.summaryWords;
    const enabled = settings.memoryExtractionEnabled ?? defaultSettings.memoryExtractionEnabled;
    const template = enabled
        ? (settings.memoryPrompt || defaultSettings.memoryPrompt)
        : (settings.summaryPrompt || defaultSettings.summaryPrompt);

    // Extract memories from all snapshots and flatten them
    const allMemories = (chatState.snapshots || []).flatMap(s => s.memories || []);
    
    const existingMemories = allMemories.length > 0
        ? allMemories.map(m => `- ${m}`).join('\n')
        : 'None';

    return template
        .replace(/\{\{words\}\}/g, words)
        .replace(/\{\{summary\}\}/g, previousSummaryText || '')
        .replace(/\{\{last_messages\}\}/g, transcript || '(no messages)')
        .replace(/\{\{charNames\}\}/g, charNames)
        .replace(/\{\{charName\}\}/g, charNames) // fallback for older prompts
        .replace(/\{\{existingMemories\}\}/g, existingMemories);
}

export function getLatestSnapshot(chatState) {
    if (!chatState?.snapshots?.length) return null;
    return chatState.snapshots[chatState.snapshots.length - 1];
}

export function buildSummaryText(chatState, settings) {
    if (!chatState?.snapshots?.length) return '';
    const count = Number(settings?.summariesToInject !== undefined ? settings.summariesToInject : defaultSettings.summariesToInject);
    const fullCount = Number(settings?.fullSummariesToInject !== undefined ? settings.fullSummariesToInject : defaultSettings.fullSummariesToInject);

    let lastSnapshots = chatState.snapshots;
    if (count > 0) {
        lastSnapshots = chatState.snapshots.slice(-count);
    }

    return lastSnapshots.map((s, index) => {
        // If fullCount is 0, all injected snapshots are full text.
        // Otherwise, only the last 'fullCount' snapshots in the injected list are full text.
        const isFull = fullCount === 0 || (lastSnapshots.length - index <= fullCount);
        
        if (isFull) {
            return `${s.title}: ${s.text}`;
        } else {
            return `${s.title}: ${s.description || 'No description available.'}`;
        }
    }).join('\n');
}
