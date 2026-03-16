export const extensionName = 'SillyTavern-SceneSummariser';
export const settingsKey = extensionName;

export const defaultSettings = {
    enabled: true,
    autoSummarise: false,
    summaryPrompt: 'Ignore previous instructions. Summarize the most important facts and events in the story so far. If a summary already exists in your memory, use that as a base and expand with new facts. Limit the summary to {{words}} words or less. Your response should include nothing but the summary.',
    consolidationPrompt: 'Create a single, cohesive summary by merging the following scene summaries. Remove redundant information and ensure the narrative flows logically. Limit the final summary to {{words}} words or less. Your response should include nothing but the summary.',
    summaryWords: 200,
    storeHistory: true,
    maxSummaries: 5,
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
    keepMessagesCount: 0,
    connectionProfileId: '',
    manualSummaryLimit: 0, // 0 = unlimited
    summaryHistoryDepth: 0, // 0 = all
    // Memory extraction (§2)
    memoryExtractionEnabled: true,
    memoryPrompt: `You are an assistant tasked with updating a story's progression by summarizing recent events and extracting significant long-term character memories.

===== CONTEXT & INPUTS =====
Character Name: {{charName}}
Existing Memories (Do not repeat or remix): {{existingMemories}}

# ===== RECENT MESSAGES (Summarize and extract ONLY from here) =====
{{last_messages}}

===== UNIFIED OUTPUT FORMATTING INSTRUCTION =====
Your output must contain exactly two components, in this exact order, with absolutely NO conversational filler, headers, or commentary:

1. A single <summary> block containing the plot summary.
2. One or more <memory> blocks containing bulleted lists of extracted memories (or exactly NO_NEW_MEMORIES inside a single block if nothing significant occurred).

Example Output Structure:

<summary>
Raw summary text goes here...
</summary>
<memory>
* [{{charName}}, OtherNames — short description]
* Memory bullet 1
* Memory bullet 2
</memory>

===== SUMMARY RULES =====
1. Summarize ONLY the events in 'Recent Messages'. Focus strictly on plot progression and meaningful actions.
2. Do NOT recap the 'Story Context' and DO NOT continue the story.
3. Assume the reader is already familiar with the characters (e.g., use "Mary" rather than "Mary, a caring mother").
4. Limit the summary text to {{words}} words.

===== MEMORY EXTRACTION RULES =====
1. Extract only NEW facts, backstory reveals, relationship shifts, and emotional turning points NOT already covered by 'Existing Memories'.
2. Write in past tense, third person. Always refer to {{charName}} by name. No emojis. Do not quote dialogue verbatim.
3. Write about WHAT HAPPENED (outcomes), not the conversation itself or the step-by-step process. Never write "she told him about X" — write the actual fact: "X happened".
4. Group memories by encounter. Use ONE <memory> block per encounter/scene.
5. Start each block with a topic tag as the first bullet: "- [{{charName}}, OtherNames — short description]".
6. HARD LIMIT: Max 5 bullet points per block (excluding the topic tag). Keep only the most significant outcomes.
7. DO NOT EXTRACT: Meta-narration, step-by-step accounts, scene-setting, temporary physical states, or trivial details. Ask yourself: "Would {{charName}} bring this up unprompted weeks later?"

NEGATIVE MEMORY EXAMPLE (Do NOT write play-by-play like this):
<memory>
* Alex set the carrier down and opened the door.
* Flux emerged and walked toward the Roomba.
* Alex poured salmon pâté into a bowl.
* Flux ate the salmon and purred.
</memory>

POSITIVE MEMORY EXAMPLE (Summarize the outcome):
<memory>
* [Alex, Flux — adoption day and settling in]
* Alex adopted Flux, who immediately bonded with a custom Roomba in the apartment.
* Flux's first meal of premium salmon pâté triggered his first purr in the new home.
</memory>`,
    maxMemories: 0, // 0 = unlimited
};

export const chatStateDefaults = {
    currentSummary: '',
    summaryCounter: 0,
    lastSummarisedIndex: 0,
    sceneBreakMarkerId: '',
    sceneBreakMesId: null,
    snapshots: [],
    // Memory extraction (§2)
    memories: [],
    memoryCounter: 0,
};

export const legacyStateKeys = Object.keys(chatStateDefaults);

export const state = {
    settings: Object.assign({}, defaultSettings),
    buttonIntervalId: null,
    isSummarising: false,
    currentAbortController: null,
    debugMessages: [],
    settingsContainer: null,
    currentMemoryTab: 'All',
};
