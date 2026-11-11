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

export interface XtermStopMessage {
    type: 'stop';
}

export type XtermClientMessage = XtermStartMessage | XtermStopMessage;
