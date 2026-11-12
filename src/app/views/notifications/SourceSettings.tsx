import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { NotificationHistoryItem, NotificationSource } from '../../../common/Notification';
import { Disclosure } from '../../ui/AnimatedDetails';
import { Banner } from '../../ui/Banner';
import { Button } from '../../ui/Button';
import { ArmedAction, ConfirmPrompt } from '../../ui/ConfirmAction';
import { Switch } from '../../ui/Switch';
import { mutedApps, SeenApp, seenApps, withAppMuted } from '../../state/notificationSources';
import { AppIcon } from '../NotificationCard';

/**
 * A change to one iPhone's settings. It applies as soon as the control changes; `undo` is made
 * from the record as it is when Undo is pressed, so a later change is not lost.
 */
export interface SourceChange {
    apply: (source: NotificationSource) => NotificationSource;
    undo: (source: NotificationSource) => NotificationSource;
    /** What the toast says, beside Undo. */
    done: string;
}

interface SourceSettingsProps {
    source: NotificationSource;
    // How many of this iPhone's notifications the server holds; both prompts state the loss.
    stored: number;
    // The stored notifications of every iPhone. Setup lists the apps of this one's.
    items: NotificationHistoryItem[];
    busy: boolean;
    /**
     * The page's armed prompt. It is held by the page, so a prompt mounts in the page's render:
     * one that mounts in this component's own re-render can be given ids already in use.
     */
    confirm: ArmedAction<string>;
    /** Saves a change. Resolves false when the server refused it and the page says why. */
    change: (change: SourceChange) => Promise<boolean>;
    remove: () => void;
}

