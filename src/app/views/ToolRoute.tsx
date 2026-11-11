import { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { DeviceEntry, findDeviceByUdid, findDeviceWithoutTools } from '../state/devices';
import { deviceTools, ToolView } from './ToolView';
import { ToolUnavailable } from './ToolUnavailable';
import '../../style/views/ToolUnavailable.css';

/** How long a tool link for a serial that is not listed yet waits for the device list. */
const TOOL_IDENTIFY_MS = 1500;

interface Decision {
    udid: string;
    /** The iPhone the link named. Kept, so the page stays as it is if that iPhone drops out. */
    refused?: DeviceEntry;
}

interface ToolRouteProps {
    params: URLSearchParams;
    /** Whether this tool's tab is the one shown. See `ToolView`. */
    active: boolean;
    tabs: (status: ComponentChildren) => ComponentChildren;
}

/**
 * The Files or Shell tab of a phone's page. Both tools run over adb, so a link that names an
 * iPhone gets an explanation and no tool: the server would run adb with the iPhone's UDID and
 * could only fail.
 *
 * A reloaded or typed link arrives before the device list. The tool then waits until the serial
 * is listed (at most `TOOL_IDENTIFY_MS`), so it is not started for an iPhone and torn down
 * again. Once a tool is open it stays open: a device that disconnects keeps its page and that
 * page's own lost-connection state.
 */
export function ToolRoute({ params, active, tabs }: ToolRouteProps) {
    const udid = params.get('udid') || '';
    const withoutTools = findDeviceWithoutTools(udid);
    const known = !!findDeviceByUdid(udid);
    const [decision, setDecision] = useState<Decision>();
    const current = decision?.udid === udid ? decision : undefined;

    useEffect(() => {
        if (withoutTools) {
            if (!current?.refused) {
                setDecision({ udid, refused: withoutTools });
            }
            return;
        }
        if (current) {
            return;
        }
        if (known) {
            setDecision({ udid });
            return;
        }
        const timer = setTimeout(() => setDecision({ udid }), TOOL_IDENTIFY_MS);
        return () => clearTimeout(timer);
    }, [udid, current, known, withoutTools]);

    const refused = current?.refused ?? withoutTools;
    if (refused) {
        const tool = deviceTools.find((item) => item.action === params.get('action'));
        return active ? <ToolUnavailable entry={refused} tool={tool?.title || 'This tool'} /> : null;
    }
    if (!current && !known) {
        return active ? <main class="tool-unavailable" aria-busy="true" /> : null;
    }
    return <ToolView params={params} active={active} tabs={tabs} />;
}
