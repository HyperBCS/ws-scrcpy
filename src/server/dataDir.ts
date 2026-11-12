import { getSettings } from './Settings';

/**
 * The server's private data directory: `WS_DATA_DIR` (`WS_NOTIFICATION_DATA` remains an alias), or `./data` under the working
 * directory. Notifications, push subscriptions and the iPhone settings store all live here, so
 * one setting moves them together.
 */
export function resolveDataDir(): string {
    return getSettings().dataDir;
}
