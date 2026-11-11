/** What to do with an incoming item whose name is already taken in the destination folder. */
export type ConflictChoice = 'replace' | 'keep' | 'skip';

export type ConflictAnswer = { choice: ConflictChoice; all: boolean };

/** `name` is the spelling in the folder, which can differ from the incoming one by case. */
export type ExistingItem = { isFolder: boolean; name?: string };

/** Turns a name into what the folder compares: equal keys are one name on the device. */
export type NameKey = (name: string) => string;

const exactName: NameKey = (name) => name;
const foldedName: NameKey = (name) => name.normalize('NFD').toLowerCase();

/**
 * Android's shared storage (`/sdcard` and what it points to, and removable cards) ignores case
 * in names: `Notes.txt` and `notes.txt` are the same file there. App and system folders such as
 * `/data/local/tmp` keep them apart. The device has the last word either way; this only decides
 * whether the owner is asked before the upload or told afterwards.
 */
export function nameKey(folder: string): NameKey {
    return /^\/(sdcard|storage|mnt\/(sdcard|media_rw|user|runtime|pass_through)|data\/media)(\/|$)/.test(folder)
        ? foldedName
        : exactName;
}

export type Resolution = {
    /** The name the item arrived with. */
    name: string;
    /** The name it gets in the destination folder. */
    target: string;
    /** True only when the owner chose to replace the existing file. */
    replace: boolean;
};

/**
 * The first unused "name (n).ext". The number goes before the extension so the copy keeps its
 * type; a folder has no extension to keep.
 */
export function freeName(name: string, taken: ReadonlySet<string>, isFolder = false, key: NameKey = exactName): string {
    const match = isFolder ? null : /^(.+?)((?:\.tar)?\.[^.]+)$/.exec(name);
    const base = match ? match[1] : name;
    const extension = match ? match[2] : '';
    for (let index = 1; ; index++) {
        const candidate = `${base} (${index})${extension}`;
        if (!taken.has(key(candidate))) {
            return candidate;
        }
    }
}

/**
 * Upload and Paste share this rule: a name that is free goes through unchanged, and a name that
 * is taken is put to `ask`. Nothing is replaced without an explicit "replace" answer, and a
 * folder is never replaced. `names` must not repeat.
 *
 * `key` says how the destination compares names (see `nameKey`). `existing` is keyed by it, and
 * `names` must not repeat under it either.
 *
 * `ask` receives how many further conflicts follow, so the dialog can offer to apply one answer
 * to all of them. It resolves to undefined when the answer no longer applies (the explorer was
 * closed or moved to another folder); nothing is returned then.
 *
 * `isFolder` says which incoming names are folders: a folder does not replace a file, and its
 * new name keeps no extension. Uploads are always files.
 */
export async function resolveNameConflicts(
    names: string[],
    existing: ReadonlyMap<string, ExistingItem>,
    replaceable: boolean,
    ask: (
        name: string,
        item: ExistingItem,
        canReplace: boolean,
        remaining: number,
    ) => Promise<ConflictAnswer | undefined>,
    isFolder: (name: string) => boolean = () => false,
    key: NameKey = exactName,
): Promise<Resolution[]> {
    const taken = new Set<string>([...existing.keys(), ...names.map(key)]);
    let remaining = names.filter((name) => existing.has(key(name))).length;
    let forAll: ConflictChoice | undefined;
    const resolved: Resolution[] = [];
    for (const name of names) {
        const item = existing.get(key(name));
        if (!item) {
            resolved.push({ name, target: name, replace: false });
            continue;
        }
        remaining--;
        const incomingFolder = isFolder(name);
        const canReplace = replaceable && !item.isFolder && !incomingFolder;
        let choice = forAll;
        if (!choice || (choice === 'replace' && !canReplace)) {
            const answer = await ask(name, item, canReplace, remaining);
            if (!answer) {
                return [];
            }
            choice = answer.choice;
            if (answer.all) {
                forAll = choice;
            }
        }
        if (choice === 'replace' && canReplace) {
            resolved.push({ name, target: name, replace: true });
        } else if (choice === 'keep') {
            const target = freeName(name, taken, incomingFolder, key);
            taken.add(key(target));
            resolved.push({ name, target, replace: false });
        }
    }
    return resolved;
}
