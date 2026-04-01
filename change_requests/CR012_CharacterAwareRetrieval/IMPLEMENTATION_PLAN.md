# CR012: Character-Aware Semantic Retrieval - Implementation Plan

## Phase 1: Storage & Metadata
**Goal**: Ensure memories are stored with character association metadata.

1. **Update `memoryFileHandler.js`**:
    - In `persistMemoriesForChat`, extract character names from `memText` using the heuristic: `const match = memText.match(/^([^:]+):/);`.
    - Include the extracted `characters` array in the metadata sent to `insertVectorItems`.
    - **Note**: Since we recently implemented incremental indexing, memories already in the vector DB won't have this metadata until they are updated or the DB is purged.

2. **UI Action**:
    - (Optional) Provide a "Force Full Re-index" button in settings or automatically trigger it once the extension detects the version bump for CR012.

## Phase 2: Contextual Retrieval & Filtering
**Goal**: Filter retrieved memories by active character.

1. **Update `engine.js`**:
    - Modify `buildSummaryText` to determine the "active" character name(s) from `getContext()`.
    - In group chats, use `getContext().name2` which usually reflects the character whose turn it is.
    - Filter `chatState.currentSemanticResults` items:
        - Keep if `res.metadata.characters` is empty or undefined.
        - Keep if `res.metadata.characters` contains the active character name (case-insensitive).

2. **Refine Matching**:
    - Implement a simple case-insensitive and whitespace-tolerant match for character names.

## Verification Plan
1. **Metadata Verification**:
    - Manually generate a summary with character-specific facts.
    - Inspect the network request to `/api/vector/insert` to ensure `metadata.characters` is correctly populated.
2. **Filtering Verification**:
    - In a group chat with two characters (A and B), generate memories for both.
    - Trigger a generation for character A.
    - Verify that B's specific memories are NOT injected (or are at least lower priority if we implement ranking).
