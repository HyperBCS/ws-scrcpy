import KeyboardSVG from '../../public/images/skin-light/ic_keyboard_678_48dp.svg';
import MoreSVG from '../../public/images/skin-light/ic_more_horiz_678_48dp.svg';
import CameraSVG from '../../public/images/skin-light/ic_photo_camera_678_48dp.svg';
import PowerSVG from '../../public/images/skin-light/ic_power_settings_new_678_48px.svg';
import VolumeDownSVG from '../../public/images/skin-light/ic_volume_down_678_48px.svg';
import VolumeUpSVG from '../../public/images/skin-light/ic_volume_up_678_48px.svg';
import BackSVG from '../../public/images/skin-light/System_Back_678.svg';
import HomeSVG from '../../public/images/skin-light/System_Home_678.svg';
import OverviewSVG from '../../public/images/skin-light/System_Overview_678.svg';
import CancelSVG from '../../public/images/buttons/cancel.svg';
import OfflineSVG from '../../public/images/buttons/offline.svg';
import RefreshSVG from '../../public/images/buttons/refresh.svg';
import SettingsSVG from '../../public/images/buttons/settings.svg';
import MenuSVG from '../../public/images/buttons/menu.svg';
import ArrowBackSVG from '../../public/images/buttons/arrow_back.svg';
import ToggleOnSVG from '../../public/images/buttons/toggle_on.svg';
import ToggleOffSVG from '../../public/images/buttons/toggle_off.svg';
import TuneSVG from '../../public/images/buttons/tune.svg';
import VolumeOffSVG from '../../public/images/buttons/volume_off.svg';
import MicSVG from '../../public/images/buttons/mic.svg';

export enum Icon {
    BACK,
    HOME,
    OVERVIEW,
    POWER,
    VOLUME_UP,
    VOLUME_DOWN,
    MORE,
    CAMERA,
    KEYBOARD,
    CANCEL,
    OFFLINE,
    REFRESH,
    SETTINGS,
    MENU,
    ARROW_BACK,
    TOGGLE_ON,
    TOGGLE_OFF,
    // "Stream settings" (the video/audio quality sheet) -- distinct from SETTINGS, which the
    // "Tools" button already owns (capture-keyboard + the more-box).
    TUNE,
    VOLUME_OFF,
    // Siri on the iOS toolbar. OVERVIEW is Android's Overview key; iOS has no equivalent that
    // can be driven from here, so nothing on that toolbar uses it.
    MIC,
}

export default class SvgImage {
    static Icon = Icon;

    // For JSX views, which render the markup themselves (`dangerouslySetInnerHTML`) instead of
    // going through `create()`'s DOM-node construction below.
    public static getSvgString(type: Icon): string {
        switch (type) {
            case Icon.KEYBOARD:
                return KeyboardSVG;
            case Icon.MORE:
                return MoreSVG;
            case Icon.CAMERA:
                return CameraSVG;
            case Icon.POWER:
                return PowerSVG;
            case Icon.VOLUME_DOWN:
                return VolumeDownSVG;
            case Icon.VOLUME_UP:
                return VolumeUpSVG;
            case Icon.BACK:
                return BackSVG;
            case Icon.HOME:
                return HomeSVG;
            case Icon.OVERVIEW:
                return OverviewSVG;
            case Icon.CANCEL:
                return CancelSVG;
            case Icon.OFFLINE:
                return OfflineSVG;
            case Icon.REFRESH:
                return RefreshSVG;
            case Icon.SETTINGS:
                return SettingsSVG;
            case Icon.MENU:
                return MenuSVG;
            case Icon.ARROW_BACK:
                return ArrowBackSVG;
            case Icon.TOGGLE_ON:
                return ToggleOnSVG;
            case Icon.TOGGLE_OFF:
                return ToggleOffSVG;
            case Icon.TUNE:
                return TuneSVG;
            case Icon.VOLUME_OFF:
                return VolumeOffSVG;
            case Icon.MIC:
                return MicSVG;
            default:
                return '';
        }
    }
    public static create(type: Icon): Element {
        const dummy = document.createElement('div');
        dummy.innerHTML = this.getSvgString(type);
        const svg = dummy.children[0];
        const titles = svg.getElementsByTagName('title');
        for (let i = 0, l = titles.length; i < l; i++) {
            svg.removeChild(titles[i]);
        }
        return svg;
    }
}
