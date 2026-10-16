import { isAbsolute } from 'node:path';
export type FolderKind = 'main' | 'worktree' | 'plain';
export interface ConnectedFolder {
  path: string;
  projectKey: string;
  kind: FolderKind;
  createdByApp: boolean;
  connectedAt: number;
}
export interface SidebarSettings {
  order: string[];
  hidden: string[];
  collapsed: string[];
  worktreeLocation: Record<string, string>;
}
export const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = Object.freeze({
  order: [],
  hidden: [],
  collapsed: [],
  worktreeLocation: {},
}) as SidebarSettings;
const strings = (v: unknown) =>
  Array.isArray(v)
    ? v
        .filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 4096)
        .slice(0, 500)
    : [];
export function validateSidebarSettings(value: unknown): SidebarSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid sidebar settings');
  const v = value as Record<string, unknown>;
  for (const k of ['order', 'hidden', 'collapsed'])
    if (v[k] !== undefined && !Array.isArray(v[k])) throw new Error('Invalid sidebar settings');
  const loc =
    v.worktreeLocation &&
    typeof v.worktreeLocation === 'object' &&
    !Array.isArray(v.worktreeLocation)
      ? (v.worktreeLocation as Record<string, unknown>)
      : {};
  return {
    order: strings(v.order),
    hidden: strings(v.hidden),
    collapsed: strings(v.collapsed),
    worktreeLocation: Object.fromEntries(
      Object.entries(loc).filter(
        ([k, p]) => k.length <= 4096 && typeof p === 'string' && isAbsolute(p) && p.length <= 4096,
      ),
    ) as Record<string, string>,
  };
}
export interface ConnectedFolderStore {
  listConnectedFolders(): ConnectedFolder[];
  putConnectedFolder(folder: ConnectedFolder): void;
  deleteConnectedFolder(path: string): void;
  readSidebarSettings(): SidebarSettings;
  writeSidebarSettings(settings: SidebarSettings): void;
}
