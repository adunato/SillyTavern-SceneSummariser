# Memory Extraction — Design

## Problem

Scene summarisation captures narrative flow as prose blobs, but individual facts worth remembering independently — relationship states, inventory, revealed backstory — are buried inside summaries and can't be retrieved selectively. When a summary is not in context the facts it contains are invisible; there is no way to surface just the relevant fact without injecting the entire scene.

## Solution

Extract **discrete memory entries** from the same message window used for scene summarisation, store them as a structured markdown file in the character's SillyTavern Data Bank, and let ST's built-in Vector Storage retrieve them semantically on each generation.

This approach mirrors the one used by the CharMemory extension and intentionally reuses its storage and retrieval interfaces — memories are markdown files with `<memory>` tag blocks registered in `extension_settings.character_attachments`, vectorised automatically by Vector Storage's "Enable for files" setting.

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
  extractedAt: number         // message index at time of extraction
  createdAt:   number         // ms since epoch
  source:      'extracted' | 'manual'
}
```

### Data Bank storage

Memories are persisted as a markdown file stored in the **chat's** Data Bank (not the character's):

- **File naming:** `ss-memories-<sanitised-chatId>.md`
- **File format:** `<memory>` tag blocks.

---

## Extraction Pipeline

**Trigger:** `onSummariseClick`.

**Process:**

1. **Combined Prompt**: Build a prompt from `memoryPrompt` template (replaces `summaryPrompt` when `memoryExtractionEnabled = true`).
2. **LLM Call**: Call `callSummarisationLLM`.
3. **Parsing**: Parse response for `<summary>` and `<memories>` tags.
4. **Combined Review**: Show the new **combined editor popup** containing the editable summary and a list of editable/deletable memory bullets.
5. **Persistence**: Save approved summary to Snapshots and approved memories to the Data Bank and chat metadata.
6. **Refresh**: Update UI components.

---

## User Interface (Requirements)

1.  **Combined Review Dialogue**: 
    - Triggered after every manual summarisation. 
    - Displays the summary in a textarea.
    - Displays a dynamic list of extracted memory bullets.
    - **Actions**: Users can edit any bullet text or delete a bullet entirely before saving.

2.  **Unified Settings**: 
    - Memory extraction configuration (Enable toggle, Prompt, Max memories) is located inside the existing **Settings** tab.
    - This provides a single location for all "Generation" settings.

3.  **Memory Management Tab**:
    - The dedicated **Memory** tab is used to display the current list of facts stored for the chat.
    - **Actions**: Each memory is editable (auto-saves) and deletable. 
    - Deleting or editing a memory triggers a rewrite of the Data Bank file to maintain consistency with Vector Storage.

---

## Combined Extraction Prompt (default)

Template variables: `{{words}}`, `{{summary}}`, `{{last_messages}}`

```
Summarize the following scene in {{words}} words or less.

===MESSAGES===
{{last_messages}}
===END===

Then extract memorable facts as a bullet list. Each bullet is one specific, atomic fact (a thing that happened, a relationship state, an item, a revealed detail). Write in past tense. Use character names, not pronouns.

Output format — use these exact tags, nothing else:

<summary>
[scene summary here]
</summary>

<memories>
- [fact 1]
- [fact 2]
</memories>

If there are no facts worth remembering beyond the summary itself, omit the <memories> block entirely.
```

---

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
- Per-character memory isolation
