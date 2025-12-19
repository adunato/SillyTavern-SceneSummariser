# Scene Summariser – Snapshot Management Plan

Goal: add fine-grained snapshot management so users can view, edit, regenerate, delete, and choose which snapshot is injected, while keeping per-chat state and existing summarisation/trim behaviour.

## 1) Data model
- Per-chat state stores `snapshots: Snapshot[]` plus existing fields (`summaryCounter`, `lastSummarisedIndex`, `sceneBreakMarkerId`, `sceneBreakMesId`).
- Snapshot shape:
  - `id: number` (increments via `summaryCounter`)
  - `title: string` (default `Scene #<id>`)
  - `text: string`
  - `createdAt: number` (ms epoch)
  - `fromIndex: number` (chat index start, inclusive)
  - `toIndex: number` (chat index end, exclusive)
  - `words?: number`, `model?: string`, `source: 'manual' | 'auto'`
  - `markerId?: string`, `messageId?: number` (for scene break)
- Keep `chatStatesByIntegrity` so forks (same `chat_metadata.integrity`) reuse snapshots.

## 2) Migration / persistence - OUT OF SCOPE
- On load, if legacy `currentSummary` string exists and no `snapshots`, create one snapshot (id=1, title `Scene #1`, text=legacy, `fromIndex=0`, `toIndex=chat.length`) and set `activeSnapshotId` to it.
- Enforce `maxSummaries` when adding new snapshots (drop oldest non-pinned; see UX).

## 3) UI additions (settings.html)
- Top-level compact header (follow memory extension pattern):
  1) Checkbox: “Enable Scene Summariser” (always visible).
  2) Button: “Summariser Settings” — toggles expansion of main settings panel (prompt/injection/data-handling/etc.), matching the memory extension’s drawer behaviour.
  3) Button: “Summary” — toggles expansion of the “Current Summary / Snapshots” panel. Defaults collapsed; expands to show snapshots list and current summary text.
   The expansion should work same as F:\StableDiffusion\SillyTavern-Launcher\SillyTavern\public\scripts\extensions\memory extension where "summary settings" button      
  expands the associated section.
- “Snapshots” section (inside the Summary drawer):
  - List/table of snapshots: Title (editable inline), Created (relative), Range (`fromIndex–toIndex`), Words, Source.
- Row actions: View, Edit, Regenerate, Delete.
- Global controls: “New snapshot” (runs summarise), “Copy text”.
  - Badges: Active snapshot indicator; Pinned flag.
  - Empty state with CTA to Summarise.

## 4) Actions wiring (index.js)
- View: open modal/textarea readonly with snapshot text.
- Edit: inline textarea, Save updates `text` and optional `title`.
- Delete: remove snapshot; if it was active, fall back to latest snapshot (or none).
- Regenerate: rerun summarise over stored `fromIndex..toIndex` with current prompt/word limit; overwrite that snapshot (update `text`, `createdAt`, optional `words`, `model`).
- New snapshot: reuse current summarise flow, but store as a snapshot object.

## 5) Summarisation flow changes
- On summarise:
  - `fromIndex = lastSummarisedIndex`
  - `toIndex = chat.length`
  - Create snapshot object, push to `snapshots`, increment `summaryCounter`.
  - Update `lastSummarisedIndex = chat.length`.
  - Respect `maxSummaries` (drop oldest non-pinned).
  - If no `activeSnapshotId`, set it to new snapshot.
- If `storeHistory` is enabled and desired, allow injection to optionally concatenate last N snapshots (configurable later).

## 6) Injection & prompt trimming
- `applyInjection`: always injects the latest snapshot’s `text` (or concatenated recent if history mode is enabled). No manual selection of older snapshots, since summaries are sequential.
- `filterChatCompletionPrompt`: unchanged logic (still trims after last summary index or marker).

## 7) UX polish / safeguards
- Show warning if snapshot’s `toIndex` exceeds current chat length (messages deleted) → disable Regenerate with a tooltip.
- Clipboard button to copy snapshot text.
- Pinned snapshots are not auto-deleted when `maxSummaries` is enforced; drop oldest unpinned first.
- If no snapshots exist, disable injection toggle and show “No summaries yet”.

## 8) Edge cases
- Forked chats: integrity-based reuse keeps snapshots; new chats with new integrity start blank.
- Deleted messages: regeneration blocked; user can create a fresh snapshot instead.
- Auto-summarise (if activated later) would create snapshots with `source='auto'`.

## 9) Testing checklist
- Legacy migration creates first snapshot and keeps trim-to-unsummarised working.
- Summarise -> snapshot appears; Regenerate updates text; Delete removes; Edit persists; Pin changes injection.
- `activeSnapshotId` respected by injection; “Use latest” fallback works.
- `maxSummaries` enforced without dropping pinned entries.
- Fork/duplicate chat retains snapshots; brand-new chat starts empty.
