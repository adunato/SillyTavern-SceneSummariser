// Third-party extensions live under /scripts/extensions/third-party/.
// Step three levels up to reach the core helpers.
import { extension_settings, renderExtensionTemplateAsync, getContext } from '../../../extensions.js';
import {
    generateRaw,
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    reloadCurrentChat,
} from '../../../../script.js';
import { eventSource, event_types } from '../../../../scripts/events.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../../popup.js';
import {
    uploadFileAttachment,
    getFileAttachment,
    deleteFileFromServer,
} from '../../../../scripts/chats.js';
import { getStringHash, convertTextToBase64 } from '../../../../scripts/utils.js';

const extensionName = 'SillyTavern-SceneSummariser';
const settingsKey = extensionName;

const defaultSettings = {
    enabled: true,
    autoSummarise: false,
    summaryPrompt: 'Ignore previous instructions. Summarize the most important facts and events in the story so far. If a summary already exists in your memory, use that as a base and expand with new facts. Limit the summary to {{words}} words or less. Your response should include nothing but the summary.',
    consolidationPrompt: 'Create a single, cohesive summary by merging the following scene summaries. Remove redundant information and ensure the narrative flows logically. Limit the final summary to {{words}} words or less. Your response should include nothing but the summary.',
    summaryWords: 200,
    storeHistory: true,
    maxSummaries: 5,
    debugMode: false,
    injectEnabled: true,
    injectPosition: extension_prompt_types.IN_PROMPT,
    injectDepth: 2,
    injectScan: false,
    injectRole: extension_prompt_roles.SYSTEM,
    injectTemplate: '[Summary: {{summary}}]',
    limitToUnsummarised: false,
    insertSceneBreak: true,
    batchSize: 50,
    maxBatchSummaries: 0,
    keepMessagesCount: 0,
    connectionProfileId: '',
    manualSummaryLimit: 0, // 0 = unlimited
    summaryHistoryDepth: 0, // 0 = all
    // Memory extraction (§2)
    memoryExtractionEnabled: true,
    memoryPrompt: `You are an assistant tasked with updating a story's progression by summarizing recent events and extracting significant long-term character memories.

===== CONTEXT & INPUTS =====
Character Name: {{charName}}
Existing Memories (Do not repeat or remix): {{existingMemories}}

# ===== RECENT MESSAGES (Summarize and extract ONLY from here) =====
{{last_messages}}

===== UNIFIED OUTPUT FORMATTING INSTRUCTION =====
Your output must contain exactly two components, in this exact order, with absolutely NO conversational filler, headers, or commentary:

1. A single <summary> block containing the plot summary.
2. One or more <memory> blocks containing bulleted lists of extracted memories (or exactly NO_NEW_MEMORIES inside a single block if nothing significant occurred).

Example Output Structure:

<summary>
Raw summary text goes here...
</summary>
<memory>
* [{{charName}}, OtherNames — short description]
* Memory bullet 1
* Memory bullet 2
</memory>

===== SUMMARY RULES =====
1. Summarize ONLY the events in 'Recent Messages'. Focus strictly on plot progression and meaningful actions.
2. Do NOT recap the 'Story Context' and DO NOT continue the story.
3. Assume the reader is already familiar with the characters (e.g., use "Mary" rather than "Mary, a caring mother").
4. Limit the summary text to {{words}} words.

===== MEMORY EXTRACTION RULES =====
1. Extract only NEW facts, backstory reveals, relationship shifts, and emotional turning points NOT already covered by 'Existing Memories'.
2. Write in past tense, third person. Always refer to {{charName}} by name. No emojis. Do not quote dialogue verbatim.
3. Write about WHAT HAPPENED (outcomes), not the conversation itself or the step-by-step process. Never write "she told him about X" — write the actual fact: "X happened".
4. Group memories by encounter. Use ONE <memory> block per encounter/scene.
5. Start each block with a topic tag as the first bullet: "- [{{charName}}, OtherNames — short description]".
6. HARD LIMIT: Max 5 bullet points per block (excluding the topic tag). Keep only the most significant outcomes.
7. DO NOT EXTRACT: Meta-narration, step-by-step accounts, scene-setting, temporary physical states, or trivial details. Ask yourself: "Would {{charName}} bring this up unprompted weeks later?"

NEGATIVE MEMORY EXAMPLE (Do NOT write play-by-play like this):
<memory>
* Alex set the carrier down and opened the door.
* Flux emerged and walked toward the Roomba.
* Alex poured salmon pâté into a bowl.
* Flux ate the salmon and purred.
</memory>

POSITIVE MEMORY EXAMPLE (Summarize the outcome):
<memory>
* [Alex, Flux — adoption day and settling in]
* Alex adopted Flux, who immediately bonded with a custom Roomba in the apartment.
* Flux's first meal of premium salmon pâté triggered his first purr in the new home.
</memory>`,
    maxMemories: 0, // 0 = unlimited
};

const chatStateDefaults = {
    currentSummary: '',
    summaryCounter: 0,
    lastSummarisedIndex: 0,
    sceneBreakMarkerId: '',
    sceneBreakMesId: null,
    snapshots: [],
    // Memory extraction (§2)
    memories: [],
    memoryCounter: 0,
};

const legacyStateKeys = Object.keys(chatStateDefaults);

let buttonIntervalId = null;
let isSummarising = false;
let currentAbortController = null;
let debugMessages = [];
let settingsContainer = null;
let currentMemoryTab = 'All';


// ============ Memory Extraction — Data Bank Helpers (§2) ============

/**
 * Returns the Data Bank filename used to store extracted memories for a given chat.
 * @param {string} chatId
 * @returns {string}
 */
