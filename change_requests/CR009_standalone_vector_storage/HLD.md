# Title: Standalone Vector Storage & Advanced Memory Injection
## Status: Draft
## Goals:
- Stop saving extracted memories as Markdown files in the SillyTavern Data Bank (`ss-memories-[chat].md`).
- Prevent the core Vector Storage extension from automatically injecting duplicate memories.
- Implement a lightweight, standalone vector management system using SillyTavern's backend APIs.
- Decouple memory injection logic from summary injection logic to allow fine-grained control.
- Seamlessly blend semantically retrieved memories into their corresponding scene blocks where possible, falling back to a standalone block for very old scenes.

## Proposed Solution:
1. **Storage Mechanism (Backend Vector DB)**: 
   - Store extracted memory facts directly into SillyTavern's built-in vector database (LanceDB) via the `/api/vector/insert` endpoint. We will use a dedicated collection ID (e.g., `scene_summariser_[chat_id]`).
2. **Refactor Ingestion**: 
   - Update `src/storage/memoryFileHandler.js` to map new memories and send them to the vector collection instead of writing `.md` Data Bank files. 
   - Add a one-time migration step to ingest existing files and delete them.
3. **Advanced Semantic Retrieval & Injection**:
   - Register a hook for `GENERATE_BEFORE_COMBINE_PROMPTS`.
   - Build a semantic query based on a configurable number of recent chat messages.
   - Fetch the top `K` facts using `/api/vector/query`.
   - **Dynamic Injection Logic**:
     - Recent scenes (up to `fullMemoriesToInject`): Display the scene block with *all* of its extracted facts.
     - Older injected scenes (beyond `fullMemoriesToInject` but within `summariesToInject`): Display the scene block, but append *only* the facts that were returned by the semantic search.
     - Very old scenes (beyond `summariesToInject`): If semantic search returns facts from these scenes, inject them into a standalone `<recalled_memories>` block at the top or bottom of the prompt.
4. **Expanded UI Configuration**: 
   - Add a new "Memory Injection Control" section (separating it from Summary Injection).
   - **Full Memories to Inject**: Number of recent scenes to show *all* their facts.
   - **Enable Semantic Search**: Toggle.
   - **Search Query Scope**: Number of recent chat messages to use as the semantic search text.
   - **Max Retrieved Memories (Top K)**: Slider for maximum results.
   - **Similarity Threshold**: Slider for minimum vector match score.
   - **Purge Vector Index**: Button to reset the database for the active chat.
