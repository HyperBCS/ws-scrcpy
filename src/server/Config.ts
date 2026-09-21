import * as process from 'process';
import * as fs from 'fs';
import * as path from 'path';
import { Configuration, HostItem, ServerItem } from '../types/Configuration';
import { EnvName } from './EnvName';
import YAML from 'yaml';

const DEFAULT_PORT = 8000;

const YAML_RE = /^.+\.(yaml|yml)$/i;
const JSON_RE = /^.+\.(json|js)$/i;

export class Config {
    private static instance?: Config;
    private static initConfig(userConfig: Configuration = {}): Required<Configuration> {
        const server: ServerItem[] = [
            {
                secure: false,
                port: DEFAULT_PORT,
            },
        ];
        // The `/// #if` blocks below are stripped by ifdef-loader when the feature is not built in,
        // so these defaults are what remains in that case.
        const defaultConfig: Required<Configuration> = {
            runGoogTracker: false,
            runApplTracker: false,
            announceGoogTracker: false,
            announceApplTracker: false,
            server,
            remoteHostList: [],
        };
        /// #if INCLUDE_GOOG
        defaultConfig.runGoogTracker = true;
        defaultConfig.announceGoogTracker = true;
        /// #endif

        /// #if INCLUDE_APPL
        defaultConfig.runApplTracker = true;
        defaultConfig.announceApplTracker = true;
        /// #endif
        const merged = Object.assign({}, defaultConfig, userConfig);
        merged.server = merged.server.map((item) => this.parseServerItem(item));
        return merged;
    }
    private static parseServerItem(config: Partial<ServerItem> = {}): ServerItem {
        const secure = config.secure || false;
        const port = config.port || (secure ? 443 : 80);
        const options = config.options;
        const redirectToSecure = config.redirectToSecure || false;
        if (secure && !options) {
            throw Error('Must provide "options" for secure server configuration');
        }
        if (options?.certPath) {
            if (options.cert) {
                throw Error(`Can't use "cert" and "certPath" together`);
            }
            options.cert = this.readFile(options.certPath);
        }
        if (options?.keyPath) {
            if (options.key) {
                throw Error(`Can't use "key" and "keyPath" together`);
            }
            options.key = this.readFile(options.keyPath);
        }
        const serverItem: ServerItem = {
            secure,
            port,
            redirectToSecure,
        };
        if (typeof options !== 'undefined') {
            serverItem.options = options;
        }
        if (typeof redirectToSecure === 'boolean') {
            serverItem.redirectToSecure = redirectToSecure;
        }
        return serverItem;
    }
    public static getInstance(): Config {
        if (!this.instance) {
            const configPath = process.env[EnvName.CONFIG_PATH];
            let userConfig: Configuration;
            if (!configPath) {
                userConfig = {};
            } else {
                if (configPath.match(YAML_RE)) {
                    userConfig = YAML.parse(this.readFile(configPath));
                } else if (configPath.match(JSON_RE)) {
                    userConfig = JSON.parse(this.readFile(configPath));
                } else {
                    throw Error(`Unknown file type: ${configPath}`);
                }
            }
            const fullConfig = this.initConfig(userConfig);
            this.instance = new Config(fullConfig);
        }
        return this.instance;
    }

    public static readFile(pathString: string): string {
        const isAbsolute = pathString.startsWith('/');
        const absolutePath = isAbsolute ? pathString : path.resolve(process.cwd(), pathString);
        if (!fs.existsSync(absolutePath)) {
            throw Error(`Can't find file "${absolutePath}"`);
        }
        return fs.readFileSync(absolutePath).toString();
    }

    constructor(private fullConfig: Required<Configuration>) {}

    public getHostList(): HostItem[] {
        if (!this.fullConfig.remoteHostList || !this.fullConfig.remoteHostList.length) {
            return [];
        }
        const hostList: HostItem[] = [];
        this.fullConfig.remoteHostList.forEach((item) => {
            const { hostname, port, pathname, secure, useProxy } = item;
            if (Array.isArray(item.type)) {
                item.type.forEach((type) => {
                    hostList.push({
                        hostname,
                        port,
                        pathname,
                        secure,
                        useProxy,
                        type,
                    });
                });
            } else {
                hostList.push({ hostname, port, pathname, secure, useProxy, type: item.type });
            }
        });
        return hostList;
    }

    public get runLocalGoogTracker(): boolean {
        return this.fullConfig.runGoogTracker;
    }

    public get announceLocalGoogTracker(): boolean {
        return this.fullConfig.announceGoogTracker;
    }

    public get runLocalApplTracker(): boolean {
        return this.fullConfig.runApplTracker;
    }

    public get announceLocalApplTracker(): boolean {
        return this.fullConfig.announceApplTracker;
    }

    public get servers(): ServerItem[] {
        return this.fullConfig.server;
    }
}
