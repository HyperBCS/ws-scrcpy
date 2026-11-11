import { useRef, useState } from 'preact/hooks';
import '../../style/kit/KitSheetsPage.css';
import { ConfirmPrompt, useArmedAction } from '../ui/ConfirmAction';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { Sheet } from '../ui/Sheet';
import { Toast } from '../ui/Toast';

type Example = 'short' | 'long' | 'field' | 'footer' | 'busy' | 'stack' | 'confirm' | 'toast';

const EXAMPLES: ReadonlyArray<{ id: Example; label: string }> = [
    { id: 'short', label: 'Short sheet' },
    { id: 'long', label: 'Long sheet' },
    { id: 'field', label: 'Sheet with a text field' },
    { id: 'footer', label: 'Sheet with a footer' },
    { id: 'busy', label: 'Sheet that stays open while busy' },
    { id: 'stack', label: 'Sheet opened from a sheet' },
    { id: 'confirm', label: 'Sheet with a confirm prompt' },
    { id: 'toast', label: 'Toast over a sheet' },
];
const PHONE = 'Pixel 9';
const ROWS = Array.from({ length: 40 }, (_, index) => `Row ${index + 1}`);

/**
 * The sheet and the menu of the design kit, at `#!action=kit-sheets`. Nothing in the app links
 * here. `scripts/e2e-kit-sheet.js` runs against this page. The buttons and the field are plain
 * markup with this page's own classes until the kit's controls take their place.
 */
export function KitSheetsPage() {
    const [example, setExample] = useState<Example>();
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
    const props = (id: Example) => ({ open: example === id, onClose: close });

    const menuFor = (where: 'page' | 'sheet') => (
        <Menu
            open={menu === where}
            onClose={() => setMenu(undefined)}
            anchor={where === 'page' ? pageMenuButton : sheetMenuButton}
            label="More actions"
        >
            <MenuItem onSelect={() => setChoice('Rename')}>Rename</MenuItem>
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
    const menuButton = (where: 'page' | 'sheet') => (
        <button
            ref={where === 'page' ? pageMenuButton : sheetMenuButton}
            type="button"
            class="kit-sheets-button"
            aria-haspopup="menu"
            aria-expanded={menu === where}
            onClick={() => setMenu(menu === where ? undefined : where)}
        >
            More
        </button>
    );

    return (
        <main class="kit-sheets-page">
            <h1 class="kit-sheets-heading">Sheets and menu</h1>
            <p class="kit-sheets-note">The sheet and the menu of the design kit. The app does not link to this page.</p>

            <h2 class="kit-sheets-section">Sheets</h2>
            <div class="kit-sheets-list">
                {EXAMPLES.map(({ id, label }) => (
                    <button key={id} type="button" class="kit-sheets-button" onClick={() => setExample(id)}>
                        {label}
                    </button>
                ))}
            </div>

            <h2 class="kit-sheets-section">Menu</h2>
            <div class="kit-sheets-list">
                {menuButton('page')}
                {menuFor('page')}
                <p class="kit-sheets-note" role="status">
                    {choice ? `Last choice: ${choice}.` : 'Nothing chosen yet.'}
                </p>
            </div>

            <Sheet {...props('short')} title="Short sheet" subtitle={PHONE}>
                <p class="kit-sheets-text">A sheet is as tall as what it holds.</p>
                <div class="kit-sheets-list">
                    <button type="button" class="kit-sheets-button primary" onClick={close}>
                        Done
                    </button>
                    {/* One sheet takes the place of another, as Stream settings does from Actions. */}
                    <button type="button" class="kit-sheets-button" onClick={() => setExample('long')}>
                        Go to the long sheet
                    </button>
                </div>
            </Sheet>

            {/* No subtitle: the sheet is not about one phone. */}
            <Sheet {...props('long')} title="Long sheet">
                <ul class="kit-sheets-rows">
                    {ROWS.map((row) => (
                        <li key={row}>{row}</li>
                    ))}
                </ul>
            </Sheet>

            <Sheet {...props('field')} subtitle={PHONE} title="Text field">
                <label class="kit-sheets-label" for="kit-sheets-name">
                    Name
                </label>
                <input id="kit-sheets-name" class="kit-sheets-field" type="text" autocomplete="off" />
                <label class="kit-sheets-label" for="kit-sheets-text">
                    Text to paste on the phone
                </label>
                <textarea id="kit-sheets-text" class="kit-sheets-field area" />
            </Sheet>

            <Sheet
                {...props('footer')}
                title="Footer"
                subtitle={PHONE}
                footer={
                    <>
                        <button type="button" class="kit-sheets-button" onClick={close}>
                            Cancel
                        </button>
                        <button type="button" class="kit-sheets-button primary" onClick={close}>
                            Save
                        </button>
                    </>
                }
            >
                <p class="kit-sheets-text">The footer holds the sheet's actions and stays in view under the body.</p>
                {menuButton('sheet')}
                {menuFor('sheet')}
            </Sheet>

            <Sheet {...props('busy')} subtitle={PHONE} dismissible={!busy} title="Busy sheet">
                <p class="kit-sheets-text" role="status">
                    {busy ? 'Working. The sheet stays open until this ends.' : 'Nothing is running.'}
                </p>
                {/* Two buttons, not one with two labels: the pressed one is removed while it has
                    focus, as a button is when its result takes its place. */}
                <button
                    key={busy ? 'finish' : 'start'}
                    type="button"
                    class="kit-sheets-button"
                    onClick={() => setBusy(!busy)}
                >
                    {busy ? 'Finish' : 'Start'}
                </button>
            </Sheet>

            <Sheet {...props('stack')} subtitle={PHONE} title="First sheet">
                <p class="kit-sheets-text">
                    The second sheet opens on top of this one. Each closes by itself, the top one first.
                </p>
                <button type="button" class="kit-sheets-button" onClick={() => setSecond(true)}>
                    Open the second sheet
                </button>
                <Sheet open={second} onClose={() => setSecond(false)} title="Second sheet" subtitle={PHONE}>
                    <p class="kit-sheets-text">This sheet was opened from the first one.</p>
                    <button type="button" class="kit-sheets-button primary" onClick={() => setSecond(false)}>
                        Done
                    </button>
                </Sheet>
            </Sheet>

            <Sheet {...props('confirm')} subtitle={PHONE} title="Confirm prompt">
                <p class="kit-sheets-text" role="status">
                    {erased ? 'The example was erased.' : 'The example is still here.'}
                </p>
                <button
                    type="button"
                    class="kit-sheets-button danger"
                    onClick={(event) => erase.arm('erase', event.currentTarget)}
                >
                    Erase the example
                </button>
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

            <Sheet {...props('toast')} subtitle={PHONE} title="Toast">
                <p class="kit-sheets-text">
                    A message raised while a sheet is open shows above it and can be closed there.
                </p>
                <button type="button" class="kit-sheets-button" onClick={() => setMessage('Saved to the phone.')}>
                    Show a message
                </button>
            </Sheet>

            {/* Outside every sheet, where a page keeps its toast. */}
            <Toast message={message} identity={message} duration={0} onDismiss={() => setMessage('')} />
        </main>
    );
}
