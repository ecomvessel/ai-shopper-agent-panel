// Check that every persona file parses, has every required field, and that every pattern compiles.
// Usage: node scripts/validate-personas.mjs [personas-dir ...]
// Default: ./personas in the current folder only. To check the shipped examples: node scripts/validate-personas.mjs examples/personas
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPersona, checkPanel, deviceMix, findConfigFile, readJsonFile } from './persona-schema.mjs';

const skillDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dirs = args.length ? args.map((d) => path.resolve(d)) : [path.resolve('personas')];
// Paths are shown relative to the current folder when they are inside it, and in full otherwise, so every line says which file it means.
const show = (p) => { const r = path.relative(process.cwd(), p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p; };
let bad = 0, warn = 0, total = 0, seenDir = 0; let cfgFile = null;
const idsSeen = new Map();
for (const dir of [...new Set(dirs)]) {
  if (!fs.existsSync(dir)) { console.log(`FAIL persona folder ${show(dir)}: folder not found${args.length ? '' : '. Run this from your project folder (where your personas/ folder is), or pass the folder: node <skill folder>/scripts/validate-personas.mjs <your personas folder>'}`); bad++; continue; }
  seenDir++;
  console.log(`Persona folder: ${show(dir)}`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (!files.length) { warn++; console.log(`WARN ${show(dir)}: no persona files (*.json) here yet. Write your shoppers from templates/persona-card.md (the files in examples/personas/ are samples for the practice store, not a real panel)`); }
  const list = [];
  for (const f of files) {
    total++;
    const file = path.join(dir, f);
    const rd = readJsonFile(fs, file);
    if (rd.err) { console.log(`FAIL ${show(file)}: ${rd.err}`); bad++; continue; }
    const p = rd.value;
    const errs = checkPersona(p);
    if (p && path.basename(f, '.json') !== p.id) errs.push('"id" must match the file name');
    if (p && typeof p.id === 'string' && idsSeen.has(p.id)) errs.push(`the id "${p.id}" is also used by ${show(idsSeen.get(p.id))}`);
    if (p && typeof p.id === 'string' && !idsSeen.has(p.id)) idsSeen.set(p.id, file);
    if (errs.length) { bad++; console.log(`FAIL ${show(file)}`); errs.forEach((x) => console.log(`  - ${x}`)); } else { console.log(`ok   ${show(file)}`); list.push(p); }
  }
  for (const x of checkPanel(list)) { warn++; console.log(`WARN ${show(dir)}: ${x}`); }
  if (list.length) console.log(`     device mix in ${show(dir)}: ${JSON.stringify(deviceMix(list))} (compare to your analytics)`);
}
// Named block rules: the shipped list, plus block_rules in ./shopper-panel.config.json when there is one. Each must say whether it is a
// host rule or a path rule (see scripts/blocklist.json).
{
  const { checkBlockRule } = await import('./panel-lib.mjs');
  const lists = [[path.join(skillDir, 'scripts', 'blocklist.json'), 'rules']];
  // the same lookup as the runner: ./shopper-panel.config.json, else the one next to a checked persona folder
  const found = findConfigFile({ personaDirs: dirs, fs, path });
  cfgFile = found.file;
  if (found.note) console.log(found.note);
  if (cfgFile) lists.push([cfgFile, 'block_rules']);
  const builtinFile = lists[0][0];
  for (const [file, key] of lists) {
    const rd = readJsonFile(fs, file);
    if (rd.err) { console.log(`FAIL ${show(file)}: ${rd.err}`); bad++; continue; }
    const cfg = rd.value;
    const rules = cfg[key]; if (rules === undefined) continue;
    if (!Array.isArray(rules)) { console.log(`FAIL ${show(file)}: "${key}" must be a list`); bad++; continue; }
    const builtin = file === builtinFile;
    const label = builtin ? `built-in block rules ${show(file)}` : `your block rules ${show(file)}`;
    const probs = rules.flatMap((r, i) => checkBlockRule(r, { builtin }).map((x) => `rule ${i + 1} (${(r && typeof r.name === 'string' && r.name.trim()) || '(no name)'}): ${x}`));
    if (probs.length) { bad++; console.log(`FAIL ${label}`); probs.forEach((x) => console.log(`  - ${x}`)); console.log('  How to write a rule, with worked examples: docs/block-rules.md'); } else console.log(`ok   ${label}: ${rules.length} rule(s), each a host rule or a path rule`);
  }
}
if (!seenDir) console.log('No persona folder found. Run this from your project folder (where your personas/ folder is), or pass the folder. A new panel starts from templates/persona-card.md.');
console.log(bad ? `\n${bad} problem(s) in ${total + (cfgFile ? 1 : 0)} file(s)${cfgFile ? ` (${total} personas + config)` : ''}.` : total ? `\nAll ${total} persona file(s) valid${warn ? ` (${warn} warning(s))` : ''}.` : '\nNo persona files checked (see the warning above).');
process.exit(bad ? 1 : 0);
