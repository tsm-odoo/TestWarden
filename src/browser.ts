import { Deferred, Mutex } from "@warden/helpers/misc.js";
import { formatter } from "@warden/helpers/terminal.js";
import { TestSuiteConfig } from "@warden/test_suite_config";

import { exec } from "child_process";
import { oraPromise } from "ora";
import puppeteer, { Browser, CDPSession, Page, Protocol, PuppeteerLaunchOptions } from "puppeteer";
import { last } from "rxjs";
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
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-accelerated-2d-canvas",
  "--no-first-run",
  "--no-zygote",
  "--blink-settings=imagesEnabled=false",
  "--disable-features=PaintHolding",
  "--disable-software-rasterizer",
  "--disable-translate",
  // "--js-flags=--expose_gc",
  "--no-sandbox",
  `--window-size=1366,768`, // Same as RunBot
];

let latestDebuggingPort = 9222;
async function killPortsInRange(start = 9222, end = 9250) {
    for (let port = start; port <= end; port++) {
        try {
            await execPromise(`fuser -k ${port}/tcp`);
        } catch (err) {
            // Ignore errors if no process is using this port
        }
    }
}

const browsers: Browser[] = [];
const clients: CDPSession[] = [];
let launchDeferred;
let setupCacheDeferred;
export async function launch(options: PuppeteerLaunchOptions) {
  if (latestDebuggingPort === 9222) {
    await killPortsInRange(9222, 9230);
  }
  launchDeferred = new Deferred();
  const port =  ++latestDebuggingPort;
  const browser = await puppeteer.launch({
    ...options,
    args: [...CHROME_OPTIONS, `--remote-debugging-port=${port}`],
    defaultViewport: null,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  browsers.push(browser);
  launchDeferred.resolve();
  return browser;
}

export async function cleanup() {
  await oraPromise(
    async () => {
      killPortsInRange(9222, latestDebuggingPort);
      await Promise.all([setupCacheDeferred, launchDeferred]);
      await Promise.all([
        ...clients.map(
          (c) =>
            c
              ?.detach()
              ?.catch(() => { }),
        ),
        ...browsers.map(
          (b) =>
            b
              ?.close()
              ?.catch(() => { }),
        ),
      ]);
    },
    {
      text: formatter.info("Cleaning up browsers and network caches"),
      successText: formatter.info("Browsers and network caches cleaned up"),
      failText: (e) => formatter.error("Failed to clean up browsers, network caches:", e.message),
    },
  );
}

const cache: {
  [url: string]: { status: number; headers: Protocol.Fetch.HeaderEntry[]; body: Buffer };
} = {};

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

/**
 * Cache responses to speed up reload time.
 * TODO: better caching, especially for document. Check if XHR caching is OK.
 */
export async function setupCache(page: Page, config: TestSuiteConfig) {
  setupCacheDeferred = new Deferred();
  const client = await page.target().createCDPSession();
  clients.push(client);
  await client.send("ServiceWorker.enable");
  await client.send("ServiceWorker.unregister", { scopeURL: config.serverURL });
  await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await client.send("Fetch.enable");

  client.on("Fetch.requestPaused", async (event) => {
    const { requestId } = event;

    let cacheUrl = event.request.url;

    // Cache /web/tests document ignoring query string
    if (event.resourceType === "Document" && event.request.url.includes("/web/tests")) {
      const [base] = event.request.url.split("?");
      cacheUrl = base;
    }

    if (cacheUrl in cache) {
      const cached = cache[cacheUrl];
      await client.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: cached.status,
        responseHeaders: addHeader(cached.headers, [
          ["Cache-Control", "public, max-age=31536000"],
          ["X-Warden-Cache", "TRUE"],
        ]),
        body: cached.body.toString("base64"),
      });
      return;
    }
    if (!event.responseStatusCode || !event.responseStatusText?.trim()) {
      await client.send("Fetch.continueRequest", { requestId, interceptResponse: true });
      return;
    }
    if (event.resourceType === "XHR" && !event.request.url.includes("all_dependencies")) {
      try {
        const { body, base64Encoded } = await client.send("Fetch.getResponseBody", { requestId });
        cache[event.request.url] = {
          status: event.responseStatusCode,
          headers: event.responseHeaders,
          body: Buffer.from(body, base64Encoded ? "base64" : "utf8"),
        };
      } catch (e) { }
    }
    if (event.resourceType === "Document" && event.request.url.includes("/web/tests")) {
      try {
        const { body, base64Encoded } = await client.send("Fetch.getResponseBody", { requestId });
        cache[cacheUrl] = {
          status: event.responseStatusCode,
          headers: event.responseHeaders,
          body: Buffer.from(body, base64Encoded ? "base64" : "utf8"),
        };
      } catch (e) { }
    }
    try {
      await client.send("Fetch.continueResponse", {
        requestId,
        responseCode: event.responseStatusCode,
        responseHeaders: addHeader(event.responseHeaders, [
          ["Cache-Control", "public, max-age=31536000"],
          ["X-Warden-Cache", "TRUE"],
        ]),
        responsePhrase: event.responseStatusText,
      });
    } catch (e) {
      client.detach();
      if (!["TargetCloseError", "ProtocolError"].includes(e.name)) {
        throw e;
      }
    }
  });

  await page.setCacheEnabled(true);
  setupCacheDeferred.resolve();
}

