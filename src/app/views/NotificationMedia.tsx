import { AutoHeight } from '../ui/AutoHeight';
import { Button, buttonClass } from '../ui/Button';
import { InlineStatus } from '../ui/InlineStatus';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { notificationTextParts, NotificationMediaLink } from '../ui/notificationContent';

export function NotificationText({ text }: { text: string }) {
    return (
        <>
            {notificationTextParts(text).map((part, index) =>
                part.href ? (
                    <a
                        key={index}
                        class="notification-link"
                        href={part.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        referrerPolicy="no-referrer"
                    >
                        {part.text}
                    </a>
                ) : (
                    part.text
                ),
            )}
        </>
    );
}

function LoadedMedia({ link, failed }: { link: NotificationMediaLink; failed: () => void }) {
    const player = useRef<HTMLMediaElement>(null);
    const playerRef = (element: HTMLMediaElement | null) => {
        player.current = element;
    };
    useLayoutEffect(() => {
        const element = player.current;
        return () => {
            if (!element) return;
            element.pause();
            element.removeAttribute('src');
            element.load();
        };
    }, []);
    if (link.kind === 'image')
        return (
            <img
                class="notification-media-content"
                src={link.href}
                alt={link.name}
                referrerPolicy="no-referrer"
                onError={failed}
            />
        );
    if (link.kind === 'video')
        return (
            <video
                class="notification-media-content"
                ref={playerRef}
                src={link.href}
                controls
                playsInline
                preload="metadata"
                aria-label={link.name}
                onError={failed}
            />
        );
    return (
        <audio
            class="notification-media-content"
            ref={playerRef}
            src={link.href}
            controls
            preload="metadata"
            aria-label={link.name}
            onError={failed}
        />
    );
}

export function NotificationMedia({ link }: { link: NotificationMediaLink }) {
    const [state, setState] = useState<'idle' | 'loaded' | 'error'>('idle');
    return (
        <AutoHeight className="notification-media-size">
            <div class="notification-media">
                <div class="notification-media-caption">
                    <span class="notification-media-name" title={link.name}>
                        {link.name}
                    </span>
                    <span>{link.host}</span>
                </div>
                {state === 'loaded' && <LoadedMedia link={link} failed={() => setState('error')} />}
                {state === 'error' && (
                    <InlineStatus tone="warning">
                        Preview unavailable. The link may have expired or this format may not be supported.
                    </InlineStatus>
                )}
                <div class="notification-media-actions">
                    <Button
                        size="compact"
                        attributes={{
                            'aria-label': `${state === 'loaded' ? 'Hide' : state === 'error' ? 'Retry' : 'Load'} ${link.kind} from ${link.host}`,
                        }}
                        onClick={() => setState(state === 'loaded' ? 'idle' : 'loaded')}
                    >
                        {state === 'loaded' ? 'Hide' : state === 'error' ? 'Retry' : 'Load'} {link.kind}
                    </Button>
                    {/* The link carries attributes the button component does not take, so it is the kit class on a plain link. */}
                    <a
                        class={buttonClass({ variant: 'quiet', size: 'compact' })}
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        referrerPolicy="no-referrer"
                    >
                        Open {link.kind}
                    </a>
                </div>
            </div>
        </AutoHeight>
    );
}
