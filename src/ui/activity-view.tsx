import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ActivityCall, ActivitySnapshot, ActivityTask } from '../core/activity-contracts.js';
import type { CodingState } from '../core/contracts.js';
import {
  ACTIVITY_NEW_ROW_MS,
  type ActivityArrival,
  clock,
  duration,
  earlierCount,
  groupTasks,
  historySummary,
  isHighlighted,
  lastActions,
  mainStatus,
  newestArrival,
  sinceLastAction,
} from './activity-page.js';
import { RichText } from './rich-text.js';
import type { SessionClient } from './session-client.js';
import {
  recallStream,
  streamKey,
  useOutputTail,
  useOutputWindow,
  useSubagentStream,
} from './use-activity-streams.js';

type ActivityClient = Pick<
  SessionClient,
  'sessionId' | 'subagentActivity' | 'outputTail' | 'outputWindow'
>;
type TaskStatus = ActivityTask['status'] | 'unknown';
/** Pixels from the bottom that still count as "at the bottom" for the output tail's auto-scroll. */
const STICK_TO_BOTTOM_PX = 8;
const STREAM_PAUSED = 'Stream paused';
const NO_LINE_YET = '…';

/** Re-renders every second while `enabled`; the returned time drives elapsed labels. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/** A running task's elapsed time; only this span re-renders every second. */
function Elapsed({ since }: { since?: string | undefined }) {
  const now = useNow(Boolean(since));
  const text = duration(since, now);
  return text ? <span>{text}</span> : null;
}

/** The main card's status line; ticks only while Claude is working. */
function MainMeta({
  status,
  calls,
}: {
  status: ReturnType<typeof mainStatus>;
  calls: readonly ActivityCall[];
}) {
  const now = useNow(status === 'working');
  if (status === 'disconnected') return <>Session disconnected</>;
  if (status === 'idle') return <>idle</>;
  const since = sinceLastAction(calls, now);
  return <>{since ? `working · ${since}` : 'working'}</>;
}

function finishedTiming(task: ActivityTask, status: TaskStatus): string {
  return [`${status} ${clock(task.finishedAt)}`.trim(), duration(task.startedAt, task.finishedAt)]
    .filter(Boolean)
    .join(' · ');
}

function TimelineRow({ call, highlighted }: { call: ActivityCall; highlighted: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={highlighted ? 'activity-row activity-row-new' : 'activity-row'}
      data-call={call.id}
    >
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <time>{clock(call.timestamp)}</time>
        <span className="activity-tool">{call.tool}</span>
        <span className="activity-summary">
          {call.summary}
          {call.background && ' · background'}
        </span>
        {call.result?.failed && <span className="activity-failed">· failed</span>}
      </button>
      {open && (
        <div className="activity-detail">
          <pre>{call.input}</pre>
          {call.result && <pre>{call.result.text}</pre>}
        </div>
      )}
    </div>
  );
}

/** Which call, if any, is the newest arrival still worth highlighting. */
function useNewestHighlight(calls: readonly ActivityCall[], enabled: boolean) {
  const [arrival, setArrival] = useState<ActivityArrival | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (enabled) setArrival((previous) => newestArrival(previous, calls, Date.now()));
  }, [calls, enabled]);
  useEffect(() => {
    if (!arrival) return;
    setNow(Date.now());
    // One re-render when the highlight expires removes the class.
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, arrival.at + ACTIVITY_NEW_ROW_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [arrival]);
  return (call: ActivityCall) => enabled && isHighlighted(arrival, call, now);
}

