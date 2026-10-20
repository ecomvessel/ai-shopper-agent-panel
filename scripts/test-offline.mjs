// Offline test: never touches the internet. Everything runs against the made-up fixture store on 127.0.0.1.
//   npm test
// Part 1: pure helpers. Part 2: the network guard (Chromium). Part 3: the whole runner end to end (Chromium, iPhone and Pixel sizes).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import nodeHttp from 'node:http';
import fsRaw from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as lib from './panel-lib.mjs';
import { checkPersona, checkPanel } from './persona-schema.mjs';
import { startFixtureServer, STORE_DIR } from './fixture-server.mjs';
// Text files are read with Windows line endings (CRLF) turned into plain newlines, so every check that parses a doc or a
// report works the same on a Windows checkout.
const fs = { ...fsRaw, readFileSync: (p, enc) => { const r = fsRaw.readFileSync(p, enc); return typeof r === 'string' ? r.replace(/\r\n/g, '\n') : r; } };

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; let fail = 0;
const ok = (cond, what, extra = '') => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? `: ${extra}` : ''}`); } };
const section = (s) => console.log(`\n${s}`);
console.log('Offline tests: the unit checks, then real browsers against the practice store on this computer. The whole run takes about 11 to 13 minutes, longer on a busy machine. If a check fails with Timeout on a busy machine, run it again.');
// a progress line at least every 60 s, so a long browser run never looks stuck
const t0 = Date.now();
setInterval(() => console.log(`  ... still running: ${Math.round((Date.now() - t0) / 60000)} min, ${pass + fail} checks so far`), 60000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Part 1: helpers ----------
section('Part 1: helpers');
const cr = (url, o = {}) => lib.checkoutReason({ url, ...o });
ok(cr('https://s.example/checkouts/cn/abc'), 'Shopify checkouts path is stopped');
ok(cr('https://s.example/12345/checkouts/abc'), 'Shopify shop-id checkouts path is stopped');
ok(cr('https://s.example/checkout/'), 'WooCommerce /checkout/ is stopped');
ok(cr('https://s.example/fr/checkout/order-pay/12/'), 'WooCommerce order-pay with a locale is stopped');
ok(cr('https://s.example/?wc-ajax=checkout'), 'WooCommerce ?wc-ajax=checkout is stopped');
ok(cr('https://s.example/cart/c/abc'), 'Shopify cart/c link is stopped');
ok(cr('https://s.example/cart/101:1'), 'cart permalink is stopped');
ok(cr('https://checkout.stripe.com/pay/x'), 'Stripe checkout host is stopped');
ok(cr('https://s.example/cart', { method: 'POST', isNavigation: true, formBody: 'updates%5B%5D=1&checkout=' }), 'cart form POST with checkout is stopped');
ok(cr('https://s.example/products/x', { redirectedFrom: ['https://s.example/checkout'] }), 'a redirect chain through checkout is stopped');
ok(!cr('https://s.example/cart'), 'the cart page itself is allowed');
ok(!cr('https://s.example/products/checkout-guide-candle'), 'a product named "checkout..." is allowed');
ok(!cr('https://s.example/?wc-ajax=get_refreshed_fragments'), 'other wc-ajax calls are allowed');
ok(cr('https://s.example/?rest_route=/wc/store/v1/checkout'), 'WooCommerce Store API checkout via ?rest_route= is stopped');
ok(cr('https://s.example/wp-json/wc/store/v1/checkout'), 'WooCommerce Store API checkout path is stopped');
ok(cr('https://s.example/checkout.php') && cr('https://s.example/finishorder.php') && cr('https://s.example/embedded-checkout/abc'), 'checkout.php, finishorder.php and embedded-checkout are stopped');
ok(!cr('https://s.example/wp-json/wc/store/v1/cart') && !cr('https://s.example/?rest_route=/wc/store/v1/cart'), 'the Store API cart itself is allowed');
ok(lib.isCartPageUrl('https://s.example/warenkorb/') && lib.isCartPageUrl('https://s.example/fr/panier/') && lib.isCartPageUrl('https://s.example/carrito'), 'cart pages in other languages are recognised');
const own1 = new Set(['s.example']);
const after = (u) => lib.allowedAfterCartTouched(u, own1, new Set(['/pages/gift-guide']), { cartFrom: 'https://s.example/products/x' });
ok(after('https://s.example/warenkorb/') && after('https://s.example/products/x') && after('https://s.example/') && after('https://s.example/pages/gift-guide'), 'after the cart is touched: the cart, the product page the add came from, home and the landing page are allowed');
ok(!after('https://s.example/kasse/') && !after('https://s.example/account') && !after('https://s.example/collections/gifts') && !after('https://other.example/products/x'), 'after the cart is touched: every other page and every other host is refused');
const fx = (f) => fs.readFileSync(path.join(STORE_DIR, f), 'utf8');
ok(lib.checkoutContentReason(fx('woo-checkout-kasse.html')), 'a checkout on the /kasse/ slug is recognised by its content', String(lib.checkoutContentReason(fx('woo-checkout-kasse.html'))));
ok(lib.checkoutContentReason('<body class="x"><div data-block-name="woocommerce/checkout"></div>') === 'WooCommerce checkout block', 'the WooCommerce checkout block is recognised');
ok(lib.checkoutContentReason('<script>Shopify.Checkout.step = "contact_information";</script>') === 'Shopify.Checkout', 'a Shopify checkout page is recognised by Shopify.Checkout');
ok(['woo-cart.html', 'woo-cart-block.html', 'woo-product-amber-soy-candle.html', 'woo-product-beeswax-taper.html', 'shopify-cart.html', 'shopify-product-dawn-tote.html', 'shopify-product-linen-and-cedar-candle.html'].every((f) => lib.checkoutContentReason(fx(f)) === null), 'cart and product pages are not mistaken for a checkout');

ok(lib.ownershipMatch('www.shop.example', 'shop.example').ok, 'ownership: www variant');
ok(lib.ownershipMatch('shop.example', 'https://www.shop.example/').ok, 'ownership: owner given as a URL');
ok(!lib.ownershipMatch('northwick.myshopify.com', 'northwick.example').ok, 'ownership: a custom-domain owner for a myshopify URL is refused');
ok(!lib.ownershipMatch('amazon.com', 'amazon.myshopify.com').ok && lib.ownershipMatch('amazon.com', 'amazon.myshopify.com').needsShopifyConfirm === 'amazon.myshopify.com', 'ownership: amazon.myshopify.com does NOT own amazon.com without the store confirming it');
ok(!lib.ownershipMatch('shop.example', 'shop.example.myshopify.com').ok, 'ownership: no first-label matching');
ok(lib.myshopifyDomainFrom({ metaJson: '{"myshopify_domain":"northwick-candles.myshopify.com"}' }) === 'northwick-candles.myshopify.com', 'ownership: myshopify address read from /meta.json');
ok(lib.myshopifyDomainFrom({ html: '<script>Shopify.shop = "northwick-candles.myshopify.com";</script>' }) === 'northwick-candles.myshopify.com', 'ownership: myshopify address read from Shopify.shop');
ok(lib.myshopifyDomainFrom({ metaJson: 'not json', html: '<p>no shop here</p>' }) === null, 'ownership: no address when the store does not say');
ok(!lib.ownershipMatch('other.example', 'shop.example').ok, 'ownership: a different site is refused');
ok(!lib.ownershipMatch('shop.example.evil.example', 'shop.example').ok, 'ownership: a look-alike host is refused');

const money = [['$28.00', 28], ['25,00 €', 25], ['USD 25', 25], ['99 kr', 99], ['¥1,200', 1200], ['₹ 1,299', 1299], ['£12', 12], ['CHF 25.50', 25.5], ['1.234,56 €', 1234.56], ['From $1,049.99', 1049.99],
  ['Rs. 1,299', 1299], ['Rs 499', 499], ['R 250', 250], ['R$ 99,90', 99.9], ['₱1,250.00', 1250], ['฿350', 350], ['₫ 250.000', 250000], ['250.000₫', 250000], ['RM 45.90', 45.9], ['1 299 Kč', 1299], ['Rp 150.000', 150000]];
for (const [t, v] of money) ok(lib.parseMoney(t)?.value === v, `parseMoney ${t}`, JSON.stringify(lib.parseMoney(t)));
ok(lib.parseMoney('Burns for 40 hours') === null, 'parseMoney ignores plain numbers');
ok(lib.parseMoney('Pack of 4 for 5 days') === null, 'parseMoney does not read a bare R or Rs inside words');
const odd = lib.resolvePrice([{ text: '28 dollars', top: 300, bottom: 320, inRoot: true, priceLike: true }], { value: 28, source: 'ld+json offers.price' });
ok(odd.price && odd.price.unrecognised_format && odd.label === 'price shown in an unrecognised format', 'a price the panel cannot parse but the page data confirms is labelled an unrecognised format, not missing', JSON.stringify(odd));
ok(lib.resolvePrice([{ text: 'Burns 40 hours', top: 300, bottom: 320, inRoot: true }], { value: 28, source: 'x' }).label === 'no visible price', 'with no matching digits on the page it is still no visible price');

const ldWoo = lib.ldProductInfo([JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite' }, { '@type': 'Product', name: 'x', offers: [{ '@type': 'Offer', price: '24.00', priceCurrency: 'EUR' }] }] })]);
ok(ldWoo.isMain && ldWoo.price === 24 && ldWoo.currency === 'EUR', 'ld+json @graph Product is the main entity with its price');
const ldList = lib.ldProductInfo([JSON.stringify({ '@type': 'ItemList', itemListElement: [] }), JSON.stringify({ '@type': 'Product', offers: { price: 5 } })]);
ok(!ldList.isMain, 'ld+json on a listing page is not a main Product');
ok(!lib.decideProductPage({ url: 'https://s.example/collections/gifts', addForms: 3 }).isProduct, 'a collection with quick-add buttons is not a product page');
ok(lib.decideProductPage({ url: 'https://s.example/collections/gifts', addForms: 1 }).isProduct, 'exactly one add form is a product page');
ok(lib.decideProductPage({ url: 'https://s.example/product/amber' }).isProduct, 'a /product/ URL is a product page');

ok(lib.mdSafe('a|b`c<d>') === 'a\\|b\\`c&lt;d&gt;', 'mdSafe escapes pipes, backticks and tags', lib.mdSafe('a|b`c<d>'));
const planted = lib.mdQuote('Great! [Claim your refund](https://phish.example/login) ![](https://track.example/p.gif) **now** _x_ # Heading');
ok(!/(?<!\\)[[\]*]/.test(planted) && !/(?<![\\A-Za-z0-9])_/.test(planted) && !/(?<!\\)\]\(/.test(planted), 'mdSafe escapes markdown links, images and emphasis planted in page text', planted);
// R9: only what Markdown would act on is escaped, so the report reads cleanly as plain text too
ok(lib.mdSafe('(the checkout page itself is never loaded) snake_case 50% off! #1 seller') === '(the checkout page itself is never loaded) snake_case 50% off! #1 seller' && lib.mdSafe('# Heading') === '\\# Heading' && lib.mdSafe('_x_') === '\\_x\\_' && lib.mdSafe('product__info') === 'product__info', 'mdSafe leaves brackets, intraword underscores, ! and a # inside text alone; a leading # and edge underscores are escaped', lib.mdSafe('(the checkout page itself is never loaded) snake_case 50% off! #1 seller'));
ok(lib.mdQuote('say "hi"') === '"say \'hi\'"', 'mdQuote wraps page text in quotes');
ok(lib.slug('../../etc/passwd') === 'etc-passwd', 'slug removes path characters');
ok(lib.slug('Ünïcode / Name!!') === 'n-code-name', 'slug keeps only safe characters', lib.slug('Ünïcode / Name!!'));

ok(lib.wordBounded('soy') === '\\b(?:soy)\\b', 'wordBounded adds word edges');
ok(new RegExp(lib.wordBounded('\\$\\s?\\d'), 'i').test('Only $55.00 today'), 'trailing escape fix: \\d at the end gets no boundary');
ok(!new RegExp(lib.wordBounded('soy'), 'i').test('soybean'), 'word-bounded scan does not match inside a longer word');
ok(lib.safeRegex('(unclosed').err, 'safeRegex reports a broken pattern');
ok(lib.safeRegex('a'.repeat(201)).err, 'safeRegex refuses an over-long pattern');
ok(lib.detectChallenge({ status: 403, headers: { 'cf-mitigated': 'challenge' } }), 'bot check: challenge header');
ok(lib.detectChallenge({ status: 503, title: 'Just a moment...' }), 'bot check: challenge title');
ok(!lib.detectChallenge({ status: 200, title: 'Linen and Cedar Candle' }), 'bot check: a normal page is not a challenge');
ok(lib.wireBytes({ 'content-encoding': 'gzip', 'content-length': '1234' }, Buffer.alloc(9000)) === 1234, 'wireBytes uses content-length when compressed');
ok(lib.wireBytes({ 'content-type': 'text/html' }, Buffer.from('a'.repeat(10000))) < 1000, 'wireBytes estimates gzip size for text');
ok(lib.exitCodeFor({ journeys: [{ quit_kind: 'required_info_missing' }] }) === 0, 'exit code 0 when a persona quits');
ok(lib.exitCodeFor({ journeys: [{ quit_kind: 'rate_limited' }] }) === 1, 'exit code 1 on a bot check');
ok(lib.exitCodeFor({ journeys: [{ checkout_page_loaded: true }] }) === 1, 'exit code 1 on a checkout breach');
ok(lib.exitCodeFor({ journeys: [{ quit_kind: 'required_info_missing' }, { quit_kind: 'error' }] }) === 1 && lib.runStatusFor({ journeys: [{ quit_kind: 'error' }] }) === 'incomplete', 'exit code 1 and status incomplete when a journey hits an error');
ok(lib.runStatusFor({ journeys: [{ quit_kind: 'sold_out' }] }) === 'completed' && lib.runStatusFor({ journeys: [{ checkout_page_loaded: true }] }) === 'safety failure', 'run status words');
// round 3 items
ok(lib.exitCodeFor({ journeys: [{ quit_kind: 'test_limit' }] }) === 1 && lib.runStatusFor({ journeys: [{ quit_kind: 'test_limit' }] }) === 'incomplete', 'a tool limit (test_limit) makes the run INCOMPLETE with exit 1, never a shopper result');
const ca = lib.chromiumArgs({ loopback: true });
ok(ca.filter((a) => a.startsWith('--disable-features=')).length === 1 && /SpeculationRules/.test(ca[0]) && /Prerender2/.test(ca[0]) && /NoStatePrefetch/.test(ca[0]) && /LocalNetworkAccessChecks/.test(ca[0]), 'Chromium gets ONE merged --disable-features flag with the speculation features', JSON.stringify(ca));
ok(lib.chromiumArgs({ loopback: false }).length === 1 && !/LocalNetwork/.test(lib.chromiumArgs({ loopback: false })[0]), 'without loopback the speculation features are still turned off');
const specHtml = '<head><script type="speculationrules">{"prerender":[{"source":"document"}]}</script><script type=\'SpeculationRules\'>{}</script><link rel="prerender" href="/checkout/"><link rel=prefetch href="/checkouts/x"><script>var ok=1</script></head>';
const specClean = lib.stripSpeculation(specHtml);
ok(!/speculationrules|prerender|prefetch/i.test(specClean) && /var ok=1/.test(specClean), 'speculation-rules scripts and prerender/prefetch links are stripped, other scripts kept', specClean);
ok(lib.isCartActionRequest('https://s.example/product/x/?buy-now=1', 'GET') && lib.isCartActionRequest('https://s.example/cart/add', 'GET') && lib.isCartActionRequest('https://s.example/p', 'POST') && !lib.isCartActionRequest('https://s.example/collections/all', 'GET'), 'cart actions are recognised (buy-now, /cart/add, any POST); a plain page is not');
ok(lib.mdSafe('see https://evil.example/x') === 'see https:\\/\\/evil.example/x' && lib.mdSafe('WWW.evil.example') === 'WWW\\.evil.example' && !/[^\\]@/.test(lib.mdSafe('mail a@b.co')), 'mdSafe neutralises bare URLs, www. autolinks and e-mail autolinks', `${lib.mdSafe('see https://evil.example/x')} ${lib.mdSafe('WWW.evil.example')} ${lib.mdSafe('mail a@b.co')}`);
ok(lib.termSafe('a\u001b[2Jb\u202ec\u0007d') === 'a[2Jbcd' && lib.oneLine('x\u001b]0;title\u0007y', 50) === 'x]0;titley', 'control, escape and bidi characters are stripped before page text reaches the terminal', JSON.stringify(lib.termSafe('a\u001b[2Jb\u202ec\u0007d')));
const ownL = new Set(['s.example']);
{ const aL = (u) => lib.allowedAfterCartTouched(u, ownL, new Set(), { cartFrom: 'https://s.example/products/x' });
  ok(aL('https://s.example/zh-hant/cart') && aL('https://s.example/pt-br/cart') && !aL('https://s.example/zh-hant/checkouts/cn/1') && lib.isCartPageUrl('https://s.example/zh-hant/cart'), 'two-part locale prefixes (/zh-hant/cart, /pt-br/cart) are allowed after the cart is touched; a localised checkout is not'); }
const sk = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
ok(/git check-ignore personas\/x\.json/.test(sk) && /file-edit tool/.test(sk) && !/printf 'personas\/\\nreports\/\\n' >> \.gitignore/.test(sk) && /tail -c1/.test(sk) && /Add-Content/.test(sk) && /EndsWith/.test(sk), 'SKILL Step 3 edits .gitignore one entry per line, guards the missing final newline in bash and PowerShell, and checks with git check-ignore');

const example = JSON.parse(fs.readFileSync(path.join(root, 'examples/personas/northwick-slow-4g-sam.json'), 'utf8'));
ok(checkPersona(example).length === 0, 'example persona is valid', checkPersona(example).join('; '));
{ const exLand = fs.readdirSync(path.join(root, 'examples/personas')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(root, 'examples/personas', f), 'utf8')).entry_point.landing_path); ok(exLand.length === 3 && exLand.every((l) => /^\/(products|collections)\/[a-z0-9-]+$/.test(l)), 'every example persona lands on a Shopify product or collection page (v1 is Shopify only)', exLand.join(', ')); }
ok(checkPersona({ ...example, choices: [{ option: 'size', pick: '([' }] }).some((e) => /choices\[0\]\.pick/.test(e)), 'a broken choices pattern is rejected');
ok(checkPersona({ ...example, id: '../evil' }).some((e) => /"id"/.test(e)), 'an unsafe persona id is rejected');
ok(checkPersona({ ...example, name: 'x'.repeat(500) }).some((e) => /longer/.test(e)), 'over-long text is rejected');
ok(checkPersona({ ...example, entry_point: { channel: 'ad', landing_path: '//evil.example/' } }).length > 0, 'a protocol-relative landing path is rejected');
const dupWarn = checkPanel([example, { ...example, id: 'other' }]);
ok(dupWarn.some((w) => /share the main quit reason/.test(w)), 'shared main quit reasons are a warning');

// ---------- R25: Shopify Online Store only, and a strict write allow-list (unit) ----------
{
  const own = new Set(['shop.example']);
  const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
  const JSONH = { 'content-type': 'application/json' };
  const WA = (url, body = 'id=1&quantity=1', headers = FORM, method = 'POST') => lib.writeAllowReason({ url, method, body, headers, ownHosts: own });
  const S = 'https://shop.example';
  // the allowed cart operations
  const okW = [[`${S}/cart/add.js`], [`${S}/cart/add`], [`${S}/cart/change.js`, 'line=1&quantity=0'], [`${S}/cart/update.js`, '{"discount":"CANDLE10"}', JSONH], [`${S}/fr/cart/add.js`], [`${S}/en-gb/cart/update.js`, '{"discount":"X1"}', JSONH], [`${S}/cart/prepare_shipping_rates.json`, 'shipping_address%5Bzip%5D=10001&shipping_address%5Bcountry%5D=US']];
  const okBad = okW.filter((a) => WA(...a) !== null).map((a) => `${a[0]}: ${WA(...a)}`);
  ok(!okBad.length, 'write allow-list: own-host /cart/add, /cart/change, /cart/update (with or without .js, with a real lower-case locale) and /cart/prepare_shipping_rates.json are sent', JSON.stringify(okBad));
  ok(WA(`${S}/cart/add.js`, 'id=1', FORM, 'GET') === null && WA(`${S}/anything`, '', {}, 'HEAD') === null, 'write allow-list: a GET or HEAD is not a write');
  // the raw path: no %, //, dot segment, backslash, ; or :, and exactly a listed operation
  const badPaths = ['/cart/%61dd.js', '/cart%2Fadd.js', '//cart/add.js', '/cart//add.js', '/cart/./add.js', '/x/../cart/add.js', '/cart/add.js;x', '/cart/add.js:x', '/cart/add.js/', '/cart/clear.js', '/cart', '/cart/add.json', '/EN/cart/add.js', '/qq/cart/add.js', '/fr/fr/cart/add.js', '/apps/proxy/cart/add.js'];
  const passedBad = badPaths.filter((p) => WA(`${S}${p}`) === null);
  ok(!passedBad.length && !lib.writePathAllowed('/cart\\add.js') && !lib.writePathAllowed('/fr\\cart/add.js') && lib.rawPathOf(`${S}/cart/./add.js?x=1`) === '/cart/./add.js', 'write allow-list: an encoded path, a double slash, a dot segment, a backslash, ; or :, a bad or upper-case locale, and any other path are never written to (the raw path is read as sent)', JSON.stringify(passedBad));
  // GraphQL, /api and other hosts
  const otherW = [WA(`${S}/api/2024-01/graphql.json`, '{"query":"mutation{cartLinesAdd}"}', JSONH), WA(`${S}/api/unstable/graphql.json`, '{"query":"{shop{name}}"}', JSONH), WA(`${S}/api/x`), WA(`${S}/buy-post`), WA('https://other.example/cart/add.js'), WA(`${S}/cart/add.js`, 'id=1', FORM, 'PUT')];
  ok(otherW.every((r) => typeof r === 'string' && r.length), 'write allow-list: GraphQL (even a query), any /api address, any other own-host path, another host and a PUT are stopped', JSON.stringify(otherW));
  // routing and method-override headers, on a write and on a GET
  const hdr = ['X-Original-URL', 'x-rewrite-url', 'X-HTTP-Method-Override', 'x-method-override', 'X-Forwarded-Host', 'Forwarded', 'x-forwarded-prefix'].map((h) => [WA(`${S}/cart/add.js`, 'id=1', { ...FORM, [h]: '/checkout' }), lib.writeAllowReason({ url: `${S}/products/a`, method: 'GET', headers: { [h]: 'x' }, ownHosts: own })]);
  ok(hdr.every(([a, b]) => a && b && /routing or method override/.test(a)), 'write allow-list: a routing or method-override header is refused on a cart write and on a GET', JSON.stringify(hdr));
  // content type and body
  const ctBad = [WA(`${S}/cart/add.js`, 'id=1', { 'content-type': 'text/plain' }), WA(`${S}/cart/add.js`, 'id=1', {}), WA(`${S}/cart/add.js`, '{', JSONH), WA(`${S}/cart/add.js`, '"x"', JSONH), WA(`${S}/cart/add.js`, 'x', { 'content-type': 'multipart/form-data' }), WA(`${S}/cart/add.js`, 'id=%E0%A4%A', FORM), WA(`${S}/cart/add.js`, null), WA(`${S}/cart/add.js`, 'id=1', { 'content-type': 'application/json', 'Content-Type': 'text/plain' })];
  ok(ctBad.every((r) => typeof r === 'string' && r.length), 'write allow-list: a wrong or missing content type, two content types, a body that does not parse as its type, and an unreadable body are stopped', JSON.stringify(ctBad));
  const mp = (name) => `--BB\r\nContent-Disposition: form-data; name="id"\r\n\r\n1\r\n--BB\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n/x\r\n--BB--\r\n`;
  const MPH = { 'content-type': 'multipart/form-data; boundary=BB' };
  ok(WA(`${S}/cart/add.js`, mp('quantity'), MPH) === null, 'write allow-list: a clean multipart cart add is sent');
  const keyBad = [WA(`${S}/cart/add.js`, 'id=1&checkout=1'), WA(`${S}/cart/update.js`, 'goto_checkout=1'), WA(`${S}/cart/add.js`, 'id=1&return_to=%2Fcheckout'), WA(`${S}/cart/add.js`, 'id=1&return%255Fto=x'), WA(`${S}/cart/add.js`, 'id=1&ch%2565ckout=x'), WA(`${S}/cart/add.js`, 'attributes%5Breturn_to%5D=x'),
    WA(`${S}/cart/update.js`, '{"items":[{"properties":{"deep":{"goto_checkout":true}}}]}', JSONH), WA(`${S}/cart/update.js`, '{"Return-To":"/x"}', JSONH), WA(`${S}/cart/add.js`, mp('return_to'), MPH), WA(`${S}/cart/add.js`, mp('Check_Out'), MPH), WA(`${S}/cart/add.js?return_to=/checkout`), WA(`${S}/cart/add.js`, 'id=1&redirect=%2Fx')];
  ok(keyBad.every((r) => typeof r === 'string' && /key/.test(r)), 'write allow-list: a checkout, goto_checkout, return_to or redirect key in a form, JSON (any depth), multipart or query, plain or encoded up to three times, is stopped', JSON.stringify(keyBad));
  ok(WA(`${S}/cart/update.js`, '{"attributes":{"gift_note":"Happy checkout day"}}', JSONH) === null && WA(`${S}/cart/add.js`, 'id=1&properties%5BNote%5D=See+you+at+checkout%2C+thanks') === null
    && WA(`${S}/cart/update.js`, '{"discount":"CANDLE10","note":"12.95 for northwick.example"}', JSONH) === null,
  'write allow-list: keys and values are read; plain prose that mentions checkout (a gift note) and ordinary values still pass');
  // R26 #2: a value that resolves to a checkout, account, login or payment destination (or a known payment host) is stopped in a
  // form, JSON (any depth), multipart or query; the key alone would not have caught any of these
  const mpv = (v) => `--BB\r\nContent-Disposition: form-data; name="id"\r\n\r\n1\r\n--BB\r\nContent-Disposition: form-data; name="attributes[gift]"\r\n\r\n${v}\r\n--BB--\r\n`;
  const valBad = [WA(`${S}/cart/update.js`, 'attributes%5Bx%5D=%2Fcheckout'), WA(`${S}/cart/update.js`, '{"attributes":{"x":"https://www.paypal.com/checkoutnow?token=1"}}', JSONH),
    WA(`${S}/cart/update.js`, '{"attributes":{"x":["shop.app"]}}', JSONH), WA(`${S}/cart/add.js`, 'id=1&properties%5BEngraving%5D=%2Faccount%2Flogin'), WA(`${S}/cart/add.js`, mpv('/checkouts/abc'), MPH),
    WA(`${S}/cart/add.js?section=%2Fcheckout`), WA(`${S}/cart/update.js`, '{"attributes":{"x":"goto_checkout"}}', JSONH), WA(`${S}/cart/update.js`, 'attributes%5Bx%5D=javascript%3Aalert(1)'),
    WA(`${S}/cart/update.js`, 'attributes%5Bx%5D=%252Fcheckout')];
  ok(valBad.every((r) => typeof r === 'string' && /value/.test(r)), 'write allow-list: a value pointing at /checkout, a payment host, shop.app, /account/login or a script address (form, JSON, multipart, query, encoded twice) is stopped', JSON.stringify(valBad));
  // R26 #1: multipart is parsed strictly; any field the parser could read two ways is stopped, Dawn's FormData add still passes
  const DB = '----WebKitFormBoundaryAbC123xYz';
  const dawn = `--${DB}\r\nContent-Disposition: form-data; name="form_type"\r\n\r\nproduct\r\n--${DB}\r\nContent-Disposition: form-data; name="utf8"\r\n\r\n\u2713\r\n--${DB}\r\nContent-Disposition: form-data; name="id"\r\n\r\n4242\r\n--${DB}\r\nContent-Disposition: form-data; name="quantity"\r\n\r\n1\r\n--${DB}\r\nContent-Disposition: form-data; name="sections"\r\n\r\ncart-drawer,cart-icon-bubble\r\n--${DB}\r\nContent-Disposition: form-data; name="sections_url"\r\n\r\n/products/gift-set\r\n--${DB}--\r\n`;
  ok(WA(`${S}/cart/add.js`, dawn, { 'content-type': `multipart/form-data; boundary=${DB}` }) === null, 'write allow-list: a Dawn-style FormData cart add (mixed-case WebKit boundary, sections_url) is sent');
  const part = (hdrs, v = 'x') => `--BB\r\nContent-Disposition: form-data; name="id"\r\n\r\n1\r\n--BB\r\n${hdrs}\r\n\r\n${v}\r\n--BB--\r\n`;
  const ambig = [
    part('Content-Disposition: form-data; name="note"; name="return_to"'),
    part('Content-Disposition: form-data; name="note"\r\nContent-Disposition: form-data; name="return_to"'),
    part('Content-Disposition: form-data;\r\n name="return_to"'),
    `preamble\r\n${part('Content-Disposition: form-data; name="note"')}`,
    `${part('Content-Disposition: form-data; name="note"')}epilogue`,
    part('Content-Disposition: form-data; name*=UTF-8\'\'return_to'),
    part('Content-Disposition: form-data; name="note"; x="1"'),
    part('Content-Disposition: form-data; name="note"\r\nX-Extra: 1'),
    part('Content-Disposition: form-data; name="no\\"te"'),
    part('Content-Disposition: attachment; name="note"'),
    part('Content-Disposition: form-data; name="note"').replace('--BB--', '--BB --'),
  ].map((b) => WA(`${S}/cart/add.js`, b, MPH));
  const ctAmbig = [WA(`${S}/cart/add.js`, mp('quantity'), { 'content-type': 'multipart/form-data; boundary=BB; boundary=CC' }), WA(`${S}/cart/add.js`, mp('quantity'), { 'content-type': 'multipart/form-data; boundary=BB; x=1' })];
  ok([...ambig, ...ctAmbig].every((r) => typeof r === 'string' && /exactly one way|not readable/.test(r)), 'write allow-list: a duplicate disposition parameter or header, a folded header, a preamble or epilogue, an extended or extra parameter, an extra header, an escaped quote, another disposition, a padded delimiter, a second boundary or an unknown content-type parameter makes the multipart body unreadable (stopped)', JSON.stringify([...ambig, ...ctAmbig]));
  // siblings: a JSON object with a repeated key, and a form or query with a raw ";" (some servers split on it) are read two ways
  const sib = [WA(`${S}/cart/update.js`, '{"note":"a","note":"b"}', JSONH), WA(`${S}/cart/update.js`, '{"attributes":{"x":"a","x":"/checkout"}}', JSONH), WA(`${S}/cart/add.js`, 'id=1;return_to=/x'), WA(`${S}/cart/add.js?a=1;return_to=x`)];
  ok(sib.every((r) => typeof r === 'string' && r.length), 'write allow-list: a JSON body with a repeated key, and a form body or query with a raw ";" are stopped (read two ways)', JSON.stringify(sib));
  // the browser-level guard uses the same list (and reads Chromium's postData parts)
  const pol = { blockRules: [], allowHosts: [], ownHosts: own, noCart: false };
  const NGW = (url, postData, headers = FORM) => lib.netGuardReason(pol, { url, method: 'POST', postData, resourceType: 'fetch', headers });
  ok(NGW(`${S}/cart/add.js`, 'id=1') === null && NGW(`${S}/buy-post`, 'id=1')?.kind === 'dispatch' && NGW(`${S}/api/2024-01/graphql.json`, '{}', JSONH)?.kind === 'dispatch' && NGW(`${S}/cart/add.js`, 'id=1&return_to=x')?.kind === 'dispatch' && NGW(`${S}/cart/add.js`, null)?.kind === 'dispatch',
    'browser-level guard: the same write allow-list (a write it stops is a dispatch intervention, an unreadable body included)');
  ok(lib.cdpPostData({ postData: 'a=1' }) === 'a=1' && lib.cdpPostData({ postDataEntries: [{ bytes: Buffer.from('a=1&').toString('base64') }, { bytes: Buffer.from('b=2').toString('base64') }] }) === 'a=1&b=2' && lib.cdpPostData({ hasPostData: true }) === null && lib.cdpPostData({ postDataEntries: [{}], hasPostData: true }) === null && lib.cdpPostData({}) === '',
    'cdpPostData: postData, joined postDataEntries, and null (never sent as a write) for a body Chromium did not hand over');
  // GET: checkout, account, password and permalinks; handles exempt only where Shopify puts them
  const cr = (p) => lib.checkoutReason({ url: `${S}${p}`, method: 'GET', isNavigation: true });
  const getBad = ['/shop/login', '/shop/checkout', '/checkoutx', '/checkout_v2', '/checkouts/abc', '/fr/checkouts/abc', '/account', '/accounts/login', '/account-settings', '/fr/account', '/password', '/password/x', '/fr/password', '/cart/123:1', '/cart/123:1,456:2', '/products/checkout', '/collections/checkout-guide', '/pages/checkout-help', '/blogs/news/checkout-tips'];
  const getOk = ['/products/checkout-guide-candle', '/collections/gifts/products/checkout-guide-candle', '/fr/products/checkout-guide-candle', '/products/account-book', '/collections/gifts', '/pages/about', '/cart'];
  const leaked = getBad.filter((p) => !cr(p)); const over = getOk.filter((p) => cr(p));
  ok(!leaked.length && !over.length, 'GET hard line: /checkout*, /checkouts/*, /account*, /password, permalinks and /shop/login are stopped; a handle is exempt only at /products/<h> and /collections/<c>/products/<h>', JSON.stringify({ leaked, over: over.map((p) => [p, cr(p)]) }));
  // the platform check
  const H = { 'content-type': 'text/html; charset=utf-8' };
  const cs = (o) => lib.classifyStorefront({ status: 200, headers: H, ...o });
  const shopHtml = '<html><head><script>Shopify.theme = {"name":"Dawn"};</script></head><body></body></html>';
  ok(cs({ html: shopHtml }).kind === 'shopify'
    && cs({ html: '<html><head><link rel="stylesheet" href="/wp-content/themes/x.css"></head><body class="woocommerce"></body></html>' }).kind === 'other'
    && /WooCommerce/.test(cs({ html: '<html><body class="woocommerce"></body></html>' }).name)
    && cs({ html: '<html><body><script src="/stencil/x.js"></script></body></html>' }).kind === 'other'
    && cs({ html: '<html><body>Hello</body></html>' }).kind === 'other'
    && cs({ headers: { ...H, 'powered-by': 'Shopify-Hydrogen' }, html: '<html><body></body></html>' }).kind === 'hydrogen'
    && cs({ headers: { ...H, 'oxygen-full-page-cache': 'miss' }, html: '<html><body></body></html>' }).kind === 'hydrogen'
    && cs({ html: '<html><body><script>window.__remixContext = {}</script></body></html>' }).kind === 'hydrogen'
    && cs({ status: 500, html: shopHtml }).kind === 'unknown' && cs({ status: 302, html: '' }).kind === 'unknown'
    && cs({ headers: { 'content-type': 'application/json' }, html: '{}' }).kind === 'unknown',
    'classifyStorefront: an Online Store theme is shopify; WooCommerce, BigCommerce or a plain page is other; Hydrogen or Oxygen is hydrogen; an error, a redirect or not HTML is unknown');
  // R26 #3: the theme must be set by running code: a comment, a string, an attribute or a non-JavaScript script is not proof, and a
  // theme next to another platform's markup is a conflict (refused); /cart.js must answer as a Shopify cart; the runtime check runs
  const sh = (body, head = '') => cs({ html: `<html><head>${head}</head><body>${body}</body></html>` }).kind;
  const pf = [sh('<!-- Shopify.theme = {"name":"x"}; -->'), sh('<script>var s = "Shopify.theme = {}";</script>'), sh('<script>// Shopify.theme = {}\n</script>'), sh('<div data-x=\'Shopify.theme = {}\'></div>'), sh('<script type="text/plain">Shopify.theme = {"name":"x"};</script>'),
    sh('<script>if (Shopify.theme == null) {}</script>'), sh('<script>Shopify.theme = {"name":"Dawn"};</script>', '<link rel="stylesheet" href="/wp-content/themes/x.css">'), sh('<script>Shopify.theme = {"name":"Dawn"};</script><div data-mage-init="{}"></div>')];
  ok(JSON.stringify(pf) === JSON.stringify(['other', 'other', 'other', 'other', 'other', 'other', 'conflict', 'conflict']),
    'classifyStorefront: Shopify.theme only in a comment, a string, an attribute, a text/plain script or a comparison is not a theme; a theme next to WooCommerce or Magento markup is a conflict', JSON.stringify(pf));
  const cj = { token: 'c1', items: [], item_count: 0, currency: 'USD', total_price: 0 };
  ok(lib.isShopifyCartJson(cj) && !lib.isShopifyCartJson({ ...cj, token: '' }) && !lib.isShopifyCartJson({ ...cj, items: {} }) && !lib.isShopifyCartJson({ ...cj, item_count: '0' }) && !lib.isShopifyCartJson({ ...cj, currency: 'dollars' }) && !lib.isShopifyCartJson(null) && !lib.isShopifyCartJson('<html>'),
    'isShopifyCartJson: a token, an items list, a whole item count and a 3-letter currency, or it is not a Shopify cart');
  // R26 #5: the cart's Checkout control: a real control, a checkout label, an own-host checkout or cart destination (or the cart
  // form's name="checkout" submit), never an express or wallet button
  const ownS = new Set(['shop.example']); const PU = 'https://shop.example/cart';
  const ccp = (d) => lib.checkoutControlProblem({ control: true, express: false, label: 'Check out', target: 'https://shop.example/cart', name_checkout: false, ...d }, PU, ownS);
  // R27: a control that leads to the cart page counts only as the cart form's own name="checkout" submit (so these use name_checkout)
  const ccOk = [ccp({ name_checkout: true }), ccp({ target: '/checkout' }), ccp({ name_checkout: true, target: 'https://shop.example/en-ca/cart' }), ccp({ label: 'Proceed to checkout', target: 'https://shop.example/checkouts/c/1' }), ccp({ name_checkout: true, target: 'https://shop.example/cart?x=1' })];
  const ccBad = [ccp({}), ccp({ control: false }), ccp({ express: true }), ccp({ label: 'Continue shopping' }), ccp({ label: '' }), ccp({ target: null }), ccp({ target: 'https://www.paypal.com/checkoutnow' }), ccp({ target: 'https://other.example/checkout' }),
    ccp({ target: 'https://shop.example/pages/help' }), ccp({ target: 'javascript:void(0)' }), ccp({ target: 'https://shop.app/checkout' })];
  ok(ccOk.every((x) => x === null) && ccBad.every((x) => typeof x === 'string' && x.length), 'checkoutControlProblem: only a real, labelled, own-host checkout or cart control passes; a non-control, an express block, a wrong label, no address, a payment or other host, another page or a script address is refused', JSON.stringify({ ccOk, ccBad }));
  // the shipping estimator is read from the store's own rates answer only
  ok(lib.isShippingRatesUrl(`${S}/cart/async_shipping_rates.json?x=1`, own) && lib.isShippingRatesUrl(`${S}/fr/cart/shipping_rates.json`, own) && !lib.isShippingRatesUrl('https://other.example/cart/async_shipping_rates.json', own) && !lib.isShippingRatesUrl(`${S}/cart/shipping_rates.json.bak`, own) && !lib.isShippingRatesUrl(`${S}/apps/rates/cart/shipping_rates.json`, own),
    'isShippingRatesUrl: only the own-host Shopify rates answers');
  const rf = lib.shippingRatesFrom({ shipping_rates: [{ name: 'Standard', price: '3.95' }, { name: 'Express', price: '12.95' }] });
  ok(JSON.stringify(rf) === JSON.stringify([{ name: 'Standard', price: 3.95 }, { name: 'Express', price: 12.95 }]) && lib.shippingRatesFrom({ shipping_rates: [{ name: 'Promo', price: 'free over $50' }] }) === null && lib.shippingRatesFrom({}) === null && lib.shippingRatesFrom('Free shipping over $50') === null && lib.shippingRatesFrom({ shipping_rates: [null] }) === null,
    'shippingRatesFrom: real rate lines only; promo text or an unreadable answer gives no price', JSON.stringify(rf));
  // coupons are whole tokens
  const ec = (t) => JSON.stringify(lib.extractStoreCodes(t));
  ok(ec('Use code CANDLE10 at checkout') === '["CANDLE10"]' && ec('Use code CANDLE10.') === '["CANDLE10"]' && ec('Use code "CANDLE10" today') === '["CANDLE10"]' && ec('Use code CANDLE10% off') === '[]' && ec('use code SAVE10-VIP now') === '[]' && ec('code WELCOME_2026') === '[]' && ec('Use code SAVE10.5') === '[]' && ec('Use code A1B2/C3') === '[]',
    'extractStoreCodes: a code is a whole token; a code that runs on into other characters is never applied', [ec('Use code CANDLE10% off'), ec('use code SAVE10-VIP now')].join(' '));
  // R26 #6: the whole token is read and checked; one that fails is dropped, never cut down (an accented letter, a dash of any kind,
  // a double dot), while a closing quote, bracket or sentence mark after a good code is fine
  const wt = ['Use code SAVE10\u00c9 now', 'Use code SAVE10\u2013VIP', 'Use code SAVE10\u2014VIP', 'Use code SAVE10..VIP', 'use code SAVE10\u00a7', 'code SAVE10\u2019s'].map(ec);
  ok(wt.every((x) => x === '[]') && ec('(use code CANDLE10).') === '["CANDLE10"]' && ec('Code:CANDLE10!') === '["CANDLE10"]' && ec('use code \u201cGIFT25\u201d.') === '["GIFT25"]',
    'extractStoreCodes: the whole token after "code" must be a valid code (SAVE10 with an accented letter, an en or em dash, a double dot, a section sign or a possessive is dropped); closing punctuation is fine', JSON.stringify(wt));
  // ---------- R27 (Codex round 8) ----------
  const r27 = (f) => { try { return f(); } catch (e) { return `THREW ${e.message}`; } };
  // R27 #1: a script's own src is platform evidence (its contents are still never read)
  const sfHome = (extra) => r27(() => lib.classifyStorefront({ status: 200, headers: { 'content-type': 'text/html' }, html: `<!doctype html><html><head><script>window.Shopify = window.Shopify || {}; Shopify.theme = {"name":"Dawn"};</script>${extra}</head><body class="home"><h1>Shop</h1></body></html>` }));
  const sf1 = [sfHome('<script src="/assets/stencil-utils.js"></script>'), sfHome('<script src="/wp-includes/js/wp-embed.min.js"></script>'), sfHome('<script defer src=\'/wp-content/plugins/x/a.js\'></script>')];
  const sf1ok = [sfHome('<script>var t = "<script src=\'/wp-includes/js/a.js\'>"; var u = "/assets/stencil-utils.js";</script>'), sfHome('<!-- <script src="/wp-includes/js/a.js"></script> -->'), sfHome('<script src="/cdn/shop/t/1/assets/global.js"></script>')];
  ok(sf1.every((v) => v && v.kind === 'conflict') && sf1ok.every((v) => v && v.kind === 'shopify'),
    'R27 #1 classifyStorefront: a running Shopify theme next to a BigCommerce (stencil-utils.js) or WordPress (wp-includes, wp-content) script address is a conflict; text inside a script or a comment is still never read as markup', JSON.stringify({ sf1, sf1ok }));
  // R27 #2: the same conflict test for the page the browser actually loaded (the fallback gate)
  const pc = (o) => r27(() => lib.platformConflictOnPage(o));
  const pcHit = [pc({ html: '<html><body class="product woocommerce woocommerce-page"><h1>x</h1></body></html>' }), pc({ html: '<html><head><script src="/wp-includes/js/wp-embed.min.js"></script></head><body></body></html>' }),
    pc({ html: '<html><body><div data-mage-init=\'{}\'></div></body></html>' }), pc({ headers: { 'Powered-By': 'Shopify, Hydrogen' }, html: '<html><body></body></html>' }), pc({ html: '<html><body><div id="root" data-hydrogen></div></body></html>' })];
  const pcNone = [pc({ html: '<html><head><script>Shopify.theme = {}; var s = "woocommerce /wp-includes/";</script></head><body class="template-product"><p>We are not WooCommerce.</p></body></html>' }), pc({ headers: { 'content-type': 'text/html' }, html: '' })];
  ok(pcHit.every((v) => typeof v === 'string' && v.length && !/^THREW/.test(v)) && pcNone.every((v) => v === null),
    'R27 #2 platformConflictOnPage: body.woocommerce, a WordPress script address, Magento markup, a Hydrogen header or Hydrogen markers on the loaded page are conflicts; words in page text or a script are not', JSON.stringify({ pcHit, pcNone }));
  // R27 #3: name="checkout" counts only for a form whose action is the canonical cart; destinations are checked one by one
  const cc3Bad = [ccp({ name_checkout: true, target: 'https://shop.example/account/login' }), ccp({ name_checkout: true, target: '/account' }), ccp({ name_checkout: true, target: '/customer/login?return=/cart' }),
    ccp({ target: 'https://shop.example/cart/add.js?id=1' }), ccp({ target: '/cart/add' }), ccp({ name_checkout: true, target: '/cart/change.js' }), ccp({ target: '/cart/update' }), ccp({ target: '/cart/clear.js' }),
    ccp({ target: '/checkout/payment' }), ccp({ target: '/payments/1' }), ccp({ target: '/fr/cart' }), ccp({ name_checkout: true, target: '/cart.js' }), ccp({ name_checkout: true, target: '/pages/cart' }), ccp({ name_checkout: true, target: '/xx-zz/cart' })];
  const cc3Ok = [ccp({ name_checkout: true, target: '/fr/cart' }), ccp({ name_checkout: true, target: '/en-ca/cart/' }), ccp({ target: '/checkouts/cn/abc' }), ccp({ target: '/cart/checkout' }), ccp({ target: '/de/checkout' }), ccp({ name_checkout: true, target: '/checkout' })];
  ok(cc3Bad.every((x) => typeof x === 'string' && x.length && !/^THREW/.test(x)) && cc3Ok.every((x) => x === null),
    'R27 #3 checkoutControlProblem: a name="checkout" submit to a login or account route, a cart action endpoint (/cart/add, /change, /update, /clear, .js), a payment route, or a /cart link without the cart form submit never counts as Checkout; the canonical cart form and real checkout paths do', JSON.stringify({ cc3Bad, cc3Ok }));
  // R27 #4: translated Checkout labels pass (same vocabulary everywhere); the negatives still fail
  const lab = (label) => ccp({ label, name_checkout: true });
  const labOk = ['Finalizar compra', 'Procéder au paiement', 'Zur Kasse', 'Passer commande → Commander', 'Afrekenen', 'Pagar ahora', 'Continue to payment', 'Check-out'].map(lab);
  const labBad = ['Continue shopping', 'Weiter einkaufen', 'Seguir comprando', 'Continuer mes achats', 'Update cart', ''].map(lab);
  const vocabSame = r27(() => [lib.visibleCheckoutText, lib.findCheckoutInPage].every((f) => String(f).includes(lib.CHECKOUT_LABEL.source)));
  ok(labOk.every((x) => x === null) && labBad.every((x) => typeof x === 'string' && /does not say checkout/.test(x)) && vocabSame === true,
    'R27 #4 checkout labels: Finalizar compra, Procéder au paiement, Zur Kasse, Commander, Afrekenen, Pagar pass; Continue shopping and its translations fail; the page-side finders use the same word list', JSON.stringify({ labOk, labBad, vocabSame }));
  // R27 #6: "code" is a whole word, and the scan goes on after the token it read (no suffix of a code is read again as a code)
  const c6 = [ec('Use code CODE2026ABC'), ec('Use code CODEGREEN'), ec('Use code CODE10 at checkout'), ec('Use code CANDLE10 or code GIFT25 today'), ec('Promo code: CODES2026!'), ec('barcode AB12CD34'), ec('Use code CODE')];
  ok(JSON.stringify(c6) === JSON.stringify(['["CODE2026ABC"]', '["CODEGREEN"]', '["CODE10"]', '["CANDLE10","GIFT25"]', '["CODES2026"]', '[]', '[]']),
    'R27 #6 extractStoreCodes: CODE2026ABC and CODEGREEN are read once and never again as 2026ABC or GREEN; two real codes are both read; "barcode" is not "code"', JSON.stringify(c6));
  // R27 #7: which dropped background requests count against a cart check (writes to cart, discount, shipping or app addresses only)
  const cd = (u, m) => r27(() => lib.cartCheckDrop(`https://shop.example${u}`, m));
  const cdYes = [cd('/cart/update.js', 'POST'), cd('/cart/prepare_shipping_rates.json', 'POST'), cd('/apps/discount/apply', 'POST'), cd('/fr/cart/change.js', 'POST'), cd('/discount/SAVE10', 'POST')];
  const cdNo = [cd('/cart/update.js', 'GET'), cd('/.well-known/shopify/monorail/unstable/produce_batch', 'POST'), cd('/api/collect', 'POST'), cd('/products/a', 'POST')];
  ok(cdYes.every((x) => x === true) && cdNo.every((x) => x === false),
    'R27 #7 cartCheckDrop: a dropped keepalive or beacon write to a cart, discount, shipping or app address counts against a cart check; analytics beacons and reads do not', JSON.stringify({ cdYes, cdNo }));
}
// ---------- Part 2: the network guard (Chromium) ----------
section('Part 2: network guard (Chromium)');
const big = crypto.randomBytes(30000).toString('base64');
const r25Got = [];
const server = await startFixtureServer({
  extraRoutes: {
    '/redir-to-checkout': (req, res) => { res.writeHead(302, { location: '/checkouts/cn/redirected' }); res.end(); },
    '/redir-hop': (req, res) => { res.writeHead(302, { location: '/redir-to-checkout' }); res.end(); },
    '/big': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><title>big</title><!-- ${big} -->`); },
    '/go-checkout': (req, res) => { res.writeHead(302, { location: '/checkouts/cn/from-iframe' }); res.end(); },
    // N1: stores that ask the browser to prefetch or prerender their checkout in the background
    '/spec-cart/': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Cart</title><h1>Your cart</h1><a id="co" class="checkout-button" href="/checkout/">Check out</a><a href="/checkouts/cn/spec-doc">Pay</a><script type="speculationrules">{"prerender":[{"source":"document","where":{"href_matches":"/*"},"eagerness":"immediate"}],"prefetch":[{"source":"document","where":{"href_matches":"/*"},"eagerness":"immediate"}]}</script>'); },
    '/spec-inject/': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Cart</title><h1>Your cart</h1><a id="co" href="/checkout/">Check out</a><script>var s=document.createElement("script");s.type="speculationrules";s.textContent=JSON.stringify({prerender:[{source:"list",urls:["/checkout/"],eagerness:"immediate"}],prefetch:[{source:"list",urls:["/checkouts/cn/spec-js"],eagerness:"immediate"}]});document.head.appendChild(s);</script>'); },
    '/spec-header/': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'speculation-rules': '"/spec-rules.json"' }); res.end('<!doctype html><title>Cart</title><h1>Your cart</h1><a id="co" href="/checkout/">Check out</a><a href="/checkouts/cn/spec-hdr">Pay</a>'); },
    '/spec-rules.json': (req, res) => { res.writeHead(200, { 'content-type': 'application/speculationrules+json' }); res.end('{"prerender":[{"source":"document","where":{"href_matches":"/*"},"eagerness":"immediate"}],"prefetch":[{"source":"list","urls":["/checkouts/cn/spec-hdr"],"eagerness":"immediate"}]}'); },
    // F1: a form POST whose redirect goes to a page of no known kind
    // (a Shopify cart add under a locale prefix, so the allow-list lets it through and the redirect is what is tested)
    '/en/cart/add': (req, res) => { res.writeHead(303, { location: '/kasse/' }); res.end(); },
    '/buy-form/': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Buy</title><h1>Buy</h1><form method="post" action="/en/cart/add"><input name="id" value="56"><button id="go">Buy now</button></form>'); },
    // R25 B: a form POST to a path that is not a Shopify cart operation is never sent
    '/buy-post': (req, res) => { res.writeHead(303, { location: '/kasse/' }); res.end(); },
    '/buy-form-bad/': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Buy</title><h1>Buy</h1><form method="post" action="/buy-post"><input name="id" value="56"><button id="go">Buy now</button></form>'); },
    // R25 C#5: redirect hops are checked with that hop's own method and body (307 and 308 keep both; 303 becomes a GET)
    '/it/cart/update.js': (req, res) => { res.writeHead(307, { location: '/es/cart/update.js' }); res.end(); },
    '/it/cart/change.js': (req, res) => { res.writeHead(308, { location: '/es/cart/change.js' }); res.end(); },
    '/es/cart/update.js': (req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { r25Got.push({ url: req.url, method: req.method, body: b }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }); },
    '/es/cart/change.js': (req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { r25Got.push({ url: req.url, method: req.method, body: b }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }); },
    '/nl/cart/add.js': (req, res) => { res.writeHead(307, { location: '/r25-sink' }); res.end(); },
    '/pt/cart/add.js': (req, res) => { res.writeHead(308, { location: '/r25-sink' }); res.end(); },
    '/sv/cart/add.js': (req, res) => { res.writeHead(303, { location: '/r25-sink' }); res.end(); },
    '/da/cart/add.js': (req, res) => { res.writeHead(307, { location: '/es/cart/update.js?return_to=%2Fcheckout' }); res.end(); },
    '/r25-sink': (req, res) => { r25Got.push({ url: req.url, method: req.method, body: '' }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); },
    // F2: product pages without an h1
    '/usable/h2/': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>x</title><main><h2 class="product-name">Beeswax Taper Pair</h2><img src="/img/amber-1.svg" width="600" height="600" alt=""></main>'); },
    '/usable/ld/': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>x</title><script type="application/ld+json">{"@type":"Product","name":"Beeswax Taper Pair"}</script><main><div class="ttl">Beeswax Taper Pair</div><img src="/img/amber-1.svg" width="600" height="600" alt=""></main>'); },
    '/usable/title/': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>x</title><main><p class="product_title">Beeswax Taper Pair</p><img src="/img/amber-1.svg" width="600" height="600" alt=""></main>'); },
    '/usable/none/': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>x</title><main><div class="ttl">Something</div><img src="/img/amber-1.svg" width="600" height="600" alt=""></main>'); },
    // F3: a WooCommerce block-theme product grid, and a grid the panel does not recognise
    '/shop-block/': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Shop</title><link rel="stylesheet" href="/assets/store.css"><main><h1>Shop</h1><img src="/img/amber-1.svg" width="600" height="600" alt="Shop"><div class="wp-block-woocommerce-product-collection"><ul class="wc-block-product-template wp-block-post-template"><li class="wc-block-product"><a href="/product/beeswax-taper/"><img src="/img/amber-2.svg" width="300" height="300" alt="Beeswax Taper Pair"></a><h3 class="wp-block-post-title"><a href="/product/beeswax-taper/">Beeswax Taper Pair</a></h3><div class="wc-block-components-product-price"><span class="woocommerce-Price-amount amount">18,00 &euro;</span></div></li></ul></div></main>'); },
    // R4 item 1: a store that sends beacons and keepalive requests as the page closes (Chromium sends these past ctx.route)
    '/unload/': (req, res) => {
      const third = `http://localhost:${req.headers.host.split(':').pop()}`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Unload</title><h1>Unload</h1><iframe id="f" src="about:blank" title="x"></iframe><script>
window.__sw = 'pending'; window.__beaconRet = []; window.__keep = [];
try { navigator.serviceWorker.register('/sw.js').then(function () { window.__sw = 'registered'; }, function (e) { window.__sw = 'rejected ' + e.name; }); } catch (e) { window.__sw = 'threw ' + e.name; }
var sent = false;
function send() {
  if (sent) return; sent = true;
  var b = navigator.sendBeacon.bind(navigator);
  window.__beaconRet.push(b('/api/collect', 'x'), b('${third}/tp-beacon', 'x'), b('/checkouts/cn/beacon', 'x'));
  try { var fw = document.getElementById('f').contentWindow; window.__beaconRet.push(fw.navigator.sendBeacon('/checkouts/cn/iframe-beacon', 'x')); fw.fetch('${third}/tp-iframe-keep', { method: 'POST', body: 'x', keepalive: true, mode: 'no-cors' }); } catch (e) { window.__beaconRet.push('iframe ' + e.name); }
  [['/api/collect', {}], ['${third}/tp-keep', { mode: 'no-cors' }], ['/checkouts/cn/keep', {}]].forEach(function (x) { fetch(x[0], Object.assign({ method: 'POST', body: 'x', keepalive: true }, x[1])).then(function (r) { window.__keep.push(r.status); }, function () { window.__keep.push('rejected'); }); });
  fetch(new Request('/checkouts/cn/keep-req', { method: 'POST', body: 'x', keepalive: true })).catch(function () {});
  fetch('/own-keep', { method: 'POST', body: 'x', keepalive: true }).catch(function () {});
}
addEventListener('pagehide', send);
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') send(); });
</script>`);
    },
    '/unload-visible/': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Vis</title><h1>Vis</h1><script>window.__r = []; window.__r.push(navigator.sendBeacon("/api/collect", "x")); fetch("/own-keep-live", { method: "POST", body: "x", keepalive: true }).then(function (r) { window.__r.push(r.status); });</script>'); },
    '/sw.js': (req, res) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('self.addEventListener("fetch", function (e) { e.respondWith(new Response("FROM-SW")); });'); },
    '/sw-probe': (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('FROM-SERVER'); },
    // R4 items 2 and 3: a gift card whose required "Recipient email" the panel never types, a page with no price it recognises, and a
    // page whose structured price is not shown
    '/product/gift-card/': (req, res) => {
      const html = fs.readFileSync(path.join(STORE_DIR, 'woo-product-beeswax-taper.html'), 'utf8')
        .replace('<form class="cart" method="post"', '<form class="cart" method="post" novalidate')
        .replace('<div class="quantity">', '<p class="form-row"><label for="gc-to">Recipient email <abbr class="required" title="required">*</abbr></label><input type="email" id="gc-to" name="recipient_email" required></p><div class="quantity">')
        .replace('</form>', '</form><script>document.querySelector("form.cart").addEventListener("submit", function (e) { if (!document.getElementById("gc-to").value) { e.preventDefault(); if (!document.querySelector(".woocommerce-error")) this.insertAdjacentHTML("afterbegin", \'<ul class="woocommerce-error" role="alert"><li>Recipient email is a required field.</li></ul>\'); } }); navigator.sendBeacon("/api/collect", "x");</script>')
        .replace(/\{\{[A-Z]+\}\}/g, '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
    },
    // R4b: tracker hosts mapped to loopback (Chromium launched with a host map), a sandboxed frame, and an uncaught register() refusal
    '/product/trackers/': (req, res) => {
      const port = req.headers.host.split(':').pop();
      const html = fs.readFileSync(path.join(STORE_DIR, 'woo-product-beeswax-taper.html'), 'utf8')
        .replace('</form>', `</form><script src="http://connect.facebook.net:${port}/en_US/fbevents.js"></script><script>fetch("http://www.clarity.ms:${port}/collect", { mode: "no-cors" }).catch(function (e) { setTimeout(function () { throw e; }, 0); }); setTimeout(function () { fetch("http://www.clarity.ms:${port}/collect-uncaught", { mode: "no-cors" }); }, 400); if (navigator.serviceWorker) navigator.serviceWorker.register("/sw.js");</script><iframe sandbox="allow-scripts" title="x" srcdoc="<p>widget</p><script>var n = 1;</script>"></iframe>`)
        .replace(/\{\{[A-Z]+\}\}/g, '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
    },
    // R5: an own-host product whose handle, photo name and product JSON name contain tracker words (a Shopify /products/<handle> address)
    '/products/trekkie-elevare-candle': (req, res) => {
      const html = fs.readFileSync(path.join(STORE_DIR, 'woo-product-beeswax-taper.html'), 'utf8')
        .replace('<img src="/img/amber-1.svg"', '<img src="/wp-content/uploads/elevare-gold.png"')
        .replace('</form>', '</form><link rel="stylesheet" href="/wp-content/uploads/littledata-pintrk.css"><script>fetch("/products/trekkie-elevare-candle.js");</script>')
        .replace(/\{\{[A-Z]+\}\}/g, '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
    },
    '/wp-content/uploads/elevare-gold.png': (req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')); },
    '/wp-content/uploads/littledata-pintrk.css': (req, res) => { res.writeHead(200, { 'content-type': 'text/css' }); res.end('body { color: #111; }'); },
    '/products/trekkie-elevare-candle.js': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); },
    // R5: a page whose heading and dispatch line are written by an own-host script, for a journey that fails after a named rule
    // stopped that script (no heading, so the page is not recognised: a quit a missing request can cause)
    '/product/needs-script/': (req, res) => {
      const html = fs.readFileSync(path.join(STORE_DIR, 'woo-product-beeswax-taper.html'), 'utf8')
        .replace('<h1 class="product_title entry-title">Beeswax Taper Pair</h1>', '<h1 class="product_title entry-title" id="tslot"></h1>')
        .replace('</form>', '</form><div id="hslot"></div><script src="/assets/render-heading.js"></script>')
        .replace(/\{\{[A-Z]+\}\}/g, '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
    },
    '/assets/render-heading.js': (req, res) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end("document.getElementById('tslot').textContent = 'Beeswax Taper Pair'; document.getElementById('hslot').textContent = 'Dispatch: leaves our workshop within 2 days.';"); },
    // R7: a page that loads a harmless own-host widget script and never states a gift-wrap option, for a content quit after a
    // named rule stopped that script (the quit stands, with a caveat naming the rule)
    '/product/widget-page/': (req, res) => {
      const html = fs.readFileSync(path.join(STORE_DIR, 'woo-product-beeswax-taper.html'), 'utf8')
        .replace('</form>', '</form><script src="/assets/extra-widget.js"></script>')
        .replace(/\{\{[A-Z]+\}\}/g, '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
    },
    '/assets/extra-widget.js': (req, res) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('var widgetLoaded = 1;'); },
    // R7: the platform's tracker script on cdn.shopify.com (mapped to this server on Chromium), and a page that never states a burn time
    '/product/cdn-trekkie/': (req, res) => {
      const port = req.headers.host.split(':').pop();
      const html = fs.readFileSync(path.join(STORE_DIR, 'woo-product-beeswax-taper.html'), 'utf8')
        .replace('</form>', `</form><script src="http://cdn.shopify.com:${port}/s/trekkie.storefront.abc123.min.js"></script>`)
        .replace(/\{\{[A-Z]+\}\}/g, '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
    },
    '/s/trekkie.storefront.abc123.min.js': (req, res) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('var trekkie = 1;'); },
    // R6: a product with a tracker word as its handle, the store's own section and collection JSON fetches, and a first-party Google tag
    '/product/perf-kit/': (req, res) => {
      const html = fs.readFileSync(path.join(STORE_DIR, 'woo-product-beeswax-taper.html'), 'utf8')
        .replace('</form>', '</form><script src="/metrics/gtag/js?id=G-TEST1"></script><script>fetch("/products/perf-kit?section_id=main"); fetch("/collections/web-pixel/products.json"); fetch("/metrics/g/collect?v=2&tid=G-TEST1&en=page_view", { method: "POST" }).catch(function () {});</script>')
        .replace(/\{\{[A-Z]+\}\}/g, '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
    },
    '/products/perf-kit': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<div>section</div>'); },
    '/collections/web-pixel/products.json': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"products":[]}'); },
    '/product/no-price/': (req, res) => {
      const html = fs.readFileSync(path.join(STORE_DIR, 'woo-product-beeswax-taper.html'), 'utf8')
        .replace(/,"offers":\[[^\]]*\]/, '')
        .replace(/<p class="price">[\s\S]*?<\/p>/, '<p class="cost-line">Ask us about this one</p>')
        .replace(/\{\{[A-Z]+\}\}/g, '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
    },
    '/product/hidden-price/': (req, res) => {
      const html = fs.readFileSync(path.join(STORE_DIR, 'woo-product-beeswax-taper.html'), 'utf8')
        .replace(/<p class="price">[\s\S]*?<\/p>/, '<p class="cost-line">Ask us about this one</p>')
        .replace(/\{\{[A-Z]+\}\}/g, '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
    },
    '/shop-odd/': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Shop</title><main><h1>Shop</h1><img src="/img/amber-1.svg" width="600" height="600" alt="Shop"><section class="mystery-shelf"><div><a href="/product/beeswax-taper/">Beeswax Taper Pair</a> 18,00 &euro;</div></section></main>'); },
  },
  extraHtml: {
    '/products/linen-and-cedar-candle': [
      // trap 1: an error from the store's own script must be reported
      '<script>setTimeout(function () { throw new Error("fixture own-page error"); }, 50);</script>',
      // trap 2: a blocked third-party call that rethrows a bare network error must be set aside
      '<script>setTimeout(function () { fetch("{{THIRD}}/collect").catch(function (e) { setTimeout(function () { throw e; }, 0); }); }, 100);</script>',
      // trap 3: a platform analytics call on the store's own host must be blocked by its named rule
      '<script>fetch("/.well-known/shopify/monorail/unstable/produce_batch", { method: "POST", body: "{}" }).catch(function () {});</script>',
      // trap 4: a hidden iframe that redirects to checkout must never load it
      '<iframe src="/go-checkout" style="display:none" title="x"></iframe>',
      // trap 5: a pop-up whose only "Close" button would submit a form, next to a safe Dismiss button
      '<div id="survey" style="position:fixed;inset:0;background:#fff;z-index:50"><form action="/survey-submit" method="post"><p>Quick question</p><button aria-label="Close">x</button></form><button type="button" aria-label="Dismiss" onclick="document.getElementById(\'survey\').remove()">Dismiss</button></div>',
    ].join('\n'),
  },
});
const O = server.origin; const PORT = server.port;
const blockCfg = JSON.parse(fs.readFileSync(path.join(root, 'scripts/blocklist.json'), 'utf8'));
// The shipped rules are compiled as built-ins (the runner does the same); user rules never get "endpoint" (see the R9 tests).
const builtinRule = (r) => lib.compileBlockRule(r, { builtin: true }); const checkBuiltin = (r) => lib.checkBlockRule(r, { builtin: true });
const blockRules = blockCfg.rules.map((r) => builtinRule(r).rule);
ok(blockRules.every(Boolean), 'every built-in block rule compiles');
// R5: named rules are host rules (host name only, label boundary) or path rules (whole segments or query parameters)
ok(blockCfg.rules.every((r) => (r.kind === 'host' || r.kind === 'path') && !checkBuiltin(r).length), 'every built-in rule says whether it is a host rule or a path rule, and passes the validator');
{
  const v = (r) => checkBuiltin(r).join(' ');
  ok(/no longer used/.test(v({ name: 'x', pattern: 'a' })) && /not anchored/.test(v({ name: 'x', kind: 'path', path: 'trekkie', own_host: true })) && /not anchored/.test(v({ name: 'x', kind: 'path', path: '^/a|b', own_host: true })) && /needs a dot/.test(v({ name: 'x', kind: 'host', hosts: ['trekkie'] })) && /own_host/.test(v({ name: 'x', kind: 'path', path: '^/a' })) && /"kind"/.test(v({ name: 'x', path: '^/a' })), 'the validator rejects an old-style pattern, an unanchored path, a bare word host, a path rule without own_host and a rule without a kind');
  const own = new Set(['shop.example']); const fr = (u, rt = 'script', isDocument = false) => lib.findBlockRule(blockRules, u, { ownHosts: own, allowHosts: blockCfg.allow_hosts, resourceType: rt, isDocument })?.name || null;
  const safe = [['https://shop.example/products/trekkie-mug', 'document', true], ['https://shop.example/products/elevare-candle', 'document', true], ['https://shop.example/products/trekkie-mug.js', 'fetch'], ['https://shop.example/products/perf-kit-bag.js', 'fetch'], ['https://shop.example/products/web-pixels-poster.js', 'fetch'],
    ['https://shop.example/cdn/shop/files/elevare-gold.png', 'image'], ['https://shop.example/cdn/shop/files/pintrk-littledata.css', 'stylesheet'], ['https://cdn.shopify.com/s/files/1/0/elevar-banner.png', 'image'], ['https://cdn.shopify.com/s/files/1/0/heap-font.woff2', 'font'], ['https://cheap.io/x.js'], ['https://notclarity.ms/x.js'], ['https://www.facebook.com/trees'], ['https://cheap-elevar.io/x.js']];
  const hit = [['https://cdn.heapanalytics.com/js/h.js', 'session-replay'], ['https://heap.io/x.js', 'session-replay'], ['https://www.clarity.ms/tag/abc', 'session-replay'], ['https://connect.facebook.net/en_US/fbevents.js', 'meta-pixel'], ['https://www.facebook.com/tr?id=1', 'meta-pixel'],
    ['https://shop.example/.well-known/shopify/monorail/unstable/produce_batch', 'platform-analytics'], ['https://shop.example/api/collect', 'platform-analytics'], ['https://shop.example/cdn/wpm/s123.js', 'platform-analytics'], ['https://shop.example/cdn/shopifycloud/perf-kit/shopify-perf-kit-1.2.js', 'platform-analytics'], ['https://cdn.shopify.com/s/trekkie.storefront.abc.min.js', 'platform-analytics'],
    ['https://api.elevar.io/x', 'attribution'], ['https://shopify-gtm-suite.getelevar.com/x.js', 'attribution'], ['https://cdn.littledata.io/x.js', 'attribution'], ['https://shop.example/?wc-ajax=wc_analytics', 'platform-analytics']];
  const wrongSafe = safe.filter(([u, rt, d]) => fr(u, rt, d)); const wrongHit = hit.filter(([u, n]) => fr(u, 'fetch') !== n);
  ok(!wrongSafe.length, 'named rules never stop product handles, own or allowed images, style sheets and fonts with tracker words, or look-alike hosts (cheap.io, notclarity.ms)', JSON.stringify(wrongSafe.map(([u, rt, d]) => `${u} -> ${fr(u, rt, d)}`)));
  ok(!wrongHit.length, 'named rules still stop the tracker hosts and the known tracker paths', JSON.stringify(wrongHit.map(([u, n]) => `${u} -> ${fr(u, 'fetch')} (want ${n})`)));
  // R6: own-host path rules only at the platform's real roots, never under catalog paths; first-party Google tag stopped by query shape
  const safe6 = [['https://shop.example/products/perf-kit?section_id=main', 'fetch'], ['https://shop.example/collections/perf-kit/products.json', 'fetch'], ['https://shop.example/collections/web-pixel/products.json', 'fetch'], ['https://shop.example/en-gb/products/wpm@x', 'fetch'], ['https://shop.example/pages/perf-kit', 'fetch'], ['https://shop.example/products/g/collect?v=2', 'fetch'], ['https://shop.example/collections/all/gtag/js?id=G-1', 'fetch'], ['https://shop.example/blogs/news/g/collect', 'fetch'], ['https://shop.example/products/api/collect', 'fetch']];
  const hit6 = [['https://shop.example/api/collect', 'image', 'platform-analytics'], ['https://shop.example/.well-known/shopify/monorail/unstable/produce_batch', 'image', 'platform-analytics'], ['https://shop.example/cdn/shopifycloud/perf-kit/shopify-perf-kit-1.2.js', 'script', 'platform-analytics'], ['https://shop.example/metrics/g/collect?v=2&tid=G-1', 'fetch', 'first-party-google-tag'], ['https://shop.example/metrics/gtag/js?id=G-ABC', 'script', 'first-party-google-tag'], ['https://shop.example/gtm.js?id=GTM-1', 'script', 'first-party-google-tag'], ['https://www.example-cdn.test/perf-kit/x.js', 'script', 'platform-analytics']];
  const ws6 = safe6.filter(([u, rt]) => fr(u, rt)); const wh6 = hit6.filter(([u, rt, n]) => fr(u, rt) !== n);
  ok(!ws6.length, 'own-host path rules never stop the store\'s catalog fetches (a perf-kit handle with a section fetch, /collections/web-pixel/products.json, locale paths) or loose tracker words elsewhere', JSON.stringify(ws6.map(([u, rt]) => `${u} -> ${fr(u, rt)}`)));
  ok(!wh6.length, 'own-host /api/collect and monorail sent as an image, the perf-kit root, a first-party Google tag (g/collect?v=2, gtag/js?id=G-, gtm.js?id=GTM-) and third-party perf-kit are stopped', JSON.stringify(wh6.map(([u, rt, n]) => `${u} -> ${fr(u, rt)} (want ${n})`)));
  const roots = blockRules.filter((r) => lib.isKnownRootRule(r)).map((r) => r.name);
  ok(roots.length === 1 && roots[0] === 'platform-analytics', 'only the root-anchored platform rule counts as a known tracker root (it still applies to own images and style sheets)', JSON.stringify(roots));
  // R7: endpoint rules (their stops are never a request the test may have broken)
  const ep = (name, kind, own, host = '') => lib.isTrackerEndpointRule(blockRules.find((r) => r.name === name && r.kind === kind && (kind === 'host' || r.ownHost === own)), host);
  ok(ep('first-party-google-tag', 'path', true) && ep('platform-analytics', 'path', true) && ep('platform-analytics', 'host') && ep('platform-analytics', 'path', false, 'cdn.shopify.com') && !ep('platform-analytics', 'path', false, 'widgets.example') && !lib.isTrackerEndpointRule(blockRules.find((r) => r.name === 'attribution' && r.kind === 'path')) && lib.isTrackerEndpointRule(blockRules.find((r) => r.name === 'attribution' && r.kind === 'path'), 'cdn.shopify.com') && !lib.isTrackerEndpointRule(blockRules.find((r) => r.name === 'attribution' && r.kind === 'host')), 'endpoint rules: the first-party Google tag, the platform analytics roots and hosts, and the loose platform and attribution path rules on cdn.shopify.com only');
  // R8: Triple Whale's pixel served from an app extension on cdn.shopify.com is an attribution endpoint, never a rule hit on an allowed host
  { const u = 'https://cdn.shopify.com/extensions/0190-abc/triple-pixel-12/assets/triple-pixel.js'; const r = lib.findBlockRule(blockRules, u, { ownHosts: own, allowHosts: blockCfg.allow_hosts, resourceType: 'script' });
    ok(r?.name === 'attribution' && lib.isTrackerEndpointRule(r, 'cdn.shopify.com') && fr('https://cdn.shopify.com/extensions/0190-abc/judgeme-1/assets/loader.js') === null, 'the attribution path rule stops triple-pixel.js on cdn.shopify.com as an endpoint; other app extensions pass', r?.name); }
  // R8: every loose third-party path rule in the blocklist is scoped: endpoint_hosts, or not an endpoint at all
  ok(blockCfg.rules.filter((r) => r.kind === 'path' && r.own_host === false).every((r) => Array.isArray(r.endpoint_hosts) && !r.endpoint), 'every third-party path rule is an endpoint only on named hosts (endpoint_hosts), never everywhere');
  // R8: loose endpoint rules from the review are refused
  const loose8 = ['(^|/)assets/(\\?x=)?', '(^|/)[^?]*\\?*=?', '^/.*\\.js', '^/(.*/)?assets/'];
  const bad8 = [];
  for (const pth of loose8) for (const own_host of [true, false]) if (!builtinRule({ name: 'x', kind: 'path', path: pth, own_host, endpoint: true }).err) bad8.push(`${pth} own_host ${own_host}`);
  if (!builtinRule({ name: 'x', kind: 'path', path: '(^|/)extensions/', own_host: false, endpoint_hosts: ['cdn.shopify.com'] }).err) bad8.push('endpoint_hosts (^|/)extensions/');
  if (!builtinRule({ name: 'x', kind: 'path', path: '^/apps/', own_host: true, endpoint: true }).err) bad8.push('^/apps/ (matches a probe path)');
  if (!builtinRule({ name: 'x', kind: 'path', path: '(^|/)x\\?(a=1)?', own_host: true, endpoint: true }).err) bad8.push('optional parameter');
  ok(!bad8.length, 'compileBlockRule refuses loose endpoint rules: an optional or quantified "\\?", a wildcard or optional group before the first "/", a pattern that matches ordinary store paths', JSON.stringify(bad8));
  ok(!builtinRule({ name: 'x', kind: 'path', path: '(^|/)g/collect\\?(.*&)?v=2', own_host: true, endpoint: true }).err && /must not match ordinary store paths/.test(builtinRule({ name: 'x', kind: 'path', path: '(^|/)assets/', own_host: false, endpoint_hosts: ['cdn.shopify.com'] }).err || ''), 'a required query endpoint passes; an endpoint_hosts rule that matches /assets/theme.css is refused by the behaviour check');
  ok(lib.hostRuleCovers(blockRules.find((r) => r.name === 'email-sms-marketing'), 'static.klaviyo.com') && !lib.hostRuleCovers(blockRules.find((r) => r.name === 'helpdesk-chat-events'), 'gorgias.chat') && !lib.hostRuleCovers(blockRules.find((r) => r.name === 'review-app-events'), 'judge.me') && lib.hostRuleCovers(blockRules.find((r) => r.name === 'email-sms-marketing'), '*.klaviyo.com'), 'hostRuleCovers: a bare host entry covers its subdomains and wildcard entries; a host rule with a path or a path prefix does not');
  const v7 = (r) => checkBuiltin(r).join(' ');
  ok(/"endpoint": true is only for/.test(v7({ name: 'x', kind: 'path', path: '(^|/)perf-kit(/|$)', own_host: false, endpoint: true })) && /"endpoint": true is only for/.test(v7({ name: 'x', kind: 'path', path: '^/a|(^|/)b\\?c=1', own_host: true, endpoint: true })) && !v7({ name: 'x', kind: 'path', path: '^/abc/x|^(/[a-z]{2}(-[a-z]{2})?)?/bcd/|^(/[a-z]{2,3}(-[a-z0-9]{2,4})?)?/cde@', own_host: true, endpoint: true }).length && !v7({ name: 'x', kind: 'path', path: '(^|/)g/collect\\?(.*&)?v=2', own_host: true, endpoint: true }).length && !v7({ name: 'x', kind: 'host', hosts: ['a.example'], endpoint: true }).length && /endpoint_hosts/.test(v7({ name: 'x', kind: 'path', path: '^/a', own_host: true, endpoint_hosts: ['cdn.shopify.com'] })) && /endpoint_hosts/.test(v7({ name: 'x', kind: 'path', path: '(^|/)a', own_host: false, endpoint_hosts: ['shopify.'] })) && /"endpoint" must be/.test(v7({ name: 'x', kind: 'host', hosts: ['a.example'], endpoint: 'yes' })), 'the validator allows "endpoint": true only on host rules and on all-root (optionally locale-prefixed) or all-query path rules, and "endpoint_hosts" only on third-party path rules with full host names');
  // R7 LOW: a locale prefix before the own-host wpm, monorail and web-pixels roots; the catalog exemption still holds
  const loc = [['https://shop.example/zh-hant/cdn/wpm/s1.js', 'script'], ['https://shop.example/es-419/.well-known/shopify/monorail/unstable/produce_batch', 'fetch'], ['https://shop.example/en-gb/api/collect', 'fetch'], ['https://shop.example/en-gb/wpm@0d2a8d5e/custom/web-pixel-1@1/sandbox/modern/', 'script'], ['https://shop.example/fr/.well-known/shopify/monorail/unstable/produce_batch', 'fetch'], ['https://shop.example/de/cdn/wpm/s1.js', 'script'], ['https://shop.example/en-us/web-pixels-manager@1/sandbox/', 'script'], ['https://shop.example/es/cdn/web-pixels@1/x.js', 'script']].filter(([u, rt]) => fr(u, rt) !== 'platform-analytics');
  const locSafe = [['https://shop.example/zh-hant/products/wpm@x', 'fetch'], ['https://shop.example/es-419/collections/x/products.json?x=wpm@', 'fetch'], ['https://shop.example/en-gb/products/wpm@x', 'fetch'], ['https://shop.example/fr/collections/web-pixels@1/products.json', 'fetch'], ['https://shop.example/en-gb/pages/wpm@x', 'fetch'], ['https://shop.example/english/wpm@x', 'script']].filter(([u, rt]) => fr(u, rt));
  ok(!loc.length && !locSafe.length, 'own-host wpm, monorail and web-pixels roots are stopped after a two-letter locale prefix (/en-gb/, /fr/); locale catalog paths and other paths are not', JSON.stringify({ missed: loc, wrong: locSafe.map(([u, rt]) => `${u} -> ${fr(u, rt)}`) }));
  ok(/too loose/.test(checkBuiltin({ name: 'x', kind: 'path', path: '(^|/)perf-kit(/|$)', own_host: true }).join(' ')) && !checkBuiltin({ name: 'x', kind: 'path', path: '(^|/)perf-kit(/|$)', own_host: false }).length, 'the validator refuses a free (^|/) own-host path rule without a query, and allows it as a third-party rule');
  ok(fr('https://www.clarity.ms/tag/abc', 'document', true) === null && fr('https://www.clarity.ms/x', 'image') === 'session-replay', 'named rules never stop a document; a tracker host image (not own or allowed) is still stopped');
}
const engines = [];
for (const [name, type] of [['chromium', chromium]]) {
  try { engines.push([name, await type.launch({ args: ['--disable-features=LocalNetworkAccessChecks'] })]); } catch (e) {
    console.error(`Cannot start ${name}: ${lib.oneLine(e.message, 160)}\nInstall it with: npx playwright install chromium`); process.exit(2);
  }
}
for (const [name, browser] of engines) {
  const mk = async (opts = {}) => {
    const ctx = await browser.newContext(); ctx.setDefaultTimeout(30000);
    const state = {}; const stops = []; const tp = []; const iv = [];
    let page;
    const loaded = []; const tabs = [];
    if (!opts.noGuard) await lib.installGuard(ctx, { state, getPage: () => page, blockRules, allowHosts: opts.allowHosts || blockCfg.allow_hosts, ownHosts: new Set(['127.0.0.1']), landingPaths: new Set(['/product/beeswax-taper']), delayMs: 0, throttle: opts.throttle || null, onCheckout: (r) => stops.push(r), onThirdParty: (r) => tp.push(r), onIntervention: (r) => iv.push(r) });
    lib.watchContext(ctx, (how) => loaded.push(how), (p) => tabs.push(p));
    page = await ctx.newPage();
    // a new journey in the same test context: the sticky after-cart state of the one before is dropped
    const fresh = () => { state.cartFrom = null; state.cartPages = []; };
    return { ctx, page, state, stops, tp, iv, loaded, tabs, fresh };
  };
  const waitTab = async (t, n = 1) => { for (let i = 0; i < 40 && t.tabs.length < n; i++) await sleep(100); const p = t.tabs[n - 1]; if (p) await p.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {}); await sleep(1200); return p; };
  const before = { ...server.hits };
  const newHits = (p) => (server.hits[p] || 0) - (before[p] || 0);
  let t = await mk();
  await t.page.goto(`${O}/redir-hop`).catch(() => {});
  ok(t.stops.some((s) => /server redirect/.test(s.why) && /\/(checkouts\/cn\/redirected|redir-to-checkout)/.test(s.url)) && !newHits('/checkouts/cn/redirected'), `${name}: a two-hop redirect to checkout is stopped (at the first hop whose address names a checkout)`, JSON.stringify(t.stops));
  await t.page.goto(`${O}/collections/gifts`);
  const fetched = await t.page.evaluate(async () => {
    const out = {};
    for (const [k, u, m] of [['woo', '/checkout/', 'GET'], ['ajax', '/?wc-ajax=checkout', 'POST'], ['own', '/collections/new-arrivals', 'GET']]) { try { out[k] = (await fetch(u, { method: m })).status; } catch { out[k] = 'blocked'; } }
    return out;
  });
  ok(fetched.woo === 'blocked' && fetched.ajax === 'blocked', `${name}: fetches to /checkout/ and ?wc-ajax=checkout are stopped`, JSON.stringify(fetched));
  ok(fetched.own === 200, `${name}: a normal store fetch passes`);
  const third = await t.page.evaluate(async (port) => { try { await fetch(`http://localhost:${port}/pixel.js`); return 'loaded'; } catch { return 'blocked'; } }, PORT);
  ok(third === 'blocked' && t.tp.some((x) => x.blocked && x.host === 'localhost' && x.name === 'not-allow-listed'), `${name}: a host not on the allow-list is blocked and logged`);
  const collect = await t.page.evaluate(async () => { try { await fetch('/api/collect?e=x'); return 'sent'; } catch { return 'blocked'; } });
  ok(collect === 'blocked' && t.tp.some((x) => x.blocked && x.name === 'platform-analytics' && x.host === ''), `${name}: a named rule blocks an own-host analytics path without listing the own host`);
  await t.ctx.close();
  ok(newHits('/checkouts/cn/redirected') === 0 && newHits('/checkout/') === 0 && newHits('/api/collect') === 0, `${name}: the fixture never received a checkout or analytics request`);

  // item: a checkout on a non-English slug, reached by a buy-now redirect, a target=_blank link, or a frame, never loads
  t = await mk();
  const kasse0 = newHits('/kasse/');
  await t.page.goto(`${O}/product/beeswax-taper/?buy-now=1`).catch(() => {});
  await sleep(800);
  const bn = t.stops.find((s) => /unknown redirect target, not fetched/.test(s.why) && /\/kasse\/$/.test(s.url));
  ok(!!bn && bn.reached_server === false && bn.hops?.length === 2 && bn.hops[0].method === 'GET' && /buy-now|beeswax/.test(bn.hops[0].url) && bn.hops[1].method === 'GET', `${name}: a buy-now redirect to an unknown page (/kasse/) is stopped WITHOUT fetching it, with each hop and its real method recorded`, JSON.stringify(t.stops));
  ok(newHits('/kasse/') === kasse0, `${name}: the buy-now redirect sent no request to /kasse/`, String(newHits('/kasse/') - kasse0));
  t.fresh(); await t.page.goto(`${O}/buy-form/`);
  const k1 = newHits('/kasse/'); const nPost = t.stops.length;
  await t.page.click('#go'); await sleep(1200);
  const ps = t.stops.slice(nPost).find((s) => /unknown redirect target, not fetched \(a redirect after POST/.test(s.why));
  ok(!!ps && ps.hops[0].method === 'POST' && ps.hops[1].method === 'GET' && ps.method === 'GET' && !ps.reached_server && newHits('/kasse/') === k1, `${name}: a form POST that redirects (303) to an unknown page is stopped before that page is requested; the hops say POST then GET`, JSON.stringify(t.stops.slice(nPost)));
  ok(!t.loaded.length && !/\/kasse/.test(t.page.url()), `${name}: the buy-now checkout never loaded`, JSON.stringify(t.loaded));
  t.fresh(); await t.page.goto(`${O}/buy-form-bad/`);
  const bp0 = newHits('/buy-post'); const nIv = t.iv.length;
  await t.page.click('#go'); await sleep(1200);
  ok(newHits('/buy-post') === bp0 && t.iv.slice(nIv).some((r) => r.kind === 'dispatch' && /not a Shopify cart operation/.test(r.what)), `${name}: a form POST to a path that is not a Shopify cart operation (/buy-post) is never sent, and is reported as a guard intervention`, JSON.stringify(t.iv.slice(nIv)));
  // R25 C#5: every redirect hop is checked with that hop's own method and body
  t.fresh(); await t.page.goto(`${O}/collections/gifts`); r25Got.length = 0;
  const hopRes = await t.page.evaluate(async () => {
    const out = {}; const J = { 'content-type': 'application/json' }; const F = { 'content-type': 'application/x-www-form-urlencoded' };
    for (const [k, u, h, b] of [['keep307', '/it/cart/update.js', J, '{"note":"r25"}'], ['keep308', '/it/cart/change.js', J, '{"line":1,"quantity":1}'], ['sink307', '/nl/cart/add.js', F, 'id=1&quantity=1'], ['sink308', '/pt/cart/add.js', F, 'id=1&quantity=1'], ['sink303', '/sv/cart/add.js', F, 'id=1&quantity=1'], ['q307', '/da/cart/add.js', F, 'id=1&quantity=1']]) {
      try { out[k] = (await fetch(u, { method: 'POST', headers: h, body: b })).status; } catch { out[k] = 'blocked'; }
    }
    return out;
  });
  const got = (u) => r25Got.filter((g) => g.url === u);
  ok(hopRes.keep307 === 200 && hopRes.keep308 === 200 && got('/es/cart/update.js').length === 1 && got('/es/cart/update.js')[0].method === 'POST' && got('/es/cart/update.js')[0].body === '{"note":"r25"}' && got('/es/cart/change.js').length === 1 && got('/es/cart/change.js')[0].body === '{"line":1,"quantity":1}',
    `${name}: a 307 and a 308 between two allowed cart operations are checked and sent with the same method and JSON body`, JSON.stringify({ hopRes, r25Got }));
  ok(hopRes.sink307 === 'blocked' && hopRes.sink308 === 'blocked' && hopRes.q307 === 'blocked' && hopRes.sink303 === 200 && got('/r25-sink').length === 1 && got('/r25-sink')[0].method === 'GET' && !r25Got.some((g) => /return_to/.test(g.url)),
    `${name}: a 307 or 308 that would carry a cart POST to another path, or to a cart operation with a return_to key, is never sent; a 303 becomes a GET and is`, JSON.stringify({ hopRes, r25Got }));
  t.fresh(); await t.page.goto(`${O}/product/beeswax-taper`);
  const nStops = t.stops.length;
  await t.page.click('#kasse-tab');
  const tab = await waitTab(t);
  ok(!!tab && t.stops.slice(nStops).some((s) => /checkout page content/.test(s.why) && !s.main_frame && s.reached_server === true && /reached the store's server but was not shown/.test(s.why)), `${name}: a target=_blank checkout link in a new tab is stopped by its content and recorded as reached the store's server but was not shown`, JSON.stringify(t.stops.slice(nStops)));
  ok(!t.loaded.length && !(tab && /\/kasse/.test(tab.url())), `${name}: the new tab never loaded the checkout`, `${JSON.stringify(t.loaded)} ${tab && tab.url()}`);
  const acc0 = newHits('/account/');
  await t.page.evaluate(() => { const f = document.createElement('iframe'); f.src = '/account/'; document.body.appendChild(f); });
  await sleep(1200);
  ok(newHits('/account/') === acc0 && t.stops.some((s) => /\/account\/$/.test(s.url)), `${name}: an iframe to the account (login) page is stopped before any request is sent`, JSON.stringify(t.stops.slice(-2)));
  const api = await t.page.evaluate(async () => { const out = {}; for (const [k, u] of [['rest', '/?rest_route=/wc/store/v1/checkout'], ['path', '/wp-json/wc/store/v1/checkout']]) { try { out[k] = (await fetch(u, { method: 'POST', body: '{}' })).status; } catch { out[k] = 'blocked'; } } return out; });
  ok(api.rest === 'blocked' && api.path === 'blocked', `${name}: Store API checkout calls are stopped`, JSON.stringify(api));
  ok(!t.loaded.length, `${name}: no checkout page loaded in any tab or frame (measured)`, JSON.stringify(t.loaded));
  ok(newHits('/kasse/') === kasse0 + 1, `${name}: the only /kasse/ request was the one content check of the first new tab before the Checkout tap (an ordinary GET; fetched, never shown)`, String(newHits('/kasse/') - kasse0));

  // item: the Store API cart count works for the Cart block, falls back to ?rest_route=, and says unknown (never 0) when unreadable
  await t.page.goto(`${O}/product/beeswax-taper`);
  const c0 = await t.page.evaluate(lib.readCartCount, 'woocommerce'); // the buy-now link above may have put one in
  // R25 B: a WooCommerce add-to-cart form posts to the product page, which is not a Shopify cart operation: never sent
  const nIvW = t.iv.length; const w0 = newHits('/product/beeswax-taper');
  await t.page.click('.single_add_to_cart_button'); await sleep(1200);
  await t.page.goto(`${O}/product/beeswax-taper`);
  const c1 = await t.page.evaluate(lib.readCartCount, 'woocommerce');
  ok(typeof c0.count === 'number' && c0.count >= 1 && c1.count === c0.count && /wp-json/.test(c1.source) && newHits('/product/beeswax-taper') === w0 + 1 && t.iv.slice(nIvW).some((r) => r.kind === 'dispatch' && /not a Shopify cart operation/.test(r.what)), `${name}: a WooCommerce add-to-cart POST is stopped by the write allow-list (the count stays the same; the only new product page request is the reload)`, JSON.stringify([c0, c1, t.iv.slice(nIvW)]));
  await t.page.goto(`${O}/warenkorb/`);
  const rowsShown = await t.page.waitForSelector('.wc-block-cart-items__row', { timeout: 10000 }).then(() => true).catch(() => false);
  ok(rowsShown && await t.page.evaluate(() => /Beeswax/.test(document.body.innerText)), `${name}: the Cart block page shows the item (rendered from the Store API)`);
  server.flags.wpJson = false;
  const c2 = await t.page.evaluate(lib.readCartCount, 'woocommerce');
  ok(c2.count === c1.count && /rest_route/.test(c2.source), `${name}: without pretty links the count comes from ?rest_route=`, JSON.stringify(c2));
  server.flags.restRoute = false;
  const c3 = await t.page.evaluate(lib.readCartCount, 'woocommerce');
  ok(c3.count === null, `${name}: an unreadable cart count is unknown (null), not 0`, JSON.stringify(c3));
  server.flags.restRoute = true;
  server.flags.wpJson = true;
  await t.ctx.close();

  // the watcher measures checkout by content, in new tabs too (no guard here, on purpose, to prove the measurement works)
  t = await mk({ noGuard: true });
  await t.page.goto(`${O}/kasse/`);
  await sleep(800);
  ok(t.loaded.some((x) => /checkout content \(body\.woocommerce-checkout\)/.test(x)), `${name}: checkout_page_loaded is measured by page content on an unknown slug`, JSON.stringify(t.loaded));
  await t.page.goto(`${O}/product/beeswax-taper`);
  const nLoaded = t.loaded.length;
  await t.page.click('#kasse-tab'); await waitTab(t);
  ok(t.loaded.length > nLoaded, `${name}: a checkout opened in a new tab is measured too`, JSON.stringify(t.loaded));
  await t.ctx.close();

  // N1: speculation rules (inline document rules, rules added by script, a Speculation-Rules header) never fetch or show a checkout
  for (const sp of ['/spec-cart/', '/spec-inject/', '/spec-header/']) {
    t = await mk();
    const h0 = { co: newHits('/checkout/'), a: newHits('/checkouts/cn/spec-doc'), b: newHits('/checkouts/cn/spec-js'), c: newHits('/checkouts/cn/spec-hdr') };
    const specReqs0 = server.requests.length;
    await t.page.goto(`${O}${sp}`); await sleep(2500);
    await t.page.click('#co').catch(() => {}); await sleep(1500);
    const shown = await t.page.evaluate(() => document.body.innerText).catch(() => '');
    const purposeReqs = server.requests.slice(specReqs0).filter((r) => /prefetch|prerender/i.test(r.headers['sec-purpose'] || r.headers.purpose || ''));
    ok(newHits('/checkout/') === h0.co && newHits('/checkouts/cn/spec-doc') === h0.a && newHits('/checkouts/cn/spec-js') === h0.b && newHits('/checkouts/cn/spec-hdr') === h0.c && !purposeReqs.length, `${name} ${sp}: the store's server logged no checkout request and no prefetch or prerender request`, JSON.stringify(purposeReqs.map((r) => r.url)));
    ok(!t.loaded.length && !/CHECKOUT|^\s*Checkout\s*$/m.test(shown) && /Your cart/.test(shown) && t.stops.some((s) => /\/checkout\/$/.test(s.url)), `${name} ${sp}: a Checkout click by the page is stopped and no checkout page is ever shown`, `${JSON.stringify(t.loaded)} ${shown.slice(0, 80)}`);
    await t.ctx.close();
  }

  // R4 item 1: beacons, keepalive fetches and service workers. The page sends on pagehide and visibilitychange; the server must log none.
  {
    const bad = ['/tp-beacon', '/checkouts/cn/beacon', '/checkouts/cn/iframe-beacon', '/tp-iframe-keep', '/tp-keep', '/checkouts/cn/keep', '/checkouts/cn/keep-req', '/sw.js'];
    const req0 = server.requests.length; const hits0 = Object.fromEntries([...bad, '/api/collect', '/own-keep'].map((p) => [p, newHits(p)]));
    t = await mk();
    await t.page.goto(`${O}/unload/`); await t.page.waitForLoadState('load'); await sleep(600);
    const sw = await t.page.evaluate(() => window.__sw);
    const probe = await t.page.evaluate(() => fetch('/sw-probe').then((r) => r.text()));
    await t.page.goto(`${O}/product/beeswax-taper`); await sleep(1500); // pagehide fires on the way out
    const reqs = server.requests.slice(req0);
    const leaked = reqs.filter((r) => /localhost/.test(r.host) || /^\/(checkouts|api\/collect|sw\.js)/.test(r.url.split('?')[0]) || /\/tp-/.test(r.url));
    ok(!leaked.length && bad.every((p) => newHits(p) === hits0[p]) && newHits('/api/collect') === hits0['/api/collect'], `${name}: beacons and keepalive requests sent on pagehide to a tracker, a host off the allow-list and /checkouts/ never reach the server (iframe and Request object included)`, JSON.stringify(leaked.map((r) => `${r.host}${r.url}`)));
    ok(newHits('/own-keep') === hits0['/own-keep'], `${name}: a keepalive write (POST) is dropped even to the store's own host, because it outlives the page`, String(newHits('/own-keep') - hits0['/own-keep']));
    ok(/^rejected/.test(sw) && probe === 'FROM-SERVER', `${name}: service worker registration is refused and no worker answers a fetch`, `${sw} ${probe}`);
    await t.ctx.close();
    // the drop count reaches the results, and a page that never unloads gets true from sendBeacon and a 204-free own-host keepalive
    const dropped = []; const ctx2 = await browser.newContext(); let p2;
    await lib.installGuard(ctx2, { state: {}, getPage: () => p2, blockRules, allowHosts: blockCfg.allow_hosts, ownHosts: new Set(['127.0.0.1']), landingPaths: new Set(), delayMs: 0, throttle: null, onCheckout: () => {}, onThirdParty: () => {}, onBeacon: (d) => dropped.push(d) });
    p2 = await ctx2.newPage();
    await p2.goto(`${O}/unload-visible/`); await sleep(800);
    const r = await p2.evaluate(() => window.__r);
    ok(r[0] === true && r[1] === 204 && dropped.some((d) => d.kind === 'keepalive' && /\/own-keep-live$/.test(d.url)) && dropped.some((d) => d.kind === 'beacon' && /^http:\/\/127\.0\.0\.1:\d+\/api\/collect$/.test(d.url)), `${name}: a dropped beacon still returns true to the page and is counted (full address), and an own-host keepalive write is dropped with a quiet 204 and counted`, JSON.stringify({ r, dropped }));
    await ctx2.close();
  }

  // F2: a usable page needs a heading of any common kind, not only an h1
  t = await mk();
  for (const [u, want] of [['/usable/h2/', 'h2'], ['/usable/ld/', 'ld+json product name'], ['/usable/title/', 'product title']]) {
    await t.page.goto(`${O}${u}`); await t.page.waitForLoadState('load');
    const r = await t.page.evaluate(lib.readUsable);
    ok(r.ok && r.heading === want, `${name}: a product page with no h1 is usable (${want})`, JSON.stringify(r));
  }
  await t.page.goto(`${O}/usable/none/`); await t.page.waitForLoadState('load');
  const rn = await t.page.evaluate(lib.readUsable);
  ok(!rn.ok && rn.img && !rn.heading, `${name}: a page with a photo but no heading the panel knows is reported as not recognised (the runner turns that into a tool limit)`, JSON.stringify(rn));
  // F3: WooCommerce block-theme grids are recognised; a grid the panel does not know is told apart from "no products"
  await t.page.goto(`${O}/shop-block/`);
  const bl = await t.page.evaluate(lib.readGridLinks, { sel: lib.SEL, linkSrc: '/products?/[^/?#]+' });
  ok(bl.length === 1 && bl[0].path === '/product/beeswax-taper/' && bl[0].cardHasPrice, `${name}: a WooCommerce block-theme product grid (wc-block-product-template) is recognised`, JSON.stringify(bl));
  await t.page.goto(`${O}/shop-odd/`);
  const oddG = await t.page.evaluate(lib.readGridLinks, { sel: lib.SEL, linkSrc: '/products?/[^/?#]+' });
  const oddL = await t.page.evaluate(lib.countProductLinks, { sel: lib.SEL, linkSrc: '/products?/[^/?#]+' });
  ok(!oddG.length && oddL === 1, `${name}: product links outside a known grid are counted, so a tool miss is not reported as "no products"`, `${oddG.length} ${oddL}`);
  await t.ctx.close();

  // item: Dawn's tall sticky info column keeps its price; a short sticky bar and a fixed bar do not count. Phone and desktop widths.
  t = await mk();
  for (const [w, h] of [[390, 844], [1280, 800]]) {
    await t.page.setViewportSize({ width: w, height: h });
    await t.page.goto(`${O}/products/dawn-tote`);
    const pos = await t.page.evaluate(() => { const c = document.querySelector('.product__column-sticky'); return { pos: getComputedStyle(c).position, h: c.getBoundingClientRect().height, vh: innerHeight }; });
    const cands = await t.page.evaluate(lib.readPriceCandidates, lib.SEL);
    const rp = lib.resolvePrice(cands, { value: 42, source: 'ld+json offers.price' });
    ok(rp.price && rp.price.value === 42 && rp.price.in_product_block && rp.price.matches_structured && !rp.price.unrecognised_format, `${name} ${w}px: Dawn price $42.00 found in the info column (column is ${pos.pos}, ${Math.round(pos.h)}px of ${pos.vh}px)`, JSON.stringify({ rp, n: cands.length }));
    ok(!cands.some((c) => /99\.00|35\.00/.test(c.text)), `${name} ${w}px: the short sticky bar and the fixed bar are not price candidates`, JSON.stringify(cands.map((c) => c.text)));
    if (w === 1280) ok(pos.pos === 'sticky' && pos.h > pos.vh * 0.3, `${name}: at 1280px the Dawn info column really is a tall position:sticky box`, JSON.stringify(pos));
  }
  await t.ctx.close();

  t = await mk({ allowHosts: ['localhost'] });
  await t.page.goto(`${O}/collections/gifts`);
  const allowed = await t.page.evaluate((port) => new Promise((res) => { const sc = document.createElement('script'); sc.src = `http://localhost:${port}/pixel.js`; sc.onload = () => res('loaded'); sc.onerror = () => res('blocked'); document.head.appendChild(sc); setTimeout(() => res('timeout'), 8000); }), PORT);
  const allowedFetch = await t.page.evaluate(async (port) => { try { await fetch(`http://localhost:${port}/pixel.js`, { mode: 'no-cors' }); return 'loaded'; } catch { return 'blocked'; } }, PORT);
  ok(allowed === 'loaded' && t.tp.some((x) => !x.blocked && x.host === 'localhost'), `${name}: an allow-listed host serves a script and is logged as allowed`, allowed);
  ok(allowedFetch === 'blocked', `${name}: a fetch to an allow-listed host is stopped (--allow-host covers static GET and HEAD only)`, allowedFetch);
  await t.ctx.close();

  t = await mk({ throttle: { down_kbps: 100, latency_ms: 50 } });
  const t0 = Date.now(); await t.page.goto(`${O}/big`); const ms = Date.now() - t0;
  ok(ms > 1200, `${name}: fulfilled pages are throttled to the persona's speed`, `${ms}ms`);
  await t.ctx.close();
}
for (const [, b] of engines) await b.close();
// R4 item 1, the browser-level request guard on its own (Chromium): no init script, no route
{
  const cb = await chromium.launch({ args: ['--disable-features=LocalNetworkAccessChecks'] });
  const drops = []; let pol = null;
  const ng = await lib.installBrowserNetGuard(cb, () => pol, (d) => drops.push(d));
  ok(!!ng, 'chromium: the browser-level request guard attaches');
  const ctx = await cb.newContext(); const pg = await ctx.newPage();
  ok(typeof lib.attachCdpBlock === 'undefined' && typeof lib.cdpBlockPatterns === 'undefined', 'the page-level CDP block (which ran before ctx.route and hid stops from the counts) is gone');
  await pg.goto(`${O}/unload-visible/`); await sleep(300);
  pol = { blockRules, allowHosts: blockCfg.allow_hosts, ownHosts: new Set(['127.0.0.1']) };
  await sleep(300); const req0 = server.requests.length;
  await pg.goto(`${O}/unload/`); await pg.waitForLoadState('load'); await sleep(400);
  await pg.goto(`${O}/product/beeswax-taper`); await sleep(1500);
  const leaked = server.requests.slice(req0).filter((r) => /localhost/.test(r.host) || /^\/(checkouts|api\/collect)/.test(r.url.split('?')[0]) || /\/tp-/.test(r.url));
  ok(!leaked.length && drops.length >= 3, 'chromium: with no page script, the browser-level guard alone stops unload beacons and keepalive requests', JSON.stringify({ leaked: leaked.map((r) => `${r.host}${r.url}`), drops: drops.length }));
  ok(drops.every((d) => /^https?:/.test(d.url) && d.method && d.resourceType && 'rule' in d && typeof d.host === 'string') && drops.some((d) => d.kind === 'hard' && /^checkout/.test(d.why)) && drops.some((d) => d.kind !== 'hard' && (d.rule || d.host)), 'chromium: each browser-guard stop reports its rule, host, method and kind, so the runner adds it to the same blocked, by-rule, host and checkout counts as a route stop', JSON.stringify(drops.slice(0, 4)));
  await cb.close();
}

// ---------- Part 3: the runner, end to end ----------
section('Part 3: the runner end to end (Chromium at iPhone and Pixel sizes)');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shopper-panel-test-'));
// R25 A: the runner reads the home page "/" before it starts and runs only on a Shopify Online Store theme, so every small test store
// below answers "/" (and only "/", no query) with a Shopify home page; that request never reaches the test's own handler
const SHOP_HOME = '<!doctype html><html><head><title>Test store</title><script>window.Shopify = window.Shopify || {}; Shopify.theme = {"name":"Dawn","id":1,"role":"main"};</script></head><body><h1>Test store</h1></body></html>';
// R26: the runner's platform check also reads /cart.js (its user agent says "platform check"), which must answer as a Shopify cart; the
// tests' own /cart.js handlers (cart counts) are left as they are for every other request
const SHOP_CART_JS = JSON.stringify({ token: 'test-cart', note: null, attributes: {}, total_price: 0, item_count: 0, items: [], currency: 'USD', requires_shipping: false });
const shopServer = (h) => nodeHttp.createServer((q, r) => {
  if ((q.method === 'GET' || q.method === 'HEAD') && q.url === '/') { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return r.end(SHOP_HOME); }
  if (q.method === 'GET' && q.url === '/cart.js' && /platform check/.test(q.headers['user-agent'] || '')) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end(SHOP_CART_JS); }
  return h(q, r);
});
const pdir = path.join(tmp, 'personas'); fs.mkdirSync(pdir);
const base = { status: 'active', evidence: 'inferred', who: 'test shopper', voice_line: 'test', shopping_for: 'a candle', quits_when: 'test', success_goal: 'test', based_on: ['offline test'], network: { name: 'no throttle', latency_ms: 0, down_kbps: null, up_kbps: null }, patience: { load_seconds: 20, max_screens_to_price: 4, max_taps_to_checkout: 25 }, photos_to_view: 2 };
const personas = [];
for (const [dev, eng] of [['iphone-14', 'wk'], ['pixel-7', 'cr']]) {
  personas.push({ ...base, id: `linen-${eng}`, name: `Linen ${eng}`, device: dev, main_quit_reason: `linen check ${eng}`, popups: 'close-once', entry_point: { channel: 'direct', landing_path: '/products/linen-and-cedar-candle' },
    before_buying: [
      { need: 'shipping days (inside the closed accordion)', look_for: ['ships in \\d'], if_missing: 'quit' },
      { need: 'the wick upgrade (hidden option text)', look_for: ['wooden wick'], if_missing: 'warn' },
      { need: 'a rating (lazy review widget)', look_for: ['rated \\d'], if_missing: 'warn', look_in: 'reviews' },
      { need: 'member price (only in a sticky bar)', look_for: ['member price'], if_missing: 'warn' },
      { need: 'related products (outside the product block)', look_for: ['also like'], if_missing: 'warn' },
      { need: 'free returns (header and footer only)', look_for: ['free returns'], if_missing: 'warn' },
      { need: 'a rating in the product block', look_for: ['rated \\d'], if_missing: 'warn' },
    ],
    choices: [{ option: 'size', pick: '12 oz' }], product_pick: null });
}
personas.push({ ...base, id: 'grid-wk', name: 'Grid wk', device: 'iphone-14', main_quit_reason: 'grid check', popups: 'close-once', entry_point: { channel: 'instagram', landing_path: '/collections/gifts' }, product_pick: 'holiday gift box|gift set', before_buying: [{ need: 'gift box', look_for: ['comes boxed'], if_missing: 'warn' }], choices: [{ option: 'box colou?r', pick: 'sage' }] });
// R25: v1 is Shopify only, so the cart-checks shopper lands on a Shopify product and uses the Shopify cart's discount box and estimator
personas.push({ ...base, id: 'ember-cr', name: 'Ember cr', device: 'pixel-7', main_quit_reason: 'cart checks', popups: 'leave', in_app_browser: 'facebook', network: { name: 'test 4G', latency_ms: 40, down_kbps: 6000, up_kbps: 2000 }, entry_point: { channel: 'ad', landing_path: '/products/autumn-ember-candle' }, product_pick: null, before_buying: [{ need: 'a seasonal scent', look_for: ['limited run'], if_missing: 'quit' }, { need: 'reviews', look_for: ['out of 5'], if_missing: 'warn', look_in: 'both' }], choices: [] });
personas.push({ ...base, id: 'quit-wk', name: 'Quit wk', device: 'iphone-14', main_quit_reason: 'shipping unclear', entry_point: { channel: 'email', landing_path: '/collections/new-arrivals' }, product_pick: 'seasonal', before_buying: [{ need: 'free shipping threshold', look_for: ['free shipping'], if_missing: 'quit' }], choices: [] });
for (const p of personas) { const errs = checkPersona(p); ok(!errs.length, `test persona ${p.id} is valid`, errs.join('; ')); fs.writeFileSync(path.join(pdir, `${p.id}.json`), JSON.stringify(p)); }

// Ctrl-C for a child runner. On Windows child.kill("SIGINT") ends the child at once, so there the test-only stdin "stop" line
// (SP_TEST_STDIN_STOP, honoured only for a loopback --url) does the same job; elsewhere the real signal is sent.
process.env.SP_TEST_STDIN_STOP = '1';
const interrupt = (child) => { if (process.platform === 'win32') { try { child.stdin.write('stop\n'); } catch {} } else child.kill('SIGINT'); };
const runPanel = (extra, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(root, 'scripts/shopper-panel.mjs'), ...extra], { cwd: tmp, env: { ...process.env, SP_TEST_JOURNEY_CAP_SECONDS: '90', ...env } });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  // The runner's journey watchdog (capped at 90 s per journey here, through SP_TEST_JOURNEY_CAP_SECONDS) ends a hung journey, so this
  // killer is only a backstop: the longest run below has 7 journeys, 7 x 90 s plus browser start-up stays under 12 minutes.
  const killer = setTimeout(() => child.kill("SIGKILL"), 12 * 60 * 1000);
  child.on('exit', (code) => { clearTimeout(killer); resolve({ code, out, err }); });
});
// For runs a loaded machine can slow down: a longer journey cap, and one fresh run again when a journey timed out (the watchdog, not
// the store). The out folder is emptied first, so the checks read the second run only.
const runPanelTolerant = async (extra, outName) => {
  const once = () => runPanel(extra, { SP_TEST_JOURNEY_CAP_SECONDS: '180' });
  let r = await once();
  const dir = path.join(tmp, outName);
  const timedOut = () => { try { return fs.readdirSync(dir).some((d) => { const f = path.join(dir, d, 'result.json'); return fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).journeys.some((j) => j.timed_out || /Timeout \d+ms exceeded/.test(JSON.stringify(j))); }); } catch { return false; } };
  if (timedOut()) { console.log(`  (a journey or a click in ${outName} timed out on a busy machine; running it once more)`); fs.rmSync(dir, { recursive: true, force: true }); r = await once(); }
  return r;
};

const refused = await runPanel(['--url', O, '--i-own', 'someone-else.example']);
ok(refused.code === 2 && /terms of service/.test(refused.err), '--i-own that does not match --url is refused with exit 2 and a terms of service warning', refused.err.slice(0, 200));
const noOwn = await runPanel(['--url', O]);
ok(noOwn.code === 2 && /--i-own/.test(noOwn.err), 'a run without --i-own is refused');
const dry = await runPanel(['--cart', '--url', O, '--i-own', '127.0.0.1', '--dry-run']);
ok(dry.code === 0 && /utm_source=shopper-panel/.test(dry.out), '--dry-run prints the plan with the labelled test link');

// R25 (fixture): the Shopify cart page's own script must reach the browser as written; a "$'" in a price label was once read as a
// String.replace pattern and broke the script, so the discount box and the estimator never ran
{
  server.flags.shopCart = true;
  const pj = await (await fetch(`${O}/products/autumn-ember-candle.js`)).json();
  const add = await fetch(`${O}/cart/add.js`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `id=${pj.variants[0].id}&quantity=1` });
  const ck = (add.headers.get('set-cookie') || '').split(';')[0];
  const html = await (await fetch(`${O}/cart`, { headers: { cookie: ck } })).text();
  server.flags.shopCart = false;
  const bad = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => { try { new Function(x); return false; } catch { return true; } });
  ok(/apply-discount/.test(html) && /': \$' \+ x\.price/.test(html) && bad.length === 0, 'fixture: the Shopify cart page script (discount box, estimator) arrives as written and parses', bad.map((x) => x.slice(0, 80)).join(' | '));
}
const firstHits = server.requests.length;
server.flags.shopCart = true;
console.log('  running 5 journeys (this takes a minute or two)...');
const run = await runPanel(['--cart', '--url', O, '--i-own', '127.0.0.1', '--pause', '0', '--report', 'report-copy.md']);
server.flags.shopCart = false;
ok(run.code === 0, 'the runner exits 0 when the run completes (one persona quits on purpose)', `${run.code} ${run.err.slice(0, 400)}`);
ok(/Run status: COMPLETED/.test(run.out), 'a clean run prints COMPLETED');
const runDir = fs.readdirSync(path.join(tmp, 'reports')).map((d) => path.join(tmp, 'reports', d)).find((d) => fs.existsSync(path.join(d, 'result.json')));
const result = runDir ? JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8')) : { journeys: [] };
const J = Object.fromEntries(result.journeys.map((j) => [j.persona, j]));
const req = server.requests.slice(firstHits);

for (const eng of ['wk', 'cr']) {
  const j = J[`linen-${eng}`] || { steps: [], trust_matches: [], script_errors: [], filtered_errors: [], checkout_blocked: [], by_rule: {}, blocked_hosts: {} };
  const found = (need) => j.trust_matches.some((m) => m.need.startsWith(need));
  ok(j.completed && j.reached_checkout && j.checkout_button?.visible && j.checkout_button.enabled && !j.checkout_request && j.steps.some((s) => s.step === 'find Checkout' && /Not tapped/.test(s.detail)), `linen-${eng}: found a visible, enabled Checkout button and never tapped it`, `${j.quit_step}: ${j.quit_reason} ${JSON.stringify(j.checkout_button)}`);
  ok(j.price && j.price.value === 28 && j.price.matches_structured, `linen-${eng}: price is $28.00 from [itemprop=price], not the $19 banner or $26 sticky bar`, JSON.stringify(j.price));
  ok(j.steps.some((s) => { if (s.step !== 'find the price') return false; const m = /screen (\d+) \((\d+)px down; one phone screen is (\d+)px\)/.exec(s.detail); return !!m && Number(m[1]) === Math.floor(Number(m[2]) / Number(m[3])) + 1; }), `linen-${eng}: price screen is measured`, JSON.stringify(j.steps.find((s) => s.step === 'find the price')));
  ok(found('shipping days'), `linen-${eng}: text inside a closed accordion is read`);
  ok(found('the wick upgrade'), `linen-${eng}: hidden option text is read`);
  ok(found('a rating (lazy'), `linen-${eng}: the lazy review widget loads after scrolling and is read with look_in reviews`);
  ok(!found('member price'), `linen-${eng}: a sticky bar is not read as product text`);
  ok(!found('related products'), `linen-${eng}: related products are not read as product text`);
  ok(!found('free returns'), `linen-${eng}: header and footer are not read as product text`);
  ok(!found('a rating in the product block'), `linen-${eng}: reviews are not read as product text`);
  ok(j.steps.some((s) => /pop-up closed/.test(s.step) && /survey/.test(s.detail)), `linen-${eng}: the pop-up was closed with the safe Dismiss button`);
  ok(j.steps.some((s) => s.step === 'pick options' && /12 oz/.test(s.detail)), `linen-${eng}: the persona's size choice was picked`);
  ok(j.script_errors.some((e) => /fixture own-page error/.test(e.message)), `linen-${eng}: the store's own script error is reported`);
  ok(j.filtered_errors.length >= 1 && !j.script_errors.some((e) => /fetch|load failed|network/i.test(e.message)), `linen-${eng}: the network error from a blocked call is set aside, not reported`, JSON.stringify({ s: j.script_errors, f: j.filtered_errors }));
  ok((j.by_rule['platform-analytics'] || 0) >= 1, `linen-${eng}: the own-host analytics calls were blocked by name`);
  ok(j.blocked_hosts.localhost >= 1, `linen-${eng}: the third-party host is listed as blocked`);
  ok(j.checkout_blocked.some((c) => /from-iframe|go-checkout/.test(c.url)) && !req.some((r) => /from-iframe/.test(r.url)), `linen-${eng}: the hidden iframe's redirect to checkout was stopped`);
  ok(j.checkout_page_loaded === false, `linen-${eng}: checkout page loaded is measured as false`);
  ok(j.cart_touched === true && !('cart_emptied' in j), `linen-${eng}: the test cart is left as it is (no cleanup)`);
}
const g = J['grid-wk'] || { steps: [], trust_matches: [] };
ok(g.product_url && /\/products\/gift-set$/.test(g.product_url), 'grid: picked the product from the product grid only (not the header link)', g.product_url);
ok(g.price && g.price.value === 38 && /handle>\.js/.test(g.price.structured_source || ''), 'grid: price confirmed through Shopify /products/<handle>.js', JSON.stringify(g.price));
ok(g.steps.some((s) => /pop-up closed/.test(s.step)), 'grid: the newsletter pop-up was closed without signing up');
ok(g.reached_checkout && /\/cart\/?$/.test(g.checkout_button?.target || '') && !g.checkout_request, 'grid: the Shopify cart Checkout button (a form to /cart) is found and never tapped', JSON.stringify([g.checkout_button, g.checkout_request]));
ok(g.steps.some((s) => s.step === 'pick options' && /Sage/.test(s.detail)), 'grid: the radio choice was picked');
const w = J['ember-cr'] || { steps: [] };
ok(w.price && w.price.value === 32 && /\$32\.00/.test(w.price.text), 'ember: the Shopify price $32.00', JSON.stringify(w.price));
ok(w.reached_checkout && /\/cart\/?$/.test(w.checkout_button?.target || '') && !w.checkout_request, 'ember: the Shopify cart Checkout button is found and never tapped', JSON.stringify([w.checkout_button, w.checkout_request]));
ok(w.cart_checks?.codes?.length === 1 && w.cart_checks.codes[0].code === 'CANDLE10' && w.cart_checks.codes[0].worked === true && w.cart_checks.codes[0].total_before === 32 && Math.abs(w.cart_checks.codes[0].total_after - 28.8) < 0.001, 'Shopify cart: the code CANDLE10 the store shows in its banner goes through the store\'s own discount box (/cart/update.js) and the total drops from 32.00 to 28.80', JSON.stringify(w.cart_checks));
ok(w.cart_checks?.free_shipping?.status === 'ok', 'Shopify cart: the free-shipping bar\'s amount matches threshold minus subtotal', JSON.stringify(w.cart_checks?.free_shipping));
ok(w.cart_checks?.shipping?.cheapest === 3.95 && w.cart_checks.shipping.postcode === '10001' && w.cart_checks.shipping.country === 'US' && JSON.stringify(w.cart_checks.shipping.options) === JSON.stringify([{ name: 'Express', price: 12.95 }, { name: 'Standard', price: 3.95 }]) && w.steps.some((s) => s.step === 'estimate shipping'), 'Shopify cart: the estimator gets the fixed US postcode 10001 and reads the cheapest rate 3.95 from the store\'s own rates answer (the "Free shipping on orders over" promo line is not a rate)', JSON.stringify(w.cart_checks?.shipping));
ok(JSON.stringify(w.typed_list || []) === JSON.stringify([{ box: 'discount code', text: 'CANDLE10' }, { box: 'shipping estimator postcode', text: '10001' }]), 'Shopify cart: the only text typed was the store\'s own code and the fixed postcode', JSON.stringify(w.typed_list));
ok(/FB_IAB|FBAN/.test(req.find((r) => /autumn-ember-candle/.test(r.url))?.headers['user-agent'] || ''), 'ember: Facebook in-app arrival is emulated by user agent only');
ok(w.cart_touched === true && !('cart_emptied' in w) && w.checkout_page_loaded === false, 'ember: no checkout loaded and the test cart is left as it is');
const q = J['quit-wk'] || {};
ok(!q.completed && q.quit_kind === 'required_info_missing', 'quit: the persona quit when the free shipping line was only in the footer', `${q.quit_kind} ${q.quit_reason}`);

// An arrival is a request for a labelled link that the page did not make to itself (a theme reloading its own page after Add to cart is not an arrival).
const landings = req.filter((r) => /utm_source=shopper-panel/.test(r.url) && !(r.headers.referer && r.headers.referer.endsWith(r.url)));
ok(landings.length >= 5 && landings.every((r) => /utm_medium=qa-test/.test(r.url) && /utm_campaign=shopper-panel-test/.test(r.url)), 'every arrival is a labelled test link');
ok(landings.every((r) => !r.headers.referer), 'no arrival carries a referer', JSON.stringify(landings.filter((r) => r.headers.referer).map((r) => [r.url, r.headers.referer])));
ok(!req.some((r) => /^\/checkouts?(\/|$|\?)/.test(r.url.split('?')[0]) || /wc-ajax=checkout|wc\/store\/v1\/checkout|^\/kasse/.test(r.url)), 'the fixture store never received a checkout request (including /kasse/ and the Store API checkout)');
ok(!req.some((r) => r.url.startsWith('/survey-submit') || /api\/collect|monorail/.test(r.url)), 'no pop-up form was submitted and no analytics call reached the store');
ok(result.checkout_page_loaded === false && result.status === 'completed', 'run status is completed and no checkout page loaded');
const shots = runDir ? fs.readdirSync(path.join(runDir, 'screenshots')) : [];
ok(shots.length > 10 && shots.every((f) => /^[a-z0-9-]+\.jpg$/.test(f)), 'screenshot file names are sanitized', shots.slice(0, 3).join(', '));
const md = fs.existsSync(path.join(tmp, 'report-copy.md')) ? fs.readFileSync(path.join(tmp, 'report-copy.md'), 'utf8') : '';
ok(md.includes('Who got to the Checkout button') && md.includes('directional') && md.includes('Server-side tracking'), 'the report has the table, the directional note and the server-side wording');
ok(/What backs "no order": the panel never taps Checkout[^\n]*no recognised checkout page loaded in any tab or frame \(measured/.test(md) && !/No order was placed/.test(md), 'the report says no order was placed only together with the measurement behind it');
ok(!md.includes(tmp) && !/\/Users\/|\\Users\\|\/home\//.test(md), 'the report uses relative paths only');
{
  const bq = result.journeys.filter((j) => !j.completed && j.quit_kind && !lib.ERROR_KINDS.includes(j.quit_kind) && j.quit_severity === 'block');
  const items = (md.split('## What to fix first')[1] || '').split('\n## ')[0].split('\n').filter((l) => /^\d+\. At "/.test(l));
  const counts = items.map((l) => +(l.match(/", (\d+) shoppers?/) || [0, 0])[1]);
  ok(bq.length > 0 && items.length > 0 && counts.reduce((x, y) => x + y, 0) === bq.length && counts.every((c, i) => i === 0 || counts[i - 1] >= c), 'report: "What to fix first" lists each blocking quit, ranked by how many shoppers it stopped', `${bq.length} ${JSON.stringify(counts)}`);
  ok(!/\bQuit\b[^\n]*checkout request/.test(md) && !/checkout request\(s\)[^\n]*\/cart\b(?![\/.]checkout)/.test(md), 'report: /cart is not labelled as a checkout request');
}
ok(md.split('\n').filter((l) => l.startsWith('| ')).every((l) => !/[^\\]`/.test(l)), 'report table cells have no unescaped backticks');

// item: a journey that hits an error makes the run exit 1 with a status that is not COMPLETED; a myshopify owner is confirmed by the store
const pdir2 = path.join(tmp, 'personas-err'); fs.mkdirSync(pdir2);
const errP = { ...base, id: 'err-wk', name: 'Err wk', device: 'iphone-14', main_quit_reason: 'error check', entry_point: { channel: 'direct', landing_path: '/server-error' }, product_pick: null, before_buying: [{ need: 'anything', look_for: ['candle'], if_missing: 'warn' }], choices: [] };
fs.writeFileSync(path.join(pdir2, 'err-wk.json'), JSON.stringify(errP));
const MS = { SP_TEST_MYSHOPIFY_LOOPBACK: '1' };
const plainMs = await runPanel(['--url', O, '--i-own', 'northwick-candles.myshopify.com', '--personas', pdir2, '--dry-run']);
ok(plainMs.code === 2 && /is this computer/.test(plainMs.err), 'without the test-only setting, this computer as --url with a myshopify owner is refused', `${plainMs.code} ${plainMs.err.slice(0, 200)}`);
const errRun = await runPanel(['--cart', '--url', O, '--i-own', 'northwick-candles.myshopify.com', '--personas', pdir2, '--out', 'reports-err', '--pause', '0'], MS);
const errDir = fs.existsSync(path.join(tmp, 'reports-err')) ? fs.readdirSync(path.join(tmp, 'reports-err')).map((d) => path.join(tmp, 'reports-err', d)).find((d) => fs.existsSync(path.join(d, 'result.json'))) : null;
const errRes = errDir ? JSON.parse(fs.readFileSync(path.join(errDir, 'result.json'), 'utf8')) : {};
ok(errRun.code === 1 && /Run status: INCOMPLETE/.test(errRun.out) && !/COMPLETED/.test(errRun.out) && errRes.status === 'incomplete' && errRes.journeys?.[0]?.quit_kind === 'error', 'a landing page whose server fails (HTTP 500, quit_kind error) exits 1 with status INCOMPLETE, not COMPLETED (a 404 is a broken_link store result instead)', `${errRun.code} ${errRun.out.slice(-300)} ${errRun.err.slice(0, 200)}`);
ok(/Ownership: 127\.0\.0\.1 confirms its address is northwick-candles\.myshopify\.com/.test(errRun.out), 'a myshopify owner is accepted once the store confirms it through /meta.json');
const wrongShop = await runPanel(['--cart', '--url', O, '--i-own', 'northwick.myshopify.com', '--personas', pdir2, '--pause', '0'], MS);
ok(wrongShop.code === 2 && /says its address is "northwick-candles\.myshopify\.com"/.test(wrongShop.err), 'a myshopify owner the store does not confirm is refused with exit 2', `${wrongShop.code} ${wrongShop.err.slice(0, 300)}`);
const dryShop = await runPanel(['--cart', '--url', O, '--i-own', 'northwick-candles.myshopify.com', '--personas', pdir2, '--dry-run'], MS);
ok(dryShop.code === 0 && /confirmed from the store itself when the run starts/.test(dryShop.out), 'a dry run says the myshopify check happens at run start and touches no network');
server.flags.meta = false;
const noMeta = await runPanel(['--cart', '--url', `${O}/products/no-such-candle`, '--i-own', 'northwick-candles.myshopify.com', '--personas', pdir2, '--pause', '0'], MS);
ok(noMeta.code === 2 && /did not say its myshopify address/.test(noMeta.err), 'without /meta.json and without Shopify.shop in the page, a myshopify owner is refused', `${noMeta.code} ${noMeta.err.slice(0, 300)}`);
const onlyGiven = await runPanel(['--url', `${O}/products/dawn-tote`, '--i-own', 'northwick-candles.myshopify.com', '--personas', pdir2, '--pause', '0', '--no-cart'], MS);
ok(onlyGiven.code === 2 && /did not say its myshopify address/.test(onlyGiven.err), 'Shopify.shop on the given page alone does not confirm the owner (the fallback reads the home page "/" only, never the address given)', `${onlyGiven.code} ${onlyGiven.err.slice(0, 300)}`);
// the ownership fallback reads the home page "/" only, so the practice store serves one that names Shopify.shop
server.flags.homeShop = true;
const viaPage = await runPanel(['--url', `${O}/products/dawn-tote`, '--i-own', 'northwick-candles.myshopify.com', '--personas', pdir2, '--out', 'reports-dawn', '--pause', '0', '--no-cart'], MS);
server.flags.meta = true; server.flags.homeShop = false;
ok(/confirms its address is northwick-candles\.myshopify\.com/.test(viaPage.out), 'without /meta.json, Shopify.shop in the page confirms the myshopify owner', `${viaPage.code} ${viaPage.out.slice(0, 300)} ${viaPage.err.slice(0, 300)}`);
const dawnDir = fs.existsSync(path.join(tmp, 'reports-dawn')) ? fs.readdirSync(path.join(tmp, 'reports-dawn')).map((d) => path.join(tmp, 'reports-dawn', d)).find((d) => fs.existsSync(path.join(d, 'result.json'))) : null;
const dawnJ = dawnDir ? JSON.parse(fs.readFileSync(path.join(dawnDir, 'result.json'), 'utf8')).journeys[0] : {};
ok(dawnJ.steps?.some((x) => x.step === 'pick options' && x.ok), 'runner on Dawn: the add-to-cart form inside Dawn\'s class="grid" layout is found (a layout grid is not a product listing)', JSON.stringify(dawnJ.steps?.slice(-2)));
ok(viaPage.code === 0 && dawnJ.completed && dawnJ.price?.value === 42, 'runner on the Dawn page at phone width: the price in the sticky info column is found and the journey completes', `${viaPage.code} ${dawnJ.quit_step}: ${dawnJ.quit_reason} ${JSON.stringify(dawnJ.price)}`);

// F2 / F3 end to end: a page the panel cannot read is a tool limit (INCOMPLETE, exit 1), never a shopper quit; a block grid works
const pdir3 = path.join(tmp, 'personas-limit'); fs.mkdirSync(pdir3);
const fast = { ...base.patience, load_seconds: 4 };
fs.writeFileSync(path.join(pdir3, 'nohead-wk.json'), JSON.stringify({ ...base, patience: fast, id: 'nohead-wk', name: 'No heading wk', device: 'iphone-14', main_quit_reason: 'no heading check', popups: 'leave', entry_point: { channel: 'direct', landing_path: '/usable/none/' }, product_pick: null, before_buying: [{ need: 'a name', look_for: ['beeswax|something'], if_missing: 'warn' }], choices: [] }));
fs.writeFileSync(path.join(pdir3, 'oddgrid-cr.json'), JSON.stringify({ ...base, id: 'oddgrid-cr', name: 'Odd grid cr', device: 'pixel-7', main_quit_reason: 'odd grid check', popups: 'leave', entry_point: { channel: 'direct', landing_path: '/shop-odd/' }, product_pick: null, before_buying: [{ need: 'a name', look_for: ['beeswax|something'], if_missing: 'warn' }], choices: [] }));
const lim = await runPanel(['--url', O, '--i-own', '127.0.0.1', '--personas', pdir3, '--out', 'reports-limit', '--pause', '0', '--no-cart']);
const limDir = fs.existsSync(path.join(tmp, 'reports-limit')) ? fs.readdirSync(path.join(tmp, 'reports-limit')).map((d) => path.join(tmp, 'reports-limit', d)).find((d) => fs.existsSync(path.join(d, 'result.json'))) : null;
const limRes = limDir ? JSON.parse(fs.readFileSync(path.join(limDir, 'result.json'), 'utf8')) : { journeys: [] };
const LJ = Object.fromEntries(limRes.journeys.map((j) => [j.persona, j]));
ok(lim.code === 1 && limRes.status === 'incomplete' && /Run status: INCOMPLETE/.test(lim.out) && /tool limit/.test(limRes.summary || ''), 'runner: tool limits make the run INCOMPLETE and exit 1', `${lim.code} ${limRes.status} ${(limRes.summary || '').slice(0, 200)} ${lim.err.slice(0, 200)}`);
ok(LJ['nohead-wk']?.quit_kind === 'test_limit' && /could not recognise its heading/.test(LJ['nohead-wk'].quit_reason) && !/patience/.test(LJ['nohead-wk'].quit_kind), 'runner: a loaded page with no recognised heading is a tool limit, not a "not usable" shopper quit', JSON.stringify(LJ['nohead-wk'] && [LJ['nohead-wk'].quit_kind, LJ['nohead-wk'].quit_reason]));
ok(LJ['oddgrid-cr']?.quit_kind === 'test_limit' && /not in a product grid the panel recognises/.test(LJ['oddgrid-cr'].quit_reason), 'runner: product links in an unknown grid are a tool limit, not not_found', JSON.stringify(LJ['oddgrid-cr'] && [LJ['oddgrid-cr'].quit_kind, LJ['oddgrid-cr'].quit_reason]));
const pdir4 = path.join(tmp, 'personas-block'); fs.mkdirSync(pdir4);
fs.writeFileSync(path.join(pdir4, 'blockgrid-wk.json'), JSON.stringify({ ...base, id: 'blockgrid-wk', name: 'Block grid wk', device: 'iphone-14', main_quit_reason: 'block grid check', popups: 'leave', entry_point: { channel: 'direct', landing_path: '/shop-block/' }, product_pick: 'beeswax', before_buying: [{ need: 'beeswax', look_for: ['beeswax'], if_missing: 'warn' }], choices: [] }));
const blk = await runPanelTolerant(['--url', O, '--i-own', '127.0.0.1', '--personas', pdir4, '--out', 'reports-block', '--pause', '0', '--no-cart'], 'reports-block');
const blkDir = fs.existsSync(path.join(tmp, 'reports-block')) ? fs.readdirSync(path.join(tmp, 'reports-block')).map((d) => path.join(tmp, 'reports-block', d)).find((d) => fs.existsSync(path.join(d, 'result.json'))) : null;
const BJ = blkDir ? JSON.parse(fs.readFileSync(path.join(blkDir, 'result.json'), 'utf8')).journeys[0] : {};
ok(blk.code === 0 && BJ.completed && BJ.steps?.some((x) => x.step === 'pick a product' && x.ok && /Beeswax/.test(x.detail || x.note || JSON.stringify(x))), 'runner: a WooCommerce block-theme grid is used to pick the product and the journey completes', `${blk.code} ${BJ.quit_step}: ${BJ.quit_reason} ${blk.err.slice(0, 200)}`);

// R4 items 1 to 3 end to end: a required field the panel skipped on purpose, a missing price with and without evidence, beacon counts
const pdir5 = path.join(tmp, 'personas-r4'); fs.mkdirSync(pdir5);
const p5 = (id, device, landing) => fs.writeFileSync(path.join(pdir5, `${id}.json`), JSON.stringify({ ...base, id, name: id, device, main_quit_reason: `${id} check`, popups: 'leave', entry_point: { channel: 'direct', landing_path: landing }, product_pick: null, before_buying: [{ need: 'a name', look_for: ['beeswax'], if_missing: 'warn' }], choices: [] }));
p5('giftcard-cr', 'pixel-7', '/product/gift-card/'); p5('giftcard-wk', 'iphone-14', '/product/gift-card/');
p5('noprice-wk', 'iphone-14', '/product/no-price/'); p5('hiddenprice-cr', 'pixel-7', '/product/hidden-price/');
const r4 = await runPanelTolerant(['--cart', '--url', O, '--i-own', '127.0.0.1', '--personas', pdir5, '--out', 'reports-r4', '--pause', '0'], 'reports-r4');
const r4Dir = fs.existsSync(path.join(tmp, 'reports-r4')) ? fs.readdirSync(path.join(tmp, 'reports-r4')).map((d) => path.join(tmp, 'reports-r4', d)).find((d) => fs.existsSync(path.join(d, 'result.json'))) : null;
const r4Res = r4Dir ? JSON.parse(fs.readFileSync(path.join(r4Dir, 'result.json'), 'utf8')) : { journeys: [] };
const RJ = Object.fromEntries(r4Res.journeys.map((j) => [j.persona, j]));
const kr = (id) => JSON.stringify(RJ[id] && [RJ[id].quit_step, RJ[id].quit_kind, RJ[id].quit_reason]);
for (const id of ['giftcard-cr', 'giftcard-wk']) ok(RJ[id]?.quit_kind === 'test_limit' && RJ[id].quit_step === 'add to cart' && /Recipient email/.test(RJ[id].quit_reason) && /personal data/.test(RJ[id].quit_reason), `runner ${id}: Add to cart refused because the panel left a required "Recipient email" empty is a tool limit naming the field, not required_info_missing`, kr(id));
ok(RJ['noprice-wk']?.quit_kind === 'test_limit' && /could not find a price element it recognises/.test(RJ['noprice-wk'].quit_reason), 'runner: no visible price, no structured price and no candidates is a tool limit, not a store problem', kr('noprice-wk'));
ok(RJ['hiddenprice-cr']?.quit_kind === 'required_info_missing' && /page data says 18/.test(RJ['hiddenprice-cr'].quit_reason), 'runner: a structured price whose digits are not shown stays required_info_missing (there is evidence)', kr('hiddenprice-cr'));
ok(r4.code === 1 && r4Res.status === 'incomplete', 'runner: these tool limits make the run INCOMPLETE (exit 1)', `${r4.code} ${r4Res.status}`);
ok(r4Res.beacons_dropped >= 2 && RJ['giftcard-cr']?.beacons_dropped >= 1 && RJ['giftcard-wk']?.beacons_dropped >= 1 && /^attached/.test(r4Res.network_guard || ''), 'runner: dropped beacons are counted per journey and in the result, and the Chromium browser-level guard is attached', JSON.stringify({ total: r4Res.beacons_dropped, cr: RJ['giftcard-cr']?.beacons_dropped, wk: RJ['giftcard-wk']?.beacons_dropped, ng: r4Res.network_guard }));
// R4b: on Chromium every tracker stop is counted (no layer runs before ctx.route any more), and errors the test browser causes are set aside
const pdir6 = path.join(tmp, 'personas-r4b'); fs.mkdirSync(pdir6);
for (const [id, device] of [['trackers-cr', 'pixel-7'], ['trackers-wk', 'iphone-14']]) fs.writeFileSync(path.join(pdir6, `${id}.json`), JSON.stringify({ ...base, id, name: id, device, main_quit_reason: `${id} check`, popups: 'leave', entry_point: { channel: 'direct', landing_path: '/product/trackers/' }, product_pick: null, before_buying: [{ need: 'a name', look_for: ['beeswax'], if_missing: 'warn' }], choices: [] }));
const req6 = server.requests.length;
const r4b = await runPanel(['--url', O, '--i-own', '127.0.0.1', '--personas', pdir6, '--out', 'reports-r4b', '--pause', '0', '--no-cart', '--strict-errors'], { SP_TEST_HOST_MAP: 'www.clarity.ms,connect.facebook.net' });
const r4bDir = fs.existsSync(path.join(tmp, 'reports-r4b')) ? fs.readdirSync(path.join(tmp, 'reports-r4b')).map((d) => path.join(tmp, 'reports-r4b', d)).find((d) => fs.existsSync(path.join(d, 'result.json'))) : null;
const r4bRes = r4bDir ? JSON.parse(fs.readFileSync(path.join(r4bDir, 'result.json'), 'utf8')) : { journeys: [] };
const TJ = Object.fromEntries(r4bRes.journeys.map((j) => [j.persona, j]));
const tCr = TJ['trackers-cr'] || {}; const tWk = TJ['trackers-wk'] || {};
const tdump = (x) => JSON.stringify({ by_rule: x.by_rule, hosts: x.blocked_hosts, errs: x.script_errors, filtered: x.filtered_errors, q: [x.quit_step, x.quit_reason] });
ok(tCr.by_rule?.['meta-pixel'] >= 1 && tCr.by_rule?.['session-replay'] >= 1 && tCr.blocked_hosts?.['connect.facebook.net'] >= 1 && tCr.blocked_hosts?.['www.clarity.ms'] >= 1, 'runner chromium: tracker hosts mapped to loopback are counted by rule and by host (nothing stops them before ctx.route)', tdump(tCr));
ok(!server.requests.slice(req6).some((r) => /clarity|facebook/.test(r.host)), 'runner: the mapped tracker hosts never reached the fixture server', JSON.stringify(server.requests.slice(req6).filter((r) => /clarity|facebook/.test(r.host)).map((r) => r.host + r.url)));
for (const [nm, x] of [['pixel', tCr], ['iphone', tWk]]) {
  ok(x.completed && !x.script_errors?.length, `runner ${nm}: with --strict-errors, a blocked tracker's "Failed to fetch", the sandboxed frame and the refused service worker are not recorded as store script errors`, tdump(x));
  ok(x.filtered_errors?.some((f) => /^service worker unavailable in this frame \(test browser blocks service workers\)$/.test(f.via)), `runner ${nm}: errors caused by the test browser are set aside and labelled as such`, tdump(x));
}
ok([tCr, tWk].every((x) => x.filtered_errors?.some((f) => /Failed to read the 'serviceWorker' property/.test(f.message)) && x.filtered_errors?.some((f) => /turned off by the shopper panel/.test(f.message))), 'runner: the sandboxed-frame service worker message and the uncaught register() refusal are the ones set aside, at both phone sizes', JSON.stringify({ cr: tCr.filtered_errors, wk: tWk.filtered_errors }));
ok(r4b.code === 0 && r4bRes.status === 'completed', 'runner: that run is COMPLETED with exit 0 (no false blocking finding)', `${r4b.code} ${r4bRes.status} ${r4b.err.slice(0, 200)}`);
// R5: tracker words in an own-host handle, photo, style sheet and product JSON never stop the journey
const pdir7 = path.join(tmp, 'personas-r5'); fs.mkdirSync(pdir7);
for (const [id, device, land] of [['handle-cr', 'pixel-7', '/products/trekkie-elevare-candle'], ['handle-wk', 'iphone-14', '/products/trekkie-elevare-candle']]) fs.writeFileSync(path.join(pdir7, `${id}.json`), JSON.stringify({ ...base, id, name: id, device, main_quit_reason: `${id} check`, popups: 'leave', entry_point: { channel: 'direct', landing_path: land }, product_pick: null, before_buying: [{ need: 'a name', look_for: ['beeswax'], if_missing: 'warn' }], choices: [] }));
const req7 = server.requests.length;
const r5 = await runPanel(['--url', O, '--i-own', '127.0.0.1', '--personas', pdir7, '--out', 'reports-r5', '--pause', '0', '--no-cart']);
const r5Dir = fs.existsSync(path.join(tmp, 'reports-r5')) ? fs.readdirSync(path.join(tmp, 'reports-r5')).map((d) => path.join(tmp, 'reports-r5', d)).find((d) => fs.existsSync(path.join(d, 'result.json'))) : null;
const r5Res = r5Dir ? JSON.parse(fs.readFileSync(path.join(r5Dir, 'result.json'), 'utf8')) : { journeys: [] };
for (const x of r5Res.journeys) ok(x.completed && !x.quit_kind && !Object.keys(x.by_rule || {}).some((k) => k !== 'not-allow-listed') && !x.rule_hits_on_allowed?.length, `runner ${x.persona}: an own-host product called trekkie-elevare-candle, with photo elevare-gold.png, is not blocked by any named rule`, JSON.stringify({ q: [x.quit_step, x.quit_kind, x.quit_reason], by_rule: x.by_rule, hits: x.rule_hits_on_allowed }));
const got7 = server.requests.slice(req7).map((r) => r.url.split('?')[0]);
ok(r5Res.journeys.length === 2 && r5.code === 0 && r5Res.status === 'completed' && ['/wp-content/uploads/elevare-gold.png', '/wp-content/uploads/littledata-pintrk.css', '/products/trekkie-elevare-candle.js'].every((u) => got7.filter((g) => g === u).length >= 2), 'runner: the photo, style sheet and product JSON with tracker words reached the store for both phones, and the run is COMPLETED (exit 0)', JSON.stringify({ code: r5.code, status: r5Res.status, got: [...new Set(got7)] }));
// R6: the store's own catalog fetches pass, the first-party Google tag is stopped and recorded as a rule hit on the store's own host
const pdir10 = path.join(tmp, 'personas-r6'); fs.mkdirSync(pdir10);
for (const [id, device] of [['perfkit-cr', 'pixel-7'], ['perfkit-wk', 'iphone-14']]) fs.writeFileSync(path.join(pdir10, `${id}.json`), JSON.stringify({ ...base, id, name: id, device, main_quit_reason: `${id} check`, popups: 'leave', entry_point: { channel: 'direct', landing_path: '/product/perf-kit/' }, product_pick: null, before_buying: [{ need: 'burn time', look_for: ['hours of burn time'], if_missing: 'quit' }], choices: [] }));
const req10 = server.requests.length;
const r6 = await runPanel(['--url', O, '--i-own', '127.0.0.1', '--personas', pdir10, '--out', 'reports-r6', '--pause', '0', '--no-cart']);
const r6Dir = fs.existsSync(path.join(tmp, 'reports-r6')) ? fs.readdirSync(path.join(tmp, 'reports-r6')).map((d) => path.join(tmp, 'reports-r6', d)).find((d) => fs.existsSync(path.join(d, 'result.json'))) : null;
const r6Res = r6Dir ? JSON.parse(fs.readFileSync(path.join(r6Dir, 'result.json'), 'utf8')) : { journeys: [] };
const got10 = server.requests.slice(req10).map((r) => r.url);
ok(['/products/perf-kit?section_id=main', '/collections/web-pixel/products.json'].every((u) => got10.filter((g) => g === u).length >= 2) && !got10.some((g) => /^\/metrics\//.test(g)), 'runner: the perf-kit section fetch and /collections/web-pixel/products.json reach the store for both phones; the first-party Google tag never does', JSON.stringify([...new Set(got10)]));
for (const x of r6Res.journeys) ok(x.quit_kind === 'required_info_missing' && !x.quit_original_kind && !/may have caused|caveat/.test(x.quit_reason || '') && x.by_rule?.['first-party-google-tag'] >= 1 && !x.by_rule?.['platform-analytics'] && !x.rule_hits_on_allowed?.length && (r6Res.findings || []).some((f) => f.persona === x.persona && f.severity === 'block'), `runner ${x.persona}: a store with a first-party Google tag gateway and a real missing-info quit: the tag is counted as blocked but is an endpoint (no rule hit), and the quit stays the store's with a blocking finding`, JSON.stringify({ q: [x.quit_kind, x.quit_original_kind, x.quit_reason], by_rule: x.by_rule, hits: x.rule_hits_on_allowed, f: (r6Res.findings || []).filter((f) => f.persona === x.persona).map((f) => f.severity) }));
ok(r6Res.journeys.length === 2 && r6.code === 0 && r6Res.status === 'completed' && /a store's own first-party tag proxy may not be/.test(fs.readFileSync(path.join(r6Dir, 'report.md'), 'utf8')), 'runner: that run is COMPLETED (exit 0), and the report says a first-party tag proxy may not be blocked', `${r6.code} ${r6Res.status}`);
// R7: the platform's tracker script on cdn.shopify.com (an allowed host, mapped to this server on Chromium) plus a real missing-info quit
const pdir11 = path.join(tmp, 'personas-r7cdn'); fs.mkdirSync(pdir11);
fs.writeFileSync(path.join(pdir11, 'cdn-cr.json'), JSON.stringify({ ...base, id: 'cdn-cr', name: 'cdn-cr', device: 'pixel-7', main_quit_reason: 'cdn check', popups: 'leave', entry_point: { channel: 'direct', landing_path: '/product/cdn-trekkie/' }, product_pick: null, before_buying: [{ need: 'burn time', look_for: ['hours of burn time'], if_missing: 'quit' }], choices: [] }));
const req11 = server.requests.length;
const r7c = await runPanel(['--url', O, '--i-own', '127.0.0.1', '--personas', pdir11, '--out', 'reports-r7cdn', '--pause', '0', '--no-cart'], { SP_TEST_HOST_MAP: 'cdn.shopify.com' });
const r7cDir = fs.existsSync(path.join(tmp, 'reports-r7cdn')) ? fs.readdirSync(path.join(tmp, 'reports-r7cdn')).map((d) => path.join(tmp, 'reports-r7cdn', d)).find((d) => fs.existsSync(path.join(d, 'result.json'))) : null;
const r7cRes = r7cDir ? JSON.parse(fs.readFileSync(path.join(r7cDir, 'result.json'), 'utf8')) : { journeys: [] };
const cj = r7cRes.journeys[0] || {};
ok(server.requests.slice(req11).some((r) => r.url.startsWith("/product/cdn-trekkie/")) && !server.requests.slice(req11).some((r) => /^\/s\/trekkie/.test(r.url)) && cj.by_rule?.['platform-analytics'] >= 1 && !cj.rule_hits_on_allowed?.length && cj.quit_kind === 'required_info_missing' && !/may have caused|caveat/.test(cj.quit_reason || '') && (r7cRes.findings || []).some((f) => f.persona === cj.persona && f.severity === 'block'), 'runner: a trekkie script on cdn.shopify.com is stopped as an endpoint (no rule hit), and the real missing-info quit stays the store\'s with a blocking finding', JSON.stringify({ q: [cj.quit_kind, cj.quit_reason], by_rule: cj.by_rule, hits: cj.rule_hits_on_allowed }));
ok(r7cRes.journeys.length === 1 && r7c.code === 0 && r7cRes.status === 'completed', 'runner: that run is COMPLETED (exit 0)', `${r7c.code} ${r7cRes.status}`);
// R5: a named rule that stops an own-host script, and then the journey fails: a tool limit naming the rule, never the store's fault.
const pdir8 = path.join(tmp, 'personas-r5b'); fs.mkdirSync(pdir8);
fs.writeFileSync(path.join(pdir8, 'widget-cr.json'), JSON.stringify({ ...base, id: 'widget-cr', name: 'widget-cr', device: 'pixel-7', main_quit_reason: 'check', popups: 'leave', entry_point: { channel: 'direct', landing_path: '/product/widget-page/' }, product_pick: null, before_buying: [{ need: 'gift wrap', look_for: ['gift wrap'], if_missing: 'quit' }], choices: [] }));
fs.writeFileSync(path.join(pdir8, 'needs-script-cr.json'), JSON.stringify({ ...base, id: 'needs-script-cr', name: 'needs-script-cr', device: 'pixel-7', main_quit_reason: 'check', popups: 'leave', entry_point: { channel: 'direct', landing_path: '/product/needs-script/' }, product_pick: null, before_buying: [{ need: 'dispatch time', look_for: ['leaves our workshop within'], if_missing: 'quit' }], choices: [] }));
const cfg8 = path.join(tmp, 'r5b-config.json');
fs.writeFileSync(cfg8, JSON.stringify({ block_rules: [{ name: 'test-own-rule', kind: 'host', hosts: ['127.0.0.1'], path: '(^|/)render-heading\\.js(\\?|$)' }, { name: 'test-widget-rule', kind: 'host', hosts: ['127.0.0.1'], path: '(^|/)extra-widget\\.js(\\?|$)' }] }));
const r5b = await runPanel(['--url', O, '--i-own', '127.0.0.1', '--personas', pdir8, '--out', 'reports-r5b', '--pause', '0', '--no-cart', '--config', cfg8]);
const r5bDir = fs.existsSync(path.join(tmp, 'reports-r5b')) ? fs.readdirSync(path.join(tmp, 'reports-r5b')).map((d) => path.join(tmp, 'reports-r5b', d)).find((d) => fs.existsSync(path.join(d, 'result.json'))) : null;
const r5bRes = r5bDir ? JSON.parse(fs.readFileSync(path.join(r5bDir, 'result.json'), 'utf8')) : { journeys: [] };
const ns = r5bRes.journeys.find((x) => x.persona === 'needs-script-cr') || {};
const wj = r5bRes.journeys.find((x) => x.persona === 'widget-cr') || {};
ok(wj.quit_kind === 'required_info_missing' && /caveat: the named block rule "test-widget-rule"/.test(wj.quit_reason || '') && !/may have caused|INCOMPLETE/.test(wj.quit_reason || '') && (r5bRes.findings || []).some((f) => f.persona === wj.persona && f.severity === 'block' && /caveat/.test(f.what || '')) && wj.rule_hits_on_allowed?.some((h) => h.rule === 'test-widget-rule'), 'runner: a content quit (required info missing) after a named rule stopped an own-host script keeps its kind and blocking finding, with a caveat naming the rule', JSON.stringify({ q: [wj.quit_step, wj.quit_kind, wj.quit_reason], hits: wj.rule_hits_on_allowed, f: (r5bRes.findings || []).filter((f) => f.persona === wj.persona) }));
ok(ns.quit_kind === 'test_limit' && /test-own-rule/.test(ns.quit_reason || '') && /may have caused this/.test(ns.quit_reason || '') && !/test-widget-rule/.test(ns.quit_reason || '') && ns.rule_hits_on_allowed?.some((h) => h.rule === 'test-own-rule' && /render-heading/.test(h.url)), 'runner: a journey that fails because a named rule stopped the own-host script that writes its heading and dispatch line (the page is not recognised) is a tool limit that names the rule', JSON.stringify({ q: [ns.quit_step, ns.quit_kind, ns.quit_original_kind, ns.quit_reason], hits: ns.rule_hits_on_allowed }));
ok(!ns.reloaded_once && ns.timings?.arrive_seconds <= 35, 'runner: after a named rule stopped an own-host request, the page is not reloaded (the rule would stop it again) and the wait ends at the persona\'s patience plus 2 s', JSON.stringify([ns.reloaded_once, ns.timings]));
ok(r5b.code === 1 && r5bRes.status === 'incomplete', 'runner: that run is INCOMPLETE (exit 1), not COMPLETED with the store blamed', `${r5b.code} ${r5bRes.status}`);
const md8 = r5bDir ? fs.readFileSync(path.join(r5bDir, 'report.md'), 'utf8') : '';
ok(/browser-level request guard[^\n]*: attached/.test(md8) && /^attached/.test(r5bRes.network_guard || '') && !/\*\*Not attached/.test(md8), 'report: the Safety section says the Chromium browser-level guard was attached', (md8.match(/.*browser-level request guard.*/) || [''])[0]);
ok(/Named block rules that stopped a request on the store's own or an allowed host: test-own-rule/.test(md8) && /Script errors counted against the store: \d+; up to 3 per journey/.test(md8), 'report: the Safety section names the rule that stopped an own-host request, and says how many store script errors there were and where they are listed', (md8.match(/.*(Named block rules|Script errors counted).*/g) || []).join(' | '));
// R8: the caveat shows: a marker first in the table cell, a summary line (also printed), and the Safety line describes the split
{
  const row = md8.split('\n').find((l) => l.startsWith('| widget-cr ')) || '';
  ok(/\| \[a block rule may have affected this\] check what they need to know: /.test(row), 'report: the content quit after a rule stop starts its table cell with "[a block rule may have affected this]"', row.slice(0, 300));
  const line = "1 blocking finding(s) came after a named rule stopped a request on the store's own or an allowed host; check before acting.";
  ok(String(r5bRes.summary || '').includes(line) && r5b.out.includes(line), 'the run summary and the console summary count the blocking findings that came after a rule stop', r5bRes.summary);
  ok(/After one of these, a quit a missing request could cause[^\n]*is marked as a tool limit; a content quit[^\n]*keeps its kind and finding with a caveat naming the rule \(quit_rule_caveat\)/.test(md8) && !/A journey that failed after one of these is marked as a tool limit/.test(md8), 'report: the Safety line says request-caused quits become tool limits and content quits keep their kind with a caveat', (md8.match(/.*Named block rules that stopped.*/) || [''])[0].slice(0, 400));
}
// R8: loose endpoint rules and an own-host endpoint host rule in a config are refused at start (exit 2, before any browser)
for (const [i, rule, re] of [
  [1, { name: 'loose-q', kind: 'path', own_host: true, endpoint: true, path: '(^|/)assets/(\\?x=)?' }, /Block rule "loose-q" in [^\n]* is not valid: endpoint can only be set on built-in rules; your rule's stops will be counted and named in the report/],
  [2, { name: 'loose-q2', kind: 'path', own_host: false, endpoint: true, path: '(^|/)[^?]*\\?*=?' }, /Block rule "loose-q2" in [^\n]* is not valid: endpoint can only be set on built-in rules; your rule's stops will be counted and named in the report/],
  [3, { name: 'loose-root', kind: 'path', own_host: true, endpoint: true, path: '^/.*\\.js' }, /Block rule "loose-root" in [^\n]* is not valid: endpoint can only be set on built-in rules; your rule's stops will be counted and named in the report/],
  [4, { name: 'loose-root2', kind: 'path', own_host: false, endpoint: true, path: '^/(.*/)?assets/' }, /Block rule "loose-root2" in [^\n]* is not valid: endpoint can only be set on built-in rules; your rule's stops will be counted and named in the report/],
  [5, { name: 'host-own', kind: 'host', hosts: ['127.0.0.1'], endpoint: true }, /Block rule "host-own" in [^\n]* is not valid: endpoint can only be set on built-in rules/],
  [6, { name: 'host-allowed', kind: 'host', hosts: ['widgets.example'], endpoint: true }, /Block rule "host-allowed" in [^\n]* is not valid: endpoint can only be set on built-in rules/],
]) {
  const cf = path.join(tmp, `r8-config-${i}.json`); fs.writeFileSync(cf, JSON.stringify({ block_rules: [rule], allow_hosts: ['widgets.example'] }));
  const rr = await runPanel(['--url', O, '--i-own', '127.0.0.1', '--personas', pdir8, '--out', 'reports-r8x', '--pause', '0', '--no-cart', '--config', cf]);
  ok(rr.code === 2 && re.test(rr.err + rr.out) && !fs.existsSync(path.join(tmp, 'reports-r8x')), `runner: config rule ${rule.name} is refused at start with exit 2`, `${rr.code} ${(rr.err + rr.out).slice(0, 240)}`);
}
// R8: an allowed host that a named host rule still blocks gets a warning at start (dry run, nothing launched)
{
  const rr = await runPanel(['--url', O, '--i-own', '127.0.0.1', '--personas', pdir8, '--no-cart', '--dry-run', '--allow-host', 'static.klaviyo.com']);
  ok(rr.code === 0 && /Warning: static\.klaviyo\.com is allowed \(from --allow-host\) but the "email-sms-marketing" rule still blocks it\./.test(rr.err), 'runner: an --allow-host entry covered by a named host rule prints a warning at start', `${rr.code} ${rr.err.slice(0, 300)}`);
}
// a bad block rule in a config stops the run before any browser starts
const cfg9 = path.join(tmp, 'r5c-config.json'); fs.writeFileSync(cfg9, JSON.stringify({ block_rules: [{ name: 'old-style', pattern: 'trekkie' }] }));
const r5c = await runPanel(['--url', O, '--i-own', '127.0.0.1', '--personas', pdir8, '--out', 'reports-r5c', '--pause', '0', '--no-cart', '--config', cfg9]);
ok(r5c.code !== 0 && /Block rule "old-style" in [^\n]* is not valid: "pattern" is no longer used/.test(r5c.err + r5c.out), 'runner: an old-style block rule in a config is refused with a plain reason', (r5c.err + r5c.out).slice(0, 200));
ok(r4Res.findings.some((f) => /background report\(s\) \(beacons or keepalive requests/.test(f.what)), 'runner: the dropped beacons are reported as a finding');

// ---------- R9 ----------
// A: "endpoint" is for built-in rules only; the store's own cart and store API paths are never stopped by a named rule
{
  const own9 = new Set(['shop.example']);
  const user = (r) => lib.checkBlockRule(r).join(' ');
  ok([{ name: 'a', kind: 'path', own_host: true, path: '^/api/', endpoint: true }, { name: 'b', kind: 'path', own_host: false, path: '(^|/)files(/|$)', endpoint_hosts: ['cdn.shopify.com'] }, { name: 'c', kind: 'host', hosts: ['t.example'], endpoint: true }].every((r) => user(r).includes(lib.USER_ENDPOINT_REFUSAL) && /Fix: delete the "endpoint" and "endpoint_hosts" lines/.test(user(r))), 'a user rule with "endpoint" or "endpoint_hosts" is refused with the plain reason and the fix');
  ok(!user({ name: 'c', kind: 'host', hosts: ['t.example'] }) && !checkBuiltin({ name: 'c', kind: 'host', hosts: ['t.example'], endpoint: true }).length, 'the same rule without "endpoint" is accepted, and a built-in rule may still set it');
  const ur = lib.compileBlockRule({ name: 'my-cart-tracker', kind: 'path', own_host: true, path: '^/cart' }).rule;
  const fb = (u, rules = [ur]) => lib.findBlockRule(rules, u, { ownHosts: own9, allowHosts: ['cdn.shopify.com'], resourceType: 'fetch' });
  const allowed = ['/cart', '/cart.js', '/cart/add', '/cart/add.js', '/cart/change.js', '/cart/update.js', '/cart/clear.js', '/fr/cart.js', '/zh-hant/cart/add.js'];
  ok(allowed.every((p) => !fb('https://shop.example' + p)), 'a user "^/cart" rule never stops the store\'s own cart calls (/cart, /cart.js, /cart/add, /cart/change, /cart/update, with a locale too)', allowed.filter((p) => fb('https://shop.example' + p)).join(', '));
  ok(fb('https://shop.example/cart-upsell.js')?.name === 'my-cart-tracker' && fb('https://shop.example/cartwidget/x.js')?.name === 'my-cart-tracker', 'its other hits are still stopped and named, so the report can count them');
  const wide = lib.compileBlockRule({ name: 'w', kind: 'path', own_host: true, path: '^/api/|^/wp-json/' }).rule;
  ok(!fb('https://shop.example/api/2024-07/graphql.json', [wide]) && !fb('https://shop.example/api/unstable/graphql.json', [wide]) && !fb('https://shop.example/wp-json/wc/store/v1/cart/add-item', [wide]) && fb('https://shop.example/api/collect', [wide])?.name === 'w', 'own /api/<version>/graphql.json and /wp-json/wc/store/... are never stopped; /api/collect still is');
  ok(fb('https://shop.example/?wc-ajax=add_to_cart', [lib.compileBlockRule({ name: 'wa', kind: 'path', own_host: true, path: '\\?(.*&)?wc-ajax=add_to_cart' }).rule])?.name === 'wa', 'wc-ajax is not in the hard allow (a rule may still stop it)');
  ok(cr('https://shop.example/checkout') && cr('https://shop.example/fr/checkouts/abc'), 'checkout guarding is unchanged and runs before any rule');
  ok(['/api/2024-01/graphql.json', '/api/unstable/graphql.json', '/wp-json/wc/store/v1/cart/add-item', '/cart/add.js', '/cart.js', '/cart/clear.js'].every((p) => lib.ENDPOINT_PROBE_PATHS.includes(p)), 'the endpoint probe list has the round 9 paths');
  ok(blockCfg.rules.every((r) => !checkBuiltin(r).length) && blockCfg.rules.filter((r) => r.endpoint || r.endpoint_hosts).every((r) => lib.checkBlockRule(r).join(' ').includes(lib.USER_ENDPOINT_REFUSAL)), 'the shipped list passes as built-ins, and its endpoint rules would be refused as user rules');
}
// C: strict locale on allow decisions
{
  const o = new Set(['s.example']); const after = (u) => lib.allowedAfterCartTouched(u, o, new Set(), { cartFrom: 'https://s.example/products/x' });
  ok(['/pay/', '/buy/', '/faq/', '/cdn/', '/app/'].every((p) => !lib.isHomePage('https://s.example' + p, o) && !after(`https://s.example${p}cart`) && !after(`https://s.example${p}products/x`)), '/pay/, /buy/, /faq/, /cdn/ and /app/ are not locales on allow decisions');
  ok(lib.isHomePage('https://s.example/fr/', o) && lib.isHomePage('https://s.example/zh-hant/', o) && after('https://s.example/pt-br/cart') && after('https://s.example/zh-hant/cart'), 'real locales (fr, pt-br, zh-hant) still work');
  const tr = lib.compileBlockRule({ name: 'tr', kind: 'path', own_host: true, path: '\\?trk=1' }).rule;
  const hit = (p) => lib.findBlockRule([tr], 'https://s.example' + p, { ownHosts: o, allowHosts: [], resourceType: 'script' })?.name === 'tr';
  ok(!hit('/fr/products/x?trk=1') && !hit('/zh-hant/collections/x?trk=1') && hit('/app/products/x?trk=1') && hit('/cdn/collections/x?trk=1') && hit('/faq/shop/x?trk=1'), 'the catalog exemption takes a real locale only (/app/products/... is not a catalog page)');
}
// F: heading only does not count as found
{
  const segs = [{ path: 'main > h2', text: 'Shipping' }, { path: 'main > h2', text: 'Reviews' }, { path: 'main > p', text: 'Short.' }];
  const h = lib.matchTerm(segs, /shipping/i, { requireBody: true });
  ok(h && h.headingOnly === true, 'a bare "Shipping" heading with no body text is marked heading only', JSON.stringify(h));
  const b = lib.matchTerm([{ path: 'main > h2', text: 'Shipping' }, { path: 'main > p', text: 'Ships in two days from our studio in Ohio.' }], /shipping/i, { requireBody: true });
  ok(b && !b.headingOnly && /Shipping: Ships in two days/.test(b.context), 'a heading followed by body text counts as found, with the body as context', JSON.stringify(b));
  ok(lib.matchTerm(segs, /shipping/i)?.headingOnly === undefined, 'without requireBody the old behaviour is kept');
}
// E and F: ownership on loopback, help, dry run
{
  ok(lib.ownershipMatch('127.0.0.1', 'localhost').ok && lib.ownershipMatch('localhost', '127.0.0.1').ok && !lib.ownershipMatch('127.0.0.2', 'localhost').ok && !lib.ownershipMatch('localhost.example', 'localhost').ok, '--i-own localhost matches 127.0.0.1 on this computer only');
  const d = await runPanel(['--url', O, '--i-own', 'localhost', '--personas', pdir8, '--no-cart', '--dry-run']);
  ok(d.code === 0 && !/www\.127\.0\.0\.1/.test(d.out + d.err), '--i-own localhost with a 127.0.0.1 url passes the dry run, and no www.127.0.0.1 is added', `${d.code} ${(d.err + d.out).slice(0, 300)}`);
  const names = (d.out.match(/rule[s]?[^\n]*/gi) || []).join('\n');
  const listed = (d.out.match(/^\s+- [a-z0-9-]+/gm) || []).map((s) => s.trim());
  ok(listed.length === new Set(listed).size, 'the dry-run rule list has no duplicates', names.slice(0, 300));
  const h1 = await runPanel(['-h']);
  ok(h1.code === 0 && /--help/.test(h1.out) && /Practice/.test(h1.out), '-h prints the help', `${h1.code} ${h1.out.slice(0, 120)}`);
}
// A end to end: a user endpoint rule in a config is refused with exit 2; a user "^/cart" rule leaves the cart working
{
  const cf = path.join(tmp, 'r9-endpoint.json'); fs.writeFileSync(cf, JSON.stringify({ block_rules: [{ name: 'my-cart-tracker', kind: 'path', own_host: true, path: '^/cart', endpoint: true }] }));
  const rr = await runPanel(['--cart', '--url', O, '--i-own', '127.0.0.1', '--personas', pdir8, '--out', 'reports-r9e', '--pause', '0', '--config', cf]);
  ok(rr.code === 2 && (rr.err + rr.out).includes(lib.USER_ENDPOINT_REFUSAL) && !fs.existsSync(path.join(tmp, 'reports-r9e')), 'runner: a user rule with "endpoint" is refused at start with exit 2 and the plain message', `${rr.code} ${(rr.err + rr.out).slice(0, 300)}`);
  const pd = path.join(tmp, 'personas-r9c'); fs.mkdirSync(pd);
  fs.copyFileSync(path.join(root, 'examples/personas/northwick-gift-giver-gwen.json'), path.join(pd, 'northwick-gift-giver-gwen.json'));
  const cf2 = path.join(tmp, 'r9-cart.json'); fs.writeFileSync(cf2, JSON.stringify({ block_rules: [{ name: 'my-cart-tracker', kind: 'path', own_host: true, path: '^/cart' }] }));
  const rc = await runPanel(['--cart', '--url', O, '--i-own', '127.0.0.1', '--personas', pd, '--include-drafts', '--out', 'reports-r9c', '--pause', '0', '--config', cf2]);
  const dirC = fs.existsSync(path.join(tmp, 'reports-r9c')) ? fs.readdirSync(path.join(tmp, 'reports-r9c')).map((x) => path.join(tmp, 'reports-r9c', x)).find((x) => fs.existsSync(path.join(x, 'result.json'))) : null;
  const resC = dirC ? JSON.parse(fs.readFileSync(path.join(dirC, 'result.json'), 'utf8')) : { journeys: [] };
  const jc = resC.journeys[0] || {};
  ok(rc.code === 0 && jc.completed && jc.cart_touched === true && !(jc.rule_hits_on_allowed || []).some((x) => /\/cart(\.js|\/)/.test(x.url || '')), 'runner: with a user "^/cart" rule the cart still works (add, read) and no cart call is stopped', `${rc.code} ${jc.quit_kind} ${jc.quit_reason} ${JSON.stringify(jc.rule_hits_on_allowed)}`);
  const mdC = dirC ? fs.readFileSync(path.join(dirC, 'report.md'), 'utf8') : '';
  ok(/found the Checkout button in the cart and stopped there, never tapped it/.test(rc.out) && !/ready to add to cart, stopped there/.test(rc.out), 'console: a cart journey says it found the Checkout button and never tapped it, not "ready to add to cart"', rc.out.slice(0, 300));
  ok(mdC.length > 0 && !/\b1(\.0)? screens\b/.test(mdC), 'report: "1 screen" is singular', (mdC.match(/.*1 screens.*/) || [''])[0]);
  ok(/The test cart is left as it is after each journey \(the panel does not empty it\); store carts expire on their own\./.test(mdC) && !/emptied/i.test(mdC), 'report: the cart line says the test cart is left as it is, and nothing claims a cart was emptied', (mdC.match(/.*test cart.*/i) || [''])[0]);
  ok(/practice run on this computer \(loopback\)[^\n]*localhost[^\n]*intentional/.test(mdC), 'report: the loopback note says blocking localhost is intentional');
}
// D: a store that does not answer is a test error, not a shopper result
{
  const rr = await runPanel(['--cart', '--url', 'http://127.0.0.1:9', '--i-own', '127.0.0.1', '--personas', pdir8, '--out', 'reports-r9d', '--pause', '0']);
  const dd = fs.existsSync(path.join(tmp, 'reports-r9d')) ? fs.readdirSync(path.join(tmp, 'reports-r9d')).map((x) => path.join(tmp, 'reports-r9d', x)).find((x) => fs.existsSync(path.join(x, 'result.json'))) : null;
  const res = dd ? JSON.parse(fs.readFileSync(path.join(dd, 'result.json'), 'utf8')) : { journeys: [] };
  const md = dd ? fs.readFileSync(path.join(dd, 'report.md'), 'utf8') : '';
  const blocking = (md.split('\n## Blocking')[1] || '').split('\n## ')[0];
  ok(rr.code === 1 && res.status === 'incomplete' && res.journeys.length && res.journeys.every((j) => j.store_unreachable && j.quit_kind === 'error'), 'runner: a dead port makes every journey a test error and the run INCOMPLETE (exit 1)', `${rr.code} ${res.status} ${JSON.stringify(res.journeys.map((j) => j.quit_kind))}`);
  ok(res.journeys.every((j) => /^The store refused the connection at http:\/\/127\.0\.0\.1:9 \(nothing is listening there\)\. Check the address, or that the store \(or "npm run fixture"\) is running, then run again\./.test(j.quit_reason || '')) && new Set(res.journeys.map((j) => j.quit_reason)).size === 1, 'the message says the store refused the connection and what to check, the same on every engine', res.journeys[0]?.quit_reason);
  ok(!/https?:\\\/\\\//.test(md) && !/\\`/.test(md), 'report: no backslash escapes in the error text (no http:\\/\\/, no escaped backticks)', (md.match(/refused[^\n]*/) || [''])[0]);
  ok(/Error \(not a shopper result\)/.test(md) && !/127\.0\.0\.1:9/.test(blocking) && !/test cart is left as it is/.test(md) && /## Test problems \(not shopper results\)/.test(md) && /the store did not answer for \d+ journey/.test(res.summary || ''), 'report: the result reads "Error (not a shopper result)", nothing is under Blocking and no cart line is written', blocking.slice(0, 200));
  ok(/\*\*In short: the store did not answer, so no journey could be tested; nothing was added to a cart/.test(md) && !/shopped like a customer/.test(md), 'report: when the store did not answer, the top line does not claim the panel shopped', (md.match(/.*In short.*/) || [''])[0]);
  ok(/No journey could be tested, so there is no shopper result\./.test(res.summary || '') && !/\d+ of \d+ shopper journeys/.test(res.summary || '') && !/Stopped short/.test(res.summary || ''), 'R10: when every journey was a test error, the summary drops the "0 of N reached" line and the stopped-short list', res.summary);
  ok(/could not start: The store refused the connection/.test(rr.out) && !/ quit at "arrive"/.test(rr.out) && /could not start: The store refused/.test(md) && !/practice run on this computer/.test(md), 'R10: the console and report say "could not start", not "quit", and the loopback note is left out', rr.out.slice(0, 300));
}
// B: the journey watchdog ends a page that stops responding, and the report and result.json are still written
{
  const http = await import('node:http');
  const page = '<!doctype html><html><head><title>Hang candle</title><meta name="viewport" content="width=device-width"></head><body class="product"><div class="product"><h1>Hang candle</h1><span class="price">$20.00</span><form action="/cart/add" method="post"><button type="submit" name="add">Add to cart</button></form><p>Ships in 2 days</p></div><script>setTimeout(function(){ for(;;){} }, 2500);</script></body></html>';
  const hs = shopServer((q, r) => { if (q.url.startsWith('/cart.js')) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end('{"item_count":0}'); } r.writeHead(200, { 'content-type': 'text/html' }); r.end(page); });
  await new Promise((res) => hs.listen(0, '127.0.0.1', res));
  const HO = `http://127.0.0.1:${hs.address().port}`;
  const pd = path.join(tmp, 'personas-hang'); fs.mkdirSync(pd);
  fs.writeFileSync(path.join(pd, 'hang-wk.json'), JSON.stringify({ ...base, id: 'hang-wk', name: 'hang-wk', device: 'iphone-14', main_quit_reason: 'hang check', popups: 'leave', entry_point: { channel: 'direct', landing_path: '/products/hang' }, product_pick: null, before_buying: [{ need: 'shipping', look_for: ['ships in \\d'], if_missing: 'warn' }], choices: [] }));
  const t0 = Date.now();
  const rr = await runPanel(['--url', HO, '--i-own', '127.0.0.1', '--personas', pd, '--out', 'reports-hang', '--pause', '0', '--no-cart'], { SP_TEST_JOURNEY_CAP_SECONDS: '20' });
  const secs = (Date.now() - t0) / 1000;
  hs.closeAllConnections?.(); hs.close();
  const hd = fs.existsSync(path.join(tmp, 'reports-hang')) ? fs.readdirSync(path.join(tmp, 'reports-hang')).map((x) => path.join(tmp, 'reports-hang', x)).find((x) => fs.existsSync(path.join(x, 'result.json'))) : null;
  const res = hd ? JSON.parse(fs.readFileSync(path.join(hd, 'result.json'), 'utf8')) : { journeys: [] };
  const j = res.journeys[0] || {};
  ok(rr.code === 1 && res.status === 'incomplete' && j.quit_kind === 'test_error' && /^journey timed out \(the page stopped responding\)/.test(j.quit_reason || '') && j.timed_out === true, 'runner: a page that stops responding is ended by the watchdog as a test error, and the run is INCOMPLETE (exit 1)', `${rr.code} ${res.status} ${j.quit_kind} ${j.quit_reason} ${(rr.err || '').slice(-300)}`);
  ok(hd && fs.existsSync(path.join(hd, 'report.md')) && secs < 150, 'the report and result.json are still written, well before the test killer', `${secs.toFixed(0)} s`);
}

// ---------- R10 ----------
const latestRun = (dir) => { const d = path.join(tmp, dir); const x = fs.existsSync(d) ? fs.readdirSync(d).map((y) => path.join(d, y)).find((y) => fs.existsSync(path.join(y, 'result.json'))) : null; return { res: x ? JSON.parse(fs.readFileSync(path.join(x, 'result.json'), 'utf8')) : { journeys: [], findings: [] }, md: x ? fs.readFileSync(path.join(x, 'report.md'), 'utf8') : '' }; };
// 1: a locale is two letters, optionally with a region of two letters, four letters or three digits; /pay-now/ is never a locale
{
  const own = new Set(['shop.example']);
  ok(['/pay-now/', '/buy-now/', '/one-tap/'].every((p) => !lib.isHomePage('https://shop.example' + p, own)) && ['/en-us/', '/zh-hant/', '/es-419/', '/fr/'].every((p) => lib.isHomePage('https://shop.example' + p, own)), 'locales: en-us, zh-hant, es-419 and fr are locales; /pay-now/, /buy-now/ and /one-tap/ are not');
  const ar = (u) => lib.allowedAfterCartTouched(u, own, new Set(), { cartFrom: 'https://shop.example/products/x' });
  ok(!ar('https://shop.example/pay-now/cart') && !ar('https://shop.example/buy-now/cart') && ar('https://shop.example/es-419/cart') && ar('https://shop.example/zh-hant/cart'), 'locales: a cart page under /pay-now/ is not allowed after the cart is touched; one under a real locale is');
}
// 2, 4, 5: spec lists, tables, fieldsets, Dawn accordions, and a heading-only hit on an early pattern
{
  ok(lib.matchTerm([{ path: 'dl > dt', text: 'Burn time' }, { path: 'dl > dd', text: '40 hours' }], /burn time/i, { requireBody: true })?.headingOnly === undefined, 'a dt followed by a short dd counts as found');
  ok(lib.matchTerm([{ path: 'tr > th', text: 'Wax', body: 'Soy' }, { path: 'tr > td', text: 'Soy' }], /wax/i, { requireBody: true })?.headingOnly === undefined, 'a th whose row or column holds a short td counts as found');
  ok(lib.matchTerm([{ path: 'tr > th', text: 'Wax' }, { path: 'tr > th', text: 'Size' }, { path: 'tr > td', text: 'Soy' }], /wax/i, { requireBody: true })?.headingOnly === true, 'a th is never paired with the next segment in reading order');
  const acc = lib.matchTerm([{ path: 'summary > div.summary__title > h2.accordion__title', text: 'Shipping', body: 'Ships in two days' }], /shipping/i, { requireBody: true });
  ok(acc && !acc.headingOnly && /Shipping: Ships in two days/.test(acc.context), 'a Dawn accordion title uses its <details> content as the body', JSON.stringify(acc));
  const fb2 = lib.matchTerm([{ path: 'summary > div > h2', text: 'Shipping', body: '' }, { path: 'div > p', text: 'Ships in two days to most of the country' }], /shipping/i, { requireBody: true });
  ok(fb2 && fb2.headingOnly === true, 'with an empty <details> body the heading is heading only; the next segments are never borrowed', JSON.stringify(fb2));
  const fb3 = lib.matchTerm([{ path: 'div > h2', text: 'Shipping' }, { path: 'div > p', text: 'Ships in two days to most of the country' }], /shipping/i, { requireBody: true });
  ok(fb3 && !fb3.headingOnly, 'with no structural container at all, the next segments are the body', JSON.stringify(fb3));
  ok(lib.matchTerm([{ path: 'dl > dt', text: 'Burn time' }, { path: 'dl > dt', text: 'Wax' }], /burn time/i, { requireBody: true })?.headingOnly === true, 'a dt with no dd is still heading only');
  const http = await import('node:http');
  const product = (extra) => `<!doctype html><html><head><title>Spec candle</title><meta name="viewport" content="width=device-width"></head><body><main><div class="product"><div class="product-info"><h1>Spec candle</h1><img src="/img.svg" style="width:100%;height:200px">${extra}<form action="/cart/add" method="post"><input type="hidden" name="id" value="1"><button type="submit" name="add">Add to cart</button></form>
<dl><dt>Burn time</dt><dd>40 hours</dd><dt>Wax</dt><dd>Soy</dd></dl><table><tr><th>Wick</th><td>Cotton</td></tr></table>
<fieldset><legend>Color</legend><label><input type="radio" name="c" value="o" checked> Orange</label><label><input type="radio" name="c" value="b"> Blue</label></fieldset>
<details><summary><div class="summary__title"><svg width="10" height="10"></svg><h2 class="accordion__title">Shipping</h2></div></summary><div class="accordion__content"><p>Ships in two days</p></div></details>
<h3>Returns</h3><h3>Care</h3><p>Trim the wick before each burn for a clean flame.</p><p>Full refund within 30 days, no questions asked.</p></div></div></main></body></html>`;
  const price = '<span class="price" itemprop="price" content="20">$20.00</span>';
  const ss = shopServer((q, r) => {
    if (q.url.startsWith('/img.svg')) { r.writeHead(200, { 'content-type': 'image/svg+xml' }); return r.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="red"/></svg>'); }
    if (q.url.startsWith('/cart.js')) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end('{"item_count":0,"items":[]}'); }
    if (q.url.startsWith('/products/silent')) return; // accepts the connection, never answers
    r.writeHead(200, { 'content-type': 'text/html' }); r.end(product(q.url.startsWith('/products/noprice') ? '' : price));
  });
  await new Promise((res) => ss.listen(0, '127.0.0.1', res));
  const SO = `http://127.0.0.1:${ss.address().port}`;
  const pd = path.join(tmp, 'personas-r10'); fs.mkdirSync(pd);
  const allNeeds = [{ need: 'burn time', look_for: ['burn time'], if_missing: 'quit' }, { need: 'wick', look_for: ['wick'], if_missing: 'quit' }, { need: 'colour', look_for: ['colou?rs?', 'orange'], if_missing: 'quit' }, { need: 'shipping', look_for: ['shipping'], if_missing: 'quit' }, { need: 'returns', look_for: ['returns', 'refund'], if_missing: 'quit' }];
  const P = (id, device, landing, needs) => { const p = { ...base, id, name: id, device, main_quit_reason: `r10 ${id}`, popups: 'leave', patience: { ...base.patience, load_seconds: 10 }, photos_to_view: 1, entry_point: { channel: 'direct', landing_path: landing }, product_pick: null, before_buying: needs, choices: [] }; const errs = checkPersona(p); ok(!errs.length, `test persona ${id} is valid`, errs.join('; ')); fs.writeFileSync(path.join(pd, `${id}.json`), JSON.stringify(p)); };
  P('spec-wk', 'iphone-14', '/products/spec', allNeeds); P('spec-cr', 'pixel-7', '/products/spec', allNeeds);
  P('miss-a-wk', 'iphone-14', '/products/spec', [{ need: 'warranty', look_for: ['lifetime warranty'], if_missing: 'quit' }]);
  P('miss-a2-cr', 'pixel-7', '/products/spec', [{ need: 'warranty', look_for: ['lifetime warranty'], if_missing: 'quit' }]);
  P('miss-b-wk', 'iphone-14', '/products/spec', [{ need: 'gift wrap', look_for: ['gift wrap'], if_missing: 'quit' }]);
  P('noprice-wk', 'iphone-14', '/products/noprice', allNeeds.slice(0, 1));
  P('silent-wk', 'iphone-14', '/products/silent', allNeeds.slice(0, 1));
  const rr = await runPanel(['--url', SO, '--i-own', '127.0.0.1', '--personas', pd, '--out', 'reports-r10', '--pause', '0', '--no-cart']);
  ss.closeAllConnections?.(); ss.close();
  const { res, md } = latestRun('reports-r10');
  const Jr = Object.fromEntries(res.journeys.map((j) => [j.persona, j]));
  for (const e of ['wk', 'cr']) {
    const j = Jr[`spec-${e}`] || { trust_matches: [] };
    const ctx = Object.fromEntries((j.trust_matches || []).map((m) => [m.need, m]));
    ok(j.completed && ['burn time', 'wick', 'colour', 'shipping', 'returns'].every((n) => ctx[n] && !ctx[n].heading_only), `runner (${e}): dl/dd, th/td, a fieldset legend with options, a Dawn accordion and a later pattern after a heading-only hit all count as found`, `${j.quit_kind} ${j.quit_reason} ${JSON.stringify(j.trust_matches)}`);
    ok(/Burn time: 40 hours/.test(ctx['burn time']?.context) && /Shipping: Ships in two days/.test(ctx.shipping?.context) && /refund/i.test(ctx.returns?.context), `runner (${e}): the context shows the body text the heading introduces`, JSON.stringify(ctx));
  }
  // 3, 11: grouping by the exact need, and only journeys whose own quit was blocking
  const items = (md.split('## What to fix first')[1] || '').split('\n## ')[0].split('\n').filter((l) => /^\d+\. At "/.test(l));
  ok(items.length === 2 && /2 shoppers \(miss-a-wk on \/products\/spec, miss-a2-cr on \/products\/spec\): "warranty"/.test(items[0]) && !/text blocks|characters read/.test(items[0]) && !/text blocks|characters read/.test(items[1]) && /1 shopper \(miss-b-wk\): "gift wrap"/.test(items[1]), '"What to fix first" keeps different missing needs apart and counts the same one together', JSON.stringify(items));
  // 6: a tool limit is labelled as one, and is left out of "Stopped short" and "What to fix first"
  const np = Jr['noprice-wk'] || {};
  ok(np.quit_kind === 'test_limit' && /\| noprice-wk \|[^\n]*\| Test limit \(not a shopper result\) \|/.test(md) && !/noprice-wk at "/.test(res.summary) && !items.some((l) => /noprice-wk/.test(l)), 'a tool limit reads "Test limit (not a shopper result)" and is not a stopped-short shopper or a fix', `${np.quit_kind} ${res.summary}`);
  // 7: a page load that timed out on a server that took the connection is not "did not answer"
  const sj = Jr['silent-wk'] || {};
  ok(sj.quit_kind === 'error' && !sj.store_unreachable && /^the page did not load/.test(sj.quit_reason || '') && !/did not answer|refused the connection/.test(sj.quit_reason || '') && !/did not answer/.test(res.summary), 'iPhone size: a page load that times out on a server that answered says "the page did not load", never "did not answer"', `${sj.quit_kind} ${sj.quit_reason}`);
  ok(/Tested: <http:\/\/127\.0\.0\.1:\d+\/?>/.test(md) && !/Tested:[^\n]*\\\//.test(md), 'report: the "Tested:" address is not escaped', (md.match(/Tested:.*/) || [''])[0]);
  ok(!/practice run on this computer/.test(md), 'report: the loopback note is left out when localhost was not blocked');
  ok(rr.code === 1, 'that run is INCOMPLETE (a tool limit and an error)', String(rr.code));
}
// 1 end to end: a redirect to /pay-now/ after Add to cart is stopped before it reaches the store (both phones)
{
  const http = await import('node:http');
  const seen = [];
  const page = '<!doctype html><html><head><title>Pay candle</title><meta name="viewport" content="width=device-width"></head><body><main><div class="product"><h1>Pay candle</h1><img src="/img.svg" style="width:100%;height:200px"><span class="price" itemprop="price" content="20">$20.00</span><form action="/cart/add" method="post"><input type="hidden" name="id" value="1"><button type="submit" name="add">Add to cart</button></form><p>Ships in 2 days</p></div></main></body></html>';
  const ps = shopServer((q, r) => {
    seen.push(`${q.method} ${q.url}`);
    if (q.url.startsWith('/img.svg')) { r.writeHead(200, { 'content-type': 'image/svg+xml' }); return r.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="red"/></svg>'); }
    if (q.url.startsWith('/cart.js')) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end('{"item_count":0,"items":[]}'); }
    if (q.url.startsWith('/cart/add')) { r.writeHead(302, { location: '/pay-now/' }); return r.end(); }
    if (q.url.startsWith('/pay-now')) { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<html><body class="woocommerce-checkout"><form class="checkout"><input name="billing_email"><button>Place order</button></form></body></html>'); }
    r.writeHead(200, { 'content-type': 'text/html' }); r.end(page);
  });
  await new Promise((res) => ps.listen(0, '127.0.0.1', res));
  const pd = path.join(tmp, 'personas-paynow'); fs.mkdirSync(pd);
  for (const [id, device] of [['pay-wk', 'iphone-14'], ['pay-cr', 'pixel-7']]) fs.writeFileSync(path.join(pd, `${id}.json`), JSON.stringify({ ...base, id, name: id, device, main_quit_reason: `pay now ${id}`, popups: 'leave', photos_to_view: 1, entry_point: { channel: 'direct', landing_path: '/products/pay' }, product_pick: null, before_buying: [{ need: 'ship', look_for: ['ships in \\d'], if_missing: 'warn' }], choices: [] }));
  const rr = await runPanel(['--cart', '--url', `http://127.0.0.1:${ps.address().port}`, '--i-own', '127.0.0.1', '--personas', pd, '--out', 'reports-paynow', '--pause', '0']);
  ps.closeAllConnections?.(); ps.close();
  const { res } = latestRun('reports-paynow');
  ok(res.journeys.length === 2 && seen.some((x) => x.startsWith('POST /cart/add')) && !seen.some((x) => /^GET \/pay-now/.test(x)) && !res.checkout_page_loaded, 'a redirect to /pay-now/ after Add to cart never reaches the store, on both phones', `${rr.code} ${JSON.stringify(seen.filter((x) => !/cart\.js|img/.test(x)))}`);
}
// 8: Ctrl-C stops the run and writes a partial report; the test cart is left as it is (no cleanup request)
{
  const pd = path.join(tmp, 'personas-sigint'); fs.mkdirSync(pd);
  fs.copyFileSync(path.join(root, 'examples/personas/northwick-gift-giver-gwen.json'), path.join(pd, 'northwick-gift-giver-gwen.json'));
  const h0 = server.requests.length;
  const child = spawn(process.execPath, [path.join(root, 'scripts/shopper-panel.mjs'), '--cart', '--url', O, '--i-own', '127.0.0.1', '--personas', pd, '--include-drafts', '--out', 'reports-sigint', '--pause', '0'], { cwd: tmp, env: { ...process.env, SP_TEST_JOURNEY_CAP_SECONDS: '90' } });
  let err = ''; child.stderr.on('data', (d) => { err += d; }); child.stdout.on('data', () => {});
  const code = await new Promise((resolve) => {
    const killer = setTimeout(() => child.kill('SIGKILL'), 4 * 60 * 1000);
    let sent = false;
    const poll = setInterval(() => { if (!sent && server.requests.slice(h0).some((r) => r.method === 'POST' && /^\/cart\/add/.test(r.url))) { sent = true; setTimeout(() => interrupt(child), 1000); } }, 50);
    child.on('exit', (c) => { clearTimeout(killer); clearInterval(poll); resolve(c); });
  });
  const { res, md } = latestRun('reports-sigint');
  const j = res.journeys[0] || {};
  const clears = server.requests.slice(h0).filter((r) => r.method === 'POST' && r.url.startsWith('/cart/clear.js'));
  ok(code === 1 && md.length > 0 && j.stopped === true && /the run was stopped/.test(j.quit_reason || '') && (res.setup_warnings || []).some((w) => /partial report/.test(w)), 'Ctrl-C: the run stops, and a partial report and result.json are written (exit 1)', `${code} ${j.quit_reason} ${err.slice(0, 200)}`);
  ok(clears.length === 0 && !('cart_emptied' in j), 'Ctrl-C: no cart cleanup request is sent; the test cart is left as it is', `${clears.length} ${j.cart_emptied}`);
}
// 9: every browser close at the end of a run has a timeout
{
  const src = fs.readFileSync(path.join(root, 'scripts/shopper-panel.mjs'), 'utf8');
  ok(/for \(const b of Object\.values\(browsers\)\) await withTimeout\(b\.close\(\), \d+\)/.test(src), 'the final browser close has a timeout');
}
// 10, 12, LOW: the practice command, the persona-folder messages, the validator and the docs
{
  const CMD = 'node ~/.claude/skills/ai-shopper-agent-panel/scripts/shopper-panel.mjs --url http://127.0.0.1:<port> --i-own 127.0.0.1 --personas ./personas';
  const VAL = 'node ~/.claude/skills/ai-shopper-agent-panel/scripts/validate-personas.mjs ./personas';
  const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const PS_CMD = 'node "$env:USERPROFILE\\.claude\\skills\\ai-shopper-agent-panel\\scripts\\shopper-panel.mjs" --url http://127.0.0.1:<port> --i-own 127.0.0.1 --personas .\\personas';
  ok(['README.md', 'SKILL.md', 'AGENTS.md'].every((f) => rd(f).includes(CMD) && rd(f).includes(PS_CMD) && /go to (your|the user's|the) project folder \(where (your|their|the) personas\/ folder is\)/.test(rd(f))), 'docs: README, SKILL.md and AGENTS.md give the practice command from the project folder, in the ~ form and the PowerShell form');
  ok(rd('scripts/fixture-server.mjs').includes("--personas \"${path.join(skill, 'examples', 'personas')}\" --include-drafts") && rd('scripts/fixture-server.mjs').includes('--personas ./personas'), 'the practice store prints the example command with the skill path in quotes, and how to use your own personas');
  const h = await runPanel(['--help']);
  ok(h.code === 0 && h.out.includes(CMD) && h.out.includes(PS_CMD), '--help gives the practice command from the project folder, also in the PowerShell form');
  const none = await runPanel([]);
  ok(none.code === 2 && /^Missing --url and --i-own\./.test(none.err), 'no arguments: "Missing --url and --i-own." comes first, exit 2', none.err.slice(0, 80));
  fs.mkdirSync(path.join(tmp, 'empty-personas'));
  const ep = await runPanel(['--cart', '--url', O, '--i-own', '127.0.0.1', '--personas', 'empty-personas', '--dry-run']);
  ok(ep.code === 2 && /No persona files[^\n]*\. If your shoppers are in your project folder, pass --personas <that folder>\/personas\./.test(ep.err) && !/cp examples/.test(ep.err), 'no persona files: the message first says how to point at the project folder, and never says to copy the examples', ep.err.slice(0, 300));
  const all = ['README.md', 'SKILL.md', 'AGENTS.md', 'SECURITY.md', 'docs/block-rules.md', 'scripts/shopper-panel.mjs', 'scripts/validate-personas.mjs', 'scripts/fixture-server.mjs'].map(rd).join('\n');
  ok(!/cp examples\/personas/.test(all), 'nothing tells the user to copy the examples into a panel');
  ok(rd('docs/block-rules.md').includes(VAL) && /already blocks every third-party host that is not on its allow list/.test(rd('docs/block-rules.md')) && /A rule is still needed/.test(rd('docs/block-rules.md')), 'block-rules.md: the check command runs from the project folder, and it says when a rule is still needed');
  const ex = [...rd('docs/block-rules.md').matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1])).flatMap((j) => j.block_rules || [j]).find((r) => r.name === 'example-events');
  const exr = lib.compileBlockRule(ex).rule; const own = new Set(['shop.example']);
  ok(exr && lib.findBlockRule([exr], 'https://shop.example/apps/example-events/collect', { ownHosts: own, resourceType: 'fetch' }) && lib.findBlockRule([exr], 'https://shop.example/apps/example-events/collect/v2', { ownHosts: own, resourceType: 'fetch' }) && !lib.findBlockRule([exr], 'https://shop.example/apps/example-events/collectors', { ownHosts: own, resourceType: 'fetch' }), 'block-rules.md example 3 stops /collect but not /collectors');
  ok(lib.checkBlockRule({ name: 'x', kind: 'host', hosts: ['https://cdn.example-apps.com/'] }).some((e) => /Fix: remove https:\/\/ and the trailing \//.test(e)) && lib.checkBlockRule({ name: 'x', kind: 'host', hosts: ['bad host'] }).every((e) => !/Fix: remove https/.test(e) && /"elevar\." with the trailing dot/.test(e)), 'a host given as a URL gets "Fix: remove https:// and the trailing /", and the example is not cut off');
  // the validator: (no name), and the config next to the persona folder
  const proj = path.join(tmp, 'r10-project'); fs.mkdirSync(path.join(proj, 'personas'), { recursive: true });
  fs.copyFileSync(path.join(root, 'examples/personas/northwick-gift-giver-gwen.json'), path.join(proj, 'personas', 'northwick-gift-giver-gwen.json'));
  fs.writeFileSync(path.join(proj, 'shopper-panel.config.json'), JSON.stringify({ block_rules: [{ kind: 'host', hosts: ['https://cdn.example-apps.com/'] }] }));
  const v = await new Promise((resolve) => { const c = spawn(process.execPath, [path.join(root, 'scripts/validate-personas.mjs'), path.join(proj, 'personas')], { cwd: tmp }); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { o += d; }); c.on('exit', (code) => resolve({ code, o })); });
  ok(v.code === 1 && /Note: no shopper-panel\.config\.json in this folder; using [^\n]*r10-project\/shopper-panel\.config\.json/.test(v.o) && /rule 1 \(\(no name\)\)/.test(v.o) && !/undefined/.test(v.o) && /Fix: remove https:\/\//.test(v.o), 'validator: run from elsewhere, it reads the config next to the persona folder, says so, and shows (no name)', v.o.slice(0, 600));
}

// Round 12, 1: a locale is checked with Intl (isRealLocaleSegment), never by shape, on every allow decision
{
  const o = new Set(['s.example']);
  const fake = ['/pay-here/', '/buy-this/', '/pay-us/', '/go-ca/', '/fr-cart/', '/pay-419/'];
  const real = ['/fr/', '/en-us/', '/zh-hant/', '/es-419/', '/pt-br/'];
  ok(['fr', 'en', 'zh', 'es', 'en-us', 'zh-hant', 'zh-hans', 'sr-latn', 'es-419', 'pt-br'].every(lib.isRealLocaleSegment) && !['pay', 'go', 'buy', 'pay-here', 'buy-this', 'pay-us', 'go-ca', 'fr-cart', 'pay-419', 'en-xx1', ''].some(lib.isRealLocaleSegment), 'isRealLocaleSegment: fr, en-us, zh-hant, es-419 are locales; pay, go, buy, pay-here, go-ca, fr-cart, pay-419 are not');
  const tap = (u) => lib.allowedAfterCartTouched(u, o, new Set(), { cartFrom: 'https://s.example/products/x' });
  const ca = (u) => lib.allowedAfterCartAction(u, o, new Set(['/products/x']), 'https://s.example/cart/add');
  ok(fake.every((p) => !lib.isHomePage('https://s.example' + p, o) && !tap(`https://s.example${p}cart`) && !ca('https://s.example' + p) && !ca(`https://s.example${p}cart`)), 'fake locales (/pay-here/, /buy-this/, /pay-us/, /go-ca/, /fr-cart/, /pay-419/) pass no allow decision', JSON.stringify(fake.filter((p) => lib.isHomePage('https://s.example' + p, o) || ca('https://s.example' + p))));
  ok(real.every((p) => lib.isHomePage('https://s.example' + p, o) && tap(`https://s.example${p}cart`) && ca('https://s.example' + p) && ca(`https://s.example${p}cart`)), 'real locales (/fr/, /en-us/, /zh-hant/, /es-419/) still pass');
  ok(ca('https://s.example/') && ca('https://s.example/cart') && ca('https://s.example/products/x') && !ca('https://s.example/products/other') && !ca('https://s.example/collections/all') && !ca('https://s.example/pages/pay') && lib.allowedAfterCartAction('https://s.example/product/y/', o, new Set(), 'https://s.example/product/y/'), 'after a cart action only the landing page, the page the action came from, "/", the cart, or a locale home may follow');
  const tr = lib.compileBlockRule({ name: 'tr', kind: 'path', own_host: true, path: '\\?trk=1' }).rule;
  const hit = (p, r = tr) => lib.findBlockRule([r], 'https://s.example' + p, { ownHosts: o, allowHosts: [], resourceType: 'script' })?.name === r.name;
  ok(!hit('/en-us/products/x?trk=1') && !hit('/es-419/collections/x?trk=1') && hit('/pay-here/products/x?trk=1') && hit('/go-ca/collections/x?trk=1') && hit('/fr-cart/shop/x?trk=1'), 'the catalog exemption takes a real locale only (/pay-here/products/... is not a catalog page)');
  const pr = lib.compileBlockRule({ name: 'pr', kind: 'path', own_host: true, path: '\\?x=1' }).rule;
  ok(!!pr && !hit('/fr/cart.js?x=1', pr) && !hit('/en-us/cart/add?x=1', pr) && hit('/pay-here/cart.js?x=1', pr) && hit('/go-ca/cart/add?x=1', pr), 'the hard allow takes a real locale only (/pay-here/cart.js is not the store cart)');
  const scr = lib.beaconBlockerScript({ ownHosts: ['s.example'], rules: [tr] });
  ok(scr.includes('const isRealLocaleSegment = function isRealLocaleSegment') || /const isRealLocaleSegment = (async )?function/.test(scr), 'the page script carries the same isRealLocaleSegment helper', scr.slice(0, 200));
  let compiles = true; try { new Function(scr); } catch (e) { compiles = e.message; }
  ok(compiles === true, 'the page script compiles', String(compiles));
}
// Round 12, 1 end to end: an add-to-cart redirect to a fake locale page is stopped before any request reaches it (both phones)
{
  const http = await import('node:http');
  const slugs = ['/pay-here/', '/buy-this/', '/go-ca/', '/fr-cart/', '/pay-419/'];
  const seen = [];
  const page = (k) => `<!doctype html><html><head><title>Pay candle</title><meta name="viewport" content="width=device-width"></head><body><main><div class="product"><h1>Pay candle</h1><img src="/img.svg" style="width:100%;height:200px"><span class="price" itemprop="price" content="20">$20.00</span><form action="/cart/add?k=${k}" method="post"><input type="hidden" name="id" value="1"><button type="submit" name="add">Add to cart</button></form><p>Ships in 2 days</p></div></main></body></html>`;
  const ps = shopServer((q, r) => {
    seen.push(`${q.method} ${q.url}`);
    if (q.url.startsWith('/img.svg')) { r.writeHead(200, { 'content-type': 'image/svg+xml' }); return r.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="red"/></svg>'); }
    if (q.url.startsWith('/cart.js')) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end('{"item_count":0,"items":[]}'); }
    const ka = /^\/cart\/add\?k=(\d)/.exec(q.url); if (ka) { r.writeHead(302, { location: slugs[+ka[1]] }); return r.end(); }
    if (slugs.some((s) => q.url.startsWith(s))) { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<html><body><h1>Pay now</h1><form><input name="card_number"><button>Pay $20</button></form></body></html>'); }
    const pk = /^\/products\/pay-(\d)/.exec(q.url);
    r.writeHead(200, { 'content-type': 'text/html' }); r.end(page(pk ? pk[1] : 0));
  });
  await new Promise((res) => ps.listen(0, '127.0.0.1', res));
  const pd = path.join(tmp, 'personas-r12-locale'); fs.mkdirSync(pd);
  slugs.forEach((s, k) => { const id = `loc${k}-${k % 2 ? 'cr' : 'wk'}`; fs.writeFileSync(path.join(pd, `${id}.json`), JSON.stringify({ ...base, id, name: id, device: k % 2 ? 'pixel-7' : 'iphone-14', main_quit_reason: `fake locale ${s}`, popups: 'leave', photos_to_view: 1, entry_point: { channel: 'direct', landing_path: `/products/pay-${k}` }, product_pick: null, before_buying: [{ need: 'ship', look_for: ['ships in \\d'], if_missing: 'warn' }], choices: [] })); });
  const rr = await runPanel(['--cart', '--url', `http://127.0.0.1:${ps.address().port}`, '--i-own', '127.0.0.1', '--personas', pd, '--out', 'reports-r12-locale', '--pause', '0']);
  ps.closeAllConnections?.(); ps.close();
  const { res } = latestRun('reports-r12-locale');
  const posts = slugs.map((_, k) => seen.some((x) => x.startsWith(`POST /cart/add?k=${k}`)));
  ok(res.journeys.length === 5 && posts.every(Boolean) && !seen.some((x) => slugs.some((s) => x.startsWith(`GET ${s}`))) && !res.checkout_page_loaded, 'a redirect to /pay-here/, /buy-this/, /go-ca/, /fr-cart/ or /pay-419/ after Add to cart is stopped and never requested (WebKit and Chromium)', `${rr.code} posts=${posts} ${seen.filter((x) => !/img|cart\.js/.test(x)).join(' | ')}`);
  ok(res.journeys.every((j) => (j.checkout_blocked || []).some((c) => /unknown redirect target, not fetched/.test(c.why) && c.reached_server === false)), 'each stop says the redirect target was not fetched', JSON.stringify(res.journeys.map((j) => (j.checkout_blocked || []).map((c) => c.why))));
}
// Round 12, 2 to 4: an empty structural body is heading only, a header row maps by column, picker options
{
  const b = await chromium.launch();
  const pg = await b.newPage();
  await pg.setContent(`<main><div class="product"><h1>Spec candle</h1>
<h2>Returns</h2><div class="rte"></div><p>Hand poured in small batches in our own workshop.</p>
<details><summary>Delivery</summary><div class="accordion__content"></div></details><p>Every candle is wrapped in paper by hand.</p>
<h3>Care</h3><div class="rte"><p>Trim the wick to 5 mm.</p></div>
<table><tr><th>Burn time</th><th>Wax</th><th>Size</th></tr><tr><td>40 hours</td><td>Soy</td><td>8 oz</td></tr></table>
<fieldset><legend>Size</legend><label><input type="radio" name="s" value="8"> 8 oz</label><label><input type="radio" name="s" value="12"> 12 oz</label></fieldset>
<fieldset><legend>Wick type</legend><label><input type="radio" name="w" value="c"> Cotton</label><label><input type="radio" name="w" value="w"> Wood</label></fieldset>
<form action="/cart/add" method="post"><button type="submit" name="add">Add to cart</button></form></div></main>`);
  const segs = await pg.evaluate(lib.readTextSegments, { sel: lib.SEL, maxChars: lib.MAX_SCAN_CHARS, mode: 'product' });
  await b.close();
  const m = (re, patterns) => lib.matchTerm(segs, re, { requireBody: true, ...(patterns ? { patterns } : {}) });
  ok(m(/returns/i)?.headingOnly === true, 'a heading followed by an empty .rte container is heading only (the next paragraph is not borrowed)', JSON.stringify(m(/returns/i)));
  ok(m(/delivery/i)?.headingOnly === true, 'a <details> with an empty body is heading only (the next paragraph is not borrowed)', JSON.stringify(m(/delivery/i)));
  ok(m(/care/i) && !m(/care/i).headingOnly && /Care: Trim the wick/.test(m(/care/i).context), 'a heading followed by a container with text uses that container as its body', JSON.stringify(m(/care/i)));
  ok(/Burn time: 40 hours/.test(m(/burn time/i)?.context || '') && /Wax: Soy/.test(m(/\bwax\b/i)?.context || '') && /Size: 8 oz/.test(m(/^size$/i)?.context || '') && !m(/burn time/i).headingOnly && !m(/\bwax\b/i).headingOnly, 'a header row of th maps each column to the td below it (Burn time: 40 hours, Wax: Soy, Size: 8 oz)', JSON.stringify([m(/burn time/i), m(/\bwax\b/i), m(/^size$/i)]));
  const sizeLegend = lib.matchTerm(segs.filter((x) => !/(^|> )th/.test(x.path)), /\bsize\b/i, { requireBody: true });
  ok(sizeLegend?.headingOnly === true, 'a picker legend "Size" is not answered by its own option labels', JSON.stringify(sizeLegend));
  const wick = /wick type/i;
  ok(m(wick, [wick])?.headingOnly === true, 'picker options that do not match the need\'s patterns are not the answer', JSON.stringify(m(wick, [wick])));
  const wick2 = m(wick, [wick, /cotton/i]);
  ok(wick2 && !wick2.headingOnly && /\(picker options\)$/.test(wick2.context), 'picker options that match one of the need\'s patterns count, marked "(picker options)"', JSON.stringify(wick2));
}
// Round 12, 5 and 6: an unknown name and a dead port each get one message whatever the engine, reported right away
{
  ok(lib.unreachableKind('net::ERR_NAME_NOT_RESOLVED at https://shop.invalid/', 'other') === 'dns' && lib.unreachableKind('A server with the specified hostname could not be found.', 'timeout') === 'dns' && lib.unreachableKind('anything', 'dns') === 'dns', 'a name that does not resolve is "dns" on Chromium and WebKit wording, and from the probe');
  ok(lib.unreachableKind('net::ERR_CONNECTION_REFUSED', 'other') === 'refused' && lib.unreachableKind('Could not connect to the server.', 'timeout') === 'refused' && lib.unreachableKind('Timeout 30000ms exceeded', 'refused') === 'refused' && lib.unreachableKind('net::ERR_CONNECTION_RESET', 'timeout') === 'timeout', 'a refused port is "refused" whatever the engine says; a reset is "did not answer"');
  ok(/^The address https:\/\/shop\.invalid does not exist \(the name did not resolve\)\. Check the address/.test(lib.unreachableMessage('https://shop.invalid', 'dns', 0)) && !/refused/.test(lib.unreachableMessage('https://shop.invalid', 'dns', 0)), 'DNS failure: "The address <origin> does not exist (the name did not resolve)."');
  const net = await import('node:net');
  const dead = await new Promise((res) => { const sv = net.createServer(); sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); }); });
  const pd = path.join(tmp, 'personas-r12-dead'); fs.mkdirSync(pd);
  for (const [id, device] of [['dead-wk', 'iphone-14'], ['dead-cr', 'pixel-7']]) fs.writeFileSync(path.join(pd, `${id}.json`), JSON.stringify({ ...base, id, name: id, device, main_quit_reason: 'dead port', popups: 'leave', entry_point: { channel: 'direct', landing_path: '/products/x' }, product_pick: null, before_buying: [{ need: 'a name', look_for: ['beeswax'], if_missing: 'warn' }], choices: [] }));
  const t = Date.now();
  const rr = await runPanel(['--url', `http://127.0.0.1:${dead}`, '--i-own', '127.0.0.1', '--personas', pd, '--out', 'reports-r12-dead', '--pause', '0', '--no-cart']);
  const ms = Date.now() - t;
  const { res, md } = latestRun('reports-r12-dead');
  const msgs = res.journeys.map((j) => j.quit_reason);
  ok(rr.code === 1 && msgs.length === 2 && new Set(msgs).size === 1 && /^The store refused the connection at http:\/\/127\.0\.0\.1:\d+ \(nothing is listening there\)/.test(msgs[0]), 'a dead port gives one shared message on WebKit and Chromium', JSON.stringify(msgs));
  ok(ms < 60000, 'a refused port is reported right away on every phone (no 30 s wait per journey)', `${ms} ms`);
  ok(/refused the connection at http:\/\/127\.0\.0\.1:\d+ \(nothing/.test(md) && !/http:\\\//.test(md) && !/\\`/.test(md), 'report.md: no backslash escapes inside the error text', (md.match(/refused the connection[^\n]*/) || [''])[0]);
}
// Round 12, 8 and 13: the runner finds the config next to the persona folder like the validator, and the validator counts the config
{
  const proj = path.join(tmp, 'r12-project'); fs.mkdirSync(path.join(proj, 'personas'), { recursive: true });
  fs.copyFileSync(path.join(root, 'examples/personas/northwick-gift-giver-gwen.json'), path.join(proj, 'personas', 'northwick-gift-giver-gwen.json'));
  fs.writeFileSync(path.join(proj, 'shopper-panel.config.json'), JSON.stringify({ block_rules: [{ name: 'r12-bad', kind: 'host', hosts: ['https://cdn.example-apps.com/'] }] }));
  const rr = await runPanel(['--cart', '--url', O, '--i-own', '127.0.0.1', '--personas', path.join(proj, 'personas'), '--include-drafts', '--dry-run']);
  const note = (rr.out.match(/Note: [^\n]*/) || [''])[0];
  ok(rr.code === 2 && /Note: no shopper-panel\.config\.json in this folder; using [^\n]*r12-project\/shopper-panel\.config\.json, next to the persona folder\./.test(rr.out) && /r12-bad/.test(rr.err + rr.out), 'runner: run from elsewhere, it reads the config next to the persona folder, says so, and applies it', `${rr.code} ${(rr.out + rr.err).slice(0, 400)}`);
  const v = await new Promise((resolve) => { const c = spawn(process.execPath, [path.join(root, 'scripts/validate-personas.mjs'), path.join(proj, 'personas')], { cwd: tmp }); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('exit', (code) => resolve({ code, o })); });
  ok(v.o.includes(note) && note.length > 0, 'runner and validator print the same Note', `${note} | ${v.o.slice(0, 300)}`);
  ok(/1 problem\(s\) in 2 file\(s\) \(1 personas \+ config\)\./.test(v.o), 'validator: the count says "(N personas + config)" when the config is counted', v.o.split('\n').slice(-3).join(' '));
}
// Round 12, 10, 14, 15: the practice store prints the real path, and the docs
{
  const fx = spawn(process.execPath, [path.join(root, 'scripts/fixture-server.mjs')], { cwd: tmp });
  let fo = ''; fx.stdout.on('data', (d) => { fo += d; });
  for (let i = 0; i < 100 && !/Leave this running/.test(fo); i++) await sleep(100);
  fx.kill();
  ok(fo.includes(JSON.stringify(path.join(root, 'scripts', 'shopper-panel.mjs'))) && !/~\/\.claude/.test(fo), 'the practice store prints the real path of the running script', fo.slice(0, 400));
  const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  ok(rd('docs/block-rules.md').includes('in your project folder, next to personas/') && !/in that folder\)/.test(rd('docs/block-rules.md')), 'block-rules.md: the config is "in your project folder, next to personas/"');
  ok(/^- `--config <file>`/m.test(rd('README.md')), 'README lists --config');
  ok(/about 11 to 13 minutes/.test(rd('README.md')) && /If a check fails with Timeout on a busy machine, run it again/.test(rd('README.md')), 'README gives one honest test time and the busy-machine note');
}

// Round 13: server redirects are walked by the guard on both phones (a fulfilled 3xx would be
// followed by the browser without the guard). A 302 landing loads, a 2-hop chain into /checkouts/ is stopped before the store
// sees /checkouts, a POST answered by a 302 lands on the cart, and a GET /cart/add answered by a 302 reaches the store once.
{
  const http = await import('node:http');
  const seen = [];
  const pg13 = (t) => `<!doctype html><html><head><title>${t}</title></head><body><h1>${t}</h1><form method="post" action="/cart/add"><input type="hidden" name="id" value="1"><button id="b13">go</button></form></body></html>`;
  const rs = shopServer((q, r) => {
    seen.push(`${q.method} ${q.url}`);
    const red = (l) => { r.writeHead(302, { location: l }); r.end(); };
    if (q.url === '/r302') return red('/landing13');
    if (q.url === '/r2') return red('/c2');
    if (q.url === '/c2') return red('/checkouts/x');
    if (q.url.startsWith('/cart/add')) return red('/cart');
    r.writeHead(200, { 'content-type': 'text/html' }); r.end(pg13(q.url));
  });
  await new Promise((res) => rs.listen(0, '127.0.0.1', res));
  const RO = `http://127.0.0.1:${rs.address().port}`;
  for (const [eng, type] of [['chromium', chromium]]) {
    const b = await type.launch(); const ctx = await b.newContext(); const stops = []; let p; const st13 = {};
    try {
      await lib.installGuard(ctx, { state: st13, getPage: () => p, blockRules: [], allowHosts: [], ownHosts: new Set(['127.0.0.1']), landingPaths: new Set(['/landing13']), delayMs: 0, throttle: null, onCheckout: (x) => stops.push(x), onThirdParty: () => {} });
      p = await ctx.newPage();
      const t0 = Date.now(); let e1 = '';
      await p.goto(RO + '/r302', { timeout: 15000 }).catch((e) => { e1 = lib.oneLine(e.message, 160); });
      ok(!e1 && new URL(p.url()).pathname === '/landing13' && (await p.title()) === '/landing13' && Date.now() - t0 < 10000, `${eng}: a landing link that 302s loads with no timeout`, `${e1} ${p.url()} ${Date.now() - t0}ms`);
      seen.length = 0;
      await p.goto(RO + '/r2', { timeout: 15000 }).catch(() => {});
      ok(stops.some((x) => /\/checkouts\/x/.test(x.url)) && !seen.some((x) => x.includes('/checkouts')) && seen.includes('GET /c2'), `${eng}: a 2-hop redirect /r2 to /c2 to /checkouts/x is stopped and the store never sees /checkouts`, JSON.stringify(seen));
      await p.goto(RO + '/landing13'); seen.length = 0;
      await Promise.all([p.waitForURL('**/cart', { timeout: 10000 }).catch(() => {}), p.click('#b13')]);
      ok(new URL(p.url()).pathname === '/cart' && (await p.title()) === '/cart' && seen.filter((x) => x === 'POST /cart/add').length === 1, `${eng}: a form POST answered by a 302 lands on the cart`, `${p.url()} ${JSON.stringify(seen)}`);
      // a new journey: the form POST above touched the cart, and after that a GET /cart/add would be stopped by the after-cart rule
      seen.length = 0; st13.cartFrom = null; st13.cartPages = [];
      await p.goto(RO + '/cart/add?id=1', { timeout: 15000 }).catch(() => {});
      ok(new URL(p.url()).pathname === '/cart' && seen.filter((x) => x.startsWith('GET /cart/add')).length === 1, `${eng}: a GET /cart/add answered by a 302 reaches the store exactly once`, `${p.url()} ${JSON.stringify(seen)} ${JSON.stringify(stops.slice(-2))}`);
    } finally { await b.close().catch(() => {}); }
  }
  rs.closeAllConnections?.(); rs.close();
}

// Round 14, 1: payment and order queries are stopped on any address; "/?page_id=" stays allowed but content checked
{
  const cr14 = (u) => lib.checkoutReason({ url: u, isNavigation: true });
  ok(['/?wc-api=WC_Gateway_Paypal&order=1', '/?order-pay=12', '/shop/?pay_for_order=true', '/x?order_id=5', '/?page_id=8&key=wc_order_abc', '/fr/?WC-API=x'].every((p) => /payment or order query/.test(cr14('https://s.example' + p) || '')), 'wc-api, order-pay, pay_for_order, order_id and key=wc_order_ are stopped on any path');
  ok(cr14('https://s.example/?page_id=8') === null && cr14('https://s.example/?key=abc') === null && lib.allowedAfterCartAction('https://s.example/?page_id=8', new Set(['s.example']), new Set(), 'https://s.example/product/a'), '/?page_id= is not a checkout address and may follow a cart action (it is content checked)');
  ok(lib.checkoutReason({ url: 'https://s.example/product/a', redirectedFrom: ['https://s.example/?wc-api=x'] }) !== null, 'a payment query earlier in a redirect chain is stopped');
  const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  ok(['docs/safety-details.md'].every((f) => rd(f).includes('"/" with a query (for example `/?page_id=8`) is fetched once and checked for checkout content') && rd(f).includes('`pay_for_order`') && rd(f).includes('Once the cart is touched, the after-cart rule holds for the rest of that journey')), 'docs/safety-details.md says what happens to "/" with a query, payment queries and page loads after the cart is touched');
}
// Round 14, 1 and 2 end to end (both phones): after a cart POST, a 302 to a payment query is stopped unrequested, /?page_id= is
// fetched once and content checked, and a page load the runner did not start (meta refresh, location.href, location.replace, a form
// that submits itself, a script redirect after a background add to cart) never reaches /pay/xyz. The runner's own tap still navigates.
{
  const http = await import('node:http');
  const seen = [];
  const doc = (b) => `<!doctype html><html><head><title>t</title></head><body>${b}</body></html>`;
  const rs = shopServer(async (q, r) => {
    seen.push(`${q.method} ${q.url}`);
    const u = new URL(q.url, 'http://x'); const go = u.searchParams.get('go');
    const html = (b) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(doc(b)); };
    const red = (l) => { r.writeHead(302, { location: l }); r.end(); };
    if (u.pathname === '/product/a' && q.method === 'GET') return html(['wcapi', 'pageid', 'meta', 'href', 'replace', 'autosubmit', 'cartok'].map((g) => `<form method="post" action="/cart/add"><input type="hidden" name="id" value="${g}"><button id="${g}">${g}</button></form>`).join('') + '<button id="ajax" onclick="fetch(\'/cart/add.js\',{method:\'POST\',headers:{\'Content-Type\':\'application/x-www-form-urlencoded\'},body:\'id=1\'}).then(()=>{location.href=\'/pay/xyz\'})">ajax</button><a id="about" href="/pages/about">about</a>');
    // R25: the cart action is a real Shopify form add (POST /cart/add, the only kind of form write the guard sends); its id says
    // which answer this test wants
    if (u.pathname === '/cart/add' && q.method === 'POST') {
      const go = new URLSearchParams(await new Promise((ok2) => { let d = ''; q.on('data', (c) => { d += c; }); q.on('end', () => ok2(d)); })).get('id');
      if (go === 'wcapi') return red('/?wc-api=WC_Gateway_Paypal&order=1');
      if (go === 'pageid') return red('/?page_id=8');
      if (go === 'meta') return html('<meta http-equiv="refresh" content="0;url=/pay/xyz">added');
      if (go === 'href') return html('<script>location.href="/pay/xyz"</script>added');
      if (go === 'replace') return html('<script>location.replace("/pay/xyz")</script>added');
      if (go === 'autosubmit') return html('<form id="f" method="post" action="/pay/xyz"><input name="a" value="1"></form><script>document.getElementById("f").submit()</script>added');
      if (go === 'cartok') return html('<meta http-equiv="refresh" content="0;url=/cart">added');
    }
    if (u.pathname === '/cart/add.js') { q.resume(); r.writeHead(200, { 'content-type': 'application/json' }); return r.end('{}'); }
    if (u.pathname === '/' && u.searchParams.get('page_id') === '8') return html('<form name="checkout" class="checkout woocommerce-checkout"><input name="billing_first_name"></form>');
    if (u.pathname === '/cart') return html('<h1>Cart</h1><a id="about" href="/pages/about">about</a>');
    return html(`<h1>${u.pathname}</h1>`);
  });
  await new Promise((res) => rs.listen(0, '127.0.0.1', res));
  const RO = `http://127.0.0.1:${rs.address().port}`;
  for (const [eng, type] of [['chromium', chromium]]) {
    const b = await type.launch(); const ctx = await b.newContext(); const stops = []; const ivs = []; let p;
    const st = { deliberate: 0, cartFrom: null, cartPages: [] };
    try {
      await lib.installGuard(ctx, { state: st, getPage: () => p, blockRules: [], allowHosts: [], ownHosts: new Set(['127.0.0.1']), landingPaths: new Set(['/product/a']), delayMs: 0, throttle: null, onCheckout: (x) => stops.push(x), onIntervention: (x) => ivs.push(x), onThirdParty: () => {} });
      p = await ctx.newPage();
      // the runner's own tap: the page load it is expected to start is marked as deliberate, and the mark is dropped once the tap has settled
      const tap = async (sel) => { st.deliberate = lib.tapMark(await lib.tapDestination(p.locator(sel))); await p.click(sel, { timeout: 8000 }).catch(() => {}); for (let i = 0; i < 20 && st.deliberate; i++) await sleep(50); st.deliberate = 0; await sleep(1200); };
      const open = async () => { await p.goto(RO + '/product/a'); seen.length = 0; stops.length = 0; ivs.length = 0; };
      await open(); await tap('#wcapi');
      ok(stops.some((x) => /payment or order query \(wc-api\)/.test(x.why) && !x.reached_server) && !seen.some((x) => /wc-api/.test(x)), `${eng}: a cart POST answered by a 302 to /?wc-api=... is stopped and never requested`, JSON.stringify(seen));
      await open(); await tap('#pageid');
      ok(seen.filter((x) => x === 'GET /?page_id=8').length === 1 && stops.some((x) => /checkout page content/.test(x.why) && x.reached_server) && !/page_id/.test(p.url()), `${eng}: a cart POST answered by a 302 to /?page_id=8 is fetched once, recognised as a checkout by content and not shown`, JSON.stringify(seen));
      for (const g of ['meta', 'href', 'replace', 'autosubmit', 'ajax']) {
        await open(); await tap('#' + g); await sleep(600);
        ok(!seen.some((x) => /\/pay\/xyz/.test(x)) && !/\/pay\/xyz/.test(p.url()) && (stops.some((x) => /after the cart was touched/.test(x.why) && /\/pay\/xyz/.test(x.url) && x.reached_server === false) || (g === 'autosubmit' && ivs.some((x) => x.kind === 'dispatch' && /\/pay\/xyz/.test(x.url) && /not a Shopify cart operation/.test(x.what)))), `${eng}: after a cart action, a ${g === 'meta' ? 'meta refresh' : g === 'href' ? 'location.href' : g === 'replace' ? 'location.replace' : g === 'autosubmit' ? 'self-submitting form' : 'script redirect after a background add to cart'} to /pay/xyz is stopped and the store never receives /pay/xyz`, JSON.stringify(seen));
      }
      await open(); await tap('#cartok');
      ok(new URL(p.url()).pathname === '/cart' && !stops.length, `${eng}: after a cart action, a meta refresh to the cart still loads`, `${p.url()} ${JSON.stringify(stops.map((x) => x.why))}`);
      seen.length = 0; await tap('#about');
      ok(new URL(p.url()).pathname === '/cart' && !seen.includes('GET /pages/about') && stops.some((x) => /pages\/about/.test(x.url) && /after the cart was touched/.test(x.why)) && !!st.cartFrom, `${eng}: once the cart is touched, even the runner's own tap to a page of no known kind is stopped, and the rule stays on`, `${p.url()} ${JSON.stringify(seen)}`);
      await open(); await tap('#cartok'); stops.length = 0; seen.length = 0;
      const cf = st.cartFrom; await p.goto(RO + '/pages/about', { timeout: 8000 }).catch(() => {});
      ok(!!cf && !seen.includes('GET /pages/about') && stops.some((x) => /pages\/about/.test(x.url)) && !!st.cartFrom, `${eng}: once the cart is touched, the runner's own page.goto to a page of no known kind is stopped too, and the rule stays on`, `${cf} ${p.url()}`);
    } finally { await b.close().catch(() => {}); }
  }
  rs.closeAllConnections?.(); rs.close();
}
// Round 14, 2: the runner marks its own taps for the guard
{
  const src = fs.readFileSync(path.join(root, 'scripts/shopper-panel.mjs'), 'utf8');
  ok(/guard\.deliberate = lib\.tapMark\(await lib\.tapDestination\(loc\)\);[\s\S]{0,400}loc\.click\(/.test(src) && /deliberate: 0, cartFrom: null/.test(src), 'the runner marks each tap with the page load it is expected to start and the guard state starts with no cart action');
}
// Round 14, 3 and 4: short real answers, empty decorative siblings, and WooCommerce tabs other than Description
{
  const b = await chromium.launch(); const pg = await b.newPage();
  const scan = async (html) => { await pg.setContent(html); return pg.evaluate(lib.readTextSegments, { sel: lib.SEL, maxChars: lib.MAX_SCAN_CHARS, mode: 'product' }); };
  const find = (segs, pats) => { const tried = pats.map((x) => lib.safeRegex(x, 'i', { bounded: true }).re); let ho = null; for (const r of tried) { const h = lib.matchTerm(segs, r, { requireBody: true, patterns: tried }); if (h && h.headingOnly) { ho = ho || h; continue; } if (h) return 'FOUND ' + h.context; } return ho ? 'HEADING ONLY' : 'MISSING'; };
  const dawn = (inner) => `<body><product-info class="product__info-container"><h1 class="product__title">Tee</h1><div class="product__description rte">${inner}</div></product-info></body>`;
  const r1 = find(await scan(dawn('<h3>Delivery</h3><p>2 to 4 days</p>')), ['deliver(y|ed|s)?']);
  const r2 = find(await scan(dawn('<h3>Returns</h3><p>30 days</p>')), ['returns?']);
  const r3 = find(await scan(dawn('<h3>Materials</h3><p>100% organic cotton</p>')), ['materials?']);
  ok(/^FOUND Delivery: 2 to 4 days/.test(r1) && /^FOUND Returns: 30 days/.test(r2) && /^FOUND Materials: 100% organic cotton/.test(r3), 'a short answer straight after its heading counts (2 to 4 days, 30 days, 100% organic cotton)', [r1, r2, r3].join(' | '));
  const r4 = find(await scan(dawn('<h3>Shipping</h3><span class="icon-caret"></span><p>Ships free in 2 business days.</p>')), ['shipping']);
  const r5 = find(await scan(dawn('<h3>Shipping</h3><div>&nbsp;</div><p>Ships in 2 business days from our studio.</p>')), ['shipping']);
  ok(/^FOUND Shipping: Ships free/.test(r4) && /^FOUND Shipping: Ships in 2/.test(r5), 'an empty decorative sibling (an icon span, a spacer div) does not make the heading heading only', `${r4} | ${r5}`);
  const r6 = find(await scan(dawn('<h3>Returns</h3><div class="rte"></div><p>Hand poured in small batches in our own workshop.</p>')), ['returns?']);
  const r7 = find(await scan(dawn('<h3>Returns</h3><span class="icon"></span><div class="accordion__content"></div><p>Hand poured in small batches here.</p>')), ['returns?']);
  const r8 = find(await scan(dawn('<h3>Returns</h3><p>Hand poured</p><p>We take returns within 30 days of delivery.</p>')), ['returns?']);
  ok(r6 === 'HEADING ONLY' && r7 === 'HEADING ONLY', 'an empty content container (.rte, an accordion panel) still makes the heading heading only', `${r6} | ${r7}`);
  ok(/^FOUND Returns: Hand poured/.test(r8), 'the segment straight after a heading is its body', r8);
  const r9 = find(await scan(dawn('<h3>Returns</h3><p>Soon</p>')), ['returns?']);
  const r10 = find(await scan(dawn('<h3>Returns</h3><p>...</p><p>see the policy page for the details</p>')), ['returns?']);
  ok(/^FOUND/.test(r9) && /^FOUND Returns: see the policy page/.test(r10), 'a further segment still needs 15 letters; punctuation alone is not an answer', `${r9} | ${r10}`);
  const woo = `<body class="woocommerce single-product"><div class="product"><div class="summary entry-summary"><h1 class="product_title">Amber Soy Candle</h1><form class="cart" method="post"><button class="single_add_to_cart_button">Add to cart</button></form></div>
<div class="woocommerce-tabs wc-tabs-wrapper"><div class="woocommerce-Tabs-panel woocommerce-Tabs-panel--description panel entry-content wc-tab"><h2>Description</h2><p>Poured by hand in small batches.</p></div>
<div class="woocommerce-Tabs-panel woocommerce-Tabs-panel--additional_information panel entry-content wc-tab"><h2>Additional information</h2><table class="woocommerce-product-attributes shop_attributes"><tr><th class="woocommerce-product-attributes-item__label">Weight</th><td class="woocommerce-product-attributes-item__value">0.5 kg</td></tr><tr><th class="woocommerce-product-attributes-item__label">Dimensions</th><td class="woocommerce-product-attributes-item__value">8 x 8 x 10 cm</td></tr></table></div>
<div class="woocommerce-Tabs-panel woocommerce-Tabs-panel--shipping panel wc-tab"><h2>Shipping</h2><p>Ships within 2 business days, delivery 3 to 5 days.</p></div>
<div class="woocommerce-Tabs-panel woocommerce-Tabs-panel--reviews panel wc-tab" id="tab-reviews"><h2>Reviews</h2><p>Lovely candle, the warranty card was a nice touch.</p></div></div></div></body>`;
  const ws = await scan(woo);
  const w1 = find(ws, ['dimensions?']); const w2 = find(ws, ['weight']); const w3 = find(ws, ['business days']); const w4 = find(ws, ['warranty']);
  ok(/^FOUND Dimensions: 8 x 8 x 10 cm/.test(w1) && /^FOUND Weight: 0\.5 kg/.test(w2), 'the WooCommerce Additional information table is scanned', `${w1} | ${w2}`);
  ok(/^FOUND .*2 business days/.test(w3), 'a WooCommerce Shipping tab is scanned', w3);
  ok(w4 === 'MISSING', 'the WooCommerce Reviews tab is still not scanned as product information', w4);
  ok(/\.woocommerce-Tabs-panel:not\(\.woocommerce-Tabs-panel--reviews\)/.test(lib.SEL.productRoot) && /table\.shop_attributes/.test(lib.SEL.productRoot) && /\.woocommerce-product-attributes/.test(lib.SEL.productRoot), 'productRoot lists the WooCommerce tab panels (not reviews) and the attributes table');
  await b.close();
}

// Round 15, p6: the checkout content check reads only the real body tag, in any quoting, and ignores script, style and comments
{
  const c = lib.checkoutContentReason;
  ok(c('<html><body class=woocommerce-checkout><p>x</p></body></html>') === 'body.woocommerce-checkout', 'an unquoted checkout body class is recognised', String(c('<body class=woocommerce-checkout>')));
  ok(c("<html><body class='woocommerce-page woocommerce-checkout'><p>x</p></body></html>") === 'body.woocommerce-checkout', 'a single-quoted checkout body class is recognised');
  ok(c('<html><body data-x="a>b" class="woocommerce-checkout"></body></html>') === 'body.woocommerce-checkout', 'a ">" inside an earlier attribute value does not cut the body tag short');
  ok(c(`<html><head><script>var s = "<body class='home'>";</script></head><body class="woocommerce-checkout"><p>x</p></body></html>`) === 'body.woocommerce-checkout', 'a "<body" inside a script string is ignored and the real body tag is read');
  ok(c('<html><head><style>/* <body class="home"> */</style><!-- <body class="home"> --></head><body class=woocommerce-checkout></body></html>') === 'body.woocommerce-checkout', 'a "<body" inside a style block or an HTML comment is ignored');
  ok(c('<html><head><meta name="x" content="<body class=home>"><title><body class=home></title></head><body class=woocommerce-checkout></body></html>') === 'body.woocommerce-checkout', 'a "<body" inside an attribute value or the title is ignored');
  ok(c('<html><head><script>document.write("<body class=\\"woocommerce-checkout\\">")</script></head><body class="home"><p>Welcome</p></body></html>') === null, 'a checkout body class written only inside a script is not the page body', String(c('<script>"<body class=\\"woocommerce-checkout\\">"</script><body class="home">')));
  ok(c('<html><!-- <form class="checkout"> --><body class="home"><script>var t = \'<form class="checkout">\';</script></body></html>') === null, 'a checkout form inside a comment or a script string is not a checkout form');
  ok(c('<html><body class=woocommerce-order-pay><form id="order_review" method="post"><div id="payment" class="woocommerce-checkout-payment"></div></form></body></html>') === 'body.woocommerce-order-pay', 'the WooCommerce pay-for-order page with an unquoted body class is recognised');
  ok(c('<html><body class="page"><form id="order_review" method="post"></form></body></html>') === 'form#order_review', 'the pay-for-order form is recognised on its own');
  ok(c('<html><body class="page"><div id="payment" class="woocommerce-checkout-payment"></div></body></html>') === '.woocommerce-checkout-payment', 'the WooCommerce payment box is recognised on its own');
  ok(c("<html><body class=page><form class='checkout woocommerce-checkout' method=post></form></body></html>") === 'form.checkout', 'a single-quoted checkout form class is recognised');
  ok(c('<body class="home"><div data-block-name=woocommerce/checkout></div></body>') === 'WooCommerce checkout block', 'an unquoted checkout block attribute is recognised');
  ok(c('<body class="home"><p>Pay with the checkout button in your cart.</p></body>') === null, 'an ordinary page that mentions checkout is not a checkout');
  const b = await chromium.launch(); const pg = await b.newPage();
  await pg.setContent('<body class=woocommerce-order-pay><form id="order_review"></form></body>');
  const inPage = await pg.evaluate(lib.checkoutContentInPage);
  await pg.setContent('<body class="page"><div class="woocommerce-checkout-payment"></div></body>');
  const inPage2 = await pg.evaluate(lib.checkoutContentInPage);
  await b.close();
  ok(inPage === 'body.woocommerce-order-pay' && inPage2 === '.woocommerce-checkout-payment', 'the in-page check also recognises the pay-for-order page and the payment box', `${inPage} ${inPage2}`);
}
// Round 15, p2: a picker's own label ("Size") never answers a size-guide need; a guide link, button or real guide text does
{
  const b = await chromium.launch(); const pg = await b.newPage();
  const segsOf = async (html) => { await pg.setContent(html); return pg.evaluate(lib.readTextSegments, { sel: lib.SEL, maxChars: lib.MAX_SCAN_CHARS, mode: 'product' }); };
  const need = (segs, pats) => { const tried = pats.map((x) => new RegExp(x, 'i')); let hit = null; let ho = null; for (const r of tried) { hit = lib.matchTerm(segs, r, { requireBody: true, patterns: tried }); if (hit && hit.headingOnly) { ho = ho || hit; hit = null; continue; } if (hit) break; } return hit || ho; };
  const woo = await segsOf(`<body class="woocommerce"><div class="product"><div class="summary entry-summary"><h1 class="product_title">Tee</h1>
<form class="variations_form cart" method="post"><table class="variations"><tbody><tr><th class="label"><label for="pa_size">Size</label></th>
<td class="value"><select id="pa_size" name="attribute_pa_size"><option value="">Choose an option</option><option value="s">Small</option></select></td></tr>
<tr><th class="label"><label for="pa_colour">Colour:</label></th><td class="value"><select id="pa_colour"><option>Red</option></select></td></tr></tbody></table>
<button class="single_add_to_cart_button">Add to cart</button></form></div></div></body>`);
  const dawnSelect = await segsOf(`<body><product-info class="product__info-container"><h1 class="product__title">Tee</h1><form action="/cart/add" method="post">
<variant-selects><div class="product-form__input product-form__input--dropdown"><label class="form__label" for="Option-1">Size</label><div class="select"><select id="Option-1" name="options[Size]"><option>Small</option><option>Medium</option></select></div></div></variant-selects>
<button name="add">Add to cart</button></form></product-info></body>`);
  const dawnLegend = await segsOf(`<body><product-info class="product__info-container"><h1 class="product__title">Tee</h1><form action="/cart/add" method="post">
<variant-selects><fieldset class="js product-form__input product-form__input--pill"><legend class="form__label">Size</legend>
<input type="radio" id="s" name="Size" value="Small" checked><label for="s">Small</label><input type="radio" id="m" name="Size" value="Medium"><label for="m">Medium</label></fieldset></variant-selects>
<button name="add">Add to cart</button></form></product-info></body>`);
  const pick = (h) => (h && !h.headingOnly ? 'found' : h ? 'heading only' : 'missing');
  ok(pick(need(woo, ['size'])) === 'missing' && pick(need(woo, ['size (guide|chart)', 'size'])) === 'missing', 'a WooCommerce variations "th > label" Size never counts as a size guide', JSON.stringify(need(woo, ['size'])));
  ok(pick(need(woo, ['colou?r'])) === 'missing', 'a WooCommerce variations label "Colour:" never counts as found', JSON.stringify(need(woo, ['colou?r'])));
  ok(pick(need(dawnSelect, ['size'])) === 'missing', 'a Dawn dropdown label Size never counts as a size guide', JSON.stringify(need(dawnSelect, ['size'])));
  ok(pick(need(dawnLegend, ['size'])) !== 'found', 'a Dawn radio legend Size never counts as a size guide', JSON.stringify(need(dawnLegend, ['size'])));
  ok(lib.isPickerLabel({ path: 'form > label.form__label', text: 'Choose a size' }) && !lib.isPickerLabel({ path: 'form > label', text: 'Size guide' }) && !lib.isPickerLabel({ path: 'div > p', text: 'Size' }), 'a picker label is a form label holding only the option name');
  const withLink = await segsOf(`<body><product-info class="product__info-container"><h1 class="product__title">Tee</h1><form action="/cart/add" method="post">
<variant-selects><div class="product-form__input"><label class="form__label" for="o1">Size</label><select id="o1" name="options[Size]"><option>Small</option></select></div></variant-selects>
<a href="/pages/size-guide" class="size-guide-link">Size guide</a><button name="add">Add to cart</button></form></product-info></body>`);
  const lk = need(withLink, ['size']);
  ok(pick(lk) === 'found' && /Size guide/.test(lk.context), 'a "Size guide" link next to the picker counts as found', JSON.stringify(lk));
  const withButton = await segsOf(`<body class="woocommerce"><div class="product"><div class="summary entry-summary"><h1 class="product_title">Tee</h1>
<form class="variations_form cart" method="post"><table class="variations"><tbody><tr><th class="label"><label for="pa_size">Size</label></th><td class="value"><select id="pa_size"><option>S</option></select></td></tr></tbody></table>
<button type="button" class="size-chart-open">Size chart</button><button class="single_add_to_cart_button">Add to cart</button></form></div></div></body>`);
  const bt = need(withButton, ['size']);
  ok(pick(bt) === 'found' && /Size chart \(guide button\)/.test(bt.context), 'a "Size chart" button counts as found, marked "(guide button)"', JSON.stringify(bt));
  const withText = await segsOf(`<body><product-info class="product__info-container"><h1 class="product__title">Tee</h1><form action="/cart/add" method="post">
<variant-selects><div class="product-form__input"><label class="form__label" for="o1">Size</label><select id="o1" name="options[Size]"><option>Small</option></select></div></variant-selects>
<button name="add">Add to cart</button></form><div class="product__description rte"><p>Fits true to size. The model is 180 cm and wears a medium.</p></div></product-info></body>`);
  const tx = need(withText, ['size']);
  ok(pick(tx) === 'found' && /true to size/.test(tx.context), 'real fit or guide text counts as found even with a Size picker on the page', JSON.stringify(tx));
  const addBtn = await segsOf(`<body><product-info class="product__info-container"><h1 class="product__title">Tee</h1><form action="/cart/add" method="post"><button name="add">Add to cart</button></form></product-info></body>`);
  ok(need(addBtn, ['cart']) === null || need(addBtn, ['cart']).headingOnly, 'an ordinary button is not a guide button', JSON.stringify(need(addBtn, ['cart'])));
  await b.close();
}
// Round 16, 1: after a cart action, a pop-up, a self-clicking target=_blank link, an iframe and a self-submitting target=_blank POST
// form never reach the store; once the cart is touched, even a new tab or a new-tab form the shopper taps is checked by the after-cart
// rule (a page of no known kind is stopped); a page load that sends a form after a cart action is stopped.
{
  const http = await import('node:http');
  const seen = [];
  const doc = (b) => `<!doctype html><html><head><title>t</title></head><body>${b}</body></html>`;
  const rs = shopServer(async (q, r) => {
    seen.push(`${q.method} ${q.url}`);
    const raw = await new Promise((ok2) => { let d = ''; q.on('data', (c) => { d += c; }); q.on('end', () => ok2(d)); });
    const u = new URL(q.url, 'http://x');
    const html = (b) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(doc(b)); };
    if (u.pathname === '/product/a' && q.method === 'GET') return html(['popup', 'blank', 'iframe', 'formblank', 'postcart', 'tabs'].map((g) => `<form method="post" action="/cart/add"><input type="hidden" name="id" value="${g}"><button id="${g}">${g}</button></form>`).join(''));
    // R25: the cart action is a real Shopify form add (POST /cart/add); its id says which answer this test wants
    if (u.pathname === '/cart/add' && q.method === 'POST') {
      const go = new URLSearchParams(raw).get('id');
      if (go === 'popup') return html('added<script>window.open("/pay/xyz")</script>');
      if (go === 'blank') return html('added<a id="x" target="_blank" href="/pay/xyz">x</a><script>document.getElementById("x").click()</script>');
      if (go === 'iframe') return html('added<iframe src="/pay/xyz"></iframe>');
      if (go === 'formblank') return html('<form id="f" target="_blank" method="post" action="/pay/xyz"><input name="a" value="1"></form><script>document.getElementById("f").submit()</script>added');
      if (go === 'postcart') return html('<form id="f" method="post" action="/cart"><input name="a" value="1"></form><script>document.getElementById("f").submit()</script>added');
      if (go === 'tabs') return html('added<a id="t" target="_blank" href="/pages/about">about</a><form target="_blank" method="post" action="/pages/contact"><button id="pb">send</button></form>');
    }
    return html(`<h1>${u.pathname}</h1>`);
  });
  await new Promise((res) => rs.listen(0, '127.0.0.1', res));
  const RO = `http://127.0.0.1:${rs.address().port}`;
  for (const [eng, type] of [['chromium', chromium]]) {
    const b = await type.launch(); const ctx = await b.newContext(); const stops = []; const ivs = []; let p;
    const st = { deliberate: 0, cartFrom: null, cartPages: [] };
    try {
      await lib.installGuard(ctx, { state: st, getPage: () => p, blockRules: [], allowHosts: [], ownHosts: new Set(['127.0.0.1']), landingPaths: new Set(['/product/a']), delayMs: 0, throttle: null, onCheckout: (x) => stops.push(x), onIntervention: (x) => ivs.push(x), onThirdParty: () => {} });
      // R25: a form POST that is not a Shopify cart operation is stopped by the write allow-list (kind dispatch) before the after-cart
      // rule sees it; either stop counts, and the store must still never receive it
      const formStopped = (re) => stops.some((x) => x.method === 'POST' && re.test(x.url) && /sending a form/.test(x.why)) || ivs.some((x) => x.kind === 'dispatch' && x.method === 'POST' && re.test(x.url) && /not a Shopify cart operation/.test(x.what));
      p = await ctx.newPage();
      const tap = async (sel) => { st.deliberate = lib.tapMark(await lib.tapDestination(p.locator(sel))); await p.click(sel, { timeout: 8000 }).catch(() => {}); if (st.cartFrom) for (let i = 0; i < 20 && st.deliberate; i++) await sleep(50); st.deliberate = 0; await sleep(1500); };
      const open = async () => { for (const x of ctx.pages()) if (x !== p) await x.close().catch(() => {}); await p.goto(RO + '/product/a'); seen.length = 0; stops.length = 0; ivs.length = 0; };
      for (const [g, label, where] of [['popup', 'a window.open pop-up', 'pop-up or new tab'], ['blank', 'a target=_blank link that clicks itself', 'pop-up or new tab'], ['iframe', 'an iframe', 'frame'], ['formblank', 'a self-submitting target=_blank POST form', '']]) {
        await open(); await tap('#' + g);
        ok(!seen.some((x) => /\/pay\/xyz/.test(x)) && (stops.some((x) => /\/pay\/xyz/.test(x.url) && /after the cart was touched/.test(x.why) && (!where || x.why.includes(`(a ${where})`)) && x.reached_server === false) || (g === 'formblank' && formStopped(/\/pay\/xyz/))), `${eng}: after a cart action, ${label} never reaches the store`, `${JSON.stringify(seen)} ${JSON.stringify(stops.map((x) => x.why))}`);
      }
      ok(formStopped(/\/pay\/xyz/), `${eng}: the stopped target=_blank form is reported as a form sent (or a write the allow-list refuses)`, JSON.stringify([stops.map((x) => [x.method, x.why]), ivs.map((x) => [x.method, x.what])]));
      await open(); await tap('#postcart');
      ok(!seen.some((x) => x === 'POST /cart') && formStopped(/\/cart$/), `${eng}: after a cart action, a form that submits itself is stopped even to the cart`, `${JSON.stringify(seen)} ${JSON.stringify(stops.map((x) => x.why))}`);
      await open(); await tap('#tabs');
      const cf = st.cartFrom;
      const tabP = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null); await tap('#t'); const tab = await tabP; if (tab) await tab.waitForLoadState('domcontentloaded').catch(() => {});
      ok(!!cf && !seen.includes('GET /pages/about') && stops.some((x) => /pages\/about/.test(x.url) && /\(a pop-up or new tab\)/.test(x.why)), `${eng}: once the cart is touched, a new tab the shopper taps to a page of no known kind is stopped`, `${cf} ${JSON.stringify(seen)} ${JSON.stringify(stops.map((x) => x.why))}`);
      await open(); await tap('#tabs'); await tap('#pb');
      ok(!seen.includes('POST /pages/contact') && formStopped(/pages\/contact/), `${eng}: once the cart is touched, a form the shopper sends into a new tab is stopped`, `${JSON.stringify(seen)} ${JSON.stringify(stops.map((x) => x.why))}`);
    } finally { await b.close().catch(() => {}); }
  }
  rs.closeAllConnections?.(); rs.close();
}
// Round 16, 2: empty icons and dividers between a heading and its text are stepped over; an empty content block is heading only
{
  const b = await chromium.launch(); const pg = await b.newPage();
  const scan = async (html) => { await pg.setContent(html); return pg.evaluate(lib.readTextSegments, { sel: lib.SEL, maxChars: lib.MAX_SCAN_CHARS, mode: 'product' }); };
  const find = (segs, pats) => { const tried = pats.map((x) => new RegExp(x, 'i')); let ho = null; for (const r of tried) { const h = lib.matchTerm(segs, r, { requireBody: true, patterns: tried }); if (h && h.headingOnly) { ho = ho || h; continue; } if (h) return 'FOUND ' + h.context; } return ho ? 'HEADING ONLY ' + ho.context : 'MISSING'; };
  const dawn = (inner) => `<body><product-info class="product__info-container"><h1 class="product__title">Tee</h1>${inner}<form action="/cart/add"><button name="add">Add to cart</button></form></product-info></body>`;
  const C = [
    ['an empty svg.accordion-icon', dawn('<div class="product__description rte"><h3>Shipping</h3><svg class="accordion-icon" width="10" height="10"><path d="M0 0"/></svg><p>Ships free in 2 business days.</p></div>'), ['shipping'], /^FOUND Shipping: Ships free/],
    ['an empty i.accordion-toggle-icon', dawn('<div class="faq"><h4 class="accordion-title">Shipping</h4><i class="accordion-toggle-icon"></i><div class="accordion-body"><p>Ships free in 2 business days.</p></div></div>'), ['shipping'], /^FOUND Shipping: Ships free/],
    ['an empty span.collapsible-trigger__icon', dawn('<div class="product-block"><h4>Returns</h4><span class="collapsible-trigger__icon"></span><div><p>We accept returns within 30 days.</p></div></div>'), ['returns?'], /^FOUND Returns: We accept/],
    ['an empty hr.content-divider', dawn('<div class="product__description rte"><h3>Materials</h3><hr class="content-divider"><p>100% organic cotton</p></div>'), ['materials?'], /^FOUND Materials: 100% organic cotton/],
    ['an empty img and button.accordion-toggle', dawn('<div class="rte"><h3>Care</h3><img class="content-img" alt=""><button class="accordion-toggle" aria-label="open"></button><p>Machine wash cold.</p></div>'), ['care'], /^FOUND Care: Machine wash/],
  ];
  for (const [name, html, pats, want] of C) { const got = find(await scan(html), pats); ok(want.test(got), `a heading followed by ${name} and then text: found`, got); }
  const empty = find(await scan(dawn('<div class="product__description rte"><h3>Shipping</h3><div class="accordion-content"></div><p>Hand made in small batches in our own studio.</p></div>')), ['shipping']);
  ok(/^HEADING ONLY Shipping/.test(empty), 'a heading followed by an empty div.accordion-content is still heading only', empty);
  const emptySvgThenEmptyBlock = find(await scan(dawn('<div class="rte"><h3>Shipping</h3><svg class="icon-content"></svg><section class="tab-panel"></section><p>Hand made in small batches in our own studio.</p></div>')), ['shipping']);
  ok(/^HEADING ONLY Shipping/.test(emptySvgThenEmptyBlock), 'an icon is stepped over and an empty section.tab-panel after it still makes the heading heading only', emptySvgThenEmptyBlock);
  await b.close();
}
// Round 16, 3 and LOWs: Shopify.Checkout comparisons, abrupt comments, the no-active-personas message, Ctrl-C after the run
{
  const c = lib.checkoutContentReason;
  ok(c(`<body class="template-product"><script>if (Shopify.Checkout && Shopify.Checkout.step === 'thank_you') { gtag('event', 'purchase'); }</script></body>`) === null, 'Shopify.Checkout.step === ... in a storefront snippet is not a checkout');
  ok(c(`<body><script>if (Shopify.Checkout.page == "thank_you") {}</script></body>`) === null, 'Shopify.Checkout.page == ... is not a checkout');
  ok(c(`<script>Shopify.Checkout.token = "abc";</script>`) === 'Shopify.Checkout' && c(`<script>Shopify.Checkout.step="contact_information"</script>`) === 'Shopify.Checkout', 'a real Shopify.Checkout assignment is still a checkout');
  ok(c('<!doctype html><html><!--><body class="woocommerce-checkout"><form class="checkout"></form></body></html>') === 'body.woocommerce-checkout', 'an abrupt "<!-->" comment ends at once and does not hide the rest of the page');
  ok(c('<html><!---><body class=woocommerce-checkout></body></html>') === 'body.woocommerce-checkout', 'an abrupt "<!--->" comment ends at once');
  ok(c('<html><!-- x --!><body class="woocommerce-checkout"></body></html>') === 'body.woocommerce-checkout', 'a comment ended by "--!>" does not hide the rest of the page');
  ok(c('<?xml version="1.0"?><!doctype html><html><body class="woocommerce-checkout"></body></html>') === 'body.woocommerce-checkout', 'a "<?...>" or "<!doctype>" before the page does not hide it');
  ok(c('<html><head><noscript><body class="home"></noscript></head><body class="woocommerce-checkout"></body></html>') === 'body.woocommerce-checkout', 'a "<body" inside noscript is ignored');
  ok(c('<html><!-- <body class="woocommerce-checkout"> --><body class="home"></body></html>') === null, 'a checkout body inside an ordinary comment is still ignored');
  const pd = path.join(tmp, 'personas-drafts16'); fs.mkdirSync(pd);
  fs.copyFileSync(path.join(root, 'examples/personas/northwick-gift-giver-gwen.json'), path.join(pd, 'northwick-gift-giver-gwen.json'));
  const nd = await runPanel(['--cart', '--url', O, '--i-own', '127.0.0.1', '--personas', pd]);
  ok(nd.code === 2 && nd.err.includes('No active personas found. The examples are drafts; add --include-drafts to try them, or set status: active.'), 'only draft personas: exit 2 with a clear message', `${nd.code} ${nd.err.slice(0, 300)}`);
  const child = spawn(process.execPath, [path.join(root, 'scripts/shopper-panel.mjs'), '--url', O, '--i-own', '127.0.0.1', '--personas', pd, '--include-drafts', '--no-cart', '--out', 'reports-linger', '--pause', '0'], { cwd: tmp, env: { ...process.env, SP_TEST_JOURNEY_CAP_SECONDS: '90', SP_TEST_LINGER_MS: '20000' } });
  let out = ''; let err = ''; let sentAt = 0;
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', (d) => { out += d; if (!sentAt && /\nJSON: /.test(out)) { sentAt = Date.now(); setTimeout(() => interrupt(child), 300); } });
  const code = await new Promise((resolve) => { const killer = setTimeout(() => child.kill('SIGKILL'), 4 * 60 * 1000); child.on('exit', (cd) => { clearTimeout(killer); resolve(cd); }); });
  const { res } = latestRun('reports-linger');
  ok(sentAt > 0 && Date.now() - sentAt < 15000 && code === res.exit_code && !/Stopping/.test(err), 'a Ctrl-C after the run has finished exits with the run\'s own exit code and does not print "Stopping..."', `${sentAt} ${code} ${res.exit_code} ${err.slice(-300)}`);
}
// Round 17: a tap marker carries the page load it is expected to start (a link's href, a form's action, nothing for a plain button), so
// a script redirect after an AJAX add, or a delayed redirect that lands during the next tap, is checked; real taps and the stores'
// "redirect to cart after add" still work.
{
  ok(lib.tapMark('http://h/cart/add') && lib.tapMark('http://h/cart/add').url === 'http://h/cart/add' && lib.tapMark('') === 0 && lib.tapMark('javascript:void(0)') === 0, 'a tap marker carries an http(s) form action, and none for anything else');
  ok(lib.isExpectedLoad({ url: 'http://h/pages/about#x' }, 'http://h/pages/about?y=1') && !lib.isExpectedLoad({ url: 'http://h/pages/about' }, 'http://h/pay/xyz') && !lib.isExpectedLoad({ url: 'http://h/a' }, 'http://g/a') && !lib.isExpectedLoad(0, 'http://h/a') && !lib.isExpectedLoad(1, 'http://h/a'), 'a page load matches a tap marker only on the same origin and path');
  ok(['docs/safety-details.md'].every((f) => { const t = fs.readFileSync(path.join(root, f), 'utf8'); return t.includes('Once the cart is touched, the after-cart rule holds for the rest of that journey and nothing lifts it') && t.includes('the runner\'s own taps and page loads included, and every server redirect on the way') && !t.includes('until the shopper\'s next tap'); }), 'the docs say the after-cart rule is sticky for the whole journey, the runner\'s own taps and page loads included');
  const http = await import('node:http');
  const seen = [];
  const doc = (b) => `<!doctype html><html><head><title>t</title></head><body>${b}</body></html>`;
  const rs = shopServer(async (q, r) => {
    seen.push(`${q.method} ${q.url}`);
    const raw = await new Promise((ok2) => { let d = ''; q.on('data', (c) => { d += c; }); q.on('end', () => ok2(d)); });
    const u = new URL(q.url, 'http://x'); const go = u.searchParams.get('go');
    const html = (b) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(doc(b)); };
    if (u.pathname === '/product/a' && q.method === 'GET') return html('<form method="post" action="/cart/add"><input type="hidden" name="id" value="delay"><button id="delay">delay</button></form>'
      + `<button id="ajaxpush" onclick="history.pushState({},'','/pay/xyz');fetch('/cart/add.js',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id=1&quantity=1'}).then(()=>{location.href='/pay/xyz'})">ajaxpush</button>`
      + `<button id="ajaxdelay" onclick="fetch('/cart/add.js',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id=1&quantity=1'}).then(()=>setTimeout(()=>{location.href='/pay/xyz'},1500))">ajaxdelay</button>`
      + `<button id="ajaxcart" onclick="fetch('/cart/add.js',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id=1&quantity=1'}).then(()=>{location.href='/cart'})">ajaxcart</button>`
      + `<a id="linkhijack" href="/pages/about" onclick="event.preventDefault();fetch('/cart/add.js',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id=1&quantity=1'}).then(()=>{location.href='/pay/xyz'})">about</a>`
      + '<form method="post" action="/cart/add"><input type="hidden" name="id" value="1"><button id="cartpost">add</button></form>'
      + '<form method="post" action="/f"><button id="fa" formaction="/g">g</button></form><form action="/f"><button id="fget">g</button></form><a id="tocart" href="/cart">cart</a><a id="toprod" href="/products/b">b</a><a id="newtab" target="_blank" href="/products/c">c</a>');
    // R25: both cart actions are real Shopify form adds (POST /cart/add with an id); id=delay answers with a page whose script redirects later
    if (u.pathname === '/cart/add' && q.method === 'POST' && new URLSearchParams(raw).get('id') === 'delay') return html('added<button id="drawer" onclick="1">drawer</button><a id="dlink" href="/products/b">b</a><script>setTimeout(()=>{location.href="/pay/xyz"},1500)</script>');
    if (u.pathname === '/cart/add' && q.method === 'POST') { r.writeHead(302, { location: '/cart' }); return r.end(); }
    if (u.pathname === '/cart/add.js') { r.writeHead(200, { 'content-type': 'application/json' }); return r.end('{}'); }
    return html(`<h1>${u.pathname}</h1><button id="drawer" onclick="1">drawer</button>`);
  });
  await new Promise((res) => rs.listen(0, '127.0.0.1', res));
  const RO = `http://127.0.0.1:${rs.address().port}`;
  for (const [eng, type] of [['chromium', chromium]]) {
    const b = await type.launch(); const ctx = await b.newContext(); const stops = []; let p;
    const st = { deliberate: 0, cartFrom: null, cartPages: [] };
    try {
      await lib.installGuard(ctx, { state: st, getPage: () => p, blockRules: [], allowHosts: [], ownHosts: new Set(['127.0.0.1']), landingPaths: new Set(['/product/a']), delayMs: 0, throttle: null, onCheckout: (x) => stops.push(x), onThirdParty: () => {} });
      p = await ctx.newPage();
      // the runner's own tap (as in shopper-panel.mjs): the marker is the tapped element's destination, dropped once the tap has settled
      const tap = async (sel) => { st.deliberate = lib.tapMark(await lib.tapDestination(p.locator(sel))); await p.click(sel, { timeout: 8000 }).catch(() => {}); if (st.cartFrom) for (let i = 0; i < 20 && st.deliberate; i++) await sleep(50); st.deliberate = 0; };
      const open = async () => { for (const x of ctx.pages()) if (x !== p) await x.close().catch(() => {}); await p.goto(RO + '/product/a'); seen.length = 0; stops.length = 0; };
      const pay = () => seen.some((x) => /\/pay\/xyz/.test(x));
      const stoppedPay = () => stops.some((x) => /\/pay\/xyz/.test(x.url) && /after the cart was touched/.test(x.why) && x.reached_server === false);
      const why = () => `${JSON.stringify(seen)} ${JSON.stringify(stops.map((x) => x.why))} ${p.url()}`;
      await open();
      ok(await lib.tapDestination(p.locator('#tocart')) === '' && await lib.tapDestination(p.locator('#cartpost')) === RO + '/cart/add' && await lib.tapDestination(p.locator('#fa')) === RO + '/g' && await lib.tapDestination(p.locator('#fget')) === '' && await lib.tapDestination(p.locator('#ajaxpush')) === '', `${eng}: a tap marker is a POST form's action (or the button's formaction), and none for a link, a GET form or a plain button`);
      await tap('#ajaxpush'); await sleep(2000);
      ok(!pay() && stoppedPay(), `${eng}: an AJAX Add to cart button whose script pushes and then loads a payment page never reaches the store (ajaxpush)`, why());
      await open(); await tap('#delay'); await sleep(1300); await tap('#drawer'); await sleep(1500);
      ok(!pay() && stoppedPay(), `${eng}: a delayed redirect after a cart POST that lands during the next tap is checked (delay+tap)`, why());
      await open(); await tap('#ajaxdelay'); await sleep(1300); await tap('#drawer'); await sleep(1500);
      ok(!pay() && stoppedPay(), `${eng}: a delayed redirect after an AJAX add that lands during the next tap is checked (ajaxdelay+tap)`, why());
      await open(); await tap('#linkhijack'); await sleep(1500);
      ok(!pay() && stoppedPay(), `${eng}: a tapped link whose script adds to the cart and loads another address than its href is checked`, why());
      await open(); await tap('#cartpost'); await sleep(500);
      ok(new URL(p.url()).pathname === '/cart' && !stops.length && seen.includes('GET /cart'), `${eng}: a cart POST answered by a 302 to /cart (redirect to cart after add) still loads the cart`, why());
      await open(); await tap('#ajaxcart'); await sleep(1500);
      ok(new URL(p.url()).pathname === '/cart' && !stops.length, `${eng}: an AJAX add followed by a script load of /cart (redirect to cart after add) still loads the cart`, why());
      await open(); await tap('#ajaxdelay'); await sleep(200); await tap('#tocart'); await sleep(500);
      ok(new URL(p.url()).pathname === '/cart' && !stops.some((x) => /\/cart$/.test(x.url)) && !!st.cartFrom, `${eng}: after an AJAX add, a tapped link to the cart loads and the rule stays on`, why());
      await open(); await tap('#ajaxdelay'); await sleep(200); await tap('#toprod'); await sleep(500);
      ok(!seen.includes('GET /products/b') && stops.some((x) => /products\/b/.test(x.url)), `${eng}: after an AJAX add, a tapped link to a page of no known kind (another product) is stopped`, why());
      await open(); await tap('#ajaxdelay'); await sleep(200);
      await tap('#newtab'); await sleep(1500);
      ok(!seen.includes('GET /products/c') && stops.some((x) => /products\/c/.test(x.url) && /\(a pop-up or new tab\)/.test(x.why)), `${eng}: after an AJAX add, a tapped target=_blank link to a page of no known kind is stopped`, why());
      await sleep(1600);
      ok(!pay(), `${eng}: the server never receives /pay/xyz`, why());
    } finally { await b.close().catch(() => {}); }
  }
  rs.closeAllConnections?.(); rs.close();
}
// Round 18: the after-cart rule is sticky. Once the cart is touched (the runner's own Add to cart tap, a recognised cart write, or a
// cart action page load), every page load in every tab and frame, the runner's own taps and gotos included, and every redirect hop,
// must pass the after-cart rule for the rest of the journey. GraphQL cart mutations and admin-ajax adds are cart writes. Cleanup
// leaves the store page before the cart is emptied and never lifts a rule. WebSockets, also from web workers, are routed. No cart by
// default; --cart opts in.
{
  ok(lib.isCartWriteCall('https://s.example/api/2024-01/graphql.json', '{"query":"mutation{cartLinesAdd(cartId:1){cart{id}}}"}') && lib.isCartWriteCall('https://s.example/api/unstable/graphql', 'mutation { cartCreate { cart { id } } }') && !lib.isCartWriteCall('https://s.example/api/2024-01/graphql.json', '{"query":"{ shop { name } }"}'), 'a Storefront GraphQL cartCreate or cartLines mutation is a cart write, a plain GraphQL read is not');
  ok(lib.isCartWriteCall('https://s.example/wp-admin/admin-ajax.php?action=custom_add_to_cart', '') && lib.isCartWriteCall('https://s.example/wp-admin/admin-ajax.php', 'action=woodmart_ajax_add_to_cart&id=1') && !lib.isCartWriteCall('https://s.example/wp-admin/admin-ajax.php?action=get_reviews', 'x=1'), 'a WordPress admin-ajax add to cart is a cart write, another admin-ajax call is not');
  const st0 = { cartPages: [] }; lib.markCartTouched(st0, 'https://s.example/products/a'); lib.markCartTouched(st0, 'https://s.example/products/a');
  const own = new Set(['s.example']);
  ok(st0.cartFrom === 'https://s.example/products/a' && st0.cartPages.length === 1 && lib.allowedAfterCartTouched('https://s.example/products/a?variant=2', own, new Set(), st0) && lib.allowedAfterCartTouched('https://s.example/cart', own, new Set(), st0) && !lib.allowedAfterCartTouched('https://s.example/pay/xyz', own, new Set(), st0) && !lib.allowedAfterCartTouched('https://s.example/products/b', own, new Set(), st0), 'once the cart is touched, only the landing page, a page the cart was touched from, home, the cart or a locale home may load');
  const pl = fs.readFileSync(path.join(root, 'scripts/panel-lib.mjs'), 'utf8');
  ok(!/state\.cleanup|g\.state\.cleanup/.test(pl) && !/pg\.goto = /.test(pl), 'the guard has no cleanup exemption and no page.goto exemption');
  const src = fs.readFileSync(path.join(root, 'scripts/shopper-panel.mjs'), 'utf8');
  ok(/lib\.markCartTouched\(guard, guard\.lastDoc \|\| page\.url\(\)\);\s*const ra = await tap\(add, 'add to cart'\);/.test(src), 'the runner marks the cart as touched itself just before it taps Add to cart');
  ok(!/clearCartFromNode|cart_emptied|emptyCart|clearCart|cleanup_requests/.test(src + pl) && !/test cart is emptied/.test(src), 'no cart cleanup code is left in the runner or the library (the test cart is left as it is)');
  ok(/const CART_MODE = !flag\('no-cart'\);/.test(src) && (src.match(/CART_MODE =/g) || []).length === 1 && /const BOOL_OPTS = new Set\(\[[^\]]*'cart', *'no-cart'/.test(src), 'cart mode is the default (one assignment); --no-cart is browse only and --cart is a known no-op option');
  const docs = ['README.md', 'SKILL.md', 'SECURITY.md', 'AGENTS.md', 'docs/safety-details.md'].map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
  ok(docs.every((t) => t.includes(lib.PROMISE) && !/planned for a later version|Browser-only mode|Claude in Chrome|test cart is emptied|chromium webkit/i.test(t)) && !/'--cart'/.test(fs.readFileSync(path.join(root, 'scripts/demo.mjs'), 'utf8')), 'README, SKILL.md, SECURITY.md, AGENTS.md and docs/safety-details.md carry the exact promise, and none says cart mode is planned, the cart is emptied, or installs WebKit');
  const dd = fs.readFileSync(path.join(root, 'docs/safety-details.md'), 'utf8');
  ok(dd.includes('possibly several times') && dd.includes('The page itself tried to add to or change the cart') && dd.includes('`WebSocketStream`') && dd.includes('The Checkout button is found, never tapped') && dd.includes('The test cart is left as it is'), 'docs/safety-details.md keeps the full detail: script GETs, cart-write stops, sockets, Checkout found not tapped, the cart left as it is');
  const hc = await runPanel(['--help']);
  ok(/--no-cart\s+Browse only/.test(hc.out) && /--cart\s+Accepted so older commands keep working/.test(hc.out) && hc.out.includes(lib.PROMISE) && /Your own promise that you own this store/.test(hc.out) && /not that you\s+own it/.test(hc.out), 'the help text carries the promise, says --no-cart is browse only and --cart changes nothing, and says --i-own is a promise, not a check', hc.out.slice(0, 600));
  const both = await runPanel(['--url', O, '--i-own', '127.0.0.1', '--cart', '--no-cart', '--dry-run']);
  ok(both.code === 2 && /either --cart or --no-cart/.test(both.err), '--cart with --no-cart is refused (exit 2)', `${both.code} ${both.err.slice(0, 200)}`);
}
// Round 18 (the review probes), both phones: an AJAX add through an unknown admin-ajax action, a GraphQL cartLinesAdd or an app proxy
// never reaches the store (R25: the write allow-list), so the script load of /pay/xyz after it never runs; a load of "/?go=1" or "/cart?go=1" that the server redirects to /pay/xyz is stopped at the hop;
// after the runner's own View cart tap, a cart page script that redirects is still stopped; an app proxy add the panel cannot
// recognise is covered by the runner marking the cart itself before its tap.
{
  const http = await import('node:http');
  const seen = [];
  const doc = (b) => `<!doctype html><html><head><title>t</title></head><body><h1>x</h1>${b}</body></html>`;
  const rs = shopServer((q, r) => {
    const u = new URL(q.url, 'http://x'); seen.push(`${q.method} ${u.pathname}${u.search}`); q.resume();
    const html = (b) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(doc(b)); };
    const red = (l) => { r.writeHead(302, { location: l }); r.end(); };
    if (u.pathname === '/product/a') return html(`
      <button id="ajaxUnknown" onclick="fetch('/wp-admin/admin-ajax.php?action=custom_add_to_cart',{method:'POST',body:'product_id=1'}).then(()=>{location.href='/pay/xyz'})">a</button>
      <button id="ajaxGql" onclick="fetch('/api/2024-01/graphql.json',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'mutation{cartLinesAdd}'})}).then(()=>{location.href='/pay/xyz'})">g</button>
      <button id="ajaxHomeRedirect" onclick="fetch('/cart/add.js',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id=1&quantity=1'}).then(()=>{location.href='/?go=1'})">h</button>
      <button id="ajaxCartRedirect" onclick="fetch('/cart/add.js',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id=1&quantity=1'}).then(()=>{location.href='/cart?go=1'})">c</button>
      <button id="proxyAdd" onclick="fetch('/apps/proxy/add',{method:'POST',body:'id=1'}).then(()=>{location.href='/pay/xyz'})">p</button>
      <button id="ajaxThenLater" onclick="fetch('/cart/add.js',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id=1&quantity=1'}).then(()=>{})">l</button>
      <a id="viewcart" href="/cart?delayed=1">View cart</a>`);
    if (['/cart/add.js', '/wp-admin/admin-ajax.php', '/api/2024-01/graphql.json', '/apps/proxy/add'].includes(u.pathname)) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end('{}'); }
    if (u.pathname === '/' && u.searchParams.get('go')) return red('/pay/xyz');
    if (u.pathname === '/cart' && u.searchParams.get('go')) return red('/pay/xyz');
    if (u.pathname === '/cart' && u.searchParams.get('delayed')) return html('<script>setTimeout(()=>{location.href="/pay/xyz"},300)</script>cart');
    return html(`<p>${u.pathname}</p>`);
  });
  await new Promise((res) => rs.listen(0, '127.0.0.1', res));
  const RO = `http://127.0.0.1:${rs.address().port}`;
  for (const [eng, type] of [['chromium', chromium]]) {
    const b = await type.launch(); const ctx = await b.newContext(); const stops = []; const ivs = []; let p;
    const st = { deliberate: 0, cartFrom: null, cartPages: [], lastDoc: '' };
    try {
      await lib.installGuard(ctx, { state: st, getPage: () => p, blockRules: [], allowHosts: [], ownHosts: new Set(['127.0.0.1']), landingPaths: new Set(['/product/a']), delayMs: 0, throttle: null, onCheckout: (x) => stops.push(x), onIntervention: (x) => ivs.push(x), onThirdParty: () => {} });
      p = await ctx.newPage();
      const tap = async (sel) => { st.deliberate = lib.tapMark(await lib.tapDestination(p.locator(sel))); await p.click(sel, { timeout: 8000 }).catch(() => {}); if (st.cartFrom) for (let i = 0; i < 20 && st.deliberate; i++) await sleep(50); st.deliberate = 0; await sleep(1500); };
      // each case is a fresh journey: a fresh guard state
      const fresh = async () => { st.cartFrom = null; st.cartPages = []; await p.goto(RO + '/product/a'); seen.length = 0; stops.length = 0; ivs.length = 0; };
      const pay = () => seen.some((x) => /\/pay\//.test(x));
      const why = () => `${JSON.stringify(seen)} ${JSON.stringify(stops.map((x) => x.why))} ${p.url()}`;
      await fresh(); await tap('#ajaxUnknown');
      ok(!pay() && !seen.some((x) => /admin-ajax/.test(x)), `${eng}: an admin-ajax call with an action name the panel does not know as a cart operation never reaches the store (shared endpoints carry only recognised cart operations), so nothing that follows it runs`, why());
      // R25: GraphQL and an app proxy are not Shopify cart operations the panel sends, so the write itself is stopped (kind dispatch)
      // and the script that would follow it never runs
      await fresh(); await tap('#ajaxGql');
      ok(!pay() && !seen.some((x) => /graphql/.test(x)) && ivs.some((x) => x.kind === 'dispatch' && /graphql/.test(x.url)), `${eng}: a Storefront GraphQL cartLinesAdd never reaches the store (the write allow-list), so the /pay/xyz load that follows it never runs`, `${why()} ${JSON.stringify(ivs)}`);
      for (const [id, label] of [['ajaxHomeRedirect', 'an AJAX add, then a load of "/?go=1" that the server redirects to /pay/xyz'], ['ajaxCartRedirect', 'an AJAX add, then a load of "/cart?go=1" that the server redirects to /pay/xyz']]) {
        await fresh(); await tap('#' + id);
        ok(!pay() && !!st.cartFrom && stops.some((x) => /\/pay\/xyz/.test(x.url) && x.reached_server === false), `${eng}: after ${label}, /pay/xyz is stopped and never requested`, why());
      }
      await fresh(); lib.markCartTouched(st, st.lastDoc || p.url()); await tap('#proxyAdd');
      ok(!pay() && !seen.some((x) => /apps\/proxy/.test(x)) && ivs.some((x) => x.kind === 'dispatch' && /apps\/proxy/.test(x.url)), `${eng}: an app proxy add the panel cannot recognise never reaches the store (the write allow-list), so /pay/xyz is never requested`, `${why()} ${JSON.stringify(ivs)}`);
      await fresh(); await tap('#ajaxThenLater'); const cf = st.cartFrom; await tap('#viewcart'); await sleep(800);
      ok(!!cf && !pay() && new URL(p.url()).pathname === '/cart' && stops.some((x) => /\/pay\/xyz/.test(x.url)) && !!st.cartFrom, `${eng}: after the runner's own View cart tap, a cart page script that redirects to /pay/xyz is still stopped`, why());
      await p.goto(RO + '/cart?go=1', { timeout: 8000 }).catch(() => {});
      ok(!pay() && stops.some((x) => /\/pay\/xyz/.test(x.url) && /redirect/.test(x.why)), `${eng}: the runner's own goto to an allowed page is checked at every server redirect hop`, why());
      await sleep(500);
      ok(!pay(), `${eng}: the server never receives /pay/*`, why());
    } finally { await b.close().catch(() => {}); }
  }
  rs.closeAllConnections?.(); rs.close();
}
// Round 18 and 24: every WebSocket is refused. A page socket or a web worker socket (classic, module, blob) never connects, on any host:
// one to a host that is neither own nor allow-listed is counted as blocked, one to the store's own or an allow-listed host is a guard intervention.
{
  const http = await import('node:http');
  const seen = []; let PORT = 0;
  const rs = shopServer((q, r) => {
    seen.push(`${q.headers.host.split(':')[0]} ${q.method} ${q.url}`); q.resume();
    if (q.url.startsWith('/w.js')) { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end(`const tag = new URLSearchParams(location.search).get('t') || 'classic'; try { new WebSocket('ws://localhost:${PORT}/ws-worker-' + tag); postMessage(tag + ' made'); } catch (e) { postMessage(tag + ' ' + e.name); } try { new WebSocket('ws://127.0.0.1:${PORT}/ws-worker-own-' + tag); } catch (e) { postMessage(tag + ' own ' + e.name); }`); }
    r.writeHead(200, { 'content-type': 'text/html' }); r.end(`<!doctype html><h1>ws</h1><script>
      window.msgs = [];
      try { const s = new WebSocket('ws://localhost:${PORT}/ws-page'); s.onerror = () => {}; } catch (e) { msgs.push('page ' + e.name); }
      try { const s = new WebSocket('ws://127.0.0.1:${PORT}/ws-page-own'); s.onerror = () => {}; } catch (e) { msgs.push('page own ' + e.name); }
      const on = (w) => { w.onmessage = (e) => msgs.push(String(e.data)); w.onerror = (e) => msgs.push('werr ' + (e.message || '')); };
      try { on(new Worker('/w.js?t=classic')); } catch (e) { msgs.push('classic throw ' + e); }
      try { on(new Worker('/w.js?t=module', { type: 'module' })); } catch (e) { msgs.push('module throw ' + e); }
      try { const bu = URL.createObjectURL(new Blob(["try { new WebSocket('ws://localhost:${PORT}/ws-worker-blob'); postMessage('blob made'); } catch (e) { postMessage('blob ' + e.name); }"])); on(new Worker(bu)); URL.revokeObjectURL(bu); } catch (e) { msgs.push('blob throw ' + e); }
    </script>`);
  });
  rs.on('upgrade', (q, sock) => { seen.push(`${q.headers.host.split(':')[0]} UPGRADE ${q.url}`); sock.destroy(); });
  await new Promise((res) => rs.listen(0, '127.0.0.1', res)); PORT = rs.address().port;
  for (const [eng, type] of [['chromium', chromium]]) {
    for (const allow of [[], ['localhost']]) {
      // the runner's own Chromium flags: a loopback test store needs Local Network Access checks off, as in a real run against it
      const b = await type.launch(type === chromium ? { args: lib.chromiumArgs({ loopback: true }) } : {}); const ctx = await b.newContext({ serviceWorkers: 'block' }); let p; const blocked = []; const inter = [];
      try {
        await lib.installGuard(ctx, { state: { deliberate: 0, cartFrom: null, cartPages: [] }, getPage: () => p, blockRules: [], allowHosts: allow, ownHosts: new Set(['127.0.0.1']), landingPaths: new Set(['/ws']), delayMs: 0, throttle: null, onCheckout: () => {}, onThirdParty: (x) => { if (x.blocked) blocked.push(x); }, onIntervention: (x) => inter.push(x) });
        p = await ctx.newPage(); seen.length = 0;
        // the page is /ws: shopServer answers "/" itself with the Shopify home page (R25)
        await p.goto(`http://127.0.0.1:${PORT}/ws`); await sleep(2500);
        const msgs = (await p.evaluate(() => window.msgs).catch(() => [])) || [];
        const up = seen.filter((x) => / UPGRADE /.test(x));
        const tag = allow.length ? 'allow-listed' : 'not allow-listed';
        ok(up.length === 0, `${eng}: no WebSocket ever connects, to any host (localhost ${tag}, and the store's own host)`, JSON.stringify(up));
        ok(['classic', 'module', 'blob'].every((t) => msgs.includes(`${t} SecurityError`)) && msgs.includes('classic own SecurityError') && msgs.includes('module own SecurityError'), `${eng}: a WebSocket from a classic, module or blob web worker is refused on every host (localhost ${tag})`, JSON.stringify(msgs));
        ok(inter.some((x) => x.kind === 'websocket' && /ws-page-own/.test(x.url)) && inter.some((x) => x.kind === 'websocket' && /ws-worker-own-classic/.test(x.url)) && !seen.some((x) => /__sp_worker|__shopper_panel/.test(x)), `${eng}: a socket to the store's own host, from the page or a worker, is refused and reported as a guard intervention`, JSON.stringify(inter.map((x) => x.url)));
        if (!allow.length) ok(blocked.filter((x) => x.host === 'localhost').length >= 4 && blocked.some((x) => /ws-page$/.test(x.url)), `${eng}: each refused socket to a host that is not allow-listed is counted as blocked`, JSON.stringify(blocked));
        else ok(!blocked.some((x) => x.host === 'localhost') && inter.some((x) => /localhost.*ws-page$/.test(x.url)), `${eng}: with the host allow-listed, its sockets are still refused (reported as an intervention, not a blocked host)`, JSON.stringify(inter.map((x) => x.url)));
      } finally { await b.close().catch(() => {}); }
    }
  }
  rs.closeAllConnections?.(); rs.close();
}
// Round 18, 24 and 25, runner end to end (cart mode is the default): an Add to cart whose store call is not a Shopify cart operation (an
// app proxy) is stopped by the write allow-list, so it never reaches the store, the /pay/xyz load after it never runs, and the journey
// ends as a test limit; an AJAX add through /cart/add.js that then loads /pay/xyz never reaches /pay/xyz; a Checkout link whose click
// would schedule a POST to /pay/now is found and never tapped, so the POST never even runs; the test cart is left as it is. --no-cart
// stops before Add to cart.
{
  const http = await import('node:http');
  const seen = []; let count = 0;
  const pageOf = (add) => '<!doctype html><html><head><title>Proxy candle</title><meta name="viewport" content="width=device-width"></head><body><main><div class="product"><h1>Proxy candle</h1><img src="/img.svg" style="width:100%;height:200px"><span class="price" itemprop="price" content="20">$20.00</span><form action="/cart/add" method="post" onsubmit="event.preventDefault();fetch(' + add + ').then(()=>{location.href=\'/pay/xyz\'})"><input type="hidden" name="id" value="1"><button type="submit" name="add">Add to cart</button></form><p>Ships in 2 days</p><a href="/cart">Cart</a></div></main></body></html>';
  const cart = '<!doctype html><html><head><title>Cart</title></head><body><h1>Your cart</h1><a id="co" href="/checkout">Checkout</a><script>document.getElementById("co").addEventListener("click",()=>{setTimeout(()=>{const f=document.createElement("form");f.method="post";f.action="/pay/now";document.body.append(f);f.submit();},1500)});</script></body></html>';
  const ps = shopServer((q, r) => {
    seen.push(`${q.method} ${q.url}`); q.resume();
    if (q.url.startsWith('/img.svg')) { r.writeHead(200, { 'content-type': 'image/svg+xml' }); return r.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="red"/></svg>'); }
    if (q.url.startsWith('/cart.js')) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end(JSON.stringify({ item_count: count, items: [] })); }
    if (q.url.startsWith('/cart/clear.js')) { count = 0; r.writeHead(200, { 'content-type': 'application/json' }); return r.end('{"item_count":0}'); }
    if (q.url.startsWith('/apps/proxy/add') || q.url.startsWith('/cart/add.js')) { q.resume(); count++; r.writeHead(200, { 'content-type': 'application/json' }); return r.end('{}'); }
    if (q.url.startsWith('/cart')) { r.writeHead(200, { 'content-type': 'text/html' }); return r.end(cart); }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(pageOf(q.url.startsWith('/products/proxy') ? "\'/apps/proxy/add\',{method:\'POST\',body:\'id=1\'}" : "\'/cart/add.js\',{method:\'POST\',headers:{\'content-type\':\'application/x-www-form-urlencoded\'},body:\'id=1\'}"));
  });
  await new Promise((res) => ps.listen(0, '127.0.0.1', res));
  const pd = path.join(tmp, 'personas-r18'); fs.mkdirSync(pd);
  for (const [id, device, land] of [['proxy-cr', 'pixel-7', '/products/proxy'], ['ajax-wk', 'iphone-14', '/products/ajax'], ['ajax-cr', 'pixel-7', '/products/ajax']]) fs.writeFileSync(path.join(pd, `${id}.json`), JSON.stringify({ ...base, id, name: id, device, main_quit_reason: `proxy ${id}`, popups: 'leave', photos_to_view: 1, entry_point: { channel: 'direct', landing_path: land }, product_pick: null, before_buying: [{ need: 'ship', look_for: ['ships in \\d'], if_missing: 'warn' }], choices: [] }));
  const rr = await runPanel(['--url', `http://127.0.0.1:${ps.address().port}`, '--i-own', '127.0.0.1', '--personas', pd, '--out', 'reports-r18', '--pause', '0']);
  const { res } = latestRun('reports-r18');
  const tail = `${rr.code} ${JSON.stringify(seen.filter((x) => !/cart\.js|img/.test(x)))} ${JSON.stringify(res.journeys.map((j) => [j.quit_reason, j.checkout_button]))}`;
  const JP = Object.fromEntries(res.journeys.map((j) => [j.persona, j]));
  ok(res.journeys.length === 3 && !seen.some((x) => /apps\/proxy/.test(x)) && seen.filter((x) => x.startsWith('POST /cart/add.js')).length === 2 && !seen.some((x) => /\/pay\//.test(x)), 'runner: an app proxy add never reaches the store (the write allow-list), an AJAX /cart/add.js add that then loads /pay/xyz never reaches /pay/xyz, and nothing reaches /pay/now', tail);
  ok(JP['proxy-cr'] && !JP['proxy-cr'].completed && JP['proxy-cr'].quit_kind === 'test_limit' && (JP['proxy-cr'].guard_kinds || []).includes('dispatch') && !JP['proxy-cr'].reached_checkout, 'runner: a journey whose Add to cart needed a write the allow-list refused ends as a test limit, not a store finding', `${JP['proxy-cr']?.quit_kind} ${JSON.stringify(JP['proxy-cr']?.guard_kinds)} ${JP['proxy-cr']?.quit_reason}`);
  ok(['ajax-wk', 'ajax-cr'].map((k) => JP[k]).every((j) => j && j.reached_checkout && j.checkout_button?.visible && j.checkout_button?.enabled && !j.checkout_request && j.cart_touched && !('cart_emptied' in j)) && !seen.some((x) => /clear\.js|GET \/checkout/.test(x)), 'runner: both AJAX-add shoppers find the Checkout button without tapping it, and the test cart is left as it is (no clear call)', tail);
  seen.length = 0;
  const rd = await runPanel(['--url', `http://127.0.0.1:${ps.address().port}`, '--i-own', '127.0.0.1', '--personas', pd, '--out', 'reports-r18d', '--pause', '0', '--no-cart']);
  const dres = latestRun('reports-r18d').res;
  ok(rd.code === 0 && dres.mode === 'no-cart' && dres.journeys.every((j) => j.completed && !j.cart_touched && j.steps.some((s) => s.step === 'ready to add to cart')) && !seen.some((x) => /^POST /.test(x) || /\/apps\/proxy|\/cart/.test(x)), 'a --no-cart run stops before Add to cart and sends nothing to the cart', `${rd.code} ${dres.mode} ${JSON.stringify(seen)}`);
  ps.closeAllConnections?.(); ps.close();
}
// ---------- R19 ----------
// Round 19, guard (both phones): recognised checkout and pay addresses are stopped for every request type a page can make (fetch, xhr,
// image, beacon, keepalive, a web worker's fetch), and shared workers are switched off (their requests skip the request guard).
// No-cart mode: every recognised cart write and cart-action load is stopped whatever made it, and counted; with --cart, a cart write the
// page makes on its own (an image) still marks the cart touched. A worker an allow-listed frame starts, and a worker started from a fresh
// about:blank frame's own Worker, both get the socket guard.
{
  const http = await import('node:http');
  const seen = []; let PORT = 0;
  const rs = shopServer((q, r) => {
    seen.push(`${q.headers.host} ${q.method} ${q.url}`); q.resume();
    if (q.url.startsWith('/w.js')) { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end(`fetch('/checkouts/cn/worker').catch(()=>{}); const x = new XMLHttpRequest(); x.open('GET', '/checkout/worker-xhr'); x.send(); postMessage('ran');`); }
    if (q.url.startsWith('/w2.js')) { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end(`const tag = new URLSearchParams(location.search).get('t'); try { new WebSocket('ws://[::1]:${PORT}/ws-' + tag); postMessage(tag + ' made'); } catch (e) { postMessage(tag + ' ' + e.name); }`); }
    if (q.url.startsWith('/frame')) { r.writeHead(200, { 'content-type': 'text/html' }); return r.end(`<p>widget</p><script>const w = new Worker('/w2.js?t=thirdparty'); w.onmessage = (e) => parent.postMessage(String(e.data), '*');</script>`); }
    r.writeHead(200, { 'content-type': 'text/html' });
    if (q.url.startsWith('/checks')) return r.end(`<h1>c</h1><script>window.msgs = []; window.sw = typeof SharedWorker;
      fetch('/checkouts/cn/fetch').catch(()=>{}); const x = new XMLHttpRequest(); x.open('GET', '/checkout/xhr'); x.send();
      new Image().src = '/checkout/img'; navigator.sendBeacon('/checkouts/beacon', 'a=1'); fetch('/checkouts/keepalive', { keepalive: true }).catch(()=>{});
      fetch('/?pay_for_order=true&key=wc_order_x').catch(()=>{}); const w = new Worker('/w.js'); w.onmessage = (e) => msgs.push(String(e.data));</script>`);
    if (q.url.startsWith('/carts')) return r.end(`<h1>k</h1><script>
      fetch('/cart/add.js', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'id=101&quantity=1' }).catch(()=>{});
      new Image().src = '/cart/add?id=102&quantity=1'; navigator.sendBeacon('/cart/add.js', 'id=103&quantity=1');
      const x = new XMLHttpRequest(); x.open('POST', '/?wc-ajax=add_to_cart'); x.send('product_id=1');
      fetch('/wp-json/wc/store/v1/cart/add-item', { method: 'POST', body: '{"id":1,"quantity":1}' }).catch(()=>{});
      setTimeout(() => { const f = document.createElement('form'); f.method = 'post'; f.action = '/cart/add'; f.innerHTML = '<input name=id value=104>'; document.body.append(f); f.submit(); }, 300);</script>`);
    if (q.url.startsWith('/workers')) return r.end(`<h1>w</h1><script>window.msgs = []; addEventListener('message', (e) => msgs.push('3p ' + e.data));
      const f = document.createElement('iframe'); f.src = 'http://localhost:${PORT}/frame'; document.body.append(f);
      const b = document.createElement('iframe'); document.body.append(b);
      try { const w = new b.contentWindow.Worker('/w2.js?t=blankframe'); w.onmessage = (e) => msgs.push('blank ' + e.data); } catch (e) { msgs.push('blank throw ' + e.name); }</script>`);
    return r.end('<h1>ok</h1>');
  });
  rs.on('upgrade', (q, sock) => { seen.push(`${q.headers.host} UPGRADE ${q.url}`); sock.destroy(); });
  await new Promise((res) => rs.listen(0, '127.0.0.1', res)); PORT = rs.address().port;
  for (const [eng, type] of [['chromium', chromium]]) {
    const b = await type.launch(type === chromium ? { args: lib.chromiumArgs({ loopback: true }) } : {});
    try {
      const mkCtx = async (opts) => {
        const ctx = await b.newContext({ serviceWorkers: 'block' }); const box = { beacons: [], stops: [], writes: [], blocked: [], state: { deliberate: 0, cartFrom: null, cartPages: [], lastDoc: '' } };
        await lib.installGuard(ctx, { state: box.state, getPage: () => box.p, blockRules: [], allowHosts: opts.allow || [], ownHosts: new Set(['127.0.0.1']), landingPaths: new Set(['/']), delayMs: 0, throttle: null, noCart: !!opts.noCart, onBeacon: (d) => box.beacons.push(d), onCartWrite: (d) => box.writes.push(d), onCheckout: (x) => box.stops.push(x.url), onThirdParty: (x) => { if (x.blocked) box.blocked.push(x); } });
        box.p = await ctx.newPage(); box.ctx = ctx; return box;
      };
      let t = await mkCtx({}); seen.length = 0;
      await t.p.goto(`http://127.0.0.1:${PORT}/checks`); await sleep(2000);
      const cmsgs = await t.p.evaluate(() => ({ msgs: window.msgs, sw: window.sw })).catch(() => ({}));
      const cseen = seen.filter((x) => /checkout|pay_for_order/.test(x));
      ok(!cseen.length && t.stops.length >= 6 && t.beacons.length >= 2 && cmsgs.sw === 'undefined' && (cmsgs.msgs || []).includes('ran'), `${eng}: a checkout or pay address is stopped for fetch, xhr, image and a web worker's fetch (a beacon or keepalive by the page-script guard), and shared workers are switched off`, `${JSON.stringify(cseen)} stops ${t.stops.length} ${JSON.stringify(cmsgs)}`);
      await t.ctx.close();
      t = await mkCtx({ noCart: true }); seen.length = 0;
      await t.p.goto(`http://127.0.0.1:${PORT}/carts`); await sleep(2000);
      const kseen = seen.filter((x) => /cart\/add|add_to_cart|add-item/.test(x)); const kinds = new Set(t.writes.map((w) => w.kind));
      ok(!kseen.length && t.writes.length + t.beacons.length >= 6 && ['fetch', 'image', 'xhr', 'page load'].every((k) => kinds.has(k)) && !t.state.cartFrom, `${eng}: no-cart mode stops every cart write a page makes on its own (fetch, xhr, image, beacon, form) before it leaves the browser, counts each one, and leaves the cart untouched`, `${JSON.stringify(kseen)} ${JSON.stringify(t.writes.map((w) => `${w.kind} ${w.url}`))} ${t.state.cartFrom}`);
      await t.ctx.close();
      t = await mkCtx({}); seen.length = 0;
      await t.p.goto(`http://127.0.0.1:${PORT}/carts`); await sleep(1500);
      ok(seen.some((x) => /GET \/cart\/add\?id=102/.test(x)) && !!t.state.cartFrom && !t.writes.length, `${eng}: in cart mode (the default), a cart write the page makes on its own (an image to /cart/add) marks the cart touched`, `${JSON.stringify(seen)} ${t.state.cartFrom}`);
      await t.ctx.close();
      t = await mkCtx({ allow: ['localhost'] }); seen.length = 0;
      await t.p.goto(`http://127.0.0.1:${PORT}/workers`); await sleep(3000);
      const wm = await t.p.evaluate(() => window.msgs).catch(() => []); const up = seen.filter((x) => / UPGRADE /.test(x));
      ok(!wm.some((m) => /thirdparty made/.test(m)) && t.blocked.some((x) => /^http:\/\/localhost:\d+\/frame/.test(x.url)) && wm.includes('blank blankframe SecurityError') && !up.length && t.blocked.some((x) => /ws-blankframe/.test(x.url)) && !seen.some((x) => /__sp_worker|__shopper_panel/.test(x)), `${eng}: a frame page from an allow-listed host is not loaded (--allow-host covers static files only), and a worker from a fresh about:blank frame's own Worker cannot open a socket; each is counted, and the wrapper never reaches the server`, `${JSON.stringify(wm)} ${JSON.stringify(up)} ${JSON.stringify(t.blocked.map((x) => x.url))} ${JSON.stringify(seen.filter((x) => /w2|frame/.test(x)))}`);
      await t.ctx.close();
    } finally { await b.close().catch(() => {}); }
  }
  rs.closeAllConnections?.(); rs.close();
}
// Round 19, runner end to end (both phones): a product page whose own script adds a gift item to the cart on load (fetch and image).
// --no-cart: nothing reaches the server and the report says the page tried. Cart mode with a shopper who quits before Add to cart: the
// page's write is reported, and the test cart is left as it is.
{
  const gift = `<script>fetch('/cart/add.js',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id=101&quantity=1'}).catch(()=>{}); new Image().src='/cart/add?id=102&quantity=1';</script>`;
  const s19 = await startFixtureServer({ extraHtml: { '/products/linen-and-cedar-candle': gift } });
  const g = JSON.parse(fs.readFileSync(path.join(root, 'examples/personas/northwick-gift-giver-gwen.json'), 'utf8'));
  const pd = path.join(tmp, 'personas-r19'); fs.mkdirSync(pd);
  for (const [id, device] of [['gift-wk', 'iphone-14'], ['gift-cr', 'pixel-7']]) {
    const p = { ...g, id, name: id, device, status: 'active', entry_point: { ...g.entry_point, landing_path: '/products/linen-and-cedar-candle' }, product_pick: null };
    p.before_buying = p.before_buying.map((x) => (/gift packaging/.test(x.need) ? { ...x, if_missing: 'quit' } : x));
    const errs = checkPersona(p); ok(!errs.length, `round 19 persona ${id} is valid`, errs.join('; '));
    fs.writeFileSync(path.join(pd, `${id}.json`), JSON.stringify(p));
  }
  const cartReqs = () => s19.requests.filter((r) => /^\/cart\/(add|clear)/.test(new URL(r.url, 'http://x').pathname)).map((r) => `${r.method} ${r.url}`);
  const rn = await runPanel(['--url', `${s19.origin}/products/linen-and-cedar-candle`, '--i-own', '127.0.0.1', '--personas', pd, '--out', 'reports-r19n', '--pause', '0', '--no-cart']);
  const n = latestRun('reports-r19n');
  ok(rn.code === 0 && n.res.journeys.length === 2 && !cartReqs().length && n.res.journeys.every((j) => j.cart_writes_stopped >= 2 && !j.cart_touched) && /The page itself tried to add to or change the cart/.test(n.md) && n.res.cart_writes_stopped >= 4, 'runner (--no-cart, both phones): a page that adds to the cart on its own never reaches the server, and the report says the page tried and was stopped', `${rn.code} ${JSON.stringify(cartReqs())} ${JSON.stringify(n.res.journeys.map((j) => [j.engine, j.cart_writes_stopped, j.cart_touched]))}`);
  s19.requests.length = 0;
  const rc = await runPanel(['--url', `${s19.origin}/products/linen-and-cedar-candle`, '--i-own', '127.0.0.1', '--personas', pd, '--out', 'reports-r19c', '--pause', '0']);
  const c = latestRun('reports-r19c');
  ok(rc.code === 0 && c.res.journeys.length === 2 && c.res.journeys.every((j) => j.cart_touched && j.cart_touched_by_page && !('cart_emptied' in j) && !j.steps.some((st) => st.step === 'add to cart')) && !cartReqs().some((x) => /\/cart\/clear/.test(x)) && /The page itself wrote to the cart before the shopper tapped Add to cart[^\n]*the test cart is left as it is/.test(c.md), 'runner (cart mode, both phones): a shopper who quits before Add to cart gets the page\'s own cart write reported, and the cart is left as it is', `${rc.code} ${JSON.stringify(cartReqs())} ${JSON.stringify(c.res.journeys.map((j) => [j.engine, j.quit_step, j.cart_touched_by_page, j.cart_emptied]))}`);
  await s19.close();
}
// ---------- R20 ----------
const { default: http } = await import('node:http');
// Round 20, recognisers: the Store API batch route is a cart write when its body holds /cart/ requests; only writes that add items
// count as an add; a learned cart address must be the store's own, a GET page with no query and not a checkout.
{
  const b = (x) => JSON.stringify({ requests: [{ path: x, method: 'POST', body: {} }] });
  ok(lib.isCartWriteCall('https://s.example/wp-json/wc/store/v1/batch', b('/wc/store/v1/cart/add-item')) && lib.isCartWriteCall('https://s.example/wp-json/wc/store/batch', b('/wc/store/cart/update-item'))
    && lib.isCartWriteCall('https://s.example/?rest_route=/wc/store/v1/batch', b('/wc/store/v1/cart/add-item')) && !lib.isCartWriteCall('https://s.example/wp-json/wc/store/v1/batch', b('/wc/store/v1/products'))
    && lib.isCartItemAdd('https://s.example/wp-json/wc/store/v1/batch', b('/wc/store/v1/cart/add-item')) && !lib.isCartItemAdd('https://s.example/wp-json/wc/store/v1/batch', b('/wc/store/v1/cart/update-customer')),
  'the Store API batch route (path and rest_route) is a cart write when its body holds cart requests, and an add only with add-item');
  const add = (u, body = '') => lib.isCartItemAdd(u, body);
  ok(add('https://s.example/cart/add.js') && add('https://s.example/cart/add') && add('https://s.example/en-gb/cart/add.js') && add('https://s.example/?wc-ajax=add_to_cart')
    && add('https://s.example/wp-json/wc/store/v1/cart/add-item') && add('https://s.example/?rest_route=/wc/store/v1/cart/add-item')
    && add('https://s.example/api/2024-01/graphql.json', '{"query":"mutation { cartLinesAdd(cartId: \\"x\\", lines: [{merchandiseId: \\"1\\"}]) { cart { id } } }"}')
    && add('https://s.example/api/2024-01/graphql.json', '{"query":"mutation { cartCreate(input: { lines: [{ merchandiseId: \\"1\\" }] }) { cart { id } } }"}')
    && !add('https://s.example/api/2024-01/graphql.json', '{"query":"mutation { cartCreate(input: { attributes: [{ key: \\"a\\", value: \\"b\\" }] }) { cart { id } } }"}')
    && !add('https://s.example/cart/update.js', '{"attributes":{"_session":"abc"}}') && !add('https://s.example/cart/update.js', 'note=hello') && !add('https://s.example/cart/change.js', '{"id":"1:a","quantity":0}')
    && !add('https://s.example/wp-json/wc/store/v1/cart/apply-coupon') && !add('https://s.example/products/x'),
  'an add is /cart/add, cartLinesAdd, a cartCreate with lines, the WooCommerce add_to_cart routes and add-item; attribute, note, quantity and coupon writes are not');
  const own = new Set(['s.example']); const st = { cartUrls: [] };
  const learn = (u) => lib.learnCartUrl(st, u, 'https://s.example/product/candle/', own);
  ok(learn('/shopping-cart/') === '/shopping-cart/' && learn('https://s.example/my-cart/') === '/my-cart/' && learn('/cart-2/') === '/cart-2/'
    && learn('https://other.example/cart-x/') === null && learn('/checkout/') === null && learn('/shopping-cart/?add-to-cart=5') === null
    && learn('/shopping-cart/?x=1') === null && learn('/cart/add') === null && learn('javascript:void(0)') === null && learn('/') === null && learn('/checkouts/cn/abc') === null && learn('/collections/bags') === null && learn('/product/candle/') === null && learn('/shop/') === null,
  'a learned cart address is kept only when it is the store\'s own page, not a checkout, with no query or cart action', JSON.stringify(st.cartUrls));
  const st2 = { cartFrom: 'https://s.example/product/candle/', cartPages: ['https://s.example/product/candle/'], cartUrls: ['/shopping-cart/'] };
  ok(lib.allowedAfterCartTouched('https://s.example/shopping-cart/', own, new Set(), st2) && lib.allowedAfterCartTouched('https://s.example/shopping-cart', own, new Set(), st2)
    && !lib.allowedAfterCartTouched('https://other.example/shopping-cart/', own, new Set(), st2) && !lib.allowedAfterCartTouched('https://s.example/shopping-cart-2/', own, new Set(), st2)
    && !lib.allowedAfterCartTouched('https://s.example/my-cart/', own, new Set(), { ...st2, cartUrls: [] }),
  'after the cart action a learned cart address may load (same host and path only)');
}
ok(['docs/safety-details.md'].every((f) => { const t = fs.readFileSync(path.join(root, f), 'utf8'); return t.includes('only marks the cart as touched; it does not turn the rule on') && t.includes('`wc_add_to_cart_params.cart_url`')
  && t.includes('the panel\'s safety rule stopped this page load: <address>') && t.includes('inside a Store API `batch`'); })
  && fs.readFileSync(path.join(root, 'docs/safety-details.md'), 'utf8').includes('requests still waiting in the guard are cancelled') && fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8').includes('cut off from the network first'),
'docs/safety-details.md says when the after-cart rule turns on, how the cart address is learned, the tool-limit result and the stop order');
{
  const src = fs.readFileSync(path.join(root, 'scripts/shopper-panel.mjs'), 'utf8');
  ok(/stopResolve\('stop'\);[\s\S]{0,300}setTimeout\([\s\S]{0,200}process\.exit\(130\); \}, STOP_HARD_CAP_MS\)\.unref\(\)/.test(src) && /withTimeout\(lib\.haltGuard\(holder\.guard, \{ waitSentMs: 0 \}\), 20000\)/.test(src) && !/clearCartAfterStop/.test(src),
  'the stop path is capped (the guard halt 20 s), has no cart clean-up step, and a backstop exits if it still does not finish');
}
// Round 20, runner end to end (both phones). Helpers: personas on both phones from one example, a cart count read with a cookie.
const r20Personas = (dirName, file, mutate) => {
  const g = JSON.parse(fs.readFileSync(path.join(root, 'examples/personas', file), 'utf8'));
  const pd = path.join(tmp, dirName); fs.mkdirSync(pd, { recursive: true });
  for (const [id, device] of [[`${dirName}-wk`, 'iphone-14'], [`${dirName}-cr`, 'pixel-7']]) {
    const p = mutate({ ...g, id, name: id, device, status: 'active', network: { name: 'test fast', latency_ms: 0, down_kbps: null, up_kbps: null } });
    const errs = checkPersona(p); ok(!errs.length, `round 20 persona ${id} is valid`, errs.join('; '));
    fs.writeFileSync(path.join(pd, `${id}.json`), JSON.stringify(p));
  }
  return pd;
};
const collWith = (file, snippet) => (q, r, { PORT }) => { const h = fs.readFileSync(path.join(root, 'examples/fixture-store', file), 'utf8').replaceAll('{{THIRD}}', `http://localhost:${PORT}`).replaceAll('{{PORT}}', String(PORT)).replace(/\{\{[A-Z]+\}\}/g, '').replace('</body>', `${snippet}</body>`); r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(h); };
// Item 1: an attribution app writes cart attributes (no items) on every page load. In cart mode the shopper's tap to the product page is
// not stopped, no speed result is blamed on the store, and the shopper still finds the Checkout button.
{
  const snippet = `<script>fetch('/cart/update.js',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({attributes:{_attribution_session:'abc123'}})}).catch(()=>{});</script>`;
  const s20 = await startFixtureServer({ extraRoutes: { '/collections/gifts': collWith('collection-gifts.html', snippet), '/cart/update.js': (q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"item_count":0,"items":[]}'); } } });
  const pd = r20Personas('attr', 'northwick-gift-giver-gwen.json', (p) => p);
  const r = await runPanelTolerant(['--url', s20.origin, '--i-own', '127.0.0.1', '--personas', pd, '--out', 'reports-r20a', '--pause', '0'], 'reports-r20a');
  const x = latestRun('reports-r20a'); const js = x.res.journeys;
  ok(r.code === 0 && js.length === 2 && js.every((j) => j.reached_checkout && j.quit_kind !== 'patience_exceeded' && j.quit_kind !== 'test_limit' && !j.own_nav_stopped
    && j.cart_touched && !('cart_emptied' in j) && !j.checkout_blocked.some((c) => /after the cart was touched/.test(c.why)))
    && s20.requests.filter((q) => q.url.startsWith('/cart/update.js')).length >= 2,
  'runner (cart mode, both phones): a cart-attribute write on page load does not turn the after-cart rule on; the product tap loads and the shopper finds Checkout',
  JSON.stringify(js.map((j) => [j.device, j.quit_kind, j.reached_checkout, j.checkout_blocked.map((c) => c.why.slice(0, 50))])));
  await s20.close();
}
// Item 1, own navigation: a recognised add on the landing page's load turns the after-cart rule on; the shopper's own tap to a product
// page is then stopped by the panel, and the journey ends as a test limit (never as a slow page or a missing button about the store).
{
  const snippet = `<script>fetch('/cart/add.js',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id=101&quantity=1'}).catch(()=>{});</script>`;
  const s20 = await startFixtureServer({ extraRoutes: { '/collections/gifts': collWith('collection-gifts.html', snippet) } });
  const pd = r20Personas('ownnav', 'northwick-gift-giver-gwen.json', (p) => p);
  const r = await runPanelTolerant(['--url', s20.origin, '--i-own', '127.0.0.1', '--personas', pd, '--out', 'reports-r20n', '--pause', '0'], 'reports-r20n');
  const x = latestRun('reports-r20n'); const js = x.res.journeys;
  ok(r.code === 1 && x.res.status === 'incomplete' && js.length === 2 && js.every((j) => j.quit_kind === 'test_limit' && /the panel's safety rule stopped this page load: "?\/products\//.test(j.quit_reason)
    && /not a result about the store; the run is INCOMPLETE/.test(j.quit_reason) && j.own_nav_stopped && !('cart_emptied' in j))
    && !x.res.findings.some((f) => /patience|took \d+(\.\d+)? s to|no Checkout button/i.test(f.what) && f.severity !== 'test' && f.severity !== 'warn')
    && /the panel's safety rule stopped this page load/.test(x.md),
  'runner (cart mode, both phones): when the safety rule stops the shopper\'s own page load, the journey ends as test_limit with the address',
  JSON.stringify(js.map((j) => [j.engine, j.quit_kind, (j.quit_reason || '').slice(0, 120)])));
  await s20.close();
}
// (R25: the WooCommerce cart-slug journeys were removed with WooCommerce support; a Shopify cart is always /cart)
// Item 3: Ctrl-C while the shopper's Add to cart is still on its way (the store applies it seconds later). The journey's network is
// halted and its context closed; the add is sent once and nothing else is sent (no cart clean-up), so the store's cart keeps the late
// add. Event driven: Ctrl-C is sent only once the store has the add; a run that never reaches the add (a very busy machine) is tried
// once more.
for (const eng of ['cr']) {
  const DELAY = 6000;
  const pd = r20Personas(`stop${eng}`, 'northwick-gift-giver-gwen.json', (p) => ({ ...p, entry_point: { ...p.entry_point, landing_path: '/products/gift-set' }, product_pick: null }));
  for (const f of fs.readdirSync(pd)) if (!f.endsWith(`-${eng}.json`)) fs.rmSync(path.join(pd, f));
  let res = null;
  for (let attempt = 1; attempt <= 2 && !(res && res.ev.includes('add received')); attempt++) {
    let child = null; let cookie = ''; let port = 0; const ev = []; let applied = null; const appliedP = new Promise((y) => { applied = y; });
    const fwd = (pathq, method, body, ck) => new Promise((res2) => { const q = http.request({ host: '127.0.0.1', port, path: pathq, method, headers: { cookie: ck, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body || '') } }, (rr) => { let d = ''; rr.on('data', (c) => d += c); rr.on('end', () => res2({ status: rr.statusCode, b: d })); }); q.on('error', () => res2({ status: 0, b: '' })); q.end(body || ''); });
    const s20 = await startFixtureServer({ extraRoutes: { '/cart/add.js': async (q, r) => {
      let b = ''; for await (const c of q) b += c; cookie = q.headers.cookie || ''; ev.push('add received');
      if (!ev.includes('SIGINT') && child) { ev.push('SIGINT'); interrupt(child); }
      await new Promise((y) => setTimeout(y, DELAY));
      let body = b; try { const jj = JSON.parse(b); body = new URLSearchParams(jj.items ? { id: jj.items[0].id, quantity: jj.items[0].quantity || 1 } : jj).toString(); } catch {}
      const a = await fwd('/cart/add', 'POST', body, cookie); ev.push(`add applied ${a.status}`); applied();
      r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"ok":true}');
    } } });
    port = s20.port;
    fs.rmSync(path.join(tmp, `reports-r20t${eng}`), { recursive: true, force: true });
    const code = await new Promise((y) => {
      child = spawn(process.execPath, [path.join(root, 'scripts/shopper-panel.mjs'), '--url', `${s20.origin}/products/gift-set`, '--i-own', '127.0.0.1', '--personas', pd, '--out', `reports-r20t${eng}`, '--pause', '0', '--cart'], { cwd: tmp, env: { ...process.env, SP_TEST_JOURNEY_CAP_SECONDS: '300' } });
      const k = setTimeout(() => child.kill('SIGKILL'), 15 * 60 * 1000);
      child.on('exit', (c, sig) => { clearTimeout(k); y(c === null ? sig : c); });
    });
    // the late add: wait for the store to apply it (at most a minute), then read the store's own cart with the shopper's cookie
    if (ev.includes('add received')) await Promise.race([appliedP, sleep(60000)]);
    const after = cookie ? await fwd('/cart.js', 'GET', '', cookie) : { b: '' };
    let count = null; try { count = JSON.parse(after.b).item_count; } catch {}
    res = { code, ev, count, j: latestRun(`reports-r20t${eng}`).res.journeys[0] || {} };
    await s20.close();
  }
  const { code, ev, count, j } = res;
  ok(code === 1 && ev.includes('add applied 302') && ev.filter((e) => e === 'add received').length === 1 && j.stopped && j.cart_touched && !('cart_emptied' in j) && count === 1 && j.engine === 'chromium',
  'runner: Ctrl-C during an Add to cart the store applies later; the add is sent once, no clean-up is sent, and the store\'s cart keeps the item (left as it is)',
  JSON.stringify({ code, ev, count, stopped: j.stopped, touched: j.cart_touched }));
}
// ---------- R21 ----------
// Item 6: a Shopify /cart/update with `updates` above 0 can put an item in the cart, so it counts as an add; attributes alone do not.
{
  const cu = 'http://127.0.0.1:1/cart/update.js';
  ok(lib.isCartItemAdd(cu, '{"updates":{"123":1}}') && lib.isCartItemAdd(cu, 'updates%5B123%5D=2') && lib.isCartItemAdd(cu, 'updates[]=0&updates[]=1') && lib.isCartItemAdd('http://127.0.0.1:1/cart/update?updates[5]=1', '')
    && !lib.isCartItemAdd(cu, '{"updates":{"123":0}}') && !lib.isCartItemAdd(cu, '{"attributes":{"a":"b"}}') && !lib.isCartItemAdd(cu, 'attributes[x]=1') && !lib.isCartItemAdd(cu, 'note=hi'),
  'a /cart/update with an updates quantity above 0 counts as an add; attributes, a note or a quantity of 0 do not');
}
// Items 2, 4 and 5 in the source: the cart address is learned only before Add to cart; the browser is not started again after a stop;
// the cart-page Checkout selectors are used only on a cart page.
{
  const src = fs.readFileSync(path.join(root, 'scripts/shopper-panel.mjs'), 'utf8');
  const calls = src.split('lib.learnCartUrl(').length - 1;
  const learnFn = src.slice(src.indexOf('const learnCartUrls = async'), src.indexOf('const vh = dev.ctx.viewport.height'));
  ok(calls === 1 && learnFn.includes('lib.learnCartUrl(') && src.indexOf('await learnCartUrls();') < src.indexOf('lib.markCartTouched(guard, guard.lastDoc || page.url());'),
    'the cart address is learned only in learnCartUrls(), before Add to cart (never from the view-cart link or icon after it)', String(calls));
  ok(/if \(first !== 'stop'\) \{ browsers\[engine\] = await launchers\[engine\]\(\);/.test(src), 'after a stop the browser is closed but not started again');
  ok(/Promise\.race\(\[page\.evaluate\(lib\.readCartCount, j\.platform\), sleep\(8000\)/.test(src) && /await revealCheck\('a closed product section'\);[^]{0,400}const nDetails = await page\.evaluate\(lib\.markClosedProductDetails/.test(src) && typeof lib.openProductDetails === 'undefined', 'the cart count read is time-limited (a stuck page cannot hang the journey), and the checkout reveal check runs before the panel opens closed product sections');
  ok(/await revealCheck\('the photo strip \(a swipe\)'\);\n\s*const swiped = await page\.evaluate/.test(src) && (src.match(/el\.scrollBy\(/g) || []).length === 1, 'a photo swipe (a scroll, not a tap) passes the checkout reveal stop before it moves the strip, like every tap');
  ok(/const onCartPageNow = isCartHere\(page\.url\(\)\);/.test(src) && /\(onCartPageNow \? coSel : panelSel\.flatMap/.test(src) && /if \(!onCartPageNow\) return await quit\('find Checkout', 'error', `the cart page did not open/.test(src),
    'the cart-page Checkout selectors are used only on a cart page (elsewhere only inside a dialog or mini-cart panel)');
}
// Item 1: a store that skips the cart. The view-cart link (by address /kasse/ checked by content, by a learned cart address that
// redirects to /checkout/, or by /cart/ redirecting to /checkout/, or a redirect to /account/login) leads straight to checkout or
// login: since R26 that is a tool limit keeping the blocked category, never reached checkout and never "no Checkout button", and the
// panel never taps Checkout. Item 2: a view-cart link seen only after the add (the notice) is not learned, so its unknown
// address is stopped without being requested and the journey ends as a tool limit.
for (const MODE of ['kasse', 'redirect', 'cartredir', 'notice', 'login']) {
  // R25: on a Shopify product (gift-set), with the cart links rewritten by a proxy; 'cartredir' is a store whose /cart redirects to checkout
  const s21 = await startFixtureServer();
  const target = MODE === 'kasse' ? '/kasse/' : MODE === 'cartredir' ? '/cart' : '/my-basket/';
  const seen = [];
  const proxy = shopServer((q, r) => {
    seen.push(`${q.method} ${q.url}`);
    if (MODE === 'login' && q.url.startsWith('/my-basket')) { r.writeHead(302, { location: '/account/login' }); return r.end(); }
    if ((MODE === 'redirect' && q.url.startsWith('/my-basket')) || (MODE === 'cartredir' && q.method === 'GET' && /^\/cart\/?(\?|$)/.test(q.url))) { r.writeHead(302, { location: '/checkout/' }); return r.end(); }
    const up = http.request({ host: '127.0.0.1', port: s21.port, path: q.url, method: q.method, headers: q.headers }, (ur) => {
      if (!/text\/html/.test(ur.headers['content-type'] || '') || !/^\/products\/gift-set(\?|$)/.test(q.url)) { r.writeHead(ur.statusCode, ur.headers); return ur.pipe(r); }
      let b = ''; ur.setEncoding('utf8'); ur.on('data', (c) => { b += c; }); ur.on('end', () => {
        // notice: the "View cart" link of the added-to-cart notification points to /kasse/ only once the add was sent (never learned)
        if (MODE === 'notice') b = b.replace('</body>', '<script>document.getElementById("product-form").addEventListener("submit", function () { document.getElementById("cart-notification-button").setAttribute("href", "/kasse/"); });</script></body>');
        else b = b.replaceAll('href="/cart"', `href="${target}"`);
        const h = { ...ur.headers }; delete h['content-length']; r.writeHead(ur.statusCode, h); r.end(b);
      });
    });
    q.pipe(up);
  });
  await new Promise((y) => proxy.listen(0, '127.0.0.1', y)); const PO = `http://127.0.0.1:${proxy.address().port}`;
  const pd = r20Personas(`skip${MODE}`, 'northwick-gift-giver-gwen.json', (p) => ({ ...p, entry_point: { ...p.entry_point, landing_path: '/products/gift-set' }, product_pick: null }));
  const out = `reports-r21${MODE}`;
  const r = await runPanelTolerant(['--url', `${PO}/products/gift-set`, '--i-own', '127.0.0.1', '--personas', pd, '--out', out, '--pause', '0'], out);
  const x = latestRun(out); const js = x.res.journeys;
  const both = js.length === 2;
  if (MODE === 'kasse') ok(!/found the Checkout button in the cart/.test(r.out) && !/leads straight to checkout/.test(r.out), 'console: a store that skips the cart is never reported as having found the Checkout button', r.out.slice(-600));
  if (MODE === 'notice') {
    ok(r.code === 1 && both && js.every((j) => j.quit_kind === 'test_limit' && j.own_nav_stopped && /stopped this page load: "?\/kasse\//.test(j.quit_reason) && !j.reached_checkout && !('cart_emptied' in j))
      && !seen.some((s) => /^GET \/kasse\//.test(s)) && !/no Checkout button/.test(x.md),
    'runner (cart mode, both phones): a view-cart link seen only after the add is not learned; its unknown address is stopped unrequested (tool limit)',
    JSON.stringify(js.map((j) => [j.device, j.quit_kind, (j.quit_reason || '').slice(0, 120)])));
  } else {
    // R26: a blocked checkout or login address is never success: every successful cart journey passes the regular Checkout check, so
    // a view-cart tap that leads straight to checkout or login ends as a tool limit (run INCOMPLETE) that keeps the blocked category
    const cat = MODE === 'login' ? 'login' : 'checkout';
    ok(r.code === 1 && both && js.every((j) => j.quit_kind === 'test_limit' && !j.reached_checkout && !j.completed && !j.checkout_request
      && j.cart_skipped_to_checkout && j.cart_skipped_to_checkout.category === cat && new RegExp(`led straight to a ${cat} address[^]*the run is INCOMPLETE`).test(j.quit_reason || '')
      && !j.checkout_page_loaded && !('cart_emptied' in j) && !j.own_nav_stopped && !j.steps.some((st) => st.step === 'tap Checkout' || st.step === 'find Checkout'))
      && !/no Checkout button/.test(x.md) && !x.res.findings.some((f) => f.severity === 'block')
      && !seen.some((t) => /^GET \/(checkout|account)/.test(t)) && (MODE === 'kasse' || !seen.some((t) => /^GET \/kasse/.test(t))),
    `runner (cart mode, both phones): a view-cart tap that leads straight to ${cat} (${MODE}) is a tool limit with category ${cat}, never reached checkout, never "no Checkout button", nothing taps Checkout`,
    JSON.stringify(js.map((j) => [j.device, j.quit_kind, (j.quit_reason || '').slice(0, 160), j.reached_checkout, j.cart_skipped_to_checkout])));
  }
  proxy.closeAllConnections?.(); proxy.close(); await s21.close();
}
// ---------- R22 ----------
// Classifier: bodies are decoded (JSON, form, multipart) before they are classified; clear, update-customer, DELETE, cart attribute and
// unknown GraphQL mutations are cart writes in no-cart mode; a plain query, a GET of the cart and the fragments refresh are not.
{
  const A = 'http://127.0.0.1:1';
  const gq = `${A}/api/2024-01/graphql.json`;
  const yes = [
    [`${A}/cart/clear.js`, '', 'POST'], [`${A}/wp-json/wc/store/v1/cart/update-customer`, '{"billing_address":{}}', 'POST'], [`${A}/wp-json/wc/store/v1/cart/items/abc`, '', 'DELETE'],
    [gq, JSON.stringify({ query: 'mutation { cartAttributesUpdate(cartId:"x", attributes:[]) { cart { id } } }' }), 'POST'],
    [gq, JSON.stringify({ query: 'mutation Mystery { somethingNew(id:1) { id } }' }), 'POST'],
    [gq, JSON.stringify({ extensions: { persistedQuery: { sha256Hash: 'abc' } }, variables: {} }), 'POST'],
    [gq, 'query=' + encodeURIComponent('mutation { cartLinesAdd(cartId:"x", lines:[]) { cart { id } } }'), 'POST'],
    [gq, '--b\r\nContent-Disposition: form-data; name="operations"\r\n\r\n{"query":"mutation { other { id } }"}\r\n--b--', 'POST'],
    [`${A}/?wc-ajax=update_shipping_method`, 'x=1', 'POST'],
  ];
  const no = [[gq, JSON.stringify({ query: 'query { shop { name } }' }), 'POST'], [`${A}/wp-json/wc/store/v1/cart`, '', 'GET'], [`${A}/?wc-ajax=get_refreshed_fragments`, '', 'POST']];
  const badY = yes.filter(([u, b, m]) => !lib.isNoCartWrite(u, m, b, false)); const badN = no.filter(([u, b, m]) => lib.isNoCartWrite(u, m, b, false));
  ok(!badY.length && !badN.length, 'no-cart classifier: decoded bodies; clear, update-customer, DELETE, cart attributes, unknown and persisted GraphQL writes count; plain queries and cart reads do not', JSON.stringify({ badY, badN }));
  ok(lib.graphqlWriteKind(JSON.stringify({ query: 'mutation { cartCreate(input:{lines:[{merchandiseId:"1"}]}) { cart { id } } }' })) === 'add' && lib.graphqlWriteKind(JSON.stringify({ query: 'mutation { mystery { id } }' })) === 'unknown' && lib.graphqlWriteKind(JSON.stringify({ query: '{ shop { name } }' })) === null,
    'GraphQL: cartCreate with lines is an add, an unknown mutation is unknown (fail closed), a query is not a write');
}
// Typing: an allow-list. Only plain text boxes that are not personal or payment related are typed into, and only with fixed test text.
{
  const refused = [{ label: 'Name' }, { label: 'Your name' }, { label: 'Payment number' }, { label: 'Recipient email', type: 'email' }, { label: 'Engraving', autocomplete: 'cc-number' }, { label: 'Card', name: 'card_number' }, { label: 'Phone', type: 'tel' }, { label: 'Note', type: 'number' }, { label: 'Company' }, { label: 'Address line 1' }, { label: 'Message on the card', autocomplete: 'off' }];
  const allowed = [{ label: 'Engraving' }, { label: 'Gift message', type: 'textarea' }, { label: 'Initials (up to 3)' }];
  const bad = [...refused.filter((x) => lib.mayTypeInto(x).ok), ...allowed.filter((x) => !lib.mayTypeInto(x).ok)];
  const src = fs.readFileSync(path.join(root, 'scripts/shopper-panel.mjs'), 'utf8');
  ok(!bad.length && /personal data/.test(lib.mayTypeInto({ label: 'Name' }).why) && /lib\.mayTypeInto\(/.test(src) && !/type_text/.test(src),
    'typing: names, payment and card fields, email, phone, numbers, company and address are never typed into; engraving and gift message are; the runner never types persona text', JSON.stringify(bad));
}
// Payment fields count as checkout content; the cross-origin bounce page; exit status for stops and short runs
{
  ok(/payment card field/.test(lib.checkoutContentReason('<html><body><form><input autocomplete="cc-number"></form></body></html>') || '') && /payment card field/.test(lib.checkoutContentReason('<body><input name="cvc"></body>') || '') && !lib.checkoutContentReason('<body><input name="engraving"></body>'),
    'a page with a payment card field (cc-number, cvc) is checkout content wherever it is');
  const bh = lib.bounceHtml('http://localhost:9/a"b<c');
  ok(/http-equiv="refresh"/.test(bh) && /location\.replace\(/.test(bh) && !/a"b<c/.test(bh), 'a cross-origin page redirect is answered with a page that sends the browser on (escaped), never the other origin\'s page');
  const done = { quit_kind: null, completed: true };
  ok(lib.exitCodeFor({ journeys: [done], planned: 2, stopped: false }) === 1 && lib.runStatusFor({ journeys: [done], planned: 1, stopped: true }) === 'incomplete'
    && lib.runStatusFor({ journeys: [{ ...done, cart_touched: true }], planned: 1 }) === 'completed'
    && lib.exitCodeFor({ journeys: [done], planned: 1, stopped: false }) === 0,
  'exit status: a stopped run and a run shorter than planned are INCOMPLETE (exit 1), never COMPLETED; a touched cart left as it is still completes');
}
// Guard: every redirect hop is vetted (page loads, images, a 307 fetch), a cross-origin redirect is never answered under the first
// address, every synchronous XHR is refused and counted, and late checkout content (a payment field a script draws) is detected.
// localhost is a second own host here (another origin of the same store); an allow-listed host would serve static files only.
{
  const hits = [];
  const srv22 = shopServer(async (q, r) => {
    let b = ''; for await (const c of q) b += c;
    hits.push(`${q.method} ${q.headers.host.split(':')[0]} ${q.url}`);
    const port = srv22.address().port;
    const html = (s) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(`<!doctype html><html><body>${s}</body></html>`); };
    const go = (code, loc) => { r.writeHead(code, { location: loc }); r.end(); };
    if (q.url === '/r22/to-add') return go(302, '/cart/add?id=1&quantity=1');
    if (q.url === '/r22/img-add') return go(302, '/cart/add?id=2&quantity=1');
    if (q.url === '/r22/h307') return go(307, '/cart/add.js');
    if (q.url === '/r22/xo') return go(302, `http://localhost:${port}/r22/landed`);
    if (q.url === '/r22/xf') return go(302, `http://localhost:${port}/r22/data`);
    if (q.url === '/r22/landed') return html('<h1>LANDED</h1>');
    if (q.url === '/r22/late') return html('<h1>Order</h1><script>setTimeout(()=>{document.body.insertAdjacentHTML("beforeend","<input autocomplete=cc-number>")},1200)</script>');
    if (q.url === '/r22/frame') return html('<iframe src="/r22/page"></iframe>');
    if (q.url.startsWith('/api/')) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end('{"data":{}}'); }
    return html('<h1>page</h1>');
  });
  await new Promise((y) => srv22.listen(0, '127.0.0.1', y));
  const P = srv22.address().port; const X = `http://127.0.0.1:${P}`;
  for (const [name, type] of [['chromium', chromium]]) {
    hits.length = 0;
    const browser = await type.launch({ args: ['--disable-features=LocalNetworkAccessChecks'] });
    const ctx = await browser.newContext(); ctx.setDefaultTimeout(20000);
    const state = {}; const ev = { cart: [], inter: [], stops: [] };
    let page;
    await lib.installGuard(ctx, { state, getPage: () => page, blockRules: [], allowHosts: [], ownHosts: new Set(['127.0.0.1', 'localhost']), landingPaths: new Set(['/r22/page']), delayMs: 0, noCart: true,
      onCheckout: (x) => ev.stops.push(x), onThirdParty: () => {}, onCartWrite: (x) => ev.cart.push(x), onIntervention: (x) => ev.inter.push(x) });
    const loaded = []; lib.watchContext(ctx, (how) => loaded.push(how), () => {});
    page = await ctx.newPage();
    await page.goto(`${X}/r22/page`);
    await page.goto(`${X}/r22/to-add`).catch(() => {});
    // the stopped redirect leaves an error page that can still be committing; one retry if it interrupts the next load
    await sleep(300); await page.goto(`${X}/r22/page`).catch(async () => { await sleep(500); await page.goto(`${X}/r22/page`); });
    const fx = await page.evaluate(async () => {
      const o = {};
      const im = new Image(); im.src = '/r22/img-add'; await new Promise((y) => { im.onload = im.onerror = y; setTimeout(y, 3000); });
      for (const [k, u, init] of [['h307', '/r22/h307', { method: 'POST', body: 'id=3&quantity=1' }], ['gqm', '/api/2024-01/graphql.json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'mutation { mystery { id } }' }) }],
        ['gqq', '/api/2024-01/graphql.json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ shop { name } }' }) }], ['xf', '/r22/xf', {}]]) { try { o[k] = (await fetch(u, init)).status; } catch { o[k] = 'stopped'; } }
      return o;
    });
    ok(!hits.some((h) => /\/cart\/add/.test(h)) && fx.h307 === 'stopped' && fx.gqm === 'stopped' && ev.cart.some((c) => /server redirect/.test(c.kind) && /page load/.test(c.kind)) && ev.cart.some((c) => /server redirect/.test(c.kind) && /image/.test(c.kind)),
      `${name}: no-cart mode vets every redirect hop (a page load, an image, a 307 POST) and fails closed on an unknown GraphQL mutation; nothing reaches /cart/add`, JSON.stringify({ fx, cart: ev.cart.map((c) => c.kind), hits: hits.filter((h) => /cart/.test(h)) }));
    ok(fx.xf === 'stopped' && ev.inter.some((i) => /another origin/.test(i.what)) && !hits.some((h) => /\/r22\/data/.test(h)), `${name}: a fetch redirected to another origin is stopped (never read under the first origin)`, JSON.stringify(ev.inter));
    const xo = await page.goto(`${X}/r22/xo`).then((r) => r && r.text()).catch((e) => `err ${e.message}`);
    await page.waitForURL(/localhost/, { timeout: 10000 }).catch(() => {});
    ok(!/LANDED/.test(xo || '') && /^http:\/\/localhost:/.test(page.url()) && /LANDED/.test(await page.content()), `${name}: a page redirected to another origin is sent on to it in view, never shown under the first address`, `${String(xo).slice(0, 80)} ${page.url()}`);
    await page.goto(`${X}/r22/frame`); await sleep(500);
    hits.length = 0;
    const sync = await page.evaluate(() => {
      const o = {};
      try { const x = new XMLHttpRequest(); x.open('POST', '/api/pay', false); x.send('x'); o.xhr = x.status; } catch { o.xhr = 'stopped'; }
      try { const x = new XMLHttpRequest(); x.open('GET', '/r22/page', false); x.send(); o.sget = x.status; } catch { o.sget = 'stopped'; }
      return o;
    });
    await sleep(500);
    ok(sync.xhr === 'stopped' && sync.sget === 'stopped' && !hits.some((h) => /\/api\/pay|GET 127\.0\.0\.1 \/r22\/page/.test(h)) && ev.inter.filter((i) => /synchronous request/.test(i.what)).length >= 2,
      `${name}: every synchronous XHR (a POST and a plain GET) is refused before it is sent, and counted`, JSON.stringify({ sync, hits, inter: ev.inter.map((i) => i.what.slice(0, 40)) }));
    await page.goto(`${X}/r22/late`); await sleep(3500);
    ok(loaded.some((h) => /payment card field/.test(h)), `${name}: a payment field a script draws after the page loaded is detected as checkout content`, JSON.stringify(loaded));
    await ctx.close(); await browser.close();
  }
  srv22.close();
}
// Runner end to end (both phones). Helper: run with personas from one example on both phones.
const r22run = async (tag, env, args, mutate, landing = '/products/gift-set', extra = {}) => {
  const s = await startFixtureServer(extra);
  const pd = r20Personas(`r22${tag}`, 'northwick-gift-giver-gwen.json', (p) => ({ ...p, entry_point: { ...p.entry_point, landing_path: landing }, product_pick: null, ...(mutate ? mutate(p) : {}) }));
  const out = `reports-r22${tag}`;
  const r = await runPanel(['--url', `${s.origin}${landing}`, '--i-own', '127.0.0.1', '--personas', pd, '--out', out, '--pause', '0', ...args], env);
  const x = latestRun(out); await s.close();
  return { r, x, js: x.res.journeys, s };
};
// #7: the browser-level guard did not attach: no journey is run (every journey is a tool limit); INCOMPLETE
{
  const { r, x, js } = await r22run('nocdp', { SP_TEST_SKIP_BROWSER_GUARD: '1' }, []);
  ok(r.code === 1 && x.res.status === 'incomplete' && js.length === 2 && js.every((j) => j.quit_kind === 'test_limit' && j.quit_step === 'start' && !(j.steps || []).length && /could not be attached/.test(j.quit_reason || ''))
    && /\*\*Not attached: Chrome-engine journeys were not run/.test(x.md),
  'runner: when the browser-level guard does not attach, no journey is run (each is a tool limit) and the run is INCOMPLETE', JSON.stringify({ code: r.code, status: x.res.status, js: js.map((j) => [j.device, j.quit_kind, j.quit_step]) }));
}
// #6: a worker that started without the panel's guard is closed and the journey is a tool limit (both phones)
{
  const w = `<script>try{new Worker('/assets/r22-worker.js')}catch(e){}</script>`;
  const { r, js } = await r22run('worker', { SP_TEST_SKIP_WORKER_GUARD: '1' }, [], null, '/products/gift-set', { extraHtml: { '/products/gift-set': w }, extraRoutes: { '/assets/r22-worker.js': (q, res) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('setInterval(function(){},1000);'); } } });
  ok(r.code === 1 && js.length === 2 && js.every((j) => j.unguarded_workers >= 1 && j.quit_kind === 'test_limit' && /without the panel's guard/.test(j.quit_reason || '') && (j.guard_interventions || []).some((i) => /web worker/.test(i))),
    'runner (both phones): a web worker without the guard is closed, and the journey is a tool limit, never a pass', JSON.stringify(js.map((j) => [j.engine, j.unguarded_workers, j.quit_kind])));
  const g = await r22run('workerok', {}, [], null, '/products/gift-set', { extraHtml: { '/products/gift-set': w }, extraRoutes: { '/assets/r22-worker.js': (q, res) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('setInterval(function(){},1000);'); } } });
  ok(g.r.code === 0 && g.js.length === 2 && g.js.every((j) => !j.unguarded_workers && j.quit_kind !== 'test_limit'), 'runner (both phones): a worker started with the guard is left alone', JSON.stringify(g.js.map((j) => [j.engine, j.unguarded_workers, j.quit_kind, (j.quit_reason || '').slice(0, 80)])));
}
// R24: a "covered" tap. A real cover is the store's (element_covered, named by its opening tag, never "/div"). On a page wider
// than the phone, the browser's tap check can miss a button that is on top in the page itself: a tool limit, plus a store finding.
{
  ok(lib.coverFrom('<div class="product__description rte">\u2026</div> intercepts pointer events') === 'div class="product__description rte"'
    && lib.coverFrom('<span>Sale</span> from <div class="promo"> subtree intercepts pointer events') === 'span'
    && lib.coverFrom('<div class="overlay"></div> intercepts pointer events') === 'div class="overlay"'
    && lib.coverFrom('Timeout 8000ms exceeded.') === null, 'a covered tap names the covering element by its opening tag, never its closing tag ("/div")');
  const plain = (p) => ({ before_buying: [{ need: 'what it is made of', look_for: ['canvas'], if_missing: 'warn' }], choices: [] });
  const wide = await r22run('wide', {}, ['--no-cart'], plain, '/products/dawn-tote', { extraHtml: { '/products/dawn-tote': '<style>.product__media-wrapper img{max-width:none;width:600px}</style>' } });
  ok(wide.r.code === 1 && wide.js.length === 2 && wide.js.every((j) => j.quit_step === 'add to cart' && j.quit_kind === 'test_limit' && /wider than the phone screen/.test(j.quit_reason || '') && j.too_wide)
    && /wider than the phone screen[^\n]*scrolls sideways/.test(wide.x.md),
    'runner (both phones): on a page wider than the phone, a tap check that misses a button on top in the page is a tool limit (not "covered"), and the sideways page is a finding', JSON.stringify(wide.js.map((j) => [j.device, j.quit_step, j.quit_kind, (j.quit_reason || '').slice(0, 140)])));
  const cov = await r22run('covered', {}, ['--no-cart'], plain, '/products/dawn-tote', { extraHtml: { '/products/dawn-tote': `<style>.product__info-container form{position:relative}</style><script>document.querySelector('.product__info-container form').insertAdjacentHTML('beforeend','<div class=\\"sp-cover\\" style=\\"position:absolute;inset:0;z-index:5\\"></div>')</script>` } });
  ok(cov.js.length === 2 && cov.js.every((j) => j.quit_step === 'add to cart' && j.quit_kind === 'element_covered' && /covered by <"?div class=\\?["']sp-cover/.test(j.quit_reason || '') && !/"\/div"/.test(j.quit_reason || '') && !j.too_wide),
    'runner (both phones): a real cover over Add to cart stays the store\'s (element_covered), named by the covering element', JSON.stringify(cov.js.map((j) => [j.device, j.quit_step, j.quit_kind, (j.quit_reason || '').slice(0, 140)])));
}
// #11: a quit after the panel's own guard stopped a request: a content quit keeps its kind with a caveat and a table marker
{
  const gift = `<script>fetch('/cart/add.js',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id=101&quantity=1'}).catch(()=>{});</script>`;
  const { r, x, js } = await r22run('caveat', {}, ['--no-cart'], (p) => ({ before_buying: [{ need: 'a dragon guarantee', look_for: ['dragon guarantee'], if_missing: 'quit' }] }), '/products/gift-set', { extraHtml: { '/products/gift-set': gift } });
  ok(js.length === 2 && js.every((j) => j.quit_kind === 'required_info_missing' && j.quit_guard_caveat && /panel's own guard stopped/.test(j.quit_reason || '')) && /\[the panel's own guard may have affected this\]/.test(x.md) && /Requests the panel's own guard stopped/.test(x.md) && r.code === 0,
    'runner (both phones): a content quit after the guard stopped a page request keeps its kind with a caveat and a marker', JSON.stringify(js.map((j) => [j.engine, j.quit_kind, (j.quit_reason || '').slice(0, 160)])));
  // the same quit when the page's cart write happened in the step that failed (it fires when a closed product section opens): a tool limit
  const onOpen = `<script>document.addEventListener('toggle',()=>{fetch('/cart/add.js',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id=101&quantity=1'}).catch(()=>{})},true);</script>`;
  const t2 = await r22run('samestep', {}, ['--no-cart'], (p) => ({ before_buying: [{ need: 'a dragon guarantee', look_for: ['dragon guarantee'], if_missing: 'quit' }] }), '/products/gift-set', { extraHtml: { '/products/gift-set': onOpen } });
  ok(t2.js.length === 2 && t2.js.every((j) => j.quit_kind === 'test_limit' && j.quit_original_kind === 'required_info_missing' && /may have caused this/.test(j.quit_reason || '')) && t2.r.code === 1,
    'runner (--no-cart): a cart write the page makes in the very step that then fails makes that quit a tool limit (only a write in the same step does)', JSON.stringify(t2.js.map((j) => [j.quit_kind, j.quit_original_kind, j.guard_kinds, (j.quit_reason || '').slice(0, 160)])));
}
// #13: Ctrl-C during the pause between journeys: the pause ends at once, no further journey starts, INCOMPLETE (exit 1), personas_run
// lists only the journeys that ran
{
  const s = await startFixtureServer();
  const pd = r20Personas('r22pause', 'northwick-gift-giver-gwen.json', (p) => ({ ...p, entry_point: { ...p.entry_point, landing_path: '/products/gift-set' }, product_pick: null }));
  fs.rmSync(path.join(tmp, 'reports-r22pause'), { recursive: true, force: true });
  const t0p = Date.now(); let sent = 0;
  const code = await new Promise((y) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/shopper-panel.mjs'), '--url', `${s.origin}/products/gift-set`, '--i-own', '127.0.0.1', '--personas', pd, '--out', 'reports-r22pause', '--pause', '120'], { cwd: tmp, env: { ...process.env, SP_TEST_JOURNEY_CAP_SECONDS: '180' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (!sent && /\.\.\. [^\n]*\n/.test(out.slice(out.indexOf(' ... ')))) { sent = Date.now(); setTimeout(() => interrupt(child), 1500); } });
    const k = setTimeout(() => child.kill('SIGKILL'), 8 * 60 * 1000);
    child.on('exit', (c, sig) => { clearTimeout(k); y(c === null ? sig : c); });
  });
  const x = latestRun('reports-r22pause'); await s.close();
  ok(code === 1 && sent && Date.now() - sent < 60000 && x.res.status === 'incomplete' && x.res.journeys.length === 1 && (x.res.personas_run || []).length === 1 && (x.res.personas_planned || []).length === 2 && /Incomplete: the run was stopped before it finished \(1 of 2/.test(x.res.summary || x.md),
    'runner: Ctrl-C during the pause between journeys ends the run at once as INCOMPLETE (exit 1); personas_run lists only the journey that ran', JSON.stringify({ code, waited: sent ? Date.now() - sent : null, status: x.res.status, n: x.res.journeys.length, run: x.res.personas_run, ms: Date.now() - t0p }));
}
// ---------- R22b: strict options, typed text, addresses, files, report wording, Windows ----------
{
  const bad = async (args, re, what) => { const r = await runPanel(args); ok(r.code === 2 && re.test(r.err), what, `${r.code} ${r.err.slice(0, 200)}`); };
  const P = ['--url', O, '--i-own', '127.0.0.1', '--dry-run'];
  await bad([...P, '--cart=false'], /--cart is an on\/off option and takes no value/, 'strict options: --cart=false is refused (exit 2), so it can never turn anything on');
  await bad([...P, '-x'], /Unknown option/, 'strict options: an unknown single-dash option is refused');
  await bad([...P, 'stray'], /Unexpected "stray"/, 'strict options: a stray word is refused');
  await bad([...P, '--pause', 'abc'], /--pause/, 'strict options: --pause abc is refused');
  await bad([...P, '--out', 'a', '--out', 'b'], /--out was given twice/, 'strict options: a value given twice is refused');
  { const rc = await runPanel([...P, '--cart']); ok(rc.code === 0, 'cart mode is the default: --cart on its own is accepted and changes nothing (older commands keep working)', `${rc.code} ${rc.err.slice(0, 200)}`); }
  await bad(['--url', 'http://10.1.2.3', '--i-own', '10.1.2.3', '--dry-run'], /private network address/, 'a private network --url is refused');
  await bad(['--url', 'http://169.254.169.254', '--i-own', '169.254.169.254', '--dry-run'], /private network address/, 'a cloud metadata --url is refused');
  const src = fs.readFileSync(path.join(root, 'scripts/shopper-panel.mjs'), 'utf8');
  ok(!/process\.env\.[A-Z_]*CART/i.test(src) && !/persona[^\n]*\.cart\b/.test(src) && !/cfg[^\n]*\.cart\b/i.test(src), 'no environment variable, persona field or config value can switch cart mode');
  ok(/redirect: 'manual'/.test(src) && /dns\.lookup\(/.test(src), 'the myshopify check does not follow redirects and looks the address up first');
  ok(/if \(loopback && process\.env\.SP_TEST_STDIN_STOP\)/.test(src), 'the stdin stop line is honoured only for a loopback run');
  ok(!/type_text|personalTextReason/.test(src) && !/\.(fill|type|pressSequentially|insertText|setInputFiles)\(/.test(src.replace(/\/\/[^\n]*/g, '')) && !/keyboard\.(type|insertText)\(/.test(src) && /lib\.typeFixed\(/.test(src), 'typing: the runner never reads persona text and types only through lib.typeFixed (no fill, type, pressSequentially, insertText or setInputFiles of its own)');
  ok(['email@example.com', 'call 555-123-4567', '+44 20 7946 0958', '4111 1111 1111 1111', 'https://x.example', 'www.example.com', 'shop.example.com'].every((t) => lib.personalTextReason(t)) && ['Gwen', '12.05.2026', 'Love you 2026', '1234 5678', 'For Mum'].every((t) => !lib.personalTextReason(t)), 'typed text: an email, a phone number, a card number or a web address is refused; a name, a date or a short number is not');
  const tp = { ...base, id: 'tt', name: 'tt', device: 'iphone-14', entry_point: { channel: 'direct', landing_path: '/' }, before_buying: [], main_quit_reason: 'x', choices: [{ option: 'engraving', type_text: 'me@example.com' }] };
  ok(checkPersona(tp).some((e) => /type_text is no longer supported/.test(e)) && checkPersona({ ...tp, choices: [{ option: 'engraving', type_text: 'Gwen' }] }).some((e) => /type_text is no longer supported/.test(e)), 'the persona check refuses any type_text (the panel types only fixed test text)', checkPersona(tp).join('; '));
  ok(lib.slowPatternReason('(a+)+') && lib.slowPatternReason('(\\w*)*') && lib.slowPatternReason('(a)\\1') && !lib.slowPatternReason('(a|b)+') && !lib.slowPatternReason('(\\d{3})+') && lib.safeRegex('(a+)+$').err, 'patterns that could run very slowly are refused');
  const pr = lib.safeRegex('{price}', 'i', { bounded: true }).re;
  ok(pr && pr.test('only 24,00 € today') && pr.test('$24') && pr.test('£18.50') && !pr.test('no price here'), 'the {price} pattern matches a price in any currency');
  const ps = await import('./persona-schema.mjs');
  const jd = path.join(tmp, 'r22b-json'); fs.mkdirSync(jd, { recursive: true });
  fs.writeFileSync(path.join(jd, 'bom.json'), '﻿{"a":1}'); fs.writeFileSync(path.join(jd, 'big.json'), `{"a":"${'x'.repeat(ps.MAX_JSON_BYTES)}"}`);
  ok(ps.readJsonFile(fsRaw, path.join(jd, 'bom.json')).value?.a === 1 && ps.readJsonFile(fsRaw, path.join(jd, 'big.json')).err, 'JSON files: a leading byte order mark is ignored, and a file over 256 KB is refused');
  const pd = path.join(tmp, 'r22b-ids'); fs.mkdirSync(pd, { recursive: true });
  const gw = JSON.parse(fs.readFileSync(path.join(root, 'examples/personas/northwick-gift-giver-gwen.json'), 'utf8'));
  fs.writeFileSync(path.join(pd, 'other-name.json'), JSON.stringify({ ...gw, status: 'active' }));
  await bad(['--url', O, '--i-own', '127.0.0.1', '--personas', pd, '--dry-run'], /"id" must match the file name/, 'the runner refuses a persona whose id is not its file name');
  const pd2 = path.join(tmp, 'r22b-dup'); fs.mkdirSync(path.join(pd2, 'a'), { recursive: true }); fs.mkdirSync(path.join(pd2, 'b'), { recursive: true });
  for (const d of ['a', 'b']) fs.writeFileSync(path.join(pd2, d, `${gw.id}.json`), JSON.stringify(gw));
  const vd = await new Promise((resolve) => { const c = spawn(process.execPath, [path.join(root, 'scripts/validate-personas.mjs'), path.join(pd2, 'a'), path.join(pd2, 'b')], { cwd: tmp }); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { o += d; }); c.on('exit', (code) => resolve({ code, o })); });
  ok(vd.code !== 0 && /is also used by/.test(vd.o), 'the validator flags two persona files with the same id', vd.o.slice(-300));
  const demo = fs.readFileSync(path.join(root, 'scripts/demo.mjs'), 'utf8');
  ok(/updateSample \? root : fs\.mkdtempSync\(/.test(demo) && !/'--cart'/.test(demo), 'the demo writes to a temporary folder unless --update-sample, and never uses --cart');
  ok(/^\* text=auto eol=lf$/m.test(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8')), '.gitattributes keeps line endings plain (LF)');
  const wf = fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');
  ok(/ubuntu-latest, windows-latest, macos-latest/.test(wf) && /node: \[22, 24\]/.test(wf) && JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).engines.node === '>=22', 'CI runs on Linux, Windows and macOS with Node 22 and 24; engines >=22');
  ok(/install --with-deps/.test(src) && /Cannot start the \$\{k\} browser engine/.test(src), 'the missing-browser message names the engine and gives the Linux --with-deps line');
  const rdm = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  ok(rdm.includes(lib.PROMISE) && rdm.includes('Works only on Shopify stores that use an Online Store theme') && rdm.includes('runs nothing and exits with code 2') && rdm.includes('Set-ExecutionPolicy -Scope CurrentUser RemoteSigned') && rdm.includes('npx playwright install --with-deps chromium') && !/webkit/i.test(rdm) && rdm.includes('Safari-only bugs are not caught') && rdm.includes('express buttons and pay-in-4 messages may not render') && !rdm.includes('i0.wp.com') && rdm.includes('You are responsible for where you point it.') && !/\.git; cd /.test(rdm), 'README: the promise, the platforms, the PowerShell notes, the Chromium-only Linux line, the Safari and express-button limits, the WooCommerce hosts, the ownership line, no ; chaining');
  // the report wording, from the first full run above
  ok(/\*\*In short: it shopped like a customer up to the cart and stopped before checkout: it never tapped Checkout, never paid, never logged in, and (it typed nothing|it typed only fixed test text)/.test(md) && md.includes(`What the panel does: ${lib.PROMISE}`) && /Detected platform: /.test(md) && /<details><summary>How the panel kept this a test/.test(md) && !/waits \d+ ?s/.test(md) && /## Who got to the Checkout button/.test(md), 'report: the plain top line (stopped before checkout), the promise, the detected platform, the folded safety details, no "waits Ns", the Checkout heading', md.slice(0, 400));
  // a start address that is "Page not found" is a broken link, a store result (both phones)
  const nf = await r22run('nf', {}, [], null, '/products/no-such-candle');
  ok(nf.js.length === 2 && nf.js.every((j) => j.quit_kind === 'broken_link' && /Page not found/.test(j.quit_reason)) && nf.r.code === 0, 'a start address that shows "Page not found" ends as broken_link, a store result, not a test error', JSON.stringify(nf.js.map((j) => [j.quit_kind, j.quit_reason])) + nf.r.err.slice(0, 200));
}
// ---------- R23: browse only means reads only (Codex round 2) ----------
{
  // #3: an encoded address is checked as the server would route it
  ok(!!cr('https://shop.example/%63heckout/') && !!cr('https://shop.example/%63heckouts/c/abc') && !!cr('https://shop.example/?wc%2dajax=checkout') && !!cr('https://shop.example/?WC-AJAX=checkout'.toLowerCase()) && !cr('https://shop.example/%63andles/'),
    'checkout check: a percent-encoded checkout path or query name is still a checkout (decoded as a second layer)');
  ok(lib.isNoCartWrite('https://shop.example/%63art/add.js', 'POST', 'id=1') && lib.isNoCartWrite('https://shop.example/cart/?remove_item=abc', 'GET') && lib.isNoCartWrite('https://shop.example/?apply_coupon=X', 'GET') && !lib.isNoCartWrite('https://shop.example/products/a', 'GET'),
    'cart write check: an encoded cart path and WooCommerce remove, coupon links are cart writes');
  // #4, #5: a worker refuses every socket, the store's own included, and the replacement keeps no link to the real constructor
  const Orig = function WebSocket(u) { this.u = u; }; const fake = { WebSocket: Orig, location: { origin: 'https://shop.example', href: 'https://shop.example/' }, fetch: () => Promise.resolve(), DOMException: class extends Error { constructor(m, n) { super(m); this.name = n; } } };
  lib.workerGuardFn(lib.workerGuardConfig({ ownHosts: ['shop.example'], allowHosts: ['cdn.example'] }), fake, true, () => false);
  const threw = (u) => { try { new fake.WebSocket(u); return ''; } catch (e) { return e.name; } };
  ok(threw('wss://shop.example/socket') === 'SecurityError' && threw('wss://cdn.example/socket') === 'SecurityError' && threw('wss://elsewhere.example/') === 'SecurityError' && fake.WebSocket !== Orig && fake.WebSocket.prototype.constructor !== Orig && Object.getPrototypeOf(fake.WebSocket) !== Orig,
    'worker guard: every socket is refused (the store itself and an allow-listed host included), and the original WebSocket cannot be reached through the replacement');
  const src = fs.readFileSync(path.join(root, 'scripts/shopper-panel.mjs'), 'utf8');
  // #8: the ownership check reads only /meta.json and the home page, never the address given
  ok(/get\(new URL\('\/meta\.json', c\.target\)/.test(src) && /get\(new URL\('\/', c\.target\)\.toString\(\)\)/.test(src) && !/get\(c\.target\.toString\(\)\)/.test(src), 'the myshopify ownership check fetches only /meta.json and "/", never the start address');
}
// ---------- R24: one policy for every request (v3) ----------
{
  const own = new Set(['shop.example']);
  const pol = { blockRules: [], allowHosts: ['cdn.example', 'i0.wp.com'], ownHosts: own, noCart: false };
  const NG = (url, method = 'GET', postData = '', resourceType = 'fetch') => lib.netGuardReason(pol, { url, method, postData, resourceType });
  // real payment provider hostnames are stopped for every request type, even when a store allow-lists them
  const provider = ['https://checkoutshopper-live.adyen.com/checkoutshopper/sdk.js', 'https://js.braintreegateway.com/web/3.97.2/js/client.min.js', 'https://payments.braintree-api.com/graphql',
    'https://web.squarecdn.com/v1/square.js', 'https://connect.squareup.com/v2/payments', 'https://js.authorize.net/v1/Accept.js', 'https://accept.authorize.net/payment/payment',
    'https://cdn.checkout.com/js/framesv2.min.js', 'https://api.checkout.com/tokens', 'https://js.mollie.com/v1/mollie.js', 'https://checkout.razorpay.com/v1/checkout.js', 'https://api.razorpay.com/v1/orders',
    'https://connect.bolt.com/connect-bolt.js', 'https://www.paypal.com/sdk/js?client-id=x&components=fastlane', 'https://shop.app/pay/installments', 'https://shop.example/cdn/shopifycloud/shop-js/modules/v2/loader.payment-terms.js'];
  const polAll = { ...pol, allowHosts: ['adyen.com', 'braintreegateway.com', 'squarecdn.com', 'authorize.net', 'checkout.com', 'mollie.com', 'razorpay.com', 'bolt.com', 'paypal.com', 'shop.app'] };
  const miss = provider.filter((u) => ['script', 'fetch', 'document', 'image'].some((rt) => (lib.netGuardReason(polAll, { url: u, method: 'GET', resourceType: rt }) || {}).kind !== 'hard'));
  ok(!miss.length, 'payment hosts: Adyen, Braintree, Square, Authorize.net, Checkout.com, Mollie, Razorpay, Bolt, PayPal Fastlane and Shop Pay installments are stopped for every request type, allow-listed or not', JSON.stringify(miss));
  ok(!lib.paymentHostReason('mycheckout.com') && !lib.paymentHostReason('checkout.com.evil.example') && !lib.paymentHostReason('notadyen.com') && lib.paymentHostReason('CHECKOUT.COM.') && lib.paymentHostReason('live.adyen.com'), 'payment hosts: matched as a whole name or a subdomain, case and a trailing dot ignored, never as a substring');
  // named entry points on other platforms (tokenised on _ - . /)
  const named = [['https://shop.example/index.php?controller=order', 'GET'], ['https://shop.example/index.php?controller=order&step=3', 'POST'], ['https://shop.example/index.php?controller=order-confirmation', 'GET'],
    ['https://shop.example/wp-admin/admin-ajax.php?action=woocommerce_checkout', 'POST'], ['https://shop.example/?wc-ajax=checkout', 'POST'], ['https://shop.example/cart.php?action=buy&sku=1', 'GET'],
    ['https://shop.example/rest/default/V1/guest-carts/abc/payment-information', 'POST'], ['https://shop.example/rest/V1/carts/mine/payment-information', 'POST'], ['https://shop.example/rest/default/V1/guest-carts/abc/place-order', 'PUT'],
    ['https://shop.example/index.php?route=checkout/confirm', 'GET'], ['https://shop.example/index.php?route=extension/payment.stripe', 'POST']];
  const leaks = named.filter(([u, m]) => !NG(u, m) && !NG(u, m, '', 'document'));
  ok(!leaks.length && named.every(([u, m]) => lib.checkoutReason({ url: u, method: m, isNavigation: true }) || lib.dispatchReason({ url: u, method: m })), 'named entry points: PrestaShop controller=order, WooCommerce action=woocommerce_checkout, BigCommerce cart.php?action=buy, Magento payment-information and place-order, OpenCart routes are all stopped', JSON.stringify(leaks));
  // shared dispatch endpoints: only recognised cart operations pass
  const dpass = [['https://shop.example/?wc-ajax=add_to_cart', 'product_id=1'], ['https://shop.example/wp-admin/admin-ajax.php', 'action=woocommerce_add_to_cart&product_id=1'], ['https://shop.example/wp-json/wc/store/v1/cart/add-item', '{"id":1}'],
    ['https://shop.example/rest/default/V1/guest-carts/abc/items', '{}'], ['https://shop.example/api/2024-07/graphql.json', '{"query":"mutation{cartLinesAdd(cartId:\\"x\\",lines:[]){cart{id}}}"}'], ['https://shop.example/api/2024-07/graphql.json', '{"query":"{product(handle:\\"a\\"){title}}"}'],
    ['https://shop.example/index.php?controller=cart&add=1', 'id_product=1']];
  const dblock = [['https://shop.example/?wc-ajax=update_order_review', ''], ['https://shop.example/wp-admin/admin-ajax.php', 'action=my_custom_action'], ['https://shop.example/wp-admin/admin-ajax.php', ''], ['https://shop.example/wp-json/wc/store/v1/batch', '{"requests":[]}'],
    ['https://shop.example/wp-json/wp/v2/users', '{}'], ['https://shop.example/api/orders', '{"line":1}'], ['https://shop.example/rest/V1/customers', '{}'], ['https://shop.example/api/2024-07/graphql.json', '{"query":"mutation{customerCreate(input:{}){customer{id}}}"}'],
    ['https://shop.example/api/2024-07/graphql.json', '[{"query":"{shop{name}}"}]'], ['https://shop.example/api/2024-07/graphql.json', '{"extensions":{"persistedQuery":{"sha256Hash":"x"}}}'], ['https://shop.example/index.php?controller=cart', 'delete=1']];
  const badPass = dpass.filter(([u, b]) => lib.dispatchReason({ url: u, method: 'POST', body: b }));
  const badBlock = dblock.filter(([u, b]) => !lib.dispatchReason({ url: u, method: 'POST', body: b }) || (NG(u, 'POST', b) || {}).kind !== 'dispatch' && (NG(u, 'POST', b) || {}).kind !== 'hard');
  ok(!badPass.length && !badBlock.length && !lib.dispatchReason({ url: 'https://shop.example/api/orders', method: 'GET' }), 'shared endpoints: known cart operations pass; any other write (unknown action, Store API batch, users, orders, a non-cart mutation, a batch or persisted query, a controller with no add) is stopped', JSON.stringify({ badPass, badBlock }));
  // another host: only static GET and HEAD from an allow-listed host; anything else to a host that is not the store is stopped
  ok(!NG('https://cdn.example/a.js', 'GET', '', 'script') && !NG('https://i0.wp.com/a.jpg', 'HEAD', '', 'image') && !!NG('https://cdn.example/api', 'POST', '{}', 'fetch') && NG('https://cdn.example/a.json', 'GET', '', 'fetch')?.kind === 'host'
    && NG('https://cdn.example/a.js', 'PUT', '', 'script')?.kind === 'host' && NG('https://elsewhere.example/a.js', 'GET', '', 'script')?.kind === 'host' && lib.allowHostRequestOk('GET', 'stylesheet') && !lib.allowHostRequestOk('POST', 'image') && !lib.allowHostRequestOk('OPTIONS', 'script'),
    '--allow-host covers static GET and HEAD only: a POST, a PUT, a fetch or XHR to an allow-listed host, and any request to a host that is not allow-listed, are stopped');
  // coupons: only an explicit "code X" on the store's own page, 4 to 20 characters, a letter and a digit or all uppercase, at most 3
  const ec = (t) => lib.extractStoreCodes(t);
  ok(JSON.stringify(ec('Use code SAVE10 at the cart')) === '["SAVE10"]' && JSON.stringify(ec('Promo code: WELCOME')) === '["WELCOME"]' && JSON.stringify(ec('discount code "gift25"')) === '["gift25"]'
    && !ec('SAVE10 today only').length && !ec('code abc').length && !ec('code welcome').length && !ec('code ABC').length && !ec(`code ${'A1'.repeat(11)}`).length && !ec('code me1@example.com').length && !ec('code AB12345678').length
    && !ec('zip code 10001').length && !ec('postal code SW1A 1AA').length && !ec('tracking code AB12CD').length
    && ec('code AAA1, code BBB2, code CCC3, code DDD4').length === 3, 'store codes: only "code X" counts; 4 to 20 characters with a letter and a digit or all uppercase; no @, no run of 7 digits, no postal or tracking codes; at most 3',
    JSON.stringify([ec('postal code SW1A 1AA'), ec('code AAA1, code BBB2, code CCC3, code DDD4')]));
  // typing: every value that reaches the one typing primitive is a fixed test value or a store code
  const filled = []; const loc = { fill: async (v) => { filled.push(v); } };
  const tf = async (v, o) => lib.typeFixed(loc, v, o).then(() => 'typed', (e) => e.message);
  const tr = [await tf('TEST'), await tf('ABC'), await tf('10001'), await tf('M5V 2T6'), await tf('SAVE10', { codes: ['SAVE10'] }), await tf('SAVE10'), await tf('me@example.com'), await tf('Gwen'), await tf('4111 1111 1111 1111'), await tf('test')];
  ok(JSON.stringify(filled) === '["TEST","ABC","10001","M5V 2T6","SAVE10"]' && tr.slice(5).every((r) => /refused/.test(r)) && lib.fixedTextFor(3) === 'ABC' && lib.fixedTextFor(2) === 'ABC' && lib.fixedTextFor(4) === 'TEST' && lib.fixedTextFor(undefined) === 'TEST' && lib.fixedTextFor(0) === 'TEST'
    && lib.zipFor('gb') === 'SW1A 1AA' && lib.zipFor('AU') === '2000' && lib.zipFor('CA') === 'M5V 2T6' && lib.zipFor('DE') === '10001',
    'typing: only TEST, ABC (a box of 3 or fewer), the fixed postcodes and the journey\'s own store codes ever reach fill(); anything else is refused before it is typed', JSON.stringify({ filled, tr }));
  // the free-shipping bar and the persona's shipping limit
  const fs1 = lib.freeShippingCheck(['Free shipping on orders over $50', 'You are $26.00 away from free shipping'], 24);
  const fs2 = lib.freeShippingCheck(['Free shipping on orders over $50', 'You are $20.00 away from free shipping'], 24);
  const fs3 = lib.freeShippingCheck(['Free shipping on orders over $50', "You've unlocked free shipping"], 24);
  ok(fs1?.status === 'ok' && fs2?.status === 'mismatch' && /26/.test(fs2.why) && fs3?.status === 'mismatch' && lib.freeShippingCheck(['Shipping calculated at checkout'], 24) === null && lib.freeShippingCheck(['Free shipping on orders over $50'], null)?.status === 'unreadable',
    'free-shipping bar: the amount left is checked against threshold minus subtotal; a wrong amount or an early "unlocked" is a mismatch; no bar is null', JSON.stringify([fs1, fs2, fs3]));
  ok(lib.shippingQuitOver({ shipping_quit_over: 1 }, 100) === 1 && lib.shippingQuitOver({ shipping_quit_over: 0 }, 100) === 0 && lib.shippingQuitOver({}, 100) === 20 && lib.shippingQuitOver({ shipping_quit_over: null }, 24.5) === 4.9 && lib.shippingQuitOver({}, null) === null,
    'shipping limit: shipping_quit_over when set, otherwise 20 percent of the subtotal');
  const sp = { ...base, id: 'sq', name: 'sq', device: 'iphone-14', entry_point: { channel: 'direct', landing_path: '/' }, before_buying: [], main_quit_reason: 'x' };
  ok(!checkPersona({ ...sp, shipping_quit_over: 7.5 }).some((e) => /shipping_quit_over/.test(e)) && !checkPersona({ ...sp, shipping_quit_over: null }).some((e) => /shipping_quit_over/.test(e)) && checkPersona({ ...sp, shipping_quit_over: -1 }).some((e) => /shipping_quit_over/.test(e)) && checkPersona({ ...sp, shipping_quit_over: '5' }).some((e) => /shipping_quit_over/.test(e)),
    'persona check: shipping_quit_over is a money amount of 0 or more, or null');
  // one interaction policy for every activating call: own text, label, ancestors, link and form targets
  const ir = lib.interactionRefusal;
  ok(ir({ own: 'Checkout' }) && ir({ own: 'Buy it now' }) && ir({ label: 'Pay with PayPal' }) && ir({ own: 'Sign in' }) && ir({ own: 'Place order' }) && ir({ own: 'Add', ancestors: 'form.checkout' }) && ir({ own: 'Go', href: 'https://shop.example/checkouts/c/1' })
    && ir({ own: 'Add to cart', action: 'https://shop.example/cart.php?action=buy', formMethod: 'post' }) && ir({ own: 'Add to cart', action: 'https://shop.example/index.php?controller=order', formMethod: 'post' }) && ir(null)
    && !ir({ own: 'Add to cart', action: 'https://shop.example/cart/add', formMethod: 'post' }) && !ir({ own: 'Size: Large' }) && !ir({ own: 'Apply', label: 'Discount code' }),
    'interaction policy: the element\'s own text, its label, a checkout or payment block around it, and where its link or form goes are all checked; Add to cart, an option and Apply pass', JSON.stringify([ir({ own: 'Add', ancestors: 'form.checkout' }), ir({ own: 'Apply', label: 'Discount code' })]));
  const rsrc = fs.readFileSync(path.join(root, 'scripts/shopper-panel.mjs'), 'utf8').replace(/\/\/[^\n]*/g, '');
  const rl = rsrc.split('\n'); const unguarded = rl.map((l, i) => [l, i]).filter(([l]) => /\.(selectOption|check|click)\(/.test(l) && !/trial: true/.test(l)).filter(([l, i]) => !rl.slice(Math.max(0, i - 16), i + 1).join('\n').includes('policy(')).map(([l]) => l.trim().slice(0, 80));
  // a forced interaction is any force: true outside a file call (fs.rmSync's own force option removes a folder, it touches no page)
  ok(!rl.some((l) => /force: true/.test(l) && !/\bfs\.(rmSync|rm|cpSync)\(/.test(l)) && /class Refused/.test(rsrc) && !unguarded.length, 'interaction policy: every click, selectOption and check passes the policy first, nothing is forced, and a refusal ends the journey', JSON.stringify(unguarded));
  // R25 C#1: the lib only finds things; it never clicks, submits, dispatches an event or opens a section itself (every activation is the
  // runner's guarded tap). Code only: comments are taken out first.
  const lsrc = fs.readFileSync(path.join(root, 'scripts/panel-lib.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  const libActs = ['.click(', 'dispatchEvent(', 'requestSubmit(', '.submit(', '.open = true', ".setAttribute('open'", '.toggleAttribute(', '.showModal(', '.showPopover('].filter((k) => lsrc.includes(k));
  ok(!libActs.length && typeof lib.markClosedProductDetails === 'function' && typeof lib.openProductDetails === 'undefined', 'interaction audit (panel-lib): the lib has no click, submit, dispatchEvent or open call of its own; closed product sections are only found (marked) there and opened by the runner\'s guarded tap', JSON.stringify(libActs));
  // the docs state the limits that come with one engine and a closed network
  const all = ['README.md', 'SECURITY.md', 'AGENTS.md', 'SKILL.md', 'docs/safety-details.md'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  // R25 C#10: no doc says the panel runs Safari or WebKit (the iPhone is Chromium at iPhone size)
  const allDocs = ['README.md', 'SECURITY.md', 'AGENTS.md', 'SKILL.md', 'CHANGELOG.md', 'templates/persona-card.md', ...fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)].map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]);
  const safariClaims = allDocs.flatMap(([f, t]) => t.split('\n').filter((l) => /\b(Safari|WebKit) engine\b|\bruns? (on|in) (the )?(Safari|WebKit)\b|\bwebkit\b/i.test(l)).map((l) => `${f}: ${l.slice(0, 80)}`));
  ok(!safariClaims.length && /iphone-14` is an iPhone 14 screen, touch and user agent on Chromium/.test(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')), 'docs: no doc says the panel runs on Safari or WebKit; SKILL.md says the iPhone is Chromium at iPhone size', JSON.stringify(safariClaims));
  // R25 A: the docs say v1 is Shopify Online Store themes only, and claim no other platform
  const pkgKw = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).keywords || [];
  const otherClaims = allDocs.flatMap(([f, t]) => t.split('\n').filter((l) => /works on [^\n]*(woocommerce|bigcommerce|magento|prestashop)|tested against both|other platforms: not tested|i0\.wp\.com/i.test(l)).map((l) => `${f}: ${l.slice(0, 80)}`));
  ok(!otherClaims.length && !pkgKw.includes('woocommerce') && /Shopify Online Store themes only/.test(allDocs.find(([f]) => f === 'SKILL.md')[1]) && /Shopify Online Store themes only/.test(allDocs.find(([f]) => f === 'docs/safety-details.md')[1]) && /Shopify Online Store themes only/.test(allDocs.find(([f]) => f === 'CHANGELOG.md')[1]), 'docs: v1 is stated as Shopify Online Store themes only (README, SKILL.md, safety details, changelog); no doc or keyword claims WooCommerce or another platform', JSON.stringify(otherClaims));
  ok(/Safari-only bugs are not caught/.test(all) && /express buttons and pay-in-4 messages may not render/.test(all) && !/install[^\n]*webkit/i.test(all) && !/webkit/i.test(fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8')), 'docs and CI: Chromium only; Safari-only bugs and missing express buttons are stated as limits');
}
// ---------- R24: the browser-level guard on its own (no request guard): redirects into checkout never reach the store ----------
{
  const s = await startFixtureServer({ extraRoutes: {
    '/r24/r1': (q, res) => { res.writeHead(302, { location: '/r24/r2' }); res.end(); },
    '/r24/r2': (q, res) => { res.writeHead(307, { location: '/checkouts/cn/abc' }); res.end(); },
    '/r24/p1': (q, res) => { res.writeHead(302, { location: '/index.php?controller=order' }); res.end(); },
  } });
  const browser = await chromium.launch({ args: lib.chromiumArgs({ loopback: true }) });
  const drops = [];
  const ng = await lib.installBrowserNetGuard(browser, () => ({ blockRules: [], allowHosts: [], ownHosts: new Set(['127.0.0.1']), noCart: false }), (d) => drops.push(d));
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`${s.origin}/r24/r1`).catch(() => {});
  // the stopped load leaves an error page with no origin; the two calls below are made from an ordinary store page
  await page.goto(`${s.origin}/`).catch(() => {});
  await page.evaluate(() => fetch('/r24/p1', { method: 'POST', body: 'x=1' }).catch(() => {})).catch(() => {});
  await page.evaluate(() => fetch('/wp-admin/admin-ajax.php?action=woocommerce_checkout', { method: 'POST', body: 'a=1' }).catch(() => {})).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  const seen = s.requests.map((q) => `${q.method} ${q.url}`);
  ok(!!ng && seen.some((x) => x.startsWith('GET /r24/r2')) && !seen.some((x) => /\/checkouts|controller=order|woocommerce_checkout/.test(x)) && drops.some((d) => d.kind === 'hard') && drops.some((d) => /admin-ajax/.test(d.url)),
    'browser-level guard only (CDP Fetch, no ctx.route): a two-hop redirect into /checkouts, a redirect to controller=order and an admin-ajax checkout call never reach the store', JSON.stringify({ seen, drops: drops.map((d) => [d.kind, d.url]) }));
  await ctx.close(); await browser.close(); await s.close();
}
// ---------- R24: a checkout reveal with no network (hash route, pushState, about:blank pop-up) ends before any click ----------
{
  const variants = {
    hash: `<script>setTimeout(()=>{location.hash='#/checkout'},50)</script>`,
    push: `<script>setTimeout(()=>{history.pushState({},'','/checkouts/local-only')},50)</script>`,
    popup: `<script>setTimeout(()=>{try{const w=window.open('about:blank');w.document.write('<title>Checkout</title><h1>Checkout</h1>')}catch(e){}},50)</script>`,
  };
  // the library check, one variant at a time, in a plain browser
  const s = await startFixtureServer({ extraRoutes: Object.fromEntries(Object.entries(variants).map(([k, v]) => [`/r24/${k}`, (q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><title>Gift set</title><h1>Gift set</h1>${v}`); }])) });
  const browser = await chromium.launch({ args: lib.chromiumArgs({ loopback: true }) });
  const got = {};
  for (const k of Object.keys(variants)) {
    const ctx = await browser.newContext(); const shown = []; const loaded = [];
    lib.watchContext(ctx, (h) => loaded.push(h), () => {}, (h) => shown.push(h));
    const page = await ctx.newPage(); await page.goto(`${s.origin}/r24/${k}`); await sleep(600);
    got[k] = { scan: await lib.checkoutShownInContext(ctx), shown, loaded };
    await ctx.close();
  }
  await browser.close();
  const before = s.requests.length;
  ok(Object.values(got).every((g) => g.scan && !g.loaded.length) && /hash route/.test(got.hash.scan) && /checkouts\/local-only/.test(got.push.scan) && got.push.shown.length === 1 && /about:blank|another tab/.test(got.popup.scan)
    && !s.requests.some((q) => /checkouts/.test(q.url)), 'a checkout shown with no request (hash route, pushState, about:blank pop-up) is seen, and is never counted as a checkout page loaded', JSON.stringify({ got, n: before }));
  await s.close();
  // end to end: the journey ends before the panel's first click
  const all = `${variants.hash}${variants.push}${variants.popup}<script>document.addEventListener('click',()=>{fetch('/r24-clicked').catch(()=>{})},true)</script>`;
  const run = await r22run('reveal', {}, [], null, '/products/gift-set', { extraHtml: { '/products/gift-set': all } });
  const clicked = run.s.requests.filter((q) => /r24-clicked|\/checkouts|\/cart\/add/.test(q.url));
  ok(run.js.length === 2 && !clicked.length && run.js.every((j) => j.quit_kind === 'test_limit' && /showing a checkout by itself/.test(j.quit_reason || '') && !j.checkout_page_loaded && !j.taps) && run.r.code === 1,
    'runner: a page that shows a checkout by itself ends the journey as a tool limit before the panel taps anything', JSON.stringify({ clicked: clicked.map((q) => q.url), js: run.js.map((j) => [j.device, j.quit_kind, j.taps, j.checkout_page_loaded, (j.quit_reason || '').slice(0, 200)]) }));
}
// ---------- R24: a socket opened before the shopper tapped can never send afterwards ----------
{
  const pre = `<script>window.__sockErr='';try{const ws=new WebSocket('ws://'+location.host+'/r24sock');ws.onerror=()=>{window.__sockErr='error'};ws.onclose=()=>{window.__sockErr+='closed'};document.addEventListener('click',()=>{try{ws.send('after-tap')}catch(e){window.__sockErr+='threw'}},true);setInterval(()=>{try{ws.send('tick')}catch(e){}},200);}catch(e){window.__sockErr='ctor:'+e.name}</script>`;
  const { js, s } = await r22run('presock', {}, [], null, '/products/gift-set', { extraHtml: { '/products/gift-set': pre } });
  const up = s.requests.filter((q) => /r24sock/.test(q.url) || /websocket/i.test(q.headers?.upgrade || ''));
  ok(js.length === 2 && !up.length && js.every((j) => (j.guard_interventions || []).some((i) => /WebSocket/.test(i)) && j.cart_touched),
    'a WebSocket a page opens before the shopper taps never connects, so nothing it tries to send after Add to cart reaches the store', JSON.stringify({ up: up.map((q) => q.url), gi: js.map((j) => j.guard_interventions) }));
}
// ---------- R24: in a real run, page writes to shared endpoints are stopped and named; a GraphQL read still works ----------
{
  const sends = `<script>fetch('/api/orders',{method:'POST',body:'{"line":1}'}).catch(()=>{});fetch('/wp-admin/admin-ajax.php',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'action=my_custom_action'}).catch(()=>{});fetch('/api/p',{method:'PUT',body:'1'}).catch(()=>{});</script>`;
  const w = await r22run('dispatch', {}, [], null, '/products/gift-set', { extraHtml: { '/products/gift-set': sends } });
  const wrote = w.s.requests.filter((q) => /^\/api\/(orders|p)\b|admin-ajax/.test(q.url));
  ok(w.js.length === 2 && !wrote.length && w.js.every((j) => (j.guard_interventions || []).some((i) => /only known cart operations are sent to a shared endpoint/.test(i))),
    'runner: a page POST to /api/orders, a PUT and an unknown admin-ajax action never reach the store, and each is named in the report', JSON.stringify({ wrote: wrote.map((q) => q.method + ' ' + q.url), gi: w.js.map((j) => j.guard_interventions) }));
  const gqlPage = (q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html><head><title>Northwick gift set</title></head><body><main id="m">Loading</main><script>fetch('/api/2024-07/graphql.json',{method:'POST',headers:{'content-type':'application/json'},body:'{"query":"{product{title}}"}'}).then(r=>r.json()).then(d=>{document.getElementById('m').innerHTML='<h1>'+d.t+'</h1><p>$24.00</p>'}).catch(()=>{});fetch('/api/2024-07/graphql.json',{method:'POST',headers:{'content-type':'application/json'},body:'{"query":"mutation{customerCreate(input:{}){customer{id}}}"}'}).catch(()=>{})</script></body></html>`); };
  const gqlApi = (q, res) => { let b = ''; q.on('data', (d) => { b += d; }); q.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ t: 'Northwick gift set', got: b.length })); }); };
  const gq = await r22run('gql', {}, [], null, '/products/gql-only', { extraRoutes: { '/products/gql-only': gqlPage, '/api/2024-07/graphql.json': gqlApi } });
  const gposts = gq.s.requests.filter((q) => /graphql\.json/.test(q.url));
  // R25 B: GraphQL is never written to, a read included (the write allow-list has only the Shopify cart operations); the page then
  // cannot show its product, and that is a tool limit, never a store finding
  ok(gq.js.length === 2 && gposts.length === 0 && gq.js.every((j) => j.quit_kind === 'test_limit' && (j.guard_interventions || []).some((i) => /graphql/i.test(i))),
    'runner: no GraphQL request reaches the store, a read included; the page that needed it is a tool limit', JSON.stringify({ n: gposts.length, js: gq.js.map((j) => [j.quit_kind, j.quit_reason, j.guard_interventions]) }));
}
// ---------- R25: Shopify Online Store only, the write allow-list and Codex round 6, end to end ----------
const r25run = async (tag, flags = {}, { landing = '/products/gift-set', extra = {}, args = [], env = {}, mutate = null } = {}) => {
  const s = await startFixtureServer(extra);
  Object.assign(s.flags, flags);
  const pd = r20Personas(`r25${tag}`, 'northwick-gift-giver-gwen.json', (p) => ({ ...p, entry_point: { ...p.entry_point, landing_path: landing }, product_pick: null, ...(mutate ? mutate(p) : {}) }));
  const out = `reports-r25${tag}`;
  const r = await runPanel(['--url', `${s.origin}${landing}`, '--i-own', '127.0.0.1', '--personas', pd, '--out', out, '--pause', '0', ...args], env);
  const x = latestRun(out); await s.close();
  // result.json keeps the findings in one top-level list; each journey gets its own back here
  return { r, x, js: x.res.journeys.map((j) => ({ ...j, findings: (x.res.findings || []).filter((f) => f.persona === j.persona) })), s };
};
{
  // A: another platform or a headless storefront is refused before the browser starts (exit 2, nothing run, only the one home-page read)
  for (const home of ['woo', 'hydrogen']) {
    const { r, js, s } = await r25run(`ref-${home}`, { home });
    const asked = s.requests.map((q) => q.url);
    ok(r.code === 2 && r.err.includes(lib.SHOPIFY_ONLY_MESSAGE) && (home === 'hydrogen' ? /Hydrogen/.test(r.err) : /WooCommerce/.test(r.err)) && !js.length && asked.length === 1 && asked[0] === '/',
      `platform check: a ${home === 'woo' ? 'WooCommerce' : 'Hydrogen (headless)'} store is refused with exit 2 before any journey, after one read of "/"`, JSON.stringify({ code: r.code, err: r.err.slice(0, 200), asked }));
  }
  // R26 #3: a theme only in a comment or a string, a theme next to WooCommerce markup, a theme whose /cart.js is not a Shopify cart,
  // and a theme assignment that never runs (inside if (false)) are all refused with exit 2 before any journey
  for (const [home, rx] of [['comment', /not an Online Store theme|not a Shopify Online Store/], ['conflict', /also .*markup|WooCommerce/], ['nocartjs', /cart\.js/], ['deadscript', /running it leaves no window\.Shopify\.theme/]]) {
    const { r, js, s } = await r25run(`ref26-${home}`, { home });
    ok(r.code === 2 && r.err.includes(lib.SHOPIFY_ONLY_MESSAGE) && rx.test(r.err) && !js.length && !s.requests.some((q) => /^\/products|add-to-cart|^\/cart\/add/.test(q.url)),
      `platform check: a ${home} home page is refused with exit 2 before any journey`, JSON.stringify({ code: r.code, err: r.err.slice(0, 300), asked: s.requests.map((q) => q.url) }));
  }
  // R27 #1: a running theme next to a BigCommerce or WordPress SCRIPT address (no other markup) is refused with exit 2 before any journey
  for (const [home, rx] of [['stencil', /also BigCommerce markup/], ['wpembed', /also WooCommerce or WordPress markup/]]) {
    const { r, js, s } = await r25run(`ref27-${home}`, { home });
    ok(r.code === 2 && r.err.includes(lib.SHOPIFY_ONLY_MESSAGE) && rx.test(r.err) && !js.length && !s.requests.some((q) => /^\/products|add-to-cart|^\/cart\/add/.test(q.url)),
      `R27 #1 platform check: a Shopify theme next to a ${home === 'stencil' ? 'BigCommerce stencil-utils.js' : 'WordPress wp-embed.min.js'} script is refused with exit 2 before any journey`, JSON.stringify({ code: r.code, err: r.err.slice(0, 300), asked: s.requests.map((q) => q.url) }));
  }
  // R27 #2: the home page cannot be read, and the first page shows a Shopify theme AND another platform (a WordPress script address, or
  // body.woocommerce set by a script): the fallback gate runs the same conflict test on the loaded page, and the run stops with exit 2
  for (const [tag, extraHtml] of [['src', '<script src="/wp-includes/js/wp-embed.min.js"></script>'], ['body', '<script>document.body.classList.add("woocommerce")</script>']]) {
    const fb = await r25run(`ref27-fb-${tag}`, { home: 'down' }, { extra: { extraHtml: { '/products/gift-set': extraHtml } } });
    ok(fb.r.code === 2 && fb.r.err.includes(lib.SHOPIFY_ONLY_MESSAGE) && /also WooCommerce or WordPress markup/.test(fb.r.err) && fb.js.length <= 1 && !fb.s.requests.some((q) => /\/cart|add-to-cart/.test(q.url)),
      `R27 #2 platform check: when the home page cannot be read, a first page with a Shopify theme and ${tag === 'src' ? 'a WordPress script address' : 'body.woocommerce'} stops the run with exit 2 before anything is tapped`, JSON.stringify({ code: fb.r.code, err: fb.r.err.slice(0, 300), js: fb.js.map((j) => [j.quit_kind, j.quit_reason]) }));
  }
  // A: the home page cannot be read, and the first page has no Shopify theme: the run stops there with exit 2
  const dn = await r25run('ref-down', { home: 'down' }, { landing: '/product/amber-soy-candle' });
  ok(dn.r.code === 2 && dn.r.err.includes(lib.SHOPIFY_ONLY_MESSAGE) && /no Shopify Online Store theme/.test(dn.r.err) && dn.js.length <= 1 && !dn.s.requests.some((q) => /\/cart|add-to-cart/.test(q.url)),
    'platform check: when the home page cannot be read, a first page with no Shopify.theme stops the run with exit 2 before anything is tapped', JSON.stringify({ code: dn.r.code, err: dn.r.err.slice(0, 200), n: dn.js.length }));
  // control: the home page cannot be read, but the first page is a Shopify Online Store theme: the run goes on
  const up = await r25run('ok-down', { home: 'down' });
  ok(up.r.code === 0 && up.js.length === 2 && up.js.every((j) => j.completed) && /could not be read before the run/.test(up.r.out), 'platform check: an unreadable home page with a Shopify theme on the first page runs normally', JSON.stringify({ code: up.r.code, err: up.r.err.slice(0, 200), js: up.js.map((j) => [j.quit_kind, j.quit_reason]) }));
}
{
  // C#1: a closed product section is opened by the runner's guarded tap after the interaction policy; one the policy refuses stays closed
  const acc = `<script>document.querySelector('product-info').insertAdjacentHTML('beforeend','<details id="acc-ship"><summary>Care and burn time</summary><div>Burns for 50 hours.</div></details><details id="acc-pay"><summary>Checkout with Shop Pay</summary><div>Pay in 4.</div></details>');document.addEventListener('toggle',(e)=>{if(e.target.open)fetch('/r25acc/'+e.target.id+'?t='+(window.__lastTrusted?1:0)).catch(()=>{})},true);document.addEventListener('click',(e)=>{window.__lastTrusted=e.isTrusted},true);</script>`;
  const a = await r25run('acc', {}, { extra: { extraHtml: { '/products/gift-set': acc } } });
  const opened = a.s.requests.filter((q) => /^\/r25acc\//.test(q.url)).map((q) => q.url);
  ok(a.js.length === 2 && opened.filter((u) => u.startsWith('/r25acc/acc-ship?t=1')).length === 2 && !opened.some((u) => /acc-pay/.test(u)) && a.js.every((j) => j.findings.some((f) => /left 1 closed product section\(s\) unopened because the interaction policy would refuse them \(.*Shop Pay/.test(f.what))),
    'closed product sections: each is opened by a real (trusted) tap through the policy; one the policy refuses (Checkout with Shop Pay) stays closed and is named', JSON.stringify({ opened, f: a.js.map((j) => j.findings.map((f) => f.what).filter((x) => /closed/.test(x))) }));
  // C#6: a tap that reveals a checkout (a section whose opening pushes a checkout address) is a safety stop, never a success
  const rev = `<script>document.querySelector('product-info').insertAdjacentHTML('beforeend','<details id="acc-rev"><summary>Gift wrap options</summary><div>Wrapped by hand.</div></details>');document.getElementById('acc-rev').addEventListener('toggle',(e)=>{if(e.target.open)history.pushState({},'','/checkouts/cn/r25-revealed')});</script>`;
  const v = await r25run('reveal', {}, { extra: { extraHtml: { '/products/gift-set': rev } } });
  ok(v.js.length === 2 && v.js.every((j) => !j.completed && j.quit_kind === 'test_limit' && /safety stop: after a closed product section/.test(j.quit_reason || '') && j.checkout_revealed && j.findings.some((f) => f.severity === 'block' && /^SAFETY: a checkout was showing/.test(f.what))) && !v.s.requests.some((q) => /r25-revealed/.test(q.url)) && v.r.code === 1,
    'a checkout revealed right after one of the panel\'s own taps is a safety stop (tool limit plus a SAFETY finding), never a success', JSON.stringify(v.js.map((j) => [j.completed, j.quit_kind, j.quit_reason])));
}
{
  // C#9: a Checkout button disabled only by a disabled fieldset around it is read as disabled (Playwright isEnabled)
  const f = await r25run('fieldset', { shopCart: true, checkoutFieldset: true });
  ok(f.js.length === 2 && f.js.every((j) => !j.completed && !j.reached_checkout && /disabled|not enabled|cannot be tapped/i.test(`${j.quit_reason} ${JSON.stringify(j.checkout_button || {})}`)) && !f.s.requests.some((q) => /\/checkout/.test(q.url)),
    'a Checkout button inside a disabled fieldset is read as disabled (never counted as reachable)', JSON.stringify(f.js.map((j) => [j.completed, j.quit_kind, j.quit_reason, j.checkout_button])));
  // R26 #5: a selector match is only a candidate; a PayPal express link (another host, inside the additional-checkout block) or a
  // <div id="checkout"> that is not a control is never counted as the cart's Checkout button (a tool limit, nothing tapped)
  for (const kind of ['express', 'div']) {
    const e = await r25run(`co-${kind}`, { shopCart: true, checkoutKind: kind });
    ok(e.r.code === 1 && e.js.length === 2 && e.js.every((j) => !j.completed && !j.reached_checkout && !j.checkout_button && j.quit_kind === 'test_limit'
      && /not a Checkout button the panel can vouch for/.test(j.quit_reason || '') && (j.checkout_candidates_rejected || []).length >= 1)
      && !e.s.requests.some((q) => /\/checkout/.test(q.url)),
    `a cart whose only checkout element is ${kind === 'express' ? 'a PayPal express link' : 'a <div id="checkout">'} never counts as reaching checkout (tool limit, nothing tapped)`,
    JSON.stringify(e.js.map((j) => [j.completed, j.quit_kind, j.quit_reason, j.checkout_candidates_rejected])));
  }
  // R26 #7: the discount box posts to a discount app outside the write allow-list, so the panel's guard stops it: the code check is
  // "not tested" and the journey a tool limit (run INCOMPLETE), never a "did not lower the total" warning about the store
  const ca = await r25run('coupon-app', { shopCart: true, couponApp: true });
  ok(ca.r.code === 1 && ca.js.length === 2 && ca.js.every((j) => j.quit_kind === 'test_limit' && /could not be tested: the panel's own guard stopped/.test(j.quit_reason || '') && j.cart_checks?.discount?.tested === false
      && !j.reached_checkout && !j.findings.some((f) => /did not lower the total/.test(f.what)))
      && !ca.s.requests.some((q) => /^\/apps\//.test(q.url)),
    'a discount write the guard stopped makes the code check "not tested" and the journey a tool limit, never a store warning', JSON.stringify(ca.js.map((j) => [j.quit_kind, j.quit_reason, j.cart_checks?.discount, j.findings.map((f) => f.what)])));
  // R27 #5: a disabled Checkout button followed by an enabled one: the enabled one is found (each candidate is judged whole)
  const df = await r25run('co27-disabledfirst', { shopCart: true, checkoutKind: 'disabledfirst' });
  ok(df.r.code === 0 && df.js.length === 2 && df.js.every((j) => j.completed && j.reached_checkout && j.checkout_button?.enabled === true) && !df.s.requests.some((q) => /\/checkout/.test(q.url)),
    'R27 #5 a disabled Checkout button first and an enabled one second: the enabled one is found (not "disabled, a shopper cannot go on"); nothing tapped', JSON.stringify(df.js.map((j) => [j.completed, j.quit_kind, j.quit_reason])));
  // R27 #3: a name="checkout" submit that posts to /account/login is never the cart's Checkout button (a tool limit, nothing tapped)
  const lf = await r25run('co27-loginform', { shopCart: true, checkoutKind: 'loginform' });
  ok(lf.r.code === 1 && lf.js.length === 2 && lf.js.every((j) => !j.completed && !j.reached_checkout && !j.checkout_button && j.quit_kind === 'test_limit' && /login or account address/.test(j.quit_reason || ''))
      && !lf.s.requests.some((q) => /\/checkout|\/account/.test(q.url)),
    'R27 #3 a name="checkout" submit whose form action is /account/login never counts as reaching checkout (tool limit, nothing tapped)', JSON.stringify(lf.js.map((j) => [j.completed, j.quit_kind, j.quit_reason])));
  // R27 #4: a translated Checkout submit ("Proc\u00e9der au paiement") on the cart form is the cart's Checkout button
  const fr = await r25run('co27-fr', { shopCart: true, checkoutKind: 'fr' });
  ok(fr.r.code === 0 && fr.js.length === 2 && fr.js.every((j) => j.completed && j.reached_checkout && /paiement/.test(j.checkout_button?.label || '')),
    'R27 #4 a translated Checkout submit (Proc\u00e9der au paiement) on the cart form is found as the Checkout button', JSON.stringify(fr.js.map((j) => [j.completed, j.quit_kind, j.quit_reason, j.checkout_button])));
  // R27 #7: the discount Apply or the shipping estimator's POST sent as a keepalive fetch is dropped by the page shim: the check is
  // "not tested" and the journey a tool limit, never a "did not lower the total" warning or an "estimate could not be read" note
  const kc = await r25run('ka27-coupon', { shopCart: true, cartKeepalive: 'coupon' });
  ok(kc.r.code === 1 && kc.js.length === 2 && kc.js.every((j) => j.quit_kind === 'test_limit' && /could not be tested: the panel's own guard stopped/.test(j.quit_reason || '') && /POST \/cart\/update\.js dropped/.test(j.quit_reason || '')
      && j.cart_checks?.discount?.tested === false && !j.reached_checkout && !j.findings.some((f) => /did not lower the total/.test(f.what)))
      && !kc.s.requests.some((q) => q.url === '/cart/update.js'),
    'R27 #7 a keepalive discount write the page shim dropped makes the code check "not tested" (method and address named) and the journey a tool limit, never a store warning', JSON.stringify(kc.js.map((j) => [j.quit_kind, j.quit_reason, j.cart_checks?.discount, j.findings.map((f) => f.what)])));
  const ks = await r25run('ka27-ship', { shopCart: true, cartKeepalive: 'ship' });
  ok(ks.r.code === 1 && ks.js.length === 2 && ks.js.every((j) => j.quit_kind === 'test_limit' && /shipping estimate could not be tested: the panel's own guard stopped/.test(j.quit_reason || '') && j.cart_checks?.shipping?.tested === false
      && !j.reached_checkout && !j.findings.some((f) => /shipping estimate for postcode .* could not be read/.test(f.what)))
      && !ks.s.requests.some((q) => q.url === '/cart/prepare_shipping_rates.json'),
    'R27 #7 a keepalive shipping-estimator POST the page shim dropped makes the estimate "not tested" and the journey a tool limit, never an "unreadable estimate" note', JSON.stringify(ks.js.map((j) => [j.quit_kind, j.quit_reason, j.cart_checks?.shipping, j.findings.map((f) => f.what)])));
  // C#8: no readable rates answer: the estimate is unreadable (a note), never a price read from promotion text
  const n = await r25run('norates', { shopCart: true, shipRates: 'none' });
  ok(n.js.length === 2 && n.js.every((j) => j.cart_checks?.shipping && j.cart_checks.shipping.cheapest === null && j.findings.some((x) => /shipping estimate for postcode \d+ \(\w+\) could not be read/.test(x.what)) && j.completed),
    'shipping estimator: with no readable rates answer the cheapest is unknown and noted as unreadable; free-shipping promotion text is never read as a rate', JSON.stringify(n.js.map((j) => [j.cart_checks?.shipping, j.quit_reason])));
}
{
  // a run whose only problems are test problems (a bot check) says 0 blocking findings
  const bot = (q, res) => { res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html><head><title>Just a moment...</title></head><body>Verifying your connection</body></html>'); };
  const b = await r25run('bot', {}, { landing: '/products/bot-check', extra: { extraRoutes: { '/products/bot-check': bot } } });
  ok(b.r.code === 1 && b.js.length >= 1 && b.js.every((j) => j.quit_kind === 'rate_limited') && /\b0 blocking and/.test(b.x.res.summary || '') && !b.x.res.findings.some((x) => x.severity === 'block'),
    'a run whose only problems are bot checks says "0 blocking" findings (test problems are never counted as blocking)', b.x.res.summary);
}
await server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} of ${pass + fail} assertions passed.`);
process.exit(fail ? 1 : 0);
