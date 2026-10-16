import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
function isEntry() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
}
export function parseArgs(args: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i]!;
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else out[key] = 'true';
  }
  return out;
}
export async function launch(args: string[]) {
  const flags = parseArgs(args);
  if (flags['prepare-claude-channel']) {
    if (!flags.project || flags.project === 'true' || flags.session || flags['claude-channel'])
      throw new Error(
        'Use --prepare-claude-channel --project <absolute-path> for a new session; use the saved session UI for resume.',
      );
    const { createChannelSetup } = await import('./claude-channel-setup.js');
    const setup = await createChannelSetup(undefined, flags.project);
    process.stdout.write(
      'Experimental Claude channel setup\n' + setup.instructions + '\n\n' + setup.command + '\n',
    );
    return setup;
  }
  if (flags['claude-channel']) {
    const { startClaudeChannel } = await import('../agents/claude/channel-server.js');
    return startClaudeChannel();
  }
  const language = flags.language ?? 'he';
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})?$/.test(language))
    throw new Error('Unsupported language');
  if (flags.agent && flags.agent !== 'claude' && flags.agent !== 'codex')
    throw new Error('Unsupported agent');
  if (flags.agent && !flags.session)
    throw new Error('A session is required when an agent is selected');
  const [
    { createApplication },
    { startServer },
    { SqliteStore },
    { ClaudeLanguageBackend },
    { CodexLanguageBackend },
    { createClaudeAdapter },
    { createCodexAdapter },
    { createHttpSourceSink },
  ] = await Promise.all([
    import('./application.js'),
    import('./http-server.js'),
    import('../storage/sqlite-store.js'),
    import('../language/claude.js'),
    import('../language/codex.js'),
    import('../agents/claude/index.js'),
    import('../agents/codex/index.js'),
    import('../agents/source-sink.js'),
  ]);
  const root = join(homedir(), '.language-assistant');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const store = new SqliteStore(join(root, 'state.db'));
  let localSink: ReturnType<typeof createHttpSourceSink> | undefined;
  const sourceSink =
    flags['bridge-endpoint'] && flags['bridge-capability']
      ? createHttpSourceSink({
          endpoint: flags['bridge-endpoint'],
          capability: flags['bridge-capability'],
        })
      : {
          async send(message: Parameters<ReturnType<typeof createHttpSourceSink>['send']>[0]) {
            if (!localSink) throw new Error('Local bridge is starting');
            await localSink.send(message);
          },
        };
  const adapterOptions = sourceSink ? { sourceSink } : {};
  const claudeAdapter = createClaudeAdapter(adapterOptions);
  let launchedCodex: ((sessionRef: string) => boolean | undefined) | undefined;
  // Launched threads are open exactly while their tmux session runs (see src/agents/README.md).
  const codexAdapter = createCodexAdapter({
    ...adapterOptions,
    launched: (sessionRef) => launchedCodex?.(sessionRef),
  });
  const { createLaunchServices } = await import('./launch-services.js');
  const { createUsageService } = await import('./usage.js');
  const usage = createUsageService({ store });
  let application: ReturnType<typeof createApplication>;
  const launchServices = createLaunchServices({
    store,
    codex: codexAdapter,
    application: () => application,
  });
  launchedCodex = launchServices.launchedCodexLive;
  // The detached whisper-server must not outlive the CLI, so only the real entry attaches the signal handlers.
  const { createDictationServices } = await import('./dictation/services.js');
  const dictation = createDictationServices({
    root,
    capability: () => application.capability,
    log: (line) => process.stdout.write(JSON.stringify({ event: 'dictation', line }) + '\n'),
    attachSignals: isEntry(),
  });
  application = createApplication({
    launcher: launchServices.launcher,
    terminals: launchServices.terminals,
    attention: launchServices.attention,
    approveLaunchFolder: launchServices.approveFolder,
    endLaunchesInFolder: launchServices.endLaunchesInFolder,
    dictation,
    ...(process.env.LANGUAGE_PANEL_CAPABILITY
      ? { capability: process.env.LANGUAGE_PANEL_CAPABILITY }
      : {}),
    store,
    projectPath: flags.project ?? process.cwd(),
    conversationId:
      flags.conversation ??
      (flags.session ? `${flags.agent}:${flags.session}` : 'language-default'),
    language,
    ...(flags.model ? { model: flags.model } : {}),
    agents: [claudeAdapter, codexAdapter],
    usage,
    languageBackends: {
      claude: new ClaudeLanguageBackend({ observer: usage.observer }),
      codex: new CodexLanguageBackend({ observer: usage.observer }),
    },
  });
  const server = await startServer(application, { port: Number(flags.port ?? 0) });
  localSink = createHttpSourceSink({
    endpoint: new URL('/api/source/messages', server.url).href,
    capability: application.capability,
    onDelivered: (message) =>
      process.stdout.write(
        JSON.stringify({
          event: 'source-delivered',
          session: message.sourceSessionId,
          id: message.sourceId,
          sequence: message.sequence,
        }) + '\n',
      ),
  });
  // The sink must exist before registration/restoration starts adapter source replay.
  if (flags.agent && flags.session)
    await application.sessions!.register(
      {
        agent: flags.agent as 'claude' | 'codex',
        sessionRef: flags.session,
        projectId: flags.project ?? process.cwd(),
      },
      application.snapshot().snapshot.id,
    );
  await application.restore?.(application.snapshot().snapshot.id);
  process.stdout.write(server.url + '\n');
  return { application, server };
}
if (isEntry())
  void launch(process.argv.slice(2)).catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : 'Launch failed') + '\n');
    process.exitCode = 1;
  });
