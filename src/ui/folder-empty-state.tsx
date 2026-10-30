// The body of a folder with nothing open: a large + for the New session dialog and a short explanation.
export function FolderEmptyState({
  folderName,
  hasSaved,
  onNewSession,
}: {
  folderName: string;
  hasSaved: boolean; // the Saved sessions menu above lists conversations to resume
  onNewSession(): void;
}) {
  return (
    <section className="folder-empty" aria-labelledby="folder-empty-title">
      <button
        type="button"
        className="folder-empty-new"
        aria-label={`Start a session in ${folderName}`}
        onClick={onNewSession}
      >
        <span aria-hidden="true">+</span>
      </button>
      <h2 id="folder-empty-title" className="folder-empty-title">
        Start a session
      </h2>
      <p className="folder-empty-text">
        A session runs Claude Code or Codex in this folder, and you talk to it here.
      </p>
      {hasSaved && <p className="folder-empty-text">Or resume one from Saved sessions above.</p>}
    </section>
  );
}
