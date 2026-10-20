# AI Shopper Agent Panel

Pretend shoppers walk your online store on a phone and tell you where each one gives up.

You tell an AI agent (Claude Code or Codex) about your store and share whatever data you have: analytics, reviews, support questions, survey answers. It builds a small panel of shopper types from that data, you approve them, and then a robot phone browser visits your store as each one. You get a report: how far each shopper got, where and why they quit, and what to fix first.

It shops like a real customer: browses, picks options, adds to cart, opens the cart, and stops before checkout. It never enters checkout, never pays, never logs in, and only types fake test text, plus discount codes your store shows on its own pages. Like any shopper, the store's analytics will see the visit and the add to cart.

The Checkout button is found and checked (is it there, can it be tapped), never tapped. Checkout, payment and login addresses are stopped inside the test browser, and the run checks that no checkout page loaded. The test cart is left as it is and expires on its own. Add `--no-cart` to browse only, without adding anything to a cart.

Limits that come with this: every phone runs on the Chrome engine, the iPhone too, so Safari-only bugs are not caught. Payment widgets are blocked, so express buttons and pay-in-4 messages may not render.

See a finished report: [examples/sample-report.md](examples/sample-report.md). It was written by the tool itself from a run against the made-up candle shop in `examples/fixture-store`, which runs on your own computer.

## What it can tell you, and what it cannot

It can tell you:
- whether the product page loads in time on a slow phone connection
- how many screens a shopper scrolls before seeing the price
- whether the things each shopper needs to know (delivery dates, returns, sizes, ingredients, reviews) are actually on the page
- whether pop-ups, missing options, sold-out items or broken links get in the way
- which third-party widgets your page depends on

It cannot tell you:
- what real customers think. These are scripted shoppers with simple rules, plus an AI reading of screenshots. Results are directional, not conversion data.
- anything about your checkout, payment or real shipping charges (it stops before checkout)
- how your store behaves in Safari (Safari-only bugs are not caught)
- how your store looks on a desktop

## Which stores it works on

