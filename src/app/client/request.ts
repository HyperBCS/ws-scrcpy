/** A request ends on navigation or timeout instead of leaving a control busy indefinitely. */
export async function requestJson<T>(url: string, options: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, 10000);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.error || `Request failed (${response.status})`);
        }
        return result as T;
    } catch (error) {
        if (timedOut)
            throw Object.assign(new Error('The server took too long to respond. Try again.'), { cause: error });
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}
