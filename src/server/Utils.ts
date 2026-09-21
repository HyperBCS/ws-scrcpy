import * as os from 'os';

export class Utils {
    public static printListeningMsg(proto: string, port: number, pathname: string): void {
        const ipv4List: string[] = [];
        const ipv6List: string[] = [];
        const formatAddress = (ip: string, scopeid: number | undefined): void => {
            if (typeof scopeid === 'undefined') {
                ipv4List.push(`${proto}://${ip}:${port}${pathname}`);
                return;
            }
            if (scopeid === 0) {
                ipv6List.push(`${proto}://[${ip}]:${port}${pathname}`);
            } else {
                return;
                // skip
                // ipv6List.push(`${proto}://[${ip}%${scopeid}]:${port}`);
            }
        };
        const networkInterfaces = os.networkInterfaces();
        Object.keys(networkInterfaces)
            .map((key) => networkInterfaces[key])
            .forEach((info) => {
                if (!info) {
                    // An interface may disappear between listing the names and reading it.
                    return;
                }
                info.forEach((iface) => {
                    let scopeid: number | undefined;
                    if (iface.family === 'IPv6') {
                        scopeid = iface.scopeid;
                    } else if (iface.family === 'IPv4') {
                        scopeid = undefined;
                    } else {
                        return;
                    }
                    formatAddress(iface.address, scopeid);
                });
            });
        const nameList = [
            encodeURI(`${proto}://${os.hostname()}:${port}${pathname}`),
            encodeURI(`${proto}://localhost:${port}${pathname}`),
        ];
        console.log('Listening on:\n\t' + nameList.join(' '));
        if (ipv4List.length) {
            console.log('\t' + ipv4List.join(' '));
        }
        if (ipv6List.length) {
            console.log('\t' + ipv6List.join(' '));
        }
    }
}
