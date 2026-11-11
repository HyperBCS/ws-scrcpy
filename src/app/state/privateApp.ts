/**
 * The link to the notifications page on the server's secure address (`WS_PUBLIC_URL`).
 * Empty when the server has none configured: there is no address to guess.
 */
export function privateAppUrl(publicUrl: string | undefined): string {
    if (!publicUrl) {
        return '';
    }
    try {
        const url = new URL(publicUrl);
        url.hash = '!action=notifications';
        return url.href;
    } catch {
        return '';
    }
}
