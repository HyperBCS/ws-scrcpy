import fs from 'fs';
import path from 'path';
import net from 'net';
import tls from 'tls';
import YAML from 'yaml';
import type { Configuration } from '../types/Configuration';

/** The key is consumed by IosSettingsStore, never kept in the general settings snapshot. */
export const IOS_KEY_ENV = 'WS_IOS_SETTINGS_KEY';

export interface ServerSettings {
    readonly configPath?: string;
    readonly pathname?: string;
    readonly dataDir: string;
    readonly streamConfigPath: string;
    readonly legacyStreamConfigPath?: string;
    readonly publicUrl?: string;
    readonly allowedHosts: readonly string[];
    readonly pushSubject?: string;
    readonly notificationsCollector: boolean;
    readonly bluetoothPython: string;
    readonly adbHost: string;
    readonly adbPort: number;
    readonly iosPython?: string;
    readonly iosPatchCheck: boolean;
    readonly iosProbeCommand?: string;
    readonly iosProbeArgs: readonly string[];
    readonly iosTunnel: 'userspace' | 'tunneld';
    readonly debug: boolean;
    readonly iosAudio: boolean;
    readonly iosAudioDecoder?: string;
    readonly iosUsbmuxListen: boolean;
    readonly iosUsbmuxSocket: string;
    readonly iosStateProbe: boolean;
    readonly iosLockProbe: boolean;
    readonly iosStateNotifications: boolean;
    readonly iosLockedCaptions: readonly string[];
    readonly iosUnlockFast: boolean;
    readonly iosServeWebBasePort: number;
    readonly iosDisplayWedgedTimeoutMs: number;
    readonly iosSignalReadyTimeoutMs: number;
    readonly iosSessionCooldownMs: number;
    readonly iosSessionStartLimit: number;
    readonly iosSessionStartWindowMs: number;
    readonly iosClipboardTimeoutMs?: number;
    readonly iosSettingsKeyFile?: string;
}

function invalid(field: string, expected: string): never {
    // Values may contain credentials. An error names the field, never its value.
    throw new Error(`${field} must be ${expected}`);
}

function text(env: NodeJS.ProcessEnv, key: string): string | undefined {
    const value = env[key];
    if (value === undefined || value === '') return undefined;
    if (value.includes('\0')) invalid(key, 'text without a null character');
    return value;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
    const value = text(env, key);
    if (value === undefined) return fallback;
    if (value === '1' || value === 'true') return true;
    if (value === '0' || value === 'false') return false;
    return invalid(key, '0, 1, false or true');
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum = 1, maximum = 2147483647): number {
    const value = text(env, key);
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) invalid(key, `an integer from ${minimum} to ${maximum}`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
        invalid(key, `an integer from ${minimum} to ${maximum}`);
    return parsed;
}

function host(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) invalid(field, 'a host name or IP address');
    const original = value.trim();
    const name = original.toLowerCase();
    const bracketed = name.startsWith('[') && name.endsWith(']');
    const bare = bracketed ? name.slice(1, -1) : name;
    // An IPv6 scope names an interface, whose case must be kept for socket hosts.
    if (net.isIP(bare) && (!bracketed || net.isIP(bare) === 6)) return name.includes('%') ? original : name;
    const domain = name.endsWith('.') ? name.slice(0, -1) : name;
    if (domain.length > 253 || !domain.split('.').every((part) => /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(part)))
        invalid(field, 'a host name or IP address');
    return name;
}

function authorityHost(value: unknown, field: string): void {
    const name = host(value, field);
    if (net.isIP(name) === 6) invalid(field, 'an IPv6 address in brackets');
    if (/\s/.test(value as string)) invalid(field, 'a host without whitespace');
    try {
        new URL(`http://${name}:1`);
    } catch {
        invalid(field, 'a valid URL host');
    }
}

function url(value: string | undefined, field: string, protocols: string[]): string | undefined {
    if (value === undefined) return undefined;
    try {
        const parsed = new URL(value);
        if (
            !protocols.includes(parsed.protocol) ||
            parsed.username ||
            parsed.password ||
            parsed.hash ||
            (parsed.protocol === 'mailto:' ? !parsed.pathname.includes('@') : !parsed.hostname)
        )
            invalid(field, `a ${protocols.join(' or ')} URL without credentials or a fragment`);
    } catch {
        invalid(field, `a ${protocols.join(' or ')} URL without credentials or a fragment`);
    }
    return value;
}

