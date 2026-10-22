/** The channel server's name: `server:gloss` on the command line, `<channel source="gloss">` in the transcript. */
export const GLOSS_SERVER = 'gloss';
/** The name before the rename. Saved commands and per-session config files still use it, so readers accept both. */
export const LEGACY_SERVER = 'language-assistant';
export const CHANNEL_SERVERS: readonly string[] = [GLOSS_SERVER, LEGACY_SERVER];
export const isChannelServer = (name: unknown): name is string =>
  typeof name === 'string' && CHANNEL_SERVERS.includes(name);
/** Where channel helpers publish their registrations, under the data folder. */
export const CHANNEL_REGISTRY_DIR = 'claude-channels';
/** The helpers' shared request/reply ledger (SQLite, DELETE journaling), under the data folder. */
export const CHANNEL_LEDGER_FILE = 'claude-channel-ledger.db';
