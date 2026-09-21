import { DragAndDropHandler, DragEventListener } from '../DragAndDropHandler';
import { FilePushStream, PushResponse } from './FilePushStream';
import { FilePushResponseStatus } from './FilePushResponseStatus';

type Resolve = (response: PushResponse) => void;

export type PushUpdateParams = {
    pushId: number;
    fileName: string;
    message: string;
    progress: number;
    error: boolean;
    finished: boolean;
};

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
    private pushIdFileNameMap: Map<number, string> = new Map();
    private released = false;
    private readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();

    constructor(
        private readonly element: HTMLElement,
        private readonly filePushStream: FilePushStream,
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
        this.listeners.forEach((listener) => {
            listener.onFilePushUpdate(params);
        });
    }

    private logError(pushId: number, fileName: string, code: number): void {
        const msg = RESPONSE_CODES.get(code) || `Unknown error (${code})`;
        this.sendUpdate({ pushId, fileName, message: `error: "${msg}"`, progress: -1, error: true, finished: true });
    }

    private static async getStreamReader(file: File): Promise<{
        reader: ReadableStreamDefaultReader<Uint8Array>;
        result: ReadableStreamReadResult<Uint8Array>;
    }> {
        const reader = file.stream().getReader() as ReadableStreamDefaultReader<Uint8Array>;
        const result = await reader.read();
        return { reader, result };
    }

    private async pushFile(file: File): Promise<void> {
        if (this.released) return;
        const start = Date.now();
        const { name: fileName, size: fileSize } = file;
        if (!this.filePushStream.hasConnection()) {
            this.listeners.forEach((listener) => {
                listener.onError('WebSocket is not ready');
            });
            return;
        }
        const id = FilePushHandler.REQUEST_NEW_PUSH_ID;
        this.sendUpdate({ pushId: id, fileName, message: 'begins...', progress: 0, error: false, finished: false });
        const allocation = this.waitForResponse(id);
        this.filePushStream.sendEventNew({ id });
        const { code: pushId } = await allocation;
        if (this.released) return;
        if (pushId <= 0) {
            return this.logError(pushId, fileName, pushId);
        }

        this.pushIdFileNameMap.set(pushId, fileName);
        const waitPromise = this.waitForResponse(pushId);
        this.filePushStream.sendEventStart({ id: pushId, fileName, fileSize });
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
            this.logError(pushId, fileName, startResponseCode);
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
                    this.logError(pushId, fileName, finishResponseCode);
                } else {
                    this.sendUpdate({
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
                this.logError(pushId, fileName, appendResponseCode);
                return;
            }
            const progress = (receivedBytes * 100) / fileSize;
            const message = `${progress.toFixed(2)}%`;
            this.sendUpdate({ pushId, fileName, message, progress, error: false, finished: false });
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
        const fileName = this.pushIdFileNameMap.get(pushId) || 'Unknown file';
        this.sendUpdate({ pushId, fileName, message: error.message, progress: -1, error: true, finished: true });
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
        files.forEach((file: File) => {
            const { type, name } = file;
            if (this.filePushStream.isAllowedFile(file)) {
                void this.pushFile(file).catch((error) => {
                    if (!this.released)
                        this.sendUpdate({
                            pushId: 0,
                            fileName: file.name,
                            message: error instanceof Error ? error.message : 'Upload failed.',
                            progress: -1,
                            error: true,
                            finished: true,
                        });
                });
            } else {
                const errorParams: PushUpdateParams = {
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
        return true;
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
]);
