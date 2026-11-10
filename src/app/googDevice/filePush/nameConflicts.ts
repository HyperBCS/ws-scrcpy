/** What to do with an incoming item whose name is already taken in the destination folder. */
export type ConflictChoice = 'replace' | 'keep' | 'skip';

export type ConflictAnswer = { choice: ConflictChoice; all: boolean };

export type ExistingItem = { isFolder: boolean };

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
export function freeName(name: string, taken: ReadonlySet<string>, isFolder = false): string {
    const match = isFolder ? null : /^(.+?)((?:\.tar)?\.[^.]+)$/.exec(name);
    const base = match ? match[1] : name;
    const extension = match ? match[2] : '';
    for (let index = 1; ; index++) {
        const candidate = `${base} (${index})${extension}`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }
}

/**
 * Upload and Paste share this rule: a name that is free goes through unchanged, and a name that
 * is taken is put to `ask`. Nothing is replaced without an explicit "replace" answer, and a
 * folder is never replaced. `names` must not repeat.
 *
 * `ask` receives how many further conflicts follow, so the dialog can offer to apply one answer
 * to all of them. It resolves to undefined when the answer no longer applies (the explorer was
 * closed or moved to another folder); nothing is returned then.
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
): Promise<Resolution[]> {
    const taken = new Set<string>([...existing.keys(), ...names]);
    let remaining = names.filter((name) => existing.has(name)).length;
    let forAll: ConflictChoice | undefined;
    const resolved: Resolution[] = [];
    for (const name of names) {
        const item = existing.get(name);
        if (!item) {
            resolved.push({ name, target: name, replace: false });
            continue;
        }
        remaining--;
        const canReplace = replaceable && !item.isFolder;
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
            const target = freeName(name, taken, item.isFolder);
            taken.add(target);
            resolved.push({ name, target, replace: false });
        }
    }
    return resolved;
}
