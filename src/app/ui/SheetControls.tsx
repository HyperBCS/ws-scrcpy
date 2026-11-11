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
import '../../style/ui/SheetControls.css';
import '../../style/kit/Group.css';

/**
 * The one layout every sheet uses for settings and actions: groups of rows, each row a title
 * with its own explanation on the left and the control that acts on it on the right. Nothing is
 * explained somewhere else on the sheet. Wide controls (`stack`) drop under the text; two-button
 * rows (`pair`) do so on narrow phones only.
 *
 * Each part takes `kit` for the kit look: the same part with the `kit-` class names of
 * `style/kit/Group.css`. Without it a part renders as it always has. The select row, the message
 * row and the footer are new and exist in the kit look only. The disclosure is `Disclosure` in
 * `AnimatedDetails.tsx`.
 */

interface KitOption {
    /** The kit look: other class names, the same behaviour. Without it nothing changes. */
    kit?: boolean;
}

interface SheetGroupProps extends KitOption {
    title?: string;
    hint?: ComponentChildren;
    class?: string;
    /** The outcome of this group's controls (`SheetStatus`), shown directly under its card. */
    status?: ComponentChildren;
    children: ComponentChildren;
}

export function SheetGroup({ title, hint, class: className, status, kit, children }: SheetGroupProps) {
    if (kit) {
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
    return (
        <section class={`sheet-group ${className || ''}`}>
            {title && <h3 class="sheet-group-title">{title}</h3>}
            {hint && <p class="sheet-group-hint">{hint}</p>}
            <AutoHeight className="sheet-group-card">{children}</AutoHeight>
            {status}
        </section>
    );
}

interface SheetRowProps extends KitOption {
    title: ComponentChildren;
    description?: ComponentChildren;
    // `stack`: control under the text. `pair`: beside the text, under it on narrow phones.
    layout?: 'inline' | 'stack' | 'pair';
    children?: ComponentChildren;
    // Anything the row wants to expose to tests or CSS (data-* attributes).
    attributes?: Record<string, string | undefined>;
}

export function SheetRow({ title, description, layout = 'inline', children, attributes, kit }: SheetRowProps) {
    if (kit) {
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
    return (
        <div class={`sheet-row ${layout}`} {...attributes}>
            <div class="sheet-row-text">
                <span class="sheet-row-title">{title}</span>
                {description && <span class="sheet-row-desc">{description}</span>}
            </div>
            {children && <div class="sheet-row-control">{children}</div>}
        </div>
    );
}

interface SheetToggleRowProps extends KitOption {
    title: ComponentChildren;
    description?: ComponentChildren;
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
}

/** The whole row turns the switch. The title names it and the description explains it. */
function KitToggleRow({ title, description, checked, disabled, onChange }: SheetToggleRowProps) {
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

export function SheetToggleRow({ kit, ...row }: SheetToggleRowProps) {
    if (kit) return <KitToggleRow {...row} />;
    const { title, description, checked, disabled, onChange } = row;
    return (
        <label class="sheet-row inline sheet-toggle-row">
            <div class="sheet-row-text">
                <span class="sheet-row-title">{title}</span>
                {description && <span class="sheet-row-desc">{description}</span>}
            </div>
            <div class="sheet-row-control">
                <input
                    type="checkbox"
                    class="sheet-switch"
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) => onChange(event.currentTarget.checked)}
                />
            </div>
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

/** A row whose control is a select, for a choice among more options than a segmented control holds. Kit look only. */
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

/** A row that holds a banner: a condition that blocks the rows of its card. Kit look only. */
export function SheetMessageRow({ tone, action, children }: SheetMessageRowProps) {
    return (
        <div class="kit-row kit-row-stack">
            <Banner tone={tone} action={action}>
                {children}
            </Banner>
        </div>
    );
}

/** The actions of a sheet, under its last group: buttons of equal width. Kit look only. */
export function SheetFooter({ children }: { children: ComponentChildren }) {
    return <div class="kit-footer">{children}</div>;
}

interface SheetStatusProps extends KitOption {
    tone?: 'neutral' | 'error' | 'success' | 'warning';
    children: ComponentChildren;
}

const STATUS_ICON_PATHS = {
    // Triangle with an exclamation mark.
    problem: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01',
    // Check mark in a circle.
    success: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM8 12.5l2.7 2.7L16 9.5',
};

/**
 * A short outcome line. Pass it as a group's `status` so it sits under the card whose control
 * produced it. The words stay in the normal text colour; the icon carries the tone. In the kit
 * look it is an `InlineStatus`.
 */
export function SheetStatus({ tone = 'neutral', kit, children }: SheetStatusProps) {
    if (kit) return <InlineStatus tone={tone}>{children}</InlineStatus>;
    const icon = tone === 'success' ? STATUS_ICON_PATHS.success : tone === 'neutral' ? '' : STATUS_ICON_PATHS.problem;
    return (
        <p class={`sheet-status ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
            {icon && (
                <svg
                    class="sheet-status-icon"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                >
                    <path d={icon} />
                </svg>
            )}
            {children}
        </p>
    );
}

interface VolumeSliderProps extends KitOption {
    session: AudioSession;
}

/** The slider alone, for sheets that lay their own rows out (Settings). */
export function VolumeSlider({ session, kit }: VolumeSliderProps) {
    const [volume, setVolume] = useState(() => Math.round(session.getVolume() * 100));
    return (
        <div class={kit ? 'kit-volume' : 'sheet-volume'}>
            <input
                type="range"
                class={kit ? 'kit-range' : undefined}
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

interface SoundRowsProps extends KitOption {
    session: AudioSession;
}

/**
 * Listen plus volume, as two rows, in the Actions sheet of both platforms. "Listen" is this
 * browser's playback; the phone's own volume keys are separate controls on the toolbar. The
 * status message doubles as the listen row's description, so "blocked" or "waiting" is read
 * next to the button that fixes it.
 */
export function SoundRows({ session, kit }: SoundRowsProps) {
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
                kit={kit}
            >
                {kit ? (
                    <Button
                        size="compact"
                        variant={muted ? 'primary' : 'secondary'}
                        disabled={unavailable}
                        onClick={toggle}
                    >
                        {label}
                    </Button>
                ) : (
                    <button
                        type="button"
                        class={`sheet-button ${muted ? 'primary' : ''}`}
                        disabled={unavailable}
                        onClick={toggle}
                    >
                        {label}
                    </button>
                )}
            </SheetRow>
            <SheetRow
                title="Volume"
                description="For this browser only. The phone's own volume is not changed."
                layout="stack"
                kit={kit}
            >
                <VolumeSlider session={session} kit={kit} />
            </SheetRow>
        </>
    );
}
