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
    
    summaryText = summaryText.replace(/<memor(?:y|ies)>[\s\S]*?<\/memor(?:y|ies)>/gi, '').trim();
    summaryText = summaryText.replace(/<title>[\s\S]*?<\/title>/gi, '').trim();
    summaryText = summaryText.replace(/<description>[\s\S]*?<\/description>/gi, '').trim();
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
            if (memberNames.length > 0) charNames = memberNames.join(', ');
        }
    }
    const words = settings.summaryWords || defaultSettings.summaryWords;
    const enabled = settings.memoryExtractionEnabled ?? defaultSettings.memoryExtractionEnabled;
    const template = enabled ? (settings.memoryPrompt || defaultSettings.memoryPrompt) : (settings.summaryPrompt || defaultSettings.summaryPrompt);
    const allMemories = (chatState.snapshots || []).flatMap(s => s.memories || []);
    const existingMemories = allMemories.length > 0 ? allMemories.map(m => `- ${m}`).join('\n') : 'None';
    return template
        .replace(/\{\{words\}\}/g, words)
        .replace(/\{\{summary\}\}/g, previousSummaryText || '')
        .replace(/\{\{last_messages\}\}/g, transcript || '(no messages)')
        .replace(/\{\{charNames\}\}/g, charNames)
        .replace(/\{\{charName\}\}/g, charNames)
        .replace(/\{\{existingMemories\}\}/g, existingMemories);
}

export function getLatestSnapshot(chatState) {
    if (!chatState?.snapshots?.length) return null;
    return chatState.snapshots[chatState.snapshots.length - 1];
}

export function buildSummaryText(chatState, settings) {
    if (!chatState?.snapshots?.length && !chatState?.currentSemanticResults?.length) return '';
    const count = Number(settings?.summariesToInject !== undefined ? settings.summariesToInject : defaultSettings.summariesToInject);
    const fullSummaryCount = Number(settings?.fullSummariesToInject !== undefined ? settings.fullSummariesToInject : defaultSettings.fullSummariesToInject);
    const fullMemoryCount = Number(settings?.fullMemoriesToInject !== undefined ? settings.fullMemoriesToInject : defaultSettings.fullMemoriesToInject);
    const memoryEnabled = settings?.memoryExtractionEnabled ?? defaultSettings.memoryExtractionEnabled;
    const semanticEnabled = settings?.semanticRetrievalEnabled ?? false;

    let lastSnapshots = chatState.snapshots || [];
    if (count > 0) lastSnapshots = lastSnapshots.slice(-count);

    const injectedBlocks = [];
    const injectedFacts = new Set(); 

    lastSnapshots.forEach((s, index) => {
        const isFullSummary = fullSummaryCount === 0 || (lastSnapshots.length - index <= fullSummaryCount);
        const isFullMemory = fullMemoryCount === 0 || (lastSnapshots.length - index <= fullMemoryCount);

        let blockText = isFullSummary ? `${s.title}: ${s.text}` : `${s.title}: ${s.description || 'No description available.'}`;

        if (memoryEnabled && s.memories && s.memories.length > 0) {
            if (isFullMemory || !semanticEnabled) {
                const memoriesList = s.memories.map(m => `- ${m}`).join('\n');
                blockText += `\nMemories:\n${memoriesList}`;
                s.memories.forEach(m => injectedFacts.add(m));
            } else {
                const relevantFacts = [];
                if (chatState.currentSemanticResults) {
                    chatState.currentSemanticResults.forEach(res => {
                        const resMetadata = res.metadata || {};
                        const resText = res.text || '';
                        let isMatch = false;
                        if (resMetadata.snapshotId !== undefined) {
                            isMatch = Number(resMetadata.snapshotId) === s.id;
                        } else {
                            isMatch = resText.startsWith(`${s.title}:\n- `);
                        }
                        if (isMatch) {
                            const fact = resMetadata.fact || resText.substring(resText.indexOf('\n- ') + 3).trim();
                            relevantFacts.push(fact);
                            injectedFacts.add(fact);
                        }
                    });
                }
                if (relevantFacts.length > 0) {
                    blockText += `\nRelevant Memories:\n${relevantFacts.map(m => `- ${m}`).join('\n')}`;
                }
            }
        }
        injectedBlocks.push(blockText);
    });

    if (semanticEnabled && memoryEnabled && chatState.currentSemanticResults) {
        const standaloneFacts = [];
        chatState.currentSemanticResults.forEach(res => {
            const resMetadata = res.metadata || {};
            const resText = res.text || '';
            const fact = resMetadata.fact || resText.substring(resText.indexOf('\n- ') + 3).trim();
            if (!injectedFacts.has(fact)) {
                const title = resMetadata.title || resText.split(':')[0] || 'Memory';
                standaloneFacts.push(`[${title}] ${fact}`);
            }
        });
        if (standaloneFacts.length > 0) {
            injectedBlocks.unshift(`<recalled_memories>\n${standaloneFacts.join('\n')}\n</recalled_memories>`);
        }
    }
    return injectedBlocks.join('\n\n');
}
