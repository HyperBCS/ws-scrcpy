// The status of a phone now comes from `phoneStatus.ts`, one model for both kinds of phone. This
// file keeps the older import path working.
export {
    clearStarting,
    getDeviceProblems,
    getDeviceStatusInfo,
    isDeviceStarting,
    listSummary,
    markStarting,
    needsAttention,
} from './phoneStatus';
export type { DeviceProblem, PhoneStatus as DeviceStatusInfo, PhoneStatusKind as DeviceStatus } from './phoneStatus';
