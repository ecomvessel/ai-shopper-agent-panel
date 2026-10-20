// Offline fixture store ("Northwick Candle Co.", made up) for the test and the demo. Listens on loopback only (127.0.0.1 and ::1).
//   node scripts/fixture-server.mjs            start it and print the address (Ctrl+C to stop)
// Pages: /collections/gifts, /collections/new-arrivals, /products/<handle> (Shopify Online Store theme; /products/dawn-tote uses Dawn's
// sticky info column; flags.shopCart turns on the Shopify cart page with a coupon box, a shipping estimator and a free-shipping bar).
// The /product/... pages, /warenkorb/, /kasse/ and the /wp-json/ Store API are other-platform pages kept only to test the safety
// layers that stay as defence in depth (v1 refuses to run on another platform).
// /meta.json names the store's (made-up) myshopify address. "/" is a Shopify Online Store home page (see flags.home).
// "localhost" on the same port plays the part of a third-party host (a tracking pixel and a delivery-date widget).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const STORE_DIR = path.join(here, '..', 'examples', 'fixture-store');

const PRODUCTS = {
  101: { title: 'Linen and Cedar Candle', variant: '8 oz', cents: 2800, kind: 'shopify' },
  102: { title: 'Linen and Cedar Candle', variant: '12 oz', cents: 3600, kind: 'shopify' },
  201: { title: 'Gift Set of Three', variant: '', cents: 3800, kind: 'shopify' },
  301: { title: 'Vanilla Hearth Candle', variant: '', cents: 2400, kind: 'shopify' },
  401: { title: 'Autumn Ember Candle', variant: '', cents: 3200, kind: 'shopify' },
  501: { title: 'Canvas Candle Tote', variant: '', cents: 4200, kind: 'shopify' },
  55: { title: 'Amber Soy Candle', variant: '', cents: 2400, kind: 'woo' },
  56: { title: 'Beeswax Taper Pair', variant: '', cents: 1800, kind: 'woo' },
};
const HANDLES = { 'linen-and-cedar-candle': [101, 102], 'gift-set': [201], 'autumn-ember-candle': [401], 'dawn-tote': [501] };
export const FIXTURE_MYSHOPIFY = 'northwick-candles.myshopify.com';
const NONCE = 'fx-store-api-nonce';
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };

