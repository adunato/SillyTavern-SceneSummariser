# Memory Extraction — Implementation Plan

**Goal:** Add memory extraction to `SillyTavern-SceneSummariser` so that discrete facts are co-extracted with scene summaries, persisted as a markdown file in the chat's ST Data Bank, and automatically retrieved by Vector Storage on each generation.

**Architecture:** Extend the existing `onSummariseClick` / batch summarise flow to use a combined extraction prompt when `memoryExtractionEnabled = true`. Parse `<summary>` and `<memories>` blocks from the LLM response. Append new memories to `chatState.memories[]` and to a Data Bank markdown file stored via `uploadFileAttachment`. Vector Storage handles retrieval automatically — no custom retrieval code required.

**Storage:** Same mechanism as CharMemory — `extension_settings.character_attachments[avatar]` + `uploadFileAttachment` / `getFileAttachment` / `deleteFileFromServer` from `scripts/chats.js`.

**LLM:** Reuses `callSummarisationLLM` with no changes — same Connection Profile, same fallback as all other summarisation operations.

**Scope:** SPEC §2 (Memory Extraction) only. Sections §3 (Active Context Assembly) and §4 (Context Panel UI) are out of scope.

---

### Task 1: Imports and settings defaults

**Files:** `index.js`

**Step 1: Add Data Bank imports**

At the top of `index.js`, alongside the existing imports from `script.js`, add:

```js
import {
    uploadFileAttachment,
    getFileAttachment,
    deleteFileFromServer,
} from '../../../../scripts/chats.js';
import { getStringHash, convertTextToBase64 } from '../../../utils.js';
```

**Step 2: Add new settings to `defaultSettings`**

```js
// In defaultSettings object, add:
memoryExtractionEnabled: true,
memoryPrompt: `Summarize the following scene in {{words}} words or less.\n\n===MESSAGES===\n{{last_messages}}\n===END===\n\nThen extract memorable facts as a bullet list. Each bullet is one specific, atomic fact. Write in past tense. Use character names, not pronouns.\n\nOutput format:\n\n<summary>\n[scene summary here]\n</summary>\n\n<memories>\n- [CharName, OtherName — short topic label]\n- [fact 1]\n- [fact 2]\n</memories>\n\nIf there are no facts worth remembering, omit the <memories> block entirely.`,
maxMemories: 0,
```

**Step 3: Add new fields to `chatStateDefaults`**

```js
// In chatStateDefaults object, add:
memories: [],
memoryCounter: 0,
```

**Step 4: Commit**

```bash
git add index.js
git commit -m "feat(memory): add imports, defaults and chatState fields for memory extraction"
```

---

### Task 2: Data Bank file helpers

**Files:** `index.js`

**Step 1: Add `getMemoryFileName(chatId)`**

Returns the Data Bank filename for a given chat, following the same safe-name pattern as CharMemory:

```js
function getSSMemoryFileName(chatId) {
    const safeChatId = String(chatId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `ss-memories-${safeChatId}.md`;
}
```

**Step 2: Add `findSSMemoryAttachment(fileName)`**

Looks up the attachment record for the file in `extension_settings.character_attachments` for the current character:

```js
function findSSMemoryAttachment(avatar, fileName) {
    if (!extension_settings.character_attachments) return null;
    const attachments = extension_settings.character_attachments[avatar];
    if (!Array.isArray(attachments)) return null;
    return attachments.find(a => a.name === fileName) || null;
}
```

**Step 3: Add `readSSMemoriesFile(avatar, fileName)`**

```js
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
```

**Step 4: Add `appendSSMemoriesBlock(avatar, fileName, newBlockMarkdown)`**

Reads existing file content, appends the new `<memory>` block, and rewrites via `uploadFileAttachment`. Mirrors CharMemory's `writeMemoriesForCharacter`:

