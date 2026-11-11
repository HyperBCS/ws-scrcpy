import { DragAndDropHandler, DragEventListener } from '../DragAndDropHandler';
import { FilePushStream, PushResponse } from './FilePushStream';
import { FilePushResponseStatus } from './FilePushResponseStatus';

type Resolve = (response: PushResponse) => void;

export type PushUpdateParams = {
    /**
     * Stays the same for one upload from its first update to its last. The push id does not
     * (it is 0 until the server allocates one), and two uploads may share a file name.
     */
    key: number;
    pushId: number;
    fileName: string;
    /** Plain text for the upload's row: "Waiting", "45%", "Saving", or why it failed. */
    message: string;
    progress: number;
    error: boolean;
    finished: boolean;
    /** Stopped by the owner: neither a success nor a failure. */
    cancelled?: boolean;
    /** Bytes the device has accepted so far, and the size of the file. */
    sent?: number;
    size?: number;
    /** False once every byte is sent: the device is saving the file and it can no longer be stopped. */
    cancellable?: boolean;
};

/**
 * One file to send: the name it gets on the device and whether it may replace that name.
 * `folder` is the folder whose listing the name was checked against. Left out, the file goes to
 * the folder that is open when the upload starts.
 */
export type PlannedUpload = { file: File; name: string; overwrite: boolean; folder?: string };

/**
 * Decides what happens to each chosen file before anything is sent: a name that is already
 * taken is replaced, renamed or left out. Files missing from the result are not uploaded.
 */
export type UploadPlanner = (files: File[]) => Promise<PlannedUpload[]>;

export interface DragAndPushListener {
    onDragEnter: () => boolean;
    onDragLeave: () => boolean;
    onDrop: () => boolean;
    onFilePushUpdate: (data: PushUpdateParams) => void;
    onError: (error: Error | string) => void;
}

/** One upload, from the moment it is queued until it has reported its outcome. */
type Job = {
    key: number;
    upload: PlannedUpload;
    pushId: number;
    cancelled: boolean;
    /** Every byte is sent and the device is saving the file. */
    saving: boolean;
    reader?: ReadableStreamDefaultReader<Uint8Array>;
};

/** Uploads that run at once. The others wait their turn, so 40 files do not start together. */
const CONCURRENT_UPLOADS = 2;
/**
 * Chunks sent ahead of their acknowledgement. Waiting for each one before sending the next
 * limited an upload to one chunk per round trip, which is slow over a remote connection.
 */
const CHUNKS_IN_FLIGHT = 16;
/** The size of one APPEND, the same as one adb sync DATA packet. */
const CHUNK_BYTES = 64 * 1024;

const TAG = '[FilePushHandler]';

export default class FilePushHandler implements DragEventListener {
    public static readonly REQUEST_NEW_PUSH_ID = 0; // ignored on server, when state is `NEW_PUSH_ID`

    private responseWaiter: Map<number, Resolve | Resolve[]> = new Map();
    private listeners: Set<DragAndPushListener> = new Set();
    private pushIdFileNameMap: Map<number, { key: number; fileName: string }> = new Map();
    private nextKey = 1;
    /** Uploads that already reported their outcome. A closed channel reports once more. */
    private settled = new Set<number>();
    private released = false;
    private readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
    private readonly queue: Job[] = [];
    private readonly active = new Map<number, Job>();

    constructor(
        private readonly element: HTMLElement,
        private readonly filePushStream: FilePushStream,
        private readonly planUploads?: UploadPlanner,
    ) {
        DragAndDropHandler.addEventListener(this);
        filePushStream.on('response', this.onStreamResponse);
        filePushStream.on('error', this.onStreamError);
    }

    private sendUpdate(params: PushUpdateParams): void {
        if (this.released) return;
        if (params.error) {
            this.pushIdFileNameMap.delete(params.pushId);
        }
        // The server explains a refusal in the close reason. The generic code that the same
        // close then hands to the waiting step must not replace that explanation.
        if (this.settled.has(params.key)) return;
        if (params.finished) this.settled.add(params.key);
        this.listeners.forEach((listener) => {
            listener.onFilePushUpdate(params);
        });
    }

    private logError(job: Job, code: number): void {
        const msg = RESPONSE_CODES.get(code) || `Unknown error (${code})`;
        this.sendUpdate({
            key: job.key,
            pushId: job.pushId,
            fileName: job.upload.name,
            message: `${msg}.`,
            progress: -1,
            error: true,
            finished: true,
            size: job.upload.file.size,
        });
    }

    private reportCancelled(job: Job): void {
        this.sendUpdate({
            key: job.key,
            pushId: job.pushId,
            fileName: job.upload.name,
            message: 'Cancelled',
            progress: -1,
            error: false,
            finished: true,
            cancelled: true,
            size: job.upload.file.size,
        });
    }

