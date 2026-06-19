declare interface TestSuiteConfigOptions {
  verbose?: boolean;
  devtools?: boolean;
  once: boolean;
  debug?: boolean;
  visible?: boolean;
  test?: string;
  workers?: number;
  minWorkerLoad?: number;
  suiteNames?: string[];
  suite?: string;
  serverUrl?: string;
  failFast: boolean;
  runForever: boolean;
  mobile: boolean;
  cpuLimit?: number;
  cpuThrottling: number;
}

declare type AuthCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
};


declare type HootTag = { id: string };
declare type HootJob = {
  id: string;
  name: string;
  fullName: string;
  tags: HootTag[];
  constructor: { name: string };
  jobs?: HootJob[];
};
declare type HootTestEntry = { id: string; fullName: string; tags: HootTag[] };
declare type HootSuiteEntry = HootJob & { weight: number };
declare type HootTestContext = {
  id: string;
  fullName: string;
  results(): Array<{ pass: boolean; duration: number }>;
};
declare interface HootRunner {
  tests: { values(): IterableIterator<HootTestEntry> };
  suites: { values(): IterableIterator<HootSuiteEntry> };
  beforeEach(callback: (test: HootTestContext) => void, options?: { global?: boolean }): void;
  afterPostTest(callback: (test: HootTestContext) => void, options?: { global?: boolean }): void;
  afterAll(callback: () => void): void;
  config: { debugTest(): boolean };
}
declare interface OdooHootModule {
  __debug__(): HootRunner;
}
declare interface OdooLoader {
  modules: { get(name: string): OdooHootModule | undefined };
}


declare type WardenTestResult = { id: string; name: string; pass: boolean; duration: number };
declare type WardenCurrentTest = { id: string; name: string };


declare interface Window {
odoo: { loader: OdooLoader };
  beforeEach: (test: WardenCurrentTest) => void;
  afterEach: (result: WardenTestResult) => void;
  afterAll: () => void | Promise<void>;
  updateNodeState: (data: {
    currentTest: WardenCurrentTest | null;
    results: WardenTestResult[];
  }) => void;
}

declare module "nodeaffinity";
