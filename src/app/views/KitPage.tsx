import { Component, ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { AudioPlaybackStatus, AudioSession } from '../state/audio';
import { Disclosure } from '../ui/AnimatedDetails';
import { AppBar, AppBarStatus } from '../ui/AppBar';
import { Badge } from '../ui/Badge';
import { Banner } from '../ui/Banner';
import { Button, buttonClass, ButtonVariant } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Chip, chipClass } from '../ui/Chip';
import { ConfirmPrompt, useArmedAction } from '../ui/ConfirmAction';
import { SelectField, TextAreaField, TextField } from '../ui/Field';
import { Icon } from '../ui/Icon';
import { IconButton, iconButtonClass } from '../ui/IconButton';
import { IconName, ICONS, iconSvg } from '../ui/icons';
import { InlineStatus } from '../ui/InlineStatus';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Sheet } from '../ui/Sheet';
import {
    SheetFooter,
    SheetGroup,
    SheetMessageRow,
    SheetRow,
    SheetSelectRow,
    SheetStatus,
    SheetToggleRow,
    SoundRows,
} from '../ui/SheetControls';
import { Switch } from '../ui/Switch';
import { TabStrip } from '../ui/TabStrip';
import { Toast } from '../ui/Toast';
import '../../style/kit/IconButtonCaption.css';
import '../../style/views/KitPage.css';

/**
 * The kit page (`#!action=kit`): every shared control in every variant and state, with its name
 * beside it, and the sheet and the menu behind buttons. It is for development and for
 * `scripts/e2e-kit.js` and `scripts/e2e-kit-sheet.js`, and nothing links to it.
 */

const VARIANTS: ReadonlyArray<ButtonVariant> = ['primary', 'secondary', 'quiet', 'danger'];
const nothing = () => undefined;

function Section({ title, children }: { title: string; children: ComponentChildren }) {
    return (
        <section class="kit-section" data-kit-section={title}>
            <h2 class="kit-section-title">{title}</h2>
            {children}
        </section>
    );
}

/** One specimen with its name beside it. */
function Demo({ name, children }: { name: string; children: ComponentChildren }) {
    return (
        <div class="kit-demo" data-kit-demo={name}>
            <code class="kit-demo-name">{name}</code>
            <div class="kit-demo-specimen">{children}</div>
        </div>
    );
}

/** Shows the reason when a specimen is refused, in place of the specimen. */
class Refusal extends Component<{ children: ComponentChildren }, { reason: string }> {
    state = { reason: '' };

    static getDerivedStateFromError(error: unknown): { reason: string } {
        return { reason: error instanceof Error ? error.message : String(error) };
    }

    render(): ComponentChildren {
        return this.state.reason ? <p class="kit-demo-refused">Refused. {this.state.reason}</p> : this.props.children;
    }
}

/** Sound that plays nowhere, so the Sound rows can be shown without a phone. */
function demoSound(): AudioSession {
    const status = signal<AudioPlaybackStatus>({ state: 'muted', message: 'Sound is off in this browser.' });
    let volume = 0.6;
    return {
        status,
        isSupported: () => true,
        isMuted: () => status.value.state === 'muted',
        getStats: () => ({
            receivedPackets: 0,
            scheduledFrames: 0,
            droppedPackets: 0,
            underruns: 0,
            bufferedMs: 0,
            lastPeak: 0,
        }),
        unmute: () => (status.value = { state: 'playing', message: 'Playing the sound of the phone.' }),
        mute: () => (status.value = { state: 'muted', message: 'Sound is off in this browser.' }),
        getVolume: () => volume,
        setVolume: (next) => (volume = next),
        stop: nothing,
    };
}
const sound = demoSound();

