import { TestSuiteConfig } from "@warden/test_suite_config";

import puppeteer, { Browser, BrowserLaunchArgumentOptions, Page } from "puppeteer";

export const CHROME_OPTIONS = [
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-breakpad",
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
let debuggingPort = 9300;
export async function launch(options: BrowserLaunchArgumentOptions) {
    const browser = await puppeteer.launch({
        ...options,
        args: [...CHROME_OPTIONS, `--remote-debugging-port=${debuggingPort++}`],
        defaultViewport: null,
    });
    browsers.push(new WeakRef(browser));
    return browser;
}

export async function cleanup() {
    await Promise.all(browsers.map((b) => b.deref()?.close()));
}

const cache = {};
const allDepsRoute = "/ir.module.module.dependency/all_dependencies";
const allDepsCache = {};

/**
 * Cache responses to speed up reload time. Ideally, the browser should use the
 * memory cache which is faster.
 */
export async function setupCache(page: Page, config: TestSuiteConfig) {
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
        if (request.resourceType() === "image") {
            request.abort();
            return;
        }
        let url = request.url();
        if (url.includes(config.baseSuiteURL)) {
            url = config.baseSuiteURL;
        }
        if (!url.includes("file:") && url in cache) {
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
        let url = response.url();
        if (url.includes(config.baseSuiteURL)) {
            url = config.baseSuiteURL;
        }
        let buffer;
        try {
            buffer = await response.buffer();
        } catch (error) {
            return;
        }
        const cachedResponse = {
            status: response.status(),
            headers: {
                ...response.headers(),
                "cache-control": "public, max-age=31536000",
            },
            body: buffer,
        };
        if (url.includes(allDepsRoute)) {
            const { params } = JSON.parse(await response.request().fetchPostData());
            allDepsCache[JSON.stringify(params.kwargs.module_names)] = cachedResponse;
            return;
        }
        cache[url] = cachedResponse;
    });
}
