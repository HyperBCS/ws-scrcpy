import { Service } from './services/Service';

/** Child processes that have to finish their own shutdown before Node may exit. */
export interface ShutdownWaiter {
    /** Whether any of them is still running. */
    pending(): boolean;
    /** Resolves when all of them have closed. */
    closed(): Promise<void>;
    /** The longest their shutdown is allowed to take. */
    budgetMs(): number;
}

/**
 * Stops the services once, in reverse start order, whatever ends the process: a signal, a crash
 * or a failed start. Then it waits for the children the services left shutting down.
 *
 * The wait matters for the iPhone sessions. serve-web returns the phone's display sessions in
 * its own orderly shutdown, which takes seconds on a slow phone, and in Docker every child dies
 * with SIGKILL the moment Node (PID 1) exits. A burst of sessions killed that way wedges the
 * phone's display service until it is rebooted (docs/HANDOFF.md).
 */
export class Shutdown {
    /** How long Node may keep running once the services are released and the children closed. */
    public static EXIT_BACKSTOP_MS = 3000;
    private stopping = false;
    private crashed = false;
    private readonly waiters: ShutdownWaiter[] = [];

    constructor(private readonly services: Service[]) {}

    public isStopping(): boolean {
        return this.stopping;
    }

    public addWaiter(waiter: ShutdownWaiter): void {
        this.waiters.push(waiter);
    }

    /** Registers the signal and crash handlers on `process`. */
    public install(): void {
        process.on('SIGINT', () => this.onSignal('SIGINT'));
        process.on('SIGTERM', () => this.onSignal('SIGTERM'));
        // nodemon restarts with SIGUSR2 and starts the next server when this one has died. The
        // signal is passed on only after the children have closed, so the next server does not
        // start a session on a phone whose previous one is still shutting down.
        process.once('SIGUSR2', () => {
            this.onSignal('SIGUSR2');
            void this.childrenClosed().then(() => process.kill(process.pid, 'SIGUSR2'));
        });
        // Without these two, Node exits on the spot and the children get no time at all.
        process.on('uncaughtException', (error) => this.onCrash('Uncaught exception', error));
        process.on('unhandledRejection', (reason) => this.onCrash('Unhandled rejection', reason));
    }

    public onSignal(signal: string): void {
        console.log(`\nReceived signal ${signal}`);
        if (!this.stopping) {
            this.stop();
            return;
        }
        if (this.pending()) {
            // Exiting now would cut the children off mid-shutdown; `stop()` set a deadline.
            console.log('Still waiting for the phone sessions to stop');
            return;
        }
        console.log('Force exit');
        process.exit(0);
    }

    /** A failed start: stops whatever did start. Node then exits on its own with code 1. */
    public onStartupFailure(error: unknown): void {
        console.error(Shutdown.describe(error));
        process.exitCode = 1;
        if (!this.stopping) {
            this.stop();
        }
    }

    private onCrash(kind: string, cause: unknown): void {
        console.error(`${kind}: ${Shutdown.describe(cause)}`);
        process.exitCode = 1;
        if (this.crashed) {
            // A second failure while stopping changes nothing; the first one's exit is on its way.
            return;
        }
        this.crashed = true;
        if (!this.stopping) {
            this.stop();
        }
        // With a handler installed Node no longer exits by itself after an uncaught exception.
        void this.childrenClosed().then(() => process.exit(1));
    }

    private stop(): void {
        this.stopping = true;
        [...this.services].reverse().forEach((service: Service) => {
            const serviceName = service.getName();
            console.log(`Stopping ${serviceName} ...`);
            try {
                service.release();
            } catch (error) {
                console.error(`Failed to stop ${serviceName}`, error);
                process.exitCode = 1;
            }
        });
        if (this.pending()) {
            // Node exits by itself when the children have closed. This covers one that never does.
            const deadline = setTimeout(() => {
                console.error('The phone sessions did not stop in time; exiting');
                process.exit();
            }, this.budgetMs());
            deadline.unref();
        }
        // Every service has been released and the children are given their time. Anything that
        // still keeps Node running after that (a socket or a child some service left open) would
        // hold the process until Docker kills it at the end of its grace period.
        void this.childrenClosed().then(() => {
            const backstop = setTimeout(() => {
                console.error('Still running after shutdown; exiting');
                process.exit();
            }, Shutdown.EXIT_BACKSTOP_MS);
            backstop.unref();
        });
    }

    private pending(): boolean {
        return this.waiters.some((waiter) => waiter.pending());
    }

    private budgetMs(): number {
        return Math.max(0, ...this.waiters.map((waiter) => waiter.budgetMs()));
    }

    /** Resolves when every child has closed, or when their budget has run out. */
    private childrenClosed(): Promise<void> {
        if (!this.pending()) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const deadline = setTimeout(resolve, this.budgetMs());
            void Promise.all(this.waiters.map((waiter) => waiter.closed())).then(() => {
                clearTimeout(deadline);
                resolve();
            });
        });
    }

    private static describe(cause: unknown): string {
        return cause instanceof Error ? cause.stack || cause.message : String(cause);
    }
}
