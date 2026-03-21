import { extension_settings, getContext } from '../../../../../extensions.js';
import { setExtensionPrompt, getExtensionPrompt, extension_prompts, extension_prompt_types, extension_prompt_roles } from '../../../../../../script.js';
import { eventSource, event_types } from '../../../../../../scripts/events.js';
import { settingsKey, extensionName, defaultSettings } from '../constants.js';
import { logDebug } from '../utils/logger.js';
import { getChatState, ensureSettings } from '../state/stateManager.js';
import { buildSummaryText } from './engine.js';
import { queryVectorCollection, getChatCollectionId } from '../storage/vectorHandler.js';

let lastRetrievalTime = 0;
const RETRIEVAL_COOLDOWN = 2000; 

export function scrubVectorStoragePrompt() {
}

/**
 * Performs semantic search and updates the transient state for building the summary prompt.
 */
export async function handleSemanticRetrieval(providedChat = null) {
    const now = Date.now();
    // Only cooldown if it's an automatic event-based call (no providedChat)
    if (!providedChat && (now - lastRetrievalTime < RETRIEVAL_COOLDOWN)) {
        return;
    }
    lastRetrievalTime = now;

    ensureSettings();
    const settings = extension_settings[settingsKey];
    if (!settings?.semanticRetrievalEnabled || !settings.enabled) {
        setExtensionPrompt('ss_vector_memories', '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
        return;
    }

    const chatState = getChatState();
    const chat = providedChat || getContext()?.chat || [];
    
    const queryDepth = Number(settings.semanticSearchDepth || 5);
    const recentMessages = chat.slice(-queryDepth).filter(m => !m.is_system).map(m => m.mes).join('\n');
    
    console.log(`[${extensionName}] [handleSemanticRetrieval] Running search (Depth: ${queryDepth})`);

    if (!recentMessages.trim()) return;

    const topK = Number(settings.semanticTopK !== undefined ? settings.semanticTopK : 5);
    const threshold = Number(settings.semanticThreshold || 0.1);
    const collectionId = getChatCollectionId();

    try {
        const results = await queryVectorCollection(collectionId, recentMessages, topK, threshold);
        
        if (!results || results.length === 0) {
            console.log(`[${extensionName}] [handleSemanticRetrieval] 0 matches found.`);
            chatState.currentSemanticResults = [];
        } else {
            console.log(`[${extensionName}] [handleSemanticRetrieval] Found ${results.length} relevant memories.`);
            chatState.currentSemanticResults = results;
        }
        
        applyInjection();

    } catch (err) {
        console.error(`[${extensionName}] [handleSemanticRetrieval] Failed:`, err);
    }
}

export function updateInjectionVisibility(container) {
    if (!container) return;
    const settings = extension_settings[settingsKey];
    const isInChat = String(settings.injectPosition) === '1'; 

    const depthInput = container.querySelector('#ss_injectDepth');
    const roleSelect = container.querySelector('#ss_injectRole');

    if (depthInput) {
        // @ts-ignore
        depthInput.disabled = !isInChat;
        // @ts-ignore
        depthInput.style.opacity = isInChat ? '1' : '0.5';
    }
    if (roleSelect) {
        // @ts-ignore
        roleSelect.disabled = !isInChat;
        // @ts-ignore
        roleSelect.style.opacity = isInChat ? '1' : '0.5';
    }
}

export function updateContextControlVisibility(container) {
}

export function applyInjection() {
    const settings = extension_settings[settingsKey];
    const chatState = getChatState();
    
    if (!settings || !settings.injectEnabled || !settings.enabled) {
        try {
            setExtensionPrompt(extensionName, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
        } catch (err) {}
        return;
    }

    const position = Number(settings.injectPosition ?? extension_prompt_types.IN_PROMPT);
    if (position === extension_prompt_types.NONE) {
        try {
            setExtensionPrompt(extensionName, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
        } catch (err) {}
        return;
    }

    const template = settings.injectTemplate || defaultSettings.injectTemplate;
    const summaryText = buildSummaryText(chatState, settings);
    
    const value = template
        .replace(/\{\{summary\}\}/ig, summaryText);

    const depth = Number(settings.injectDepth ?? 2);
    const scan = !!settings.injectScan;
    const role = Number(settings.injectRole ?? extension_prompt_roles.SYSTEM);

    try {
        setExtensionPrompt(extensionName, value, position, depth, scan, role);
    } catch (err) {
        console.error(`[${extensionName}] Failed to set injection prompt:`, err);
    }
}

export async function insertSceneBreakMarker(snapshotId) {
    const ctx = getContext();
    if (!ctx || !Array.isArray(ctx.chat)) return;
    const chatState = getChatState();

    const markerId = `scene-break-${Date.now()}`;
    const markerHtml = `<details class="scene-summary-break" data-marker-id="${markerId}"><summary>📑 Scene Summary Boundary</summary><div>Summaries above; new messages below.</div></details>`;
    const message = {
        name: extensionName,
        is_user: false,
        is_system: true,
        mes: markerHtml,
        extra: {
            scene_summariser_marker: true,
            marker_id: markerId,
            snapshot_id: snapshotId,
        },
        send_date: Date.now(),
    };

    ctx.chat.push(message);
    const messageId = ctx.chat.length - 1;
    try {
        await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'extension');
        // @ts-ignore
        ctx.addOneMessage(message);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
        if (typeof ctx.saveChat === 'function') {
            await ctx.saveChat();
        }
    } catch (err) {
        console.error(`[${extensionName}] Failed to add scene break marker:`, err);
    }

    chatState.sceneBreakMarkerId = markerId;
    chatState.sceneBreakMesId = messageId;
}

/**
 * Context interceptor for filtering messages
 */
export async function filterContextInterceptor(chat, maxContext, abort, type) {
    if (type === 'quiet') return;

    ensureSettings();
    const settings = extension_settings[settingsKey];
    
    if (settings?.enabled && settings?.semanticRetrievalEnabled) {
        await handleSemanticRetrieval(chat);
    }

    if (!settings?.limitToUnsummarised) return;

    const ctx = getContext();
    const fullChat = ctx?.chat || [];
    let markerIndexFull = -1;

    for (let i = fullChat.length - 1; i >= 0; i--) {
        const m = fullChat[i];
        if (m?.extra?.scene_summariser_marker) {
            markerIndexFull = i;
            break;
        }
        const content = m?.mes || '';
        if (content.includes('scene-summary-break')) {
            markerIndexFull = i;
            break;
        }
    }

    if (markerIndexFull !== -1) {
        let chatPtr = 0;
        for (let i = 0; i <= markerIndexFull; i++) {
            const fMsg = fullChat[i];
            const cMsg = chat[chatPtr];
            if (!cMsg) break;
            const isMatch = fMsg.send_date === cMsg.send_date &&
                !!fMsg.is_user === !!cMsg.is_user &&
                !!fMsg.is_system === !!cMsg.is_system &&
                fMsg.name === cMsg.name;
            if (isMatch) chatPtr++;
        }

        const keepCount = Number(settings?.keepMessagesCount || 0);
        const removedItemsCount = Math.max(0, chatPtr - keepCount);
        if (removedItemsCount > 0) {
            chat.splice(0, removedItemsCount);
        }
    }
}
