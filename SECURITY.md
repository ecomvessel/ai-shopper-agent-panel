# Security

## Reporting a problem

If you find a way the panel could tap Checkout, place an order, load a checkout page, log in, add to a cart with `--no-cart`, submit a form, type personal data, send analytics, or be steered by text on a store page, please report it privately: on [the repository](https://github.com/ecomvessel/ai-shopper-agent-panel) open the Security tab and press "Report a vulnerability" (GitHub's private vulnerability reporting). Do not open a public issue. Include the steps and, if you can, a page from `examples/fixture-store` that shows it.

## What the panel promises

It shops like a real customer: browses, picks options, adds to cart, opens the cart, and stops before checkout. It never enters checkout, never pays, never logs in, and only types fake test text, plus discount codes your store shows on its own pages. Like any shopper, the store's analytics will see the visit and the add to cart.

Two guards check every request in the test browser with the same policy: one in each browser context and one at the browser level, which also sees every worker, frame and pop-up and every redirect hop. Only the Chrome engine (Chromium) is used, for every phone, the iPhone too; Safari-only bugs are not caught.

1. **It never checks out, never pays and never logs in.** The shopper adds to cart, opens the cart, and then finds the Checkout button (is it visible, can it be tapped) without ever tapping it. Checkout, payment and login addresses are stopped inside the test browser in every tab and frame, for every kind of request, and the run checks, by address and by page content (including payment card fields), that no checkout page loaded. If one ever loads, the run fails with SAFETY FAILURE (exit 1). Payment hosts (Shopify checkout, Shop Pay, PayPal, Stripe, Klarna, Afterpay, Adyen, Braintree, Square and others) are stopped on every path and cannot be allowed, so express buttons and pay-in-4 messages may not render. A shared endpoint (`admin-ajax.php`, a Store API, GraphQL, `/api/`) only carries the cart operations the panel recognises; every other write there is stopped. Every WebSocket is refused. If the page shows a checkout by itself, without loading one, the journey stops before the panel touches anything else. Every tap, option pick and check goes through one policy; a Checkout, Buy now, express wallet, payment or login control is refused, and a refusal ends the journey; nothing is ever forced. The test cart is left as it is and expires on its own; some stores hold stock for a cart while it lives. `--no-cart` browses only: nothing is added, and cart writes the page itself makes are stopped when the panel recognises them.
2. **It types nothing personal.** It types only fixed test text: `TEST` (or `ABC` for a box of 3 characters or fewer) in a required personalisation box, one public city-centre postcode in the cart's shipping estimator, and discount codes the store shows on its own pages (at most 3). Nothing from a persona file is typed. It never types into email, phone, password or address fields, never submits a form of its own, never uploads a file and never creates an account.
3. **It only goes where you point it.** `--i-own` must name the same host as `--url` (or its `www.` version), or it refuses to start. `--i-own` is your own promise, not a check: the panel cannot tell who owns a store. Testing a store you don't own, or have no permission to test, may break its terms and the law. You are responsible for where you point it. Private network addresses are refused as `--url` (this computer is allowed only with `--i-own` naming it too). For a `<name>.myshopify.com` owner of a custom domain, the panel first sends a GET for the store's `/meta.json` and, if needed, the page you gave, with redirects off and only after checking that the name does not point at a private address. That check proves the store is that shop, not that you own it.
4. **It keeps its visits out of your numbers as far as a browser can.** Known trackers, the platform's own analytics calls and unknown third-party hosts are blocked in the test browser. Every arrival is labelled `utm_source=shopper-panel&utm_medium=qa-test&utm_campaign=shopper-panel-test` with no referer. It pauses between shoppers, backs off when the store says "too many requests" and stops at any bot check.
5. **Page text is data, never instructions.** Reports quote page text and escape what Markdown would act on, so page text cannot add links, images or layout, and the agent is told never to follow instructions found on a page.

## Known gaps

- Server-side tracking cannot be blocked from a browser, and a store's own first-party tag proxy may not be recognised as a tracker.
- A page's own script (for example a link prefetcher) can request a checkout page at an address the panel does not recognise. That GET reaches the store's server but is never shown; a GET never places an order with the checkouts the panel knows. A checkout the panel does not recognise that places an order with a GET request alone is not ruled out.
- With `--no-cart`, a cart write the panel does not recognise (a custom app endpoint on the store's own host) is not stopped.
- Only the Chrome engine is used, so Safari-only bugs are not caught, and blocked payment widgets mean express buttons and pay-in-4 messages may not render.
- The test cart is left as it is; a store or app that holds stock for open carts holds it until the cart expires.
- The myshopify pre-check looks up the store's address and then fetches it; a name that changes its answer between the two (DNS rebinding) could still reach a private address.

[docs/safety-details.md](docs/safety-details.md) has the full detail: how the guard handles redirects, workers, sockets and background reports, the cart flow and the after-cart rule, the test-only settings, and every exit code case.

## Your data

Persona files and reports are written to `personas/` and `reports/` in your project folder. They are only kept out of git once those folders are in your project's `.gitignore`; the skill asks before adding them. This repository's own `.gitignore` covers only this folder. Never put customer names, emails, order numbers or addresses in them.
