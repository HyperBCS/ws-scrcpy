import { useEffect, useRef, useState } from 'preact/hooks';
import { ControlCenterCommand } from '../../common/ControlCenterCommand';
import { DEFAULT_SCRCPY_SERVER_CONFIG, ScrcpyServerConfig } from '../../common/Constants';
import { EncoderInfo } from '../../types/EncoderInfo';

/**
 * The stream settings of one Android phone, as Stream settings shows them: what the phone
 * reports, what the user has changed since, and the two requests over the tracker socket
 * (`list_encoders` to load, `update_stream_config` to apply). The sheet draws this state and
 * has no protocol of its own.
 */

export const APPLY_TIMEOUT_MS = 20000;
export const LOAD_TIMEOUT_MS = 15000;

export const WAITING_FOR_PHONE = 'Waiting for the phone…';
export const LOAD_TIMED_OUT = 'Stream settings took too long to load. Check the connection and try again.';
export const APPLY_TIMED_OUT =
    'The phone has not confirmed the change. Reopen Stream settings to check its current values, or try again.';
export const SETTINGS_SAVED = 'Settings saved.';

export type StreamConfigPatch = Partial<ScrcpyServerConfig>;

export interface StreamConfigState {
    /** What the phone runs with. The defaults until it has answered. */
    baseline: ScrcpyServerConfig;
    /** False until the phone has reported its settings. Until then every changed value is kept. */
    configKnown: boolean;
    /** The values the user changed and has not applied. */
    patch: StreamConfigPatch;
    encoders: EncoderInfo[];
    loading: boolean;
    loadError?: string;
    applying: boolean;
    applyError?: string;
    appliedNote?: string;
}

interface ListEncodersReply {
    udid: string;
    requestId: number;
    encoders?: EncoderInfo[];
    config?: ScrcpyServerConfig;
    error?: string;
}
interface UpdateStreamConfigReply {
    udid: string;
    requestId: number;
    config?: ScrcpyServerConfig;
    error?: string;
}

/** What the session needs from a device tracker; `BaseDeviceTracker` and a test's fake both fit. */
export interface StreamConfigTracker {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(type: string, listener: (reply: any) => void): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    off(type: string, listener: (reply: any) => void): void;
    sendCommand(type: string, data?: Record<string, unknown>): number;
}

export function initialStreamConfigState(): StreamConfigState {
    return {
        baseline: DEFAULT_SCRCPY_SERVER_CONFIG,
        configKnown: false,
        patch: {},
        encoders: [],
        loading: true,
        applying: false,
    };
}

/** A setting as the sheet compares and shows it: a missing codec is H.264 and a missing encoder is automatic. */
export function normalized<K extends keyof ScrcpyServerConfig>(
    config: StreamConfigPatch,
    key: K,
): ScrcpyServerConfig[K] {
    return (config[key] ??
        (key === 'videoCodec'
            ? 'h264'
            : key === 'videoEncoder'
              ? ''
              : DEFAULT_SCRCPY_SERVER_CONFIG[key])) as ScrcpyServerConfig[K];
}

/**
 * The patch after `fields` are set. A value that is back at what the phone runs with leaves the
 * patch, so "nothing to apply" is an empty patch. While the phone's settings are unknown there
 * is nothing to compare with and every value stays.
 */
export function patchWith(
    patch: StreamConfigPatch,
    fields: StreamConfigPatch,
    baseline: ScrcpyServerConfig,
    configKnown: boolean,
): StreamConfigPatch {
    const next = { ...patch, ...fields };
    if (configKnown) {
        (Object.keys(next) as (keyof ScrcpyServerConfig)[]).forEach((key) => {
            if (normalized(next, key) === normalized(baseline, key)) {
                delete next[key];
            }
        });
    }
    return next;
}

/**
 * One opening of Stream settings for one phone. `load` asks for the encoders and the current
 * settings; `apply` sends a patch. Each waits for the reply with its own request id and gives up
 * after its time limit. `dispose` ends both: a reply that arrives later changes nothing.
 */
export class StreamConfigSession {
    public state = initialStreamConfigState();
    private loadRequestId?: number;
    private loadTimer?: ReturnType<typeof setTimeout>;
    private pendingPatch?: StreamConfigPatch;
    private pendingRequestId?: number;
    private applyTimer?: ReturnType<typeof setTimeout>;
    private disposed = false;

    constructor(
        private readonly tracker: StreamConfigTracker | undefined,
        private readonly udid: string,
        private readonly onChange: (state: StreamConfigState) => void = () => undefined,
    ) {}

    private update(change: Partial<StreamConfigState>): void {
        if (this.disposed) {
            return;
        }
        this.state = { ...this.state, ...change };
        this.onChange(this.state);
    }

