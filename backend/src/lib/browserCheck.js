import { chromium } from "playwright-core";

const NAV_TIMEOUT_MS = 20000;
const ACTION_TIMEOUT_MS = 10000;
const MAX_WAIT_MS = 10000;

// Only one Chromium instance runs at a time, process-wide. Each launch is
// 150-300MB+ of RSS on its own, and checkRunner.js can call this
// concurrently for every due "browser" monitor in the same cron tick via
// Promise.all - two instances launching at once is the single most likely
// way this feature takes down a free-tier (512MB) Render instance. Every
// call queues behind whichever one is already running instead of actually
// running in parallel. This costs latency under load, not correctness -
// checks still complete, just one after another rather than concurrently.
let queue = Promise.resolve();

export async function runBrowserCheck(monitor) {
  const run = queue.then(() => execute(monitor));
  // however this run settles, let the next queued call proceed - a
  // rejection here must not permanently jam the queue for every browser
  // monitor after it.
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function execute(monitor) {
  const steps = Array.isArray(monitor.synthetic_steps) ? monitor.synthetic_steps : [];
  const start = Date.now();
  let browser;

  try {
    try {
      // --no-sandbox is required in most containerized hosts (Render
      // included) since the sandbox needs kernel namespace permissions a
      // container typically doesn't grant. --disable-dev-shm-usage avoids
      // Chromium filling /dev/shm, which is often tiny (64MB) in a
      // container and otherwise a second, unrelated way to crash.
      browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    } catch (err) {
      // The most common failure here isn't a bug, it's the browser binary
      // never having been downloaded on this host - see HANDOVER.md for
      // the required build-step / Dockerfile setup. Surfacing that
      // directly in the error saves a confusing debugging detour.
      throw new Error(
        `could not launch Chromium (${err.message}). See HANDOVER.md "Headless-browser checks" for the required build setup.`
      );
    }

    const page = await browser.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    await page.goto(monitor.url, { waitUntil: "load" });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const label = `Step ${i + 1} (${step.action || "?"})`;

      switch (step.action) {
        case "goto":
          await page.goto(step.value, { waitUntil: "load" });
          break;
        case "click":
          await page.click(step.selector);
          break;
        case "fill":
          await page.fill(step.selector, step.value ?? "");
          break;
        case "waitForSelector":
          await page.waitForSelector(step.selector, { state: "visible" });
          break;
        case "assertVisible": {
          const visible = await page.isVisible(step.selector).catch(() => false);
          if (!visible) throw new Error(`${label}: "${step.selector}" is not visible`);
          break;
        }
        case "assertText": {
          const content = await page.content();
          if (!content.includes(step.value)) {
            throw new Error(`${label}: page does not contain "${step.value}"`);
          }
          break;
        }
        case "wait":
          await page.waitForTimeout(Math.min(Number(step.value) || 1000, MAX_WAIT_MS));
          break;
        default:
          throw new Error(`${label}: unknown action "${step.action}"`);
      }
    }

    const responseMs = Date.now() - start;
    return { status: "up", statusCode: 200, responseMs, errorMessage: null, contentHash: null };
  } catch (err) {
    const responseMs = Date.now() - start;
    const detail = err.name === "TimeoutError" ? `timed out: ${err.message.split("\n")[0]}` : err.message;
    return { status: "down", statusCode: null, responseMs, errorMessage: detail, contentHash: null };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
