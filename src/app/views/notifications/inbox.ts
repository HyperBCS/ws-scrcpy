import type { NotificationHistoryItem } from '../../../common/Notification';

/** Local calendar days, rather than 24-hour intervals, also cover daylight-saving changes. */
export function notificationDay(time: number): string {
    const date = new Date(time);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function notificationDayLabel(time: number, now = Date.now()): string {
    if (notificationDay(time) === notificationDay(now)) return 'Today';
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (notificationDay(time) === notificationDay(yesterday.getTime())) return 'Yesterday';
    return new Date(time).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

export function notificationTime(time: number, now = Date.now()): string {
    const minutes = Math.floor((now - time) / 60000);
    if (minutes >= 0 && minutes < 1) return 'Just now';
    if (minutes >= 1 && minutes < 60) return `${minutes} min ago`;
    return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Only adjacent messages from the same conversation and calendar day share a stack. */
export function notificationStacks(items: NotificationHistoryItem[]): NotificationHistoryItem[][] {
    const stacks: NotificationHistoryItem[][] = [];
    for (const item of items) {
        const last = stacks[stacks.length - 1];
        const head = last?.[0];
        if (
            head &&
            head.app &&
            head.title &&
            head.source === item.source &&
            head.app === item.app &&
            head.title === item.title &&
            notificationDay(head.received) === notificationDay(item.received)
        )
            last.push(item);
        else stacks.push([item]);
    }
    return stacks;
}
