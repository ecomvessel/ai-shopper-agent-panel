#!/usr/bin/env node
// AI Shopper Agent Panel: scripted shopper personas walk YOUR store on a phone, from arrival to the cart, then stop before checkout.
// Run `node scripts/shopper-panel.mjs --help` for every option. Read README.md before the first run.
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import * as lib from './panel-lib.mjs';
import { checkPersona, checkPanel, findConfigFile, readJsonFile } from './persona-schema.mjs';

// Page text is printed to the terminal: strip control and bidi characters first so a store page cannot move the cursor, clear the
// screen or reverse text in the operator's terminal. Newlines and tabs in the tool's own messages are kept.
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => orig(...a.map((x) => (typeof x === 'string' ? x.split('\n').map((l) => l.split('\t').map(lib.termSafe).join('\t')).join('\n') : x)));
}
{ const w = process.stdout.write.bind(process.stdout); process.stdout.write = (c, ...r) => w(typeof c === 'string' ? c.split('\n').map(lib.termSafe).join('\n') : c, ...r); }

const VERSION = '1.0.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const HELP = `AI Shopper Agent Panel ${VERSION}

${lib.PROMISE}

Usage:
  node scripts/shopper-panel.mjs --url https://your-store.example --i-own your-store.example [options]

Required:
  --url <address>        Your store. With only the domain (no path), each persona lands on its own
                         entry_point.landing_path. With a path, every persona lands on that page.
                         Repeat --url to test several pages.
  --i-own <domain>       Your own promise that you own this store or have permission to test it; the
                         panel cannot check that. Must be the same host as --url or its www. version.
                         A <name>.myshopify.com owner for a custom domain is accepted only when the store
                         confirms that address (its /meta.json or the Shopify.shop value in the page),
                         checked when the run starts. That proves the store is that shop, not that you
                         own it.

Options:
  --personas <folder>    Persona files (default: ./personas in the current folder)
  --persona <ids>        Only these personas, comma separated
  --include-drafts       Also run personas with "status": "draft"
  --out <folder>         Where results go (default: ./reports)
  --report <file>        Also write the Markdown report to this file
  --no-cart              Browse only: never tap Add to cart (known cart calls from the page are stopped,
                         best effort). Without it, each shopper adds to cart, opens the cart and stops
                         when it finds the Checkout button, without tapping it
  --cart                 Accepted so older commands keep working (adding to cart is the default)
  --fb-inapp             Every persona uses the Facebook in-app browser's user agent (only the user agent
                         is copied; it is still Playwright's browser, and there is no fake referer)
  --allow-host <host>    Let a third-party host serve static files (GET or HEAD of scripts, styles, images,
                         fonts and media only; repeatable, "*.example.com" allowed). Payment hosts never pass
  --config <file>        Extra settings (default: ./shopper-panel.config.json if it exists)
  --pause <seconds>      Pause between journeys (default 6, plus a random extra)
  --strict-errors        Count page script errors as blocking findings
  --headed               Show the browser window
  --dry-run              Print the plan and the safety setup; launch nothing, touch no network
  -h, --help             This text

Practice first: "npm run fixture" (in the skill folder) starts a made-up store on this computer and prints its port. Then
go to your project folder (where your personas/ folder is) and run:
  node ~/.claude/skills/ai-shopper-agent-panel/scripts/shopper-panel.mjs --url http://127.0.0.1:<port> --i-own 127.0.0.1 --personas ./personas
Windows PowerShell does not expand ~ in that path; there, use:
  node "$env:USERPROFILE\\.claude\\skills\\ai-shopper-agent-panel\\scripts\\shopper-panel.mjs" --url http://127.0.0.1:<port> --i-own 127.0.0.1 --personas .\\personas

Exit codes: 0 the run completed (shoppers quitting is a result, not a failure).
            1 the run is INCOMPLETE: something stopped the test itself, so some results are missing.
            2 bad setup (a wrong option, a bad file, or an ownership check that failed).
            docs/safety-details.md lists every case.`;

// ---------- arguments ----------
const argv = process.argv.slice(2);
const bail = (msg) => { console.error(msg); process.exit(2); };
if (!argv.length) { console.error('Missing --url and --i-own.\n'); console.log(HELP); process.exit(2); }
if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); process.exit(0); }
// Strict parsing, so a typo can never quietly change what a run does: an on/off option takes no value ("--cart=false" is refused, not
// read as on), every other option needs one, and an unknown option, a single-dash option or a stray word is an error.
const BOOL_OPTS = new Set(['include-drafts', 'cart', 'no-cart', 'fb-inapp', 'strict-errors', 'headed', 'dry-run']);
const VALUE_OPTS = new Set(['url', 'i-own', 'personas', 'persona', 'out', 'report', 'allow-host', 'config', 'pause']);
const MULTI_OPTS = new Set(['url', 'allow-host']);
const parsed = new Map();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const m = /^--([a-z][a-z-]*)(?:=(.*))?$/s.exec(a);
  if (!m) bail(a.startsWith('-') ? `Unknown option ${a}. Run with --help to see the options.` : `Unexpected "${a}": every value belongs to an option (for example --url ${a}). Run with --help.`);
  const [, name, inline] = m;
  if (BOOL_OPTS.has(name)) {
    if (inline !== undefined) bail(`--${name} is an on/off option and takes no value: write --${name} on its own, or leave it out.`);
    parsed.set(name, true); continue;
  }
  if (!VALUE_OPTS.has(name)) bail(`Unknown option --${name}. Run with --help to see the options.`);
  let v = inline;
  if (v === undefined) { v = argv[i + 1]; if (v === undefined || /^--?[a-z]/i.test(v)) bail(`--${name} needs a value. Run with --help.`); i++; }
  if (MULTI_OPTS.has(name)) { parsed.set(name, [...(parsed.get(name) || []), v]); continue; }
  if (parsed.has(name)) bail(`--${name} was given twice. Give it once.`);
  parsed.set(name, v);
}
const flag = (n) => parsed.get(n) === true;
const opt = (n) => { const v = parsed.get(n); return typeof v === 'string' ? v : null; };
const many = (n) => (Array.isArray(parsed.get(n)) ? parsed.get(n) : []);
if (opt('pause') !== null && !/^\d+(\.\d+)?$/.test(opt('pause').trim())) bail(`--pause "${opt('pause')}" is not a number of seconds. Use for example --pause 6.`);

// ---------- what to test, and proof of ownership ----------
const urls = many('url');
if (!urls.length) bail('Missing --url. Run with --help.');
const targets = urls.map((u) => {
  let x; try { x = new URL(u); } catch { bail(`--url "${u}" is not a web address. Use the full address, for example https://your-store.example`); }
  if (!/^https?:$/.test(x.protocol)) bail(`--url "${u}" must start with http:// or https://`);
  return x;
});
const owned = opt('i-own');
const TOS = [
  '',
  'Only run the shopper panel on a store you own or have written permission to test.',
  'Scripted browsers on someone else\'s store can break that site\'s terms of service, skew its analytics,',
  'and look like an attack to its bot protection. This check cannot prove ownership; it makes you say it.',
].join('\n');
if (!owned) bail(`Refusing to run: add --i-own <domain> to confirm you own ${targets[0].hostname} (or are allowed to test it).${TOS}`);
const shopifyToConfirm = [];
for (const t of targets) {
  const m = lib.ownershipMatch(t.hostname, owned);
  if (m.ok) continue;
  if (m.needsShopifyConfirm) { shopifyToConfirm.push({ target: t, shop: m.needsShopifyConfirm }); continue; }
  bail(`Refusing to run: --i-own "${owned}" does not match --url host "${t.hostname}". It must be the same host or its www. version. (A <name>.myshopify.com owner is accepted for a custom domain only when that store confirms the address itself.)${TOS}`);
}
// The www. twin is added for real domain names only, never for an IP address or localhost (there is no www.127.0.0.1).
const isIpOrLocal = (h) => /^(\d+\.\d+\.\d+\.\d+|localhost|\[[0-9a-f:.]+\])$/i.test(h);
const ownHosts = new Set(targets.flatMap((t) => { const h = t.hostname.toLowerCase(); return isIpOrLocal(h) ? [h] : [h, h.replace(/^www\./, ''), `www.${h.replace(/^www\./, '')}`]; }));
const loopback = targets.every((t) => /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i.test(t.hostname));
// A private network or cloud metadata address is never tested, and this computer only when --i-own names it too (the practice store)
// SP_TEST_MYSHOPIFY_LOOPBACK: offline tests only (every --url loopback), lets the practice store stand in for a myshopify owner check.
const testMyshopifyLoopback = loopback && process.env.SP_TEST_MYSHOPIFY_LOOPBACK === '1' && /\.myshopify\.com$/i.test(String(owned || ''));
for (const t of targets) {
  const k = lib.privateAddressKind(t.hostname);
  if (k === 'private' || (k === 'loopback' && !lib.privateAddressKind(owned) && !testMyshopifyLoopback)) bail(`Refusing to run: --url "${t.hostname}" is ${k === 'private' ? 'a private network address' : 'this computer'}. The panel tests a public store, or the practice store on this computer (with --i-own 127.0.0.1).`);
}
// Adding to cart is the default. --no-cart = browse only. --cart is accepted as a no-op so older commands keep working.
if (flag('cart') && flag('no-cart')) bail('Use either --cart or --no-cart, not both (without either, each shopper adds to cart).');

// ---------- personas ----------
const personaDir = path.resolve(opt('personas') || 'personas');
if (!fs.existsSync(personaDir)) bail(`No persona folder at ${personaDir}. Make ./personas (see templates/persona-card.md) or pass --personas <folder>.`);
const wanted = (opt('persona') || '').split(',').map((s) => s.trim()).filter(Boolean);
const loaded = [];
for (const f of fs.readdirSync(personaDir).filter((x) => x.endsWith('.json')).sort()) {
  const rd = readJsonFile(fs, path.join(personaDir, f));
  if (rd.err) bail(`${f} ${rd.err}`);
  const p = rd.value;
  const errs = checkPersona(p);
  // the same rules as the validator: the id is the file name, and no two personas share an id
  if (!errs.length && path.basename(f, '.json') !== p.id) errs.push(`"id" must match the file name (the file is ${f}, the id is "${p.id}")`);
  if (!errs.length && loaded.some((x) => x.id === p.id)) errs.push(`the id "${p.id}" is used by another persona file`);
  if (errs.length) bail(`${f} is not a valid persona. Run node "${path.join(here, 'validate-personas.mjs')}" "${personaDir}" to see every problem. First problem: ${errs[0]}`);
  loaded.push(p);
}
for (const w of checkPanel(loaded)) console.warn(`Warning: ${w}`);
for (const w of wanted) if (!loaded.find((p) => p.id === w)) bail(`Unknown persona "${w}" in ${personaDir}`);
const includeDrafts = flag('include-drafts');
const personas = loaded.filter((p) => (includeDrafts || p.status === 'active') && (!wanted.length || wanted.includes(p.id)));
const skipped = loaded.filter((p) => !personas.includes(p)).map((p) => `${p.id}${p.status !== 'active' ? ' (draft)' : ''}`);
if (!personas.length) bail(loaded.length ? 'No active personas found. The examples are drafts; add --include-drafts to try them, or set status: active.' : `No persona files (*.json) in ${personaDir}. If your shoppers are in your project folder, pass --personas <that folder>/personas. To start a new panel, write your shoppers from templates/persona-card.md (the files in examples/personas/ are samples for the practice store, not a real panel), then check them with "node ${path.join(here, 'validate-personas.mjs')} <your personas folder>".`);

// ---------- config and the third-party allow-list ----------
let config = {};
// the same lookup as the validator: --config, else ./shopper-panel.config.json, else the one next to the persona folder
const cfgFound = findConfigFile({ explicit: opt('config') || null, personaDirs: [personaDir], fs, path });
const cfgPath = cfgFound.file || path.resolve('shopper-panel.config.json');
if (opt('config') && !fs.existsSync(cfgPath)) bail(`--config file not found: ${cfgPath}`);
if (cfgFound.note) console.log(cfgFound.note);
if (fs.existsSync(cfgPath)) { const rd = readJsonFile(fs, cfgPath); if (rd.err) bail(`${cfgPath} ${rd.err}`); config = rd.value; }
const blockCfg = JSON.parse(fs.readFileSync(path.join(here, 'blocklist.json'), 'utf8'));
const blockRules = [];
// Only the shipped rules are built in: "endpoint" and "endpoint_hosts" are refused on a rule from shopper-panel.config.json.
for (const [r, builtin] of [...blockCfg.rules.map((x) => [x, true]), ...(Array.isArray(config.block_rules) ? config.block_rules : []).map((x) => [x, false])]) {
  const c = lib.compileBlockRule(r, { builtin }); // every rule says whether it is a host rule or a path rule (see docs/block-rules.md)
  if (c.err) bail(`Block rule "${r && r.name}"${builtin ? ' (built in)' : ` in ${cfgPath}`} is not valid: ${c.err}. See docs/block-rules.md.`);
  blockRules.push(c.rule);
}
const extraAllow = [...many('allow-host'), ...(Array.isArray(config.allow_hosts) ? config.allow_hosts : [])];
for (const h of extraAllow) if (typeof h !== 'string' || !lib.HOST_PATTERN.test(h)) bail(`Allowed host "${h}" is not a host name (for example widgets.reviews.example or *.reviews.example).`);
const baseAllow = [...blockCfg.allow_hosts, ...extraAllow];
// A host rule that stops every request to an allowed host (or the store's own host): an endpoint host rule doing that would hide a
// broken page, so the run stops; any other host rule doing that is a warning, because the allow entry has no effect.
const setupWarnings = [];
{
  const allowEntries = [...blockCfg.allow_hosts.map((h) => [h, 'scripts/blocklist.json']), ...many('allow-host').map((h) => [h, '--allow-host']), ...(Array.isArray(config.allow_hosts) ? config.allow_hosts : []).map((h) => [h, 'shopper-panel.config.json']), ...personas.flatMap((p) => (Array.isArray(p.allow_hosts) ? p.allow_hosts : []).map((h) => [h, `persona ${p.id}`]))];
  for (const r of blockRules) {
    if (r.kind !== 'host') continue;
    for (const h of ownHosts) if (lib.hostRuleCovers(r, h)) {
      if (r.endpoint) bail(`Block rule "${r.name}" is marked "endpoint": true but it covers the store's own host ${h}, so it would stop the store's pages and scripts without anyone noticing. Remove "endpoint" or narrow the rule.`);
      setupWarnings.push(`the store's own host ${h} is covered by the "${r.name}" block rule, which blocks every request to it except pages`);
    }
    for (const [h, from] of allowEntries) if (typeof h === 'string' && lib.hostRuleCovers(r, h)) {
      if (r.endpoint) bail(`Block rule "${r.name}" is marked "endpoint": true but it covers the allowed host ${h} (from ${from}). Remove "endpoint" or narrow the rule.`);
      setupWarnings.push(`${h} is allowed (from ${from}) but the "${r.name}" rule still blocks it`);
    }
  }
  for (const w of [...new Set(setupWarnings)]) console.error(`Warning: ${w}.`);
}
const TRACKER_WORDING = 'Inside the test browser, known third-party trackers and the platform\'s own analytics endpoints were blocked; a store\'s own first-party tag proxy may not be. Server-side tracking (events a store platform or app sends from its own servers) cannot be blocked from a browser, so a run can still show up there.';

// ---------- output places ----------
const started = new Date();
const stamp = started.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const runId = `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
const outRoot = path.resolve(opt('out') || 'reports');
const runDir = path.join(outRoot, runId);
const shotsDir = path.join(runDir, 'screenshots');
const rel = (p) => { const r = path.relative(process.cwd(), p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : p; };
const CART_MODE = !flag('no-cart'); // adding to cart is the default; --no-cart = browse only
// Offline tests only (loopback --url): SP_TEST_NO_ROUTE_GUARD turns the route guard off so the browser-level guard is tested alone.
const TEST_NO_ROUTE_GUARD = loopback && !!process.env.SP_TEST_NO_ROUTE_GUARD;
const FB_INAPP = flag('fb-inapp');
const STRICT_ERRORS = flag('strict-errors');
let pauseSec = opt('pause') === null ? 6 : Number(opt('pause'));

// Arrival is labelled as a test so it is easy to filter out of analytics. Never a fake referer, never ad-network UTM values.
const UTM = { utm_source: 'shopper-panel', utm_medium: 'qa-test', utm_campaign: 'shopper-panel-test' };
const landingFor = (t, persona) => {
  const x = new URL(t.toString());
  if (x.pathname === '/' && !x.search) x.pathname = persona.entry_point.landing_path.split('?')[0];
  for (const [k, v] of Object.entries(UTM)) x.searchParams.set(k, v);
  return x.toString();
};
const fbUserAgent = (ua, deviceKey) => `${ua} ${deviceKey === 'pixel-7' ? '[FB_IAB/FB4A;FBAV/450.0.0.38.109;]' : '[FBAN/FBIOS;FBAV/450.0.0.38.109;FBBV/560000000;FBDV/iPhone14,7;FBMD/iPhone;FBSN/iOS;FBSV/17.0;FBLC/en_US;FBOP/5]'}`;
// Chromium only: an iPhone shopper is Chrome at iPhone size (viewport, user agent, touch, pixel ratio), so Safari-only bugs are not caught.
const { defaultBrowserType: _iphoneEngine, ...IPHONE_14 } = devices['iPhone 14'];
const DEVICES = {
  'iphone-14': { label: 'iPhone 14 size (Chrome engine)', engine: 'chromium', ctx: IPHONE_14 },
  'pixel-7': { label: 'Pixel 7 (Chrome engine)', engine: 'chromium', ctx: devices['Pixel 7'] },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s, max = 120) => `"${lib.oneLine(s, max).replace(/"/g, "'")}"`; // page-derived text is always quoted
const SOLD = /sold.?out|unavailable|out of stock/i;
// Network errors that mean the store never answered (Chromium net:: codes, WebKit wording).
const UNREACHABLE = /ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_ADDRESS_INVALID|ERR_UNSAFE_PORT|ERR_CONNECTION_FAILED|ERR_INTERNET_DISCONNECTED|Could not connect|Failed to connect|hostname could not be found|Connection refused|Couldn't connect|server with the specified hostname|Not allowed to use restricted network port|Network connection was lost|NS_ERROR_CONNECTION_REFUSED|NS_ERROR_UNKNOWN_HOST/i;
// Can a plain connection reach the store at all? Used only after a page load failed, to tell "the store did not answer" (a dead
// port, a name that does not resolve) from a store that answered with an error. One TCP connection, no request is sent.
// Returns 'ok', 'refused' (nothing listening), 'dns' (the name did not resolve), 'timeout' or 'other'.
function storeProbe(origin, ms = 5000) {
  return new Promise((resolve) => {
    let u; try { u = new URL(origin); } catch { return resolve('other'); }
    const port = +(u.port || (u.protocol === 'https:' ? 443 : 80));
    const sock = net.connect({ host: u.hostname.replace(/^\[|\]$/g, ''), port });
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(ms, () => done('timeout')); sock.once('connect', () => done('ok'));
    sock.once('error', (e) => done(e && e.code === 'ECONNREFUSED' ? 'refused' : e && /^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL)$/.test(e.code) ? 'dns' : 'other'));
  });
}

