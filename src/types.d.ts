declare interface TestSuiteConfigOptions {
    testId?: string;
    suiteIds?: string[];
    numberOfTry?: number;
    testSuite?: string;
    serverURL: string;
    headless: boolean;
    failfast: boolean;
    onlyLastStats: boolean;
    mobileEmulation: boolean;
    promptForRetry: boolean;
    debug: boolean,
    authCookie: AuthCookie;
    workers?: number;
    testsPerWorker?: number;
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