function Buttons() {
    const [held, setHeld] = useState(false);
    return (
        <Section title="Button">
            {VARIANTS.map((variant) => (
                <Demo key={variant} name={variant}>
                    <Button variant={variant}>Open screen</Button>
                    <Button variant={variant} size="compact">
                        Compact
                    </Button>
                    <Button variant={variant} disabled>
                        Disabled
                    </Button>
                    <Button variant={variant} busy>
                        Busy
                    </Button>
                    <Button variant={variant} icon="refresh">
                        With an icon
                    </Button>
                </Demo>
            ))}
            <Demo name="pressed">
                <Button pressed={held} onClick={() => setHeld(!held)}>
                    Ctrl
                </Button>
                <Button pressed>Held</Button>
            </Demo>
            <Demo name="link">
                <Button href="#!action=kit">A link</Button>
                <Button href="#!action=kit" variant="quiet" size="compact">
                    A quiet link
                </Button>
                <Button href="#!action=kit" disabled>
                    A link that is off
                </Button>
            </Demo>
            <Demo name="full">
                <Button variant="primary" full>
                    Unlock
                </Button>
            </Demo>
            <Demo name="from a string">
                <div
                    class="kit-demo-html"
                    dangerouslySetInnerHTML={{
                        __html:
                            `<button type="button" class="${buttonClass({ variant: 'primary' })}">${iconSvg('upload', 20)}Upload</button>` +
                            `<button type="button" class="${buttonClass({ size: 'compact' })}">Select</button>` +
                            `<button type="button" class="${iconButtonClass({ variant: 'bare' })}" aria-label="Upload files" title="Upload files">${iconSvg('upload')}</button>`,
                    }}
                />
            </Demo>
        </Section>
    );
}

function IconButtons() {
    const [listening, setListening] = useState(false);
    return (
        <Section title="IconButton">
            <Demo name="outlined">
                <IconButton icon="refresh" label="Refresh the list" />
                <IconButton icon="folder" label="Files" size="compact" />
                <IconButton icon="trash" label="Delete" danger />
                <IconButton icon="bell" label="Notifications" disabled />
                <IconButton icon="terminal" label="Shell" href="#!action=kit" />
            </Demo>
            <Demo name="bare">
                <IconButton icon="bolt" label="Actions" variant="bare" />
                <IconButton icon="sliders" label="Settings" variant="bare" size="compact" />
                <IconButton icon="trash" label="Delete selected items" variant="bare" danger />
                <IconButton icon="close" label="Close" variant="bare" disabled />
            </Demo>
            <Demo name="pressed (Sound)">
                <IconButton
                    icon="headphones"
                    label="Sound"
                    variant="bare"
                    pressed={listening}
                    onClick={() => setListening(!listening)}
                />
                <IconButton icon="headphones" label="Sound, playing" variant="bare" pressed />
                <IconButton icon="volMute" label="Mute the phone" variant="bare" />
            </Demo>
            <Demo name="with a caption (phone controls)">
                <div class="kit-demo-controls">
                    {(
                        [
                            ['home', 'Home', undefined, false],
                            ['headphones', 'Listen', true, false],
                            ['power', 'Power', undefined, true],
                        ] as const
                    ).map(([icon, title, pressed, disabled]) => (
                        <button
                            key={title}
                            type="button"
                            class={`${iconButtonClass({ variant: 'bare' })} kit-icon-button-captioned`}
                            aria-label={title}
                            title={title}
                            aria-pressed={pressed}
                            disabled={disabled}
                        >
                            <Icon name={icon} />
                            <span class="kit-icon-button-caption" aria-hidden="true">
                                {pressed ? 'Listening' : title}
                            </span>
                        </button>
                    ))}
                </div>
            </Demo>
            <Demo name="without a label">
                <Refusal>
                    <IconButton icon="close" label="" />
                </Refusal>
            </Demo>
        </Section>
    );
}

