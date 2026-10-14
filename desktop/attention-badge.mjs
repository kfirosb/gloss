// Dock badge rule, kept free of Electron so it can be unit tested: show the count only while the window is not in front.
export function createBadgeController({ setBadge, isFocused }) {
  let count = 0;
  const apply = () => setBadge(count > 0 && !isFocused() ? String(count) : '');
  return {
    setCount(value) { count = Number.isSafeInteger(value) && value > 0 ? value : 0; apply(); },
    refresh() { apply(); },
    clear() { count = 0; apply(); },
  };
}
