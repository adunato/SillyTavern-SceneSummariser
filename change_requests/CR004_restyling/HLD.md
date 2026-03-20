# SillyTavern-SceneSummariser Restyling

## Status
Draft

## Goals
- Restyle the SillyTavern-SceneSummariser UI to improve user experience.
- Implement a more intuitive and visually appealing interface for managing scene summaries and memories, migrating to a tabbed navigation system.
- Standardize the UI components (toggles, sliders, buttons) to match the provided mockup while maintaining existing functionality.

## Proposed Solution

Based on the provided `mockup.html`, the UI will be overhauled to adopt a modern, dark-themed, tabbed interface. The core content and functionality of the extension will remain unchanged, but it will be visually reorganized into the new structural paradigm.

### 1. Structural Changes (HTML)
- **Container Overhaul**: Wrap the main extension UI in a `.st-extension` container.
- **Header & Global Toggles**: Implement a dedicated `.extension-header` and `.global-enable-row` above the tab navigation.
- **Tabbed Interface**: Migrate from a single vertical list/accordion layout to a tabbed layout using `.tabs` and `.tab-content` classes. The planned tabs are:
  - Settings
  - Memory
  - Snapshots
- **Section Grouping**: Wrap logically related form elements inside `.section` containers with inset backgrounds and `.section-header-row` titles.
- **Form Controls**: Replace standard checkboxes with the custom `.switch` toggle UI. Wrap labels and inputs in `.control-group` containers with `.block-label` styling. Use the new `.range-wrapper` for sliders.
- **Content Porting**: Existing elements (like the Scene Extraction popup fields) will be fitted into this new structural format (e.g., placed within appropriate `.section` blocks) without altering their underlying IDs or data bindings so the JS remains functional.

### 2. Styling Changes (CSS)
- **CSS Variables**: Introduce the theme variables (`--accent-color`, `--bg-panel`, `--bg-section`, `--bg-input`, etc.) from the mockup. Where possible, these should be mapped or scoped so they do not conflict with the broader SillyTavern theme while maintaining the mockup's distinct look.
- **Component Styling**:
  - Implement the `.switch` custom toggle CSS.
  - Implement custom `input[type=range]` styling.
  - Implement `.btn`, `.icon-btn`, and `.badge` styles with defined hover states.
  - Style list elements like `.memory-block` and `.snapshot-item` as defined in the mockup.

### 3. Implementation Plan
1.  **Refactor `style.css`**: Integrate the CSS rules from the mockup into the extension's stylesheet.
2.  **Refactor HTML generation**: Update `popup.html` and any JavaScript that generates UI (e.g., in `index.js`) to output the new nested DOM structure (Tabs -> Sections -> Control Groups).
3.  **Implement Interactions**: Add the simple JavaScript required to handle tab switching.
4.  **Verification**: Ensure that all existing data bindings, button clicks, and dynamic UI updates (like adding a memory block) still function correctly within the new DOM structure.