Works only on Shopify stores that use an Online Store theme (the normal Shopify storefront). Before the browser starts, the panel reads your home page once. If it shows another platform (WooCommerce, BigCommerce, Magento, PrestaShop or anything else) or a headless Shopify storefront (Hydrogen), the panel says so, runs nothing and exits with code 2. A Shopify theme needs two signs that agree: the home page sets `Shopify.theme` in a script that really runs (checked in an offline browser; a comment or a string does not count), and `/cart.js` answers as a Shopify cart. Missing, unclear or conflicting signs (a theme next to another platform's markup, a script address such as a WordPress or BigCommerce one included, say) also exit with code 2. If the home page cannot be read, the first page the browser opens must show a Shopify Online Store theme and no other platform's markup, or the run stops there with exit code 2.

On your store's own address the panel sends only the Shopify cart operations a shopper's taps need: add to cart, change or update the cart (the discount box uses this) and the shipping estimator. Every other write is stopped before it leaves the test browser, and so are checkout, account, password and cart-link addresses.

## Before you start

You need:
- **A terminal.** This is the window where you type commands. On a Mac, open Spotlight (Cmd+Space), type Terminal and press Enter. On Windows, open the Start menu, type PowerShell and press Enter; its prompt starts with `PS`. The older Command Prompt (cmd.exe), whose prompt has no `PS`, is not supported for the install line. On Linux, use your usual terminal.
- **Node.js 22 or newer**. Download it from nodejs.org (the LTS button). To check, type `node --version` in the terminal.
- **Git**, or download this folder as a ZIP from its page and unzip it.
- About **200 MB** of disk space for the test browser.
- A store you own, or permission to test it.

You don't have to type the commands below yourself. Once it is installed, the AI agent runs them for you; the commands in "Run it yourself" are optional.

## Install

In Terminal (Mac or Linux), run these lines one at a time. They put the panel straight into your Claude Code skills folder and install it:

```
git clone https://github.com/ecomvessel/ai-shopper-agent-panel.git ~/.claude/skills/ai-shopper-agent-panel
cd ~/.claude/skills/ai-shopper-agent-panel
npm install
npx playwright install chromium
```

On Linux, use this last line instead (it also installs the system libraries the browser needs, and asks for your password because it uses sudo):

```
npx playwright install --with-deps chromium
```

On Windows, in PowerShell, one line at a time:

```
git clone https://github.com/ecomvessel/ai-shopper-agent-panel.git "$env:USERPROFILE\.claude\skills\ai-shopper-agent-panel"
cd "$env:USERPROFILE\.claude\skills\ai-shopper-agent-panel"
npm install
npx playwright install chromium
```

If PowerShell says running scripts is disabled on this system, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once and try again, or type `npm.cmd` and `npx.cmd` in place of `npm` and `npx`.

`npm install` worked when it ends with a line such as "added 2 packages" (the number can differ). The last line downloads one test browser (Chromium, about 200 MB). It runs both phones, the iPhone too.

**Check that it works** (fully offline, against the made-up shop on your own computer):

```
npm run demo
```

It walks the three example shoppers and ends with "Demo finished. It works." and the place of the report it wrote (a temporary folder, so nothing in the skill folder changes).

`npm test` is optional, for contributors: it runs every offline check and takes about 11 to 13 minutes (longer on a busy machine), with a progress line at least every minute. If a check fails with Timeout on a busy machine, run it again.

## Use it with an AI agent

Your project folder is any folder of your own where you want your shoppers and reports kept (for example a folder named after your store). The agent saves your shoppers in `personas/` and results in `reports/` there.

**Claude Code**: after the install above, start Claude Code in your own project folder and say: **"build my shopper panel"**.

**Codex**: put the skill folder where your Codex reads skills (for many setups that is `~/.codex/skills/ai-shopper-agent-panel`, on Windows `$env:USERPROFILE\.codex\skills\ai-shopper-agent-panel`; check your Codex documentation), or simply clone it anywhere. Then start Codex in your own project folder and say: **"build my shopper panel"**, telling it where the skill folder is if it does not find it. `AGENTS.md` in the skill folder tells Codex what to do. Codex's sandbox may block network access by default; the panel needs it to reach your store, so allow network access for the run.

The agent interviews you one topic at a time, builds the shoppers, shows you a table and waits for your yes. If your project folder is a git repository, the agent asks before adding `personas/` and `reports/` to its `.gitignore`; nothing keeps them out of git until that is done.

## Try it on the practice store first

Before you point the panel at your real store, run shoppers against the made-up practice store on your own computer. Nothing leaves your computer. Below, `<SKILL_DIR>` means your install folder: `~/.claude/skills/ai-shopper-agent-panel` on Mac or Linux, `$env:USERPROFILE\.claude\skills\ai-shopper-agent-panel` in PowerShell (or wherever you put it).

1. In the skill folder, start the practice store and leave it running. It prints its address, its port, and the exact commands for the next step with your folders filled in:
   ```
   npm run fixture
   ```
2. In a second terminal, run the three example shoppers (they are drafts, so `--include-drafts` is needed). Use the port it printed. Mac or Linux:
   ```
   node ~/.claude/skills/ai-shopper-agent-panel/scripts/shopper-panel.mjs --url http://127.0.0.1:<port> --i-own 127.0.0.1 --personas ~/.claude/skills/ai-shopper-agent-panel/examples/personas --include-drafts
   ```
   PowerShell:
   ```
   node "$env:USERPROFILE\.claude\skills\ai-shopper-agent-panel\scripts\shopper-panel.mjs" --url http://127.0.0.1:<port> --i-own 127.0.0.1 --personas "$env:USERPROFILE\.claude\skills\ai-shopper-agent-panel\examples\personas" --include-drafts
   ```
3. To try your own shoppers, go to your project folder (where your personas/ folder is) and run:
   ```
   node ~/.claude/skills/ai-shopper-agent-panel/scripts/shopper-panel.mjs --url http://127.0.0.1:<port> --i-own 127.0.0.1 --personas ./personas
   ```
   PowerShell:
   ```
   node "$env:USERPROFILE\.claude\skills\ai-shopper-agent-panel\scripts\shopper-panel.mjs" --url http://127.0.0.1:<port> --i-own 127.0.0.1 --personas .\personas
   ```
   For a shopper's `landing_path`, use one of the practice store's pages: `/collections/gifts`, `/collections/new-arrivals`, `/products/linen-and-cedar-candle`, `/products/gift-set`, `/products/autumn-ember-candle` or `/products/dawn-tote` (the practice store also has two WooCommerce pages, kept only for the tests, so do not land shoppers there).

`--i-own localhost` works here too: on this computer, `localhost` and `127.0.0.1` are the same machine. When the shoppers walk the practice store the way you expect, run them on your own store.

## Run it yourself

From the skill folder (the agent normally does this for you):

```
node scripts/shopper-panel.mjs --url https://your-store.example --i-own your-store.example --dry-run
node scripts/shopper-panel.mjs --url https://your-store.example --i-own your-store.example
```

- `--i-own` is your own promise that you own the store or have permission to test it; the panel cannot check that. It must name the same host as `--url`, or its `www.` version, otherwise the panel refuses to start. A `<name>.myshopify.com` owner for a custom domain is accepted only when the store itself confirms that address (its `/meta.json` or the `Shopify.shop` value in the page), checked when the run starts; that proves the store is that shop, not that you own it.
- `--personas <folder>` picks where your shopper files are (default `./personas`).
- `--no-cart` browses only: the shopper never taps Add to cart, and cart writes the page makes on its own are stopped. Without it, each shopper adds to cart, opens the cart and stops at the Checkout button. (`--cart` is accepted and changes nothing; `--cart` with `--no-cart` is refused.)
- `--allow-host <host>` lets a third-party widget's static files load (GET or HEAD of scripts, styles, images, fonts and media only; see "Blocked widgets" below). Payment hosts are never allowed.
- `--config <file>` reads settings (block_rules, allow_hosts) from that file. Without it the panel reads `./shopper-panel.config.json`, or else the one next to your persona folder, and says which.
- `--fb-inapp` copies the Facebook in-app browser's user agent (user-agent emulation only: it is still the test browser, and there is no fake referer).
- `--help` (or `-h`) lists everything.
- To check your shopper files, run `node ~/.claude/skills/ai-shopper-agent-panel/scripts/validate-personas.mjs ./personas` from your project folder (PowerShell: `node "$env:USERPROFILE\.claude\skills\ai-shopper-agent-panel\scripts\validate-personas.mjs" .\personas`).

Exit codes and run status:

| Exit code | Run status | What it means |
|---|---|---|
| 0 | COMPLETED | Every journey ran. Shoppers quitting is a result, not a failure. |
| 1 | INCOMPLETE | Something stopped the test itself, not the shopper: an error, a store that did not answer, a page that stopped responding, a bot check, a page the panel could not read, a block rule or the panel's own guard that may have caused the quit, or a run stopped with Ctrl-C. Those journeys say nothing about your shoppers or your store; fix it or run again. `docs/safety-details.md` lists every case. |
| 1 | SAFETY FAILURE | A checkout page loaded in the test browser. Check your store's orders. |
| 1 | BROKEN | The run itself crashed before finishing. |
| 2 | (none) | A setup problem, including an ownership check that failed. The message says what to fix. |

## Safety

- Only your own store. Testing a store you don't own, or have no permission to test, may break its terms and the law. You are responsible for where you point it.
- It adds to cart and opens the cart like a shopper, then stops: it never taps Checkout, never pays and never logs in. Checkout, payment and login requests are stopped inside the test browser, in every tab and frame, and the run checks that no checkout page loaded. The test cart is left as it is and expires on its own; some stores hold stock for a cart while it lives. `--no-cart` browses without adding anything.
- It types only fixed test text: `TEST` in a required personalisation box, one public city-centre postcode in the shipping estimator, and discount codes your store shows on its own pages. Never anything from a persona file, and never into email, phone, password or address fields.
- Trackers and unknown third-party hosts are blocked in the test browser. **Server-side tracking cannot be blocked from a browser**, so your store's own server may still record the visit.
- Every arrival is labelled `utm_source=shopper-panel&utm_medium=qa-test&utm_campaign=shopper-panel-test`, so you can filter it out of your analytics.
- It pauses between shoppers, backs off when your store says "too many requests", and stops at any bot check.
- Never paste customer names, emails, order numbers or addresses into the chat; remove them first.

SECURITY.md lists the promises and the known gaps; `docs/safety-details.md` has the full detail.

## Troubleshooting

- **"Cannot start the chromium browser engine"**: the test browser is not installed. Run `npx playwright install chromium` in the skill folder. On Linux, use `npx playwright install --with-deps chromium` (it needs sudo).
- **"The store did not answer at ..."** or **"The store refused the connection at ..."**: the address is wrong or the store is not running. For the practice store, start `npm run fixture` first and use the port it prints.
- **"shows "Page not found""** or **"leads to a page that was not found"**: the start address, or a product card on your store, goes to a "Page not found" page. Check the address first (`--url`, or the persona's `landing_path`); otherwise it is a broken link in the store, and the report names it.
- **"journey timed out (the page stopped responding)"**: a page kept the browser busy past the shopper's patience plus 3 minutes, so the panel closed it and went on with the next shopper. The report and result.json are still written. Run that shopper again; if it keeps happening, the page itself hangs on a phone.
- **"refused: --i-own ... does not match"**: use the same domain as your store address, for example `--url https://shop.example.com --i-own shop.example.com`.
- **Blocked widgets**: the report lists third-party hosts that were blocked. If one is your review app, delivery date widget or photo gallery, add `--allow-host thathost.example` so the page looks the way shoppers see it. Allow only the ones your store needs.
- **A bot check stopped the run**: wait a while, then run again with a longer `--pause 20`.
- **It is very slow**: that is normal on a busy computer; slow-network personas also wait on purpose. Set `SP_DEBUG=1` before the command to print timing for each step (Mac or Linux: `SP_DEBUG=1 node scripts/...`; PowerShell: first `$env:SP_DEBUG=1`, then the `node` line).
- **Windows paths**: put a path in quotes, for example `--personas "C:\Users\me\shop\personas"`.

## What is in the box

- `SKILL.md`: the skill instructions (Claude Code and Codex)
- `AGENTS.md`: what Codex does when this folder is opened
- `scripts/shopper-panel.mjs`: the phone browser runner
- `scripts/validate-personas.mjs`: checks your shopper files
- `scripts/blocklist.json`: the ad and analytics requests to block. Your own rules go in `block_rules` in `shopper-panel.config.json`; `docs/block-rules.md` explains the format with worked examples.
- `scripts/test-offline.mjs`, `scripts/demo.mjs`, `scripts/fixture-server.mjs`: the offline test and demo
- `docs/block-rules.md`: how to write your own block rules
- `docs/safety-details.md`: the full safety detail
- `templates/`: the interview questions and the shopper card
- `examples/`: the made-up candle shop, three example shoppers and the sample report
- `personas/`: an empty placeholder; your own shoppers go in `personas/` in your project folder

## Not affiliated

This project is not affiliated with, endorsed by or sponsored by Shopify, Meta or any other company named here. Names are used only to describe compatibility. Results are directional.

## License

MIT. See `LICENSE`, `CHANGELOG.md` and `SECURITY.md`.