function getSSMemoryFileName(chatId) {
    const safeChatId = String(chatId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `ss-memories-${safeChatId}.md`;
}

/**
 * Finds the attachment record for a SceneSummariser memory file in a character's Data Bank.
 * @param {string} avatar
 * @param {string} fileName
 * @returns {object|null}
 */
function findSSMemoryAttachment(avatar, fileName) {
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
async function readSSMemoriesFile(avatar, fileName) {
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
async function appendSSMemoriesBlock(avatar, fileName, newBlockMarkdown) {
    if (!extension_settings.character_attachments) extension_settings.character_attachments = {};
    if (!Array.isArray(extension_settings.character_attachments[avatar])) {
        extension_settings.character_attachments[avatar] = [];
    }

    const existing = await readSSMemoriesFile(avatar, fileName);
    const newContent = existing
        ? `${existing.trimEnd()}\n\n${newBlockMarkdown}`
        : newBlockMarkdown;

    // Delete old file if present
    const oldAttachment = findSSMemoryAttachment(avatar, fileName);
    if (oldAttachment) {
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
        logDebug('error', 'appendSSMemoriesBlock: uploadFileAttachment returned no URL');
        return;
    }

    extension_settings.character_attachments[avatar].push({
        url: fileUrl,
        size: newContent.length,
        name: fileName,
        created: Date.now(),
    });
    saveSettingsDebounced();
    logDebug('log', `Memory file updated: ${fileName} (${newContent.length} bytes)`);
}

/**
 * Rebuilds and overwrites the entire Data Bank memory file from the current chatState index.
 * Used after manual edits or deletions.
 * @param {string} avatar
 * @param {string} fileName
 * @param {object[]} memories List of memory objects from chatState.
 */
async function writeSSMemoriesFile(avatar, fileName, memories) {
    if (!extension_settings.character_attachments) extension_settings.character_attachments = {};
    if (!Array.isArray(extension_settings.character_attachments[avatar])) {
        extension_settings.character_attachments[avatar] = [];
    }

    if (!memories.length) {
        // If no memories, delete the file
        const oldAttachment = findSSMemoryAttachment(avatar, fileName);
        if (oldAttachment) {
            try { await deleteFileFromServer(oldAttachment.url, true); } catch (_) { /* ignore */ }
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
            allBulletsText += `* ${header}\n` + texts.map(t => `* ${t}`).join('\n') + '\n';
        }
        blocks.push(`<memory chat="${sceneLabel}" date="${timestamp}">\n${allBulletsText.trim()}\n</memory>`);
    }

    const newContent = blocks.join('\n\n');

    // Delete old file
    const oldAttachment = findSSMemoryAttachment(avatar, fileName);
    if (oldAttachment) {
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
        logDebug('error', 'writeSSMemoriesFile: uploadFileAttachment returned no URL');
        return;
    }

    extension_settings.character_attachments[avatar].push({
        url: fileUrl,
        size: newContent.length,
        name: fileName,
        created: Date.now(),
    });
    saveSettingsDebounced();
    logDebug('log', `Memory file rebuilt: ${fileName} (${newContent.length} bytes)`);
}

// ============ Memory Extraction — Response Parser (§2) ============

/**
 * Parses a combined LLM extraction response into summary text and memory blocks.
 * Falls back to treating the whole response as summaryText when tags are absent.
 * @param {string} raw Raw LLM response.
 * @returns {{ summaryText: string, blocks: Array<{ header: string, characters: string[], bullets: string[] }> }}
 */
function parseExtractionResponse(raw) {
    const text = (raw || '').trim();
    const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i);
    const memoryBlocksRaw = [...text.matchAll(/<memor(?:y|ies)>([\s\S]*?)<\/memor(?:y|ies)>/gi)];

    const summaryText = summaryMatch ? summaryMatch[1].trim() : text;
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
    
    return { summaryText, blocks };
}

// ============ Memory Extraction — Prompt Builder (§2) ============

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
function buildExtractionPrompt(transcript, settings, previousSummaryText, chatState = {}) {
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
function pruneMemories(chatState, settings) {
    const max = Number(settings.maxMemories ?? defaultSettings.maxMemories);
    if (max <= 0) return;
    while (chatState.memories.length > max) chatState.memories.shift();
}

function getLatestSnapshot(chatState) {
    if (!chatState?.snapshots?.length) return null;
    return chatState.snapshots[chatState.snapshots.length - 1];
}

function buildSummaryText(chatState, settings) {
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
    return latest?.text || '';
}

function getActiveChatId() {
    const ctx = getContext();
    const chatId = ctx?.getCurrentChatId?.();
    return chatId ?? '__no_chat__';
}

function getActiveIntegrity() {
    const ctx = getContext();
    return ctx?.chatMetadata?.integrity || null;
}

function migrateLegacySnapshot(chatState, settings) {
    // If legacy currentSummary exists and no snapshots yet, create one
    if (chatState.snapshots && chatState.snapshots.length) return;
    const legacySummary = settings.currentSummary || '';
    if (!legacySummary) return;
    const legacyId = chatState.summaryCounter || 0;
    const snapshot = {
        id: legacyId || 1,
        title: `Scene #${legacyId || 1}`,
        text: legacySummary,
        createdAt: Date.now(),
        fromIndex: 0,
        toIndex: 0,
        source: 'legacy',
    };
    chatState.snapshots = [snapshot];
    chatState.summaryCounter = snapshot.id;
}

function pullLegacyState(settings) {
    const legacy = {};
    let found = false;
    for (const key of legacyStateKeys) {
        if (settings[key] !== undefined) {
            legacy[key] = settings[key];
            delete settings[key];
            found = true;
        }
    }
    return found ? legacy : null;
}

function getChatState(chatId = null) {
    ensureSettings();
    const settings = extension_settings[settingsKey];
    const activeChatId = chatId || getActiveChatId();
    const integrity = getActiveIntegrity();

    if (!settings.chatStates[activeChatId]) {
        const legacy = pullLegacyState(settings);
        const integrityState = integrity && settings.chatStatesByIntegrity?.[integrity];

        settings.chatStates[activeChatId] = {
            ...chatStateDefaults,
            ...(integrityState || legacy || {}),
        };
    }

    migrateLegacySnapshot(settings.chatStates[activeChatId], settings);

    // Keep a by-integrity cache so forks that carry integrity can re-use state
    if (integrity) {
        if (!settings.chatStatesByIntegrity) settings.chatStatesByIntegrity = {};
        settings.chatStatesByIntegrity[integrity] = settings.chatStates[activeChatId];
    }

    return settings.chatStates[activeChatId];
}

function logDebug(level, ...args) {
    if (!extension_settings[settingsKey]?.debugMode) return;
    const ts = new Date().toISOString();
    const line = `[${extensionName}][${level.toUpperCase()}] ${ts} ${args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}`;
    debugMessages.push(line);
    if (debugMessages.length > 500) {
        debugMessages = debugMessages.slice(-500);
    }
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

function copyLogs() {
    if (!debugMessages.length) {
        toastr.info('No logs to copy');
        return;
    }
    const text = debugMessages.join('\n');
    navigator.clipboard.writeText(text).then(() => {
        toastr.success('Debug logs copied to clipboard');
    }).catch(err => {
        console.error('Failed to copy logs:', err);
        toastr.error('Failed to copy logs');
    });
}

function ensureSettings() {
    if (!extension_settings[settingsKey]) {
        extension_settings[settingsKey] = {};
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[settingsKey][key] === undefined) {
            extension_settings[settingsKey][key] = value;
        }
    }

    if (!extension_settings[settingsKey].chatStates || typeof extension_settings[settingsKey].chatStates !== 'object') {
        extension_settings[settingsKey].chatStates = {};
    }
    if (!extension_settings[settingsKey].chatStatesByIntegrity || typeof extension_settings[settingsKey].chatStatesByIntegrity !== 'object') {
        extension_settings[settingsKey].chatStatesByIntegrity = {};
    }
}

async function mountSettings() {
    const parent = document.getElementById('extensions_settings');
    if (!parent) {
        console.warn(`[${extensionName}] Could not find #extensions_settings`);
        return;
    }

    const containerId = `extension_settings_${extensionName}`;
    let container = document.getElementById(containerId);
    if (!container) {
        container = document.createElement('div');
        container.id = containerId;
        parent.appendChild(container);
    }
    settingsContainer = container;

    const html = await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'settings');
    container.innerHTML = html;
    bindSettingsUI(container);
    updateSettingsUI(container);
}

function createSummariseButton() {
    const button = document.createElement('div');
    button.id = 'ss_summarise_button';
    // Reuse GG button styling for consistent look/placement
    button.className = 'gg-action-button ss-action-button fa-solid fa-clapperboard';
    button.title = 'Summarise Scene';

    button.addEventListener('click', () => {
        if (isSummarising && currentAbortController) {
            logDebug('log', 'Aborting summarisation by user request');
            currentAbortController.abort();
            return;
        }
        onSummariseClick();
    });

    return button;
}

/**
 * Place the summarise button beside other action buttons (same row as Guided Response).
 * Falls back to its own container if the Guided Generations container is not present.
 */
function placeSummariseButton() {
    const settings = extension_settings[settingsKey];
    const existing = document.getElementById('ss_summarise_button');

    if (!settings?.enabled) {
        // Remove if present
        if (existing?.parentElement) {
            existing.parentElement.removeChild(existing);
        }
        return false;
    }

    // Prefer the Guided Generations action container if it exists
    let targetContainer = document.getElementById('gg-regular-buttons-container');

    // Fallback: create a tiny container beneath the input if GG isn't present
    if (!targetContainer) {
        const sendForm = document.getElementById('send_form');
        const nonQRFormItems = document.getElementById('nonQRFormItems');
        if (sendForm && nonQRFormItems) {
            targetContainer = document.getElementById('ss-action-button-container');
            if (!targetContainer) {
                targetContainer = document.createElement('div');
                targetContainer.id = 'ss-action-button-container';
                targetContainer.className = 'gg-action-buttons-container';
                nonQRFormItems.parentNode.insertBefore(targetContainer, nonQRFormItems.nextSibling);
            }
        } else {
            return false;
        }
    }

    const button = existing || createSummariseButton();

    // If the button already lives in the right container, do nothing
    if (button.parentElement !== targetContainer) {
        button.remove();
        targetContainer.appendChild(button);
    }

    return true;
}

function startButtonMount() {
    // Try immediately
    let mounted = placeSummariseButton();

    // Retry a few times while the GG toolbar initializes/refreshes
    if (buttonIntervalId) {
        clearInterval(buttonIntervalId);
    }
    buttonIntervalId = setInterval(() => {
        mounted = placeSummariseButton() || mounted;
        // Stop after it has successfully placed once and exists in DOM
        if (mounted && document.getElementById('ss_summarise_button')) {
            clearInterval(buttonIntervalId);
            buttonIntervalId = null;
        }
    }, 1000);

    // Safety stop after 15s
    setTimeout(() => {
        if (buttonIntervalId) {
            clearInterval(buttonIntervalId);
            buttonIntervalId = null;
        }
    }, 15000);
}

function bindSettingsUI(container) {
    if (!container) return;

    // 1) Standard inputs
    container.addEventListener('input', (event) => {
        const target = event.target;
        if (!target.classList?.contains('ss-setting-input')) return;

        const { name, type, value, checked } = target;
        if (!name) return;

        let newValue = value;
        if (type === 'checkbox') newValue = !!checked;
        else if (type === 'range' || type === 'number' || type === 'radio') newValue = Number(value);

        extension_settings[settingsKey][name] = newValue;

        if (name === 'summaryWords') {
            const display = container.querySelector('#ss_summaryWords_value');
            if (display) display.textContent = newValue;
        }

        saveSettingsDebounced();

        if (name === 'injectPosition') {
            updateInjectionVisibility(container);
        }

        if (name === 'limitToUnsummarised') {
            updateContextControlVisibility(container);
        }

        if (name === 'batchSize') {
            const display = container.querySelector('#ss_batchSize_value');
            if (display) display.textContent = newValue;
        }

        if (name === 'maxBatchSummaries') {
            const display = container.querySelector('#ss_maxBatchSummaries_value');
            if (display) display.textContent = newValue;
        }

        if (name === 'keepMessagesCount') {
            const display = container.querySelector('#ss_keepMessagesCount_value');
            if (display) display.textContent = newValue;
        }

        if (name === 'manualSummaryLimit') {
            const display = container.querySelector('#ss_manualSummaryLimit_value');
            if (display) display.textContent = newValue;
        }

        if (name === 'summaryHistoryDepth') {
            const display = container.querySelector('#ss_summaryHistoryDepth_value');
            if (display) display.textContent = newValue;
        }

        if (['injectEnabled', 'injectPosition', 'injectDepth', 'injectScan', 'injectRole', 'injectTemplate'].includes(name)) {
            applyInjection();
        }
    });

    // 1b) Auto-save summary text
    container.addEventListener('input', (event) => {
        if (!event.target.classList.contains('ss-snap-text')) return;
        const id = Number(event.target.dataset.id);
        const chatState = getChatState();
        const snap = chatState.snapshots.find(s => s.id === id);
        if (snap) {
            snap.text = event.target.value;
            saveSettingsDebounced();

            // Refresh preview using full build logic (respects Store History)
            const currentSummary = container.querySelector('#ss_currentSummary');
            if (currentSummary) {
                currentSummary.value = buildSummaryText(chatState, extension_settings[settingsKey]);
            }

            applyInjection();
        }
    });

    // 2) Click delegation
    container.addEventListener('click', async (event) => {
        const actionEl = event.target.closest('[data-ss-action]');
        if (actionEl) {
            const action = actionEl.dataset.ssAction;
            if (action === 'toggle-settings') togglePanel(container, '#ss_settings_panel');
            if (action === 'toggle-memory') togglePanel(container, '#ss_memory_panel');
            if (action === 'toggle-summary') togglePanel(container, '#ss_summary_panel');
            return;
        }

        // Accordion header expand/collapse
        const headerEl = event.target.closest('.ss-snapshot-header');
        if (headerEl && !event.target.closest('.ss-no-propagate')) {
            const item = headerEl.closest('.ss-snapshot-item');
            item?.classList.toggle('expanded');
            return;
        }

        // Snapshot actions
        const snapBtn = event.target.closest('[data-snap-action]');
        if (snapBtn) {
            const action = snapBtn.dataset.snapAction;
            const id = Number(snapBtn.dataset.snapId);
            const chatState = getChatState();
            await handleSnapshotAction(action, id, chatState, container);
            renderSnapshotsList(container, chatState, extension_settings[settingsKey]);
            const currentSummary = container.querySelector('#ss_currentSummary');
            if (currentSummary) currentSummary.value = buildSummaryText(chatState, extension_settings[settingsKey]);
            applyInjection();
            saveSettingsDebounced();
        }

        // Memory actions
        const memoryBtn = event.target.closest('[data-memory-action]');
        if (memoryBtn) {
            const action = memoryBtn.dataset.memoryAction;
            const id = Number(memoryBtn.dataset.memoryId);
            const chatState = getChatState();
            if (action === 'delete') {
                chatState.memories = chatState.memories.filter(m => m.id !== id);
                const ctx = getContext();
                const avatar = ctx?.characters?.[ctx?.characterId]?.avatar
                    || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined);
                if (avatar) {
                    const fileName = getSSMemoryFileName(getActiveChatId());
                    await writeSSMemoriesFile(avatar, fileName, chatState.memories);
                }
                renderMemoriesList(container, chatState);
                saveSettingsDebounced();
            }
        }

        const deleteBlockBtn = event.target.closest('.ss-delete-full-block');
        if (deleteBlockBtn) {
            const headerToDelete = deleteBlockBtn.dataset.header;
            if (confirm(`Delete the entire block "${headerToDelete}"?`)) {
                const chatState = getChatState();
                chatState.memories = chatState.memories.filter(m => m.blockHeader !== headerToDelete);
                
                const ctx = getContext();
                const avatar = ctx?.characters?.[ctx?.characterId]?.avatar
                    || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined);
                if (avatar) {
                    const fileName = getSSMemoryFileName(getActiveChatId());
                    await writeSSMemoriesFile(avatar, fileName, chatState.memories);
                }
                renderMemoriesList(container, chatState);
                saveSettingsDebounced();
            }
        }
    });

    // 2b) Auto-save memory text and block headers
    container.addEventListener('input', (event) => {
        if (event.target.classList.contains('ss-memory-text')) {
            const id = Number(event.target.dataset.id);
            const chatState = getChatState();
            const memory = chatState.memories.find(m => m.id === id);
            if (memory) {
                memory.text = event.target.value;
                saveSettingsDebounced();
                
                clearTimeout(memory.rewriteTimeout);
                memory.rewriteTimeout = setTimeout(async () => {
                    const ctx = getContext();
                    const avatar = ctx?.characters?.[ctx?.characterId]?.avatar
                        || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined);
                    if (avatar) {
                        const fileName = getSSMemoryFileName(getActiveChatId());
                        await writeSSMemoriesFile(avatar, fileName, chatState.memories);
                    }
                }, 2000);
            }
            return;
        }

        if (event.target.classList.contains('ss-memory-block-header')) {
            const originalHeader = event.target.dataset.originalHeader;
            const newHeader = event.target.value.trim() || '[Unknown]';
            const chatState = getChatState();
            
            let characters = [];
            const bracketMatch = newHeader.match(/^\[(.*?)\]/);
            if (bracketMatch) {
                const inside = bracketMatch[1];
                const charPart = inside.split(/—|-/)[0]; // get text before the dash
                if (charPart) {
                    characters = charPart.split(',').map(c => c.trim()).filter(c => c);
                }
            }

            chatState.memories.forEach(m => {
                if (m.blockHeader === originalHeader) {
                    m.blockHeader = newHeader;
                    m.characters = characters;
                }
            });
            event.target.dataset.originalHeader = newHeader; // update original to allow continuous editing
            saveSettingsDebounced();

            // Store rewriteTimeout on the chatState object to debounce across the whole file
            clearTimeout(chatState.headerRewriteTimeout);
            chatState.headerRewriteTimeout = setTimeout(async () => {
                const ctx = getContext();
                const avatar = ctx?.characters?.[ctx?.characterId]?.avatar
                    || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined);
                if (avatar) {
                    const fileName = getSSMemoryFileName(getActiveChatId());
                    await writeSSMemoriesFile(avatar, fileName, chatState.memories);
                }
            }, 2000);
            return;
        }

        if (!event.target.classList.contains('ss-snap-text')) return;
        const id = Number(event.target.dataset.id);
        const chatState = getChatState();
        const snap = chatState.snapshots.find(s => s.id === id);
        if (snap) {
            snap.text = event.target.value;
            saveSettingsDebounced();

            // Refresh preview using full build logic (respects Store History)
            const currentSummary = container.querySelector('#ss_currentSummary');
            if (currentSummary) {
                currentSummary.value = buildSummaryText(chatState, extension_settings[settingsKey]);
            }

            applyInjection();
        }
    });

    // 2c) Debug controls
    container.querySelector('#ss_copyLogs')?.addEventListener('click', async () => {
        const text = debugMessages.join('\n');
        try {
            await navigator.clipboard.writeText(text);
            logDebug('log', 'Debug logs copied to clipboard');
        } catch (err) {
            console.error(`[${extensionName}] Failed to copy logs:`, err);
        }
    });

    container.querySelector('#ss_clearLogs')?.addEventListener('click', () => {
        debugMessages = [];
        logDebug('log', 'Debug logs cleared');
    });

    const summariseButton = container.querySelector('#ss_summarise_button');
    if (summariseButton) {
        summariseButton.addEventListener('click', onSummariseClick);
    }

    const consolidateButton = container.querySelector('#ss_consolidate_button');
    if (consolidateButton) {
        consolidateButton.addEventListener('click', onConsolidateClick);
    }

    // Snapshot selection for consolidation
    container.addEventListener('change', (event) => {
        if (event.target.classList.contains('ss-snapshot-select')) {
            handleSnapshotSelectionChange(container);
        }
    });

    const batchSummariseButton = container.querySelector('#ss_batch_summarise_button');
    if (batchSummariseButton) {
        batchSummariseButton.addEventListener('click', () => {
            if (isSummarising && currentAbortController) {
                logDebug('log', 'Aborting batch summarisation by user request');
                currentAbortController.abort();
                return;
            }
            onBatchSummariseClick();
        });
    }

    // Connection Profile dropdown — powered by Connection Manager
    try {
        const settings = extension_settings[settingsKey];
        ConnectionManagerRequestService.handleDropdown(
            '#ss_connectionProfile',
            settings.connectionProfileId || '',
            async (profile) => {
                extension_settings[settingsKey].connectionProfileId = profile?.id || '';
                saveSettingsDebounced();
                logDebug('log', `Connection Profile set to: ${profile?.name || '<none>'}`);
            },
        );
    } catch (err) {
        // Connection Manager may not be available (disabled extension, etc.)
        const select = container.querySelector('#ss_connectionProfile');
        if (select) {
            select.innerHTML = '<option value="">Connection Manager not available</option>';
            select.disabled = true;
        }
        logDebug('warn', 'Could not initialise Connection Profile dropdown', err?.message || err);
    }
}