/** The last actions newest first, with "Show earlier actions" and the lookback gaps after them. */
function ActionList({
  calls,
  gaps = [],
  highlight,
}: {
  calls: readonly ActivityCall[];
  gaps?: readonly string[];
  highlight: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const highlighted = useNewestHighlight(calls, highlight);
  const earlier = earlierCount(calls);
  const rows = lastActions(calls, showAll);
  // Gaps describe what lies before the oldest known action, so they follow it once it is shown.
  const showGaps = showAll || earlier === 0;
  if (rows.length === 0 && (!showGaps || gaps.length === 0)) return null;
  return (
    <>
      <div className="activity-actions">
        {rows.map((call) => (
          <TimelineRow key={call.id} call={call} highlighted={highlighted(call)} />
        ))}
        {showGaps &&
          gaps.map((gap) => (
            <p key={gap} className="activity-gap">
              {gap}
            </p>
          ))}
      </div>
      {earlier > 0 && (
        <button
          type="button"
          className="activity-button"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? 'Show fewer' : `Show earlier actions (${earlier})`}
        </button>
      )}
    </>
  );
}

/** A task the subagent itself started; counted only in its own transcript, never in the main badge. */
function NestedTaskRow({ task }: { task: ActivityTask }) {
  const labels = [task.kind === 'subagent' ? task.agentType : task.command, task.status]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="activity-nested-task" data-nested-task={task.id} data-status={task.status}>
      <span aria-hidden="true">{task.status === 'running' ? '● ' : '○ '}</span>
      <span>
        {task.kind === 'subagent' ? 'Subagent' : 'Background'} · {task.description}
      </span>
      <span className="activity-meta">{labels}</span>
      <span className="activity-nested">nested ×{task.depth}</span>
    </div>
  );
}

/** A subagent's own actions: the tasks it started, then its last actions; `Stream paused` without a slot. */
function SubagentActions({
  stream,
  paused,
  live,
  highlight,
}: {
  stream: ActivitySnapshot;
  paused: boolean;
  live: boolean;
  highlight: boolean;
}) {
  if (paused)
    return (
      <p className="activity-meta" role="status">
        {STREAM_PAUSED}
      </p>
    );
  return (
    <>
      {stream.tasks.length > 0 && (
        <div className="activity-nested-tasks" aria-label="Nested tasks">
          {stream.tasks.map((task) => (
            <NestedTaskRow key={task.id} task={task} />
          ))}
        </div>
      )}
      {stream.calls.length > 0 ? (
        <ActionList calls={stream.calls} highlight={highlight} />
      ) : (
        <p className="activity-meta">
          {live ? 'Waiting for its first tool call.' : 'No live transcript.'}
        </p>
      )}
      {stream.gaps.map((gap) => (
        <p key={gap} className="activity-meta">
          {gap}
        </p>
      ))}
    </>
  );
}

function Report({ task }: { task: ActivityTask }) {
  if (!task.report) return null;
  return (
    <div className="activity-report" dir="ltr">
      <RichText language="auto" text={task.report} />
    </div>
  );
}

/** The shared card shape for the main session, running subagents and finished ones. */
function AgentCard({
  agent,
  status,
  name,
  tag,
  depth = 0,
  meta,
  expanded,
  onToggle,
  children,
}: {
  agent: string;
  status: string;
  name: string;
  tag: 'main' | 'subagent';
  depth?: number;
  meta: ReactNode;
  /** Present only on a card whose head expands it. */
  expanded?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}) {
  const head = (
    <>
      <span className="activity-agent-name">
        <span className="activity-dot" aria-hidden="true" />
        <b>{name}</b>
        <span className="activity-tag">{tag}</span>
        {depth > 1 && <span className="activity-nested">nested ×{depth}</span>}
      </span>
      <span className="activity-meta">{meta}</span>
    </>
  );
  return (
    <article className="activity-agent" data-agent={agent} data-status={status}>
      {onToggle ? (
        <button
          type="button"
          className="activity-agent-head"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {head}
        </button>
      ) : (
        <div className="activity-agent-head">{head}</div>
      )}
      {children}
    </article>
  );
}

function subagentLabels(task: ActivityTask): string {
  return [task.agentType, task.model].filter(Boolean).join(' · ');
}

