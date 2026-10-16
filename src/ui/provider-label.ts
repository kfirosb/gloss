const knownProviders: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };

export function providerLabel(agent: string): string {
  return (
    knownProviders[agent] ??
    (agent.replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase()) ||
      'Terminal')
  );
}

export function terminalDestinationLabel(): string {
  return 'Send to Terminal in English';
}