```js
async function appendSSMemoriesBlock(avatar, fileName, newBlockMarkdown) {
    // Ensure character_attachments map exists
    if (!extension_settings.character_attachments) extension_settings.character_attachments = {};
    if (!Array.isArray(extension_settings.character_attachments[avatar])) {
        extension_settings.character_attachments[avatar] = [];
    }

    // Read existing content
    const existing = await readSSMemoriesFile(avatar, fileName);

    // Append new block
    const newContent = existing
        ? `${existing.trimEnd()}\n\n${newBlockMarkdown}`
        : newBlockMarkdown;

    // Delete old file if present
    const oldAttachment = findSSMemoryAttachment(avatar, fileName);
    if (oldAttachment) {
        await deleteFileFromServer(oldAttachment.url, true);
        extension_settings.character_attachments[avatar] =
            extension_settings.character_attachments[avatar].filter(a => a.url !== oldAttachment.url);
    }

    // Upload new file
    const base64Data = convertTextToBase64(newContent);
    const slug = getStringHash(fileName);
    const uniqueFileName = `${Date.now()}_${slug}.txt`;
    const fileUrl = await uploadFileAttachment(uniqueFileName, base64Data);
    if (!fileUrl) {
        logDebug('error', 'uploadFileAttachment returned no URL');
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
```

**Step 5: Commit**

```bash
git add index.js
git commit -m "feat(memory): add Data Bank file helpers for memory read/write"
```

---

### Task 3: Response parser

**Files:** `index.js`

Add `parseExtractionResponse(raw)` — a pure function, no side effects:

```js
/**
 * Parse a combined extraction LLM response into summary text and memory bullets.
 * Falls back to summary-only (empty bullets array) if the <memories> block is absent or malformed.
 * @param {string} raw Raw LLM response text.
 * @returns {{ summaryText: string, bullets: string[] }}
 */
function parseExtractionResponse(raw) {
    const text = (raw || '').trim();

    const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i);
    const memoriesMatch = text.match(/<memories>([\s\S]*?)<\/memories>/i);

    const summaryText = summaryMatch
        ? summaryMatch[1].trim()
        : text; // fallback: treat whole response as summary

    const bullets = [];
    if (memoriesMatch) {
        const lines = memoriesMatch[1].split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('- ')) {
                bullets.push(trimmed.slice(2).trim());
            }
        }
    }

    return { summaryText, bullets };
}
```

**Commit:**

```bash
git add index.js
git commit -m "feat(memory): add parseExtractionResponse() for combined LLM output"
```

---

### Task 4: Prompt builder

**Files:** `index.js`

Add `buildExtractionPrompt(transcript, settings, previousSummaryText)`:

```js
/**
 * Build the LLM prompt for the current summarisation pass.
 * When memoryExtractionEnabled is true, uses memoryPrompt (combined template).
 * When false, falls back to summaryPrompt (existing behaviour).
 */
function buildExtractionPrompt(transcript, settings, previousSummaryText) {
    const words = settings.summaryWords || defaultSettings.summaryWords;
    const enabled = settings.memoryExtractionEnabled ?? defaultSettings.memoryExtractionEnabled;

    const template = enabled
        ? (settings.memoryPrompt || defaultSettings.memoryPrompt)
        : (settings.summaryPrompt || defaultSettings.summaryPrompt);

    return template
        .replace(/\{\{words\}\}/g, words)
        .replace(/\{\{summary\}\}/g, previousSummaryText || '')
        .replace(/\{\{last_messages\}\}/g, transcript || '(no messages)');
}
```

**Commit:**

```bash
git add index.js
git commit -m "feat(memory): add buildExtractionPrompt() supporting combined and legacy templates"
```

---

### Task 5: Extend `onSummariseClick`

**Files:** `index.js`

Modify `onSummariseClick` to use `buildExtractionPrompt`, call `parseExtractionResponse`, create `Memory` objects, and append to the Data Bank file.

Find the prompt construction and LLM call block inside `onSummariseClick`. Replace:

```js
const prompt = promptTemplate
    .replace('{{words}}', words)
    .replace('{{summary}}', previousSummaryText || '')
    .replace('{{last_messages}}', transcript || '(no messages)');

// (existing)
const result = await callSummarisationLLM(prompt, currentAbortController.signal);
let cleaned = (result || '').trim();
// ... existing cleanup and showSummaryEditor call ...
```

