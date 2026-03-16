import { state } from '../constants.js';

export function renderMemoriesList(container, chatState) {
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
        btn.className = `menu_button interactable ${state.currentMemoryTab === name ? 'fa-solid fa-check' : ''}`;
        btn.textContent = name;
        btn.style.padding = '4px 8px';
        btn.style.fontSize = '0.9em';
        if (state.currentMemoryTab === name) {
            btn.style.background = 'var(--smart-theme-focus)';
            btn.style.color = 'var(--smart-theme-focus-text)';
        }
        btn.addEventListener('click', () => {
            state.currentMemoryTab = name;
            renderMemoriesList(container, chatState);
        });
        tabsContainer.appendChild(btn);
    };

    renderTabButton('All');
    uniqueChars.forEach(c => renderTabButton(c));

    // Filter memories by tab
    let filteredMemories = memories;
    if (state.currentMemoryTab !== 'All') {
        filteredMemories = memories.filter(m => m.characters && m.characters.includes(state.currentMemoryTab));
    }

    if (filteredMemories.length === 0) {
        list.innerHTML = `<div style="text-align:center; opacity:0.6; padding:10px;">No memories for ${state.currentMemoryTab}</div>`;
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

        // @ts-ignore
        blockMemories.forEach(m => {
            const item = document.createElement('div');
            item.className = 'ss-memory-edit-item';
            item.style.marginBottom = '3px';
            item.innerHTML = `
                <textarea class="text_pole ss-memory-text" data-id="${m.id}" rows="2">${m.text || ''}</textarea>
                <i class="menu_button fa-solid fa-trash-can ss-delete-icon ss-action-icon" title="Delete Memory" data-memory-action="delete" data-memory-id="${m.id}"></i>
            `;
            // @ts-ignore
            itemsContainer.appendChild(item);
        });
        
        list.appendChild(blockEl);
    }
}
