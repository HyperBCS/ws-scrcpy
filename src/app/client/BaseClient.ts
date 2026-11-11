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
        const title = Util.parseStringEnv(query.get('title'));
        if (!Util.parseBooleanEnv(query.get('useProxy'))) {
            // The socket goes to the server this page came from. A link cannot name another host:
            // whatever the page sends, a stored passcode included, would go there.
            return { action, title };
        }
        // The connection is wrapped in this server's proxy, which accepts configured hosts only.
        return {
            action: action,
            useProxy: true,
            secure: Util.parseBooleanEnv(query.get('secure')),
            hostname: Util.parseStringEnv(query.get('hostname')),
            port: Util.parseIntEnv(query.get('port')),
            pathname: Util.parseStringEnv(query.get('pathname')),
            title,
        };
    }

    public setTitle(text = this.title): void {
        // A `title` URL param overrides the automatic per-client title, so an
        // embedded or popped-out client can show a meaningful document title
        // (e.g. in a browser tab or detached window).
        let titleTag: HTMLTitleElement | null = document.querySelector('head > title');
        if (!titleTag) {
            titleTag = document.createElement('title');
            document.head.appendChild(titleTag);
        }
        titleTag.innerText = this.params?.title || text;
    }

    public setBodyClass(text: string): void {
        document.body.className = text;
    }
}
