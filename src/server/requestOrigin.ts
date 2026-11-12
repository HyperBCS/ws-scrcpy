import { getSettings } from './Settings';
import { IncomingMessage, ServerResponse } from 'http';
import * as net from 'net';
import * as os from 'os';
import { TLSSocket } from 'tls';
import { RequestHandler } from 'express';
import { Config } from './Config';

/** Extra host names this server answers to, comma separated. Adds to `allowedHosts` in the config file. */
export const ALLOWED_HOSTS_ENV = 'WS_ALLOWED_HOSTS';

const HOST_NOT_ALLOWED =
    'Host not allowed. Add this name to allowedHosts in the configuration file or to WS_ALLOWED_HOSTS.';

/** A Host header value split into its lower-case name and `name:port`. Undefined when malformed. */
function parseHost(header: string | undefined): { name: string; host: string } | undefined {
    if (!header) {
        return undefined;
    }
    try {
        const url = new URL(`http://${header}`);
        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            return undefined;
        }
        return { name: url.hostname, host: url.host };
    } catch {
        return undefined;
    }
}

function publicUrl(): URL | undefined {
    try {
        const value = getSettings().publicUrl;
        return value ? new URL(value) : undefined;
    } catch {
        return undefined;
    }
}

/** The names this server is known by, besides IP addresses and localhost. */
function knownHostNames(): Set<string> {
    const names = new Set<string>();
    const add = (name: string | undefined) => {
        const trimmed = name?.trim().toLowerCase();
        if (trimmed) {
            names.add(trimmed);
        }
    };
    const machine = os.hostname();
    const label = machine.split('.')[0];
    add(machine);
    add(label);
    // The name the machine answers to over mDNS.
    add(`${label}.local`);
    const publicName = publicUrl()?.hostname;
    add(publicName);
    if (publicName && net.isIP(publicName.replace(/^\[|\]$/g, '')) === 0) {
        // The short name, as Tailscale MagicDNS resolves it: http://box:8000 for
        // box.example.ts.net. A single label is resolved on the local network only.
        add(publicName.split('.')[0]);
    }
    getSettings().allowedHosts.forEach(add);
    const config = Config.getInstance();
    config.allowedHosts.forEach(add);
    config.servers.forEach((server) => {
        // The HTTP listener sends browsers to this name, so the HTTPS listener has to accept it.
        if (typeof server.redirectToSecure === 'object') {
            add(server.redirectToSecure.host);
        }
    });
    return names;
}

/**
 * Whether the Host header names this server.
 *
 * A browser sends the name the user's page was loaded from. After DNS rebinding that name belongs
 * to another site while the address is ours, and the Origin header matches it, so the Origin check
 * alone passes. An IP address cannot be rebound, so every address is accepted.
 */
export function allowsHost(request: IncomingMessage): boolean {
    const parsed = parseHost(request.headers.host);
    if (!parsed) {
        return false;
    }
    const name = parsed.name;
    if (name === 'localhost' || net.isIP(name.replace(/^\[|\]$/g, '')) !== 0) {
        return true;
    }
    return knownHostNames().has(name);
}

/** Reject browser requests from unrelated sites. */
export function allowsOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    const protocol = (request.socket as TLSSocket).encrypted ? 'https' : 'http';
    return origin === `${protocol}://${request.headers.host}` || origin === publicUrl()?.origin;
}

/** The check for every HTTP request and WebSocket upgrade: a known Host and a matching Origin. */
export function allowsRequest(request: IncomingMessage): boolean {
    return allowsHost(request) && allowsOrigin(request);
}

const reportedHosts = new Set<string>();

/** Logs a refused Host once, so the owner can see which name to add. */
export function reportRefusedHost(request: IncomingMessage): void {
    const host = String(request.headers.host || '').slice(0, 255);
    if (reportedHosts.has(host) || reportedHosts.size >= 50) {
        return;
    }
    reportedHosts.add(host);
    console.warn(`Refused a request for host ${JSON.stringify(host)}. ${HOST_NOT_ALLOWED}`);
}

/** Answers 403 to a request whose Host header is not one of this server's names. Runs before routing. */
export const knownHost: RequestHandler = (request, response, next) => {
    if (allowsHost(request)) {
        next();
        return;
    }
    reportRefusedHost(request);
    response.status(403).type('text/plain').send(HOST_NOT_ALLOWED);
};

/** `ws://` and `wss://` sources for one `name:port`. CSP has no syntax for IPv6 literals. */
function socketSources(host: string | undefined): string[] {
    return host && !host.startsWith('[') ? [`ws://${host}`, `wss://${host}`] : [];
}

/**
 * The Content-Security-Policy value for a request.
 *
 * `frame-ancestors` keeps other sites from framing the app. `connect-src` limits fetch and
 * WebSocket targets to this server and the configured remote hosts, so a crafted link cannot send
 * a socket, and what the page writes to it, anywhere else. The explicit ws and wss entries are for
 * browsers where 'self' does not cover WebSockets.
 */
export function contentSecurityPolicy(request: IncomingMessage): string {
    const sources = new Set<string>(["'self'"]);
    socketSources(parseHost(request.headers.host)?.host).forEach((source) => sources.add(source));
    socketSources(publicUrl()?.host).forEach((source) => sources.add(source));
    Config.getInstance()
        .getHostList()
        .filter((item) => !item.useProxy)
        .forEach((item) => {
            // A remote host that is not proxied is reached straight from the browser.
            const parsed = parseHost(`${item.hostname}:${item.port}`);
            if (parsed && !parsed.host.startsWith('[')) {
                sources.add(`${item.secure ? 'wss' : 'ws'}://${parsed.host}`);
            }
        });
    return `frame-ancestors 'none'; connect-src ${Array.from(sources).join(' ')}`;
}

function setSecurityHeaders(request: IncomingMessage, response: ServerResponse): void {
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', contentSecurityPolicy(request));
}

/** Sets the frame and connection limits on every response: pages, downloads and the API. */
export const securityHeaders: RequestHandler = (request, response, next) => {
    setSecurityHeaders(request, response);
    next();
};

export const sameOrigin: RequestHandler = (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (allowsOrigin(request)) next();
    else response.sendStatus(403);
};
