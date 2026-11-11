import { EventMap, TypedEmitter } from '../../common/TypedEmitter';
import { ParamsBase } from '../../types/ParamsBase';
import Util from '../Util';

export class BaseClient<P extends ParamsBase, TE extends EventMap> extends TypedEmitter<TE> {
    protected title = 'BaseClient';
    protected params: P;

    protected constructor(params: P) {
        super();
        this.params = params;
    }

    public static parseParameters(query: URLSearchParams): ParamsBase {
        const action = Util.parseStringEnv(query.get('action'));
        if (!action) {
            throw TypeError('Invalid action');
        }
        return {
            action: action,
            useProxy: Util.parseBooleanEnv(query.get('useProxy')),
            secure: Util.parseBooleanEnv(query.get('secure')),
            hostname: Util.parseStringEnv(query.get('hostname')),
            port: Util.parseIntEnv(query.get('port')),
            pathname: Util.parseStringEnv(query.get('pathname')),
            title: Util.parseStringEnv(query.get('title')),
        };
    }

    /**
     * Does nothing. Tab titles are set in one place, from the route and the device list
     * (`state/pageTitle.ts`, applied in `views/App.tsx`), which also honours the `title` URL
     * parameter. Each client used to write its own format here ("Stream <model>",
     * "Files · <serial>"). Kept so the existing callers compile; remove it together with them.
     */
    public setTitle(_text = this.title): void {
        // Intentionally empty.
    }

    public setBodyClass(text: string): void {
        document.body.className = text;
    }
}
