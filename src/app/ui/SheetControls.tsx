import { ComponentChildren } from 'preact';
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
    children: ComponentChildren;
}

export function SheetGroup({ title, hint, class: className, children }: SheetGroupProps) {
    return (
        <section class={`sheet-group ${className || ''}`}>
            {title && <h3 class="sheet-group-title">{title}</h3>}
            {hint && <p class="sheet-group-hint">{hint}</p>}
            <div class="sheet-group-card">{children}</div>
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

/** A short outcome line that lives inside the group whose control produced it. */
export function SheetStatus({ tone = 'neutral', children }: SheetStatusProps) {
    return (
        <p class={`sheet-status ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
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
 * Listen/mute plus volume, as two rows. The status message doubles as the listen row's
 * description, so "blocked" or "waiting" is read next to the button that fixes it.
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
                    {muted ? 'Listen' : 'Mute'}
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
