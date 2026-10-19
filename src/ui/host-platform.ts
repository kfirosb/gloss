/** The platform the page runs on, as far as the browser tells: the app and its server share one machine. */
export type HostPlatform = 'darwin' | 'linux' | 'other';

export function hostPlatform(
  nav: Pick<Navigator, 'platform' | 'userAgent'> | undefined = globalThis.navigator,
): HostPlatform {
  const text = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  if (/Mac/i.test(text)) return 'darwin';
  if (/Linux|X11/i.test(text) && !/Android/i.test(text)) return 'linux';
  return 'other';
}
