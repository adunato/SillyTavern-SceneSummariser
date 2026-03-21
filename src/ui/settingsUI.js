import { extensionName, settingsKey, defaultSettings, state } from '../constants.js';
import { logDebug } from '../utils/logger.js';
import { getChatState, getActiveChatId } from '../state/stateManager.js';
import { buildSummaryText } from '../core/engine.js';
import { applyInjection, updateInjectionVisibility, updateContextControlVisibility } from '../core/injector.js';
import { persistMemoriesForChat } from '../storage/memoryFileHandler.js';
import { extension_settings, renderExtensionTemplateAsync, getContext } from '../../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../../shared.js';
// We will need to import the other UI components and button handlers
import { handleSnapshotAction, renderSnapshotsList, handleSnapshotSelectionChange } from './snapshotUI.js';
import { onSummariseClick, onConsolidateClick, onBatchSummariseClick } from './buttons.js';

import { purgeVectorCollection, getChatCollectionId } from '../storage/vectorHandler.js';

export function togglePanel(container, selector) {
    const panel = container.querySelector(selector);
    if (!panel) return;
    const isHidden = panel.style.display === 'none';
    panel.style.display = isHidden ? '' : 'none';
}

export function updatePromptVisibility(container) {
    if (!container) return;
    const settings = extension_settings[settingsKey] || defaultSettings;
    const memoryEnabled = settings.memoryExtractionEnabled ?? defaultSettings.memoryExtractionEnabled;

    const summaryPromptEl = container.querySelector('#ss_summaryPrompt');
    const summaryHintEl = container.querySelector('#ss_summaryPrompt_hint');
    const memoryPromptEl = container.querySelector('#ss_memoryPrompt');
    const memoryHintEl = container.querySelector('#ss_memoryPrompt_hint');

    if (summaryPromptEl) {
        // @ts-ignore
        summaryPromptEl.disabled = memoryEnabled;
        // @ts-ignore
        summaryPromptEl.style.opacity = memoryEnabled ? '0.5' : '1';
        if (summaryHintEl) {
            summaryHintEl.textContent = memoryEnabled
                ? '⚠️ Disabled: Using the combined "Extraction Prompt" below.'
                : 'Prompt used to generate summaries.';
            // @ts-ignore
            summaryHintEl.style.color = memoryEnabled ? 'var(--smart-theme-yellow)' : '';
        }
    }

    if (memoryPromptEl) {
        // @ts-ignore
        memoryPromptEl.disabled = !memoryEnabled;
        // @ts-ignore
        memoryPromptEl.style.opacity = !memoryEnabled ? '0.5' : '1';
        if (memoryHintEl) {
            memoryHintEl.textContent = !memoryEnabled
                ? '⚠️ Disabled: Using the standard "Summary Prompt" above.'
                : 'This prompt replaces the Summary Prompt when extraction is enabled. Must include <summary> and <memory> tags.';
            // @ts-ignore
            memoryHintEl.style.color = !memoryEnabled ? 'var(--smart-theme-yellow)' : '';
        }
    }
}

