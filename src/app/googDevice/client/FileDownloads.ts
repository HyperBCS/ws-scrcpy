const MEMORY_LIMIT = 16 * 1024 * 1024;

/** Owns download buffers and object URLs, independent of file-browser rendering. */
export class FileDownloads {
    private readonly buffers = new Map<string, { chunks: Uint8Array<ArrayBuffer>[]; size: number }>();
    private readonly urls = new Map<string, ReturnType<typeof setTimeout>>();
    constructor(private readonly endpoint: (path: string) => URL) {}

    start(path: string, size: number): boolean {
        if (size > MEMORY_LIMIT || this.buffers.size + this.urls.size >= 2) {
            this.stream(path);
            return false;
        }
        this.buffers.set(path, { chunks: [], size: 0 });
        return true;
    }
    append(path: string, bytes: Uint8Array): number | undefined {
        const buffer = this.buffers.get(path);
        if (!buffer) return;
        if (buffer.size + bytes.byteLength > MEMORY_LIMIT) {
            this.buffers.delete(path);
            this.stream(path);
            return;
        }
        buffer.chunks.push(new Uint8Array(bytes));
        buffer.size += bytes.byteLength;
        return buffer.size;
    }
    finish(path: string, filename: string): void {
        const buffer = this.buffers.get(path);
        if (!buffer) return;
        this.buffers.delete(path);
        const url = URL.createObjectURL(new Blob(buffer.chunks, { type: 'application/octet-stream' }));
        this.click(url, filename);
        this.urls.set(
            url,
            setTimeout(() => {
                URL.revokeObjectURL(url);
                this.urls.delete(url);
            }, 60000),
        );
    }
    cancel(path: string): void {
        this.buffers.delete(path);
    }
    private stream(path: string): void {
        this.click(this.endpoint(path).href, path.slice(path.lastIndexOf('/') + 1));
    }
    private click(url: string, filename: string): void {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
    }
    release(): void {
        this.buffers.clear();
        for (const [url, timer] of this.urls) {
            clearTimeout(timer);
            URL.revokeObjectURL(url);
        }
        this.urls.clear();
    }
}
