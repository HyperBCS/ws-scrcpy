import '../../../style/filelisting.css';
import { ParamsFileListing } from '../../../types/ParamsFileListing';
import { ManagerClient } from '../../client/ManagerClient';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { ACTION } from '../../../common/Action';
import { FileCommand } from '../../../common/FileCommand';
import Util from '../../Util';
import { ToolEntry } from '../../client/Tool';
import Protocol from '@dead50f7/adbkit/lib/adb/protocol';
import { Entry } from '../Entry';
import { html } from '../../ui/HtmlTag';
import * as path from 'path';
import { ChannelCode } from '../../../common/ChannelCode';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import FilePushHandler, { DragAndPushListener, PushUpdateParams } from '../filePush/FilePushHandler';
import { AdbkitFilePushStream } from '../filePush/AdbkitFilePushStream';
import { fileListingTool } from './deviceTools';
import { pushRoute } from '../../state/router';
import { formatMode, formatModified, formatSize, iconMarkup, kindOf, typeLabel } from './fileTypes';

type Request = {
    kind: 'stat' | 'list' | 'download' | 'mutate';
    path: string;
    generation: number;
    entry?: Entry;
    received: number;
    chunks: Uint8Array<ArrayBuffer>[];
    completed: boolean;
    failed: boolean;
    /** Mutating requests reload the folder and report this once the device answers DONE. */
    success?: string;
};

type ViewMode = 'details' | 'list' | 'tiles';
type SortKey = 'name' | 'size' | 'type' | 'modified';
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

type Clipboard = { mode: 'cut' | 'copy'; dir: string; names: string[] };

type Preferences = {
    view: ViewMode;
    sort: SortKey;
    ascending: boolean;
    showHidden: boolean;
};

const PREFERENCES_KEY = 'ws-scrcpy.files.preferences';
const DEFAULT_PREFERENCES: Preferences = { view: 'details', sort: 'name', ascending: true, showHidden: false };

