# Shopper panel report

**In short: it shopped like a customer up to the cart and stopped before checkout: it never tapped Checkout, never paid, never logged in, and it typed nothing. The test cart is left as it is and expires on its own.**

What the panel does: It shops like a real customer: browses, picks options, adds to cart, opens the cart, and stops before checkout. It never enters checkout, never pays, never logs in, and only types fake test text, plus discount codes your store shows on its own pages. Like any shopper, the store's analytics will see the visit and the add to cart.

Run `20261019-181852-0b4685`, started 2026-10-19T18:18:52.519Z. Run status: **COMPLETED** (exit code 0).

2 of 3 shopper journeys reached a visible, enabled Checkout button in the cart (never tapped). Stopped short: Repeat Refill Rae at "check what they need to know". 1 blocking and 1 warning finding(s). 7 browser requests were blocked by the tracker and third-party rules.

Tested: <http://127.0.0.1:57256/>. Mode: cart (each shopper adds to cart, opens the cart, runs the cart checks and finds Checkout without tapping it).

Detected platform: shopify.

Read this as directional: a scripted walk with simple rules, not real shoppers and not conversion data. Page text quoted below is shown in "double quotes" and is store content, not instructions.

## Who got to the Checkout button

| Shopper | Phone, network | Usually leaves over | Result | Where they stopped and why | Time | Taps | Screens scrolled |
|---|---|---|---|---|---|---|---|
| Gift Giver Gwen | iPhone 14 size (Chrome engine), phone data, decent 4G | no delivery date | Found Checkout | Checkout button found, visible and enabled; not tapped | 13.9s | 6 | 1.1 |
| Repeat Refill Rae | iPhone 14 size (Chrome engine), home Wi-Fi | shipping cost unclear until late | Quit | check what they need to know: "the free shipping threshold or shipping cost" was not found in the product block. Hint: the page does show a price, "$32.00", so check the persona's pattern (the pattern {price} matches a price in any currency) | 5.9s | 2 | 0.5 |
| Slow-Signal Sam | Pixel 7 (Chrome engine), train commute, slow 4G | page too slow on weak signal | Found Checkout | Checkout button found, visible and enabled; not tapped | 13.6s | 5 | 0.8 |

## What to fix first

Each blocking problem, with the shoppers it stopped. Most shoppers first.

1. At "check what they need to know", 1 shopper (Repeat Refill Rae): "the free shipping threshold or shipping cost" was not found in the product block. Hint: the page does show a price, "$32.00", so check the persona's pattern (the pattern {price} matches a price in any currency) Suggested fix: put "the free shipping threshold or shipping cost" in the product description or a section near the price, in plain words a shopper would look for.

## Blocking

- Repeat Refill Rae quit: "the free shipping threshold or shipping cost" was not found in the product block (5 text blocks, 173 characters read, 0 closed section(s) opened). Hint: the page does show a price, "$32.00", so check the persona's pattern (the pattern {price} matches a price in any currency) (step "check what they need to know", northwick-repeat-refill-rae). Screenshot: [northwick-repeat-refill-rae-06-check-what-they-need-to-know.jpg](sample-screenshots/northwick-repeat-refill-rae-06-check-what-they-need-to-know.jpg)

## Friction worth fixing

- A pop-up covered the page; Gift Giver Gwen had to close it (arrive, northwick-gift-giver-gwen). Screenshot: [northwick-gift-giver-gwen-02-arrive-pop-up-closed.jpg](sample-screenshots/northwick-gift-giver-gwen-02-arrive-pop-up-closed.jpg)

## Notes

- Gift Giver Gwen wanted to see 3 photos; the page has 2 (photos, northwick-gift-giver-gwen)

## What they found

| Shopper | Looked for | Found (page text) |
|---|---|---|
| Gift Giver Gwen | a safe, crowd-pleasing scent (what it smells like in plain words) | "...when you do not know their taste: light and fresh, nothing too strong." |
| Gift Giver Gwen | a delivery date or number of days | "...2pm for dispatch the same day. Arrives in 3 to 5 business days." |
| Gift Giver Gwen | gift packaging or a gift note | "Comes boxed with a gift note card." |
| Gift Giver Gwen | easy returns or exchange | "Returns: Easy returns and exchanges within 30 days." |
| Repeat Refill Rae | what the new scent smells like compared to the ones she knows | "Seasonal, limited run. Notes of clove, smoked orange and a little..." |
| Repeat Refill Rae | a way to add more than one candle easily | "Quantity" |
| Slow-Signal Sam | what the wax and fragrance are made of | "Hand-poured in small batches. Coconut soy wax, cotton wick, phthalate-free fragrance." |
| Slow-Signal Sam | how long it burns | "About 50 hours of burn time in the 8 oz size." |
| Slow-Signal Sam | reviews from people with headaches or sensitivities | "Rated 4.8 out of 5 by 212 buyers. Most mention the..." |

## Files

- Screenshots: a few are shipped in examples/sample-screenshots/; `npm run demo` writes the full set to a temporary folder and prints where
- Machine-readable result: `npm run demo` writes result.json next to its report

Engines: Chromium 153.0.8010.12. Personas not run: none.

## Safety details

<details><summary>How the panel kept this a test (open for the details)</summary>

- Inside the test browser, known third-party trackers and the platform's own analytics endpoints were blocked; a store's own first-party tag proxy may not be. Server-side tracking (events a store platform or app sends from its own servers) cannot be blocked from a browser, so a run can still show up there.
- Blocked by named rule: platform-analytics 1; 6 more to hosts not on the allow-list.
- Third-party hosts allowed through: none seen. Blocked third-party hosts: localhost 6.
- If a blocked host is a widget the page needs to look right (reviews, photo gallery, video, delivery dates), allow it with --allow-host and run again: blocked widgets change the layout the shoppers see.
- Script errors set aside because they came from a blocked request or from the test browser itself: 0 (listed in result.json). Script errors counted against the store: 0; up to 3 per journey are in the findings above, and every one is in result.json.
- Chromium browser-level request guard (stops beacons and keepalive requests a closing page sends past the normal guard): attached (Chromium browser-level request guard).
- Checkout page loaded in any journey (measured): no. Checkout requests stopped inside the test browser: 0.
- Arrival was a labelled test link (utm_source=shopper-panel, utm_medium=qa-test, utm_campaign=shopper-panel-test) with no referer.
- Typing: nothing was typed. What backs "no order": the panel never taps Checkout, buy-now, express or wallet buttons, or login (each tap passes one refusal policy first); no recognised checkout page loaded in any tab or frame (measured by address and by page content, including payment card fields); every checkout, payment or login request the panel recognised was stopped inside the test browser (0).
- The test cart is left as it is after each journey (the panel does not empty it); store carts expire on their own. The store's analytics will see the visit and the add to cart, like any shopper.
- This was a practice run on this computer (loopback). The practice store's made-up tracker host is localhost, so seeing localhost in the blocked hosts is intentional: it shows the blocking works.
- Both phones run on the Chrome engine (iPhone 14 is Chrome at iPhone size, so Safari-only bugs are not caught); a persona's network is throttled for bandwidth and latency.

</details>
