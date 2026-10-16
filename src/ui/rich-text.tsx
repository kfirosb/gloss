import { useRef, useState, useContext, isValidElement, type ReactNode } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import { FileLinkContext, isLocalFileLink } from './file-links.js';
import { RunCommandContext, runnableCommand } from './run-command.js';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent } from 'mdast';
import { isHebrew } from '../core/language-style.js';

function highlights() {
  return (tree: Root) => {
    function visit(node: { children?: RootContent[] }) {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text') {
          visit(child as { children?: RootContent[] });
          return [child];
        }
        const parts = child.value.split(/(==[^=\n]+==|@(?:File|Image)\s+\d+\b)/g);
        return parts.map((value): RootContent =>
          /^@(?:File|Image)\s+\d+$/.test(value)
            ? {
                type: 'strong',
                data: { hName: 'bdi', hProperties: { dir: 'ltr' } },
                children: [{ type: 'text', value }],
              }
            : value.startsWith('==') && value.endsWith('==')
              ? {
                  type: 'strong',
                  data: { hName: 'mark' },
                  children: [{ type: 'text', value: value.slice(2, -2) }],
                }
              : { type: 'text', value },
        );
      });
    }
    visit(tree);
  };
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const runner = useContext(RunCommandContext);
  const [run, setRun] = useState<'idle' | 'running' | string>('idle');
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children)
    ? children.props
    : undefined;
  const language = /(?:^|\s)language-(\S+)/.exec(code?.className ?? '')?.[1];
  const command = runner
    ? runnableCommand(
        language,
        typeof code?.children === 'string'
          ? code.children
          : Array.isArray(code?.children)
            ? code.children.filter((c) => typeof c === 'string').join('')
            : '',
      )
    : undefined;
  return (
    <div className="code-block" dir="ltr">
      <div className="code-actions">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(ref.current?.textContent ?? '').then(
              () => {
                setCopied(true);
                setFailed(false);
              },
              () => setFailed(true),
            );
          }}
        >
          {failed ? 'Copy unavailable' : copied ? 'Copied' : 'Copy code'}
        </button>
        {command !== undefined && (
          <button
            type="button"
            className="run-command"
            disabled={run === 'running'}
            aria-label={`Run: ${command.split('\n')[0]}`}
            onClick={() => {
              setRun('running');
              runner!.run(command).then(
                () => setRun('idle'),
                (e) => setRun(e instanceof Error ? e.message : 'Could not run'),
              );
            }}
          >
            {run === 'running' ? 'Running…' : run === 'idle' ? '▶ Run' : run}
          </button>
        )}
      </div>
      <pre ref={ref} tabIndex={0}>
        {children}
      </pre>
    </div>
  );
}
export function RichText({ text, language = 'auto' }: { text: string; language?: string }) {
  const files = useContext(FileLinkContext);
  // Translations have a known language. First-strong-character detection is
  // incorrect when a Hebrew reply opens with a file reference or product name.
  const direction =
    language === 'auto'
      ? 'auto'
      : isHebrew(language) || /^(iw|ar|fa|ur)(-|$)/i.test(language.trim())
        ? 'rtl'
        : 'ltr';
  return (
    <div
      className="rich-text"
      dir={direction}
      lang={language === 'auto' ? undefined : isHebrew(language) ? 'he' : language.trim()}
    >
      <Markdown
        urlTransform={(url) => (files && isLocalFileLink(url) ? url : defaultUrlTransform(url))}
        remarkPlugins={[remarkGfm, highlights]}
        skipHtml
        components={{
          strong: ({ children }) => <strong dir="auto">{children}</strong>,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ children, href }) =>
            files && href && isLocalFileLink(href) ? (
              <a
                dir="auto"
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  files.open(href);
                }}
              >
                {children}
              </a>
            ) : (
              <a dir="auto" href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
          img: ({ alt }) => <span>{alt}</span>,
          table: ({ children }) => (
            <div className="table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
