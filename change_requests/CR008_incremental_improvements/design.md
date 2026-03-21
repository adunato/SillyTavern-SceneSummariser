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
     - **Injection Template**: `{{summary}}`, `{{last_messages}}`, `{{words}}`.
   - Use a styled `.variable-legend` class in `style.css` for consistent appearance.

3. **Description for Word limit**
   - Add a helpful description for the "Word limit" slider in the Advanced Control section.
   - Clarify that it controls the `{{words}}` variable used in prompt templates.

## Affected Files
- `src/ui/settingsUI.js`: UI logic for enabling/disabling inputs.
- `settings.html`: UI structure for variable legends.
- `style.css`: Styling for the legends.

## Design Decisions
- Add a new helper function `updatePromptVisibility(container, settings)` to handle the logic.
- Call this function in `updateSettingsUI` and in the `input` event listener for `ss_memoryExtractionEnabled`.
- Use `opacity` and `disabled` attributes to clearly indicate the state to the user.

## Verification Plan
- Manually toggle the "Enable memory extraction" switch in the extension settings.
- Verify that the text areas are correctly enabled/disabled.
- Verify that the settings are saved and persist after a page refresh.
