// AI Shopper Agent Panel helpers: pure functions and page-side readers, shared by shopper-panel.mjs and test-offline.mjs.
// No network and no side effects at import time.
import zlib from 'node:zlib';

// ---------- small text helpers ----------
export const slug = (s, max = 40) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'x';
export const stripQuery = (u) => String(u).replace(/[?#].*$/, '');
// Control characters (terminal escape sequences, bidi overrides, zero-width marks) are removed from anything shown to a person.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
export const termSafe = (s) => String(s ?? '').replace(CONTROL, '');
export const oneLine = (s, max = 300) => termSafe(s).replace(/\s+/g, ' ').trim().slice(0, max);
// The element Playwright names as covering a tap: its opening tag ("div class=\"x\""), never the closing tag of
// "<div class=\"x\">...</div> intercepts pointer events" (that read as a cover named "/div").
export const coverFrom = (msg) => {
  const m = String(msg || '').match(/<([a-z][^<>]{0,139})>(?:[^<]{0,200}<\/[a-z][a-z0-9-]*>)? (?:from <[^<>]*> subtree )?intercepts pointer events/i);
  return m ? m[1] : null;
};
// In the page (passed to evaluate with the element): is the element itself on top at its own centre, on a page wider
// than the phone screen? There the browser's tap check can miss the element (the visual viewport is offset from the
// layout one), so a "covered" verdict is a limit of the test tool, not something a shopper would hit.
export function hitCheck(e) {
  const vv = window.visualViewport;
  const screen = Math.round(vv ? vv.width : innerWidth);
  const pageWidth = document.documentElement.scrollWidth;
  if (pageWidth <= screen + 2) return null;
  e.scrollIntoView({ block: 'center', inline: 'center' });
  const r = e.getBoundingClientRect();
  const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return t && (t === e || e.contains(t)) ? { pageWidth, screen } : null;
}

// Markdown table cell or inline text built from page or persona content: one line, no control characters, no raw HTML (< and > become
// entities), and only the characters Markdown would act on escaped, so the report stays readable as plain text: | (tables), [ and ]
// (links and images; with both escaped, ( ) and ! are plain text), ` and * and ~ (code, emphasis, strike), _ at a word edge (an _ inside
// a word is plain text), a backslash before punctuation, and a leading # (a heading). The GitHub autolink triggers are broken (scheme
// ://, www. and the @ inside an e-mail address), so page text does not become a clickable link, an image or a heading in
// GitHub-flavoured Markdown. It is meant for Markdown viewers; it does not make text safe for HTML attributes or other formats.
export function mdSafe(s, max = 300) {
  return oneLine(s, max)
    .replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\')
    .replace(/[|`[\]*~]/g, (c) => `\\${c}`)
    // underscores: only a run at the edge of a word can start or end emphasis (product__info is left alone, _x_ is escaped)
    .replace(/(?<![A-Za-z0-9_])_+|_+(?![A-Za-z0-9_])/g, (m) => m.replace(/_/g, '\\_'))
    .replace(/^#/, '\\#')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/:\/\//g, ':\\/\\/')
    .replace(/(www)\./gi, '$1\\.')
    .replace(/([A-Za-z0-9._%+-])@(?=[A-Za-z0-9-])/g, '$1\\@');
}
// Page-derived strings are always shown in quotes, so a reader can tell store text from the panel's own words.
export const mdQuote = (s, max = 200) => `"${mdSafe(s, max).replace(/"/g, "'")}"`;

// ---------- ownership ----------
// --i-own must name the same site as --url: the same host or its www. variant, nothing looser. A <name>.myshopify.com owner for a custom
// domain is NOT accepted here: ownershipMatch returns needsShopifyConfirm and the runner confirms it from the store itself
// (/meta.json myshopify_domain, or Shopify.shop in the page), which must match exactly.
export function normHost(h) {
  return String(h ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
}
export function ownershipMatch(urlHost, owned) {
  const a = normHost(urlHost).replace(/^www\./, '');
  const b = normHost(owned).replace(/^www\./, '');
  if (!a || !b) return { ok: false, how: null };
  if (a === b) return { ok: true, how: 'same host' };
  // localhost, 127.0.0.1 and ::1 are the same computer: on loopback only, --i-own localhost matches --url http://127.0.0.1 and back.
  const LOOP = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/;
  if (LOOP.test(a) && LOOP.test(b)) return { ok: true, how: 'same computer (loopback)' };
  const isShop = (h) => /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(h);
  if (isShop(b) && !isShop(a)) return { ok: false, how: null, needsShopifyConfirm: b };
  return { ok: false, how: null };
}
// The store's own myshopify address, read from its /meta.json text or its page HTML. Null when neither says.
export function myshopifyDomainFrom({ metaJson = '', html = '' } = {}) {
  const clean = (v) => { const h = normHost(v); return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(h) ? h : null; };
  try { const j = JSON.parse(metaJson); if (j && typeof j.myshopify_domain === 'string') { const h = clean(j.myshopify_domain); if (h) return h; } } catch {}
  const m = /Shopify\.shop\s*=\s*["']([^"']{1,120})["']/.exec(String(html).slice(0, 2000000));
  return m ? clean(m[1]) : null;
}

// ---------- checkout guard ----------
// a locale prefix: en/, pt-br/, zh-hant/, es-419/
// The wide form is used only where a match BLOCKS something (checkout paths, cart permalinks): erring wide is the safe side there.
const LOCALE = '(?:[a-z]{2,3}(?:-[a-z0-9]{2,4})?\\/)?';
// Where a match ALLOWS something (the home page, the cart page and shopping pages after the Checkout tap, cart-action redirects,
// the catalog exemption and the hard allow), a locale is checked with isRealLocaleSegment, never by shape: /pay-here/, /buy-this/,
// /go-ca/, /fr-cart/ and /pay-419/ look like locales but are not.
// Pure and self-contained (it is also embedded in the page script). A real locale is a two letter language Intl knows (fr, en, zh),
// optionally followed by a region Intl knows (us, gb), 419, or a script (hant, hans, latn, cyrl).
export function isRealLocaleSegment(seg) {
  const m = /^([a-z]{2})(?:[-_]([a-z]{2}|\d{3}|[a-z]{4}))?$/i.exec(String(seg || ''));
  if (!m) return false;
  const lang = m[1].toLowerCase(); const reg = m[2] ? m[2].toLowerCase() : '';
  try { if (new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(lang) === undefined) return false; } catch (e) { return false; }
  if (!reg) return true;
  if (reg === '419' || ['hant', 'hans', 'latn', 'cyrl'].includes(reg)) return true;
  if (reg.length !== 2) return false;
  try { return new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }).of(reg.toUpperCase()) !== undefined; } catch (e) { return false; }
}
// The path with a leading real locale segment removed (/fr/cart -> /cart, /pay-here/cart stays as it is).
export function stripRealLocale(pathname) {
  const p = String(pathname || '');
  const m = /^\/([^/]+)(\/.*)$/.exec(p);
  return m && isRealLocaleSegment(m[1]) ? m[2] : p;
}
// /checkout or /checkouts as a path segment ANYWHERE (Shopify /{shop_id}/checkouts/{token}, locale prefixes, WooCommerce /checkout/
// and /checkout/order-pay/...), Shopify cart/c/ checkout links, and Shopify's numbered order pages /{shop_id}/orders/...
export const CHECKOUT_PATH = new RegExp(`(?:\\/checkouts?(?:\\/|$)|^\\/${LOCALE}cart\\/c\\/|^\\/${LOCALE}\\d+\\/orders(?:\\/|$))`, 'i');
export const CART_PERMALINK = new RegExp(`^\\/${LOCALE}cart\\/\\d+:`, 'i');
export const CART_CHECKOUT_PATH = new RegExp(`^\\/${LOCALE}cart\\/checkout\\/?$`, 'i');
// The cart page in the languages WooCommerce and Shopify themes commonly use for its slug.
export const CART_WORDS = ['cart', 'basket', 'bag', 'warenkorb', 'panier', 'carrito', 'carrello', 'winkelwagen', 'winkelmand', 'kurv', 'handlekurv', 'varukorg', 'koszyk', 'cesta', 'carrinho', 'ostoskori', 'kosik', 'kosar'];
export const CART_PAGE_PATH = new RegExp(`^\\/${LOCALE}(?:${CART_WORDS.join('|')})\\/?$`, 'i');
// The same cart page, strict locale only: used to ALLOW a page load after the Checkout tap.
const CART_PAGE_PATH_BARE = new RegExp(`^\\/(?:${CART_WORDS.join('|')})\\/?$`, 'i');
const isCartPageAllow = (p) => CART_PAGE_PATH_BARE.test(stripRealLocale(p));
// Other checkout entry points: WooCommerce Store API checkout (pretty path or ?rest_route=), checkout.php and finishorder.php
// (BigCommerce and older carts), embedded checkouts.
const OTHER_CHECKOUT_PATH = /(?:\/wc\/store(?:\/v\d+)?\/checkout(?:\/|$)|\/(?:checkout|finishorder)\.php$|\/embedded-checkout(?:\/|$))/i;

// The address with its path percent-decoded once (as many servers route it), or null when it has none or cannot be decoded.
export function decodedUrl(url) {
  try {
    const x = new URL(url); if (!/%/.test(x.pathname)) return null;
    let p; try { p = decodeURIComponent(x.pathname); } catch { return `${x.origin}/__undecodable__${x.search}`; }
    return `${x.origin}${p.replace(/[?#\s]/g, encodeURIComponent)}${x.search}`;
  } catch { return null; }
}
// ---------- the hard line: checkout, payment and login, by address ----------
// One pure matcher used by every layer (the request guard, the browser-level guard, every redirect hop, the interaction policy). It
// errs wide on purpose: a false block is a stop that the report names, never a way past the line.
// Payment, wallet and pay-later hosts (and every subdomain), never reachable whatever --allow-host says.
export const PAYMENT_HOSTS = [
  'checkout.shopify.com', 'pay.shopify.com', 'shop.app', 'shopifycs.com', 'accounts.shopify.com',
  'paypal.com', 'paypalobjects.com', 'paypal.me', 'venmo.com', 'braintreegateway.com', 'braintree-api.com', 'braintreepayments.com',
  'stripe.com', 'stripe.network', 'stripecdn.com', 'klarna.com', 'klarnaservices.com', 'klarnacdn.net', 'klarnaevt.com',
  'afterpay.com', 'clearpay.co.uk', 'squareup.com', 'squarecdn.com', 'square.site', 'cash.app', 'affirm.com', 'affirm.ca',
  'sezzle.com', 'zip.co', 'quadpay.com', 'adyen.com', 'adyenpayments.com', 'authorize.net', 'checkout.com', 'mollie.com',
  'razorpay.com', 'bolt.com', 'pay.google.com', 'payments.google.com', 'applepay.cdn-apple.com', 'pay.amazon.com',
  'payments.amazon.com', 'payments-amazon.com',
];
export function normalHostName(h) { return String(h || '').toLowerCase().replace(/\.+$/, ''); }
export function paymentHostReason(host) {
  const h = normalHostName(host);
  if (!h) return null;
  if (/^apple-pay-gateway[a-z0-9-]*\.apple\.com$/.test(h)) return 'Apple Pay gateway';
  const hit = PAYMENT_HOSTS.find((p) => h === p || h.endsWith(`.${p}`));
  return hit ? `payment or wallet host (${hit})` : null;
}
// Whole path segments that are a checkout, payment, order or login entry point on any platform.
const HARD_SEGMENTS = new Set([
  'checkout', 'checkouts', 'order-pay', 'order-received', 'account', 'accounts', 'my-account', 'myaccount', 'login', 'logout', 'signin',
  'sign-in', 'sign_in', 'signup', 'sign-up', 'register', 'customer_authentication', 'authentication', 'wp-login.php', 'checkout.php',
  'finishorder.php', 'login.php', 'embedded-checkout', 'payment-information', 'set-payment-information', 'selected-payment-method',
  'place-order', 'placeorder', 'payment', 'payments', 'onestepcheckout', 'firecheckout',
]);
// Words that block when they are one token of a segment split on - _ . (so /checkout-v2/, /secure_checkout/, /checkout.html block).
const HARD_TOKENS = new Set(['checkout', 'checkouts']);
// Values of query keys that pick a handler on shared endpoints, split on / \ . _ - (OpenCart route=checkout/..., PrestaShop
// controller=order, WooCommerce action=woocommerce_checkout, BigCommerce cart.php?action=buy).
const DISPATCH_KEYS = new Set(['action', 'route', 'controller', 'rest_route', 'fc', 'wc-ajax', 'module', 'task', 'view', 'option', 'page']);
const DISPATCH_TOKENS = new Set(['checkout', 'checkouts', 'login', 'logout', 'signin', 'signup', 'payment', 'payments', 'pay', 'order', 'orders',
  'account', 'accounts', 'authentication', 'register', 'buy', 'paypal', 'stripe', 'klarna', 'afterpay', 'affirm', 'braintree', 'adyen', 'placeorder']);
const CATALOG_SEGMENTS = new Set(['products', 'collections']);
const ROUTING_HEADERS = ['x-original-url', 'x-rewrite-url', 'x-override-url'];
// every form of the path a server might route: as sent, and percent-decoded up to three times (dot segments resolved again)
function pathForms(pathname) {
  const out = [String(pathname || '')];
  let cur = out[0];
  for (let i = 0; i < 3 && /%/.test(cur); i++) {
    let d; try { d = decodeURIComponent(cur); } catch { out.push('/__undecodable__'); break; }
    if (d === cur) break;
    try { d = new URL(d.replace(/[?#]/g, encodeURIComponent), 'http://x').pathname; } catch {}
    out.push(d); cur = d;
  }
  return out;
}
function pathHardReason(pathname) {
  for (const p of pathForms(pathname)) {
    const segs = p.split(/[/\\;]+/).filter(Boolean).map((s) => s.toLowerCase());
    // the path after a leading locale (wide on purpose: this only blocks): /checkout*, /checkouts/*, /account*, /password
    const top = segs[0] && /^[a-z]{2,3}(?:[-_][a-z0-9]{2,4})?$/.test(segs[0]) && segs.length > 1 && !CATALOG_SEGMENTS.has(segs[0]) ? segs.slice(1) : segs;
    for (const t of [segs, top]) {
      if (t[0] && /^checkout/.test(t[0])) return `checkout in the address (${t[0]})`;
      if (t[0] && /^account/.test(t[0])) return `account in the address (${t[0]})`;
      if (t[0] === 'password') return 'the store password page';
    }
    // a product handle may be any word ("checkout-guide-candle" is a product), but only where Shopify puts one: /products/<handle> and
    // /collections/<collection>/products/<handle> (after an optional locale). There only a checkout token with nothing but a number or
    // version beside it counts ("checkout", "checkout-2", "checkout_v2"). No other place exempts a handle.
    const off = segs.length - top.length;
    const isHandle = (i) => { const j = i - off; return (j === 1 && top[0] === 'products') || (j === 3 && top[0] === 'collections' && top[2] === 'products'); };
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const handle = isHandle(i);
      if (!handle && HARD_SEGMENTS.has(s)) return `${s} in the address`;
      const toks = s.split(/[-_.]+/).filter(Boolean);
      if (toks.some((t) => HARD_TOKENS.has(t)) && (!handle || toks.every((t) => HARD_TOKENS.has(t) || /^v?\d+$/.test(t) || t === 'html' || t === 'php'))) return `checkout in the address (${s})`;
      // Magento: /guest-carts/{id}/order and /carts/mine/order place an order
      if ((s === 'order' || s === 'orders') && segs.slice(0, i).some((x) => x === 'guest-carts' || x === 'carts')) return `place order (${s})`;
    }
    if (/^\/(?:[a-z]{2,3}(?:-[a-z0-9]{2,4})?\/)?\d+\/orders(?:\/|$)/i.test(p)) return 'order page';
  }
  return null;
}
function queryHardReason(search) {
  let sp; try { sp = new URLSearchParams(search); } catch { return null; }
  for (const [k0, v] of sp) {
    const k = k0.toLowerCase();
    if (/^(wc-api|order-pay|pay_for_order|order_id)$/.test(k) || (k === 'key' && /^wc_order_/i.test(v))) return `payment or order query (${k})`;
    if (DISPATCH_KEYS.has(k)) {
      for (const form of [v, (() => { try { return decodeURIComponent(v); } catch { return v; } })()]) {
        const toks = String(form).toLowerCase().split(/[/\\._\-\s]+/).filter(Boolean);
        const bad = toks.find((t) => DISPATCH_TOKENS.has(t));
        if (bad) return `${k}=${String(v).slice(0, 60)} (${bad})`;
      }
    }
  }
  return null;
}
// Returns { kind: 'payment' | 'login' | 'checkout', why } when this address must never be requested, else null.
export function hardLineReason({ url, headers = {} } = {}) {
  let x; try { x = new URL(url); } catch { return null; }
  if (!/^(https?|wss?):$/.test(x.protocol)) return null;
  const host = normalHostName(x.hostname);
  const pay = paymentHostReason(host);
  if (pay) return { kind: /accounts\.shopify\.com$/.test(host) ? 'login' : 'payment', why: pay };
  if ((host === 'shopify.com' || host.endsWith('.shopify.com')) && /^\/\d+\/account(?:\/|$)/i.test(x.pathname)) return { kind: 'login', why: 'Shopify customer account' };
  const kindOf = (why) => (/login|logout|signin|sign-in|sign_in|signup|sign-up|register|account|authentication/i.test(why) ? 'login' : /pay|wallet/i.test(why) ? 'payment' : 'checkout');
  // Shop Pay installments (pay in 4 messages) and the Shop Pay button load from the store's own host
  if (/\/shopifycloud\/(?:shop-js|payment-terms|shopify-pay|checkout-web)(?:\/|$)|\/shop-pay-installments/i.test(x.pathname)) return { kind: 'payment', why: 'Shop Pay widget or installments' };
  const pr = pathHardReason(x.pathname);
  if (pr) return { kind: kindOf(pr), why: pr };
  const qr = queryHardReason(x.search);
  if (qr) return { kind: kindOf(qr), why: qr };
  for (const name of ROUTING_HEADERS) {
    const hv = Object.entries(headers || {}).find(([k]) => k.toLowerCase() === name);
    if (!hv) continue;
    let y; try { y = new URL(String(hv[1]), x.origin); } catch { return { kind: 'checkout', why: `unreadable ${name} header` }; }
    const r = pathHardReason(y.pathname) || queryHardReason(y.search);
    if (r) return { kind: kindOf(r), why: `${r} (in the ${name} header)` };
  }
  return null;
}
// Returns a short reason string when this request must never leave the test browser, else null.
export function checkoutReason({ url, method = 'GET', isNavigation = false, redirectedFrom = [], formBody = '', headers = {} }) {
  const chain = [...redirectedFrom, url];
  for (const u of chain) { const h = hardLineReason({ url: u, headers: u === url ? headers : {} }); if (h) return `${h.kind === 'checkout' ? 'checkout' : h.kind === 'payment' ? 'payment' : 'login'}: ${h.why}${u === url ? '' : ' (reached by redirect)'}`; }
  // a server may decode the path before it routes it (/%63heckout is /checkout there), so the decoded address is checked too
  for (const u of [...chain]) { const d = decodedUrl(u); if (d && d !== u) chain.push(d); }
  for (const u of chain) {
    let x; try { x = new URL(u); } catch { continue; }
    const p = x.pathname;
    const via = u === url ? '' : ' (reached by redirect)';
    if (CHECKOUT_PATH.test(p)) return `checkout path${via}`;
    if (CART_PERMALINK.test(p)) return `cart permalink${via}`;
    if (CART_CHECKOUT_PATH.test(p)) return `cart/checkout${via}`;
    if (/^checkout$/i.test(x.searchParams.get('wc-ajax') || '')) return `WooCommerce checkout call${via}`;
    if (OTHER_CHECKOUT_PATH.test(p)) return `checkout endpoint${via}`;
    // payment and order queries (WooCommerce gateway callbacks and order-pay pages) are stopped on any address, "/" included
    for (const [k, v] of x.searchParams) if (/^(wc-api|order-pay|pay_for_order|order_id)$/i.test(k) || (/^key$/i.test(k) && /^wc_order_/i.test(v))) return `payment or order query (${k.toLowerCase()})${via}`;
    const rr = x.searchParams.get('rest_route');
    if (rr && OTHER_CHECKOUT_PATH.test(rr)) return `WooCommerce Store API checkout${via}`;
    if (/(^|\.)shop\.app$/i.test(x.hostname) && /\/(pay|checkout)/i.test(p)) return `Shop Pay${via}`;
    if (/(^|\.)paypal\.com$/i.test(x.hostname) && /checkout/i.test(p)) return `PayPal checkout${via}`;
    if (/(^|\.)checkout\.shopify\.com$/i.test(x.hostname)) return `Shopify checkout host${via}`;
    if (/(^|\.)checkout\.stripe\.com$/i.test(x.hostname)) return `Stripe checkout host${via}`;
  }
  try {
    const x = new URL(url);
    if (method === 'POST' && CART_PAGE_PATH.test(x.pathname) && isNavigation && /(^|&)checkout(=|&|$)/.test(formBody || '')) return 'cart form posted with checkout';
  } catch {}
  return null;
}
// ---------- the write allow-list (v1: Shopify Online Store themes only) ----------
// Every request that is not a GET or HEAD, on every layer (the request guard, every redirect hop with that hop's own method and body,
// and the browser-level guard for pages, frames, workers and keepalive requests), is sent only when ALL of these hold; anything else
// (GraphQL, /api, an app proxy, a form of any other kind) is stopped. A stopped write the store needed makes the journey a tool limit,
// never a store finding.
// Headers that make a server route or treat a request as something other than what its address and method say. Refused on every
// method, a GET included.
export const ROUTING_OVERRIDE_HEADERS = ['x-original-url', 'x-rewrite-url', 'x-override-url', 'x-original-uri', 'x-rewrite-uri', 'x-http-method-override',
  'x-http-method', 'x-method-override', 'x-forwarded-path', 'x-forwarded-uri', 'x-forwarded-prefix', 'x-forwarded-host', 'x-forwarded-server',
  'x-forwarded-scheme', 'x-forwarded-proto', 'x-host', 'x-original-host', 'x-original-method', 'x-rewrite-method', 'forwarded'];
export function overrideHeaderReason(headers = {}) {
  for (const [k] of Object.entries(headers || {})) {
    const n = String(k).toLowerCase();
    if (ROUTING_OVERRIDE_HEADERS.includes(n)) return `a routing or method override header (${n})`;
  }
  return null;
}
// The Shopify cart operations a shopper's taps can need: add, change, update (the cart discount box sends {discount} to /cart/update.js)
// and the shipping estimator's prepare call. Their reads (/cart.js, /cart/async_shipping_rates.json, /cart/shipping_rates.json,
// /discount/<code>) are GETs. An optional locale prefix /xx or /xx-yy (a real one, lower case) is allowed in front.
const WRITE_ALLOW_PATHS = new Set(['/cart/add', '/cart/add.js', '/cart/change', '/cart/change.js', '/cart/update', '/cart/update.js', '/cart/prepare_shipping_rates.json']);
// the path exactly as it was sent: cut from the address string, never from a parsed (and so normalised) URL
export function rawPathOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\\]*([^?#]*)/i.exec(String(url || ''));
  return m ? (m[1] || '/') : null;
}
export function writePathAllowed(rawPath) {
  const p = String(rawPath ?? '');
  if (!p.startsWith('/') || /[%\;:]/.test(p) || p.includes('//') || /[^\x21-\x7e]/.test(p)) return false;
  if (p.split('/').some((s) => s === '.' || s === '..')) return false;
  if (WRITE_ALLOW_PATHS.has(p)) return true;
  const m = /^\/([a-z]{2}(?:-[a-z]{2})?)(\/.*)$/.exec(p);
  return !!m && isRealLocaleSegment(m[1]) && WRITE_ALLOW_PATHS.has(m[2]);
}
// A key that names a checkout or a place to go next, in any encoding: percent-decoded up to three times, Unicode-folded (NFKC), lower
// case, and with everything but letters taken out (check_out, Check-Out and CHECKOUT all read "checkout").
const BAD_KEYS = new Set(['returnto', 'returnurl', 'returnpath', 'redirect', 'redirectto', 'redirecturl', 'redirecturi', 'goto', 'next', 'continue', 'continueurl', 'callback', 'callbackurl', 'successurl', 'destination', 'dest', 'forwardto', 'forwardurl']);
// the forms of a key or value a server might read: as sent, then percent-decoded up to three times; null when one does not decode
function decodedForms(s) {
  const forms = [String(s ?? '')];
  let cur = forms[0];
  for (let i = 0; i < 3 && /%/.test(cur); i++) { let d; try { d = decodeURIComponent(cur); } catch { return null; } if (d === cur) break; forms.push(d); cur = d; }
  return forms;
}
export function badBodyKey(key) {
  const forms = decodedForms(key);
  if (!forms) return 'an undecodable key';
  for (const f of forms) {
    const flat = f.normalize('NFKC').toLowerCase().replace(/[^a-z]/g, '');
    if (flat.includes('checkout')) return `a key naming checkout (${oneLine(f, 40)})`;
    if (BAD_KEYS.has(flat)) return `a key that names where to go next (${oneLine(f, 40)})`;
    // a bracketed form key (attributes[return_to], items[0][checkout]) is read part by part too
    for (const part of f.split(/[[\]]+/).filter(Boolean)) { const pf = part.normalize('NFKC').toLowerCase().replace(/[^a-z]/g, ''); if (BAD_KEYS.has(pf)) return `a key that names where to go next (${oneLine(f, 40)})`; }
  }
  return null;
}
// Words that, as the whole value (one word, no spaces), pick a checkout, login or payment step ("checkout", "goto_checkout", "pay").
const SELECTOR_WORDS = new Set(['checkout', 'checkouts', 'login', 'logout', 'signin', 'signup', 'payment', 'payments', 'pay', 'placeorder', 'account', 'accounts', 'register', 'authentication']);
// A VALUE that is a destination or a step selector: an address or path (absolute, scheme-relative, a bare host name, or a path) that
// resolves to a checkout, account, login or payment address or a payment host, a script or data address, or a single word that names a
// checkout, login or payment step. Prose with spaces that only mentions checkout ("Leave it at the checkout desk") is not a destination.
export function badBodyValue(value) {
  if (typeof value !== 'string') return null;
  const forms = decodedForms(value);
  if (!forms) return 'an undecodable value';
  for (const f0 of forms) {
    const f = f0.normalize('NFKC').replace(/[\u0000-\u0020]+/g, (m) => (/[\r\n\t\u0000-\u001f]/.test(m) ? '' : m)).trim();
    if (!f) continue;
    if (/^(?:javascript|data|vbscript|blob|file)\s*:/i.test(f)) return `a value that is a script or data address (${oneLine(f, 40)})`;
    let u = null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(f) || /^[a-z][a-z0-9+.-]*:/i.test(f) && /^(?:https?|wss?):/i.test(f)) { try { u = new URL(f); } catch { return `an unreadable address value (${oneLine(f, 40)})`; } }
    else if (/^[/\\]/.test(f)) { try { u = new URL(f.replace(/\\/g, '/'), 'https://own.invalid'); } catch { return `an unreadable path value (${oneLine(f, 40)})`; } }
    else if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\.?(?::\d+)?(?:[/?#]|$)/i.test(f) && !/\s/.test(f)) { try { u = new URL(`https://${f}`); } catch { u = null; } }
    if (u) {
      const h = hardLineReason({ url: u.href });
      if (h) return `a value that leads to ${h.kind === 'login' ? 'a login or account page' : h.kind === 'payment' ? 'payment' : 'checkout'} (${oneLine(f, 60)})`;
      const c = checkoutReason({ url: u.href });
      if (c) return `a value that leads to checkout (${oneLine(f, 60)})`;
      continue;
    }
    if (!/\s/.test(f)) {
      const toks = f.toLowerCase().split(/[/\\._\-:|+,=&?#]+/).filter(Boolean);
      const flat = f.toLowerCase().replace(/[^a-z]/g, '');
      if (toks.some((t) => SELECTOR_WORDS.has(t)) || SELECTOR_WORDS.has(flat) || /checkout/.test(flat)) return `a value that names a checkout, login or payment step (${oneLine(f, 40)})`;
    }
  }
  return null;
}
// JSON with a key twice in one object is read differently by different parsers (first or last wins): true when any object repeats a key.
export function jsonHasDuplicateKey(text) {
  const s = String(text ?? ''); const stack = []; let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      let j = i + 1; while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      const lit = s.slice(i, j + 1); i = j + 1;
      let k = i; while (k < s.length && /\s/.test(s[k])) k++;
      const top = stack[stack.length - 1];
      if (s[k] === ':' && top instanceof Set) { let key; try { key = JSON.parse(lit); } catch { return true; } if (top.has(key)) return true; top.add(key); }
      continue;
    }
    if (ch === '{') stack.push(new Set()); else if (ch === '[') stack.push('['); else if (ch === '}' || ch === ']') stack.pop();
    i++;
  }
  return false;
}
// A multipart/form-data body read strictly, as [{ key, value, file }], or null when anything about it could be read two ways: a
// preamble, padding or an epilogue, a part with no or two Content-Disposition headers, a header other than Content-Disposition and
// Content-Type, a folded header line, a disposition parameter other than name and filename, a parameter given twice, an extended (name*)
// parameter, a backslash or a line break in a quoted value, or a boundary given twice in the content type. Every field is returned.
function multipartFields(contentType, body) {
  const ctm = /^\s*multipart\/form-data\s*((?:;[^;]*)+)$/i.exec(String(contentType || ''));
  if (!ctm) return null;
  const params = {};
  for (const seg of ctm[1].split(';').slice(1)) {
    const m = /^\s*([A-Za-z0-9-]+)=(?:"([^"\\\r\n]*)"|([^\s";\\]+))\s*$/.exec(seg);
    if (!m) return null;
    const k = m[1].toLowerCase();
    if (k in params || !['boundary', 'charset'].includes(k)) return null;
    params[k] = m[2] ?? m[3];
  }
  const bd = params.boundary;
  if (!bd || !/^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/.test(bd)) return null;
  const s = String(body ?? '');
  const open = `--${bd}\r\n`; const delim = `\r\n--${bd}`;
  if (!s.startsWith(open)) return null;
  const raw = []; let pos = open.length;
  for (;;) {
    const i = s.indexOf(delim, pos);
    if (i < 0) return null;
    raw.push(s.slice(pos, i));
    const after = s.slice(i + delim.length);
    if (after.startsWith('\r\n')) { pos = i + delim.length + 2; continue; }
    if (/^--(?:\r\n)?$/.test(after)) break;
    return null;
  }
  const out = [];
  for (const part of raw) {
    const he = part.indexOf('\r\n\r\n');
    if (he <= 0) return null;
    let disp = null; let ctype = 0;
    for (const line of part.slice(0, he).split('\r\n')) {
      const hm = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\u0000-\u0008\u000a-\u001f\u007f]*?)[ \t]*$/.exec(line);
      if (!hm) return null;
      const n = hm[1].toLowerCase();
      if (n === 'content-disposition') { if (disp !== null) return null; disp = hm[2]; } else if (n === 'content-type') { if (ctype++) return null; } else return null;
    }
    if (disp === null) return null;
    const dm = /^form-data((?:[ \t]*;[ \t]*[A-Za-z0-9*-]+=(?:"[^"\\\r\n]*"|[^\s;"\\]+))+)[ \t]*$/i.exec(disp);
    if (!dm) return null;
    const dp = {};
    for (const pm of dm[1].matchAll(/;[ \t]*([A-Za-z0-9*-]+)=(?:"([^"\\\r\n]*)"|([^\s;"\\]+))/g)) {
      const k = pm[1].toLowerCase();
      if (k in dp || !['name', 'filename'].includes(k)) return null;
      dp[k] = pm[2] ?? pm[3];
    }
    if (dp.name === undefined) return null;
    out.push({ key: dp.name, value: part.slice(he + 4), file: dp.filename !== undefined });
  }
  return out;
}
// The fields of a request body of the given content type, as [{ key, value, file }], or null when the body does not parse as that type
// in exactly one way.
export function bodyFields(contentType, body) {
  const ct = String(contentType || '').toLowerCase();
  const b = String(body ?? '');
  if (/^application\/x-www-form-urlencoded\b/.test(ct)) {
    // a raw ";" is a second pair separator on some servers, so it is never sent (a browser always encodes it)
    if (/[^\x20-\x7e]/.test(b) || b.includes(';')) return null;
    const out = [];
    for (const pair of b.split('&')) {
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      const rk = eq < 0 ? pair : pair.slice(0, eq); const rv = eq < 0 ? '' : pair.slice(eq + 1);
      let key; let value; try { key = decodeURIComponent(rk.replace(/\+/g, ' ')); value = decodeURIComponent(rv.replace(/\+/g, ' ')); } catch { return null; }
      out.push({ key, value, file: false });
    }
    return out;
  }
  if (/^application\/json\b/.test(ct)) {
    let v; try { v = JSON.parse(b); } catch { return null; }
    if (v === null || typeof v !== 'object' || jsonHasDuplicateKey(b)) return null;
    const out = []; const walk = (o, d, k) => { if (d > 20) throw new Error('deep'); if (Array.isArray(o)) o.forEach((x) => walk(x, d + 1, k)); else if (o && typeof o === 'object') for (const [kk, x] of Object.entries(o)) { out.push({ key: kk, value: null, file: false }); walk(x, d + 1, kk); } else if (typeof o === 'string') out.push({ key: null, value: o, file: false }); };
    try { walk(v, 0, null); } catch { return null; }
    return out;
  }
  if (/^multipart\/form-data\b/.test(ct)) return multipartFields(contentType, body);
  return null;
}
// The keys of a request body of the given content type, or null when the body does not parse as that type in exactly one way.
export function bodyKeys(contentType, body) {
  const f = bodyFields(contentType, body);
  return f ? f.filter((x) => x.key !== null).map((x) => x.key) : null;
}
// null when this request may be sent, else the reason it is stopped. ownHosts: the store's own host names.
export function writeAllowReason({ url, method = 'GET', body = '', headers = {}, ownHosts = new Set() } = {}) {
  // body: the request body as text; null when the request has one the guard could not read
  const oh = overrideHeaderReason(headers);
  if (oh) return oh;
  if (/^(GET|HEAD)$/i.test(String(method || 'GET'))) return null;
  let x; try { x = new URL(url); } catch { return 'an unreadable address'; }
  if (!/^https?:$/.test(x.protocol)) return `a ${String(method).toUpperCase()} to a ${x.protocol.replace(':', '')} address`;
  if (!isOwnHost(x.hostname.toLowerCase(), ownHosts)) return 'a write to another host';
  if (x.username || x.password) return 'a write with credentials in the address';
  const raw = rawPathOf(url);
  if (!writePathAllowed(raw)) return `a ${String(method).toUpperCase()} to ${oneLine(raw, 80)}, which is not a Shopify cart operation the panel allows`;
  if (!/^POST$/i.test(String(method))) return `a ${oneLine(String(method).toUpperCase(), 12)} request (only POST is sent to a cart operation)`;
  if (body === null || body === undefined) return 'a body the guard could not read';
  const ctv = Object.entries(headers || {}).filter(([k]) => String(k).toLowerCase() === 'content-type').map(([, v]) => String(v));
  if (ctv.length !== 1) return ctv.length ? 'more than one content type' : 'a write with no content type';
  const fields = bodyFields(ctv[0], body);
  if (!fields) return `a body that is not readable as ${oneLine(ctv[0].split(';')[0], 60) || 'a form or JSON'} in exactly one way`;
  const rawQuery = (/\?([^#]*)/.exec(String(url)) || [])[1] || '';
  if (rawQuery.includes(';')) return 'a cart write whose query has a raw ";"';
  const q = []; for (const [key, value] of x.searchParams) q.push({ key, value, file: false });
  for (const fld of [...fields, ...q]) {
    if (fld.key !== null) { const bad = badBodyKey(fld.key); if (bad) return `a cart write with ${bad}`; }
    // a file's content is not a field a server routes by; every other value is checked
    if (!fld.file && fld.value !== null) { const bv = badBodyValue(fld.value); if (bv) return `a cart write with ${bv}`; }
  }
  return null;
}
// The request body as the browser-level guard sees it: postData when Chromium gives it, else the postDataEntries (base64 parts) joined.
// null when the request has a body the guard was not given (it is then never sent as a write).
export function cdpPostData(request = {}) {
  if (typeof request.postData === 'string') return request.postData;
  if (Array.isArray(request.postDataEntries) && request.postDataEntries.length) { try { return request.postDataEntries.map((e) => { if (typeof e.bytes !== 'string') throw new Error('no bytes'); return Buffer.from(e.bytes, 'base64').toString('utf8'); }).join(''); } catch { return null; } }
  return request.hasPostData ? null : '';
}
// ---------- the store's platform (v1: Shopify Online Store themes only) ----------
// JavaScript source with its comments and string literals (quotes, template literals) blanked out, so text inside them is never read as
// code. Regular-expression literals are not recognised; a quote inside one only blanks more, which can only make a match less likely.
export function jsCodeOnly(src) {
  const s = String(src || ''); let out = ''; let i = 0;
  while (i < s.length) {
    const c = s[i]; const n = s[i + 1];
    if (c === '/' && n === '/') { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e; out += ' '; continue; }
    if (c === '/' && n === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; out += ' '; continue; }
    if (c === '<' && s.startsWith('<!--', i)) { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') { let j = i + 1; while (j < s.length && s[j] !== c && !(c !== '`' && s[j] === '\n')) j += s[j] === '\\' ? 2 : 1; i = j + 1; out += '""'; continue; }
    out += c; i++;
  }
  return out;
}
// The text of each inline classic or module script the browser would run (no src, a JavaScript type), from raw HTML with comments out.
export function inlineScripts(html) {
  const h = String(html || '').slice(0, 3000000).replace(/<!--(?:>|->|[\s\S]*?(?:--!?>|$))/g, ' ');
  const out = [];
  for (const m of h.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(?:<\/script\s*>|$)/gi)) {
    const attrs = {}; for (const a of m[1].matchAll(TAG_ATTR)) { const k = a[1].toLowerCase(); if (!(k in attrs)) attrs[k] = a[2] ?? a[3] ?? a[4] ?? ''; }
    if ('src' in attrs) continue;
    const type = String(attrs.type ?? '').trim().toLowerCase();
    if (type && !/^(?:text\/javascript|application\/javascript|module|text\/ecmascript|application\/ecmascript)$/.test(type)) continue;
    out.push(m[2]);
  }
  return out;
}
// Another platform's own markup (not words in the page text): WordPress asset paths, a WooCommerce body class, Magento's init attribute,
// BigCommerce's Stencil, or a generator meta naming another platform.
function otherPlatformMarkup(tags) {
  for (const t of tags) {
    const a = t.attrs;
    if ((a.src && /\/wp-(?:content|includes)\//i.test(a.src)) || (a.href && /\/wp-(?:content|includes)\//i.test(a.href))) return 'WooCommerce or WordPress';
    if (t.name === 'body' && /(?:^|\s)woocommerce(?:-[a-z-]+)?(?:\s|$)/i.test(a.class || '')) return 'WooCommerce or WordPress';
    if ('data-mage-init' in a) return 'Magento';
    if (a.src && /stencil-utils|bigcommerce/i.test(a.src)) return 'BigCommerce';
    if (t.name === 'meta' && /^generator$/i.test(a.name || '') && /wordpress|woocommerce|prestashop|magento|bigcommerce|wix|squarespace/i.test(a.content || '')) return oneLine(a.content, 40);
  }
  return null;
}
// From the store's home page as fetched before the browser starts: 'shopify' (an inline script ASSIGNS Shopify.theme: never a comment,
// a string, an attribute or page text), 'hydrogen' (a Hydrogen or Oxygen storefront), 'conflict' (a Shopify.theme assignment AND
// another platform's markup), 'other' (a readable page of another platform; name says which when it can tell) or 'unknown' (no
// answer, an error, a redirect, a bot check, or not HTML). Only 'shopify' and 'unknown' may run, and both still need runtime proof.
export function classifyStorefront({ status = 0, headers = {}, html = '' } = {}) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  const page = String(html || '').slice(0, 3000000);
  const theme = inlineScripts(page).some((src) => /(?:^|[^.\w$])(?:(?:window|self|globalThis)\s*\.\s*)?Shopify\s*\.\s*theme\s*=(?!=)/.test(jsCodeOnly(src)));
  if (/hydrogen|oxygen/i.test(h['powered-by'] || '') || Object.keys(h).some((k) => /^oxygen-/.test(k)) || (!theme && /data-hydrogen|__remixContext|window\.__hydrogen/i.test(page))) return { kind: 'hydrogen', name: 'Shopify Hydrogen (headless)' };
  if (!(status >= 200 && status < 300)) return { kind: 'unknown', name: null };
  if (!/html/i.test(h['content-type'] || '') || !/<html|<body|<head/i.test(page)) return { kind: 'unknown', name: null };
  const other = otherPlatformMarkup(startTags(page, { keepRawOpen: true }));
  if (theme && other) return { kind: 'conflict', name: other };
  if (theme) return { kind: 'shopify', name: 'Shopify Online Store' };
  if (detectChallenge({ status, headers: h, title: (/<title[^>]*>([^<]*)/i.exec(page) || [])[1] || '', body: page.slice(0, 20000) })) return { kind: 'unknown', name: null };
  const name = other || (/wp-content|woocommerce/i.test(page) ? 'WooCommerce or WordPress' : /stencil|bigcommerce/i.test(page) ? 'BigCommerce' : /\bMagento\b|mage\/|data-mage-init/i.test(page) ? 'Magento' : /prestashop/i.test(page) ? 'PrestaShop' : /Shopify|cdn\.shopify\.com/i.test(page) ? 'Shopify, but not an Online Store theme' : null);
  return { kind: 'other', name };
}
// R27: another platform's evidence on a page that already showed a Shopify theme at runtime (the fallback gate, when the home page
// could not be read before the run): a Hydrogen or Oxygen header, another platform's markup (script and link addresses included), or
// Hydrogen markers. Returns the other platform's name, or null. Any answer means the platform is unclear, so the run stops (exit 2).
export function platformConflictOnPage({ headers = {}, html = '' } = {}) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  const page = String(html || '').slice(0, 3000000);
  if (/hydrogen|oxygen/i.test(h['powered-by'] || '') || Object.keys(h).some((k) => /^oxygen-/.test(k))) return 'Shopify Hydrogen (headless)';
  const other = otherPlatformMarkup(startTags(page, { keepRawOpen: true }));
  if (other) return other;
  if (/data-hydrogen|__remixContext|window\.__hydrogen/i.test(page)) return 'Shopify Hydrogen (headless)';
  return null;
}
// The second signal: the store's /cart.js answers as a Shopify Online Store cart does (a cart token, an items list, an item count, a
// currency code).
export function isShopifyCartJson(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.token === 'string' && v.token.length > 0 && Array.isArray(v.items)
    && Number.isInteger(v.item_count) && v.item_count >= 0 && typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency);
}
// Runtime proof, in the browser: the page's own scripts left a window.Shopify.theme object (comments and strings cannot do that).
export function shopifyThemeAtRuntime() {
  try { const s = window.Shopify; return !!(s && typeof s === 'object' && s.theme && typeof s.theme === 'object'); } catch { return false; }
}
export const SHOPIFY_ONLY_MESSAGE = 'v1 of the panel supports only Shopify Online Store themes';
export function isCartPageUrl(url) { try { return CART_PAGE_PATH.test(new URL(url).pathname); } catch { return false; } }
// Where a server redirect caused by an add-to-cart or form POST may go before it is requested: only the landing page, the page the
// action was sent from, "/", the cart page, or a real locale home "/<locale>/" (optionally followed by the cart). No generic home match.
export function allowedAfterCartAction(url, ownHosts, landingPaths = new Set(), fromUrl = '') {
  let x; try { x = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(x.protocol) || !isOwnHost(x.hostname, ownHosts)) return false;
  const p = x.pathname; const same = (q) => q === p || q === p.replace(/\/$/, '') || q === `${p}/`;
  if (p === '/' || isCartPageAllow(p) || [...landingPaths].some(same)) return true;
  let from = ''; try { from = new URL(fromUrl).pathname; } catch {}
  if (from && same(from)) return true;
  return p.endsWith('/') && stripRealLocale(p) === '/';
}
// Checkout recognised by page CONTENT, for checkouts on any slug (/kasse/, /caisse/, /pagar/...). Works on raw HTML (in the guard).
// HTML that is not markup the browser renders (comments, script, style, textarea, template, title and noscript text) is blanked out
// first in one left-to-right pass, so a "<body ...>" written inside a script string or a comment is never read as the page's body.
// Comments end where the HTML parser ends them: "<!-->" and "<!--->" end at once, others at "-->" or "--!>"; "<!...>" and "<?...>"
// (a doctype, a bogus comment) end at the first ">".
const NON_MARKUP = /<!--(?:>|->|[\s\S]*?(?:--!?>|$))|<[!?][^>]*>|<(script|style|textarea|template|title|xmp|noembed|noframes|noscript)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
// One start tag, attribute values (double-quoted, single-quoted or unquoted) read whole, so a ">" or "<body" inside a value is not a tag.
const START_TAG = /<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const TAG_ATTR = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
// keepRawOpen: a script, style or other raw-text element keeps its OWN opening tag (its src, its attributes) while its contents are
// still blanked out, so platform detection sees <script src="/wp-includes/..."> without ever reading text inside a script.
const RAW_OPEN = /^<(?:script|style|textarea|template|title|xmp|noembed|noframes|noscript)\b(?:[^>"']|"[^"]*"|'[^']*')*>/i;
export function startTags(html, { keepRawOpen = false } = {}) {
  const h = String(html || '').slice(0, 3000000).replace(NON_MARKUP, (m, el) => { if (!keepRawOpen || !el) return ' '; const o = RAW_OPEN.exec(m); return o ? `${o[0]} ` : ' '; });
  const out = [];
  for (const m of h.matchAll(START_TAG)) {
    const attrs = {};
    for (const a of m[2].matchAll(TAG_ATTR)) { const k = a[1].toLowerCase(); if (!(k in attrs)) attrs[k] = a[2] ?? a[3] ?? a[4] ?? ''; }
    out.push({ name: m[1].toLowerCase(), attrs });
  }
  return out;
}
const CHECKOUT_BODY = ['woocommerce-checkout', 'woocommerce-order-pay'];
// A payment card field, on any page and any slug (a custom checkout at /cart?stage=payment): autocomplete cc-number, cc-csc, cc-exp
// (and its parts), or a field named or id'd as a card number or security code.
export const PAYMENT_FIELD_NAME = /^(?:(?:cc|card|credit[-_]?card|payment[-_]?card)[-_]?(?:number|num|no)|cardnumber|cvc|cvv2?|csc|card[-_]?(?:cvc|cvv|csc|code)|security[-_]?code)$/i;
export function isPaymentInput(autocomplete, name, id) {
  if (/(?:^|\s)cc-(?:number|csc|exp|exp-month|exp-year)(?:\s|$)/i.test(String(autocomplete || ''))) return true;
  return PAYMENT_FIELD_NAME.test(String(name || '')) || PAYMENT_FIELD_NAME.test(String(id || ''));
}
export function checkoutContentReason(html) {
  const tags = startTags(html);
  const tokens = (v) => String(v || '').split(/\s+/).filter(Boolean);
  // only the first real <body> tag, as the browser reads it
  const body = tags.find((t) => t.name === 'body');
  if (body) { const c = CHECKOUT_BODY.find((k) => tokens(body.attrs.class).includes(k)); if (c) return `body.${c}`; }
  for (const t of tags) {
    if (t.name === 'form' && tokens(t.attrs.class).includes('checkout')) return 'form.checkout';
    if (t.name === 'form' && t.attrs.id === 'order_review') return 'form#order_review';
    if (String(t.attrs['data-block-name'] || '').toLowerCase() === 'woocommerce/checkout') return 'WooCommerce checkout block';
    if (tokens(t.attrs.class).includes('woocommerce-checkout-payment')) return '.woocommerce-checkout-payment';
    if (t.name === 'input' && isPaymentInput(t.attrs.autocomplete, t.attrs.name, t.attrs.id)) return 'a payment card field';
  }
  // Shopify's own checkout pages set Shopify.Checkout.step / .page / .token; a bare Shopify.Checkout object, or a comparison such as
  // Shopify.Checkout.step === 'thank_you' in a storefront analytics snippet, is not enough.
  if (/\bShopify\.Checkout\.(?:step|page|token)\s*=(?!=)/.test(String(html || '').slice(0, 3000000))) return 'Shopify.Checkout';
  return null;
}
// The same test in a live frame (serialised into the page).
export function checkoutContentInPage() {
  try {
    const b = document.body;
    for (const c of ['woocommerce-checkout', 'woocommerce-order-pay']) if (b && b.classList.contains(c)) return `body.${c}`;
    if (document.querySelector('form.checkout')) return 'form.checkout';
    if (document.querySelector('form#order_review')) return 'form#order_review';
    if (document.querySelector('[data-block-name="woocommerce/checkout" i]')) return 'WooCommerce checkout block';
    if (document.querySelector('.woocommerce-checkout-payment')) return '.woocommerce-checkout-payment';
    const pay = /^(?:(?:cc|card|credit[-_]?card|payment[-_]?card)[-_]?(?:number|num|no)|cardnumber|cvc|cvv2?|csc|card[-_]?(?:cvc|cvv|csc|code)|security[-_]?code)$/i;
    for (const i of document.querySelectorAll('input')) if (/(?:^|\s)cc-(?:number|csc|exp|exp-month|exp-year)(?:\s|$)/i.test(i.getAttribute('autocomplete') || '') || pay.test(i.getAttribute('name') || '') || pay.test(i.id || '')) return 'a payment card field';
    const sc = window.Shopify && window.Shopify.Checkout;
    if (sc && (sc.step || sc.page || sc.token)) return 'Shopify.Checkout';
  } catch {}
  return null;
}

// ---------- third-party allow-list ----------
export const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
export function hostMatches(host, pattern) {
  const h = String(host).toLowerCase(); const p = String(pattern).toLowerCase();
  if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
  return h === p;
}
// The store's own host(s): the --url host and its www. variant. WooCommerce's /wp-content/ files on that host are own-host by definition.
export function isOwnHost(host, ownHosts) {
  const h = String(host).toLowerCase();
  return ownHosts.has(h) || ownHosts.has(h.replace(/^www\./, '')) || ownHosts.has(`www.${h}`);
}
export const isAllowedThirdParty = (host, allowHosts) => allowHosts.some((p) => hostMatches(host, p));

// ---------- named block rules: host rules and path rules ----------
// Every named rule in blocklist.json (and in a config's block_rules) says what it matches:
// - kind "host": "hosts" lists host names, matched against the request's HOST NAME ONLY at a label boundary ("clarity.ms" matches
//   clarity.ms and www.clarity.ms, never notclarity.ms). An entry ending in "." is one label with any ending ("elevar." matches
//   elevar.io and cdn.elevar.com, never cheap-elevar.io). An entry may carry a path prefix ("facebook.com/tr"), matched on whole path
//   segments. An optional "path" pattern narrows the rule further and follows the path-rule anchoring below.
// - kind "path": "path" is a pattern tested against the request's path and query, and every top-level alternative must start at a
//   path segment ("^/" or "(^|/)") or at a query parameter ("[?&]"). It always applies on third-party hosts. "own_host": true
//   makes it apply on the store's own host too, and then every alternative must start at the site root ("^/", a platform's real
//   endpoint such as ^/api/collect or ^/cdn/shopifycloud/perf-kit/) or require a query string (a "\?" after a "(^|/)" start, such as a
//   first-party Google tag at .../g/collect?v=2). On the store's own host a path rule never applies under the catalog paths
//   (/products/, /collections/, /product/, /product-category/, /shop/, with or without a locale prefix such as /en-gb/).
// A rule is a KNOWN TRACKER ROOT when it is an own_host path rule whose alternatives all start with "^/" (or a two-letter locale
// prefix and then "/"). A rule marked "endpoint": true (or "endpoint_hosts" naming the host) is a tracker endpoint: stopping it is
// the point. Any other named-rule stop on the store's own host or an allowed host is recorded (rule_hits_on_allowed), and a journey
// that then quits in a way a missing request could cause is a tool limit naming the rule.
// Named rules are never applied to documents (a page or a frame). Images, style sheets, fonts and media on the store's own host or an
// allowed host are only stopped by a host rule or a known-tracker-root rule (an own-host /api/collect sent as an image is still
// stopped), so a product handle or a photo file name that happens to contain a tracker word is never stopped.
export const STATIC_TYPES = new Set(['image', 'stylesheet', 'font', 'media', 'imageset', 'manifest']);
function topLevelAlternatives(src) {
  const out = []; let depth = 0; let cls = false; let cur = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { cur += c + (src[i + 1] || ''); i++; continue; }
    if (cls) { if (c === ']') cls = false; cur += c; continue; }
    if (c === '[') { cls = true; cur += c; continue; }
    if (c === '(') depth++; else if (c === ')') depth--;
    if (c === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur); return out;
}
// Optional locale prefixes before the site root: /en/, /fr/, /en-gb/, /zh-hant/, /es-419/ (the older two-letter form is accepted too)
export const LOCALE_ROOTS = ['^(/[a-z]{2,3}(-[a-z0-9]{2,4})?)?/', '^(/[a-z]{2}(-[a-z]{2})?)?/'];
// What follows the site root (and any locale prefix) in an alternative, or null when it does not start at the root.
const afterRoot = (a) => { if (a.startsWith('^/')) return a.slice(2); const p = LOCALE_ROOTS.find((x) => a.startsWith(x)); return p ? a.slice(p.length) : null; };
// A root alternative: the site root (optionally after a locale prefix), then a LITERAL first path segment (letters, digits, - _ ~ @ %
// or an escaped . @ ~ -) up to a "/" or the end of the alternative. No wildcard, class or optional group before that first "/".
const ROOT_ALT = (a) => { const r = afterRoot(a); return r !== null && /^(?:[A-Za-z0-9_~@%-]|\\[.@~-])+(?:\/|$)/.test(r); };
// Walk one alternative at group depth 0: [{ tok, depth, quant }] where quant is the quantifier after the token (or its group).
function depthTokens(a) {
  const out = []; let depth = 0;
  for (let i = 0; i < a.length; i++) {
    const c = a[i]; let tok = c;
    if (c === '\\') { tok = c + (a[i + 1] || ''); i++; }
    else if (c === '[') { let k = i + 1; while (k < a.length && a[k] !== ']') { if (a[k] === '\\') k++; k++; } tok = a.slice(i, k + 1); i = k; }
    else if (c === '(') { depth++; continue; }
    else if (c === ')') { depth--; const q = a[i + 1]; if (q && '?*{'.includes(q)) out.forEach((t) => { if (t.depth > depth) t.optional = true; }); continue; }
    const q = a[i + 1]; out.push({ tok, depth, quant: q && '?*{+'.includes(q) ? q : '' });
  }
  return out;
}
// A query alternative: a "\?" that is required (at group depth 0 and not optional), then a required "name=" parameter.
const QUERY_ALT = (a) => {
  const t = depthTokens(a).filter((x) => x.depth === 0 && !x.optional);
  const qi = t.findIndex((x) => x.tok === '\\?' && !['?', '*', '{'].includes(x.quant));
  if (qi < 0) return false;
  return t.slice(qi + 1).some((x, k, arr) => x.tok === '=' && !['?', '*', '{'].includes(x.quant) && k > 0 && /^[A-Za-z0-9_-]$/.test(arr[k - 1].tok) && !arr[k - 1].quant);
};
// Paths an endpoint rule must never match (theme files, app proxies, app extensions, a product page, the home page).
export const ENDPOINT_PROBE_PATHS = ['/cdn/shop/t/1/assets/x.js', '/apps/x/y.js', '/extensions/a/b/assets/c.js', '/assets/theme.css', '/products/x', '/',
  '/api/2024-01/graphql.json', '/api/unstable/graphql.json', '/wp-json/wc/store/v1/cart/add-item', '/cart', '/cart.js', '/cart/add.js', '/cart/clear.js',
  '/cdn/shop/t/1/assets/theme.js?v=123', '/?wc-ajax=add_to_cart', '/cdn/s/files/1/0/products/a.jpg', '/s/files/1/a.js', '/s/files/1/x/t/1/assets/global.js'];
// The refusal for a user rule that sets "endpoint" or "endpoint_hosts".
export const USER_ENDPOINT_REFUSAL = "endpoint can only be set on built-in rules; your rule's stops will be counted and named in the report";
const ANCHORED_ALT = /^(\^\/|\^\(\/\[a-z\]\{2(,3)?\}\(-\[a-z(0-9)?\]\{2(,4)?\}\)\?\)\?\/|\\\?|\(\^\|\/\)|\(\?:\^\|\/\)|\[\?&\]|\[&\?\])/;
const HOST_ENTRY = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(\.|(\/[A-Za-z0-9._~@%+-]+)+)?$/;
// Returns a list of problems (empty when the rule is fine).
// { builtin: true } is passed only for the rules in the shipped scripts/blocklist.json. "endpoint" and "endpoint_hosts" are honoured on
// those rules only: a user rule that sets either one is refused, so a loose user pattern can never hide its stops from the report.
export function checkBlockRule(r, { builtin = false } = {}) {
  const errs = [];
  if (!r || typeof r !== 'object') return ['a rule must be an object'];
  if (!builtin && ('endpoint' in r || 'endpoint_hosts' in r)) errs.push(`${USER_ENDPOINT_REFUSAL}. Fix: delete the "endpoint" and "endpoint_hosts" lines from this rule`);
  if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 40) errs.push('"name" must be 1 to 40 characters');
  if ('pattern' in r) errs.push('"pattern" is no longer used: say "kind": "host" with "hosts", or "kind": "path" with "path" and "own_host"');
  const pathOk = (src, what) => {
    const c = safeRegex(src, 'i', { maxLen: 2000 });
    if (c.err) { errs.push(`${what} does not compile (${c.err}). Fix: in JSON every backslash is written twice, so a literal dot is "\\\\."`); return; }
    const bad = topLevelAlternatives(src).filter((a) => !ANCHORED_ALT.test(a));
    if (bad.length) errs.push(`${what}: every alternative must start at a path segment ("^/" or "(^|/)") or a query parameter ("[?&]"); not anchored: ${bad.map((b) => JSON.stringify(b.slice(0, 40))).join(', ')}. Fix: put "^/" in front for a path from the site root, or "(^|/)" for a path segment anywhere`);
    if (r.kind === 'path' && r.own_host === true) {
      const loose = topLevelAlternatives(src).filter((a) => !ROOT_ALT(a) && !QUERY_ALT(a));
      if (loose.length) errs.push(`${what}: with "own_host": true every alternative must start at the site root ("^/") or require a query string ("\\?"); too loose for the store's own paths: ${loose.map((b) => JSON.stringify(b.slice(0, 40))).join(', ')}. Fix: start it with "^/" and the first folder name (for example "^/my-tracker/"), or set "own_host": false if it is meant for other sites only`);
    }
  };
  if (r.kind === 'host') {
    if (!Array.isArray(r.hosts) || !r.hosts.length) errs.push('a host rule needs a non-empty "hosts" list');
    else for (const h of r.hosts) {
      if (typeof h !== 'string' || !HOST_ENTRY.test(h)) errs.push(`host ${JSON.stringify(h)} is not a host name (examples: clarity.ms; facebook.com/tr; or "elevar." with the trailing dot, which means elevar with any ending, such as elevar.io)${typeof h === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(h) ? '. Fix: remove https:// and the trailing /' : ''}`);
      else if (!/[./]/.test(h.replace(/\.$/, '')) && !h.endsWith('.')) errs.push(`host ${JSON.stringify(h)} needs a dot (a bare word would match too much). Fix: write the full host name, for example "stats.example.com"`);
    }
    if (r.path !== undefined) pathOk(r.path, '"path"');
    if ('own_host' in r) errs.push('"own_host" belongs to path rules only');
  } else if (r.kind === 'path') {
    if (typeof r.path !== 'string') errs.push('a path rule needs a "path" pattern');
    else pathOk(r.path, '"path"');
    if (typeof r.own_host !== 'boolean') errs.push('a path rule must say "own_host": true or false. Fix: add "own_host": false to stop it on other sites only, or true to stop it on the store too');
    if ('hosts' in r) errs.push('"hosts" belongs to host rules only');
  } else errs.push('"kind" must be "host" or "path". Fix: use "host" with a "hosts" list to stop a whole site, or "path" with a "path" pattern');
  // The endpoint shape checks below apply to the built-in rules only; a user rule with either key is already refused above,
  // so the user sees one plain reason and its fix instead of a list of shape rules they cannot use.
  if (builtin && 'endpoint' in r) {
    if (typeof r.endpoint !== 'boolean') errs.push('"endpoint" must be true or false');
    else if (r.endpoint && r.kind === 'path' && typeof r.path === 'string') {
      const alts = topLevelAlternatives(r.path);
      if (!alts.every(ROOT_ALT) && !alts.every(QUERY_ALT)) errs.push('"endpoint": true is only for a host rule, a path rule whose alternatives all start at the site root ("^/", optionally after a locale prefix) with a literal first path segment, or one whose alternatives all require a query string ("\\?", not optional) and a "name=" parameter; use "endpoint_hosts" to mark a looser third-party path rule as an endpoint on named hosts only');
    }
  }
  if (builtin && 'endpoint_hosts' in r) {
    if (r.kind !== 'path' || r.own_host !== false) errs.push('"endpoint_hosts" belongs to path rules with "own_host": false only');
    else if (!Array.isArray(r.endpoint_hosts) || !r.endpoint_hosts.length || !r.endpoint_hosts.every((h) => typeof h === 'string' && HOST_ENTRY.test(h) && /\./.test(h) && !/[/]/.test(h) && !h.endsWith('.'))) errs.push('"endpoint_hosts" must be a non-empty list of full host names (example: cdn.shopify.com)');
  }
  // behaviour check: an endpoint rule's pattern must not match ordinary theme, app, extension, product or home paths
  if (builtin && (r.endpoint === true || 'endpoint_hosts' in r) && typeof r.path === 'string') {
    const c = safeRegex(r.path, 'i', { maxLen: 2000 });
    const hits = c.err ? [] : ENDPOINT_PROBE_PATHS.filter((pp) => c.re.test(pp));
    if (hits.length) errs.push(`an endpoint rule must not match ordinary store paths, but this "path" matches ${hits.map((x) => JSON.stringify(x)).join(', ')}`);
  }
  return errs;
}
// A serialisable spec ({ name, kind, hosts, path, ownHost }) that the page script can use too.
export function compileBlockRule(r, opts = {}) {
  const errs = checkBlockRule(r, opts);
  if (errs.length) return { err: errs.join('; ') };
  const knownRoot = r.kind === 'path' && r.own_host === true && topLevelAlternatives(r.path).every(ROOT_ALT);
  return { rule: { name: String(r.name).slice(0, 40), kind: r.kind, hosts: (r.hosts || []).map((h) => h.toLowerCase()), path: r.path || null, ownHost: r.kind === 'path' ? r.own_host : false, knownRoot, endpoint: r.endpoint === true, endpointHosts: (r.endpoint_hosts || []).map((h) => h.toLowerCase()) } };
}
// Pure and self-contained (it is also embedded in the page script): does the spec match this host and path+query?
export function blockRuleHit(spec, host, pathQuery, own) {
  const re = (src) => { try { return new RegExp(src, 'i'); } catch (e) { return null; } };
  const pathname = String(pathQuery).split('?')[0];
  // Hard allow: the store's own cart and store API paths (/cart, /cart.js, /cart/add, /cart/change, /cart/update, /cart/clear, each
  // with or without .js; /api/<version>/graphql.json; /wp-json/wc/store/...) are never stopped by a named rule (built-in or user), whatever the rule says.
  // Checkout guarding runs before any rule, so a checkout request is still stopped. Strict locale prefix only.
  const seg1 = /^\/([^/]+)\//.exec(pathname); const bare = seg1 && isRealLocaleSegment(seg1[1]) ? pathname.slice(seg1[1].length + 1) : pathname;
  if (own && /^\/(?:cart(?:\.js)?|cart\/(?:add|change|update|clear)(?:\.js)?|api\/[^/?#]+\/graphql\.json|wp-json\/wc\/store(?:\/.*)?)\/?$/i.test(bare)) return false;
  if (spec.kind === 'host') {
    const hostHit = spec.hosts.some((e) => {
      const slash = e.indexOf('/'); const h = slash < 0 ? e : e.slice(0, slash); const pre = slash < 0 ? '' : e.slice(slash);
      const hm = h.endsWith('.') ? (host.startsWith(h) || host.includes('.' + h)) : (host === h || host.endsWith('.' + h));
      return hm && (!pre || pathname.toLowerCase() === pre.toLowerCase() || pathname.toLowerCase().startsWith(pre.toLowerCase() + '/'));
    });
    if (!hostHit) return false;
    if (!spec.path) return true;
    const r = re(spec.path); return !!r && r.test(pathQuery);
  }
  if (spec.kind === 'path') {
    if (own && !spec.ownHost) return false;
    // the store's own catalog pages and their JSON and section fetches are never a tracker endpoint
    if (own && /^\/(products|collections|product|product-category|shop)(\/|$)/i.test(bare)) return false;
    const r = re(spec.path); return !!r && r.test(pathQuery);
  }
  return false;
}
// A known tracker root (an own_host path rule whose alternatives all start at the site root): it still applies to the store's own
// images and style sheets (an /api/collect sent as an image is still stopped).
export const isKnownRootRule = (r) => !!r && r.kind === 'path' && r.ownHost === true && r.knownRoot === true;
// A rule marked "endpoint": true (or "endpoint_hosts" naming this host) only ever stops tracker endpoints: stopping it is the point,
// never a sign the test broke the page, so its stops are never recorded in rule_hits_on_allowed.
export const isTrackerEndpointRule = (r, host = '') => !!r && (r.endpoint === true || (!!host && Array.isArray(r.endpointHosts) && r.endpointHosts.includes(String(host).toLowerCase())));
// Does this host rule stop EVERY request to the host (a host entry with no path prefix and no "path" pattern)?
export function hostRuleCovers(spec, host) {
  if (!spec || spec.kind !== 'host' || spec.path) return false;
  const h0 = String(host).toLowerCase().replace(/^\*\./, '');
  const names = String(host).startsWith('*.') ? [h0, `www.${h0}`] : [h0];
  return names.some((h) => spec.hosts.some((e) => !e.includes('/') && (e.endsWith('.') ? (h.startsWith(e) || h.includes('.' + e)) : (h === e || h.endsWith('.' + e)))));
}
// The first named rule that applies to a request, or null. resourceType is Playwright's (lowercase) or CDP's (any case).
export function findBlockRule(rules, url, { ownHosts, allowHosts = [], resourceType = '', isDocument = false } = {}) {
  if (isDocument) return null;
  let u; try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const own = !!ownHosts && isOwnHost(host, ownHosts);
  const rt = String(resourceType).toLowerCase();
  if (rt === 'document') return null;
  const pq = u.pathname + u.search;
  // own or allowed images, style sheets, fonts and media: only host rules and known-tracker-root rules apply
  const staticOnAllowed = (own || isAllowedThirdParty(host, allowHosts)) && STATIC_TYPES.has(rt);
  return rules.find((r) => (!staticOnAllowed || r.kind === 'host' || isKnownRootRule(r)) && blockRuleHit(r, host, pq, own)) || null;
}

// ---------- bot challenge detection ----------
// Pure: pass what you saw. Used only to label the run honestly, never to get past a challenge.
export function detectChallenge({ status = 0, headers = {}, title = '', url = '', body = '', cookieNames = [] }) {
  const hdr = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const bad = status === 403 || status === 503 || status === 429;
  const titleHit = /just a moment|verifying your connection|checking your browser|attention required|verify you are human|access denied/i.test(title);
  const urlHit = /\/challenge(\/|\?|$)|__cf_chl|cf_chl_/i.test(url);
  const hdrHit = /challenge/i.test(hdr['cf-mitigated'] || '');
  const bodyHit = /cf-chl|__cf_chl_|cf-browser-verification|Verifying your connection|Just a moment/i.test(String(body).slice(0, 200000));
  const akamai = bad && cookieNames.includes('_abck') && /akamai/i.test(`${hdr.server || ''} ${hdr['x-akamai-transformed'] || ''}`);
  if (hdrHit) return 'challenge header';
  if (urlHit) return 'challenge URL';
  if (titleHit && (bad || bodyHit || status === 0 || status === 200)) return `challenge page title "${oneLine(title, 40)}"`;
  if (bad && bodyHit) return 'challenge page text';
  if (akamai) return 'Akamai bot check';
  return null;
}

// ---------- safe regex from persona and CLI strings ----------
export const MAX_REGEX_LEN = 200;
export function wordBounded(p) {
  const src = String(p);
  const first = src[0]; const last = src[src.length - 1];
  const w = /[A-Za-z0-9_]/;
  // A trailing escape such as \d or \w is a class, not a literal word character, so no boundary goes after it
  // (otherwise "\$\s?\d" would demand a single-digit price and never match "$55.00").
  const lastEscaped = src.length > 1 && src[src.length - 2] === '\\';
  return `${w.test(first || '') ? '\\b' : ''}(?:${src})${w.test(last || '') && !lastEscaped ? '\\b' : ''}`;
}
// {price} in a persona pattern matches a price in any common currency and format: $24, $24.00, 24,00 €, £1,299.99, EUR 24, 24 kr.
// A persona that writes "\\$\\d+" misses "24,00 €"; "{price}" does not.
// (it is the same money pattern the price check uses, MONEY_RE below)
// Patterns a persona may not use because they can take very long on a long page (catastrophic backtracking): a quantified group
// that itself holds a quantifier, such as (a+)+ or (\w*)*, and backreferences. Lookbehind is refused too.
export function slowPatternReason(src) {
  const t = String(src).replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'x');
  if (/\\[1-9]|\\k</.test(String(src))) return 'it uses a backreference, which can make a check very slow';
  if (/\(\?<[=!]/.test(t)) return 'it uses a lookbehind, which this panel does not accept';
  // a group with a quantifier inside, itself followed by a quantifier
  const stack = [];
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '(') stack.push({ inner: false });
    else if (ch === ')') {
      const g = stack.pop() || { inner: false };
      const after = t[i + 1];
      const quantified = after === '*' || after === '+' || (after === '{' && /^\{\d*,\d*\}/.test(t.slice(i + 1)) && !/^\{\d+\}/.test(t.slice(i + 1)));
      if (g.inner && quantified) return 'it repeats a group that itself repeats, such as (a+)+, which can make a check very slow';
      if (stack.length && (g.inner || quantified)) stack[stack.length - 1].inner = true;
    } else if ((ch === '*' || ch === '+' || ch === '{') && stack.length) {
      if (ch !== '{' || /^\{\d*,\d*\}/.test(t.slice(i)) && !/^\{\d+\}/.test(t.slice(i))) stack[stack.length - 1].inner = true;
    }
  }
  return null;
}
export function safeRegex(src, flags = 'i', { bounded = false, maxLen = MAX_REGEX_LEN } = {}) {
  if (typeof src !== 'string' || !src.length) return { err: 'empty pattern' };
  if (src.length > maxLen) return { err: `pattern longer than ${maxLen} characters` };
  const slow = slowPatternReason(src.replaceAll('{price}', 'x'));
  if (slow) return { err: slow };
  const full = src.replaceAll('{price}', `(?:${MONEY_RE.source})`);
  try { return { re: new RegExp(bounded ? wordBounded(full) : full, flags) }; } catch (e) { return { err: oneLine(e.message, 100) }; }
}

// ---------- the trust-info scan: first match over text segments ----------
export const MAX_SCAN_CHARS = 200000;
// A bare heading (a heading, summary, tab button, table or list term) is a title, not the information itself: "Returns" or
// "Reviews (37)" on its own does not say what the return policy is or what reviewers said.
const HEADING_SEG = /(?:^|> )(?:h[1-6]|summary|button|dt|th|legend)(?:[#.][^>]*)?$/i;
export const isHeadingSegment = (s) => !!s && HEADING_SEG.test(String(s.path || '')) && String(s.text || '').length <= 80;
// Body text for heading segment i. First what the page structure says the heading introduces (segment.body: a dd, a td in the
// th's row or column, a fieldset's option labels, a <details> body, a container right after a heading), whatever its length; when
// that structure exists but is empty the heading is heading only. Then a dd right after a dt. Otherwise (no structure at all) the
// next 2 segments, stopping at the next heading: the one straight after with any letter or digit, the one after that with at least
// 15 letters of ordinary text.
function bodyAfter(segments, i) {
  const s = segments[i];
  // a structural body (segment.body present): it is the answer, and an empty one makes the heading heading only
  if (typeof s.body === 'string') return /[A-Za-z0-9\u00c0-\uffff]/.test(s.body) ? { path: s.path, text: s.body } : null;
  const nx = segments[i + 1];
  if (nx && /(?:^|> )dt(?:[#.][^>]*)?$/i.test(String(s.path || '')) && /(?:^|> )dd(?:[#.][^>]*)?$/i.test(String(nx.path || '')) && nx.text.trim()) return nx;
  // a th is never paired with whatever comes next in reading order
  if (/(?:^|> )th(?:[#.][^>]*)?$/i.test(String(s.path || ''))) return null;
  // the segment straight after the heading counts with any letter or digit ("30 days", "100% organic cotton"); one further away needs
  // at least 15 letters of ordinary text
  for (let k = i + 1; k < Math.min(segments.length, i + 3); k++) {
    if (isHeadingSegment(segments[k])) return null;
    if (k === i + 1 && /[A-Za-z0-9\u00c0-\uffff]/.test(segments[k].text)) return segments[k];
    if ((segments[k].text.match(/[A-Za-z\u00c0-\uffff]/g) || []).length >= 15) return segments[k];
  }
  return null;
}
// requireBody: a match inside a bare heading counts only when body text follows it; otherwise the result is marked headingOnly
// (returned only when nothing better matched), so the caller can say "heading only" instead of "found".
// A picker's legend (a fieldset of options): when the matched word is only the picker's own label (size, colour, fit...), the option
// labels are never the answer; otherwise they count only when they match one of the need's patterns (patterns), marked "(picker options)".
const PICKER_LABEL = /^(?:sizes?|colou?rs?|fits?|styles?|options?|services?)$/i;
const LEGEND_SEG = /(?:^|> )legend(?:[#.][^>]*)?$/i;
// A picker's own form label (a Woo variations "th > label", a Dawn dropdown "label.form__label") that is only the option name
// ("Size", "Size:", "Choose a size") names the picker; it is never the information itself, so it never counts as found.
const LABEL_SEG = /(?:^|> )label(?:[#.][^>]*)?$/i;
const BARE_PICKER = /^\s*(?:(?:choose|select|pick)\s+(?:an?\s+|your\s+|the\s+)?)?(?:sizes?|colou?rs?|fits?|styles?|options?|services?)\s*:?\s*$/i;
export const isPickerLabel = (s) => !!s && LABEL_SEG.test(String(s.path || '')) && BARE_PICKER.test(String(s.text || ''));
// A button that opens a guide ("Size guide", "Size chart", "Find my size") is the guide's way in: it counts on its own.
const GUIDE_BUTTON = /\b(?:guide|chart|calculator|finder)\b|\bfind\s+(?:my|your)\s+(?:size|fit)\b/i;
const BUTTON_SEG = /(?:^|> )button(?:[#.][^>]*)?$/i;
export function matchTerm(segments, re, { requireBody = false, patterns = [re] } = {}) {
  let headingOnly = null;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (isPickerLabel(s)) continue;
    const m = re.exec(s.text);
    if (m && requireBody && BUTTON_SEG.test(String(s.path || '')) && GUIDE_BUTTON.test(s.text)) return { path: s.path, matched: m[0], context: `${oneLine(s.text, 70)} (guide button)` };
    if (m && requireBody && isHeadingSegment(s)) {
      let body = bodyAfter(segments, i);
      const picker = LEGEND_SEG.test(String(s.path || ''));
      if (body && picker && (PICKER_LABEL.test(m[0].trim()) || !patterns.some((p) => p.test(body.text)))) body = null;
      if (body && picker) return { path: s.path, matched: m[0], context: `${oneLine(s.text, 60)}: ${oneLine(body.text, 60)}${body.text.length > 60 ? '...' : ''} (picker options)` };
      if (!body) { if (!headingOnly) headingOnly = { path: s.path, matched: m[0], context: oneLine(s.text, 80), headingOnly: true }; continue; }
      return { path: s.path, matched: m[0], context: `${oneLine(s.text, 60)}: ${oneLine(body.text, 70)}${body.text.length > 70 ? '...' : ''}` };
    }
    if (m) {
      // about 30 characters either side, widened to whole words, with "..." where the text was cut
      const t = s.text; let a = Math.max(0, m.index - 30); let b = Math.min(t.length, m.index + m[0].length + 30);
      while (a > 0 && a > m.index - 50 && !/\s/.test(t[a - 1])) a--;
      while (b < t.length && b < m.index + m[0].length + 50 && !/\s/.test(t[b])) b++;
      const context = `${a > 0 ? '...' : ''}${t.slice(a, b).replace(/\s+/g, ' ').trim()}${b < t.length ? '...' : ''}`;
      return { path: s.path, matched: m[0], context };
    }
  }
  return headingOnly;
}

// ---------- money ----------
// Longer symbols first so "R$" wins over "R" and "Rs." over "R". A bare "R" (South African rand) only counts right before a number.
const SYM_PRE = ['US\\$', 'C\\$', 'CA\\$', 'A\\$', 'AU\\$', 'NZ\\$', 'R\\$', 'HK\\$', 'S\\$', '\\$', '€', '£', '¥', '₹', '₩', '₺', '₱', '฿', '₫', 'zł', 'Kč', 'kr\\.?', 'Rs\\.?', 'Rp', 'RM', 'CHF', 'Fr\\.',
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'INR', 'SEK', 'NOK', 'DKK', 'PLN', 'PHP', 'THB', 'VND', 'MYR', 'CZK', 'ZAR', 'PKR', 'LKR', 'IDR', 'R(?=\\s?\\d)'];
const SYM = `(?:${SYM_PRE.join('|')})`;
const NUM = "(\\d{1,3}(?:[.,\\s\\u00a0\\u202f']\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
export const MONEY_RE = new RegExp(`(?<![A-Za-z])${SYM}\\s?${NUM}(?![\\d])|(?<![\\d.,])${NUM}\\s?${SYM}(?![A-Za-z])`, 'i');
export function moneyValue(numText) {
  let s = String(numText).replace(/[\s\u00a0\u202f']/g, '');
  const lastDot = s.lastIndexOf('.'); const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    const tail = parts[parts.length - 1];
    s = parts.length === 2 && tail.length <= 2 ? `${parts[0]}.${tail}` : parts.join('');
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}
// Finds the first money amount in a short text: symbol before or after the number, or an ISO code ("$25", "25,00 €", "USD 25", "kr 99").
export function parseMoney(text) {
  const m = MONEY_RE.exec(String(text ?? ''));
  if (!m) return null;
  const num = m[1] ?? m[2];
  const value = moneyValue(num);
  if (value === null) return null;
  return { text: m[0].replace(/\s+/g, ' ').trim(), value };
}
// candidates: visible elements with money-looking text, read by readPriceCandidates. structured: { value, source } or null.
// Prefers an element inside the product block that shows the structured price; never a header, banner, fixed bar or short sticky bar
// (those are dropped page-side).
export function pickPrice(candidates, structured) {
  const scored = [];
  for (const c of candidates || []) {
    const m = parseMoney(c.text);
    if (!m) continue;
    const matches = structured && structured.value !== null && Math.abs(m.value - structured.value) < 0.006;
    const score = (matches ? 8 : 0) + (c.inRoot ? 4 : 0) + (c.priceLike ? 2 : 0);
    scored.push({ ...c, money: m, matches, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || a.top - b.top);
  const best = scored[0];
  return { text: best.money.text, value: best.money.value, top: best.top, bottom: best.bottom, in_product_block: !!best.inRoot, matches_structured: !!best.matches, structured_source: structured?.source || null };
}
// The price step's decision. No visible price parses but the page data has one and its digits show in the product block: the price is
// there in a format the panel cannot read, which is a limit of the panel, not a missing price.
export function resolvePrice(candidates, structured) {
  const price = pickPrice(candidates, structured);
  if (price) return { price, label: null };
  if (structured && structured.value !== null && Number.isFinite(structured.value)) {
    const whole = String(Math.trunc(structured.value));
    const c = (candidates || []).find((x) => x.inRoot && x.text.replace(/\D/g, '').includes(whole));
    if (c) return { price: { text: oneLine(c.text, 60), value: structured.value, top: c.top, bottom: c.bottom, in_product_block: true, matches_structured: true, structured_source: structured.source, unrecognised_format: true }, label: 'price shown in an unrecognised format' };
    return { price: null, label: 'no visible price' };
  }
  return { price: null, label: 'no visible price' };
}

// ld+json blocks (raw text) -> is a Product the main entity, and its offer price.
export function ldProductInfo(jsonTexts) {
  const nodes = [];
  const add = (x) => { if (Array.isArray(x)) x.forEach(add); else if (x && typeof x === 'object') nodes.push(x); };
  const tops = [];
  for (const t of jsonTexts || []) { try { const j = JSON.parse(t); add(j); tops.push(...(Array.isArray(j) ? j : [j])); } catch {} }
  const types = (n) => [].concat(n?.['@type'] || []).map(String);
  const graph = nodes.flatMap((n) => (Array.isArray(n['@graph']) ? n['@graph'] : []));
  const all = [...nodes, ...graph];
  const products = all.filter((n) => types(n).some((t) => /^(Product|ProductGroup)$/.test(t)));
  const lists = all.filter((n) => types(n).some((t) => /^(ItemList|CollectionPage|OfferCatalog)$/.test(t)));
  let main = null;
  const topProduct = tops.find((n) => types(n).some((t) => /^(Product|ProductGroup)$/.test(t)));
  if (topProduct && !lists.length) main = topProduct;
  if (!main) { const page = all.find((n) => types(n).includes('WebPage') && n.mainEntity && types(n.mainEntity).some((t) => /^Product/.test(t))); if (page) main = page.mainEntity; }
  if (!main && graph.length && !lists.length) { const gp = graph.filter((n) => types(n).some((t) => /^Product/.test(t))); if (gp.length === 1) main = gp[0]; }
  let price = null; let currency = null;
  if (main) {
    const offers = [].concat(main.offers || (main.hasVariant ? [].concat(main.hasVariant).flatMap((v) => [].concat(v.offers || [])) : []));
    for (const o of offers) {
      const p = o?.price ?? o?.lowPrice ?? o?.priceSpecification?.price;
      if (p !== undefined && p !== null && Number.isFinite(Number(p))) { price = Number(p); currency = o.priceCurrency || o?.priceSpecification?.priceCurrency || null; break; }
    }
  }
  return { isMain: !!main, products: products.length, lists: lists.length, price, currency };
}

// ---------- product page detection ----------
// A product page is decided by its URL (/products/<handle>, /product/<slug>), an ld+json Product as the main entity, or exactly one
// add-to-cart form outside any product grid. A collection page with quick-add buttons (several forms) is NOT a product page.
export function decideProductPage({ url, ldMain = false, addForms = 0 }) {
  let p = ''; try { p = new URL(url).pathname; } catch {}
  if (/\/products\/[^/]+/i.test(p) || /\/product\/[^/]+/i.test(p)) return { isProduct: true, why: 'product URL' };
  if (ldMain) return { isProduct: true, why: 'ld+json Product is the main entity' };
  if (addForms === 1) return { isProduct: true, why: 'exactly one add-to-cart form' };
  return { isProduct: false, why: addForms > 1 ? `${addForms} add-to-cart forms (a listing with quick-add buttons)` : 'no product URL, no ld+json Product, no add-to-cart form' };
}

// ---------- selectors (passed into page-side readers as data) ----------
export const SEL = {
  productRoot: 'product-info, .product__info-container, .product__info-wrapper, .summary.entry-summary, .entry-summary, .woocommerce-product-details__short-description, .woocommerce-Tabs-panel--description, .woocommerce-Tabs-panel:not(.woocommerce-Tabs-panel--reviews), .woocommerce-product-attributes, table.shop_attributes, [itemtype*="schema.org/Product" i], .product-single__meta, .product-details, .product-info, #product-info',
  addForm: 'form[action*="/cart/add"], form.cart, form.variations_form',
  grid: '#product-grid, .product-grid, [class*="product-grid" i], [class*="collection-grid" i], ul.products, [class*="product-list" i], [data-product-grid], .wc-block-product-template, .wc-block-grid__products, .wp-block-woocommerce-product-collection',
  reviews: '[class*="review" i], [id*="review" i], [class*="jdgm" i], [class*="yotpo" i], [class*="okendo" i], [class*="stamped" i], [class*="loox" i], [class*="testimonial" i]',
  chrome: 'nav, header, footer, [role="banner"], [role="navigation"], [role="contentinfo"], [class*="breadcrumb" i], [class*="announcement" i]',
  elsewhere: '[class*="related" i], [class*="recommend" i], .upsells, .cross-sells, [class*="cart-drawer" i], cart-drawer, [class*="cart-notification" i]',
  noText: 'script, style, noscript, template',
  // No class-name test for "sticky": Dawn's tall info column is product__column-sticky. Pinned bars are found by computed style instead.
  priceNoise: '[class*="installment" i], shopify-payment-terms, s, del, [class*="compare" i], [class*="was-price" i], [class*="banner" i]',
};

// ---------- page-side readers (serialised into the page: no closures, no imports; data comes in as the argument) ----------
export function readPageShape(sel) {
  const forms = [...document.querySelectorAll(sel.addForm)].filter((f) => !f.closest(sel.grid) && !f.closest(sel.elsewhere));
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent || '').slice(0, 20);
  return { addForms: forms.length, ld };
}

// Is the page usable for a shopper: a visible heading (h1, h2, role=heading, the product title, or the ld+json product name shown as
// text) and a loaded photo. textChars tells a blank page (a store problem) from a page the panel could not read (a tool limit).
export function readUsable() {
  const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const img = [...document.images].some((i) => vis(i) && i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().width >= innerWidth * 0.3);
  const anyImg = document.images.length > 0;
  const sel = 'h1, h2, [role="heading"], .product_title, .product__title, [class*="product-title" i], [class*="product_title" i], [itemprop="name"], .wp-block-post-title';
  const h = [...document.querySelectorAll(sel)].find((e) => vis(e) && (e.innerText || '').trim());
  let heading = h ? (h.matches('h1') ? 'h1' : h.matches('h2') ? 'h2' : h.getAttribute('role') === 'heading' ? 'role=heading' : 'product title') : null;
  const text = document.body ? document.body.innerText || '' : '';
  if (!heading) {
    const names = [];
    for (const sc of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { const walk = (o) => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk); if (/Product/i.test(String(o['@type'])) && typeof o.name === 'string') names.push(o.name.trim()); Object.values(o).forEach(walk); }; walk(JSON.parse(sc.textContent || '')); } catch {}
    }
    if (names.some((n) => n.length >= 3 && text.toLowerCase().includes(n.toLowerCase()))) heading = 'ld+json product name';
  }
  return { ok: !!heading && img, heading, img, anyImg, textChars: text.trim().length };
}
// Visible buy-style button or checkout-style text: tells "this page has no add to cart / no checkout" (a store problem) from "the
// panel did not recognise the control" (a tool limit).
export function visibleBuyButton() {
  const rx = /\b(add to (cart|bag|basket)|buy now|buy it now|in den warenkorb|ajouter au panier|a\u00f1adir al carrito|toevoegen aan winkelwagen)\b/i;
  const el = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')].find((e) => e.getClientRects().length && rx.test(e.innerText || e.value || ''));
  return el ? (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40) : null;
}
export function visibleCheckoutText() {
  // the same checkout words as CHECKOUT_LABEL (written out again: this runs in the page)
  const rx = /\b(?:check\s*-?\s*out|kasse|caisse|pagar|afrekenen|commander|finalizar|paiement|(?:proceed|continue)\s+to\s+(?:checkout|payment))\b/i;
  const el = [...document.querySelectorAll('button, input[type="submit"], a, [role="button"]')].find((e) => e.getClientRects().length && !e.closest('header, nav, footer') && rx.test(e.innerText || e.value || ''));
  return el ? (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40) : null;
}
// The cart's Checkout control, described in the page (passed to locator.evaluate, so it uses nothing outside itself). The runner
// accepts it only when checkoutControlProblem() finds nothing wrong: a real control, a checkout label, an own-host checkout or cart
// destination (or the cart form's name="checkout" submit), and no express or wallet button around it or behind it.
export function describeCheckoutCandidate(el) {
  const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
  const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  const enabled = !(el.disabled || el.getAttribute('aria-disabled') === 'true' || /(^|\s)(disabled|is-disabled)(\s|$)/.test(el.className || ''));
  const tag = el.tagName; const type = String(el.getAttribute('type') || '').toLowerCase();
  const submit = (tag === 'BUTTON' && (type === '' || type === 'submit')) || (tag === 'INPUT' && (type === 'submit' || type === 'image'));
  const control = tag === 'A' ? el.hasAttribute('href') : tag === 'BUTTON' ? ['', 'submit', 'button'].includes(type) : tag === 'INPUT' ? ['submit', 'button', 'image'].includes(type) : false;
  let target = null;
  if (tag === 'A') target = el.hasAttribute('href') ? el.href : null;
  else if (submit && el.form) target = el.hasAttribute('formaction') ? el.formAction : el.form.action;
  const exp = el.closest('[class*="dynamic-checkout" i], [class*="additional-checkout" i], [class*="express" i], [class*="accelerated" i], [class*="wallet" i], [class*="paypal" i], [class*="apple-pay" i], [class*="google-pay" i], [class*="shop-pay" i], [class*="shopify-payment-button" i], [data-shopify="payment-button"], shopify-accelerated-checkout, shopify-accelerated-checkout-cart');
  // the page root never counts (a theme may carry a name like "express" on <body>)
  const express = !!exp && exp !== document.body && exp !== document.documentElement;
  return {
    visible, enabled, tag, type, control, express, target, top: Math.round(r.top + scrollY),
    name_checkout: submit && !!el.form && el.getAttribute('name') === 'checkout',
    label: String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
  };
}
// The checkout words the panel reads on a cart control, one list everywhere (visibleCheckoutText and findCheckoutInPage run in the page
// and carry the same pattern written out; a test keeps the three equal): English, German, French, Spanish, Portuguese and Dutch.
export const CHECKOUT_LABEL = /\b(?:check\s*-?\s*out|kasse|caisse|pagar|afrekenen|commander|finalizar|paiement|(?:proceed|continue)\s+to\s+(?:checkout|payment))\b/i;
// R27: where a cart's Checkout control may lead, checked path by path (after one real locale prefix such as /en-ca/): Shopify's
// /checkout, /checkouts/... and /cart/checkout, a /kasse checkout slug, or the canonical cart page /cart, which only the cart form's own
// name="checkout" submit may target. A login, account or payment route, a cart action endpoint (/cart/add, /change, /update, /clear)
// and any .js or .json address are refused, whatever the control is called.
const DEST_LOGIN_SEG = /^(?:account|accounts|login|logout|signin|sign-in|sign_in|register|customer|customers|password|auth|session|sessions)$/i;
const DEST_PAY_SEG = /^(?:pay|payment|payments|wallet|wallets|paypal|billing)$/i;
export function checkoutDestinationProblem(pathname, nameCheckout = false) {
  const raw = String(pathname || '/');
  const p = stripRealLocale(raw);
  const shown = JSON.stringify(raw.slice(0, 60));
  if (/\.(?:js|json)\/?$/i.test(p)) return `it leads to ${shown}, a script or data address, not a page`;
  const segs = p.split('/').filter(Boolean);
  if (segs.some((x) => DEST_LOGIN_SEG.test(x))) return `it leads to ${shown}, a login or account address`;
  if (segs.some((x) => DEST_PAY_SEG.test(x))) return `it leads to ${shown}, a payment address`;
  if (/^\/cart\/(?:add|change|update|clear)(?:[/.]|$)/i.test(p)) return `it leads to ${shown}, a cart action, not the checkout`;
  if (/^\/cart\/?$/i.test(p)) return nameCheckout ? null : `it leads back to the cart page (${shown}); only the cart form's own Checkout submit (name="checkout") may do that`;
  if (/^\/(?:checkout|checkouts(?:\/[^/]+)*|cart\/checkout|kasse)\/?$/i.test(p)) return null;
  return `it leads to ${shown}, not the store's checkout or cart`;
}
// Why a cart control is not the cart's regular Checkout button (null when it is). d is what describeCheckoutCandidate() returned.
export function checkoutControlProblem(d, pageUrl, ownHosts) {
  if (!d || !d.control) return 'it is not a button, a submit input or a link with an address';
  if (d.express) return 'it sits inside an express or wallet checkout block';
  if (!CHECKOUT_LABEL.test(d.label || '')) return `its label ${JSON.stringify(String(d.label || '').slice(0, 40))} does not say checkout`;
  if (!d.target) return d.name_checkout ? 'its form has no address' : 'it leads nowhere the panel can read';
  let u; try { u = new URL(d.target, pageUrl); } catch { return 'its address cannot be read'; }
  if (!/^https?:$/.test(u.protocol)) return `its address is a ${u.protocol} address`;
  const pay = paymentHostReason(u.hostname);
  if (pay) return `it leads to a ${pay}`;
  if (!isOwnHost(u.hostname, ownHosts)) return `it leads to another host (${u.hostname})`;
  return checkoutDestinationProblem(u.pathname, !!d.name_checkout);
}
// Product links anywhere outside the header, menu and footer: used to tell "no products here" (a store problem) from "the panel did
// not recognise this product grid" (a tool limit).
export function countProductLinks({ sel, linkSrc }) {
  const rx = new RegExp(linkSrc, 'i'); const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    if (a.closest(sel.chrome) || a.closest(sel.elsewhere) || !a.getClientRects().length) continue;
    let u; try { u = new URL(a.href, location.href); } catch { continue; }
    if (u.origin === location.origin && rx.test(u.pathname)) seen.add(u.pathname);
  }
  return seen.size;
}

// Product grid links only: never the header, menu, footer, announcement bar or related-products rows.
export function readGridLinks({ sel, linkSrc }) {
  const rx = new RegExp(linkSrc, 'i');
  const grids = [...document.querySelectorAll(sel.grid)];
  const seen = new Set(); const out = [];
  for (const g of grids) {
    for (const a of g.querySelectorAll('a[href]')) {
      if (a.closest(sel.chrome) || a.closest(sel.elsewhere)) continue;
      if (!a.getClientRects().length) continue;
      let u; try { u = new URL(a.href, location.href); } catch { continue; }
      if (u.origin !== location.origin || !rx.test(u.pathname) || seen.has(u.pathname)) continue;
      const card = a.closest('li, article, [class*="card" i], [class*="product" i]') || a;
      const text = ((a.innerText || a.getAttribute('aria-label') || a.querySelector('img')?.alt || '') + ' ' + (card.innerText || '')).trim().replace(/\s+/g, ' ').slice(0, 160);
      seen.add(u.pathname);
      out.push({ path: u.pathname + u.search, text, top: Math.round(a.getBoundingClientRect().top + scrollY), cardHasPrice: /\d/.test(card.querySelector('[class*="price" i], .amount')?.textContent || '') });
    }
  }
  return out;
}

// Open closed <details> inside the product block (summary elements only).
// A finder only: marks each closed product section's summary (data-sp-details="0", "1", ...) and returns how many it marked. It never
// activates anything; the runner opens each one through the interaction policy and its guarded tap, like every other tap.
export function markClosedProductDetails(sel) {
  document.querySelectorAll('[data-sp-details]').forEach((e) => e.removeAttribute('data-sp-details'));
  let n = 0;
  for (const s of document.querySelectorAll('details:not([open]) > summary')) {
    if (!s.closest(sel.productRoot) && !s.closest(sel.addForm)) continue;
    if (s.closest(sel.chrome) || s.closest(sel.reviews) || s.closest(sel.elsewhere)) continue;
    if (n >= 12) break;
    s.setAttribute('data-sp-details', String(n)); n++;
  }
  return n;
}

// mode 'product': the product info block, the add-to-cart form and option labels/values (hidden <option>s included).
// Reviews, header, footer, nav, breadcrumbs, announcement bars and related-product rows are excluded.
// mode 'reviews': review widgets only (scroll first so lazy widgets load).
export function readTextSegments({ sel, maxChars, mode }) {
  const cssPath = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4 && e !== document.body; e = e.parentElement) {
      const p = e.tagName.toLowerCase();
      const id = e.getAttribute('id'); // never e.id: a form input named "id" shadows it
      if (id) { parts.unshift(`${p}#${id}`); break; }
      const c = [...e.classList].slice(0, 2).join('.');
      parts.unshift(c ? `${p}.${c}` : p);
    }
    return parts.join(' > ');
  };
  const EXCL = mode === 'reviews' ? `${sel.chrome}, ${sel.noText}` : `${sel.chrome}, ${sel.reviews}, ${sel.elsewhere}, ${sel.noText}`;
  let roots;
  if (mode === 'reviews') {
    roots = [...document.querySelectorAll(sel.reviews)].filter((r) => !r.closest(sel.chrome) && !r.closest(sel.elsewhere));
  } else {
    roots = [...document.querySelectorAll(sel.productRoot)];
    if (!roots.length) {
      const f = [...document.querySelectorAll(sel.addForm)].filter((x) => !x.closest(sel.grid));
      if (f.length === 1) roots = [f[0].closest('section, .product, main') || f[0].parentElement];
    }
    for (const x of document.querySelectorAll(`${sel.addForm}, .choices`)) if (!x.closest(sel.grid)) roots.push(x);
    roots = roots.filter((r) => r && !r.closest(EXCL));
  }
  roots = [...new Set(roots)];
  roots = roots.filter((r) => !roots.some((o) => o !== r && o.contains(r)));
  const marked = [];
  roots.forEach((r) => r.querySelectorAll('*').forEach((e) => { e.setAttribute('data-sp-i', String(marked.length)); marked.push(e); }));
  const segments = []; let total = 0;
  // The text a heading-like element introduces, read from the page structure: the dd after a dt, the td in a th's row, a legend's
  // fieldset (its option labels), and the rest of the <details> around a summary (a Dawn accordion title sits inside the summary;
  // its text is in a sibling div). Empty when the structure says nothing.
  // Returns null when there is no such structure, and '' when the structure exists but is empty (the heading is then heading only,
  // and the next segments are never borrowed as its body).
  const bodyFor = (e) => {
    const t = (x) => (x ? x.textContent.replace(/\s+/g, ' ').trim() : '');
    const tag = e.tagName.toLowerCase();
    if (tag === 'dt') { let n = e.nextElementSibling; while (n && !/^d[dt]$/i.test(n.tagName)) n = n.nextElementSibling; return n && n.tagName.toLowerCase() === 'dd' ? t(n) : ''; }
    if (tag === 'th') {
      const tr = e.closest('tr'); if (!tr) return '';
      const cells = [...tr.children].filter((c) => /^t[dh]$/i.test(c.tagName));
      const own = cells.filter((c) => c.tagName.toLowerCase() === 'td').map(t).join(' ').trim();
      if (cells.some((c) => c.tagName.toLowerCase() === 'td')) return own;
      // a header row: the th maps by column index to the td in the same column of the following row(s)
      const col = cells.indexOf(e); const table = tr.closest('table'); if (!table || col < 0) return '';
      const rows = [...table.querySelectorAll('tr')].filter((x) => x.closest('table') === table);
      const out = [];
      for (const row of rows.slice(rows.indexOf(tr) + 1)) {
        const rc = [...row.children].filter((c) => /^t[dh]$/i.test(c.tagName));
        if (!rc.some((c) => c.tagName.toLowerCase() === 'td')) break;
        const c = rc[col]; if (c && c.tagName.toLowerCase() === 'td' && t(c)) out.push(t(c));
      }
      return out.join(' ').trim();
    }
    if (tag === 'legend') { const fs = e.closest('fieldset'); return fs ? [...fs.children].filter((c) => c !== e).map(t).join(' ').trim() : ''; }
    if (!/^(h[1-6]|summary|span|div|p|strong|b)$/.test(tag)) return null;
    const sum = e.closest('summary'); const d = sum && sum.parentElement && sum.parentElement.tagName.toLowerCase() === 'details' ? sum.parentElement : null;
    if (d) return [...d.children].filter((c) => c !== sum).map(t).join(' ').trim();
    // a heading followed by a container (an .rte div, a list, a table): that container is its body. Empty decorative siblings (an icon
    // svg, i, span, hr, img or button, a spacer div) are stepped over; only an empty BLOCK container (a div, section, article, dd, td,
    // list or details) that is also a CONTENT container (.rte, a content, accordion, collapsible or tab panel) makes it heading only.
    if (/^h[1-6]$/.test(tag)) {
      const CONTENT = 'dd, td, .rte, [class*="content" i], [class*="accordion" i], [class*="collapsible" i], [class*="tab-panel" i]';
      let n = e.nextElementSibling;
      const BLOCK = /^(div|section|article|dd|td|ul|ol|dl|details)$/i;
      while (n && !t(n) && !(BLOCK.test(n.tagName) && n.matches(CONTENT))) n = n.nextElementSibling;
      if (n && !t(n)) return '';
      if (n && /^(div|section|article|aside|ul|ol|dl|table)$/i.test(n.tagName)) return t(n);
    }
    return null;
  };
  for (const r of roots) {
    const clone = r.cloneNode(true);
    clone.querySelectorAll(EXCL).forEach((e) => e.remove());
    const walk = (el) => {
      if (total >= maxChars) return;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).length;
      if (own) {
        const text = el.textContent.replace(/\s+/g, ' ').trim().slice(0, 2000);
        const idx = el.getAttribute && el.getAttribute('data-sp-i');
        const orig = idx !== null && idx !== undefined ? marked[Number(idx)] : r;
        const seg = { path: cssPath(orig || r), text };
        const b = bodyFor(el); if (b !== null) seg.body = b.slice(0, 300);
        segments.push(seg); total += text.length;
      }
      for (const c of el.children) walk(c);
    };
    walk(clone);
  }
  marked.forEach((e) => e.removeAttribute('data-sp-i'));
  return segments;
}

// Structured price sources, in order: [itemprop=price], ld+json (parsed in Node), Shopify /products/<handle>.js.
export async function readStructuredPrice(sel) {
  const out = { itemprop: null, shopifyJs: null };
  const ip = [...document.querySelectorAll('[itemprop="price"]')].find((e) => !e.closest(sel.grid) && !e.closest(sel.elsewhere) && !e.closest(sel.chrome));
  if (ip) out.itemprop = (ip.getAttribute('content') || ip.textContent || '').trim().slice(0, 40);
  const m = location.pathname.match(/^(.*\/products\/[^/?#]+?)\/?$/);
  out.handlePath = m ? m[1] : null;
  return out;
}
export async function fetchShopifyProductJs(handlePath) {
  try {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10000) : undefined;
    const r = await fetch(`${handlePath}.js`, { cache: 'no-store', headers: { Accept: 'application/json' }, signal });
    if (!r.ok) return null;
    const j = await r.json();
    const v = j.price ?? j.variants?.[0]?.price;
    return typeof v === 'number' ? v / 100 : null;
  } catch { return null; }
}

// Visible elements whose short text holds a number. Header, nav, footer, banners, announcement bars, related rows, cart drawers,
// installment widgets, struck-through compare-at prices and anything inside a pinned bar are dropped here. Pinned = inside a
// position:fixed box, or inside a position:sticky box shorter than 30% of the screen (a sticky add-to-cart bar). A tall sticky box
// (a theme's sticky product info column) is the product block itself and counts.
export function readPriceCandidates(sel) {
  const vis = (e) => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
  const pinned = (e) => {
    for (let a = e; a && a !== document.documentElement; a = a.parentElement) {
      const p = getComputedStyle(a).position;
      if (p === 'fixed') return true;
      if (p === 'sticky' && a.getBoundingClientRect().height < innerHeight * 0.3) return true;
    }
    return false;
  };
  const roots = [...document.querySelectorAll(sel.productRoot), ...[...document.querySelectorAll(sel.addForm)].filter((f) => !f.closest(sel.grid))];
  const bad = `${sel.chrome}, ${sel.elsewhere}, ${sel.grid}, ${sel.priceNoise}, ${sel.reviews}`;
  const out = [];
  for (const e of document.querySelectorAll('[itemprop="price"], [class*="price" i], [data-price], .amount, bdi, ins, span, p, strong, b, div')) {
    if (out.length > 400) break;
    if (e.children.length > 4) continue;
    const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 60 || !/\d/.test(t)) continue;
    if (e.closest(bad) || !vis(e) || pinned(e)) continue;
    const b = e.getBoundingClientRect();
    out.push({ text: t, top: Math.round(b.top + scrollY), bottom: Math.round(b.bottom + scrollY), inRoot: roots.some((r) => r.contains(e)), priceLike: e.hasAttribute('itemprop') || /price|amount/i.test(String(e.className || '')) });
  }
  return out;
}

// Bytes that would cross the wire. Compressed responses: the content-length header. Text types: gzip estimate. Binary: raw length.
export function wireBytes(headers, body) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const enc = (h['content-encoding'] || '').trim().toLowerCase();
  if (enc && enc !== 'identity') { const n = Number(h['content-length']); if (Number.isFinite(n) && n > 0) return n; }
  if (/(text\/|javascript|json|xml|css|svg)/i.test(h['content-type'] || '')) { try { return zlib.gzipSync(body).length; } catch {} }
  return body.length;
}

// ---------- the cart, read the way the platform's own scripts do (serialised into the page) ----------
// Shopify: /cart.js item_count. WooCommerce: the Store API items_count (/wp-json/wc/store/v1/cart, then ?rest_route= for sites without
// pretty links), which is right for the classic cart and the Cart block alike. Unreadable = { count: null } (unknown), never 0.
export async function readCartCount(platform) {
  const get = async (u) => {
    try {
      // a timeout of its own, so a store that never answers cannot hold the journey (older engines without AbortSignal.timeout skip it)
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10000) : undefined;
      const r = await fetch(u, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' }, signal });
      if (!r.ok || !/json/i.test(r.headers.get('content-type') || '')) return null;
      return await r.json();
    } catch { return null; }
  };
  if (platform !== 'woocommerce') { const j = await get('/cart.js'); if (j && typeof j.item_count === 'number') return { count: j.item_count, source: 'Shopify /cart.js' }; }
  if (platform !== 'shopify') {
    for (const u of ['/wp-json/wc/store/v1/cart', '/?rest_route=/wc/store/v1/cart']) { const j = await get(u); if (j && typeof j.items_count === 'number') return { count: j.items_count, source: `WooCommerce Store API ${u}` }; }
  }
  return { count: null, source: null };
}

// ---------- the network guard, shared by the runner and the offline test ----------
// g.state = { deliberate, cartFrom, cartPages, lastDoc }. The Checkout button is never tapped. Every document is checked by address
// (checkoutReason) and by content (checkoutContentReason), so a checkout on any slug (/kasse/, a buy-now redirect, a target=_blank
// link) never loads. cartFrom / cartPages: the cart was touched (see markCartTouched); from then on the after-cart rule holds for the
// rest of the journey, and no state ever lifts it. cartDirty: the page wrote to the cart without adding items (attributes, a note).
// cartUrls: the store's own cart page paths learned before the add (learnCartUrl). halt: the journey was stopped; every request aborts.
// g.landingPaths: optional Set of landing page paths.
// A request that is itself an add-to-cart or a form POST: a server redirect it causes may lead anywhere (a buy-now button that jumps to
// the checkout), so such a redirect is only followed to a page of a known safe kind.
// The text of a request body as the panel reads it to classify the request: the raw body plus, decoded, every key and string value of a
// JSON body, every field of a form body and every part of a multipart body, so an escaped (cart) or encoded name is still read.
export function decodedBodyText(body) {
  const raw = String(body ?? '').slice(0, 1000000); if (!raw) return '';
  const out = [raw];
  const walk = (v, d = 0) => {
    if (d > 10 || out.length > 5000) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, d + 1); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); walk(x, d + 1); }
  };
  const tryJson = (t) => { try { walk(JSON.parse(t)); } catch {} };
  tryJson(raw);
  if (/^[^\s{[<]*=/.test(raw)) { try { for (const [k, v] of new URLSearchParams(raw)) { out.push(k, v); tryJson(v); } } catch {} }
  const m = /^--([^\r\n]{1,200})\r?\n/.exec(raw);
  if (m) for (const part of raw.split(`--${m[1]}`)) { const i = part.search(/\r?\n\r?\n/); if (i >= 0) { const v = part.slice(i).trim(); out.push(v); tryJson(v); } }
  return out.join('\n');
}
// A GraphQL request (any GraphQL endpoint): 'add' (a cart mutation that adds lines), 'cart' (another cart mutation), 'unknown' (a mutation
// the panel cannot name, or a non-GET body whose operation it cannot read, such as a persisted query), or null (only queries).
export const GRAPHQL_PATH = /\/graphql(?:\.json)?\/?$/i;
export function graphqlWriteKind(body = '', method = 'POST', url = '') {
  const raw = String(body ?? '');
  const docs = [];
  const collect = (v, d = 0) => { if (d > 4 || !v || typeof v !== 'object') return; if (Array.isArray(v)) { for (const x of v) collect(x, d + 1); return; } if (typeof v.query === 'string') docs.push(v.query); if (v.operations) { try { collect(typeof v.operations === 'string' ? JSON.parse(v.operations) : v.operations, d + 1); } catch {} } };
  let parsed = false;
  try { collect(JSON.parse(raw)); parsed = true; } catch {}
  try { if (/^[^\s{[<]*=/.test(raw)) { const f = new URLSearchParams(raw); if (f.get('query')) docs.push(f.get('query')); if (f.get('operations')) collect(JSON.parse(f.get('operations'))); } } catch {}
  const mp = /^--([^\r\n]{1,200})\r?\n/.exec(raw);
  if (mp) for (const part of raw.split(`--${mp[1]}`)) { const i = part.search(/\r?\n\r?\n/); if (i >= 0) { try { collect(JSON.parse(part.slice(i).trim())); } catch {} } }
  if (!docs.length && !parsed && /^\s*(?:query|mutation|subscription|\{)/.test(raw)) docs.push(raw);
  try { const q = new URL(url).searchParams.get('query'); if (q) docs.push(q); } catch {}
  const text = docs.join('\n');
  const all = decodedBodyText(raw);
  if (!docs.length) {
    if (/^(GET|HEAD|OPTIONS)$/i.test(String(method || 'GET'))) return null;
    // a body the panel cannot read as GraphQL (a persisted query sends only an operation name): never taken for a read
    return /cart.{0,20}(?:add|create)|(?:add|create).{0,20}cart/i.test(all) ? 'add' : /cart/i.test(all) ? 'cart' : 'unknown';
  }
  if (!/\bmutation\b/.test(text)) return null;
  if (/\bcartLinesAdd\b/.test(text) || (/\bcartCreate\b/.test(text) && /\blines\b/.test(all))) return 'add';
  if (/\bcart[A-Z]\w*\s*[({]/.test(text)) return 'cart';
  return 'unknown';
}
const WC_AJAX_READ = /^(?:get_refreshed_fragments|get_variation)$/i;
// The store's own background cart writes, whatever made them (fetch, xhr, an image, a beacon), read from the address, the method and
// the decoded body: Shopify /cart, /cart/add|change|update|clear (.js or .json); any write to the WooCommerce Store API cart (any
// route under /wc/store/.../cart, also as ?rest_route= and inside a Store API batch), wc-ajax and admin-ajax cart or coupon actions;
// and any GraphQL mutation (a Storefront cart mutation, or one the panel cannot name: see graphqlWriteKind). method: when not given, a
// call with a body is taken as POST and one without as GET.
export function isCartWriteCall(url, body = '', method = '') {
  try {
    const u = new URL(url); const p = stripRealLocale(u.pathname);
    const m = String(method || (body ? 'POST' : 'GET')).toUpperCase();
    const write = !/^(GET|HEAD|OPTIONS)$/.test(m);
    const b = decodedBodyText(body);
    if (GRAPHQL_PATH.test(p)) return graphqlWriteKind(body, m, url) !== null;
    if (/\/wp-admin\/admin-ajax\.php$/i.test(p)) {
      const acts = [u.searchParams.get('action') || ''];
      for (const x of b.matchAll(/(?:^|[&\n"])action(?:"\s*:\s*"|=)([^&"\n]*)/g)) acts.push(x[1]);
      if (acts.some((x) => /cart|coupon/i.test(x))) return true;
    }
    if (/^\/cart\/(?:add|change|update|clear)(?:\.js|\.json)?\/?$/i.test(p)) return true;
    if (write && /^\/cart\/?$/i.test(p)) return true;
    const rr = u.searchParams.get('rest_route') || '';
    const named = /\/cart\/(?:add-item|update-item|remove-item|remove-items|items|apply-coupon|remove-coupon|select-shipping-rate|update-customer|batch)\b/i;
    for (const route of [p, rr]) {
      if (!/\/?wc\/store(?:\/v\d+)?\/cart(?:\/|$)/i.test(route)) continue;
      if (write || named.test(route)) return true;
    }
    // the Store API batch route (/wc/store/v1/batch, or the same in rest_route) carries cart writes inside its body
    if ((/^\/wp-json\/wc\/store(?:\/v\d+)?\/batch\/?$/i.test(p) || /^\/?wc\/store(?:\/v\d+)?\/batch\/?$/i.test(rr)) && (/\/cart/i.test(b) || (write && !b))) return true;
    const wa = u.searchParams.get('wc-ajax') || '';
    return !!wa && !WC_AJAX_READ.test(wa) && /cart|coupon|shipping/i.test(wa);
  } catch { return false; }
}
// A cart write that adds items, as far as the panel can tell: /cart/add, a Storefront cartLinesAdd, a cartCreate that sends lines, the
// WooCommerce add routes (wc-ajax, admin-ajax add actions, the Store API add-item route, also inside a batch), a /cart/update that sets
// a quantity above 0. Anything else (cart attributes or a note, a quantity change, a coupon, a write the panel cannot read) is not an
// add: it does not turn the after-cart rule on.
export function isCartItemAdd(url, body = '', method = '') {
  try {
    if (!isCartWriteCall(url, body, method)) return false;
    const u = new URL(url); const p = stripRealLocale(u.pathname); const b = decodedBodyText(body);
    const rr = u.searchParams.get('rest_route') || '';
    if (GRAPHQL_PATH.test(p)) return graphqlWriteKind(body, method || 'POST', url) === 'add';
    if (/\/wp-admin\/admin-ajax\.php$/i.test(p)) return /add[-_]?to[-_]?cart|add[-_]?cart|cart[-_]?add/i.test(`${u.searchParams.get('action') || ''} ${b}`);
    if (/^\/cart\/add(?:\.js|\.json)?\/?$/i.test(p)) return true;
    // Shopify /cart/update (or a POST to /cart) with `updates` can put an item in the cart (a quantity above 0 for a variant)
    if (/^\/cart(?:\/update(?:\.js|\.json)?)?\/?$/i.test(p)) return cartUpdateSetsQuantity(String(body || '')) || cartUpdateSetsQuantity(u.search.slice(1));
    if (/\/wc\/store(?:\/v\d+)?\/cart\/add-item/i.test(p) || /\/wc\/store(?:\/v\d+)?\/cart\/add-item/i.test(rr)) return true;
    if (/\/wc\/store(?:\/v\d+)?\/batch/i.test(`${p} ${rr}`)) return /\/cart\/add-item/i.test(b);
    return /^add_to_cart$/i.test(u.searchParams.get('wc-ajax') || '');
  } catch { return false; }
}
// a /cart/update body (JSON or form) with an `updates` quantity above 0
function cartUpdateSetsQuantity(b) {
  const pos = (v) => Number(v) > 0;
  try { const j = JSON.parse(b); if (j && j.updates && typeof j.updates === 'object') return Object.values(j.updates).some(pos); if (j && typeof j === 'object') return false; } catch {}
  try { for (const [k, v] of new URLSearchParams(b)) if (/^updates(\[|$)/i.test(k) && pos(v)) return true; } catch {}
  return false;
}
// Browse-only mode (--no-cart), best effort: a request that would write to the cart, whatever made it (a page script, an image, a beacon,
// a page load or a form). A recognised cart write call (any method, body decoded), a GET address that is itself a cart action
// (/cart/add, add-to-cart, buy-now, quantity[n]), any GraphQL mutation, and for a page load also any form POST.
export function isNoCartWrite(url, method = 'GET', body = '', isDocument = false) {
  if (!/^https?:/i.test(String(url))) return false;
  const one = (x) => isCartWriteCall(x, body, method) || isCartActionRequest(x, isDocument ? method : 'GET');
  const d = decodedUrl(url);
  return one(url) || (!!d && one(d));
}
export function isCartActionRequest(url, method = 'GET') {
  if (String(method).toUpperCase() === 'POST') return true;
  try {
    const u = new URL(url);
    if (/\/cart\/add(?:\.js)?\/?$/i.test(u.pathname)) return true;
    for (const k of u.searchParams.keys()) if (/^(add[-_]to[-_]cart|buy[-_]?now|quantity\[\d+\]|remove_item|undo_item|removed_item|apply_coupon|remove_coupon|empty[-_]?cart|clear[-_]?cart|order_again)$/i.test(k)) return true;
  } catch {}
  return false;
}
// ---------- shared dispatch endpoints: only recognised cart operations may be sent ----------
// A write (anything but GET, HEAD or OPTIONS) to an endpoint that runs many kinds of operation (GraphQL, /api, admin-ajax.php,
// wc-ajax, /rest/, ?route=, ?controller=, ?fc=) is allowed only when its body or query names a cart operation the panel recognises.
// Anything else there (an unknown operation, a body the panel cannot read, a batch, a persisted query) is stopped.
export const CART_MUTATIONS = new Set(['cartCreate', 'cartLinesAdd', 'cartLinesUpdate', 'cartLinesRemove', 'cartDiscountCodesUpdate', 'cartNoteUpdate', 'cartAttributesUpdate', 'cartBuyerIdentityUpdate', 'cartSelectedDeliveryOptionsUpdate']);
const WC_AJAX_OK = new Set(['add_to_cart', 'get_refreshed_fragments', 'get_variation', 'apply_coupon', 'remove_coupon', 'update_shipping_method', 'remove_from_cart', 'get_cart_totals']);
const ADMIN_AJAX_OK = new Set(['woocommerce_add_to_cart', 'woocommerce_get_refreshed_fragments', 'woocommerce_apply_coupon', 'woocommerce_remove_coupon', 'woocommerce_update_shipping_method', 'woocommerce_get_variation']);
const STORE_API_OK = /^\/?wc\/store(?:\/v\d+)?\/cart(?:\/(?:add-item|update-item|remove-item|apply-coupon|remove-coupon|select-shipping-rate|update-customer))?\/?$/i;
const MAGENTO_OK = /\/V1\/guest-carts(?:\/[A-Za-z0-9]+(?:\/(?:items(?:\/\d+)?|estimate-shipping-methods|coupons(?:\/[^/]+)?|totals-information))?)?\/?$/i;
export function isDispatchEndpoint(url) {
  let u; try { u = new URL(url); } catch { return false; }
  const p = u.pathname.toLowerCase();
  if (GRAPHQL_PATH.test(p) || /\/graphql(?:\/|$)/.test(p)) return true;
  if (/(?:^|\/)api(?:\/|$)/.test(p) || /\/admin-ajax\.php$/.test(p) || /(?:^|\/)rest(?:\/|$)/.test(p) || /(?:^|\/)wp-json(?:\/|$)/.test(p)) return true;
  for (const k of u.searchParams.keys()) if (/^(wc-ajax|route|controller|fc|rest_route)$/i.test(k)) return true;
  return false;
}
// The top-level operations of a GraphQL document: { ok: true, mutations: [names] } or { ok: false, why }. Strings and comments are
// blanked first; a fragment spread at the top of a mutation, a subscription, or a document the scanner cannot read is refused.
export function graphqlTopLevel(doc) {
  const src = String(doc || '').replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\n]*/g, ' ');
  const out = []; let i = 0; let sawOp = false;
  const skipWs = () => { while (i < src.length && /[\s,]/.test(src[i])) i++; };
  const skipBlock = () => { let d = 0; for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) { i++; return true; } } } return false; };
  const skipParens = () => { let d = 0; for (; i < src.length; i++) { if (src[i] === '(') d++; else if (src[i] === ')') { d--; if (d === 0) { i++; return true; } } } return false; };
  while (i < src.length) {
    skipWs(); if (i >= src.length) break;
    const m = /^(query|mutation|subscription|fragment)\b/.exec(src.slice(i));
    if (!m && src[i] === '{') { sawOp = true; if (!skipBlock()) return { ok: false, why: 'unbalanced braces' }; continue; }
    if (!m) return { ok: false, why: 'not a GraphQL document the panel can read' };
    const kind = m[1]; i += kind.length; sawOp = true;
    while (i < src.length && src[i] !== '{' && src[i] !== '(') i++;
    if (src[i] === '(') { if (!skipParens()) return { ok: false, why: 'unbalanced parentheses' }; while (i < src.length && src[i] !== '{') i++; }
    if (kind === 'subscription') return { ok: false, why: 'a subscription' };
    if (kind !== 'mutation') { if (!skipBlock()) return { ok: false, why: 'unbalanced braces' }; continue; }
    // the mutation's top-level fields
    i++;
    for (;;) {
      skipWs();
      if (i >= src.length) return { ok: false, why: 'unbalanced braces' };
      if (src[i] === '}') { i++; break; }
      if (src.startsWith('...', i)) return { ok: false, why: 'a fragment spread at the top of a mutation' };
      const f = /^([_A-Za-z][_0-9A-Za-z]*)\s*(?::\s*([_A-Za-z][_0-9A-Za-z]*))?/.exec(src.slice(i));
      if (!f) return { ok: false, why: 'a mutation field the panel cannot read' };
      out.push(f[2] || f[1]); i += f[0].length; skipWs();
      if (src[i] === '(') { if (!skipParens()) return { ok: false, why: 'unbalanced parentheses' }; skipWs(); }
      while (src[i] === '@') { const d = /^@[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i)); if (!d) break; i += d[0].length; skipWs(); if (src[i] === '(') { skipParens(); skipWs(); } }
      if (src[i] === '{') { if (!skipBlock()) return { ok: false, why: 'unbalanced braces' }; }
    }
  }
  if (!sawOp) return { ok: false, why: 'an empty GraphQL document' };
  return { ok: true, mutations: out };
}
function graphqlBodyReason(body, url) {
  const raw = String(body ?? '').trim();
  let docs = [];
  let j = null; try { j = JSON.parse(raw); } catch {}
  if (Array.isArray(j)) return 'a batch of GraphQL operations';
  if (j && typeof j === 'object') {
    if (typeof j.query !== 'string') return j.extensions && j.extensions.persistedQuery ? 'a persisted GraphQL query' : 'a GraphQL body with no query';
    docs.push(j.query);
  } else if (/^[^\s{[<]*=/.test(raw)) {
    try { const f = new URLSearchParams(raw); if (f.get('query')) docs.push(f.get('query')); } catch {}
  } else if (/^(?:query|mutation|subscription|\{)/.test(raw)) docs.push(raw);
  try { const q = new URL(url).searchParams.get('query'); if (q) docs.push(q); } catch {}
  if (!docs.length) return 'a GraphQL request the panel cannot read';
  for (const d of docs) {
    const r = graphqlTopLevel(d);
    if (!r.ok) return `GraphQL: ${r.why}`;
    const bad = r.mutations.find((n) => !CART_MUTATIONS.has(n));
    if (bad) return `GraphQL mutation ${bad} is not a cart operation`;
  }
  return null;
}
// Returns null when this request may be sent, else a reason. Only writes to dispatch endpoints are judged; everything else returns null.
export function dispatchReason({ url, method = 'GET', body = '' } = {}) {
  if (/^(GET|HEAD|OPTIONS)$/i.test(String(method || 'GET'))) return null;
  if (!isDispatchEndpoint(url)) return null;
  let u; try { u = new URL(url); } catch { return 'an address the panel cannot read'; }
  const p = u.pathname;
  if (GRAPHQL_PATH.test(p) || /\/graphql(?:\/|$)/i.test(p)) return graphqlBodyReason(body, url);
  const raw = String(body ?? '');
  const form = (() => { try { return /^[^\s{[<]*=/.test(raw) ? new URLSearchParams(raw) : null; } catch { return null; } })();
  let json = null; try { json = JSON.parse(raw); } catch {}
  const wa = u.searchParams.getAll('wc-ajax');
  if (wa.length) { const bad = wa.find((a) => !WC_AJAX_OK.has(a.toLowerCase())); return bad === undefined ? null : `wc-ajax=${bad.slice(0, 40)} is not a cart operation`; }
  if (/\/admin-ajax\.php$/i.test(p)) {
    const acts = [...u.searchParams.getAll('action'), ...(form ? form.getAll('action') : []), ...(json && typeof json === 'object' && typeof json.action === 'string' ? [json.action] : [])];
    if (!acts.length) return 'admin-ajax.php with no action the panel can read';
    const bad = acts.find((a) => !ADMIN_AJAX_OK.has(a.toLowerCase()));
    return bad === undefined ? null : `admin-ajax.php action ${bad.slice(0, 40)} is not a cart operation`;
  }
  const rr = u.searchParams.get('rest_route');
  const route = rr !== null ? rr : (/\/wp-json\/(.*)$/i.exec(p) || [])[1];
  if (route !== undefined && route !== null) return STORE_API_OK.test(`/${String(route).replace(/^\/+/, '')}`) ? null : `the route ${String(route).slice(0, 60)} is not a cart operation`;
  if (/(?:^|\/)rest(?:\/|$)/i.test(p)) return MAGENTO_OK.test(p) ? null : `the REST call ${p.slice(0, 60)} is not a cart operation`;
  const ctl = u.searchParams.get('controller') || (form && form.get('controller'));
  if (ctl !== null && ctl !== undefined) {
    const add = u.searchParams.has('add') || u.searchParams.has('update') || (form && (form.has('add') || form.has('update')));
    return /^cart$/i.test(ctl) && add ? null : `controller=${String(ctl).slice(0, 40)} is not a cart operation`;
  }
  return 'a write to a shared endpoint (an API, route or controller) that names no cart operation the panel recognises';
}
// Chromium speculation (speculation rules, prerender, no-state prefetch) loads pages in the background; those loads are made by the
// browser itself, are NOT seen by the network guard, and a prerendered checkout would be SHOWN on the Checkout tap. Three layers stop it:
// 1. SPECULATION_BLOCKER (an init script in every page and frame, before any page script) neutralises every speculation-rules script a
//    page adds with JavaScript, and says the feature is unsupported. This is the layer that works: in Playwright's Chromium the
//    feature flags below were measured NOT to stop document-rules prefetch on their own.
// 2. installGuard removes <script type="speculationrules">, <link rel=prerender|prefetch> and the Speculation-Rules header from every
//    page it hands to the browser, and refuses any request whose Sec-Purpose says prefetch or prerender.
// 3. chromiumArgs: one --disable-features flag (a second one would replace the first) with the speculation features, kept as an
//    extra layer for Chromium builds that honour it.
export const SPECULATION_BLOCKER = `(() => {
  const TYPE = /^\\s*speculationrules\\s*$/i;
  const bad = (n) => !!n && n.nodeType === 1 && n.localName === 'script' && TYPE.test(n.getAttribute('type') || '');
  const neuter = (n) => {
    if (!n || typeof n !== 'object') return;
    if (bad(n)) n.setAttribute('type', 'text/x-blocked-speculationrules');
    else if (n.querySelectorAll) n.querySelectorAll('script[type]').forEach((s) => { if (bad(s)) s.setAttribute('type', 'text/x-blocked-speculationrules'); });
  };
  const wrap = (proto, names) => { for (const name of names) { const orig = proto && proto[name]; if (typeof orig !== 'function') continue; Object.defineProperty(proto, name, { configurable: true, writable: true, value: function (...args) { for (const a of args) neuter(a); return orig.apply(this, args); } }); } };
  wrap(Node.prototype, ['appendChild', 'insertBefore', 'replaceChild']);
  wrap(Element.prototype, ['append', 'prepend', 'after', 'before', 'replaceWith', 'insertAdjacentElement', 'replaceChildren']);
  wrap(Document.prototype, ['append', 'prepend', 'replaceChildren']);
  wrap(DocumentFragment.prototype, ['append', 'prepend', 'replaceChildren']);
  try { const sup = HTMLScriptElement.supports; if (sup) HTMLScriptElement.supports = function (t) { return TYPE.test(String(t)) ? false : sup.call(this, t); }; } catch {}
  try { new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (bad(n)) n.remove(); }).observe(document, { childList: true, subtree: true }); } catch {}
})();`;
// ---------- unload traffic: beacons, keepalive fetches, fetchLater, service workers ----------
// In Chromium, requests sent while a page unloads (navigator.sendBeacon, fetch with keepalive: true, fetchLater) are handed to the
// browser process and skip ctx.route completely (measured: trackers, hosts off the allow-list and checkout paths all reached the
// server; WebKit routes them). Layers:
// 1. beaconBlockerScript (init script): in every page and frame the init script reaches (the top page, same-origin frames, and child
//    windows reached through contentWindow, contentDocument or window.open), every sendBeacon and every fetchLater is dropped, and a
//    keepalive fetch is dropped when its address is a checkout, matches a block rule, or is on a host that is neither the store's nor
//    allow-listed. Service worker registration is refused. Measured limit: the init script does not run in a sandboxed iframe with an
//    opaque origin (sandbox="allow-scripts" without allow-same-origin) on WebKit, so a beacon from such a frame is not dropped by this
//    layer; WebKit sends beacons through ctx.route, so the route guard still applies its normal rules to it (an own-host beacon passes,
//    as any own-host request does).
// 2. installBrowserNetGuard (Chromium only): a browser-level CDP Fetch session. It sees only what got past ctx.route, which on Chromium
//    includes what the browser sends for a page that is closing (beacons arrive as resourceType Ping, keepalive fetches as XHR or
//    Fetch), and fails the ones that are a checkout, match a block rule, or go to a host off the allow-list. Each is counted in the same
//    blocked and checkout counts as a ctx.route stop. Measured on Chromium 153.
// A page-level CDP Network.setBlockedURLs layer was tried and removed: it never stopped unload requests, and because it acts BEFORE
// ctx.route it hid tracker and checkout stops from the counts and turned blocked trackers into page script errors.
// Web workers. A socket a page opens goes through ctx.routeWebSocket (see installGuard), but one a web worker opens does not, on either
// engine. So every worker a page (or a worker) starts is started through a small wrapper: for an http(s) worker the address gets a
// marker, the guard answers that marked address itself with workerGuardSource + an import of the real script (so the worker keeps its
// own address and relative paths), and for a blob: or data: worker the wrapper is built in the page. Inside the worker the guard
// replaces WebSocket, WebSocketStream and WebTransport: a connection to a host that is neither the store's own nor allow-listed, or
// that a block rule names, throws a SecurityError and is reported to the guard (a request the guard stops and counts; it never leaves
// the browser). Known edge: in a blob: or data: module worker the wrapper imports the original, so nothing runs before the guard.
export const WORKER_MARK = '__sp_worker';
export const SOCKET_REPORT_PATH = '/__shopper_panel_blocked_socket__';
export function workerGuardFn(C, scope, sockets, ruleHit) {
  const S = scope;
  const own = (h) => C.own.includes(h) || C.own.includes(h.replace(/^www\./, '')) || C.own.includes('www.' + h);
  const allowed = (h) => C.allow.some((p) => (p.startsWith('*.') ? h === p.slice(2) || h.endsWith(p.slice(1)) : h === p));
  // the base for a relative worker address: the document's base (a fresh about:blank frame inherits its parent's), else the address
  const here = () => { try { return S.document && S.document.baseURI && S.document.baseURI !== 'about:blank' ? S.document.baseURI : S.location.href; } catch (e) { return ''; } };
  const src = () => `(${C.boot})(${JSON.stringify(C)}, self, true);\n`;
  if (sockets) {
    const bad = (raw) => {
      let u; try { u = new URL(String(raw && raw.url ? raw.url : raw), here()); } catch (e) { return false; }
      if (!/^(wss?|https?):$/.test(u.protocol)) return false;
      const h = u.hostname.toLowerCase();
      // every socket is refused, on any host: the panel cannot read what a socket sends, so none is opened
      return u.href;
    };
    for (const name of ['WebSocket', 'WebSocketStream', 'WebTransport']) {
      const O = S[name]; if (typeof O !== 'function') continue;
      const G = function (url) {
        const b = bad(url);
        if (b) {
          try { S.fetch(S.location.origin + C.report + '?u=' + encodeURIComponent(String(b).slice(0, 300))).catch(() => {}); } catch (e) {}
          throw new S.DOMException('This connection is blocked by the shopper panel', 'SecurityError');
        }
        throw new S.DOMException('This connection is blocked by the shopper panel', 'SecurityError');
      };
      // the replacement keeps no link to the original constructor (no shared prototype), so a script cannot reach the real one
      // through WebSocket.prototype.constructor or Object.getPrototypeOf(WebSocket)
      G.prototype = {};
      try { Object.defineProperty(S, name, { configurable: true, writable: true, value: G }); } catch (e) {}
    }
    // the marker the runner reads in every worker it sees (page.on('worker')): a worker without it started without the guard
    try { Object.defineProperty(S, '__spSocketGuard', { value: true }); } catch (e) {}
  }
  // the browser runs offline (ctx.setOffline) and every response is served by the request guard, so pages and workers are told they
  // are online, as a real shopper's browser would be
  try { const NP = (S.WorkerNavigator || S.Navigator) && (S.WorkerNavigator || S.Navigator).prototype; if (NP) Object.defineProperty(NP, 'onLine', { configurable: true, get() { return true; } }); } catch (e) {}
  if (!sockets) {
    // in pages: WebTransport and WebSocketStream are refused (page WebSockets are closed by the request guard)
    for (const name of ['WebTransport', 'WebSocketStream']) {
      if (typeof S[name] !== 'function') continue;
      const G = function () {
        try { const f = S[C.binding]; if (typeof f === 'function') f({ kind: 'socket', url: String(arguments[0] && arguments[0].url ? arguments[0].url : arguments[0]).slice(0, 300) }); } catch (e) {}
        throw new S.DOMException('This connection is blocked by the shopper panel', 'SecurityError');
      };
      G.prototype = {};
      try { Object.defineProperty(S, name, { configurable: true, writable: true, value: G }); } catch (e) {}
    }
  }
  if (!sockets) {
    // Shared workers are switched off in pages: on both engines a shared worker's own requests skip the request guard. Pages treat a
    // missing SharedWorker as an older browser (Safari lacked it for years) and fall back.
    try { delete S.SharedWorker; } catch (e) {}
    try { if (S.SharedWorker) Object.defineProperty(S, 'SharedWorker', { configurable: true, writable: true, value: undefined }); } catch (e) {}
    // A fresh frame (about:blank) may get its Worker before the page script runs in it; the guard is applied to a frame's window the
    // first time the page reaches it through iframe.contentWindow (other ways in, such as window.frames, are a known gap).
    const IF = S.HTMLIFrameElement && S.HTMLIFrameElement.prototype;
    const d = IF && Object.getOwnPropertyDescriptor(IF, 'contentWindow');
    if (d && d.get && !S.__spFrameHook) {
      const done = new WeakSet();
      try { Object.defineProperty(S, '__spFrameHook', { value: true }); } catch (e) {}
      try {
        Object.defineProperty(IF, 'contentWindow', { configurable: true, enumerable: d.enumerable, get() {
          const w = d.get.call(this);
          try { if (w && w !== S && !done.has(w)) { done.add(w); if (w.Worker && !w.__spFrameHook) workerGuardFn(C, w, false, ruleHit); } } catch (e) {}
          return w;
        } });
      } catch (e) {}
    }
  }
  // Synchronous XMLHttpRequest to an http(s) address is refused, in pages, frames and workers: on the Safari engine it never reaches the
  // request guard (ctx.route), so it could write a cart or send an order unseen. Pages report it (a guard intervention); blob: and data:
  // addresses, which never reach the network, still work (the worker wrapper itself reads blob: scripts that way).
  const XP = S.XMLHttpRequest && S.XMLHttpRequest.prototype;
  if (XP && typeof XP.open === 'function' && !S.__spSyncXhr) {
    try { Object.defineProperty(S, '__spSyncXhr', { value: true }); } catch (e) {}
    const oOpen = XP.open; const oSend = XP.send; const syncNet = new WeakMap();
    try {
      Object.defineProperty(XP, 'open', { configurable: true, writable: true, value: function open(method, url, async) {
        let hit = null;
        try { if (arguments.length >= 3 && !async) { const u = new URL(String(url), here()); if (/^https?:$/.test(u.protocol)) hit = u.href; } } catch (e) {}
        try { syncNet.set(this, hit); } catch (e) {}
        return oOpen.apply(this, arguments);
      } });
      Object.defineProperty(XP, 'send', { configurable: true, writable: true, value: function send() {
        const hit = syncNet.get(this);
        if (hit) {
          try { const f = S[C.binding]; if (typeof f === 'function') f({ kind: 'sync-xhr', url: hit.slice(0, 300) }); } catch (e) {}
          throw new S.DOMException('A synchronous request is blocked by the shopper panel', 'NetworkError');
        }
        return oSend.apply(this, arguments);
      } });
    } catch (e) {}
  }
  for (const name of ['Worker', 'SharedWorker']) {
    const O = S[name]; if (typeof O !== 'function') continue;
    const G = function (url, opts) {
      const mod = !!(opts && typeof opts === 'object' && opts.type === 'module');
      let u = null; try { u = new URL(String(url), here()); } catch (e) {}
      let next = url;
      if (u && /^https?:$/.test(u.protocol)) { u.searchParams.set(C.mark, mod ? 'm' : 'c'); next = u.href; }
      else if (u && (u.protocol === 'blob:' || u.protocol === 'data:')) {
        let body = null;
        try { const x = new S.XMLHttpRequest(); x.open('GET', u.href, false); x.send(); if (x.status === 200 || x.status === 0) body = x.responseText; } catch (e) {}
        const mk = (t) => S.URL.createObjectURL(new S.Blob([t], { type: 'text/javascript' }));
        const inner = body === null ? u.href : mod ? mk(body) : null;
        next = mk(src() + (mod ? `await import(${JSON.stringify(inner)});` : inner ? `importScripts(${JSON.stringify(inner)});` : body));
      }
      const a = Array.prototype.slice.call(arguments); a[0] = next;
      return Reflect.construct(O, a, new.target || G);
    };
    G.prototype = O.prototype; Object.setPrototypeOf(G, O);
    try { Object.defineProperty(S, name, { configurable: true, writable: true, value: G }); } catch (e) {}
  }
}
// the guard as one self-contained function source (no eval, so a strict Content-Security-Policy does not stop it)
const workerGuardBoot = () => `(function (C, S, sockets) { const isRealLocaleSegment = ${isRealLocaleSegment.toString()}; const ruleHit = ${blockRuleHit.toString()}; (${workerGuardFn.toString()})(C, S, sockets, ruleHit); })`;
export function workerGuardConfig({ ownHosts = [], allowHosts = [], rules = [] } = {}) {
  return { own: [...ownHosts].map((h) => String(h).toLowerCase()), allow: allowHosts.map((h) => String(h).toLowerCase()), rules: rules.map((r) => ({ kind: r.kind, hosts: r.hosts, path: r.path, ownHost: r.ownHost })), mark: WORKER_MARK, report: SOCKET_REPORT_PATH, binding: BEACON_BINDING, boot: workerGuardBoot() };
}
// the worker's first lines: the guard (sockets on), then the real script, imported so it keeps its own address
export function workerGuardSource(cfg, realUrl, mod) {
  return `(${cfg.boot})(${JSON.stringify(cfg)}, self, true);\n${mod ? `await import(${JSON.stringify(realUrl)});` : `importScripts(${JSON.stringify(realUrl)});`}\n`;
}
export const BEACON_BINDING = '__shopperPanelDropped';
export function checkoutPatternSources() {
  return { checkoutPath: CHECKOUT_PATH.source, cartPermalink: CART_PERMALINK.source, cartCheckout: CART_CHECKOUT_PATH.source, other: OTHER_CHECKOUT_PATH.source };
}
export function beaconBlockerScript({ ownHosts = [], allowHosts = [], rules: ruleSpecs = [] } = {}) {
  const cfg = JSON.stringify({ own: [...ownHosts].map((h) => String(h).toLowerCase()), allow: allowHosts.map((h) => String(h).toLowerCase()), rules: ruleSpecs.map((r) => ({ kind: r.kind, hosts: r.hosts, path: r.path, ownHost: r.ownHost })), co: checkoutPatternSources(), binding: BEACON_BINDING });
  return `(() => {
  const C = ${cfg};
  const isRealLocaleSegment = ${isRealLocaleSegment.toString()};
  const ruleHit = ${blockRuleHit.toString()};
  const co = Object.fromEntries(Object.entries(C.co).map(([k, v]) => [k, new RegExp(v, 'i')]));
  const own = (h) => C.own.includes(h) || C.own.includes(h.replace(/^www\\./, '')) || C.own.includes('www.' + h);
  const allowed = (h) => C.allow.some((p) => (p.startsWith('*.') ? h === p.slice(2) || h.endsWith(p.slice(1)) : h === p));
  const isBad = (raw, base) => {
    let u; try { u = new URL(String(raw), base); } catch (e) { return true; }
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase(); const p = u.pathname;
    if (co.checkoutPath.test(p) || co.cartPermalink.test(p) || co.cartCheckout.test(p) || co.other.test(p)) return true;
    if (/^checkout$/i.test(u.searchParams.get('wc-ajax') || '')) return true;
    let dp = p; try { dp = decodeURIComponent(p); } catch (e) {}
    if (dp !== p && (co.checkoutPath.test(dp) || co.cartPermalink.test(dp) || co.cartCheckout.test(dp) || co.other.test(dp))) return true;
    const rr = u.searchParams.get('rest_route'); if (rr && co.other.test(rr)) return true;
    if (C.rules.some((r) => ruleHit(r, h, u.pathname + u.search, own(h)))) return true;
    return !(own(h) || allowed(h));
  };
  const report = (kind, url, method) => { try { let abs = String(url); try { abs = new URL(abs, location.href).href; } catch (e) {} const f = window[C.binding]; if (typeof f === 'function') f({ kind, url: abs.slice(0, 300), method: String(method || '').toUpperCase().slice(0, 12) }); } catch (e) {} };
  const seen = new WeakSet();
  const patch = (w) => {
    try {
      if (!w || seen.has(w)) return; seen.add(w);
      const base = () => { try { return w.location.href; } catch (e) { return location.href; } };
      const N = w.Navigator && w.Navigator.prototype;
      if (N && typeof N.sendBeacon === 'function') Object.defineProperty(N, 'sendBeacon', { configurable: true, writable: true, value: function sendBeacon(url) { report('beacon', url, 'POST'); return true; } });
      if (typeof w.fetchLater === 'function') Object.defineProperty(w, 'fetchLater', { configurable: true, writable: true, value: function fetchLater(input, init) { let m = 'GET'; try { m = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET'); } catch (e) {} report('fetchLater', input && input.url ? input.url : input, m); return { activated: false }; } });
      const of = w.fetch;
      if (typeof of === 'function') Object.defineProperty(w, 'fetch', { configurable: true, writable: true, value: function fetch(input, init) {
        let ka = false; let url = ''; let m = 'GET';
        try { ka = !!(init && init.keepalive) || !!(input && typeof input === 'object' && input.keepalive === true); url = input && typeof input === 'object' && 'url' in input ? input.url : String(input); m = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase(); } catch (e) {}
        if (ka && (isBad(url, base()) || !/^(GET|HEAD)$/.test(m))) { report('keepalive', url, m); return w.Promise.resolve(new w.Response(null, { status: 204, statusText: 'No Content' })); }
        return of.apply(this, arguments);
      } });
      // Playwright's serviceWorkers: 'block' puts a register() that RESOLVES on the container itself (no worker runs, but the page is told
      // it registered). Ours refuses, on the prototype and on the container, re-applied on every navigator.serviceWorker read.
      const refuse = function register() { return w.Promise.reject(new w.DOMException('Service workers are turned off by the shopper panel', 'SecurityError')); };
      const SWC = w.ServiceWorkerContainer && w.ServiceWorkerContainer.prototype;
      if (SWC && typeof SWC.register === 'function') Object.defineProperty(SWC, 'register', { configurable: true, writable: true, value: refuse });
      const swd = N && Object.getOwnPropertyDescriptor(N, 'serviceWorker');
      if (swd && swd.get) Object.defineProperty(N, 'serviceWorker', { configurable: true, enumerable: swd.enumerable, get: function () { const c = swd.get.call(this); try { if (c && c.register !== refuse) Object.defineProperty(c, 'register', { configurable: true, writable: true, value: refuse }); } catch (e) {} return c; } });
      for (const E of [w.HTMLIFrameElement, w.HTMLFrameElement, w.HTMLObjectElement]) {
        const P = E && E.prototype; if (!P) continue;
        for (const prop of ['contentWindow', 'contentDocument']) {
          const d = Object.getOwnPropertyDescriptor(P, prop); if (!d || !d.get) continue;
          Object.defineProperty(P, prop, { configurable: true, enumerable: d.enumerable, get: function () { const v = d.get.call(this); try { patch(prop === 'contentWindow' ? v : v && v.defaultView); } catch (e) {} return v; } });
        }
      }
      const op = w.open;
      if (typeof op === 'function') Object.defineProperty(w, 'open', { configurable: true, writable: true, value: function open() { const v = op.apply(this, arguments); try { patch(v); } catch (e) {} return v; } });
    } catch (e) {}
  };
  patch(window);
})();`;
}
// R27: a background request (a beacon, a keepalive fetch, a fetchLater) the page shim dropped that a cart check may have needed: a
// write (any method but GET or HEAD; a beacon is a POST) to a cart, discount, coupon, shipping or app address, or any cart write call.
// The runner counts these as guard stops while a cart check runs, so the check is reported as not tested, never as a store result.
export function cartCheckDrop(url, method = '') {
  let u; try { u = new URL(url); } catch { return false; }
  const m = String(method || 'POST').toUpperCase();
  if (/^(GET|HEAD)$/.test(m)) return false;
  if (isCartWriteCall(u.href, '', m)) return true;
  const p = stripRealLocale(u.pathname);
  return /^\/(?:cart|discounts?|coupons?|vouchers?|promo(?:tions?)?|apps|shipping)(?:[/.]|$)|shipping_rates|discount|coupon/i.test(p);
}
// A third-party host on the allow list serves only static files: a GET or HEAD for an image, style sheet, font, media, manifest or script.
export const ALLOW_HOST_TYPES = new Set([...STATIC_TYPES, 'script']);
export function allowHostRequestOk(method, resourceType) { return /^(GET|HEAD)$/i.test(String(method || '')) && ALLOW_HOST_TYPES.has(String(resourceType || '').toLowerCase()); }
// The one policy for a request, used by the browser-level guard below (and mirrored in the request guard): returns
// { why, kind } for a request that must not leave the browser, else null. kind: 'hard' (checkout, payment, login), 'dispatch' (a shared
// endpoint call that is not a known cart operation), 'cart' (a cart write in browse-only mode), 'rule', 'host'.
export function netGuardReason(pol, { url, method = 'GET', postData = '', resourceType = '', headers = {} } = {}) {
  if (!pol) return null;
  if (pol.halt) return { why: 'journey stopped', kind: 'halt' };
  if (!/^https?:/i.test(url)) return null;
  const host = new URL(url).hostname.toLowerCase();
  const rt = String(resourceType || '').toLowerCase();
  const isDoc = rt === 'document';
  const co = checkoutReason({ url, method, isNavigation: isDoc, headers });
  if (co) return { why: co, kind: 'hard' };
  const dr = dispatchReason({ url, method, body: postData || '' });
  if (dr) return { why: dr, kind: 'dispatch' };
  const oh = overrideHeaderReason(headers);
  if (oh) return { why: oh, kind: 'dispatch' };
  if (pol.noCart && isNoCartWrite(url, method, postData || '', isDoc)) return { why: 'cart write (browse only)', kind: 'cart' };
  if (findBlockRule(pol.blockRules, url, { ownHosts: pol.ownHosts, allowHosts: pol.allowHosts, resourceType: rt, isDocument: isDoc })) return { why: 'block rule', kind: 'rule' };
  if (isOwnHost(host, pol.ownHosts)) {
    // the write allow-list: on the store's own host only the Shopify cart operations are written to (see writeAllowReason)
    const wr = writeAllowReason({ url, method, body: postData, headers, ownHosts: pol.ownHosts });
    return wr ? { why: wr, kind: 'dispatch' } : null;
  }
  if (!isAllowedThirdParty(host, pol.allowHosts)) return { why: 'host not allow-listed', kind: 'host' };
  if (!allowHostRequestOk(method, rt)) return { why: 'allow-host-static-only', kind: 'host' };
  return null;
}
// Layer 2: one browser-level CDP Fetch session per Chromium browser, pausing every request of every target (pages, frames, pop-ups,
// workers) at the Request stage, each redirect hop included. getPolicy() returns the current journey's policy (or null between
// journeys); onDrop({ url, why, kind, method, resourceType, rule, host }) is called BEFORE the request is failed. A request the policy
// cannot be worked out for is failed (fail closed).
export async function installBrowserNetGuard(browser, getPolicy, onDrop) {
  let bs;
  try { bs = await browser.newBrowserCDPSession(); } catch { return null; }
  bs.on('Fetch.requestPaused', async (e) => {
    const url = e.request.url; let r = null; let pol = null;
    try { pol = getPolicy(); r = netGuardReason(pol, { url, method: e.request.method, postData: cdpPostData(e.request), resourceType: e.resourceType || '', headers: e.request.headers || {} }); }
    catch { r = { why: 'guard could not read the request', kind: 'error' }; }
    try {
      if (r) {
        if (onDrop) { try { const rule = pol && r.kind === 'rule' ? findBlockRule(pol.blockRules, url, { ownHosts: pol.ownHosts, allowHosts: pol.allowHosts, resourceType: String(e.resourceType || '').toLowerCase() }) : null; let host = ''; try { host = new URL(url).hostname.toLowerCase(); } catch {} onDrop({ url, why: r.why, kind: r.kind, method: e.request.method, resourceType: e.resourceType || '', rule: rule ? rule.name : null, ruleIsEndpoint: !!rule && isTrackerEndpointRule(rule, host), host }); } catch {} }
        await bs.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' });
      } else await bs.send('Fetch.continueRequest', { requestId: e.requestId });
    } catch {}
  });
  await bs.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  return bs;
}
export const SPECULATION_FEATURES = ['SpeculationRules', 'Prerender2', 'NoStatePrefetch'];
export function chromiumArgs({ loopback = false, extraArgs = [] } = {}) {
  const feats = new Set(SPECULATION_FEATURES);
  if (loopback) feats.add('LocalNetworkAccessChecks');
  const rest = [];
  for (const a of extraArgs) { const m = /^--disable-features=(.*)$/.exec(a); if (m) m[1].split(',').filter(Boolean).forEach((f) => feats.add(f)); else rest.push(a); }
  return [`--disable-features=${[...feats].join(',')}`, ...rest];
}
// Speculation rules removed from a page before the browser sees it (the inline script and the Speculation-Rules header), plus
// <link rel=prerender|prefetch> hints.
export function stripSpeculation(html) {
  return String(html)
    .replace(/<script\b[^>]*\btype\s*=\s*["']?speculationrules["']?[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\b(?:prerender|prefetch)\b[^>]*>/gi, '');
}
// the store's home page (/, or a locale home such as /en-gb/), on its own host
export function isHomePage(url, ownHosts) {
  try { const u = new URL(url); return isOwnHost(u.hostname.toLowerCase(), ownHosts) && (u.pathname === '/' || (u.pathname.endsWith('/') && stripRealLocale(u.pathname) === '/')); } catch { return false; }
}
// The runner's tap marker for the guard: the resolved action of the form the tapped submit button sends by POST (its formaction if
// it has one), or '' for anything else (a link, a plain button, an AJAX Add to cart, a swatch). After the cart is touched it is the
// only form post that may load (see installGuard); a GET never needs it, as every GET is checked against the after-cart rule.
export async function tapDestination(loc) {
  try {
    return await loc.evaluate((el) => {
      const s = el.closest('button, input');
      if (!(s && s.form && (s.type === 'submit' || s.type === 'image'))) return '';
      const method = String(s.hasAttribute('formmethod') ? s.formMethod : s.form.method).toLowerCase();
      if (method !== 'post') return '';
      return s.hasAttribute('formaction') ? s.formAction : s.form.action;
    }, null, { timeout: 3000 });
  } catch { return ''; }
}
export function tapMark(dest) { return /^https?:/i.test(String(dest || '')) ? { url: String(dest) } : 0; }
// whether a page load at u is the one the marker expects (same origin and path). Used only for the one thing the marker still allows
// after the cart is touched: the main-page form POST of the runner's own tap (the Add to cart form), never a GET and never a frame.
export function isExpectedLoad(mark, u) {
  if (!mark || typeof mark !== 'object' || !mark.url) return false;
  try { const a = new URL(mark.url), b = new URL(u); return a.origin === b.origin && a.pathname === b.pathname; } catch { return false; }
}
// The cart was touched: by the runner itself the moment it taps Add to cart, by a recognised background cart write, or by a main-page
// cart action. From then on, for the rest of the journey, every document load in every tab and frame (the runner's own taps and gotos,
// scripts, pop-ups, frames) and every server redirect hop must pass allowedAfterCartAction against one of the pages the cart was touched
// from (only pages that really loaded; history.pushState cannot add one). Nothing clears it.
export function markCartTouched(state, from) {
  if (!state) return;
  if (!Array.isArray(state.cartPages)) state.cartPages = [];
  if (from && !state.cartPages.includes(from)) { state.cartPages.push(from); if (state.cartPages.length > 8) state.cartPages.shift(); }
  state.cartFrom = from || state.cartFrom || 'touched';
}
export function allowedAfterCartTouched(url, ownHosts, landingPaths, state) {
  const froms = [...((state && state.cartPages) || []), (state && state.cartFrom) || ''];
  if (froms.some((f) => allowedAfterCartAction(url, ownHosts, landingPaths, f))) return true;
  // the store's own cart page at a slug of its own (/shopping-cart/, /my-cart/), learned before the add (see learnCartUrl)
  let x; try { x = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(x.protocol) || !isOwnHost(x.hostname, ownHosts)) return false;
  const p = x.pathname.replace(/\/$/, '');
  return ((state && state.cartUrls) || []).some((c) => c.replace(/\/$/, '') === p);
}
// The store's real cart address, read from the store's own page settings (wc_add_to_cart_params.cart_url, wcSettings cartUrl,
// Shopify routes.cart_url) or the view-cart link or cart icon, all read from the product page before Add to cart is tapped (never
// after). Kept (as a path) only when it is the store's own host, http(s), not a checkout by address, not a product page or a listing,
// and has no query; it is then allowed after the cart action as a GET (its content is still checked
// for a checkout, as every page load is). Returns the path kept, or null.
export function learnCartUrl(state, url, base, ownHosts) {
  if (!state || !url) return null;
  let x; try { x = new URL(String(url), base || undefined); } catch { return null; }
  if (!/^https?:$/.test(x.protocol) || !isOwnHost(x.hostname.toLowerCase(), ownHosts)) return null;
  if (x.hash) x.hash = '';
  if (checkoutReason({ url: x.toString(), method: 'GET', isNavigation: true })) return null;
  if (isCartActionRequest(x.toString(), 'GET') || isCartWriteCall(x.toString(), '')) return null;
  if (x.search) return null;
  const p = x.pathname;
  if (!p || p === '/') return null;
  // a product, collection or shop listing is never taken for the cart
  if (/\/(?:products?|collections?|product-category|shop|category|tag)(?:\/|$)/i.test(p)) return null;
  if (!Array.isArray(state.cartUrls)) state.cartUrls = [];
  if (!state.cartUrls.includes(p)) { state.cartUrls.push(p); if (state.cartUrls.length > 4) state.cartUrls.shift(); }
  return p;
}
export async function installGuard(ctx, g) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const redirectChain = (req) => { const out = []; try { for (let r = req.redirectedFrom(); r; r = r.redirectedFrom()) out.push(r.url()); } catch {} return out; };
  // testNoRouteGuard: offline tests only (the runner honours it only for a loopback --url), to prove the browser-level guard alone
  // stops each request; nothing of this layer is installed then
  if (g.testNoRouteGuard) return;
  // The browser runs offline: every response it gets is served by the request guard below (route.fetch runs outside the browser), so
  // anything that bypasses the guard (a socket, a request the guard never saw) fails instead of reaching the network
  await ctx.setOffline(true);
  await ctx.addInitScript(SPECULATION_BLOCKER);
  await ctx.addInitScript(beaconBlockerScript({ ownHosts: [...g.ownHosts], allowHosts: g.allowHosts, rules: g.blockRules }));
  const wcfg = workerGuardConfig({ ownHosts: g.ownHosts, allowHosts: g.allowHosts, rules: g.blockRules });
  // skipWorkerGuardForTest: offline tests only (the runner sets it only for a loopback --url), to check that a worker without the guard
  // is closed and reported
  if (!g.skipWorkerGuardForTest) await ctx.addInitScript(`(${wcfg.boot})(${JSON.stringify(wcfg)}, window, false);`);
  await ctx.exposeBinding(BEACON_BINDING, (_src, d) => { try { if (d && d.kind === 'sync-xhr') { if (g.onIntervention) g.onIntervention({ what: 'a synchronous request (the panel refuses every one)', method: '', url: stripQuery(String(d.url)), kind: 'xhr', tab: 'page' }); return; } if (d && d.kind === 'socket') { if (g.onIntervention) g.onIntervention({ what: 'a WebTransport or WebSocketStream connection (the panel refuses every socket)', method: '', url: stripQuery(String(d.url)), kind: 'websocket', tab: 'page' }); return; } if (g.onBeacon) g.onBeacon(d && typeof d === 'object' ? { kind: String(d.kind).slice(0, 20), url: stripQuery(String(d.url)), method: /^[A-Z]{1,12}$/.test(String(d.method || '')) ? String(d.method) : '' } : { kind: 'unknown', url: '', method: '' }); } catch {} }).catch(() => {});
  // WebSockets do not pass through ctx.route. Every socket a page opens goes through routeWebSocket instead and is closed before it
  // connects, for the whole journey: the panel cannot read what a socket sends, so it never opens one. A socket to the store's own host
  // or an allow-listed host is reported as a guard intervention (a journey that fails after it is a tool limit); any other is counted as
  // a blocked host.
  if (typeof ctx.routeWebSocket === 'function') {
    await ctx.routeWebSocket(() => true, (ws) => {
      const u = ws.url(); let host = ''; try { host = new URL(u).hostname.toLowerCase(); } catch {}
      const own = !!host && isOwnHost(host, g.ownHosts);
      const rule = findBlockRule(g.blockRules, u.replace(/^ws/i, 'http'), { ownHosts: g.ownHosts, allowHosts: g.allowHosts, resourceType: 'websocket', isDocument: false });
      if (!rule && (own || (host && isAllowedThirdParty(host, g.allowHosts)))) { try { if (g.onIntervention) g.onIntervention({ what: 'a WebSocket connection (the panel refuses every socket)', method: 'WEBSOCKET', url: stripQuery(u), kind: 'websocket', tab: 'page' }); } catch {} }
      else { try { g.onThirdParty({ blocked: true, name: rule ? rule.name : 'not-allow-listed', host: own ? '' : host, url: u }); } catch {} }
      return ws.close({ code: 1008, reason: 'blocked by the shopper panel' }).catch(() => {});
    });
  }
  const isMainNav = (req) => { try { const p = g.getPage(); return req.isNavigationRequest() && !!p && req.frame() === p.mainFrame(); } catch { return false; } };
  // the top frame of a tab other than the runner's page (a pop-up or a new tab); false for an iframe. A new tab's first page load is
  // requested before its frame exists, so Playwright has no frame for it: a navigation request without a frame is a new tab.
  const isTopOfOtherPage = (req) => { let f; try { f = req.frame(); } catch { return req.isNavigationRequest(); } try { return !f.parentFrame() && f.page() !== g.getPage(); } catch { return false; } };
  await ctx.route('**/*', async (route) => {
    // halted (the journey was stopped or timed out): nothing more leaves this context
    if (g.state && g.state.halt) return route.abort('blockedbyclient').then(() => { haltedSet(g.state).add(route.request()); }, () => {});
    // every request still in this handler is listed, so a stop can abort them first (haltGuard): a request the context's close leaves
    // unhandled would otherwise be sent by the browser itself, a second copy of a cart write the panel already sent
    const pend = g.state ? (g.state.pending || (Object.defineProperty(g.state, 'pending', { value: new Set(), enumerable: false }), g.state.pending)) : new Set();
    pend.add(route);
    try { return await guardRoute(route); } finally { pend.delete(route); }
  });
  // where a request came from: 'main' (the runner's page, its top frame), 'frame' (a frame in it), 'other' (another tab or a pop-up; a
  // new tab's first page load has no frame yet) or 'worker' (no frame at all)
  const tabOf = (req) => {
    let f = null; try { f = req.frame(); } catch { return req.isNavigationRequest() ? 'other' : 'worker'; }
    try { if (f.page() !== g.getPage()) return 'other'; return f.parentFrame() ? 'frame' : 'main'; } catch { return 'other'; }
  };
  // A cart write in cart mode: one that adds items turns the after-cart rule on; any other (cart attributes, a note, a write the panel
  // cannot read) is only noted.
  const noteCartWrite = (url, body, method) => {
    const adds = isCartItemAdd(url, body, method);
    if (adds) { let from = ''; try { from = g.getPage()?.url() || ''; } catch {} markCartTouched(g.state, g.state.lastDoc || from); } else g.state.cartDirty = true;
    try { if (g.onCartTouched) g.onCartTouched(url, { adds }); } catch {}
  };
  async function guardRoute(route) {
    const req = route.request(); const u = req.url();
    const main = isMainNav(req);
    const rt = req.resourceType();
    const isDoc = req.isNavigationRequest() || rt === 'document';
    const method0 = req.method();
    const write0 = !/^(GET|HEAD)$/i.test(method0);
    const body0 = write0 ? (req.postData() || '') : '';
    const tab = tabOf(req);
    const reqHeaders = req.headers();
    const why = checkoutReason({ url: u, method: method0, isNavigation: req.isNavigationRequest(), redirectedFrom: redirectChain(req), formBody: method0 === 'POST' ? body0 : '', headers: reqHeaders });
    // reached_server: whether a request for the stopped address itself was sent to the store (true only for a content check, which
    // fetches the page to look at it and then never shows it). hops: every request in the chain with its real method.
    const hops = [{ method: method0, url: stripQuery(u) }];
    const stop = (reason, target = u, reachedServer = false) => { g.onCheckout({ method: hops.at(-1).method, url: stripQuery(target), request_url: stripQuery(u), why: reason, main_frame: main, tab, reached_server: reachedServer, hops: hops.slice() }); return route.abort('aborted').catch(() => {}); };
    // a request the guard stops for a reason of its own (not a tracker, not a checkout): reported, so a journey that fails after it is
    // a tool limit, never the store's fault
    const intervene = (what, target = u, kind = isDoc ? 'page load' : rt) => { try { if (g.onIntervention) g.onIntervention({ what, method: hops.at(-1).method, url: stripQuery(target), kind, tab }); } catch {} return route.abort('blockedbyclient').catch(() => {}); };
    // a write to a shared endpoint (GraphQL, /api, admin-ajax.php, wc-ajax, /rest/, ?route=, ?controller=, ?fc=) that does not name a
    // known cart operation: stopped and reported as kind 'dispatch', which makes any quit of this journey a tool limit (test_limit)
    const dispatchStop = (reason, target = u) => intervene(`${reason}; only known cart operations are sent to a shared endpoint`, target, 'dispatch');
    // a request to a host that is not the store's own: only a GET or HEAD for a static file reaches an allow-listed host, and nothing
    // that is not a GET or HEAD reaches any other host
    const thirdPartyOk = (host, own, method, type) => own || !host || (isAllowedThirdParty(host, g.allowHosts) && allowHostRequestOk(method, type));
    // background speculation (prefetch / prerender) is never allowed: it would load pages the shopper did not open
    const purpose = String(req.headers()['sec-purpose'] || req.headers()['purpose'] || '');
    if (/prefetch|prerender/i.test(purpose)) { if (g.onSpeculative) g.onSpeculative({ url: stripQuery(u), purpose }); return route.abort('blockedbyclient').catch(() => {}); }
    if (why) return stop(why);
    const dr = /^https?:/i.test(u) ? dispatchReason({ url: u, method: method0, body: body0 }) : null;
    if (dr) return dispatchStop(dr);
    // a routing or method override header is refused on every request, a GET included
    const ohr = overrideHeaderReason(reqHeaders);
    if (ohr) return intervene(`${ohr}, refused on every request`, u, 'dispatch');
    // the write allow-list (see writeAllowReason): a write on the store's own host that is not a Shopify cart operation is stopped and
    // reported as kind 'dispatch', so a journey that fails after it is a tool limit, never the store's fault. A named rule's stop on the
    // store's own host (a tracker endpoint) stays a rule count below.
    const allowStop = (target, method, body) => {
      if (/^(GET|HEAD)$/i.test(String(method)) || !/^https?:/i.test(target)) return null;
      let wh = ''; try { wh = new URL(target).hostname.toLowerCase(); } catch {}
      if (!wh || !isOwnHost(wh, g.ownHosts) || findBlockRule(g.blockRules, target, { ownHosts: g.ownHosts, allowHosts: g.allowHosts, resourceType: rt, isDocument: isDoc })) return null;
      return writeAllowReason({ url: target, method, body, headers: reqHeaders, ownHosts: g.ownHosts });
    };
    // the worker wrapper (see workerGuardFn): a marked worker address on the store's own host or an allow-listed host (a worker an
    // allowed widget frame starts) is answered here with the guard plus an import of the real script, and a blocked worker socket's
    // report is counted and stopped; neither reaches the server
    if (/^https?:/.test(u)) {
      let pu = null; try { pu = new URL(u); } catch {}
      if (pu && (isOwnHost(pu.hostname.toLowerCase(), g.ownHosts) || isAllowedThirdParty(pu.hostname.toLowerCase(), g.allowHosts))) {
        if (pu.pathname === SOCKET_REPORT_PATH) {
          const bad = pu.searchParams.get('u') || ''; let host = ''; try { host = new URL(bad).hostname.toLowerCase(); } catch {}
          const ownSock = !!host && isOwnHost(host, g.ownHosts);
          const rule = findBlockRule(g.blockRules, bad.replace(/^ws/i, 'http'), { ownHosts: g.ownHosts, allowHosts: g.allowHosts, resourceType: 'websocket', isDocument: false });
          if (!rule && (ownSock || (host && isAllowedThirdParty(host, g.allowHosts)))) { try { if (g.onIntervention) g.onIntervention({ what: 'a WebSocket connection from a worker (the panel refuses every socket)', method: 'WEBSOCKET', url: stripQuery(bad), kind: 'websocket', tab: 'worker' }); } catch {} }
          else { try { g.onThirdParty({ blocked: true, name: rule ? rule.name : 'not-allow-listed', host: ownSock ? '' : host, url: u }); } catch {} }
          return route.abort('blockedbyclient').catch(() => {});
        }
        const wm = pu.searchParams.get(WORKER_MARK);
        if (wm === 'c' || wm === 'm') {
          pu.searchParams.delete(WORKER_MARK);
          return route.fulfill({ status: 200, contentType: 'text/javascript', body: workerGuardSource(wcfg, pu.href, wm === 'm') }).catch(() => {});
        }
      }
    }
    const landing = g.landingPaths || new Set();
    // No-cart mode: nothing may write to the cart, not even the page itself (an auto-add gift app, a script, an image, a self-submitting
    // form). Each such request (its body decoded first) is stopped before it leaves the browser and reported; the cart is never touched.
    if (g.noCart && isNoCartWrite(u, method0, body0, isDoc)) {
      try { if (g.onCartWrite) g.onCartWrite({ method: method0, url: stripQuery(u), kind: isDoc ? 'page load' : rt, main_frame: main }); } catch {}
      return route.abort('blockedbyclient').catch(() => {});
    }
    const wr = allowStop(u, method0, write0 ? req.postData() : '');
    if (wr) return intervene(`${wr}; on the store's own host the panel sends only the Shopify cart operations`, u, 'dispatch');
    // The after-cart rule (see markCartTouched). Once the cart is touched, every document load in ANY tab or frame, the runner's own
    // included (a tap, a goto, a meta refresh, location.href, a form that submits itself, a window.open pop-up, a link that clicks
    // itself into a new tab, an iframe), must be a GET to where a page may go after a cart action (the landing page, a page the cart was
    // touched from, "/", the cart, a real locale home); anything else is stopped before it is requested. It holds for the rest of the
    // journey. The one form allowed is the runner's own tapped form (state.deliberate: the tapped form's action, main page only), such as
    // the Add to cart form, when it posts to such a page or to /cart/add; its server redirects are then checked hop by hop below.
    if (isDoc && /^https?:/.test(u)) {
      const topNew = !main && isTopOfOtherPage(req);
      if (g.state.cartFrom) {
        const get = method0 === 'GET';
        const okAddr = allowedAfterCartTouched(u, g.ownHosts, landing, g.state);
        const ownForm = !get && main && isExpectedLoad(g.state.deliberate, u) && (okAddr || /\/cart\/add(?:\.js)?\/?$/i.test(stripRealLocale(new URL(u).pathname)));
        if (ownForm) g.state.deliberate = 0;
        if (!(get ? okAddr : ownForm)) {
          hops.length = 0; hops.push({ method: method0, url: stripQuery(u) });
          const where = main ? '' : topNew ? ' (a pop-up or new tab)' : ' (a frame)';
          const what = get ? 'to a page of no known kind' : 'sending a form';
          return stop(`a page load after the cart was touched${where} (a tap, a script, a meta refresh, a self-submitting form, a pop-up or a frame), ${what}; not requested`, u, false);
        }
      }
      if (isCartActionRequest(u, method0) || isCartWriteCall(u, body0, method0)) {
        if (main && isCartActionRequest(u, method0)) { markCartTouched(g.state, u); try { if (g.onCartTouched) g.onCartTouched(u, { adds: true }); } catch {} }
        else noteCartWrite(u, body0, method0);
      }
    } else if (/^https?:/.test(u) && isCartWriteCall(u, body0, method0)) noteCartWrite(u, body0, method0);
    let host = ''; try { host = new URL(u).hostname.toLowerCase(); } catch {}
    const own = !!host && isOwnHost(host, g.ownHosts);
    const allowed = own || !host || /^(data|blob|about):/.test(u) || thirdPartyOk(host, own, method0, rt);
    const rule = findBlockRule(g.blockRules, u, { ownHosts: g.ownHosts, allowHosts: g.allowHosts, resourceType: rt, isDocument: isDoc });
    // a named rule stopping something on the store's own host or an allow-listed host: reported so a failed journey is not blamed on the store
    if (rule && allowed && host && !isTrackerEndpointRule(rule, host) && g.onRuleOnAllowed) g.onRuleOnAllowed({ rule: rule.name, url: stripQuery(u), own, resourceType: rt });
    // Only THIRD-PARTY hosts are reported by host. A named rule that stops the store's own path (an analytics endpoint) is counted by
    // rule name with an empty host, so the store's own host never lands in the blocked-host list used to explain script errors.
    const reportHost = own ? '' : host;
    const blockName = (r, h, isAllowList) => r ? r.name : isAllowList ? 'allow-host-static-only' : 'not-allow-listed';
    if (rule || !allowed) { g.onThirdParty({ blocked: true, name: blockName(rule, host, !!host && isAllowedThirdParty(host, g.allowHosts)), host: reportHost, url: u }); return route.abort('blockedbyclient').catch(() => {}); }
    g.onThirdParty({ blocked: false, name: null, host: reportHost });
    if (!/^https?:/i.test(u)) { sentSet(g.state).add(req); return route.continue().catch(() => {}); }
    // a server-sent event stream never ends, so it cannot be fetched here and checked hop by hop: it is stopped and reported
    if (rt === 'eventsource') return intervene('a server-sent event stream (EventSource), which the panel cannot check hop by hop, was stopped');
    if (g.delayMs) await sleep(g.delayMs);
    // Server redirects are never handed to the browser, for any kind of request (a page, a frame, fetch, XHR, an image, a script, a
    // style sheet, a font, media). A redirect fulfilled back to the browser is followed WITHOUT coming through this handler again
    // (Chromium), and route.continue() lets the browser follow a redirect unchecked on both engines. So every request is fetched here
    // with redirects off and every hop is followed here: each Location is checked, as a first request is, BEFORE it is requested (a
    // checkout, a page not allowed after the Checkout tap, a form kept by a 307/308 after the tap, a cart write in no-cart mode, the
    // after-cart rule, a block rule, a host not allow-listed). A hop to another origin is never answered under the first address: a page
    // load gets a tiny page that sends the browser on to the new address (that load comes through this handler again, in view), and a
    // fetch, XHR, worker script or form post is stopped; only a plain resource (an image, a script, a style sheet, a font, media) is
    // handed over, under the first address. Known edge: the page then treats it as coming from the first origin, so a canvas drawn with
    // such an image is not marked cross-origin and a style sheet's rules can be read; this only changes what the page itself can read,
    // never what is sent to the store. For a page redirected on its own origin the page gets a <base> for the
    // final address and history.replaceState, so links and page.url() match the final address.
    const dest = String(req.headers()['sec-fetch-dest'] || '').toLowerCase();
    const corsLike = rt === 'fetch' || rt === 'xhr' || /^(worker|sharedworker|serviceworker|empty)$/.test(dest);
    let resp; let body; let at = u; let method = method0; let postData = req.postDataBuffer();
    const baseHeaders = { ...req.headers() };
    let headers = undefined;
    const chain = [...redirectChain(req)];
    const cartAction = isCartActionRequest(chain.length ? chain.at(-1) : u, method0) || isCartActionRequest(u, method0);
    let origin0 = ''; try { origin0 = new URL(u).origin; } catch {}
    try {
      sentSet(g.state).add(req);
      resp = await route.fetch({ maxRedirects: 0 });
      if (g.state) answeredSet(g.state).add(req);
      for (let hop = 0; hop < 10; hop++) {
        // halted (the journey was stopped) while this request was on its way: the store has answered it; no redirect is followed
        if (g.state && g.state.halt) return route.abort('blockedbyclient').catch(() => {});
        const loc = resp.headers().location;
        if (!(resp.status() >= 300 && resp.status() < 400 && loc)) break;
        let target; try { target = new URL(loc, at).toString(); } catch { break; }
        chain.push(at);
        const keep = resp.status() === 307 || resp.status() === 308;
        const nextMethod = keep ? method : 'GET';
        const nextBody = keep && postData ? postData.toString('utf8') : '';
        const via = `(server redirect from ${stripQuery(at)})`;
        if (!/^https?:/i.test(target)) return intervene(`a server redirect to an address that is not http(s) ${via}`, target);
        // every check gets this hop's own method and body (a 307 or 308 sends the same body again; any other redirect becomes a GET)
        const why2 = checkoutReason({ url: target, method: nextMethod, isNavigation: isDoc, redirectedFrom: chain, formBody: nextMethod === 'POST' ? nextBody : '', headers: reqHeaders });
        if (why2) return stop(`${why2} ${via}`, target);
        const dr2 = dispatchReason({ url: target, method: nextMethod, body: nextBody });
        if (dr2) return dispatchStop(`${dr2} ${via}`, target);
        const wr2 = allowStop(target, nextMethod, nextBody);
        if (wr2) { hops.push({ method: nextMethod, url: stripQuery(target) }); return intervene(`${wr2} ${via}; not sent`, target, 'dispatch'); }
        if (g.noCart && isNoCartWrite(target, nextMethod, nextBody, isDoc)) {
          try { if (g.onCartWrite) g.onCartWrite({ method: nextMethod, url: stripQuery(target), kind: `${isDoc ? 'page load' : rt} (server redirect)`, main_frame: main }); } catch {}
          return route.abort('blockedbyclient').catch(() => {});
        }
        // after a cart action, or once the cart was touched (any document, the runner's own included), a server redirect to a page of no
        // known safe kind is stopped WITHOUT requesting that page
        if (isDoc && (cartAction || g.state.cartFrom) && !(cartAction && allowedAfterCartAction(target, g.ownHosts, landing, u)) && !allowedAfterCartTouched(target, g.ownHosts, landing, g.state)) {
          hops.push({ method: nextMethod, url: stripQuery(target) });
          return stop(`unknown redirect target, not fetched (a redirect after ${hops[0].method} ${stripQuery(u).replace(/^https?:\/\/[^/]+/, '')})`, target, false);
        }
        let th = ''; try { th = new URL(target).hostname.toLowerCase(); } catch {}
        const tOwn = !!th && isOwnHost(th, g.ownHosts);
        const tAllowed = !!th && thirdPartyOk(th, tOwn, nextMethod, rt);
        const trule = findBlockRule(g.blockRules, target, { ownHosts: g.ownHosts, allowHosts: g.allowHosts, resourceType: rt, isDocument: isDoc });
        if (trule && tAllowed && !isTrackerEndpointRule(trule, th) && g.onRuleOnAllowed) g.onRuleOnAllowed({ rule: trule.name, url: stripQuery(target), own: tOwn, resourceType: rt });
        if (trule || !tAllowed) { g.onThirdParty({ blocked: true, name: blockName(trule, th, !!th && isAllowedThirdParty(th, g.allowHosts)), host: tOwn ? '' : th, url: target }); return route.abort('blockedbyclient').catch(() => {}); }
        let cross = true; try { cross = new URL(target).origin !== origin0; } catch {}
        if (cross) {
          if (isDoc && nextMethod === 'GET') {
            if (main) g.state.lastDoc = u;
            return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: bounceHtml(target) }).catch(() => {});
          }
          if (isDoc || corsLike) return intervene(`a server redirect to another origin (${new URL(target).origin}) ${via}, not followed`, target);
        }
        if (!g.noCart && (isCartWriteCall(target, nextBody, nextMethod) || (isDoc && isCartActionRequest(target, nextMethod)))) noteCartWrite(target, nextBody, nextMethod);
        if (!keep) {
          method = 'GET'; postData = undefined;
          headers = Object.fromEntries(Object.entries(baseHeaders).filter(([k]) => !/^(content-type|content-length|origin)$/i.test(k)));
        }
        at = target;
        hops.push({ method: nextMethod, url: stripQuery(at) });
        resp = await route.fetch({ url: at, method, ...(postData ? { postData } : {}), ...(headers ? { headers } : {}), maxRedirects: 0 });
      }
      body = await resp.body();
    } catch { return route.abort('failed').catch(() => {}); }
    // Fulfilled bodies skip the browser's own network throttling, so it is re-applied here: transfer time at the persona's download
    // speed plus latency, using the wire size (content-length when compressed, else a gzip estimate for text, else raw length).
    if (g.throttle && g.throttle.down_kbps) {
      const ms = (wireBytes(resp.headers(), body) / ((g.throttle.down_kbps * 1024) / 8)) * 1000 + (g.throttle.latency_ms || 0);
      if (ms > 0) await sleep(ms);
    }
    if (resp.status() >= 300 && resp.status() < 400 && resp.headers().location) return route.fulfill({ status: 508, contentType: 'text/plain', body: 'Too many redirects (stopped by the shopper panel)' }).catch(() => {});
    if (rt === 'document' && /html/i.test(resp.headers()['content-type'] || 'text/html')) {
      const cw = checkoutContentReason(body.toString('utf8'));
      if (cw) return stop(`checkout page content (${cw})${at !== u ? ` reached by redirect` : ''}; the page reached the store's server but was not shown`, at, true);
    }
    const headersOut = { ...resp.headers() };
    delete headersOut['speculation-rules'];
    if (rt === 'document' && /text\/html/i.test(headersOut['content-type'] || '')) {
      const html = body.toString('utf8'); const clean = stripSpeculation(html);
      if (clean !== html) { body = Buffer.from(clean, 'utf8'); delete headersOut['content-length']; delete headersOut['content-encoding']; if (g.onSpeculative) g.onSpeculative({ url: stripQuery(at), purpose: 'speculation rules removed from the page' }); }
    }
    if (at !== u) {
      delete headersOut['content-length']; delete headersOut['content-encoding'];
      // only a redirect on the same origin gets here for a page (another origin was sent on above)
      if (rt === 'document' && /text\/html/i.test(headersOut['content-type'] || '')) {
        const fix = `<base href="${at.replace(/"/g, '&quot;')}"><script>try{history.replaceState(history.state,'',${JSON.stringify(at)})}catch(e){}</script>`;
        const html = body.toString('utf8');
        const m = /<head[^>]*>/i.exec(html);
        body = Buffer.from(m ? html.slice(0, m.index + m[0].length) + fix + html.slice(m.index + m[0].length) : fix + html, 'utf8');
      }
    }
    // the address the runner's page really loaded (history.pushState cannot change it): the page a background cart write was sent
    // from, so a script that pushes a payment address before its cart call cannot make that address the allowed "from" page
    if (main && rt === 'document') g.state.lastDoc = at;
    return route.fulfill({ status: resp.status(), headers: headersOut, body }).catch(() => {});
  }
}
// the page answered for a page load that a server redirected to another origin: it sends the browser on to that address, as a new page
// load the guard checks again, so the other origin's page is never shown under the first address
export function bounceHtml(target) {
  const t = String(target);
  return `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"><title>Redirecting</title><script>location.replace(${JSON.stringify(t).replace(/</g, '\\u003c')})</script>`;
}

// checkout_page_loaded is measured, in every frame: a checkout navigation response that was not an error, a frame that really reached a
// checkout URL, or a frame whose loaded page has checkout content (body.woocommerce-checkout, form.checkout, the WooCommerce checkout
// block, Shopify.Checkout).
export function watchCheckoutLoaded(page, onLoaded, onShown = () => {}) {
  const reached = (url) => { try { return /^https?:/.test(url) && checkoutReason({ url }) !== null; } catch { return false; } };
  const noHash = (u) => String(u || '').split('#')[0];
  // the address each frame's last document actually came from (a navigation response); a frame whose address changes without one
  // changed it in the page (history.pushState, a hash route): nothing was loaded, so that is a checkout shown, not a checkout loaded
  const docs = new WeakMap();
  page.on('response', (r) => { try { const q = r.request(); if (!q.isNavigationRequest()) return; docs.set(q.frame(), noHash(r.url())); if (reached(r.url()) && r.status() < 400) onLoaded(`checkout address ${stripQuery(r.url())}`); } catch {} });
  page.on('framenavigated', async (f) => {
    try {
      if (reached(f.url())) {
        if (docs.has(f) && docs.get(f) !== noHash(f.url())) { onShown(`checkout address ${stripQuery(f.url())} set by the page itself (no page was loaded)`); return; }
        onLoaded(`checkout address ${stripQuery(f.url())}`); return;
      }
      if (!/^https?:/.test(f.url())) return;
      // read at DOMContentLoaded, at load and once more 2 s later, so content a script renders after the page loads is seen too
      const u0 = f.url();
      for (const step of ['domcontentloaded', 'load', 2000]) {
        if (typeof step === 'number') await new Promise((r) => setTimeout(r, step)); else await f.waitForLoadState(step, { timeout: 15000 }).catch(() => {});
        if (f.isDetached() || f.url() !== u0) return;
        const c = await f.evaluate(checkoutContentInPage).catch(() => null);
        if (c) { onLoaded(`checkout content (${c}) at ${stripQuery(f.url())}`); return; }
      }
    } catch {}
  });
}
// Page-side: a checkout the page shows without loading one: a hash route (#/checkout, #!/checkout), or a heading or title that is
// just "Checkout", "Secure checkout" or "Payment". Returns a short description or null.
export function checkoutShownInPage() {
  try {
    const h = String(location.hash || '').replace(/^#!?/, '');
    if (h && /(?:^|\/)(?:checkouts?|payment|order-pay)(?:[/?#_.-]|$)/i.test(h)) return `hash route #${h.slice(0, 60)}`;
    const plain = (t) => /^\s*(?:secure\s+)?(?:checkout|payment|pay now)\s*$/i.test(String(t || ''));
    if (plain(document.title)) return `page title "${String(document.title).trim().slice(0, 40)}"`;
    for (const el of document.querySelectorAll('h1, h2')) {
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && plain(el.textContent)) return `heading "${el.textContent.trim().slice(0, 40)}"`;
    }
  } catch {}
  return null;
}
// Before every activating call: is any tab or frame (about:blank and srcdoc frames included) showing a checkout, by address (the hash
// route too), by checkout content, or by a plain Checkout heading? Returns a short description or null. Nothing is sent to the store.
export async function checkoutShownInContext(ctx) {
  for (const p of ctx.pages()) {
    let pu = ''; try { pu = p.url(); } catch {}
    if (/^https?:/.test(pu) && checkoutReason({ url: pu.split('#')[0] })) return `checkout address ${stripQuery(pu)}${p === ctx.pages()[0] ? '' : ' (another tab)'}`;
    for (const f of p.frames()) {
      let u = ''; try { u = f.url(); } catch {}
      if (!/^(https?:|about:|data:|blob:)|^$/.test(u)) continue;
      const c = await f.evaluate(checkoutContentInPage).catch(() => null);
      if (c) return `checkout content (${c}) at ${stripQuery(u) || 'about:blank'}`;
      const s = await f.evaluate(checkoutShownInPage).catch(() => null);
      if (s) return `${s} at ${stripQuery(u) || 'about:blank'}`;
    }
  }
  return null;
}
// Every tab the context opens (target=_blank links, window.open) is watched too.
// A new tab may already have navigated before its 'page' event fires, so each new tab is also checked once as it is.
export function watchContext(ctx, onLoaded, onNewTab = () => {}, onShown = () => {}) {
  for (const p of ctx.pages()) watchCheckoutLoaded(p, onLoaded, onShown);
  ctx.on('page', (p) => {
    watchCheckoutLoaded(p, onLoaded, onShown);
    try { onNewTab(p); } catch {}
    (async () => {
      try {
        await p.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        const u = p.url();
        if (!/^https?:/.test(u)) return;
        if (checkoutReason({ url: u }) !== null) { onLoaded(`checkout address ${stripQuery(u)} (new tab)`); return; }
        const c = await p.mainFrame().evaluate(checkoutContentInPage).catch(() => null);
        if (c) onLoaded(`checkout content (${c}) at ${stripQuery(u)} (new tab)`);
      } catch {}
    })();
  });
}

// ---------- typing ----------
// Anything that looks personal or payment related, by label, name, id or placeholder: never typed into.
// An address on this computer, a private network or the cloud metadata service (an IP written out, or localhost). The panel tests
// public stores, or the practice store on this computer; it never points a browser or a pre-check at a private network address.
// Returns 'loopback', 'private' or null.
export function privateAddressKind(host) {
  let h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h); if (mapped) h = mapped[1];
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    if (a === 127) return 'loopback';
    if (a === 0 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return 'private';
    return null;
  }
  if (h.includes(':')) {
    if (h === '::1') return 'loopback';
    if (h === '::' || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h) || /^::ffff:/.test(h)) return 'private';
  }
  return null;
}
// What a persona may type (choices[].type_text) is checked by its content too, not only by the box it goes into: text that looks
// like an email address, a web address, a payment card number or a phone number is refused, in the validator, in the runner's
// persona check and again right before typing. Returns the reason, or null when the text is fine. Fails closed: a date such as
// 12.05.2026 passes, but any 9 or more digits do not.
export function personalTextReason(text) {
  const t = String(text ?? '');
  if (/\S@\S/.test(t)) return 'looks like an email address';
  if (/[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|app|dev|shop|store|info|biz|me|us|uk|de|fr|ca|au|nl|es|it)\b/i.test(t)) return 'looks like a web address';
  const digits = t.replace(/\D/g, '');
  const runs = t.match(/\d[\d\s.-]*\d/g) || [];
  const luhn = (d) => { let sum = 0; for (let i = 0; i < d.length; i++) { let n = +d[d.length - 1 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; } return sum % 10 === 0; };
  for (const r of runs) { const d = r.replace(/\D/g, ''); if (d.length >= 12 || (d.length >= 8 && luhn(d) && !/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(r.trim()))) return 'looks like a payment card number'; }
  if (digits.length >= 9 || /\+\s*\d/.test(t) || /\b\d{3}[\s.-]\d{4}\b/.test(t)) return 'looks like a phone number';
  return null;
}
export const PERSONAL_FIELD = /e-?mail|phone|\btel\b|mobile|names?\b|surname|recipient|sender|address|street|city|town|zip|postal|post.?code|country|\bstate\b|province|county|card|cvc|cvv|\bcsc\b|expir|payment|\bpay\b|billing|shipping|iban|swift|\bbic\b|sort.?code|routing|account|bank|ssn|social.?security|national.?id|passport|licen[cs]e|\btax\b|\bvat\b|company|business|birth|\bdob\b|\bage\b|gender|password|passcode|\bpin\b|\botp\b|one.?time|login|signature|contact|whatsapp|telegram|instagram|twitter|handle|website|\burl\b/i;
const PLAIN_TEXT_TYPES = new Set(['text', 'search', 'textarea']);
// Whether the panel may type into a box at all (the persona must still give the text): { ok, why }.
export function mayTypeInto({ label = '', name = '', type = 'text', autocomplete = '' } = {}) {
  const t = String(type || 'text').toLowerCase();
  const ac = String(autocomplete || '').trim().toLowerCase();
  if (/^(email|tel|password|url|number)$/.test(t) || PERSONAL_FIELD.test(`${label} ${name}`) || (ac && !/^(on|off)$/.test(ac))) return { ok: false, why: 'looks like personal data, which the test never types' };
  if (!PLAIN_TEXT_TYPES.has(t)) return { ok: false, why: `the test types only into plain text boxes (this one is ${t})` };
  return { ok: true, why: null };
}

// ---------- the interaction policy: every tap, option pick and tick goes through it ----------
// Read in the page from the element about to be activated: its own words (text, value of a submit input, aria-label, title, name,
// id, class), the label tied to it, the class, id and aria-label of up to 5 ancestors, and where a submit sends (formaction or the
// form's action) or a link goes. interactionRefusal then decides in Node. A refusal is terminal: the step stops as a test limit
// and nothing is forced.
export function readInteraction(el) {
  const t = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const own = [el.innerText || el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('name'), el.id, el.getAttribute('class'), el.getAttribute('data-testid')];
  const tag = el.tagName.toLowerCase();
  const type = String(el.getAttribute('type') || '').toLowerCase();
  if (tag === 'input' && /^(submit|button|image|reset)$/.test(type)) own.push(el.value, el.getAttribute('alt'));
  const labels = [];
  try { for (const l of el.labels || []) labels.push(l.innerText || l.textContent); } catch {}
  const lab = el.closest('label'); if (lab) labels.push(lab.innerText || lab.textContent);
  const lb = el.getAttribute('aria-labelledby');
  if (lb) for (const id of lb.split(/\s+/)) { const n = document.getElementById(id); if (n) labels.push(n.textContent); }
  if (tag === 'select') { const o = el.selectedOptions && el.selectedOptions[0]; if (o) labels.push(o.textContent); }
  const anc = [];
  let a = el.parentElement;
  for (let i = 0; a && i < 5; i++, a = a.parentElement) anc.push([a.tagName.toLowerCase(), a.id, a.getAttribute('class'), a.getAttribute('aria-label'), a.getAttribute('data-testid')].filter(Boolean).join(' '));
  const sub = el.closest('button, input');
  let action = '';
  if (sub && sub.form && /^(submit|image|)$/.test(String(sub.type || '').toLowerCase())) action = sub.hasAttribute('formaction') ? sub.formAction : sub.form.action;
  else if (el.form && el.form.action) action = el.form.action;
  const link = el.closest('a[href]');
  return { tag, type, own: own.map(t).filter(Boolean).join(' | '), label: labels.map(t).filter(Boolean).join(' | '), ancestors: anc.map(t).join(' | '), action: action || '', href: link ? link.href : '', formMethod: sub && sub.form ? String(sub.form.method || '').toLowerCase() : '' };
}
// Words that mean checkout, payment, a wallet, buy now, an order or a login, on the element itself or its label.
export const REFUSE_WORDS = /\b(?:check\s*-?\s*out|checkout|buy\s+(?:it\s+)?now|express|shop\s*pay|paypal|pay\s*pal|apple\s*pay|google\s*pay|g\s*pay|gpay|venmo|klarna|afterpay|clearpay|affirm|sezzle|amazon\s*pay|pay\s+with|pay\s+now|pay\s+in\s+\d|place\s+(?:my\s+)?order|complete\s+(?:my\s+)?order|confirm\s+order|submit\s+order|log\s*-?\s*in|sign\s*-?\s*in|sign\s*-?\s*up|register|create\s+(?:an\s+)?account|my\s+account|zur\s+kasse|kasse|caisse|commander|pagar|bezahlen)\b|shopify-payment-button|dynamic-checkout|payment-button|wallet/i;
// Class, id or label words on an ancestor that put the element inside a checkout, wallet or login widget.
export const REFUSE_ANCESTOR = /checkout|shopify-payment-button|payment-button|dynamic-checkout|express|wallet|paypal|apple-?pay|google-?pay|shop-?pay|klarna|afterpay|login|signin|sign-in|customer-account/i;
export function interactionRefusal(info) {
  if (!info || typeof info !== 'object') return 'the panel could not read the element, so it does not touch it';
  const m = REFUSE_WORDS.exec(`${info.own || ''} | ${info.label || ''}`);
  if (m) return `the element says "${m[0].trim()}"`;
  const a = REFUSE_ANCESTOR.exec(info.ancestors || '');
  if (a) return `the element sits inside a ${a[0]} block`;
  for (const [what, u] of [['form sends to', info.action], ['link goes to', info.href]]) {
    if (!u || !/^https?:/i.test(u)) continue;
    const r = checkoutReason({ url: u, method: what === 'form sends to' && info.formMethod === 'post' ? 'POST' : 'GET', isNavigation: true });
    if (r) return `the ${what} ${r.split(':')[0]} (${String(u).slice(0, 100)})`;
  }
  return null;
}

// ---------- fixed typing: the only text the panel ever types ----------
// One public city-centre postcode per country, for the cart's shipping estimator only (a made-up code makes most estimators
// return nothing). Personalisation boxes get "TEST" ("ABC" when the box takes 3 characters or fewer). Discount codes come only from
// the store's own visible pages (see extractStoreCodes). Nothing else can be typed: typeFixed refuses any other string.
// The one promise the docs, the help text and the report all repeat word for word (a test checks every copy).
export const PROMISE = 'It shops like a real customer: browses, picks options, adds to cart, opens the cart, and stops before checkout. It never enters checkout, never pays, never logs in, and only types fake test text, plus discount codes your store shows on its own pages. Like any shopper, the store\'s analytics will see the visit and the add to cart.';
export const TEST_ZIPS = Object.freeze({ US: '10001', CA: 'M5V 2T6', GB: 'SW1A 1AA', AU: '2000' });
export const TEST_TEXT = 'TEST';
export const TEST_TEXT_SHORT = 'ABC';
export function fixedTextFor(maxLength) { const n = Number(maxLength); return Number.isFinite(n) && n > 0 && n <= 3 ? TEST_TEXT_SHORT : TEST_TEXT; }
export function zipFor(country) { return TEST_ZIPS[String(country || '').toUpperCase()] || TEST_ZIPS.US; }
export function isFixedText(value, storeCodes = []) {
  const v = String(value ?? '');
  return v === TEST_TEXT || v === TEST_TEXT_SHORT || Object.values(TEST_ZIPS).includes(v) || (storeCodes || []).includes(v);
}
// The single place the runner types. loc is a Playwright locator; codes = the store codes accepted for this journey.
export async function typeFixed(loc, value, { codes = [], timeout = 5000 } = {}) {
  if (!isFixedText(value, codes)) throw new Error('typeFixed refused a value that is not one of the fixed test values');
  await loc.fill(value, { timeout });
  return value;
}

// ---------- discount codes the store shows on its own pages ----------
// Only an explicit "code X" or "use code X" (also "promo code: X", "coupon code X", "Code: X"). The code is the WHOLE token after
// it (everything up to the next white space), with one opening quote and, at its end, one closing quote, bracket or sentence mark
// removed. That whole token must then be 4 to 20 plain letters and digits, with a letter and a digit, or all uppercase; never next to
// an @, never a run of 7 or more digits. A token that fails (SAVE10-VIP, SAVE10.5, CANDLE10%, a letter with an accent) is never cut
// down to a shorter code; it is dropped. At most 3 per journey.
export function extractStoreCodes(text, max = 3) {
  const out = [];
  // "code" must be a whole word (never the start of CODE2026ABC or CODEGREEN), and the scan goes on AFTER the token it read, so a
  // suffix of a code already read is never read again as a code of its own
  const re = /\b(?:use\s+)?(?:(?:promo|discount|coupon|voucher|offer)\s+)?code(?![A-Za-z0-9_])\s*[:=]?\s*/gi;
  const s = String(text || '').slice(0, MAX_SCAN_CHARS);
  for (let m; (m = re.exec(s)) && out.length < max;) {
    if (!m[0].length) { re.lastIndex++; continue; }
    const at = m.index + m[0].length;
    const raw = /^\S{1,80}/.exec(s.slice(at));
    if (!raw) continue;
    re.lastIndex = at + raw[0].length;
    const c = raw[0].replace(/^["'\u201c\u2018]/, '').replace(/["'\u201d\u2019]?\)?[.,;:!?]?["'\u201d\u2019]?$/, '');
    if (!/^[A-Za-z0-9]{4,20}$/.test(c)) continue;
    const before = s.slice(Math.max(0, m.index - 1), m.index);
    // a postcode, tracking, security or order code is not a discount code
    if (!/^(?:use|promo|discount|coupon|voucher|offer)/i.test(m[0]) && /\b(?:zip|postal|post|area|country|tracking|security|verification|access|confirmation|order|reference|product|style|sort|source|qr|bar|gift\s+card)[\s-]*$/i.test(s.slice(Math.max(0, m.index - 24), m.index))) continue;
    if (/@/.test(before) || /\d{7,}/.test(c)) continue;
    const hasL = /[A-Za-z]/.test(c), hasD = /\d/.test(c);
    if (!((hasL && hasD) || (hasL && c === c.toUpperCase()))) continue;
    if (/^(CODE|CODES|BELOW|ABOVE|HERE)$/i.test(c)) continue;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

// ---------- cart checks: free-shipping bar, totals, estimator ----------
// texts: visible text of the cart page. subtotal: number or null. Returns null when no free-shipping message is shown, else
// { threshold, remaining, subtotal, status: 'ok' | 'mismatch' | 'unreadable', why }.
export function freeShippingCheck(texts, subtotal) {
  const s = (Array.isArray(texts) ? texts.join('\n') : String(texts || '')).slice(0, MAX_SCAN_CHARS);
  if (!/free\s+(?:standard\s+)?(?:shipping|delivery)|kostenlose[nr]?\s+versand|livraison\s+gratuite/i.test(s)) return null;
  const moneyAt = (str) => { const m = parseMoney(str); return m ? m.value : null; };
  let remaining = null, threshold = null;
  const lastMoney = (str) => { let v = null; const re = new RegExp(MONEY_RE.source, 'gi'); for (let m; (m = re.exec(str));) v = moneyValue(m[1] ?? m[2]); return v; };
  const away = /\b(?:away\s+from|more\s+(?:to|for|and)|left\s+(?:to|for|until)|to\s+go|until\s+(?:you\s+get\s+)?free|bis\s+zum|fehlen)\b/i.exec(s);
  if (away) remaining = lastMoney(s.slice(Math.max(0, away.index - 40), away.index));
  if (remaining === null) { const sp = /(?:spend|add)\s+(?:only\s+|just\s+|another\s+)?([^\n]{0,20}?)\s+more/i.exec(s); if (sp) remaining = moneyAt(sp[1]); }
  const over = /(?:free\s+(?:standard\s+)?(?:shipping|delivery)|kostenlose[nr]?\s+versand|livraison\s+gratuite)[^\n]{0,30}?(?:over|above|on\s+orders?\s+(?:over|of|above)|from|ab|d\u00e8s)\s+([^\n]{0,20})/i.exec(s)
    || /(?:orders?\s+(?:over|above)|spend)\s+([^\n]{0,20}?)\s+(?:get|for|ship|and)[^\n]{0,20}free/i.exec(s);
  if (over) threshold = moneyAt(over[1]);
  const unlocked = /(?:you(?:'ve| have)?\s+(?:got|unlocked|earned|qualif(?:y|ied)\s+for)|qualifies\s+for)\s+free/i.test(s);
  const sub = Number.isFinite(subtotal) ? subtotal : null;
  if (threshold === null || sub === null) return { threshold, remaining, subtotal: sub, status: 'unreadable', why: threshold === null ? 'the free-shipping threshold could not be read' : 'the cart subtotal could not be read' };
  const expected = Math.max(0, Math.round((threshold - sub) * 100) / 100);
  if (expected === 0) return { threshold, remaining, subtotal: sub, status: unlocked || remaining === null || remaining === 0 ? 'ok' : 'mismatch', why: unlocked || remaining === null || remaining === 0 ? null : `the cart is over ${threshold} but the bar still says ${remaining} to go` };
  if (remaining === null) return { threshold, remaining, subtotal: sub, status: unlocked ? 'mismatch' : 'unreadable', why: unlocked ? `the bar says free shipping is unlocked but the cart is ${expected} short` : 'the amount left to free shipping could not be read' };
  const ok = Math.abs(remaining - expected) <= 0.011;
  return { threshold, remaining, subtotal: sub, status: ok ? 'ok' : 'mismatch', why: ok ? null : `the bar says ${remaining} to go, but ${threshold} minus the ${sub} subtotal is ${expected}` };
}
// The persona's shipping limit: shipping_quit_over (a money amount) or 20 percent of the subtotal.
// The store's own shipping rates answer: Shopify /cart/async_shipping_rates.json or /cart/shipping_rates.json (optionally behind a
// locale), on the store's own host.
export function isShippingRatesUrl(url, ownHosts) {
  try { const x = new URL(url); return isOwnHost(x.hostname.toLowerCase(), ownHosts) && /^\/cart\/(?:async_)?shipping_rates\.json$/.test(stripRealLocale(x.pathname)); } catch { return false; }
}
// The shipping options in a rates answer ({ shipping_rates: [{ name, price }] }, price as "4.80"), as [{ name, price }], or null when the
// answer is not a readable rates list. Promotions and page text are never read here.
export function shippingRatesFrom(obj) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.shipping_rates)) return null;
  const out = [];
  for (const r of obj.shipping_rates.slice(0, 50)) {
    if (!r || typeof r !== 'object') return null;
    const raw = typeof r.price === 'number' ? String(r.price) : typeof r.price === 'string' ? r.price.trim() : null;
    if (raw === null || !/^\d{1,7}(?:\.\d{1,2})?$/.test(raw)) return null;
    out.push({ name: oneLine(r.name || r.presentment_name || r.code || 'shipping', 60), price: Number(raw) });
  }
  return out;
}
export function shippingQuitOver(persona, subtotal) {
  const raw = persona ? persona.shipping_quit_over : null;
  const v = typeof raw === 'number' ? raw : NaN; // null or a missing value means the default (Number(null) would be 0, a $0 limit)
  if (Number.isFinite(v) && v >= 0) return v;
  return Number.isFinite(subtotal) ? Math.round(subtotal * 20) / 100 : null;
}
// Page-side: the cart's subtotal and total from the visible page (rows labelled subtotal or total). Returns numbers or null.
export function readCartTotalsInPage() {
  const out = { subtotal: null, total: null, subtotalText: null, totalText: null };
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const nodes = document.querySelectorAll('tr, li, div, p, dl, span, td, th');
  for (const n of nodes) {
    if (n.children.length > 6 || !vis(n)) continue;
    const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 80) continue;
    const m = /^(sub-?total|zwischensumme|sous-total|estimated total|total|gesamtsumme|summe)\b[:\s]*(.*\d.*)$/i.exec(t);
    if (!m) continue;
    const key = /sub|zwischen|sous/i.test(m[1]) ? 'subtotal' : 'total';
    if (out[`${key}Text`] === null) out[`${key}Text`] = m[2];
  }
  return out;
}
export function cartTotalsFrom(raw) {
  const v = (s) => { const m = parseMoney(s || ''); return m ? m.value : null; };
  const subtotal = v(raw && raw.subtotalText), total = v(raw && raw.totalText);
  return { subtotal: subtotal ?? total, total: total ?? subtotal };
}
// Page-side: finds the cart's shipping estimator and its discount code box and marks them with data-sp-* attributes the runner then
// uses as locators. Nothing is typed or tapped here.
export function markCartWidgetsInPage() {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const words = (el) => [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), ...(el.labels ? [...el.labels].map((l) => l.textContent) : [])].join(' ');
  const found = { estimator: false, country: false, coupon: false };
  const buttonIn = (root) => [...root.querySelectorAll('button, input[type=submit], input[type=button]')].find((b) => vis(b) && /estimate|calculate|get\s+rates|update|apply|redeem|berechnen|anwenden|appliquer|calculer|einl/i.test(`${b.innerText || ''} ${b.value || ''} ${b.getAttribute('aria-label') || ''}`));
  for (const inp of document.querySelectorAll('input')) {
    if (!vis(inp) || !/^(text|search|)$/i.test(inp.type || '')) continue;
    const w = words(inp);
    const root = inp.closest('form, section, [class*="shipping" i], [class*="estimat" i], [class*="calculat" i], [class*="coupon" i], [class*="discount" i]') || inp.parentElement;
    if (!found.estimator && /zip|postal|post.?code|postcode|plz/i.test(w) && root && /estimat|calculat|shipping\s+rates|versand|livraison/i.test(root.textContent || '')) {
      const b = buttonIn(root);
      if (b) {
        inp.setAttribute('data-sp-est', 'zip'); b.setAttribute('data-sp-est', 'button'); found.estimator = true;
        const c = root.querySelector('select[name*="country" i], select[id*="country" i]');
        if (c && vis(c)) { c.setAttribute('data-sp-est', 'country'); found.country = true; }
      }
    }
    if (!found.coupon && /coupon|discount|promo|voucher|gutschein|rabatt|code\s+promo/i.test(w) && !/gift\s*card|giftcard/i.test(w)) {
      const b = root && buttonIn(root);
      if (b) { inp.setAttribute('data-sp-coupon', 'input'); b.setAttribute('data-sp-coupon', 'button'); found.coupon = true; }
    }
  }
  return found;
}
// Page-side: the visible Checkout control in the cart, found and described, never tapped.
export function findCheckoutInPage() {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
  const say = (el) => String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  const cands = [...document.querySelectorAll('a[href], button, input[type=submit], input[type=button]')].filter((el) => {
    const t = `${say(el)} ${el.getAttribute('name') || ''}`;
    // the same checkout words as CHECKOUT_LABEL (written out again: this runs in the page)
    return /\b(?:check\s*-?\s*out|kasse|caisse|pagar|afrekenen|commander|finalizar|paiement|(?:proceed|continue)\s+to\s+(?:checkout|payment))\b/i.test(t);
  });
  const seen = cands.filter(vis);
  if (!seen.length) return { present: cands.length > 0, visible: false, enabled: false, label: cands[0] ? say(cands[0]).slice(0, 80) : null, target: null };
  const el = seen[0];
  const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || /\bdisabled\b/.test(el.className || '');
  let target = null;
  if (el.tagName === 'A') target = el.href;
  else if (el.form) target = el.hasAttribute('formaction') ? el.formAction : el.form.action;
  return { present: true, visible: true, enabled: !disabled, label: say(el).slice(0, 80), target };
}

// ---------- exit code ----------
// 0 = the run completed (personas quitting is a result, not a failure). 1 = a journey hit an error (a page that would not load, a
// button that would not respond, a step that timed out), a test error, a bot check, or a checkout breach. 2 = bad setup.
// test_limit = the panel itself could not read the page (its own selectors missed, or a step it never does such as an upload): not a
// shopper quit, so the run is INCOMPLETE.
export const ERROR_KINDS = ['error', 'test_error', 'rate_limited', 'test_limit'];
// A run is INCOMPLETE too when it was stopped (Ctrl-C) or ran fewer journeys than planned. A touched test cart is left as it is.
function incompleteRun({ journeys, planned, stopped }) {
  if (stopped) return true;
  if (typeof planned === 'number' && journeys.length < planned) return true;
  if (journeys.some((j) => ERROR_KINDS.includes(j.quit_kind))) return true;
  return false;
}
export function exitCodeFor({ runError, journeys, planned, stopped }) {
  if (runError || !journeys.length) return 1;
  if (journeys.some((j) => j.checkout_page_loaded)) return 1;
  if (incompleteRun({ journeys, planned, stopped })) return 1;
  return 0;
}
export function runStatusFor({ runError, journeys, planned, stopped }) {
  if (runError || !journeys.length) return 'broken';
  if (journeys.some((j) => j.checkout_page_loaded)) return 'safety failure';
  if (incompleteRun({ journeys, planned, stopped })) return 'incomplete';
  return 'completed';
}
// A journey was stopped or timed out: from now on the guard aborts every request and socket of that context, and every request still
// waiting in the guard is aborted now, so the context's close cannot leave one for the browser to send on its own.
// A request the guard is already fetching from the store (route.fetch) is given up to waitSentMs to get the store's answer, so the
// report can tell whether the store answered a cart write; one still waiting after that is aborted, so the close cannot resend it.
export async function haltGuard(state, { waitSentMs = 0 } = {}) {
  if (!state) return;
  state.halt = true;
  const sent = (r) => !!(state.sentOn && state.sentOn.has(r.request()));
  // only a route this abort really stopped is marked as never sent
  for (const r of [...(state.pending || [])]) if (!sent(r)) await r.abort('blockedbyclient').then(() => { haltedSet(state).add(r.request()); }, () => {});
  for (const end = Date.now() + waitSentMs; Date.now() < end && [...(state.pending || [])].length;) await new Promise((x) => setTimeout(x, 100));
  for (const r of [...(state.pending || [])]) await r.abort('blockedbyclient').catch(() => {});
}
function answeredSet(state) { return state.storeAnswered || (Object.defineProperty(state, 'storeAnswered', { value: new WeakSet(), enumerable: false }), state.storeAnswered); }
// the store answered this request (the guard fetched it with route.fetch and got a response)
export function storeAnswered(state, req) { return !!(state && state.storeAnswered && state.storeAnswered.has(req)); }
// the requests the halted guard aborted before they were sent (they never reached the store)
// (a request the guard already passed on, with route.fetch from Node or route.continue, may have reached the store even if a later
// abort of its route succeeds)
function haltedSet(state) { return state.halted || (Object.defineProperty(state, 'halted', { value: new WeakSet(), enumerable: false }), state.halted); }
function sentSet(state) { if (!state) return new WeakSet(); return state.sentOn || (Object.defineProperty(state, 'sentOn', { value: new WeakSet(), enumerable: false }), state.sentOn); }
export function haltedBeforeSending(state, req) { return !!(state && state.halted && state.halted.has(req) && !(state.sentOn && state.sentOn.has(req))); }
// One message for a store that did not answer, whatever the engine.
const DNS_ERR = /ERR_NAME_NOT_RESOLVED|could not be found|server with the specified hostname|Could not resolve host|getaddrinfo/i;
const REFUSED_ERR = /ERR_CONNECTION_REFUSED|Connection refused|Could not connect|Couldn't connect|Failed to connect/i;
export function unreachableMessage(origin, kind, seconds) {
  const tail = ' Check the address, or that the store (or "npm run fixture") is running, then run again.';
  if (kind === 'dns') return `The address ${origin} does not exist (the name did not resolve).${tail}`;
  if (kind === 'refused') return `The store refused the connection at ${origin} (nothing is listening there).${tail}`;
  return `The store did not answer at ${origin} in ${seconds} s.${tail}`;
}
// 'dns', 'refused' or 'timeout', from the TCP probe first (it names a refused port or an unknown name the same way on every engine),
// then from the browser's error text (Chromium net:: codes, WebKit wording).
export function unreachableKind(msg, probe) {
  if (probe === 'dns' || probe === 'refused') return probe;
  if (DNS_ERR.test(String(msg))) return 'dns';
  if (REFUSED_ERR.test(String(msg))) return 'refused';
  return 'timeout';
}
