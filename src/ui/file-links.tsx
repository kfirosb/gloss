import { createContext } from 'react';

export const FileLinkContext = createContext<{
  root: string;
  open(path: string, basePath?: string): void;
} | null>(null);
export function isLocalFileLink(href: string): boolean {
  href = href.replace(/(\.[a-zA-Z0-9]+):\d+(?::\d+)?$/, '$1');
  return (
    Boolean(href) &&
    !href.startsWith('#') &&
    !href.startsWith('//') &&
    (/^file:/i.test(href) || !/^[a-z][a-z\d+.-]*:/i.test(href))
  );
}
export function localFilePath(href: string, root: string, basePath = ''): string {
  let value = href;
  if (/^file:/i.test(value)) {
    const url = new URL(value);
    if (url.hostname && url.hostname !== 'localhost')
      throw new Error('File is outside the selected worktree');
    value = url.pathname;
  }
  value = decodeURIComponent(value.split(/[?#]/)[0]!).replace(/:\d+(?::\d+)?$/, '');
  const prefix = root.replace(/\/$/, '') + '/';
  if (value.startsWith('/')) {
    if (!value.startsWith(prefix)) throw new Error('File is outside the selected worktree');
    value = value.slice(prefix.length);
  } else if (basePath) value = basePath.slice(0, basePath.lastIndexOf('/') + 1) + value;
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('File is outside the selected worktree');
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length || value.includes('\0')) throw new Error('Select a file path');
  return parts.join('/');
}
