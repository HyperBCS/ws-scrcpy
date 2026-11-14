import { stopRemoteInteraction, trapDialogTab } from '../../ui/dialogFocus';
import { CONFIRM_GUARD_MS } from '../../ui/ConfirmAction';
import { transitionVisibility, cancelVisibility } from '../../ui/motion';
import { buttonClass } from '../../ui/Button';
import { iconButtonClass } from '../../ui/IconButton';
import { IconName, iconSvg } from '../../ui/icons';
import { bindMenu, MenuAnchor, placeMenu } from '../../ui/Menu';
import { SHEET_DIALOG } from '../../ui/Sheet';
import { bindSheetDrag } from '../../ui/sheetDrag';
import '../../../style/kit/Icon.css';
import '../../../style/kit/Field.css';
import '../../../style/kit/InlineStatus.css';
import '../../../style/filelisting.css';
import { ParamsFileListing } from '../../../types/ParamsFileListing';
import { ManagerClient } from '../../client/ManagerClient';
import { ACTION } from '../../../common/Action';
import Util from '../../Util';
import { Entry } from '../Entry';
import { html } from '../../ui/HtmlTag';
import * as path from 'path';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import FilePushHandler, { DragAndPushListener, PlannedUpload, PushUpdateParams } from '../filePush/FilePushHandler';
import { Cancellable, FileError, FileService } from '../files/FileService';
import { FolderEntries, SortKey } from '../files/FolderEntries';
import { KeyedRows } from '../files/KeyedRows';
import { RowGeometry, RowRange, RowWindow } from '../files/RowWindow';
import {
    ConflictAnswer,
    ConflictChoice,
    ExistingItem,
    nameKey,
    Resolution,
    resolveNameConflicts,
} from '../filePush/nameConflicts';
import { DEFAULT_FILES_PATH } from './deviceTools';
import { clearLeaveGuard, LeaveGuard, OverlayEntry, pushRoute, replaceRoute, setLeaveGuard } from '../../state/router';
import { deviceRoute, parseRoute } from '../../state/routes';
import { openOverlay } from '../../ui/overlayHistory';
import { formatMode, formatModified, formatSize, iconMarkup, kindOf, typeLabel } from './fileTypes';
import { h, render } from 'preact';
import { Toast } from '../../ui/Toast';
import { deviceName } from '../../state/devices';
import { CONNECTION } from '../../copy';
import { findDeviceForTool } from '../../state/toolDevice';

/** How a folder that was asked for ended: listed, or why it could not be opened. */
type Listing = { kind: 'stat' | 'list'; path: string; error?: string };

/**
 * How one folder operation is reported. `failure` names the item ("Could not rename “a”") and
 * the device's reason is added to it. `many` sums up a batch in which several items succeeded.
 */
type Outcome = { success: string; failure: string; many?: (count: number) => string };

type ViewMode = 'details' | 'list' | 'tiles';
type Command =
    | 'open'
    | 'download'
    | 'copy-path'
    | 'cut'
    | 'copy'
    | 'paste'
    | 'rename'
    | 'delete'
    | 'properties'
    | 'new-folder'
    | 'upload'
    | 'refresh'
    | 'select-all';

/** An upload's row in the transfer list and what it shows. */
type Upload = {
    row: HTMLElement;
    bar: HTMLElement;
    fill: HTMLElement;
    state: HTMLElement;
    name: string;
    folder: string;
    sent: number;
    size: number;
};

/** `folders` lists which of `names` are folders. */
type Clipboard = { mode: 'cut' | 'copy'; dir: string; names: string[]; folders: string[] };

type Preferences = {
    view: ViewMode;
    sort: SortKey;
    ascending: boolean;
    showHidden: boolean;
    /** Item check boxes, as in Explorer: a check box on every row, or none at all. */
    checkboxes: boolean;
};

const PREFERENCES_KEY = 'ws-scrcpy.files.preferences';
const DEFAULT_PREFERENCES: Preferences = {
    view: 'details',
    sort: 'name',
    ascending: true,
    showHidden: false,
    checkboxes: false,
};

// Quick access, in the order Explorer puts its own: the roots first, then the folders people
// actually visit. Any of them can be missing on a given device; opening one then reports the
// device's own error instead of hiding the shortcut based on a guess.
const PLACES: { title: string; path: string }[] = [
    { title: 'Phone root', path: '/' },
    { title: 'Internal storage', path: '/sdcard' },
    { title: 'Downloads', path: '/sdcard/Download' },
    { title: 'Camera', path: '/sdcard/DCIM/Camera' },
    { title: 'Pictures', path: '/sdcard/Pictures' },
    { title: 'Movies', path: '/sdcard/Movies' },
    { title: 'Music', path: '/sdcard/Music' },
    { title: 'Documents', path: '/sdcard/Documents' },
    { title: 'Temporary', path: '/data/local/tmp' },
];

const SORT_TITLES: Record<SortKey, string> = {
    name: 'Name',
    size: 'Size',
    type: 'Type',
    modified: 'Modified',
};

// The explorer writes its markup as strings, so it takes the kit's classes as strings. Its
// toolbar and its rows are dense: 32px under a mouse and 44px under a finger.
const BUTTON = buttonClass({ size: 'compact' });
const BUTTON_PRIMARY = buttonClass({ variant: 'primary', size: 'compact' });
const BUTTON_DANGER = buttonClass({ variant: 'danger', size: 'compact' });
const BUTTON_QUIET = buttonClass({ variant: 'quiet', size: 'compact' });
const ICON_BUTTON = iconButtonClass({ variant: 'bare', size: 'compact' });
const ICON_BUTTON_DANGER = iconButtonClass({ variant: 'bare', size: 'compact', danger: true });
const ICON_BUTTON_OUTLINED = iconButtonClass({ size: 'compact' });
/** The check of a menu item that is on or off. The kit hides it while the item is off. */
const CHECK = iconSvg('check', 20);
const ROW_MENU_ICON = iconSvg('more', 20);
// The answers of a dialog are full size at every width. The one that removes something is on
// the solid danger fill.
const ANSWER = buttonClass();
const ANSWER_PRIMARY = buttonClass({ variant: 'primary' });
const ANSWER_DANGER = buttonClass({ variant: 'danger' });
const ANSWER_REMOVES = buttonClass({ variant: 'danger-solid' });
const MENU_SEPARATOR = '<div class="kit-menu-separator" role="separator"></div>';

/** The icon of each toolbar button, by its command. */
const TOOLBAR_ICONS: Record<string, IconName> = {
    back: 'arrowLeft',
    forward: 'arrowRight',
    up: 'arrowUp',
    home: 'house',
    refresh: 'refresh',
    places: 'folder',
    'edit-path': 'edit',
    'filter-toggle': 'search',
    actions: 'more',
};
/** The same for the phone's selection bar. */
const SELECTION_ICONS: Record<string, IconName> = {
    'end-selection': 'close',
    download: 'download',
    copy: 'copy',
    cut: 'move',
    delete: 'trash',
};

/** The name of each menu, for assistive technology. A menu has no title of its own. */
const MENU_LABELS = {
    view: 'View',
    places: 'Quick access',
    actions: 'Actions',
    item: 'Item actions',
    folder: 'Folder actions',
};

const LONG_PRESS_MS = 450;
/** While a folder is listed, its rows are added at most this often. */
const RENDER_INTERVAL_MS = 250;

// Opening follows the input device, not the viewport: a mouse selects on one click and opens on
// two, exactly like Explorer, while a touch tap opens straight away because a phone has no
// double-tap-to-open convention and no modifier keys.
const COARSE_POINTER = '(hover: none) and (pointer: coarse)';

function esc(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function readPreferences(): Preferences {
    try {
        const stored = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || '{}');
        return {
            view: ['details', 'list', 'tiles'].includes(stored.view) ? stored.view : DEFAULT_PREFERENCES.view,
            sort: ['name', 'size', 'type', 'modified'].includes(stored.sort) ? stored.sort : DEFAULT_PREFERENCES.sort,
            ascending: typeof stored.ascending === 'boolean' ? stored.ascending : DEFAULT_PREFERENCES.ascending,
            showHidden: typeof stored.showHidden === 'boolean' ? stored.showHidden : DEFAULT_PREFERENCES.showHidden,
            checkboxes: typeof stored.checkboxes === 'boolean' ? stored.checkboxes : DEFAULT_PREFERENCES.checkboxes,
        };
    } catch {
        // Private windows and blocked site data throw here; the explorer still works with defaults.
        return { ...DEFAULT_PREFERENCES };
    }
}

/**
 * A file explorer for one device: breadcrumb navigation with history, quick access, sortable
 * details/list/tile views, filtering, multi-select, upload/download and folder operations.
 *
 * It owns its mount only; `stop()` can safely run while a listing, download, folder operation or
 * upload is still in flight.
 */
export class FileListingClient extends ManagerClient<ParamsFileListing, never> implements DragAndPushListener {
    public static readonly ACTION = ACTION.FILE_LISTING;
    public static readonly PARENT_DIR = '..';
    public static readonly PROPERTY_NAME = 'data-name';
    public static readonly PROPERTY_ENTRY_ID = 'data-entry-id';
    public static start(params: ParamsFileListing, mount: HTMLElement): FileListingClient {
        return new FileListingClient(params, mount);
    }
    private readonly serial: string;
    private readonly wrapper: HTMLElement;
    private readonly tableHead: HTMLElement;
    private readonly tableBody: HTMLElement;
    private readonly items: HTMLElement;
    private readonly breadcrumb: HTMLElement;
    private readonly addressInput: HTMLInputElement;
    private readonly places: HTMLElement;
    private readonly filterInput: HTMLInputElement;
    private readonly status: HTMLElement;
    private readonly counts: HTMLElement;
    private readonly transfers: HTMLElement;
    private readonly menu: HTMLElement;
    private readonly dialog: HTMLDialogElement;
    private readonly picker: HTMLInputElement;
    private readonly buttons = new Map<string, HTMLButtonElement>();
    /** The phone's selection bar. Its buttons run the same commands as the toolbar's. */
    private readonly barButtons = new Map<string, HTMLButtonElement>();
    private readonly selectionCount: HTMLElement;
    /**
     * The items a row's ⋮ menu acts on: that row alone. The menu never changes the selection,
     * so the selection bar and the Actions menu keep acting on what the owner selected.
     */
    private menuTargets?: string[];

    private filePushHandler?: FilePushHandler;
    /** Every request to the phone. The explorer builds and reads no bytes of its own. */
    private readonly files: FileService;
    /** Set when the connection closes. The tool page reports that; the status line stays quiet. */
    private offline = false;
    /** The STAT and LIST of the folder being opened. Opening another one cancels them. */
    private readonly lookups = new Set<Cancellable<unknown>>();
    /** Uploads that have not ended, by key: two uploads may carry the same file name. */
    private readonly uploads = new Map<number, Upload>();
    /** Failures in the current batch of uploads, shown together when the last one ends. */
    private uploadErrors: string[] = [];
    private uploadsDone: string[] = [];
    /** The batch so far, for "Uploading 3 of 40, 45%", and the folders it sends files to. */
    private uploadBatch = FileListingClient.emptyBatch();
    private readonly transferSummary: HTMLElement;
    /** The phone whose page this explorer is on. An address that is not that phone's leaves it. */
    private readonly phone: string;
    /** The open "Stop uploading?" question, so a second Back does not ask twice. */
    private leaving?: Promise<boolean>;
    /**
     * Uploads go on while another tab of the same phone is shown, so a change of view does not
     * ask. Leaving the phone's page stops them: another phone, the list or Notifications.
     */
    private readonly leaveGuard: LeaveGuard = {
        blocks: (next) => this.uploads.size > 0 && FileListingClient.phoneOf(next) !== this.phone,
        ask: () => this.confirmLeave(),
    };
    /** False while the phone's page shows another of its tabs and keeps the explorer hidden. */
    private active = true;
    /** The last result or failure reported while hidden, shown when the tab is shown again. */
    private missed?: { message: string; error: boolean };
    /** Ends what `bindMenu` set up for the open menu, its history entry included. */
    private unbindMenu?: () => void;
    /** `left` once Back has closed the dialog through its entry. */
    private dialogEntry?: { entry: OverlayEntry; left: boolean };
    /** Gives up the dialog's entry once a closed question has had no successor. */
    private dialogRelease?: ReturnType<typeof setTimeout>;
    /** Holds the dialog on the page itself while the question before leaving is open. */
    private dialogHolder?: HTMLElement;
    /** The panel of the question that is shown: the part of the sheet that moves. */
    private dialogPanel?: HTMLElement;
    /** True from an answer until the dialog has closed, so a second press answers nothing. */
    private dialogClosing = false;
    /** Ends the header drag and the viewport tracking of the open dialog. */
    private unbindSheet?: () => void;
    /** Lets presses in the dialog reach the page's listeners again. */
    private readonly allowRemote: () => void;
    /** Results of the folder operations in flight, reported together when the last one answers. */
    private batch: { done: string[]; failed: string[]; many?: (count: number) => string } = { done: [], failed: [] };
    /** Set while the list shows a folder that could not be opened, in place of its rows. */
    private listingError?: string;
    private readonly toastHost: HTMLElement;
    private toastCount = 0;
    /** True while the owner is answering name conflicts; nothing else may start meanwhile. */
    private resolving = false;
    /** The items of the folder that is shown, by name. */
    private readonly folder = new FolderEntries();
    /** One row per item, built when the item is first shown and kept while it is the same. */
    private readonly rows: KeyedRows<Entry>;
    /** The line the list shows in place of rows: loading, empty, no match, or why it failed. */
    private emptyRow?: { key: string; element: HTMLElement };
    /** Which rows of a long list are in the document, and the spacers for the lines around them. */
    private readonly rowWindow = new RowWindow();
    private readonly spacerBefore: HTMLElement;
    private readonly spacerAfter: HTMLElement;
    /** How the rows lie, measured; forgotten when the layout or the width changes. */
    private rowGeometry?: RowGeometry;
    /** The width of the list when the rows were last measured. */
    private listWidth = 0;
    private windowFrame = 0;
    /** What the list showed when it was last put in order. */
    private listed: Entry[] = [];
    private readonly resizeObserver?: ResizeObserver;
    private selection = new Set<string>();
    private anchorName?: string;
    private clipboard?: Clipboard;
    private filter = '';
    private preferences = readPreferences();
    private selectionMode = false;
    /**
     * The browser's history is the only history. Each entry this explorer creates is tagged with
     * its position, so the toolbar knows whether Back and Forward have somewhere to go; the
     * buttons themselves call `history.back()` and `history.forward()`.
     */
    private historyId = '';
    private historyIndex = 0;
    private historyTop = 0;
    private readonly historyKey: string;
    private generation = 0;
    private loading = false;
    private stopped = false;
    private operations = 0;
    private enterCount = 0;
    private renderHandle = 0;
    private renderTimer?: ReturnType<typeof setTimeout>;
    /** When the rows were last put in order, for `RENDER_INTERVAL_MS`. */
    private renderedAt = 0;
    private longPressTimer?: ReturnType<typeof setTimeout>;
    private longPressedAt = 0;
    /** Rebuilds the open menu after a setting inside it changes, keeping any Back item. */
    private menuBuilder?: () => string[];
    /** The button the open menu belongs to, or the point a context menu was asked for at. */
    private menuAnchor?: MenuAnchor;
    private typeAhead = { text: '', at: 0 };
    /**
     * The one row that Tab stops on. The arrow keys move between rows, so the list is a single
     * stop: this row's name, then its menu button.
     */
    private rovingName?: string;
    /**
     * Whether the Tab stop is on a row because that row had focus. Otherwise it belongs on the
     * first row, also while a listing is still arriving: its rows come in bursts and the first
     * one to arrive is not the first one shown.
     */
    private rovingFromFocus = false;
    private path: string;
    /** The place a load in progress opens. */
    private loadingPath?: string;
    /** Checks the open dialog's field. A message keeps the dialog open and is shown under the field. */
    private dialogCheck?: () => string;

