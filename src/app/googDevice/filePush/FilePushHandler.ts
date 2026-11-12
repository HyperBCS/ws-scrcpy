import * as path from 'path';
import { DragAndDropHandler, DragEventListener } from '../DragAndDropHandler';
import { Cancellable, FileError, FileService } from '../files/FileService';

export type PushUpdateParams = {
    /** Stays the same for one upload from its first update to its last. Two uploads may share a name. */
    key: number;
    fileName: string;
    /** The folder the file goes to: the one its name was checked against. */
    folder: string;
    /**
     * A word for the upload's row while no bytes are being sent ("Waiting", "Starting",
     * "Saving"), why it failed, or nothing while it sends.
     */
    message: string;
    error: boolean;
    finished: boolean;
    /** Stopped by the owner: neither a success nor a failure. */
    cancelled?: boolean;
    /** Bytes the phone has accepted so far, and the size of the file. */
    sent: number;
    size: number;
    /** False once every byte is sent: the phone is saving the file and it can no longer be stopped. */
    cancellable: boolean;
};

/**
 * One file to send: the name it gets on the phone, whether it may replace that name, and the
 * folder whose listing the name was checked against. The file goes to that folder, whichever
 * folder the explorer shows by the time it starts.
 */
export type PlannedUpload = { file: File; name: string; overwrite: boolean; folder: string };

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
    request?: Cancellable<void>;
    cancelled: boolean;
    /** Every byte is sent and the phone is saving the file. */
    saving: boolean;
    /** The outcome is reported; nothing more is said about this upload. */
    settled: boolean;
};

/** Uploads that run at once. The others wait their turn, so 40 files do not start together. */
const CONCURRENT_UPLOADS = 2;

const TAG = '[FilePushHandler]';

/**
 * The queue of uploads for one explorer: files dropped on it or picked, the question about
 * names that are taken (`planUploads`), two uploads at a time through `FileService.upload`,
 * Cancel, and an update for each step of each upload.
 */
export default class FilePushHandler implements DragEventListener {
    private readonly listeners = new Set<DragAndPushListener>();
    private nextKey = 1;
    private released = false;
    private readonly queue: Job[] = [];
    private readonly active = new Map<number, Job>();

    constructor(
        private readonly element: HTMLElement,
        private readonly service: FileService,
        private readonly planUploads: UploadPlanner,
    ) {
        DragAndDropHandler.addEventListener(this);
    }

    private update(job: Job, fields: Partial<PushUpdateParams> & { message: string }): void {
        if (this.released || job.settled) return;
        if (fields.finished) job.settled = true;
        const { file, name, folder } = job.upload;
        const params: PushUpdateParams = {
            key: job.key,
            fileName: name,
            folder,
            error: false,
            finished: false,
            sent: 0,
            size: file.size,
            cancellable: !job.saving,
            ...fields,
        };
        this.listeners.forEach((listener) => listener.onFilePushUpdate(params));
    }

    private reportCancelled(job: Job): void {
        this.update(job, { message: 'Cancelled', finished: true, cancelled: true, cancellable: false });
    }

    private async pushFile(job: Job): Promise<void> {
        const { file, name, overwrite, folder } = job.upload;
        const start = Date.now();
        const size = file.size;
        job.request = this.service.upload(file, {
            path: path.join(folder, name),
            overwrite,
            onProgress: ({ sent, saving }) => {
                job.saving = saving;
                this.update(job, { message: saving ? 'Saving' : sent ? '' : 'Starting', sent });
            },
        });
        try {
            await job.request;
            this.update(job, { message: 'Uploaded', finished: true, sent: size, cancellable: false });
            console.log(TAG, `File "${name}" uploaded in ${Date.now() - start}ms`);
        } catch (error) {
            if (error instanceof FileError && error.kind === 'cancelled') {
                this.reportCancelled(job);
            } else {
                const message = error instanceof Error ? error.message : 'Upload failed.';
                this.update(job, { message, error: true, finished: true, cancellable: false });
            }
        }
    }

    public onFilesDrop(files: File[]): boolean {
        if (this.released) return false;
        let accepted = true;
        this.listeners.forEach((listener) => {
            if (!listener.onDrop()) accepted = false;
        });
        if (!accepted || !files.length) return true;
        void this.planUploads(files)
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
        const job: Job = { key: this.nextKey++, upload, cancelled: false, saving: false, settled: false };
        this.queue.push(job);
        this.update(job, { message: 'Waiting' });
        this.pump();
    }

    private pump(): void {
        while (!this.released && this.active.size < CONCURRENT_UPLOADS && this.queue.length) {
            const job = this.queue.shift() as Job;
            this.active.set(job.key, job);
            void this.pushFile(job).finally(() => {
                this.active.delete(job.key);
                this.pump();
            });
        }
    }

    /**
     * Stops one upload. A waiting one never starts; a running one is cancelled on the phone,
     * which discards the partial file. A file that is already being saved is left to finish.
     */
    public cancel(key: number): void {
        const waiting = this.queue.findIndex((job) => job.key === key);
        if (waiting >= 0) {
            const [job] = this.queue.splice(waiting, 1);
            job.cancelled = true;
            this.reportCancelled(job);
            return;
        }
        const job = this.active.get(key);
        if (!job || job.cancelled || job.saving) {
            return;
        }
        job.cancelled = true;
        job.request?.cancel();
        this.reportCancelled(job);
    }

    /** Stops every upload that is waiting or running. */
    public cancelAll(): void {
        [...this.queue, ...this.active.values()].forEach((job) => this.cancel(job.key));
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

    /**
     * Says nothing more about any upload. The channels of the uploads are the service's: they
     * close when it is released or when the connection goes.
     */
    public release(): void {
        if (this.released) return;
        this.released = true;
        this.queue.length = 0;
        this.active.clear();
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