function togglePanel(container, selector) {
    const panel = container.querySelector(selector);
    if (!panel) return;
    const isHidden = panel.style.display === 'none';
    panel.style.display = isHidden ? '' : 'none';
}

function renderSnapshotsList(container, chatState, settings) {
    const list = container?.querySelector('#ss_snapshots_list');
    const emptyState = container?.querySelector('#ss_empty_state');
    if (!list) return;
    list.innerHTML = '';
    const snapshots = chatState?.snapshots || [];

    if (!snapshots.length) {
        if (emptyState) emptyState.style.display = 'block';
        return;
    } else if (emptyState) {
        emptyState.style.display = 'none';
    }

    // Oldest first
    [...snapshots].forEach((snap) => {
        const title = snap.title || `Scene #${snap.id}`;

        const item = document.createElement('div');
        item.className = 'ss-snapshot-item'; // Default state is collapsed (no 'expanded' class)
        item.dataset.id = snap.id;

        item.innerHTML = `
            <div class="inline-drawer wide100p">
                <div class="inline-drawer-header ss-snapshot-header">
                    <div class="inline-drawer-toggle inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    <div class="ss-snapshot-header-content">
                         <input type="checkbox" class="ss-snapshot-select ss-no-propagate" data-snap-id="${snap.id}" title="Select for consolidation" style="cursor: pointer;">
                         <div class="ss-snapshot-title text_pole textarea_compact" title="${title}">${title}</div>
                         <div class="ss-header-actions ss-no-propagate">
                               <i class="menu_button fa-solid fa-arrows-rotate ss-action-icon" title="Regenerate" data-snap-action="regen" data-snap-id="${snap.id}"></i>
                               <i class="menu_button fa-solid fa-copy ss-action-icon" title="Copy Text" data-snap-action="copy" data-snap-id="${snap.id}"></i>
                               <i class="menu_button fa-solid fa-trash-can ss-delete-icon ss-action-icon" title="Delete Snapshot" data-snap-action="delete" data-snap-id="${snap.id}"></i>
                         </div>
                    </div>
                </div>
                <div class="inline-drawer-content ss-snapshot-content">
                    <div class="setting_item">
                        <textarea class="text_pole ss-snap-text" data-id="${snap.id}" rows="6" style="width:100%; font-size:0.9em; font-family:inherit;">${snap.text || ''}</textarea>
                    </div>
                    </div>
                    <!-- Save button removed; auto-save is active -->
                </div>
            </div>
        `;
        list.appendChild(item);
    });
}

