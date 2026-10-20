// npm run demo: start the offline practice store, run the 3 example personas against it (browse only: every shopper stops before
// Add to cart), and write the report to a fresh folder in the system's temporary folder. It never changes the skill's own files.
// Never touches a real website: the practice store listens on this computer only.
// Maintainers: node scripts/demo.mjs --update-sample also rewrites examples/sample-report.md and examples/sample-screenshots/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await startFixtureServer();
console.log(`Fixture store running at ${server.origin} (made up, loopback only)`);
const updateSample = process.argv.includes('--update-sample');
// the sample report is built inside the skill folder (its links are relative to it); a normal demo writes to a temporary folder
const outRoot = updateSample ? root : fs.mkdtempSync(path.join(os.tmpdir(), 'shopper-panel-demo-'));
const args = [path.join(root, 'scripts', 'shopper-panel.mjs'), '--url', server.origin, '--i-own', '127.0.0.1', '--personas', path.join(root, 'examples', 'personas'), '--include-drafts', '--pause', '0', '--out', path.join(outRoot, 'reports', 'demo'), ...(updateSample ? ['--report', path.join(root, 'examples', 'sample-report.md')] : [])];
const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd: outRoot, stdio: 'inherit' });
  child.on('exit', (c) => resolve(c ?? 1));
});
await server.close();
// The sample report ships with a few of its screenshots in examples/sample-screenshots/, linked relative to examples/. Links to
// screenshots that are not shipped are dropped, and the Files section says where a fresh demo puts the full set.
const reportPath = path.join(root, 'examples', 'sample-report.md');
if (updateSample && fs.existsSync(reportPath)) {
  const shipDir = path.join(root, 'examples', 'sample-screenshots');
  fs.rmSync(shipDir, { recursive: true, force: true }); fs.mkdirSync(shipDir, { recursive: true });
  let md = fs.readFileSync(reportPath, 'utf8'); let shipped = 0;
  md = md.replace(/\. Screenshot: (reports\/demo\/[A-Za-z0-9-]+\/screenshots\/([a-z0-9-]+\.jpg))/g, (m, rel, file) => {
    const src = path.join(root, rel);
    if (shipped >= 3 || !fs.existsSync(src)) return '';
    if (!fs.existsSync(path.join(shipDir, file))) { fs.copyFileSync(src, path.join(shipDir, file)); shipped++; }
    return `. Screenshot: [${file}](sample-screenshots/${file})`;
  });
  md = md.replace(/^- Screenshots: reports\/demo\/.*$/m, '- Screenshots: a few are shipped in examples/sample-screenshots/; `npm run demo` writes the full set to a temporary folder and prints where')
    .replace(/^- Machine-readable result: reports\/demo\/.*$/m, '- Machine-readable result: `npm run demo` writes result.json next to its report');
  fs.writeFileSync(reportPath, md);
}
const hits = Object.keys(server.hits).filter((p) => /^\/checkouts?(\/|$)|^\/kasse|wc\/store\/v1\/checkout/.test(p));
if (hits.length) { console.error(`SAFETY: the fixture checkout was requested: ${hits.join(', ')}`); process.exit(1); }
const demoDir = path.join(outRoot, 'reports', 'demo');
const run = fs.existsSync(demoDir) ? fs.readdirSync(demoDir).sort().pop() : null;
const where = run ? path.join(demoDir, run, 'report.md') : demoDir;
console.log(code === 0 ? `Demo finished. It works. Open the report: ${where}` : `Demo run exited with code ${code}. Report (if written): ${where}`);
process.exit(code);
