export class Deferred<T> extends Promise<T> {
    #resolve: typeof Promise.resolve<T>;
    #reject: typeof Promise.reject<T>;

    constructor(executor?) {
        let _resolve, _reject;

        super((resolve, reject) => {
            _resolve = resolve;
            _reject = reject;
            return executor?.(resolve, reject);
        });

        this.#resolve = _resolve;
        this.#reject = _reject;
    }

    reject(reason) {
        return this.#reject(reason);
    }

    resolve(value: T) {
        return this.#resolve(value);
    }
}

export function uuid() {
    return `${Math.random().toString(36).substring(2, 15)}`.toUpperCase();
}
