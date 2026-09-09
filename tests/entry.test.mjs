import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('entry module loads without a host and exposes lifecycle hooks', async () => {
  delete globalThis.SillyTavern;
  const entry = await import(`../index.js?test=${Date.now()}`);
  assert.equal(typeof globalThis.traceMemoryPromptInterceptor, 'function');
  assert.equal(typeof entry.onActivate, 'function');
  assert.equal(typeof entry.onEnable, 'function');
  assert.equal(typeof entry.onDisable, 'function');
  await entry.onDisable();
});

test('version stamps agree across manifest, package and entry', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const packageFile = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.equal(manifest.version, packageFile.version);
  assert.match(entry, new RegExp(`const VERSION = '${manifest.version.replaceAll('.', '\\.')}';`));
  assert.equal(manifest.generate_interceptor, 'traceMemoryPromptInterceptor');
});