function ChipsAndBadges() {
    return (
        <>
            <Section title="Chip">
                <Demo name="tones">
                    <Chip tone="success">Ready</Chip>
                    <Chip tone="info">Viewing</Chip>
                    <Chip>Offline</Chip>
                    <Chip tone="warning">Needs attention</Chip>
                    <Chip tone="error">Error</Chip>
                </Demo>
                <Demo name="from a string">
                    <div
                        class="kit-demo-html"
                        dangerouslySetInnerHTML={{ __html: `<span class="${chipClass('info')}">Locked</span>` }}
                    />
                </Demo>
            </Section>
            <Section title="Badge">
                <Demo name="on an icon button">
                    <a
                        class={iconButtonClass()}
                        href="#!action=kit"
                        title="Notifications"
                        aria-label="Notifications, 5 unread"
                    >
                        <Icon name="bell" />
                        <Badge count={5} />
                    </a>
                    <a
                        class={iconButtonClass({ variant: 'bare' })}
                        href="#!action=kit"
                        title="Notifications"
                        aria-label="Notifications, 120 unread"
                    >
                        <Icon name="bell" />
                        <Badge count={120} />
                    </a>
                    <a class={iconButtonClass()} href="#!action=kit" title="Notifications" aria-label="Notifications">
                        <Icon name="bell" />
                        <Badge count={0} />
                    </a>
                </Demo>
            </Section>
        </>
    );
}

function Icons() {
    return (
        <Section title="Icon">
            <Demo name="sizes 16, 20, 24">
                <Icon name="phone" size={16} />
                <Icon name="phone" size={20} />
                <Icon name="phone" size={24} />
            </Demo>
            <div class="kit-demo-icons">
                {(Object.keys(ICONS) as IconName[]).map((name) => (
                    <div class="kit-demo-icon" key={name} data-kit-icon={name}>
                        <Icon name={name} />
                        <code>{name}</code>
                    </div>
                ))}
            </div>
        </Section>
    );
}

function Fields() {
    const [name, setName] = useState('Pixel 9');
    const [codec, setCodec] = useState('h264');
    const [volume, setVolume] = useState(60);
    return (
        <Section title="Field">
            <Demo name="input">
                <TextField
                    label="Name"
                    hint="Shown in the list and in the tab title."
                    value={name}
                    onInput={(event) => setName(event.currentTarget.value)}
                />
            </Demo>
            <Demo name="input, empty">
                <TextField label="Passcode" type="password" inputMode="numeric" placeholder="Passcode" />
            </Demo>
            <Demo name="input, error">
                <TextField label="First time of day" value="25:00" error="Enter a time between 00:00 and 23:59." />
            </Demo>
            <Demo name="input, disabled">
                <TextField label="Serial" value="ATLAS-PIXEL-0001" disabled />
            </Demo>
            <Demo name="input, short">
                <TextField label="First time of day" labelHidden width="short" value="03:00" inputMode="numeric" />
            </Demo>
            <Demo name="select">
                <SelectField
                    label="Video codec"
                    value={codec}
                    onChange={(event) => setCodec(event.currentTarget.value)}
                    options={[
                        { value: 'h264', label: 'H.264' },
                        { value: 'h265', label: 'H.265' },
                        { value: 'av1', label: 'AV1', disabled: true },
                    ]}
                />
            </Demo>
            <Demo name="textarea">
                <TextAreaField label="Text to paste on the phone" placeholder="Type or paste text" />
            </Demo>
            <Demo name="range">
                <input
                    type="range"
                    class="kit-range"
                    min="0"
                    max="100"
                    value={volume}
                    aria-label="Volume in this browser"
                    onInput={(event) => setVolume(Number(event.currentTarget.value))}
                />
            </Demo>
        </Section>
    );
}

function Switches() {
    const [listen, setListen] = useState(false);
    const [unlock, setUnlock] = useState(true);
    return (
        <Section title="Switch">
            <Demo name="off, on">
                <Switch label="Listen in this browser" checked={listen} onChange={setListen} />
                <Switch label="Unlock twice a day" checked={unlock} onChange={setUnlock} />
            </Demo>
            <Demo name="disabled">
                <Switch label="Unavailable, off" checked={false} disabled onChange={nothing} />
                <Switch label="Unavailable, on" checked disabled onChange={nothing} />
            </Demo>
        </Section>
    );
}

function Checkboxes() {
    const [remember, setRemember] = useState(false);
    return (
        <Section title="Checkbox">
            <Demo name="off or on">
                <Checkbox checked={remember} onChange={setRemember}>
                    Remember in this browser
                </Checkbox>
            </Demo>
            <Demo name="disabled">
                <Checkbox checked disabled onChange={nothing}>
                    Unavailable, ticked
                </Checkbox>
            </Demo>
        </Section>
    );
}