    private async pushFile(job: Job): Promise<void> {
        if (this.released) return;
        const { key, upload } = job;
        const { file, name: fileName, overwrite, folder } = upload;
        const start = Date.now();
        const size = file.size;
        const progress = (sent: number, message: string) =>
            this.sendUpdate({
                key,
                pushId: job.pushId,
                fileName,
                message,
                progress: size ? (sent * 100) / size : 100,
                error: false,
                finished: false,
                sent,
                size,
                cancellable: !job.saving,
            });
        if (!this.filePushStream.hasConnection()) {
            this.sendUpdate({
                key,
                pushId: 0,
                fileName,
                message: 'The connection to the device is closed.',
                progress: -1,
                error: true,
                finished: true,
                size,
            });
            return;
        }
        progress(0, 'Starting');
        const allocation = this.waitForResponse(FilePushHandler.REQUEST_NEW_PUSH_ID);
        this.filePushStream.sendEventNew({ id: FilePushHandler.REQUEST_NEW_PUSH_ID });
        const { code: pushId } = await allocation;
        if (this.released) return;
        if (pushId <= 0) {
            return this.logError(job, pushId);
        }
        job.pushId = pushId;
        if (job.cancelled) {
            this.filePushStream.sendEventCancel({ id: pushId });
            return;
        }

        this.pushIdFileNameMap.set(pushId, { key, fileName });
        const waitPromise = this.waitForResponse(pushId);
        this.filePushStream.sendEventStart({ id: pushId, fileName, fileSize: size, overwrite, folder });
        const [{ code: startResponseCode }, { reader, result }] = await Promise.all([
            waitPromise,
            FilePushHandler.getStreamReader(file),
        ]);
        this.readers.add(reader);
        job.reader = reader;
        try {
            if (this.released || job.cancelled) return;
            if (startResponseCode !== FilePushResponseStatus.NO_ERROR) {
                return this.logError(job, startResponseCode);
            }
            const inFlight: { response: Promise<PushResponse>; bytes: number }[] = [];
            let acknowledged = 0;
            let shown = -1;
            // Waits for the oldest chunk's acknowledgement. Returns the error code, if any.
            const settleOldest = async (): Promise<number> => {
                const { response, bytes } = inFlight.shift() as (typeof inFlight)[number];
                const { code } = await response;
                if (code === FilePushResponseStatus.NO_ERROR) {
                    acknowledged += bytes;
                    // One update per percent, not one per chunk.
                    const percent = Math.floor((acknowledged * 100) / size);
                    if (percent !== shown) {
                        shown = percent;
                        progress(acknowledged, `${percent}%`);
                    }
                }
                return code;
            };
            let next = result;
            while (!next.done && next.value) {
                const value = next.value;
                const reading = reader.read();
                // A cancelled upload stops waiting for this read; its failure is not news then.
                reading.catch(() => undefined);
                // A browser may hand over the whole file as one chunk. Pieces of a fixed size
                // keep the device's buffer, the progress and the window meaningful.
                for (let offset = 0; offset < value.length; offset += CHUNK_BYTES) {
                    const chunk = value.subarray(offset, offset + CHUNK_BYTES);
                    inFlight.push({ response: this.waitForResponse(pushId), bytes: chunk.length });
                    this.filePushStream.sendEventAppend({ id: pushId, chunk });
                    while (inFlight.length >= CHUNKS_IN_FLIGHT) {
                        const code = await settleOldest();
                        if (this.released || job.cancelled) return;
                        if (code !== FilePushResponseStatus.NO_ERROR) return this.logError(job, code);
                    }
                }
                next = await reading;
                if (this.released || job.cancelled) return;
            }
            while (inFlight.length) {
                const code = await settleOldest();
                if (this.released || job.cancelled) return;
                if (code !== FilePushResponseStatus.NO_ERROR) return this.logError(job, code);
            }
            job.saving = true;
            progress(size, 'Saving');
            const finish = this.waitForResponse(pushId);
            this.filePushStream.sendEventFinish({ id: pushId });
            const { code: finishResponseCode } = await finish;
            if (this.released) return;
            if (finishResponseCode !== FilePushResponseStatus.NO_ERROR) {
                return this.logError(job, finishResponseCode);
            }
            this.sendUpdate({
                key,
                pushId,
                fileName,
                message: 'Uploaded',
                progress: 100,
                error: false,
                finished: true,
                sent: size,
                size,
            });
            console.log(TAG, `File "${fileName}" uploaded in ${Date.now() - start}ms`);
        } finally {
            this.readers.delete(reader);
            await reader.cancel().catch(() => undefined);
            this.pushIdFileNameMap.delete(pushId);
        }
    }

