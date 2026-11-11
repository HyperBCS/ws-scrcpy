import '@xterm/xterm/css/xterm.css';
import { ManagerClient } from '../../client/ManagerClient';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { MessageXtermClient } from '../../../types/MessageXtermClient';
import { ACTION } from '../../../common/Action';
import { ParamsShell } from '../../../types/ParamsShell';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import Util from '../../Util';
import { ChannelCode } from '../../../common/ChannelCode';
import { ToolEntry } from '../../client/Tool';
import { shellTool } from './deviceTools';
import { applyControl } from './shellInput';

const TAG = '[ShellClient]';
// A window drag or the phone keyboard sliding in refits the terminal many times in a row.
const RESIZE_DEBOUNCE_MS = 100;

export class ShellClient extends ManagerClient<ParamsShell, never> {
    public static ACTION = ACTION.SHELL;
    public static start(params: ParamsShell, mount?: HTMLElement): ShellClient {
        return new ShellClient(params, mount);
    }

    private readonly term: Terminal;
    private readonly fitAddon: FitAddon;
    private readonly udid: string;
    private readonly container: HTMLElement;
    private readonly resizeObserver: ResizeObserver;
    private closed = false;
    private started = false;
    private resizeTimer?: number;
    private controlActive = false;
    private controlListener?: (active: boolean) => void;

    constructor(params: ParamsShell, mount?: HTMLElement) {
        super(params);
        this.udid = params.udid;
        if (!mount) {
            this.setTitle(`Shell ${this.udid}`);
            this.setBodyClass('shell');
        }
        this.container = document.createElement('div');
        this.container.className = 'terminal-container';
        (mount ?? document.body).appendChild(this.container);
        this.term = new Terminal({ fontSize: 14, cursorBlink: true, scrollback: 3000 });
        this.fitAddon = new FitAddon();
        this.term.loadAddon(this.fitAddon);
        this.term.open(this.container);
        this.updateTerminalSize();
        this.resizeObserver = new ResizeObserver(this.updateTerminalSize);
        this.resizeObserver.observe(this.container);
        this.openNewConnection();
        // Typed input goes through `send` rather than the attach addon so the toolbar Ctrl key
        // can change it; output is written back in `onSocketMessage`.
        this.term.onData(this.onInput);
        this.term.onBinary((data) => this.send(data));
        this.term.onResize(this.scheduleResize);
        // On phones, opening a tool should not immediately cover it with the keyboard.
        if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
            this.term.focus();
        }
    }

    protected supportMultiplexing(): boolean {
        return true;
    }

    public static parseParameters(params: URLSearchParams): ParamsShell {
        const typedParams = super.parseParameters(params);
        const { action } = typedParams;
        if (action !== ACTION.SHELL) {
            throw Error('Incorrect action');
        }
        return { ...typedParams, action, udid: Util.parseString(params, 'udid', true) };
    }

    protected onSocketOpen = (): void => {
        if (!this.destroyed) {
            this.startShell(this.udid);
        }
    };

    protected onSocketClose(event: CloseEvent): void {
        if (this.destroyed) {
            return;
        }
        console.log(TAG, `Connection closed: ${event.reason}`);
        this.closed = true;
        this.started = false;
        this.term.options.disableStdin = true;
        this.term.writeln('\r\n[Shell disconnected. Use Reconnect to open a new session.]');
    }

    protected onSocketMessage(event: MessageEvent): void {
        if (this.destroyed) {
            return;
        }
        const data = event.data;
        this.term.write(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer));
    }

    private send(data: string): void {
        if (!this.destroyed && !this.closed && this.ws?.readyState === this.ws?.OPEN) {
            this.ws?.send(data);
        }
    }

    private onInput = (data: string): void => {
        const next = applyControl(data, this.controlActive);
        this.send(next.data);
        if (next.armed !== this.controlActive) {
            this.controlActive = next.armed;
            this.controlListener?.(next.armed);
        }
    };

    /** The toolbar Ctrl key. It applies to the next single character and then releases itself. */
    public setControl(active: boolean): void {
        this.controlActive = active;
    }

    /** Called when typing releases Ctrl, so the toolbar button can follow. */
    public onControlChange(listener: (active: boolean) => void): void {
        this.controlListener = listener;
    }

    public startShell(udid: string): void {
        if (!udid || !this.ws || this.ws.readyState !== this.ws.OPEN) {
            return;
        }
        const dimensions = this.fitAddon.proposeDimensions();
        if (!dimensions) {
            return;
        }
        const { rows, cols } = dimensions;
        const message: MessageXtermClient = {
            id: 1,
            type: 'shell',
            data: {
                type: 'start',
                rows,
                cols,
                udid,
            },
        };
        this.ws.send(JSON.stringify(message));
        this.started = true;
    }

    /**
     * Tells the device the new terminal size. Without it the remote pty keeps the size it started
     * with, so full-screen programs draw off screen and long lines wrap at the wrong column.
     */
    private scheduleResize = (): void => {
        window.clearTimeout(this.resizeTimer);
        this.resizeTimer = window.setTimeout(this.sendSize, RESIZE_DEBOUNCE_MS);
    };

    private sendSize = (): void => {
        this.resizeTimer = undefined;
        // Before the start message there is no pty, and that message carries the size itself.
        if (this.destroyed || this.closed || !this.started || this.ws?.readyState !== this.ws?.OPEN) {
            return;
        }
        const { cols, rows } = this.term;
        const message: MessageXtermClient = { id: 1, type: 'shell', data: { type: 'resize', cols, rows } };
        // A binary frame: the server types every text frame into the shell.
        this.ws?.send(new TextEncoder().encode(JSON.stringify(message)));
    };

    public focus(): void {
        if (!this.destroyed && !this.closed) {
            this.term.focus();
        }
    }

    public sendInput(text: string): void {
        this.send(text);
        this.focus();
    }

    private updateTerminalSize = (): void => {
        if (this.destroyed || !this.container.clientWidth || !this.container.clientHeight) {
            return;
        }
        this.fitAddon.fit();
    };

    public stop(): void {
        if (this.destroyed) {
            return;
        }
        this.resizeObserver.disconnect();
        window.clearTimeout(this.resizeTimer);
        this.destroy();
        this.term.dispose();
        this.container.remove();
    }

    public static createEntryForDeviceList(descriptor: GoogDeviceDescriptor): ToolEntry | undefined {
        return shellTool.createEntryForDeviceList(descriptor);
    }

    protected getChannelInitData(): Buffer {
        const buffer = Buffer.alloc(4);
        buffer.write(ChannelCode.SHEL, 'ascii');
        return buffer;
    }
}
