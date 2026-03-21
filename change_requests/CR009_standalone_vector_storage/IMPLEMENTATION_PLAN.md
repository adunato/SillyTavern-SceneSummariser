# Implementation Plan: Standalone Vector Storage
## Prerequisites:
- Existing `SillyTavern` backend must be running to handle `/api/vector/*` requests.
- Ensure the `CR008` changes (appending memories to scene blocks) are integrated, as they form the baseline for deduplication.

## Step-by-Step Tasks:
1. **Create `src/storage/vectorHandler.js`**
   - Implement `queryVectorCollection`, `insertVectorItems`, `deleteVectorItems`, `purgeVectorCollection`.
   - Implement `getChatCollectionId()` to isolate data per chat.
2. **Update `src/storage/memoryFileHandler.js`**
   - Replace Data Bank file generation with calls to `insertVectorItems`.
   - Create a migration function that reads existing `ss-memories` files, calls `insertVectorItems`, and then deletes the files.
3. **Update `src/core/injector.js`**
   - Add a hook (e.g., `onGenerateBeforeCombinePrompts`) to perform the semantic search right before prompt construction.
   - Build the query from the last `N` messages in the active chat.
   - Fetch the top `K` facts using `queryVectorCollection`.
   - Implement deduplication against the active `chatState.snapshots`.
   - Create a formatted `<recalled_memories>` string and inject it using `setExtensionPrompt` with a new dedicated tag (e.g., `ss_vector_memories`).
4. **Update UI and Settings**
   - Add default settings to `src/constants.js` (enable semantic retrieval, top K, threshold, query depth).
   - Add sliders and toggles to `settings.html`.
   - Bind inputs in `src/ui/settingsUI.js`.
   - Add a "Purge Vector Index" button to allow users to reset the semantic memory for the active chat.

## Files Affected:
- `src/constants.js` (Add new default settings)
- `src/storage/vectorHandler.js` (New file)
- `src/storage/memoryFileHandler.js` (Refactor to use vectorHandler instead of file writing)
- `src/core/injector.js` (Add semantic retrieval and deduplication hook)
- `index.js` (Register new event hooks)
- `settings.html` (Add UI controls)
- `src/ui/settingsUI.js` (Bind new UI controls)

## Verification:
- Manually run summarization and memory extraction. Verify NO `ss-memories` file is created in the Data Bank.
- Open Vector Storage UI and verify it is not finding duplicate Data Bank files.
- Enable Debug Mode, generate a message, and verify `vectorHandler.js` is logging the semantic query and returned facts.
- Inspect the final prompt to ensure `<recalled_memories>` are injected correctly without duplicating facts found in the recent scene blocks.

## Rollback:
- Revert the commit in the `SillyTavern-SceneSummariser` repository to restore `memoryFileHandler.js` back to its Markdown generation state and remove the vector retrieval hooks.