function Segments() {
    const [kind, setKind] = useState<'pin' | 'password'>('pin');
    const [quality, setQuality] = useState<'auto' | 'high' | 'low'>('auto');
    const [filter, setFilter] = useState<'all' | 'unread' | 'archive' | 'muted'>('all');
    return (
        <Section title="SegmentedControl">
            <Demo name="two options">
                <SegmentedControl
                    label="Kind of passcode"
                    value={kind}
                    onChange={setKind}
                    options={[
                        { value: 'pin', label: 'PIN' },
                        { value: 'password', label: 'Password' },
                    ]}
                />
            </Demo>
            <Demo name="three options, full">
                <SegmentedControl
                    label="Quality"
                    full
                    value={quality}
                    onChange={setQuality}
                    options={[
                        { value: 'auto', label: 'Auto' },
                        { value: 'high', label: 'High' },
                        { value: 'low', label: 'Low data' },
                    ]}
                />
            </Demo>
            <Demo name="four options">
                <SegmentedControl
                    label="Show"
                    value={filter}
                    onChange={setFilter}
                    options={[
                        { value: 'all', label: 'All' },
                        { value: 'unread', label: 'Unread' },
                        { value: 'archive', label: 'Archive' },
                        { value: 'muted', label: 'Muted', disabled: true },
                    ]}
                />
            </Demo>
        </Section>
    );
}

function Messages() {
    const [toast, setToast] = useState<{ message: string; tone?: 'error'; undo?: boolean }>({ message: '' });
    return (
        <>
            <Section title="InlineStatus">
                <Demo name="neutral">
                    <InlineStatus>Reading the phone clipboard.</InlineStatus>
                </Demo>
                <Demo name="success">
                    <InlineStatus tone="success">Copied to this browser.</InlineStatus>
                </Demo>
                <Demo name="warning">
                    <InlineStatus tone="warning">Waiting for the phone.</InlineStatus>
                </Demo>
                <Demo name="error">
                    <InlineStatus tone="error">The phone did not answer. Try again.</InlineStatus>
                </Demo>
            </Section>
            <Section title="Banner">
                <Demo name="warning">
                    <Banner action={{ label: 'Wake', run: nothing }}>The screen is asleep.</Banner>
                </Demo>
                <Demo name="info">
                    <Banner tone="info">
                        An older list is still active. Only Messages, Mail, Calendar and Games come through.
                    </Banner>
                </Demo>
                <Demo name="error">
                    <Banner tone="error" action={{ label: 'Retry', run: nothing }}>
                        The stream stopped. Check the USB cable.
                    </Banner>
                </Demo>
            </Section>
            <Section title="Toast">
                <Demo name="kit">
                    <Button onClick={() => setToast({ message: 'Archived.', undo: true })}>Show with Undo</Button>
                    <Button onClick={() => setToast({ message: 'Restored to the inbox.' })}>Show</Button>
                    <Button onClick={() => setToast({ message: 'The phone did not answer.', tone: 'error' })}>
                        Show an error
                    </Button>
                </Demo>
                <Toast
                    kit
                    message={toast.message}
                    identity={toast.message}
                    tone={toast.tone}
                    duration={0}
                    action={toast.undo ? { label: 'Undo', run: () => setToast({ message: '' }) } : undefined}
                    onDismiss={() => setToast({ message: '' })}
                />
            </Section>
        </>
    );
}

