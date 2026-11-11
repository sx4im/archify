import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const integrationRoot = path.resolve(here, '..');
const patch = fs.readFileSync(path.join(integrationRoot, 'cordis.patch.yml'), 'utf8');

// Mirrors vendor/loader/src/config/utils.ts in deepseek-ai/deepseek-harness
// (dsh-v0.2.1-rc.2): a !!js expression evaluates against the loader context,
// so the patch expression sees ctx.loader, the composed loader entry tree.
// eslint-disable-next-line no-new-func
const evaluate = new Function('ctx', 'expr', `
  with (ctx) {
    return eval(expr)
  }
`);

function defaultRootsExpression() {
  const lines = patch.split('\n').filter((line) => /^\s*includeDefaultRoots:/.test(line));
  assert.equal(lines.length, 1, 'the patch must decide includeDefaultRoots in exactly one place');
  const match = lines[0].match(/includeDefaultRoots:\s*!!js\s*"([^"]*)"/);
  assert.ok(match, 'includeDefaultRoots must be a !!js expression, not a literal boolean (see #1336)');
  return match[1];
}

function run(expression, store) {
  return evaluate({ loader: { store } }, expression);
}

function entry(id, disabled) {
  const options = { id, name: '@deepseek-ai/dsh-skill-filesystem' };
  if (disabled !== undefined) options.disabled = disabled;
  // The host Entry exposes disabled as a getter over its options; a plain
  // property carries the same contract for this expression.
  return { options, get disabled() { return Boolean(options.disabled); } };
}

const expression = defaultRootsExpression();

test('patch decides includeDefaultRoots from the host skill-filesystem row', () => {
  assert.match(expression, /ctx\.loader\.store\['skill-filesystem'\]/);
  assert.match(expression, /!base\.disabled/);
});

test('default roots are included only when no live host row covers them', () => {
  const archify = entry('archify-skill-filesystem');
  // No host row at all: this provider is the only live filesystem source (#906).
  assert.equal(run(expression, { 'archify-skill-filesystem': archify }), true);
  // Host row live with its default config: it already scans the roots, so a
  // second scan here would log a shadowing warning per Skill (#1336).
  assert.equal(run(expression, {
    'skill-filesystem': entry('skill-filesystem'),
    'archify-skill-filesystem': archify,
  }), false);
  // Host row present but explicitly enabled: same as live.
  assert.equal(run(expression, {
    'skill-filesystem': entry('skill-filesystem', false),
    'archify-skill-filesystem': archify,
  }), false);
  // Host row disabled (web template: presets own local discovery): this
  // provider must include the defaults by itself (#906).
  assert.equal(run(expression, {
    'skill-filesystem': entry('skill-filesystem', true),
    'archify-skill-filesystem': archify,
  }), true);
});

test('unrelated rows do not change the decision', () => {
  const store = {
    'archify-skill-filesystem': entry('archify-skill-filesystem'),
    skill: { options: { id: 'skill', name: '@deepseek-ai/dsh-skill' }, get disabled() { return false; } },
    'tool-skill': { options: { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' }, get disabled() { return false; } },
  };
  assert.equal(run(expression, store), true);
  assert.equal(run(expression, {}), true);
});
