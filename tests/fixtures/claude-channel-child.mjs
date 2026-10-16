// Test-only child: real stdin/stdout MCP and HTTP, with trusted identity inputs.
import { registerHooks } from 'node:module';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js')) throw error;
    return next(specifier.slice(0, -3) + '.ts', context);
  }
} });

const root = process.argv[2];
const mode = process.argv[3];
if (mode === 'cli') {
  // Fail if the channel branch even imports normal application/DB modules.
  registerHooks({ resolve(specifier, context, next) {
    if (/\/(application|http-server|sqlite-store)\.js$/.test(specifier)) throw new Error('Panel module loaded');
    if (specifier.endsWith('/agents/claude/channel-server.js')) return {
      url: 'data:text/javascript,' + encodeURIComponent(`export async function startClaudeChannel() {
        const {writeFile} = await import('node:fs/promises');
        await writeFile(${JSON.stringify(join(root, 'cli.json'))}, JSON.stringify({started:true}));
        return {async close(){}};
      }`), shortCircuit: true,
    };
    return next(specifier, context);
  } });
  const { launch } = await import('../../src/runtime/cli.ts');
  await launch(['--claude-channel', '--language', 'invalid!', '--agent', 'invalid']);
} else {
  const { startClaudeChannel } = await import('../../src/agents/claude/channel-server.ts');
  const input = JSON.parse(await readFile(join(root, 'input.json'), 'utf8'));
  // The parent Claude's command line and the bridge env; by default a legacy session that enabled the channel.
  const activation = await readFile(join(root, 'activation.json'), 'utf8').then(JSON.parse, () => ({
    env: {},
    commandLine: 'claude --dangerously-load-development-channels server:language-assistant',
  }));
  let removals = 0;
  const registryFactory = ({ port, stateDir }) => ({
    async registerChannel() {
      await writeFile(join(root, 'registered'), 'registered');
      const record = { ...input, port };
      await writeFile(join(root, 'bound.json'), JSON.stringify({ record, stateDir }));
      if (mode === 'gated' || mode === 'reject') {
        while (true) {
          try { await access(join(root, 'release')); break; } catch { await delay(10); }
        }
      }
      if (mode === 'reject') throw new Error('PRIVATE-STARTUP-DETAIL');
      return record;
    },
    async removeChannel(generation) {
      await writeFile(join(root, 'removed-count'), String(++removals));
      await writeFile(join(root, 'removed.json'), JSON.stringify({ generation }));
    },
  });
  try {
    const handle = await startClaudeChannel({
      stateDir: join(root, 'state'),
      registryFactory,
      env: activation.env,
      readParentCommandLine: async () => activation.commandLine,
    });
    await writeFile(join(root, 'started'), 'started');
    if (mode === 'close') { await handle.close(); await handle.close(); }
  } catch {
    await writeFile(join(root, 'failed'), 'failed');
    process.exitCode = 1;
  }
}