function RunningSubagentCard({
  client,
  task,
  disconnected,
}: {
  client: ActivityClient;
  task: ActivityTask;
  disconnected: boolean;
}) {
  const { activity: stream, paused } = useSubagentStream(client, task.id, !disconnected, 2);
  const labels = subagentLabels(task);
  return (
    <AgentCard
      agent={task.id}
      status={disconnected ? 'unknown' : 'running'}
      name={task.description}
      tag="subagent"
      depth={task.depth}
      meta={
        <>
          {labels && `${labels} · `}
          {disconnected ? 'Session disconnected' : <Elapsed since={task.startedAt} />}
        </>
      }
    >
      <SubagentActions stream={stream} paused={paused} live={!disconnected} highlight />
      <Report task={task} />
    </AgentCard>
  );
}

/**
 * A finished subagent: head and report, its actions on expand. Actions seen while it ran are
 * recalled without a stream; otherwise expanding streams its transcript once more.
 */
function FinishedSubagentCard({
  client,
  task,
  disconnected,
}: {
  client: ActivityClient;
  task: ActivityTask;
  disconnected: boolean;
}) {
  // Decided at the click: once the stream folds, the recalled state exists and must not close it.
  const [expanded, setExpanded] = useState<false | 'recalled' | 'streamed'>(false);
  const streamed = expanded === 'streamed' && !disconnected;
  const { activity: stream, paused } = useSubagentStream(client, task.id, streamed, 1);
  const labels = subagentLabels(task);
  const timing = finishedTiming(task, task.status);
  const toggle = () =>
    setExpanded((value) =>
      value
        ? false
        : recallStream(streamKey(client.sessionId, task.id)) === undefined
          ? 'streamed'
          : 'recalled',
    );
  return (
    <AgentCard
      agent={task.id}
      status={task.status}
      name={task.description}
      tag="subagent"
      depth={task.depth}
      meta={[labels, timing].filter(Boolean).join(' · ')}
      expanded={expanded !== false}
      onToggle={toggle}
    >
      <Report task={task} />
      {expanded && (
        <SubagentActions stream={stream} paused={paused} live={streamed} highlight={false} />
      )}
    </AgentCard>
  );
}

interface PanelText {
  text: string;
  start: number;
  error?: string | undefined;
  paused?: boolean;
  showEarlier(): Promise<void>;
}
/** A command's output text, kept scrolled to the bottom unless the reader scrolled up. */
function OutputPanel({ output }: { output: PanelText }) {
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const element = pre.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [output.text]);
  return (
    <div className="activity-output">
      {output.start > 0 && (
        <button type="button" className="activity-button" onClick={() => void output.showEarlier()}>
          Show earlier
        </button>
      )}
      <pre
        ref={pre}
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_TO_BOTTOM_PX;
        }}
      >
        {output.text}
      </pre>
      {output.paused && (
        <p className="activity-meta" role="status">
          {STREAM_PAUSED}
        </p>
      )}
      {output.error && (
        <p className="activity-meta" role="status">
          {output.error}
        </p>
      )}
    </div>
  );
}

function lastLine(text: string): string {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (line) return line;
  }
  return '';
}

/**
 * One running background command. Its tail stream feeds both the last line and, while expanded,
 * the output panel; expanding raises the same stream's priority instead of opening another.
 */
