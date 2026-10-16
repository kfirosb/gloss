import { expect, it } from 'vitest';
// @ts-expect-error untyped desktop module
import { createBadgeController } from '../../desktop/attention-badge.mjs';

it('shows the count only while unfocused, clears on focus even when the count is unchanged, and ignores junk', () => {
  const badges: string[] = [];
  let focused = false;
  const controller = createBadgeController({
    setBadge: (text: string) => badges.push(text),
    isFocused: () => focused,
  });
  controller.setCount(2);
  expect(badges.at(-1)).toBe('2');
  focused = true;
  controller.refresh();
  expect(badges.at(-1)).toBe('');
  controller.setCount(2);
  expect(badges.at(-1)).toBe('');
  focused = false;
  controller.refresh();
  expect(badges.at(-1)).toBe('2');
  controller.setCount(0);
  expect(badges.at(-1)).toBe('');
  controller.setCount(-1 as any);
  expect(badges.at(-1)).toBe('');
  controller.setCount('7' as any);
  expect(badges.at(-1)).toBe('');
  controller.setCount(3);
  controller.clear();
  expect(badges.at(-1)).toBe('');
  controller.refresh();
  expect(badges.at(-1)).toBe('');
});
