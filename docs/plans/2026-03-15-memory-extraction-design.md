# Memory Extraction — Design

## Problem

Scene summarisation captures narrative flow as prose blobs, but individual facts worth remembering independently — relationship states, inventory, revealed backstory — are buried inside summaries and can't be retrieved selectively. When a summary is not in context the facts it contains are invisible; there is no way to surface just the relevant fact without injecting the entire scene.

## Solution

Extract **discrete memory entries** from the same message window used for scene summarisation, store them as a structured markdown file in the character's SillyTavern Data Bank, and let ST's built-in Vector Storage retrieve them semantically on each generation.

This approach mirrors the one used by the CharMemory extension and intentionally reuses its storage and retrieval interfaces — memories are markdown files with `<memory>` tag blocks registered in `extension_settings.character_attachments`, vectorised automatically by Vector Storage's "Enable for files" setting.

---

## Data Model

### `chatState` extensions

```
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
  createdAt:   timestamp      // ms since epoch
  source:      'extracted' | 'manual'
}
```

### Data Bank storage

Memories are persisted as a markdown file stored in the **chat's** Data Bank (not the character's), using the same `extension_settings.character_attachments` mechanism used by CharMemory:

- **File naming:** `ss-memories-<sanitised-chatId>.md`
- **File format:** `<memory>` tag blocks, fully compatible with CharMemory's parser in `lib.js` — enabling future interoperability if desired.

```markdown
<memory chat="Scene #3" date="2026-03-15 09:45">
- [Elena, Player — warehouse ambush]
- Elena was shot in the shoulder during the ambush at Koval's warehouse.
- Player carries a forged harbor pass obtained from Varro.
</memory>
```

Each `<memory>` block maps to one extraction run (one scene summary). A new block is appended on every Update; blocks are never modified after writing.

### Vector retrieval

No custom retrieval code. After the file is written:
1. ST's Vector Storage extension detects the new/updated Data Bank file.
2. On the next generation it chunks and embeds the file automatically.
3. Semantically relevant memory bullets are injected via the `4_vectors_data_bank` extension prompt slot.

This is identical to how CharMemory retrieval works and requires only that the user has "Enable for files" checked in Vector Storage settings.

---

## Extraction Pipeline

**Trigger:** same as the existing manual summarise flow (`onSummariseClick`). Memory extraction runs as part of that operation — no new toolbar button.

**Process:**

1. Build a combined extraction prompt from `memoryPrompt` template (replaces `summaryPrompt` when `memoryExtractionEnabled = true`).
2. Call `callSummarisationLLM` — the same function used for all other summarisation, honouring the Connection Profile setting.
3. Parse the response:
   - Split on `<summary>…</summary>` and `<memories>…</memories>` XML wrapper tags.
   - If parsing fails: fall back to treating the whole response as a summary (no memories created). No crash, no data loss.
4. Create one `Snapshot` from the `<summary>` text (existing flow unchanged).
5. Parse `<memories>` bullets into `Memory` objects; append to `chatState.memories[]`.
6. Append the new `<memory>` tag block to the Data Bank file via `writeMemoriesFile()`.
7. Show the existing summary editor popup (summary text only; memories save silently).
8. Prune oldest memories if `maxMemories > 0` and count exceeds limit.
9. Call `applyInjection`.

**Batch summarise:** when `memoryExtractionEnabled` is true, each batch window also runs the combined prompt and appends a memory block. No popup shown per batch (existing behaviour).

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
- [CharacterName, OtherName — short topic label]
- [fact 1]
- [fact 2]
</memories>

If there are no facts worth remembering beyond the summary itself, omit the <memories> block entirely.
```

---

## Settings Additions

| Key | Type | Default | Description |
|---|---|---|---|
| `memoryExtractionEnabled` | boolean | `true` | Co-extract memories alongside scene summaries |
| `memoryPrompt` | string | (see above) | Combined extraction prompt template |
| `maxMemories` | number | `0` | Maximum memories retained in `chatState.memories[]`; 0 = unlimited. Oldest pruned first. |

No `contextTokenBudget`, no AI search, no context panel — those are Section 3 and 4 of the SPEC and are **out of scope for this CR**.

---

## Injection

`applyInjection` is **not changed** for this CR. Memory retrieval happens passively via Vector Storage. The `{{summary}}` template variable continues to work as before.

The `injectTemplate` setting may reference `{{memories}}` in a future CR. For now the memories land in `4_vectors_data_bank` (Vector Storage's extension prompt slot), which is independent of the SceneSummariser injection slot.

---

## Backwards Compatibility

- `chatState` without `memories` / `memoryCounter` fields: initialised with empty defaults on first access — no migration.
- When `memoryExtractionEnabled = false`: prompt falls back to `summaryPrompt`; no Data Bank file is written; no behaviour change from the user's perspective.
- Existing snapshots, injection, batch summarise, consolidation, and filterContextInterceptor are untouched.

---

## Dependencies

- `uploadFileAttachment`, `getFileAttachment`, `deleteFileFromServer` from `scripts/chats.js` — same imports as CharMemory.
- `convertTextToBase64`, `getStringHash` from `scripts/utils.js` — same as CharMemory.
- ST Vector Storage extension — must be enabled by the user with "Enable for files" checked. The extension does not validate this at runtime; user-facing docs note the requirement.

---

## Out of Scope

- Active Context Panel (SPEC §4)
- Update / Rebuild distinction (SPEC §3)
- Token budget or picker UI
- AI-powered search over memories
- Per-character memory isolation
