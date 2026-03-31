# CR012: Character-Aware Semantic Retrieval - Investigation

## Current State Analysis

### Memory-Character Association
Currently, character association only exists as a UI feature in `src/ui/snapshotUI.js`. It uses a heuristic to identify the character(s) a memory belongs to based on a colon prefix:
```javascript
const match = memText.match(/^([^:]+):/);
// e.g. "Seraphina: is feeling tired" -> characters = ["Seraphina"]
```
This is used to show character-specific tabs in the snapshot list.

### Storage
In `src/storage/memoryFileHandler.js`, the `persistMemoriesForChat` function converts memories into vector items. It currently only stores:
- `text`: `${snapshot.title}:\n- ${memText}`
- `metadata.snapshotId`: The ID of the scene.
- `metadata.fact`: The raw fact text.

**Crucially, character association is NOT stored in the vector database.**

### Retrieval and Injection
The `buildSummaryText` function in `src/core/engine.js` processes semantic results but does not perform any character-based filtering. It injects all results that pass the vector search threshold and top-K limit.

## Performance & Relevance Implications
In chats with multiple characters, semantic retrieval often pulls in facts about "Character B" when the prompt is being built for "Character A", provided the facts are semantically related to the current conversation. This reduces the relevance of the injected context and can cause characters to "know" things they shouldn't or hallucinate based on other characters' traits/actions.

## Proposed Improvement
By storing character metadata in the vector items and filtering by the active character during prompt construction, we can significantly improve the relevance of recalled memories.