function Groups() {
    const [keys, setKeys] = useState(true);
    const [codec, setCodec] = useState('h264');
    return (
        <Section title="Group and Row">
            <div class="kit-demo-sheet">
                <SheetGroup
                    kit
                    title="Clipboard"
                    status={
                        <SheetStatus kit tone="success">
                            Copied to this browser.
                        </SheetStatus>
                    }
                    hint="Text only. Pictures stay on the phone."
                >
                    <SheetRow kit title="Read the phone's clipboard" description="Copies it to this browser.">
                        <Button size="compact">Read</Button>
                    </SheetRow>
                    <SheetRow kit title="Paste text on the phone" layout="stack">
                        <textarea
                            class="kit-field"
                            aria-label="Text to paste on the phone"
                            placeholder="Type or paste text"
                        />
                        <Button>Paste</Button>
                    </SheetRow>
                    <SheetRow kit title="Restart the phone" description="Asks before it restarts." layout="pair">
                        <Button size="compact" variant="danger">
                            Restart
                        </Button>
                        <Button size="compact">Shut down</Button>
                    </SheetRow>
                </SheetGroup>
                <SheetGroup kit title="Keyboard and video">
                    <SheetToggleRow
                        kit
                        title="Send this keyboard to the phone"
                        description="Ctrl+Alt+K releases it."
                        checked={keys}
                        onChange={setKeys}
                    />
                    <SheetSelectRow
                        title="Video codec"
                        description="Applies when the video restarts."
                        value={codec}
                        onChange={setCodec}
                        options={[
                            { value: 'h264', label: 'H.264' },
                            { value: 'h265', label: 'H.265' },
                        ]}
                    />
                    <SheetMessageRow tone="info" action={{ label: 'Clear', run: nothing }}>
                        An older list is still active.
                    </SheetMessageRow>
                    <SheetRow kit title="System">
                        <span class="kit-row-value">Android 16</span>
                    </SheetRow>
                </SheetGroup>
                <SheetGroup kit title="Sound">
                    <SoundRows kit session={sound} />
                </SheetGroup>
                <Disclosure title="About and troubleshooting" note="Stream service running">
                    <SheetRow kit title="Stream service" description="Running">
                        <Button size="compact">Restart</Button>
                    </SheetRow>
                    <SheetRow kit title="Serial">
                        <span class="kit-row-value">ATLAS-PIXEL-0001</span>
                    </SheetRow>
                </Disclosure>
                <SheetFooter>
                    <Button>Cancel</Button>
                    <Button variant="primary">Apply and restart video</Button>
                </SheetFooter>
            </div>
        </Section>
    );
}

type SheetExample = 'short' | 'long' | 'field' | 'footer' | 'busy' | 'stack' | 'confirm' | 'toast';

const SHEET_EXAMPLES: ReadonlyArray<{ id: SheetExample; label: string }> = [
    { id: 'short', label: 'Short sheet' },
    { id: 'long', label: 'Long sheet' },
    { id: 'field', label: 'Sheet with a text field' },
    { id: 'footer', label: 'Sheet with a footer' },
    { id: 'busy', label: 'Sheet that stays open while busy' },
    { id: 'stack', label: 'Sheet opened from a sheet' },
    { id: 'confirm', label: 'Sheet with a confirm prompt' },
    { id: 'toast', label: 'Toast over a sheet' },
];
const SHEET_PHONE = 'Pixel 9';
const SHEET_ROWS = Array.from({ length: 40 }, (_, index) => `Row ${index + 1}`);

/**
 * The sheet and the menu, each example behind a button. `scripts/e2e-kit-sheet.js` runs here.
 * The sheets are rendered after the buttons, so a list of buttons holds only the buttons.
 */
