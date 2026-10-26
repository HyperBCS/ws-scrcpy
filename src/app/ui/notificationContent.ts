export type NotificationMediaKind = 'image' | 'video' | 'audio';
export type NotificationTextPart = { text: string; href?: string; media?: NotificationMediaKind };
export type NotificationMediaLink = { href: string; kind: NotificationMediaKind; host: string; name: string };

function mediaKind(url: URL): NotificationMediaKind | undefined {
    // HTTP links remain clickable, but embedding them would fail on the HTTPS PWA.
    if (url.protocol !== 'https:') return undefined;
    const extension = url.pathname.split('.').pop()?.toLowerCase();
    if (extension && ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp'].includes(extension)) return 'image';
    if (extension && ['mp4', 'm4v', 'mov', 'webm', 'ogv'].includes(extension)) return 'video';
    if (extension && ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac'].includes(extension)) return 'audio';
    return undefined;
}

/** Treat notification content as plain text; never interpret HTML from an app. */
export function notificationTextParts(text: string): NotificationTextPart[] {
    const parts: NotificationTextPart[] = [];
    const urls = /\bhttps?:\/\/[^\s<>"'`\p{Cc}\p{Cf}\u2018\u2019\u201c\u201d]+/giu;
    let end = 0;
    for (const match of text.matchAll(urls)) {
        let candidate = match[0];
        // Leave sentence punctuation outside links, retaining balanced URL parentheses.
        while (candidate) {
            const trimmed = candidate.replace(/[.,!?;:]+$/, '');
            if (trimmed !== candidate) {
                candidate = trimmed;
                continue;
            }
            const close = candidate.slice(-1);
            const open = { ')': '(', ']': '[', '}': '{' }[close];
            if (open && candidate.split(close).length > candidate.split(open).length)
                candidate = candidate.slice(0, -1);
            else break;
        }
        let url: URL;
        try {
            url = new URL(candidate);
        } catch {
            continue;
        }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || candidate.includes('\\'))
            continue;
        const start = match.index!;
        if (start > end) parts.push({ text: text.slice(end, start) });
        parts.push({ text: candidate, href: url.href, media: mediaKind(url) });
        end = start + candidate.length;
    }
    if (end < text.length) parts.push({ text: text.slice(end) });
    return parts;
}

export function notificationMediaLinks(texts: Array<string | undefined>): NotificationMediaLink[] {
    const links = new Map<string, NotificationMediaLink>();
    for (const text of texts) {
        for (const part of notificationTextParts(text || '')) {
            if (!part.href || !part.media || links.has(part.href)) continue;
            const url = new URL(part.href);
            let name = url.pathname.split('/').pop() || part.media;
            try {
                name = decodeURIComponent(name);
            } catch {
                // Keep the original filename if percent escaping is malformed.
            }
            links.set(part.href, { href: part.href, kind: part.media, host: url.host, name });
            // Bound the UI even if a single notification contains many URLs.
            if (links.size === 4) return [...links.values()];
        }
    }
    return [...links.values()];
}
