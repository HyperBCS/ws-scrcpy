import { Readable, ReadableOptions } from 'stream';

export class ReadStream extends Readable {
    private _bytesRead = 0;
    // `client.push()` is typed to take an `fs.ReadStream`, but adbkit only ever uses it
    // as a `Readable`. This stream never waits on a file descriptor, so it is never pending.
    public readonly pending: boolean = false;
    constructor(
        private readonly _path: string,
        opts?: ReadableOptions,
    ) {
        super(opts);
    }
    public get bytesRead(): number {
        return this._bytesRead;
    }
    public get path(): string | Buffer {
        return this._path;
    }
    public push(chunk: any, encoding?: BufferEncoding): boolean {
        if (chunk) {
            this._bytesRead += chunk.length;
        }
        return super.push(chunk, encoding);
    }

    public close(): void {
        this.destroy();
    }
}
