declare interface TestSuiteConfigOptions {
    debug?: boolean;
    "test-id"?: string;
    workers?: number;
    "tests-per-worker"?: number;
    "suite-names"?: string[];
    suite?: string;
    "server-url"?: string;
    visible?: boolean;
    "fail-fast"?: boolean;
    "only-last-stats"?: boolean;
    mobile?: boolean;
    "prompt-for-retry"?: boolean;
    "open-fail-folder"?: boolean;
    "run-forever": boolean;
}

declare type AuthCookie = {
    name: string;
    value: string;
    domain: string;
    path: string;
}

declare interface Window {
    QUnit: any,
    originalQUnitStart: any,
    odoo: any,
    owl: any,
    afterEach: any;
    beforeEach: any;
    afterAll: any;
    getQUnitData: Function,
}
