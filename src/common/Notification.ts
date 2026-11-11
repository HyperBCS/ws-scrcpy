export interface NotificationSource {
    id: string;
    address: string;
    name: string;
    apps: string[];
    preview: boolean;
}

export interface NotificationEvent {
    source: string;
    session: string;
    uid: number;
    event: 'added' | 'modified' | 'removed';
    preExisting?: boolean;
    app?: string;
    appName?: string;
    title?: string;
    subtitle?: string;
    body?: string;
    date?: string;
    canDismiss?: boolean;
    negativeActionLabel?: string;
}

export interface NotificationHistoryItem extends NotificationEvent {
    key: string;
    received: number;
    read: boolean;
    dismissed: boolean;
    active: boolean;
}

export interface NotificationSummary {
    unread: number;
    unreadBySource: Record<string, number>;
    sources: Array<{ id: string; name: string }>;
}

export interface NotificationStatus extends NotificationSummary {
    publicKey: string;
    publicUrl?: string;
    sources: NotificationSource[];
    bluetooth: Array<{ address: string; name: string; paired: boolean; connected: boolean }>;
    statuses: Record<string, string>;
    pairing: { address: string; code: string } | null;
    pairingOpen: boolean;
    // An iPhone asked to pair in the last 10 minutes while no pairing window was open.
    pairingRejected?: boolean;
    // Every current problem as one notice. The fields below give the parts.
    error: string;
    // The Bluetooth collector's last error, cleared once it has run for a while without one.
    collectorError?: string;
    // Collector restarts in a row; zero again after a minute of uptime.
    collectorRestarts?: number;
    // Set while notification history is not being saved.
    storageError?: string;
    // The last failed Bluetooth pairing in the past 10 minutes.
    pairingError?: { message: string; at: number } | null;
    // Totals for all receiving devices since the server started.
    delivery: { sent: number; failed: number; lastError: string };
    // The same per receiving device. `id` is the SHA-256 of the push endpoint.
    receivers?: Array<{ id: string; provider: string; sent: number; failed: number; lastError: string }>;
    // Changes whenever the stored notifications change; the page then fetches /history.
    historyRevision: string;
    // How many notifications the server holds for each iPhone.
    storedBySource: Record<string, number>;
    retentionDays?: number;
}

/** Reply of GET /history. */
export interface NotificationHistoryReply {
    revision: string;
    notifications: NotificationHistoryItem[];
}
