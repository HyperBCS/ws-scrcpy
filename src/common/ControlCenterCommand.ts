import { ScrcpyServerConfig } from './Constants';

export class ControlCenterCommand {
    public static KILL_SERVER = 'kill_server';
    public static START_SERVER = 'start_server';
    public static UPDATE_INTERFACES = 'update_interfaces';
    public static CONFIGURE_STREAM = 'configure_stream';
    public static ENABLE_DEVELOPER_MODE = 'enable_developer_mode';
    public static REFRESH_DEVICE = 'refresh_device';
    public static REBOOT_DEVICE = 'reboot_device';
    public static SHUTDOWN_DEVICE = 'shutdown_device';
    public static REMOUNT_DDI = 'remount_ddi';
    public static RESTART_SESSION = 'restart_session';
    public static LIST_ENCODERS = 'list_encoders';
    public static UPDATE_STREAM_CONFIG = 'update_stream_config';
    public static GET_LOCK_STATE = 'get_lock_state';

    private id = -1;
    private type = '';
    private pid = 0;
    private udid = '';
    private method = '';
    private args?: any;
    private data?: any;

    public static fromJSON(json: string): ControlCenterCommand {
        const body = JSON.parse(json);
        if (!body) {
            throw new Error('Invalid input');
        }
        const command = new ControlCenterCommand();
        const data = (command.data = body.data);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('Invalid command data');
        }
        command.id = body.id;
        command.type = body.type;

        if (typeof data.udid === 'string') {
            command.udid = data.udid;
        }
        switch (body.type) {
            case this.KILL_SERVER:
                if (!Number.isInteger(data.pid) || data.pid <= 0) {
                    throw new Error('Invalid "pid" value');
                }
                command.pid = data.pid;
                return command;
            case this.START_SERVER:
            case this.UPDATE_INTERFACES:
            case this.CONFIGURE_STREAM:
            case this.LIST_ENCODERS:
                return command;
            case this.ENABLE_DEVELOPER_MODE:
            case this.REFRESH_DEVICE:
            case this.REBOOT_DEVICE:
            case this.SHUTDOWN_DEVICE:
            case this.REMOUNT_DDI:
            case this.RESTART_SESSION:
                if (!command.udid) {
                    throw new Error('Missing device id');
                }
                return command;
            case this.GET_LOCK_STATE:
                if (!command.udid) {
                    throw new Error('Missing device id in lock-state request');
                }
                return command;
            case this.UPDATE_STREAM_CONFIG:
                if (!data.config || typeof data.config !== 'object' || Array.isArray(data.config)) {
                    throw new Error('Invalid "config" value');
                }
                return command;
            default:
                throw new Error(`Unknown command "${body.command}"`);
        }
    }

    public getType(): string {
        return this.type;
    }
    public getPid(): number {
        return this.pid;
    }
    public getUdid(): string {
        return this.udid;
    }
    public getId(): number {
        return this.id;
    }
    public getMethod(): string {
        return this.method;
    }
    public getData(): any {
        return this.data;
    }
    public getArgs(): any {
        return this.args;
    }
    public getConfig(): Partial<ScrcpyServerConfig> | undefined {
        return this.data?.config;
    }
}
