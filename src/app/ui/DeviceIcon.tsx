import { Icon } from './Icon';
import '../../style/ui/DeviceIcon.css';

/** The tile that stands for a phone. It is decorative: the name beside it says which phone. */
export function DeviceIcon({ className = '' }: { className?: string }) {
    return (
        <span class={`device-icon ${className}`.trim()} aria-hidden="true">
            <Icon name="phone" />
        </span>
    );
}