    constructor(params: ParamsFileListing, mount: HTMLElement) {
        super(params);
        this.serial = params.udid;
        this.path = path.resolve('/', params.path);
        this.historyKey = `ws-scrcpy.files.history.${this.serial}`;
        this.phone = FileListingClient.phoneOf(new URLSearchParams(location.hash.replace(/^#!/, '')));
        this.adoptHistory();
        const fragment = html`<section class="file-listing-client file-explorer" aria-label="Phone files">
            <div class="fx-chrome">
                <div class="fx-history">
                    <button
                        type="button"
                        class="${ICON_BUTTON}"
                        data-command="back"
                        aria-label="Back"
                        title="Back"
                        disabled
                    ></button>
                    <button
                        type="button"
                        class="${ICON_BUTTON}"
                        data-command="forward"
                        aria-label="Forward"
                        title="Forward"
                        disabled
                    ></button>
                    <button
                        type="button"
                        class="${ICON_BUTTON}"
                        data-command="up"
                        aria-label="Up one folder"
                        title="Up one folder"
                    ></button>
                    <button
                        type="button"
                        class="${ICON_BUTTON} fx-home"
                        data-command="home"
                        aria-label="Phone root"
                        title="Phone root"
                    ></button>
                    <button
                        type="button"
                        class="${ICON_BUTTON} fx-refresh"
                        data-command="refresh"
                        aria-label="Refresh"
                        title="Refresh"
                        disabled
                    ></button>
                    <button
                        type="button"
                        class="${ICON_BUTTON} fx-places-toggle"
                        data-command="places"
                        aria-haspopup="menu"
                        aria-expanded="false"
                        aria-label="Quick access"
                        title="Quick access"
                    ></button>
                </div>
                <div class="fx-selection-bar" role="toolbar" aria-label="Selected items">
                    <button
                        type="button"
                        class="${ICON_BUTTON}"
                        data-command="end-selection"
                        aria-label="Close selection"
                        title="Close selection"
                    ></button>
                    <span class="fx-selection-count"></span>
                    <button
                        type="button"
                        class="${ICON_BUTTON}"
                        data-command="download"
                        aria-label="Download selected files"
                        title="Download"
                        disabled
                    ></button>
                    <button
                        type="button"
                        class="${ICON_BUTTON}"
                        data-command="copy"
                        aria-label="Copy selected items"
                        title="Copy"
                        disabled
                    ></button>
                    <button
                        type="button"
                        class="${ICON_BUTTON}"
                        data-command="cut"
                        aria-label="Move selected items"
                        title="Move"
                        disabled
                    ></button>
                    <button
                        type="button"
                        class="${ICON_BUTTON_DANGER}"
                        data-command="delete"
                        aria-label="Delete selected items"
                        title="Delete"
                        disabled
                    ></button>
                </div>
                <div class="fx-address" data-command="edit-path">
                    <nav class="fx-breadcrumb" aria-label="Folder path"></nav>
                    <input
                        class="fx-address-input"
                        type="text"
                        spellcheck="false"
                        autocapitalize="off"
                        autocomplete="off"
                        autocorrect="off"
                        enterkeyhint="go"
                        aria-label="Folder path"
                        hidden
                    />
                    <button
                        type="button"
                        class="${ICON_BUTTON} fx-address-toggle"
                        data-command="edit-path"
                        aria-label="Type a folder path"
                        title="Type a folder path"
                    ></button>
                </div>
                <div class="fx-mobile-tools">
                    <button
                        type="button"
                        class="${ICON_BUTTON_OUTLINED}"
                        data-command="filter-toggle"
                        aria-pressed="false"
                        aria-label="Filter this folder"
                        title="Filter this folder"
                    ></button>
                    <button
                        type="button"
                        class="${ICON_BUTTON_OUTLINED}"
                        data-command="actions"
                        aria-haspopup="menu"
                        aria-expanded="false"
                        aria-label="Actions"
                        title="Actions"
                    ></button>
                </div>
                <div class="fx-commands" role="toolbar" aria-label="File commands">
                    <button
                        type="button"
                        class="${BUTTON_PRIMARY}"
                        data-command="upload"
                        aria-label="Upload files to this folder"
                    >
                        Upload
                    </button>
                    <button type="button" class="${BUTTON}" data-command="new-folder">New folder</button>
                    <button type="button" class="${BUTTON}" data-command="download" disabled>Download</button>
                    <button type="button" class="${BUTTON}" data-command="rename" disabled>Rename</button>
                    <button type="button" class="${BUTTON_DANGER}" data-command="delete" disabled>Delete</button>
                    <button type="button" class="${BUTTON}" data-command="cut" disabled>Cut</button>
                    <button type="button" class="${BUTTON}" data-command="copy" disabled>Copy</button>
                    <button type="button" class="${BUTTON}" data-command="paste" disabled>Paste</button>
                    <span class="fx-bar-spacer"></span>
                    <button type="button" class="${BUTTON}" data-command="selection-mode" aria-pressed="false">
                        Select
                    </button>
                    <button
                        type="button"
                        class="${BUTTON}"
                        data-command="view-menu"
                        aria-haspopup="menu"
                        aria-expanded="false"
                    >
                        View
                    </button>
                    <label class="fx-filter">
                        <input
                            type="search"
                            class="kit-field fx-filter-input"
                            placeholder="Filter"
                            aria-label="Filter items in this folder"
                        />
                    </label>
                </div>
            </div>
            <div class="fx-body">
                <nav class="fx-places" aria-label="Quick access"></nav>
                <div class="fx-main">
                    <div class="fx-transfers" role="group" aria-label="Uploads" hidden>
                        <div class="fx-transfer-summary">
                            <span class="fx-transfer-total"></span>
                            <button type="button" class="${BUTTON}" data-upload-cancel="all">Cancel all</button>
                        </div>
                    </div>
                    <div class="fx-items" tabindex="0" role="group" aria-label="Folder contents">
                        <table class="fx-table file-listing-table">
                            <thead>
                                <tr>
                                    <th scope="col" class="fx-cell-select">
                                        <input type="checkbox" class="fx-check-all" aria-label="Select all items" />
                                    </th>
                                    <th scope="col" class="fx-col-name" aria-sort="ascending">
                                        <button type="button" class="fx-sort" data-sort="name">
                                            Name
                                            <span class="fx-sort-arrow" aria-hidden="true"></span>
                                        </button>
                                    </th>
                                    <th scope="col" class="fx-col-size" aria-sort="none">
                                        <button type="button" class="fx-sort" data-sort="size">
                                            Size
                                            <span class="fx-sort-arrow" aria-hidden="true"></span>
                                        </button>
                                    </th>
                                    <th scope="col" class="fx-col-type" aria-sort="none">
                                        <button type="button" class="fx-sort" data-sort="type">
                                            Type
                                            <span class="fx-sort-arrow" aria-hidden="true"></span>
                                        </button>
                                    </th>
                                    <th scope="col" class="fx-col-time" aria-sort="none">
                                        <button type="button" class="fx-sort" data-sort="modified">
                                            Modified
                                            <span class="fx-sort-arrow" aria-hidden="true"></span>
                                        </button>
                                    </th>
                                    <th scope="col" class="fx-cell-menu"><span class="fx-sr-only">Actions</span></th>
                                </tr>
                            </thead>
                            <tbody></tbody>
                        </table>
                    </div>
                </div>
            </div>
            <div class="fx-statusbar">
                <span class="fx-counts"></span>
                <span class="file-listing-status fx-status" role="status" aria-live="polite"
                    >${CONNECTION.connecting}</span
                >
            </div>
            <div class="kit-menu kit-menu-compact files-menu" role="menu" tabindex="-1" hidden></div>
            <dialog class="kit-sheet fx-dialog" role="dialog" tabindex="-1" aria-labelledby="fx-dialog-title"></dialog>
            <div class="fx-toast-host"></div>
            <input type="file" multiple hidden aria-label="Choose files to upload" />
        </section>`.content;
        this.wrapper = fragment.querySelector('section') as HTMLElement;
        this.tableHead = this.wrapper.querySelector('thead') as HTMLElement;
        this.tableBody = this.wrapper.querySelector('tbody') as HTMLElement;
        this.items = this.wrapper.querySelector('.fx-items') as HTMLElement;
        this.breadcrumb = this.wrapper.querySelector('.fx-breadcrumb') as HTMLElement;
        this.addressInput = this.wrapper.querySelector('.fx-address-input') as HTMLInputElement;
        this.places = this.wrapper.querySelector('.fx-places') as HTMLElement;
        this.filterInput = this.wrapper.querySelector('.fx-filter-input') as HTMLInputElement;
        this.status = this.wrapper.querySelector('.fx-status') as HTMLElement;
        this.counts = this.wrapper.querySelector('.fx-counts') as HTMLElement;
        this.transfers = this.wrapper.querySelector('.fx-transfers') as HTMLElement;
        this.transferSummary = this.wrapper.querySelector('.fx-transfer-total') as HTMLElement;
        this.menu = this.wrapper.querySelector('.files-menu') as HTMLElement;
        this.toastHost = this.wrapper.querySelector('.fx-toast-host') as HTMLElement;
        this.dialog = this.wrapper.querySelector('.fx-dialog') as HTMLDialogElement;
        this.dialog.addEventListener('cancel', this.onDialogCancel);
        this.dialog.addEventListener('submit', this.onDialogSubmit);
        this.dialog.addEventListener('keydown', this.onDialogKeyDown);
        this.dialog.addEventListener('click', this.onDialogClick);
        this.dialog.addEventListener('close', this.onDialogClose);
        // The question before leaving is asked over the Screen tab too: a press in it must not
        // reach the listeners that drive the phone.
        this.allowRemote = stopRemoteInteraction(this.dialog);
        this.picker = this.wrapper.querySelector('input[type="file"]') as HTMLInputElement;
        this.wrapper.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((button) => {
            const map = button.closest('.fx-selection-bar') ? this.barButtons : this.buttons;
            map.set(button.dataset.command as string, button);
        });
        this.selectionCount = this.wrapper.querySelector('.fx-selection-count') as HTMLElement;
        this.rows = new KeyedRows<Entry>(
            this.tableBody,
            (entry) => entry.name,
            (entries) => this.buildRows(entries),
            FileListingClient.sameEntry,
        );
        const spacers = document.createElement('template');
        spacers.innerHTML =
            '<tr class="fx-spacer" aria-hidden="true"></tr><tr class="fx-spacer" aria-hidden="true"></tr>';
        [this.spacerBefore, this.spacerAfter] = Array.from(spacers.content.children) as HTMLElement[];
        this.wrapper.dataset.listing = 'loading';
        this.decorateIcons();
        this.renderBreadcrumb();
        this.applyPreferences();
        this.renderItems();

        this.wrapper.addEventListener('click', this.onClick);
        this.wrapper.addEventListener('dblclick', this.onDoubleClick);
        this.wrapper.addEventListener('contextmenu', this.onContextMenu);
        this.wrapper.addEventListener('keydown', this.onKeyDown);
        this.tableBody.addEventListener('focusin', this.onRowFocus);
        this.tableBody.addEventListener('pointerdown', this.onPointerDown);
        this.tableBody.addEventListener('pointerup', this.cancelLongPress);
        this.tableBody.addEventListener('pointercancel', this.cancelLongPress);
        this.items.addEventListener('scroll', this.onListScroll, { passive: true });
        if (typeof ResizeObserver === 'function') {
            // A new width can change how many tiles fit on a line and how tall they are. A new
            // height changes only which lines are in view.
            this.resizeObserver = new ResizeObserver(() => {
                const width = this.items.clientWidth;
                // A hidden tab has no size. Its rows and their measures wait until it is shown.
                if (!width) {
                    return;
                }
                if (width !== this.listWidth) {
                    this.listWidth = width;
                    this.forgetRowGeometry();
                }
                this.onListScroll();
            });
            this.resizeObserver.observe(this.items);
        }
        this.filterInput.addEventListener('input', () => {
            this.filter = this.filterInput.value.trim().toLowerCase();
            this.renderItems();
        });
        this.addressInput.addEventListener('keydown', this.onAddressKeyDown);
        this.addressInput.addEventListener('blur', () => this.closeAddressInput());
        (this.wrapper.querySelector('.fx-check-all') as HTMLInputElement).addEventListener('change', (event) => {
            if ((event.currentTarget as HTMLInputElement).checked) {
                this.visible().forEach((entry) => this.selection.add(entry.name));
            } else {
                this.selection.clear();
            }
            this.paintSelection();
        });
        this.picker.addEventListener('change', () => {
            const files = Array.from(this.picker.files || []);
            this.picker.value = '';
            if (files.length && this.canModify()) {
                this.filePushHandler?.onFilesDrop(files);
            }
        });

        mount.appendChild(this.wrapper);
        this.openNewConnection();
        this.files = new FileService(this.ws as Multiplexer, {
            serial: this.serial,
            remote: params.useProxy ? this.buildDirectWebSocketUrl().toString() : undefined,
        });
        this.filePushHandler = new FilePushHandler(this.wrapper, this.files, this.planUploads);
        this.filePushHandler.addEventListener(this);
    }

    // ---------------------------------------------------------------- chrome

    /** Each icon button gets its icon from the kit's set. Its name is the `aria-label` in the markup. */
    private decorateIcons(): void {
        const draw = (map: Map<string, HTMLButtonElement>, icons: Record<string, IconName>) =>
            Object.entries(icons).forEach(([command, icon]) => {
                const button = map.get(command);
                if (button) {
                    button.innerHTML = iconSvg(icon, 20);
                }
            });
        draw(this.buttons, TOOLBAR_ICONS);
        draw(this.barButtons, SELECTION_ICONS);
    }

    private renderPlaces(): void {
        this.places.innerHTML = PLACES.map(
            (place) =>
                `<button type="button" class="${BUTTON_QUIET} fx-place" data-place="${esc(place.path)}"${
                    place.path === this.path ? ' aria-current="page"' : ''
                }>${place.path === '/' ? iconSvg('house', 20) : iconMarkup('folder')}<span>${esc(
                    place.title,
                )}</span></button>`,
        ).join('');
    }

    private renderBreadcrumb(): void {
        const segments = this.path.split('/').filter(Boolean);
        let walked = '';
        const parts = [
            `<button type="button" class="fx-crumb fx-crumb-root" data-place="/" aria-label="Phone root" title="Phone root"${
                this.path === '/' ? ' aria-current="page"' : ''
            }>/</button>`,
        ];
        segments.forEach((segment, index) => {
            walked += `/${segment}`;
            parts.push(
                '<span class="fx-crumb-part">' +
                    (index ? '<span class="fx-crumb-separator" aria-hidden="true">/</span>' : '') +
                    `<button type="button" class="fx-crumb" data-place="${esc(walked)}"${
                        index === segments.length - 1 ? ' aria-current="page"' : ''
                    }>${esc(segment)}</button></span>`,
            );
        });
        this.breadcrumb.innerHTML = parts.join('');
        // A deep path overflows the bar: keep the folder you are in visible, not the root.
        this.breadcrumb.scrollLeft = this.breadcrumb.scrollWidth;
        this.renderPlaces();
    }

    private applyPreferences(): void {
        const { view, sort, ascending, checkboxes } = this.preferences;
        if (this.wrapper.dataset.view !== view) {
            this.forgetRowGeometry();
        }
        this.wrapper.dataset.view = view;
        // The check box column is there for every row or for none (`filelisting.css`), so a
        // first selection never moves the names.
        this.wrapper.dataset.checkboxes = checkboxes ? 'on' : 'off';
        this.tableHead.querySelectorAll<HTMLElement>('th[aria-sort]').forEach((cell) => {
            const key = cell.querySelector<HTMLElement>('.fx-sort')?.dataset.sort;
            cell.setAttribute('aria-sort', key === sort ? (ascending ? 'ascending' : 'descending') : 'none');
            // The arrow is an icon in a hidden span: the column's name stays the button's name.
            const arrow = cell.querySelector<HTMLElement>('.fx-sort-arrow');
            if (arrow) {
                arrow.innerHTML = key === sort ? iconSvg(ascending ? 'arrowUp' : 'arrowDown', 16) : '';
            }
        });
        try {
            localStorage.setItem(PREFERENCES_KEY, JSON.stringify(this.preferences));
        } catch {
            // A remembered view is a convenience; losing it must not break the explorer.
        }
    }

    // ---------------------------------------------------------------- listing

    /** Brings the folder's list in line with the view settings and the filter. */
    private arrange(): void {
        const { sort, ascending, showHidden } = this.preferences;
        this.folder.arrange({ sort, ascending, showHidden, filter: this.filter });
    }

    /** What the list shows, in its order. It is sorted once per change, not each time it is asked for. */
    private visible(): Entry[] {
        this.arrange();
        return this.folder.visible();
    }

    private hiddenCount(): number {
        this.arrange();
        return this.folder.hiddenCount();
    }

    /**
     * A listing arrives one item at a time. Its rows go on screen on the next frame, and then no
     * more often than every `RENDER_INTERVAL_MS` while more keep coming, so a folder of
     * thousands is sorted and put in order a few times rather than once per frame.
     */
    private scheduleRender(): void {
        if (this.stopped || this.renderHandle || this.renderTimer) {
            return;
        }
        const frame = () => {
            this.renderTimer = undefined;
            this.renderHandle = requestAnimationFrame(() => {
                this.renderHandle = 0;
                this.renderItems();
            });
        };
        const wait = this.renderedAt + RENDER_INTERVAL_MS - performance.now();
        if (wait > 0) {
            this.renderTimer = setTimeout(frame, wait);
        } else {
            frame();
        }
    }

    private cancelRender(): void {
        if (this.renderHandle) {
            cancelAnimationFrame(this.renderHandle);
            this.renderHandle = 0;
        }
        clearTimeout(this.renderTimer);
        this.renderTimer = undefined;
    }

    /**
     * Puts the rows of what the list shows in order. A row is built the first time its item is
     * shown and kept while the item stays the same: the filter, a sort and a listing that grows
     * move rows, they do not build them again. A long list has the rows near the view only.
     */
    private renderItems(): void {
        if (this.stopped) {
            return;
        }
        this.cancelRender();
        this.renderedAt = performance.now();
        this.wrapper.classList.remove('fx-loading');
        const active = document.activeElement;
        const focusedName =
            active instanceof HTMLElement && this.wrapper.contains(active)
                ? active.closest<HTMLElement>('tr[data-name]')?.dataset.name
                : undefined;
        const list = this.visible();
        this.listed = list;
        const shown = (name?: string) => (name !== undefined && this.folder.isShown(name) ? name : undefined);
        const kept = this.rovingFromFocus ? shown(this.rovingName) : undefined;
        const roving = this.rovingName;
        this.rovingName = shown(focusedName) ?? kept ?? list[0]?.name;
        if (RowWindow.windowed(list.length)) {
            this.renderWindow(list);
        } else {
            this.rowWindow.reset();
            this.rows.show(list, { after: list.length ? undefined : this.emptyLine() });
        }
        if (roving !== this.rovingName) {
            this.setStops(roving, -1);
            this.setStops(this.rovingName, 0);
        }
        this.keepFocus(focusedName);
        this.paintRows();
        this.renderStatus();
        this.updateControls();
    }

    /**
     * After rows were put in order: the row that had focus has it again. A row that left the
     * document hands it to the list, so the arrow keys go on from it.
     */
    private keepFocus(focusedName?: string): void {
        const row = focusedName === undefined ? undefined : this.rows.element(focusedName);
        if (row?.isConnected) {
            if (!row.contains(document.activeElement)) {
                row.querySelector<HTMLElement>('.entry-name a')?.focus({ preventScroll: true });
            }
        } else if (row) {
            this.items.focus({ preventScroll: true });
        }
        // With a row to stop on, the list itself is reached by script only.
        const stop = this.rovingName === undefined ? undefined : this.rows.element(this.rovingName);
        this.items.tabIndex = stop?.isConnected ? -1 : 0;
    }

    /**
     * The rows of a long list near the view, between two spacers. The rows are measured after
     * they are in place; when they lie differently from what the range assumed (the first time,
     * or after the view or the width changed), the range is worked out again from them. A
     * measure that stands is kept (`RowWindow.fits`), and each line in the document is kept at
     * the pitch it has, so the spacers stand for the lines as they are.
     */
    private renderWindow(list: Entry[]): void {
        for (let pass = 0; pass < 3; pass++) {
            const settled = this.rowGeometry;
            const assumed = settled ?? this.measureRows() ?? this.guessGeometry();
            const range = this.rowWindow.range(list, this.viewInBody(), assumed);
            this.spacerBefore.style.height = `${range.before}px`;
            this.spacerAfter.style.height = `${range.after}px`;
            this.rows.show(list.slice(range.from, range.to), {
                before: range.before ? this.spacerBefore : undefined,
                after: range.after ? this.spacerAfter : undefined,
            });
            const measured = this.measureRows();
            if (!measured) {
                this.rowGeometry = undefined;
                return;
            }
            if (RowWindow.fits(assumed, measured, !!settled)) {
                this.rowGeometry = settled ?? measured;
                this.measureLines(list, range, measured.columns);
                return;
            }
            this.rowGeometry = measured;
            this.rowWindow.reset();
        }
    }

    /**
     * Keeps the pitch of each line in the document, from the top of one line to the next. The
     * line next to a spacer is left out: where a table shares the border between two rows, it
     * can be half a pixel off. A line is measured once it is between two others.
     */
    private measureLines(list: Entry[], range: RowRange, columns: number): void {
        const rows = this.rows.shown();
        const tops: number[] = [];
        for (let index = 0; index < rows.length; index += columns) {
            tops.push(rows[index].getBoundingClientRect().top);
        }
        const skip = range.before ? 1 : 0;
        const pitches = tops.slice(skip + 1).map((top, index) => top - tops[skip + index]);
        this.rowWindow.measured(list, columns, range.from / columns + skip, pitches);
    }

    /** Forgets how the rows lie, after a change of view or width. */
    private forgetRowGeometry(): void {
        this.rowGeometry = undefined;
        this.rowWindow.forget();
    }

    /** How the rows in the document lie: items per line, and the mean pitch of their lines. */
    private measureRows(): RowGeometry | undefined {
        const rows = this.rows.shown();
        if (rows.length < 2 || !rows[0].isConnected) {
            return undefined;
        }
        const first = rows[0].getBoundingClientRect();
        let columns = 1;
        while (columns < rows.length && Math.abs(rows[columns].getBoundingClientRect().top - first.top) < 1) {
            columns++;
        }
        if (columns >= rows.length) {
            return undefined;
        }
        // From the second line where there is a third: the first line after a spacer can be half
        // a pixel shorter, where a table shares the border between two rows. The pitch is the
        // mean over the lines from there to the last, which differ where tiles do.
        const lines = Math.ceil(rows.length / columns);
        const line = lines > 2 ? 1 : 0;
        const from = rows[line * columns].getBoundingClientRect();
        const next = rows[(line + 1) * columns].getBoundingClientRect();
        const pitch = (rows[(lines - 1) * columns].getBoundingClientRect().top - from.top) / (lines - 1 - line);
        if (pitch <= 0) {
            return undefined;
        }
        const padding = parseFloat(getComputedStyle(this.tableBody).paddingTop) || 0;
        return { columns, pitch, gap: Math.max(0, next.top - from.top - from.height), padding };
    }

    /** A first guess for a list not yet measured: one row per line, each a row high. */
    private guessGeometry(): RowGeometry {
        const row = parseFloat(getComputedStyle(this.wrapper).getPropertyValue('--fx-row')) || 32;
        return { columns: 1, pitch: row + 1, gap: 0, padding: 0 };
    }

    /** The part of the list's body that is in view, measured from the top of the body. */
    private viewInBody(): { top: number; bottom: number } {
        const top = this.items.getBoundingClientRect().top - this.tableBody.getBoundingClientRect().top;
        return { top, bottom: top + this.items.clientHeight };
    }

    /** A scroll or a new width of a long list changes which rows are near the view. */
    private onListScroll = (): void => {
        this.cancelLongPress();
        if (this.windowFrame || !this.rowWindowShown()) {
            return;
        }
        this.windowFrame = requestAnimationFrame(() => {
            this.windowFrame = 0;
            this.updateWindow();
        });
    };

    /** Whether the last render had a long list's rows near the view only. */
    private rowWindowShown(): boolean {
        return !this.stopped && RowWindow.windowed(this.listed.length);
    }

    /** Puts the rows near the view in the document, and nothing else changes. */
    private updateWindow(): void {
        if (!this.rowWindowShown()) {
            return;
        }
        const active = document.activeElement;
        const focusedName =
            active instanceof HTMLElement && this.wrapper.contains(active)
                ? active.closest<HTMLElement>('tr[data-name]')?.dataset.name
                : undefined;
        // The list as it was last put in order: a scroll sorts nothing.
        this.renderWindow(this.listed);
        this.keepFocus(focusedName);
        this.paintRows();
    }

    /** Scrolls a long list so the row of `index` is in the document, for the keyboard. */
    private reveal(list: Entry[], index: number): void {
        const entry = list[index];
        const geometry = this.rowGeometry;
        if (!entry || this.rows.element(entry.name)?.isConnected || !geometry || !RowWindow.windowed(list.length)) {
            return;
        }
        const body =
            this.items.scrollTop + this.tableBody.getBoundingClientRect().top - this.items.getBoundingClientRect().top;
        const line = Math.floor(index / geometry.columns);
        const top = body + this.rowWindow.offset(list, line, geometry);
        if (top < this.items.scrollTop) {
            this.items.scrollTop = top;
        } else {
            this.items.scrollTop = body + this.rowWindow.offset(list, line + 1, geometry) - this.items.clientHeight;
        }
        this.updateWindow();
    }

    /** The rows of several items, from one piece of markup. */
    private buildRows(entries: Entry[]): HTMLElement[] {
        const cut = this.cutNames();
        const prefix = this.linkPrefix();
        const template = document.createElement('template');
        template.innerHTML = entries.map((entry) => this.rowMarkup(entry, cut, prefix)).join('');
        return Array.from(template.content.children) as HTMLElement[];
    }

    private rowMarkup(entry: Entry, cut: ReadonlySet<string>, prefix: string): string {
        const index = this.folder.indexOf(entry.name);
        const directory = entry.isDirectory();
        const selected = this.selection.has(entry.name);
        const name = esc(entry.name);
        const tabIndex = entry.name === this.rovingName ? 0 : -1;
        return `<tr class="fx-row${selected ? ' selected' : ''}${cut.has(entry.name) ? ' fx-cut' : ''}${
            this.menuTargets?.includes(entry.name) ? ' fx-row-menu-open' : ''
        }" data-name="${name}" data-index="${index}" data-kind="${kindOf(entry)}" aria-selected="${selected}">
                <td class="fx-cell-select"><input type="checkbox" class="fx-check" tabindex="-1" aria-label="Select ${name}"${
                    selected ? ' checked' : ''
                }></td>
                <td class="entry-name">
                    <a class="${directory ? 'dir' : 'file'}" href="${esc(
                        this.link(path.join(this.path, entry.name), prefix),
                    )}" data-name="${name}" data-entry-id="${index}" tabindex="${tabIndex}" aria-label="${
                        entry.isFile() ? 'Download' : 'Open'
                    } ${name}">${iconMarkup(kindOf(entry))}<span class="fx-name">${name}</span></a>
                </td>
                <td class="entry-size" data-label="Size">${directory ? '—' : esc(formatSize(entry.size))}</td>
                <td class="entry-type" data-label="Type">${esc(typeLabel(entry))}</td>
                <td class="entry-time" data-label="Modified">${esc(formatModified(entry.mtime))}</td>
                <td class="fx-cell-menu"><button type="button" class="${ICON_BUTTON} fx-row-menu" tabindex="${tabIndex}" aria-haspopup="menu" aria-label="Actions for ${name}">${ROW_MENU_ICON}</button></td>
            </tr>`;
    }

    /** A row still shows an item when nothing the row says about it changed. */
    private static sameEntry(before: Entry, after: Entry): boolean {
        return (
            before.name === after.name &&
            before.mode === after.mode &&
            before.size === after.size &&
            before.mtime.getTime() === after.mtime.getTime()
        );
    }

    /** The names in this folder that a Cut is waiting to move. */
    private cutNames(): ReadonlySet<string> {
        return new Set(this.clipboard?.mode === 'cut' && this.clipboard.dir === this.path ? this.clipboard.names : []);
    }

    /** The line in place of rows: loading, empty, no match, or why the folder could not be opened. */
    private emptyLine(): HTMLElement {
        let markup: string;
        if (this.listingError && !this.loading) {
            // The failure is shown where the rows would be, with the two ways out of it. An
            // empty list next to a small error line read as "this folder is empty".
            markup = `<tr class="fx-empty-row"><td colspan="6" class="fx-empty"><div class="fx-failed-box" role="alert">
                <strong>This folder could not be opened</strong>
                <span class="fx-failed-reason">${esc(this.listingError)}</span>
                <span class="fx-failed-path">${esc(this.path)}</span>
                <span class="fx-failed-actions">
                    <button type="button" class="${BUTTON}" data-command="refresh">Retry</button>
                    ${
                        this.path === '/'
                            ? ''
                            : `<button type="button" class="${BUTTON}" data-command="up">Up one folder</button>`
                    }
                </span>
            </div></td></tr>`;
        } else {
            const message = this.loading
                ? 'Loading folder…'
                : this.folder.size
                  ? 'No items match the filter.'
                  : !this.hasConnection()
                    ? '' // Offline or still connecting: nothing was listed, so the folder is not known to be empty.
                    : 'This folder is empty.';
            markup = `<tr class="fx-empty-row"><td colspan="6" class="fx-empty">${esc(message)}</td></tr>`;
        }
        if (this.emptyRow?.key !== markup) {
            const template = document.createElement('template');
            template.innerHTML = markup;
            this.emptyRow = { key: markup, element: template.content.firstElementChild as HTMLElement };
        }
        return this.emptyRow.element;
    }

    /**
     * Selection changes must not rebuild the rows. Replacing the node between the two clicks of a
     * double click loses the `dblclick` event entirely, so opening an item with a mouse silently
     * stopped working; repainting in place also keeps scroll position and focus.
     */
    private paintSelection(): void {
        this.paintRows();
        this.renderStatus();
        this.updateControls();
    }

    /** The selected and cut look of the rows on screen, changed only where it differs. */
    private paintRows(): void {
        const cut = this.cutNames();
        for (const row of this.rows.shown()) {
            const name = row.dataset.name as string;
            const selected = this.selection.has(name);
            if (row.classList.contains('selected') !== selected) {
                row.classList.toggle('selected', selected);
                row.setAttribute('aria-selected', String(selected));
            }
            if (row.classList.contains('fx-cut') !== cut.has(name)) {
                row.classList.toggle('fx-cut', cut.has(name));
            }
            const check = row.querySelector<HTMLInputElement>('.fx-check');
            if (check && check.checked !== selected) {
                check.checked = selected;
            }
        }
    }

    /** The Tab stops of one row: its name and its menu button. */
    private setStops(name: string | undefined, tabIndex: number): void {
        const row = name === undefined ? undefined : this.rows.element(name);
        row?.querySelectorAll<HTMLElement>('.entry-name a, .fx-row-menu').forEach(
            (element) => (element.tabIndex = tabIndex),
        );
    }

    /** Moves the list's Tab stop to the row that took focus. */
    private onRowFocus = (event: FocusEvent): void => {
        const name = (event.target as Element | null)?.closest<HTMLElement>('tr[data-name]')?.dataset.name;
        if (name === undefined) {
            return;
        }
        this.rovingFromFocus = true;
        if (name === this.rovingName) {
            return;
        }
        this.setStops(this.rovingName, -1);
        this.rovingName = name;
        this.setStops(name, 0);
    };

    private renderStatus(): void {
        const list = this.visible();
        const selected = list.filter((entry) => this.selection.has(entry.name));
        const bytes = selected.reduce((total, entry) => total + (entry.isDirectory() ? 0 : entry.size), 0);
        const hidden = this.hiddenCount();
        const total = this.folder.size;
        const parts =
            this.listingError && !this.loading
                ? []
                : [this.filter ? `${list.length} of ${total} items` : `${total} items`];
        if (hidden) {
            parts.push(`${hidden} hidden`);
        }
        if (selected.length) {
            parts.push(`${selected.length} selected${bytes ? ` · ${formatSize(bytes)}` : ''}`);
        }
        this.counts.textContent = parts.join(' · ');
        const checkAll = this.wrapper.querySelector<HTMLInputElement>('.fx-check-all');
        if (checkAll) {
            checkAll.checked = list.length > 0 && selected.length === list.length;
            checkAll.indeterminate = selected.length > 0 && selected.length < list.length;
        }
    }

    /**
     * The status line: what is in progress, next to the counts. Results and failures go to
     * `toast`, where the whole message fits and stays long enough to read.
     */
    private report(message: string, error = false): void {
        // Requests cut off by a lost connection would each ask for a refresh that cannot work.
        if (this.stopped || this.offline) {
            return;
        }
        this.status.textContent = message;
        this.status.classList.toggle('error', error);
        this.status.setAttribute('role', error ? 'alert' : 'status');
    }

    /** The app's toast: the result of an action, or why it failed, naming the item. */
    private toast(message: string, error = false): void {
        if (this.stopped) {
            return;
        }
        if (!this.active) {
            // Nobody sees a hidden explorer. A failure is kept over a result that follows it.
            if (error || !this.missed?.error) {
                this.missed = { message, error };
            }
            return;
        }
        this.toastCount++;
        this.renderToast(message, error);
    }

    private renderToast(message: string, error: boolean): void {
        render(
            h(Toast, {
                message,
                identity: this.toastCount,
                tone: error ? 'error' : 'success',
                duration: error ? 12000 : 6000,
                onDismiss: () => this.renderToast('', error),
            }),
            this.toastHost,
        );
    }

    private canModify(): boolean {
        // Uploads run beside everything else: each one goes to the folder it was started in.
        return !this.stopped && this.hasConnection() && !this.loading && !this.operations && !this.resolving;
    }

    private updateControls(): void {
        const ready = this.canModify();
        const selected = this.selectedEntries();
        const files = selected.filter((entry) => entry.isFile());
        const enable = (command: string, value: boolean) => {
            [this.buttons.get(command), this.barButtons.get(command)].forEach((button) => {
                if (button) {
                    button.disabled = !value;
                }
            });
        };
        enable('back', this.historyIndex > 0);
        enable('forward', this.historyIndex < this.historyTop);
        enable('up', this.path !== '/');
        enable('refresh', !this.stopped && this.hasConnection() && !this.loading);
        enable('upload', ready);
        enable('new-folder', ready);
        enable('download', ready && files.length > 0);
        enable('rename', ready && selected.length === 1);
        enable('delete', ready && selected.length > 0);
        enable('cut', ready && selected.length > 0);
        enable('copy', ready && selected.length > 0);
        enable('paste', ready && !!this.clipboard?.names.length);
        this.buttons.get('selection-mode')?.setAttribute('aria-pressed', String(this.selectionMode));
        this.wrapper.classList.toggle('fx-selecting', this.selecting());
        // A narrow phone shows the number alone; the word stays for screen readers.
        this.selectionCount.innerHTML = `${selected.length}<span class="fx-selection-word"> selected</span>`;
        this.wrapper.setAttribute('aria-busy', String(this.loading));
    }

    private selectedEntries(): Entry[] {
        return this.folder.all().filter((entry) => this.selection.has(entry.name));
    }

    /** Selection mode, or anything selected: the checkboxes show and the selection bar replaces history. */
    private selecting(): boolean {
        return this.selectionMode || this.selection.size > 0;
    }

    /** What a command acts on: the row a ⋮ menu was opened for, or else the selection. */
    private targetEntries(targets?: string[]): Entry[] {
        if (!targets) {
            return this.selectedEntries();
        }
        return this.folder.all().filter((entry) => targets.includes(entry.name));
    }

    // ---------------------------------------------------------------- input

    private onClick = (event: MouseEvent): void => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || !this.wrapper.contains(target)) {
            return;
        }
        const menuItem = target.closest<HTMLElement>('.files-menu [data-menu]');
        if (menuItem) {
            event.preventDefault();
            this.runMenuItem(menuItem);
            return;
        }
        const cancelUpload = target.closest<HTMLElement>('[data-upload-cancel]');
        if (cancelUpload) {
            event.preventDefault();
            const key = cancelUpload.dataset.uploadCancel;
            if (key === 'all') {
                this.filePushHandler?.cancelAll();
            } else {
                this.filePushHandler?.cancel(Number(key));
            }
            return;
        }
        const place = target.closest<HTMLElement>('[data-place]');
        if (place) {
            event.preventDefault();
            this.navigate(place.dataset.place as string);
            return;
        }
        const sort = target.closest<HTMLElement>('.fx-sort');
        if (sort) {
            event.preventDefault();
            this.sortBy(sort.dataset.sort as SortKey);
            return;
        }
        const command = target.closest<HTMLElement>('[data-command]');
        if (command && !(command as HTMLButtonElement).disabled && !target.closest('.fx-address-input')) {
            event.preventDefault();
            this.runCommand(command.dataset.command as string);
            return;
        }
        const row = target.closest<HTMLElement>('tr[data-name]');
        if (!row) {
            if (!target.closest('.files-menu')) {
                this.closeMenu();
            }
            return;
        }
        // A row's menu button closes the menu it opened.
        const rowMenu = target.closest<HTMLElement>('.fx-row-menu');
        const wasOpenHere = !!rowMenu && rowMenu === this.menuAnchor;
        this.closeMenu();
        const name = row.dataset.name as string;
        if (Date.now() - this.longPressedAt < 600) {
            // The long press already put this row into multi-select; the trailing click must
            // not toggle it straight back out.
            event.preventDefault();
            return;
        }
        if (rowMenu) {
            // The menu acts on its own row and leaves the selection as it is.
            event.preventDefault();
            if (!wasOpenHere) {
                this.openRowMenu(rowMenu, name);
            }
            return;
        }
        if (target.closest('.fx-check')) {
            this.toggleSelection(name);
            return;
        }
        const anchor = target.closest<HTMLAnchorElement>('a[data-name]');
        const coarse = matchMedia(COARSE_POINTER).matches;
        // `detail === 0` marks keyboard activation of the link, which must open the item.
        const opens = coarse || event.detail === 0;
        if (event.shiftKey) {
            event.preventDefault();
            this.selectRange(name);
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            this.toggleSelection(name);
            return;
        }
        // On touch the whole row is the target, so the name link need not be 44px by itself.
        if (anchor || coarse) {
            event.preventDefault();
            if (this.selectionMode) {
                this.toggleSelection(name);
            } else if (opens) {
                const entry = this.folder.get(name);
                if (coarse && event.detail !== 0 && entry?.isFile()) {
                    // A tap is also how a list is scrolled past and a folder opened. It does not
                    // start a download; it asks what to do with the file.
                    void this.askAboutFile(entry);
                } else {
                    this.open(name);
                }
            } else {
                this.selectOnly(name);
            }
            return;
        }
        if (this.selectionMode) {
            this.toggleSelection(name);
        } else {
            this.selectOnly(name);
        }
    };

    private onDoubleClick = (event: MouseEvent): void => {
        const row = event.target instanceof Element ? event.target.closest<HTMLElement>('tr[data-name]') : null;
        if (!row || this.selectionMode || event.ctrlKey || event.metaKey || event.shiftKey) {
            return;
        }
        event.preventDefault();
        this.open(row.dataset.name as string);
    };

    private onContextMenu = (event: MouseEvent): void => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || !this.wrapper.contains(target) || target.closest('input, textarea')) {
            return;
        }
        const row = target.closest<HTMLElement>('tr[data-name]');
        event.preventDefault();
        if (matchMedia(COARSE_POINTER).matches) {
            // A touch long press is handled by the pointer timer (multi-select); only the native
            // callout is suppressed here.
            return;
        }
        if (row) {
            const name = row.dataset.name as string;
            if (!this.selection.has(name)) {
                this.selectOnly(name);
            }
            this.openMenu(() => this.itemMenuItems(), { x: event.clientX, y: event.clientY }, MENU_LABELS.item);
        } else if (target.closest('.fx-items')) {
            this.openMenu(() => this.folderMenuItems(), { x: event.clientX, y: event.clientY }, MENU_LABELS.folder);
        }
    };

    private onPointerDown = (event: PointerEvent): void => {
        if (event.pointerType === 'mouse' || event.button !== 0) {
            return;
        }
        const row = event.target instanceof Element ? event.target.closest<HTMLElement>('tr[data-name]') : null;
        if (!row) {
            return;
        }
        const name = row.dataset.name as string;
        this.cancelLongPress();
        // A long press is the touch equivalent of right-click: it starts multi-select.
        this.longPressTimer = setTimeout(() => {
            this.longPressTimer = undefined;
            this.longPressedAt = Date.now();
            this.selectionMode = true;
            this.selection.add(name);
            this.anchorName = name;
            this.paintSelection();
        }, LONG_PRESS_MS);
    };

    private cancelLongPress = (): void => {
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = undefined;
        }
    };

    private onKeyDown = (event: KeyboardEvent): void => {
        // Keys pressed in a dialog bubble up to here. They belong to the dialog: Escape must
        // close it, not clear the selection behind it.
        if (!this.active || this.dialog.open) {
            return;
        }
        const target = event.target as HTMLElement | null;
        // A key pressed in the open menu is the menu's. The kit answers the ones it knows; the
        // rest must not start a command on the list behind it.
        if (this.unbindMenu && target && this.menu.contains(target)) {
            return;
        }
        const typing = !!target?.closest('input, textarea, select');
        if (event.key === 'Escape') {
            // Escape with focus outside the open menu still closes it.
            if (this.unbindMenu) {
                this.closeMenu();
                event.preventDefault();
            } else if (typing && target === this.filterInput) {
                this.setFiltering(false);
                this.items.focus();
            } else if (this.selection.size || this.selectionMode) {
                this.clearSelection();
                event.preventDefault();
            }
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
            event.preventDefault();
            this.filterInput.focus();
            this.filterInput.select();
            return;
        }
        if (typing) {
            return;
        }
        const list = this.visible();
        if (list !== this.listed && RowWindow.windowed(list.length)) {
            // Items arrived since the rows were put in order; the keys move over what is shown.
            this.renderItems();
        }
        // In a long list the row that had focus may have scrolled out of the document; the list
        // then holds focus, and the keys go on from that row.
        const current =
            target?.closest<HTMLElement>('tr[data-name]')?.dataset.name ??
            (target === this.items && RowWindow.windowed(list.length) ? this.rovingName : undefined);
        const index = list.findIndex((entry) => entry.name === current);
        const focusAt = (next: number) => {
            const at = Math.max(0, Math.min(list.length - 1, next));
            const entry = list[at];
            if (!entry) {
                return;
            }
            this.reveal(list, at);
            const anchor = this.rows.element(entry.name)?.querySelector<HTMLElement>('.entry-name a');
            anchor?.focus();
            anchor?.scrollIntoView({ block: 'nearest' });
            if (event.shiftKey) {
                this.selectRange(entry.name);
            }
        };
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            focusAt(index + 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            focusAt(index < 0 ? 0 : index - 1);
        } else if (event.key === 'Home') {
            event.preventDefault();
            focusAt(0);
        } else if (event.key === 'End') {
            event.preventDefault();
            focusAt(list.length - 1);
        } else if (event.key === ' ' && current && !target?.closest('button')) {
            // Space on the row's menu button presses that button.
            event.preventDefault();
            this.toggleSelection(current);
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            this.runCommand('select-all');
        } else if (event.key === 'Backspace' || (event.altKey && event.key === 'ArrowLeft')) {
            event.preventDefault();
            this.runCommand(event.altKey ? 'back' : 'up');
        } else if (event.key === 'F5') {
            event.preventDefault();
            this.runCommand('refresh');
        } else if (event.key === 'F2') {
            event.preventDefault();
            this.runCommand('rename');
        } else if (event.key === 'Delete') {
            event.preventDefault();
            this.runCommand('delete');
        } else if ((event.ctrlKey || event.metaKey) && ['x', 'c', 'v'].includes(event.key.toLowerCase())) {
            event.preventDefault();
            this.runCommand({ x: 'cut', c: 'copy', v: 'paste' }[event.key.toLowerCase() as 'x' | 'c' | 'v']);
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            // Explorer type-ahead: repeated letters walk matching names.
            const now = Date.now();
            this.typeAhead.text = now - this.typeAhead.at > 900 ? event.key : this.typeAhead.text + event.key;
            this.typeAhead.at = now;
            const prefix = this.typeAhead.text.toLowerCase();
            const from = this.typeAhead.text.length > 1 ? Math.max(0, index) : index + 1;
            const order = [...list.slice(from), ...list.slice(0, from)];
            const match = order.find((entry) => entry.name.toLowerCase().startsWith(prefix));
            if (match) {
                event.preventDefault();
                focusAt(list.indexOf(match));
            }
        }
    };

    private onAddressKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Enter') {
            event.preventDefault();
            const value = this.addressInput.value.trim();
            this.closeAddressInput();
            if (value) {
                this.navigate(value);
            }
        } else if (event.key === 'Escape') {
            event.preventDefault();
            this.closeAddressInput();
        }
    };

    /** On a phone the filter field is a row of its own that only exists while filtering. */
    private setFiltering(active: boolean): void {
        this.wrapper.classList.toggle('fx-filtering', active);
        this.buttons.get('filter-toggle')?.setAttribute('aria-pressed', String(active));
        if (active) {
            this.filterInput.focus();
            this.filterInput.select();
        } else if (this.filter || this.filterInput.value) {
            this.filterInput.value = '';
            this.filter = '';
            this.renderItems();
        }
    }

    /** Swaps the crumbs for a field holding the whole path, selected, until Enter/Escape/blur. */
    private openAddressInput(): void {
        this.addressInput.value = this.path;
        this.addressInput.hidden = false;
        this.breadcrumb.hidden = true;
        this.addressInput.focus();
        // `select()` is ignored by iOS Safari; a range covers the whole path everywhere, so typing
        // replaces it rather than appending to it.
        this.addressInput.setSelectionRange(0, this.addressInput.value.length);
    }

    private closeAddressInput(): void {
        this.addressInput.hidden = true;
        this.breadcrumb.hidden = false;
    }

    // ---------------------------------------------------------------- selection

    private selectOnly(name: string): void {
        this.selection = new Set([name]);
        this.anchorName = name;
        this.paintSelection();
    }

    private toggleSelection(name: string): void {
        if (this.selection.has(name)) {
            this.selection.delete(name);
        } else {
            this.selection.add(name);
            this.anchorName = name;
        }
        this.paintSelection();
    }

    private selectRange(name: string): void {
        const list = this.visible();
        const to = list.findIndex((entry) => entry.name === name);
        const from = this.anchorName ? list.findIndex((entry) => entry.name === this.anchorName) : to;
        if (to < 0) {
            return;
        }
        const [start, end] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
        this.selection = new Set(list.slice(start, end + 1).map((entry) => entry.name));
        this.paintSelection();
    }

    private clearSelection(): void {
        this.selection.clear();
        this.selectionMode = false;
        this.anchorName = undefined;
        this.paintSelection();
    }

    // ---------------------------------------------------------------- menus

    private itemMenuItems(selected = this.selectedEntries()): string[] {
        const single = selected.length === 1 ? selected[0] : undefined;
        const files = selected.filter((entry) => entry.isFile()).length;
        const items: string[] = [];
        if (single) {
            items.push(this.menuItem('open', single.isDirectory() ? 'Open' : 'Download'));
        } else if (files) {
            items.push(this.menuItem('download', `Download ${files} file${files === 1 ? '' : 's'}`));
        }
        items.push(MENU_SEPARATOR);
        items.push(this.menuItem('cut', 'Cut'));
        items.push(this.menuItem('copy', 'Copy'));
        items.push(this.menuItem('paste', 'Paste', !this.clipboard?.names.length));
        items.push(this.menuItem('copy-path', 'Copy path'));
        items.push(MENU_SEPARATOR);
        items.push(this.menuItem('rename', 'Rename', selected.length !== 1));
        items.push(this.menuItem('delete', 'Delete', false, true));
        items.push(MENU_SEPARATOR);
        items.push(this.menuItem('properties', 'Properties', selected.length !== 1));
        return items;
    }

    private folderMenuItems(): string[] {
        return [
            this.menuItem('refresh', 'Refresh'),
            this.menuItem('new-folder', 'New folder'),
            this.menuItem('upload', 'Upload files'),
            this.menuItem('paste', 'Paste', !this.clipboard?.names.length),
            MENU_SEPARATOR,
            this.menuItem('select-all', 'Select all'),
        ];
    }

    /**
     * The phone command bar: every toolbar command in one menu, so the address bar can have a
     * whole line to itself. Selection commands come first, exactly as the row menu lists them.
     */
    private actionsMenuItems(): string[] {
        const ready = this.canModify();
        const selected = this.selectedEntries();
        const items = selected.length ? [...this.itemMenuItems(), MENU_SEPARATOR] : [];
        items.push(
            this.menuItem('upload', 'Upload files', !ready),
            this.menuItem('new-folder', 'New folder', !ready),
            ...(selected.length ? [] : [this.menuItem('paste', 'Paste', !ready || !this.clipboard?.names.length)]),
            this.menuItem('refresh', 'Refresh', !this.hasConnection() || this.loading),
            MENU_SEPARATOR,
            this.checkItem('menuitemcheckbox', 'Select items', this.selectionMode, 'command', 'selection-mode'),
            this.menuItem('select-all', 'Select all'),
            MENU_SEPARATOR,
            '<button type="button" class="kit-menu-item" role="menuitem" tabindex="-1" data-menu="submenu" data-value="view">View options…</button>',
        );
        return items;
    }

    private viewSubmenuItems(): string[] {
        return [
            `<button type="button" class="kit-menu-item" role="menuitem" tabindex="-1" data-menu="submenu" data-value="actions">${iconSvg(
                'back',
                20,
            )}Back</button>`,
            MENU_SEPARATOR,
            ...this.viewMenuItems(),
        ];
    }

    /** Quick access as a menu, for every width where the sidebar would crowd out the listing. */
    private placesMenuItems(): string[] {
        return [
            '<div class="kit-menu-title" role="presentation">Quick access</div>',
            ...PLACES.map((place) =>
                this.checkItem('menuitemradio', place.title, place.path === this.path, 'place', place.path),
            ),
        ];
    }

    private viewMenuItems(): string[] {
        const { view, sort, ascending, showHidden, checkboxes } = this.preferences;
        const radio = (value: string, title: string, checked: boolean, key: string) =>
            this.checkItem('menuitemradio', title, checked, key, value);
        return [
            '<div class="kit-menu-title" role="presentation">Layout</div>',
            radio('details', 'Details', view === 'details', 'view'),
            radio('list', 'List', view === 'list', 'view'),
            radio('tiles', 'Tiles', view === 'tiles', 'view'),
            MENU_SEPARATOR,
            '<div class="kit-menu-title" role="presentation">Sort by</div>',
            ...(Object.keys(SORT_TITLES) as SortKey[]).map((key) => radio(key, SORT_TITLES[key], sort === key, 'sort')),
            // What to sort by and which way are two choices: a line between them.
            MENU_SEPARATOR,
            radio('asc', 'Ascending', ascending, 'order'),
            radio('desc', 'Descending', !ascending, 'order'),
            MENU_SEPARATOR,
            this.checkItem('menuitemcheckbox', 'Hidden items', showHidden, 'hidden'),
            this.checkItem('menuitemcheckbox', 'Item check boxes', checkboxes, 'checkboxes'),
        ];
    }

    /** A kit menu item that runs a command. `danger` is for one that removes something. */
    private menuItem(command: string, title: string, disabled = false, danger = false): string {
        return `<button type="button" class="kit-menu-item${
            danger ? ' kit-menu-danger' : ''
        }" role="menuitem" tabindex="-1" data-menu="command" data-value="${command}"${
            disabled ? ' disabled' : ''
        }>${esc(title)}</button>`;
    }

    /** A kit menu item that is on or off, or one of a set. Its check is always drawn. */
    private checkItem(
        role: 'menuitemcheckbox' | 'menuitemradio',
        title: string,
        checked: boolean,
        kind: string,
        value = '',
    ): string {
        return `<button type="button" class="kit-menu-item" role="${role}" aria-checked="${checked}" tabindex="-1" data-menu="${kind}" data-value="${esc(
            value,
        )}">${CHECK}${esc(title)}</button>`;
    }

    /**
     * Opens the one menu at its button, or at a point for a context menu. `bindMenu` places it
     * in the top layer, gives it the arrow keys and a history entry, and asks for it to close
     * on Escape, Tab, a press outside and the browser's Back.
     */
    private openMenu(build: () => string[], anchor: MenuAnchor, label: string): void {
        // A menu that is open gives way first: its keys, its entry and its button are its own.
        this.closeMenu();
        this.claimForward();
        this.menuBuilder = build;
        this.menuAnchor = anchor;
        this.menu.setAttribute('aria-label', label);
        this.menu.innerHTML = build().join('');
        this.menu.scrollTop = 0;
        // Shown before it is bound: the kit measures the menu and gives its first item focus.
        transitionVisibility(this.menu, true);
        this.unbindMenu = bindMenu(this.menu, anchor, () => this.closeMenu());
    }

    private openRowMenu(button: HTMLElement, name: string): void {
        const targets = [name];
        this.openMenu(() => this.itemMenuItems(this.targetEntries(targets)), button, MENU_LABELS.item);
        // Set after `openMenu`, which forgets the targets of the menu it replaces.
        this.menuTargets = targets;
        button.closest('tr')?.classList.add('fx-row-menu-open');
    }

    private forgetMenuTargets(): void {
        this.menuTargets = undefined;
        this.tableBody.querySelectorAll('.fx-row-menu-open').forEach((row) => row.classList.remove('fx-row-menu-open'));
    }

    /**
     * Builds the items of the open menu again. The kit placed the menu for the items it had
     * and gave one of them focus, so both are done again here: the new items may be taller
     * (View options inside Actions), and focus went with the old ones.
     */
    private refreshMenu(focus?: string): void {
        if (!this.unbindMenu || !this.menuBuilder || !this.menuAnchor) {
            return;
        }
        this.menu.innerHTML = this.menuBuilder().join('');
        placeMenu(this.menu, this.menuAnchor);
        const target = focus ? this.menu.querySelector<HTMLElement>(focus) : null;
        (target || this.menu.querySelector<HTMLElement>('.kit-menu-item:not(:disabled)') || this.menu).focus();
    }

    private closeMenu(): void {
        const unbind = this.unbindMenu;
        if (!unbind) {
            return;
        }
        this.unbindMenu = undefined;
        // Ends the keys, the press outside and the history entry, and returns focus to the button.
        unbind();
        transitionVisibility(this.menu, false, () => {
            this.menu.innerHTML = '';
            this.leaveTopLayer();
        });
        this.menuBuilder = undefined;
        this.menuAnchor = undefined;
        this.forgetMenuTargets();
        ['view-menu', 'places', 'actions'].forEach((command) =>
            this.buttons.get(command)?.setAttribute('aria-expanded', 'false'),
        );
    }

    /** A closed menu leaves the top layer, where `bindMenu` put it. */
    private leaveTopLayer(): void {
        if (typeof this.menu.hidePopover === 'function' && this.menu.matches(':popover-open')) {
            this.menu.hidePopover();
        }
    }

    private runMenuItem(item: HTMLElement): void {
        const kind = item.dataset.menu;
        const value = item.dataset.value || '';
        if (kind === 'command') {
            const targets = this.menuTargets;
            this.closeMenu();
            this.runCommand(value, targets);
            return;
        }
        if (kind === 'place') {
            this.closeMenu();
            this.navigate(value);
            return;
        }
        if (kind === 'submenu') {
            this.menuBuilder = value === 'view' ? () => this.viewSubmenuItems() : () => this.actionsMenuItems();
            this.refreshMenu();
            return;
        }
        if (kind === 'view') {
            this.preferences.view = value as ViewMode;
        } else if (kind === 'sort') {
            this.preferences.sort = value as SortKey;
        } else if (kind === 'order') {
            this.preferences.ascending = value === 'asc';
        } else if (kind === 'hidden') {
            this.preferences.showHidden = !this.preferences.showHidden;
        } else if (kind === 'checkboxes') {
            this.preferences.checkboxes = !this.preferences.checkboxes;
        }
        this.applyPreferences();
        this.renderItems();
        // The View menu stays open while several settings are adjusted, like Explorer's ribbon.
        // Focus stays on the item that was chosen.
        this.refreshMenu(`[data-menu="${kind}"][data-value="${CSS.escape(value)}"]`);
    }

    private sortBy(key: SortKey): void {
        if (this.preferences.sort === key) {
            this.preferences.ascending = !this.preferences.ascending;
        } else {
            this.preferences.sort = key;
            this.preferences.ascending = true;
        }
        this.applyPreferences();
        this.renderItems();
    }

    // ---------------------------------------------------------------- commands

    /**
     * `targets` names the row a ⋮ menu was opened for. Without it, item commands act on the
     * selection, and a command that is done with the selection ends selection mode: the
     * checkboxes go away and a tap opens a folder again.
     */
    private runCommand(command: string, targets?: string[]): void {
        // Keyboard shortcuts reach the same commands as the (already disabled) buttons do.
        const MODIFYING = ['upload', 'download', 'new-folder', 'rename', 'delete', 'paste'];
        if (MODIFYING.includes(command) && !this.canModify()) {
            return;
        }
        switch (
            command as
                | Command
                | 'back'
                | 'forward'
                | 'up'
                | 'edit-path'
                | 'home'
                | 'view-menu'
                | 'places'
                | 'actions'
                | 'filter-toggle'
                | 'selection-mode'
                | 'end-selection'
        ) {
            case 'back':
                // Never past the entry Files was opened on: that Back belongs to the browser.
                if (this.historyIndex > 0) {
                    history.back();
                }
                return;
            case 'forward':
                if (this.historyIndex < this.historyTop) {
                    history.forward();
                }
                return;
            case 'up':
                if (this.path !== '/') {
                    this.navigate(path.dirname(this.path));
                }
                return;
            case 'refresh':
                this.reload();
                return;
            case 'home':
                this.navigate('/');
                return;
            case 'edit-path':
                if (this.addressInput.hidden) {
                    this.openAddressInput();
                }
                return;
            case 'view-menu':
            case 'places':
            case 'actions': {
                const button = this.buttons.get(command);
                if (!button) {
                    return;
                }
                // The button closes the menu it opened.
                if (this.menuAnchor === button) {
                    this.closeMenu();
                    return;
                }
                if (command === 'view-menu') {
                    this.openMenu(() => this.viewMenuItems(), button, MENU_LABELS.view);
                } else if (command === 'places') {
                    this.openMenu(() => this.placesMenuItems(), button, MENU_LABELS.places);
                } else {
                    this.openMenu(() => this.actionsMenuItems(), button, MENU_LABELS.actions);
                }
                // Set after `openMenu`, which closes the menu before it.
                button.setAttribute('aria-expanded', 'true');
                return;
            }
            case 'filter-toggle':
                this.setFiltering(!this.wrapper.classList.contains('fx-filtering'));
                return;
            case 'selection-mode':
                this.selectionMode = !this.selectionMode;
                if (!this.selectionMode) {
                    this.selection.clear();
                }
                this.paintSelection();
                return;
            case 'end-selection':
                this.clearSelection();
                return;
            case 'select-all':
                this.visible().forEach((entry) => this.selection.add(entry.name));
                // On touch the selection is a mode: taps now add and remove rows.
                if (matchMedia(COARSE_POINTER).matches) {
                    this.selectionMode = true;
                }
                this.paintSelection();
                return;
            case 'upload':
                this.picker.click();
                return;
            case 'open': {
                const [entry] = this.targetEntries(targets);
                if (entry) {
                    this.open(entry.name);
                }
                return;
            }
            case 'download': {
                const files = this.targetEntries(targets).filter((entry) => entry.isFile());
                files.forEach((entry) => this.download(path.join(this.path, entry.name), entry, files.length === 1));
                if (files.length > 1) {
                    this.toast(`Downloads of ${files.length} files started in your browser.`);
                }
                this.doneWithSelection(targets);
                return;
            }
            case 'copy-path': {
                const paths = this.targetEntries(targets).map((entry) => path.join(this.path, entry.name));
                void this.copyText(paths.join('\n'));
                this.doneWithSelection(targets);
                return;
            }
            case 'cut':
            case 'copy': {
                const selected = this.targetEntries(targets);
                const names = selected.map((entry) => entry.name);
                if (!names.length) {
                    return;
                }
                const folders = selected.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
                this.clipboard = { mode: command as Clipboard['mode'], dir: this.path, names, folders };
                const count = `${names.length} item${names.length === 1 ? '' : 's'}`;
                this.toast(
                    command === 'cut'
                        ? `${count} ready to move. Open the destination folder and choose Paste.`
                        : `${count} ready to paste.`,
                );
                this.paintSelection();
                this.doneWithSelection(targets);
                return;
            }
            case 'paste':
                void this.paste();
                return;
            case 'new-folder':
                void this.createFolder();
                return;
            case 'rename':
                void this.rename(this.targetEntries(targets));
                return;
            case 'delete':
                void this.remove(this.targetEntries(targets));
                return;
            case 'properties':
                this.showProperties(this.targetEntries(targets));
                return;
        }
    }

    /** A command that acted on the selection ends selection mode. A ⋮ menu leaves it alone. */
    private doneWithSelection(targets?: string[]): void {
        if (!targets) {
            this.clearSelection();
        }
    }

    private open(name: string): void {
        const entry = this.folder.get(name);
        const destination = path.resolve(this.path, name);
        if (entry?.isFile()) {
            this.download(destination, entry);
        } else {
            this.navigate(destination);
        }
    }

    /**
     * The sheet a tap on a file opens on a touch screen: what the file is, and Download, Rename
     * and Delete. Each runs the command of the row's menu for this one file.
     */
    private async askAboutFile(entry: Entry): Promise<void> {
        const off = this.canModify() ? '' : ' disabled';
        const facts = [formatSize(entry.size), typeLabel(entry), formatModified(entry.mtime)].filter(Boolean);
        this.dialog.innerHTML = this.sheetMarkup({
            title: entry.name,
            close: 'Close',
            className: 'fx-file-sheet',
            body: `<p class="fx-dialog-message">${esc(facts.join(' · '))}</p>
                <div class="fx-file-actions">
                    <button type="submit" class="${ANSWER_PRIMARY}" value="download"${off}>Download</button>
                    <button type="submit" class="${ANSWER}" value="rename"${off}>Rename</button>
                    <button type="submit" class="${ANSWER_DANGER}" value="delete"${off}>Delete</button>
                </div>`,
            actions: `<button type="button" class="${ANSWER}" data-dialog="cancel">Cancel</button>`,
        });
        const result = await this.showDialog(() => {
            // Cancel is the default, as for the app's other sheets that can remove something.
            this.dialog.querySelector<HTMLButtonElement>('[data-dialog="cancel"]')?.focus();
        });
        if (result === 'download' || result === 'rename' || result === 'delete') {
            this.runCommand(result, [entry.name]);
        }
    }

    private async copyText(text: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            this.toast('Copied to the clipboard.');
        } catch {
            // Insecure origins and denied permissions both land here; show the path to copy by hand.
            this.toast(text);
        }
    }

    private async createFolder(): Promise<void> {
        const name = await this.prompt({
            title: 'New folder',
            label: 'Folder name',
            value: 'New folder',
            confirm: 'Create',
            check: (value) => this.checkName(value),
        });
        if (!name) {
            return;
        }
        const destination = path.join(this.path, name);
        this.mutate(() => this.files.mkdir(destination), `Creating ${name}…`, {
            success: `Created ${name}.`,
            failure: `Could not create “${name}”`,
        });
    }

    private async rename(entries: Entry[]): Promise<void> {
        const [entry] = entries;
        if (!entry || entries.length !== 1) {
            return;
        }
        const name = await this.prompt({
            title: 'Rename',
            label: 'New name',
            value: entry.name,
            confirm: 'Rename',
            selectBase: entry.isFile(),
            // Keeping the name is not an error; it just renames nothing.
            check: (value) => (value === entry.name ? '' : this.checkName(value)),
        });
        if (!name || name === entry.name) {
            return;
        }
        const from = path.join(this.path, entry.name);
        const to = path.join(this.path, name);
        this.mutate(() => this.files.rename(from, to), `Renaming ${entry.name}…`, {
            success: `Renamed ${entry.name} to ${name}.`,
            failure: `Could not rename “${entry.name}”`,
        });
    }

    private async remove(selected: Entry[]): Promise<void> {
        if (!selected.length) {
            return;
        }
        const label = selected.length === 1 ? `“${selected[0].name}”` : `${selected.length} items`;
        const folders = selected.filter((entry) => entry.isDirectory()).length;
        // The question names the item and the device, as the app's other destructive prompts do.
        const confirmed = await this.confirm({
            title: `Delete ${label} from ${this.deviceLabel()}?`,
            message: `${
                folders
                    ? selected.length === 1
                        ? 'The folder is deleted with everything inside it. '
                        : 'Folders are deleted with everything inside them. '
                    : ''
            }This cannot be undone.`,
            confirm: 'Delete',
            danger: true,
        });
        if (!confirmed) {
            return;
        }
        const paths = selected.map((entry) => path.join(this.path, entry.name));
        this.mutate(() => this.files.remove(paths), `Deleting ${label}…`, {
            success: `Deleted ${label}.`,
            failure: `Could not delete ${label}`,
        });
    }

    private async paste(): Promise<void> {
        const clipboard = this.clipboard;
        if (!clipboard?.names.length) {
            return;
        }
        if (clipboard.dir === this.path && clipboard.mode === 'cut') {
            this.toast('These items are already in this folder.');
            return;
        }
        // A copy made in its own folder has nothing to replace: the source is the existing item.
        const items = await this.resolveNames(clipboard.names, clipboard.dir !== this.path, clipboard.folders);
        if (!items.length) {
            return;
        }
        // One channel per item keeps each failure reportable on its own, and `mutate` reloads once
        // the last operation finishes.
        const move = clipboard.mode === 'cut';
        const verb = clipboard.mode === 'cut' ? 'Moving' : 'Copying';
        const done = clipboard.mode === 'cut' ? 'Moved' : 'Copied';
        const failed = clipboard.mode === 'cut' ? 'move' : 'copy';
        items.forEach(({ name, target, replace }) => {
            const from = path.join(clipboard.dir, name);
            const to = path.join(this.path, target);
            this.mutate(
                () => (move ? this.files.move(from, to, replace) : this.files.copy(from, to, replace)),
                `${verb} ${name}…`,
                {
                    success: target === name ? `${done} ${name}.` : `${done} ${name} as ${target}.`,
                    failure: `Could not ${failed} “${name}”`,
                    many: (count) => `${done} ${count} items.`,
                },
            );
        });
        if (clipboard.mode === 'cut') {
            this.clipboard = undefined;
        }
    }

    /**
     * Upload and Paste both come through here, so a name that is already in this folder is
     * handled the same way for each. Returns nothing when every item was skipped, or when the
     * explorer closed or changed folder while a question was open.
     */
    private async resolveNames(names: string[], replaceable: boolean, folders: string[] = []): Promise<Resolution[]> {
        if (!names.length) {
            return [];
        }
        const folder = this.path;
        const incomingFolders = new Set(folders);
        // Compared the way this folder's storage compares names: on /sdcard, case is ignored.
        const key = nameKey(folder);
        const existing = new Map(
            this.folder.all().map((entry) => [key(entry.name), { isFolder: entry.isDirectory(), name: entry.name }]),
        );
        this.resolving = true;
        this.updateControls();
        try {
            const resolved = await resolveNameConflicts(
                names,
                existing,
                replaceable,
                async (name, item, canReplace, remaining) => {
                    const answer = await this.askConflict(name, item, canReplace, remaining);
                    return this.stopped || !this.active || this.path !== folder ? undefined : answer;
                },
                (name) => incomingFolders.has(name),
                key,
            );
            if (!resolved.length && !this.stopped && this.path === folder) {
                this.toast(names.length === 1 ? `Skipped ${names[0]}.` : `Skipped ${names.length} items.`);
            }
            return resolved;
        } finally {
            this.resolving = false;
            this.updateControls();
        }
    }

    private planUploads = async (files: File[]): Promise<PlannedUpload[]> => {
        // The answers are about this folder's listing, so the files go to this folder even if
        // the explorer has moved on by the time they start.
        const folder = this.path;
        const key = nameKey(folder);
        const chosen = new Map<string, File>();
        const taken = new Set<string>();
        const repeated = new Set<string>();
        files.forEach((file) => {
            if (taken.has(key(file.name))) {
                repeated.add(file.name);
            } else {
                taken.add(key(file.name));
                chosen.set(file.name, file);
            }
        });
        const plan = (await this.resolveNames([...chosen.keys()], true)).map(({ name, target, replace }) => ({
            file: chosen.get(name) as File,
            folder,
            name: target,
            overwrite: replace,
        }));
        if (repeated.size) {
            // Two files with one name cannot both land in this folder.
            const [first] = repeated;
            const message =
                repeated.size === 1
                    ? `“${first}” was added more than once. Only the first one is uploaded.`
                    : `${repeated.size} names were added more than once. Only the first file of each is uploaded.`;
            if (plan.length) {
                // Reported with the outcome of the uploads that follow, not replaced by it.
                this.uploadErrors.push(message);
            } else {
                this.toast(message, true);
            }
        }
        return plan;
    };

    /** The device's name as the page header shows it. */
    private deviceLabel(): string {
        const entry = findDeviceForTool(this.params);
        return entry ? deviceName(entry) : this.serial;
    }

    private checkName(name: string): string {
        if (!name) {
            return 'Enter a name.';
        }
        if (name.includes('/')) {
            return 'A name cannot contain “/”.';
        }
        if (name === '.' || name === '..') {
            return 'Choose a different name.';
        }
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f\x7f]/.test(name)) {
            return 'This name contains characters that cannot be used on the phone.';
        }
        const key = nameKey(this.path);
        const taken = this.folder.all().find((entry) => key(entry.name) === key(name));
        if (taken) {
            return taken.name === name
                ? `“${name}” already exists in this folder.`
                : `This storage treats “${name}” and “${taken.name}” as the same name.`;
        }
        return '';
    }

    private showProperties(entries: Entry[]): void {
        const [entry] = entries;
        if (!entry || entries.length !== 1) {
            return;
        }
        const rows: [string, string][] = [
            ['Name', entry.name],
            ['Location', this.path],
            ['Type', typeLabel(entry)],
            [
                'Size',
                entry.isDirectory()
                    ? 'Folders are not measured'
                    : `${formatSize(entry.size)} (${entry.size.toLocaleString()} bytes)`,
            ],
            ['Modified', formatModified(entry.mtime)],
            ['Permissions', formatMode(entry.mode)],
        ];
        this.dialog.innerHTML = this.sheetMarkup({
            title: 'Properties',
            close: 'Close Properties',
            body: `<dl class="fx-properties">${rows
                .map(([title, value]) => `<dt>${esc(title)}</dt><dd>${esc(value)}</dd>`)
                .join('')}</dl>`,
            actions: `<button type="submit" class="${ANSWER_PRIMARY}" value="close">Close</button>`,
        });
        this.presentDialog();
        this.dialog.querySelector<HTMLButtonElement>('[value="close"]')?.focus();
    }

    // ---------------------------------------------------------------- dialogs

    /**
     * The kit's sheet as markup (`style/kit/Sheet.css`): the backdrop, then the panel with the
     * title, the body and the actions. The panel is the form, so Enter in a field answers.
     * `close` names the close button.
     */
    private sheetMarkup(parts: {
        title: string;
        close: string;
        body: string;
        actions: string;
        className?: string;
    }): string {
        return `<div class="kit-sheet-backdrop" data-dialog="close"></div>
            <form method="dialog" class="kit-sheet-panel fx-dialog-form ${parts.className || ''}" novalidate>
                <header class="kit-sheet-header">
                    <div class="kit-sheet-handle" aria-hidden="true"></div>
                    <div class="kit-sheet-heading">
                        <h2 class="kit-sheet-title" id="fx-dialog-title">${esc(parts.title)}</h2>
                    </div>
                    <button type="button" class="${iconButtonClass({
                        variant: 'bare',
                    })} kit-sheet-close" data-dialog="close" aria-label="${esc(parts.close)}" title="${esc(
                        parts.close,
                    )}">${iconSvg('close', 24)}</button>
                </header>
                <div class="kit-sheet-body">${parts.body}</div>
                <footer class="kit-sheet-footer fx-dialog-actions">${parts.actions}</footer>
            </form>`;
    }

    private prompt(options: {
        title: string;
        label: string;
        value: string;
        confirm: string;
        selectBase?: boolean;
        /** Returns what is wrong with the name, or nothing. The dialog stays open on a problem. */
        check?: (value: string) => string;
    }): Promise<string | undefined> {
        // The kit's field with its label above it and its error line under it.
        this.dialog.innerHTML = this.sheetMarkup({
            title: options.title,
            close: `Close ${options.title}`,
            body: `<div class="kit-field-group">
                <label class="kit-field-label" for="fx-dialog-field">${esc(options.label)}</label>
                <input class="kit-field" id="fx-dialog-field" type="text" name="value" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="fx-dialog-error" />
                <p class="kit-field-error fx-dialog-error" id="fx-dialog-error" role="alert" hidden>${iconSvg(
                    'errorCircle',
                    16,
                )}<span></span></p>
            </div>`,
            actions: `<button type="button" class="${ANSWER}" data-dialog="cancel">Cancel</button>
                <button type="submit" class="${ANSWER_PRIMARY}" value="confirm">${esc(options.confirm)}</button>`,
        });
        const input = this.dialog.querySelector('input[name="value"]') as HTMLInputElement;
        const error = this.dialog.querySelector('.fx-dialog-error') as HTMLElement;
        const errorText = error.querySelector('span') as HTMLElement;
        input.value = options.value;
        input.addEventListener('input', () => {
            error.hidden = true;
            input.removeAttribute('aria-invalid');
        });
        this.dialogCheck = () => {
            const problem = options.check?.(input.value.trim()) || '';
            errorText.textContent = problem;
            error.hidden = !problem;
            if (problem) {
                input.setAttribute('aria-invalid', 'true');
                input.focus();
            } else {
                input.removeAttribute('aria-invalid');
            }
            return problem;
        };
        return this.showDialog(() => {
            const dot = options.selectBase ? options.value.lastIndexOf('.') : -1;
            input.focus();
            input.setSelectionRange(0, dot > 0 ? dot : options.value.length);
        }).then((result) => (result === 'confirm' ? input.value.trim() : undefined));
    }

    private confirm(options: {
        title: string;
        message: string;
        confirm: string;
        cancel?: string;
        danger?: boolean;
    }): Promise<boolean> {
        this.dialog.innerHTML = this.sheetMarkup({
            title: options.title,
            close: 'Close this question',
            body: `<p class="fx-dialog-message">${esc(options.message)}</p>`,
            actions: `<button type="button" class="${ANSWER}" data-dialog="cancel">${esc(
                options.cancel || 'Cancel',
            )}</button>
                <button type="submit" class="${
                    options.danger ? ANSWER_REMOVES : ANSWER_PRIMARY
                }" value="confirm">${esc(options.confirm)}</button>`,
        });
        return this.showDialog(() => {
            const confirm = this.dialog.querySelector<HTMLButtonElement>('[value="confirm"]');
            if (!options.danger) {
                confirm?.focus();
                return;
            }
            // The same rule as the app's other destructive actions: Cancel is the default.
            this.dialog.querySelector<HTMLButtonElement>('[data-dialog="cancel"]')?.focus();
            this.guard(confirm);
        }).then((result) => result === 'confirm');
    }

    /**
     * The red answer ignores presses for `CONFIRM_GUARD_MS`, like `ConfirmPrompt`'s button, so a
     * double tap or a repeated key on whatever opened the dialog cannot also answer it.
     */
    private guard(button: HTMLButtonElement | null): void {
        if (button) {
            button.disabled = true;
            setTimeout(() => (button.disabled = false), CONFIRM_GUARD_MS);
        }
    }

    /**
     * Asks what to do with one name that is already in this folder. Closing the dialog skips the
     * item, the keyboard starts on "Keep both", and Replace ignores presses for its first
     * `CONFIRM_GUARD_MS`, so nothing is replaced by accident.
     */
    private askConflict(
        name: string,
        item: ExistingItem,
        canReplace: boolean,
        remaining: number,
    ): Promise<ConflictAnswer> {
        const device = this.deviceLabel();
        // The item that is there, which is what a replace removes. Its name can differ by case.
        const existing = item.name ?? name;
        const title = canReplace ? `Replace “${existing}” on ${device}?` : `“${existing}” already exists on ${device}`;
        const sameName = existing === name ? '' : ` This storage treats “${name}” and “${existing}” as the same name.`;
        const message =
            (canReplace
                ? 'This folder already has a file with this name. Replacing it cannot be undone.'
                : item.isFolder
                  ? 'This folder already has a folder with this name. Folders are not replaced.'
                  : 'This folder already has an item with this name.') + sameName;
        const others = remaining === 1 ? 'the other conflict' : `the other ${remaining} conflicts`;
        this.dialog.innerHTML = this.sheetMarkup({
            title,
            close: 'Close this question',
            className: 'fx-conflict',
            body: `<p class="fx-dialog-message">${esc(message)}</p>
                ${
                    remaining > 0
                        ? `<label class="fx-dialog-check"><input type="checkbox" name="all" /><span>Do the same for ${others}</span></label>`
                        : ''
                }`,
            actions: `<button type="submit" class="${ANSWER}" value="skip">Skip</button>
                <button type="submit" class="${ANSWER}" value="keep">Keep both</button>
                ${canReplace ? `<button type="submit" class="${ANSWER_REMOVES}" value="replace">Replace</button>` : ''}`,
        });
        const all = this.dialog.querySelector<HTMLInputElement>('input[name="all"]');
        return this.showDialog(() => {
            this.dialog.querySelector<HTMLButtonElement>('[value="keep"]')?.focus();
            this.guard(this.dialog.querySelector<HTMLButtonElement>('[value="replace"]'));
        }).then((result) => ({
            choice: (result === 'replace' || result === 'keep' ? result : 'skip') as ConflictChoice,
            // Closing the dialog answers for this one item only.
            all: !!all?.checked && result !== '',
        }));
    }

    private presentDialog(): void {
        clearTimeout(this.dialogRelease);
        this.dialogRelease = undefined;
        // A question that opens as soon as the one before it is answered (the next name of an
        // upload) takes over that one's entry. Released at once, the entry would be stepped back
        // over before the next question opens, and the step would count against the press that
        // answered: the next question would get no entry, and Back would leave Files.
        if (!this.dialogEntry || this.dialogEntry.left) {
            const fresh = { left: false } as { entry: OverlayEntry; left: boolean };
            fresh.entry = this.overlayEntry(() => {
                fresh.left = true;
                this.closeDialog('');
            });
            this.dialogEntry = fresh;
        }
        const held = this.dialogEntry;
        const closed = () => {
            this.dialog.removeEventListener('close', closed);
            // Given up once the code that waits for the answer has run. The question that
            // follows, if any, has opened by then and cleared this timer.
            clearTimeout(this.dialogRelease);
            this.dialogRelease = setTimeout(() => {
                this.dialogRelease = undefined;
                if (this.dialogEntry === held && !this.dialog.open) {
                    this.dialogEntry = undefined;
                    held.entry.release();
                }
            });
        };
        this.dialog.addEventListener('close', closed);
        // The panel of the question before may still be leaving, when the browser closed the
        // dialog itself during that exit (a second Back with no press in between). Its exit
        // ends here: when it finished, it would close this question.
        this.stopDialogMotion();
        this.dialogPanel = this.dialog.querySelector<HTMLElement>('.kit-sheet-panel') || undefined;
        this.dialogClosing = false;
        this.dialog.toggleAttribute('data-exiting', false);
        this.dialog.style.removeProperty('--sheet-backdrop-opacity');
        this.bindSheet();
        this.dialog.showModal();
        if (this.dialogPanel) {
            transitionVisibility(this.dialogPanel, true, undefined, FileListingClient.sheetAway());
        }
    }

    /** Where the panel of a closed sheet sits: under the window, or a little lower as a dialog. */
    private static sheetAway(): string {
        return window.matchMedia(SHEET_DIALOG).matches ? 'translateY(12px) scale(0.98)' : 'translateY(100%)';
    }

    /**
     * What `ui/Sheet.tsx` does for a sheet while it is open, for this one: a drag on the header
     * closes a bottom sheet, and the sheet keeps to the part of the window that an on-screen
     * keyboard leaves in view. Ended when the dialog closes.
     */
    private bindSheet(): void {
        this.unbindSheet?.();
        this.unbindSheet = undefined;
        const header = this.dialog.querySelector<HTMLElement>('.kit-sheet-header');
        const panel = this.dialogPanel;
        if (!header || !panel) {
            return;
        }
        const releaseDrag = bindSheetDrag(
            header,
            panel,
            this.dialog,
            () => true,
            () => this.closeDialog(''),
            SHEET_DIALOG,
        );
        const viewport = window.visualViewport;
        const update = () => {
            this.dialog.style.setProperty('--sheet-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
            this.dialog.style.setProperty('--sheet-viewport-top', `${viewport?.offsetTop ?? 0}px`);
        };
        update();
        viewport?.addEventListener('resize', update);
        viewport?.addEventListener('scroll', update);
        window.addEventListener('resize', update);
        this.unbindSheet = () => {
            releaseDrag();
            viewport?.removeEventListener('resize', update);
            viewport?.removeEventListener('scroll', update);
            window.removeEventListener('resize', update);
        };
    }

    private onDialogClose = (): void => {
        this.unbindSheet?.();
        this.unbindSheet = undefined;
    };

    /**
     * Gives an open menu or dialog a history entry, so the browser's Back closes it and leaves
     * the folder alone. The entry is added after the one that is shown, which removes whatever
     * Forward led to.
     */
    private overlayEntry(onClose: () => void): OverlayEntry {
        this.claimForward();
        return openOverlay(onClose);
    }

    /** An overlay's entry takes the place of whatever Forward led to, and the toolbar says so. */
    private claimForward(): void {
        if (this.active && this.historyTop !== this.historyIndex) {
            this.historyTop = this.historyIndex;
            this.storeHistory();
            this.updateControls();
        }
    }

    /** Closes an open dialog as cancelled. Its close event comes later, in a task of its own. */
    private dismissDialog(): Promise<void> {
        if (!this.dialog.open) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.dialog.addEventListener('close', () => resolve(), { once: true });
            this.stopDialogMotion();
            this.dialog.close('');
        });
    }

    /** Closes the dialog with an answer, once its panel has moved away. */
    private closeDialog(value: string): void {
        if (!this.dialog.open || this.dialogClosing) return;
        this.dialogClosing = true;
        // The backdrop fades while the panel leaves.
        this.dialog.toggleAttribute('data-exiting', true);
        if (!this.dialogPanel) {
            this.dialog.close(value);
            return;
        }
        transitionVisibility(this.dialogPanel, false, () => this.dialog.close(value), FileListingClient.sheetAway());
    }

    private stopDialogMotion(): void {
        if (this.dialogPanel) {
            cancelVisibility(this.dialogPanel);
        }
    }

    private onDialogKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && !event.isComposing) {
            // Answered here, as in `ui/Sheet.tsx`, so the browser raises no close request of
            // its own: one it raises a second time cannot be refused, and skips the exit.
            event.preventDefault();
            event.stopPropagation();
            this.closeDialog('');
            return;
        }
        trapDialogTab(event, this.dialog);
    };

    /** The backdrop, the close button and Cancel all close the dialog without an answer. */
    private onDialogClick = (event: MouseEvent): void => {
        if (event.target instanceof Element && event.target.closest('[data-dialog]')) {
            this.closeDialog('');
        }
    };

    /** The browser's own request to close: Back in Chrome on Android goes to an open modal dialog. */
    private onDialogCancel = (event: Event): void => {
        event.preventDefault();
        this.closeDialog('');
    };

    private onDialogSubmit = (event: SubmitEvent): void => {
        event.preventDefault();
        const submitter = event.submitter;
        // Enter in the field submits without a submitter; it means the same as the main button.
        const value = submitter instanceof HTMLButtonElement ? submitter.value : this.dialogCheck ? 'confirm' : '';
        if (value === 'confirm' && this.dialogCheck?.()) {
            return;
        }
        this.closeDialog(value);
    };

    private showDialog(onOpen: () => void): Promise<string> {
        return new Promise((resolve) => {
            const finish = () => {
                this.dialog.removeEventListener('close', finish);
                this.dialogCheck = undefined;
                resolve(this.dialog.returnValue);
            };
            this.dialog.returnValue = '';
            // Whoever waits may open the next dialog at once (promise callbacks run between two
            // listeners of one event). That dialog takes over this one's entry; see
            // `presentDialog`.
            this.presentDialog();
            this.dialog.addEventListener('close', finish);
            onOpen();
        });
    }

    // ---------------------------------------------------------------- requests

    /**
     * One folder operation. Results are reported together, and the folder is listed again, once
     * the last operation in flight has answered.
     */
    private mutate(start: () => Cancellable<void>, pending: string, outcome: Outcome): void {
        // Callers gate on `canModify()`; a multi-item paste must not block itself after its own
        // first operation raises the pending count.
        if (this.stopped || !this.hasConnection()) {
            return;
        }
        // Every folder operation ends selection mode; the folder is listed again afterwards.
        this.selection.clear();
        this.selectionMode = false;
        this.anchorName = undefined;
        this.paintSelection();
        this.report(pending);
        this.operations++;
        this.updateControls();
        start()
            .then(
                () => {
                    this.batch.done.push(outcome.success);
                    this.batch.many = outcome.many;
                },
                (error: FileError) => {
                    this.batch.failed.push(`${outcome.failure}: ${error.message || 'no reason given.'}`);
                },
            )
            .finally(() => {
                this.operations = Math.max(0, this.operations - 1);
                if (this.stopped) {
                    return;
                }
                // Report and reload once the last operation of a batch has answered, so a
                // multi-item paste does not re-list the folder for every item.
                if (!this.operations) {
                    this.reportBatch();
                    this.reload();
                }
                this.updateControls();
            });
    }

    /** One toast for the whole batch: a failure is never replaced by a later success. */
    private reportBatch(): void {
        const { done, failed, many } = this.batch;
        this.batch = { done: [], failed: [] };
        if (failed.length) {
            const total = done.length + failed.length;
            this.toast(total === 1 ? failed[0] : `${failed.length} of ${total} items failed. ${failed[0]}`, true);
        } else if (done.length) {
            this.toast(done.length > 1 && many ? many(done.length) : done[done.length - 1]);
        }
    }

    /** Keeps a request of the folder being opened, so opening another one can cancel it. */
    private lookup<T>(request: Cancellable<T>): Cancellable<T> {
        this.lookups.add(request);
        const forget = () => this.lookups.delete(request);
        request.then(forget, forget);
        return request;
    }

    /** Opens a place: a folder is listed; a file is downloaded and the folder it is in listed. */
    private openPlace(destination: string): void {
        const generation = this.generation;
        const current = () => !this.stopped && generation === this.generation;
        this.lookup(this.files.stat(destination)).then(
            (entry) => {
                if (!current()) {
                    return;
                }
                if (entry.isDirectory()) {
                    this.list(destination, destination);
                } else {
                    this.download(destination, entry);
                    this.list(path.dirname(destination), destination);
                }
            },
            (error: FileError) => {
                if (current() && error.kind !== 'cancelled') {
                    this.finishListing({ kind: 'stat', path: destination, error: error.message });
                }
            },
        );
    }

    private finishListing(listing: Listing): void {
        if (this.stopped) {
            return;
        }
        this.loading = false;
        this.loadingPath = undefined;
        this.wrapper.dataset.listing = listing.error ? 'error' : 'ready';
        this.report('');
        if (listing.error) {
            // The place that failed is the place shown: its own path in the address bar, so
            // Up and Retry mean what they say, and no rows from the folder before it.
            if (listing.kind === 'stat') {
                this.enter(listing.path, listing.path);
            }
            this.folder.clear();
            this.selection.clear();
            this.listingError = listing.error;
            this.renderItems();
            return;
        }
        this.renderItems();
        // The listing states sizes in 32 bits. Ask for the true size of anything larger.
        if (listing.kind === 'list' && this.folder.all().some((entry) => entry.isFile())) {
            this.requestSizes();
        }
    }

    private requestSizes(): void {
        const generation = this.generation;
        this.files.largeSizes(this.path).then(
            (sizes) => {
                if (this.stopped || generation !== this.generation || !sizes.size) {
                    return;
                }
                sizes.forEach((size, name) => {
                    const entry = this.folder.get(name);
                    if (entry) {
                        this.folder.add(new Entry(name, entry.mode, size, entry.mtime.getTime() / 1000));
                    }
                });
                this.scheduleRender();
            },
            // A size correction that does not arrive leaves the listing as it was.
            () => undefined,
        );
    }

    private list(destination: string, requested: string): void {
        this.enter(destination, requested);
        // The old rows stay, dimmed and inert, until the new folder has rows of its own; wiping
        // them first made every folder change flash an empty list.
        this.wrapper.classList.add('fx-loading');
        const generation = this.generation;
        const current = () => !this.stopped && generation === this.generation;
        this.lookup(
            this.files.list(destination, (entry) => {
                if (current()) {
                    this.folder.add(entry);
                    this.scheduleRender();
                }
            }),
        ).then(
            () => current() && this.finishListing({ kind: 'list', path: destination }),
            (error: FileError) => {
                if (current() && error.kind !== 'cancelled') {
                    this.finishListing({ kind: 'list', path: destination, error: error.message });
                }
            },
        );
    }

    /**
     * Makes `destination` the place the explorer shows: the address bar, the browser's address
     * and an empty selection. `requested` is the path that was asked for; a file's path shows
     * the folder it is in.
     */
    private enter(destination: string, requested: string): void {
        if (destination !== this.path) {
            // A row links to its item in its folder, so rows do not move to another folder.
            this.rows.clear();
        }
        this.path = destination;
        this.folder.clear();
        this.selection.clear();
        // Selection mode belongs to the folder it was started in. Left on, the next folder
        // would open with "0 selected" and taps that select instead of opening.
        this.selectionMode = false;
        this.anchorName = undefined;
        this.rovingFromFocus = false;
        this.renderBreadcrumb();
        this.updateControls();
        const params = this.routeParams();
        const shown = params?.get('path');
        if (params && shown !== destination) {
            params.set('path', destination);
            if (path.resolve('/', shown || DEFAULT_FILES_PATH) === requested) {
                // The address already asked for this place; it only spells it differently (a
                // trailing slash, or a file inside the folder). Correct it without a new entry.
                replaceRoute(params);
            } else {
                this.historyIndex++;
                this.historyTop = this.historyIndex;
                pushRoute(params, this.historyState());
                this.storeHistory();
            }
            this.updateControls();
        }
    }

    /**
     * The current address, when it shows this phone's Files and the explorer is the tab that is
     * shown. A hidden explorer gets nothing here, so it writes neither the address nor history.
     */
    private routeParams(): URLSearchParams | undefined {
        if (!this.active) {
            return undefined;
        }
        const params = new URLSearchParams(location.hash.replace(/^#!/, ''));
        const route = parseRoute(params);
        return route.page === 'device' && route.view === 'files' && route.udid === this.serial ? params : undefined;
    }

    private historyState(): unknown {
        return { ...(history.state || {}), files: { id: this.historyId, index: this.historyIndex } };
    }

    private storeHistory(): void {
        try {
            sessionStorage.setItem(this.historyKey, JSON.stringify({ id: this.historyId, top: this.historyTop }));
        } catch {
            // Without it Forward is only forgotten by a page reload.
        }
    }

    /**
     * Picks up where this tab's history stands. An entry tagged by an earlier explorer in this
     * tab (a reload, or Back into Files) continues that run; anything else starts a new one
     * with nothing behind it.
     */
    private adoptHistory(): void {
        const tag = history.state?.files;
        let stored: { id?: unknown; top?: unknown } = {};
        try {
            stored = JSON.parse(sessionStorage.getItem(this.historyKey) || '{}') || {};
        } catch {
            // Session storage can be unavailable; Forward then starts disabled.
        }
        if (tag && typeof tag.id === 'string' && Number.isInteger(tag.index) && tag.index >= 0) {
            this.historyId = tag.id;
            this.historyIndex = tag.index;
            this.historyTop =
                stored.id === tag.id && typeof stored.top === 'number' ? Math.max(stored.top, tag.index) : tag.index;
            return;
        }
        this.historyId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        this.historyIndex = 0;
        this.historyTop = 0;
        const params = this.routeParams();
        if (params) {
            replaceRoute(params, this.historyState());
        }
        this.storeHistory();
    }

    /**
     * Called for every path change. The browser's Back and Forward land on a tagged entry; an
     * entry without this run's tag was pushed by something else (a typed address, a link), so
     * it counts as one step forward and is tagged now.
     */
    private syncHistory(): void {
        if (!this.active) {
            return;
        }
        const tag = history.state?.files;
        if (FileListingClient.isTag(tag)) {
            if (tag.id !== this.historyId) {
                // An entry from an earlier run in this tab: continue that run from here.
                this.historyId = tag.id;
                this.historyTop = tag.index;
            }
            this.historyIndex = tag.index;
            this.historyTop = Math.max(this.historyTop, tag.index);
            return;
        }
        const params = this.routeParams();
        if (params) {
            this.historyIndex++;
            this.historyTop = this.historyIndex;
            replaceRoute(params, this.historyState());
            this.storeHistory();
        }
    }

    /** Whether `tag` is the mark an explorer leaves on a history entry it made or adopted. */
    private static isTag(tag: unknown): tag is { id: string; index: number } {
        const { id, index } = (tag || {}) as { id?: unknown; index?: unknown };
        return typeof id === 'string' && Number.isInteger(index);
    }

    /** A link to a folder of this phone. It is the same whichever tab the address shows. */
    private link(destination: string, prefix = this.linkPrefix()): string {
        const { useProxy, hostname, port, pathname, secure } = this.params;
        const host = useProxy ? { hostname, port, pathname, secure, useProxy } : {};
        return `${prefix}#!${deviceRoute(this.serial, 'files', { ...host, path: destination })}`;
    }

    /**
     * The page's address without its hash, worked out once for many links. The hash is encoded
     * as search parameters, which the hash of a URL keeps as it is.
     */
    private linkPrefix(): string {
        const url = new URL(location.href);
        url.hash = '';
        return url.href;
    }

    /**
     * Every download is a plain HTTP request that the browser saves to disk itself: it shows the
     * progress, and a file of any size never passes through this page's memory.
     */
    private download(destination: string, entry: Entry, announce = true): void {
        const link = document.createElement('a');
        link.href = this.files.downloadLink(destination);
        link.download = entry.name;
        // The installed app on an iPhone has no browser bar. A file that iOS shows in the app's
        // own window leaves no way back, so the link opens outside it, where iOS gives Done.
        if ((navigator as Navigator & { standalone?: boolean }).standalone === true) {
            link.target = '_blank';
            link.rel = 'noopener';
        }
        document.body.appendChild(link);
        link.click();
        link.remove();
        if (announce) {
            this.toast(`Download of ${entry.name} started in your browser.`);
        }
    }

    // ---------------------------------------------------------------- navigation

    public getPath(): string {
        return this.path;
    }

    public focus(): void {
        if (this.active) {
            this.items.focus();
        }
    }

    /**
     * The phone's page keeps the explorer mounted while it shows another tab of the same phone,
     * and says so here. A hidden explorer keeps its folder, its connection and its uploads. It
     * closes its menu and any open question, handles no keys and leaves the address alone.
     */
    public setActive(active: boolean): void {
        if (this.stopped || active === this.active) {
            return;
        }
        if (!active) {
            this.closeMenu();
            void this.dismissDialog();
            this.closeAddressInput();
            this.cancelLongPress();
            this.enterCount = 0;
            this.wrapper.classList.remove('file-listing-drop');
            const focused = document.activeElement;
            if (focused instanceof HTMLElement && this.wrapper.contains(focused)) {
                focused.blur();
            }
            this.active = false;
            return;
        }
        this.active = true;
        const params = this.routeParams();
        const asked = params?.get('path');
        const tagged = FileListingClient.isTag(history.state?.files);
        if (tagged) {
            // Back or Forward came to one of this explorer's entries.
            this.syncHistory();
        }
        if (params && (!tagged || !asked)) {
            // A change of tab writes the same history entry, and the explorer's tag is lost. The
            // entry is still the place the explorer was at, not a step forward, so it is tagged
            // with that place again. A link that names no folder gets the folder that is shown.
            if (!asked) {
                params.set('path', this.path);
            }
            replaceRoute(params, this.historyState());
        }
        this.updateControls();
        if (this.missed) {
            const { message, error } = this.missed;
            this.missed = undefined;
            this.toast(message, error);
        }
        // The folder may have changed on the phone meanwhile, by a shell command for one, so it
        // is listed again. Not when the address asks for another folder, which the page opens
        // next, and not over a selection or a filter, which a new listing would clear.
        const elsewhere = !!asked && path.resolve('/', asked) !== this.path;
        const editing = this.selecting() || !!this.filter || this.wrapper.classList.contains('fx-filtering');
        if (!elsewhere && !editing && this.canModify()) {
            this.reload();
        }
    }

    /**
     * Every path change funnels through here: shortcut clicks, the address bar, and the
     * browser's Back and Forward (which reach it through the hash router, as the toolbar's
     * Back and Forward do too).
     */
    public navigate(destination: string): void {
        const normalized = path.resolve('/', destination);
        if (this.stopped) {
            return;
        }
        this.syncHistory();
        if (!this.hasConnection()) {
            this.path = normalized;
            this.renderBreadcrumb();
            this.updateControls();
            return;
        }
        if (normalized === this.path) {
            this.updateControls();
            return;
        }
        this.load(normalized);
    }

    public reload(): void {
        this.load(this.path);
    }

    private load(destination: string): void {
        if (this.stopped || !this.hasConnection()) {
            return;
        }
        this.closeMenu();
        this.generation++;
        this.loading = true;
        this.loadingPath = destination;
        this.listingError = undefined;
        this.setFiltering(false);
        // A settled listing needs an observable marker: "no rows yet" and "this folder is empty"
        // look identical from the outside, which is exactly how a fixture reads a half-loaded
        // folder as an empty one.
        this.wrapper.dataset.listing = 'loading';
        this.updateControls();
        this.lookups.forEach((request) => request.cancel());
        this.lookups.clear();
        this.report('Loading folder…');
        this.openPlace(destination);
    }

    // ---------------------------------------------------------------- uploads

    public onDragEnter(): boolean {
        if (!this.canModify()) {
            return false;
        }
        this.enterCount++;
        this.wrapper.classList.add('file-listing-drop');
        return true;
    }
    public onDragLeave(): boolean {
        this.enterCount = Math.max(0, this.enterCount - 1);
        if (!this.enterCount) {
            this.wrapper.classList.remove('file-listing-drop');
        }
        return true;
    }
    public onDrop(): boolean {
        this.enterCount = 0;
        this.wrapper.classList.remove('file-listing-drop');
        if (!this.canModify()) {
            // Uploads run beside each other: only a folder that loads, an operation or a question stops a drop.
            this.toast('Wait for the current folder or operation to finish before adding files.');
            return false;
        }
        return true;
    }
    public onFilePushUpdate(data: PushUpdateParams): void {
        if (this.stopped) {
            return;
        }
        let upload = this.uploads.get(data.key);
        if (!upload) {
            upload = this.uploadRow(data);
            this.transfers.appendChild(upload.row);
            this.uploads.set(data.key, upload);
            if (!this.uploadBatch.total) {
                // The first upload of a batch: leaving the phone's page or the app now asks first.
                setLeaveGuard(this.leaveGuard);
                window.addEventListener('beforeunload', this.onBeforeUnload);
            }
            this.uploadBatch.total++;
            this.uploadBatch.bytes += upload.size;
            this.uploadBatch.folders.add(upload.folder);
            this.transfers.hidden = false;
        }
        upload.sent = data.sent;
        this.paintUpload(upload, data);
        if (data.finished) {
            upload.row.remove();
            this.uploads.delete(data.key);
            this.uploadBatch.ended++;
            this.uploadBatch.endedBytes += upload.size;
            if (data.cancelled) {
                this.uploadBatch.cancelled++;
            } else if (data.error) {
                this.uploadErrors.push(`${data.fileName}: ${data.message}`);
            } else {
                this.uploadsDone.push(data.fileName);
            }
            this.endBatchIfDone();
        }
        this.renderTransferSummary();
        this.updateControls();
    }

    /**
     * One upload's row: its name, how much is sent of how much (or the step it is at), Cancel,
     * and a bar under the name.
     */
    private uploadRow(data: PushUpdateParams): Upload {
        const row = document.createElement('div');
        row.className = 'file-listing-upload-progress';
        row.innerHTML = `<span class="fx-upload-name">${esc(data.fileName)}</span><span class="kit-status kit-status-neutral fx-upload-state"></span><button type="button" class="${BUTTON} fx-upload-cancel" data-upload-cancel="${
            data.key
        }" aria-label="${esc(`Cancel the upload of ${data.fileName}`)}">Cancel</button><span class="fx-upload-bar" role="progressbar" aria-label="${esc(
            `Upload of ${data.fileName}`,
        )}" aria-valuemin="0" aria-valuemax="100"><span class="fx-upload-fill"></span></span>`;
        return {
            row,
            bar: row.querySelector('.fx-upload-bar') as HTMLElement,
            fill: row.querySelector('.fx-upload-fill') as HTMLElement,
            state: row.querySelector('.fx-upload-state') as HTMLElement,
            name: data.fileName,
            folder: data.folder,
            sent: 0,
            size: data.size,
        };
    }

    private paintUpload(upload: Upload, data: PushUpdateParams): void {
        const bytes = `${formatSize(upload.sent)} of ${formatSize(upload.size)}`;
        const percent = upload.size
            ? Math.floor((upload.sent * 100) / upload.size)
            : data.message === 'Saving'
              ? 100
              : 0;
        upload.state.textContent = data.message || bytes;
        upload.bar.setAttribute('aria-valuenow', String(percent));
        upload.bar.setAttribute('aria-valuetext', bytes);
        upload.fill.style.width = `${percent}%`;
        (upload.row.querySelector('.fx-upload-cancel') as HTMLElement).hidden = !data.cancellable;
    }

    /** "Uploading 3 of 40, 45%": the file the batch is on and how much of all of it is sent. */
    private renderTransferSummary(): void {
        const { total, ended, bytes, endedBytes } = this.uploadBatch;
        this.transfers.hidden = !this.uploads.size;
        if (!this.uploads.size) {
            return;
        }
        let sent = endedBytes;
        this.uploads.forEach((upload) => (sent += upload.sent));
        const percent = bytes ? Math.floor((sent * 100) / bytes) : 0;
        this.transferSummary.textContent =
            total === 1 ? `Uploading 1 file, ${percent}%` : `Uploading ${ended + 1} of ${total}, ${percent}%`;
    }

    private static emptyBatch() {
        return { total: 0, ended: 0, cancelled: 0, bytes: 0, endedBytes: 0, folders: new Set<string>() };
    }

    /**
     * When the last upload of a batch ends: one toast for all of it, then the folder again if
     * files went to the folder that is shown. The owner may have moved to another one meanwhile.
     */
    private endBatchIfDone(): void {
        if (this.uploads.size) {
            return;
        }
        // One toast for the batch, so a later success does not hide an earlier failure. The
        // folder is listed even after a failure: a refused name means the listing was out of
        // date, and a second try must see it.
        const failures = this.uploadErrors;
        const done = this.uploadsDone;
        const { cancelled, folders } = this.uploadBatch;
        this.uploadErrors = [];
        this.uploadsDone = [];
        this.uploadBatch = FileListingClient.emptyBatch();
        this.releaseLeaveGuard();
        const stopped = cancelled ? `Cancelled ${cancelled} upload${cancelled === 1 ? '' : 's'}.` : '';
        if (failures.length) {
            this.toast(failures.length === 1 ? failures[0] : `${failures.length} uploads failed. ${failures[0]}`, true);
        } else if (done.length) {
            const uploaded = done.length === 1 ? `Uploaded ${done[0]}.` : `Uploaded ${done.length} files.`;
            this.toast(stopped ? `${uploaded} ${stopped}` : uploaded);
        } else if (stopped) {
            this.toast(stopped);
        }
        // A folder that is still being opened is opened again, so its listing has the files.
        const shown = this.loading ? this.loadingPath : this.path;
        if (shown !== undefined && folders.has(path.resolve('/', shown))) {
            this.load(shown);
        }
    }

    private releaseLeaveGuard(): void {
        clearLeaveGuard(this.leaveGuard);
        window.removeEventListener('beforeunload', this.onBeforeUnload);
    }

    /** Closing or reloading the page while files upload asks first; the browser words the question. */
    private onBeforeUnload = (event: BeforeUnloadEvent): void => {
        if (this.uploads.size) {
            event.preventDefault();
            event.returnValue = '';
        }
    };

    /**
     * Asked before anything takes the owner away from the phone's page while files upload: the
     * phone switcher, the back control, the browser's Back. Leaving stops the uploads that have
     * not finished. The question is asked from whichever tab of the page is shown.
     */
    private confirmLeave(): Promise<boolean> {
        if (!this.uploads.size || this.stopped) {
            return Promise.resolve(true);
        }
        if (this.leaving) {
            // The question is already on screen.
            return Promise.resolve(false);
        }
        this.leaving = this.dismissDialog()
            .then(() => {
                const count = this.uploads.size;
                if (!count || this.stopped) {
                    return true;
                }
                this.liftDialog();
                return this.confirm({
                    title: `Stop ${count === 1 ? 'the upload' : `${count} uploads`} to ${this.deviceLabel()}?`,
                    message:
                        count === 1
                            ? 'Leaving this phone stops the upload, and the file is not saved on it.'
                            : 'Leaving this phone stops the uploads that have not finished, and those files are not saved on it.',
                    confirm: 'Stop and leave',
                    cancel: 'Keep uploading',
                    danger: true,
                });
            })
            .then((leave) => {
                this.leaving = undefined;
                this.returnDialog();
                if (leave) {
                    this.filePushHandler?.cancelAll();
                }
                return leave;
            });
        return this.leaving;
    }

    /**
     * The explorer is hidden while another tab of the phone's page is shown, and a dialog inside
     * a hidden element is not drawn. For the question before leaving, the dialog moves to the
     * page itself. Its holder has the explorer's class, which the rules for the dialog's own
     * parts start from, and makes no box of its own.
     */
    private liftDialog(): void {
        if (this.dialogHolder) {
            return;
        }
        const holder = document.createElement('div');
        holder.className = 'file-explorer';
        holder.style.display = 'contents';
        document.body.appendChild(holder);
        holder.appendChild(this.dialog);
        this.dialogHolder = holder;
    }

    private returnDialog(): void {
        if (!this.dialogHolder) {
            return;
        }
        this.wrapper.insertBefore(this.dialog, this.toastHost);
        this.dialogHolder.remove();
        this.dialogHolder = undefined;
    }

    /**
     * The phone an address shows and the server it is reached through. The view and the folder
     * are not part of it. A page that is not a phone's gives the empty string.
     */
    private static phoneOf(params: URLSearchParams): string {
        const route = parseRoute(params);
        if (route.page !== 'device') {
            return '';
        }
        const host = ['hostname', 'port', 'pathname', 'secure', 'useProxy'].map((key) => params.get(key));
        return [route.udid, ...host].join('\n');
    }
    public onError(error: string | Error): void {
        this.toast(typeof error === 'string' ? error : error.message, true);
    }

    // ---------------------------------------------------------------- lifecycle

    public stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.cancelLongPress();
        this.closeMenu();
        this.cancelRender();
        if (this.windowFrame) {
            cancelAnimationFrame(this.windowFrame);
            this.windowFrame = 0;
        }
        this.resizeObserver?.disconnect();
        this.items.removeEventListener('scroll', this.onListScroll);
        cancelVisibility(this.menu);
        this.stopDialogMotion();
        this.unbindSheet?.();
        this.unbindSheet = undefined;
        this.allowRemote();
        this.returnDialog();
        clearTimeout(this.dialogRelease);
        this.dialogEntry?.entry.release();
        this.dialogEntry = undefined;
        this.dialog.removeEventListener('cancel', this.onDialogCancel);
        this.dialog.removeEventListener('submit', this.onDialogSubmit);
        this.dialog.removeEventListener('keydown', this.onDialogKeyDown);
        this.dialog.removeEventListener('click', this.onDialogClick);
        this.dialog.removeEventListener('close', this.onDialogClose);
        if (this.dialog.open) {
            this.dialog.close('');
        }
        this.filePushHandler?.release();
        this.filePushHandler = undefined;
        // Closes every channel still open, uploads included: the phone drops a partial file.
        this.files.release();
        this.lookups.clear();
        this.uploads.clear();
        this.releaseLeaveGuard();
        render(null, this.toastHost);
        this.picker.value = '';
        this.wrapper.removeEventListener('click', this.onClick);
        this.wrapper.removeEventListener('dblclick', this.onDoubleClick);
        this.wrapper.removeEventListener('contextmenu', this.onContextMenu);
        this.wrapper.removeEventListener('keydown', this.onKeyDown);
        this.wrapper.remove();
        super.destroy();
    }
    public destroy(): void {
        this.stop();
    }

    public static parseParameters(params: URLSearchParams): ParamsFileListing {
        const typed = super.parseParameters(params);
        if (typed.action !== ACTION.FILE_LISTING) {
            throw Error('Incorrect action');
        }
        return {
            ...typed,
            action: ACTION.FILE_LISTING,
            udid: Util.parseString(params, 'udid', true),
            path: params.get('path') || DEFAULT_FILES_PATH,
        };
    }
    protected buildDirectWebSocketUrl(): URL {
        const url = super.buildDirectWebSocketUrl();
        url.searchParams.set('action', ACTION.MULTIPLEX);
        return url;
    }
    protected onSocketOpen(): void {
        if (!this.stopped) {
            this.reload();
        }
    }
    protected onSocketMessage(): void {
        /* Requests each own a nested channel. */
    }
    protected onSocketClose(): void {
        if (this.stopped) {
            return;
        }
        this.filePushHandler?.release();
        // The uploads ended with the connection; say so instead of leaving their rows behind.
        this.uploads.forEach((upload, key) =>
            this.onFilePushUpdate({
                key,
                fileName: upload.name,
                folder: upload.folder,
                message: 'The connection to the phone was lost.',
                error: true,
                finished: true,
                sent: upload.sent,
                size: upload.size,
                cancellable: false,
            }),
        );
        this.loading = false;
        this.loadingPath = undefined;
        this.updateControls();
        // The tool page says the connection is lost and reconnects. Until then the rows stay
        // on screen but cannot be opened.
        this.report('');
        this.offline = true;
        this.wrapper.classList.add('fx-offline');
        this.scheduleRender();
    }
    protected supportMultiplexing(): boolean {
        return true;
    }
    protected getChannelInitData(): Buffer {
        return FileService.channelInit(this.serial);
    }
}
