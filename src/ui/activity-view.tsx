import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ActivityCall, ActivitySnapshot, ActivityTask } from '../core/activity-contracts.js';
import { RichText } from './rich-text.js';
import type { SessionClient } from './session-client.js';
import { useOutputTail, useSubagentStream } from './use-activity-streams.js';

type ActivityClient = Pick<
  SessionClient,
  'sessionId' | 'subagentActivity' | 'outputTail' | 'outputWindow'
>;
type CardStatus = ActivityTask['status'] | 'unknown';
/** Pixels from the bottom that still count as "at the bottom" for the output tail's auto-scroll. */
const STICK_TO_BOTTOM_PX = 8;
const STREAM_PAUSED = 'Stream paused while other streams are open; it resumes when one closes.';

function clock(timestamp?: string): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
function duration(from?: string, to?: string | number): string {
  if (!from || to === undefined) return '';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
/** A running task's elapsed time; only this span re-renders every second. */
function Elapsed({ since }: { since?: string | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  const text = duration(since, now);
  return text ? <span>{text}</span> : null;
}

function TimelineRow({ call }: { call: ActivityCall }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="activity-row" data-call={call.id}>
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
/** Tool calls newest first. */
function Timeline({ calls }: { calls: readonly ActivityCall[] }) {
  return (
    <div className="activity-timeline">
      {[...calls].reverse().map((call) => (
        <TimelineRow key={call.id} call={call} />
      ))}
    </div>
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

function SubagentTimeline({
  client,
  taskId,
  active,
}: {
  client: ActivityClient;
  taskId: string;
  active: boolean;
}) {
  const { activity: stream, paused } = useSubagentStream(client, taskId, active, 1);
  return (
    <div className="activity-sub">
      {paused && (
        <p className="activity-meta" role="status">
          {STREAM_PAUSED}
        </p>
      )}
      {stream.tasks.length > 0 && (
        <div className="activity-nested-tasks" aria-label="Nested tasks">
          {stream.tasks.map((task) => (
            <NestedTaskRow key={task.id} task={task} />
          ))}
        </div>
      )}
      {stream.calls.length > 0 ? (
        <Timeline calls={stream.calls} />
      ) : (
        !paused && (
          <p className="activity-meta">
            {active ? 'Waiting for its first tool call.' : 'No live transcript.'}
          </p>
        )
      )}
      {stream.gaps.map((gap) => (
        <p key={gap} className="activity-meta">
          {gap}
        </p>
      ))}
    </div>
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

function OutputPanel({ client, taskId }: { client: ActivityClient; taskId: string }) {
  const tail = useOutputTail(client, taskId, true, 1);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const element = pre.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [tail.lines]);
  return (
    <div className="activity-output">
      {tail.start > 0 && (
        <button type="button" className="activity-button" onClick={() => void tail.showEarlier()}>
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
        {tail.lines}
      </pre>
      {tail.paused && (
        <p className="activity-meta" role="status">
          {STREAM_PAUSED}
        </p>
      )}
      {tail.error && (
        <p className="activity-meta" role="status">
          {tail.error}
        </p>
      )}
    </div>
  );
}

function TaskCard({
  client,
  task,
  disconnected,
}: {
  client: ActivityClient;
  task: ActivityTask;
  disconnected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const status: CardStatus = disconnected && task.status === 'running' ? 'unknown' : task.status;
  const subagent = task.kind === 'subagent';
  const timing =
    status === 'unknown' ? (
      <span>Session disconnected</span>
    ) : status === 'running' ? (
      <Elapsed since={task.startedAt} />
    ) : (
      <span>
        {[`${status} ${clock(task.finishedAt)}`.trim(), duration(task.startedAt, task.finishedAt)]
          .filter(Boolean)
          .join(' · ')}
      </span>
    );
  const title = (
    <>
      <b>
        <span aria-hidden="true">{status === 'running' ? '● ' : '○ '}</span>
        {subagent ? 'Subagent' : 'Background'} · {task.description}
      </b>
    </>
  );
  const labels = subagent ? [task.agentType, task.model].filter(Boolean).join(' · ') : '';
  const meta = (
    <span className="activity-meta">
      {labels && `${labels} · `}
      {timing}
    </span>
  );
  return (
    <article className="activity-card" data-task={task.id} data-status={status}>
      {subagent ? (
        <button
          type="button"
          className="activity-card-head"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="activity-title">{title}</span>
          {meta}
        </button>
      ) : (
        <div className="activity-card-head">
          <span className="activity-title">{title}</span>
          <span className="activity-head-end">
            {meta}
            {task.outputAvailable && !disconnected && (
              <button
                type="button"
                className="activity-button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
              >
                {open ? 'Hide output' : 'Show output'}
              </button>
            )}
          </span>
        </div>
      )}
      {!subagent && task.command && (
        <div className="activity-meta">
          <code>{task.command}</code>
        </div>
      )}
      {subagent && open && (
        <SubagentTimeline client={client} taskId={task.id} active={!disconnected} />
      )}
      {!subagent && open && !disconnected && <OutputPanel client={client} taskId={task.id} />}
      {subagent && (open || task.status === 'running') && <Report task={task} />}
    </article>
  );
}

export function ActivityView({
  client,
  activity,
  agentIsClaude,
  disconnected,
}: {
  client: ActivityClient;
  activity: ActivitySnapshot | undefined;
  agentIsClaude: boolean;
  disconnected: boolean;
}) {
  const tasks = activity?.tasks ?? [];
  const calls = activity?.calls ?? [];
  const gaps = activity?.gaps ?? [];
  const newest = [...tasks].reverse();
  const groups = [
    {
      label: disconnected ? 'Status unknown' : 'Running now',
      tasks: newest.filter((task) => task.status === 'running'),
    },
    { label: 'Completed', tasks: newest.filter((task) => task.status !== 'running') },
  ];
  if (tasks.length === 0 && calls.length === 0 && gaps.length === 0)
    return (
      <div className="activity" dir="ltr">
        <p className="activity-empty">No tool calls yet.</p>
      </div>
    );
  return (
    <div className="activity" dir="ltr">
      {tasks.length > 0 && (
        <section className="activity-tasks" aria-label="Tasks">
          {/* Keep cards under one parent so completing a task preserves its open stream and history. */}
          {groups
            .filter((group) => group.tasks.length > 0)
            .flatMap((group) => [
              <h3 key={`heading:${group.label}`} className="activity-label">
                {group.label}
              </h3>,
              ...group.tasks.map((task) => (
                <TaskCard
                  key={`task:${task.id}`}
                  client={client}
                  task={task}
                  disconnected={disconnected}
                />
              )),
            ])}
        </section>
      )}
      <section className="activity-main" aria-label="Tool timeline">
        <h3 className="activity-label">
          {agentIsClaude ? 'What Claude did' : 'What the agent did'}
        </h3>
        {calls.length > 0 && <Timeline calls={calls} />}
        {calls.length === 0 && gaps.length === 0 && (
          <p className="activity-empty">No tool calls yet.</p>
        )}
        {gaps.map((gap) => (
          <p key={gap} className="activity-gap">
            {gap}
          </p>
        ))}
      </section>
    </div>
  );
}
