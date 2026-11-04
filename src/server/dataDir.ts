import path from 'path';

/**
 * The server's private data directory: `WS_NOTIFICATION_DATA`, or `./data` under the working
 * directory. Notifications, push subscriptions and the iPhone settings store all live here, so
 * one env var moves them together. Read on each call so tests can point it at a temp dir.
 */
export function resolveDataDir(): string {
    return path.resolve(process.env.WS_NOTIFICATION_DATA || path.join(process.cwd(), 'data'));
}
