#!/usr/bin/env node
// Opt-in acceptance against an installed DSH, with a disposable HOME/cwd only.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createDashboardSmokeFixture } from './dashboard-smoke-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  'install-anchor': { type: 'string' }, 'output-dir': { type: 'string' },
} });
const anchor = values['install-anchor'] || process.env.DSH_INSTALL_ANCHOR;
if (!anchor) throw new Error('Pass --install-anchor <@deepseek-ai/dsh/package.json>.');
const manifest = JSON.parse(readFileSync(resolve(anchor), 'utf8'));
assert.equal(manifest.name, '@deepseek-ai/dsh', 'DSH installation anchor must name the official CLI package');
const cli = dirname(resolve(anchor));
const playwrightRequire = process.env.PLAYWRIGHT_MODULE_ROOT
  ? createRequire(join(resolve(process.env.PLAYWRIGHT_MODULE_ROOT), 'package.json')) : createRequire(import.meta.url);
const { chromium } = playwrightRequire('playwright');
const output = resolve(values['output-dir'] || join(root, '.superpowers/sdd/dashboard-native-smoke'));
mkdirSync(output, { recursive: true });
const sessionId = 'dashboard-preview-session';
const fixture = createDashboardSmokeFixture({ sessionIds: [sessionId] });
const before = fixture.hashes();
const home = mkdtempSync(join(tmpdir(), 'gungnir-dashboard-native-'));
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
delete env.DSH_PROFILE_DIR;
const previousHome = process.env.DSH_HOME;
const oldOut = process.stdout.write;
const oldErr = process.stderr.write;
let booted, browser, page;
const result = { dsh_version: manifest.version, fixture: 'synthetic temporary databases and session log', checks: [], page_errors: [], stage: 'initialize' };
// The official boot logger can print its process launch token. Never capture it in artifacts.
const bootMessages = [];
const suppressBoot = chunk => { if (bootMessages.length < 500) bootMessages.push(String(chunk)); return true; };
process.stdout.write = suppressBoot;
process.stderr.write = suppressBoot;
try {
  execFileSync(process.execPath, [join(cli, 'lib/bin.js'), '--profile', 'web', '--dump-config'], { env, stdio: 'ignore' });
  writeFileSync(join(home, 'profiles/web/cordis.patch.yml'), `- insert:\n    - id: dashboard-smoke\n      name: ${JSON.stringify(join(root, 'packages/warroom-dashboard/src/dsh-entry.mjs'))}\n      config:\n        home: ${JSON.stringify(fixture.home)}\n        sessionBindings:\n          ${sessionId}: ${fixture.engagementId}\n`);
  process.env.DSH_HOME = home;
  const hostRequire = createRequire(join(cli, 'package.json'));
  const { runProfile } = await import(pathToFileURL(join(cli, 'lib/profile-boot.js')).href);
  const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-launch-environment')).href);
  result.stage = 'boot plugin';
  booted = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]), profile: 'web', patchFiles: [], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  const { ctx } = booted;
  await ctx.get('loader')?.await?.();
  const port = ctx.get('webServer').port;
  const base = `http://127.0.0.1:${port}`;
  const workspacePath = join(home, 'workspace');
  mkdirSync(workspacePath, { recursive: true });
  const workspace = await ctx.get('workspaceController').create({ path: workspacePath });
  await ctx.get('sessionController').create({ sessionId, workspaceId: workspace.workspace.workspaceId });
  const session = ctx.get('sessions').get(sessionId);
  assert(session, 'Created session is attached in the isolated store');
  result.stage = 'synthetic committed messages';
  for (const message of fixture.messages) {
    const content = [{ type: 'text', text: message.text }];
    if (message.role === 'user') session.append('user/message', { role: 'user', id: message.id, content, source: { kind: 'user' } }, { surfaceOp: 'append' });
    else session.append('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', id: message.id, content, source: { kind: 'model', provider: 'synthetic-fixture', model: 'synthetic-fixture' } }, stream: [],
    }, { surfaceOp: 'append' });
  }
  await ctx.get('sessions').flush(session);
  const inspection = await ctx.get('sessionController').inspect(sessionId);
  assert(inspection.events.length >= 2, 'Test messages entered the official session log');
  result.checks.push('official Session.append + durability checkpoint; no prompt issued');
  result.stage = 'native routes';
  const staticResponse = await fetch(`${base}/gungnir-dashboard/`);
  assert.equal(staticResponse.status, 200);
  assert.match(staticResponse.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.equal(staticResponse.headers.get('access-control-allow-origin'), '*');
  let anonymous;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    anonymous = await fetch(`${base}/warroom-dashboard/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (anonymous.status === 401) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(anonymous.status, 401, 'Native data RPC must reject anonymous HTTP');
  result.checks.push('anonymous native data RPC denied');
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  page.on('pageerror', error => result.page_errors.push(error.name));
  result.stage = 'authenticated browser';
  await page.goto(ctx.get('connection').authenticatedUrl(`${base}/`));
  await page.getByRole('button').first().waitFor({ timeout: 20000 });
  assert.equal(new URL(page.url()).search, '', 'Token exchange redirects to a clean URL');
  assert((await page.context().cookies()).some(cookie => cookie.httpOnly), 'Official authority cookie was exchanged');
  result.checks.push('official cookie login and clean URL');
  result.stage = 'open conversation';
  const previewNotice = page.getByRole('button', { name: '继续', exact: true });
  await previewNotice.waitFor({ state: 'visible', timeout: 20000 });
  await previewNotice.click();
  const keyNotice = page.getByRole('button', { name: '稍后配置', exact: true });
  await keyNotice.waitFor({ state: 'visible', timeout: 10000 });
  await keyNotice.click();
  // The native UI restores the workspace's current conversation. No model key is needed for cold history.
  await page.getByText('[Synthetic smoke fixture]', { exact: false }).first().waitFor({ timeout: 20000 });
  await page.getByRole('tab', { name: '战图', exact: true }).click({ timeout: 20000 });
  const frame = page.frameLocator('iframe[title="GUNGNIR 战图"]');
  result.stage = 'native graph';
  await frame.locator('#global-graph [data-node-id]').first().waitFor({ timeout: 20000 });
  assert.equal(await frame.locator('#global-graph [data-node-id]').count(), fixture.snapshot.nodes.length);
  assert.equal(await frame.locator('.route-note').count(), 4);
  await frame.locator('[data-node-ref]').first().click();
  assert(await frame.locator('#focus-graph [data-node-id]').count() > 0);
  assert(await frame.locator('.message.related').count() >= 2);
  assert.equal(await frame.locator('#mode-badge').innerText(), '真实数据');
  const sandbox = await page.locator('iframe[title="GUNGNIR 战图"]').getAttribute('sandbox');
  assert.equal(sandbox, 'allow-scripts');
  result.checks.push('ModuleLoader plugin + session slot + opaque iframe + authenticated RPC graph');
  result.checks.push('official inspect/page text decoded and conversation links work');
  const dashboardFrame = page.frames().find(item => item.parentFrame() && item.url().includes('/gungnir-dashboard/'));
  assert(dashboardFrame, 'Sandboxed dashboard frame exists');
  assert(await dashboardFrame.evaluate(() => { try { void parent.document.body; return false; } catch (error) { return error.name === 'SecurityError'; } }), 'Opaque frame cannot read parent DOM');
  result.checks.push('actual opaque origin blocks parent DOM; native CSP has connect-src none');
  await ctx.get('sessionController').create({ sessionId: 'dashboard-unbound-session', workspaceId: workspace.workspace.workspaceId });
  for (const payload of [{ sessionId, engagementId: 'other-engagement' }, { sessionId: 'dashboard-unbound-session', engagementId: fixture.engagementId }]) {
    const denied = await page.evaluate(async payload => {
      const response = await fetch('/warroom-dashboard/snapshot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'snapshot', payload }) });
      return { status: response.status, body: await response.json() };
    }, payload);
    assert.equal(denied.status, 200);
    assert.equal(denied.body.result.ok, false);
    assert.equal(denied.body.result.error.code, 'E_DASHBOARD_SCOPE');
    assert.equal(denied.body.result.value, undefined);
  }
  result.checks.push('authenticated mismatched engagement and visible unbound session denied');
  await page.screenshot({ path: join(output, 'native-dsh.png'), fullPage: true });
  assert.deepEqual(fixture.hashes(), before, 'Dashboard preserved both databases');
  assert.deepEqual(result.page_errors, []);
  result.checks.push('database hashes unchanged; zero page errors');
  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error_type = error.name;
  if (page) {
    result.failure_body = (await page.locator('body').innerText()).slice(0, 2000);
    result.failure_buttons = await page.getByRole('button').allTextContents();
    await page.screenshot({ path: join(output, 'native-failure.png'), fullPage: true });
  }
  result.boot_errors = bootMessages.flatMap(chunk => chunk.split('\n')).filter(line => /TypeError|webserver:|gungnir|warroom-dashboard|dashboard-smoke/.test(line)).map(line => line.replace(/https?:\/\/[^\s]+/g, '[URL omitted]')).slice(-20);
  // Keep errors free of launch URLs, auth cookies and raw Host diagnostics.
  result.error = error.message.replace(/https?:\/\/[^\s]+/g, '[URL omitted]').slice(0, 600);
} finally {
  await browser?.close();
  try { await (booted?.shutdown?.shutdown?.(0) ?? booted?.ctx?.fiber?.dispose()); }
  catch { result.shutdown_error = true; result.ok = false; }
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  fixture.dispose();
  process.stdout.write = oldOut;
  process.stderr.write = oldErr;
  writeFileSync(join(output, 'native-result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;
