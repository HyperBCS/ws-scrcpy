import { ComponentChildren } from 'preact';
import { AutoHeight } from './AutoHeight';
import { useId, useState } from 'preact/hooks';
import type { AudioSession } from '../state/audio';
import { Banner, BannerTone } from './Banner';
import { Button } from './Button';
import { Icon } from './Icon';
import { InlineStatus } from './InlineStatus';
import { Switch } from './Switch';
import type { SelectOption } from './Field';
import '../../style/kit/Group.css';

/**
 * The one layout every sheet uses for settings and actions: groups of rows, each row a title
 * with its own explanation on the left and the control that acts on it on the right. Nothing is
 * explained somewhere else on the sheet. Wide controls (`stack`) drop under the text; two-button
 * rows (`pair`) do so on narrow phones only. The class names are those of `style/kit/Group.css`.
 * The disclosure is `Disclosure` in `AnimatedDetails.tsx`, and the actions that end a sheet go in
 * the `footer` of `Sheet`.
 */

interface SheetGroupProps {
    title?: string;
    hint?: ComponentChildren;
    class?: string;
    /** The outcome of this group's controls (`SheetStatus`), shown directly under its card. */
    status?: ComponentChildren;
    children: ComponentChildren;
}

export function SheetGroup({ title, hint, class: className, status, children }: SheetGroupProps) {
    // The hint goes under the card, after the outcome of the card's controls.
    return (
        <section class={`kit-group ${className || ''}`.trim()}>
            {title && <h3 class="kit-group-title">{title}</h3>}
            <AutoHeight className="kit-card kit-list">{children}</AutoHeight>
            {status}
            {hint && <p class="kit-group-hint">{hint}</p>}
        </section>
    );
}

interface SheetRowProps {
    title: ComponentChildren;
    description?: ComponentChildren;
    // `stack`: control under the text. `pair`: beside the text, under it on narrow phones.
    layout?: 'inline' | 'stack' | 'pair';
    children?: ComponentChildren;
    // Anything the row wants to expose to tests or CSS (data-* attributes).
    attributes?: Record<string, string | undefined>;
}

export function SheetRow({ title, description, layout = 'inline', children, attributes }: SheetRowProps) {
    return (
        <div class={`kit-row ${layout === 'inline' ? '' : `kit-row-${layout}`}`.trim()} {...attributes}>
            <div class="kit-row-text">
                <span class="kit-row-title">{title}</span>
                {description && <span class="kit-row-desc">{description}</span>}
            </div>
            {children && <div class="kit-row-control">{children}</div>}
        </div>
    );
}

interface SheetToggleRowProps {
    title: ComponentChildren;
    description?: ComponentChildren;
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
}

/** The whole row turns the switch. The title names it and the description explains it. */
export function SheetToggleRow({ title, description, checked, disabled, onChange }: SheetToggleRowProps) {
    const id = useId();
    return (
        <label class="kit-row kit-row-toggle">
            <div class="kit-row-text">
                <span class="kit-row-title" id={`${id}-title`}>
                    {title}
                </span>
                {description && (
                    <span class="kit-row-desc" id={`${id}-desc`}>
                        {description}
                    </span>
                )}
            </div>
            <Switch
                checked={checked}
                disabled={disabled}
                onChange={onChange}
                labelledBy={`${id}-title`}
                describedBy={description ? `${id}-desc` : undefined}
            />
        </label>
    );
}

interface SheetSelectRowProps {
    title: ComponentChildren;
    description?: ComponentChildren;
    value: string;
    options: ReadonlyArray<SelectOption>;
    disabled?: boolean;
    onChange: (value: string) => void;
}

/** A row whose control is a select, for a choice among more options than a segmented control holds. */
export function SheetSelectRow({ title, description, value, options, disabled, onChange }: SheetSelectRowProps) {
    const id = useId();
    return (
        <div class="kit-row">
            <div class="kit-row-text">
                <span class="kit-row-title" id={`${id}-title`}>
                    {title}
                </span>
                {description && (
                    <span class="kit-row-desc" id={`${id}-desc`}>
                        {description}
                    </span>
                )}
            </div>
            <div class="kit-row-control kit-row-control-select">
                <span class="kit-select">
                    <select
                        class="kit-field"
                        value={value}
                        disabled={disabled}
                        aria-labelledby={`${id}-title`}
                        aria-describedby={description ? `${id}-desc` : undefined}
                        onChange={(event) => onChange(event.currentTarget.value)}
                    >
                        {options.map((option) => (
                            <option key={option.value} value={option.value} disabled={option.disabled}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                    <Icon name="chevDown" size={16} />
                </span>
            </div>
        </div>
    );
}

interface SheetMessageRowProps {
    tone?: BannerTone;
    /** The one thing to do about it. */
    action?: { label: string; run: () => void; busy?: boolean; disabled?: boolean };
    children: ComponentChildren;
}

/** A row that holds a banner: a condition that blocks the rows of its card. */
export function SheetMessageRow({ tone, action, children }: SheetMessageRowProps) {
    return (
        <div class="kit-row kit-row-stack">
            <Banner tone={tone} action={action}>
                {children}
            </Banner>
        </div>
    );
}

interface SheetStatusProps {
    tone?: 'neutral' | 'error' | 'success' | 'warning';
    children: ComponentChildren;
}

/**
 * A short outcome line, an `InlineStatus`. Pass it as a group's `status` so it sits under the
 * card whose control produced it.
 */
export function SheetStatus({ tone = 'neutral', children }: SheetStatusProps) {
    return <InlineStatus tone={tone}>{children}</InlineStatus>;
}

/** The slider alone, for sheets that lay their own rows out (Settings). */
export function VolumeSlider({ session }: { session: AudioSession }) {
    const [volume, setVolume] = useState(() => Math.round(session.getVolume() * 100));
    return (
        <div class="kit-volume">
            <input
                type="range"
                class="kit-range"
                min="0"
                max="100"
                step="1"
                value={volume}
                aria-label="Volume"
                aria-valuetext={`${volume}%`}
                onInput={(event) => {
                    const next = Number(event.currentTarget.value);
                    setVolume(next);
                    session.setVolume(next / 100);
                }}
            />
            <output aria-hidden="true">{volume}%</output>
        </div>
    );
}

/**
 * Listen plus volume, as two rows, in the Actions sheet of both platforms. "Listen" is this
 * browser's playback; the phone's own volume keys are separate controls on the toolbar. The
 * status message doubles as the listen row's description, so "blocked" or "waiting" is read
 * next to the button that fixes it.
 */
export function SoundRows({ session }: { session: AudioSession }) {
    const status = session.status.value;
    const muted = session.isMuted() || status.state === 'blocked';
    const unavailable = status.state === 'disabled' || status.state === 'unsupported' || status.state === 'error';
    const toggle = () => (muted ? session.unmute() : session.mute());
    const label = muted ? 'Listen' : 'Stop listening';
    return (
        <>
            <SheetRow
                title="Listen in this browser"
                description={status.message}
                attributes={{ 'data-audio-state': status.state }}
            >
                <Button
                    size="compact"
                    variant={muted ? 'primary' : 'secondary'}
                    disabled={unavailable}
                    onClick={toggle}
                >
                    {label}
                </Button>
            </SheetRow>
            <SheetRow
                title="Volume"
                description="For this browser only. The phone's own volume is not changed."
                layout="stack"
            >
                <VolumeSlider session={session} />
            </SheetRow>
        </>
    );
}
