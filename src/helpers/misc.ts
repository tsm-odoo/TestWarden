export class Deferred<T> extends Promise<T> {
  #resolve!: (value: T | PromiseLike<T>) => void;
  #reject!: (reason?: unknown) => void;

  constructor(executor?: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void) => void) {
    let _resolve!: (value: T | PromiseLike<T>) => void;
    let _reject!: (reason?: unknown) => void;

    super((resolve, reject) => {
      _resolve = resolve;
      _reject = reject;
      return executor?.(resolve, reject);
    });

    this.#resolve = _resolve;
    this.#reject = _reject;
  }

  reject(reason?: unknown) {
    return this.#reject(reason);
  }

  resolve(value: T) {
    return this.#resolve(value);
  }
}

export function uuid() {
  return `${Math.random().toString(36).substring(2, 15)}`.toUpperCase();
}
