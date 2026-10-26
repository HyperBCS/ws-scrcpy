import { Express } from 'express';
import http from 'http';
import https from 'https';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { AccessControl } from '../../AccessControl';
import { Config } from '../../Config';
import { AdbUtils } from '../AdbUtils';

/** Browser-managed large downloads stream to disk instead of accumulating a Blob in the tab. */
export function mountFileDownloads(app: Express, base: string, access: AccessControl): void {
    app.get(`${base.replace(/\/$/, '')}/api/files/download`, access.requireAccess, async (request, response) => {
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
                            headers: host.accessKey ? { Authorization: `Bearer ${host.accessKey}` } : {},
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
            } else {
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
            await pipeline(stream, response, { signal: controller.signal });
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
