
import { exec } from "child_process";
import puppeteer, { Browser, CDPSession, LaunchOptions, Page, Protocol } from "puppeteer";
import { promisify } from "util";

import { Deferred } from "@warden/helpers/misc";
import { logger } from "@warden/helpers/terminal";
import { TestSuiteConfig } from "@warden/test_suite_config";


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
  "--blink-settings=imagesEnabled=false",
  "--disable-features=PaintHolding",
  "--disable-software-rasterizer",
  "--disable-gpu",
  "--disable-translate",
  // "--js-flags=--expose_gc",
  "--no-sandbox",
  "--no-zygote",
  `--window-size=1366,768`, // Same as RunBot
];

let latestDebuggingPort = 9222;
async function killPortsInRange(start: number, end: number) {
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
export async function launch(options: LaunchOptions) {
  await launchDeferred;
  launchDeferred = new Deferred();
  await killPortsInRange(9222, 9222);
  const port = latestDebuggingPort++;
  const browser = await puppeteer.launch({
    ...options,
    args: [
      ...CHROME_OPTIONS,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
    ],
    defaultViewport: null,
    handleSIGHUP: false,
    handleSIGINT: false,
    handleSIGTERM: false,
  });
  browsers.push(browser);
  launchDeferred.resolve();
  return browser;
}

export async function cleanup() {
    await launchDeferred;
    await Promise.allSettled([
        ... clients.map((c) => c ?. detach() ?. catch(() => {}),),
        ... browsers.map((b) => b ?. close()?.catch(() => {})),
    ]);
    await killPortsInRange(9222, 9222);
}

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
 * Cache responses to speed up reload time by forcing browser memory cache.
 */
const cache: Record<string, {
  status: number,
  headers: Protocol.Fetch.HeaderEntry[],
  body: Buffer
}> = {};

export async function setupCache(page: Page, config: TestSuiteConfig) {
  const client = await page.target().createCDPSession();
  clients.push(client);

  if (config.cpuThrottling) {
    await client.send("Emulation.setCPUThrottlingRate", { rate: config.cpuThrottling + 1 });
  }

  await client.send("ServiceWorker.enable");
  await client.send("ServiceWorker.unregister", { scopeURL: config.serverURL });
  await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await client.send("Fetch.enable");

  client.on("Fetch.requestPaused", async (event) => {
    const { requestId, request, resourceType } = event;
    let cacheUrl = request.url;
    if (resourceType === "Document" && request.url.includes("/web/tests")) {
      [cacheUrl] = request.url.split("?");
    }
    if (cacheUrl in cache) {
      const cached = cache[cacheUrl];
      await client.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: cached.status,
        responseHeaders: cached.headers,
        body: cached.body.toString("base64"),
      });
      return;
    }
    if (!event.responseStatusCode) {
      await client.send("Fetch.continueRequest", { requestId, interceptResponse: true });
      return;
    }
    if (resourceType === "XHR" && !request.url.includes("all_dependencies")) {
      try {
        const { body, base64Encoded } = await client.send("Fetch.getResponseBody", { requestId });
        cache[request.url] = {
          status: event.responseStatusCode,
          headers: event.responseHeaders,
          body: Buffer.from(body, base64Encoded ? "base64" : "utf8"),
        };
      } catch (e) {
          logger.error(`Failed to cache ${request.url}`);
          logger.error(e);
       }
    }
    if (resourceType === "Document" && request.url.includes("/web/tests")) {
      try {
        const { body, base64Encoded } = await client.send("Fetch.getResponseBody", { requestId });
        cache[cacheUrl] = {
          status: event.responseStatusCode,
          headers: event.responseHeaders,
          body: Buffer.from(body, base64Encoded ? "base64" : "utf8"),
        };
      } catch (e) {
          logger.error(`Failed to cache ${request.url}`);
          logger.error(e);
       }
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
      client.detach().catch(() => {});
      if (!["TargetCloseError", "ProtocolError"].includes(e.name)) throw e;
    }
  });

  await page.setCacheEnabled(true);
}