async function handleSnapshotAction(action, snapshotId, chatState, container) {
    const settings = extension_settings[settingsKey];
    const snapIndex = chatState.snapshots.findIndex(s => s.id === snapshotId);
    if (snapIndex === -1) return;
    const snap = chatState.snapshots[snapIndex];

    if (action === 'delete') {
        if (confirm(`Delete "${snap.title || 'this snapshot'}"?`)) {
            const titleToDelete = snap.title;

            // 1. Remove snapshot from state
            chatState.snapshots.splice(snapIndex, 1);
            
            // 2. Remove associated memories from state
            const hadMemories = chatState.memories?.length > 0;
            if (hadMemories) {
                chatState.memories = chatState.memories.filter(m => m.chatLabel !== titleToDelete);
            }
            
            // 3. Re-calculate lastSummarisedIndex
            if (chatState.snapshots.length > 0) {
                const latest = chatState.snapshots[chatState.snapshots.length - 1];
                chatState.lastSummarisedIndex = latest.toIndex || 0;
            } else {
                chatState.lastSummarisedIndex = 0;
            }

            // 4. Clean up Data Bank if memories were removed
            const ctx = getContext();
            const avatar = ctx?.characters?.[ctx?.characterId]?.avatar
                || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined);
            
            if (avatar && hadMemories) {
                const fileName = getSSMemoryFileName(getActiveChatId());
                await writeSSMemoriesFile(avatar, fileName, chatState.memories);
                renderMemoriesList(container, chatState);
            }

            // 5. Clean up chat marker if it exists
            const fullChat = ctx?.chat || [];
            let markerRemoved = false;
            for (let i = fullChat.length - 1; i >= 0; i--) {
                const m = fullChat[i];
                if (m?.extra?.scene_summariser_marker && m?.extra?.snapshot_id === snapshotId) {
                    fullChat.splice(i, 1);
                    markerRemoved = true;
                    logDebug('log', `Removed chat marker for snapshot ${snapshotId}`);
                    break;
                }
            }

            if (markerRemoved) {
                if (typeof ctx.saveChat === 'function') await ctx.saveChat();
                if (typeof reloadCurrentChat === 'function') await reloadCurrentChat();
            }

            logDebug('log', `Deleted snapshot ${snapshotId} and its memories. Reset lastSummarisedIndex to ${chatState.lastSummarisedIndex}`);
        }
    } else if (action === 'copy') {
        try {
            await navigator.clipboard.writeText(snap.text || '');
        } catch (err) {
            console.error('Copy failed', err);
        }
    } else if (action === 'regen') {
        const icon = container.querySelector(`i[data-snap-action="regen"][data-snap-id="${snapshotId}"]`);
        if (icon) {
            icon.classList.remove('fa-arrows-rotate');
            icon.classList.add('fa-spinner', 'fa-spin');
            icon.style.pointerEvents = 'none';
        }
        await regenerateSnapshot(snap, settings, chatState);
        if (icon) {
            icon.classList.remove('fa-spinner', 'fa-spin');
            icon.classList.add('fa-arrows-rotate');
            icon.style.pointerEvents = '';
        }
    }
}

/**
 * Calls the LLM for summarisation. Uses the configured Connection Profile if set,
 * otherwise falls back to the main API via generateRaw.
 * @param {string} prompt The prompt to send to the LLM.
 * @param {AbortSignal} [signal] Optional abort signal to cancel the request.
 * @returns {Promise<string>} The raw LLM response text.
 */
async function callSummarisationLLM(prompt, signal) {
    const settings = extension_settings[settingsKey];
    const profileId = settings?.connectionProfileId || '';

    console.debug(`[${extensionName}] Summarisation Prompt:\n`, prompt);

    if (profileId) {
        try {
            logDebug('log', `Using Connection Profile "${profileId}" for summarisation`);

            // ConnectionManagerRequestService does not cleanly expose an abort signal for sendRequest,
            // but we can wrap it in an abortable promise if needed, or see if it natively supports it.
            // For now, if aborted, we'll throw immediately.
            if (signal?.aborted) throw new Error('AbortError');

            return await new Promise((resolve, reject) => {
                const onAbort = () => reject(new Error('AbortError'));
                if (signal) signal.addEventListener('abort', onAbort);

                ConnectionManagerRequestService.sendRequest(
                    profileId,
                    prompt,
                    settings.summaryWords ? settings.summaryWords * 4 : 1024, // rough token estimate
                ).then(response => {
                    if (signal?.aborted) return reject(new Error('AbortError'));
                    resolve(response?.content ?? String(response ?? ''));
                }).catch(reject).finally(() => {
                    if (signal) signal.removeEventListener('abort', onAbort);
                });
            });
        } catch (err) {
            if (err?.message === 'AbortError' || String(err).includes('AbortError') || String(err).includes('aborted')) throw err;
            logDebug('error', 'Connection Profile request failed, falling back to generateRaw', err?.message || err);
            console.warn(`[${extensionName}] Connection Profile failed, falling back to main API:`, err);
        }
    }

    // Wrap generateRaw which also doesn't take signal cleanly in this version,
    // although ST core generation functions do support throwing if we just hook it up.
    // generateRaw does not accept an AbortSignal argument directly, but we can do a similar wrapper.
    if (signal?.aborted) throw new Error('AbortError');
    return await new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error('AbortError'));
        if (signal) signal.addEventListener('abort', onAbort);

        generateRaw({ prompt, trimNames: false, signal })
            .then(res => {
                if (signal?.aborted) return reject(new Error('AbortError'));
                resolve(res);
            })
            .catch(reject)
            .finally(() => {
                if (signal) signal.removeEventListener('abort', onAbort);
            });
    });
}

async function regenerateSnapshot(snapshot, settings, chatState) {
    const ctx = getContext();
    const chat = ctx?.chat || [];
    const start = Math.max(0, snapshot.fromIndex || 0);
    const end = Math.min(chat.length, snapshot.toIndex || chat.length);
    const slice = chat.slice(start, end);
    const name1 = ctx?.name1 || 'User';
    const name2 = ctx?.name2 || 'Character';
    const transcript = slice
        .filter(m => !m.extra?.scene_summariser_marker)
        .map((m) => {
            const speaker = m.name || (m.is_user ? name1 : name2);
            return `${speaker}: ${m.mes || ''}`.trim();
        })
        .join('\n');

    const words = settings.summaryWords || defaultSettings.summaryWords;
    const promptTemplate = settings.summaryPrompt || defaultSettings.summaryPrompt;

    // Fix: Only use summaries prior to this one as context
    const snapshotIndex = chatState.snapshots.findIndex(s => s.id === snapshot.id);
    let previousSnapshots = snapshotIndex > -1 ? chatState.snapshots.slice(0, snapshotIndex) : [];

    const historyDepth = Number(settings.summaryHistoryDepth || defaultSettings.summaryHistoryDepth);
    if (historyDepth > 0 && previousSnapshots.length > historyDepth) {
        previousSnapshots = previousSnapshots.slice(-historyDepth);
    }

    const previousSummaryText = previousSnapshots.map(s => `${s.title}: ${s.text}`).join('\n');

    const prompt = promptTemplate
        .replace('{{words}}', words)
        .replace('{{summary}}', previousSummaryText || '')
        .replace('{{last_messages}}', transcript || '(no messages)');

    try {
        const result = await callSummarisationLLM(prompt);
        let cleaned = (result || '').trim();
        if (cleaned.startsWith(prompt.trim())) {
            cleaned = cleaned.substring(prompt.trim().length).trim();
        }

        const editedText = await showSummaryEditor(cleaned);
        if (editedText === null) {
            logDebug('log', 'User cancelled summary regeneration');
            return;
        }

        snapshot.text = editedText;
        snapshot.createdAt = Date.now();
        logDebug('log', `Regenerated snapshot ${snapshot.id}`);
    } catch (err) {
        console.error(`[${extensionName}] Failed to regenerate snapshot`, err);
        logDebug('error', 'Regenerate failed', err?.message || err);
    }
}

/**
 * Wrapper for showCombinedEditor that only returns the summary text.
 * Used for legacy calls or single-purpose summary editing.
 * @param {string} initialText 
 * @returns {Promise<string|null>}
 */
async function showSummaryEditor(initialText) {
    const result = await showCombinedEditor(initialText, []);
    return result ? result.summary : null;
}

/**
 * Shows the combined editor popup for reviewing and editing the generated summary and memory blocks.
 * @param {string} initialSummary AI-generated summary.
 * @param {Array<{ header: string, characters: string[], bullets: string[] }>} initialBlocks AI-extracted memory blocks.
 * @returns {Promise<{ summary: string, blocks: Array<{ header: string, characters: string[], bullets: string[] }> }|null>} Final edited data, or null if cancelled.
 */
