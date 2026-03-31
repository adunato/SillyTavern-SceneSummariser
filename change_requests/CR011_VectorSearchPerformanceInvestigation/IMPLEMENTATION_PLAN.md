# CR011: Vector Search Performance Optimization - Implementation Plan

## Phase 1: Incremental Indexing
**Goal**: Replace full re-indexing with hash-based incremental updates.

1. **Update `vectorHandler.js`**:
    - Add a wrapper for `/api/vector/list` (`listVectorHashes`) to fetch existing hashes.
    - Add a wrapper for `/api/vector/delete` (`deleteVectorItems`) to remove items by hash.
    - Update `insertVectorItems` to include `hash` and `index` in the metadata items.

2. **Update `memoryFileHandler.js`**:
    - Modify `persistMemoriesForChat` to:
        - Fetch existing hashes using `listVectorHashes`.
        - Calculate composite hashes for current memories (`getStringHash(snap.id + factText)`).
        - Filter items to `insert` only if they don't already exist.
        - Identify and `delete` items whose hashes are no longer in the `chatState`.
        - Remove `purgeVectorCollection` from the normal flow.

## Phase 2: Asynchronous Search
**Goal**: Eliminate prompt blocking.

1. **Update `injector.js`**:
    - Refactor `handleSemanticRetrieval` to be non-blocking when called from `filterContextInterceptor`.
    - Ensure `applyInjection` is called correctly within the async flow.
    - Remove `await` from the `filterContextInterceptor` call to `handleSemanticRetrieval`.

## Verification Plan
1. **Performance**: 
    - Monitor the "Network" tab to confirm fewer `/api/vector/insert` calls when adding a single snapshot.
    - Measure TTFT with and without the changes to verify asynchronous execution.
2. **Correctness**:
    - Verify that relevant memories are still being injected into the prompt.
    - Confirm that deleting a snapshot also removes its memories from subsequent searches.
