import { Entry } from '../Entry';
import { IconName, iconSvg } from '../../ui/icons';

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

// The icon of each kind, from the kit's one set (`ui/icons.ts`).
const KIND_ICON: Record<FileKind, IconName> = {
    folder: 'folder',
    apk: 'package',
    image: 'image',
    video: 'video',
    audio: 'audio',
    archive: 'zip',
    code: 'code',
    text: 'document',
    document: 'file',
    link: 'link',
    special: 'clock',
    file: 'file',
};

/**
 * The kit's icon for a kind of file, as markup. It also carries `fx-icon` and the kind, which
 * the explorer sizes and tints it by.
 */
export function iconMarkup(kind: FileKind): string {
    return iconSvg(KIND_ICON[kind], 20).replace('class="kit-icon"', `class="kit-icon fx-icon fx-icon-${kind}"`);
}
