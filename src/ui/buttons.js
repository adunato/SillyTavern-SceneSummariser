import { state, extensionName, settingsKey, defaultSettings } from '../constants.js';
import { logDebug } from '../utils/logger.js';
import { ensureSettings, getChatState, getActiveChatId } from '../state/stateManager.js';
import { getContext, extension_settings } from '../../../../../extensions.js';
import { buildExtractionPrompt, parseExtractionResponse, pruneMemories } from '../core/engine.js';
import { callSummarisationLLM } from '../core/llmApi.js';
import { showCombinedEditor, showSummaryEditor } from './editorUI.js';
import { getSSMemoryFileName, appendSSMemoriesBlock, writeSSMemoriesFile } from '../storage/memoryFileHandler.js';
import { applyInjection, insertSceneBreakMarker } from '../core/injector.js';
import { updateSettingsUI } from './settingsUI.js';
import { saveSettingsDebounced, reloadCurrentChat } from '../../../../../../script.js';

export function createSummariseButton() {
    const button = document.createElement('div');
    button.id = 'ss_summarise_button';
    // Reuse GG button styling for consistent look/placement
    button.className = 'gg-action-button ss-action-button fa-solid fa-clapperboard';
    button.title = 'Summarise Scene';

    button.addEventListener('click', () => {
        if (state.isSummarising && state.currentAbortController) {
            logDebug('log', 'Aborting summarisation by user request');
            state.currentAbortController.abort();
            return;
        }
        onSummariseClick();
    });

    return button;
}

export function placeSummariseButton() {
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
        if (sendForm && nonQRFormItems && nonQRFormItems.parentNode) {
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

export function startButtonMount() {
    // Try immediately
    let mounted = placeSummariseButton();

    // Retry a few times while the GG toolbar initializes/refreshes
    if (state.buttonIntervalId) {
        clearInterval(state.buttonIntervalId);
    }
    state.buttonIntervalId = setInterval(() => {
        mounted = placeSummariseButton() || mounted;
        // Stop after it has successfully placed once and exists in DOM
        if (mounted && document.getElementById('ss_summarise_button')) {
            clearInterval(state.buttonIntervalId);
            state.buttonIntervalId = null;
        }
    }, 1000);

    // Safety stop after 15s
    setTimeout(() => {
        if (state.buttonIntervalId) {
            clearInterval(state.buttonIntervalId);
            state.buttonIntervalId = null;
        }
    }, 15000);
}

export async function onSummariseClick() {
    if (state.isSummarising) return;
    ensureSettings();
    if (!extension_settings[settingsKey]?.enabled) {
        console.warn(`[${extensionName}] Summariser disabled.`);
        return;
    }
    state.isSummarising = true;
    state.currentAbortController = new AbortController();

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
        state.isSummarising = false;
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
        const rawResult = await callSummarisationLLM(prompt, state.currentAbortController.signal);
        // Parse combined response — falls back gracefully to summary-only if tags are absent
        const { summaryText, blocks, title, description } = parseExtractionResponse(rawResult || '');
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
        const baseTitle = `Scene #${nextId}`;
        const snapshot = {
            id: nextId,
            title: title ? `${baseTitle} - ${title}` : baseTitle,
            description: description || '',
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
                // @ts-ignore
                || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined)
                || ctx?.avatar; // Fallback to current context avatar

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
                    const bulletsText = `- ${block.header}\n` + block.bullets.map(b => `- ${b}`).join('\n');
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

        updateSettingsUI(state.settingsContainer);

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
        state.isSummarising = false;
        state.currentAbortController = null;
    }
}

export async function onBatchSummariseClick() {
    if (state.isSummarising) return;
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

    state.isSummarising = true;
    state.currentAbortController = new AbortController();

    const button = document.getElementById('ss_batch_summarise_button');
    const originalText = button?.innerHTML;
    if (button) {
        button.classList.add('ss-stop-btn');
        button.innerHTML = '<i class="fa-solid fa-stop"></i> Stop Batch...';
    }
    logDebug('log', 'Batch Summarise clicked');

    const chatState = getChatState();
    const words = settings.summaryWords || defaultSettings.summaryWords;

    // Reset state
    chatState.snapshots = [];
    chatState.summaryCounter = 0;
    chatState.lastSummarisedIndex = 0;
    chatState.memories = [];
    chatState.memoryCounter = 0;

    const ctx = getContext();
    const avatar = ctx?.characters?.[ctx?.characterId]?.avatar
        // @ts-ignore
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
            button.innerHTML = originalText || '';
        }
        state.isSummarising = false;
        state.currentAbortController = null;
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
        const prompt = buildExtractionPrompt(transcript, settings, previousSummaryText, chatState);

        try {
            const rawResult = await callSummarisationLLM(prompt, state.currentAbortController.signal);
            // Parse combined response — falls back gracefully to summary-only if tags are absent
            const { summaryText, blocks, title, description } = parseExtractionResponse(rawResult || '');
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

            const baseTitle = `Scene #${nextId}`;
            const snapshot = {
                id: nextId,
                title: title ? `${baseTitle} - ${title}` : baseTitle,
                description: description || '',
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
                    // @ts-ignore
                    || (typeof characters !== 'undefined' ? characters[batchCtx?.characterId]?.avatar : undefined)
                    || batchCtx?.avatar;

                if (avatar) {
                    const chatId = getActiveChatId();
                    const fileName = getSSMemoryFileName(chatId);
                    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
                    const sceneLabel = snapshot.title;
                    
                    let blockMarkdowns = [];
                    chatState.memories = chatState.memories || [];
                    let memoriesAdded = 0;

                    for (const block of blocks) {
                        const bulletsText = `- ${block.header}\n` + block.bullets.map(b => `- ${b}`).join('\n');
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
            updateSettingsUI(state.settingsContainer);
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
        button.innerHTML = originalText || '';
    }
    state.isSummarising = false;
    state.currentAbortController = null;

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
    saveSettingsDebounced();
    state.isSummarising = false;
}

export async function onConsolidateClick() {
    if (state.isSummarising || !state.settingsContainer) return;
    
    const checkboxes = Array.from(state.settingsContainer.querySelectorAll('.ss-snapshot-select'));
    // @ts-ignore
    const selectedIds = checkboxes.filter(cb => cb.checked).map(cb => Number(cb.dataset.snapId));
    
    if (selectedIds.length < 2) {
        toastr.info('Please select at least two consecutive snapshots to consolidate.');
        return;
    }

    state.isSummarising = true;
    state.currentAbortController = new AbortController();
    const button = state.settingsContainer.querySelector('#ss_consolidate_button');
    const originalHtml = button?.innerHTML;
    if (button) {
        button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Consolidating...';
        // @ts-ignore
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

        const result = await callSummarisationLLM(prompt, state.currentAbortController.signal);
        const { summaryText, title, description } = parseExtractionResponse(result || '');
        let cleaned = summaryText;
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
            title: title ? `${newTitle} - ${title}` : newTitle,
            description: description || '',
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

        updateSettingsUI(state.settingsContainer);
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
            button.innerHTML = originalHtml || '';
            // @ts-ignore
            button.disabled = false;
        }
        state.isSummarising = false;
        state.currentAbortController = null;
    }
}
