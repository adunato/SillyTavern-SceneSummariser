# SillyTavern-SceneSummariser — Extension Spec

> **How to use this document**  
> This is the authoritative spec for the extension. It describes what exists, what is being added, and the contracts between subsystems. It is intentionally code-agnostic — implementation details belong in the code, not here. Update this document when scope changes, not when implementation details change.

---

## 1. Current State (as-built)

### 1.1 Persistence model

State is split into two layers:

**Global settings** (`extension_settings[settingsKey]`) — persisted by SillyTavern across sessions. Contains all configuration and the `chatStates` map.

**Chat state** (`chatStates[chatId]`) — per-conversation state, keyed by chat ID with a secondary integrity-based index for fork recovery. Schema:

```
chatState {
  snapshots:            Snapshot[]     // ordered oldest-first
  summaryCounter:       number         // monotonic ID counter
  lastSummarisedIndex:  number         // message frontier
  sceneBreakMarkerId:   string
  sceneBreakMesId:      number | null
}

Snapshot {
  id:          number
  title:       string               // "Scene #N" or "Scene N-M" after consolidation
  text:        string               // the summary prose
  createdAt:   timestamp
  fromIndex:   number               // inclusive start in ctx.chat
  toIndex:     number               // exclusive end in ctx.chat
  source:      'manual' | 'batch' | 'consolidation' | 'legacy'
  words:       number               // word limit used at generation time
}
```

### 1.2 Summarisation pipelines

**Manual summarise** (`onSummariseClick`) — user-triggered via toolbar button. Summarises messages from `lastSummarisedIndex` to current end. Shows editor popup before saving. Inserts a scene break marker into the chat.

**Batch summarise** (`onBatchSummariseClick`) — resets all state, processes entire chat history in fixed-size windows. Auto-saves without editor popup per batch.

**Consolidation** (`onConsolidateClick`) — merges a consecutive selection of existing snapshots into one. Shows editor popup before saving. Replaces the selected snapshots in-place.

**Regenerate** (`regenerateSnapshot`) — re-runs summarisation for a single existing snapshot using its original message range. Shows editor popup.

All pipelines route through `callSummarisationLLM` which respects the configured Connection Profile with fallback to `generateRaw`.

### 1.3 Injection

`applyInjection` is called after every state mutation. It calls `setExtensionPrompt` with the assembled injection string, built by `buildSummaryText` which respects `storeHistory` and `maxSummaries` settings.

The injected string is a template: `[Summary: {{summary}}]` by default, with `{{last_messages}}` and `{{words}}` also available.

### 1.4 Context filtering

`filterContextInterceptor` is exposed as `window['SceneSummariser_filterContextInterceptor']` and registered in `manifest.json`. When `limitToUnsummarised` is enabled, it scans `fullChat` backwards for a scene break marker and splices older messages out of the `chat` array passed to generation, optionally keeping a tail of `keepMessagesCount` messages.

### 1.5 UI

Settings panel mounted into `#extensions_settings`. Separate collapsible panels for settings and summary management. Snapshot list rendered as an accordion — each snapshot is editable inline with auto-save. Toolbar button placed alongside Guided Generations buttons with polling-based mount.

---

## 2. New Feature: Memory Extraction

### 2.1 Purpose

Alongside scene summaries (prose blobs capturing narrative flow), the extension will extract discrete **memory entries** — atomic facts, relationship states, inventory items, locations, or any detail worth preserving independently of scene structure.

Memories are extracted from the same message windows as scene summaries but stored and managed separately. They are injected independently and can be selectively included or excluded from context.

### 2.2 Memory data model

Extends `chatState`:

```
chatState {
  // existing fields unchanged
  snapshots:           Snapshot[]
  summaryCounter:      number
  lastSummarisedIndex: number
  sceneBreakMarkerId:  string
  sceneBreakMesId:     number | null

  // new fields
  memories:            Memory[]
  memoryCounter:       number
  activeContext:       ActiveContext
}

Memory {
  id:               number
  text:             string        // single atomic fact, one sentence
  extractedAt:      number        // message index at time of extraction
  createdAt:        timestamp
  source:           'extracted' | 'manual'
}

ActiveContext {
  entries: ContextEntry[]
}

ContextEntry {
  type:    'scene' | 'memory'
  refId:   number               // foreign key into snapshots[] or memories[]
  pinned:  boolean              // survives Rebuild if true
}
```

### 2.3 Memory extraction pipeline

**Trigger:** same as manual summarise — user-triggered only. Memory extraction runs as part of the Update operation (see §3.1), not as a standalone pipeline.

**Process:** a single LLM call receives the same message window as the scene summary. The prompt requests both a scene summary and a list of discrete memory entries. The response is parsed into one new `Snapshot` and zero or more new `Memory` entries.

**Prompt contract:** the extraction prompt must instruct the LLM to return a structured response separable into summary prose and a memory list. The exact format is a prompt engineering concern, not a spec concern — but the parser must handle malformed responses gracefully (fall back to summary-only if memory list cannot be parsed).

**Post-extraction:** new snapshot and memories are appended to their respective stores. New entries are also appended to `activeContext` as unpinned entries.

**Settings additions:**
- `memoryExtractionEnabled: boolean` — default `true`. When false, extraction prompt requests summary only (existing behaviour).
- `memoryPrompt: string` — the combined extraction prompt template.
- `maxMemories: number` — max memories retained across all extraction runs. 0 = unlimited. Oldest entries pruned when exceeded.

---

