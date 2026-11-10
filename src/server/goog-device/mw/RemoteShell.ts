import WS from 'ws';
import { Mw, RequestParameters } from '../../mw/Mw';
import * as pty from 'node-pty';
import { IDisposable, IPty } from 'node-pty';
import { Message } from '../../../types/Message';
import { XtermClientMessage, XtermServiceParameters } from '../../../types/XtermMessage';
import { ACTION } from '../../../common/Action';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ChannelCode } from '../../../common/ChannelCode';

const EVENT_TYPE_SHELL = 'shell';

export class RemoteShell extends Mw {
    public static readonly TAG = 'RemoteShell';
    private term?: IPty;
    private subscriptions: IDisposable[] = [];
    private initialized = false;
    private timeoutBuffer: NodeJS.Timeout | null = null;
    private terminated = false;
    private released = false;
    private closeCode = 1000;
    private closeReason = '';

    public static processChannel(ws: Multiplexer, code: string): Mw | undefined {
        if (code !== ChannelCode.SHEL) {
            return;
        }
        return new RemoteShell(ws);
    }

    public static processRequest(ws: WS, params: RequestParameters): RemoteShell | undefined {
        if (params.action !== ACTION.SHELL) {
            return;
        }
        return new RemoteShell(ws);
    }

    constructor(protected ws: WS | Multiplexer) {
        super(ws);
    }

    public createTerminal(params: XtermServiceParameters): IPty {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const env = Object.assign({}, process.env) as any;
        env['COLORTERM'] = 'truecolor';
        const { cols = 80, rows = 24 } = params;
        const cwd = env.PWD || '/';
        const file = 'adb';
        const term = pty.spawn(file, ['-s', params.udid, 'shell'], {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env,
            encoding: null,
        });
        const send = this.bufferUtf8(5);
        // release() disposes these: adb can write one more chunk between the socket closing and
        // the signal reaching it, and that chunk must not start another flush.
        this.subscriptions.push(
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore Documentation is incorrect for `encoding: null`
            term.onData((data) => {
                send(Buffer.from(data));
            }),
            term.onExit(({ exitCode }) => {
                if (exitCode === 0) {
                    this.closeCode = 1000;
                } else {
                    this.closeCode = 4500;
                }
                this.closeReason = `[${[RemoteShell.TAG]}] terminal process exited with code: ${exitCode}`;
                if (this.timeoutBuffer) {
                    this.terminated = true;
                } else {
                    this.ws.close(this.closeCode, this.closeReason);
                }
            }),
        );
        return term;
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        if (this.initialized) {
            if (!this.term) {
                return;
            }
            return this.term.write(event.data as string);
        }
        let data;
        try {
            data = JSON.parse(event.data.toString());
        } catch (error: any) {
            console.error(`[${RemoteShell.TAG}]`, error?.message);
            return;
        }
        this.handleMessage(data as Message).catch((error: Error) => {
            console.error(`[${RemoteShell.TAG}]`, error.message);
        });
    }

    private handleMessage = async (message: Message): Promise<void> => {
        if (message.type !== EVENT_TYPE_SHELL) {
            return;
        }
        const data: XtermClientMessage = message.data as XtermClientMessage;
        const { type } = data;
        if (type === 'start') {
            this.term = this.createTerminal(data);
            this.initialized = true;
        }
        if (type === 'stop') {
            this.release();
        }
    };

    private bufferUtf8(timeout: number): (data: Buffer) => void {
        let buffer: Buffer[] = [];
        let length = 0;
        return (data: Buffer) => {
            if (this.released) {
                return;
            }
            buffer.push(data);
            length += data.length;
            if (!this.timeoutBuffer) {
                this.timeoutBuffer = setTimeout(() => {
                    this.timeoutBuffer = null;
                    if (this.released) {
                        return;
                    }
                    const chunk = Buffer.concat(buffer, length);
                    buffer = [];
                    length = 0;
                    // A multiplexed channel throws when it is sent to after closing, and nothing
                    // catches a throw from a timer.
                    if (this.ws.readyState === this.ws.OPEN) {
                        this.ws.send(chunk);
                    }
                    if (this.terminated) {
                        this.ws.close(this.closeCode, this.closeReason);
                    }
                }, timeout);
            }
        };
    }

    public release(): void {
        if (this.released) {
            return;
        }
        this.released = true;
        super.release();
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        this.subscriptions = [];
        if (this.timeoutBuffer) {
            clearTimeout(this.timeoutBuffer);
            this.timeoutBuffer = null;
        }
        if (this.term) {
            this.term.kill();
            this.term = undefined;
        }
    }
}
