// Shared persona checks used by the runner and by scripts/validate-personas.mjs.
import { safeRegex, HOST_PATTERN, MAX_REGEX_LEN } from './panel-lib.mjs';

export const DEVICES = ['iphone-14', 'pixel-7'];
export const CHANNELS = ['ad', 'google search', 'instagram', 'email', 'direct'];
export const POPUPS = ['leave', 'close-once', 'close-always'];
export const LOOK_IN = ['product', 'reviews', 'both'];
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;
// Text caps keep a persona file small and keep any one field from flooding the report.
export const CAPS = { short: 120, text: 600, based_on: 400, list: 20 };

// Persona and config files: at most 256 KB each, read as UTF-8 with a leading byte order mark (written by some Windows editors)
// removed. Returns { value } or { err }.
export const MAX_JSON_BYTES = 256 * 1024;
export function readJsonFile(fs, file) {
  let st; try { st = fs.statSync(file); } catch (e) { return { err: `cannot be read (${e.code || e.message})` }; }
  if (st.size > MAX_JSON_BYTES) return { err: `is ${Math.round(st.size / 1024)} KB; a persona or config file may be at most ${MAX_JSON_BYTES / 1024} KB` };
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { err: `cannot be read (${e.code || e.message})` }; }
  try { return { value: JSON.parse(text.replace(/^\uFEFF/, '')) }; } catch (e) { return { err: `does not parse (${e.message})` }; }
}
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string' && v.trim().length > 0;
const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function regexErr(src, where, e, bounded = false) {
  if (typeof src !== 'string') { e.push(`${where} must be a text pattern`); return; }
  if (src.length > MAX_REGEX_LEN) { e.push(`${where} is longer than ${MAX_REGEX_LEN} characters`); return; }
  const r = safeRegex(src, 'i', { bounded });
  if (r.err) e.push(`${where} is not a valid pattern: ${r.err}`);
}

