export interface Message<T = unknown> {
    id: number;
    type: string;
    data: T;
}
