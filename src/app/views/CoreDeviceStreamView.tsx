import { ComponentChildren } from 'preact';
import { ParamsStreamCoreDevice } from '../../types/ParamsStreamCoreDevice';
import { useIphoneScreen } from './screen/iphone';
import { ScreenView } from './ScreenView';

interface CoreDeviceStreamViewProps {
    params: ParamsStreamCoreDevice;
    /** The tab strip of the phone's page. An iPhone has one view, so it gets none today. */
    tabs?: ComponentChildren;
}

/**
 * The screen of an iPhone: `ScreenView` with the iPhone adapter. Kept under this name because
 * `App.tsx` imports this file for the order of the stylesheets in the bundle.
 */
export function CoreDeviceStreamView({ params, tabs }: CoreDeviceStreamViewProps) {
    return <ScreenView params={params} useScreen={useIphoneScreen} tabs={tabs} />;
}