export function bindSettingsUI(container) {
    if (!container) return;

    // 1) Standard inputs
    container.addEventListener('input', (event) => {
        const target = event.target;
        // @ts-ignore
        if (!target.classList?.contains('ss-setting-input')) return;

        // @ts-ignore
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

        if (name === 'memoryExtractionEnabled') {
            updatePromptVisibility(container);
        }

        if (name === 'summariesToInject') {
            const display = container.querySelector('#ss_summariesToInject_value');
            if (display) display.textContent = newValue;
            const currentSummary = container.querySelector('#ss_currentSummary');
            if (currentSummary) currentSummary.value = buildSummaryText(getChatState(), extension_settings[settingsKey]);
            applyInjection();
        }

        if (name === 'fullSummariesToInject') {
            const display = container.querySelector('#ss_fullSummariesToInject_value');
            if (display) display.textContent = newValue;
            const currentSummary = container.querySelector('#ss_currentSummary');
            if (currentSummary) currentSummary.value = buildSummaryText(getChatState(), extension_settings[settingsKey]);
            applyInjection();
        }

        if (name === 'summaryContextDepth') {
            const display = container.querySelector('#ss_summaryContextDepth_value');
            if (display) display.textContent = newValue;
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

        if (name === 'fullMemoriesToInject') {
            const display = container.querySelector('#ss_fullMemoriesToInject_value');
            if (display) display.textContent = newValue;
            const currentSummary = container.querySelector('#ss_currentSummary');
            if (currentSummary) currentSummary.value = buildSummaryText(getChatState(), extension_settings[settingsKey]);
            applyInjection();
        }

        if (name === 'semanticSearchDepth') {
            const display = container.querySelector('#ss_semanticSearchDepth_value');
            if (display) display.textContent = newValue;
        }

        if (name === 'semanticTopK') {
            const display = container.querySelector('#ss_semanticTopK_value');
            if (display) display.textContent = newValue;
        }

        if (name === 'semanticThreshold') {
            const display = container.querySelector('#ss_semanticThreshold_value');
            if (display) display.textContent = newValue;
        }

        if (['injectEnabled', 'injectPosition', 'injectDepth', 'injectScan', 'injectRole', 'injectTemplate', 'semanticRetrievalEnabled'].includes(name)) {
            applyInjection();
        }
    });

    // 1b) Auto-save summary text
    container.addEventListener('input', (event) => {
        if (event.target.classList.contains('ss-snap-desc')) {
            const id = Number(event.target.dataset.id);
            const chatState = getChatState();
            const snap = chatState.snapshots.find(s => s.id === id);
            if (snap) {
                snap.description = event.target.value;
                saveSettingsDebounced();
            }
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

    // 2) Click delegation
    container.addEventListener('click', async (event) => {
        const tabEl = event.target.closest('.tab');
        if (tabEl) {
            const tabName = tabEl.dataset.tab;
            const tabs = container.querySelectorAll('.tab');
            tabs.forEach(t => t.classList.remove('active'));
            const contents = container.querySelectorAll('.tab-content');
            contents.forEach(c => c.classList.remove('active'));
            
            tabEl.classList.add('active');
            const targetContent = container.querySelector(`#${tabName}`);
            if (targetContent) targetContent.classList.add('active');
            return;
        }

        // Snapshot inner character tabs
        const snapTabBtn = event.target.closest('.ss-snap-tab-btn');
        if (snapTabBtn) {
            const char = snapTabBtn.dataset.char;
            const snapId = snapTabBtn.dataset.snapId;
            const itemContainer = container.querySelector(`.ss-snap-memories-container[data-snap-id="${snapId}"]`);
            if (itemContainer) {
                const allTabs = snapTabBtn.parentElement.querySelectorAll('.ss-snap-tab-btn');
                allTabs.forEach(t => t.classList.remove('active'));
                snapTabBtn.classList.add('active');

                const items = itemContainer.querySelectorAll('.ss-memory-edit-item');
                items.forEach(item => {
                    if (char === 'All') {
                        // @ts-ignore
                        item.style.display = '';
                    } else {
                        const itemChars = (item.dataset.chars || '').split('||');
                        // @ts-ignore
                        item.style.display = itemChars.includes(char) ? '' : 'none';
                    }
                });
            }
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

        // Reset Prompt Buttons
        const resetBtn = event.target.closest('#ss_reset_summaryPrompt, #ss_reset_consolidationPrompt, #ss_reset_memoryPrompt');
        if (resetBtn) {
            const id = resetBtn.id;
            let key = '';
            if (id === 'ss_reset_summaryPrompt') key = 'summaryPrompt';
            else if (id === 'ss_reset_consolidationPrompt') key = 'consolidationPrompt';
            else if (id === 'ss_reset_memoryPrompt') key = 'memoryPrompt';
            
            if (key) {
                if (confirm(`Reset ${key} to default?`)) {
                    extension_settings[settingsKey][key] = defaultSettings[key];
                    saveSettingsDebounced();
                    updateSettingsUI(container);
                }
            }
        }

        // Delete Fact from Snapshot
        const deleteMemoryBtn = event.target.closest('.ss-delete-snap-memory');
        if (deleteMemoryBtn) {
            const snapId = Number(deleteMemoryBtn.dataset.snapId);
            const index = Number(deleteMemoryBtn.dataset.index);
            const chatState = getChatState();
            const snap = chatState.snapshots.find(s => s.id === snapId);
            if (snap && snap.memories) {
                snap.memories.splice(index, 1);
                
                persistMemoriesForChat(chatState).catch(err => logDebug('error', 'persistMemoriesForChat', err));
                
                saveSettingsDebounced();
                renderSnapshotsList(container, chatState, extension_settings[settingsKey]);
                
                // Re-open accordion after render
                const item = container.querySelector(`.ss-snapshot-item[data-id="${snapId}"]`);
                if (item) item.classList.add('expanded');
            }
        }
    });

    // 2b) Auto-save snapshot text and descriptions
    container.addEventListener('input', (event) => {
        if (event.target.classList.contains('ss-snap-memory-text')) {
            const snapId = Number(event.target.dataset.snapId);
            const index = Number(event.target.dataset.index);
            const chatState = getChatState();
            const snap = chatState.snapshots.find(s => s.id === snapId);
            if (snap && snap.memories) {
                snap.memories[index] = event.target.value;
                saveSettingsDebounced();

                clearTimeout(snap.memoryRewriteTimeout);
                snap.memoryRewriteTimeout = setTimeout(() => {
                    persistMemoriesForChat(chatState).catch(err => logDebug('error', 'persistMemoriesForChat', err));
                }, 2000);
            }
            return;
        }

        if (event.target.classList.contains('ss-snap-desc')) {
            const id = Number(event.target.dataset.id);
            const chatState = getChatState();
            const snap = chatState.snapshots.find(s => s.id === id);
            if (snap) {
                snap.description = event.target.value;
                saveSettingsDebounced();
            }
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

    const summariseButton = container.querySelector('#ss_settings_summarise_button');
    if (summariseButton) {
        summariseButton.addEventListener('click', onSummariseClick);
    }

    const consolidateButton = container.querySelector('#ss_consolidate_button');
    if (consolidateButton) {
        consolidateButton.addEventListener('click', onConsolidateClick);
    }

    const purgeVectorButton = container.querySelector('#ss_purge_vector_button');
    if (purgeVectorButton) {
        purgeVectorButton.addEventListener('click', async () => {
            if (confirm('Are you sure you want to purge the vector index for this chat? This cannot be undone.')) {
                await purgeVectorCollection(getChatCollectionId());
                toastr.success('Vector index purged');
            }
        });
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
    setValue('#ss_summariesToInject', settings.summariesToInject ?? defaultSettings.summariesToInject);
    setValue('#ss_fullSummariesToInject', settings.fullSummariesToInject ?? defaultSettings.fullSummariesToInject);
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
    setValue('#ss_summaryContextDepth', settings.summaryContextDepth ?? defaultSettings.summaryContextDepth);
    // Memory extraction (§2)
    setValue('#ss_memoryExtractionEnabled', settings.memoryExtractionEnabled ?? defaultSettings.memoryExtractionEnabled);
    setValue('#ss_memoryPrompt', settings.memoryPrompt ?? defaultSettings.memoryPrompt);
    setValue('#ss_maxMemories', settings.maxMemories ?? defaultSettings.maxMemories);
    setValue('#ss_fullMemoriesToInject', settings.fullMemoriesToInject ?? defaultSettings.fullMemoriesToInject);
    setValue('#ss_semanticRetrievalEnabled', settings.semanticRetrievalEnabled ?? defaultSettings.semanticRetrievalEnabled);
    setValue('#ss_semanticSearchDepth', settings.semanticSearchDepth ?? defaultSettings.semanticSearchDepth);
    setValue('#ss_semanticTopK', settings.semanticTopK ?? defaultSettings.semanticTopK);
    setValue('#ss_semanticThreshold', settings.semanticThreshold ?? defaultSettings.semanticThreshold);

    // Radio for position
    const radios = container.querySelectorAll('input[name="injectPosition"]');
    radios.forEach(r => r.checked = String(r.value) === String(settings.injectPosition));

    updateInjectionVisibility(container);
    updateContextControlVisibility(container);
    updatePromptVisibility(container);

    const wordsDisplay = container.querySelector('#ss_summaryWords_value');
    if (wordsDisplay) wordsDisplay.textContent = settings.summaryWords ?? defaultSettings.summaryWords;

    const summariesToInjectDisplay = container.querySelector('#ss_summariesToInject_value');
    if (summariesToInjectDisplay) summariesToInjectDisplay.textContent = settings.summariesToInject ?? defaultSettings.summariesToInject;

    const summaryContextDepthDisplay = container.querySelector('#ss_summaryContextDepth_value');
    if (summaryContextDepthDisplay) summaryContextDepthDisplay.textContent = settings.summaryContextDepth ?? defaultSettings.summaryContextDepth;

    const fullMemoriesToInjectDisplay = container.querySelector('#ss_fullMemoriesToInject_value');
    if (fullMemoriesToInjectDisplay) fullMemoriesToInjectDisplay.textContent = settings.fullMemoriesToInject ?? defaultSettings.fullMemoriesToInject;

    const semanticSearchDepthDisplay = container.querySelector('#ss_semanticSearchDepth_value');
    if (semanticSearchDepthDisplay) semanticSearchDepthDisplay.textContent = settings.semanticSearchDepth ?? defaultSettings.semanticSearchDepth;

    const semanticTopKDisplay = container.querySelector('#ss_semanticTopK_value');
    if (semanticTopKDisplay) semanticTopKDisplay.textContent = settings.semanticTopK ?? defaultSettings.semanticTopK;

    const semanticThresholdDisplay = container.querySelector('#ss_semanticThreshold_value');
    if (semanticThresholdDisplay) semanticThresholdDisplay.textContent = settings.semanticThreshold ?? defaultSettings.semanticThreshold;

    const batchSizeDisplay = container.querySelector('#ss_batchSize_value');
    if (batchSizeDisplay) batchSizeDisplay.textContent = settings.batchSize ?? defaultSettings.batchSize;

    const maxBatchSummariesDisplay = container.querySelector('#ss_maxBatchSummaries_value');
    if (maxBatchSummariesDisplay) maxBatchSummariesDisplay.textContent = settings.maxBatchSummaries ?? defaultSettings.maxBatchSummaries;

    const keepMessagesCountDisplay = container.querySelector('#ss_keepMessagesCount_value');
    if (keepMessagesCountDisplay) keepMessagesCountDisplay.textContent = settings.keepMessagesCount ?? defaultSettings.keepMessagesCount;

    const manualSummaryLimitDisplay = container.querySelector('#ss_manualSummaryLimit_value');
    if (manualSummaryLimitDisplay) manualSummaryLimitDisplay.textContent = settings.manualSummaryLimit ?? defaultSettings.manualSummaryLimit;

    const currentSummary = container.querySelector('#ss_currentSummary');
    if (currentSummary) currentSummary.value = buildSummaryText(chatState, settings);

    renderSnapshotsList(container, chatState, settings);

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
