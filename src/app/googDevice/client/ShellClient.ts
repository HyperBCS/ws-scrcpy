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

const TAG = '[ShellClient]';

/**
 * Maps typed text to the control characters a physical Ctrl key would produce. Phone keyboards
 * have no Ctrl, so the toolbar offers one as a toggle; while it is on, every letter is sent as
 * its control code (c -> ^C, d -> ^D, l -> ^L...) and the punctuation that has a control code
 * follows the same rule. Anything else passes through unchanged.
 */
export function withControl(data: string): string {
    return Array.from(data)
        .map((char) => {
            if (/^[a-z]$/i.test(char)) {
                return String.fromCharCode(char.toUpperCase().charCodeAt(0) - 64);
            }
            const punctuation: Record<string, string> = {
                '@': '\x00',
                ' ': '\x00',
                '[': '\x1b',
                '\\': '\x1c',
                ']': '\x1d',
                '^': '\x1e',
                _: '\x1f',
                '?': '\x7f',
            };
            return punctuation[char] ?? char;
        })
        .join('');
}

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
    private controlActive = false;

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
        // Typed input goes through `send` rather than the attach addon so the Ctrl toggle can
        // rewrite it; output is written back in `onSocketMessage`.
        this.term.onData((data) => this.send(this.controlActive ? withControl(data) : data));
        this.term.onBinary((data) => this.send(data));
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

    /** The toolbar Ctrl toggle: on until switched off, like a held modifier. */
    public setControl(active: boolean): void {
        this.controlActive = active;
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
    }

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
