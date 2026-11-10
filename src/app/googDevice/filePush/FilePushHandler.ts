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
    message: string;
    progress: number;
    error: boolean;
    finished: boolean;
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

    private logError(key: number, pushId: number, fileName: string, code: number): void {
        const msg = RESPONSE_CODES.get(code) || `Unknown error (${code})`;
        this.sendUpdate({
            key,
            pushId,
            fileName,
            message: `error: "${msg}"`,
            progress: -1,
            error: true,
            finished: true,
        });
    }

    private static async getStreamReader(file: File): Promise<{
        reader: ReadableStreamDefaultReader<Uint8Array>;
        result: ReadableStreamReadResult<Uint8Array>;
    }> {
        const reader = file.stream().getReader() as ReadableStreamDefaultReader<Uint8Array>;
        const result = await reader.read();
        return { reader, result };
    }

    private async pushFile(key: number, { file, name: fileName, overwrite, folder }: PlannedUpload): Promise<void> {
        if (this.released) return;
        const start = Date.now();
        const fileSize = file.size;
        if (!this.filePushStream.hasConnection()) {
            this.listeners.forEach((listener) => {
                listener.onError('WebSocket is not ready');
            });
            return;
        }
        const id = FilePushHandler.REQUEST_NEW_PUSH_ID;
        this.sendUpdate({
            key,
            pushId: id,
            fileName,
            message: 'begins...',
            progress: 0,
            error: false,
            finished: false,
        });
        const allocation = this.waitForResponse(id);
        this.filePushStream.sendEventNew({ id });
        const { code: pushId } = await allocation;
        if (this.released) return;
        if (pushId <= 0) {
            return this.logError(key, pushId, fileName, pushId);
        }

        this.pushIdFileNameMap.set(pushId, { key, fileName });
        const waitPromise = this.waitForResponse(pushId);
        this.filePushStream.sendEventStart({ id: pushId, fileName, fileSize, overwrite, folder });
        const [{ code: startResponseCode }, { reader, result }] = await Promise.all([
            waitPromise,
            FilePushHandler.getStreamReader(file),
        ]);
        this.readers.add(reader);
        if (this.released) {
            await reader.cancel();
            this.readers.delete(reader);
            return;
        }
        if (startResponseCode !== FilePushResponseStatus.NO_ERROR) {
            this.logError(key, pushId, fileName, startResponseCode);
            await reader.cancel();
            this.readers.delete(reader);
            return;
        }
        let receivedBytes = 0;

        const processData = async ({ done, value }: { done: boolean; value?: Uint8Array }): Promise<void> => {
            if (this.released) return;
            if (done || !value) {
                const finish = this.waitForResponse(pushId);
                this.filePushStream.sendEventFinish({ id: pushId });
                const { code: finishResponseCode } = await finish;
                if (this.released) return;
                if (finishResponseCode !== 0) {
                    this.logError(key, pushId, fileName, finishResponseCode);
                } else {
                    this.sendUpdate({
                        key,
                        pushId,
                        fileName,
                        message: 'success!',
                        progress: 100,
                        error: false,
                        finished: true,
                    });
                }
                console.log(TAG, `File "${fileName}" uploaded in ${Date.now() - start}ms`);
                return;
            }

            receivedBytes += value.length;
            const append = this.waitForResponse(pushId);
            this.filePushStream.sendEventAppend({ id: pushId, chunk: value });

            const [{ code: appendResponseCode }, result] = await Promise.all([append, reader.read()]);
            if (appendResponseCode !== 0) {
                this.logError(key, pushId, fileName, appendResponseCode);
                return;
            }
            const progress = (receivedBytes * 100) / fileSize;
            const message = `${progress.toFixed(2)}%`;
            this.sendUpdate({ key, pushId, fileName, message, progress, error: false, finished: false });
            return processData(result);
        };
        try {
            await processData(result);
        } finally {
            this.readers.delete(reader);
            await reader.cancel().catch(() => undefined);
            this.pushIdFileNameMap.delete(pushId);
        }
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
        // An upload with no push id yet is not in the map; the step waiting below reports it.
        this.onStreamResponse({ id: pushId, code: FilePushResponseStatus.ERROR_OTHER });
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

    private startUpload(upload: PlannedUpload): void {
        if (this.released) return;
        const key = this.nextKey++;
        void this.pushFile(key, upload)
            .catch((error) => {
                this.sendUpdate({
                    key,
                    pushId: 0,
                    fileName: upload.name,
                    message: error instanceof Error ? error.message : 'Upload failed.',
                    progress: -1,
                    error: true,
                    finished: true,
                });
            })
            .finally(() => this.settled.delete(key));
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