function pathname(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.startsWith('/') || /[?#\0]/.test(value) || value.startsWith('//'))
        invalid(field, 'an absolute URL path without a query or fragment');
    return value;
}

/**
 * The built server lives in dist, even when npm start changes its working directory to dist.
 * Source fixtures may name their own working directory. Neither path depends on build files
 * being present at runtime: the production image contains only the built server and its tools.
 */
function defaultDataDir(cwd: string, serverDirectory: string): string {
    const root = path.basename(serverDirectory) === 'dist' ? path.dirname(serverDirectory) : cwd;
    const directory = path.join(root, 'data');
    const legacy =
        path.basename(serverDirectory) === 'dist' ? path.join(serverDirectory, 'data') : path.join(cwd, 'data');
    if (legacy !== directory && fs.existsSync(legacy)) {
        let occupied = true;
        try {
            occupied = fs.readdirSync(legacy).length > 0;
        } catch {
            // A path that cannot be listed must not be treated as an empty private store.
        }
        if (occupied) {
            throw new Error(
                'Existing data was found in dist/data. Set WS_DATA_DIR to that directory or move it before starting.',
            );
        }
    }
    return directory;
}

/** Parse once at startup. Tests may pass a separate environment without changing the host's. */
export function readSettings(
    env: NodeJS.ProcessEnv = process.env,
    cwd = process.cwd(),
    serverDirectory = __dirname,
): ServerSettings {
    const configuredData = text(env, 'WS_DATA_DIR') || text(env, 'WS_NOTIFICATION_DATA');
    const dataDir = configuredData ? path.resolve(cwd, configuredData) : defaultDataDir(cwd, serverDirectory);
    const streamPath = text(env, 'WS_SCRCPY_STREAM_CONFIG_PATH');
    const probeArgs = text(env, 'IOS_PROBE_ARGS');
    let parsedArgs: unknown = [];
    if (probeArgs !== undefined) {
        try {
            parsedArgs = JSON.parse(probeArgs);
        } catch {
            invalid('IOS_PROBE_ARGS', 'a JSON array of strings');
        }
        if (!Array.isArray(parsedArgs) || !parsedArgs.every((item) => typeof item === 'string' && !item.includes('\0')))
            invalid('IOS_PROBE_ARGS', 'a JSON array of strings without null characters');
    }
    const tunnel = text(env, 'IOS_TUNNEL') || 'userspace';
    if (tunnel !== 'userspace' && tunnel !== 'tunneld') invalid('IOS_TUNNEL', 'userspace or tunneld');
    const publicUrl = url(text(env, 'WS_PUBLIC_URL'), 'WS_PUBLIC_URL', ['http:', 'https:']);
    const pushSubject = url(text(env, 'WS_PUSH_SUBJECT'), 'WS_PUSH_SUBJECT', ['https:', 'mailto:']);
    const list = (key: string) =>
        (text(env, key) || '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
    const root = text(env, 'WS_SCRCPY_PATHNAME');
    const keyFile = text(env, 'WS_IOS_SETTINGS_KEY_FILE');
    const clipboard = text(env, 'IOS_CLIPBOARD_TIMEOUT_MS');
    return Object.freeze({
        configPath: text(env, 'WS_SCRCPY_CONFIG'),
        pathname: root === undefined ? undefined : pathname(root, 'WS_SCRCPY_PATHNAME'),
        dataDir,
        streamConfigPath: streamPath ? path.resolve(cwd, streamPath) : path.join(dataDir, 'stream-config.json'),
        legacyStreamConfigPath: streamPath ? undefined : path.resolve(cwd, 'stream-config.json'),
        publicUrl,
        allowedHosts: Object.freeze(list('WS_ALLOWED_HOSTS').map((value) => host(value, 'WS_ALLOWED_HOSTS'))),
        pushSubject: pushSubject || publicUrl,
        notificationsCollector: bool(env, 'WS_NOTIFICATIONS_COLLECTOR', true),
        bluetoothPython: text(env, 'WS_BLUETOOTH_PYTHON') || '/usr/bin/python3',
        adbHost: host(text(env, 'ADB_HOST') || '127.0.0.1', 'ADB_HOST').replace(/^\[|\]$/g, ''),
        adbPort: integer(env, 'ADB_PORT', 5037, 1, 65535),
        iosPython: text(env, 'IOS_PYMOBILEDEVICE3'),
        iosPatchCheck: bool(env, 'IOS_PATCH_CHECK', true),
        iosProbeCommand: text(env, 'IOS_PROBE_CMD'),
        iosProbeArgs: Object.freeze(parsedArgs as string[]),
        iosTunnel: tunnel,
        debug: bool(env, 'WS_SCRCPY_DEBUG', false),
        iosAudio: bool(env, 'IOS_AUDIO', true),
        iosAudioDecoder: text(env, 'IOS_AUDIO_DECODER'),
        iosUsbmuxListen: bool(env, 'IOS_USBMUX_LISTEN', true),
        iosUsbmuxSocket: text(env, 'IOS_USBMUXD_SOCKET') || '/var/run/usbmuxd',
        iosStateProbe: bool(env, 'IOS_STATE_PROBE', true),
        iosLockProbe: bool(env, 'IOS_LOCK_PROBE', true),
        iosStateNotifications: bool(env, 'IOS_STATE_NOTIFICATIONS', true),
        iosLockedCaptions: Object.freeze(list('IOS_LOCKED_CAPTIONS').map((value) => value.toLowerCase())),
        iosUnlockFast: bool(env, 'IOS_UNLOCK_FAST', false),
        iosServeWebBasePort: integer(env, 'IOS_SERVE_WEB_BASE_PORT', 18100, 1025, 65535),
        iosDisplayWedgedTimeoutMs: integer(env, 'IOS_DISPLAY_WEDGED_TIMEOUT_MS', 25000),
        iosSignalReadyTimeoutMs: integer(env, 'IOS_SIGNAL_READY_TIMEOUT_MS', 35000),
        iosSessionCooldownMs: integer(env, 'IOS_SESSION_COOLDOWN_MS', 30000, 0),
        iosSessionStartLimit: integer(env, 'IOS_SESSION_START_LIMIT', 3, 0),
        iosSessionStartWindowMs: integer(env, 'IOS_SESSION_START_WINDOW_MS', 300000),
        iosClipboardTimeoutMs: clipboard === undefined ? undefined : integer(env, 'IOS_CLIPBOARD_TIMEOUT_MS', 1),
        iosSettingsKeyFile: keyFile === undefined ? undefined : path.resolve(cwd, keyFile),
    });
}

let current: ServerSettings | undefined;

export function getSettings(): ServerSettings {
    return current ?? (current = readSettings());
}

/** Fixture seam: the next read parses the test's new environment. Production never resets it. */
export function resetSettingsForTests(): void {
    current = undefined;
}

/** Consume and remove the key. Only IosSettingsStore keeps its value. */
export function takeIosSettingsKey(): string | undefined {
    const value = process.env[IOS_KEY_ENV];
    delete process.env[IOS_KEY_ENV];
    return value;
}

/** Children inherit the process environment, with the stored-passcode key always removed. */
export function childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env = { ...process.env, ...extra };
    delete env[IOS_KEY_ENV];
    return env;
}

function record(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, 'an object');
    return value as Record<string, unknown>;
}