export function checkPersona(p) {
  const e = [];
  if (!isObj(p)) return ['the file must hold one JSON object'];
  if (!str(p.id) || !ID_PATTERN.test(p.id)) e.push('"id" must be lowercase letters, digits and dashes, at most 60 characters');
  for (const k of ['name', 'main_quit_reason']) if (!str(p[k])) e.push(`missing text field "${k}"`); else if (p[k].length > CAPS.short) e.push(`"${k}" is longer than ${CAPS.short} characters`);
  for (const k of ['who', 'voice_line', 'shopping_for', 'quits_when', 'success_goal']) if (!str(p[k])) e.push(`missing text field "${k}"`); else if (p[k].length > CAPS.text) e.push(`"${k}" is longer than ${CAPS.text} characters`);
  if (!['active', 'draft'].includes(p.status)) e.push('"status" must be "active" or "draft"');
  if (!['data', 'inferred'].includes(p.evidence)) e.push('"evidence" must be "data" or "inferred" (no evidence = inferred)');
  if (!isObj(p.entry_point) || !CHANNELS.includes(p.entry_point.channel) || !str(p.entry_point.landing_path) || !p.entry_point.landing_path.startsWith('/') || p.entry_point.landing_path.startsWith('//') || p.entry_point.landing_path.length > 300) e.push(`"entry_point" needs channel (${CHANNELS.join(' / ')}) and a landing_path starting with a single "/"`);
  if (!DEVICES.includes(p.device)) e.push(`"device" must be one of ${DEVICES.join(', ')}`);
  const n = p.network;
  if (!isObj(n) || !str(n.name) || !num(n.latency_ms) || !('down_kbps' in n) || !('up_kbps' in n)) e.push('"network" needs name, latency_ms, down_kbps, up_kbps (null kbps = no throttling)');
  else for (const k of ['down_kbps', 'up_kbps']) if (n[k] !== null && !num(n[k])) e.push(`network.${k} must be a number or null`);
  const pt = p.patience;
  if (!isObj(pt) || !['load_seconds', 'max_screens_to_price', 'max_taps_to_checkout'].every((k) => num(pt[k]) && pt[k] > 0)) e.push('"patience" needs load_seconds, max_screens_to_price, max_taps_to_checkout (numbers above 0)');
  if ('popups' in p && !POPUPS.includes(p.popups)) e.push(`"popups" must be one of ${POPUPS.join(', ')}`);
  if ('photos_to_view' in p && !(Number.isInteger(p.photos_to_view) && p.photos_to_view >= 1 && p.photos_to_view <= 10)) e.push('"photos_to_view" must be a whole number from 1 to 10');
  if ('in_app_browser' in p && p.in_app_browser !== null && p.in_app_browser !== 'facebook') e.push('"in_app_browser" must be "facebook" or null');
  if (!Array.isArray(p.before_buying) || !p.before_buying.length) e.push('"before_buying" needs at least one need');
  else if (p.before_buying.length > CAPS.list) e.push(`"before_buying" has more than ${CAPS.list} needs`);
  else p.before_buying.forEach((b, i) => {
    if (!isObj(b) || !str(b.need) || !Array.isArray(b.look_for) || !b.look_for.length || !['warn', 'quit'].includes(b.if_missing)) { e.push(`before_buying[${i}] needs need, look_for (pattern list), if_missing (warn|quit)`); return; }
    if (b.need.length > CAPS.short) e.push(`before_buying[${i}].need is longer than ${CAPS.short} characters`);
    if (b.look_for.length > CAPS.list) e.push(`before_buying[${i}].look_for has more than ${CAPS.list} patterns`);
    if ('look_in' in b && !LOOK_IN.includes(b.look_in)) e.push(`before_buying[${i}].look_in must be one of ${LOOK_IN.join(', ')}`);
    b.look_for.forEach((r, k) => regexErr(r, `before_buying[${i}].look_for[${k}]`, e, true));
  });
  if (!Array.isArray(p.choices)) e.push('"choices" must be a list (can be empty)');
  else if (p.choices.length > CAPS.list) e.push(`"choices" has more than ${CAPS.list} entries`);
  else p.choices.forEach((c, i) => {
    if (!isObj(c) || !str(c.option)) { e.push(`choices[${i}] needs "option" (a pattern for the option's label) and "pick" (a pattern or null)`); return; }
    regexErr(c.option, `choices[${i}].option`, e);
    if (c.pick !== null && c.pick !== undefined) regexErr(c.pick, `choices[${i}].pick`, e);
    // a persona never chooses what is typed: the panel types only fixed test text (TEST, ABC, a postcode from a fixed table) and
    // discount codes the store shows on its own pages
    if ('type_text' in c) e.push(`choices[${i}].type_text is no longer supported: the panel types only fixed test text (TEST, or ABC for a box of 3 characters or fewer) into a required box, so remove it`);
  });
  if (p.product_pick !== null && p.product_pick !== undefined) regexErr(p.product_pick, '"product_pick"', e);
  // the most the shopper pays for shipping before leaving at the cart (a money amount); without it, 20 percent of the subtotal
  if ('shipping_quit_over' in p && p.shipping_quit_over !== null && !num(p.shipping_quit_over)) e.push('"shipping_quit_over" must be a money amount of 0 or more, or null (20 percent of the subtotal)');
  if ('allow_hosts' in p) {
    if (!Array.isArray(p.allow_hosts) || p.allow_hosts.length > CAPS.list) e.push(`"allow_hosts" must be a list of up to ${CAPS.list} host names`);
    else p.allow_hosts.forEach((h, i) => { if (typeof h !== 'string' || !HOST_PATTERN.test(h)) e.push(`allow_hosts[${i}] must be a host name such as "cdn.reviews.example" or "*.reviews.example"`); });
  }
  if (!Array.isArray(p.based_on) || !p.based_on.length || !p.based_on.every(str)) e.push('"based_on" needs at least one exact number, quote or file name');
  else if (p.based_on.length > CAPS.list || p.based_on.some((x) => x.length > CAPS.based_on)) e.push(`"based_on" allows up to ${CAPS.list} items of up to ${CAPS.based_on} characters`);
  return e;
}

// Panel-level checks. Shared main quit reasons are a WARNING: a panel works best when every persona tests a different reason to leave,
// but two personas with the same reason are still valid.
export function checkPanel(personas) {
  const warnings = []; const seen = new Map(); const ids = new Map();
  for (const p of personas) {
    if (ids.has(p.id)) warnings.push(`two files use the id "${p.id}"`); else ids.set(p.id, true);
    const k = String(p.main_quit_reason || '').trim().toLowerCase();
    if (!k) continue;
    if (seen.has(k)) warnings.push(`"${p.id}" and "${seen.get(k)}" share the main quit reason "${k}" (consider making them test different reasons)`); else seen.set(k, p.id);
  }
  return warnings;
}

export function deviceMix(personas) {
  const m = {}; for (const p of personas) m[p.device] = (m[p.device] || 0) + 1;
  return m;
}
// Where the settings file is, the same for the runner and the validator: --config when given, else ./shopper-panel.config.json, else
// the one next to a persona folder (its parent folder). Returns { file, note } (file null when there is none).
export function findConfigFile({ explicit = null, personaDirs = [], cwd = process.cwd(), fs, path }) {
  if (explicit) return { file: path.resolve(cwd, explicit), note: null };
  const here = path.resolve(cwd, 'shopper-panel.config.json');
  if (fs.existsSync(here)) return { file: here, note: null };
  const near = [...new Set(personaDirs.map((d) => path.join(path.dirname(path.resolve(cwd, d)), 'shopper-panel.config.json')))].filter((f) => fs.existsSync(f));
  if (!near.length) return { file: null, note: null };
  const r = path.relative(cwd, near[0]); const show = r && !r.startsWith('..') && !path.isAbsolute(r) ? r : near[0];
  return { file: near[0], note: `Note: no shopper-panel.config.json in this folder; using ${show}, next to the persona folder.` };
}
