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

export class Mutex {
    _lock;
    _queueSize;
    _unlockedProm;
    _unlock;

    constructor() {
        this._lock = Promise.resolve();
        this._queueSize = 0;
        this._unlockedProm = undefined;
        this._unlock = undefined;
    }
    /**
     * Add a computation to the queue, it will be executed as soon as the
     * previous computations are completed.
     *
     * @param {() => (void | Promise<void>)} action a function which may return a Promise
     * @returns {Promise<void>}
     */
    async exec(action) {
        this._queueSize++;
        if (!this._unlockedProm) {
            this._unlockedProm = new Promise((resolve) => {
                this._unlock = () => {
                    resolve(true);
                    this._unlockedProm = undefined;
                };
            });
        }
        const always = () => {
            return Promise.resolve(action()).finally(() => {
                if (--this._queueSize === 0) {
                    this._unlock();
                }
            });
        };
        this._lock = this._lock.then(always, always);
        return this._lock;
    }
    /**
     * @returns {Promise<void>} resolved as soon as the Mutex is unlocked
     *   (directly if it is currently idle)
     */
    getUnlockedDef() {
        return this._unlockedProm || Promise.resolve();
    }
}
