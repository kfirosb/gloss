import type { LanguageInput, LanguageSession } from '../../src/core/contracts.js';

export class FakeLanguageSession implements LanguageSession {
  readonly translatedLanguages: string[] = [];
  readonly summarizedLanguages: string[] = [];
  async summarize(_text:string,language:string,_signal:AbortSignal){this.summarizedLanguages.push(language);return 'תקציר';}
  readonly id = 'language-session-1';
  prepareResult = { localizedText: 'בצע את השינוי', englishText: 'Make the change' };
  discussionReply = 'הנה הסבר';
  translationReply = '';
  translationError?: Error;
  translateTransform?: ((text: string) => string) | undefined;
  readonly translated: string[] = [];
  readonly inputs: LanguageInput[] = [];
  prepareGate?: Promise<void>;
  discussGate?: Promise<void>;
  aborted = false;
  ignoreAbort = false;
  retainProjectContext = false;
  retainedProjectContext = '';
  resetContextCalls = 0;
  retainContextOnCompletion = false;
  resetContextGate?: Promise<void>;

  async *discuss(input: LanguageInput, signal: AbortSignal) {
    this.inputs.push(structuredClone(input));
    if (this.retainProjectContext && input.projectContext && !this.retainContextOnCompletion) {
      this.retainedProjectContext = input.projectContext;
    }
    if (this.discussGate) await this.discussGate;
    if (this.retainProjectContext && input.projectContext && this.retainContextOnCompletion) {
      this.retainedProjectContext = input.projectContext;
    }
    if (signal.aborted && !this.ignoreAbort) {
      this.aborted = true;
      throw new DOMException('Aborted', 'AbortError');
    }
    yield this.retainProjectContext ? this.retainedProjectContext : this.discussionReply;
  }
  async prepare(input: LanguageInput, signal: AbortSignal) {
    this.inputs.push(structuredClone(input));
    if (this.prepareGate) await this.prepareGate;
    if (signal.aborted && !this.ignoreAbort) {
      this.aborted = true;
      throw new DOMException('Aborted', 'AbortError');
    }
    return { ...this.prepareResult };
  }
  async translate(text: string, language = '') {
    this.translated.push(text); this.translatedLanguages.push(language);
    if (this.translationError) throw this.translationError;
    return this.translateTransform?.(text) ?? this.translationReply;
  }
  async resetContext() {
    this.resetContextCalls += 1;
    if (this.resetContextGate) await this.resetContextGate;
    this.retainedProjectContext = '';
  }
  async close() {}
}
