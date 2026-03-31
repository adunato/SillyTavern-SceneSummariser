# CR011: Vector Search Performance Optimization - HLD

## 1. Overview
This design addresses the performance bottlenecks identified in the vector search and indexing implementation of the `SillyTavern-SceneSummariser` extension. The goal is to move from a "purge-and-reindex" strategy to incremental indexing and to optimize the retrieval process through asynchronous execution.

## 2. Design Decisions

### 2.1. Incremental Indexing
Instead of purging the entire collection, we will use the `hash` field supported by SillyTavern's vector API to manage items.
- **Mechanism**:
    - Assign a unique hash to each memory fact. A composite hash of `snapshotId` and `factContent` will be used.
    - Before saving, query the current collection for existing hashes using `/api/vector/list`.
    - Only insert (`/api/vector/insert`) items whose hashes are not in the list.
    - Delete (`/api/vector/delete`) items from the collection if their `snapshotId` is no longer present in the `chatState` (e.g., snapshot deleted).
- **Benefit**: Dramatically reduces the number of embedding generations required, especially in long chats.

### 2.2. Asynchronous Search
To eliminate blocking during prompt construction:
- **Mechanism**:
    - Trigger `handleSemanticRetrieval` non-blockingly when `filterContextInterceptor` is called.
    - The search results from the background call will be available for the *next* generation or later in the current generation if timing allows (transient state update).
- **Benefit**: Removes vector retrieval latency from the TTFT (Time to First Token).

## 3. Detailed Component Analysis

### 3.1. Implementation of `deleteVectorItems`
We will use the `/api/vector/delete` endpoint. This requires an array of hashes. We will track which hashes belong to which snapshot to allow surgical removal of memories when a snapshot is deleted or regenerated.

## 4. Risks and Mitigations
- **Race Conditions**: Asynchronous updates might lead to the UI showing stale memories for one turn. *Mitigation*: This is an acceptable trade-off for zero-latency prompt generation.
- **Hash Collisions**: Extremely unlikely with 64-bit hashes but possible. *Mitigation*: Include `snapshotId` in the hash to narrow the scope.
