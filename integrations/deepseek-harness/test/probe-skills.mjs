import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const name = 'archify-dsh-skill-probe';
export const inject = ['skills'];

export async function probeSkills(skills, cwd, expectedNames = ['archify'], {
  timeoutMs = 30_000,
  pollMs = 100,
  sleep = delay,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let list = [];
  do {
    list = await skills.list({ cwd });
    if (expectedNames.every((name) => list.some((skill) => skill.name === name))) break;
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  } while (true);
  const definitions = {};
  for (const name of expectedNames) {
    if (!list.some((skill) => skill.name === name)) continue;
    const definition = await skills.get(name, { cwd });
    if (!definition) continue;
    definitions[name] = {
      name: definition.name,
      provider: definition.provider,
      resourceBase: definition.resourceBase,
      path: definition.path,
      contentLength: definition.content?.length || 0,
      contentSha256: createHash('sha256').update(definition.content || '').digest('hex'),
    };
  }
  return {
    skills: list.map((skill) => ({
      name: skill.name,
      provider: skill.provider,
      resourceBase: skill.resourceBase,
      path: skill.path,
    })),
    definitions,
  };
}

export async function apply(ctx) {
  const out = process.env.ARCHIFY_DSH_PROBE_OUT;
  if (!out) throw new Error('ARCHIFY_DSH_PROBE_OUT is required for the test-only skill probe');
  const expectedNames = JSON.parse(process.env.ARCHIFY_DSH_PROBE_SKILLS || '["archify"]');
  const cwd = process.env.ARCHIFY_DSH_PROBE_CWD || process.cwd();
  // Capture host warnings while listing: a provider scanning roots another
  // live provider already covers logs one shadowing warning per Skill on
  // every uncached catalog read (#1336). The registry still de-duplicates
  // the catalog, so the skill list alone cannot show the duplicate scan.
  const warnings = [];
  let warningsCaptured = false;
  if (typeof ctx.logger?.exporter === 'function') {
    warningsCaptured = true;
    ctx.logger.exporter({ colors: 0, export: (message) => {
      if (message?.type === 'warn') warnings.push(String(message.args?.[0] ?? message));
    } });
  }
  const result = await probeSkills(ctx.skills, cwd, expectedNames);
  // A watcher event has the same effect as an invalidation, so list once
  // more on a fresh catalog instead of letting the first read's cache hide
  // a duplicate scan.
  if (typeof ctx.skills.invalidateCache === 'function') {
    ctx.skills.invalidateCache();
    await ctx.skills.list({ cwd });
  }
  result.warnings = warnings;
  result.warningsCaptured = warningsCaptured;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  const exit = ctx.cmdlineArgs?.exit || ctx.appExit;
  if (typeof exit === 'function') exit(0);
}