    private static async getStreamReader(file: File): Promise<{
        reader: ReadableStreamDefaultReader<Uint8Array>;
        result: ReadableStreamReadResult<Uint8Array>;
    }> {
        const reader = file.stream().getReader() as ReadableStreamDefaultReader<Uint8Array>;
        const result = await reader.read();
        return { reader, result };
    }

    private waitForResponse(pushId: number): Promise<PushResponse> {
        if (this.released) return Promise.resolve({ id: pushId, code: FilePushResponseStatus.ERROR_OTHER });
        return new Promise((resolve) => {
            const stored = this.responseWaiter.get(pushId);
            if (Array.isArray(stored)) {
                stored.push(resolve);
            } else if (stored) {
                const arr: Resolve[] = [stored];
                arr.push(resolve);
                this.responseWaiter.set(pushId, arr);
            } else {
                this.responseWaiter.set(pushId, resolve);
            }
        });
    }

    /** Ends every wait on one allocated upload: its channel is gone, so no answer will come. */
    private resolveAll(pushId: number, code: number): void {
        const stored = this.responseWaiter.get(pushId);
        this.responseWaiter.delete(pushId);
        (Array.isArray(stored) ? stored : stored ? [stored] : []).forEach((resolve) => resolve({ id: pushId, code }));
    }

    onStreamError = ({ id: pushId, error }: { id: number; error: Error }): void => {
        const known = this.pushIdFileNameMap.get(pushId);
        if (known) {
            const { key, fileName } = known;
            this.sendUpdate({
                key,
                pushId,
                fileName,
                message: error.message,
                progress: -1,
                error: true,
                finished: true,
            });
        }
        if (pushId === FilePushHandler.REQUEST_NEW_PUSH_ID) {
            // An upload with no push id yet is not in the map; the step waiting below reports
            // it. The other uploads waiting for an id still get theirs.
            this.onStreamResponse({ id: pushId, code: FilePushResponseStatus.ERROR_OTHER });
        } else {
            // Several chunks may be waiting for their acknowledgement.
            this.resolveAll(pushId, FilePushResponseStatus.ERROR_OTHER);
        }
    };

    onStreamResponse = (response: PushResponse): void => {
        let func: Resolve;
        let value: PushResponse;
        const { code, id: idInResponse } = response;
        const id = code === FilePushResponseStatus.NEW_PUSH_ID ? FilePushHandler.REQUEST_NEW_PUSH_ID : response.id;
        const resolve = this.responseWaiter.get(id);
        if (!resolve) {
            console.warn(TAG, `Unexpected push id: "${id}", ${JSON.stringify(response)}`);
            return;
        }
        if (Array.isArray(resolve)) {
            func = resolve.shift() as Resolve;
            if (!resolve.length) {
                this.responseWaiter.delete(id);
            }
        } else {
            func = resolve;
            this.responseWaiter.delete(id);
        }
        if (code === FilePushResponseStatus.NEW_PUSH_ID) {
            value = { id, code: idInResponse };
        } else {
            value = { id, code: code };
        }
        func(value);
    };
    public onFilesDrop(files: File[]): boolean {
        if (this.released) return false;
        let accepted = true;
        this.listeners.forEach((listener) => {
            if (!listener.onDrop()) accepted = false;
        });
        if (!accepted) return true;
        const allowed: File[] = [];
        files.forEach((file: File) => {
            const { type, name } = file;
            if (this.filePushStream.isAllowedFile(file)) {
                allowed.push(file);
            } else {
                const errorParams: PushUpdateParams = {
                    key: this.nextKey++,
                    pushId: FilePushHandler.REQUEST_NEW_PUSH_ID,
                    fileName: name,
                    message: `Unsupported type "${type}"`,
                    progress: -1,
                    error: true,
                    finished: true,
                };
                this.sendUpdate(errorParams);
            }
        });
        if (!allowed.length) {
            return true;
        }
        if (!this.planUploads) {
            // No listing to compare with: send each file under its own name. The server
            // refuses a name that is already taken.
            allowed.forEach((file) => this.startUpload({ file, name: file.name, overwrite: false }));
            return true;
        }
        void this.planUploads(allowed)
            .then((plan) => plan.forEach((upload) => this.startUpload(upload)))
            .catch((error) => {
                if (this.released) return;
                this.listeners.forEach((listener) => {
                    listener.onError(error instanceof Error ? error : String(error));
                });
            });
        return true;
    }

    /** Queues one upload. It shows as waiting until one of the transfers is free. */
    private startUpload(upload: PlannedUpload): void {
        if (this.released) return;
        const job: Job = { key: this.nextKey++, upload, pushId: 0, cancelled: false, saving: false };
        this.queue.push(job);
        this.sendUpdate({
            key: job.key,
            pushId: 0,
            fileName: upload.name,
            message: 'Waiting',
            progress: 0,
            error: false,
            finished: false,
            sent: 0,
            size: upload.file.size,
            cancellable: true,
        });
        this.pump();
    }

