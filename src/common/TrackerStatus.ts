/** The type of the message a device tracker sends when its source of devices goes down or returns. */
export const TRACKER_STATUS = 'tracker_status';

export interface TrackerStatus {
    /** The tracker's id and name, as in the device list messages. */
    id: string;
    name: string;
    /** Android: whether the server can reach adb. */
    available: boolean;
}
