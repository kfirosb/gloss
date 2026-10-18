/**
 * Characters Run never types: C0 controls except newline (so tab too), DEL, C1 controls, bidi controls and
 * zero-width characters. They would act on the shell or hide what the command really does.
 * Shared by the Run button (hidden for such blocks) and the server (`Invalid command`).
 */
export const UNSAFE_COMMAND_CHARACTER = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F؜​-‏‪-‮⁠⁦-⁩﻿]/;
export const MAX_RUN_COMMAND_LENGTH = 8192;
/** Single-quotes a value for a shell command the user copies; nothing Gloss runs goes through a shell. */
export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
