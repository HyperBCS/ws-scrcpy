// Everything the browser may ask of the shell service. The server chooses the working directory
// and environment of the adb process itself; a client must never be able to supply them.

export interface XtermSize {
    cols: number;
    rows: number;
}

export interface XtermStartMessage extends XtermSize {
    type: 'start';
    udid: string;
}

export interface XtermResizeMessage extends XtermSize {
    type: 'resize';
}

export interface XtermStopMessage {
    type: 'stop';
}

// The start message is the first text frame. After it, text frames are typed input and the
// other messages travel as JSON in binary frames, so input can never be read as a message.
export type XtermClientMessage = XtermStartMessage | XtermResizeMessage | XtermStopMessage;
