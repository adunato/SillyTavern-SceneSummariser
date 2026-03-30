# Implementation Plan - Expose Current Summary API (CR010)

## Overview
This plan outlines the steps needed to implement the public API for the Scene Summariser extension.

## Proposed Steps

### Step 1: Create API Module
Create `src/core/api.js` with the following skeleton:

```javascript
import { getChatState, ensureSettings } from '../state/stateManager.js';
import { buildSummaryText, getLatestSnapshot } from './engine.js';
import { extension_settings } from '../../../../../extensions.js';
import { settingsKey } from '../constants.js';

export function getCurrentSummary() {
    ensureSettings();
    const settings = extension_settings[settingsKey];
    const chatState = getChatState();
    return buildSummaryText(chatState, settings);
}

export function getLatestSnapshotData() {
    ensureSettings();
    const chatState = getChatState();
    return getLatestSnapshot(chatState);
}

export function getCurrentRecalledMemories() {
    ensureSettings();
    const chatState = getChatState();
    return chatState.currentSemanticResults || [];
}
```

### Step 2: Initialize API in Entry Point
Modify `index.js` to import the new functions and expose them on `window.SceneSummariser`.

```javascript
import * as api from './src/core/api.js';

// ... other imports

jQuery(async () => {
    // ... initialization

    // Register API
    window.SceneSummariser = {
        ...api,
    };
});
```

### Step 3: Verification & Testing
1.  Open SillyTavern and open the browser console.
2.  Type `window.SceneSummariser.getCurrentSummary()` and verify it returns the expected summary string.
3.  Type `window.SceneSummariser.getLatestSnapshotData()` and verify it returns a valid snapshot object.
4.  Type `window.SceneSummariser.getCurrentRecalledMemories()` and verify it returns an array of semantic search results.

## Rollback Plan
-   Remove the `window.SceneSummariser` assignment from `index.js`.
-   Delete the `src/core/api.js` file.
