// The stream service line now comes from `phoneStatus.ts`. This file keeps the older import path
// working.
export { getStreamServiceStatus, hasRunningStreamService } from './phoneStatus';
export type { StreamServiceInfo, StreamServiceState } from './phoneStatus';
