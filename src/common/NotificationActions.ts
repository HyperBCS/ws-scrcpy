/** ANCS negative actions can also decline calls or delete data. Only these
 * explicit dismissal labels belong in a bulk “dismiss notifications” action. */
export function isDismissActionLabel(label?: string): boolean {
    return typeof label === 'string' && /^(?:clear|dismiss)(?: notification)?$/i.test(label.trim());
}
