import { extension_settings, getContext } from '../../../../../extensions.js';
import { reloadCurrentChat } from '../../../../../../script.js';
import { settingsKey, defaultSettings, extensionName } from '../constants.js';
import { logDebug } from '../utils/logger.js';
import { persistMemoriesForChat } from '../storage/memoryFileHandler.js';
import { getActiveChatId } from '../state/stateManager.js';
import { buildExtractionPrompt, parseExtractionResponse } from '../core/engine.js';
import { callSummarisationLLM } from '../core/llmApi.js';
import { showCombinedEditor } from './editorUI.js';

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

        let memoriesHtml = '';
        if (snap.memories && snap.memories.length > 0) {
            const uniqueChars = new Set();
            const parsedMemories = snap.memories.map(mem => {
                let chars = [];
                const match = mem.match(/^([^:]+):/);
                if (match) {
                    chars = match[1].split(',').map(c => c.trim()).filter(c => c);
                    chars.forEach(c => uniqueChars.add(c));
                }
                return { text: mem, chars };
            });

            memoriesHtml = '<div class="ss-snapshot-memories" style="margin-top: 10px;">';
            memoriesHtml += '<div class="section-title" style="margin-bottom: 5px; font-size: 0.85em; color: var(--text-muted);">Extracted Facts</div>';

            if (uniqueChars.size > 0) {
                memoriesHtml += `<div class="ss-snap-memory-tabs filter-row" style="margin-bottom: 10px; display: flex; gap: 5px; flex-wrap: wrap;">
                    <div class="badge active ss-snap-tab-btn" data-snap-id="${snap.id}" data-char="All" style="cursor: pointer;">All</div>
                    ${Array.from(uniqueChars).map(c => `<div class="badge ss-snap-tab-btn" data-snap-id="${snap.id}" data-char="${c.replace(/"/g, '&quot;')}" style="cursor: pointer;">${c}</div>`).join('')}
                </div>`;
            }

            memoriesHtml += `<div class="ss-snap-memories-container" data-snap-id="${snap.id}">`;
            parsedMemories.forEach((parsed, index) => {
                const charsAttr = parsed.chars.join('||');
                memoriesHtml += `
                    <div class="ss-memory-edit-item" data-chars="${charsAttr.replace(/"/g, '&quot;')}" style="margin-bottom: 5px;">
                        <textarea class="text_pole ss-snap-memory-text" data-snap-id="${snap.id}" data-index="${index}" rows="1" style="width:100%; font-size:0.9em; font-family:inherit;">${parsed.text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
                        <button class="icon-btn trash ss-delete-snap-memory" title="Remove fact" data-snap-id="${snap.id}" data-index="${index}"><i class="fas fa-trash"></i></button>
                    </div>
                `;
            });
            memoriesHtml += '</div></div>';
        }

        const item = document.createElement('div');
        item.className = 'ss-snapshot-item';
        item.dataset.id = String(snap.id);

        item.innerHTML = `
            <div class="inline-drawer wide100p">
                <div class="inline-drawer-header ss-snapshot-header">
                    <div class="inline-drawer-toggle inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    <div class="ss-snapshot-header-content">
                         <input type="checkbox" class="ss-snapshot-select ss-no-propagate" data-snap-id="${snap.id}" title="Select for consolidation" style="cursor: pointer;">
                         <div class="ss-snapshot-title text_pole textarea_compact" title="${title}">${title}</div>
                         <div class="ss-header-actions ss-no-propagate">
                               <i class="menu_button fa-solid fa-plus ss-action-icon" title="Add Fact" data-snap-action="add-fact" data-snap-id="${snap.id}"></i>
                               <i class="menu_button fa-solid fa-arrows-rotate ss-action-icon" title="Regenerate" data-snap-action="regen" data-snap-id="${snap.id}"></i>
                               <i class="menu_button fa-solid fa-copy ss-action-icon" title="Copy Text" data-snap-action="copy" data-snap-id="${snap.id}"></i>
                               <i class="menu_button fa-solid fa-trash-can ss-delete-icon ss-action-icon" title="Delete Snapshot" data-snap-action="delete" data-snap-id="${snap.id}"></i>
                         </div>
                    </div>
                </div>
                <div class="inline-drawer-content ss-snapshot-content">
                    <div class="setting_item" style="margin-bottom: 5px;">
                        <textarea class="text_pole ss-snap-desc" data-id="${snap.id}" rows="2" placeholder="Scene Description" style="width:100%; font-size:0.9em; font-family:inherit;">${snap.description || ''}</textarea>
                    </div>
                    <div class="setting_item">
                        <textarea class="text_pole ss-snap-text" data-id="${snap.id}" rows="6" style="width:100%; font-size:0.9em; font-family:inherit;">${snap.text || ''}</textarea>
                    </div>
                    ${memoriesHtml}
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

    const ctx = getContext();
    const avatar = ctx?.characters?.[ctx?.characterId]?.avatar
        // @ts-ignore
        || (typeof characters !== 'undefined' ? characters[ctx?.characterId]?.avatar : undefined)
        || ctx?.avatar;

    if (action === 'delete') {
        if (confirm(`Delete "${snap.title || 'this snapshot'}"?`)) {
            // 1. Remove snapshot from state
            chatState.snapshots.splice(snapIndex, 1);
            
            // 2. Re-calculate lastSummarisedIndex
            if (chatState.snapshots.length > 0) {
                const latest = chatState.snapshots[chatState.snapshots.length - 1];
                chatState.lastSummarisedIndex = latest.toIndex || 0;
            } else {
                chatState.lastSummarisedIndex = 0;
            }

            // 3. Clean up Data Bank
            await persistMemoriesForChat(chatState);

            // 4. Clean up chat marker if it exists
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
    } else if (action === 'add-fact') {
        if (!snap.memories) snap.memories = [];
        snap.memories.push(''); // Add an empty fact
        renderSnapshotsList(container, chatState, settings);
        
        // Ensure the accordion stays open
        const item = container.querySelector(`.ss-snapshot-item[data-id="${snapshotId}"]`);
        if (item) item.classList.add('expanded');
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

    const historyDepth = Number(settings.summaryContextDepth || defaultSettings.summaryContextDepth);
    if (historyDepth > 0 && previousSnapshots.length > historyDepth) {
        previousSnapshots = previousSnapshots.slice(-historyDepth);
    }

    const previousSummaryText = previousSnapshots.map(s => `${s.title}: ${s.text}`).join('\n');

    // Use combined extraction prompt to ensure memory extraction remains active during regeneration
    const prompt = buildExtractionPrompt(transcript, settings, previousSummaryText, chatState);

    try {
        const result = await callSummarisationLLM(prompt);
        const { summaryText, memories, title, description } = parseExtractionResponse(result || '');
        let cleaned = summaryText;
        if (cleaned.startsWith(prompt.trim())) {
            cleaned = cleaned.substring(prompt.trim().length).trim();
        }

        // Use the combined editor to allow reviewing both the regenerated summary and memories
        const editorResult = await showCombinedEditor(cleaned, memories, title, description);
        if (!editorResult) {
            logDebug('log', 'User cancelled regeneration editor');
            return;
        }

        const { summary: editedText, memories: approvedMemories, title: editedTitle, description: editedDescription } = editorResult;

        snapshot.text = editedText;
        if (editedTitle) {
            const baseTitleMatch = snapshot.title.match(/^(Scene #\d+)/);
            const baseTitle = baseTitleMatch ? baseTitleMatch[1] : `Scene #${snapshot.id}`;
            snapshot.title = `${baseTitle} - ${editedTitle}`;
        }
        if (editedDescription) {
            snapshot.description = editedDescription;
        }
        snapshot.memories = approvedMemories;
        snapshot.createdAt = Date.now();
        logDebug('log', `Regenerated snapshot ${snapshot.id}`);

        // Handle memory extraction for regenerated snapshot
        const memoryEnabled = settings.memoryExtractionEnabled ?? defaultSettings.memoryExtractionEnabled;
        if (memoryEnabled) {
            await persistMemoriesForChat(chatState);
            logDebug('log', `Regenerated and persisted memories for ${snapshot.title}`);
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