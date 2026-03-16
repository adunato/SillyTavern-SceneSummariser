import { extensionName } from '../constants.js';
import { renderExtensionTemplateAsync } from '../../../../../extensions.js';
import { POPUP_TYPE, Popup } from '../../../../../popup.js';

export async function showSummaryEditor(initialText) {
    const result = await showCombinedEditor(initialText, []);
    return result ? result.summary : null;
}

/**
 * Shows the combined editor popup for reviewing and editing the generated summary and memory blocks.
 * @param {string} initialSummary AI-generated summary.
 * @param {Array<{ header: string, characters: string[], bullets: string[] }>} initialBlocks AI-extracted memory blocks.
 * @returns {Promise<{ summary: string, blocks: Array<{ header: string, characters: string[], bullets: string[] }> }|null>} Final edited data, or null if cancelled.
 */
export async function showCombinedEditor(initialSummary, initialBlocks) {
    // @ts-ignore
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
        // @ts-ignore
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
            // @ts-ignore
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
        // @ts-ignore
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
            // @ts-ignore
            const val = $(this).val().trim();
            if (val) bullets.push(val);
        });

        if (bullets.length > 0) {
            finalBlocks.push({ header, characters, bullets });
        }
    });

    return { summary: finalSummary, blocks: finalBlocks };
}