async function showCombinedEditor(initialSummary, initialBlocks) {
    const template = $(await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'popup'));
    const summaryArea = template.find('#ssPopupTextarea');
    const memoriesList = template.find('#ssPopupMemoriesList');
    const addBtn = template.find('#ssPopupAddMemory');

    summaryArea.val(initialSummary);

    const refreshEmptyHint = () => {
        memoriesList.find('.ss-empty-hint').remove();
        if (memoriesList.children('.ss-memory-block-item').length === 0) {
            memoriesList.append('<div class="ss-empty-hint" style="text-align:center; padding:10px; opacity:0.6;">No facts extracted.</div>');
        }
    };

    const renderMemoryBlock = (blockData = { header: '[Character — topic]', characters: [], bullets: [''] }) => {
        const blockEl = $(`
            <div class="ss-memory-block-item" style="border: 1px solid var(--grey40); border-radius: 5px; padding: 5px; margin-bottom: 8px; background: var(--grey30);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 5px;">
                    <input type="text" class="text_pole ss-block-header-input" value="${blockData.header.replace(/"/g, '&quot;')}" style="flex: 1; font-weight: bold;" />
                    <i class="fa-solid fa-trash-can ss-delete-icon ss-action-icon ss-delete-block" title="Remove entire block" style="margin-left: 5px;"></i>
                </div>
                <div class="ss-block-bullets"></div>
                <button class="menu_button interactable ss-add-bullet-btn" style="font-size: 0.7em; padding: 2px 6px; margin-top: 5px;">
                    <i class="fa-solid fa-plus"></i> Add Fact
                </button>
            </div>
        `);

        const bulletsContainer = blockEl.find('.ss-block-bullets');

        const renderBulletItem = (text = '') => {
            const item = $(`
                <div class="ss-memory-edit-item" style="margin-bottom: 3px;">
                    <textarea class="text_pole" placeholder="Enter a fact...">${text}</textarea>
                    <i class="fa-solid fa-trash-can ss-delete-icon ss-action-icon ss-delete-bullet" title="Remove fact"></i>
                </div>
            `);
            item.find('.ss-delete-bullet').on('click', () => {
                item.remove();
            });
            return item;
        };

        (blockData.bullets || []).forEach(b => bulletsContainer.append(renderBulletItem(b)));

        blockEl.find('.ss-add-bullet-btn').on('click', () => {
            const newItem = renderBulletItem();
            bulletsContainer.append(newItem);
            newItem.find('textarea').focus();
        });

        blockEl.find('.ss-delete-block').on('click', () => {
            blockEl.remove();
            refreshEmptyHint();
        });

        return blockEl;
    };

    if (Array.isArray(initialBlocks) && initialBlocks.length) {
        initialBlocks.forEach(b => memoriesList.append(renderMemoryBlock(b)));
    } else {
        refreshEmptyHint();
    }

    addBtn.on('click', () => {
        memoriesList.find('.ss-empty-hint').remove();
        const blockEl = renderMemoryBlock();
        memoriesList.append(blockEl);
        blockEl.find('input').focus();
    });

    const popup = new Popup(template, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        large: true,
        okButton: 'Save Extraction',
        cancelButton: 'Discard'
    });

    const result = await popup.show();
    if (!result) return null;

    const finalSummary = String(summaryArea.val()).trim();
    const finalBlocks = [];

    memoriesList.find('.ss-memory-block-item').each(function () {
        const blockEl = $(this);
        const header = String(blockEl.find('.ss-block-header-input').val()).trim() || '[Unknown — Event]';
        
        let characters = [];
        const bracketMatch = header.match(/^\[(.*?)\]/);
        if (bracketMatch) {
            const inside = bracketMatch[1];
            const charPart = inside.split(/—|-/)[0]; // get text before the dash
            if (charPart) {
                characters = charPart.split(',').map(c => c.trim()).filter(c => c);
            }
        }

        const bullets = [];
        blockEl.find('textarea').each(function () {
            const val = $(this).val().trim();
            if (val) bullets.push(val);
        });

        if (bullets.length > 0) {
            finalBlocks.push({ header, characters, bullets });
        }
    });

    return { summary: finalSummary, blocks: finalBlocks };
}

