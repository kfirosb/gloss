export type LiveView = 'translated' | 'original' | 'split' | 'terminal' | 'activity';
export type ConversationView = 'translated' | 'original';
export const LIVE_VIEWS: readonly LiveView[] = [
  'translated',
  'original',
  'split',
  'terminal',
  'activity',
];
export const CONVERSATION_VIEWS: readonly ConversationView[] = ['translated', 'original'];
export const LIVE_VIEW_LABELS: Record<LiveView, string> = {
  translated: 'Translated',
  original: 'Original',
  split: 'Split',
  terminal: 'Terminal',
  activity: 'Activity',
};
export const NO_ACTIVITY_TOOLTIP = 'Activity is available for Claude sessions';
export const NO_TERMINAL_TOOLTIP = 'Gloss can show the terminal only for sessions it started';
export const showsTerminal = (view: LiveView): boolean => view === 'split' || view === 'terminal';
// The terminal shortcut: opens split from a conversation view, and returns to the remembered side.
export const toggleTerminal = (view: LiveView, conversation: ConversationView): LiveView =>
  showsTerminal(view) ? conversation : 'split';
// An approval needs the terminal; returnTo is the view to restore afterwards (null when none was left).
export const approvalSwitch = (view: LiveView): { view: LiveView; returnTo: LiveView | null } =>
  showsTerminal(view) ? { view, returnTo: null } : { view: 'split', returnTo: view };
export const historyView = (view: LiveView): LiveView => (view === 'terminal' ? 'split' : view);
export const selectView = (view: LiveView, conversation: ConversationView): ConversationView =>
  view === 'translated' || view === 'original' ? view : conversation;
