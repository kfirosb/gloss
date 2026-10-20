# Videos and launch posts

Two guide videos in English, with captions and an ElevenLabs narration (voice: Eric). 1920×1080, H.264, about a minute and a half each.

| File | What it shows |
|------|---------------|
| `gloss-guide.mp4` | "The same agent. A more convenient interface. In your language." Open Gloss and it finds every session open on the computer automatically: two projects, three worktrees, six agents (two of them on two tasks in the same worktree), with badges for approvals and unread answers. A Claude reply arrives translated, with no copying into another agent; the per-session language menu shows that you write in your language while the agent receives the language you choose (English). Split view puts the real terminal next to the translated conversation; a message written in Hebrew is typed into the terminal as English, and Claude's answer appears in both. Then the full Terminal view, Activity (tool calls, subagents, background commands), a notification when another agent finishes, the Files column, where a long spec is shortened with a TL;DR and then translated for reading, a new session, Move to Gloss, and finally the Language Assistant. |
| `gloss-install.mp4` | Requirements, install with Homebrew or the DMG (and Linux packages), connecting a folder, the first Codex session appearing and its reply translated, the first Hebrew message through review and send, a Claude Code session from the plus button, and the language settings. |

The footage is the real Gloss UI (the React app served by vite) fed by a demo API with invented projects and conversations, so nothing private is on screen and the recording is repeatable. To re-record after a UI change, see [`scripts/video/README.md`](../../scripts/video/README.md). The narration is each scene's caption (or its `voice` line for the title and end cards) from `scripts/video/script.mjs`, generated with ElevenLabs; scenes last as long as their line.

The MP4s are not committed (12.7 MB that every clone would carry); they live in GitHub's attachment storage and the README embeds their `user-attachments` URLs, which GitHub renders as an inline player. To replace a video, upload the new file through any GitHub editor on the repository (release notes, an issue, the README web editor), make sure the URL appears in saved content so the attachment becomes public, and update the README. The poster image stays in the repository.

## LinkedIn post · Hebrew

> הסוכן הכי מהיר הוא זה שלא מחכה לך.
>
> ככה נראה יום עבודה שלי היום: פותחים את Gloss, וכל הסשנים של Claude Code ו‑Codex שרצים בטרמינלים כבר שם. ב‑main Claude סיים תיקון ב‑checkout, ובאותו worktree Codex כותב בדיקות לעגלה. ב‑worktree אחד Claude מחכה לאישור. ב‑worktree שני Codex סיים ומחכה לסקירה. ובפרויקט אחר Codex מפצל Terraform למודולים. שני פרויקטים, שלושה ענפים, שישה סוכנים, מסך אחד. ובעברית.
>
> זה Gloss, הכלי שבניתי כי נמאס לי להעתיק תשובות מהטרמינל לצ'אט כדי לקרוא אותן בנוחות. הוא יושב ליד הסשנים שכבר רצים לכם, ועושה שלושה דברים:
>
> 1. מראה את כל הפרויקטים וה‑worktrees בסרגל צד אחד, עם תג אדום בכל מקום שסוכן צריך אתכם: אישור או תשובה שעוד לא קראתם. לא צריך לעבור בין חלונות טרמינל כדי לגלות מי תקוע.
> 2. מציג את הטרמינל האמיתי לצד השיחה המתורגמת. כותבים בעברית, Gloss מקליד לטרמינל אנגלית תמציתית, והתשובה של הסוכן מופיעה בעברית לידה. רק הלחיצה שלכם שולחת, והאישורים נשארים בטרמינל.
> 3. פותח סשנים חדשים מתוכו (Claude, Codex או טרמינל, בכל תיקייה או worktree), מעביר אליו סשן של Claude שפתחתם בטרמינל שלכם עם כל ההיסטוריה, וכשרוצים לחשוב קודם, עוזר השפה דן איתכם בעברית ומכין הוראה חדה יותר שאתם בודקים לפני השליחה.
>
> התוצאה: במקום לשבת מול סוכן אחד ולחכות, פותחים worktrees, מריצים בכל אחד כמה סוכנים על כמה משימות במקביל, ועוברים ביניהם לפי התגים. העבודה המקבילית היא לא פיצ'ר נוסף, היא כל הרעיון.
>
> קוד פתוח, macOS ו‑Linux, רץ על החשבון הקיים שלכם ב‑Claude או OpenAI, והכול נשאר על המחשב. סרטון קצר בפוסט, הלינק להתקנה בתגובה הראשונה.
>
> #ClaudeCode #Codex #OpenSource #DeveloperTools #Hebrew #AIAgents

First comment:

> התקנה: `brew install --cask kfirosb/tap/gloss`
> הקוד, ההסברים וסרטון ההתקנה: https://github.com/kfirosb/gloss

## LinkedIn post · English

> The fastest agent is the one that is not waiting for you.
>
> Here is what my workday looks like now: open Gloss, and every Claude Code and Codex session running in my terminals is already there. On main, Claude just finished a checkout fix while Codex writes cart tests in the same worktree. In one worktree Claude is waiting for an approval. In another, Codex has finished and is waiting for review. And in a different project, Codex is splitting Terraform into modules. Two projects, three branches, six agents, one screen. And in Hebrew.
>
> This is Gloss, the tool I built because I was tired of copying answers out of the terminal into a chat just to read them comfortably. It sits next to the sessions you already have running, and does three things:
>
> 1. Shows every project and worktree in one sidebar, with a red badge wherever an agent needs you: an approval, or an answer you have not read yet. No more cycling through terminal windows to find out who is stuck.
> 2. Puts the real terminal next to the translated conversation. You write in Hebrew, Gloss types concise English into the terminal, and the agent's answer shows up in Hebrew beside it. Only your click sends, and approvals stay in the terminal.
> 3. Opens new sessions from inside (Claude, Codex or a terminal, in any folder or worktree), moves a Claude session you started in your own terminal into Gloss with all its history, and when you want to think first, the Language Assistant discusses the task with you in Hebrew and prepares a sharper instruction that you review before it goes out.
>
> The result: instead of sitting in front of one agent and waiting, you open worktrees, run several agents on several tasks in each, in parallel, and move between them by the badges. Parallel work is not an extra feature; it is the whole idea.
>
> Open source, macOS and Linux, runs on the Claude or OpenAI account you already have, and everything stays on your computer. A short video in the post, install link in the first comment.
>
> #ClaudeCode #Codex #OpenSource #DeveloperTools #Hebrew #AIAgents

First comment:

> Install: `brew install --cask kfirosb/tap/gloss`
> Code, docs and the install video: https://github.com/kfirosb/gloss
