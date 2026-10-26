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
    error: string;
    delivery: { sent: number; failed: number; lastError: string };
    notifications: NotificationHistoryItem[];
    retentionDays?: number;
}