function renderMemoriesList(container, chatState) {
    const list = container?.querySelector('#ss_memories_list');
    const tabsContainer = container?.querySelector('#ss_memory_tabs');
    const emptyState = container?.querySelector('#ss_memories_empty_state');
    if (!list || !tabsContainer) return;
    
    list.innerHTML = '';
    tabsContainer.innerHTML = '';
    const memories = chatState?.memories || [];

    if (!memories.length) {
        if (emptyState) emptyState.style.display = 'block';
        return;
    } else if (emptyState) {
        emptyState.style.display = 'none';
    }

    // Extract unique characters
    const charSet = new Set();
    memories.forEach(m => {
        if (m.characters && Array.isArray(m.characters)) {
            m.characters.forEach(c => charSet.add(c));
        }
    });
    const uniqueChars = Array.from(charSet).sort();

    // Render Tabs
    const renderTabButton = (name) => {
        const btn = document.createElement('button');
        btn.className = `menu_button interactable ${currentMemoryTab === name ? 'fa-solid fa-check' : ''}`;
        btn.textContent = name;
        btn.style.padding = '4px 8px';
        btn.style.fontSize = '0.9em';
        if (currentMemoryTab === name) {
            btn.style.background = 'var(--smart-theme-focus)';
            btn.style.color = 'var(--smart-theme-focus-text)';
        }
        btn.addEventListener('click', () => {
            currentMemoryTab = name;
            renderMemoriesList(container, chatState);
        });
        tabsContainer.appendChild(btn);
    };

    renderTabButton('All');
    uniqueChars.forEach(c => renderTabButton(c));

    // Filter memories by tab
    let filteredMemories = memories;
    if (currentMemoryTab !== 'All') {
        filteredMemories = memories.filter(m => m.characters && m.characters.includes(currentMemoryTab));
    }

    if (filteredMemories.length === 0) {
        list.innerHTML = `<div style="text-align:center; opacity:0.6; padding:10px;">No memories for ${currentMemoryTab}</div>`;
        return;
    }

    // Group by blockHeader
    const grouped = {};
    [...filteredMemories].reverse().forEach(m => {
        const header = m.blockHeader || '[General]';
        if (!grouped[header]) grouped[header] = [];
        grouped[header].push(m);
    });

    for (const [header, blockMemories] of Object.entries(grouped)) {
        const blockEl = document.createElement('div');
        blockEl.style.border = '1px solid var(--grey40)';
        blockEl.style.borderRadius = '5px';
        blockEl.style.padding = '5px';
        blockEl.style.background = 'var(--grey30)';
        
        let headerHtml = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                <input type="text" class="text_pole ss-memory-block-header" data-original-header="${header.replace(/"/g, '&quot;')}" value="${header.replace(/"/g, '&quot;')}" style="flex:1; font-weight:bold; background:transparent; border:none; border-bottom:1px solid var(--grey50); margin-right:5px;"/>
                <i class="fa-solid fa-trash-can ss-delete-icon ss-action-icon ss-delete-full-block" title="Delete entire block" data-header="${header.replace(/"/g, '&quot;')}"></i>
            </div>
            <div class="ss-block-items"></div>
        `;
        blockEl.innerHTML = headerHtml;
        const itemsContainer = blockEl.querySelector('.ss-block-items');

        blockMemories.forEach(m => {
            const item = document.createElement('div');
            item.className = 'ss-memory-edit-item';
            item.style.marginBottom = '3px';
            item.innerHTML = `
                <textarea class="text_pole ss-memory-text" data-id="${m.id}" rows="2">${m.text || ''}</textarea>
                <i class="menu_button fa-solid fa-trash-can ss-delete-icon ss-action-icon" title="Delete Memory" data-memory-action="delete" data-memory-id="${m.id}"></i>
            `;
            itemsContainer.appendChild(item);
        });
        
        list.appendChild(blockEl);
    }
}

/**
 * Purges memories that are not associated with any existing snapshot.
 * Useful for cleaning up orphans from older versions or failed deletions.
 * @param {object} chatState 
 */
async function reconcileMemories(chatState) {
    if (!chatState.memories?.length) return;

    const snapshotTitles = new Set(chatState.snapshots.map(s => s.title));
    const initialCount = chatState.memories.length;
    
    // Filter out memories whose label is missing or doesn't match an existing snapshot
    chatState.memories = chatState.memories.filter(m => m.chatLabel && snapshotTitles.has(m.chatLabel));

    if (chatState.memories.length !== initialCount) {
        logDebug('log', `Reconciliation: Purged ${initialCount - chatState.memories.length} orphaned memories.`);
        const ctx = getContext();
        const avatar = ctx?.characters?.[ctx?.characterId]?.avatar
            || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined);
        
        if (avatar) {
            const fileName = getSSMemoryFileName(getActiveChatId());
            await writeSSMemoriesFile(avatar, fileName, chatState.memories);
        }
    }
}

function updateSettingsUI(container) {
    if (!container) return;
    const settings = extension_settings[settingsKey] || defaultSettings;
    const chatState = getChatState();

    // Run reconciliation to clear orphans
    reconcileMemories(chatState);

    const setValue = (selector, val) => {
        const el = container.querySelector(selector);
        if (!el) return;
        if (el.type === 'checkbox') {
            el.checked = !!val;
        } else if (el.type === 'radio') {
            el.checked = String(el.value) === String(val);
        } else {
            el.value = val ?? '';
        }
    };

    setValue('#ss_enabled', settings.enabled ?? defaultSettings.enabled);
    setValue('#ss_autoSummarise', settings.autoSummarise ?? defaultSettings.autoSummarise);
    setValue('#ss_summaryPrompt', settings.summaryPrompt ?? defaultSettings.summaryPrompt);
    setValue('#ss_consolidationPrompt', settings.consolidationPrompt ?? defaultSettings.consolidationPrompt);
    setValue('#ss_summaryWords', settings.summaryWords ?? defaultSettings.summaryWords);
    setValue('#ss_storeHistory', settings.storeHistory ?? defaultSettings.storeHistory);
    setValue('#ss_maxSummaries', settings.maxSummaries ?? defaultSettings.maxSummaries);
    setValue('#ss_debugMode', settings.debugMode ?? defaultSettings.debugMode);
    setValue('#ss_injectEnabled', settings.injectEnabled ?? defaultSettings.injectEnabled);
    setValue('#ss_injectDepth', settings.injectDepth ?? defaultSettings.injectDepth);
    setValue('#ss_injectScan', settings.injectScan ?? defaultSettings.injectScan);
    setValue('#ss_injectRole', settings.injectRole ?? defaultSettings.injectRole);
    setValue('#ss_injectTemplate', settings.injectTemplate ?? defaultSettings.injectTemplate);
    setValue('#ss_limitToUnsummarised', settings.limitToUnsummarised ?? defaultSettings.limitToUnsummarised);
    setValue('#ss_insertSceneBreak', settings.insertSceneBreak ?? defaultSettings.insertSceneBreak);
    setValue('#ss_batchSize', settings.batchSize ?? defaultSettings.batchSize);
    setValue('#ss_maxBatchSummaries', settings.maxBatchSummaries ?? defaultSettings.maxBatchSummaries);
    setValue('#ss_keepMessagesCount', settings.keepMessagesCount ?? defaultSettings.keepMessagesCount);
    setValue('#ss_manualSummaryLimit', settings.manualSummaryLimit ?? defaultSettings.manualSummaryLimit);
    setValue('#ss_summaryHistoryDepth', settings.summaryHistoryDepth ?? defaultSettings.summaryHistoryDepth);
    // Memory extraction (§2)
    setValue('#ss_memoryExtractionEnabled', settings.memoryExtractionEnabled ?? defaultSettings.memoryExtractionEnabled);
    setValue('#ss_memoryPrompt', settings.memoryPrompt ?? defaultSettings.memoryPrompt);
    setValue('#ss_maxMemories', settings.maxMemories ?? defaultSettings.maxMemories);

    // Radio for position
    const radios = container.querySelectorAll('input[name="injectPosition"]');
    radios.forEach(r => r.checked = String(r.value) === String(settings.injectPosition));

    updateInjectionVisibility(container);
    updateContextControlVisibility(container);

    // Visual feedback for prompt inheritance
    const memoryEnabled = settings.memoryExtractionEnabled ?? defaultSettings.memoryExtractionEnabled;
    const summaryPromptEl = container.querySelector('#ss_summaryPrompt');
    const summaryHintEl = container.querySelector('#ss_summaryPrompt_hint');
    if (summaryPromptEl) {
        summaryPromptEl.disabled = memoryEnabled;
        summaryPromptEl.style.opacity = memoryEnabled ? '0.5' : '1';
        if (summaryHintEl) {
            summaryHintEl.textContent = memoryEnabled
                ? '⚠️ Disabled: Using the combined "Extraction Prompt" below.'
                : 'Prompt used to generate summaries.';
            summaryHintEl.style.color = memoryEnabled ? 'var(--smart-theme-yellow)' : '';
        }
    }

    const wordsDisplay = container.querySelector('#ss_summaryWords_value');
    if (wordsDisplay) wordsDisplay.textContent = settings.summaryWords ?? defaultSettings.summaryWords;

    const batchSizeDisplay = container.querySelector('#ss_batchSize_value');
    if (batchSizeDisplay) batchSizeDisplay.textContent = settings.batchSize ?? defaultSettings.batchSize;

    const maxBatchSummariesDisplay = container.querySelector('#ss_maxBatchSummaries_value');
    if (maxBatchSummariesDisplay) maxBatchSummariesDisplay.textContent = settings.maxBatchSummaries ?? defaultSettings.maxBatchSummaries;

    const keepMessagesCountDisplay = container.querySelector('#ss_keepMessagesCount_value');
    if (keepMessagesCountDisplay) keepMessagesCountDisplay.textContent = settings.keepMessagesCount ?? defaultSettings.keepMessagesCount;

    const manualSummaryLimitDisplay = container.querySelector('#ss_manualSummaryLimit_value');
    if (manualSummaryLimitDisplay) manualSummaryLimitDisplay.textContent = settings.manualSummaryLimit ?? defaultSettings.manualSummaryLimit;

    const summaryHistoryDepthDisplay = container.querySelector('#ss_summaryHistoryDepth_value');
    if (summaryHistoryDepthDisplay) summaryHistoryDepthDisplay.textContent = settings.summaryHistoryDepth ?? defaultSettings.summaryHistoryDepth;

    const currentSummary = container.querySelector('#ss_currentSummary');
    if (currentSummary) currentSummary.value = buildSummaryText(chatState, settings);

    renderSnapshotsList(container, chatState, settings);
    renderMemoriesList(container, chatState);

    applyInjection();
    logDebug('log', 'Settings UI updated');
}

function updateInjectionVisibility(container) {
    if (!container) return;
    const settings = extension_settings[settingsKey];
    const isInChat = String(settings.injectPosition) === '1'; // IN_CHAT

    const depthInput = container.querySelector('#ss_injectDepth');
    const roleSelect = container.querySelector('#ss_injectRole');

    if (depthInput) {
        depthInput.disabled = !isInChat;
        depthInput.style.opacity = isInChat ? '1' : '0.5';
    }
    if (roleSelect) {
        roleSelect.disabled = !isInChat;
        roleSelect.style.opacity = isInChat ? '1' : '0.5';
    }
}

function updateContextControlVisibility(container) {
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

async function onSummariseClick() {
    if (isSummarising) return;
    ensureSettings();
    if (!extension_settings[settingsKey]?.enabled) {
        console.warn(`[${extensionName}] Summariser disabled.`);
        return;
    }
    isSummarising = true;
    currentAbortController = new AbortController();

    const button = document.getElementById('ss_summarise_button');
    const originalTitle = button?.title;
    if (button) {
        button.classList.remove('fa-clapperboard');
        button.classList.add('fa-stop', 'ss-stop-btn');
        button.title = 'Stop Summarising';
    }
    logDebug('log', 'Summarise clicked');

    const settings = extension_settings[settingsKey];
    const chatState = getChatState();

    const historyDepth = Number(settings.summaryHistoryDepth || defaultSettings.summaryHistoryDepth);
    let previousSnapshots = chatState.snapshots || [];
    if (historyDepth > 0 && previousSnapshots.length > historyDepth) {
        previousSnapshots = previousSnapshots.slice(-historyDepth);
    }

    const previousSummaryText = previousSnapshots
        .map(s => `${s.title || 'Scene #' + s.id}: ${s.text}`)
        .join('\n');

    // Build chat transcript for context
    const ctx = getContext();
    const chat = ctx?.chat || [];
    const lastIdx = Math.min(chatState.lastSummarisedIndex || 0, chat.length);
    const newMessages = chat.slice(lastIdx);

    if (!newMessages.length) {
        console.warn(`[${extensionName}] No new messages since last summary; skipping.`);
        logDebug('warn', 'No new messages since last summary; skipping');
        if (button) {
            button.classList.remove('disabled');
            button.title = originalTitle || 'Summarise Scene';
        }
        isSummarising = false;
        return;
    }

    const name1 = ctx?.name1 || 'User';
    const name2 = ctx?.name2 || 'Character';

    logDebug('log', `Summarising with names: name1="${name1}", name2="${name2}"`);
    if (newMessages.length > 0) {
        const sample = newMessages[0];
        logDebug('log', `Sample message: name="${sample.name}", is_user=${sample.is_user}, mes="${(sample.mes || '').substring(0, 20)}..."`);
    }

    const manualSummaryLimit = Number(settings.manualSummaryLimit || defaultSettings.manualSummaryLimit);
    let messagesToSummarise = newMessages.filter(m => !m.extra?.scene_summariser_marker);
    if (manualSummaryLimit > 0) {
        messagesToSummarise = messagesToSummarise.slice(-manualSummaryLimit);
    }

    const transcript = messagesToSummarise
        .map((m) => {
            const speaker = m.name || (m.is_user ? name1 : name2);
            return `${speaker}: ${m.mes || ''}`.trim();
        })
        .join('\n');

    // Use combined extraction prompt (or legacy summary-only prompt if extraction is disabled)
    const prompt = buildExtractionPrompt(transcript, settings, previousSummaryText, chatState);

    try {
        const rawResult = await callSummarisationLLM(prompt, currentAbortController.signal);
        // Parse combined response — falls back gracefully to summary-only if tags are absent
        const { summaryText, blocks } = parseExtractionResponse(rawResult || '');
        let cleaned = summaryText;
        if (cleaned.startsWith(prompt.trim())) {
            cleaned = cleaned.substring(prompt.trim().length).trim();
        }
        logDebug('log', 'LLM summary result', cleaned);
        logDebug('log', `Memory blocks extracted: ${blocks ? blocks.length : 0}`);

        const result = await showCombinedEditor(cleaned, blocks);
        if (!result) {
            logDebug('log', 'User cancelled combined editor');
            return;
        }

        const { summary: editedText, blocks: approvedBlocks } = result;

        // Update stored snapshot list
        const words = settings.summaryWords || defaultSettings.summaryWords;
        const nextId = (chatState.summaryCounter ?? 0) + 1;
        const snapshot = {
            id: nextId,
            title: `Scene #${nextId}`,
            text: editedText,
            createdAt: Date.now(),
            fromIndex: lastIdx,
            toIndex: chat.length,
            source: 'manual',
            words,
        };

        chatState.summaryCounter = nextId;
        chatState.snapshots = chatState.snapshots || [];
        chatState.snapshots.push(snapshot);
        chatState.lastSummarisedIndex = chat.length;

        // --- Memory Extraction (§2): persist approved memories to Data Bank ---
        const memoryEnabled = settings.memoryExtractionEnabled ?? defaultSettings.memoryExtractionEnabled;
        const totalApprovedBullets = approvedBlocks.reduce((sum, b) => sum + b.bullets.length, 0);

        if (memoryEnabled && totalApprovedBullets > 0) {
            const avatar = ctx?.characters?.[ctx?.characterId]?.avatar
                || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined);

            if (avatar) {
                const chatId = getActiveChatId();
                const fileName = getSSMemoryFileName(chatId);

                // Build <memory> tag block (CharMemory-compatible format)
                const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
                const sceneLabel = snapshot.title;

                let blockMarkdowns = [];
                chatState.memories = chatState.memories || [];
                let memoriesAdded = 0;

                for (const block of approvedBlocks) {
                    const bulletsText = `* ${block.header}\n` + block.bullets.map(b => `* ${b}`).join('\n');
                    const newBlock = `<memory chat="${sceneLabel}" date="${timestamp}">\n${bulletsText}\n</memory>`;
                    blockMarkdowns.push(newBlock);

                    const newMemories = block.bullets.map(text => ({
                        id: ++chatState.memoryCounter,
                        text,
                        chatLabel: sceneLabel,
                        blockHeader: block.header,
                        characters: block.characters,
                        extractedAt: chat.length,
                        createdAt: Date.now(),
                        source: 'extracted',
                    }));
                    chatState.memories.push(...newMemories);
                    memoriesAdded += newMemories.length;
                }

                await appendSSMemoriesBlock(avatar, fileName, blockMarkdowns.join('\n\n'));

                pruneMemories(chatState, settings);

                logDebug('log', `Persisted ${memoriesAdded} memories across ${approvedBlocks.length} blocks for ${sceneLabel}`);
                toastr.info(`Saved summary and ${memoriesAdded} ${memoriesAdded === 1 ? 'fact' : 'facts'} to Data Bank.`, extensionName);
            } else {
                logDebug('warn', 'Memory extraction: no character avatar found, skipping Data Bank write');
            }
        } else if (editedText) {
            toastr.info('Saved scene summary.', extensionName);
        }

        if (settings.insertSceneBreak) {
            await insertSceneBreakMarker(nextId);
        }

        updateSettingsUI(settingsContainer);

        applyInjection();
        saveSettingsDebounced();
    } catch (error) {
        if (error?.message === 'AbortError' || String(error).includes('AbortError') || String(error).includes('aborted')) {
            logDebug('warn', 'Summarisation aborted by user');
            toastr.info('Summarisation aborted');
        } else {
            console.error(`[${extensionName}] Error during summarisation:`, error);
            logDebug('error', 'Summarisation error', error?.message || error);
            toastr.error('Summarisation error: ' + (error?.message || error));
        }
    } finally {
        if (button) {
            button.classList.remove('fa-stop', 'ss-stop-btn');
            button.classList.add('fa-clapperboard');
            button.title = originalTitle || 'Summarise Scene';
        }
        isSummarising = false;
        currentAbortController = null;
    }
}

