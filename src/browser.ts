import { Deferred } from "@warden/helpers/misc.js";
import { formatter } from "@warden/helpers/terminal.js";
import { TestSuiteConfig } from "@warden/test_suite_config";

import { exec } from "child_process";
import { oraPromise } from "ora";
import puppeteer, {
    Browser,
    CDPSession,
    Page,
    Protocol,
    PuppeteerLaunchOptions,
    ResponseForRequest,
} from "puppeteer";
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
    "--blink-settings=imagesEnabled=false",
    "--disable-features=PaintHolding",
    "--single-process",
    "--disable-software-rasterizer",
    "--disable-translate",
    // "--js-flags=--expose_gc",
    "--no-sandbox",
    `--window-size=1366,768`, // Same as RunBot
];

const browsers: WeakRef<Browser>[] = [];
const clients: WeakRef<CDPSession>[] = [];
let debuggingPort = 9222;
let launchDeferred;
let setupCacheDeferred;
export async function launch(options: PuppeteerLaunchOptions) {
    launchDeferred = new Deferred();
    const port = debuggingPort++;
    try {
        await execPromise(`kill -9 $(lsof -i4TCP:${port} -sTCP:LISTEN -t)`);
    } catch {}
    const browser = await puppeteer.launch({
        ...options,
        args: [...CHROME_OPTIONS, `--remote-debugging-port=${port}`],
        defaultViewport: null,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
    });
    browsers.push(new WeakRef(browser));
    launchDeferred.resolve();
    return browser;
}

export async function cleanup() {
    await oraPromise(
        async () => {
            await Promise.all([setupCacheDeferred, launchDeferred]);
            await Promise.all(
                clients.map((c) =>
                    c
                        .deref()
                        .detach()
                        .catch(() => {}),
                ),
            );
            await Promise.all(
                browsers.map((b) =>
                    b
                        .deref()
                        .close()
                        .catch(() => {}),
                ),
            );
        },
        {
            text: formatter.info("Cleaning up browsers and network caches"),
            successText: formatter.info("Browsers and network caches cleaned up"),
            failText: (e) =>
                formatter.error("Failed to clean up browsers, network caches:", e.message),
        },
    );
}

const cache: { [pathname: string]: Partial<ResponseForRequest> } = {};
const allDepsRoute = "/ir.module.module.dependency/all_dependencies";
const allDepsCache = {};

function addHeader(
    ogHeaders: Protocol.Fetch.HeaderEntry[],
    headers: [key: string, value: string][],
): Protocol.Fetch.HeaderEntry[] {
    for (const [key, value] of headers) {
        const headerIdx = ogHeaders.findIndex((h) => h.name.toLowerCase() === key.toLowerCase());
        if (headerIdx === -1) {
            ogHeaders.push({ name: key, value });
        } else {
            ogHeaders[headerIdx].value = value;
        }
    }
    return ogHeaders;
}

const chromeCacheResourceTypes: Protocol.Network.ResourceType[] = [
    "Stylesheet",
    "Image",
    "Media",
    "Font",
    "Script",
];

/**
 * Cache responses to speed up reload time. Ideally, the browser should use the
 * memory cache which is faster.
 */
export async function setupCache(page: Page, config: TestSuiteConfig) {
    setupCacheDeferred = new Deferred();
    const client = await page.target().createCDPSession();
    clients.push(new WeakRef(client));
    await client.send("Network.disable");
    await client.send("Fetch.enable");
    client.on("Fetch.requestPaused", async (event) => {
        const { requestId } = event;
        if (!event.responseStatusCode) {
            await client.send("Fetch.continueRequest", { requestId, interceptResponse: true });
            return;
        }
        await client.send("Fetch.continueResponse", {
            requestId,
            responseCode: event.responseStatusCode,
            responseHeaders: addHeader(event.responseHeaders, [
                ["Cache-Control", "private, max-age=31536000"],
            ]),
            responsePhrase: event.responseStatusText,
        });
    });
    await page.setRequestInterception(true);
    page.off("request");
    page.off("response");
    page.on("request", async (request) => {
        const url = new URL(request.url());
        if (url.pathname === allDepsRoute) {
            const { params } = JSON.parse(await request.fetchPostData());
            const cachedResponse = allDepsCache[JSON.stringify(params.kwargs.module_names)];
            if (cachedResponse) {
                return request.respond(cachedResponse);
            }
        }
        const type = request.resourceType();
        if (chromeCacheResourceTypes.map((t) => t.toLowerCase()).includes(type)) {
            return request.continue();
        }
        if (url.pathname in cache) {
            request.respond(cache[url.pathname]);
            return;
        }

        request.continue();
    });
    page.on("response", async (response) => {
        const url = new URL(response.url());
        const type = response.request().resourceType();
        if (
            url.pathname in cache ||
            chromeCacheResourceTypes.map((t) => t.toLowerCase()).includes(type)
        ) {
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
            headers: Object.assign(response.headers(), { FROM_LOCAL_CACHE: true }),
            body: buffer,
        };
        if (url.pathname === allDepsRoute) {
            const { params } = JSON.parse(await response.request().fetchPostData());
            allDepsCache[JSON.stringify(params.kwargs.module_names)] = cachedResponse;
        } else {
            cache[url.pathname] = cachedResponse;
        }
    });
    setupCacheDeferred.resolve();
}
