# Implementation Plan: Standalone Vector Storage & Memory Injection
## Prerequisites:
- Existing `SillyTavern` backend must be running to handle `/api/vector/*` requests.

## Step-by-Step Tasks:
0. **Bug Fix: onBatchSummariseClick**
   - Fix `ReferenceError: ctx is not defined` in `src/ui/buttons.js`.
0.1 **Feature: Batch Summarisation Preview**
   - Add `previewBatchSummaries` setting.
   - Update `onBatchSummariseClick` to show `showCombinedEditor` for each batch if enabled.
1. **Create `src/storage/vectorHandler.js`**
   - Implement `queryVectorCollection`, `insertVectorItems`, `deleteVectorItems`, `purgeVectorCollection`.
   - Implement `getChatCollectionId()` to isolate data per chat.
2. **Update `src/storage/memoryFileHandler.js`**
   - Replace Data Bank file generation with calls to `insertVectorItems` into the dedicated collection.
   - Attach metadata to the vectors (e.g., `snapshotId`, `memoryIndex`) to map them back to the source.
   - Create a migration function that reads existing `ss-memories` Data Bank files, ingests their contents into the vector collection, and then deletes the files.
3. **Refactor Memory Injection (`src/core/engine.js` & `injector.js`)**
   - Hook into `GENERATE_BEFORE_COMBINE_PROMPTS` or `generate_interceptor` to run the semantic query async before prompt construction.
   - Build the query string using the last `semanticSearchDepth` messages.
   - Fetch top `semanticTopK` facts with score >= `semanticThreshold`.
   - Update `buildSummaryText` logic:
     - For scenes within `fullMemoriesToInject`: Append all `s.memories` to the scene block.
     - For older scenes within `summariesToInject`: Append only the specific facts returned by the vector query that match this scene's `snapshotId`.
     - Group any remaining vector results (from scenes completely outside `summariesToInject`) into a single `<recalled_memories>` block.
   - Update `applyInjection` to handle appending the `<recalled_memories>` block to the final injected string.
4. **Update UI and Settings (`src/constants.js`, `settings.html`, `settingsUI.js`)**
   - Create a new "Memory Injection Control" UI section.
   - Move `fullMemoriesToInject` slider here.
   - Add toggle: `Enable Semantic Search`.
   - Add sliders: `Search Query Scope (Messages)`, `Max Retrieved Memories (Top K)`, `Similarity Threshold`.
   - Add button: `Purge Vector Index`.
   - Bind all new settings in `settingsUI.js`.

## Files Affected:
- `src/constants.js` (Add new default settings)
- `src/storage/vectorHandler.js` (New file)
- `src/storage/memoryFileHandler.js` (Refactor to use vector APIs instead of file writing)
- `src/core/engine.js` (Update `buildSummaryText` to handle the dynamic merging of semantic and full memories)
- `src/core/injector.js` (Add async semantic retrieval hook)
- `index.js` (Register new event hooks)
- `settings.html` (Add "Memory Injection Control" section and inputs)
- `src/ui/settingsUI.js` (Bind new UI controls)

## Verification:
- Manually run summarization and memory extraction. Verify NO `ss-memories` file is created in the Data Bank.
- Open Vector Storage UI and verify it is not finding duplicate Data Bank files.
- Enable Debug Mode, generate a message, and verify `vectorHandler.js` is logging the semantic query and returned facts.
- Inspect the prompt to ensure:
  - Recent scene blocks show all facts.
  - Older scene blocks show only semantically retrieved facts.
  - Very old retrieved facts appear in `<recalled_memories>`.

## Rollback:
- Revert the branch `change/CR009-standalone-vector-storage`.