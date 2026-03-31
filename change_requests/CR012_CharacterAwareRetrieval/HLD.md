# CR012: Character-Aware Semantic Retrieval - HLD

## 1. Overview
Currently, semantic retrieval fetches all relevant memories from the vector collection regardless of which character they are associated with. In group chats or multi-character scenarios, this can lead to the "wrong" memories being injected for the current active character. This CR introduces character-awareness to the retrieval and injection process.

## 2. Design Decisions

### 2.1. Metadata Enhancement
- **Mechanism**: When persisting memories to the vector storage (`persistMemoriesForChat`), extract character names from the memory bullet points (e.g., `Character Name: fact`).
- **Storage**: Store these character names as an array in the `metadata.characters` field of the vector item.
- **Benefit**: Allows the backend or frontend to filter results by character.

### 2.2. Contextual Filtering during Injection
- **Mechanism**: Update `buildSummaryText` to filter the `currentSemanticResults` based on the active character name(s) in the current context.
- **Logic**:
    - A memory is considered "relevant" if:
        1. It has no character association (it's a general world/scene fact).
        2. One of its associated characters matches the active character(s).
- **Benefit**: Improves relevance by ensuring characters only "remember" things they were involved in or that are general knowledge.

### 2.3. Character Name Resolution
- **Mechanism**: Use `getContext().name2` (or member names in group chats) to determine the current "active" character for whom the prompt is being generated.

## 3. Detailed Component Analysis

### 3.1. Parsing Logic
In `src/storage/memoryFileHandler.js`, use the same heuristic as `src/ui/snapshotUI.js` to extract character names:
```javascript
const match = memText.match(/^([^:]+):/);
const characters = match ? match[1].split(',').map(c => c.trim()).filter(c => c) : [];
```

### 3.2. Filtering Logic
In `src/core/engine.js`, identify the current character(s) from `getContext()`. If in a group chat, find the specific character whose turn it is. Filter semantic results by matching `res.metadata.characters` against the active character list.

## 4. Risks and Mitigations
- **Inconsistent Naming**: If the LLM uses a different name for a character than their official ST name, filtering might fail. *Mitigation*: Allow a "relaxed" match or fall back to showing the memory if relevance score is very high.
- **Retroactive Application**: Existing vectors won't have the `characters` metadata. *Mitigation*: Trigger a full re-index (purge and re-index) once when this feature is enabled, or handle missing metadata gracefully (treat as "All").
