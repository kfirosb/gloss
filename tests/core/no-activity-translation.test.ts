import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

it('Activity has no translation code path', () => {
  const grep = () =>
    execFileSync(
      'grep',
      [
        '-rln',
        '-e',
        'translate-activity-report',
        '-e',
        'translateActivityReport',
        '-e',
        'reportTranslation',
        '-e',
        'useReportTranslations',
        '-e',
        'takeReportRequests',
        'src',
        'tests',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
  let files = '';
  try {
    files = grep();
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
  }
  expect(
    files
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((f) => !f.endsWith('no-activity-translation.test.ts')),
  ).toEqual([]);
});