function SheetsAndMenu() {
    const [example, setExample] = useState<SheetExample>();
    const [second, setSecond] = useState(false);
    const [busy, setBusy] = useState(false);
    const [erased, setErased] = useState(false);
    const [message, setMessage] = useState('');
    const [menu, setMenu] = useState<'page' | 'sheet'>();
    const [choice, setChoice] = useState('');
    const [hidden, setHidden] = useState(false);
    const erase = useArmedAction<'erase'>(example === 'confirm');
    const pageMenuButton = useRef<HTMLButtonElement>(null);
    const sheetMenuButton = useRef<HTMLButtonElement>(null);
    const close = () => setExample(undefined);
    const props = (id: SheetExample) => ({ open: example === id, onClose: close });

    const menuFor = (where: 'page' | 'sheet') => (
        <Menu
            open={menu === where}
            onClose={() => setMenu(undefined)}
            anchor={where === 'page' ? pageMenuButton : sheetMenuButton}
            label="More actions"
        >
            {/* An item that opens a sheet. */}
            <MenuItem
                onSelect={() => {
                    setChoice('Rename');
                    setExample('field');
                }}
            >
                Rename
            </MenuItem>
            <MenuItem onSelect={() => setChoice('Move')}>Move</MenuItem>
            <MenuItem onSelect={() => setChoice('Share')} disabled>
                Share
            </MenuItem>
            <MenuItem onSelect={() => setHidden(!hidden)} checked={hidden}>
                Show hidden items
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => setChoice('Delete')} danger>
                Delete
            </MenuItem>
        </Menu>
    );
    // Plain markup with the kit's classes: the menu needs the element of its button, and
    // `Button` does not pass a ref on.
    const menuButton = (where: 'page' | 'sheet') => (
        <button
            ref={where === 'page' ? pageMenuButton : sheetMenuButton}
            type="button"
            class={buttonClass()}
            aria-haspopup="menu"
            aria-expanded={menu === where}
            onClick={() => setMenu(menu === where ? undefined : where)}
        >
            More
        </button>
    );

    return (
        <>
            <Section title="Sheet">
                <Demo name="examples">
                    {SHEET_EXAMPLES.map(({ id, label }) => (
                        <Button key={id} onClick={() => setExample(id)}>
                            {label}
                        </Button>
                    ))}
                </Demo>

                <Sheet {...props('short')} title="Short sheet" subtitle={SHEET_PHONE}>
                    <p class="kit-demo-text">A sheet is as tall as what it holds.</p>
                    <div class="kit-demo-actions">
                        <Button variant="primary" onClick={close}>
                            Done
                        </Button>
                        {/* One sheet takes the place of another, as Stream settings does from Actions. */}
                        <Button onClick={() => setExample('long')}>Go to the long sheet</Button>
                    </div>
                </Sheet>

                {/* No subtitle: the sheet is not about one phone. */}
                <Sheet {...props('long')} title="Long sheet">
                    <SheetGroup kit title="Rows">
                        {SHEET_ROWS.map((row) => (
                            <SheetRow kit key={row} title={row} />
                        ))}
                    </SheetGroup>
                </Sheet>

                <Sheet {...props('field')} subtitle={SHEET_PHONE} title="Text field">
                    <div class="kit-demo-fields">
                        <TextField label="Name" autocomplete="off" />
                        <TextAreaField label="Text to paste on the phone" />
                    </div>
                </Sheet>

                <Sheet
                    {...props('footer')}
                    title="Footer"
                    subtitle={SHEET_PHONE}
                    footer={
                        <>
                            <Button onClick={close}>Cancel</Button>
                            <Button variant="primary" onClick={close}>
                                Save
                            </Button>
                        </>
                    }
                >
                    <p class="kit-demo-text">The footer holds the sheet's actions and stays in view under the body.</p>
                    {menuButton('sheet')}
                    {menuFor('sheet')}
                </Sheet>

                <Sheet {...props('busy')} subtitle={SHEET_PHONE} dismissible={!busy} title="Busy sheet">
                    <p class="kit-demo-text" role="status">
                        {busy ? 'Working. The sheet stays open until this ends.' : 'Nothing is running.'}
                    </p>
                    {/* Two buttons, not one with two labels: the pressed one is removed while it has
                        focus, as a button is when its result takes its place. */}
                    <Button key={busy ? 'finish' : 'start'} onClick={() => setBusy(!busy)}>
                        {busy ? 'Finish' : 'Start'}
                    </Button>
                </Sheet>

                <Sheet {...props('stack')} subtitle={SHEET_PHONE} title="First sheet">
                    <p class="kit-demo-text">
                        The second sheet opens on top of this one. Each closes by itself, the top one first.
                    </p>
                    <Button onClick={() => setSecond(true)}>Open the second sheet</Button>
                    <Sheet open={second} onClose={() => setSecond(false)} title="Second sheet" subtitle={SHEET_PHONE}>
                        <p class="kit-demo-text">This sheet was opened from the first one.</p>
                        <Button variant="primary" onClick={() => setSecond(false)}>
                            Done
                        </Button>
                    </Sheet>
                </Sheet>

                <Sheet {...props('confirm')} subtitle={SHEET_PHONE} title="Confirm prompt">
                    <p class="kit-demo-text" role="status">
                        {erased ? 'The example was erased.' : 'The example is still here.'}
                    </p>
                    <Button variant="danger" onClick={(event) => erase.arm('erase', event.currentTarget)}>
                        Erase the example
                    </Button>
                    {erase.armed && (
                        <ConfirmPrompt
                            kit
                            danger
                            action={erase}
                            question="Erase the example?"
                            consequence="It cannot be brought back."
                            confirmLabel="Erase"
                            onConfirm={() => setErased(true)}
                        />
                    )}
                </Sheet>

                <Sheet {...props('toast')} subtitle={SHEET_PHONE} title="Toast">
                    <p class="kit-demo-text">
                        A message raised while a sheet is open shows above it and can be closed there.
                    </p>
                    <Button onClick={() => setMessage('Saved to the phone.')}>Show a message</Button>
                </Sheet>

                {/* Outside every sheet, where a page keeps its toast. */}
                <Toast kit message={message} identity={message} duration={0} onDismiss={() => setMessage('')} />
            </Section>

            <Section title="Menu">
                <Demo name="at its button">
                    {menuButton('page')}
                    {menuFor('page')}
                    <p class="kit-demo-note" role="status">
                        {choice ? `Last choice: ${choice}.` : 'Nothing chosen yet.'}
                    </p>
                </Demo>
            </Section>
        </>
    );
}

