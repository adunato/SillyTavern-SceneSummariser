import { extensionName } from '../constants.js';
import { renderExtensionTemplateAsync } from '../../../../../extensions.js';
import { POPUP_TYPE, Popup } from '../../../../../popup.js';

export async function showSummaryEditor(initialText, initialTitle = '', initialDescription = '') {
    const result = await showCombinedEditor(initialText, [], initialTitle, initialDescription);
    return result ? { summary: result.summary, title: result.title, description: result.description } : null;
}

/**
 * Shows the combined editor popup for reviewing and editing the generated summary and memory facts.
 * @param {string} initialSummary AI-generated summary.
 * @param {string[]} initialMemories AI-extracted memory facts.
 * @returns {Promise<{ summary: string, memories: string[], title: string, description: string }|null>} Final edited data, or null if cancelled.
 */
export async function showCombinedEditor(initialSummary, initialMemories, initialTitle = '', initialDescription = '') {
    // @ts-ignore
    const template = $(await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'popup'));
    const summaryArea = template.find('#ssPopupTextarea');
    const titleInput = template.find('#ssPopupTitle');
    const descArea = template.find('#ssPopupDescription');
    const memoriesList = template.find('#ssPopupMemoriesList');
    const addBtn = template.find('#ssPopupAddFact');

    summaryArea.val(initialSummary);
    titleInput.val(initialTitle);
    descArea.val(initialDescription);

    const refreshEmptyHint = () => {
        memoriesList.find('.ss-empty-hint').remove();
        if (memoriesList.children('.ss-memory-edit-item').length === 0) {
            memoriesList.append('<div class="ss-empty-hint" style="text-align:center; padding:10px; opacity:0.6;">No facts extracted.</div>');
        }
    };

    const renderBulletItem = (text = '') => {
        // @ts-ignore
        const item = $(`
            <div class="ss-memory-edit-item" style="margin-bottom: 5px;">
                <textarea class="text_pole" placeholder="Enter a fact..." rows="1">${text}</textarea>
                <button class="icon-btn trash ss-delete-bullet" title="Remove fact"><i class="fas fa-trash"></i></button>
            </div>
        `);
        item.find('.ss-delete-bullet').on('click', () => {
            item.remove();
            refreshEmptyHint();
        });
        return item;
    };

    if (Array.isArray(initialMemories) && initialMemories.length) {
        initialMemories.forEach(b => memoriesList.append(renderBulletItem(b)));
    } else {
        refreshEmptyHint();
    }

    addBtn.on('click', () => {
        memoriesList.find('.ss-empty-hint').remove();
        const newItem = renderBulletItem();
        memoriesList.append(newItem);
        newItem.find('textarea').focus();
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
    const finalTitle = String(titleInput.val()).trim();
    const finalDescription = String(descArea.val()).trim();
    const finalMemories = [];

    memoriesList.find('textarea').each(function () {
        // @ts-ignore
        const val = String($(this).val()).trim();
        if (val) finalMemories.push(val);
    });

    return { summary: finalSummary, memories: finalMemories, title: finalTitle, description: finalDescription };
}
