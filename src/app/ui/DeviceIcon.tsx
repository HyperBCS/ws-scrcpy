import '../../style/ui/DeviceIcon.css';

/** Shared decorative device avatar; the adjacent device name supplies its accessible label. */
export function DeviceIcon({ className = '' }: { className?: string }) {
    return (
        <span class={`device-icon ${className}`} aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" focusable="false">
                <rect x="6" y="2.5" width="12" height="19" rx="3" />
                <path d="M10 5h4M10 18.5h4" />
            </svg>
        </span>
    );
}
