import { useEffect, useId, useRef, useState } from 'react';
import {
  LANGUAGE_FIELDS,
  SUPPORTED_LANGUAGES,
  languageDirection,
  languageName,
  languageShortCode,
  needsReplyTranslation,
  needsSendTranslation,
  type LanguageOverride,
  type LanguageSettings,
} from '../core/language-settings.js';
import {
  readLanguageDefaults,
  writeLanguageDefaults,
  type SessionClient,
} from './session-client.js';
import { PanelDialog } from './composer-dialogs.js';
import {
  LaunchSettingsFields,
  readLaunchSettings,
  saveLaunchSettings,
  toInput,
  type LaunchSettingsInput,
} from './launch-controls.js';
import { alertSoundsFor, useAlertSettings } from './attention-alerts.js';
import { hostPlatform } from './host-platform.js';
import {
  DARK_STYLES,
  useDisplayPreferences,
  type DarkStyle,
  type Theme,
} from './display-preferences.js';
import { errorMessage } from './error-message.js';
import { ClaudeRegistrationSettings } from './claude-connection.js';

export type SessionLanguage = {
  defaults: LanguageSettings;
  override: LanguageOverride;
  effective: LanguageSettings;
};
const labels: Record<keyof LanguageSettings, [string, string]> = {
  write: ['I write in', 'Sets the composer direction'],
  send: ['Send to the agent in', 'What the coding session receives'],
  reply: ['Show agent replies in', 'English shows the original text, no translation'],
  assist: ['Language Assistant speaks', 'The discussion with the assistant'],
};
/** Menu text for a language; right-to-left languages say so, since they change the layout. */
export function languageOptionLabel(code: string) {
  const name = languageName(code);
  return languageDirection(code) === 'rtl' ? `${name} (RTL)` : name;
}
function Fields({
  value,
  onChange,
  idPrefix,
}: {
  value: LanguageSettings;
  onChange(field: keyof LanguageSettings, code: string): void;
  idPrefix: string;
}) {
  return (
    <>
      {LANGUAGE_FIELDS.map((field) => (
        <div className="language-field" key={field}>
          <label htmlFor={idPrefix + field}>{labels[field][0]}</label>
          <select
            id={idPrefix + field}
            value={value[field]}
            onChange={(e) => onChange(field, e.target.value)}
          >
            {SUPPORTED_LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {languageOptionLabel(code)}
              </option>
            ))}
          </select>
          <small>{labels[field][1]}</small>
        </div>
      ))}
    </>
  );
}
export function translationSummary(s: LanguageSettings) {
  const out = needsSendTranslation(s),
    back = needsReplyTranslation(s);
  return {
    on: out || back,
    text: `You type ${languageName(s.write)} → ${out ? 'translated to' : 'sent as is in'} ${languageName(s.send)}. Agent replies → ${back ? 'translated to ' + languageName(s.reply) : 'shown as is, formatted'}.`,
  };
}
export function LanguageDefaultsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [value, setValue] = useState<LanguageSettings | null>(null);
  const [alerts, updateAlerts] = useAlertSettings();
  const [display, updateDisplay] = useDisplayPreferences();
  const [launch, setLaunch] = useState<LaunchSettingsInput | null>(null);
  const [error, setError] = useState('');
  const id = useId();
  useEffect(() => {
    if (open) {
      setError('');
      setLaunch(null);
      readLanguageDefaults().then(setValue, (e) => setError(errorMessage(e, 'Unavailable')));
      readLaunchSettings().then(
        (s) => setLaunch(toInput(s)),
        () => {},
      );
    }
  }, [open]);
  const save = async () => {
    if (!value) return;
    try {
      await writeLanguageDefaults(value);
      if (launch) await saveLaunchSettings(launch);
      onClose();
    } catch (e) {
      setError(errorMessage(e, 'Save failed'));
    }
  };
  return (
    <PanelDialog
      title="Settings"
      open={open}
      close={onClose}
      className="sidebar-panel-dialog settings-dialog"
    >
      <div className="review-body" dir="ltr">
        <section className="settings-section" aria-labelledby={id + 'languages'}>
          <h3 id={id + 'languages'}>Languages</h3>
          <p>Every new session starts with these. You can change them per session later.</p>
          {value && (
            <Fields
              idPrefix={id}
              value={value}
              onChange={(f, c) => setValue({ ...value, [f]: c })}
            />
          )}
        </section>
        {launch && <LaunchSettingsFields value={launch} onChange={setLaunch} />}
        <section className="settings-section" aria-labelledby={id + 'appearance'}>
          <h3 id={id + 'appearance'}>Appearance</h3>
          <div className="language-field">
            <label htmlFor={id + 'theme'}>Theme</label>
            <select
              id={id + 'theme'}
              value={display.theme}
              onChange={(e) => {
                const theme = e.target.value as Theme;
                updateDisplay((p) => ({ ...p, theme }));
              }}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="auto">Match system</option>
            </select>
          </div>
          <div className="language-field">
            <label htmlFor={id + 'dark-style'}>Dark style</label>
            <select
              id={id + 'dark-style'}
              value={display.darkStyle}
              onChange={(e) => {
                const darkStyle = e.target.value as DarkStyle;
                updateDisplay((p) => ({ ...p, darkStyle }));
              }}
            >
              {DARK_STYLES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <small>Used whenever Gloss is dark, including Match system at night</small>
          </div>
        </section>
        <section className="settings-section alert-settings" aria-labelledby={id + 'alerts'}>
          <h3 id={id + 'alerts'}>Notifications</h3>
          <p>When a session you are not looking at replies or needs approval.</p>{' '}
          <label>
            <input
              type="checkbox"
              checked={alerts.message}
              onChange={(e) => {
                const message = e.target.checked;
                updateAlerts((s) => ({ ...s, message }));
              }}
            />{' '}
            Show a message (banner in Gloss,{' '}
            {hostPlatform() === 'darwin' ? 'Dock bounce' : 'taskbar flash'})
          </label>{' '}
          <label>
            <input
              type="checkbox"
              checked={alerts.sound}
              onChange={(e) => {
                const sound = e.target.checked;
                updateAlerts((s) => ({ ...s, sound }));
              }}
            />{' '}
            Play a sound
          </label>{' '}
          <div className="settings-row">
            <select
              aria-label="Alert sound"
              value={alerts.soundName}
              disabled={!alerts.sound}
              onChange={(e) => {
                const soundName = e.target.value;
                updateAlerts((s) => ({ ...s, soundName }));
              }}
            >
              {alertSoundsFor(hostPlatform()).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {window.gloss?.alert && (
              <button
                type="button"
                disabled={!alerts.sound}
                onClick={() => window.gloss?.alert?.({ sound: alerts.soundName, bounce: false })}
              >
                Try sound
              </button>
            )}
          </div>
        </section>
        <ClaudeRegistrationSettings open={open} />
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="review-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={!value} onClick={() => void save()}>
          Save
        </button>
      </div>
    </PanelDialog>
  );
}
export function SessionLanguageControl({
  client,
  settings,
}: {
  client: SessionClient;
  settings: LanguageSettings;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const summary = translationSummary(settings);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef<LanguageOverride | null>(null);
  const change = (field: keyof LanguageSettings, code: string) => {
    queue.current = queue.current.then(async () => {
      try {
        setError('');
        const base = latest.current ?? (await client.language()).override;
        const next = { ...base, [field]: code };
        const result = await client.setLanguage(next);
        latest.current = result.override ?? next;
      } catch (e) {
        latest.current = null;
        setError(errorMessage(e, 'Change failed'));
      }
    });
  };
  const reset = () => {
    queue.current = queue.current.then(async () => {
      try {
        setError('');
        await client.resetLanguage();
        latest.current = {};
      } catch (e) {
        latest.current = null;
        setError(errorMessage(e, 'Reset failed'));
      }
    });
  };
  return (
    <div className="session-language" ref={root} dir="ltr">
      <span className={'translation-indicator' + (summary.on ? ' on' : '')}>
        {summary.on ? 'Translation on' : 'No translation'}
      </span>
      <button
        type="button"
        className="language-chip"
        aria-expanded={open}
        aria-label={'Session languages ' + languageShortCode(settings)}
        onClick={() => setOpen((v) => !v)}
      >
        🌐 {languageShortCode(settings)} ▾
      </button>
      {open && (
        <section
          role="dialog"
          aria-labelledby={id + 'title'}
          className="language-popover"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
        >
          <h3 id={id + 'title'}>Languages for this session</h3>
          <p>Applies to this session only.</p>
          <Fields idPrefix={id} value={settings} onChange={(f, c) => change(f, c)} />
          <p className="language-flow">{summary.text}</p>
          {error && <p role="alert">{error}</p>}
          <div className="language-actions">
            <button type="button" onClick={() => reset()}>
              Reset to defaults
            </button>
            <button type="button" className="primary" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