async function onBatchSummariseClick() {
    if (isSummarising) return;
    ensureSettings();
    if (!extension_settings[settingsKey]?.enabled) {
        console.warn(`[${extensionName}] Summariser disabled.`);
        return;
    }

    const settings = extension_settings[settingsKey];
    const batchSize = Number(settings.batchSize || defaultSettings.batchSize);

    if (!confirm(`This will delete all existing Scene Summaries and generate new ones in batches of ${batchSize} messages from the beginning of the chat. Proceed?`)) {
        return;
    }

    isSummarising = true;
    currentAbortController = new AbortController();

    const button = document.getElementById('ss_batch_summarise_button');
    const originalText = button?.innerHTML;
    if (button) {
        button.classList.add('ss-stop-btn');
        button.innerHTML = '<i class="fa-solid fa-stop"></i> Stop Batch...';
    }
    logDebug('log', 'Batch Summarise clicked');

    const chatState = getChatState();
    const words = settings.summaryWords || defaultSettings.summaryWords;
    const promptTemplate = settings.summaryPrompt || defaultSettings.summaryPrompt;

    // Reset state
    chatState.snapshots = [];
    chatState.summaryCounter = 0;
    chatState.lastSummarisedIndex = 0;
    chatState.memories = [];
    chatState.memoryCounter = 0;

    const ctx = getContext();
    const avatar = ctx?.characters?.[ctx?.characterId]?.avatar
        || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined);

    // Clear Data Bank file at start of batch
    if (avatar) {
        const fileName = getSSMemoryFileName(getActiveChatId());
        await writeSSMemoriesFile(avatar, fileName, []);
    }

    const fullChat = ctx?.chat || [];

    // Strip old markers from fullChat to reset the state physically
    let modifiedChat = false;
    for (let i = fullChat.length - 1; i >= 0; i--) {
        if (fullChat[i].extra?.scene_summariser_marker) {
            fullChat.splice(i, 1);
            modifiedChat = true;
        }
    }

    // Now track valid messages. The originalIndex will map perfectly to fullChat.
    // Also skip the very first system message if it represents the scenario prompt
    const validMessages = [];
    for (let i = 0; i < fullChat.length; i++) {
        if (!fullChat[i].is_system) {
            validMessages.push({ msg: fullChat[i], originalIndex: i });
        }
    }

    if (!validMessages.length) {
        if (button) {
            button.classList.remove('disabled');
            button.innerHTML = originalText;
        }
        isSummarising = false;
        currentAbortController = null;
        toastr.info('No messages to summarise.');
        return;
    }

    const name1 = ctx?.name1 || 'User';
    const name2 = ctx?.name2 || 'Character';

    // Create batches
    let batches = [];
    for (let i = 0; i < validMessages.length; i += batchSize) {
        batches.push(validMessages.slice(i, i + batchSize));
    }

    const maxBatchSummaries = Number(settings.maxBatchSummaries || defaultSettings.maxBatchSummaries);
    if (maxBatchSummaries > 0 && batches.length > maxBatchSummaries) {
        // Keep only the first N batches
        batches = batches.slice(0, maxBatchSummaries);
    }

    const totalBatches = batches.length;
    let successCount = 0;
    const markersToInsert = [];

    for (let i = 0; i < totalBatches; i++) {
        const batch = batches[i];
        if (!batch.length) continue;

        if (button) {
            button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Batch ${i + 1} of ${totalBatches}...`;
        }

        const historyDepth = Number(settings.summaryHistoryDepth || defaultSettings.summaryHistoryDepth);
        let previousSnapshots = chatState.snapshots || [];
        if (historyDepth > 0 && previousSnapshots.length > historyDepth) {
            previousSnapshots = previousSnapshots.slice(-historyDepth);
        }

        const previousSummaryText = previousSnapshots
            .map(s => `${s.title || 'Scene #' + s.id}: ${s.text}`)
            .join('\n');

        const transcript = batch
            .map(({ msg }) => {
                const speaker = msg.name || (msg.is_user ? name1 : name2);
                return `${speaker}: ${msg.mes || ''}`.trim();
            })
            .join('\n');

        // Use combined extraction prompt (or legacy summary-only prompt if extraction is disabled)
        const prompt = buildExtractionPrompt(transcript, settings, previousSummaryText);

        try {
            const rawResult = await callSummarisationLLM(prompt, currentAbortController.signal);
            // Parse combined response — falls back gracefully to summary-only if tags are absent
            const { summaryText, blocks } = parseExtractionResponse(rawResult || '');
            let cleaned = summaryText;
            if (cleaned.startsWith(prompt.trim())) {
                cleaned = cleaned.substring(prompt.trim().length).trim();
            }
            logDebug('log', `LLM batch summary result ${i + 1}/${totalBatches}`, cleaned);
            logDebug('log', `Memory blocks extracted: ${blocks ? blocks.length : 0}`);

            // Update stored snapshot list
            const nextId = (chatState.summaryCounter ?? 0) + 1;

            // Getting the original index bounds for this batch
            const batchFromIndex = batch[0].originalIndex;
            const batchToIndex = batch[batch.length - 1].originalIndex + 1; // exclusive end

            const snapshot = {
                id: nextId,
                title: `Scene #${nextId}`,
                text: cleaned,
                createdAt: Date.now(),
                fromIndex: batchFromIndex,
                toIndex: batchToIndex,
                source: 'batch',
                words,
            };

            chatState.summaryCounter = nextId;
            chatState.snapshots.push(snapshot);
            chatState.lastSummarisedIndex = batchToIndex;

            // --- Memory Extraction (§2): persist bullets to Data Bank (silently in batch mode) ---
            const memoryEnabled = settings.memoryExtractionEnabled ?? defaultSettings.memoryExtractionEnabled;
            const totalApprovedBullets = blocks.reduce((sum, b) => sum + b.bullets.length, 0);

            if (memoryEnabled && totalApprovedBullets > 0) {
                const batchCtx = getContext();
                const avatar = batchCtx?.characters?.[batchCtx?.characterId]?.avatar
                    || (typeof characters !== 'undefined' ? characters[batchCtx?.characterId]?.avatar : undefined);

                if (avatar) {
                    const chatId = getActiveChatId();
                    const fileName = getSSMemoryFileName(chatId);
                    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
                    const sceneLabel = snapshot.title;
                    
                    let blockMarkdowns = [];
                    chatState.memories = chatState.memories || [];
                    let memoriesAdded = 0;

                    for (const block of blocks) {
                        const bulletsText = `* ${block.header}\n` + block.bullets.map(b => `* ${b}`).join('\n');
                        const newBlock = `<memory chat="${sceneLabel}" date="${timestamp}">\n${bulletsText}\n</memory>`;
                        blockMarkdowns.push(newBlock);

                        const newMemories = block.bullets.map(text => ({
                            id: ++chatState.memoryCounter,
                            text,
                            chatLabel: sceneLabel,
                            blockHeader: block.header,
                            characters: block.characters,
                            extractedAt: batchToIndex,
                            createdAt: Date.now(),
                            source: 'extracted',
                        }));
                        chatState.memories.push(...newMemories);
                        memoriesAdded += newMemories.length;
                    }

                    // Fire-and-forget in batch: don't block the loop, but log errors
                    appendSSMemoriesBlock(avatar, fileName, blockMarkdowns.join('\n\n')).catch(err => {
                        logDebug('error', `Batch memory write failed for ${sceneLabel}:`, err?.message || err);
                    });

                    pruneMemories(chatState, settings);
                    logDebug('log', `Batch: persisted ${memoriesAdded} memories for ${sceneLabel}`);
                }
            }

            if (settings.insertSceneBreak) {
                markersToInsert.push({ index: batchToIndex, id: nextId });
            }

            successCount++;

            // Update UI dynamically to show the new snapshot
            updateSettingsUI(settingsContainer);
        } catch (error) {
            if (error?.message === 'AbortError' || String(error).includes('AbortError') || String(error).includes('aborted')) {
                logDebug('warn', `Batch summarisation aborted at batch ${i + 1}/${totalBatches}`);
                toastr.info(`Batch summarisation stopped at batch ${i + 1}`);
                break;
            } else {
                console.error(`[${extensionName}] Error during batch summarisation (batch ${i + 1}):`, error);
                logDebug('error', `Batch ${i + 1} error`, error?.message || error);
                toastr.error(`Error generating batch ${i + 1}. Stopping.`);
                break; // Stop remaining batches on error
            }
        }
    }

    if (successCount > 0) {
        logDebug('log', `Batch completely inserted ${successCount} summaries`);
        toastr.success(`Batch summarisation complete: ${successCount} new summaries generated.`);
        applyInjection();
        saveSettingsDebounced();
    }

    if (button) {
        button.classList.remove('ss-stop-btn');
        button.innerHTML = originalText;
    }
    isSummarising = false;
    currentAbortController = null;

    if (markersToInsert.length > 0) {
        // Insert markers in reverse order so we don't shift earlier indices
        markersToInsert.sort((a, b) => b.index - a.index);

        for (const ins of markersToInsert) {
            const markerId = `scene-break-${Date.now()}-${ins.id}`;
            const markerHtml = `<details class="scene-summary-break" data-marker-id="${markerId}"><summary>📑 Scene Summary Boundary</summary><div>Summaries above; new messages below.</div></details>`;
            const message = {
                name: extensionName,
                is_user: false,
                is_system: true,
                send_date: Date.now(),
                mes: markerHtml,
                extra: {
                    scene_summariser_marker: true,
                    marker_id: markerId,
                    snapshot_id: ins.id,
                }
            };

            // Add the extra fields in a way ST's chat parser expects
            if (typeof message.extra !== 'object') {
                message.extra = {};
            }
            message.extra.scene_summariser_marker = true;
            message.extra.marker_id = markerId;
            message.extra.snapshot_id = ins.id;

            fullChat.splice(ins.index, 0, message);
        }
        modifiedChat = true;
    }

    if (modifiedChat) {
        if (typeof ctx.saveChat === 'function') await ctx.saveChat();
        if (typeof reloadCurrentChat === 'function') await reloadCurrentChat();
    }

    if (successCount > 0) {
        toastr.success(`Successfully generated ${successCount} summaries.`);
    }

    applyInjection();
    applyInjection();
    saveSettingsDebounced();
    isSummarising = false;
}

