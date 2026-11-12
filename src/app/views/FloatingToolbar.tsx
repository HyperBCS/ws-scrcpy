import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import '../../style/views/FloatingToolbar.css';
import { ControlPanel } from '../controls/ControlPanel';
import { ControlRail } from '../controls/ControlRail';
import type { PhoneControls } from '../controls/definition';

// Width alone misclassifies both wide iPads and narrow desktop browser windows.
const MOBILE_CONTROLS_QUERY = '(hover: none) and (pointer: coarse)';

/** What the controls need from a stream client: its platform's actions (`controls/`). */
export interface ToolbarClient {
    getControls(): PhoneControls | undefined;
}

interface FloatingToolbarProps {
    client: ToolbarClient;
}

/**
 * The controls of a phone's screen. A touch screen gets the floating button and its panel
 * (`ControlPanel`), a window with a mouse the rail beside the picture (`ControlRail`). Both draw
 * the one definition in `controls/definition.ts`.
 */
export function FloatingToolbar({ client }: FloatingToolbarProps) {
    const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_CONTROLS_QUERY).matches);

    useLayoutEffect(() => {
        // Connecting a mouse can change the control layout without changing window dimensions.
        // Notify the client's existing debounced resize path after the sidebar space changes.
        window.dispatchEvent(new Event('resize'));
    }, [mobile]);

    useEffect(() => {
        const media = window.matchMedia(MOBILE_CONTROLS_QUERY);
        const update = () => setMobile(media.matches);
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);

    const controls = client.getControls();
    if (!controls) {
        return null;
    }
    return mobile ? <ControlPanel controls={controls} /> : <ControlRail controls={controls} />;
}