function joinNames(names: string[]): string {
    return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The settings of one sending iPhone: notification text, the older allow-list while it is set,
 * a switch for each app seen from it, and removal. A switch shows the new value while it is
 * saved, and the saved one again if the server refuses it.
 */
export function SourceSettings({ source, stored, items, busy, confirm, change, remove }: SourceSettingsProps) {
    const eraseText = `${source.id}:erase-text`;
    const removal = `${source.id}:remove`;
    const count = `${stored} stored notification${stored === 1 ? '' : 's'}`;
    const textRow = useRef<HTMLLabelElement>(null);
    const textId = useId();
    const [preview, setPreview] = useState<boolean>();
    const [shown, setShown] = useState<Record<string, boolean>>({});
    const apps = seenApps(source, items);
    const muted = mutedApps(source).length;
    const names = new Map(apps.map((entry) => [entry.app, entry.name]));

    const applyPreview = async (next: boolean) => {
        setPreview(next);
        await change({
            apply: (current) => ({ ...current, preview: next }),
            undo: (current) => ({ ...current, preview: !next }),
            done: next
                ? `New notifications from ${source.name} keep their text.`
                : `Notification text from ${source.name} is no longer stored.`,
        });
        setPreview(undefined);
    };
    const applyMute = async (entry: SeenApp, on: boolean) => {
        setShown((current) => ({ ...current, [entry.app]: on }));
        await change({
            apply: (current) => withAppMuted(current, entry.app, entry.name, !on),
            undo: (current) => withAppMuted(current, entry.app, entry.name, on),
            done: on ? `${entry.name} unmuted.` : `${entry.name} muted.`,
        });
        setShown(({ [entry.app]: _saved, ...rest }) => rest);
    };
    const clearList = () => {
        const previous = source.apps;
        void change({
            apply: (current) => ({ ...current, apps: [] }),
            undo: (current) => ({ ...current, apps: previous }),
            done: 'The older list was cleared.',
        });
    };

    return (
        <Disclosure title={`Settings for ${source.name}`}>
            <label class="kit-row kit-row-toggle" ref={textRow}>
                <div class="kit-row-text">
                    <span class="kit-row-title" id={`${textId}-title`}>
                        Include notification text
                    </span>
                    <span class="kit-row-desc" id={`${textId}-desc`}>
                        Missing message text? Check Show Previews in this iPhone’s notification settings.
                    </span>
                </div>
                <Switch
                    checked={preview ?? source.preview}
                    disabled={busy}
                    labelledBy={`${textId}-title`}
                    describedBy={`${textId}-desc`}
                    onChange={(next) => {
                        if (next || !stored) {
                            void applyPreview(next);
                            return;
                        }
                        // Turning text off also erases the text already stored, so it is
                        // confirmed first and the switch stays on until then.
                        const input = textRow.current?.querySelector('input');
                        if (input) input.checked = true;
                        confirm.arm(eraseText, textRow.current);
                    }}
                />
            </label>
            <div class="notification-details-content">
                {confirm.armed === eraseText && (
                    <ConfirmPrompt
                        action={confirm}
                        question={`Stop storing notification text from ${source.name}?`}
                        consequence={`The text of its ${count} is erased from the server and cannot be restored.`}
                        confirmLabel="Erase text"
                        danger
                        onConfirm={() => void applyPreview(false)}
                    />
                )}
                {source.apps.length > 0 && (
                    <section class="notification-only-apps" aria-labelledby={`${textId}-only`}>
                        <h4 class="notification-subheading" id={`${textId}-only`}>
                            Only these apps
                        </h4>
                        <Banner tone="info">
                            An older list is still active. Only{' '}
                            {joinNames(source.apps.map((app) => names.get(app) || app))} come through. Other apps are
                            not kept.
                        </Banner>
                        <Button disabled={busy} onClick={clearList}>
                            Clear the list and use muting
                        </Button>
                    </section>
                )}
                <Disclosure title="Apps" note={muted ? `${muted} muted` : 'None muted'}>
                    <AppSwitches
                        source={source}
                        apps={apps}
                        shown={shown}
                        busy={busy}
                        onChange={(entry, on) => void applyMute(entry, on)}
                    />
                </Disclosure>
                <div class="notification-remove-source">
                    <p class="notification-help">
                        Removing this iPhone deletes its link and its {count} from the server. Nothing changes on the
                        iPhone.
                    </p>
                    <Button variant="danger" disabled={busy} onClick={(e) => confirm.arm(removal, e.currentTarget)}>
                        Remove iPhone
                    </Button>
                    {confirm.armed === removal && (
                        <ConfirmPrompt
                            action={confirm}
                            question={
                                stored
                                    ? `Remove ${source.name} and delete its ${count}?`
                                    : `Remove ${source.name} from notification sharing?`
                            }
                            consequence="This cannot be undone. To share its notifications again, connect the iPhone again."
                            confirmLabel="Remove iPhone"
                            danger
                            onConfirm={remove}
                        />
                    )}
                </div>
            </div>
        </Disclosure>
    );
}

/**
 * A switch for each app seen from the iPhone: on, its notifications come through; off, it is
 * muted. The icons are asked for once the list is first opened, not when Setup is shown.
 */
function AppSwitches({
    source,
    apps,
    shown,
    busy,
    onChange,
}: {
    source: NotificationSource;
    apps: SeenApp[];
    shown: Record<string, boolean>;
    busy: boolean;
    onChange: (entry: SeenApp, on: boolean) => void;
}) {
    const id = useId();
    const anchor = useRef<HTMLDivElement>(null);
    const [opened, setOpened] = useState(false);
    useEffect(() => {
        const details = anchor.current?.closest('details');
        if (!details) return;
        const seen = () => {
            if (details.open) setOpened(true);
        };
        seen();
        details.addEventListener('toggle', seen);
        return () => details.removeEventListener('toggle', seen);
    }, []);
    return (
        <div ref={anchor} class="notification-app-switches">
            {apps.map((entry, index) => {
                const on = shown[entry.app] ?? !entry.muted;
                const note = !entry.listed ? 'Not on the list above, so not kept.' : on ? '' : 'Muted';
                return (
                    <label class="kit-row kit-row-toggle notification-app-row" key={entry.app}>
                        {opened ? (
                            <AppIcon source={source.id} app={entry.app} name={entry.name} />
                        ) : (
                            <span class="notification-app-icon" aria-hidden="true">
                                {entry.name.slice(0, 1).toLocaleUpperCase()}
                            </span>
                        )}
                        <div class="kit-row-text">
                            <span class="kit-row-title" id={`${id}-${index}`}>
                                {entry.name}
                            </span>
                            {note && (
                                <span class="kit-row-desc" id={`${id}-${index}-note`}>
                                    {note}
                                </span>
                            )}
                        </div>
                        <Switch
                            checked={on}
                            disabled={busy}
                            labelledBy={`${id}-${index}`}
                            describedBy={note ? `${id}-${index}-note` : undefined}
                            onChange={(next) => onChange(entry, next)}
                        />
                    </label>
                );
            })}
            <div class="notification-details-content">
                <p class="notification-help">
                    {apps.length
                        ? 'Turn an app off to mute it. Its new notifications are not kept and show no banner.'
                        : 'No notifications from this iPhone yet. Its apps appear here after their first notification.'}
                </p>
            </div>
        </div>
    );
}
