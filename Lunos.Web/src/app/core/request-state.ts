export type RequestState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; data: T }
  | { status: 'error'; message: string };

export const idle = <T>(): RequestState<T> => ({ status: 'idle' });
export const loading = <T>(): RequestState<T> => ({ status: 'loading' });
export const loaded = <T>(data: T): RequestState<T> => ({ status: 'loaded', data });
export const failed = <T>(message: string): RequestState<T> => ({ status: 'error', message });