const TABS = [
    { id: 'screen', title: 'Screen' },
    { id: 'files', title: 'Files' },
    { id: 'shell', title: 'Shell' },
] as const;

function Bars() {
    const [tab, setTab] = useState<(typeof TABS)[number]['id']>('screen');
    return (
        <>
            <Section title="AppBar">
                <Demo name="a phone's page">
                    <div class="kit-demo-frame">
                        <AppBar
                            kit
                            title="Pixel 9"
                            status={<AppBarStatus kit>Connected · Android 16</AppBarStatus>}
                            onBack={nothing}
                            onTitle={nothing}
                            titleLabel="Switch phone. Viewing Pixel 9"
                        >
                            <IconButton icon="bolt" label="Actions" variant="bare" />
                            <IconButton icon="sliders" label="Settings" variant="bare" />
                        </AppBar>
                    </div>
                </Demo>
                <Demo name="a page">
                    <div class="kit-demo-frame">
                        <AppBar
                            kit
                            title="Notifications"
                            status={<AppBarStatus kit>Receiving from Bench iPhone</AppBarStatus>}
                            onBack={nothing}
                        >
                            <Button size="compact">Open screen</Button>
                        </AppBar>
                    </div>
                </Demo>
                <Demo name="root">
                    <div class="kit-demo-frame">
                        <AppBar
                            kit
                            root
                            title="Phones"
                            status={<AppBarStatus kit>3 phones, 1 needs attention</AppBarStatus>}
                        >
                            <IconButton icon="bell" label="Notifications" />
                            <IconButton icon="refresh" label="Refresh the list" />
                        </AppBar>
                    </div>
                </Demo>
            </Section>
            <Section title="TabStrip">
                <Demo name="kit">
                    <div class="kit-demo-frame">
                        <TabStrip kit label="Phone views" tabs={TABS} current={tab} onSelect={setTab} />
                    </div>
                </Demo>
            </Section>
        </>
    );
}

export function KitPage() {
    return (
        <main class="kit-page">
            <div class="kit-page-content">
                <header class="kit-page-header">
                    <h1 class="kit-page-title">Kit</h1>
                    <p class="kit-page-note">
                        Every shared control in every variant and state, and the sheet and the menu. This page is for
                        development and nothing links to it.
                    </p>
                </header>
                <Buttons />
                <IconButtons />
                <ChipsAndBadges />
                <Icons />
                <Fields />
                <Switches />
                <Checkboxes />
                <Segments />
                <Messages />
                <Groups />
                <SheetsAndMenu />
                <Bars />
            </div>
        </main>
    );
}
