import { extension_settings, getContext } from '../../../../../extensions.js';
import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../../../script.js';
import { eventSource, event_types } from '../../../../../../scripts/events.js';
import { settingsKey, extensionName, defaultSettings } from '../constants.js';
import { logDebug } from '../utils/logger.js';
import { getChatState, ensureSettings } from '../state/stateManager.js';
import { buildSummaryText } from './engine.js';

export function updateInjectionVisibility(container) {
    if (!container) return;
    const settings = extension_settings[settingsKey];
    const isInChat = String(settings.injectPosition) === '1'; // IN_CHAT

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
    if (!container) return;
    const settings = extension_settings[settingsKey];
    // limitToUnsummarised controls whether we are trimming at all.
    // trimAfterSceneBreak is a refinement of HOW we trim.
    // However, trimAfterSceneBreak creates a visual marker which is also controlled by insertSceneBreak.

    // Logic: 
    // If limitToUnsummarised is OFF, then trimAfterSceneBreak does nothing relevant to the prompt (though it might still run logic).
    // Let's visualy imply dependency: trimAfterSceneBreak is only relevant if limitToUnsummarised is ON.

    const limitCheckbox = container.querySelector('#ss_limitToUnsummarised');
    // trimAfterSceneBreak removed as per user request (strict filtering enforced)
}

export function applyInjection() {
    const settings = extension_settings[settingsKey];
    const chatState = getChatState();
    if (!settings || !settings.injectEnabled || !settings.enabled) {
        try {
            setExtensionPrompt(extensionName, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
        } catch (err) {
            console.error(`[${extensionName}] Failed to clear injection:`, err);
        }
        return;
    }

    const position = Number(settings.injectPosition ?? extension_prompt_types.IN_PROMPT);
    if (position === extension_prompt_types.NONE) {
        try {
            setExtensionPrompt(extensionName, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
        } catch (err) {
            console.error(`[${extensionName}] Failed to clear injection (NONE):`, err);
        }
        return;
    }

    const template = settings.injectTemplate || defaultSettings.injectTemplate;
    const value = template
        .replace(/\{\{summary\}\}/ig, buildSummaryText(chatState, settings));

    const depth = Number(settings.injectDepth ?? 2);
    const scan = !!settings.injectScan;
    const role = Number(settings.injectRole ?? extension_prompt_roles.SYSTEM);

    try {
        setExtensionPrompt(extensionName, value, position, depth, scan, role);
        const valuePreview = value ? (value.substring(0, 50).replace(/\n/g, ' ') + '...') : '[empty]';
        logDebug('log', `[applyInjection] Injection updated (pos=${position}, depth=${depth}, scan=${scan}, role=${role}). Value preview: ${valuePreview}, value length: ${value ? value.length : 0}`);
    } catch (err) {
        console.error(`[${extensionName}] Failed to set injection prompt:`, err);
        logDebug('error', 'Failed to set injection prompt', err?.message || err);
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
    logDebug('log', 'Inserted scene break marker', markerId, messageId, snapshotId);
}

/**
 * Context interceptor for filtering messages
 * @param {object[]} chat The chat array to filter
 * @param {number} maxContext The maximum context size (unused here but passed by ST)
 * @param {function} abort Function to abort generation
 * @param {string} type Generation type ('chat', 'text', 'quiet', etc)
 */
export async function filterContextInterceptor(chat, maxContext, abort, type) {
    if (type === 'quiet') return; // Don't interfere with internal quiet prompts

    ensureSettings();
    const settings = extension_settings[settingsKey];
    logDebug('log', `[filterContextInterceptor] Triggered. type=${type}, maxContext=${maxContext}, original_chat_length=${chat.length}, limitToUnsummarised=${settings?.limitToUnsummarised}`);

    if (!settings?.limitToUnsummarised) {
        logDebug('log', '[filterContextInterceptor] limitToUnsummarised is disabled. Bailing out.');
        return;
    }

    // Optional: Log the very last message just to see what kind of objects we're receiving
    if (chat.length > 0) {
        logDebug('log', `[filterContextInterceptor] Sample chat message keys: ${Object.keys(chat[chat.length - 1]).join(', ')}`);
        const sampleMes = chat[chat.length - 1].mes || '';
        logDebug('log', `[filterContextInterceptor] Sample chat message mes start: ${sampleMes.substring(0, 30)}...`);
    }

    const ctx = getContext();
    const fullChat = ctx?.chat || [];
    let markerIndexFull = -1;
    let foundType = 'none';

    // 1. SillyTavern filters out is_system messages from the chat array passed to generate_interceptor.
    // Therefore, the marker will never be in `chat`. We scan BACKWARDS in `fullChat`.
    for (let i = fullChat.length - 1; i >= 0; i--) {
        const m = fullChat[i];

        // 1. Check Metadata (Robust)
        const isMetadataMarker = m?.extra?.scene_summariser_marker;
        if (isMetadataMarker) {
            markerIndexFull = i;
            foundType = 'metadata';
            logDebug('log', `[filterContextInterceptor] Found cutoff marker via Metadata at fullChat index ${i}`);
            break;
        }

        // 2. Check Content (Fallback)
        const content = m?.mes || '';
        if (content.includes('scene-summary-break') || content.includes('Scene Summary Boundary') || content.includes('data-marker-id="scene-break')) {
            markerIndexFull = i;
            foundType = 'content';
            logDebug('log', `[filterContextInterceptor] Found cutoff marker via Content fallback at fullChat index ${i}`);
            break;
        }
    }

    if (markerIndexFull !== -1) {
        // 2. Map the marker index in `fullChat` to the generated subset `chat`.
        // We know `chat` is a strict filtered subsequence of `fullChat` containing non-system messages.
        let chatPtr = 0;
        for (let i = 0; i <= markerIndexFull; i++) {
            const fMsg = fullChat[i];
            const cMsg = chat[chatPtr];
            if (!cMsg) break;

            // Check if fMsg structurally matches cMsg.
            // SillyTavern guarantees preserved send_date, name, and is_user in the copied array.
            const isMatch = fMsg.send_date === cMsg.send_date &&
                !!fMsg.is_user === !!cMsg.is_user &&
                !!fMsg.is_system === !!cMsg.is_system &&
                fMsg.name === cMsg.name;

            if (isMatch) {
                chatPtr++;
            }
        }

        const keepCount = Number(settings?.keepMessagesCount || 0);
        const removedItemsCount = Math.max(0, chatPtr - keepCount);
        logDebug('log', `[filterContextInterceptor] Filtering request. Marker type=${foundType} at fullChat index ${markerIndexFull}. Removing ${removedItemsCount} matched messages from coreChat (retaining ${keepCount}).`);
        if (removedItemsCount > 0) {
            chat.splice(0, removedItemsCount);
        }
        logDebug('log', `[filterContextInterceptor] Final chat array length after splicing: ${chat.length}`);
    } else {
        logDebug('log', '[filterContextInterceptor] Limit enabled but neither metadata nor content marker found in fullChat. Sending full context.');
    }
}
