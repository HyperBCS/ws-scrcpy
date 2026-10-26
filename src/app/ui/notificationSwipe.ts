export type NotificationSwipeLock = 'pending' | 'horizontal' | 'vertical';
export type NotificationSwipeAction = 'read' | 'dismiss';
export interface NotificationSwipeState {
    offset: number;
    locked: NotificationSwipeLock;
}

interface Gesture extends NotificationSwipeState {
    x: number;
    y: number;
    pointerId: number;
    threshold: number;
    width: number;
    lastX: number;
    lastTime: number;
    velocity: number;
}

/** Geometry only: the caller owns pointer capture, touch-action, and app mutations. */
export class NotificationSwipe {
    private gesture?: Gesture;
    private pointers = new Set<number>();
    private blocked = false;
    public releaseVelocity = 0;

    get pointerId(): number | null {
        return this.gesture?.pointerId ?? null;
    }

    start(x: number, y: number, pointerId: number, width: number): boolean {
        // iOS Home Screen apps can report signed negative pointer/touch IDs.
        // These are opaque identifiers, not positive indexes.
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isInteger(pointerId)) {
            this.cancel();
            return false;
        }
        // Duplicate pointerdown events must not move the gesture's origin.
        if (this.pointers.has(pointerId)) return false;
        this.pointers.add(pointerId);
        if (this.blocked || this.gesture || this.pointers.size > 1) {
            this.gesture = undefined;
            this.blocked = true;
            return false;
        }
        const measuredWidth = Number.isFinite(width) && width > 0 ? width : 256;
        this.releaseVelocity = 0;
        this.gesture = {
            x,
            y,
            pointerId,
            offset: 0,
            locked: 'pending',
            threshold: Math.max(56, Math.min(88, measuredWidth * 0.25)),
            width: measuredWidth,
            lastX: x,
            lastTime: performance.now(),
            velocity: 0,
        };
        return true;
    }

    move(x: number, y: number, pointerId: number): NotificationSwipeState {
        const gesture = this.gesture;
        // Never report horizontal intent for an unrelated pointer: callers use
        // this result to decide whether to capture that specific pointer.
        if (!gesture || gesture.pointerId !== pointerId) return { offset: 0, locked: 'pending' };
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            this.cancel();
            return { offset: 0, locked: 'pending' };
        }
        const dx = x - gesture.x;
        const dy = y - gesture.y;
        if (gesture.locked === 'pending') {
            if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) gesture.locked = 'vertical';
            else if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.35) gesture.locked = 'horizontal';
        }
        const now = performance.now();
        const elapsed = now - gesture.lastTime;
        if (elapsed > 0) gesture.velocity = Math.max(-3, Math.min(3, (x - gesture.lastX) / elapsed));
        gesture.lastX = x;
        gesture.lastTime = now;
        // Track the finger across the entire card. Resistance only starts beyond its edge.
        const distance = Math.abs(dx);
        const offset = distance <= gesture.width ? distance : gesture.width + Math.sqrt(distance - gesture.width) * 3;
        gesture.offset = gesture.locked === 'horizontal' ? Math.sign(dx) * offset : 0;
        return { offset: gesture.offset, locked: gesture.locked };
    }

    end(x: number, y: number, pointerId: number): NotificationSwipeAction | null {
        const gesture = this.gesture;
        let action: NotificationSwipeAction | null = null;
        if (gesture?.pointerId === pointerId) {
            this.releaseVelocity = performance.now() - gesture.lastTime < 80 ? gesture.velocity : 0;
            // Only a move may establish horizontal intent. A tap or an unmatched
            // pointerup must never initiate an action by itself.
            const dx = x - gesture.x;
            if (
                Number.isFinite(x) &&
                Number.isFinite(y) &&
                gesture.locked === 'horizontal' &&
                Math.abs(dx) >= gesture.threshold
            )
                action = dx > 0 ? 'read' : 'dismiss';
            this.gesture = undefined;
        }
        this.pointers.delete(pointerId);
        if (!this.pointers.size) this.blocked = false;
        return action;
    }

    cancel(): void {
        this.gesture = undefined;
        this.pointers.clear();
        this.blocked = false;
    }
}
