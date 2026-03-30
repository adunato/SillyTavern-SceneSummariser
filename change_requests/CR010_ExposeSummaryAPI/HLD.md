# High Level Design (HLD) - Expose Current Summary API (CR010)

## Problem Statement
Currently, the Scene Summariser extension provides its output solely by injecting it into the SillyTavern prompt via `setExtensionPrompt`. Other extensions or the user cannot easily programmatically access the latest generated summary and memories without manual extraction from the prompt or looking into the extension's internal state.

## Proposed Solution
Introduce a public API (exposed via the `window` object) that allows other parts of SillyTavern or other extensions to retrieve the current chat summary and memories using the same logic and settings that the extension uses for its own prompt injection.

## Technical Details

### API Location
The API will be exposed globally as `window.SceneSummariser`.

### Exposed Functions
1.  `getCurrentSummary()`: Returns the full text that would be injected into the prompt, including summaries and recalled memories, formatted according to current settings.
2.  `getLatestSnapshot()`: Returns the most recent snapshot object (containing title, text, memories, etc.).
3.  `getCurrentRecalledMemories()`: Returns the array of memories currently recalled via semantic retrieval for the active context.

### Implementation Strategy
-   Create a new module `src/core/api.js`.
-   This module will import `getChatState`, `ensureSettings`, and `buildSummaryText`.
-   It will provide a standard way to access these without exposing too much internal state.
-   `index.js` will initialize this API on the `window` object.

## Impact Analysis
-   **Security**: Minimal impact. The API only exposes data that is already destined for the prompt.
-   **Performance**: Extremely low impact as it primarily reads from existing state.
-   **Compatibility**: No breaking changes to existing functionality.

## Questions for the User
1.  Is a simple string return (matching what's injected into the prompt) sufficient for `getCurrentSummary()`, or would you prefer a more structured JSON object (e.g., separating snapshots from recalled memories)? **user answer**:simple string return is sufficient
2.  Do you want a way to manually trigger a refresh of the summary/memories via this API, or is returning the "last generated" state enough?**user answer**:returning the "last generated" state is enough
3.  Is `window.SceneSummariser` a suitable namespace for the API? **user answer**:yes
