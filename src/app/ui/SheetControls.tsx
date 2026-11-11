import { ComponentChildren } from 'preact';
import { AutoHeight } from './AutoHeight';
import { useState } from 'preact/hooks';
import type { AudioSession } from '../state/audio';
import '../../style/ui/SheetControls.css';

/**
 * The one layout every sheet uses for settings and actions: groups of rows, each row a title
 * with its own explanation on the left and the control that acts on it on the right. Nothing is
 * explained somewhere else on the sheet. Wide controls (`stack`) drop under the text; two-button
 * rows (`pair`) do so on narrow phones only.
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
    return (
        <section class={`sheet-group ${className || ''}`}>
            {title && <h3 class="sheet-group-title">{title}</h3>}
            {hint && <p class="sheet-group-hint">{hint}</p>}
            <AutoHeight className="sheet-group-card">{children}</AutoHeight>
            {status}
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
        <div class={`sheet-row ${layout}`} {...attributes}>
            <div class="sheet-row-text">
                <span class="sheet-row-title">{title}</span>
                {description && <span class="sheet-row-desc">{description}</span>}
            </div>
            {children && <div class="sheet-row-control">{children}</div>}
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

export function SheetToggleRow({ title, description, checked, disabled, onChange }: SheetToggleRowProps) {
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

interface SheetStatusProps {
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
 * produced it. The words stay in the normal text colour; the icon carries the tone.
 */
export function SheetStatus({ tone = 'neutral', children }: SheetStatusProps) {
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

interface VolumeSliderProps {
    session: AudioSession;
}

/** The slider alone, for sheets that lay their own rows out (Settings). */
export function VolumeSlider({ session }: VolumeSliderProps) {
    const [volume, setVolume] = useState(() => Math.round(session.getVolume() * 100));
    return (
        <div class="sheet-volume">
            <input
                type="range"
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

interface SoundRowsProps {
    session: AudioSession;
}

/**
 * Listen plus volume, as two rows, in the Actions sheet of both platforms. "Listen" is this
 * browser's playback; the phone's own volume keys are separate controls on the toolbar. The
 * status message doubles as the listen row's description, so "blocked" or "waiting" is read
 * next to the button that fixes it.
 */
export function SoundRows({ session }: SoundRowsProps) {
    const status = session.status.value;
    const muted = session.isMuted() || status.state === 'blocked';
    const unavailable = status.state === 'disabled' || status.state === 'unsupported' || status.state === 'error';
    return (
        <>
            <SheetRow
                title="Listen in this browser"
                description={status.message}
                attributes={{ 'data-audio-state': status.state }}
            >
                <button
                    type="button"
                    class={`sheet-button ${muted ? 'primary' : ''}`}
                    disabled={unavailable}
                    onClick={() => (muted ? session.unmute() : session.mute())}
                >
                    {muted ? 'Listen' : 'Stop listening'}
                </button>
            </SheetRow>
            <SheetRow
                title="Volume"
                description="For this browser only. The device's own volume is not changed."
                layout="stack"
            >
                <VolumeSlider session={session} />
            </SheetRow>
        </>
    );
}