function StripRow({
  client,
  task,
  disconnected,
}: {
  client: ActivityClient;
  task: ActivityTask;
  disconnected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const readable = !disconnected && task.outputAvailable === true;
  const tail = useOutputTail(client, task.id, readable, open ? 1 : 3);
  const line = tail.paused ? '' : lastLine(tail.lines);
  return (
    <>
      <div
        className="activity-strip-row"
        data-task={task.id}
        data-status={disconnected ? 'unknown' : 'running'}
      >
        <span className="activity-dot" aria-hidden="true" />
        <span className="activity-strip-name">{task.description}</span>
        {task.command && <code>{task.command}</code>}
        {!disconnected && <Elapsed since={task.startedAt} />}
        <span className="activity-last-line">{line || NO_LINE_YET}</span>
        {readable && (
          <button
            type="button"
            className="activity-link"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            output
          </button>
        )}
      </div>
      {open && readable && <OutputPanel output={{ ...tail, text: tail.lines }} />}
    </>
  );
}

function BackgroundStrip({
  client,
  commands,
  disconnected,
}: {
  client: ActivityClient;
  commands: readonly ActivityTask[];
  disconnected: boolean;
}) {
  if (commands.length === 0) return null;
  return (
    <section className="activity-strip" aria-label="Background commands">
      {commands.map((task) => (
        <StripRow key={task.id} client={client} task={task} disconnected={disconnected} />
      ))}
    </section>
  );
}

/** A finished command; its output is read once, through the window endpoint, when asked for. */
function FinishedCommandRow({
  client,
  task,
  disconnected,
}: {
  client: ActivityClient;
  task: ActivityTask;
  disconnected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const readable = !disconnected && task.outputAvailable === true;
  const output = useOutputWindow(client, task.id, open && readable);
  return (
    <>
      <div className="activity-strip-row" data-task={task.id} data-status={task.status}>
        <span className="activity-dot" aria-hidden="true" />
        <span className="activity-strip-name">{task.description}</span>
        {task.command && <code>{task.command}</code>}
        <span className="activity-meta">{finishedTiming(task, task.status)}</span>
        {readable && (
          <button
            type="button"
            className="activity-link"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            output
          </button>
        )}
      </div>
      {open && readable && <OutputPanel output={output} />}
    </>
  );
}

function HistorySection({
  client,
  finished,
  disconnected,
}: {
  client: ActivityClient;
  finished: readonly ActivityTask[];
  disconnected: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (finished.length === 0) return null;
  return (
    <section className="activity-history" aria-label="History">
      <button
        type="button"
        className="activity-history-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        History · {historySummary(finished)}
      </button>
      {open &&
        finished.map((task) =>
          task.kind === 'subagent' ? (
            <FinishedSubagentCard
              key={task.id}
              client={client}
              task={task}
              disconnected={disconnected}
            />
          ) : (
            <FinishedCommandRow
              key={task.id}
              client={client}
              task={task}
              disconnected={disconnected}
            />
          ),
        )}
    </section>
  );
}

export function ActivityView({
  client,
  activity,
  codingState,
  agentIsClaude,
}: {
  client: ActivityClient;
  activity: ActivitySnapshot | undefined;
  codingState: CodingState;
  agentIsClaude: boolean;
}) {
  const disconnected = codingState === 'disconnected';
  const tasks = activity?.tasks;
  const calls = activity?.calls;
  const gaps = activity?.gaps ?? [];
  // Nested tasks belong to their parent's transcript; only the main session's own reach the page.
  const groups = useMemo(
    () => groupTasks((tasks ?? []).filter((task) => task.depth === 0)),
    [tasks],
  );
  const mainCalls = useMemo(() => (calls ?? []).filter((entry) => entry.depth === 0), [calls]);
  const empty = !tasks?.length && !calls?.length && gaps.length === 0;
  if (empty && !disconnected)
    return (
      <div className="activity" dir="ltr">
        <p className="activity-empty">No tool calls yet.</p>
      </div>
    );
  const status = mainStatus(codingState, groups.subagents.length + groups.commands.length);
  return (
    <div className="activity" dir="ltr">
      <BackgroundStrip client={client} commands={groups.commands} disconnected={disconnected} />
      <AgentCard
        agent="main"
        status={status === 'disconnected' ? 'unknown' : status}
        name={agentIsClaude ? 'Claude' : 'Agent'}
        tag="main"
        meta={<MainMeta status={status} calls={mainCalls} />}
      >
        <ActionList calls={mainCalls} gaps={gaps} highlight={!disconnected} />
      </AgentCard>
      {groups.subagents.map((task) => (
        <RunningSubagentCard
          key={task.id}
          client={client}
          task={task}
          disconnected={disconnected}
        />
      ))}
      <HistorySection client={client} finished={groups.finished} disconnected={disconnected} />
    </div>
  );
}
