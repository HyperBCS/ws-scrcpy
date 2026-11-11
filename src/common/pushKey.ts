/** The server's VAPID public key (base64url, as /status sends it) as the bytes `subscribe` takes. */
export function serverKeyBytes(publicKey: string): Uint8Array<ArrayBuffer> {
    const base64 = publicKey.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/**
 * Whether a push subscription was created for this server key. A subscription made for other
 * keys (the server's data was reset, for example) is refused by the push service on every send.
 * A browser that does not report the key gives no reason to replace the subscription.
 */
export function madeForServerKey(subscribedKey: ArrayBuffer | null | undefined, publicKey: string): boolean {
    if (!subscribedKey || !publicKey) return true;
    const held = new Uint8Array(subscribedKey);
    let wanted: Uint8Array;
    try {
        wanted = serverKeyBytes(publicKey);
    } catch {
        return true;
    }
    return held.length === wanted.length && held.every((byte, index) => byte === wanted[index]);
}
