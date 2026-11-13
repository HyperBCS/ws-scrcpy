/** Small request guards. Objects keep unknown fields for older and newer pages. */
export type Schema<T> = (value: unknown) => value is T;
type Value<S> = S extends Schema<infer T> ? T : never;

export const boolean: Schema<boolean> = (value): value is boolean => typeof value === 'boolean';

export function text(max = Infinity, min = 0, pattern?: RegExp): Schema<string> {
    return (value): value is string =>
        typeof value === 'string' && value.length >= min && value.length <= max && (!pattern || pattern.test(value));
}

export function optional<T>(schema: Schema<T>): Schema<T | undefined> {
    return (value): value is T | undefined => value === undefined || schema(value);
}

export function array<T>(schema: Schema<T>, max = Infinity, min = 0): Schema<T[]> {
    return (value): value is T[] =>
        Array.isArray(value) && value.length >= min && value.length <= max && value.every(schema);
}

export function object<S extends Record<string, Schema<unknown>>>(fields: S): Schema<{ [K in keyof S]: Value<S[K]> }> {
    return (value): value is { [K in keyof S]: Value<S[K]> } =>
        !!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.entries(fields).every(([key, schema]) => schema((value as Record<string, unknown>)[key]));
}

export function validate<T>(schema: Schema<T>, value: unknown, message: string): T {
    if (!schema(value)) throw Error(message);
    return value;
}