## 3. New Feature: Active Context Assembly

### 3.1 The Update / Rebuild distinction

**Update** — advances the knowledge store. Runs extraction on unsummarised messages. Appends results to `snapshots`, `memories`, and `activeContext`. Does not remove anything. This replaces and extends the existing manual summarise flow.

**Rebuild** — reshapes `activeContext` only. Clears all unpinned entries. Re-populates from the knowledge store using recency order until token budget is exhausted. Pinned entries always included and counted against the budget. Knowledge store is untouched.

Both are manual, user-triggered only. No automatic context assembly.

### 3.2 Token budget

`activeContext` tracks an approximate token count. Budget ceiling is a setting (`contextTokenBudget`, default 2000). Token counting is approximate — character count divided by a configurable ratio is acceptable; exact tokenisation is not required.

When Rebuild runs, entries are selected newest-first until the budget is reached. Scenes and memories are interleaved by recency of their source message range.

Pinned entries are always included regardless of budget. If pinned entries alone exceed the budget, the token bar reflects over-budget state but no entries are dropped.

### 3.3 Context injection

`applyInjection` is extended to build the injected string from `activeContext` rather than directly from `buildSummaryText`.

The injection template gains two new variables:
- `{{scenes}}` — concatenation of all scene entries in active context, ordered by `fromIndex`
- `{{memories}}` — concatenation of all memory entries in active context, ordered by `extractedAt`

Existing `{{summary}}` variable continues to work as before (uses `buildSummaryText` logic) for backwards compatibility with existing prompt templates.

### 3.4 Unsummarised message nudge

When `currentMessageIndex > lastSummarisedIndex + nudgeThreshold`, the context panel displays a notice with the count of unsummarised messages and a shortcut to trigger Update. `nudgeThreshold` is a setting, default 8.

---

## 4. New Feature: Context Panel UI

### 4.1 Panel placement

The Context panel is a side panel to the main chat interface, toggled via a button in the ST toolbar. It is persistent and visible alongside the chat, not inside the extension settings drawer. The extension settings drawer retains only configuration options.

### 4.2 Active context view

Displays the current contents of `activeContext`. Two collapsible sections: Scenes and Memories.

Each entry shows:
- Type indicator (colour-coded)
- Entry text, truncated; full text on expand or hover
- Source reference (message range for scenes; extracted-at index for memories)
- Pin toggle (on hover) — sets `pinned: true/false`
- Remove button (on hover) — removes from `activeContext` only, not from knowledge store

Token budget bar — live fill representing current token usage vs `contextTokenBudget`.

Unsummarised message notice — shown when nudge condition is met (§3.4). Contains an inline Update shortcut.

Header actions:
- **Update** — triggers extraction pipeline (§2.3)
- **Rebuild** — triggers context rebuild (§3.2)

Footer actions:
- **Browse & Add** — opens the picker (§4.3)
- **Clear All** — removes all unpinned entries from `activeContext`

### 4.3 Picker

Opens as a drawer or sub-panel within the side panel. Allows the user to browse the full knowledge store and add entries to `activeContext`.

**Tabs:** Scenes | Memories

**Search bar** with two modes:
- *Text mode* — synchronous substring filter on entry text. No LLM call.
- *AI mode* — sends entry texts and the query string to the LLM; returns relevance-ranked results with scores. Entries below `aiSearchScoreThreshold` (setting, default 0.4) are visually dimmed but not hidden.

Entry list — all knowledge store entries for the active tab, filtered/ranked by search if active. Each entry shows:
- Checkbox for multi-select
- Type indicator
- Entry text
- Source reference
- "in context" label if already present in `activeContext` (re-adding is a no-op)
- Relevance score in AI mode

Footer: selected count, **Add to Context** button (disabled when nothing selected).

### 4.4 Manual entry addition

In the picker, a **+ Add manually** affordance allows the user to type free-form text and add it directly to `activeContext` as a memory entry with `source: 'manual'`. The entry is also appended to the `memories` store.

---

## 5. Settings additions summary

| Key | Type | Default | Description |
|---|---|---|---|
| `memoryExtractionEnabled` | boolean | `true` | Whether to extract memories alongside scene summaries |
| `memoryPrompt` | string | (TBD) | Combined extraction prompt template |
| `maxMemories` | number | `0` | Max memories retained. 0 = unlimited |
| `contextTokenBudget` | number | `2000` | Token ceiling for Rebuild auto-selection |
| `aiSearchScoreThreshold` | number | `0.4` | Below this, AI search results are dimmed |
| `unsummarisedNudgeThreshold` | number | `8` | Messages before notice appears |

---

## 6. Backwards compatibility

- Existing `snapshots` structure is unchanged.
- `buildSummaryText` and existing `{{summary}}` template variable continue to work unchanged.
- `filterContextInterceptor` behaviour is unchanged.
- `limitToUnsummarised`, `keepMessagesCount`, and all existing settings are preserved.
- Chat states without `memories` or `activeContext` fields are initialised with empty defaults on first access — no migration required.
- When `memoryExtractionEnabled` is false, the extension behaves identically to the current version from the LLM's perspective.

---

## 7. Out of scope

- Editing or deleting entries from the knowledge store (snapshots or memories) via the context panel — that remains in the existing summary management panel.
- Automatic context assembly without user action.
- LLM tool use during generation.
- Vector/embedding-based retrieval — AI search operates on the full in-memory knowledge store, not a vector index.
- Per-character memory separation (as in CharMemory) — all memory is scoped to the chat, not the character card.
