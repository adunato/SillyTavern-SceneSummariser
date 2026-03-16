# Memory Blocks & Character Tabs — Implementation Plan

**Goal:** Enhance the memory extraction feature to group memories into "Memory Blocks" with descriptive headers tied to characters. Update the UI to display these blocks, allow editing of headers, and provide character-specific tabs for managing memories.

**Architecture:** Extend the existing memory extraction flow. The parser will extract full block structures (header + bullets) instead of flat lists. The popup editor will group inputs by block. The settings UI will dynamically generate character tabs and display blocks accordingly.

---

### Task 1: Enhance Parser for Memory Blocks
**Files:** `index.js`

- Modify `parseExtractionResponse(raw)` to return an array of `blocks` instead of flat `bullets`.
- For each `<memory>` match, parse the first bullet (the header, e.g., `* [CharA, CharB — description]`) and separate it from the subsequent fact bullets.
- Return structure: `{ summaryText: string, blocks: Array<{ header: string, characters: string[], bullets: string[] }> }`.
- Extract characters by parsing the text inside the brackets `[]` before the `—` or `-` separator.

### Task 2: Update Combined Review Dialogue (Popup)
**Files:** `public/popup.html` (or inline template in `index.js`), `index.js`

- **HTML Template:** Update `showCombinedEditor` to render a container for blocks.
- **Logic:**
  - Loop through parsed blocks. For each block, render an editable input for the header and a list of textareas for the bullets.
  - Add buttons to: Add a new block, delete an entire block, add a bullet to a block, delete a bullet.
- **Return Value:** On save, return `{ summary: finalSummary, blocks: finalBlocks }`.

### Task 3: Update Persistence & State Mapping
**Files:** `index.js`

- **`onSummariseClick` / `onBatchSummariseClick`:**
  - Receive the `blocks` array.
  - Format the markdown string to write to the Data Bank so it matches CharMemory format but retains the header as the first bullet.
  - Push individual memories to `chatState.memories`, but now include `blockHeader` and `characters` properties.
- **`writeSSMemoriesFile`:** Ensure it reconstructs the markdown file properly, grouping by `chatLabel` and ensuring `blockHeader` is preserved.

### Task 4: Memory Management UI & Character Tabs
**Files:** `settings.html` (or inline template), `index.js`

- **HTML Template:** Add a container for tabs in the memory management panel.
- **`renderMemoriesList` Logic:**
  - Iterate over `chatState.memories` to collect all unique characters.
  - Create a tab button for each character (plus an "All/Unassigned" tab).
  - For the active tab, render memories grouped by `blockHeader`.
  - Display the `blockHeader` as an editable input.
  - Provide a "Delete Block" button next to the header.
  - Render individual memory textareas under the header.
- **Event Delegation:**
  - Handle tab switching.
  - Handle block header edits (auto-save and rewrite Data Bank).
  - Handle full block deletions (remove all memories with that header, rewrite Data Bank).

### Task 5: Testing
- Run a manual extraction to verify the popup groups memories into blocks.
- Edit headers and bullets in the popup and save.
- Verify the Data Bank file contains the correct markdown structure.
- Open the Settings -> Memory panel.
- Verify Character Tabs appear and correctly filter memories.
- Test editing a block header from the settings panel and confirm the Data Bank file updates.
- Test deleting an entire block.