# CR006: Group Chat Support

## Status
Draft

## Goals
- Provide full support for group chats when extracting and summarizing memories.
- Pass a comprehensive list of participating characters to the LLM prompt.
- Instruct the LLM to associate extracted facts specifically with the character(s) involved.
- Exclude the User from holding extracted memories, focusing only on the AI characters.
- Ensure only characters present in the provided list are assigned memories.
- Update the Snapshot UI to display extracted facts grouped by character using a tabbed interface.

## Proposed Solution & Implementation Plan

### 1. Context & Variable Resolution (`src/core/engine.js`)
- **Update `buildExtractionPrompt`**: Check if the current chat is a group chat (`chatState.groupId` or checking the context). 
- If it's a group chat, extract the list of group members (excluding the User). If 1-on-1, use just the main character.
- Provide a comma-separated list of these characters to the LLM as a new variable, e.g., `{{charNames}}`.

### 2. Prompt Template Updates (`src/constants.js`)
- **`memoryPrompt`**: Update the template instructions:
  - Replace `Character Name: {{charName}}` with `Participating Characters: {{charNames}}`.
  - Add rules explicitly stating that facts MUST be prefixed with the name of the character(s) holding the memory (e.g., `* CharacterName: fact...`).
  - Add a rule: "The user should not be accounted for. Only extract memories for the Participating Characters."
  - Add a rule: "Do not assign memories to characters not present in the Participating Characters list."
  - Update the Examples to reflect this multi-character prefix format.

### 3. Parsing Logic (`src/core/engine.js`)
- **Update `parseExtractionResponse`**: Update the parsing logic to handle the new prefix format (`* CharacterName: fact`).
- Parse the prefix to identify which character(s) the fact belongs to.
- Ensure the data structure for a single memory fact now includes the associated characters, e.g., `{ text: 'fact...', characters: ['CharacterA'] }`.
- Note: Since facts can belong to multiple characters, `characters` will be an array.

### 4. UI Adjustments (`src/ui/snapshotUI.js` & `popup.html`)
- **Review Popup (`src/ui/editorUI.js`)**: Keep the list flat but visually indicate or enforce the `CharacterName: ` prefix, or build a mini character-selector for each fact. For simplicity and robustness, editing the raw text with the prefix intact is the most reliable approach for the popup, matching the current flat list design but with prefixes.
- **Snapshot Accordion (`src/ui/snapshotUI.js`)**: 
  - Instead of a single flat list, parse the `snapshot.memories` array to group facts by their associated characters.
  - Implement a tabbed interface inside the `.ss-snapshot-memories` section.
  - Generate a tab for "All" and a tab for each unique character found in the memories.
  - Clicking a tab filters the displayed facts below it to only those associated with the selected character.

### 5. Data Bank Persistence (`src/storage/memoryFileHandler.js`)
- **`writeSSMemoriesFile`**: Ensure that when saving to the Data Bank, memories are written to the correct character's file. 
- In a group chat, the system should iterate over the unique characters found in the extracted facts and write/append the facts to each respective character's Data Bank attachment.
