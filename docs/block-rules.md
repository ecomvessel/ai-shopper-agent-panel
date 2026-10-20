# Writing your own block rules

The panel already blocks the common ad and analytics requests (`scripts/blocklist.json`), and it already blocks every third-party host that is not on its allow list, so an unknown tracker on another domain is stopped without a rule. A rule is still needed in two cases: a tracker on a host you allow (with `--allow-host` or `allow_hosts`, for example a widget's own analytics path), and a tracker on your own store's domain (an app that proxies its events through your site). The report lists the third-party hosts it let through under "Third-party hosts allowed through".

Your rules go in `block_rules` in `shopper-panel.config.json` in your project folder. Check them before a run: from your project folder, run `node ~/.claude/skills/ai-shopper-agent-panel/scripts/validate-personas.mjs ./personas` (PowerShell: `node "$env:USERPROFILE\.claude\skills\ai-shopper-agent-panel\scripts\validate-personas.mjs" .\personas`; it reads `shopper-panel.config.json` in your project folder, next to personas/); a rule that is not valid stops the run at start (exit 2) and the message says how to fix it.

## The two kinds of rule

- **Host rule** (`"kind": "host"`): stops every request to a host, such as a tracker's own domain. `stats.example.com` also covers `eu.stats.example.com`, but never `notstats.example.com`. A host may carry a path prefix (`facebook.com/tr`), and an optional `"path"` pattern narrows the rule further.
- **Path rule** (`"kind": "path"`): stops requests whose path matches a pattern, on other sites. Add `"own_host": true` to stop it on your own store too.

Patterns are JavaScript regular expressions written in JSON, so every backslash is written twice: a literal dot is `\\.`.

## What a rule can never do

- It never stops the store's own cart and store API calls: `/cart`, `/cart.js`, `/cart/add`, `/cart/change`, `/cart/update`, `/cart/clear` (each with or without `.js`), `/api/<version>/graphql.json` and `/wp-json/wc/store/...`. The panel needs them to add to the cart, read it and empty it.
- It never stops a page or a frame, and never applies under your own `/products/`, `/collections/`, `/product/`, `/product-category/` or `/shop/` paths.
- It never turns off the checkout guard, which always runs first.
- On your own host, every alternative in the pattern must start at the site root (`^/`) or require a query string (`\\?`), so a product called "pixel-lamp" is never caught.

Every stop your rule makes on your own host or an allowed host is counted and named in the report (and in `rule_hits_on_allowed` in result.json). If a journey then fails in a way a missing request could cause, it is marked as a tool limit naming your rule, because the rule may have caused it. That is on purpose: you always see what your rule did.

## Worked example 1: a tracker on its own domain

The report lists `pixel.example-analytics.com` as a host that loaded. Block the whole host:

```json
{
  "block_rules": [
    { "name": "example-analytics", "kind": "host", "hosts": ["pixel.example-analytics.com"] }
  ]
}
```

## Worked example 2: one script on a shared host

An app serves its tracking script from a shared CDN that also serves things your page needs. Block only that file name, anywhere on that host:

```json
{
  "block_rules": [
    { "name": "app-tracker-script", "kind": "host", "hosts": ["cdn.example-apps.com"], "path": "(^|/)tracker\\.js(\\?|$)" }
  ]
}
```

`(^|/)` means the name must start a path segment, so `mytracker.js` is not caught.

## Worked example 3: an endpoint on your own store

An app proxies its events through your own domain at `/apps/example-events/collect`. Block that path from the site root, on your own host. `(/|$)` ends the match at the end of that folder name, so `/apps/example-events/collectors` is not caught:

```json
{
  "block_rules": [
    { "name": "example-events", "kind": "path", "own_host": true, "path": "^/apps/example-events/collect(/|$)" }
  ]
}
```

## A refused rule, and the fix

This rule is refused:

```json
{ "name": "my-cart-tracker", "kind": "path", "own_host": true, "path": "(^|/)collect", "endpoint": true }
```

The check says, among other things:

```
endpoint can only be set on built-in rules; your rule's stops will be counted and named in the report. Fix: delete the "endpoint" and "endpoint_hosts" lines from this rule
"path": with "own_host": true every alternative must start at the site root ("^/") or require a query string ("\?"); too loose for the store's own paths: "(^|/)collect". Fix: start it with "^/" and the first folder name ...
```

Two things are wrong. `"endpoint"` (and `"endpoint_hosts"`) is only for the built-in rules, which the panel's own tests check; a user rule is never trusted to hide its stops. And `(^|/)collect` would match `collect` anywhere on your store, including a page called `/pages/collectors-edition`. The fix deletes the `endpoint` line and starts the pattern at the site root:

```json
{ "name": "my-collect-tracker", "kind": "path", "own_host": true, "path": "^/apps/example-events/collect(/|$)" }
```
