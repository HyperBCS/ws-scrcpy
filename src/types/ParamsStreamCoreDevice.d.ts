import { ACTION } from '../common/Action';
import { ParamsBase } from './ParamsBase';

export interface ParamsStreamCoreDevice extends ParamsBase {
    action: ACTION.STREAM_COREDEVICE;
    udid: string;
    // Defaults on; `?captureKeyboard=0` opts out of forwarding the physical keyboard.
    captureKeyboard?: boolean;
    // Decoder override: `hevc` (WebCodecs) or `mse`; the default picks whatever the browser supports.
    player?: 'hevc' | 'mse';
}
