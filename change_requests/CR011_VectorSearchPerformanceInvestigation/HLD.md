# CR011: Vector Search Performance Optimization - HLD

## 1. Overview
This design addresses the performance bottlenecks identified in the vector search and indexing implementation of the `SillyTavern-SceneSummariser` extension. The goal is to move from a "purge-and-reindex" strategy to incremental indexing and to optimize the retrieval process through asynchronous execution and intelligent caching.

## 2. Design Decisions

### 2.1. Incremental Indexing
Instead of purging the entire collection, we will use the `hash` field supported by SillyTavern's vector API to manage items.
- **Mechanism**:
    - Assign a unique hash to each memory fact. A composite hash of `snapshotId` and `factContent` will be used.
    - Before saving, query the current collection for existing hashes using `/api/vector/list`.
    - Only insert (`/api/vector/insert`) items whose hashes are not in the list.
    - Delete (`/api/vector/delete`) items from the collection if their `snapshotId` is no longer present in the `chatState` (e.g., snapshot deleted).
- **Benefit**: Dramatically reduces the number of embedding generations required, especially in long chats.

### 2.2. Asynchronous & Stale-While-Revalidate Search
To eliminate blocking during prompt construction:
- **Mechanism**:
    - Trigger `handleSemanticRetrieval` non-blockingly when `filterContextInterceptor` is called.
    - If a valid cache exists, use it immediately.
    - If no cache exists, the first generation might lack semantic memories, but subsequent ones will be populated once the background search completes.
    - Additionally, trigger the search on `MESSAGE_RECEIVED` to pre-fetch results before the user even starts generating a response.
- **Benefit**: Removes vector retrieval latency from the TTFT (Time to First Token).

### 2.3. Result Caching
- **Implementation**:
    - Store the results of the last search along with a fingerprint of the query context.
    - **Query Fingerprint**: A hash or concatenated string of the last `N` message IDs and their content.
    - **Cache Logic**: 
        - If the fingerprint matches exactly, return cached results.
        - If the fingerprint has changed but only slightly (e.g., only the last message is new and it's short), consider a "fuzzy match" or simply use the stale cache while updating in the background.
- **Benefit**: Avoids redundant network calls and embedding generation for identical or near-identical chat states.

### 2.4. Query Refinement
- **Mechanism**:
    - Instead of sending raw chat logs, extract the last user message and the most recent AI response to form a more focused query.
    - Optionally, use the "Scene Description" of the current (unsummarized) segment if available.
- **Benefit**: Improves retrieval relevance by reducing "noise" in the query vector.

### 2.5. Collection Management
- **Mechanism**:
    - Implement a `purge` on chat deletion (if the extension can hook into that event).
    - Ensure collection IDs are consistently derived from the `chatId`.
- **Benefit**: Prevents "zombie" collections from accumulating in the vector backend storage.

## 3. Detailed Component Analysis

### 3.1. Result Caching in Detail
The cache will be stored in the transient `chatState`. It will consist of:
- `lastQueryFingerprint`: A hash of the messages used for the last search.
- `lastResults`: The array of metadata results returned by the vector backend.
- `timestamp`: When the search was performed.

**Refresh Policy**:
- **Hard Refresh**: Triggered if the fingerprint changes significantly (e.g., a new character joins, or a large block of text is pasted).
- **Soft Refresh**: Triggered if a new message is added but the cooldown hasn't expired. Use stale results but queue a background update.

### 3.2. Query Refinement Logic
The current implementation uses a "depth" of messages. We will refine this by:
1. Identifying the "Primary Subject": The last 1-2 exchanges.
2. Contextual Overlay: Adding the current snapshot's title or description if it exists to ground the search in the current scene's context.

### 3.3. Implementation of `deleteVectorItems`
We will use the `/api/vector/delete` endpoint discovered in the core investigation. This requires an array of hashes. We will track which hashes belong to which snapshot to allow surgical removal of memories when a snapshot is deleted or regenerated.

## 4. Risks and Mitigations
- **Race Conditions**: Asynchronous updates might lead to the UI showing stale memories. *Mitigation*: Use a version counter or timestamp to ensure only the latest search results are applied.
- **Hash Collisions**: Extremely unlikely with 64-bit hashes but possible. *Mitigation*: Include `snapshotId` in the hash to narrow the scope.
