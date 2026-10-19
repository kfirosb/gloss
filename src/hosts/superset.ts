import { spawn } from 'node:child_process';
import type { HostAdapter, Target } from '../core/contracts.js';
import { urlOpenerPath } from '../runtime/platform-tools.js';
export interface SupersetHostOptions {
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  opener?: (args: string[]) => Promise<void>;
}
export function createSupersetHost(options: SupersetHostOptions = {}): HostAdapter {
  const open =
    options.opener ??
    ((args) =>
      new Promise((resolve, reject) => {
        const child = spawn(urlOpenerPath(), args, { stdio: 'ignore' });
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error('Superset route could not be opened')),
        );
      }));
  return {
    async openPanel(url) {
      throw new Error(
        'Superset 1.17.0 cannot create a browser pane automatically; open this URL in its embedded browser: ' +
          url,
      );
    },
    async revealCodingSession(_target: Target) {
      if (!options.workspaceId) throw new Error('Superset workspace context is unavailable');
      const route = 'superset://workspace/' + encodeURIComponent(options.workspaceId) + '/';
      const query = new URLSearchParams();
      if (options.tabId) query.set('tabId', options.tabId);
      if (options.paneId) query.set('paneId', options.paneId);
      await open([route + (query.toString() ? '?' + query.toString() : '')]);
    },
  };
}
