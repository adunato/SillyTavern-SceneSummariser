# Implementation Plan: Standalone Vector Storage

## Phase 1: Core API Wrappers
1. Create `src/storage/vectorHandler.js`.
2. Implement async wrapper functions for SillyTavern's backend vector endpoints:
   - `queryVectorCollection(collectionId, searchText, topK, threshold)`
   - `insertVectorItems(collectionId, items)`
   - `deleteVectorItems(collectionId, hashes)`
   - `purgeVectorCollection(collectionId)`
3. Implement utility functions for generating unique `collectionId` strings based on the current chat or group.

## Phase 2: Refactor Memory Storage (Ingestion)
1. Modify `src/storage/memoryFileHandler.js` (or replace its logic).
2. Update the `persistMemoriesForChat` workflow:
   - Stop generating and uploading `ss-memories-[chat].md` Data Bank files.
   - Instead, map the extracted memories to text objects and send them to `insertVectorItems`.
3. Add logic to hash individual memories so we can target them for deletion if a user manually deletes a fact from a snapshot via the UI.
4. Implement a one-time migration function that runs on load: detects existing `ss-memories` Data Bank files, ingests their contents into the new vector collections, and deletes the Data Bank files to immediately stop core extension duplication.

## Phase 3: Semantic Retrieval & Prompt Injection
1. Update `src/core/injector.js`.
2. Register an async hook prior to prompt generation (e.g., intercepting the chat or using an event emitter hook).
3. Build the query string by fetching the last `N` messages of the active chat.
4. Call `queryVectorCollection`.
5. **Deduplication Logic:** Compare the returned memory strings against the memories already attached to the recent snapshots (which are handled by the standard `buildSummaryText` scene blocks). Discard duplicates.
6. Format the remaining memories into a designated block (e.g., `<recalled_memories>...`) and inject it using `setExtensionPrompt` with a specific position/depth configured in settings.

## Phase 4: UI and Settings
1. Update `src/constants.js` with new default settings for vector retrieval (enabled, topK, threshold, query depth, injection format).
2. Update `settings.html` to add the configuration sliders and toggles.
3. Add a "Purge Vector Index" button to the Snapshots tab or Settings tab to allow users to manually clear the semantic database for the active chat.
4. Update `src/ui/settingsUI.js` to bind these new settings.

## Phase 5: Testing and Refinement
1. Verify memories are successfully stored in the backend (no Data Bank files created).
2. Verify that querying returns relevant older memories.
3. Verify that the deduplication successfully prevents a memory from appearing in both the "Recent Scene Block" and the "Recalled Memories" block simultaneously.
4. Verify the UI updates correctly reflect the state.