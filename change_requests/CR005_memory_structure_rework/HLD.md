# CR005: Memory Structure Rework

## Status
Draft

## Goals
- Rework the memory data structure: tie extracted memories directly to the Scene Snapshot they originate from, removing the concept of standalone "Memory Blocks".
- Simplify the LLM prompt and output parsing to generate a single flat list of facts per scene.
- Streamline the UI: remove the dedicated "Memories" tab and place memory management directly inside the revised Scene Snapshot accordion.
- Simplify the Review Scene Extraction popup to handle a flat list of facts.
- Add a "Reset Prompt" button to all prompt configuration fields to easily restore default values.

## Proposed Solution & Implementation Plan

### 1. Data Structure & Storage Updates
- **State**: Remove `chatState.memories` array. Introduce a `memories: string[]` array directly on each `snapshot` object in `chatState.snapshots`.
- **Data Bank Persistence**: Update `memoryFileHandler.js` to iterate over snapshots and their embedded memories when writing to the `.jsonl` Data Bank file, rather than relying on a separate `chatState.memories` array. 

### 2. Prompt & Parsing Adjustments (`src/core/engine.js`, `src/constants.js`)
- **Default Extraction Prompt**: Update the `memoryPrompt` template. Remove instructions requiring topic tags (`[Char, Char - topic]`) and multiple `<memory>` blocks. Instruct the LLM to output exactly one `<memory>` block containing a flat bulleted list of significant facts.
- **Parsing Logic**: Update `parseExtractionResponse` to extract a single array of bullet points instead of an array of objects representing blocks.

### 3. Settings UI Overhaul (`settings.html`, `src/ui/settingsUI.js`)
- **Remove Memories Tab**: Delete the `<button data-tab="memory">` and the `<div id="memory">` content area.
- **Reset Prompt Buttons**: Add small reset buttons (e.g., a counter-clockwise arrow icon) next to the labels for "Summary Prompt", "Consolidation Prompt", and "Extraction Prompt". 
- **JS Logic**: Remove `memoryUI.js` references. Add event listeners for the new "Reset Prompt" buttons to overwrite the setting with the value from `defaultSettings` and re-render the UI.

### 4. Snapshot UI Updates (`src/ui/snapshotUI.js`)
- **Accordion Content**: Expand the HTML generated for each snapshot item. Below the summary textarea, add a list of input fields/textareas representing the facts extracted for that snapshot.
- **Interactions**: Allow adding new facts to a snapshot, editing existing facts, and deleting facts directly from the Snapshot accordion. Auto-save changes to the `snapshot.memories` array and debounce a save to the Data Bank.

### 5. Extraction Review Popup (`popup.html`, `src/ui/editorUI.js`)
- **HTML Cleanup**: Remove the "Add Block" button.
- **JS Logic**: Update `showCombinedEditor` to render a single list of memory input fields. Return a flat array of memory strings to the caller (`onSummariseClick` / `onBatchSummariseClick`). 
- **Integration**: `onSummariseClick` will store this flat array directly onto the newly created `snapshot` object.