function port(value: unknown, field: string): void {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535)
        invalid(field, 'an integer from 1 to 65535');
}

function booleanField(value: unknown, field: string): void {
    if (value !== undefined && typeof value !== 'boolean') invalid(field, 'a boolean');
}

function tlsOptions(value: unknown, field: string): void {
    const options = record(value, field);
    for (const name of ['certPath', 'keyPath', 'passphrase', 'ciphers', 'minVersion', 'maxVersion'])
        if (options[name] !== undefined && typeof options[name] !== 'string') invalid(`${field}.${name}`, 'a string');
    for (const name of ['cert', 'ca', 'pfx']) {
        const entry = options[name];
        if (
            entry !== undefined &&
            typeof entry !== 'string' &&
            !Buffer.isBuffer(entry) &&
            !(Array.isArray(entry) && entry.every((item) => typeof item === 'string' || Buffer.isBuffer(item)))
        )
            invalid(`${field}.${name}`, 'a string, buffer or array of them');
    }
    for (const name of ['requestCert', 'rejectUnauthorized', 'honorCipherOrder'])
        booleanField(options[name], `${field}.${name}`);
    if (options.cert !== undefined && options.certPath !== undefined)
        invalid(field, 'configured with cert or certPath, not both');
    if (options.key !== undefined && options.keyPath !== undefined)
        invalid(field, 'configured with key or keyPath, not both');
    for (const name of ['minVersion', 'maxVersion'])
        if (
            options[name] !== undefined &&
            !['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'].includes(options[name] as string)
        )
            invalid(`${field}.${name}`, 'TLSv1, TLSv1.1, TLSv1.2 or TLSv1.3');
    const versions = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
    if (
        options.minVersion &&
        options.maxVersion &&
        versions.indexOf(options.minVersion as string) > versions.indexOf(options.maxVersion as string)
    )
        invalid(field, 'configured with minVersion no higher than maxVersion');
    try {
        // Let Node validate the supported TLS values and credential forms without a listener.
        // Its errors can include certificate contents, so report only the configuration field.
        tls.createSecureContext(options);
    } catch {
        invalid(field, 'valid TLS options and credentials');
    }
}

