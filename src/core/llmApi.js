import { extension_settings } from '../../../../../extensions.js';
import { generateRaw } from '../../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../../shared.js';
import { extensionName, settingsKey } from '../constants.js';
import { logDebug } from '../utils/logger.js';

/**
 * Executes an LLM request for summarisation.
 * Tries the selected Connection Profile first, falls back to generateRaw.
 * @param {string} prompt Summarisation prompt.
 * @param {AbortSignal} [signal] Optional abort signal to cancel request.
 * @returns {Promise<string>} The raw LLM response text.
 */
export async function callSummarisationLLM(prompt, signal) {
    const settings = extension_settings[settingsKey];
    const profileId = settings?.connectionProfileId || '';

    console.debug(`[${extensionName}] Summarisation Prompt:\n`, prompt);

    if (profileId) {
        try {
            logDebug('log', `Using Connection Profile "${profileId}" for summarisation`);

            // ConnectionManagerRequestService does not cleanly expose an abort signal for sendRequest,
            // but we can wrap it in an abortable promise if needed, or see if it natively supports it.
            // For now, if aborted, we'll throw immediately.
            if (signal?.aborted) throw new Error('AbortError');

            return await new Promise((resolve, reject) => {
                const onAbort = () => reject(new Error('AbortError'));
                if (signal) signal.addEventListener('abort', onAbort);

                ConnectionManagerRequestService.sendRequest(
                    profileId,
                    prompt,
                    settings.summaryWords ? settings.summaryWords * 4 : 1024, // rough token estimate
                ).then(response => {
                    if (signal?.aborted) return reject(new Error('AbortError'));
                    resolve(response?.content ?? String(response ?? ''));
                }).catch(reject).finally(() => {
                    if (signal) signal.removeEventListener('abort', onAbort);
                });
            });
        } catch (err) {
            if (err?.message === 'AbortError' || String(err).includes('AbortError') || String(err).includes('aborted')) throw err;
            logDebug('error', 'Connection Profile request failed, falling back to generateRaw', err?.message || err);
            console.warn(`[${extensionName}] Connection Profile failed, falling back to main API:`, err);
        }
    }

    // Wrap generateRaw which also doesn't take signal cleanly in this version,
    // although ST core generation functions do support throwing if we just hook it up.
    // generateRaw does not accept an AbortSignal argument directly, but we can do a similar wrapper.
    if (signal?.aborted) throw new Error('AbortError');
    return await new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error('AbortError'));
        if (signal) signal.addEventListener('abort', onAbort);

        generateRaw({ prompt, trimNames: false, signal })
            .then(res => {
                if (signal?.aborted) return reject(new Error('AbortError'));
                resolve(res);
            })
            .catch(reject)
            .finally(() => {
                if (signal) signal.removeEventListener('abort', onAbort);
            });
    });
}
