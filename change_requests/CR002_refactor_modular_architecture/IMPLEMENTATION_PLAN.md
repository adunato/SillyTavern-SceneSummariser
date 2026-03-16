# Implementation Plan: CR002 Refactor Modular Architecture

## Overview
This document outlines the step-by-step implementation plan for refactoring `index.js` into a modular architecture. The refactoring will be done incrementally to ensure no functionality is broken. We will rely on ES Modules (`import`/`export`) which are supported by SillyTavern extensions.

## Phase 1: Directory Structure and Shared Constants
1.  **Create Directories**: Under the root of the extension, create the following directory structure:
    *   `src/`
    *   `src/core/`
    *   `src/state/`
    *   `src/storage/`
    *   `src/ui/`
    *   `src/utils/`
2.  **Extract Constants & Globals**: Create `src/constants.js`.
    *   Move `extensionName`, `settingsKey`, `defaultSettings`, `chatStateDefaults`, and `legacyStateKeys` into this file.
    *   Define shared state objects (e.g., a `state` object holding `settings`, `isSummarising`, `debugMessages`, etc.) so that modules can read/write shared state without cyclic dependencies.

## Phase 2: Utilities and Storage Extraction
1.  **Logger Module (`src/utils/logger.js`)**:
    *   Extract `logDebug` and `copyLogs`.
    *   Ensure it references the shared `state.settings.debugMode` or is passed as an argument.
2.  **Memory Storage Module (`src/storage/memoryFileHandler.js`)**:
    *   Extract `getSSMemoryFileName`, `findSSMemoryAttachment`, `readSSMemoriesFile`, `writeSSMemoriesFile`, `appendSSMemoriesBlock`.
    *   Ensure SillyTavern core imports (`uploadFileAttachment`, `getFileAttachment`, etc.) are imported correctly.

## Phase 3: State Management Extraction
1.  **State Manager (`src/state/stateManager.js`)**:
    *   Extract `getChatState`, `migrateLegacySnapshot`, `pullLegacyState`.
    *   This module will manage the fetching and initialization of chat-specific extension settings stored in `extension_settings`.

## Phase 4: Core Engine and LLM API
1.  **LLM API (`src/core/llmApi.js`)**:
    *   Extract `callSummarisationLLM` and related prompt formatting.
    *   Import necessary SillyTavern generation functions (`generateRaw`).
2.  **Summarization Engine (`src/core/engine.js`)**:
    *   Extract `buildExtractionPrompt`, `parseExtractionResponse`, `buildSummaryText`, `pruneMemories`, `getLatestSnapshot`, `reconcileMemories`.

## Phase 5: UI Components Extraction
1.  **Settings UI (`src/ui/settingsUI.js`)**:
    *   Extract `bindSettingsUI`, `updateSettingsUI`, `ensureSettings`, `mountSettings`, `togglePanel`.
2.  **Snapshot UI (`src/ui/snapshotUI.js`)**:
    *   Extract `renderSnapshotsList`, `handleSnapshotAction`, `handleSnapshotSelectionChange`.
3.  **Memory UI (`src/ui/memoryUI.js`)**:
    *   Extract `renderMemoriesList`.
4.  **Editor UI (`src/ui/editorUI.js`)**:
    *   Extract `showSummaryEditor`, `showCombinedEditor`.
5.  **Action Buttons (`src/ui/buttons.js`)**:
    *   Extract `createSummariseButton`, `placeSummariseButton`, `startButtonMount`, `onSummariseClick`, `onBatchSummariseClick`, `onConsolidateClick`.

## Phase 6: Context Injection
1.  **Injector (`src/core/injector.js`)**:
    *   Extract `applyInjection`, `filterContextInterceptor`, `insertSceneBreakMarker`, `updateInjectionVisibility`, `updateContextControlVisibility`.
    *   Ensure all prompt types and roles are imported from SillyTavern scripts.

## Phase 7: Wiring `index.js`
1.  **Main Entry (`index.js`)**:
    *   Import initialization functions from the `src/` modules.
    *   Setup the main SillyTavern extension lifecycle hooks (e.g., `jQuery(document).ready()`).
    *   Register `eventSource.on(event_types.CHAT_CHANGED, onChatChanged)`.
    *   Register context interceptors.
    *   Ensure the file is significantly reduced in size, acting purely as a bootstraper and event orchestrator.

## Phase 8: Testing and Validation
1.  Verify the extension loads without syntax errors.
2.  Verify the settings panel renders and saves correctly.
3.  Perform a manual summarization to ensure LLM calls and UI updates work.
4.  Check that memories are extracted, displayed, and saved to the Data Bank correctly.
5.  Ensure prompt injection is inserting the summary correctly into the context.

## Commit Strategy
Each phase will be committed separately to the current branch (`change/CR002-refactor_modular_architecture`) to maintain a clean history and allow for easy rollbacks if a specific extraction introduces bugs.