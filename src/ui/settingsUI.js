import { extensionName, settingsKey, defaultSettings, state } from '../constants.js';
import { logDebug } from '../utils/logger.js';
import { getChatState } from '../state/stateManager.js';
import { buildSummaryText, reconcileMemories } from '../core/engine.js';
import { applyInjection, updateInjectionVisibility, updateContextControlVisibility } from '../core/injector.js';
import { getSSMemoryFileName, writeSSMemoriesFile } from '../storage/memoryFileHandler.js';
import { extension_settings, renderExtensionTemplateAsync, getContext } from '../../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../../shared.js';
// We will need to import the other UI components and button handlers
import { handleSnapshotAction, renderSnapshotsList, handleSnapshotSelectionChange } from './snapshotUI.js';
import { renderMemoriesList } from './memoryUI.js';
import { onSummariseClick, onConsolidateClick, onBatchSummariseClick } from './buttons.js';

export function togglePanel(container, selector) {
    const panel = container.querySelector(selector);
    if (!panel) return;
    const isHidden = panel.style.display === 'none';
    panel.style.display = isHidden ? '' : 'none';
}

export function bindSettingsUI(container) {
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
                    // @ts-ignore
                    || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined);
                if (avatar) {
                    const fileName = getSSMemoryFileName(chatState.chatId);
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
                    // @ts-ignore
                    || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined);
                if (avatar) {
                    const fileName = getSSMemoryFileName(chatState.chatId);
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
                        // @ts-ignore
                        || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined);
                    if (avatar) {
                        const fileName = getSSMemoryFileName(chatState.chatId);
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
                    // @ts-ignore
                    || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined);
                if (avatar) {
                    const fileName = getSSMemoryFileName(chatState.chatId);
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
        const text = state.debugMessages.join('\n');
        try {
            await navigator.clipboard.writeText(text);
            logDebug('log', 'Debug logs copied to clipboard');
        } catch (err) {
            console.error(`[${extensionName}] Failed to copy logs:`, err);
        }
    });

    container.querySelector('#ss_clearLogs')?.addEventListener('click', () => {
        state.debugMessages = [];
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
            if (state.isSummarising && state.currentAbortController) {
                logDebug('log', 'Aborting batch summarisation by user request');
                state.currentAbortController.abort();
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

export function updateSettingsUI(container) {
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

export async function mountSettings() {
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
    state.settingsContainer = container;

    const html = await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'settings');
    container.innerHTML = html;
    bindSettingsUI(container);
    updateSettingsUI(container);
}
