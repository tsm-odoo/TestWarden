import { TestSuiteConfig } from "@warden/test_suite_config";

import puppeteer, { Browser, Page, PuppeteerLaunchOptions } from "puppeteer";
import { intercept, patterns, InterceptionHandler } from "puppeteer-interceptor";
import { exec } from "child_process";
import { promisify } from "util";

const execPromise = promisify(exec);

export const CHROME_OPTIONS = [
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-namespace-sandbox",
    "--disable-client-side-phishing-detection",
    "--disable-crash-reporter",
    "--disable-default-apps",
    "--disable-device-discovery-notifications",
    "--disable-accelerated-2d-canvas",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--no-first-run",
    "--no-zygote",
    "--single-process",
    "--disable-translate",
    "--no-sandbox",
    `--window-size=1366,768`, // Same as RunBot
];

const browsers: WeakRef<Browser>[] = [];
let debuggingPort = 9222;
export async function launch(options: PuppeteerLaunchOptions) {
    const port = debuggingPort++;
    try {
        await execPromise(`kill -9 $(lsof -i4TCP:${port} -sTCP:LISTEN -t)`);
    } catch {}
    const browser = await puppeteer.launch({
        ...options,
        args: [...CHROME_OPTIONS, `--remote-debugging-port=${port}`],
        defaultViewport: null,
    });
    browsers.push(new WeakRef(browser));
    return browser;
}

export async function cleanup() {
    await Promise.all(browsers.map((b) => b.deref()?.close()));
    interceptHandler?.disable();
}

const cache = {};
const allDepsRoute = "/ir.module.module.dependency/all_dependencies";
const allDepsCache = {};

function useChromeCache(reqType: string) {
    // Puppeteer do not provide any way to ammend a response. Caching file
    // responses locally is not an option, it consumes a lot of memory and it is
    // very slow to answer a request from a large buffer (300-400ms). Add the
    // cache control using the devtool protocol and ignore those requests in
    // order to let Chrome handle it.
    return ["script", "stylesheet", "font", "image"].includes(reqType.toLowerCase());
}

let interceptHandler: InterceptionHandler;
/**
 * Cache responses to speed up reload time. Ideally, the browser should use the
 * memory cache which is faster.
 */
export async function setupCache(page: Page, config: TestSuiteConfig) {
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
        const type = request.resourceType();
        if (useChromeCache(type)) {
            return request.continue();
        }
        const url = request.url().includes(config.baseSuiteURL)
            ? config.baseSuiteURL
            : request.url();
        if (url in cache) {
            await request.respond(cache[url]);
        } else if (url.includes(allDepsRoute)) {
            const { params } = JSON.parse(await request.fetchPostData());
            if (JSON.stringify(params.kwargs.module_names) in allDepsCache) {
                await request.respond(allDepsCache[JSON.stringify(params.kwargs.module_names)]);
            } else {
                request.continue();
            }
        } else {
            request.continue();
        }
    });
    page.on("response", async (response) => {
        const url = response.request().url().includes(config.baseSuiteURL)
            ? config.baseSuiteURL
            : response.request().url();
        if (url in cache || useChromeCache(response.request().resourceType())) {
            return;
        }
        let buffer;
        try {
            buffer = await response.buffer();
        } catch (error) {
            return;
        }
        const cachedResponse = {
            status: response.status(),
            headers: Object.assign(response.headers(), { DEBUG_FROM_LOCAL_CACHE: true }),
            body: buffer,
        };
        if (url.includes(allDepsRoute)) {
            const { params } = JSON.parse(await response.request().fetchPostData());
            allDepsCache[JSON.stringify(params.kwargs.module_names)] = cachedResponse;
            return;
        }
        cache[url] = cachedResponse;
    });
    interceptHandler = await intercept(page, patterns.All("*"), {
        onResponseReceived: (event) => {
            const cacheControlIdx = event.response.headers.findIndex(
                ({ name }) => name === "Cache-Control",
            );
            if (cacheControlIdx !== -1) {
                event.response.headers[cacheControlIdx].value = "public, max-age=31536000";
            } else {
                event.response.headers.push({
                    name: "Cache-Control",
                    value: "public, max-age=31536000",
                });
            }
            return event.response;
        },
    });
}
