import { Entry } from '../Entry';

export type FileKind =
    | 'folder'
    | 'apk'
    | 'image'
    | 'video'
    | 'audio'
    | 'archive'
    | 'code'
    | 'text'
    | 'document'
    | 'link'
    | 'special'
    | 'file';

// Extension groups worth an icon of their own. Android storage is mostly media, archives and
// APKs, so those earn a distinct glyph; everything else falls back to the generic file icon.
const EXTENSIONS: [FileKind, string[]][] = [
    ['apk', ['apk', 'apks', 'apkm', 'xapk', 'aab']],
    ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'svg', 'ico', 'avif', 'dng', 'raw']],
    ['video', ['mp4', 'mkv', 'webm', 'mov', 'avi', '3gp', 'm4v', 'flv', 'ts', 'mpg', 'mpeg']],
    ['audio', ['mp3', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'm4a', 'amr', 'mid', 'midi']],
    ['archive', ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'jar', 'iso', 'obb']],
    [
        'code',
        [
            'js',
            'mjs',
            'cjs',
            'ts',
            'tsx',
            'jsx',
            'json',
            'xml',
            'html',
            'htm',
            'css',
            'java',
            'kt',
            'c',
            'h',
            'cpp',
            'cc',
            'py',
            'rb',
            'go',
            'rs',
            'sh',
            'bash',
            'gradle',
            'yml',
            'yaml',
            'toml',
            'sql',
            'smali',
        ],
    ],
    ['text', ['txt', 'log', 'md', 'ini', 'conf', 'cfg', 'prop', 'properties', 'csv', 'tsv']],
    ['document', ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'rtf', 'epub']],
];

const KIND_LABEL: Record<FileKind, string> = {
    folder: 'Folder',
    apk: 'Android app',
    image: 'Image',
    video: 'Video',
    audio: 'Audio',
    archive: 'Archive',
    code: 'Code',
    text: 'Text',
    document: 'Document',
    link: 'Shortcut',
    special: 'System object',
    file: 'File',
};

export function extensionOf(name: string): string {
    // A leading dot marks a hidden file, not an extension: `.bashrc` has none.
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function kindOf(entry: Entry): FileKind {
    if (entry.isDirectory()) {
        return 'folder';
    }
    if (entry.isSymbolicLink()) {
        return 'link';
    }
    if (!entry.isFile()) {
        return 'special';
    }
    const extension = extensionOf(entry.name);
    if (extension) {
        for (const [kind, list] of EXTENSIONS) {
            if (list.includes(extension)) {
                return kind;
            }
        }
    }
    return 'file';
}

/** The Type column: the extension when there is one, the way Explorer names file types. */
export function typeLabel(entry: Entry): string {
    const kind = kindOf(entry);
    if (kind === 'folder' || kind === 'link' || kind === 'special') {
        return KIND_LABEL[kind];
    }
    const extension = extensionOf(entry.name);
    return extension ? `${extension.toUpperCase()} ${KIND_LABEL[kind].toLowerCase()}` : KIND_LABEL[kind];
}

export function formatSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatModified(date: Date): string {
    if (!date.getTime()) {
        return '—';
    }
    // Short, sortable and unambiguous in every locale the phone might be set to.
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
        date.getMinutes(),
    )}`;
}

export function formatMode(mode: number): string {
    const bits = mode & 0o7777;
    const rwx = (value: number) => `${value & 4 ? 'r' : '-'}${value & 2 ? 'w' : '-'}${value & 1 ? 'x' : '-'}`;
    return `${rwx((bits >> 6) & 7)}${rwx((bits >> 3) & 7)}${rwx(bits & 7)} (${bits.toString(8).padStart(4, '0')})`;
}

// 24x24 line icons, drawn with `currentColor` so both themes and the selected row work.
const ICONS: Record<FileKind, string> = {
    folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17z"/>',
    apk: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9.5v5m6-5v5M9 12h6"/>',
    image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4.5 17 4.2-4 3.3 3 2.8-2.6 4.7 4.2"/>',
    video: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m10.5 9.5 4.5 2.5-4.5 2.5z"/>',
    audio: '<path d="M9 16.5V7.5l8-2v9"/><circle cx="7" cy="16.5" r="2"/><circle cx="15" cy="14.5" r="2"/>',
    archive: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M10 4v4m4-4v4m-4 4v4m4-4v4m-4 4h4"/>',
    code: '<path d="m9 9-3 3 3 3m6-6 3 3-3 3m-2-8-2 10"/>',
    text: '<path d="M6 3.5h7l5 5v12H6z"/><path d="M13 3.5v5h5M9 13h6M9 16.5h4"/>',
    document: '<path d="M6 3.5h7l5 5v12H6z"/><path d="M13 3.5v5h5"/>',
    link: '<path d="M10 14a3.5 3.5 0 0 1 0-5l2-2a3.5 3.5 0 0 1 5 5l-1 1"/><path d="M14 10a3.5 3.5 0 0 1 0 5l-2 2a3.5 3.5 0 0 1-5-5l1-1"/>',
    special: '<circle cx="12" cy="12" r="7.5"/><path d="M12 8.5v4l3 2"/>',
    file: '<path d="M6 3.5h7l5 5v12H6z"/><path d="M13 3.5v5h5"/>',
};

export function iconMarkup(kind: FileKind): string {
    return `<svg class="fx-icon fx-icon-${kind}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[kind]}</svg>`;
}
