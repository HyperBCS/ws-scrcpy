import { IncomingMessage } from 'http';
import { TLSSocket } from 'tls';
import { RequestHandler } from 'express';

/** Reject browser requests from unrelated sites. */
export function allowsOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    const protocol = (request.socket as TLSSocket).encrypted ? 'https' : 'http';
    return (
        origin === `${protocol}://${request.headers.host}` ||
        (!!process.env.WS_PUBLIC_URL && origin === new URL(process.env.WS_PUBLIC_URL).origin)
    );
}

export const sameOrigin: RequestHandler = (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (allowsOrigin(request)) next();
    else response.sendStatus(403);
};
