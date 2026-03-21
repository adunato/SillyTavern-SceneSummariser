# Change Request: Incremental Bug Fixing and Improvements

## Summary
This change request covers a series of incremental improvements and bug fixes for the Scene Summariser extension.

## Requirements
1. **Enable Memories Extraction Switch Improvement**
   - When the "Enable memory extraction" switch is **OFF**:
     - "Summary Prompt" text box is **ENABLED**.
     - "Extraction Prompt (Combined)" text box is **DISABLED**.
   - When the "Enable memory extraction" switch is **ON**:
     - "Summary Prompt" text box is **DISABLED**.
     - "Extraction Prompt (Combined)" text box is **ENABLED**.

2. **Variable Legend in Prompt Configuration Boxes**
   - Add a legend of available variables to each prompt configuration box:
     - **Summary Prompt**: `{{words}}`, `{{summary}}`, `{{last_messages}}`, `{{charNames}}`, `{{existingMemories}}`.
     - **Consolidation Prompt**: `{{words}}`.
     - **Extraction Prompt**: `{{words}}`, `{{summary}}`, `{{last_messages}}`, `{{charNames}}`, `{{existingMemories}}`.
     - **Injection Template**: `{{summary}}`.
   - Use a styled `.variable-legend` class in `style.css` for consistent appearance.

3. **Description for Word limit**
   - Add a helpful description for the "Word limit" slider in the Advanced Control section.
   - Clarify that it controls the `{{words}}` variable used in prompt templates.

4. **Settings Refactor & Section Renaming**
   - **Summarisation Control (Generation Context):**
     - Rename "Summary History Depth" ➔ "Previous Summaries Context" (`summaryContextDepth`).
     - This controls how many past snapshots the LLM sees when generating a *new* summary.
   - **Chat Injection Control (Chat Context):**
     - Consolidate "Store History" & "Max Snapshots History" ➔ "Summaries to Inject in Chat" (`summariesToInject`).
     - This controls how many snapshots are injected into the active chat prompt (1 = latest only, 0 = all).
     - Merged the "Injection" section into this block for better organization.
     - Added "Retain full summaries" (`fullSummariesToInject`). This setting determines how many of the most recent summaries are injected as full text. Older injected summaries will only include their title and description. 0 = all injected summaries are full text.
   - Added migration logic to `src/state/stateManager.js` to preserve user choices during the transition.

## Affected Files
- `src/constants.js`: Updated default settings and keys.
- `src/state/stateManager.js`: Added migration logic.
- `src/core/engine.js`: Updated injection building logic.
- `src/ui/buttons.js`: Updated summarisation context logic.
- `src/ui/settingsUI.js`: Updated UI binding and display logic.
- `settings.html`: Rewrote UI structure and labels.
- `style.css`: Added styling for variable legends.

## Design Decisions
- Add a new helper function `updatePromptVisibility(container, settings)` to handle the logic.
- Call this function in `updateSettingsUI` and in the `input` event listener for `ss_memoryExtractionEnabled`.
- Use `opacity` and `disabled` attributes to clearly indicate the state to the user.

## Verification Plan
- Manually toggle the "Enable memory extraction" switch in the extension settings.
- Verify that the text areas are correctly enabled/disabled.
- Verify that the settings are saved and persist after a page refresh.