    private pump(): void {
        while (!this.released && this.active.size < CONCURRENT_UPLOADS && this.queue.length) {
            const job = this.queue.shift() as Job;
            this.active.set(job.key, job);
            void this.pushFile(job)
                .catch((error) => {
                    this.sendUpdate({
                        key: job.key,
                        pushId: job.pushId,
                        fileName: job.upload.name,
                        message: error instanceof Error ? error.message : 'Upload failed.',
                        progress: -1,
                        error: true,
                        finished: true,
                    });
                })
                .finally(() => {
                    this.active.delete(job.key);
                    this.settled.delete(job.key);
                    this.pump();
                });
        }
    }

    /**
     * Stops one upload. A waiting one never starts; a running one is cancelled on the device,
     * which discards the partial file. A file that is already being saved is left to finish.
     */
    public cancel(key: number): void {
        const waiting = this.queue.findIndex((job) => job.key === key);
        if (waiting >= 0) {
            const [job] = this.queue.splice(waiting, 1);
            job.cancelled = true;
            this.reportCancelled(job);
            this.settled.delete(job.key);
            return;
        }
        const job = this.active.get(key);
        if (!job || job.cancelled || job.saving) {
            return;
        }
        job.cancelled = true;
        // Without a push id the upload stops as soon as the server allocates one.
        if (job.pushId > 0) {
            this.filePushStream.sendEventCancel({ id: job.pushId });
            this.resolveAll(job.pushId, FilePushResponseStatus.ERROR_OTHER);
        }
        void job.reader?.cancel().catch(() => undefined);
        this.reportCancelled(job);
    }

    /** Stops every upload that is waiting or running. */
    public cancelAll(): void {
        [...this.queue, ...this.active.values()].forEach((job) => this.cancel(job.key));
    }

    public static getErrorMessage(code: number, message?: string): string {
        return message || RESPONSE_CODES.get(code) || 'Unknown error';
    }

    public onDragEnter(): boolean {
        let handled = false;
        this.listeners.forEach((listener) => {
            handled = handled || listener.onDragEnter();
        });
        return handled;
    }

    public onDragLeave(): boolean {
        let handled = false;
        this.listeners.forEach((listener) => {
            handled = handled || listener.onDragLeave();
        });
        return handled;
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public release(): void {
        if (this.released) return;
        this.released = true;
        this.queue.length = 0;
        this.active.clear();
        this.responseWaiter.forEach((value, id) => {
            const waiters = Array.isArray(value) ? value : [value];
            waiters.forEach((resolve) => resolve({ id, code: FilePushResponseStatus.ERROR_OTHER }));
        });
        this.responseWaiter.clear();
        this.pushIdFileNameMap.clear();
        this.readers.forEach((reader) => {
            void reader.cancel().catch(() => undefined);
        });
        this.readers.clear();
        this.filePushStream.off('response', this.onStreamResponse);
        this.filePushStream.off('error', this.onStreamError);
        this.filePushStream.release();
        DragAndDropHandler.removeEventListener(this);
        this.listeners.clear();
    }

    public addEventListener(listener: DragAndPushListener): void {
        this.listeners.add(listener);
    }
    public removeEventListener(listener: DragAndPushListener): void {
        this.listeners.delete(listener);
    }
}

const RESPONSE_CODES = new Map([
    [FilePushResponseStatus.NEW_PUSH_ID, 'New push id'],
    [FilePushResponseStatus.NO_ERROR, 'No error'],

    [FilePushResponseStatus.ERROR_INVALID_NAME, 'Invalid name'],
    [FilePushResponseStatus.ERROR_NO_SPACE, 'No space'],
    [FilePushResponseStatus.ERROR_FAILED_TO_DELETE, 'Failed to delete existing'],
    [FilePushResponseStatus.ERROR_FAILED_TO_CREATE, 'Failed to create new file'],
    [FilePushResponseStatus.ERROR_FILE_NOT_FOUND, 'File not found'],
    [FilePushResponseStatus.ERROR_FAILED_TO_WRITE, 'Failed to write to file'],
    [FilePushResponseStatus.ERROR_FILE_IS_BUSY, 'File is busy'],
    [FilePushResponseStatus.ERROR_INVALID_STATE, 'Invalid state'],
    [FilePushResponseStatus.ERROR_UNKNOWN_ID, 'Unknown id'],
    [FilePushResponseStatus.ERROR_NO_FREE_ID, 'No free id'],
    [FilePushResponseStatus.ERROR_INCORRECT_SIZE, 'Incorrect size'],
    [FilePushResponseStatus.ERROR_OTHER, 'The upload did not finish'],
    [FilePushResponseStatus.ERROR_FILE_EXISTS, 'An item with this name already exists'],
]);