let netPolicy = null; let netDrop = null;
// Which journey owns the policy slot: a journey the watchdog gave up on may finish late, and must not clear the next journey's policy.
let netOwner = null;
// ---------- one journey = one persona on one page ----------
// holder: filled in as the journey starts ({ ctx, j }), so the watchdog can close a journey whose page stopped responding.
async function runJourney(browsers, persona, target, holder = {}) {
  const dev = DEVICES[persona.device];
  const engine = dev.engine;
  const net = persona.network;
  const inApp = FB_INAPP || persona.in_app_browser === 'facebook';
  const ctx = await browsers[engine].newContext({ ...dev.ctx, ...(inApp ? { userAgent: fbUserAgent(dev.ctx.userAgent, persona.device) } : {}), serviceWorkers: 'block', locale: 'en-US' });
  holder.ctx = ctx;
  ctx.setDefaultTimeout(30000); // no browser action may wait forever
  ctx.setDefaultNavigationTimeout(Math.max(persona.patience.load_seconds * 3, 30) * 1000);
  const startUrl = landingFor(target, persona);
  const j = {
    persona: persona.id, name: persona.name, device: dev.label, engine, network: net.name,
    expected_quit_reason: persona.main_quit_reason,
    mode: CART_MODE ? 'cart' : 'no-cart', completed: false, checkout_button: null, cart_checks: {}, reached_checkout: false, checkout_page_loaded: false, checkout_request: null, checkout_blocked: [],
    arrival: inApp ? 'Facebook in-app browser user agent only (no referer); labelled qa-test' : 'labelled qa-test link, no referer',
    start_url: startUrl, product_url: null, page_kind: null, platform: null,
    quit_step: null, quit_reason: null, quit_kind: null,
    seconds: 0, taps: 0, screens_scrolled: 0, typed_chars: 0, steps: [], findings: [], warnings: [], trust_matches: [],
    cart_touched: false, cart_touched_by_page: false, cart_writes_stopped: 0, cart_writes_stopped_list: [], store_unreachable: false,
    script_errors: [], filtered_errors: [], blocked: 0, speculation_blocked: 0, beacons_dropped: 0, unload_blocked: 0, unload_dropped: [], rule_hits_on_allowed: [], allowed_hosts: {}, blocked_hosts: {}, by_rule: {}, timings: {},
  };
  holder.j = j;
  const t0 = Date.now();
  const dbg = (m) => { if (process.env.SP_DEBUG) console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}] ${m}`); };
  const sec = () => +((Date.now() - t0) / 1000).toFixed(1);
  const tag = lib.slug(persona.id, 40);
  let shotN = 0;
  const finding = (severity, what, where, screenshot = null) => j.findings.push({ persona: persona.id, severity, what, where, screenshot });
  const rx = (src, what, opts) => {
    if (src === null || src === undefined || src === '') return null;
    const r = lib.safeRegex(src, 'i', opts);
    if (r.err) { j.warnings.push(`bad pattern for ${what}: ${r.err}`); finding('warn', `Persona pattern for ${what} is not valid (${r.err}); that check was skipped`, `persona ${persona.id}`); return null; }
    return r.re;
  };
  const allowHosts = [...baseAllow, ...(persona.allow_hosts || [])];
  const guard = { deliberate: 0, cartFrom: null, cartPages: [], lastDoc: '', cartDirty: false, cartUrls: [], halt: false };
  holder.guard = guard;
  // the runner's own tap in progress (the address it leads to), so a page load the guard stops can be told apart: the runner's own
  // navigation (its tapped link or form, and the redirects of a tapped link) versus something the page did on its own
  let pendingNav = null;
  const samePage = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, ''); } catch { return false; } };
  const ourAborts = new Map(); const blockedFails = []; const allowedFails = [];
  // the guard's own stops that a store page may depend on (a cart write in no-cart mode, a write to a shared endpoint that names no known
  // cart operation, a redirect to another origin, a socket, a worker started without the guard): a journey that then fails is a tool
  // limit, not the store's fault. guard_kinds keeps the kind of each ('dispatch' makes any quit a tool limit; a no-cart write only a quit in
  // the same step, see quit). guardAt keeps the time of the latest stop of each kind.
  j.guard_interventions = []; j.guard_kinds = []; const guardAt = {};
  // guardStops counts every stop of the panel's own guard and every named rule hit on the store's own or an allowed host, so a cart
  // check can tell whether a request it needed was stopped while it ran (see stopMark)
  let guardStops = 0;
  const intervention = (what, kind = 'other') => { guardStops++; guardAt[kind] = sec(); if (!j.guard_kinds.includes(kind)) j.guard_kinds.push(kind); if (j.guard_interventions.length < 20 && !j.guard_interventions.includes(what)) j.guard_interventions.push(what); };
  // the interaction policy (lib.interactionRefusal) refused an element: terminal, the journey ends as a tool limit and nothing is forced
  class Refused extends Error { constructor(what, why) { super(`the panel refused to touch ${what}: ${why}`); this.refusal = { what, why }; } }
  // a checkout the page showed right after one of the panel's own taps (or found right before the journey would succeed): a safety stop.
  // The journey ends as a tool limit with a SAFETY finding, never as a success.
  class SafetyStop extends Error { constructor(what, how) { super(`safety stop after ${what}: ${how}`); this.safety = { what, how }; } }
  const revealAfter = async (what, pg = null) => {
    // let the tap's own queued work run first (a details "toggle" event, a click handler's setTimeout, the next frame), so a checkout
    // the tap reveals a moment later is still seen here; capped at 1 s
    if (pg) await Promise.race([pg.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(() => setTimeout(r, 50)), 0))).catch(() => {}), sleep(1000)]);
    const shown = await Promise.race([lib.checkoutShownInContext(ctx).catch(() => null), sleep(4000).then(() => null)]);
    if (shown) { j.checkout_revealed = { after: lib.oneLine(what, 60), how: lib.oneLine(shown, 160) }; throw new SafetyStop(what, shown); }
  };
  // a checkout the page shows by itself, with no request (a hash route, history.pushState, an about:blank pop-up): stop before any tap,
  // and before the panel opens a closed product section (that is a click too)
  const revealCheck = async (what) => {
    const shown = j.checkout_shown || await Promise.race([lib.checkoutShownInContext(ctx).catch(() => null), sleep(4000).then(() => null)]);
    if (shown) { j.checkout_shown = shown; j.interaction_refused = { what: lib.oneLine(what, 60), why: `the page is showing a checkout by itself (${lib.oneLine(shown, 120)})` }; throw new Refused(what, j.interaction_refused.why); }
  };
  const policy = async (loc, what) => {
    if (j.interaction_refused) throw new Refused(what, 'an earlier element was refused, so the journey ends');
    await revealCheck(what);
    const info = await loc.evaluate(lib.readInteraction, null, { timeout: 3000 }).catch(() => null);
    if (!info && !(await loc.count().catch(() => 0))) return { missing: true };
    const why = lib.interactionRefusal(info);
    if (why) { j.interaction_refused = { what: lib.oneLine(what, 60), why }; throw new Refused(what, why); }
    return { missing: false };
  };
  let page;
  await lib.installGuard(ctx, {
    state: guard, getPage: () => page, blockRules, allowHosts, ownHosts, landingPaths: new Set([new URL(startUrl).pathname]),
    // SP_TEST_SKIP_WORKER_GUARD: offline tests only (loopback --url), to check that a worker without the guard is closed and reported
    skipWorkerGuardForTest: loopback && !!process.env.SP_TEST_SKIP_WORKER_GUARD,
    // SP_TEST_NO_ROUTE_GUARD: offline tests only (loopback --url), so the browser-level guard is tested on its own
    testNoRouteGuard: TEST_NO_ROUTE_GUARD,
    delayMs: 0,
    throttle: net.down_kbps ? { down_kbps: net.down_kbps, latency_ms: net.latency_ms || 0 } : null,
    onCheckout: (rec) => {
      // a top-page load the runner itself started (its tapped link or form, or any redirect hop of it), stopped before the Checkout tap,
      // whatever the reason: a checkout (a store that skips the cart) is recorded as such, anything else as the after-cart rule's stop
      const ownNav = rec.main_frame && pendingNav && pendingNav.href && !j.own_nav_stopped && !j.skip_cart_stop && Date.now() - pendingNav.at < 30000
        && [rec.url, rec.request_url, ...(rec.hops || []).map((h) => h.url)].some((u) => u && samePage(u, pendingNav.href));
      if (ownNav) {
        if (/^(a page load after the cart was touched|unknown redirect target)/.test(String(rec.why || ''))) j.own_nav_stopped = { url: rec.url, why: rec.why };
        else j.skip_cart_stop = { method: rec.method, url: rec.url, why: rec.why, reached_server: !!rec.reached_server, tapped: pendingNav.what || null };
      }
      const k = rec.request_url || rec.url; ourAborts.set(k, (ourAborts.get(k) || 0) + 1); delete rec.request_url;
      rec.at_seconds = sec();
      j.checkout_blocked.push(rec);
      // a checkout, payment or login request the page made on its own (the runner never taps Checkout): the step then fails as a tool limit
      if (!ownNav) intervention(`${rec.method || 'GET'} ${lib.stripQuery(rec.url).replace(/^https?:\/\/[^/]+/, '') || '/'} stopped at the hard line (${lib.oneLine(rec.why, 80)})`, 'hard');
    },
    // a request the guard stopped for a reason of its own (a redirect to another origin, a socket, a shared endpoint write it cannot read)
    onIntervention: (d) => { const k = lib.stripQuery(d.url); ourAborts.set(k, (ourAborts.get(k) || 0) + 1); intervention(lib.oneLine(d.what, 200), d.kind === 'dispatch' ? 'dispatch' : String(d.kind || 'other')); },
    onSpeculative: () => { j.speculation_blocked++; },
    // --no-cart: the page's own attempts to write to the cart are stopped (best effort); otherwise a cart write the page makes on its
    // own (before the shopper tapped Add to cart) is noted, and the test cart is left as it is
    noCart: !CART_MODE,
    onCartWrite: (d) => { const k = lib.stripQuery(d.url); ourAborts.set(k, (ourAborts.get(k) || 0) + 1); intervention(`a cart write the page made (${d.method} ${d.url.replace(/^https?:\/\/[^/]+/, '') || '/'}), stopped because this run does not use the cart`, 'no-cart-write'); j.cart_writes_stopped++; if (j.cart_writes_stopped_list.length < 20) j.cart_writes_stopped_list.push({ method: d.method, url: d.url, kind: d.kind, at_seconds: sec() }); },
    onCartTouched: (_u, info) => { if (!j.cart_touched) { j.cart_touched = true; j.cart_touched_by_page = true; } if (info && !info.adds) j.cart_written_without_add = true; },
    onRuleOnAllowed: (d) => { guardStops++; if (j.rule_hits_on_allowed.length < 20) j.rule_hits_on_allowed.push({ rule: d.rule, url: d.url, own_host: d.own, kind: d.resourceType }); },
    // R27: a dropped background write a cart check may have needed (a keepalive POST to /cart/update.js, say), on the store's own or an
    // allowed host, counts as a guard stop with its method and address, like a stop at the route guard
    onBeacon: (d) => { const bm = d.method || (d.kind === 'beacon' ? 'POST' : ''); let bh = ''; try { bh = new URL(d.url).hostname; } catch {}
      if (bh && (lib.isOwnHost(bh, ownHosts) || lib.isAllowedThirdParty(bh, allowHosts)) && lib.cartCheckDrop(d.url, bm || 'POST')) intervention(`${bm || 'POST'} ${d.url.replace(/^https?:\/\/[^/]+/, '') || '/'} dropped by the page's background-request guard (${d.kind})`, 'background');
      if (!CART_MODE && lib.isCartWriteCall(d.url)) { j.cart_writes_stopped++; if (j.cart_writes_stopped_list.length < 20) j.cart_writes_stopped_list.push({ method: bm || 'POST', url: d.url, kind: d.kind, at_seconds: sec() }); } j.beacons_dropped++; if (j.unload_dropped.length < 20) j.unload_dropped.push({ kind: d.kind, method: bm || null, url: d.url, layer: 'page script' }); },
    onThirdParty: ({ blocked: isBlocked, name, host, url }) => {
      if (isBlocked) {
        if (url) { const k = lib.stripQuery(url); ourAborts.set(k, (ourAborts.get(k) || 0) + 1); }
        j.blocked++; j.by_rule[name] = (j.by_rule[name] || 0) + 1;
        if (host) j.blocked_hosts[host] = (j.blocked_hosts[host] || 0) + 1;
      } else if (host) j.allowed_hosts[host] = (j.allowed_hosts[host] || 0) + 1;
    },
  });
  const myNet = {}; netOwner = myNet;
  netPolicy = { blockRules, allowHosts, ownHosts, noCart: !CART_MODE, guard };
  // Stops by the Chromium browser-level guard (requests that got past ctx.route, such as beacons and keepalive requests from a closing
  // page) go into the same counts as route stops, and are marked as ours so the page's resulting "Failed to fetch" is never blamed on the store.
  netDrop = (d) => {
    const k = lib.stripQuery(d.url); ourAborts.set(k, (ourAborts.get(k) || 0) + 1);
    j.unload_blocked++;
    if (j.unload_dropped.length < 20) j.unload_dropped.push({ kind: d.resourceType === 'Ping' ? 'beacon' : (d.resourceType || 'request').toLowerCase(), url: k, why: d.why, layer: 'browser network guard' });
    if (d.kind === 'hard') { j.checkout_blocked.push({ method: d.method, url: k, why: `${lib.oneLine(d.why, 120)} (stopped by the browser network guard)`, main_frame: false, reached_server: false, hops: [], at_seconds: sec() }); intervention(`${d.method || 'GET'} ${k.replace(/^https?:\/\/[^/]+/, '') || '/'} stopped at the hard line by the browser network guard`, 'hard'); }
    else if (d.kind === 'dispatch') intervention(`${d.method || ''} ${k.replace(/^https?:\/\/[^/]+/, '') || '/'} stopped by the browser network guard (${lib.oneLine(d.why, 120)})`, 'dispatch');
    else if (d.kind === 'halt' || d.kind === 'error') intervention(`${d.method || ''} ${k.replace(/^https?:\/\/[^/]+/, '') || '/'} stopped by the browser network guard (${lib.oneLine(d.why, 80)})`, d.kind);
    else {
      const name = d.rule || 'not-allow-listed';
      if (d.host && (lib.isOwnHost(d.host, ownHosts) || lib.isAllowedThirdParty(d.host, allowHosts))) guardStops++;
      if (d.rule && !d.ruleIsEndpoint && d.host && (lib.isOwnHost(d.host, ownHosts) || lib.isAllowedThirdParty(d.host, allowHosts)) && j.rule_hits_on_allowed.length < 20) j.rule_hits_on_allowed.push({ rule: d.rule, url: k, own_host: lib.isOwnHost(d.host, ownHosts), kind: String(d.resourceType || '').toLowerCase() });
      j.blocked++; j.by_rule[name] = (j.by_rule[name] || 0) + 1;
      if (d.host && !lib.isOwnHost(d.host, ownHosts)) j.blocked_hosts[d.host] = (j.blocked_hosts[d.host] || 0) + 1; // own host is never listed, as with route stops
    }
  };
  page = await ctx.newPage();
  if (process.env.SP_DEBUG) for (const m of ['evaluate', 'waitForURL', 'waitForLoadState', 'title', 'content', 'goto']) { const o = page[m].bind(page); page[m] = async (...x) => { const t = Date.now(); try { return await o(...x); } finally { if (Date.now() - t > 1500) dbg(`slow ${m} ${Date.now() - t}ms ${String(x[0]).slice(0, 70).replace(/\s+/g, ' ')}`); } }; }
  // measured in every tab and every frame, by address and by page content
  j.checkout_loaded_how = null; j.new_tabs = 0;
  lib.watchContext(ctx, (how) => { j.checkout_page_loaded = true; if (!j.checkout_loaded_how) j.checkout_loaded_how = how; }, (p) => { j.new_tabs++; watchWorkers(p); }, (how) => { if (!j.checkout_shown) j.checkout_shown = how; });
  // Every worker a page starts must carry the panel's guard (see lib.workerGuardFn). One that does not (a worker started inside an
  // opaque sandboxed frame on WebKit, which the page-side wrapper cannot reach) is closed at once and the journey becomes a tool limit:
  // it may have run for a moment before it was closed.
  function watchWorkers(p) {
    p.on('worker', async (w) => {
      const ok = await w.evaluate(() => self.__spSocketGuard === true).catch(() => null);
      if (ok !== false) return;
      j.unguarded_workers = (j.unguarded_workers || 0) + 1;
      intervention(`a web worker started without the panel's guard (${lib.stripQuery(w.url()).slice(0, 80)}) and was closed`);
      await w.evaluate(() => self.close()).catch(() => {});
    });
  }
  watchWorkers(page);
  // the page's network speed; offline stays on (as ctx.setOffline set it) so a request that bypasses the route guard fails, unless the
  // route guard is off for a test (then nothing would serve the page)
  if (net.down_kbps) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: !TEST_NO_ROUTE_GUARD, latency: net.latency_ms || 0, downloadThroughput: (net.down_kbps * 1024) / 8, uploadThroughput: ((net.up_kbps || net.down_kbps) * 1024) / 8 });
  }
  page.on('requestfailed', (r) => {
    const k = lib.stripQuery(r.url()); const n = ourAborts.get(k) || 0;
    // A request the browser itself cancelled (net::ERR_ABORTED in Chromium, "cancelled" in WebKit) never surfaces as "Failed to fetch",
    // so it does not count as an allowed request failing.
    const cancelled = /ERR_ABORTED|^cancell?ed$/i.test(String(r.failure()?.errorText || ''));
    if (n > 0) { ourAborts.set(k, n - 1); blockedFails.push(Date.now()); } else if (!cancelled) allowedFails.push(Date.now());
    dbg(`requestfailed ${k} ours=${n > 0} ${r.failure()?.errorText}`);
  });
  // A script error is set aside only when (a) its message or stack names a blocked third-party host, or (b) it is a bare network failure
  // ("Failed to fetch", "Load failed", also with WebKit's "Unhandled Promise Rejection: " prefix for an uncaught one) within about 2s after a request this run blocked, with no allowed request failing in that window.
  // Errors the panel itself causes: Playwright's serviceWorkers: 'block' makes reading navigator.serviceWorker throw in sandboxed frames,
  // and the init script's refusal of register() is an uncaught rejection when a page does not catch it.
  const TEST_BROWSER_ERRORS = /^(?:Unhandled Promise Rejection: |Uncaught \(in promise\) )?(?:SecurityError: )?(?:Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed|Service Worker is disabled because the context is sandboxed|Service workers are turned off by the shopper panel)/;
  const BARE_NETWORK = /^(?:Unhandled Promise Rejection: |Uncaught \(in promise\) )?(?:TypeError: )?(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/i;
  page.on('pageerror', async (e) => {
    const m = lib.oneLine(e && (e.message || e.name) ? `${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message || ''}` : `a script failed with no message (${String(e)})`, 200);
    const blob = `${m} ${String((e && e.stack) || '')}`;
    const hostsIn = [...blob.matchAll(/(?:https?:)?\/\/([a-z0-9.-]+)/gi)].map((x) => x[1].toLowerCase());
    const viaStack = hostsIn.find((h) => j.blocked_hosts[h]);
    if (TEST_BROWSER_ERRORS.test(m)) { j.filtered_errors.push({ message: m, host: '(the test browser)', via: 'service worker unavailable in this frame (test browser blocks service workers)' }); return; }
    if (viaStack) { j.filtered_errors.push({ message: m, host: viaStack, via: 'blocked third-party host named in the error' }); return; }
    if (BARE_NETWORK.test(m)) {
      const t = Date.now(); await sleep(150);
      const inWin = (x) => x >= t - 2000;
      dbg(`bare network error ${m} blocked=${blockedFails.filter(inWin).length} allowed=${allowedFails.filter(inWin).length}`);
      if (blockedFails.some(inWin) && !allowedFails.some(inWin)) { j.filtered_errors.push({ message: m, host: '(request blocked by this run)', via: 'bare network failure right after a request this run blocked' }); return; }
    }
    j.script_errors.push({ at: lib.stripQuery(page.url()), message: m });
  });

  const shot = async (stepName) => {
    shotN++;
    const file = path.join(shotsDir, `${tag}-${String(shotN).padStart(2, '0')}-${lib.slug(stepName, 30)}.jpg`);
    dbg(`shot ${stepName}`); await page.screenshot({ path: file, type: 'jpeg', quality: 60, timeout: 15000 }).catch((e) => dbg(`shot fail ${String(e.message).slice(0, 200)}`)); dbg('shot done');
    return fs.existsSync(file) ? rel(file) : null;
  };
  const step = async (name, ok, detail, { snap = true } = {}) => {
    const s = { step: name, at_seconds: sec(), ok, detail, screenshot: snap ? await shot(name) : null };
    j.steps.push(s); return s;
  };
  // Quits a missing request could cause: a page that did not load or was not usable in time, an element the panel did not find, or
  // a step the panel could not read. Content quits (required info missing, sold out, the price past the persona's screens, a price
  // element that shows no amount, the persona's own tap limit, something covering a button) are about what the page shows.
  const REQUEST_SENSITIVE = (stepName, kind) => ['error', 'not_found', 'test_limit'].includes(kind) || (kind === 'patience_exceeded' && ['arrive', 'pick a product'].includes(stepName));
  // topic: what exactly stopped them (for a missing need, the need itself), so "What to fix first" never merges different problems.
  const quit = async (stepName, kind, reason, severity = 'block', topic = null) => {
    // The panel's own safety rule stopped a page load the runner itself started (its tapped link or form): whatever the step then saw
    // (a slow page, a missing button) was caused by the test, so the journey ends as a tool limit, never as a result about the store.
    // an element the interaction policy refused ends the journey as a tool limit (never forced, never a store result)
    if (j.interaction_refused && !['rate_limited', 'test_error', 'test_limit'].includes(kind)) {
      j.quit_original_kind = kind;
      reason = `the panel refused to touch ${lib.oneLine(j.interaction_refused.what, 60)} (${lib.oneLine(j.interaction_refused.why, 160)}). Nothing was forced; this is a limit of the test tool, not a shopper quit; the run is INCOMPLETE`;
      kind = 'test_limit'; severity = 'warn'; topic = 'the panel refused to touch an element';
    }
    const ons = j.own_nav_stopped || j.skip_cart_stop;
    if (ons && !['rate_limited', 'test_error'].includes(kind)) {
      if (kind !== 'test_limit') j.quit_original_kind = kind;
      reason = `the panel's safety rule stopped this page load: ${q(ons.url.replace(/^https?:\/\/[^/]+/, '') || '/', 100)} (${lib.oneLine(ons.why, 160)}). This is a limit of the test tool, not a result about the store; the run is INCOMPLETE`;
      kind = 'test_limit'; severity = 'warn'; topic = 'the panel\'s safety rule stopped a page load the shopper tapped';
    }
    // A named rule (not an endpoint rule) stopped something on the store's own host or an allow-listed host. If the quit is one a
    // missing request could cause, the test may have caused it, so it is a tool limit (run INCOMPLETE), never blamed on the store.
    // A content quit keeps its kind and severity, with a caveat naming the rule.
    if (j.rule_hits_on_allowed.length && !['rate_limited', 'test_error'].includes(kind)) {
      const names = [...new Set(j.rule_hits_on_allowed.map((x) => x.rule))];
      const ex = j.rule_hits_on_allowed[0];
      const what = `the named block rule${names.length > 1 ? 's' : ''} ${names.map((n) => q(n, 40)).join(', ')} stopped ${j.rule_hits_on_allowed.length} request(s) on the store's own or an allowed host during this journey (first: ${q(ex.url.replace(/^https?:\/\/[^/]+/, ''), 80)})`;
      if (REQUEST_SENSITIVE(stepName, kind)) {
        reason = `${reason}; but ${what}, so the test may have caused this${/limit of the test tool/.test(reason) ? '' : '. This is a limit of the test tool, not a shopper quit; the run is INCOMPLETE'}. Check that rule in scripts/blocklist.json or your block_rules`;
        if (kind !== 'test_limit') j.quit_original_kind = kind;
        kind = 'test_limit'; severity = 'warn';
      } else {
        reason = `${reason} (caveat: ${what}; this quit is about what the page shows, so it stands, but check that rule in scripts/blocklist.json or your block_rules)`;
        j.quit_rule_caveat = names;
      }
    }
    // The panel's own guard stopped a request the page made (a cart write in no-cart mode, a request after the Checkout tap, a redirect
    // to another origin, an event stream, a worker without the guard). A quit a missing request could cause is then a tool limit; a
    // content quit keeps its kind with a caveat (quit_guard_caveat).
    if (j.guard_interventions.length && !['rate_limited', 'test_error'].includes(kind) && kind !== 'test_limit') {
      const what = `the panel's own guard stopped ${j.guard_interventions.length === 1 ? 'a request' : `${j.guard_interventions.length} requests`} the page made (first: ${lib.oneLine(j.guard_interventions[0], 160)})`;
      // a request the dispatch rule stopped (an unknown operation, a batch or a persisted query sent to a shared endpoint such as GraphQL
      // or admin-ajax) may have been a read the page needed, so any quit after one is a tool limit; a write the page made that browse
      // only (--no-cart) stopped makes a quit a tool limit only when it happened in the step that failed (since the last recorded step)
      const stepFrom = j.steps.length ? j.steps[j.steps.length - 1].at_seconds : 0;
      const dispatched = j.guard_kinds.includes('dispatch') || (!CART_MODE && guardAt['no-cart-write'] != null && guardAt['no-cart-write'] >= stepFrom);
      if (REQUEST_SENSITIVE(stepName, kind) || dispatched) {
        j.quit_original_kind = kind;
        reason = dispatched
          ? `${reason}; but the panel stopped requests this store's pages make (${what}), so the test may have caused this. This is a limit of the test tool, not a shopper quit; the run is INCOMPLETE`
          : `${reason}; but ${what}, so the test may have caused this. This is a limit of the test tool, not a shopper quit; the run is INCOMPLETE`;
        kind = 'test_limit'; severity = 'warn';
      } else {
        reason = `${reason} (caveat: ${what}; this quit is about what the page shows, so it stands, but the stopped request may have changed the page)`;
        j.quit_guard_caveat = true;
      }
    }
    // a test error or a rate limit says nothing about the store: listed under test problems, never counted as a blocking finding
    if (['test_error', 'rate_limited'].includes(kind) && severity === 'block') severity = 'test';
    const s = await step(stepName, false, reason);
    j.quit_step = stepName; j.quit_kind = kind; j.quit_reason = reason; j.quit_severity = severity; j.quit_topic = topic || lib.oneLine(String(reason).split(persona.name).join('the shopper').replace(/\d+(?:\.\d+)?/g, '#'), 200);
    const label = j.store_unreachable ? 'could not start' : lib.ERROR_KINDS.includes(kind) ? 'was not tested properly' : 'quit';
    finding(severity, `${persona.name} ${label}: ${reason}`, `step "${stepName}"`, s.screenshot);
    return false;
  };
  // A tap Playwright says is covered: the covering element, unless the element is on top in the page itself on a page wider
  // than the phone screen (then the tap check is misaligned: a test tool limit, and the sideways page is a store finding)
  const coverOf = async (loc, msg, what) => {
    const covered = lib.coverFrom(msg);
    if (!covered) return { covered: null, misaligned: null };
    const h = await Promise.race([loc.evaluate(lib.hitCheck).catch(() => null), sleep(4000).then(() => null)]);
    if (!h) return { covered, misaligned: null };
    if (!j.too_wide) { j.too_wide = h; finding('warn', `The page is wider than the phone screen (${h.pageWidth}px on a ${h.screen}px screen), so it scrolls sideways`, 'layout'); }
    return { covered: null, misaligned: `the page is wider than the phone screen (${h.pageWidth}px on a ${h.screen}px screen), so the browser's tap check could not line up with the ${what}; nothing covers it in the page itself. This is a limit of the test tool, not a shopper quit; the run is INCOMPLETE` };
  };
  const tapKind = (r) => (r.covered ? 'element_covered' : r.misaligned ? 'test_limit' : 'error');
  const tap = async (loc, what, opts = {}) => {
    dbg(`tap ${what}`); await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    // every tap passes the interaction policy first (a refusal throws Refused: terminal, never forced); a missing element is not tapped
    if ((await policy(loc, what)).missing) return { ok: false, covered: null, msg: `no ${what} was found to tap`, what };
    // the tap marker: for a submit button of a POST form, the form's action (see installGuard: once the cart is touched, that form post
    // is the only one allowed, and only to a page the after-cart rule allows or to /cart/add; every GET is checked by the rule whoever
    // started it). The mark is dropped once the tap has settled, so a later self-submitting form cannot use it.
    const dest = await loc.evaluate((e) => { const a = e.closest('a[href]'); if (a) return { href: a.href, get: true }; const f = e.form || e.closest('form'); return f && f.action ? { href: f.action, get: (f.method || 'get').toLowerCase() !== 'post' } : null; }, null, { timeout: 3000 }).catch(() => null);
    pendingNav = dest && /^https?:/i.test(dest.href) ? { ...dest, what, at: Date.now() } : null;
    guard.deliberate = lib.tapMark(await lib.tapDestination(loc));
    const settle = async () => { if (guard.cartFrom) for (let i = 0; i < 20 && guard.deliberate; i++) await sleep(50); guard.deliberate = 0; };
    try {
      await loc.click({ timeout: 8000 }); await settle(); if (!opts.uncounted) j.taps++; dbg('tap done');
      // every activating tap is followed by a scan: a checkout the tap revealed (a drawer, a panel, a hash route) is a safety stop
      await revealAfter(what, loc.page());
      // once the cart is touched the after-cart rule may stop the tap's own page load; give the guard a moment to see the request
      if (pendingNav && guard.cartFrom) for (let i = 0; i < 8 && !j.own_nav_stopped && !j.skip_cart_stop; i++) await sleep(100);
      if (j.skip_cart_stop) return { ok: false, skipCart: true, msg: `the tap led straight to checkout (${lib.oneLine(j.skip_cart_stop.why, 120)})`, what };
      if (j.own_nav_stopped) return { ok: false, guardStop: true, msg: `the panel's safety rule stopped the page load (${lib.oneLine(j.own_nav_stopped.why, 120)})`, what };
      return { ok: true };
    } catch (e) { guard.deliberate = 0; if (e && e.safety) throw e; dbg(`tap fail ${String(e.message).slice(0, 200)}`);
      const msg = String(e.message);
      const c = await coverOf(loc, msg, what);
      return { ok: false, covered: c.covered, misaligned: c.misaligned, msg: c.misaligned || lib.oneLine(msg.split('\n')[0], 160), what };
    }
  };
  // A store that skips the cart: the runner's own view-cart tap, cart icon tap or Add to cart led straight to a checkout, payment or
  // login address, which the guard stopped before any request reached the store. The panel never saw a Checkout button in a cart, so
  // this is never counted as reaching checkout: every successful cart journey passes the regular Checkout check. The journey ends as a
  // tool limit (the run is INCOMPLETE), keeping the category of what was blocked (checkout, payment or login).
  const skipCartEnd = async (stepName, lead) => {
    const sc = j.skip_cart_stop; j.skip_cart_stop = null;
    const why = String(sc.why || '');
    const category = /^login\b/i.test(why) ? 'login' : /^payment\b/i.test(why) ? 'payment' : 'checkout';
    j.cart_skipped_to_checkout = { via: lead, url: sc.url, why: sc.why, category };
    const path = sc.url.replace(/^https?:\/\/[^/]+/, '') || '/';
    return await quit(stepName, 'test_limit', `${lead} led straight to a ${category} address (${q(path, 100)}, ${lib.oneLine(why, 160)}), which the panel's safety rule stopped inside the test browser. The panel never found a Checkout button in a cart, so this journey cannot count as reaching checkout. This is a limit of the test tool, not a result about the store; the run is INCOMPLETE`, 'warn', `the shopper's tap led straight to a ${category} address`);
  };
  // the store's real cart address, read before the add (see lib.learnCartUrl), so a cart page at a slug of the store's own
  // (/shopping-cart/, /my-cart/) may load after the cart action
  const learnCartUrls = async () => {
    const cands = await page.evaluate(() => {
      const out = []; const add = (v) => { if (typeof v === 'string' && v) out.push(v); };
      try { add(window.wc_add_to_cart_params && window.wc_add_to_cart_params.cart_url); } catch (e) {}
      try { const w = window.wcSettings; if (w) { add(w.cartUrl); add(w.storePages && w.storePages.cart && w.storePages.cart.permalink); } } catch (e) {}
      try { add(window.Shopify && window.Shopify.routes && window.Shopify.routes.cart_url); add(window.routes && window.routes.cart_url); } catch (e) {}
      for (const a of document.querySelectorAll('a.cart-contents[href], a#cart-icon-bubble[href], a.wc-forward[href]')) add(a.getAttribute('href'));
      for (const a of document.querySelectorAll('a[aria-label][href]')) if (/^\s*(view |open )?(my |your )?(shopping )?(cart|basket|bag)\b/i.test(a.getAttribute('aria-label'))) add(a.getAttribute('href'));
      for (const a of document.querySelectorAll('a[href]')) if (/^\s*view (my )?(cart|basket|bag)\s*$/i.test(a.innerText || '')) add(a.getAttribute('href'));
      return out.slice(0, 16);
    }).catch(() => []);
    for (const c of cands) lib.learnCartUrl(guard, c, page.url(), ownHosts);
    if (guard.cartUrls.length) dbg(`cart urls ${guard.cartUrls.join(' ')}`);
  };
  const vh = dev.ctx.viewport.height;
  // "0.4 screens down", "1 screen down", "2.5 screens down": one wording for every distance down the page (one screen = one phone viewport)
  const screensDown = (px) => { const n = +(Math.max(0, px) / vh).toFixed(1); return `${n} screen${n === 1 ? '' : 's'} down`; };
  const scrollTo = async (y) => {
    const before = await page.evaluate(() => scrollY).catch(() => 0);
    await page.evaluate((yy) => window.scrollTo(0, yy), y).catch(() => {}); await sleep(300);
    const after = await page.evaluate(() => scrollY).catch(() => before);
    j.screens_scrolled += Math.abs(after - before) / vh;
  };
  const coverCheck = () => page.evaluate(() => {
    const vis = (e) => { const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.05; };
    return [...document.querySelectorAll('body *')].filter((e) => {
      const s = getComputedStyle(e); if (s.position !== 'fixed' || !vis(e)) return false;
      const b = e.getBoundingClientRect();
      return b.width * b.height > innerWidth * innerHeight * 0.25 && b.top < innerHeight && b.bottom > 0;
    }).map((e) => ({ sel: e.getAttribute('id') ? `#${e.getAttribute('id')}` : String(e.className || e.tagName).trim().split(/\s+/).slice(0, 2).map((c) => `.${c}`).join(''), text: (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80) }));
  }).catch(() => []);
  const handlePopups = async (where) => {
    let covers = await coverCheck();
    if (!covers.length) return true;
    const what = covers.map((c) => `${c.sel}${c.text ? ` (${q(c.text, 60)})` : ''}`).join(', ');
    if ((persona.popups || 'close-once') === 'leave') return quit(where, 'element_covered', `a pop-up covered the page and ${persona.name} does not close pop-ups: ${what}`);
    const tries = persona.popups === 'close-always' ? 3 : 1;
    for (let i = 0; i < tries && covers.length; i++) {
      // A shopper taps the X, "No thanks" or "Dismiss" first, then "Decline". Never Accept, Agree, OK, Continue or Sign up.
      // Never taps anything inside a form that asks for an email or phone number, and never a submit button (an explicit type="submit"
      // or a button with no type attribute, which also submits its form).
      const found = await page.evaluate(() => {
        document.querySelectorAll('[data-sp-close]').forEach((e) => e.removeAttribute('data-sp-close'));
        const layers = [...document.querySelectorAll('body *')].filter((e) => { const st = getComputedStyle(e); const b = e.getBoundingClientRect(); return st.position === 'fixed' && st.display !== 'none' && st.visibility !== 'hidden' && b.width * b.height > innerWidth * innerHeight * 0.25; });
        const order = [/^(close|dismiss|close (dialog|popup|pop-up|modal)|×|✕|✖|x)$/i, /^(no,? thanks|no thank you|not now|maybe later)$/i, /^(decline|reject( all)?|deny)$/i];
        const hasContactForm = (x) => { const f = x.closest('form'); return !!(f && f.querySelector('input[type="email"], input[type="tel"], input[name*="email" i], input[name*="phone" i]')); };
        const submits = (x) => x.tagName === 'BUTTON' && x.form && (x.getAttribute('type') || 'submit').toLowerCase() === 'submit';
        for (const r of order) for (const L of layers) {
          const b = [...L.querySelectorAll('button, a, [role="button"], input[type="submit"]')].find((x) => x.getClientRects().length && !hasContactForm(x) && !submits(x) && !(x.tagName === 'INPUT') && (r.test((x.getAttribute('aria-label') || '').trim()) || r.test((x.innerText || '').trim())));
          if (b) { b.setAttribute('data-sp-close', '1'); return (b.getAttribute('aria-label') || b.innerText || '').trim().slice(0, 30); }
        }
        return null;
      }).catch(() => null);
      if (!found) break;
      await tap(page.locator('[data-sp-close]').first(), 'close pop-up');
      for (let w = 0; w < 10; w++) { await sleep(500); covers = await coverCheck(); if (!covers.length) break; }
    }
    if (covers.length) return quit(where, 'element_covered', `a pop-up covered the page and ${persona.name} could not close it with a close, no thanks or decline button (pop-ups with an email or phone form are never touched): ${what}`);
    const s = await step(`${where}: pop-up closed`, true, what);
    finding('warn', `A pop-up covered the page; ${persona.name} had to close it`, where, s.screenshot);
    return true;
  };
  // discount codes the store shows on its own pages ("use code X", "code: X"), read from what is visible; never guessed (lib.extractStoreCodes)
  const storeCodes = [];
  const collectCodes = async () => {
    if (!CART_MODE || storeCodes.length >= 3) return;
    const t = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 200000) : '')).catch(() => '');
    for (const c of lib.extractStoreCodes(t)) if (!storeCodes.includes(c) && storeCodes.length < 3) storeCodes.push(c);
  };
  const detectPlatform = () => page.evaluate(() => (window.Shopify ? 'shopify' : (document.body && /\bwoocommerce\b/.test(document.body.className)) || document.querySelector('form.cart, .woocommerce') ? 'woocommerce' : 'unknown')).catch(() => 'unknown');
  // the cart count from the platform's own cart API (Shopify /cart.js, WooCommerce Store API). null = unknown, never 0.
  // checkout content in any frame of any tab, read now (not only when a frame loads)
  const rescanForCheckout = async () => {
    for (const p of ctx.pages()) for (const f of p.frames()) {
      let u = ''; try { u = f.url(); } catch {}
      if (!/^https?:/.test(u)) continue;
      const c = await f.evaluate(lib.checkoutContentInPage).catch(() => null);
      if (c) { j.checkout_page_loaded = true; if (!j.checkout_loaded_how) j.checkout_loaded_how = `checkout content (${c}) at ${lib.stripQuery(u)}`; }
    }
  };
  const cartCount = async () => {
    dbg('cartCount');
    for (let i = 0; i < 4; i++) {
      try { const r = await Promise.race([page.evaluate(lib.readCartCount, j.platform), sleep(8000).then(() => { throw new Error('cart count read timed out'); })]); dbg('cartCount read'); if (r.source) j.cart_count_source = r.source; return r.count; } catch { await page.waitForLoadState('domcontentloaded').catch(() => {}); await sleep(500); }
    }
    return null;
  };
  const shape = async () => {
    const s = await page.evaluate(lib.readPageShape, lib.SEL).catch(() => ({ addForms: 0, ld: [] }));
    const ld = lib.ldProductInfo(s.ld);
    return { ...lib.decideProductPage({ url: page.url(), ldMain: ld.isMain, addForms: s.addForms }), ld };
  };
  const loadSeconds = persona.patience.load_seconds;
  const gotoMs = Math.max(loadSeconds * 3, 30) * 1000;
  // Usable = a visible heading (h1, h2, role=heading, the product title or the ld+json name) and a loaded photo. Returns
  // { ok, toolMiss }: toolMiss means the page clearly loaded (a photo or plenty of text) but the panel's own checks did not
  // recognise it, which is a tool limit, never a shopper quit.
  // the status of the latest page load in the main frame, so a "Page not found" can be reported as a broken link
  let docStatus = 0;
  page.on('response', (res) => { try { const r = res.request(); if (r.isNavigationRequest() && r.frame() === page.mainFrame()) docStatus = res.status(); } catch {} });
  // A page that says it was not found: HTTP 404 or 410, or a page whose title or main heading says "Page not found" or "404"
  const notFoundPage = async () => {
    if (docStatus === 404 || docStatus === 410) return `HTTP ${docStatus}`;
    const t = await page.evaluate(() => `${document.title} | ${(document.querySelector('h1') || {}).innerText || ''}`).catch(() => '');
    return /\b(?:page not found|not found|404)\b/i.test(t) ? 'the page says "Page not found"' : null;
  };
  // Once a named rule has stopped a request on the store's own or an allowed host, any quit a missing request could cause is a tool
  // limit whatever the timing, so the wait stops at the persona's own patience (plus 2 s) instead of the full page-load timeout.
  const ruleHit = () => j.rule_hits_on_allowed.length > 0;
  const waitUsable = async (ms) => {
    if (ruleHit()) ms = Math.min(ms, loadSeconds * 1000 + 2000);
    const ok = await page.waitForFunction(`(${lib.readUsable.toString()})().ok`, null, { timeout: Math.max(1000, ms) }).then(() => true).catch(() => false);
    if (ok) return { ok: true, toolMiss: false };
    const u = await page.evaluate(lib.readUsable).catch(() => null);
    return { ok: false, toolMiss: !!u && (u.img || (u.anyImg && u.textChars > 200) || (!!u.heading && u.textChars > 200)), shape: u };
  };
  // A page that loaded but whose first photo did not show (the case a busy test computer causes most) is reloaded once before it
  // becomes a tool limit; the time is then counted from the reload, and a note says it happened. Returns the new start time or null.
  const reloadOnce = async (where) => {
    dbg(`reload once at ${where}`);
    const t = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: gotoMs }).catch(() => {});
    dbg(`reloaded in ${Date.now() - t}ms`);
    const again = await waitUsable(gotoMs - (Date.now() - t));
    dbg(`usable after reload: ${again.ok}`);
    if (!again.ok) return { usable: again, t: null };
    j.reloaded_once = (j.reloaded_once || 0) + 1;
    finding('note', `At "${where}" the page's first photo did not show on the first try, so the panel reloaded the page once; the time shown is from the reload (a busy test computer can cause this, not only the store)`, where);
    return { usable: again, t };
  };
  const notRecognised = (u) => `the page loaded but the panel could not recognise its ${!u?.heading ? 'heading' : 'photo'}${!u?.heading && !u?.img ? ' or photo' : ''}. This is a limit of the test tool, not a shopper quit; the run is INCOMPLETE (please report the page type)`;
  const challengeNow = async (resp) => {
    let title = ''; let body = '';
    try { title = await page.title(); } catch {}
    const st = resp && !resp.err ? resp.status() : 0;
    if (st >= 400 || /just a moment|verifying|checking your browser|attention required|verify you are human|access denied/i.test(title)) { try { body = await page.content(); } catch {} }
    let cookieNames = []; try { cookieNames = (await ctx.cookies()).map((c) => c.name); } catch {}
    let headers = {}; try { headers = resp && !resp.err ? resp.headers() : {}; } catch {}
    return lib.detectChallenge({ status: st, headers, title, url: page.url(), body, cookieNames });
  };

  try {
    await (async () => {
      // 1. arrive. Patience is timed from the start of the request that worked; backoff waits after a bot check or 429 never count.
      let tl = Date.now(); let resp; let challenge = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        tl = Date.now();
        // the TCP probe runs alongside the first page load: a refused port or a name that does not resolve is reported right away on
        // every engine, without waiting for the page load to time out
        const gotoP = page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: gotoMs }).catch((e) => ({ err: e }));
        const probeP = attempt === 0 ? storeProbe(new URL(startUrl).origin).then((k) => (k === 'refused' || k === 'dns' ? { err: new Error(`probe ${k}`), probe: k } : gotoP)) : gotoP;
        resp = await Promise.race([gotoP, probeP]);
        dbg(`arrive goto done ${resp && resp.err ? resp.err.message : 'ok'}`);
        challenge = await challengeNow(resp);
        dbg('arrive challenge checked');
        if (challenge || (resp && !resp.err && resp.status() === 429)) { j.backoff_seconds = (j.backoff_seconds || 0) + 30 * (attempt + 1); if (attempt < 3) await sleep(30000 * (attempt + 1)); continue; }
        break;
      }
      if (challenge || (resp && !resp.err && resp.status() === 429)) return await quit('arrive', 'rate_limited', `the store showed a bot check (${challenge || 'HTTP 429'}) four times, so the test browser could not get in. This is the test being stopped, not a shopper problem; wait 15 to 30 minutes and run again, or allow-list the test in your bot protection`, 'warn');
      // The store did not answer at all (a dead port, a name that does not resolve, a refused or reset connection): not a shopper
      // result, so it is a test error with its own wording, never a Blocking finding.
      if (resp && resp.err) {
        const msg = String(resp.err.message);
        const probe = resp.probe || (await storeProbe(new URL(startUrl).origin));
        if (resp.probe || UNREACHABLE.test(msg) || probe !== 'ok') {
          j.store_unreachable = true;
          const kind = lib.unreachableKind(msg, probe);
          return await quit('arrive', 'error', lib.unreachableMessage(new URL(startUrl).origin, kind, Math.round((Date.now() - tl) / 1000)), 'test');
        }
      }
      if (resp && !resp.err && [404, 410].includes(resp.status())) return await quit('arrive', 'broken_link', `the address ${q(new URL(startUrl).pathname, 80)} shows "Page not found" (HTTP ${resp.status()}). Check the address (--url, or the persona's landing_path); if shoppers reach it from an ad or a link, that link is broken`);
      if (!resp || resp.err || resp.status() >= 400) return await quit('arrive', 'error', `the page did not load (${resp?.err ? lib.oneLine(String(resp.err.message).split('\n')[0], 120) : `HTTP ${resp?.status()}`})`);
      dbg(`arrive waitUsable for ${gotoMs - (Date.now() - tl)}ms`);
      let usable = await waitUsable(gotoMs - (Date.now() - tl));
      dbg(`arrive usable ${JSON.stringify(usable)}`);
      if (!usable.ok && usable.toolMiss && !ruleHit() && !(await notFoundPage())) { const r1 = await reloadOnce('arrive'); usable = r1.usable; if (r1.t) tl = r1.t; }
      const loadSec = +((Date.now() - tl) / 1000).toFixed(1);
      j.timings.arrive_seconds = loadSec;
      if (!usable.ok) {
        const late = await challengeNow(resp);
        if (late) return await quit('arrive', 'rate_limited', `the page turned into a bot check (${late}). This is the test being stopped, not a store failure`, 'warn');
        if (usable.toolMiss) return await quit('arrive', 'test_limit', notRecognised(usable.shape), 'warn');
        return await quit('arrive', 'patience_exceeded', `the page was not usable (heading and first photo) after ${loadSec}s on ${net.name}, longer than ${persona.name} will wait`);
      }
      if (loadSec > loadSeconds) return await quit('arrive', 'patience_exceeded', `the page took ${loadSec}s to show its heading and first photo on ${net.name}, longer than ${persona.name} will wait`);
      j.platform = await detectPlatform();
      if (platformUnknown.has(target.origin)) {
        const theme = await page.evaluate(lib.shopifyThemeAtRuntime).catch(() => false);
        if (!theme) {
          platformRefused = `${lib.SHOPIFY_ONLY_MESSAGE}. ${target.hostname} shows no Shopify Online Store theme (no window.Shopify.theme on the first page), so the run stopped there`;
          return await quit('arrive', 'test_limit', platformRefused, 'warn');
        }
        // R27: the same conflict test the home-page check uses, on the page the browser actually loaded (its response headers and its
        // markup, script and link addresses included): a Shopify theme next to another platform's evidence is an unclear platform
        const seen = await page.content().catch(() => '');
        let hdrs = {}; try { hdrs = (resp && !resp.err && typeof resp.headers === 'function') ? resp.headers() : {}; } catch {}
        const other = lib.platformConflictOnPage({ headers: hdrs, html: seen });
        if (other) {
          platformRefused = `${lib.SHOPIFY_ONLY_MESSAGE}. ${target.hostname} shows a Shopify theme on the first page and also ${other} markup, so its platform is unclear and the run stopped there`;
          return await quit('arrive', 'test_limit', platformRefused, 'warn');
        }
        // the second signal: the store's /cart.js answers as a Shopify cart (one GET, no redirect followed)
        let cartOk = false;
        try { const cr = await ctx.request.get(new URL('/cart.js', target.origin).toString(), { maxRedirects: 0, timeout: 15000, headers: { accept: 'application/json' } }); cartOk = cr.status() === 200 && lib.isShopifyCartJson(JSON.parse((await cr.text()).slice(0, 200000))); } catch {}
        if (!cartOk) {
          platformRefused = `${lib.SHOPIFY_ONLY_MESSAGE}. ${target.hostname} shows a Shopify theme on the first page, but its /cart.js does not answer as a Shopify cart, so the run stopped there`;
          return await quit('arrive', 'test_limit', platformRefused, 'warn');
        }
        platformUnknown.delete(target.origin);
      }
      await step('arrive', true, `heading and first photo showed in ${loadSec}s, timed from the page request (bot-check waits not counted)`);
      if (loadSec > loadSeconds / 2) finding('note', `The page took ${loadSec}s to show its heading and first photo on ${net.name}`, 'arrive');
      await sleep(2500); // a first-time visitor looks around for a moment; pop-ups usually appear here
      await collectCodes();
      if (!(await handlePopups('arrive'))) return;

      // 2. on a listing page, pick a product from the product grid only
      let kind = await shape();
      if (!kind.isProduct) {
        const pick = rx(persona.product_pick, 'product_pick');
        const cards = await page.evaluate(lib.readGridLinks, { sel: lib.SEL, linkSrc: '/products?/[^/?#]+' }).catch(() => []);
        if (!cards.length) {
          const loose = await page.evaluate(lib.countProductLinks, { sel: lib.SEL, linkSrc: '/products?/[^/?#]+' }).catch(() => 0);
          if (loose) return await quit('pick a product', 'test_limit', `this is not a product page (${kind.why}); ${loose} product link(s) are on the page but not in a product grid the panel recognises. This is a limit of the test tool, not a shopper quit; the run is INCOMPLETE`, 'warn');
          return await quit('pick a product', 'not_found', `this is not a product page (${kind.why}) and no product links were found on it`);
        }
        const choice = cards.find((c) => pick && pick.test(c.text)) || cards[0];
        if (pick && !pick.test(choice.text)) finding('note', `${persona.name} saw no product matching what they came for, so took the first one`, 'product grid');
        if (cards.some((c) => !c.cardHasPrice)) finding('warn', 'Some product cards in the grid show no price', 'product grid');
        await scrollTo(Math.max(0, choice.top - vh / 3));
        await step('pick a product', true, `${q(choice.text, 80)} sits ${screensDown(choice.top)} in the product grid`);
        let tt = Date.now();
        const link = page.locator(`a[href*="${choice.path.split('?')[0].replace(/"/g, '')}"]:visible`).first();
        const r = await tap(link, 'product card');
        if (!r.ok) return await quit('pick a product', tapKind(r), r.covered ? `the product card was covered by <${q(r.covered, 80)}>` : r.misaligned || `could not open the product (${r.msg})`);
        await page.waitForURL((u) => u.pathname !== new URL(startUrl).pathname, { timeout: gotoMs }).catch(() => {});
        let ok = await waitUsable(gotoMs - (Date.now() - tt));
        // a product card that leads to "Page not found" is a broken link in the store, said plainly (not a page that was slow)
        const nf = await notFoundPage();
        if (!nf && !ok.ok && ok.toolMiss && !ruleHit()) { const r1 = await reloadOnce('open the product'); ok = r1.usable; if (r1.t) tt = r1.t; }
        if (nf) { let pth = ''; try { pth = new URL(page.url()).pathname; } catch {} return await quit('open the product', 'broken_link', `the product card ${q(choice.text, 60)} leads to a page that was not found (${nf}, ${q(pth, 80)}): a broken link in the store`); }
        const openSec = +((Date.now() - tt) / 1000).toFixed(1);
        j.timings.open_product_seconds = openSec;
        if (!ok.ok) { const late = await challengeNow(null); if (late) return await quit('pick a product', 'rate_limited', `the product page turned into a bot check (${late}); the test was stopped, not the store`, 'warn'); if (ok.toolMiss) return await quit('open the product', 'test_limit', notRecognised(ok.shape), 'warn'); return await quit('pick a product', 'patience_exceeded', `the product page was not usable after ${openSec}s from the tap, longer than ${persona.name} will wait`); }
        if (openSec > loadSeconds) return await quit('pick a product', 'patience_exceeded', `the product page took ${openSec}s from the tap to be usable, longer than ${persona.name} will wait`);
        j.platform = await detectPlatform();
        await step('open the product', true, `product page usable in ${openSec}s from the tap`);
        await collectCodes();
        if (!(await handlePopups('open the product'))) return;
        kind = await shape();
        if (!kind.isProduct) return await quit('open the product', 'test_limit', `the page that opened from the product card was not recognised as a product page (${kind.why}). This is a limit of the test tool, not a shopper quit; the run is INCOMPLETE`, 'warn');
      }
      j.page_kind = `product page (${kind.why})`;
      j.product_url = lib.stripQuery(page.url());

      // 3. look at photos: thumbnails, a next arrow, or a sideways swipe
      const want = persona.photos_to_view || 2;
      const activeMedia = () => page.evaluate(() => {
        const imgs = [...document.querySelectorAll('main img, .woocommerce-product-gallery img, media-gallery img')].filter((x) => { const b = x.getBoundingClientRect(); return x.getClientRects().length && b.width > innerWidth * 0.5 && b.left > -10 && b.left < innerWidth * 0.5; });
        let strip = imgs[0] && imgs[0].parentElement; let off = '';
        for (let el = strip; el; el = el.parentElement) if (el.scrollWidth > el.clientWidth + 10) { off = Math.round(el.scrollLeft); break; }
        return `${imgs[0] ? imgs[0].currentSrc || imgs[0].src : ''}|${off}`;
      }).catch(() => '');
      const thumbs = page.locator('[class*="thumbnail" i] button:visible, button[class*="thumbnail" i]:visible, .flex-control-thumbs img:visible, [class*="thumb" i] button:visible');
      const next = page.locator('main button[class*="next" i]:visible, main [aria-label*="next" i]:visible').first();
      let seen = 1; let how = 'no gallery controls'; const dupes = [];
      dbg('photos count'); const nThumbs = await thumbs.count(); dbg(`photos thumbs ${nThumbs}`);
      for (let i = 1, tries = 0; seen < want && tries < want + 2; i++, tries++) {
        const before = await activeMedia(); dbg(`photos before ${i}`);
        let r;
        if (nThumbs > 1 && i >= nThumbs) break; // every thumbnail seen: the page has no more photos
        if (nThumbs > i) { how = 'thumbnails'; r = await tap(thumbs.nth(i), 'photo thumbnail'); } else if (await next.count()) { how = 'next arrow'; r = await tap(next, 'next photo'); } else {
          // a swipe is an interaction too: it passes the reveal stop first, like every tap does through policy()
          await revealCheck('the photo strip (a swipe)');
          const swiped = await page.evaluate(() => {
            const img = [...document.querySelectorAll('main img')].find((x) => x.getClientRects().length && x.getBoundingClientRect().width > innerWidth * 0.5);
            let el = img && img.parentElement;
            while (el && !(el.scrollWidth > el.clientWidth + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowX))) el = el.parentElement;
            if (!el) return false;
            el.scrollBy({ left: el.clientWidth, behavior: 'instant' });
            return true;
          }).catch(() => false);
          if (!swiped) break;
          how = 'swipe'; j.taps++; r = { ok: true };
        }
        await sleep(600);
        if (!r.ok) { finding('warn', r.covered ? `The photo ${how} were covered by <${q(r.covered, 80)}>` : `Could not tap the photo ${how} (${r.msg})`, 'photos'); break; }
        if ((await activeMedia()) === before) { if (how === 'swipe') break; dupes.push(i + 1); continue; } // a swipe that moves nothing = the end of the strip
        seen++;
      }
      if (dupes.length) finding('warn', `Tapping to photo ${dupes.join(', ')} showed the same photo again (a repeated photo, or a tap that does nothing)`, 'photos');
      if (how === 'no gallery controls' && want > 1) finding('note', 'No photo thumbnails, arrows or swipe strip found to look through more photos', 'photos');
      if (seen < want && !dupes.length && how !== 'no gallery controls') finding('note', `${persona.name} wanted to see ${want} photos; the page has ${seen}`, 'photos');
      await step('look at photos', true, `saw ${seen} of the ${want} photos ${persona.name} wanted (${how})`);

      // 4. find the price: structured price first ([itemprop=price], then ld+json offers, then Shopify /products/<handle>.js),
      // then the visible element in the product block that shows it. Header, banners, sticky and fixed bars never count.
      const sp = await page.evaluate(lib.readStructuredPrice, lib.SEL).catch(() => ({}));
      let structured = null;
      const ipVal = sp.itemprop ? lib.parseMoney(sp.itemprop)?.value ?? (Number.isFinite(Number(sp.itemprop)) ? Number(sp.itemprop) : null) : null;
      if (ipVal !== null) structured = { value: ipVal, source: '[itemprop=price]' };
      else if (kind.ld.price !== null) structured = { value: kind.ld.price, source: 'ld+json offers.price' };
      else if (j.platform === 'shopify' && sp.handlePath) { const v = await page.evaluate(lib.fetchShopifyProductJs, sp.handlePath).catch(() => null); if (v !== null) structured = { value: v, source: 'Shopify /products/<handle>.js' }; }
      const cands = await page.evaluate(lib.readPriceCandidates, lib.SEL).catch(() => []);
      const { price, label: priceLabel } = lib.resolvePrice(cands, structured);
      j.price = price;
      if (!price && structured) return await quit('find the price', 'required_info_missing', `no visible price was found in the product block (the page data says ${structured.value} via ${structured.source}, and those digits are not shown in the product block)`);
      if (!price) return await quit('find the price', 'test_limit', `the panel could not find a price element it recognises in the product block (${cands.length ? `${cands.length} price-like element(s) were found but none could be read as an amount` : 'no price-like element'}, and the page has no structured price to check against). This is a limit of the test tool, not a store problem or a shopper quit; the run is INCOMPLETE`, 'warn');
      if (price.unrecognised_format) finding('warn', `${priceLabel}: the product block shows ${q(price.text)}, which the panel could not read as an amount; it used the page data instead (${structured.value}, ${structured.source}). Check the price reads clearly to a shopper`, 'price');
      if (structured && !price.matches_structured) finding('warn', `The visible price ${q(price.text)} does not match the price in the page data (${structured.value}, ${structured.source})`, 'price');
      const screen = Math.floor(price.top / vh) + 1;
      await scrollTo(Math.max(0, price.top - vh / 2));
      const maxScreens = persona.patience.max_screens_to_price;
      if (screen > maxScreens) return await quit('find the price', 'patience_exceeded', `the price ${q(price.text)} first shows on screen ${screen}; ${persona.name} gives up after ${maxScreens} screen${maxScreens === 1 ? '' : 's'}`);
      const ps = await step('find the price', true, `${q(price.text)} first shows on screen ${screen} (${price.top}px down; one phone screen is ${vh}px)${structured ? `; matches ${structured.source}` : ''}`);
      if (screen > 1) finding('warn', `The price is not on the first phone screen: it first shows on screen ${screen}`, 'price', ps.screenshot);

      // 5. read the page first (scroll to the end so lazy widgets such as reviews load), then check the before_buying list.
      dbg('scroll start');
      const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => vh);
      for (let y = vh; y < Math.min(height, vh * 15); y += vh) { await scrollTo(y); await sleep(250); }
      await sleep(800);
      dbg('details');
      await revealCheck('a closed product section');
      // closed product sections (accordions) are found by the lib (a finder only) and each is opened through the interaction policy and
      // the guarded tap, like every other tap; one the policy would refuse is left closed (and named in the step), never forced
      const nDetails = await page.evaluate(lib.markClosedProductDetails, lib.SEL).catch(() => 0);
      let opened = 0; const leftClosed = [];
      for (let di = 0; di < nDetails; di++) {
        const dl = page.locator(`[data-sp-details="${di}"]`).first();
        const info = await dl.evaluate(lib.readInteraction, null, { timeout: 3000 }).catch(() => null);
        if (!info) continue;
        const refuse = lib.interactionRefusal(info);
        if (refuse) { leftClosed.push(info.own.split(' | ')[0] || 'a section'); continue; }
        const r = await tap(dl, 'a closed product section', { uncounted: true });
        pendingNav = null;
        if (r.ok) opened++;
      }
      if (opened) await sleep(300);
      if (leftClosed.length) finding('note', `The panel left ${leftClosed.length} closed product section(s) unopened because the interaction policy would refuse them (${leftClosed.slice(0, 3).map((x) => q(x, 40)).join(', ')})`, 'product');
      dbg('segments');
      const productSeg = await page.evaluate(lib.readTextSegments, { sel: lib.SEL, maxChars: lib.MAX_SCAN_CHARS, mode: 'product' }).catch(() => []);
      const reviewSeg = await page.evaluate(lib.readTextSegments, { sel: lib.SEL, maxChars: lib.MAX_SCAN_CHARS, mode: 'reviews' }).catch(() => []);
      const scanned = productSeg.reduce((n, x) => n + x.text.length, 0);
      dbg('scan');
      const missing = []; const found = [];
      for (const need of persona.before_buying) {
        const look = need.look_in || 'product';
        const segs = look === 'product' ? productSeg : look === 'reviews' ? reviewSeg : [...productSeg, ...reviewSeg];
        const tried = need.look_for.map((p) => rx(p, `before_buying ${q(need.need, 60)}`, { bounded: true })).filter(Boolean);
        if (!tried.length) continue;
        let hit = null;
        let headingHit = null;
        for (const r of tried) { hit = lib.matchTerm(segs, r, { requireBody: true, patterns: tried }); if (hit && hit.headingOnly) { headingHit = headingHit || hit; hit = null; continue; } if (hit) break; }
        if (hit) { found.push(need.need); j.trust_matches.push({ need: need.need, look_in: look, element: hit.path, context: hit.context }); }
        else { missing.push(headingHit ? { ...need, heading_only: headingHit.context } : need); if (headingHit) j.trust_matches.push({ need: need.need, look_in: look, element: headingHit.path, context: headingHit.context, heading_only: true }); }
      }
      dbg('scan done');
      // A miss where the page plainly has what the persona meant (a price in another currency or format, or the need's own words)
      // gets a hint: the persona's pattern may be too narrow, not the page.
      for (const m of missing) {
        const look = m.look_in || 'product';
        const text = (look === 'product' ? productSeg : look === 'reviews' ? reviewSeg : [...productSeg, ...reviewSeg]).map((x) => x.text).join(' \n ');
        const priceLike = m.look_for.some((p) => /\\\$|[$\u20ac\u00a3\u00a5]|\\d|price|cost/i.test(String(p))) || /\bprice|cost\b/i.test(m.need);
        const pm = priceLike && !m.look_for.some((p) => String(p).includes('{price}')) ? text.match(lib.MONEY_RE) : null;
        const words = String(m.need).toLowerCase().match(/[a-z\u00c0-\uffff]{5,}/g) || [];
        const seen = words.filter((w) => text.toLowerCase().includes(w));
        if (pm) m.hint = `the page does show a price, ${q(pm[0].trim(), 30)}, so check the persona's pattern (the pattern {price} matches a price in any currency)`;
        else if (words.length && seen.length === words.length) m.hint = `the words ${seen.map((w) => q(w, 30)).join(', ')} are on the page, so check the persona's pattern`;
      }
      const deal = missing.find((m) => m.if_missing === 'quit');
      await scrollTo(Math.max(0, price.top - vh / 2));
      if (deal) return await quit('check what they need to know', 'required_info_missing', `${q(deal.need, 80)} was not found in the ${deal.look_in === 'reviews' ? 'reviews' : deal.look_in === 'both' ? 'product block or reviews' : 'product block'}${deal.heading_only ? ` (heading only: the heading ${q(deal.heading_only, 60)} is there, with no text under it)` : ''} (${productSeg.length} text blocks, ${scanned} characters read, ${opened} closed section(s) opened)${deal.hint ? `. Hint: ${deal.hint}` : ''}`, 'block', deal.need);
      const tq = await step('check what they need to know', true, [found.length ? `found: ${found.map((x) => q(x, 60)).join('; ')}` : '', missing.length ? `not found: ${missing.map((m) => `${q(m.need, 60)}${m.heading_only ? ` (heading only: ${q(m.heading_only, 40)})` : ''}`).join('; ')}` : '', `read ${productSeg.length} text blocks of the product block and ${reviewSeg.length} of reviews; ${opened} closed section(s) opened`].filter(Boolean).join('. '));
      for (const m of missing) finding('warn', m.heading_only ? `${persona.name} looked for ${q(m.need, 80)} and found only a heading, ${q(m.heading_only, 60)}, with no text under it` : `${persona.name} looked for ${q(m.need, 80)} and did not find it${m.hint ? `. Hint: ${m.hint}` : ''}`, 'product block', tq.screenshot);

      // 6. pick options (required ones always; the persona's own picks where they have one). Never types personal data, never uploads.
      dbg('options');
      // the product's own form: not one inside a product listing grid or a related/recommended/cart-drawer block.
      // (A plain class="grid" layout wrapper, as in Dawn, is not a listing.)
      const marked = await page.evaluate((sel) => {
        document.querySelectorAll('[data-sp-form]').forEach((f) => f.removeAttribute('data-sp-form'));
        const f = [...document.querySelectorAll(sel.addForm)].find((x) => !x.closest(sel.grid) && !x.closest(sel.elsewhere));
        if (f) f.setAttribute('data-sp-form', '1');
        return !!f;
      }, lib.SEL).catch(() => false);
      const form = page.locator('[data-sp-form="1"]').first();
      if (!marked || !(await form.count())) {
        const buyText = await page.evaluate(lib.visibleBuyButton).catch(() => null);
        if (buyText) return await quit('pick options', 'test_limit', `the page shows a ${q(buyText, 40)} button but not an add to cart form the panel recognises. This is a limit of the test tool, not a shopper quit; the run is INCOMPLETE`, 'warn');
        return await quit('pick options', 'not_found', 'the product page shows no add to cart form or button');
      }
      dbg('controls');
      const controls = await form.evaluate((f) => {
        const vis = (e) => e && e.getClientRects().length > 0;
        const labelOf = (el) => {
          const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          const fs = el.closest('fieldset');
          return ((byFor && byFor.innerText) || (fs && fs.querySelector('legend')?.innerText) || el.getAttribute('aria-label') || el.closest('label')?.innerText || el.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        };
        const out = []; const radioNames = new Set();
        f.querySelectorAll('[data-sp-opt]').forEach((e) => e.removeAttribute('data-sp-opt'));
        for (const el of f.querySelectorAll('select, input, textarea')) {
          const type = (el.type || el.tagName).toLowerCase();
          if (['hidden', 'submit', 'button', 'number', 'checkbox'].includes(type) || /quantity|qty/i.test(el.name || '')) continue;
          if (type === 'radio') {
            if (radioNames.has(el.name)) continue; radioNames.add(el.name);
            const group = [...f.querySelectorAll('input[type="radio"]')].filter((r) => r.name === el.name);
            const idx = out.length; group.forEach((r, k) => r.setAttribute('data-sp-opt', `${idx}-${k}`));
            out.push({ idx, kind: 'radio', label: labelOf(el), required: group.some((r) => r.required), options: group.map((r, k) => ({ k, text: ((r.closest('label') && r.closest('label').innerText) || r.value || '').trim().slice(0, 60), off: r.disabled || /sold.?out|unavailable|out of stock/i.test(r.closest('label')?.innerText || ''), checked: r.checked })) });
            continue;
          }
          if (!vis(el)) continue;
          const idx = out.length; el.setAttribute('data-sp-opt', String(idx));
          if (el.tagName === 'SELECT') out.push({ idx, kind: 'select', label: labelOf(el), required: el.required, value: el.value, options: [...el.options].map((o) => ({ v: o.value, text: o.textContent.trim().slice(0, 60), off: o.disabled || /sold.?out|unavailable|out of stock/i.test(o.textContent) })) });
          else if (type === 'file') out.push({ idx, kind: 'file', label: labelOf(el), required: el.required });
          else out.push({ idx, kind: 'text', label: labelOf(el), required: el.required, name: `${el.name || ''} ${el.id || ''} ${el.getAttribute('placeholder') || ''}`, type, autocomplete: String(el.getAttribute('autocomplete') || '').trim().toLowerCase(), filled: !!el.value });
        }
        return out;
      }).catch(() => []);
      dbg('controls done');
      const optLog = []; const soldOut = []; const leftEmpty = []; let needsFile = null;
      for (const c of controls) {
        dbg(`control ${c.kind} ${c.label}`);
        const pref = (persona.choices || []).find((x) => { const r = rx(x.option, 'choices.option'); return r && r.test(c.label); });
        const pickRe = pref && pref.pick ? rx(pref.pick, `choices.pick for ${q(c.label, 40)}`) : null;
        if (c.kind === 'select') {
          const real = c.options.filter((o) => o.v !== '');
          const ok = real.filter((o) => !o.off);
          if (real.length && !ok.length) { soldOut.push(c.label); optLog.push(`${q(c.label, 40)}: sold out`); continue; }
          const cur = c.options.find((o) => o.v === c.value);
          if (!pref && cur && cur.v !== '' && !cur.off) { optLog.push(`${q(c.label, 40)}: kept ${q(cur.text, 40)}`); continue; }
          const hit = (pickRe && ok.find((o) => pickRe.test(o.text))) || ok[0];
          if (pickRe && !ok.some((o) => pickRe.test(o.text)) && real.some((o) => pickRe.test(o.text))) finding('note', `${persona.name}'s preferred ${q(c.label, 40)} is sold out, so they took another`, 'options');
          if (hit) {
            const loc = form.locator(`[data-sp-opt="${c.idx}"]`); dbg('sel scroll'); await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
            // the interaction policy: the select itself, then the option about to be picked
            await policy(loc, c.label);
            const ow = lib.interactionRefusal({ own: hit.text });
            if (ow) { j.interaction_refused = { what: lib.oneLine(`${c.label}: ${hit.text}`, 60), why: ow }; throw new Refused(`the option ${q(hit.text, 40)}`, ow); }
            dbg('sel pick'); await loc.selectOption(hit.v, { timeout: 8000 }).catch((e) => dbg(String(e.message).slice(0, 300))); j.taps += 2; optLog.push(`${q(c.label, 40)}: ${q(hit.text, 40)}`); await sleep(400);
          }
        } else if (c.kind === 'radio') {
          const ok = c.options.filter((o) => !o.off);
          if (!ok.length) { soldOut.push(c.label); optLog.push(`${q(c.label, 40)}: sold out`); continue; }
          const already = ok.find((o) => o.checked);
          const target = (pickRe && ok.find((o) => pickRe.test(o.text))) || (already && !pickRe ? already : null) || ok[0];
          if (target === already) { optLog.push(`${q(c.label, 40)}: kept ${q(target.text, 40)}`); continue; }
          const radio = form.locator(`[data-sp-opt="${c.idx}-${target.k}"]`);
          const lab = radio.locator('xpath=ancestor::label[1]');
          let r = (await lab.count()) ? await tap(lab, c.label) : { ok: false };
          // no label, or its tap failed: the radio itself, through the same policy, never forced
          if (!r.ok) { await policy(radio, c.label); r = await radio.check({ timeout: 8000 }).then(() => ({ ok: true }), () => ({ ok: false })); if (r.ok) j.taps++; }
          optLog.push(r.ok ? `${q(c.label, 40)}: ${q(target.text, 40)}` : `${q(c.label, 40)}: could not pick ${q(target.text, 40)}`);
        } else if (c.kind === 'file') {
          if (c.required) needsFile = c.label;
        } else if (c.kind === 'text') {
          if (c.filled || !c.required) continue;
          // Fixed typing only: a required plain text box (personalisation) gets "TEST" ("ABC" when it takes 3 characters or fewer),
          // never into a box that looks personal or payment related (lib.mayTypeInto). Personas cannot give text to type.
          const ok = lib.mayTypeInto({ label: c.label, name: c.name, type: c.type, autocomplete: c.autocomplete });
          if (!ok.ok) { leftEmpty.push({ label: c.label, why: ok.why }); optLog.push(`${q(c.label, 40)}: left empty (${ok.why})`); continue; }
          const loc = form.locator(`[data-sp-opt="${c.idx}"]`);
          const r = await tap(loc, c.label);
          if (!r.ok) { leftEmpty.push({ label: c.label, why: 'the panel could not tap the box' }); optLog.push(`${q(c.label, 40)}: could not tap the box`); continue; }
          const txt = lib.fixedTextFor(await loc.evaluate((e) => e.maxLength).catch(() => -1));
          await lib.typeFixed(loc, txt).catch(() => {}); j.typed_chars += txt.length; (j.typed_list ||= []).push({ box: lib.oneLine(c.label, 60), text: txt }); optLog.push(`${q(c.label, 40)}: typed ${q(txt, 40)}`);
        }
      }
      const os = await step('pick options', true, optLog.join('; ') || 'nothing to pick');
      if (soldOut.length) return await quit('pick options', 'sold_out', `every choice for ${soldOut.map((x) => q(x, 40)).join(', ')} is sold out (stock, not a problem with the page)`, 'warn');
      if (needsFile) return await quit('pick options', 'test_limit', `${q(needsFile, 40)} needs a file upload; the test never uploads files`, 'warn');
      if (optLog.some((l) => /could not/.test(l))) finding('warn', `Some options could not be picked: ${optLog.filter((l) => /could not/.test(l)).join('; ')}`, 'options', os.screenshot);

      // 7. add to cart
      const add = form.locator('button[name="add"], button[name="add-to-cart"], .single_add_to_cart_button, button[type="submit"], input[type="submit"]').first();
      if (!(await add.count())) return await quit('add to cart', 'test_limit', 'the product form has no Add to cart button the panel recognises. This is a limit of the test tool, not a shopper quit; the run is INCOMPLETE', 'warn');
      dbg('add found'); const addTop = await add.evaluate((b) => Math.round(b.getBoundingClientRect().top + scrollY)).catch(() => null);
      const addState = await add.evaluate((b) => ({ off: b.disabled || b.getAttribute('aria-disabled') === 'true', text: (b.innerText || b.value || '').trim().replace(/\s+/g, ' ').slice(0, 40) })).catch(() => ({ off: false, text: '' }));
      if (addState.off && SOLD.test(addState.text)) return await quit('add to cart', 'sold_out', `the button says ${q(addState.text)} instead of Add to cart (stock, not a problem with the button)`, 'warn');
      if (!CART_MODE) {
        await add.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        await policy(add, 'add to cart');
        const trial = await add.click({ trial: true, timeout: 8000 }).then(() => null).catch((e) => String(e.message));
        if (trial) { const c = await coverOf(add, trial, 'Add to cart button'); return await quit('add to cart', tapKind(c), c.covered ? `the Add to cart button was covered by <${q(c.covered, 80)}>` : c.misaligned || `the Add to cart button could not be tapped (${lib.oneLine(trial.split('\n')[0], 120)})`); }
        if (leftEmpty.length) finding('warn', `Required field(s) were left empty on purpose (${leftEmpty.map((x) => `${q(x.label, 40)}: ${x.why}`).join('; ')}); browse only (--no-cart) stops before Add to cart, so it cannot say whether the store would accept Add to cart`, 'options');
        await step('ready to add to cart', true, `Add to cart can be tapped${addTop !== null ? ` ${screensDown(addTop)}` : ''}. Stopped here on purpose (browse only, --no-cart), nothing added.`);
        await rescanForCheckout();
        await revealAfter('the last tap (checked right before success)');
        j.completed = true;
        return;
      }
      // a count before the add confirms the add by count; without one, the cart page confirms it (an item row, not "empty")
      const before = await cartCount();
      j.cart_touched = true; // the test cart is left as it is afterwards; it expires on its own
      // the cart is touched the moment the runner taps Add to cart, whatever call the store makes (a custom admin-ajax action, a GraphQL
      // cart mutation, an app proxy): from now on, for the rest of the journey, every page load must pass the after-cart rule
      await learnCartUrls();
      lib.markCartTouched(guard, guard.lastDoc || page.url());
      const ra = await tap(add, 'add to cart');
      if (!ra.ok && !ra.skipCart) return await quit('add to cart', tapKind(ra), ra.covered ? `the Add to cart button was covered by <${q(ra.covered, 80)}>` : ra.misaligned || `could not tap Add to cart (${ra.msg})`);
      let after = before;
      const grew = () => before !== null && after !== null && after > before;
      if (before !== null) for (let i = 0; i < 14 && !grew(); i++) { await sleep(500); after = await cartCount(); }
      else { await sleep(1500); after = await cartCount(); }
      const addErrors = () => page.evaluate(() => [...document.querySelectorAll('form [class*="error" i], .woocommerce-error, [role="alert"]:not(.woocommerce-message)')].filter((e) => e.getClientRects().length && e.innerText.trim()).map((e) => e.innerText.trim().replace(/\s+/g, ' ').slice(0, 100))).catch(() => []);
      if (before !== null && !grew()) {
        const errs = await addErrors();
        if (leftEmpty.length) return await quit('add to cart', 'test_limit', `Add to cart was refused after the panel left required field(s) empty on purpose: ${leftEmpty.map((x) => `${q(x.label, 40)} (${x.why})`).join(', ')}${errs.length ? `; the store said ${[...new Set(errs)].slice(0, 2).map((x) => q(x, 80)).join(' / ')}` : ''}. This is a limit of the test tool, not a store problem or a shopper quit; the run is INCOMPLETE`, 'warn');
        if (errs.length) return await quit('add to cart', 'required_info_missing', `Add to cart was refused: ${[...new Set(errs)].slice(0, 3).map((x) => q(x, 80)).join(' / ')}`);
        if (after === null) return await quit('add to cart', 'error', 'the cart count could not be read after the tap (the cart API did not answer), so whether Add to cart worked is unknown');
        return await quit('add to cart', 'error', 'tapping Add to cart did not add anything to the cart');
      }
      const addWhat = before !== null ? `cart went from ${before} to ${after} item(s) (read from ${j.cart_count_source || 'the cart API'})` : 'the cart count could not be read, so the cart page confirms the add';
      if (ra.skipCart) { await step('add to cart', true, addWhat); return await skipCartEnd('add to cart', 'Add to cart'); }
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(600);
      await step('add to cart', true, `${addWhat}; the button sat ${addTop !== null ? screensDown(addTop) : 'at an unknown height'}`);

      // 8. go to the cart
      const viewCart = page.locator('#cart-notification-button:visible, .woocommerce-message a.wc-forward:visible, a:visible:text-matches("^\\s*view (my )?(cart|basket|bag)", "i")').first();
      // every visible drawer Checkout submit is a candidate (no .first(): the first may be a disabled one; see step 10)
      const drawerCheckout = page.locator('cart-drawer button[name="checkout"]:visible, #CartDrawer button[name="checkout"]:visible');
      const isCartHere = (u) => lib.isCartPageUrl(u) || guard.cartUrls.some((c) => samePage(u, new URL(c, u).toString()));
      let onCart = isCartHere(page.url());
      if (onCart) finding('note', 'Add to cart jumps straight to the cart page (no drawer or notice)', 'add to cart');
      else if (await viewCart.count()) {
        const r = await tap(viewCart, 'view cart');
        if (r.skipCart) return await skipCartEnd('go to cart', 'The view-cart link');
        if (r.guardStop) return await quit('go to cart', 'test_limit', r.msg, 'warn'); onCart = r.ok;
      }
      if (!onCart && !(await drawerCheckout.count())) {
        const icon = page.locator('a[href$="/cart"]:visible, a[href$="/cart/"]:visible, #cart-icon-bubble:visible, a.cart-contents:visible').first();
        const r = await tap(icon, 'cart icon');
        if (r.skipCart) return await skipCartEnd('go to cart', 'The cart icon');
        if (!r.ok) return await quit('go to cart', tapKind(r), r.covered ? `the cart icon was covered by <${q(r.covered, 80)}>` : r.misaligned || `could not open the cart (${r.msg})`);
        onCart = true;
      }
      if (onCart) { await page.waitForURL((u) => isCartHere(u.toString()), { timeout: gotoMs }).catch(() => {}); await page.waitForLoadState('domcontentloaded').catch(() => {}); await sleep(1200); }
      if (j.skip_cart_stop) return await skipCartEnd('go to cart', 'The cart link');
      const onCartPage = isCartHere(page.url());
      // without a count before the add, the cart page itself must show an item row (and not say it is empty)
      if (before === null && after === null) {
        const rows = await page.evaluate(() => ({ rows: document.querySelectorAll('.cart-item, .cart_item, tr.woocommerce-cart-form__cart-item, .wc-block-cart-items__row, [class*="cart-item" i], [class*="line-item" i]').length, empty: /\b(your (cart|basket|bag) is empty|cart is empty|basket is empty|warenkorb ist (noch )?leer)\b/i.test(document.body ? document.body.innerText : '') })).catch(() => ({ rows: 0, empty: false }));
        if (!rows.rows || rows.empty) return await quit('go to cart', 'error', `tapping Add to cart did not add anything the cart page shows (${rows.empty ? 'the cart says it is empty' : 'no item row found'})`);
      }
      const cTapsAtCart = j.taps;
      if (cTapsAtCart > persona.patience.max_taps_to_checkout) return await quit('go to cart', 'patience_exceeded', `it already took ${cTapsAtCart} taps to reach the cart; ${persona.name} gives up after ${persona.patience.max_taps_to_checkout}`);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      const cartCovers = await coverCheck();
      const cs = await step('go to cart', true, onCartPage ? 'cart page' : 'cart drawer or mini-cart panel');
      if (cartCovers.length && onCart) finding('warn', `Something covers the cart page: ${cartCovers.map((c) => c.sel).join(', ')}`, 'cart', cs.screenshot);
      await collectCodes();

      // 9. cart checks (findings; only a shipping price over the persona's limit is a quit): the free-shipping bar's math, discount
      // codes the store shows on its own pages, and the shipping estimator with the fixed postcode for the country
      const cartText = async () => page.evaluate(() => (document.body ? document.body.innerText.slice(0, 200000) : '')).catch(() => '');
      const totalsNow = async () => lib.cartTotalsFrom(await page.evaluate(lib.readCartTotalsInPage).catch(() => null));
      let totals = await totalsNow();
      j.cart_checks.totals = totals;
      const fsc = lib.freeShippingCheck(await cartText(), totals.subtotal);
      if (fsc) {
        j.cart_checks.free_shipping = fsc;
        if (fsc.status === 'mismatch') finding('warn', `The free-shipping message is wrong: ${fsc.why}`, 'cart', cs.screenshot);
        else if (fsc.status === 'unreadable') finding('note', `The cart shows a free-shipping message, but ${fsc.why}`, 'cart');
      }
      const widgets = async () => page.evaluate(lib.markCartWidgetsInPage).catch(() => ({ estimator: false, country: false, coupon: false }));
      let w = await widgets();
      j.cart_checks.codes = [];
      if (storeCodes.length && !w.coupon) finding('warn', `The store shows the discount code${storeCodes.length > 1 ? 's' : ''} ${storeCodes.map((c) => q(c, 24)).join(', ')} on its pages, but the cart has no discount code box`, 'cart', cs.screenshot);
      // R26: each cart check is tied to the guard stops during it. A request the check needed that the panel's own guard stopped (a
      // discount write to an address outside the write allow-list, say) means the check was NOT tested: never a store warning, and
      // the journey ends as a tool limit (the run is INCOMPLETE)
      const stopMark = () => ({ n: guardStops, first: j.guard_interventions.length });
      const stopsSince = (m) => guardStops - m.n;
      const notTested = async (what, m) => {
        const ex = j.guard_interventions[m.first] || (j.rule_hits_on_allowed.at(-1) ? `the named rule ${q(j.rule_hits_on_allowed.at(-1).rule, 40)} on ${q(j.rule_hits_on_allowed.at(-1).url.replace(/^https?:\/\/[^/]+/, '') || '/', 60)}` : 'a request the page made');
        return await quit('cart', 'test_limit', `${what} could not be tested: the panel's own guard stopped ${stopsSince(m) === 1 ? 'a request' : `${stopsSince(m)} requests`} the page made while it ran (first: ${lib.oneLine(ex, 160)}). This is a limit of the test tool, not a result about the store; the run is INCOMPLETE`, 'warn', 'the panel\'s guard stopped a request a cart check needed');
      };
      for (const code of w.coupon ? storeCodes : []) {
        const t0 = (await totalsNow()).total;
        const m0 = stopMark();
        const box = page.locator('[data-sp-coupon="input"]').first(); const btn = page.locator('[data-sp-coupon="button"]').first();
        const r1 = await tap(box, 'discount code box');
        if (!r1.ok) { finding('note', `Could not tap the discount code box (${r1.msg})`, 'cart'); break; }
        await lib.typeFixed(box, code, { codes: storeCodes }); j.typed_chars += code.length; (j.typed_list ||= []).push({ box: 'discount code', text: code });
        const r2 = await tap(btn, 'apply the code');
        if (!r2.ok) { finding('note', `Could not tap the button that applies the discount code (${r2.msg})`, 'cart'); break; }
        await page.waitForLoadState('domcontentloaded').catch(() => {}); await sleep(2000);
        const t1 = (await totalsNow()).total;
        const dropped = t0 !== null && t1 !== null && t1 < t0 - 0.005;
        if (!dropped && stopsSince(m0)) {
          j.cart_checks.codes.push({ code, total_before: t0, total_after: t1, worked: null, tested: false, why: 'the panel\'s guard stopped a request while the code was applied' });
          j.cart_checks.discount = { tested: false, code, guard_stops: stopsSince(m0) };
          return await notTested(`The store's code ${q(code, 24)}`, m0);
        }
        j.cart_checks.codes.push({ code, total_before: t0, total_after: t1, worked: dropped });
        if (dropped) finding('note', `The store's code ${q(code, 24)} works: the total dropped by ${(t0 - t1).toFixed(2)}`, 'cart');
        else finding('warn', `The store shows the code ${q(code, 24)}, but applying it in the cart did not lower the total${t0 === null || t1 === null ? ' (the panel could not read the total)' : ` (${t0} before, ${t1} after)`}`, 'cart');
        w = await widgets(); if (!w.coupon) break;
      }
      if (w.estimator) {
        let country = 'US';
        if (w.country) {
          const sel = page.locator('[data-sp-est="country"]').first();
          const cur = await sel.evaluate((e) => ({ v: e.value, opts: [...e.options].map((o) => [o.value, o.textContent.trim()]) })).catch(() => null);
          const inTable = cur && Object.keys(lib.TEST_ZIPS).find((k) => String(cur.v).toUpperCase() === k);
          if (inTable) country = inTable;
          else if (cur) {
            const us = cur.opts.find(([v, t]) => /^(US|USA)$/i.test(v) || /^united states/i.test(t));
            if (us) { await policy(sel, 'shipping country'); await sel.selectOption(us[0], { timeout: 8000 }).catch(() => {}); j.taps++; }
          }
        }
        const zip = lib.zipFor(country);
        const zbox = page.locator('[data-sp-est="zip"]').first(); const zbtn = page.locator('[data-sp-est="button"]').first();
        const mz = stopMark();
        const r1 = await tap(zbox, 'postcode box');
        if (r1.ok) {
          await lib.typeFixed(zbox, zip); j.typed_chars += zip.length; (j.typed_list ||= []).push({ box: 'shipping estimator postcode', text: zip });
          // the shipping options are read only from the store's own rates answer (Shopify /cart/async_shipping_rates.json or
          // /cart/shipping_rates.json) seen while the estimate runs, never from page text, where a promotion ("free shipping on orders
          // over 50") reads like a rate. No readable answer is an unreadable estimate, never a price.
          const rateAnswers = [];
          const onRates = async (resp) => { try { if (!lib.isShippingRatesUrl(resp.url(), ownHosts) || resp.status() !== 200) return; const v = lib.shippingRatesFrom(await resp.json()); if (v) rateAnswers.push(v); } catch {} };
          page.on('response', onRates);
          const r2 = await tap(zbtn, 'estimate shipping');
          if (r2.ok) {
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            for (let wi = 0; wi < 20 && !rateAnswers.length; wi++) await sleep(400);
            await sleep(300); page.off('response', onRates);
            const rates = rateAnswers.at(-1) || null;
            const amounts = rates ? rates.map((x) => x.price) : [];
            const cheapest = amounts.length ? Math.min(...amounts) : null;
            const limit = lib.shippingQuitOver(persona, totals.subtotal);
            j.cart_checks.shipping = { postcode: zip, country, cheapest, limit };
            j.cart_checks.shipping.options = rates ? rates.slice(0, 8) : null;
            if (!rates && stopsSince(mz)) { j.cart_checks.shipping.tested = false; return await notTested('The cart\'s shipping estimate', mz); }
            if (!rates) finding('note', `The cart's shipping estimate for postcode ${zip} (${country}) could not be read: the panel saw no shipping rates answer from the store (an unreadable estimate, not a price)`, 'cart');
            else if (cheapest === null) finding('note', `The cart's shipping estimator returned no shipping options for postcode ${zip} (${country})`, 'cart');
            else if (limit !== null && cheapest > limit + 0.005) return await quit('cart', 'shipping_cost', `the cheapest shipping the cart shows is ${cheapest.toFixed(2)} (postcode ${zip}), more than ${persona.name} will pay (${limit.toFixed(2)})`);
            else await step('estimate shipping', true, `cheapest shipping ${cheapest.toFixed(2)} for postcode ${zip} (${country}); ${persona.name}'s limit is ${limit === null ? 'unknown' : limit.toFixed(2)}`, { snap: false });
          } else { page.off('response', onRates); finding('note', `Could not tap the shipping estimator's button (${r2.msg})`, 'cart'); }
        } else finding('note', `Could not tap the shipping estimator's postcode box (${r1.msg})`, 'cart');
      }
      if (j.skip_cart_stop) return await skipCartEnd('cart', 'A cart check');

      // 10. find Checkout: visible and enabled, read but never tapped. The journey ends here; the panel never enters checkout.
      const onCartPageNow = isCartHere(page.url());
      // the cart-page Checkout selectors are used only on a cart page; elsewhere (a cart that opened as a mini-cart panel) only inside a
      // dialog or mini-cart panel, so a header or menu checkout link on some other page is never taken for the cart's button
      const coSel = ['button[name="checkout"]', 'input[name="checkout"]', 'a.checkout-button', '#checkout', '.wc-block-cart__submit-button', 'a[href*="/checkout"]', 'a[href*="/kasse"]'];
      const panelSel = ['[role="dialog"]', '[aria-modal="true"]', '.widget_shopping_cart', '[class*="mini-cart" i]', '[class*="minicart" i]', '[class*="cart-drawer" i]'];
      const coLoc = (await drawerCheckout.count()) ? drawerCheckout
        : page.locator((onCartPageNow ? coSel : panelSel.flatMap((c) => coSel.map((x) => `${c} ${x}`))).map((x) => `${x}:visible`).join(', '));
      const nCand = Math.min(await coLoc.count().catch(() => 0), 12);
      if (!nCand) {
        const coText = await page.evaluate(lib.visibleCheckoutText).catch(() => null);
        if (!onCartPageNow) return await quit('find Checkout', 'error', `the cart page did not open: still on ${q(lib.stripQuery(page.url()).replace(/^https?:\/\/[^/]+/, '') || '/', 80)} after the cart tap, with no cart drawer or mini-cart panel the panel recognises${coText ? ` (the page shows ${q(coText, 40)})` : ''}`);
        if (coText) return await quit('find Checkout', 'test_limit', `the cart shows ${q(coText, 40)} but not a Checkout button the panel recognises. This is a limit of the test tool, not a shopper quit; the run is INCOMPLETE`, 'warn');
        return await quit('find Checkout', 'not_found', 'the cart has no Checkout button');
      }
      // R26: a selector match is only a candidate. It counts as the cart's Checkout button only when it is a real control (a button, a
      // submit input or a link with an address) with a checkout label, leading to the store's own checkout or cart (or the cart form's
      // name="checkout" submit), and not an express or wallet button. Anything else is never counted as reaching checkout.
      // R27: each candidate is judged whole (what it is, where it leads, visible, and enabled by the browser's own reckoning, so a disabled
      // fieldset counts) and the loop goes on to the next one, so a disabled first button never hides a usable second one
      let checkoutBtn = null; let desc = null; const coRejected = []; const coDisabled = []; const coHidden = [];
      for (let i = 0; i < nCand && !checkoutBtn; i++) {
        const c = coLoc.nth(i);
        const d = await c.evaluate(lib.describeCheckoutCandidate).catch(() => null);
        if (!d) continue;
        const why = lib.checkoutControlProblem(d, page.url(), ownHosts);
        if (why) { coRejected.push({ label: d.label, why }); continue; }
        if (!d.visible) { coHidden.push(d); continue; }
        // the browser's own enabled state (a disabled fieldset around the button disables it too), plus aria-disabled and a disabled class
        const en = d.enabled && (await c.isEnabled({ timeout: 3000 }).catch(() => false));
        if (!en) { coDisabled.push({ ...d, enabled: false }); continue; }
        checkoutBtn = c; desc = d;
      }
      if (!checkoutBtn && coDisabled.length) return await quit('find Checkout', 'not_found', `the cart's Checkout button ${q(coDisabled[0].label || 'Checkout', 40)} is disabled, so a shopper cannot go on`);
      if (!checkoutBtn && coHidden.length) return await quit('find Checkout', 'not_found', 'the cart\'s Checkout button is not visible');
      if (!checkoutBtn && coRejected.length) {
        j.checkout_candidates_rejected = coRejected.slice(0, 4);
        return await quit('find Checkout', 'test_limit', `the cart shows ${q(coRejected[0].label || 'a checkout element', 40)}, but ${lib.oneLine(coRejected[0].why, 120)}, so it is not a Checkout button the panel can vouch for. Nothing was tapped. This is a limit of the test tool, not a shopper quit; the run is INCOMPLETE`, 'warn');
      }
      if (!checkoutBtn) return await quit('find Checkout', 'test_limit', 'the panel could not read the cart\'s Checkout button (it changed or went away while being read). This is a limit of the test tool, not a shopper quit; the run is INCOMPLETE', 'warn');
      j.checkout_button = { present: true, visible: true, enabled: true, label: desc.label, target: desc.target ? lib.stripQuery(desc.target) : null };
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      const ck = await step('find Checkout', true, `Checkout button ${q(desc.label || 'Checkout', 40)} found ${screensDown(desc.top)}, visible and enabled${desc.target ? `; it leads to ${q(lib.stripQuery(desc.target).replace(/^https?:\/\/[^/]+/, '') || '/', 60)}` : ''}. Not tapped: the panel stops before checkout.`);
      if (desc.top > vh) finding('warn', `On the cart the Checkout button is below the first phone screen (${(desc.top / vh).toFixed(1)} screens down)`, 'cart', ck.screenshot);
      // right before success: no tab or frame may be showing a checkout (one a tap revealed after its own scan ran, such as a cart
      // drawer that renders a checkout once the add returns), and no frame may hold checkout content
      await rescanForCheckout();
      await revealAfter('the last tap (checked right before success)');
      j.reached_checkout = true;
      j.completed = true;
    })();
  } catch (e) {
    if (e && e.safety) {
      finding('block', `SAFETY: a checkout was showing in the test browser after the panel's own action (${lib.oneLine(e.safety.what, 60)}): ${lib.oneLine(e.safety.how, 160)}. The panel stopped at once; nothing was typed or tapped after it. Report it (see SECURITY.md).`, 'checkout');
      await quit(j.steps.at(-1)?.step || 'start', 'test_limit', `safety stop: after ${lib.oneLine(e.safety.what, 60)} the page showed a checkout (${lib.oneLine(e.safety.how, 160)}). The panel stops before checkout, so this journey ends here; this is a limit of the test tool, not a shopper quit; the run is INCOMPLETE`, 'warn').catch(() => {});
    } else if (e && e.refusal) await quit(j.steps.at(-1)?.step || 'start', 'test_limit', `the panel refused to touch ${lib.oneLine(e.refusal.what, 60)}: ${lib.oneLine(e.refusal.why, 160)}. The panel never taps checkout, payment, buy-now or login controls; this is a limit of the test tool, not a shopper quit; the run is INCOMPLETE`, 'warn').catch(() => {});
    else await quit(j.steps.at(-1)?.step || 'start', 'test_error', `the test itself broke: ${lib.oneLine(String(e.message).split('\n')[0], 180)}`).catch(() => {});
  } finally {
    if (j.cart_writes_stopped) { const items = [...new Set(j.cart_writes_stopped_list.map((x) => `${x.method} ${q(x.url.replace(/^https?:\/\/[^/]+/, '') || '/', 60)} (${x.kind})`))].slice(0, 4).join('; ');
      finding('note', `The page itself tried to add to or change the cart ${j.cart_writes_stopped} time(s) (${items}); stopped, because browse only (--no-cart) never puts anything in a cart`, 'cart guard'); }
    if (j.cart_touched_by_page && CART_MODE) finding('note', 'The page itself wrote to the cart before the shopper tapped Add to cart (a script or an app, not the shopper); the test cart is left as it is', 'cart guard');
    // a worker ran without the guard: whatever the journey shows, the panel cannot vouch for what that worker sent
    if (j.unguarded_workers && !lib.ERROR_KINDS.includes(j.quit_kind)) {
      j.quit_original_kind = j.quit_kind || (j.completed ? 'completed' : null); j.completed = false; j.reached_checkout = false;
      j.quit_step = j.steps.at(-1)?.step || 'start'; j.quit_kind = 'test_limit'; j.quit_severity = 'warn';
      j.quit_reason = `${j.unguarded_workers} web worker(s) started without the panel's guard (in a frame the guard cannot reach) and were closed; the panel cannot vouch for what they sent before that. This is a limit of the test tool, not a shopper result; the run is INCOMPLETE`;
      j.quit_topic = 'a web worker started without the panel\'s guard';
      finding('warn', `${persona.name} was not tested properly: ${j.quit_reason}`, `step "${j.quit_step}"`);
    }
    if (j.checkout_blocked.length) { const reached = j.checkout_blocked.filter((x) => x.reached_server).length; const items = [...new Set(j.checkout_blocked.map((x) => `${x.method || 'GET'} ${lib.stripQuery(x.url.replace(/^https?:\/\/[^/]+/, '')) || '/'} (${x.why || 'checkout guard'})`))].slice(0, 3);
      finding('note', `The checkout guard stopped ${j.checkout_blocked.length} request(s) or page load(s) on the way to checkout inside the test browser${reached ? ` (${reached} of them reached the store's server but ${reached === 1 ? 'was' : 'were'} not shown)` : ''}: ${items.join('; ')}`, 'checkout guard'); }
    if (j.beacons_dropped || j.unload_blocked) finding('note', `${j.beacons_dropped + j.unload_blocked} background report(s) (beacons or keepalive requests, the kind a browser sends even while a page closes) were dropped inside the test browser${j.unload_blocked ? ` (${j.unload_blocked} by the browser network guard)` : ''}`, 'checkout guard');
    if (j.speculation_blocked) finding('note', `${j.speculation_blocked} background prefetch or prerender attempt(s) were stopped or removed`, 'checkout guard');
    if (j.checkout_page_loaded) finding('block', 'SAFETY: a checkout page loaded in the test browser. This must never happen; stop using the panel and report it (see SECURITY.md).', 'checkout');
    for (const se of j.script_errors.slice(0, 3)) finding(STRICT_ERRORS ? 'block' : 'warn', `Page script error: ${q(se.message, 160)}`, se.at.replace(/^https?:\/\/[^/]+/, '') || '/');
    j.seconds = sec();
    j.screens_scrolled = +j.screens_scrolled.toFixed(1);
    if (!holder.stopping) { await lib.haltGuard(guard); await ctx.close().catch(() => {}); }
    if (netOwner === myNet && !holder.stopping) { netPolicy = null; netDrop = null; netOwner = null; }
  }
  return j;
}

// ---------- dry run ----------
const plan = targets.flatMap((t) => personas.map((p) => ({ target: t, persona: p })));
if (flag('dry-run')) {
  console.log(`Shopper panel dry run (nothing launched, no network): ${plan.length} journey(s)`);
  for (const { target, persona } of plan) console.log(`  ${persona.id} (${DEVICES[persona.device].label}, ${persona.network.name}): ${landingFor(target, persona)}`);
  console.log(`  cart journey: ${CART_MODE}; own hosts: ${[...ownHosts].join(', ')}`);
  for (const c of shopifyToConfirm) console.log(`  ownership: "${c.shop}" for ${c.target.hostname} is confirmed from the store itself when the run starts (a dry run touches no network)`);
  console.log(`  third-party allow-list: ${baseAllow.join(', ')}`);
  console.log(`  named block rules: ${[...new Set(blockRules.map((r) => r.name))].join(', ')}`);
  if (skipped.length) console.log(`  not run: ${skipped.join(', ')}`);
  process.exit(0);
}

// ---------- run ----------
// A <name>.myshopify.com owner for a custom domain: the store itself must name exactly that address.
for (const c of shopifyToConfirm) {
  const get = async (u) => {
    try {
      // the address must not lead to a private network address, and a redirect is not followed (it does not count as confirmation)
      const addrs = await dns.lookup(new URL(u).hostname, { all: true }).catch(() => []);
      if (!addrs.length || (!testMyshopifyLoopback && addrs.some((x) => lib.privateAddressKind(x.address)))) return '';
      const r = await fetch(u, { redirect: 'manual', headers: { 'user-agent': `ai-shopper-agent-panel/${VERSION} (ownership check)` }, signal: AbortSignal.timeout(15000) });
      if (!r.ok || !lib.isOwnHost(new URL(r.url).hostname, ownHosts)) return '';
      return (await r.text()).slice(0, 2000000);
    } catch { return ''; }
  };
  const metaJson = await get(new URL('/meta.json', c.target).toString());
  let said = lib.myshopifyDomainFrom({ metaJson });
  // the fallback reads the store's home page "/" only, never the address given (which could be an action such as ?add-to-cart=)
  if (!said) said = lib.myshopifyDomainFrom({ html: await get(new URL('/', c.target).toString()) });
  if (said !== c.shop) {
    console.error(`Refusing to run: --i-own "${owned}" is a myshopify address, and ${c.target.hostname} ${said ? `says its address is "${said}"` : 'did not say its myshopify address (no /meta.json myshopify_domain and no Shopify.shop in the page)'}. Pass --i-own ${c.target.hostname} instead.${TOS}`);
    process.exit(2);
  }
  console.log(`Ownership: ${c.target.hostname} confirms its address is ${said}.`);
}
// v1 supports Shopify Online Store themes only. One GET of each store's home page "/" (no redirect followed, never a private network
// address unless every --url is loopback) says which platform it is. Another platform, a Hydrogen (headless) storefront, or a page that
// shows both a Shopify theme and another platform's markup stops the run here with exit 2. A home page that reads as Shopify must then
// be backed by two more signals before any journey: the store's /cart.js answers as a Shopify cart does, and the home page, run in an
// offline browser page (no request can leave it), leaves a window.Shopify.theme object. When the home page cannot be read (a redirect,
// an error, a bot check), the run starts and the first page the browser opens must show window.Shopify.theme and the store's /cart.js
// must answer as a Shopify cart, or the run stops with exit 2 before anything is tapped.
const platformUnknown = new Set();
const platformHtml = new Map();
const refusePlatform = (msg) => { console.error(`Refusing to run: ${lib.SHOPIFY_ONLY_MESSAGE}. ${msg}, so nothing was run.`); process.exit(2); };
for (const origin of [...new Set(targets.map((t) => t.origin))]) {
  let verdict = { kind: 'unknown', name: null }; let html = '';
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
  const addrs = await dns.lookup(host, { all: true }).catch(() => []);
  const mayFetch = addrs.length && (loopback || !addrs.some((x) => lib.privateAddressKind(x.address)));
  try {
    if (mayFetch) {
      const r = await fetch(new URL('/', origin).toString(), { redirect: 'manual', headers: { 'user-agent': `ai-shopper-agent-panel/${VERSION} (platform check)`, accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
      const headers = Object.fromEntries(r.headers);
      html = r.status >= 200 && r.status < 300 && /html/i.test(r.headers.get('content-type') || '') ? (await r.text()).slice(0, 3000000) : '';
      verdict = lib.classifyStorefront({ status: r.status, headers, html });
    }
  } catch {}
  const hn = new URL(origin).hostname;
  if (verdict.kind === 'other' || verdict.kind === 'hydrogen') refusePlatform(`${hn} ${verdict.kind === 'hydrogen' ? 'is a Shopify Hydrogen (headless) storefront' : verdict.name ? `looks like ${verdict.name}` : 'is not a Shopify Online Store (its home page sets no Shopify.theme)'}`);
  if (verdict.kind === 'conflict') refusePlatform(`${hn} shows a Shopify theme and also ${verdict.name} markup, so its platform is unclear`);
  if (verdict.kind === 'unknown') { platformUnknown.add(origin); console.log(`Platform: ${hn} could not be read before the run; the first page the browser opens must show a Shopify Online Store theme and its /cart.js must answer as a Shopify cart.`); continue; }
  // the second signal: one GET of /cart.js (no redirect followed, no cookie sent, so it reads an empty new cart)
  let cartOk = false;
  try {
    const r = await fetch(new URL('/cart.js', origin).toString(), { redirect: 'manual', headers: { 'user-agent': `ai-shopper-agent-panel/${VERSION} (platform check)`, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    cartOk = r.status === 200 && lib.isShopifyCartJson(JSON.parse((await r.text()).slice(0, 200000)));
  } catch {}
  if (!cartOk) refusePlatform(`${hn}'s home page reads as a Shopify theme, but its /cart.js does not answer as a Shopify cart, so its platform is unclear`);
  platformHtml.set(origin, html);
  console.log(`Platform: ${hn} is a Shopify Online Store (home page theme and /cart.js agree; the theme is checked in the browser next).`);
}
let platformRefused = null;
fs.mkdirSync(shotsDir, { recursive: true });
const browsers = {}; const launchers = {};
// Chromium only (every persona, iPhone ones at iPhone size)
for (const [k, t] of [['chromium', chromium]]) {
  // The fixture store's made-up third-party host is loopback; Chromium's local-network check would block it from a loopback page.
  // Chromium: one merged --disable-features flag turns off speculation (prefetch and prerender), and for the fixture also the
  // local-network check that would block its loopback third-party host.
  // Offline tests only: SP_TEST_HOST_MAP (comma-separated host names) maps those names to 127.0.0.1 so the fixture store can stand in for a
  // tracker host. It is honoured only when every --url is loopback, and it can only point names at 127.0.0.1, never at another server.
  const hostMap = loopback && process.env.SP_TEST_HOST_MAP ? process.env.SP_TEST_HOST_MAP.split(',').map((h) => h.trim().toLowerCase()).filter((h) => /^[a-z0-9.-]+$/.test(h)) : [];
  const launchArgs = k === 'chromium' ? lib.chromiumArgs({ loopback, extraArgs: hostMap.length ? [`--host-resolver-rules=${hostMap.map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`] : [] }) : [];
  // Playwright's own Ctrl-C handling would kill the browsers and exit at once; the runner handles the signals itself (write a partial report).
  launchers[k] = () => t.launch({ headless: !flag('headed'), args: launchArgs, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  try { browsers[k] = await launchers[k](); } catch (e) {
    console.error(`Cannot start the ${k} browser engine: ${lib.oneLine(String(e.message).split('\n')[0], 160)}`);
    console.error(`Install it from the skill folder with: npx playwright install ${k}${process.platform === 'linux' ? ` (on Linux: npx playwright install --with-deps ${k}, which needs sudo for the system libraries)` : ''}`);
    for (const b of Object.values(browsers)) await b.close().catch(() => {});
    process.exit(2);
  }
}
// Runtime proof for each store whose home page read as Shopify: that same home page HTML (already fetched) runs in an offline browser
// page where every request is stopped, and its own scripts must leave a window.Shopify.theme object. A Shopify.theme that is only text
// (a comment, a string, a script that never runs) fails here, and the run stops with exit 2.
for (const [origin, html] of platformHtml) {
  let proof = false;
  try {
    const pctx = await browsers.chromium.newContext({ offline: true, serviceWorkers: 'block', javaScriptEnabled: true });
    await pctx.route('**/*', (route) => route.abort('blockedbyclient').catch(() => {}));
    const pp = await pctx.newPage();
    await pp.setContent(lib.stripSpeculation(html), { waitUntil: 'domcontentloaded', timeout: 15000 });
    proof = await Promise.race([pp.evaluate(lib.shopifyThemeAtRuntime), sleep(5000).then(() => false)]).catch(() => false);
    await pctx.close().catch(() => {});
  } catch {}
  if (!proof) { for (const b of Object.values(browsers)) await b.close().catch(() => {}); refusePlatform(`${new URL(origin).hostname}'s home page names Shopify.theme, but running it leaves no window.Shopify.theme, so its platform is unclear`); }
}
// Chromium sends unload beacons and keepalive requests from the browser process, past ctx.route; one browser-level guard
// (lib.installBrowserNetGuard) applies the current journey's rules to them. Journeys run one at a time, so one policy slot is enough.
let browserNetGuard = 'not attached';
const attachNetGuard = async () => {
  // SP_TEST_SKIP_BROWSER_GUARD: offline tests only (loopback --url), to check how a run reports a guard that did not attach.
  const ng = loopback && (process.env.SP_TEST_SKIP_BROWSER_GUARD || process.env.SP_TEST_NO_CDP_GUARD) ? null : await lib.installBrowserNetGuard(browsers.chromium, () => netPolicy, (d) => { if (netDrop) netDrop(d); }).catch(() => null);
  browserNetGuard = ng ? 'attached (Chromium browser-level request guard)' : 'not attached';
  if (!ng) console.warn('Warning: the Chromium browser-level request guard could not be attached; Chrome-engine journeys will not be run (each is reported as a tool limit).');
  return !!ng;
};
if (browsers.chromium) await attachNetGuard();
// ---------- journey watchdog ----------
// A page can stop responding (a script stuck in a loop blocks every read of the page, and those reads have no timeout of their own).
// Each journey gets a cap: its patience budget (four page loads at the persona's load limit, at least 30 s each) plus 3 minutes, plus
// any wait after a bot check. When the cap passes, the journey's browser context is closed, the journey is marked as a test error,
// and the run moves on, so the report and result.json are always written. SP_TEST_JOURNEY_CAP_SECONDS: offline tests only (loopback).
const DEFAULT_LOAD_SECONDS = 10;
const journeyCapMs = (persona) => {
  const t = Number(process.env.SP_TEST_JOURNEY_CAP_SECONDS);
  if (loopback && t > 0) return t * 1000;
  const load = Number(persona?.patience?.load_seconds) > 0 ? Number(persona.patience.load_seconds) : DEFAULT_LOAD_SECONDS;
  return (Math.max(load * 3, 30) * 4 + 180) * 1000;
};
const TIMED_OUT = 'journey timed out (the page stopped responding)';
const STOPPED = 'the run was stopped (Ctrl-C or a stop signal)';
const STOP_HARD_CAP_MS = 240000;
let stopRequested = false; let stopResolve = null; let runDone = false;
const stopSignal = new Promise((r) => { stopResolve = r; });
const onStopSignal = () => {
  // the run is over and everything is written: a Ctrl-C now just exits with the run's own exit code, without "Stopping..."
  if (runDone) process.exit(process.exitCode ?? 0);
  if (stopRequested) { console.error('\nStopped again: exiting now without the report.'); process.exit(130); }
  stopRequested = true; stopResolve('stop');
  // backstop: the stop path is capped step by step; should it still not finish, the process exits rather than hang
  setTimeout(() => { console.error('\nStopping took too long: exiting now.'); process.exit(130); }, STOP_HARD_CAP_MS).unref();
  console.error('\nStopping: writing a partial report (press Ctrl-C again to quit at once)...');
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, onStopSignal);
// SP_TEST_STDIN_STOP: offline tests only (loopback --url). A line "stop" on standard input acts as Ctrl-C, because on Windows a test
// cannot send Ctrl-C to a child process (child.kill('SIGINT') ends it at once). The stream is unref'd, so it never keeps the run alive.
if (loopback && process.env.SP_TEST_STDIN_STOP) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line === 'stop') onStopSignal(); } });
  process.stdin.on('error', () => {});
  if (typeof process.stdin.unref === 'function') process.stdin.unref();
}
const withTimeout = (pr, ms) => Promise.race([pr.then(() => true, () => true), sleep(ms).then(() => false)]);
function blankJourney(persona) {
  return { persona: persona.id, name: persona.name, device: DEVICES[persona.device].label, engine: DEVICES[persona.device].engine, network: persona.network.name, expected_quit_reason: persona.main_quit_reason, mode: CART_MODE ? 'cart' : 'no-cart', completed: false, checkout_button: null, cart_checks: {}, reached_checkout: false, checkout_page_loaded: false, checkout_request: null, checkout_blocked: [], steps: [], findings: [], warnings: [], trust_matches: [], script_errors: [], filtered_errors: [], blocked: 0, speculation_blocked: 0, beacons_dropped: 0, unload_blocked: 0, unload_dropped: [], rule_hits_on_allowed: [], guard_interventions: [], allowed_hosts: {}, blocked_hosts: {}, by_rule: {}, timings: {}, taps: 0, screens_scrolled: 0, typed_chars: 0, seconds: 0, cart_touched: false };
}
// The Chromium browser-level guard did not attach: a Chrome-engine journey is not run at all (it would send unload beacons and
// keepalive requests past the guard), and is reported as a tool limit.
function unguardedChromiumJourney(persona) {
  const j = blankJourney(persona);
  j.quit_step = 'start'; j.quit_kind = 'test_limit'; j.quit_severity = 'warn';
  j.quit_reason = 'not run: the Chromium browser-level request guard could not be attached, so this Chrome-engine journey was not started. This is a limit of the test tool, not a shopper result; the run is INCOMPLETE';
  j.quit_topic = 'the Chromium browser-level request guard was not attached';
  j.findings.push({ persona: persona.id, severity: 'test', what: `${persona.name}: ${j.quit_reason}`, where: 'step "start"', screenshot: null });
  return j;
}
async function runJourneyWatched(persona, target) {
  const holder = {};
  const started = Date.now();
  const run = runJourney(browsers, persona, target, holder);
  run.catch(() => {});
  const capMs = journeyCapMs(persona);
  let timer;
  const timedOut = new Promise((r) => {
    const tick = () => {
      const extra = ((holder.j && holder.j.backoff_seconds) || 0) * 1000;
      if (Date.now() - started >= capMs + extra) return r('timeout');
      timer = setTimeout(tick, 250);
    };
    tick();
  });
  const first = await Promise.race([run.then((j) => ({ j }), (e) => ({ e })), timedOut, stopSignal]);
  clearTimeout(timer);
  if (first !== 'timeout' && first !== 'stop') {
    if (first.e) throw first.e;
    return first.j;
  }
  // Timed out: keep a copy of what the journey saw so far, then close its context (and its browser if the close hangs).
  holder.stopping = true;
  const base = holder.j ? JSON.parse(JSON.stringify(holder.j)) : null;
  const engine = DEVICES[persona.device].engine;
  // Stopped or timed out: first nothing more leaves the journey's browser (the guard aborts every further request and socket), then its
  // context is closed. The test cart is left as it is (no cleanup); it expires on its own.
  if (netPolicy) netPolicy.halt = true;
  if (holder.guard) await withTimeout(lib.haltGuard(holder.guard, { waitSentMs: 0 }), 20000);
  const closed = holder.ctx ? await withTimeout(holder.ctx.close(), 10000) : true;
  if (!closed && browsers[engine]) {
    await withTimeout(browsers[engine].close(), 10000);
    // after a stop no further journey runs, so the browser is not started again
    if (first !== 'stop') { browsers[engine] = await launchers[engine](); if (engine === 'chromium') await attachNetGuard(); }
  }
  netPolicy = null; netDrop = null; netOwner = null;
  const j = base || blankJourney(persona);
  const where = (j.steps.at(-1) && j.steps.at(-1).step) || 'start';
  j.completed = false; j.reached_checkout = false;
  j.quit_step = where; j.quit_kind = 'test_error'; j.quit_reason = `${first === 'stop' ? STOPPED : TIMED_OUT}; stopped after ${Math.round((Date.now() - started) / 1000)} s, during or after "${where}"`;
  if (first === 'stop') j.stopped = true; else j.timed_out = true;
  j.steps.push({ step: where, at_seconds: +((Date.now() - started) / 1000).toFixed(1), ok: false, detail: j.quit_reason, screenshot: null });
  j.findings.push({ persona: persona.id, severity: 'test', what: `${persona.name}: ${j.quit_reason}. This is not a shopper result; the run is INCOMPLETE`, where: `step "${where}"`, screenshot: null });
  j.seconds = +((Date.now() - started) / 1000).toFixed(1);
  j.screens_scrolled = +(+j.screens_scrolled || 0).toFixed(1);
  return j;
}
const engines = Object.fromEntries(Object.entries(browsers).map(([k, b]) => [k, `Chromium ${b.version()}`]));
console.log(`Shopper panel run ${runId}: ${plan.length} journey(s)`);
const journeys = []; let runError = null;
try {
  for (const { target, persona } of plan) {
    if (stopRequested) break;
    // the pause between journeys ends at once on a stop, and no further journey starts
    // (its timer is cleared after a stop, so a long pause cannot keep the finished process alive)
    if (journeys.length && pauseSec) { let tmr; await Promise.race([new Promise((r) => { tmr = setTimeout(r, Math.round((pauseSec + Math.random() * pauseSec * 0.7) * 1000)); }), stopSignal]); clearTimeout(tmr); }
    if (stopRequested) break;
    process.stdout.write(`  ${persona.id} ... `);
    if (DEVICES[persona.device].engine === 'chromium' && !/^attached/.test(browserNetGuard)) {
      const j = unguardedChromiumJourney(persona); journeys.push(j); console.log(`test limit (not a shopper result): ${j.quit_reason}`); continue;
    }
    const j = await runJourneyWatched(persona, target);
    journeys.push(j);
    if (platformRefused) { console.log(`not a supported store: ${platformRefused}`); break; }
    if (j.quit_kind === 'rate_limited' || j.backoff_seconds) pauseSec = Math.min(120, Math.max(pauseSec, 3) * 2);
    console.log(j.completed ? (j.reached_checkout ? `found the Checkout button in the cart and stopped there, never tapped it (${j.seconds}s, ${j.taps} taps)` : `ready to add to cart, stopped there (${j.seconds}s, ${j.taps} taps)`) : j.store_unreachable ? `could not start: ${j.quit_reason}` : lib.ERROR_KINDS.includes(j.quit_kind) ? `${['test_limit', 'rate_limited'].includes(j.quit_kind) ? 'test limit' : 'test error'} at "${j.quit_step}" (not a shopper result): ${j.quit_reason}` : `quit at "${j.quit_step}": ${j.quit_reason}`);
  }
} catch (e) { runError = lib.oneLine(String(e.message).split('\n')[0], 200); console.error('Run broke:', runError); }
// a timeout on each close: a stuck browser must not keep the report from being written
for (const b of Object.values(browsers)) await withTimeout(b.close(), 15000);
if (platformRefused) {
  // the run never tested a supported store: no report, the run folder is removed, exit 2 (bad setup)
  try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {}
  console.error(`Refusing to run: ${platformRefused}. Nothing else was run.`);
  process.exit(2);
}
if (stopRequested) setupWarnings.push(`the run was stopped before it finished (${journeys.length} of ${plan.length} journeys started); this is a partial report`);

// ---------- results ----------
const sum = (key) => { const o = {}; for (const j of journeys) for (const [k, v] of Object.entries(j[key])) o[k] = (o[k] || 0) + v; return o; };
const blockedHosts = sum('blocked_hosts'); const allowedHosts = sum('allowed_hosts'); const byRule = sum('by_rule');
const findings = journeys.flatMap((j) => j.findings);
const blockers = findings.filter((f) => f.severity === 'block');
const afterRuleHit = journeys.filter((j) => j.rule_hits_on_allowed.length).reduce((n, j) => n + j.findings.filter((f) => f.severity === 'block').length, 0);
const testTrouble = journeys.filter((j) => ['rate_limited', 'test_error'].includes(j.quit_kind));
const toolLimits = journeys.filter((j) => j.quit_kind === 'test_limit');
const errorJourneys = journeys.filter((j) => j.quit_kind === 'error');
const unreachableJourneys = errorJourneys.filter((j) => j.store_unreachable);
// shopper quits only: test errors and tool limits say nothing about the shoppers or the store
const shopperQuits = journeys.filter((j) => !j.completed && !lib.ERROR_KINDS.includes(j.quit_kind));
const exitCode = lib.exitCodeFor({ runError, journeys, planned: plan.length, stopped: stopRequested });
const status = lib.runStatusFor({ runError, journeys, planned: plan.length, stopped: stopRequested });
const reachedN = journeys.filter((j) => j.completed).length;
const goal = CART_MODE ? `reached a visible, enabled Checkout button in the cart (never tapped)` : 'got to a tappable Add to cart (browse only, nothing added)';
const blockedTotal = journeys.reduce((n, j) => n + j.blocked, 0);
const summary = runError || !journeys.length
  ? `The run broke before it finished: ${runError || 'no journeys ran'}.`
  : (journeys.some((j) => j.checkout_page_loaded) ? 'SAFETY FAILURE: a checkout page loaded in the test browser. ' : '')
    + (testTrouble.length ? `Not trustworthy: ${testTrouble.length} journey(s) could not run properly. ` : '')
    + (toolLimits.length ? `Incomplete: ${toolLimits.length} journey(s) hit a tool limit (the panel could not read the page, so those journeys say nothing about shoppers). ` : '')
    + (stopRequested || journeys.length < plan.length ? `Incomplete: the run was stopped before it finished (${journeys.length} of ${plan.length} journeys ran). ` : '')
    + (unreachableJourneys.length ? `Incomplete: the store did not answer for ${unreachableJourneys.length} journey(s); check the address, or that the store (or "npm run fixture") is running, then run again. ` : '')
    + (errorJourneys.length - unreachableJourneys.length > 0 ? `Incomplete: ${errorJourneys.length - unreachableJourneys.length} journey(s) hit an error (a page that would not load, a button that would not respond, or a step that timed out); fix it or run again before reading those journeys as shopper behaviour. ` : '')
    + (journeys.every((j) => lib.ERROR_KINDS.includes(j.quit_kind)) ? 'No journey could be tested, so there is no shopper result. ' : `${reachedN} of ${journeys.length} shopper journeys ${goal}. `
      + (shopperQuits.length ? `Stopped short: ${shopperQuits.map((j) => `${j.name} at "${j.quit_step}"`).join('; ')}. ` : 'Nobody quit. '))
    + `${blockers.length} blocking and ${findings.filter((f) => f.severity === 'warn').length} warning finding(s). ${blockedTotal} browser requests were blocked by the tracker and third-party rules.`
    + (afterRuleHit ? ` ${afterRuleHit} blocking finding(s) came after a named rule stopped a request on the store's own or an allowed host; check before acting.` : '')
    + (setupWarnings.length ? ` Setup warning(s): ${[...new Set(setupWarnings)].join('; ')}.` : '');
const platformsSeen = [...new Set(journeys.map((j) => j.platform).filter(Boolean))];
const result = {
  setup_warnings: [...new Set(setupWarnings)],
  tool: 'ai-shopper-agent-panel', version: VERSION, run_id: runId, started_at: started.toISOString(), finished_at: new Date().toISOString(),
  targets: targets.map((t) => t.toString()), status, exit_code: exitCode, mode: CART_MODE ? 'cart' : 'no-cart', platform: platformsSeen.join(', ') || null,
  checkout_page_loaded: journeys.some((j) => j.checkout_page_loaded),
  checkout_blocked_attempts: journeys.reduce((n, j) => n + j.checkout_blocked.length, 0),
  checkout_reached_server: journeys.reduce((n, j) => n + j.checkout_blocked.filter((x) => x.reached_server).length, 0),
  speculation_blocked: journeys.reduce((n, j) => n + (j.speculation_blocked || 0), 0),
  cart_writes_stopped: journeys.reduce((n, j) => n + (j.cart_writes_stopped || 0), 0),
  beacons_dropped: journeys.reduce((n, j) => n + (j.beacons_dropped || 0) + (j.unload_blocked || 0), 0),
  network_guard: browserNetGuard,
  summary, findings, personas_run: [...new Set(journeys.map((j) => j.persona))], personas_planned: personas.map((p) => p.id), personas_not_run: skipped, engines,
  blocked_requests: { total: blockedTotal, by_rule: byRule },
  third_party: { policy: 'allow-list: the store\'s own host(s) and the hosts listed pass; everything else is blocked', allow_list: baseAllow, allowed_hosts: allowedHosts, blocked_hosts: blockedHosts, wording: TRACKER_WORDING, advice: 'If a blocked host is a widget your page needs to look right (reviews, photo gallery, video, delivery dates), allow it and run again; blocked widgets change the layout.' },
  throttling: 'Both phones run on the Chrome engine (iPhone 14 is Chrome at iPhone size, so Safari-only bugs are not caught); a persona\'s network is throttled for bandwidth and latency.',
  promise: lib.PROMISE,
  journeys: journeys.map(({ findings: _f, ...j }) => j),
  screenshots_dir: rel(shotsDir), error: runError,
};
fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');

// The tested addresses are the user's own, so they are shown as typed (no backslash escapes) inside the panel's own messages.
const ownOrigins = [...new Set(targets.map((t) => t.origin))].map((o) => [lib.mdSafe(o, 400), o]).filter(([e, o]) => e !== o);
const S = (s, max) => ownOrigins.reduce((acc, [e, o]) => acc.split(e).join(o), lib.mdSafe(s, max));
const md = [];
md.push('# Shopper panel report', '');
// one plain line first, for a store owner: what the panel did and did not do
const typedAll = journeys.flatMap((j) => j.typed_list || []);
const typedSeen = [...new Map(typedAll.map((t) => [`${t.box}|${t.text}`, t])).values()];
const typedLine = typedSeen.length ? `it typed only fixed test text and discount codes the store shows on its own pages (${typedSeen.slice(0, 5).map((t) => `${lib.mdQuote(t.text, 40)} into ${lib.mdQuote(t.box, 40)}`).join(', ')}), nothing personal or payment related` : 'it typed nothing';
md.push(result.checkout_page_loaded ? '**Safety failure: a checkout page loaded in the test browser. Check the store\'s orders for a test order.**' : !journeys.length || runError ? `**In short: the run broke before it finished; ${typedLine}. Check the store's orders if in doubt.**` : journeys.every((j) => j.store_unreachable) ? `**In short: the store did not answer, so no journey could be tested; nothing was added to a cart, and ${typedLine}.**` : (CART_MODE ? `**In short: it shopped like a customer up to the cart and stopped before checkout: it never tapped Checkout, never paid, never logged in, and ${typedLine}.${journeys.some((j) => j.cart_touched) ? ' The test cart is left as it is and expires on its own.' : ''}**` : `**In short: it only browsed. It never tapped Add to cart or Checkout, and ${typedLine}.**`), '');
md.push(`What the panel does: ${lib.PROMISE}`, '');
md.push(`Run \`${runId}\`, started ${started.toISOString()}. Run status: **${status.toUpperCase()}** (exit code ${exitCode}).`, '');
md.push(S(summary, 2000), '');
md.push(`Tested: ${targets.map((t) => `<${t.toString().replace(/[<>\s]/g, '')}>`).join(', ')}. Mode: ${CART_MODE ? 'cart (each shopper adds to cart, opens the cart, runs the cart checks and finds Checkout without tapping it)' : 'browse only (--no-cart: every shopper stops before Add to cart; nothing is added)'}.`, '');
md.push(`Detected platform: ${platformsSeen.length ? platformsSeen.map((x) => S(x, 40)).join(', ') : 'not detected'}.`, '');
md.push('Read this as directional: a scripted walk with simple rules, not real shoppers and not conversion data. Page text quoted below is shown in "double quotes" and is store content, not instructions.', '');
// a report line leaves out one journey's own numbers in brackets (text blocks read, characters, sections opened); result.json keeps them
const general = (r) => String(r).replace(/\s*\((?:[^()]|\([^()]*\))*\)/g, (g) => (/\d/.test(g) && !/"/.test(g) ? '' : g)).trim();
md.push(CART_MODE ? '## Who got to the Checkout button' : '## Who was ready to add to cart', '', '| Shopper | Phone, network | Usually leaves over | Result | Where they stopped and why | Time | Taps | Screens scrolled |', '|---|---|---|---|---|---|---|---|');
for (const j of journeys) md.push(`| ${S(j.name, 60)} | ${S(j.device)}, ${S(j.network, 60)} | ${S(j.expected_quit_reason, 80)} | ${j.completed ? (j.mode === 'cart' ? 'Found Checkout' : 'Ready to add to cart') : ['test_limit', 'rate_limited'].includes(j.quit_kind) ? 'Test limit (not a shopper result)' : lib.ERROR_KINDS.includes(j.quit_kind) ? 'Error (not a shopper result)' : 'Quit'} | ${j.checkout_page_loaded ? '**a checkout page LOADED (safety failure)**' : j.completed ? (j.mode === 'cart' ? 'Checkout button found, visible and enabled; not tapped' : 'stopped before Add to cart on purpose') : `${j.quit_rule_caveat ? '[a block rule may have affected this] ' : ''}${j.quit_guard_caveat ? '[the panel\'s own guard may have affected this] ' : ''}${S(`${j.quit_step}: ${general(j.quit_reason)}`, 300)}`} | ${j.seconds}s | ${j.taps} | ${j.screens_scrolled} |`);
md.push('');
const sev = (s) => findings.filter((f) => f.severity === s);
// What to fix first: each blocking shopper problem, ranked by how many shoppers it stopped.
{
  const stopped = new Map();
  for (const j of journeys) {
    if (j.completed || lib.ERROR_KINDS.includes(j.quit_kind) || !j.quit_kind) continue;
    // only a journey whose own quit was a blocking finding, grouped by the exact thing that stopped them
    if (j.quit_severity !== 'block') continue;
    const key = `${j.quit_step}|${j.quit_kind}|${String(j.quit_topic || j.quit_reason).toLowerCase()}`;
    const e = stopped.get(key) || { step: j.quit_step, kind: j.quit_kind, reason: j.quit_reason, topic: j.quit_topic || '', who: [] };
    let pg = ''; try { pg = new URL(j.product_url || j.start_url).pathname; } catch {}
    e.who.push({ name: j.name, page: pg }); stopped.set(key, e);
  }
  const ranked = [...stopped.values()].sort((a, b) => b.who.length - a.who.length);
  if (ranked.length) {
    md.push('## What to fix first', '', 'Each blocking problem, with the shoppers it stopped. Most shoppers first.', '');
    // a plain suggested fix for each kind of stop, where there is an obvious one
    const FIX = { required_info_missing: (e) => `Suggested fix: put ${lib.mdQuote(e.topic, 60)} in the product description or a section near the price, in plain words a shopper would look for.`, patience_exceeded: () => 'Suggested fix: make the page show its heading and first photo sooner on a phone (a smaller first image, fewer scripts and apps loading before it).', broken_link: () => 'Suggested fix: fix the link or the address, or redirect it to the right page.', sold_out: () => 'Suggested fix: restock it, or say when it is back and offer something close.', element_covered: () => 'Suggested fix: make sure nothing (a pop-up, a chat bubble or a sticky bar) covers the button on a phone.', not_found: () => 'Suggested fix: make sure the page links to its products, and the cart shows an enabled Checkout button.', shipping_cost: () => 'Suggested fix: show a cheaper shipping option, or a free-shipping threshold, before the cart.' };
    ranked.forEach((e, i) => md.push(`${i + 1}. At "${S(e.step, 60)}", ${e.who.length} shopper${e.who.length === 1 ? '' : 's'} (${e.who.map((w) => (e.who.length > 1 && w.page ? `${S(w.name, 60)} on ${S(w.page, 80)}` : S(w.name, 60))).join(', ')}): ${S(general(e.reason), 300)}${FIX[e.kind] ? ` ${FIX[e.kind](e)}` : ''}`));
    md.push('');
  }
}
for (const [s, title] of [['test', 'Test problems (not shopper results)'], ['block', 'Blocking'], ['warn', 'Friction worth fixing'], ['note', 'Notes']]) {
  const list = sev(s); if (!list.length) continue;
  md.push(`## ${title}`, '');
  const seen = new Map();
  for (const f of list) { const k = `${f.what}|${f.where}`; if (!seen.has(k)) seen.set(k, f); }
  for (const f of seen.values()) md.push(`- ${S(f.what, 400)} (${S(f.where, 80)}, ${S(f.persona, 60)})${f.screenshot ? `. Screenshot: ${S(f.screenshot, 200)}` : ''}`);
  md.push('');
}
const tm = journeys.flatMap((j) => j.trust_matches.map((m) => ({ ...m, who: j.name })));
if (tm.length) {
  // where on the page each one was found (a page-structure path) is in result.json under trust_matches, not here
  md.push('## What they found', '', '| Shopper | Looked for | Found (page text) |', '|---|---|---|');
  for (const m of tm) md.push(`| ${S(m.who, 60)} | ${S(m.need, 100)} | ${m.heading_only ? `heading only (not counted as found): ${lib.mdQuote(m.context, 80)}` : lib.mdQuote(m.context, 120)} |`);
  md.push('');
}
md.push('## Files', '', `- Screenshots: ${S(rel(shotsDir), 200)}`, `- Machine-readable result: ${S(rel(path.join(runDir, 'result.json')), 200)}`, '');
md.push(`Engines: ${Object.values(engines).join(', ') || 'none'}. Personas not run: ${skipped.map((x) => S(x)).join(', ') || 'none'}.`, '');
md.push('## Safety details', '', '<details><summary>How the panel kept this a test (open for the details)</summary>', '',
  `- ${S(TRACKER_WORDING, 400)}`,
  `- Blocked by named rule: ${Object.entries(byRule).filter(([k]) => k !== 'not-allow-listed').map(([k, v]) => `${S(k)} ${v}`).join(', ') || 'none seen'}${byRule['not-allow-listed'] ? `; ${byRule['not-allow-listed']} more to hosts not on the allow-list` : ''}.`,
  `- Third-party hosts allowed through: ${Object.keys(allowedHosts).map((h) => S(h)).join(', ') || 'none seen'}. Blocked third-party hosts: ${Object.entries(blockedHosts).map(([h, n]) => `${S(h)} ${n}`).join(', ') || 'none seen'}.`,
  '- If a blocked host is a widget the page needs to look right (reviews, photo gallery, video, delivery dates), allow it with --allow-host and run again: blocked widgets change the layout the shoppers see.',
  `- Script errors set aside because they came from a blocked request or from the test browser itself: ${journeys.reduce((n, j) => n + j.filtered_errors.length, 0)} (listed in result.json). Script errors counted against the store: ${journeys.reduce((n, j) => n + j.script_errors.length, 0)}; up to 3 per journey are in the findings above, and every one is in result.json.`,
  `- Chromium browser-level request guard (stops beacons and keepalive requests a closing page sends past the normal guard): ${S(browserNetGuard, 80)}.${browsers.chromium && !/^attached/.test(browserNetGuard) ? ' **Not attached: Chrome-engine journeys were not run (each is a tool limit), so nothing could pass the guard that way.**' : ''}`,
  ...(journeys.some((j) => j.rule_hits_on_allowed.length) ? [`- Named block rules that stopped a request on the store's own or an allowed host: ${[...new Set(journeys.flatMap((j) => j.rule_hits_on_allowed.map((x) => x.rule)))].map((n) => S(n, 40)).join(', ')} (requests listed in result.json under rule_hits_on_allowed). After one of these, a quit a missing request could cause (a page that did not load or was not usable in time, an element not found, a page the panel could not read) is marked as a tool limit; a content quit (required information missing, sold out, the price too far down, the persona's tap limit) keeps its kind and finding with a caveat naming the rule (quit_rule_caveat), and is marked [a block rule may have affected this] in the table above. ${afterRuleHit} blocking finding(s) came after such a stop; check before acting.`] : []),
  ...(journeys.some((j) => (j.guard_interventions || []).length) ? [`- Requests the panel's own guard stopped that a page may rely on (a cart write the page tried on its own, a server redirect to another origin, an event stream, a worker without the guard): ${journeys.reduce((n, j) => n + (j.guard_interventions || []).length, 0)} kind(s) across ${journeys.filter((j) => (j.guard_interventions || []).length).length} journey(s) (listed in result.json under guard_interventions). After one of these, a quit a missing request could cause is marked as a tool limit; a content quit keeps its kind with a caveat (quit_guard_caveat), marked [the panel's own guard may have affected this] in the table above.`] : []),
  ...(setupWarnings.length ? [`- Setup warnings: ${[...new Set(setupWarnings)].map((w) => S(w, 200)).join('; ')}.`] : []),
  `- Checkout page loaded in any journey (measured): ${result.checkout_page_loaded ? '**YES (safety failure)**' : 'no'}. Checkout requests stopped inside the test browser: ${result.checkout_blocked_attempts}.`,
  '- Arrival was a labelled test link (utm_source=shopper-panel, utm_medium=qa-test, utm_campaign=shopper-panel-test) with no referer.',
  `- Typing: ${typedSeen.length ? `only fixed test text (a postcode from a fixed table, TEST or ABC) and discount codes the store shows on its own pages (${typedSeen.map((t) => `${lib.mdQuote(t.text, 40)} into ${lib.mdQuote(t.box, 40)}`).join(', ')}); nothing personal or payment related` : 'nothing was typed'}. ${!journeys.length || runError ? 'Whether an order was placed was not measured, because the run broke; check the store\'s orders.' : result.checkout_page_loaded ? '**A checkout page loaded, so this run cannot say no order was placed: check the store\'s orders for a test order.**' : `What backs "no order": the panel never taps Checkout, buy-now, express or wallet buttons, or login (each tap passes one refusal policy first); no recognised checkout page loaded in any tab or frame (measured by address and by page content, including payment card fields); every checkout, payment or login request the panel recognised was stopped inside the test browser (${result.checkout_blocked_attempts}).`}`,
  ...(journeys.some((j) => j.cart_writes_stopped) ? [`- Cart writes the store's pages tried on their own, stopped inside the test browser because browse only (--no-cart) never puts anything in a cart: ${journeys.reduce((n, j) => n + (j.cart_writes_stopped || 0), 0)} (listed in result.json under cart_writes_stopped_list).`] : []),
  ...(journeys.some((j) => j.cart_touched) ? ['- The test cart is left as it is after each journey (the panel does not empty it); store carts expire on their own. The store\'s analytics will see the visit and the add to cart, like any shopper.'] : []),
  ...(loopback && Object.keys(blockedHosts).some((h) => /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)(:\d+)?$/i.test(h)) ? ['- This was a practice run on this computer (loopback). The practice store\'s made-up tracker host is localhost, so seeing localhost in the blocked hosts is intentional: it shows the blocking works.'] : []),
  `- ${result.throttling}`, '', '</details>', '');
const mdText = md.join('\n');
fs.writeFileSync(path.join(runDir, 'report.md'), mdText);
if (opt('report')) { const rp = path.resolve(opt('report')); fs.mkdirSync(path.dirname(rp), { recursive: true }); fs.writeFileSync(rp, mdText); }

console.log(`\nRun status: ${status.toUpperCase()}. ${summary}`);
console.log(`Report: ${rel(path.join(runDir, 'report.md'))}${opt('report') ? ` (also ${rel(path.resolve(opt('report')))})` : ''}\nJSON:   ${rel(path.join(runDir, 'result.json'))}`);
process.exitCode = exitCode;
runDone = true;
// SP_TEST_LINGER_MS: offline tests only (loopback --url); keeps the finished process alive for a moment, so a test can send a Ctrl-C
if (loopback && Number(process.env.SP_TEST_LINGER_MS) > 0) setTimeout(() => {}, Math.min(Number(process.env.SP_TEST_LINGER_MS), 30000));
// A journey the watchdog gave up on may still hold a timer; everything is written, so do not wait for it.
if (journeys.some((j) => j.timed_out || j.stopped)) setTimeout(() => process.exit(exitCode), 2000).unref();
