export const extensionName = 'SillyTavern-SceneSummariser';
export const settingsKey = extensionName;

export const defaultSettings = {
    enabled: true,
    autoSummarise: false,
    summaryPrompt: 'Ignore previous instructions. Summarize the most important facts and events in the story so far. If a summary already exists in your memory, use that as a base and expand with new facts. Limit the summary to {{words}} words or less. Your response must include exactly three components:\n\n1. A single <title> block containing a brief title for the scene.\n2. A single <description> block containing a short description of the scene.\n3. A single <summary> block containing the plot summary.',
    consolidationPrompt: 'Create a single, cohesive summary by merging the following scene summaries. Remove redundant information and ensure the narrative flows logically. Limit the final summary to {{words}} words or less. Your response must include exactly three components:\n\n1. A single <title> block containing a brief title for the consolidated scene.\n2. A single <description> block containing a short description of the consolidated scene.\n3. A single <summary> block containing the merged plot summary.',
    summaryWords: 200,
    summariesToInject: 5, // Replaces storeHistory (bool) and maxSummaries (int)
    fullSummariesToInject: 0, // 0 = all
    debugMode: false,
    injectEnabled: true,
    injectPosition: 0, // In Prompt
    injectDepth: 2,
    injectScan: false,
    injectRole: 1, // System
    injectTemplate: '[Summary: {{summary}}]',
    limitToUnsummarised: false,
    insertSceneBreak: true,
    batchSize: 50,
    maxBatchSummaries: 0,
    previewBatchSummaries: false,
    keepMessagesCount: 0,
    connectionProfileId: '',
    manualSummaryLimit: 0, // 0 = unlimited
    summaryContextDepth: 0, // Replaces summaryHistoryDepth. 0 = all
    // Memory extraction (§2)
    memoryExtractionEnabled: true,
    memoryPrompt: `You are an assistant tasked with updating a story's progression by summarizing recent events and extracting significant long-term character memories.

===== CONTEXT & INPUTS =====
Participating Characters: {{charNames}}
Existing Memories (Do not repeat or remix): {{existingMemories}}

# ===== RECENT MESSAGES (Summarize and extract ONLY from here) =====
{{last_messages}}

===== UNIFIED OUTPUT FORMATTING INSTRUCTION =====
Your output must contain exactly four components, in this exact order, with absolutely NO conversational filler, headers, or commentary:

1. A single <title> block containing a brief title for the scene.
2. A single <description> block containing a short description of the scene.
3. A single <summary> block containing the plot summary.
4. A single <memory> block containing a bulleted list of extracted facts (or exactly NO_NEW_MEMORIES inside the block if nothing significant occurred).

Example Output Structure:

<title>
Scene Title
</title>
<description>
Short description of the scene.
</description>
<summary>
Raw summary text goes here...
</summary>
<memory>
* CharacterName: Memory bullet 1
* CharacterA, CharacterB: Memory bullet 2
</memory>

===== SUMMARY RULES =====
1. Summarize ONLY the events in 'Recent Messages'. Focus strictly on plot progression and meaningful actions.
2. Do NOT recap the 'Story Context' and DO NOT continue the story.
3. Assume the reader is already familiar with the characters.
4. Limit the summary text to {{words}} words.

===== MEMORY EXTRACTION RULES =====
1. Extract only NEW facts, backstory reveals, relationship shifts, and emotional turning points NOT already covered by 'Existing Memories'.
2. Write in past tense, third person. No emojis. Do not quote dialogue verbatim.
3. Write about WHAT HAPPENED (outcomes), not the conversation itself or the step-by-step process.
4. HARD LIMIT: Max 5 bullet points. Keep only the most significant outcomes.
5. DO NOT EXTRACT: Meta-narration, step-by-step accounts, scene-setting, temporary physical states, or trivial details.
6. Facts MUST be prefixed with the name of the character(s) holding the memory (e.g., "* CharacterName: fact...").
7. The user should not be accounted for. Only extract memories for the Participating Characters.
8. Do not assign memories to characters not present in the Participating Characters list.

NEGATIVE MEMORY EXAMPLE (Do NOT write play-by-play like this):
<memory>
* Alex: Alex set the carrier down and opened the door.
* Flux: Flux emerged and walked toward the Roomba.
* Alex: Alex poured salmon pâté into a bowl.
* Flux: Flux ate the salmon and purred.
</memory>

POSITIVE MEMORY EXAMPLE (Summarize the outcome):
<memory>
* Alex, Flux: Alex adopted Flux, who immediately bonded with a custom Roomba in the apartment.
* Flux: Flux's first meal of premium salmon pâté triggered his first purr in the new home.
</memory>`,
    maxMemories: 0, // 0 = unlimited
    // Semantic Injection settings
    fullMemoriesToInject: 2,
    semanticRetrievalEnabled: false,
    semanticSearchDepth: 5,
    semanticTopK: 5,
    semanticThreshold: 0.5,
};

export const chatStateDefaults = {
    currentSummary: '',
    summaryCounter: 0,
    lastSummarisedIndex: 0,
    sceneBreakMarkerId: '',
    sceneBreakMesId: null,
    snapshots: [],
};

export const legacyStateKeys = Object.keys(chatStateDefaults);

export const state = {
    settings: Object.assign({}, defaultSettings),
    buttonIntervalId: null,
    isSummarising: false,
    currentAbortController: null,
    debugMessages: [],
    settingsContainer: null,
};
