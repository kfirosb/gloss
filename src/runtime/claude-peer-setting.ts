import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeConfigDir } from '../agents/shared.js';
import type { JsonRecord } from '../core/json-record.js';
import { writeFileAtomic } from './atomic-file.js';
import {
  isMissingFile,
  defaultManagedDir,
  opaqueManagedPolicyPaths,
  pathExists,
  readClaudeConfigFile,
} from './claude-config.js';

export type PeerInbound = 'accept' | 'hold' | 'refuse' | 'unset';
export interface PeerSetting {
  /** The user's own value, or 'unreadable' when settings.json can't be read safely. */
  user: PeerInbound | 'unreadable';
  /** A setting that wins over the user's. Gloss shows it and never writes. */
  forcedBy?: 'repository' | 'organization';
  /** The forced value; absent when the organization's policy is in a form Gloss can't read. */
  forced?: 'hold' | 'refuse';
}
export interface PeerSettingService {
  read(project: string): Promise<PeerSetting>;
  allowAll(project: string): Promise<PeerSetting>;
}
/** Trusted host/test options only. Never accept these through HTTP. */
export interface PeerSettingOptions {
  homeDir?: string | undefined;
  configDir?: string | undefined;
  managedDir?: string | undefined;
  systemLibraryDir?: string | undefined;
  platform?: NodeJS.Platform | undefined;
}

const KEY = 'crossSessionInbound';
/** Mode for a settings.json Gloss creates: Claude settings may hold tokens. */
const NEW_SETTINGS_MODE = 0o600;
const isSetValue = (value: unknown): value is Exclude<PeerInbound, 'unset'> =>
  value === 'accept' || value === 'hold' || value === 'refuse';
const valueOf = (settings: JsonRecord | undefined): PeerInbound => {
  const value = settings?.[KEY];
  return isSetValue(value) ? value : 'unset';
};
const tightens = (value: PeerInbound): value is 'hold' | 'refuse' =>
  value === 'hold' || value === 'refuse';

/** Claude's per-user switch for messages from other sessions. Gloss only ever sets it to accept, on request. */
export function createClaudePeerSetting(options: PeerSettingOptions = {}): PeerSettingService {
  const home = options.homeDir ?? homedir();
  const configDir = resolve(claudeConfigDir(options.configDir, home));
  const platform = options.platform ?? process.platform;
  const library = options.systemLibraryDir ?? '/Library';
  const managedDir = options.managedDir ?? defaultManagedDir(platform, library);
  const userPath = join(configDir, 'settings.json');
  // Repository files Claude itself can't parse don't force anything.
  const optional = (path: string) => readClaudeConfigFile(path).catch(() => undefined);

  async function read(project: string): Promise<PeerSetting> {
    const user = await readClaudeConfigFile(userPath).then(valueOf, () => 'unreadable' as const);
    // A managed file that exists but can't be read safely fails closed, like the opaque policy paths.
    const managedFile = await readClaudeConfigFile(join(managedDir, 'managed-settings.json')).catch(
      () => 'unreadable' as const,
    );
    if (managedFile === 'unreadable') return { user, forcedBy: 'organization' };
    const managed = valueOf(managedFile);
    if (tightens(managed)) return { user, forcedBy: 'organization', forced: managed };
    for (const path of opaqueManagedPolicyPaths({ home, library, managedDir, platform }))
      if (await pathExists(path)) return { user, forcedBy: 'organization' };
    for (const name of ['settings.json', 'settings.local.json']) {
      const repository = valueOf(await optional(join(project, '.claude', name)));
      if (tightens(repository)) return { user, forcedBy: 'repository', forced: repository };
    }
    return { user };
  }
  return {
    read,
    async allowAll(project) {
      const current = await read(project);
      if (current.forcedBy)
        throw new Error(
          `Your ${current.forcedBy} controls this Claude setting, so Gloss left it unchanged.`,
        );
      if (current.user === 'accept') return current;
      const info = await lstat(userPath).catch((error: unknown) => {
        if (isMissingFile(error)) return undefined;
        throw new Error(
          `Claude's settings.json (${userPath}) could not be checked, so Gloss left it unchanged.`,
        );
      });
      if (info && (info.isSymbolicLink() || !info.isFile()))
        throw new Error(
          `Claude's settings.json (${userPath}) is a link or not a regular file, so Gloss left it unchanged. Set "Messages from your other sessions" to accept in /config.`,
        );
      let settings: JsonRecord | undefined;
      try {
        settings = await readClaudeConfigFile(userPath);
      } catch {
        throw new Error(
          `Claude's settings.json (${userPath}) could not be read as JSON, so Gloss left it unchanged. Fix it, or set "Messages from your other sessions" to accept in /config.`,
        );
      }
      await lstat(configDir).catch(() => {
        throw new Error(
          `Claude's settings folder (${configDir}) doesn't exist yet. Open Claude once, then try again.`,
        );
      });
      await writeFileAtomic(
        userPath,
        JSON.stringify({ ...settings, [KEY]: 'accept' }, null, 2) + '\n',
        info ? info.mode & 0o777 : NEW_SETTINGS_MODE,
      );
      return read(project);
    },
  };
}
