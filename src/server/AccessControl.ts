import crypto from 'crypto';
import { IncomingMessage } from 'http';
import { TLSSocket } from 'tls';
import { BlockList, isIP } from 'net';
import express, { Express, RequestHandler } from 'express';

const COOKIE = 'ws_scrcpy_session';
const SESSION_SECONDS = 90 * 24 * 60 * 60;

function equalSecret(actual: string, expected: string): boolean {
    const left = Buffer.from(actual),
        right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** One policy for HTTP and WebSockets, with remembered access over either LAN or HTTPS. */
export class AccessControl {
    private attempts = new Map<string, { failures: number; reset: number }>();
    private trustedNetworks = new BlockList();
    constructor(
        private readonly key: string,
        private readonly publicUrl = process.env.WS_PUBLIC_URL || '',
        networks = process.env.WS_TRUSTED_NETWORKS || '',
    ) {
        for (const network of networks
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)) {
            const [address, prefix, extra] = network.split('/');
            const family = isIP(address);
            if (!family || extra !== undefined || !/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)) {
                throw new Error(`Invalid trusted network: ${network}. Use an IP subnet such as 10.10.10.0/24.`);
            }
            this.trustedNetworks.addSubnet(address, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
        }
    }

    private isTrustedNetwork(request: IncomingMessage): boolean {
        // Trust the actual connection, never client-supplied forwarding headers.
        const address = request.socket.remoteAddress || '';
        const family = isIP(address);
        return !!family && this.trustedNetworks.check(address, family === 4 ? 'ipv4' : 'ipv6');
    }

    private publicOrigin(): string {
        return this.publicUrl ? new URL(this.publicUrl).origin : '';
    }

    allowsOrigin(request: IncomingMessage): boolean {
        const origin = request.headers.origin;
        if (!origin) return true; // Native clients do not send a browser origin.
        const protocol = (request.socket as TLSSocket).encrypted ? 'https' : 'http';
        return origin === this.publicOrigin() || origin === `${protocol}://${request.headers.host}`;
    }

    private isLocalProxy(request: IncomingMessage): boolean {
        return (
            !!this.publicOrigin() &&
            ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '') &&
            typeof request.headers['tailscale-user-login'] === 'string' &&
            !!request.headers['tailscale-user-login']
        );
    }

    private signature(value: string): string {
        return crypto.createHmac('sha256', this.key).update(`ws-scrcpy-session:${value}`).digest('base64url');
    }

    authorized(request: IncomingMessage): boolean {
        if (!this.allowsOrigin(request)) return false;
        if (this.isTrustedNetwork(request) || this.isLocalProxy(request)) return true;
        const authorization = request.headers.authorization;
        if (authorization?.startsWith('Bearer ') && equalSecret(authorization.slice(7), this.key)) return true;
        const cookie = request.headers.cookie
            ?.split(';')
            .map((item) => item.trim())
            .find((item) => item.startsWith(`${COOKIE}=`));
        if (!cookie) return false;
        const [expires, nonce, signature, extra] = cookie.slice(COOKIE.length + 1).split('.');
        if (extra || !/^\d+$/.test(expires) || !nonce || !signature || Number(expires) <= Date.now() / 1000)
            return false;
        return equalSecret(signature, this.signature(`${expires}.${nonce}`));
    }

    readonly requireAccess: RequestHandler = (request, response, next) => {
        response.setHeader('Cache-Control', 'no-store');
        if (!this.allowsOrigin(request)) response.sendStatus(403);
        else if (!this.authorized(request)) response.sendStatus(401);
        else next();
    };

    mount(app: Express, base: string): void {
        const pathname = `${base.replace(/\/$/, '')}/api/access`;
        app.get(pathname, (request, response) => {
            response.setHeader('Cache-Control', 'no-store');
            response.json({ authenticated: this.authorized(request) });
        });
        app.post(
            pathname,
            (request, response, next) => {
                response.setHeader('Cache-Control', 'no-store');
                if (!this.allowsOrigin(request)) {
                    response.sendStatus(403);
                    return;
                }
                const now = Date.now();
                for (const [ip, record] of this.attempts) if (record.reset <= now) this.attempts.delete(ip);
                const ip = request.socket.remoteAddress || '';
                const record = this.attempts.get(ip) || { failures: 0, reset: now + 60000 };
                if (record.failures >= 12) {
                    response.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
                    return;
                }
                // Count before parsing so malformed/oversized requests cannot evade the bound.
                record.failures++;
                if (this.attempts.size >= 1000) this.attempts.delete(this.attempts.keys().next().value!);
                this.attempts.set(ip, record);
                next();
            },
            express.json({ limit: '1kb', inflate: false }),
            (request, response) => {
                const key = request.body?.key;
                if (typeof key !== 'string' || !equalSecret(key.trim(), this.key)) {
                    response.status(401).json({ error: 'That setup key did not match.' });
                    return;
                }
                this.attempts.delete(request.socket.remoteAddress || '');
                const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
                const value = `${expires}.${crypto.randomBytes(16).toString('base64url')}`;
                response.cookie(COOKIE, `${value}.${this.signature(value)}`, {
                    httpOnly: true,
                    sameSite: 'strict',
                    secure:
                        !!(request.socket as TLSSocket).encrypted ||
                        (this.isLocalProxy(request) && this.publicOrigin().startsWith('https:')),
                    path: base || '/',
                    maxAge: SESSION_SECONDS * 1000,
                });
                response.json({ authenticated: true });
            },
        );
    }
}
