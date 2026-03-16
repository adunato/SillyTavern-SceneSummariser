import { extension_settings, getContext } from '../../../../../extensions.js';
import { reloadCurrentChat } from '../../../../../../script.js';
import { settingsKey, defaultSettings, extensionName } from '../constants.js';
import { logDebug } from '../utils/logger.js';
import { getSSMemoryFileName, writeSSMemoriesFile } from '../storage/memoryFileHandler.js';
import { getActiveChatId } from '../state/stateManager.js';
import { buildExtractionPrompt, pruneMemories, parseExtractionResponse } from '../core/engine.js';
import { callSummarisationLLM } from '../core/llmApi.js';
import { showCombinedEditor } from './editorUI.js';
import { renderMemoriesList } from './memoryUI.js';

export function renderSnapshotsList(container, chatState, settings) {
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
        item.dataset.id = String(snap.id);

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

export async function handleSnapshotAction(action, snapshotId, chatState, container) {
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
                // @ts-ignore
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
            // @ts-ignore
            icon.style.pointerEvents = 'none';
        }
        await regenerateSnapshot(snap, settings, chatState);
        if (icon) {
            icon.classList.remove('fa-spinner', 'fa-spin');
            icon.classList.add('fa-arrows-rotate');
            // @ts-ignore
            icon.style.pointerEvents = '';
        }
    }
}

export async function regenerateSnapshot(snapshot, settings, chatState) {
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

    // Fix: Only use summaries prior to this one as context
    const snapshotIndex = chatState.snapshots.findIndex(s => s.id === snapshot.id);
    let previousSnapshots = snapshotIndex > -1 ? chatState.snapshots.slice(0, snapshotIndex) : [];

    const historyDepth = Number(settings.summaryHistoryDepth || defaultSettings.summaryHistoryDepth);
    if (historyDepth > 0 && previousSnapshots.length > historyDepth) {
        previousSnapshots = previousSnapshots.slice(-historyDepth);
    }

    const previousSummaryText = previousSnapshots.map(s => `${s.title}: ${s.text}`).join('\n');

    // Use combined extraction prompt to ensure memory extraction remains active during regeneration
    const prompt = buildExtractionPrompt(transcript, settings, previousSummaryText, chatState);

    try {
        const result = await callSummarisationLLM(prompt);
        const { summaryText, blocks } = parseExtractionResponse(result || '');
        let cleaned = summaryText;
        if (cleaned.startsWith(prompt.trim())) {
            cleaned = cleaned.substring(prompt.trim().length).trim();
        }

        // Use the combined editor to allow reviewing both the regenerated summary and memories
        const editorResult = await showCombinedEditor(cleaned, blocks);
        if (!editorResult) {
            logDebug('log', 'User cancelled regeneration editor');
            return;
        }

        const { summary: editedText, blocks: approvedBlocks } = editorResult;

        snapshot.text = editedText;
        snapshot.createdAt = Date.now();
        logDebug('log', `Regenerated snapshot ${snapshot.id}`);

        // Handle memory extraction for regenerated snapshot
        const memoryEnabled = settings.memoryExtractionEnabled ?? defaultSettings.memoryExtractionEnabled;
        const totalApprovedBullets = approvedBlocks.reduce((sum, b) => sum + b.bullets.length, 0);

        if (memoryEnabled && totalApprovedBullets > 0) {
            const avatar = ctx?.characters?.[ctx?.characterId]?.avatar
                // @ts-ignore
                || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined)
                || ctx?.avatar;
            if (avatar) {
                const chatId = getActiveChatId();
                const fileName = getSSMemoryFileName(chatId);
                const sceneLabel = snapshot.title;
                const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

                // Remove old memories associated with this snapshot
                chatState.memories = chatState.memories.filter(m => m.chatLabel !== sceneLabel);

                let blockMarkdowns = [];
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
                        extractedAt: snapshot.toIndex || 0,
                        createdAt: Date.now(),
                        source: 'extracted',
                    }));
                    chatState.memories.push(...newMemories);
                    memoriesAdded += newMemories.length;
                }

                // Completely rewrite the file to clear out old deleted memories and add the new ones
                await writeSSMemoriesFile(avatar, fileName, chatState.memories);
                pruneMemories(chatState, settings);

                logDebug('log', `Regenerated and persisted ${memoriesAdded} memories for ${sceneLabel}`);
            }
        }
    } catch (err) {
        console.error(`[${extensionName}] Failed to regenerate snapshot`, err);
        logDebug('error', 'Regenerate failed', err?.message || err);
    }
}

export function handleSnapshotSelectionChange(container) {
    if (!container) return;
    const checkboxes = Array.from(container.querySelectorAll('.ss-snapshot-select'));
    if (!checkboxes.length) return;

    let firstChecked = -1;
    let lastChecked = -1;

    checkboxes.forEach((cb, index) => {
        // @ts-ignore
        if (cb.checked) {
            if (firstChecked === -1) firstChecked = index;
            lastChecked = index;
        }
    });

    if (firstChecked !== -1 && lastChecked !== -1 && lastChecked > firstChecked) {
        // Enforce consecutive selection
        for (let i = firstChecked; i <= lastChecked; i++) {
            // @ts-ignore
            checkboxes[i].checked = true;
        }
    }

    const consolidateButton = container.querySelector('#ss_consolidate_button');
    if (consolidateButton) {
        // @ts-ignore
        const checkedCount = checkboxes.filter(cb => cb.checked).length;
        // @ts-ignore
        consolidateButton.style.display = checkedCount >= 2 ? '' : 'none';
    }
}
