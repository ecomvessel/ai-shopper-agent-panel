# Persona card (fill in every field; save as personas/<slug>.json)

No evidence = mark the persona `"evidence": "inferred"`. Never invent a number and call it data.

| Field | What goes here | Example |
|---|---|---|
| `id` | slug, same as the file name | `northwick-gift-giver-gwen` |
| `status` | `active` to run, `draft` to skip | `active` |
| `evidence` | `data` if numbers or quotes back it, else `inferred` | `data` |
| `name` | first name + trait | `Gift Giver Gwen` |
| `who` | age and situation, one or two lines | `36, buying a housewarming gift the week before` |
| `voice_line` | one or two lines in THEIR words (from a review, survey or email if you have one) | `Will it get here by Saturday?` |
| `shopping_for` | what they want to leave with | `A safe gift candle under $40` |
| `entry_point` | `channel` (ad / google search / instagram / email / direct) and `landing_path` (the page they land on) | `{ "channel": "instagram", "landing_path": "/collections/gifts" }` |
| `device` | `iphone-14` (iPhone size on the Chrome engine; Safari-only bugs are not caught) or `pixel-7` (Chrome engine); mix should match analytics | `iphone-14` |
| `network` | name, `latency_ms`, `down_kbps`, `up_kbps` (null = full speed), set from data | `{ "name": "train, slow 4G", "latency_ms": 250, "down_kbps": 1600, "up_kbps": 750 }` |
| `patience` | `load_seconds`, `max_screens_to_price`, `max_taps_to_checkout`, from drop-off and scroll data | `{ "load_seconds": 6, "max_screens_to_price": 2, "max_taps_to_checkout": 14 }` |
| `before_buying` | list of `{ need, look_for: [patterns], if_missing: "warn" or "quit", look_in }`. Patterns match whole words (`returns?` matches "return" and "returns"). For a price need, use the pattern `{price}`: it matches a price in any currency ("$24", "24,00 €", "£18.50"). `look_in`: `product` (default), `reviews` or `both` | `{ "need": "delivery date", "look_for": ["arrives?", "business days"], "if_missing": "quit" }` |
| `quits_when` | what makes them leave, in a sentence | `No delivery date` |
| `main_quit_reason` | 2 to 5 words; best kept different for every persona (the validator warns on a repeat) | `no delivery date` |
| `success_goal` | what counts as a win (the panel adds to cart, opens the cart and stops at the Checkout button, so "found Checkout" is the furthest it goes; with `--no-cart`, "ready to add to cart") | `Reached Checkout with a delivery date she has seen` |
| `choices` | `{ option, pick }` patterns for dropdowns and radio buttons. There is no `type_text` (the validator refuses it): a required personalisation box gets the fixed text `TEST`, never anything from this file | `{ "option": "size", "pick": "8" }` |
| `based_on` | list of the exact numbers, quotes or files this persona comes from, with customer names, emails, order numbers and addresses removed | `["analytics export: 58% iPhone", "review: 'smelled lovely'"]` |

Optional:
- `popups`: `leave` (a pop-up makes them leave), `close-once` (default) or `close-always`
- `photos_to_view`: 1 to 10, how many product photos they look at
- `product_pick`: a pattern on product names in the collection grid, used when they land on a collection
- `in_app_browser`: `"facebook"` to use the Facebook in-app browser user agent
- `allow_hosts`: third-party hosts this persona's pages need, for example `["cdn.reviews.example"]`

## Checks before saving
- Every field above is filled in.
- `based_on` names real numbers, quotes or files (or says what pages you read, for inferred personas).
- No customer names, emails, order numbers or addresses anywhere.
- Different `main_quit_reason` for each persona where possible.
- The device mix across the panel roughly matches the store's analytics.
- Run `node scripts/validate-personas.mjs <personas folder>`.