With:

```js
const prompt = buildExtractionPrompt(transcript, settings, previousSummaryText);

const rawResult = await callSummarisationLLM(prompt, currentAbortController.signal);
const { summaryText, bullets } = parseExtractionResponse(rawResult || '');
let cleaned = summaryText;
if (cleaned.startsWith(prompt.trim())) {
    cleaned = cleaned.substring(prompt.trim().length).trim();
}

const editedText = await showSummaryEditor(cleaned);
if (editedText === null) {
    logDebug('log', 'User cancelled summarisation');
    return;
}

// (existing snapshot creation — unchanged)
const newSnapshotId = ++chatState.summaryCounter;
// ...

// --- NEW: save memory entries ---
const enabled = settings.memoryExtractionEnabled ?? defaultSettings.memoryExtractionEnabled;
if (enabled && bullets.length > 0) {
    const ctx = getContext();
    const avatar = ctx?.characters?.[ctx?.characterId]?.avatar
        || (typeof characters !== 'undefined' && typeof this_chid !== 'undefined'
            ? characters[this_chid]?.avatar : undefined);

    if (avatar) {
        const chatId = getActiveChatId();
        const fileName = getSSMemoryFileName(chatId);

        // Build <memory> tag block
        const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        const sceneLabel = `Scene #${newSnapshotId}`;
        const bulletsText = bullets.map(b => `- ${b}`).join('\n');
        const newBlock = `<memory chat="${sceneLabel}" date="${timestamp}">\n${bulletsText}\n</memory>`;

        // Append to Data Bank
        await appendSSMemoriesBlock(avatar, fileName, newBlock);

        // Update in-memory index
        const newMemories = bullets.map((text, i) => ({
            id: ++chatState.memoryCounter,
            text,
            extractedAt: toIndex - 1,
            createdAt: Date.now(),
            source: 'extracted',
        }));
        chatState.memories.push(...newMemories);

        // Prune if maxMemories set
        pruneMemories(chatState, settings);

        logDebug('log', `Extracted ${bullets.length} memories for ${sceneLabel}`);
    } else {
        logDebug('warn', 'No character avatar found — skipping memory file write');
    }
}
```

**Step 2: Add `pruneMemories(chatState, settings)`**

```js
function pruneMemories(chatState, settings) {
    const max = settings.maxMemories ?? defaultSettings.maxMemories;
    if (max <= 0) return;
    while (chatState.memories.length > max) {
        chatState.memories.shift(); // remove oldest first
    }
}
```

**Commit:**

```bash
git add index.js
git commit -m "feat(memory): extend onSummariseClick to extract and persist memory entries"
```

---

### Task 6: Extend batch summarise

**Files:** `index.js`

`onBatchSummariseClick` processes windows via a loop that calls the existing prompt builder. Apply the same changes:

1. Replace the prompt construction inside the batch loop with `buildExtractionPrompt`.
2. Parse the result with `parseExtractionResponse`.
3. Use the `summaryText` portion for the snapshot.
4. Append memory bullets to the Data Bank file (batch windows accumulate all memories into the same file; each window gets one `<memory>` block).
5. Call `pruneMemories` after each batch window.

The batch loop never shows a popup, so only the parse/save steps change — no summary editor shown for the memory portion.

**Commit:**

```bash
git add index.js
git commit -m "feat(memory): extend batch summarise to co-extract and persist memories"
```

---

### Task 7: Settings UI

**Files:** `settings.html`, `index.js`

**Step 1: Add memory panel to `settings.html`**

Inside the existing settings HTML, add a collapsible section (following the existing pattern):

```html
<div class="ss-panel-toggle" data-ss-action="toggle-memory">
    Memory Extraction
    <i class="fa-solid fa-chevron-down"></i>
