import { englishProductTerms } from './language-style.js';
import { resolveLanguage } from './language-settings.js';
import { createHash } from 'node:crypto';
import { ATTACHMENT_MENTION_SOURCE } from './file-references.js';
import type { ConversationStore, LanguageSession, TranslationKey } from './contracts.js';

export interface TranslationRequest {
  sourceScope: string;
  sourceId: string;
  sourceRevision: number;
  text: string;
  complete: boolean;
  language: string;
  promptLanguage?: string;
  model: string;
  promptVersion: string;
  signal?: AbortSignal;
}

interface TranslationDependencies {
  store: ConversationStore;
  session: LanguageSession;
}

// Placeholder-shaped text already in the message is protected like any literal, so every placeholder the model sees is ours.
const literalPattern =
  /⟪LITERAL_\d+⟫|```[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s)\]}>,]+|(["'])(?=(?:[A-Za-z]:\\|\\\\|\.\.?\/|\/|(?:[\w.-]+\/)+))[^"'\r\n]+\1|(?:[A-Za-z]:\\|\\\\)(?:[^\\\r\n]+?\\)*?[^\\\r\n]*?\.[A-Za-z0-9]{1,16}(?:\.[A-Za-z0-9]{1,16})*|(?:\.\.?\/|\/)(?:[^/\r\n]+?\/)*?[^/\r\n]*?\.[A-Za-z0-9]{1,16}(?:\.[A-Za-z0-9]{1,16})*|(?:[A-Za-z]:\\|\\\\)[\w@%+.,~#=\\-]+|(?:\.\.?\/|\/|(?:[\w.-]+\/)+)(?:\\ |[\w@%+.,~#=\\\-/])+/g;

const replyLiteralPattern = (language: string) => {
  const code = resolveLanguage(language)?.code;
  return code && code !== 'en'
    ? new RegExp(literalPattern.source + '|\\b(?:' + englishProductTerms.join('|') + ')\\b', 'g')
    : literalPattern;
};

const protectLiterals = (text: string, pattern: RegExp) => {
  const literals: string[] = [];
  return {
    text: text.replace(pattern, (literal) => {
      const marker = `⟪LITERAL_${literals.length}⟫`;
      literals.push(literal);
      return marker;
    }),
    literals,
  };
};

/** One pass, so restored literals are never rescanned; each placeholder must appear exactly once and none may be invented. */
const restoreLiterals = (translated: string, literals: string[]): string | undefined => {
  const seen = new Array<number>(literals.length).fill(0);
  let invalid = false;
  const restored = translated.replace(/⟪LITERAL_(\d+)⟫/g, (marker, index: string) => {
    const at = Number(index);
    if (at >= literals.length) {
      invalid = true;
      return marker;
    }
    seen[at]!++;
    return literals[at]!;
  });
  return invalid || seen.some((count) => count !== 1) ? undefined : restored;
};

/**
 * Translates text with every `pattern` match held out of the model's reach as a placeholder and restored afterwards.
 * Returns undefined when the model loses or invents a placeholder twice, so the caller never gets a text missing a literal.
 */
export async function translateKeepingLiterals(
  text: string,
  pattern: RegExp,
  translate: (text: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const protectedText = protectLiterals(text, pattern);
  const attempt = async () =>
    restoreLiterals(await translate(protectedText.text), protectedText.literals);
  // A model occasionally drops a placeholder in long, code-heavy replies; one more try usually keeps them all.
  const restored = await attempt();
  return restored === undefined && !signal?.aborted ? attempt() : restored;
}

/**
 * Attachment references ("@Image 3") a composer translation must keep verbatim, so the text still names the
 * same entry as the References block. Placeholder-shaped user text is protected too, so every placeholder is ours.
 */
export const composerLiteralPattern = () =>
  new RegExp('⟪LITERAL_\\d+⟫|' + ATTACHMENT_MENTION_SOURCE, 'g');

export const translationContentHash = (text: string) =>
  createHash('sha256').update(text).digest('hex');

export interface TranslationResult {
  status: 'complete' | 'pending' | 'error';
  text: string;
}

export async function translateMessageResult(
  request: TranslationRequest,
  { store, session }: TranslationDependencies,
): Promise<TranslationResult> {
  if (request.signal?.aborted) return { status: 'error', text: request.text };
  if (!request.complete) return { status: 'pending', text: request.text };
  const key: TranslationKey = {
    sourceScope: request.sourceScope,
    sourceId: request.sourceId,
    sourceRevision: request.sourceRevision,
    contentHash: translationContentHash(request.text),
    language: request.language,
    model: request.model,
    promptVersion: request.promptVersion,
  };
  const cached = store.getTranslation(key);
  if (cached !== undefined) return { status: 'complete', text: cached };

  try {
    const signal = request.signal ?? new AbortController().signal;
    const restored = await translateKeepingLiterals(
      request.text,
      replyLiteralPattern(request.language),
      (text) => session.translate(text, request.promptLanguage ?? request.language, signal),
      signal,
    );
    if (restored === undefined || request.signal?.aborted)
      return { status: 'error', text: request.text };
    store.putTranslation(key, restored);
    return { status: 'complete', text: restored };
  } catch {
    return { status: 'error', text: request.text };
  }
}

export async function translateMessage(
  request: TranslationRequest,
  dependencies: TranslationDependencies,
): Promise<string> {
  return (await translateMessageResult(request, dependencies)).text;
}
