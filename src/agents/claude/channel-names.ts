/** The channel server's name: `server:gloss` on the command line, `<channel source="gloss">` in the transcript. */
export const GLOSS_SERVER = 'gloss';
/** The name before the rename. Saved commands and per-session config files still use it, so readers accept both. */
export const LEGACY_SERVER = 'language-assistant';
export const CHANNEL_SERVERS: readonly string[] = [GLOSS_SERVER, LEGACY_SERVER];
export const isChannelServer = (name: unknown): name is string =>
  typeof name === 'string' && CHANNEL_SERVERS.includes(name);