    public load(): void {
        const { tracker, udid } = this;
        if (!tracker) {
            this.update({ loading: false, loadError: WAITING_FOR_PHONE });
            return;
        }
        this.loadTimer = setTimeout(() => {
            this.loadRequestId = undefined;
            this.update({ loading: false, loadError: LOAD_TIMED_OUT });
        }, LOAD_TIMEOUT_MS);
        tracker.on('list_encoders', this.onEncoders);
        tracker.on('update_stream_config', this.onUpdated);
        this.loadRequestId = tracker.sendCommand(ControlCenterCommand.LIST_ENCODERS, { udid });
    }

    private onEncoders = (data: ListEncodersReply): void => {
        if (!data || data.udid !== this.udid || data.requestId !== this.loadRequestId) {
            return;
        }
        clearTimeout(this.loadTimer);
        this.loadRequestId = undefined;
        if (data.error) {
            this.update({ loading: false, loadError: `Could not load stream settings: ${data.error}` });
            return;
        }
        this.update({
            loading: false,
            loadError: undefined,
            encoders: Array.isArray(data.encoders) ? data.encoders : [],
            ...(data.config ? { baseline: data.config, configKnown: true } : {}),
        });
    };

    private onUpdated = (data: UpdateStreamConfigReply): void => {
        // A delayed or unsolicited reply must not clear a new edit or claim we applied it.
        if (!data || data.udid !== this.udid || !this.pendingPatch || data.requestId !== this.pendingRequestId) {
            return;
        }
        clearTimeout(this.applyTimer);
        this.applyTimer = undefined;
        const submitted = this.pendingPatch;
        this.pendingPatch = undefined;
        this.pendingRequestId = undefined;
        if (data.error) {
            this.update({ applying: false, applyError: `Could not apply changes: ${data.error}` });
            return;
        }
        this.update({
            applying: false,
            baseline: data.config ?? { ...this.state.baseline, ...submitted },
            configKnown: true,
            applyError: undefined,
            patch: {},
            appliedNote: SETTINGS_SAVED,
        });
    };

    /** Changes values in the patch. The outcome of the last apply no longer describes what is shown. */
    public setFields(fields: StreamConfigPatch): void {
        const { patch, baseline, configKnown } = this.state;
        this.update({
            patch: patchWith(patch, fields, baseline, configKnown),
            appliedNote: undefined,
            applyError: undefined,
        });
    }

    public discard(): void {
        this.update({ patch: {}, applyError: undefined });
    }

    /** Sends `config` to the phone. Returns false when there is nothing to send or a request is out. */
    public apply(config: StreamConfigPatch = this.state.patch): boolean {
        const { tracker, udid } = this;
        if (!tracker || !Object.keys(config).length || this.pendingPatch || this.disposed) {
            return false;
        }
        this.update({ applying: true, applyError: undefined, appliedNote: undefined });
        this.pendingPatch = { ...config };
        // Set the timeout before sending: a synchronous reply must be able to clear it.
        this.applyTimer = setTimeout(() => {
            this.applyTimer = undefined;
            this.pendingPatch = undefined;
            this.pendingRequestId = undefined;
            this.update({ applying: false, applyError: APPLY_TIMED_OUT });
        }, APPLY_TIMEOUT_MS);
        this.pendingRequestId = tracker.sendCommand(ControlCenterCommand.UPDATE_STREAM_CONFIG, { udid, config });
        return true;
    }

    public dispose(): void {
        this.disposed = true;
        clearTimeout(this.loadTimer);
        clearTimeout(this.applyTimer);
        this.applyTimer = undefined;
        this.pendingPatch = undefined;
        this.pendingRequestId = undefined;
        this.tracker?.off('list_encoders', this.onEncoders);
        this.tracker?.off('update_stream_config', this.onUpdated);
    }
}

export interface StreamConfig extends StreamConfigState {
    setFields(fields: StreamConfigPatch): void;
    discard(): void;
    apply(config?: StreamConfigPatch): boolean;
    /** Asks the phone again, after a load that failed. */
    reload(): void;
}

/**
 * The stream settings for the sheet. `opening` is what one opening of the sheet is (its target);
 * a new one, another tracker or `reload` starts again from nothing with a fresh request. While
 * `opening` is undefined the sheet is closed and the last state stays, for its closing animation.
 */
export function useStreamConfig(
    opening: object | undefined,
    tracker: StreamConfigTracker | undefined,
    udid: string | undefined,
): StreamConfig {
    const [state, setState] = useState(initialStreamConfigState);
    const [attempt, setAttempt] = useState(0);
    const session = useRef<StreamConfigSession>();

    useEffect(() => {
        if (!opening || udid === undefined) {
            return;
        }
        const current = new StreamConfigSession(tracker, udid, setState);
        session.current = current;
        setState(current.state);
        current.load();
        return () => {
            current.dispose();
            if (session.current === current) {
                session.current = undefined;
            }
        };
    }, [opening, tracker, attempt]);

    return {
        ...state,
        setFields: (fields) => session.current?.setFields(fields),
        discard: () => session.current?.discard(),
        apply: (config) => session.current?.apply(config) ?? false,
        reload: () => setAttempt((value) => value + 1),
    };
}
