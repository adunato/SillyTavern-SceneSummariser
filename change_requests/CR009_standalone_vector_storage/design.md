# High-Level Design (HLD): Standalone Vector Storage

## 1. Summary
The Scene Summariser extension currently relies on the core SillyTavern Vector Storage extension to semantically retrieve and inject older extracted memories. This causes duplication issues, as the core extension injects memories indiscriminately from Data Bank files (`ss-memories-[chat].md`), often overlapping with the recent memories already injected by the Scene Summariser's scene blocks.

This Change Request (CR009) aims to decouple Scene Summariser from the global Vector Storage extension's Data Bank processing. We will implement a lightweight, standalone vector management system that directly utilizes SillyTavern's native backend vector APIs (`/api/vector/*`). 

## 2. Architecture & Components

### 2.1 Storage & Ingestion
Instead of generating markdown files for the Data Bank, Scene Summariser will directly ingest extracted memory strings into a dedicated vector collection tied to the current chat/character.
- **Collection ID Strategy:** E.g., `scene_summariser_[chat_id]` or `ss_[character_name]`.
- **API Endpoints Used:** `/api/vector/insert`, `/api/vector/purge`, `/api/vector/delete`.
- **Migration:** Existing `ss-memories` Data Bank files will be parsed, ingested into the new vector collection, and then optionally archived or deleted to prevent the core Vector Storage extension from continuing to use them.

### 2.2 Semantic Retrieval & Injection
Retrieval will be handled natively by Scene Summariser during the generation cycle.
- **Trigger:** Hook into an appropriate event (e.g., `GENERATE_BEFORE_COMBINE_PROMPTS` or similar async pre-generation phase).
- **Query Formulation:** The extension will gather the last `N` messages of the chat to form the query text.
- **API Endpoint:** `/api/vector/query`.
- **Deduplication:** The logic will filter out any retrieved memories that are *already present* in the recent "Scene Blocks" currently being injected by the extension.
- **Injection:** The final, deduplicated list of relevant older memories will be formatted and injected using `setExtensionPrompt` under a unique tag (e.g., `ss_vector_memories`).

### 2.3 New Module: `src/storage/vectorHandler.js`
A new file dedicated to handling the HTTP requests to SillyTavern's backend vector endpoints, abstracting the complexity away from the UI and core engine.

## 3. UI & Settings Updates
A new sub-section under **Memory Extraction** will be added to configure this standalone vector system:
- **Enable Semantic Retrieval:** Toggle to turn the standalone retrieval on/off.
- **Max Retrieved Memories:** Slider for the maximum number of vector results to fetch (Top K).
- **Similarity Threshold:** Slider for the minimum vector score required to inject a memory.
- **Query Depth:** How many recent chat messages to use as the semantic search query.
- **Purge Vector Index:** A utility button to clear the private collection for the current chat.