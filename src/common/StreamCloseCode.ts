/**
 * WebSocket close code for an Android stream whose service the owner stopped on purpose. Unlike
 * every other close, the viewer must not reconnect: that would start the service again.
 */
export const STREAM_SERVICE_STOPPED = 4012;
