# CR011: Vector Search Performance Optimization - Implementation Plan

## Phase 1: Incremental Indexing
**Goal**: Replace full re-indexing with hash-based incremental updates.

1. **Update `vectorHandler.js`**:
    - Add a wrapper for `/api/vector/list` to fetch existing hashes.
    - Add a wrapper for `/api/vector/delete` to remove items by hash.
    - Update `insertVectorItems` to optionally accept hashes.

2. **Update `memoryFileHandler.js`**:
    - Modify `persistMemoriesForChat` to:
        - Fetch the list of hashes already in the collection.
        - Calculate a composite hash for each memory in `chatState.snapshots` (e.g., `getStringHash(snap.id + factText)`).
        - Identify "new" memories (hash not in collection) and "deleted" memories (hash in collection but not in current `chatState`).
        - Perform incremental `insert` for new items and `delete` for removed items.
        - Remove `purgeVectorCollection` from the normal flow.

## Phase 2: Asynchronous Search & Caching
**Goal**: Eliminate prompt blocking and redundant queries.

1. **Update `stateManager.js`**:
    - Add fields to the transient state for caching: `lastQueryFingerprint`, `lastResults`, `lastSearchTimestamp`.

2. **Update `injector.js`**:
    - Refactor `handleSemanticRetrieval` to:
        - Calculate a fingerprint of the current context (e.g., hash of last 5 message IDs).
        - Check if the fingerprint matches the cache. If so, return cached results immediately.
        - If not, return cached results (if available) but trigger a background search.
        - Ensure `applyInjection` is called only after the background search finishes.
    - Remove `await` from the `filterContextInterceptor` call to `handleSemanticRetrieval`.

3. **Event Hooks**:
    - Hook into `MESSAGE_RECEIVED` and `CHARACTER_MESSAGE_RENDERED` to trigger a background search pre-emptively.

## Phase 3: Query Refinement & Collection Management
**Goal**: Improve retrieval quality and storage hygiene.

1. **Refine Query**:
    - Update `handleSemanticRetrieval` to use a more focused query (last exchange + current scene description).

2. **Hygiene**:
    - Ensure the collection is purged when a chat is deleted (if a hook is available) or when a "Reset Vector Storage" button is pressed in the UI.

## Verification Plan
1. **Performance**: 
    - Monitor the "Network" tab to confirm fewer `/api/vector/insert` calls when adding a single snapshot.
    - Measure TTFT with and without the changes to verify asynchronous execution.
2. **Correctness**:
    - Verify that relevant memories are still being injected into the prompt.
    - Confirm that deleting a snapshot also removes its memories from subsequent searches.
