import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { NotificationSource } from '../../common/Notification';
import type { HistoryItem } from './NotificationHistory';
import { notificationIcon } from '../state/notifications';
import { NotificationSwipe, NotificationSwipeAction } from '../ui/notificationSwipe';
import { bindNotificationTouch } from '../ui/notificationTouch';
import { notificationMediaLinks } from '../ui/notificationContent';
import { NotificationMedia, NotificationText } from './NotificationMedia';
import { animate, finished, MOTION } from '../ui/motion';
import { AutoHeight } from '../ui/AutoHeight';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { notificationTime } from './notifications/inbox';
import '../../style/views/NotificationsInbox.css';

/** The app's icon from the iPhone, or its first letter where the server has none. Setup lists apps with it too. */
export function AppIcon({ source, app, name }: { source: string; app?: string; name: string }) {
    const [url, setUrl] = useState('');
    useEffect(() => {
        let alive = true;
        let objectUrl = '';
        setUrl('');
        if (app)
            void notificationIcon(source, app).then((blob) => {
                if (alive && blob) {
                    objectUrl = URL.createObjectURL(blob);
                    setUrl(objectUrl);
                }
            });
        return () => {
            alive = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [source, app]);
    return (
        <span class="notification-app-icon" aria-hidden="true">
            {url ? (
                <img class="notification-app-image" src={url} alt="" onError={() => setUrl('')} />
            ) : (
                name.slice(0, 1).toLocaleUpperCase()
            )}
        </span>
    );
}

export function NotificationCard({
    item: n,
    source,
    busy,
    highlighted,
    markRead,
    dismiss,
    openMenu,
    openScreen,
    removeOnRead,
    onExpand,
    showSource = false,
    menuIsPopover = false,
}: {
    item: HistoryItem;
    source: NotificationSource;
    busy: boolean;
    highlighted: boolean;
    markRead: () => Promise<void>;
    dismiss: () => Promise<void>;
    openMenu: (anchor?: HTMLElement) => void;
    // Enter on the focused card, or a double-click with a mouse, opens the iPhone's screen.
    openScreen: () => void;
    removeOnRead: boolean;
    onExpand?: (expanded: boolean) => void;
    showSource?: boolean;
    menuIsPopover?: boolean;
}) {
    // A double tap on a touch screen is too easy to make by accident to start a stream.
    const lastPointer = useRef('');
    const [expanded, setExpanded] = useState(false);
    const [overflow, setOverflow] = useState(false);
    const expand = () => {
        onExpand?.(!expanded);
        setExpanded(!expanded);
    };
    const [offset, setOffset] = useState(0);
    const [direction, setDirection] = useState(0);
    const [committing, setCommitting] = useState(false);
    const offsetRef = useRef(0);
    const committingRef = useRef(false);
    const exitAnimation = useRef<Animation>();
    const rowAnimation = useRef<Animation>();
    const row = useRef<HTMLDivElement>(null);
    const showPreview = source.preview !== false;
    const media = showPreview ? notificationMediaLinks([n.title, n.subtitle, n.body]) : [];
    const preview = useRef<HTMLDivElement>(null);
    const card = useRef<HTMLElement>(null);
    const swipe = useRef(new NotificationSwipe());
    const suppressClick = useRef(0);
    const nativeTouch = 'ontouchstart' in window;
    const touch = useRef<ReturnType<typeof bindNotificationTouch>>();
    const latest = useRef({ busy, dismissed: n.dismissed, markRead, dismiss, removeOnRead });
    latest.current = { busy, dismissed: n.dismissed, markRead, dismiss, removeOnRead };
    const moveSwipe = (value: number) => {
        if (committingRef.current) return;
        offsetRef.current = value;
        setOffset(value);
        if (value) {
            setDirection(Math.sign(value));
            suppressClick.current = Date.now() + 400;
        }
    };
    const finishSwipe = async (action: NotificationSwipeAction, velocity = 0) => {
        if (committingRef.current || latest.current.busy || latest.current.dismissed) {
            moveSwipe(0);
            return;
        }
        const node = card.current;
        const container = row.current;
        if (!node || !container) return;
        const apply = action === 'read' ? latest.current.markRead : latest.current.dismiss;
        const removing = action === 'dismiss' || latest.current.removeOnRead;
        const height = container.getBoundingClientRect().height;
        // The space under a row closes with it. The stylesheet sets how much that is.
        const gap = getComputedStyle(container).marginBottom;
        committingRef.current = true;
        setCommitting(true);
        suppressClick.current = Date.now() + 400;
        try {
            const end = removing ? (action === 'dismiss' ? -1 : 1) * (node.clientWidth + 24) : 0;
            const remaining = Math.abs(end - offsetRef.current);
            exitAnimation.current = animate(
                node,
                [
                    { transform: `translateX(${offsetRef.current}px)`, opacity: 1 },
                    { transform: `translateX(${end}px)`, opacity: removing ? 0 : 1 },
                ],
                {
                    duration: removing
                        ? Math.max(160, Math.min(280, remaining / (Math.abs(velocity) || 1.5)))
                        : MOTION.settle,
                },
            );
            if (removing) {
                rowAnimation.current = animate(
                    container,
                    [
                        { height: `${height}px`, marginBottom: gap, opacity: 1 },
                        { height: '0px', marginBottom: '0px', opacity: 0 },
                    ],
                    { duration: 260, delay: 60 },
                );
            }
            await Promise.all([finished(exitAnimation.current), finished(rowAnimation.current)]);
            if (!node.isConnected) return;
            await apply();
        } finally {
            const fromHeight = container.getBoundingClientRect().height;
            const fromTransform = getComputedStyle(node).transform;
            exitAnimation.current?.cancel();
            rowAnimation.current?.cancel();
            exitAnimation.current = undefined;
            rowAnimation.current = undefined;
            if (node.isConnected) {
                // A failed request (or dismissal while viewing history) returns the same card.
                setOffset(0);
                offsetRef.current = 0;
                if (removing) {
                    rowAnimation.current = animate(container, [
                        { height: `${fromHeight}px`, marginBottom: '0px', opacity: 0 },
                        { height: `${height}px`, marginBottom: gap, opacity: 1 },
                    ]);
                    exitAnimation.current = animate(node, [
                        { transform: fromTransform, opacity: 0 },
                        { transform: 'translateX(0)', opacity: 1 },
                    ]);
                    await Promise.all([finished(rowAnimation.current), finished(exitAnimation.current)]);
                    rowAnimation.current?.cancel();
                    exitAnimation.current?.cancel();
                    rowAnimation.current = exitAnimation.current = undefined;
                }
                setCommitting(false);
            }
            committingRef.current = false;
        }
    };
    const cancelSwipe = () => {
        touch.current?.cancel();
        const id = swipe.current.pointerId;
        swipe.current.cancel();
        moveSwipe(0);
        if (id !== null && card.current?.hasPointerCapture(id)) card.current.releasePointerCapture(id);
    };
    useLayoutEffect(() => {
        if (!nativeTouch || !card.current) return;
        const binding = bindNotificationTouch(card.current, {
            enabled: () => !latest.current.busy && !latest.current.dismissed && !committingRef.current,
            offset: moveSwipe,
            action: (action, velocity) => void finishSwipe(action, velocity),
        });
        touch.current = binding;
        return () => {
            binding.release();
            touch.current = undefined;
        };
    }, [nativeTouch]);
    useEffect(() => {
        const node = preview.current;
        if (!node) return;
        let frame = 0;
        const measure = () => setOverflow(expanded || node.scrollHeight > node.clientHeight + 1);
        const schedule = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(measure);
        };
        schedule();
        const observer = new ResizeObserver(schedule);
        observer.observe(node);
        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame);
        };
    }, [n.title, n.subtitle, n.body, expanded]);
    useEffect(() => {
        const otherPointer = (event: PointerEvent) => {
            if (nativeTouch && event.pointerType === 'touch') return;
            const id = swipe.current.pointerId;
            if (id !== null && event.pointerId !== id) cancelSwipe();
        };
        const endedOutside = (event: PointerEvent) => {
            if (nativeTouch && event.pointerType === 'touch') return;
            if (swipe.current.pointerId === event.pointerId) cancelSwipe();
        };
        window.addEventListener('pointerdown', otherPointer, true);
        window.addEventListener('pointerup', endedOutside);
        window.addEventListener('pointercancel', endedOutside);
        window.addEventListener('blur', cancelSwipe);
        return () => {
            window.removeEventListener('pointerdown', otherPointer, true);
            window.removeEventListener('pointerup', endedOutside);
            window.removeEventListener('pointercancel', endedOutside);
            window.removeEventListener('blur', cancelSwipe);
            swipe.current.cancel();
            exitAnimation.current?.cancel();
            rowAnimation.current?.cancel();
        };
    }, []);
    useEffect(cancelSwipe, [busy, n.read, n.dismissed]);
    return (
        <div
            ref={row}
            style={{ '--swipe-distance': `${Math.abs(offset)}px` }}
            data-notification-key={n.key}
            class={`notification-swipe-row ${direction > 0 ? 'swipe-read' : 'swipe-dismiss'} ${committing ? 'committing' : ''} ${Math.abs(offset) >= Math.max(56, Math.min(88, (card.current?.clientWidth || 256) * 0.25)) ? 'swipe-ready' : ''}`}
        >
            <div class="notification-swipe-reveal" aria-hidden="true">
                <Icon name={direction > 0 ? (n.read ? 'mail' : 'check') : 'archive'} size={20} />
                <span class="notification-swipe-label">{direction > 0 ? (n.read ? 'Unread' : 'Read') : 'Archive'}</span>
            </div>
            <article
                ref={card}
                tabIndex={0}
                style={offset ? { transform: `translateX(${offset}px)` } : undefined}
                aria-busy={committing || undefined}
                class={`notification-history-item ${!n.read ? 'unread' : ''} ${n.dismissed ? 'dismissed' : ''} ${highlighted ? 'highlighted' : ''} ${offset && !committing ? 'swiping' : ''}`}
                onKeyDown={(event) => {
                    if (event.key === ' ' && event.target === event.currentTarget) {
                        event.preventDefault();
                        if (!busy && !event.repeat) expand();
                    } else if (event.key === 'Enter' && event.target === event.currentTarget) {
                        event.preventDefault();
                        openScreen();
                    }
                }}
                onDblClick={(event) => {
                    if (
                        lastPointer.current === 'mouse' &&
                        !(
                            event.target instanceof Element &&
                            event.target.closest(
                                'button, a, input, select, textarea, video, audio, .notification-media',
                            )
                        )
                    )
                        openScreen();
                }}
                onPointerDown={(event) => {
                    lastPointer.current = event.pointerType;
                    if (nativeTouch && event.pointerType === 'touch') return;
                    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
                    if (!event.isPrimary) {
                        cancelSwipe();
                        return;
                    }
                    if (
                        busy ||
                        committingRef.current ||
                        n.dismissed ||
                        event.button > 0 ||
                        (event.target instanceof Element &&
                            event.target.closest(
                                'button, a, input, select, textarea, video, audio, .notification-media',
                            ))
                    )
                        return;
                    swipe.current.start(event.clientX, event.clientY, event.pointerId, event.currentTarget.clientWidth);
                }}
                onPointerMove={(event) => {
                    if (nativeTouch && event.pointerType === 'touch') return;
                    if (swipe.current.pointerId !== event.pointerId) return;
                    const state = swipe.current.move(event.clientX, event.clientY, event.pointerId);
                    if (state.locked === 'vertical') {
                        cancelSwipe();
                        return;
                    }
                    if (state.locked === 'horizontal') {
                        if (event.cancelable) event.preventDefault();
                        if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
                            try {
                                event.currentTarget.setPointerCapture(event.pointerId);
                            } catch {
                                /* A cancelled native pointer is ignored on release. */
                            }
                        }
                    }
                    moveSwipe(state.offset);
                }}
                onPointerUp={(event) => {
                    if (nativeTouch && event.pointerType === 'touch') return;
                    if (swipe.current.pointerId !== event.pointerId) return;
                    const action = swipe.current.end(event.clientX, event.clientY, event.pointerId);
                    if (event.currentTarget.hasPointerCapture(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId);
                    if (action) void finishSwipe(action, swipe.current.releaseVelocity);
                    else moveSwipe(0);
                }}
                onPointerCancel={(event) => {
                    if (swipe.current.pointerId === event.pointerId) cancelSwipe();
                }}
                onLostPointerCapture={(event) => {
                    if (nativeTouch && event.pointerType === 'touch') return;
                    // Taking capture from the original text child emits a bubbled
                    // lost-capture event. Only losing this card's own capture ends it.
                    if (event.target === event.currentTarget && swipe.current.pointerId === event.pointerId)
                        cancelSwipe();
                }}
                onClick={(event) => {
                    if (
                        busy ||
                        committingRef.current ||
                        (event.target instanceof Element &&
                            event.target.closest(
                                'button, a, input, select, textarea, video, audio, .notification-media',
                            ))
                    )
                        return;
                    expand();
                }}
                onClickCapture={(event) => {
                    if (Date.now() < suppressClick.current) {
                        event.preventDefault();
                        event.stopPropagation();
                    }
                }}
            >
                <div class="notification-history-item-heading">
                    <AppIcon source={n.source} app={n.app} name={n.appName || n.app || 'App'} />
                    <div class="notification-history-app">
                        <span class="notification-app-name">{n.appName || n.app || 'iPhone app'}</span>
                        {showSource && <span class="notification-source-name-on-card">{source.name}</span>}
                        <time class="notification-time" dateTime={new Date(n.received).toISOString()}>
                            {notificationTime(n.received)}
                        </time>
                    </div>
                    {!n.read && <span class="notification-unread-dot" aria-label="Unread" />}
                    <IconButton
                        icon="more"
                        variant="bare"
                        label={`Actions for ${n.title || n.appName || n.app || 'notification'}`}
                        attributes={{ 'aria-haspopup': menuIsPopover ? 'menu' : 'dialog' }}
                        disabled={busy || committing}
                        onClick={(event) => openMenu(event.currentTarget as HTMLElement)}
                    />
                </div>
                <AutoHeight className="notification-preview-size">
                    <div
                        id={`notification-content-${n.key}`}
                        ref={preview}
                        class={`notification-preview ${expanded ? 'expanded' : ''}`}
                    >
                        {showPreview && n.title && (
                            <h3 class="notification-title">
                                <NotificationText text={n.title} />
                            </h3>
                        )}
                        {showPreview && n.subtitle && (
                            <p class="notification-line">
                                <NotificationText text={n.subtitle} />
                            </p>
                        )}
                        {showPreview && n.body && (
                            <p class="notification-line notification-body">
                                <NotificationText text={n.body} />
                            </p>
                        )}
                        {(!showPreview || (!n.title && !n.subtitle && !n.body)) && (
                            <p class="notification-help">
                                {source.preview === false ? 'Previews off.' : 'No preview available.'}
                            </p>
                        )}
                    </div>
                </AutoHeight>
                {overflow && (
                    <Button
                        variant="quiet"
                        size="compact"
                        class="notification-expand"
                        attributes={{
                            'aria-expanded': String(expanded),
                            'aria-controls': `notification-content-${n.key}`,
                        }}
                        onClick={expand}
                    >
                        {expanded ? 'Show less' : 'Show more'}
                    </Button>
                )}
                {!!media.length && (
                    <section
                        key={JSON.stringify([n.title, n.subtitle, n.body])}
                        class="notification-media-list"
                        aria-label="Media links"
                    >
                        {media.map((link) => (
                            <NotificationMedia key={link.href} link={link} />
                        ))}
                    </section>
                )}
                <div class="notification-card-actions" aria-label="Notification actions">
                    {!n.dismissed && (
                        <IconButton
                            icon={n.read ? 'mail' : 'check'}
                            variant="bare"
                            label={n.read ? 'Mark unread' : 'Mark read'}
                            disabled={busy || committing}
                            onClick={() => void markRead()}
                        />
                    )}
                    {!n.dismissed && (
                        <IconButton
                            icon="archive"
                            variant="bare"
                            label="Dismiss"
                            disabled={busy || committing}
                            onClick={() => void dismiss()}
                        />
                    )}
                    <IconButton
                        icon="phone"
                        variant="bare"
                        label="Open screen"
                        disabled={busy || committing}
                        onClick={openScreen}
                    />
                </div>
                {n.dismissed && <span class="notification-history-status">Archived</span>}
            </article>
        </div>
    );
}
