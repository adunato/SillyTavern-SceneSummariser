import { extensionName, state } from '../constants.js';

export function logDebug(level, ...args) {
    if (!state.settings?.debugMode) return;
    const ts = new Date().toISOString();
    const line = `[${extensionName}][${level.toUpperCase()}] ${ts} ${args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}`;
    state.debugMessages.push(line);
    if (state.debugMessages.length > 500) {
        state.debugMessages = state.debugMessages.slice(-500);
    }
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

export function copyLogs() {
    if (!state.debugMessages.length) {
        toastr.info('No logs to copy');
        return;
    }
    const text = state.debugMessages.join('\n');
    navigator.clipboard.writeText(text).then(() => {
        toastr.success('Debug logs copied to clipboard');
    }).catch(err => {
        console.error('Failed to copy logs:', err);
        toastr.error('Failed to copy logs');
    });
}
