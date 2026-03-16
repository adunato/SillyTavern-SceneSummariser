# Memory Extraction — Design

## Problem

Scene summarisation captures narrative flow as prose blobs, but individual facts worth remembering independently — relationship states, inventory, revealed backstory — are buried inside summaries and can't be retrieved selectively. When a summary is not in context the facts it contains are invisible; there is no way to surface just the relevant fact without injecting the entire scene.

## Solution

Extract **discrete memory entries grouped into Memory Blocks** from the same message window used for scene summarisation. A Memory Block is a group of memories related to one or more characters, tied to a short description of the memory event. These blocks are stored as a structured markdown file in the character's SillyTavern Data Bank, letting ST's built-in Vector Storage retrieve them semantically on each generation.

This approach mirrors the one used by the CharMemory extension and intentionally reuses its storage and retrieval interfaces — memories are markdown files with `<memory>` tag blocks registered in `extension_settings.character_attachments`, vectorised automatically by Vector Storage's "Enable for files" setting.

### Key Concepts

*   **Memory Block:** A collection of related memories tied to an event. Defined by a header tag like `* [CharacterA, CharacterB — Event Description]`. A block represents an encounter or scene.
*   **Character Scope:** Memories are implicitly or explicitly tied to characters. In group chats, a single block may apply to multiple characters (e.g. `[Alex, Flux — adoption day]`). The UI will support filtering/viewing blocks by character.

---

## Data Model

### `chatState` extensions

```javascript
chatState {
  // Existing — unchanged
  snapshots:            Snapshot[]
  summaryCounter:       number
  lastSummarisedIndex:  number
  sceneBreakMarkerId:   string
  sceneBreakMesId:      number | null

  // New
  memories:            Memory[]       // lightweight index; full text in Data Bank file
  memoryCounter:       number
}

Memory {
  id:          number
  text:        string         // single atomic fact (also stored in Data Bank file)
  chatLabel:   string         // Used to link back to the snapshot/scene (e.g. "Scene #1")
  characters:  string[]       // Characters involved in this memory block
  blockHeader: string         // The descriptive header of the block (e.g. "[Alex, Flux — event]")
  extractedAt: number         // message index at time of extraction
  createdAt:   number         // ms since epoch
  source:      'extracted' | 'manual'
}
```

### Data Bank storage

Memories are persisted as a markdown file stored in the **chat's** Data Bank (not the character's):

- **File naming:** `ss-memories-<sanitised-chatId>.md`
- **File format:** `<memory>` tag blocks. Each block is formatted to retain the descriptive header and bullets, ensuring it is injected coherently when retrieved.

---

## Extraction Pipeline

**Trigger:** `onSummariseClick`.

**Process:**

1. **Combined Prompt**: Build a prompt from `memoryPrompt` template, providing `{{charName}}` and `{{existingMemories}}`.
2. **LLM Call**: Call `callSummarisationLLM`.
3. **Parsing**: Parse response for `<summary>` and `<memory>` blocks. The parser must recognize the block header (`- [CharA, CharB — description]`) and group subsequent bullets under it.
4. **Combined Review**: Show the new **combined editor popup**.
    *   **Memory Blocks**: Blocks are clearly identified with character names and the event description.
    *   **Actions**: Edit/delete individual bullets, edit the block description, or delete the entire block.
5. **Persistence**: Save approved summary to Snapshots and approved memories (structured as blocks) to the Data Bank and chat metadata.
6. **Refresh**: Update UI components.

---

## User Interface (Requirements)

1.  **Combined Review Dialogue**: 
    - Triggered after every manual summarisation. 
    - Displays the summary in a textarea.
    - Displays extracted memories **grouped by block**. Each block has an editable header (Character/s & Description).
    - **Actions**: Users can edit any bullet text, delete a bullet, edit the block description, or delete a whole block (including its memories) before saving.

2.  **Memory Management Tab**:
    - The dedicated **Memory** tab displays the current list of blocks and facts.
    - **Character Tabs**: The UI must be divided into tabs, one for each character present in the chat (vital for group chats).
    - **Display**: Memories are displayed under their respective block description headings.
    - **Actions**: Edit block description, delete whole block, edit individual memory, delete individual memory. Auto-saves changes to the Data Bank.

3.  **Unified Settings**: 
    - Memory extraction configuration (Enable toggle, Prompt, Max memories) is located inside the existing **Settings** tab.

---

## Combined Extraction Prompt (default)

Template variables: `{{charName}}`, `{{existingMemories}}`, `{{words}}`, `{{summary}}`, `{{last_messages}}`

*(The full prompt text is defined in index.js, enforcing the output structure of `<summary>` followed by `<memory>` blocks with `[CharA, CharB — description]` headers and max 5 bullets per block).*

---

## Injection

Memories will continue to be injected as blocks via Vector Storage retrieval. Because they are saved to the markdown file with their block headers intact, when Vector Storage pulls a chunk, it will pull the cohesive block of facts.

## Settings Additions (in Settings Tab)

| Key | Type | Default | Description |
|---|---|---|---|
| `memoryExtractionEnabled` | boolean | `true` | Co-extract memories alongside scene summaries |
| `memoryPrompt` | string | (see above) | Combined extraction prompt template |
| `maxMemories` | number | `0` | Maximum memories retained in metadata index; 0 = unlimited. |

---

## Out of Scope

- Active Context Panel (SPEC §4)
- AI-powered search over memories
- Per-character memory isolation in storage (Memories are still stored in one file per chat, though the UI will filter them by character).