export async function startFixtureServer({ extraHtml = {}, extraRoutes = {} } = {}) {
  const hits = {}; const requests = [];
  // switches a test can flip: wpJson off = a WordPress site without pretty links; restRoute off too = no readable Store API at all
  const flags = { wpJson: true, restRoute: true, meta: true, homeShop: false };
  // the WooCommerce classic cart (/cart/): a code banner, a coupon box (couponWorks off = the code does nothing), a free-shipping bar
  // (freeShipBar 'ok', 'wrong' or null) and a shipping estimator (shipCents per order, null = no estimator)
  Object.assign(flags, { codeBanner: true, couponWorks: true, freeShipBar: 'ok', shipCents: 395 });
  // the Shopify cart (/cart): shopCart on = the same code banner, discount box, free-shipping bar and shipping estimator there;
  // shipRates 'json' = the estimator's rates answer is readable, anything else = no readable answer; checkoutFieldset = the Checkout
  // button sits in a disabled fieldset (disabled by inheritance only)
  // R26: checkoutKind 'express' = the cart's only checkout control is a PayPal express link in the additional-checkout block; 'div' =
  // a <div id="checkout"> that looks like a button but is not a control
  // couponApp = the discount box's Apply posts to a discount app (/apps/discount/apply), outside the write allow-list
  // R27: checkoutKind 'disabledfirst' = a disabled Checkout submit, then an enabled one; 'loginform' = the name="checkout" submit posts
  // to /account/login (formaction); 'fr' = the submit says "Proc\u00e9der au paiement". cartKeepalive 'coupon' or 'ship' = the discount
  // Apply or the shipping estimator's POST is sent as a keepalive fetch (which the panel's page shim drops)
  Object.assign(flags, { shopCart: false, shipRates: 'json', checkoutFieldset: false, checkoutKind: 'normal', couponApp: false, cartKeepalive: '' });
  // the home page "/": 'shopify' (an Online Store theme, the default), 'woo' (a WooCommerce shop), 'hydrogen' (a headless Hydrogen
  // storefront) or 'down' (HTTP 500, so the runner's platform check cannot read it and checks the first page in the browser instead);
  // R26: 'comment', 'conflict', 'deadscript' (see the home page below) and 'nocartjs' (a Shopify home, but /cart.js is a 404 page)
  // R27: 'stencil' and 'wpembed' = a running Shopify theme next to a BigCommerce or WordPress script address
  flags.home = 'shopify';
  const carts = new Map();
  let PORT = 0;
  const read = (f) => fs.readFileSync(path.join(STORE_DIR, f), 'utf8');
  const fill = (html, p, more = {}) => {
    // replacement FUNCTIONS, so a "$'" or "$&" inside an inserted script (a price label such as ': $' + x.price) is kept as written
    let out = html.replace('{{EXTRA}}', () => extraHtml[p] || '').replaceAll('{{THIRD}}', `http://localhost:${PORT}`).replaceAll('{{PORT}}', String(PORT));
    for (const [k, v] of Object.entries(more)) out = out.replaceAll(`{{${k}}}`, () => v);
    return out.replace(/\{\{[A-Z]+\}\}/g, '');
  };
  const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
  const cartOf = (req, res) => {
    const m = /(?:^|;\s*)fx_cart=([a-f0-9]+)/.exec(req.headers.cookie || '');
    let id = m && carts.has(m[1]) ? m[1] : null;
    if (!id) { id = crypto.randomBytes(6).toString('hex'); carts.set(id, []); res.setHeader('set-cookie', `fx_cart=${id}; Path=/; SameSite=Lax`); }
    return carts.get(id);
  };
  const add = (cart, id, qty = 1) => { const p = PRODUCTS[id]; if (!p) return false; const line = cart.find((l) => l.id === +id); if (line) line.qty += qty; else cart.push({ id: +id, qty, key: crypto.randomBytes(4).toString('hex') }); return true; };
  const money = (c, kind) => (kind === 'woo' ? `${(c / 100).toFixed(2).replace('.', ',')} €` : `$${(c / 100).toFixed(2)}`);
  const send = (res, code, type, text) => { res.writeHead(code, { 'content-type': type }); res.end(text); };
  // WooCommerce Store API, the small part a cart count and a cart emptying need
  const storeApi = async (req, res, route) => {
    const cart = cartOf(req, res);
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=UTF-8', Nonce: NONCE, 'Cart-Token': 'fx-cart-token' }); res.end(JSON.stringify(obj)); };
    const view = () => ({ items_count: cart.reduce((n, l) => n + l.qty, 0), items: cart.map((l) => ({ key: l.key, id: l.id, quantity: l.qty, name: PRODUCTS[l.id].title })) });
    if (/^\/?checkout/.test(route)) return json(200, { order_id: 9999, status: 'placed (this must never be reached)' });
    if (route === 'cart' && req.method === 'GET') return json(200, view());
    if (route === 'cart/items' && req.method === 'DELETE') { if (req.headers.nonce !== NONCE) return json(401, { code: 'woocommerce_rest_missing_nonce' }); cart.length = 0; return json(200, []); }
    if (route === 'cart/remove-item' && req.method === 'POST') { if (req.headers.nonce !== NONCE) return json(401, { code: 'woocommerce_rest_missing_nonce' }); const k = (JSON.parse((await body(req)) || '{}').key); const i = cart.findIndex((l) => l.key === k); if (i >= 0) cart.splice(i, 1); return json(200, view()); }
    return json(404, { code: 'rest_no_route' });
  };

  const handler = async (req, res) => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname;
    hits[p] = (hits[p] || 0) + 1;
    requests.push({ method: req.method, url: req.url, host: req.headers.host, headers: { ...req.headers } });
    if (extraRoutes[p]) return extraRoutes[p](req, res, { PORT });
    const third = /^localhost(:|$)/.test(req.headers.host || '');
    if (third) {
      if (p === '/pixel.js') return send(res, 200, 'text/javascript', 'window.fxPixel = 1;');
      if (p === '/widgets/delivery-date.js') return send(res, 200, 'text/javascript', "document.getElementById('delivery-estimate').textContent = 'Order in the next 3 hours for delivery by Friday.';");
      return send(res, 404, 'text/plain', 'not found');
    }
    // checkout pages exist so a test can prove they are never requested
    if (/^\/checkouts?(\/|$)/.test(p)) return send(res, 200, 'text/html', '<!doctype html><title>Checkout</title><h1>Checkout</h1>');
    if (p === '/assets/store.css') return send(res, 200, TYPES['.css'], read('store.css'));
    if (p === '/assets/shopify-theme.js') return send(res, 200, TYPES['.js'], read('shopify-theme.js'));
    if (p === '/assets/woo-theme.js') return send(res, 200, TYPES['.js'], read('woo-theme.js'));
    if (p === '/wp-content/themes/storefront/style.css') return send(res, 200, TYPES['.css'], read('wp-content/themes/storefront/style.css'));
    if (/^\/img\/[a-z0-9-]+\.svg$/.test(p) && fs.existsSync(path.join(STORE_DIR, p))) return send(res, 200, TYPES['.svg'], read(p.slice(1)));
    if (p === '/reviews.json') return send(res, 200, TYPES['.json'], JSON.stringify({ summary: 'Rated 4.8 out of 5 by 212 buyers.', snippet: 'Most mention the light scent and the friendly customer service.' }));
    if (p === '/api/collect') return send(res, 204, 'text/plain', '');
    if (p === '/meta.json') return flags.meta ? send(res, 200, TYPES['.json'], JSON.stringify({ name: 'Northwick Candle Co.', myshopify_domain: FIXTURE_MYSHOPIFY })) : send(res, 404, 'text/plain', 'not found');
    if (p.startsWith('/wp-json/wc/store/v1/')) return flags.wpJson ? storeApi(req, res, p.slice('/wp-json/wc/store/v1/'.length)) : send(res, 404, TYPES['.html'], '<!doctype html><title>Not found</title>');
    // a Shopify home page names its myshopify address in Shopify.shop (the ownership fallback reads "/" only)
    if (p === '/' && !u.search) {
      if (flags.home === 'down') return send(res, 500, TYPES['.html'], '<!doctype html><title>Server error</title><h1>Something went wrong</h1>');
      if (flags.home === 'woo') return send(res, 200, TYPES['.html'], '<!doctype html><html><head><title>Northwick Candle Co.</title><link rel="stylesheet" href="/wp-content/themes/storefront/style.css"></head><body class="home woocommerce-page"><h1>Northwick Candle Co.</h1></body></html>');
      // R26: pages that only LOOK like a Shopify theme: the name in a comment on a WooCommerce page, a theme assignment beside WooCommerce
      // markup, a Shopify home whose /cart.js is not a Shopify cart, and an assignment in a script that never runs it
      if (flags.home === 'comment') return send(res, 200, TYPES['.html'], '<!doctype html><html><head><title>Northwick Candle Co.</title></head><body class="home"><!-- Shopify.theme = {}; --><script>var note = "Shopify.theme = {}";</script><h1>Northwick Candle Co.</h1></body></html>');
      if (flags.home === 'conflict') return send(res, 200, TYPES['.html'], '<!doctype html><html><head><title>Northwick Candle Co.</title><link rel="stylesheet" href="/wp-content/themes/storefront/style.css"><script>window.Shopify = window.Shopify || {}; Shopify.theme = {"name":"Dawn","id":1};</script></head><body class="home woocommerce-page"><h1>Northwick Candle Co.</h1></body></html>');
      if (flags.home === 'stencil' || flags.home === 'wpembed') return send(res, 200, TYPES['.html'], `<!doctype html><html><head><title>Northwick Candle Co.</title><script>window.Shopify = window.Shopify || {}; Shopify.theme = {"name":"Dawn","id":1};</script><script src="${flags.home === 'stencil' ? '/assets/stencil-utils.js' : '/wp-includes/js/wp-embed.min.js'}"></script></head><body class="home"><h1>Northwick Candle Co.</h1></body></html>`);
      if (flags.home === 'deadscript') return send(res, 200, TYPES['.html'], '<!doctype html><html><head><title>Northwick Candle Co.</title><script>window.Shopify = window.Shopify || {}; if (false) { Shopify.theme = {"name":"Dawn","id":1}; }</script></head><body><h1>Northwick Candle Co.</h1></body></html>');
      if (flags.home === 'hydrogen') { res.writeHead(200, { 'content-type': TYPES['.html'], 'powered-by': 'Shopify, Hydrogen' }); return res.end('<!doctype html><html><head><title>Northwick Candle Co.</title></head><body><div id="root" data-hydrogen><h1>Northwick Candle Co.</h1></div><script>window.__remixContext = {};</script></body></html>'); }
      return send(res, 200, TYPES['.html'], `<!doctype html><html><head><title>Northwick Candle Co.</title><script>window.Shopify = window.Shopify || {};${flags.homeShop ? ` Shopify.shop = "${FIXTURE_MYSHOPIFY}";` : ''} Shopify.theme = {"name":"Dawn","id":1,"role":"main"};</script></head><body><h1>Northwick Candle Co.</h1><a href="/collections/gifts">Gifts</a></body></html>`);
    }
    if (p === '/' && u.searchParams.get('rest_route')) { const rr = u.searchParams.get('rest_route'); return flags.restRoute && rr.startsWith('/wc/store/v1/') ? storeApi(req, res, rr.slice('/wc/store/v1/'.length)) : send(res, 404, TYPES['.json'], '{"code":"rest_no_route"}'); }
    // a page whose server fails (HTTP 500): the journey ends as an error, never as a store finding
    if (p === '/server-error') return send(res, 500, TYPES['.html'], '<!doctype html><title>Server error</title><h1>Something went wrong</h1>');
    if (p === '/kasse' || p === '/kasse/') return send(res, 200, TYPES['.html'], fill(read('woo-checkout-kasse.html'), '/kasse/'));
    if (p === '/warenkorb') { res.writeHead(301, { location: '/warenkorb/' }); return res.end(); }
    if (p === '/warenkorb/') { cartOf(req, res); return send(res, 200, TYPES['.html'], fill(read('woo-cart-block.html'), p)); }
    if (p === '/product/beeswax-taper' || p === '/product/beeswax-taper/') {
      const cart = cartOf(req, res);
      if (req.method === 'POST') { await body(req); add(cart, 56, 1); res.writeHead(302, { location: '/product/beeswax-taper/?added=1' }); return res.end(); }
      if (u.searchParams.get('buy-now')) { add(cart, 56, 1); res.writeHead(302, { location: '/kasse/' }); return res.end(); }
      const notice = u.searchParams.get('added') ? '<div class="woocommerce-message" role="alert">"Beeswax Taper Pair" wurde deinem Warenkorb hinzugef&uuml;gt. <a href="/warenkorb/" class="button wc-forward">Warenkorb anzeigen</a></div>' : '';
      return send(res, 200, TYPES['.html'], fill(read('woo-product-beeswax-taper.html'), '/product/beeswax-taper', { NOTICE: notice }));
    }
    if (p === '/collections/gifts') return send(res, 200, TYPES['.html'], fill(read('collection-gifts.html'), p));
    if (p === '/collections/new-arrivals') return send(res, 200, TYPES['.html'], fill(read('collection-new-arrivals.html'), p));
    const js = p.match(/^\/products\/([a-z0-9-]+)\.js$/);
    if (js && HANDLES[js[1]]) { const v = HANDLES[js[1]].map((id) => ({ id, price: PRODUCTS[id].cents, title: PRODUCTS[id].variant })); return send(res, 200, TYPES['.json'], JSON.stringify({ handle: js[1], price: v[0].price, variants: v })); }
    const prod = p.match(/^\/products\/([a-z0-9-]+)\/?$/);
    if (prod && HANDLES[prod[1]]) return send(res, 200, TYPES['.html'], fill(read(`shopify-product-${prod[1]}.html`), p));
    if (p === '/product/amber-soy-candle' || p === '/product/amber-soy-candle/') {
      const cart = cartOf(req, res);
      if (req.method === 'POST') { const f = new URLSearchParams(await body(req)); add(cart, f.get('add-to-cart') || 55, 1); res.writeHead(302, { location: '/product/amber-soy-candle/?added=1' }); return res.end(); }
      const notice = u.searchParams.get('added') ? '<div class="woocommerce-message" role="alert">"Amber Soy Candle" has been added to your basket. <a href="/cart/" class="button wc-forward">View basket</a></div>' : '';
      return send(res, 200, TYPES['.html'], fill(read('woo-product-amber-soy-candle.html'), '/product/amber-soy-candle', { NOTICE: notice }));
    }
    if (p === '/cart/add.js' || p === '/cart/add') {
      const cart = cartOf(req, res); const f = new URLSearchParams(await body(req));
      if (!add(cart, f.get('id'), Number(f.get('quantity') || 1))) return send(res, 422, TYPES['.json'], JSON.stringify({ description: 'Unknown item' }));
      if (p === '/cart/add') { res.writeHead(302, { location: '/cart' }); return res.end(); }
      return send(res, 200, TYPES['.json'], JSON.stringify({ ok: true }));
    }
    if (p === '/cart.js') { const cart = cartOf(req, res); if (flags.home === 'nocartjs') return send(res, 404, TYPES['.html'], '<!doctype html><title>Not found</title><h1>Not found</h1>'); return send(res, 200, TYPES['.json'], JSON.stringify({ token: 'fx-cart-token', currency: 'USD', total_price: cart.reduce((n, l) => n + PRODUCTS[l.id].cents * l.qty, 0), item_count: cart.reduce((n, l) => n + l.qty, 0), items: cart.map((l) => ({ quantity: l.qty, product_title: PRODUCTS[l.id].title, variant_title: PRODUCTS[l.id].variant || null, final_line_price: PRODUCTS[l.id].cents * l.qty })) })); }
    if (p === '/cart/clear.js') { const cart = cartOf(req, res); cart.length = 0; return send(res, 200, TYPES['.json'], JSON.stringify({ item_count: 0 })); }
    if (p === '/cart' && req.method === 'POST') { res.writeHead(302, { location: '/checkouts/cn/fixture-token' }); return res.end(); }
    // the Shopify cart's own writes: /cart/update.js (a discount code, quantities), /cart/change.js (one line), and the shipping
    // estimator (POST /cart/prepare_shipping_rates.json, then GET /cart/async_shipping_rates.json)
    if ((p === '/cart/update.js' || p === '/cart/change.js') && req.method === 'POST') {
      const cart = cartOf(req, res); const raw = await body(req);
      let f = {}; try { f = /json/i.test(req.headers['content-type'] || '') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw)); } catch {}
      if (typeof f.discount === 'string') cart.coupon = flags.couponWorks && f.discount.trim().toUpperCase() === 'CANDLE10' ? 'CANDLE10' : null;
      return send(res, 200, TYPES['.json'], JSON.stringify({ item_count: cart.reduce((n, l) => n + l.qty, 0) }));
    }
    if (p === '/cart/prepare_shipping_rates.json' && req.method === 'POST') {
      const cart = cartOf(req, res); const f = new URLSearchParams(await body(req));
      cart.postcode = String(f.get('shipping_address[zip]') || '').slice(0, 12); cart.country = String(f.get('shipping_address[country]') || '').slice(0, 2);
      return send(res, 202, TYPES['.json'], 'null');
    }
    if (p === '/cart/async_shipping_rates.json') {
      const cart = cartOf(req, res);
      if (flags.shipRates !== 'json' || !cart.postcode) return send(res, 422, TYPES['.json'], JSON.stringify({ error: 'rates unavailable' }));
      return send(res, 200, TYPES['.json'], JSON.stringify({ shipping_rates: [{ name: 'Express', price: ((flags.shipCents + 900) / 100).toFixed(2) }, { name: 'Standard', price: (flags.shipCents / 100).toFixed(2) }] }));
    }
    if (p === '/cart') {
      const cart = cartOf(req, res);
      const rows = cart.map((l) => `<tr class="cart-item"><td>${PRODUCTS[l.id].title}${PRODUCTS[l.id].variant ? ` (${PRODUCTS[l.id].variant})` : ''}</td><td>${l.qty}</td><td>${money(PRODUCTS[l.id].cents * l.qty)}</td></tr>`).join('');
      const sub = cart.reduce((n, l) => n + PRODUCTS[l.id].cents * l.qty, 0);
      const off = cart.coupon ? Math.round(sub / 10) : 0;
      const shop = flags.shopCart && cart.length;
      const banner = shop && flags.codeBanner ? '<p class="store-notice">New here? Use code CANDLE10 for 10% off your first order.</p>' : '';
      const bar = !shop || !flags.freeShipBar ? '' : `<p class="free-shipping-bar">You are ${money(Math.max(0, 5000 - sub) + (flags.freeShipBar === 'wrong' ? 500 : 0))} away from free shipping on orders over ${money(5000)}</p>`;
      const coupon = '<section class="cart-discount"><label for="cart-discount-code">Discount code</label> <input type="text" id="cart-discount-code" name="discount" placeholder="Discount code"> <button type="button" id="apply-discount">Apply</button></section>';
      const est = flags.shipCents === null ? '' : '<section class="shipping-calculator"><h2>Estimate shipping rates</h2><select id="address_country" name="address[country]"><option value="">Select a country</option><option value="DE">Germany</option><option value="US">United States</option></select> <input type="text" id="address_zip" name="address[zip]" placeholder="Postal code"> <button type="button" id="get-rates">Calculate shipping</button><p class="promo">Free shipping on orders over $50.00!</p><ul id="shipping-rates"></ul></section>';
      const js = `<script>
(function () {
  var a = document.getElementById('apply-discount');
  if (a) a.addEventListener('click', function () { fetch('${flags.couponApp ? '/apps/discount/apply' : '/cart/update.js'}', { method: 'POST',${flags.cartKeepalive === 'coupon' ? ' keepalive: true,' : ''} headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ discount: document.getElementById('cart-discount-code').value.trim() }) }).then(function () { location.reload(); }, function () { location.reload(); }); });
  var g = document.getElementById('get-rates');
  if (g) g.addEventListener('click', function () {
    var b = new URLSearchParams(); b.set('shipping_address[zip]', document.getElementById('address_zip').value); b.set('shipping_address[country]', document.getElementById('address_country').value);
    fetch('/cart/prepare_shipping_rates.json', { method: 'POST',${flags.cartKeepalive === 'ship' ? ' keepalive: true,' : ''} headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() })
      .then(function () { return fetch('/cart/async_shipping_rates.json'); })
      .then(function (r) { return r.ok ? r.json() : { shipping_rates: [] }; })
      .then(function (j) { document.getElementById('shipping-rates').innerHTML = (j.shipping_rates || []).map(function (x) { return '<li>' + x.name + ': $' + x.price + '</li>'; }).join('') || '<li>No shipping options</li>'; });
  });
})();
</script>`;
      const btn = flags.checkoutKind === 'express' ? '<div class="additional-checkout-buttons"><a class="paypal-button" href="https://www.paypal.com/checkoutnow?token=fx">Check out with PayPal</a></div>'
        : flags.checkoutKind === 'div' ? '<div id="checkout" class="button" style="display:inline-block;padding:12px 24px;background:#222;color:#fff">Check out</div>'
        : flags.checkoutKind === 'disabledfirst' ? '<button type="submit" name="checkout" disabled>Check out</button> <button type="submit" name="checkout">Check out</button>'
        : flags.checkoutKind === 'loginform' ? '<button type="submit" name="checkout" formaction="/account/login">Check out</button>'
        : flags.checkoutKind === 'fr' ? '<button type="submit" name="checkout">Proc\u00e9der au paiement</button>'
        : '<button type="submit" name="checkout">Check out</button>';
      return send(res, 200, TYPES['.html'], fill(read('shopify-cart.html'), p, {
        ROWS: rows || '<tr><td>Your cart is empty</td></tr>', SUBTOTAL: money(sub), TOTAL: money(sub - off),
        DISCOUNTLINE: off ? `<p>Discount CANDLE10 -${money(off)}</p>` : '', BANNER: banner, BAR: bar,
        CHECKOUT: flags.checkoutFieldset ? `<fieldset disabled class="cart__ctas">${btn}</fieldset>` : btn,
        WIDGETS: shop ? `${coupon}${est}${js}` : '',
      }));
    }
    if (p === '/cart/') {
      const cart = cartOf(req, res);
      const rm = u.searchParams.get('remove_item');
      if (rm) { const i = cart.findIndex((l) => l.key === rm); if (i >= 0) cart.splice(i, 1); res.writeHead(302, { location: '/cart/' }); return res.end(); }
      // the classic cart form posts back to /cart/: apply_coupon or calc_shipping, then a redirect to the cart (as WooCommerce does)
      if (req.method === 'POST') {
        const f = new URLSearchParams(await body(req));
        if (f.has('apply_coupon') && flags.couponWorks && String(f.get('coupon_code') || '').trim().toUpperCase() === 'CANDLE10') cart.coupon = 'CANDLE10';
        if (f.has('calc_shipping')) { cart.postcode = String(f.get('calc_shipping_postcode') || '').slice(0, 12); cart.country = String(f.get('calc_shipping_country') || '').slice(0, 2); }
        res.writeHead(302, { location: '/cart/' }); return res.end();
      }
      const rows = cart.map((l) => `<tr class="woocommerce-cart-form__cart-item cart_item"><td><a class="remove" href="/cart/?remove_item=${l.key}" aria-label="Remove this item">&times;</a></td><td>${PRODUCTS[l.id].title}</td><td><input class="qty" name="cart[${l.key}][qty]" value="${l.qty}"></td><td>${money(PRODUCTS[l.id].cents * l.qty, 'woo')}</td></tr>`).join('');
      const sub = cart.reduce((n, l) => n + PRODUCTS[l.id].cents * l.qty, 0);
      const off = cart.coupon ? Math.round(sub / 10) : 0;
      const ship = cart.length && cart.postcode && flags.shipCents !== null ? flags.shipCents : 0;
      const bar = !cart.length || !flags.freeShipBar ? '' : `<p class="free-shipping-bar">You are ${money(Math.max(0, 5000 - sub) + (flags.freeShipBar === 'wrong' ? 500 : 0), 'woo')} away from free shipping on orders over ${money(5000, 'woo')}</p>`;
      const banner = flags.codeBanner ? '<p class="store-notice">New here? Use code CANDLE10 for 10% off your first order.</p>' : '';
      const coupon = '<div class="coupon"><label for="coupon_code">Coupon:</label> <input type="text" name="coupon_code" class="input-text" id="coupon_code" value="" placeholder="Coupon code"> <button type="submit" class="button" name="apply_coupon" value="Apply coupon">Apply coupon</button></div>';
      const calc = flags.shipCents === null ? '' : `<tr class="woocommerce-shipping-totals shipping"><th>Shipping</th><td>${cart.postcode ? `<ul id="shipping_method"><li>Flat rate: ${money(flags.shipCents, 'woo')}</li></ul><p class="woocommerce-shipping-destination">Shipping to ${cart.postcode}.</p>` : '<p>Enter your address to view shipping options.</p>'}<form class="woocommerce-shipping-calculator" action="/cart/" method="post"><p>Calculate shipping</p><select name="calc_shipping_country" id="calc_shipping_country"><option value="">Select a country</option><option value="DE">Germany</option><option value="US">United States (US)</option></select> <input type="text" name="calc_shipping_postcode" id="calc_shipping_postcode" placeholder="Postcode / ZIP"> <button type="submit" name="calc_shipping" value="1" class="button">Update</button></form></td></tr>`;
      return send(res, 200, TYPES['.html'], fill(read('woo-cart.html'), p, { ROWS: rows || '<tr><td>Your basket is empty</td></tr>', BANNER: banner, BAR: bar, COUPON: cart.length ? coupon : '', SHIPPING: cart.length ? calc : '', SUBTOTAL: money(sub, 'woo'), TOTAL: money(sub - off + ship, 'woo') }));
    }
    return send(res, 404, TYPES['.html'], '<!doctype html><title>Not found</title><h1>Page not found</h1>');
  };

  const server = http.createServer((req, res) => { handler(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch {} }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  let server6 = null;
  try { server6 = http.createServer(server.listeners('request')[0]); await new Promise((r, j) => { server6.once('error', j); server6.listen(PORT, '::1', r); }); } catch { server6 = null; }
  return {
    port: PORT, origin: `http://127.0.0.1:${PORT}`, hits, requests, flags,
    close: () => Promise.all([new Promise((r) => server.close(r)), server6 ? new Promise((r) => server6.close(r)) : null]),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startFixtureServer();
  console.log(`Practice store (made up, on this computer only): ${s.origin}  (port ${s.port})`);
  console.log(`Pages: /collections/gifts, /collections/new-arrivals, /products/linen-and-cedar-candle, /products/gift-set,`);
  console.log(`       /products/autumn-ember-candle, /products/dawn-tote, /cart`);
  // paths are printed as they are, in double quotes (JSON.stringify would double every backslash in a Windows path)
  const skill = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log('In a second terminal, run the 3 example shoppers (they are drafts, so --include-drafts is needed):');
  console.log(`  node "${path.join(skill, 'scripts', 'shopper-panel.mjs')}" --url http://127.0.0.1:${s.port} --i-own 127.0.0.1 --personas "${path.join(skill, 'examples', 'personas')}" --include-drafts`);
  console.log('To try your own shoppers instead, run it from your project folder with --personas ./personas (and no --include-drafts once they are active).');
  console.log('Leave this running; press Ctrl+C to stop it.');
}