function handleSnapshotSelectionChange(container) {
    if (!container) return;
    const checkboxes = Array.from(container.querySelectorAll('.ss-snapshot-select'));
    if (!checkboxes.length) return;

    let firstChecked = -1;
    let lastChecked = -1;

    checkboxes.forEach((cb, index) => {
        if (cb.checked) {
            if (firstChecked === -1) firstChecked = index;
            lastChecked = index;
        }
    });

    if (firstChecked !== -1 && lastChecked !== -1 && lastChecked > firstChecked) {
        // Enforce consecutive selection
        for (let i = firstChecked; i <= lastChecked; i++) {
            checkboxes[i].checked = true;
        }
    }

    const consolidateButton = container.querySelector('#ss_consolidate_button');
    if (consolidateButton) {
        const checkedCount = checkboxes.filter(cb => cb.checked).length;
        consolidateButton.style.display = checkedCount >= 2 ? '' : 'none';
    }
}

async function onConsolidateClick() {
    if (isSummarising || !settingsContainer) return;
    
    const checkboxes = Array.from(settingsContainer.querySelectorAll('.ss-snapshot-select'));
    const selectedIds = checkboxes.filter(cb => cb.checked).map(cb => Number(cb.dataset.snapId));
    
    if (selectedIds.length < 2) {
        toastr.info('Please select at least two consecutive snapshots to consolidate.');
        return;
    }

    isSummarising = true;
    currentAbortController = new AbortController();
    const button = settingsContainer.querySelector('#ss_consolidate_button');
    const originalHtml = button?.innerHTML;
    if (button) {
        button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Consolidating...';
        button.disabled = true;
    }

    try {
        const settings = extension_settings[settingsKey];
        const chatState = getChatState();
        const words = settings.summaryWords || defaultSettings.summaryWords;
        const promptTemplate = settings.consolidationPrompt || defaultSettings.consolidationPrompt;

        // Gather snapshots to consolidate
        const snapshotsToConsolidate = chatState.snapshots.filter(s => selectedIds.includes(s.id));
        if (snapshotsToConsolidate.length !== selectedIds.length) {
            throw new Error('Could not find all selected snapshots in chat state.');
        }

        const summariesText = snapshotsToConsolidate
            .map(s => `${s.title}: ${s.text}`)
            .join('\n\n');

        const prompt = promptTemplate
            .replace('{{words}}', words)
            + `\n\nScenes to consolidate:\n${summariesText}`;

        const result = await callSummarisationLLM(prompt, currentAbortController.signal);
        let cleaned = (result || '').trim();
        if (cleaned.startsWith(prompt.trim())) {
            cleaned = cleaned.substring(prompt.trim().length).trim();
        }

        const editedText = await showSummaryEditor(cleaned);
        if (editedText === null) {
            logDebug('log', 'User cancelled consolidation editor');
            return;
        }

        // Determine title & indices
        const firstSnap = snapshotsToConsolidate[0];
        const lastSnap = snapshotsToConsolidate[snapshotsToConsolidate.length - 1];
        
        // Match numbers from "Scene #X" to form "Scene X-Y", fallback to IDs
        const extractNum = (title, id) => {
            const match = /Scene #?(\d+(?:-\d+)?)/i.exec(title);
            return match ? match[1] : id;
        };
        const startNum = extractNum(firstSnap.title, firstSnap.id);
        const endNum = extractNum(lastSnap.title, lastSnap.id);
        const newTitle = `Scene ${startNum}-${endNum}`;

        const newId = (chatState.summaryCounter ?? 0) + 1;
        chatState.summaryCounter = newId;

        const newSnapshot = {
            id: newId,
            title: newTitle,
            text: editedText,
            createdAt: Date.now(),
            fromIndex: firstSnap.fromIndex,
            toIndex: lastSnap.toIndex,
            source: 'consolidation',
            words,
        };

        // Remove old snapshots and insert the new one
        const startIndex = chatState.snapshots.findIndex(s => s.id === firstSnap.id);
        chatState.snapshots.splice(startIndex, snapshotsToConsolidate.length, newSnapshot);

        logDebug('log', `Consolidated ${snapshotsToConsolidate.length} snapshots into ${newTitle}`);
        toastr.success(`Successfully consolidated ${snapshotsToConsolidate.length} scenes.`);

        updateSettingsUI(settingsContainer);
        applyInjection();
        saveSettingsDebounced();
    } catch (error) {
        if (error?.message === 'AbortError' || String(error).includes('AbortError') || String(error).includes('aborted')) {
            logDebug('warn', 'Consolidation aborted by user');
        } else {
            console.error(`[${extensionName}] Error during consolidation:`, error);
            logDebug('error', 'Consolidation error', error?.message || error);
            toastr.error('Consolidation error: ' + (error?.message || error));
        }
    } finally {
        if (button) {
            button.innerHTML = originalHtml;
            button.disabled = false;
        }
        isSummarising = false;
        currentAbortController = null;
    }
}

function applyInjection() {
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

    const ctx = getContext();
    const chat = ctx?.chat || [];
    const lastIdx = Math.min(chatState.lastSummarisedIndex || 0, chat.length);
    const newMessages = chat.slice(lastIdx);
    const name1 = ctx?.name1 || 'User';
    const name2 = ctx?.name2 || 'Character';
    const transcript = newMessages
        .slice(-50)
        .map((m) => {
            const speaker = m.name || (m.is_user ? name1 : name2);
            return `${speaker}: ${m.mes || ''}`.trim();
        })
        .join('\n');

    const template = settings.injectTemplate || defaultSettings.injectTemplate;
    const value = template
        .replace('{{summary}}', buildSummaryText(chatState, settings))
        .replace('{{last_messages}}', transcript)
        .replace('{{words}}', settings.summaryWords ?? defaultSettings.summaryWords);

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

async function insertSceneBreakMarker(snapshotId) {
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

jQuery(async () => {
    ensureSettings();
    await mountSettings();
    startButtonMount();
    try {
        // logDebug('log', `eventSource available: ${!!eventSource}`);
        // eventSource?.on(event_types.CHAT_COMPLETION_PROMPT_READY, filterChatCompletionPrompt);
        // eventSource?.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, filterTextCompletionPrompt);
        eventSource?.on(event_types.CHAT_CHANGED, onChatChanged);
        logDebug('log', 'Registered prompt filter listeners (migrated to generate_interceptor)');
    } catch (err) {
        console.error(`[${extensionName}] Failed to register prompt filter:`, err);
    }
});

function onChatChanged() {
    logDebug('log', 'Chat changed, refreshing chat-scoped state');
    updateSettingsUI(settingsContainer);
    applyInjection();
}

/**
 * Context interceptor for filtering messages
 * @param {object[]} chat The chat array to filter
 * @param {number} maxContext The maximum context size (unused here but passed by ST)
 * @param {function} abort Function to abort generation
 * @param {string} type Generation type ('chat', 'text', 'quiet', etc)
 */
async function filterContextInterceptor(chat, maxContext, abort, type) {
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

// Expose the interceptor globally matching the name in manifest.json
window['SceneSummariser_filterContextInterceptor'] = filterContextInterceptor;
