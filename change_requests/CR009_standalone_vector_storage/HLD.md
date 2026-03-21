# Title: Standalone Vector Storage
## Status: Draft
## Goals:
- Stop saving extracted memories as Markdown files in the SillyTavern Data Bank (`ss-memories-[chat].md`).
- Prevent the core Vector Storage extension from automatically injecting duplicate memories.
- Implement a lightweight, standalone vector management system within Scene Summariser.
- Store extracted memory facts directly into a private vector collection via SillyTavern's `/api/vector/insert` endpoint.
- Retrieve relevant older memories semantically via `/api/vector/query` during prompt generation.
- Deduplicate retrieved vector memories against the recent ones already injected by the scene blocks.
- Inject the standalone recalled memories directly into the chat context.

## Proposed Solution:
1. **New Storage Module**: Create `src/storage/vectorHandler.js` to wrap SillyTavern's backend vector APIs (`insert`, `query`, `delete`, `purge`).
2. **Refactor Ingestion**: Update `src/storage/memoryFileHandler.js` to map memories and send them to the vector collection instead of writing Data Bank files. Add a migration step to ingest existing files and delete them.
3. **Retrieval Hook**: Register an event listener for `GENERATE_BEFORE_COMBINE_PROMPTS` or use the `generate_interceptor` to trigger semantic search right before generation.
4. **Deduplication & Injection**: Retrieve `Top K` facts, filter out facts that already exist in the recent `chatState.snapshots` being injected via the scene blocks, and format the remainder into a `<recalled_memories>` block. Inject this using `setExtensionPrompt`.
5. **UI Updates**: Add settings to toggle Semantic Retrieval, configure Top K, set similarity threshold, query depth, and provide a button to manually purge the active chat's vector index.
