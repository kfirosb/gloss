/**
 * Characters Run never types: C0 controls except newline (so tab too), DEL, C1 controls, bidi controls and
 * zero-width characters. They would act on the shell or hide what the command really does.
 * Shared by the Run button (hidden for such blocks) and the server (`Invalid command`).
 */
export const UNSAFE_COMMAND_CHARACTER = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F؜​-‏‪-‮⁠⁦-⁩﻿]/;
