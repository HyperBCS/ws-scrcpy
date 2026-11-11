import KeyboardSVG from '../../public/images/skin-light/ic_keyboard_678_48dp.svg';
import MoreSVG from '../../public/images/skin-light/ic_more_horiz_678_48dp.svg';
import CameraSVG from '../../public/images/skin-light/ic_photo_camera_678_48dp.svg';
import PowerSVG from '../../public/images/skin-light/ic_power_settings_new_678_48px.svg';
import VolumeDownSVG from '../../public/images/skin-light/ic_volume_down_678_48px.svg';
import VolumeUpSVG from '../../public/images/skin-light/ic_volume_up_678_48px.svg';
import BackSVG from '../../public/images/skin-light/System_Back_678.svg';
import HomeSVG from '../../public/images/skin-light/System_Home_678.svg';
import OverviewSVG from '../../public/images/skin-light/System_Overview_678.svg';
import SettingsSVG from '../../public/images/buttons/settings.svg';
import TuneSVG from '../../public/images/buttons/tune.svg';
import VolumeOffSVG from '../../public/images/buttons/volume_off.svg';
import MicSVG from '../../public/images/buttons/mic.svg';
import HeadphonesSVG from '../../public/images/buttons/headphones.svg';

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
    SETTINGS,
    // The Settings button on the Android toolbar. SETTINGS is the one on the iPhone toolbar.
    TUNE,
    VOLUME_OFF,
    // Siri on the iOS toolbar. OVERVIEW is Android's Overview key; iOS has no equivalent that
    // can be driven from here, so nothing on that toolbar uses it.
    MIC,
    // Listen (this browser's playback). The speaker icons belong to the phone's own volume keys.
    HEADPHONES,
}

export default class SvgImage {
    static Icon = Icon;

    // The inline SVG markup for an icon. Only `create()` below reads it.
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
            case Icon.SETTINGS:
                return SettingsSVG;
            case Icon.TUNE:
                return TuneSVG;
            case Icon.VOLUME_OFF:
                return VolumeOffSVG;
            case Icon.MIC:
                return MicSVG;
            case Icon.HEADPHONES:
                return HeadphonesSVG;
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
