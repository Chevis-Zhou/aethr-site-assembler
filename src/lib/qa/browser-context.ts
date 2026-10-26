import type { Browser, BrowserContext } from "playwright";

/**
 * The browser context every stage of this suite checks pages in.
 *
 * This suite runs under `tsx`, and `tsx`'s esbuild loader transforms `tasteled-qa`'s compiled
 * `dist/` too, wrapping each nested function in a `__name(fn, "name")` keep-names call.
 * `page.evaluate` stringifies its callback into the browser, where no `__name` exists, so
 * `tasteled-qa`'s `checkHeadAndStructure` and layout checks threw "ReferenceError: __name is
 * not defined" on first use. The package itself is fine — it ships `tsc` output and runs
 * under plain Node. Defining an identity `__name` in every page is the fix that survives any
 * callback either package adds later, where the old per-function `new Function` workaround
 * had to be repeated for each one.
 *
 * A normal context, not `browser.newPage()`: axe-core opens an extra page internally, which
 * the single-owner context rejects.
 */
export async function newCheckContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = (fn) => fn;");
  return context;
}
