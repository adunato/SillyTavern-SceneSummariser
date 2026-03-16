# Refactor index.js as a modular architecture

## Status
Draft

## Goals
* Break down the monolithic `index.js` (currently > 2500 lines) into smaller, maintainable, and logically grouped modules.
* Establish a robust architectural foundation for future extension features and bug fixes.
* Improve readability and separation of concerns without altering existing functionality.
* Ensure the new modular structure is easily extensible over time while remaining pragmatic for a SillyTavern extension.

## Proposed Solution
The logic currently housed in `index.js` will be reorganized into a `src/` directory with a clear folder structure based on responsibilities:

1.  **`src/index.js`**: The primary entry point. It will handle the extension bootstrap, module initialization, setting up global event listeners (e.g., `onChatChanged`), and exposing the necessary API.
2.  **`src/core/`**:
    *   **`engine.js`**: Core summarization and memory extraction orchestrators (`buildExtractionPrompt`, `parseExtractionResponse`, `buildSummaryText`).
    *   **`llmApi.js`**: Interface for LLM integration (`callSummarisationLLM`).
    *   **`injector.js`**: Logic for prompt injections and context interception (`applyInjection`, `filterContextInterceptor`).
3.  **`src/state/`**:
    *   **`stateManager.js`**: Management of the extension state, chat contexts, and migrations (`getChatState`, `migrateLegacySnapshot`, `pullLegacyState`).
4.  **`src/storage/`**:
    *   **`memoryFileHandler.js`**: Reading and writing memories to the file system (`readSSMemoriesFile`, `writeSSMemoriesFile`, `appendSSMemoriesBlock`).
5.  **`src/ui/`**:
    *   **`settingsUI.js`**: Binding and updating the main settings panel (`bindSettingsUI`, `updateSettingsUI`).
    *   **`snapshotUI.js`**: Rendering and handling the snapshot list (`renderSnapshotsList`, `handleSnapshotAction`).
    *   **`memoryUI.js`**: Rendering the long-term memory list (`renderMemoriesList`).
    *   **`editorUI.js`**: Functions managing editor popups for combined/summary views (`showSummaryEditor`, `showCombinedEditor`).
    *   **`buttons.js`**: Initialization and placement of summarization action buttons.
6.  **`src/utils/`**:
    *   **`config.js`**: Managing default settings and configuration loading (`ensureSettings`, `mountSettings`).
    *   **`logger.js`**: Unified logging framework (`logDebug`, `copyLogs`).

By exporting modular components and importing them within the entry file, `index.js` will become a slim orchestrator, ensuring separation of concerns and maintainability.