/** Validate the YAML/JSON shape before Config merges defaults or any service starts. */
export function validateConfiguration(value: unknown): Configuration {
    const config = record(value, 'configuration');
    for (const key of ['runGoogTracker', 'runApplTracker', 'announceGoogTracker', 'announceApplTracker'])
        booleanField(config[key], key);
    if (config.allowedHosts !== undefined) {
        if (!Array.isArray(config.allowedHosts)) invalid('allowedHosts', 'an array of host names');
        config.allowedHosts.forEach((name, index) => host(name, `allowedHosts[${index}]`));
    }
    if (config.server !== undefined) {
        if (!Array.isArray(config.server) || !config.server.length) invalid('server', 'a non-empty array');
        const ports = new Set<number>();
        config.server.forEach((entry, index) => {
            const field = `server[${index}]`;
            const item = record(entry, field);
            booleanField(item.secure, `${field}.secure`);
            if (item.port !== undefined) port(item.port, `${field}.port`);
            const actualPort = (item.port as number | undefined) ?? (item.secure ? 443 : 80);
            if (ports.has(actualPort)) invalid(`${field}.port`, 'different from the other server ports');
            ports.add(actualPort);
            if (item.options !== undefined) tlsOptions(item.options, `${field}.options`);
            if (item.secure && !item.options) invalid(`${field}.options`, 'provided for HTTPS');
            if (item.secure) {
                const options = item.options as Record<string, unknown>;
                if (!options.pfx && !((options.cert || options.certPath) && (options.key || options.keyPath)))
                    invalid(`${field}.options`, 'configured with cert and key, certPath and keyPath, or pfx');
            }
            const redirect = item.redirectToSecure;
            if (redirect !== undefined && typeof redirect !== 'boolean') {
                const target = record(redirect, `${field}.redirectToSecure`);
                if (target.port !== undefined) port(target.port, `${field}.redirectToSecure.port`);
                if (target.host !== undefined) authorityHost(target.host, `${field}.redirectToSecure.host`);
            }
        });
    }
    if (config.remoteHostList !== undefined) {
        if (!Array.isArray(config.remoteHostList)) invalid('remoteHostList', 'an array');
        config.remoteHostList.forEach((entry, index) => {
            const field = `remoteHostList[${index}]`;
            const item = record(entry, field);
            authorityHost(item.hostname, `${field}.hostname`);
            port(item.port, `${field}.port`);
            if (typeof item.secure !== 'boolean') invalid(`${field}.secure`, 'a boolean');
            booleanField(item.useProxy, `${field}.useProxy`);
            if (item.pathname !== undefined) pathname(item.pathname, `${field}.pathname`);
            const types = Array.isArray(item.type) ? item.type : [item.type];
            if (!types.length || types.some((type) => type !== 'android' && type !== 'ios'))
                invalid(`${field}.type`, 'android, ios or an array of them');
        });
    }
    return config as Configuration;
}

export function readConfiguration(file: string | undefined): Configuration {
    if (!file) return {};
    if (!/\.(?:ya?ml|json|js)$/i.test(file)) throw new Error('WS_SCRCPY_CONFIG must name a YAML or JSON file');
    let source: string;
    try {
        source = fs.readFileSync(path.resolve(file), 'utf8');
    } catch {
        throw new Error('WS_SCRCPY_CONFIG could not be read');
    }
    let parsed: unknown;
    try {
        parsed = /\.ya?ml$/i.test(file) ? YAML.parse(source) : JSON.parse(source);
    } catch {
        throw new Error('WS_SCRCPY_CONFIG must contain valid YAML or JSON');
    }
    return validateConfiguration(parsed);
}

/** An explicit allow-list prevents new settings or TLS/key values from reaching the log. */
export function settingsReport(settings: ServerSettings): Record<string, unknown> {
    return {
        dataDir: settings.dataDir,
        streamConfigPath: settings.streamConfigPath,
        publicOrigin: settings.publicUrl ? new URL(settings.publicUrl).origin : undefined,
        adbHost: settings.adbHost,
        adbPort: settings.adbPort,
        iosTunnel: settings.iosTunnel,
        iosSessionStartLimit: settings.iosSessionStartLimit,
        iosSessionStartWindowMs: settings.iosSessionStartWindowMs,
        iosSessionCooldownMs: settings.iosSessionCooldownMs,
        notificationsCollector: settings.notificationsCollector,
    };
}
