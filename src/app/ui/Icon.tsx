import { ICON_ATTRIBUTES, ICONS, IconName, IconSize } from './icons';
import '../../style/kit/Icon.css';

interface IconProps {
    name: IconName;
    size?: IconSize;
}

/** One icon of the set in `icons.ts`. It is decorative: the control it sits in carries the name. */
export function Icon({ name, size = 24 }: IconProps) {
    return (
        <svg {...ICON_ATTRIBUTES} width={size} height={size}>
            <path d={ICONS[name]} />
        </svg>
    );
}