</div>
<div id="ss_memory_panel">
    <div class="setting_item">
        <label class="checkbox_label">
            <input type="checkbox" class="ss-setting-input" name="memoryExtractionEnabled" id="ss_memoryExtractionEnabled" />
            <span>Enable memory extraction</span>
        </label>
        <div class="ss-setting-hint">Co-extract atomic facts alongside scene summaries — stored in the Data Bank for Vector Storage retrieval.</div>
    </div>

    <div class="setting_item">
        <label for="ss_memoryPrompt">Extraction prompt</label>
        <textarea class="text_pole ss-setting-input" name="memoryPrompt" id="ss_memoryPrompt" rows="10"></textarea>
    </div>

    <div class="setting_item">
        <label for="ss_maxMemories">Max memories in index (0 = unlimited)</label>
        <input type="number" class="text_pole ss-setting-input" name="maxMemories" id="ss_maxMemories" min="0" step="1" />
    </div>
</div>
```

**Step 2: Wire in `bindSettingsUI` and `updateSettingsUI`**

In `bindSettingsUI`: add `'toggle-memory'` to the panel action handler (same pattern as existing `toggle-settings` / `toggle-summary`).

In `updateSettingsUI`: add:

```js
setValue('#ss_memoryExtractionEnabled', settings.memoryExtractionEnabled ?? defaultSettings.memoryExtractionEnabled);
setValue('#ss_memoryPrompt', settings.memoryPrompt ?? defaultSettings.memoryPrompt);
setValue('#ss_maxMemories', settings.maxMemories ?? defaultSettings.maxMemories);
```

**Commit:**

```bash
git add index.js settings.html
git commit -m "feat(memory): add memory extraction settings panel to settings.html"
```

---

### Task 8: Manual testing

**Step 1: Basic extraction flow**

1. Start SillyTavern, open a chat with at least 10 messages.
2. Enable the extension; ensure `memoryExtractionEnabled` is checked.
3. Click the Summarise (clapperboard) button.
4. Verify the summary editor popup shows the scene summary text.
5. Save the summary.
6. Open **Extensions → Vector Storage → Data Bank** and confirm a file named `ss-memories-<chatId>.md` appears.
7. Download/inspect the file — it should contain one `<memory>` block with bullet points.

**Step 2: Memory extraction disabled**

1. Uncheck `memoryExtractionEnabled`.
2. Add several new messages and click Summarise.
3. Confirm no new `<memory>` block is appended to the Data Bank file.
4. Confirm the LLM prompt (visible in debug mode) uses `summaryPrompt`, not `memoryPrompt`.

**Step 3: Multiple extractions accumulate**

1. Re-enable `memoryExtractionEnabled`.
2. Summarise two or three more scenes.
3. Inspect the Data Bank file — confirm each run appended a new `<memory>` block.

**Step 4: Vector retrieval**

1. Ensure "Enable for files" is checked in Vector Storage settings.
2. Send a chat message that relates to a fact in the extracted memories (e.g. mention a character name or event).
3. Open the browser Network tab or ST debug view and inspect the prompt payload — confirm the relevant bullet appears in the `4_vectors_data_bank` prompt slot.

**Step 5: maxMemories pruning**

1. Set `maxMemories` to 3.
2. Run enough extractions to create more than 3 memories (check `chatState.memories.length` via the debug console).
3. Confirm the index is capped at 3 entries (oldest removed first).

**Step 6: Batch summarise**

1. Start a fresh chat with 100+ messages.
2. Click "Batch Summarise".
3. Inspect the Data Bank file — confirm one `<memory>` block per batch window.

**Step 7: Parse fallback**

1. In debug mode, temporarily modify the combined prompt to instruct the LLM to omit `<summary>` tags.
2. Run Summarise.
3. Confirm no crash occurs and the entire LLM response is treated as the summary text.

**Step 8: Fix issues found and commit**

```bash
git add index.js settings.html
git commit -m "fix(memory): polish and edge case fixes from manual testing"
```

---

### Task 9: Version bump and changelog

**Files:** `manifest.json`

Bump version (e.g. current → next minor). Add changelog entry noting the new memory extraction feature, the settings keys, and the Vector Storage dependency.

```bash
git add manifest.json
git commit -m "chore: bump version for memory extraction feature"
```
