import { Express } from 'express';
import http from 'http';
import https from 'https';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import { sameOrigin } from '../../requestOrigin';
import { Config } from '../../Config';
import { AdbUtils } from '../AdbUtils';

/**
 * Passes exactly `length` bytes. A source that ends early fails the response, so the browser
 * reports a failed download and not a short file. Bytes past the stated length are dropped: the
 * file grew after its size was read.
 */
function exactLength(length: number): Transform {
    let remaining = length;
    return new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            const part = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            remaining -= part.length;
            callback(null, part.length ? part : undefined);
        },
        flush(callback) {
            callback(remaining ? Error('The file ended early.') : null);
        },
    });
}

/** Every download streams to disk through the browser; nothing accumulates in the tab. */
export function mountFileDownloads(app: Express, base: string): void {
    app.get(`${base.replace(/\/$/, '')}/api/files/download`, sameOrigin, async (request, response) => {
        const { udid, path: file, remote } = request.query;
        if (
            typeof udid !== 'string' ||
            !udid ||
            typeof file !== 'string' ||
            !file.startsWith('/') ||
            file.includes('\0')
        ) {
            response.status(400).send('Choose a device and file.');
            return;
        }
        const controller = new AbortController();
        let cancel: (() => void) | undefined;
        const abort = () => {
            if (response.writableFinished) return;
            controller.abort();
            cancel?.();
        };
        response.once('close', abort);
        try {
            let stream: Readable;
            // Known only when the device or the remote server states it. The browser shows
            // progress and detects a cut-off transfer only with a Content-Length.
            let size: number | undefined;
            if (remote !== undefined) {
                const target = new URL(String(remote));
                const host = Config.getInstance().getProxyHost(target);
                if (!host) {
                    response.sendStatus(403);
                    return;
                }
                target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
                target.pathname = target.pathname.replace(/\/$/, '') + '/api/files/download';
                target.search = new URLSearchParams({ udid, path: file }).toString();
                stream = await new Promise<http.IncomingMessage>((resolve, reject) => {
                    const upstream = (target.protocol === 'https:' ? https : http).get(
                        target,
                        {
                            signal: controller.signal,
                        },
                        (reply) => {
                            if (reply.statusCode !== 200) {
                                reply.resume();
                                reject(Error('Remote download failed'));
                            } else resolve(reply);
                        },
                    );
                    upstream.setTimeout(30000, () => upstream.destroy(Error('Remote download timed out')));
                    upstream.on('error', reject);
                });
                const stated = Number((stream as http.IncomingMessage).headers['content-length']);
                size = Number.isSafeInteger(stated) && stated >= 0 ? stated : undefined;
            } else {
                size = await AdbUtils.fileSize(udid, file);
                if (controller.signal.aborted) return;
                const transfer = await AdbUtils.pipePullFile(udid, file);
                transfer.on('error', () => undefined);
                let cancelled = false;
                cancel = () => {
                    if (cancelled) return;
                    cancelled = true;
                    transfer.cancel();
                    transfer.destroy();
                };
                stream = transfer;
            }
            if (controller.signal.aborted) {
                cancel?.();
                stream.destroy();
                return;
            }
            response.type('application/octet-stream');
            response.attachment(file.slice(file.lastIndexOf('/') + 1) || 'download');
            if (size === undefined) {
                await pipeline(stream, response, { signal: controller.signal });
            } else {
                response.setHeader('Content-Length', size);
                await pipeline(stream, exactLength(size), response, { signal: controller.signal });
            }
        } catch {
            if (!controller.signal.aborted) {
                if (response.headersSent) response.destroy();
                else
                    response
                        .status(502)
                        .send('The file could not be downloaded. Check the device connection and try again.');
            }
        } finally {
            response.off('close', abort);
            if (!response.writableFinished) cancel?.();
        }
    });
}
