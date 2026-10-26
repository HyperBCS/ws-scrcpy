import { Service, ServiceClass } from './Service';

/** Start in dependency order and retain every instance for partial-start cleanup. */
export async function startServices(
    classes: ServiceClass[],
    running: Service[],
    isStopping: () => boolean,
): Promise<void> {
    for (const serviceClass of classes) {
        if (isStopping()) return;
        const service = serviceClass.getInstance();
        running.push(service);
        await service.start();
        if (isStopping()) {
            service.release();
            return;
        }
    }
}