// Quick access, in the order Explorer puts its own: the roots first, then the folders people
// actually visit. Any of them can be missing on a given device; opening one then reports the
// device's own error instead of hiding the shortcut based on a guess.
const PLACES: { title: string; path: string }[] = [
    { title: 'Device root', path: '/' },
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

const LONG_PRESS_MS = 450;

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
    public static start(params: ParamsFileListing, mount?: HTMLElement): FileListingClient {
        return new FileListingClient(params, mount);
    }
    public static createEntryForDeviceList(descriptor: GoogDeviceDescriptor): ToolEntry | undefined {
        return fileListingTool.createEntryForDeviceList(descriptor);
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

    private filePushHandler?: FilePushHandler;
    private readonly requests = new Map<Multiplexer, Request>();
    private readonly uploads = new Map<string, HTMLElement>();
    private readonly objectUrls = new Set<string>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    /** Live downloads by device path, so progress survives a re-render (sorting, filtering, polling). */
    private readonly downloads = new Map<string, { received: number; size: number }>();

    private entries: Entry[] = [];
    private selection = new Set<string>();
    private anchorName?: string;
    private clipboard?: Clipboard;
    private filter = '';
    private preferences = readPreferences();
    private selectionMode = false;
    private backStack: string[] = [];
    private forwardStack: string[] = [];
    private readonly historyKey: string;
    private generation = 0;
    private loading = false;
    private stopped = false;
    private operations = 0;
    private enterCount = 0;
    private renderHandle = 0;
    private longPressTimer?: ReturnType<typeof setTimeout>;
    private longPressedAt = 0;
    /** Rebuilds the open menu after a setting inside it changes, keeping any Back item. */
    private menuBuilder?: () => string[];
    private typeAhead = { text: '', at: 0 };
    private path: string;
    private pendingPath?: string;
    private closeMenuListener?: (event: Event) => void;
    /**
     * A refused folder operation still refreshes the listing, and that refresh would otherwise
     * replace the device's own explanation with an item count. Hold the message and report it
     * once the listing it triggered has settled.
     */
    private operationError?: string;

    constructor(params: ParamsFileListing, mount?: HTMLElement) {
        super(params);
        this.serial = params.udid;
        this.path = path.resolve('/', params.path);
        this.historyKey = `ws-scrcpy.files.history.${this.serial}`;
        try {
            const stored = JSON.parse(sessionStorage.getItem(this.historyKey) || '{}');
            const paths = (list: unknown) =>
                Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
            this.backStack = paths(stored.back);
            this.forwardStack = paths(stored.forward);
        } catch {
            // Session storage can be unavailable; history then simply starts empty.
        }
        const fragment = html`<section class="file-listing-client file-explorer" aria-label="Device files">
            <div class="fx-chrome">
                <div class="fx-history">
                    <button
                        type="button"
                        class="fx-button fx-icon-button"
                        data-command="back"
                        aria-label="Back"
                        title="Back"
                        disabled
                    ></button>
                    <button
                        type="button"
                        class="fx-button fx-icon-button"
                        data-command="forward"
                        aria-label="Forward"
                        title="Forward"
                        disabled
                    ></button>
                    <button
                        type="button"
                        class="fx-button fx-icon-button"
                        data-command="up"
                        aria-label="Up one folder"
                        title="Up one folder"
                    ></button>
                    <button
                        type="button"
                        class="fx-button fx-icon-button fx-home"
                        data-command="home"
                        aria-label="Device root"
                        title="Device root"
                    ></button>
                    <button
                        type="button"
                        class="fx-button fx-icon-button fx-refresh"
                        data-command="refresh"
                        aria-label="Refresh"
                        title="Refresh"
                        disabled
                    ></button>
                    <button
                        type="button"
                        class="fx-button fx-icon-button fx-places-toggle"
                        data-command="places"
                        aria-haspopup="menu"
                        aria-expanded="false"
                        aria-label="Quick access"
                        title="Quick access"
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
                        class="fx-button fx-icon-button fx-address-toggle"
                        data-command="edit-path"
                        aria-label="Type a folder path"
                        title="Type a folder path"
                    ></button>
                </div>
                <div class="fx-mobile-tools">
                    <button
                        type="button"
                        class="fx-button fx-icon-button"
                        data-command="filter-toggle"
                        aria-pressed="false"
                        aria-label="Filter this folder"
                        title="Filter this folder"
                    ></button>
                    <button
                        type="button"
                        class="fx-button fx-icon-button"
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
                        class="fx-button fx-primary"
                        data-command="upload"
                        aria-label="Upload files to this folder"
                    >
                        Upload
                    </button>
                    <button type="button" class="fx-button" data-command="new-folder">New folder</button>
                    <button type="button" class="fx-button fx-contextual" data-command="download" disabled>
                        Download
                    </button>
                    <button type="button" class="fx-button fx-contextual" data-command="rename" disabled>Rename</button>
                    <button type="button" class="fx-button fx-contextual fx-danger" data-command="delete" disabled>
                        Delete
                    </button>
                    <button type="button" class="fx-button fx-contextual" data-command="cut" disabled>Cut</button>
                    <button type="button" class="fx-button fx-contextual" data-command="copy" disabled>Copy</button>
                    <button type="button" class="fx-button fx-contextual" data-command="paste" disabled>Paste</button>
                    <span class="fx-bar-spacer"></span>
                    <button
                        type="button"
                        class="fx-button fx-select-toggle"
                        data-command="selection-mode"
                        aria-pressed="false"
                    >
                        Select
                    </button>
                    <button
                        type="button"
                        class="fx-button"
                        data-command="view-menu"
                        aria-haspopup="menu"
                        aria-expanded="false"
                    >
                        View
                    </button>
                    <label class="fx-filter">
                        <input
                            type="search"
                            class="fx-filter-input"
                            placeholder="Filter"
                            aria-label="Filter items in this folder"
                        />
                    </label>
                </div>
            </div>
            <div class="fx-body">
                <nav class="fx-places" aria-label="Quick access"></nav>
                <div class="fx-main">
                    <div class="fx-transfers" aria-label="Transfers" hidden></div>
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
                    >Connecting to device…</span
                >
            </div>
            <div class="fx-menu" role="menu" hidden></div>
            <dialog class="fx-dialog"></dialog>
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
        this.menu = this.wrapper.querySelector('.fx-menu') as HTMLElement;
        this.dialog = this.wrapper.querySelector('.fx-dialog') as HTMLDialogElement;
        this.picker = this.wrapper.querySelector('input[type="file"]') as HTMLInputElement;
        this.wrapper.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((button) => {
            this.buttons.set(button.dataset.command as string, button);
        });
        this.wrapper.dataset.listing = 'loading';
        this.decorateIcons();
        this.renderBreadcrumb();
        this.applyPreferences();
        this.renderItems();

        this.wrapper.addEventListener('click', this.onClick);
        this.wrapper.addEventListener('dblclick', this.onDoubleClick);
        this.wrapper.addEventListener('contextmenu', this.onContextMenu);
        this.wrapper.addEventListener('keydown', this.onKeyDown);
        this.tableBody.addEventListener('pointerdown', this.onPointerDown);
        this.tableBody.addEventListener('pointerup', this.cancelLongPress);
        this.tableBody.addEventListener('pointercancel', this.cancelLongPress);
        this.items.addEventListener('scroll', this.cancelLongPress);
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

        (mount || document.body).appendChild(this.wrapper);
        if (!mount) {
            this.setTitle(`Files · ${this.serial}`);
            this.setBodyClass('file-listing-page');
        }
        this.openNewConnection();
        if (this.ws instanceof Multiplexer) {
            this.filePushHandler = new FilePushHandler(this.wrapper, new AdbkitFilePushStream(this.ws, this));
            this.filePushHandler.addEventListener(this);
        }
    }

    // ---------------------------------------------------------------- chrome

    private decorateIcons(): void {
        const shapes: Record<string, string> = {
            back: '<path d="m14 6-6 6 6 6"/>',
            forward: '<path d="m10 6 6 6-6 6"/>',
            up: '<path d="M12 19V6m-6 6 6-6 6 6"/>',
            refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4"/>',
            'edit-path': '<path d="M4 17h16M7 13l9-9 3 3-9 9H7z"/>',
            home: '<path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z"/>',
            places: '<path d="M4 6.5h5l1.5 2h9v9H4zM4 6.5V17"/>',
            'filter-toggle': '<circle cx="10.5" cy="10.5" r="6"/><path d="m20 20-5.2-5.2"/>',
            actions:
                '<circle cx="12" cy="5.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.7" fill="currentColor" stroke="none"/>',
        };
        Object.entries(shapes).forEach(([command, shape]) => {
            const button = this.buttons.get(command);
            if (button) {
                button.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shape}</svg>`;
            }
        });
    }

    private renderPlaces(): void {
        this.places.innerHTML = PLACES.map(
            (place) =>
                `<button type="button" class="fx-place" data-place="${esc(place.path)}"${
                    place.path === this.path ? ' aria-current="page"' : ''
                }>${iconMarkup(place.path === '/' ? 'special' : 'folder')}<span>${esc(place.title)}</span></button>`,
        ).join('');
    }

    private renderBreadcrumb(): void {
        const segments = this.path.split('/').filter(Boolean);
        let walked = '';
        const parts = [
            `<button type="button" class="fx-crumb fx-crumb-root" data-place="/" aria-label="Device root" title="Device root"${
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
        const { view, sort, ascending } = this.preferences;
        this.wrapper.dataset.view = view;
        this.tableHead.querySelectorAll<HTMLElement>('th[aria-sort]').forEach((cell) => {
            const key = cell.querySelector<HTMLElement>('.fx-sort')?.dataset.sort;
            cell.setAttribute('aria-sort', key === sort ? (ascending ? 'ascending' : 'descending') : 'none');
        });
        try {
            localStorage.setItem(PREFERENCES_KEY, JSON.stringify(this.preferences));
        } catch {
            // A remembered view is a convenience; losing it must not break the explorer.
        }
    }

    // ---------------------------------------------------------------- listing

    private visible(): Entry[] {
        const { sort, ascending, showHidden } = this.preferences;
        const direction = ascending ? 1 : -1;
        const list = this.entries.filter((entry) => {
            if (!showHidden && entry.name.startsWith('.')) {
                return false;
            }
            return !this.filter || entry.name.toLowerCase().includes(this.filter);
        });
        list.sort((a, b) => {
            // Folders first in every order, the way Explorer groups them.
            const folders = Number(b.isDirectory()) - Number(a.isDirectory());
            if (folders) {
                return folders;
            }
            let result = 0;
            if (sort === 'size') {
                result = (a.isDirectory() ? -1 : a.size) - (b.isDirectory() ? -1 : b.size);
            } else if (sort === 'modified') {
                result = a.mtime.getTime() - b.mtime.getTime();
            } else if (sort === 'type') {
                result = typeLabel(a).localeCompare(typeLabel(b));
            }
            return (result || a.name.localeCompare(b.name, undefined, { numeric: true })) * direction;
        });
        return list;
    }

    private hiddenCount(): number {
        return this.preferences.showHidden ? 0 : this.entries.filter((entry) => entry.name.startsWith('.')).length;
    }

    private scheduleRender(): void {
        if (this.stopped || this.renderHandle) {
            return;
        }
        // DENT replies arrive in a burst; one render per frame keeps a large folder responsive.
        this.renderHandle = requestAnimationFrame(() => {
            this.renderHandle = 0;
            this.renderItems();
        });
    }

    private renderItems(): void {
        if (this.stopped) {
            return;
        }
        this.wrapper.classList.remove('fx-loading');
        const active = document.activeElement;
        const focusedName =
            active instanceof HTMLElement && this.wrapper.contains(active)
                ? active.closest<HTMLElement>('tr[data-name]')?.dataset.name
                : undefined;
        const list = this.visible();
        const cut = this.clipboard?.mode === 'cut' && this.clipboard.dir === this.path ? this.clipboard.names : [];
        const rows = list.map((entry) => {
            const index = this.entries.indexOf(entry);
            const directory = entry.isDirectory();
            const selected = this.selection.has(entry.name);
            const download = this.downloads.get(path.join(this.path, entry.name));
            const percent = download
                ? Math.min(100, download.size ? (download.received * 100) / download.size : 100)
                : 0;
            const name = esc(entry.name);
            return `<tr class="fx-row${selected ? ' selected' : ''}${
                cut.includes(entry.name) ? ' fx-cut' : ''
            }" data-name="${name}" data-index="${index}" data-kind="${kindOf(entry)}" aria-selected="${selected}">
                <td class="fx-cell-select"><input type="checkbox" class="fx-check" tabindex="-1" aria-label="Select ${name}"${
                    selected ? ' checked' : ''
                }></td>
                <td class="entry-name">
                    <a class="${directory ? 'dir' : 'file'}" href="${esc(
                        this.link(path.join(this.path, entry.name)),
                    )}" data-name="${name}" data-entry-id="${index}" aria-label="${
                        entry.isFile() ? 'Download' : 'Open'
                    } ${name}">${iconMarkup(kindOf(entry))}<span class="fx-name">${name}</span></a>
                    ${download ? `<span class="file-listing-progress" style="width:${percent}%" aria-hidden="true"></span>` : ''}
                </td>
                <td class="entry-size" data-label="Size">${directory ? '—' : esc(formatSize(entry.size))}</td>
                <td class="entry-type" data-label="Type">${esc(typeLabel(entry))}</td>
                <td class="entry-time" data-label="Modified">${esc(formatModified(entry.mtime))}</td>
                <td class="fx-cell-menu"><button type="button" class="fx-row-menu" tabindex="-1" aria-haspopup="menu" aria-label="Actions for ${name}"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5.5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="18.5" r="1.6"/></svg></button></td>
            </tr>`;
        });
        if (!rows.length) {
            const message = this.loading
                ? 'Loading folder…'
                : this.entries.length
                  ? 'No items match the filter.'
                  : 'This folder is empty.';
            rows.push(`<tr class="fx-empty-row"><td colspan="6" class="fx-empty">${esc(message)}</td></tr>`);
        }
        this.tableBody.innerHTML = rows.join('');
        if (focusedName) {
            this.tableBody
                .querySelector<HTMLElement>(`tr[data-name="${CSS.escape(focusedName)}"] .entry-name a`)
                ?.focus({ preventScroll: true });
        }
        this.renderStatus();
        this.updateControls();
    }

    /**
     * Selection changes must not rebuild the rows. Replacing the node between the two clicks of a
     * double click loses the `dblclick` event entirely, so opening an item with a mouse silently
     * stopped working; repainting in place also keeps scroll position and focus.
     */
    private paintSelection(): void {
        const cut = this.clipboard?.mode === 'cut' && this.clipboard.dir === this.path ? this.clipboard.names : [];
        this.tableBody.querySelectorAll<HTMLElement>('tr[data-name]').forEach((row) => {
            const name = row.dataset.name as string;
            const selected = this.selection.has(name);
            row.classList.toggle('selected', selected);
            row.classList.toggle('fx-cut', cut.includes(name));
            row.setAttribute('aria-selected', String(selected));
            const check = row.querySelector<HTMLInputElement>('.fx-check');
            if (check) {
                check.checked = selected;
            }
        });
        this.renderStatus();
        this.updateControls();
    }

    private renderStatus(): void {
        const list = this.visible();
        const selected = list.filter((entry) => this.selection.has(entry.name));
        const bytes = selected.reduce((total, entry) => total + (entry.isDirectory() ? 0 : entry.size), 0);
        const hidden = this.hiddenCount();
        const parts = [this.filter ? `${list.length} of ${this.entries.length} items` : `${this.entries.length} items`];
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

    private report(message: string, error = false): void {
        if (this.stopped) {
            return;
        }
        this.status.textContent = message;
        this.status.classList.toggle('error', error);
        this.status.setAttribute('role', error ? 'alert' : 'status');
    }

    private canModify(): boolean {
        return !this.stopped && this.hasConnection() && !this.loading && !this.uploads.size && !this.operations;
    }

    private updateControls(): void {
        const ready = this.canModify();
        const selected = this.selectedEntries();
        const files = selected.filter((entry) => entry.isFile());
        const enable = (command: string, value: boolean) => {
            const button = this.buttons.get(command);
            if (button) {
                button.disabled = !value;
            }
        };
        enable('back', !!this.backStack.length);
        enable('forward', !!this.forwardStack.length);
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
        this.wrapper.classList.toggle('fx-selecting', this.selectionMode || this.selection.size > 0);
        this.wrapper.setAttribute('aria-busy', String(this.loading));
    }

    private selectedEntries(): Entry[] {
        return this.entries.filter((entry) => this.selection.has(entry.name));
    }

    // ---------------------------------------------------------------- input

    private onClick = (event: MouseEvent): void => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || !this.wrapper.contains(target)) {
            return;
        }
        const menuItem = target.closest<HTMLElement>('.fx-menu [data-menu]');
        if (menuItem) {
            event.preventDefault();
            this.runMenuItem(menuItem);
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
            if (!target.closest('.fx-menu')) {
                this.closeMenu();
            }
            return;
        }
        this.closeMenu();
        const name = row.dataset.name as string;
        if (Date.now() - this.longPressedAt < 600) {
            // The long press already put this row into multi-select; the trailing click must
            // not toggle it straight back out.
            event.preventDefault();
            return;
        }
        if (target.closest('.fx-row-menu')) {
            event.preventDefault();
            if (!this.selection.has(name)) {
                this.selectOnly(name);
            }
            this.openRowMenu(target.closest('.fx-row-menu') as HTMLElement);
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
                this.open(name);
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
            this.openMenu(() => this.itemMenuItems(), event.clientX, event.clientY);
        } else if (target.closest('.fx-items')) {
            this.openMenu(() => this.folderMenuItems(), event.clientX, event.clientY);
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
        if (this.menu.hidden === false && this.onMenuKeyDown(event)) {
            return;
        }
        const target = event.target as HTMLElement | null;
        const typing = !!target?.closest('input, textarea, select');
        if (event.key === 'Escape') {
            if (!this.menu.hidden) {
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
        const current = target?.closest<HTMLElement>('tr[data-name]')?.dataset.name;
        const index = list.findIndex((entry) => entry.name === current);
        const focusAt = (next: number) => {
            const entry = list[Math.max(0, Math.min(list.length - 1, next))];
            if (!entry) {
                return;
            }
            const anchor = this.tableBody.querySelector<HTMLElement>(
                `tr[data-name="${CSS.escape(entry.name)}"] .entry-name a`,
            );
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
        } else if (event.key === ' ' && current) {
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

    private itemMenuItems(): string[] {
        const selected = this.selectedEntries();
        const single = selected.length === 1 ? selected[0] : undefined;
        const files = selected.filter((entry) => entry.isFile()).length;
        const items: string[] = [];
        if (single) {
            items.push(this.menuItem('open', single.isDirectory() ? 'Open' : 'Download'));
        } else if (files) {
            items.push(this.menuItem('download', `Download ${files} file${files === 1 ? '' : 's'}`));
        }
        items.push('<div class="fx-menu-separator" role="separator"></div>');
        items.push(this.menuItem('cut', 'Cut'));
        items.push(this.menuItem('copy', 'Copy'));
        items.push(this.menuItem('paste', 'Paste', !this.clipboard?.names.length));
        items.push(this.menuItem('copy-path', 'Copy path'));
        items.push('<div class="fx-menu-separator" role="separator"></div>');
        items.push(this.menuItem('rename', 'Rename', selected.length !== 1));
        items.push(this.menuItem('delete', 'Delete', false, 'fx-menu-danger'));
        items.push('<div class="fx-menu-separator" role="separator"></div>');
        items.push(this.menuItem('properties', 'Properties', selected.length !== 1));
        return items;
    }

    private folderMenuItems(): string[] {
        return [
            this.menuItem('refresh', 'Refresh'),
            this.menuItem('new-folder', 'New folder'),
            this.menuItem('upload', 'Upload files'),
            this.menuItem('paste', 'Paste', !this.clipboard?.names.length),
            '<div class="fx-menu-separator" role="separator"></div>',
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
        const items = selected.length
            ? [...this.itemMenuItems(), '<div class="fx-menu-separator" role="separator"></div>']
            : [];
        items.push(
            this.menuItem('upload', 'Upload files', !ready),
            this.menuItem('new-folder', 'New folder', !ready),
            ...(selected.length ? [] : [this.menuItem('paste', 'Paste', !ready || !this.clipboard?.names.length)]),
            this.menuItem('refresh', 'Refresh', !this.hasConnection() || this.loading),
            '<div class="fx-menu-separator" role="separator"></div>',
            `<button type="button" role="menuitemcheckbox" aria-checked="${this.selectionMode}" data-menu="command" data-value="selection-mode">Select items</button>`,
            this.menuItem('select-all', 'Select all'),
            '<div class="fx-menu-separator" role="separator"></div>',
            '<button type="button" role="menuitem" data-menu="submenu" data-value="view">View options…</button>',
        );
        return items;
    }

    private viewSubmenuItems(): string[] {
        return [
            '<button type="button" role="menuitem" class="fx-menu-back" data-menu="submenu" data-value="actions">‹ Back</button>',
            '<div class="fx-menu-separator" role="separator"></div>',
            ...this.viewMenuItems(),
        ];
    }

    /** Quick access as a menu, for every width where the sidebar would crowd out the listing. */
    private placesMenuItems(): string[] {
        return [
            '<div class="fx-menu-title" role="presentation">Quick access</div>',
            ...PLACES.map(
                (place) =>
                    `<button type="button" role="menuitemradio" aria-checked="${
                        place.path === this.path
                    }" data-menu="place" data-value="${esc(place.path)}">${esc(place.title)}</button>`,
            ),
        ];
    }

    private viewMenuItems(): string[] {
        const { view, sort, ascending, showHidden } = this.preferences;
        const radio = (value: string, title: string, checked: boolean, key: string) =>
            `<button type="button" role="menuitemradio" aria-checked="${checked}" data-menu="${key}" data-value="${value}">${esc(
                title,
            )}</button>`;
        return [
            '<div class="fx-menu-title" role="presentation">Layout</div>',
            radio('details', 'Details', view === 'details', 'view'),
            radio('list', 'List', view === 'list', 'view'),
            radio('tiles', 'Tiles', view === 'tiles', 'view'),
            '<div class="fx-menu-separator" role="separator"></div>',
            '<div class="fx-menu-title" role="presentation">Sort by</div>',
            ...(Object.keys(SORT_TITLES) as SortKey[]).map((key) => radio(key, SORT_TITLES[key], sort === key, 'sort')),
            radio('asc', 'Ascending', ascending, 'order'),
            radio('desc', 'Descending', !ascending, 'order'),
            '<div class="fx-menu-separator" role="separator"></div>',
            `<button type="button" role="menuitemcheckbox" aria-checked="${showHidden}" data-menu="hidden">Hidden items</button>`,
        ];
    }

    private menuItem(command: string, title: string, disabled = false, className = ''): string {
        return `<button type="button" role="menuitem" data-menu="command" data-value="${command}" class="${className}"${
            disabled ? ' disabled' : ''
        }>${esc(title)}</button>`;
    }

    private openMenu(build: () => string[], clientX: number, clientY: number): void {
        this.menuBuilder = build;
        this.menu.innerHTML = build().join('');
        this.menu.hidden = false;
        const bounds = this.wrapper.getBoundingClientRect();
        const size = this.menu.getBoundingClientRect();
        const left = Math.max(4, Math.min(clientX - bounds.left, bounds.width - size.width - 4));
        const top = Math.max(4, Math.min(clientY - bounds.top, bounds.height - size.height - 4));
        this.menu.style.left = `${left}px`;
        this.menu.style.top = `${top}px`;
        this.menu.querySelector<HTMLElement>('button:not([disabled])')?.focus();
        if (!this.closeMenuListener) {
            this.closeMenuListener = (event: Event) => {
                const target = event.target;
                if (target instanceof Node && this.menu.contains(target)) {
                    return;
                }
                this.closeMenu();
            };
            document.addEventListener('pointerdown', this.closeMenuListener, true);
        }
    }

    private openRowMenu(button: HTMLElement): void {
        const rect = button.getBoundingClientRect();
        this.openMenu(() => this.itemMenuItems(), rect.left, rect.bottom);
    }

    private refreshMenu(focus?: string): void {
        if (this.menu.hidden || !this.menuBuilder) {
            return;
        }
        this.menu.innerHTML = this.menuBuilder().join('');
        const target = focus ? this.menu.querySelector<HTMLElement>(focus) : null;
        (target || this.menu.querySelector<HTMLElement>('button:not([disabled])'))?.focus();
    }

    private closeMenu(): void {
        if (this.menu.hidden) {
            return;
        }
        this.menu.hidden = true;
        this.menu.innerHTML = '';
        this.menuBuilder = undefined;
        ['view-menu', 'places', 'actions'].forEach((command) =>
            this.buttons.get(command)?.setAttribute('aria-expanded', 'false'),
        );
        if (this.closeMenuListener) {
            document.removeEventListener('pointerdown', this.closeMenuListener, true);
            this.closeMenuListener = undefined;
        }
    }

    private onMenuKeyDown(event: KeyboardEvent): boolean {
        const options = Array.from(this.menu.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
        if (!options.length) {
            return false;
        }
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
            options[(next + options.length) % options.length].focus();
            return true;
        }
        if (event.key === 'Tab') {
            event.preventDefault();
            this.closeMenu();
            return true;
        }
        return false;
    }

    private runMenuItem(item: HTMLElement): void {
        const kind = item.dataset.menu;
        const value = item.dataset.value || '';
        if (kind === 'command') {
            this.closeMenu();
            this.runCommand(value);
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
        }
        this.applyPreferences();
        this.renderItems();
        // The View menu stays open while several settings are adjusted, like Explorer's ribbon.
        this.refreshMenu(`[data-menu="${kind}"]`);
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

    private runCommand(command: string): void {
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
        ) {
            case 'back':
                this.step(this.backStack);
                return;
            case 'forward':
                this.step(this.forwardStack);
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
                const rect = button.getBoundingClientRect();
                button.setAttribute('aria-expanded', 'true');
                const builders: Record<string, () => string[]> = {
                    'view-menu': () => this.viewMenuItems(),
                    places: () => this.placesMenuItems(),
                    actions: () => this.actionsMenuItems(),
                };
                this.openMenu(builders[command], rect.left, rect.bottom);
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
            case 'select-all':
                this.visible().forEach((entry) => this.selection.add(entry.name));
                this.paintSelection();
                return;
            case 'upload':
                this.picker.click();
                return;
            case 'open': {
                const [entry] = this.selectedEntries();
                if (entry) {
                    this.open(entry.name);
                }
                return;
            }
            case 'download':
                this.selectedEntries()
                    .filter((entry) => entry.isFile())
                    .forEach((entry) => this.download(path.join(this.path, entry.name), entry));
                return;
            case 'copy-path': {
                const paths = this.selectedEntries().map((entry) => path.join(this.path, entry.name));
                void this.copyText(paths.join('\n'));
                return;
            }
            case 'cut':
            case 'copy': {
                const names = this.selectedEntries().map((entry) => entry.name);
                if (!names.length) {
                    return;
                }
                this.clipboard = { mode: command as Clipboard['mode'], dir: this.path, names };
                this.report(`${names.length} item${names.length === 1 ? '' : 's'} ready to paste.`);
                this.paintSelection();
                return;
            }
            case 'paste':
                this.paste();
                return;
            case 'new-folder':
                void this.createFolder();
                return;
            case 'rename':
                void this.rename();
                return;
            case 'delete':
                void this.remove();
                return;
            case 'properties':
                this.showProperties();
                return;
        }
    }

    private step(stack: string[]): void {
        const destination = stack[stack.length - 1];
        if (destination) {
            this.navigate(destination);
        }
    }

    private open(name: string): void {
        const entry = this.entries.find((item) => item.name === name);
        const destination = path.resolve(this.path, name);
        if (entry?.isFile()) {
            this.download(destination, entry);
        } else {
            this.navigate(destination);
        }
    }

    private async copyText(text: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            this.report('Copied to the clipboard.');
        } catch {
            // Insecure origins and denied permissions both land here; show the path to copy by hand.
            this.report(text);
        }
    }

    private async createFolder(): Promise<void> {
        const name = await this.prompt({
            title: 'New folder',
            label: 'Folder name',
            value: 'New folder',
            confirm: 'Create',
        });
        if (!name) {
            return;
        }
        const problem = this.checkName(name);
        if (problem) {
            this.report(problem, true);
            return;
        }
        const destination = path.join(this.path, name);
        this.mutate(this.stringCommand(FileCommand.MKDIR, destination), `Creating ${name}…`, `Created ${name}.`);
    }

    private async rename(): Promise<void> {
        const [entry] = this.selectedEntries();
        if (!entry) {
            return;
        }
        const name = await this.prompt({
            title: 'Rename',
            label: 'New name',
            value: entry.name,
            confirm: 'Rename',
            selectBase: entry.isFile(),
        });
        if (!name || name === entry.name) {
            return;
        }
        const problem = this.checkName(name);
        if (problem) {
            this.report(problem, true);
            return;
        }
        this.mutate(
            this.pairCommand(FileCommand.MOVE, path.join(this.path, entry.name), path.join(this.path, name)),
            `Renaming ${entry.name}…`,
            `Renamed to ${name}.`,
        );
    }

    private async remove(): Promise<void> {
        const selected = this.selectedEntries();
        if (!selected.length) {
            return;
        }
        const label = selected.length === 1 ? `“${selected[0].name}”` : `${selected.length} items`;
        const folders = selected.filter((entry) => entry.isDirectory()).length;
        const confirmed = await this.confirm({
            title: 'Delete',
            message: `Delete ${label} from the device?${
                folders ? ' Folders are deleted with everything inside them.' : ''
            } This cannot be undone.`,
            confirm: 'Delete',
            danger: true,
        });
        if (!confirmed) {
            return;
        }
        const paths = selected.map((entry) => path.join(this.path, entry.name));
        const payload = Buffer.alloc(
            8 + paths.reduce((total, item) => total + 4 + Buffer.byteLength(item, 'utf-8'), 0),
        );
        payload.write(FileCommand.DELETE, 0, 'ascii');
        payload.writeUInt32LE(paths.length, 4);
        let offset = 8;
        paths.forEach((item) => {
            const length = Buffer.byteLength(item, 'utf-8');
            payload.writeUInt32LE(length, offset);
            offset += 4;
            payload.write(item, offset, 'utf-8');
            offset += length;
        });
        this.selection.clear();
        this.mutate(payload, `Deleting ${label}…`, `Deleted ${label}.`);
    }

    private paste(): void {
        const clipboard = this.clipboard;
        if (!clipboard?.names.length) {
            return;
        }
        if (clipboard.dir === this.path && clipboard.mode === 'cut') {
            this.report('These items are already in this folder.');
            return;
        }
        const existing = new Set(this.entries.map((entry) => entry.name));
        const collision = clipboard.names.find((name) => existing.has(name));
        if (collision) {
            this.report(`“${collision}” already exists in this folder. Rename it first.`, true);
            return;
        }
        // One channel per item keeps each failure reportable on its own, and `mutate` reloads once
        // the last operation finishes.
        const command = clipboard.mode === 'cut' ? FileCommand.MOVE : FileCommand.COPY;
        const verb = clipboard.mode === 'cut' ? 'Moving' : 'Copying';
        const done = clipboard.mode === 'cut' ? 'Moved' : 'Copied';
        clipboard.names.forEach((name) => {
            this.mutate(
                this.pairCommand(command, path.join(clipboard.dir, name), path.join(this.path, name)),
                `${verb} ${name}…`,
                `${done} ${name}.`,
            );
        });
        if (clipboard.mode === 'cut') {
            this.clipboard = undefined;
        }
    }

    private checkName(name: string): string {
        if (name.includes('/')) {
            return 'A name cannot contain “/”.';
        }
        if (name === '.' || name === '..') {
            return 'Choose a different name.';
        }
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f\x7f]/.test(name)) {
            return 'This name contains characters that cannot be used on the device.';
        }
        if (this.entries.some((entry) => entry.name === name)) {
            return `“${name}” already exists in this folder.`;
        }
        return '';
    }

    private showProperties(): void {
        const [entry] = this.selectedEntries();
        if (!entry) {
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
        this.dialog.innerHTML = `<form method="dialog" class="fx-dialog-form">
            <h2>Properties</h2>
            <dl class="fx-properties">${rows
                .map(([title, value]) => `<dt>${esc(title)}</dt><dd>${esc(value)}</dd>`)
                .join('')}</dl>
            <div class="fx-dialog-actions">
                <button type="submit" class="fx-button fx-primary" value="close">Close</button>
            </div>
        </form>`;
        this.dialog.showModal();
    }

    // ---------------------------------------------------------------- dialogs

    private prompt(options: {
        title: string;
        label: string;
        value: string;
        confirm: string;
        selectBase?: boolean;
    }): Promise<string | undefined> {
        this.dialog.innerHTML = `<form method="dialog" class="fx-dialog-form">
            <h2>${esc(options.title)}</h2>
            <label class="fx-dialog-field">
                <span>${esc(options.label)}</span>
                <input type="text" name="value" spellcheck="false" autocapitalize="off" autocomplete="off" required />
            </label>
            <div class="fx-dialog-actions">
                <button type="button" class="fx-button" data-dialog="cancel">Cancel</button>
                <button type="submit" class="fx-button fx-primary" value="confirm">${esc(options.confirm)}</button>
            </div>
        </form>`;
        const input = this.dialog.querySelector('input[name="value"]') as HTMLInputElement;
        input.value = options.value;
        return this.showDialog(() => {
            const dot = options.selectBase ? options.value.lastIndexOf('.') : -1;
            input.focus();
            input.setSelectionRange(0, dot > 0 ? dot : options.value.length);
        }).then((result) => (result === 'confirm' ? input.value.trim() : undefined));
    }

    private confirm(options: { title: string; message: string; confirm: string; danger?: boolean }): Promise<boolean> {
        this.dialog.innerHTML = `<form method="dialog" class="fx-dialog-form">
            <h2>${esc(options.title)}</h2>
            <p class="fx-dialog-message">${esc(options.message)}</p>
            <div class="fx-dialog-actions">
                <button type="button" class="fx-button" data-dialog="cancel">Cancel</button>
                <button type="submit" class="fx-button ${
                    options.danger ? 'fx-danger-solid' : 'fx-primary'
                }" value="confirm">${esc(options.confirm)}</button>
            </div>
        </form>`;
        return this.showDialog(() => this.dialog.querySelector<HTMLButtonElement>('[value="confirm"]')?.focus()).then(
            (result) => result === 'confirm',
        );
    }

    private showDialog(onOpen: () => void): Promise<string> {
        return new Promise((resolve) => {
            const finish = () => {
                this.dialog.removeEventListener('close', finish);
                resolve(this.dialog.returnValue);
            };
            this.dialog.returnValue = '';
            this.dialog.addEventListener('close', finish);
            this.dialog.querySelector<HTMLButtonElement>('[data-dialog="cancel"]')?.addEventListener('click', () => {
                this.dialog.close('');
            });
            this.dialog.showModal();
            onOpen();
        });
    }

    // ---------------------------------------------------------------- protocol

    private stringCommand(command: string, value: string): Buffer {
        const length = Buffer.byteLength(value, 'utf-8');
        const payload = Buffer.alloc(8 + length);
        payload.write(command, 0, 'ascii');
        payload.writeUInt32LE(length, 4);
        payload.write(value, 8, 'utf-8');
        return payload;
    }

    private pairCommand(command: FileCommand, from: string, to: string): Buffer {
        const fromLength = Buffer.byteLength(from, 'utf-8');
        const toLength = Buffer.byteLength(to, 'utf-8');
        const payload = Buffer.alloc(12 + fromLength + toLength);
        payload.write(command, 0, 'ascii');
        payload.writeUInt32LE(fromLength, 4);
        payload.write(from, 8, 'utf-8');
        payload.writeUInt32LE(toLength, 8 + fromLength);
        payload.write(to, 12 + fromLength, 'utf-8');
        return payload;
    }

    private mutate(payload: Buffer, pending: string, success: string): void {
        // Callers gate on `canModify()`; a multi-item paste must not block itself after its own
        // first operation raises the pending count.
        if (this.stopped || !this.hasConnection()) {
            return;
        }
        this.report(pending);
        this.operationError = undefined;
        this.operations++;
        this.updateControls();
        this.send('mutate', payload, this.path, undefined, success);
    }

    private request(kind: Request['kind'], destination: string, entry?: Entry): void {
        const cmd = kind === 'stat' ? Protocol.STAT : kind === 'list' ? Protocol.LIST : Protocol.RECV;
        this.send(kind, this.stringCommand(cmd, destination), destination, entry);
    }

    private send(kind: Request['kind'], payload: Buffer, destination: string, entry?: Entry, success?: string): void {
        if (this.stopped || !(this.ws instanceof Multiplexer) || !this.hasConnection()) {
            return;
        }
        const channel = this.ws.createChannel(payload);
        const request: Request = {
            kind,
            path: destination,
            generation: this.generation,
            entry,
            received: 0,
            chunks: [],
            completed: false,
            failed: false,
            success,
        };
        this.requests.set(channel, request);
        // Only listings belong to a generation: a download or a folder operation must survive the
        // navigation that a completed operation itself triggers.
        const stale = () => kind !== 'download' && kind !== 'mutate' && request.generation !== this.generation;
        const onMessage = (event: MessageEvent) => {
            if (this.stopped || stale()) {
                return;
            }
            try {
                this.handleReply(channel, request, Buffer.from(event.data));
            } catch {
                request.failed = true;
                this.report('Could not read this folder or file. Refresh to try again.', true);
                channel.close();
            }
        };
        const onClose = (event: CloseEvent) => {
            channel.removeEventListener('message', onMessage);
            channel.removeEventListener('close', onClose);
            this.requests.delete(channel);
            if (kind === 'download') {
                this.downloads.delete(request.path);
                this.scheduleRender();
            }
            if (kind === 'mutate') {
                this.operations = Math.max(0, this.operations - 1);
            }
            if (this.stopped || stale()) {
                return;
            }
            if (
                !request.failed &&
                ((event.code !== 0 && event.code !== 1000) ||
                    ((kind === 'stat' || kind === 'mutate') && !request.completed))
            ) {
                request.failed = true;
                this.report('The file request was interrupted. Refresh to try again.', true);
            }
            if (kind === 'list' || (kind === 'stat' && !request.completed)) {
                this.finishListing(request);
            }
            if (kind === 'download' && !request.completed && !request.failed) {
                this.report('The download was interrupted. Select the file to try again.', true);
            }
            if (kind === 'mutate') {
                if (request.completed && !request.failed) {
                    this.report(request.success || 'Done.');
                }
                // Reload once the last operation of a batch has answered, so a multi-item paste
                // does not re-list the folder for every item.
                if (!this.operations) {
                    this.reload();
                }
            }
            this.updateControls();
        };
        channel.addEventListener('message', onMessage);
        channel.addEventListener('close', onClose);
    }

    private handleReply(channel: Multiplexer, request: Request, data: Buffer): void {
        if (data.length < 4) {
            throw Error('Truncated reply');
        }
        const code = data.subarray(0, 4).toString('ascii');
        if (code === Protocol.FAIL) {
            request.failed = true;
            const message = data.subarray(8, 8 + data.readUInt32LE(4)).toString('utf8');
            this.report(message || 'The device could not open this folder or file.', true);
            if (request.kind === 'mutate') {
                this.operationError = message || 'The device refused this operation.';
            } else if (request.kind !== 'download') {
                this.finishListing(request);
            }
            channel.close();
        } else if (code === Protocol.STAT) {
            request.completed = true;
            const entry = new Entry(
                path.basename(request.path),
                data.readUInt32LE(4),
                data.readUInt32LE(8),
                data.readUInt32LE(12),
            );
            if (!entry.mode) {
                request.failed = true;
                this.report('This path is unavailable. Choose another folder or refresh.', true);
                this.finishListing(request);
            } else if (entry.isDirectory()) {
                this.list(request.path);
            } else if (entry.isFile()) {
                this.download(request.path, entry);
                this.list(path.dirname(request.path));
            } else {
                request.failed = true;
                this.report('This item is not a regular file or folder.', true);
                this.finishListing(request);
            }
        } else if (code === Protocol.DENT && request.kind === 'list') {
            const entry = new Entry(
                data.subarray(20, 20 + data.readUInt32LE(16)).toString('utf8'),
                data.readUInt32LE(4),
                data.readUInt32LE(8),
                data.readUInt32LE(12),
            );
            if (entry.name !== '.' && entry.name !== '..') {
                this.entries.push(entry);
                this.scheduleRender();
            }
        } else if (code === Protocol.DATA && request.kind === 'download') {
            request.chunks.push(new Uint8Array(data.subarray(4)));
            request.received += data.length - 4;
            const progress = this.downloads.get(request.path);
            if (progress) {
                progress.received = request.received;
                this.updateProgressBar(request);
            }
        } else if (code === Protocol.DONE) {
            request.completed = true;
            if (request.kind === 'download') {
                this.finishDownload(request);
            } else if (request.kind !== 'mutate') {
                this.finishListing(request);
            }
        }
    }

    /** Updates the existing bar in place: a re-render per data packet would fight scrolling. */
    private updateProgressBar(request: Request): void {
        const name = path.basename(request.path);
        const bar = this.tableBody.querySelector<HTMLElement>(
            `tr[data-name="${CSS.escape(name)}"] .file-listing-progress`,
        );
        if (bar) {
            const size = request.entry?.size || 0;
            bar.style.width = `${Math.min(100, size ? (request.received * 100) / size : 100)}%`;
        } else {
            this.scheduleRender();
        }
    }

    private finishListing(request: Request): void {
        if (request.generation !== this.generation || this.stopped) {
            return;
        }
        this.loading = false;
        this.wrapper.dataset.listing = request.failed ? 'error' : 'ready';
        this.renderItems();
        if (request.failed) {
            return;
        }
        if (this.operationError) {
            this.report(this.operationError, true);
            this.operationError = undefined;
            return;
        }
        this.report('');
    }

    private list(destination: string): void {
        this.path = destination;
        this.entries = [];
        this.selection.clear();
        this.anchorName = undefined;
        this.renderBreadcrumb();
        // The old rows stay, dimmed and inert, until the new folder has rows of its own; wiping
        // them first made every folder change flash an empty list.
        this.wrapper.classList.add('fx-loading');
        this.updateControls();
        const params = new URLSearchParams(location.hash.replace(/^#!/, ''));
        if (
            params.get('action') === ACTION.FILE_LISTING &&
            params.get('udid') === this.serial &&
            params.get('path') !== destination
        ) {
            params.set('path', destination);
            pushRoute(params);
        }
        this.request('list', destination);
    }

    private link(destination: string): string {
        const url = new URL(location.href);
        const params = new URLSearchParams(url.hash.replace(/^#!/, ''));
        params.set('path', destination);
        url.hash = `#!${params.toString()}`;
        return url.toString();
    }

    private download(destination: string, entry: Entry): void {
        if (
            Array.from(this.requests.values()).some(
                (request) => request.kind === 'download' && request.path === destination,
            )
        ) {
            return;
        }
        this.report(`Downloading ${entry.name}…`);
        this.downloads.set(destination, { received: 0, size: entry.size });
        this.scheduleRender();
        this.request('download', destination, entry);
    }

    private finishDownload(request: Request): void {
        const file = new Blob(request.chunks, { type: 'application/octet-stream' });
        request.chunks = [];
        const url = URL.createObjectURL(file);
        this.objectUrls.add(url);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = request.entry?.name || path.basename(request.path);
        this.wrapper.appendChild(anchor);
        anchor.click();
        anchor.remove();
        const timer = setTimeout(() => {
            URL.revokeObjectURL(url);
            this.objectUrls.delete(url);
            this.timers.delete(timer);
        }, 60000);
        this.timers.add(timer);
        this.report(`Downloaded ${anchor.download}.`);
    }

    // ---------------------------------------------------------------- navigation

    public getPath(): string {
        return this.path;
    }

    public focus(): void {
        this.items.focus();
    }

    /**
     * Every path change funnels through here: shortcut clicks, the address bar, the history
     * buttons and the browser's own Back/Forward (which reach it through the hash router). The
     * destination tells the stacks apart -- matching the top of one stack means the user went
     * that way, anything else is a new visit.
     */
    public navigate(destination: string): void {
        const normalized = path.resolve('/', destination);
        if (this.stopped) {
            return;
        }
        if (!this.hasConnection()) {
            this.path = normalized;
            this.renderBreadcrumb();
            return;
        }
        if (normalized === this.path) {
            return;
        }
        if (this.backStack[this.backStack.length - 1] === normalized) {
            this.backStack.pop();
            this.forwardStack.push(this.path);
        } else if (this.forwardStack[this.forwardStack.length - 1] === normalized) {
            this.forwardStack.pop();
            this.backStack.push(this.path);
        } else {
            this.backStack.push(this.path);
            this.forwardStack = [];
        }
        try {
            sessionStorage.setItem(
                this.historyKey,
                JSON.stringify({ back: this.backStack.slice(-50), forward: this.forwardStack.slice(-50) }),
            );
        } catch {
            // Remembering history is a convenience; a full or blocked store must not stop navigation.
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
        if (this.uploads.size) {
            this.pendingPath = destination;
            this.report('Wait for uploads to finish before changing folders.');
            return;
        }
        this.pendingPath = undefined;
        this.closeMenu();
        this.generation++;
        this.loading = true;
        this.setFiltering(false);
        // A settled listing needs an observable marker: "no rows yet" and "this folder is empty"
        // look identical from the outside, which is exactly how a fixture reads a half-loaded
        // folder as an empty one.
        this.wrapper.dataset.listing = 'loading';
        this.updateControls();
        for (const [channel, request] of this.requests) {
            if (request.kind === 'list' || request.kind === 'stat') {
                channel.close();
            }
        }
        this.report('Loading folder…');
        this.request('stat', destination);
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
            this.report('Wait for the current folder or upload to finish before adding files.');
            return false;
        }
        return true;
    }
    public onFilePushUpdate(data: PushUpdateParams): void {
        if (this.stopped) {
            return;
        }
        let row = this.uploads.get(data.fileName);
        if (!row) {
            row = document.createElement('div');
            row.className = 'file-listing-upload-progress';
            this.transfers.appendChild(row);
            this.transfers.hidden = false;
            this.uploads.set(data.fileName, row);
        }
        row.textContent = `${data.fileName} · ${data.message}`;
        row.classList.toggle('error', data.error);
        if (data.finished) {
            row.remove();
            this.uploads.delete(data.fileName);
            this.transfers.hidden = !this.transfers.childElementCount;
            this.report(data.error ? `${data.fileName}: ${data.message}` : `Uploaded ${data.fileName}.`, data.error);
            if (!this.uploads.size) {
                if (this.pendingPath) {
                    this.load(this.pendingPath);
                } else if (!data.error) {
                    this.reload();
                }
            }
        }
        this.updateControls();
    }
    public onError(error: string | Error): void {
        this.report(typeof error === 'string' ? error : error.message, true);
    }

    // ---------------------------------------------------------------- lifecycle

    public stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.cancelLongPress();
        this.closeMenu();
        if (this.renderHandle) {
            cancelAnimationFrame(this.renderHandle);
            this.renderHandle = 0;
        }
        if (this.dialog.open) {
            this.dialog.close('');
        }
        this.filePushHandler?.release();
        this.filePushHandler = undefined;
        for (const channel of this.requests.keys()) {
            channel.close();
        }
        this.requests.clear();
        this.uploads.clear();
        this.downloads.clear();
        for (const timer of this.timers) {
            clearTimeout(timer);
        }
        this.timers.clear();
        for (const url of this.objectUrls) {
            URL.revokeObjectURL(url);
        }
        this.objectUrls.clear();
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
            path: params.get('path') || '/data/local/tmp',
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
        this.loading = false;
        this.updateControls();
        this.report('Connection lost. Return to your devices and open Files again.', true);
    }
    protected supportMultiplexing(): boolean {
        return true;
    }
    protected getChannelInitData(): Buffer {
        const serial = Buffer.from(this.serial, 'utf8');
        const buffer = Buffer.alloc(8 + serial.length);
        buffer.write(ChannelCode.FSLS, 0);
        buffer.writeUInt32LE(serial.length, 4);
        serial.copy(buffer, 8);
        return buffer;
    }
}
