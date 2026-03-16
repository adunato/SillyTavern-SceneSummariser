import { getContext, extension_settings } from '../../../../../extensions.js';
import { settingsKey, defaultSettings, chatStateDefaults, legacyStateKeys } from '../constants.js';

export function getActiveChatId() {
    const ctx = getContext();
    const chatId = ctx?.getCurrentChatId?.();
    return chatId ?? '__no_chat__';
}

export function getActiveIntegrity() {
    const ctx = getContext();
    return ctx?.chatMetadata?.integrity || null;
}

export function migrateLegacySnapshot(chatState, settings) {
    // If legacy currentSummary exists and no snapshots yet, create one
    if (chatState.snapshots && chatState.snapshots.length) return;
    const legacySummary = settings.currentSummary || '';
    if (!legacySummary) return;
    const legacyId = chatState.summaryCounter || 0;
    const snapshot = {
        id: legacyId || 1,
        title: `Scene #${legacyId || 1}`,
        text: legacySummary,
        createdAt: Date.now(),
        fromIndex: 0,
        toIndex: 0,
        source: 'legacy',
    };
    chatState.snapshots = [snapshot];
    chatState.summaryCounter = snapshot.id;
}

export function pullLegacyState(settings) {
    const legacy = {};
    let found = false;
    for (const key of legacyStateKeys) {
        if (settings[key] !== undefined) {
            legacy[key] = settings[key];
            delete settings[key];
            found = true;
        }
    }
    return found ? legacy : null;
}

export function ensureSettings() {
    if (!extension_settings[settingsKey]) {
        extension_settings[settingsKey] = {};
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[settingsKey][key] === undefined) {
            extension_settings[settingsKey][key] = value;
        }
    }

    if (!extension_settings[settingsKey].chatStates || typeof extension_settings[settingsKey].chatStates !== 'object') {
        extension_settings[settingsKey].chatStates = {};
    }
    if (!extension_settings[settingsKey].chatStatesByIntegrity || typeof extension_settings[settingsKey].chatStatesByIntegrity !== 'object') {
        extension_settings[settingsKey].chatStatesByIntegrity = {};
    }
}

export function getChatState(chatId = null) {
    ensureSettings();
    const settings = extension_settings[settingsKey];
    const activeChatId = chatId || getActiveChatId();
    const integrity = getActiveIntegrity();

    if (!settings.chatStates[activeChatId]) {
        const legacy = pullLegacyState(settings);
        const integrityState = integrity && settings.chatStatesByIntegrity?.[integrity];

        settings.chatStates[activeChatId] = {
            ...chatStateDefaults,
            ...(integrityState || legacy || {}),
        };
    }

    migrateLegacySnapshot(settings.chatStates[activeChatId], settings);

    // Keep a by-integrity cache so forks that carry integrity can re-use state
    if (integrity) {
        if (!settings.chatStatesByIntegrity) settings.chatStatesByIntegrity = {};
        settings.chatStatesByIntegrity[integrity] = settings.chatStates[activeChatId];
    }

    return settings.chatStates[activeChatId];
}
