import { ComponentChildren } from 'preact';
import { ParamsStreamScrcpy } from '../../types/ParamsStreamScrcpy';
import { useAndroidScreen } from './screen/android';
import { ScreenView } from './ScreenView';

interface StreamViewProps {
    params: ParamsStreamScrcpy;
    /** The tab strip of the phone's page, drawn under the header. */
    tabs?: ComponentChildren;
}

/**
 * The screen of an Android phone: `ScreenView` with the Android adapter. Kept under this name
 * because `App.tsx` imports this file for the order of the stylesheets in the bundle.
 */
export function StreamView({ params, tabs }: StreamViewProps) {
    return <ScreenView params={params} useScreen={useAndroidScreen} tabs={tabs} />;
}
