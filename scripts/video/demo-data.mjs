// Demo data for the guide videos: the real Gloss UI served by vite, every API answered from here.
// Nothing here touches a real session; the projects, folders and conversations are invented.
const HOME = '/Users/dana';
const P = `${HOME}/Projects`;
export const shop = { key: `${P}/shop-api/.git`, name: 'shop-api', main: `${P}/shop-api` };
export const infra = { key: `${P}/infra/.git`, name: 'infra', main: `${P}/infra` };
export const mobile = { key: `${P}/mobile-app/.git`, name: 'mobile-app', main: `${P}/mobile-app` };
export const wtPayments = `${P}/shop-api/.worktrees/payments-retry`;
export const wtLogin = `${P}/shop-api/.worktrees/login-redirect`;

export const ts = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
export const msg = (
  sourceId,
  revision,
  role,
  text,
  translatedText,
  minutesAgo,
  complete = true,
) => ({
  sourceId,
  revision,
  role,
  text,
  complete,
  timestamp: ts(minutesAgo),
  ...(translatedText ? { translatedText, translationStatus: 'complete' } : {}),
});

export const claudeCaps = {
  imageAttachments: true,
  fileReferences: true,
  history: true,
  liveMessages: true,
  attachExisting: true,
  sendWhileBusy: false,
  channelSendWhileBusy: true,
  acknowledgement: 'queued',
};
export const codexCaps = {
  imageAttachments: true,
  fileReferences: true,
  history: true,
  liveMessages: true,
  attachExisting: true,
  sendWhileBusy: false,
  acknowledgement: 'none',
};
export const languageSettings = { write: 'he', send: 'en', reply: 'he', assist: 'he' };

export const sessions = [
  {
    id: 'checkout',
    target: { agent: 'claude', sessionRef: 'checkout', projectId: shop.main },
    canonicalRoot: shop.main,
    projectName: shop.name,
    projectKey: shop.key,
    branch: 'main',
    worktreePath: shop.main,
    sessionTitle: 'Checkout race',
    activity: 'idle',
    open: true,
    launchId: 'L-checkout',
    launchState: 'running',
    enabled: true,
  },
  {
    id: 'payments',
    target: { agent: 'claude', sessionRef: 'payments', projectId: wtPayments },
    canonicalRoot: wtPayments,
    projectName: shop.name,
    projectKey: shop.key,
    branch: 'feature/payments-retry',
    worktreePath: wtPayments,
    sessionTitle: 'Payments retry',
    activity: 'approval-required',
    open: true,
    latestResponseSequence: 2,
    enabled: true,
  },
  {
    id: 'carttests',
    target: { agent: 'codex', sessionRef: 'carttests', projectId: shop.main },
    canonicalRoot: shop.main,
    projectName: shop.name,
    projectKey: shop.key,
    branch: 'main',
    worktreePath: shop.main,
    sessionTitle: 'Cart API tests',
    activity: 'working',
    open: true,
    enabled: true,
  },
  {
    id: 'login',
    target: { agent: 'codex', sessionRef: 'login', projectId: wtLogin },
    canonicalRoot: wtLogin,
    projectName: shop.name,
    projectKey: shop.key,
    branch: 'fix/login-redirect',
    worktreePath: wtLogin,
    sessionTitle: 'Login redirect',
    activity: 'idle',
    open: true,
    latestResponseSequence: 4,
    attention: 'response',
    enabled: true,
  },
  {
    id: 'terraform',
    target: { agent: 'codex', sessionRef: 'terraform', projectId: infra.main },
    canonicalRoot: infra.main,
    projectName: infra.name,
    projectKey: infra.key,
    branch: 'main',
    worktreePath: infra.main,
    sessionTitle: 'Terraform modules',
    activity: 'working',
    open: true,
    latestResponseSequence: 2,
    enabled: true,
  },
  {
    id: 'onboarding',
    target: { agent: 'claude', sessionRef: 'onboarding', projectId: mobile.main },
    canonicalRoot: mobile.main,
    projectName: mobile.name,
    projectKey: mobile.key,
    branch: 'main',
    worktreePath: mobile.main,
    sessionTitle: 'Onboarding screens',
    activity: 'idle',
    open: true,
    enabled: true,
  },
];

export const folders = [
  {
    path: shop.main,
    projectKey: shop.key,
    projectName: shop.name,
    branch: 'main',
    missing: false,
    kind: 'main',
    createdByApp: false,
    connectedAt: 1,
  },
  {
    path: wtPayments,
    projectKey: shop.key,
    projectName: shop.name,
    branch: 'feature/payments-retry',
    missing: false,
    kind: 'worktree',
    createdByApp: true,
    connectedAt: 2,
  },
  {
    path: wtLogin,
    projectKey: shop.key,
    projectName: shop.name,
    branch: 'fix/login-redirect',
    missing: false,
    kind: 'worktree',
    createdByApp: true,
    connectedAt: 3,
  },
  {
    path: infra.main,
    projectKey: infra.key,
    projectName: infra.name,
    branch: 'main',
    missing: false,
    kind: 'main',
    createdByApp: false,
    connectedAt: 4,
  },
  {
    path: mobile.main,
    projectKey: mobile.key,
    projectName: mobile.name,
    branch: 'main',
    missing: false,
    kind: 'main',
    createdByApp: false,
    connectedAt: 5,
  },
];
export const worktreesByKey = {
  [shop.key]: [
    {
      path: shop.main,
      branch: 'main',
      main: true,
      detached: false,
      locked: false,
      prunable: false,
    },
    {
      path: wtPayments,
      branch: 'feature/payments-retry',
      main: false,
      detached: false,
      locked: false,
      prunable: false,
    },
    {
      path: wtLogin,
      branch: 'fix/login-redirect',
      main: false,
      detached: false,
      locked: false,
      prunable: false,
    },
  ],
  [infra.key]: [
    {
      path: infra.main,
      branch: 'main',
      main: true,
      detached: false,
      locked: false,
      prunable: false,
    },
  ],
  [mobile.key]: [
    {
      path: mobile.main,
      branch: 'main',
      main: true,
      detached: false,
      locked: false,
      prunable: false,
    },
  ],
};

const activityCheckout = {
  running: 0,
  gaps: [],
  calls: [
    {
      id: 'c1',
      tool: 'Grep',
      summary: 'reserveStock in src/',
      input: 'reserveStock',
      position: 10,
      depth: 0,
      timestamp: ts(6),
      result: { ok: true, text: 'src/checkout/reserve.ts:41' },
    },
    {
      id: 'c2',
      tool: 'Read',
      summary: 'src/checkout/reserve.ts',
      input: 'src/checkout/reserve.ts',
      position: 20,
      depth: 0,
      timestamp: ts(5),
      result: { ok: true, text: '…' },
    },
    {
      id: 'c3',
      tool: 'Bash',
      summary: 'git log -n 20 -- src/checkout',
      input: 'git log -n 20 -- src/checkout',
      position: 30,
      depth: 0,
      timestamp: ts(4),
      result: { ok: true, text: '…' },
    },
    {
      id: 'c4',
      tool: 'Edit',
      summary: 'src/checkout/reserve.ts',
      input: 'SELECT … FOR UPDATE',
      position: 40,
      depth: 0,
      timestamp: ts(2),
      result: { ok: true, text: 'ok' },
    },
  ],
  tasks: [
    {
      kind: 'subagent',
      id: 'a1',
      description: 'Review every caller of reserveStock for the same race',
      position: 35,
      depth: 0,
      status: 'finished',
      startedAt: ts(3),
      finishedAt: ts(2),
      agentType: 'general-purpose',
      model: 'sonnet',
      report:
        'Checked all 4 callers of reserveStock. Only the checkout path had the race; cart and admin already run inside a locking transaction.',
    },
    {
      kind: 'background',
      id: 'b1',
      description: 'Run the checkout test suite',
      position: 45,
      depth: 0,
      status: 'finished',
      startedAt: ts(2),
      finishedAt: ts(1),
      command: 'npm test -- checkout',
      outputAvailable: true,
    },
  ],
};

export const snapshots = {
  checkout: {
    id: 'checkout',
    target: sessions.find((x) => x.id === 'checkout').target,
    codingState: 'idle',
    capabilities: claudeCaps,
    language: 'he',
    languageSettings,
    languageSessionId: 'lang-1',
    languageModel: 'default',
    sourceRevision: 3,
    deliveries: [],
    discussion: [],
    activity: activityCheckout,
    codingMessages: [
      msg(
        'm1',
        1,
        'user',
        'Two customers can both buy the last unit of an item. Find the race in checkout and fix it without changing the API.',
        null,
        8,
      ),
      msg(
        'm2',
        2,
        'assistant',
        'Found it. `reserveStock` in `src/checkout/reserve.ts` reads the quantity and writes it back in two separate queries, so two requests that arrive together both see `1` and both succeed.\n\nI locked the row with `SELECT … FOR UPDATE` inside the existing transaction and added a test that fires two checkouts at once. The checkout suite passes: 30 tests.',
        'מצאתי. הפונקציה `reserveStock` בקובץ `src/checkout/reserve.ts` קוראת את הכמות וכותבת אותה בחזרה בשתי שאילתות נפרדות, ולכן שתי בקשות שמגיעות יחד רואות `1` ושתיהן מצליחות.\n\nנעלתי את השורה עם `SELECT … FOR UPDATE` בתוך הטרנזקציה הקיימת והוספתי בדיקה שמריצה שני תשלומים במקביל. חבילת הבדיקות של ה‑checkout עוברת: 30 בדיקות.',
        6,
      ),
    ],
  },
  payments: {
    id: 'payments',
    target: sessions.find((x) => x.id === 'payments').target,
    codingState: 'approval-required',
    capabilities: claudeCaps,
    language: 'he',
    languageSettings,
    languageSessionId: 'lang-2',
    languageModel: 'default',
    sourceRevision: 2,
    deliveries: [],
    discussion: [],
    codingMessages: [
      msg(
        'p1',
        1,
        'user',
        'Add retry with exponential backoff to the payment provider client. Max 3 attempts, never retry a declined card.',
        null,
        14,
      ),
      msg(
        'p2',
        2,
        'assistant',
        'The client is wrapped with a retry policy: 3 attempts, 200 ms, 800 ms and 3.2 s apart, only for network errors and 5xx responses. A declined card returns immediately.\n\nTo run the provider sandbox tests I need to install `nock`. Approve the install in the terminal and I will continue.',
        'הלקוח עטוף עכשיו במדיניות ניסיונות חוזרים: 3 ניסיונות, בהפרשים של 200 מילישניות, 800 מילישניות ו‑3.2 שניות, רק לשגיאות רשת ולתשובות 5xx. כרטיס שנדחה חוזר מיד.\n\nכדי להריץ את בדיקות ה‑sandbox של הספק אני צריך להתקין `nock`. אשרו את ההתקנה בטרמינל ואמשיך.',
        9,
      ),
    ],
  },
  carttests: {
    id: 'carttests',
    target: { agent: 'codex', sessionRef: 'carttests', projectId: shop.main },
    codingState: 'working',
    capabilities: codexCaps,
    language: 'he',
    languageSettings,
    languageSessionId: 'lang-6',
    languageModel: 'default',
    sourceRevision: 2,
    deliveries: [],
    discussion: [],
    codingMessages: [
      msg(
        'ct1',
        1,
        'user',
        'Write integration tests for the cart API: add, remove, update quantity, and an empty cart.',
        null,
        6,
      ),
      msg(
        'ct2',
        2,
        'assistant',
        'Writing `cart.api.test.ts` with 12 cases against a test database. Running them now.',
        'כותב את `cart.api.test.ts` עם 12 מקרים מול מסד נתונים לבדיקות. מריץ אותם עכשיו.',
        4,
      ),
    ],
  },
  login: {
    id: 'login',
    target: sessions.find((x) => x.id === 'login').target,
    codingState: 'idle',
    capabilities: codexCaps,
    language: 'he',
    languageSettings,
    languageSessionId: 'lang-3',
    languageModel: 'default',
    sourceRevision: 4,
    deliveries: [],
    discussion: [],
    codingMessages: [
      msg(
        'l1',
        1,
        'user',
        'After login the user lands on the home page instead of the page they asked for. Keep the ?next= target.',
        null,
        30,
      ),
      msg(
        'l2',
        2,
        'assistant',
        'The login form drops the query string when it posts. I will carry `next` through the form and validate that it is a relative path.',
        'טופס ההתחברות מאבד את ה‑query string בזמן השליחה. אעביר את `next` דרך הטופס ואוודא שהוא נתיב יחסי בלבד.',
        28,
      ),
      msg('l3', 3, 'user', 'Go ahead, and add a test for an absolute URL in next.', null, 26),
      msg(
        'l4',
        4,
        'assistant',
        'Done.\n\n- `LoginForm` keeps `next` in a hidden field and the handler redirects to it after a successful login.\n- An absolute URL or a protocol-relative URL in `next` falls back to `/`.\n- Two tests cover both cases; the full auth suite passes (48 tests).\n\nReady for review on `fix/login-redirect`.',
        'סיימתי.\n\n- `LoginForm` שומר את `next` בשדה מוסתר, וה‑handler מפנה אליו אחרי התחברות מוצלחת.\n- כתובת מוחלטת או כתובת יחסית‑לפרוטוקול ב‑`next` חוזרת ל‑`/`.\n- שתי בדיקות מכסות את שני המקרים; כל חבילת ה‑auth עוברת (48 בדיקות).\n\nמוכן לסקירה בענף `fix/login-redirect`.',
        3,
      ),
    ],
  },
  terraform: {
    id: 'terraform',
    target: sessions.find((x) => x.id === 'terraform').target,
    codingState: 'working',
    capabilities: codexCaps,
    language: 'he',
    languageSettings,
    languageSessionId: 'lang-4',
    languageModel: 'default',
    sourceRevision: 2,
    deliveries: [],
    discussion: [],
    codingMessages: [
      msg(
        't1',
        1,
        'user',
        'Split the monolithic main.tf into modules: network, database, app. Keep the state addresses stable with moved blocks.',
        null,
        12,
      ),
      msg(
        't2',
        2,
        'assistant',
        'Starting with the network module. I will generate `moved` blocks for every resource so `terraform plan` shows no changes.',
        'מתחיל במודול הרשת. אייצר בלוקי `moved` לכל משאב כך ש‑`terraform plan` לא יציג שינויים.',
        10,
      ),
    ],
  },
  onboarding: {
    id: 'onboarding',
    target: sessions.find((x) => x.id === 'onboarding').target,
    codingState: 'idle',
    capabilities: claudeCaps,
    language: 'he',
    languageSettings,
    languageSessionId: 'lang-5',
    languageModel: 'default',
    sourceRevision: 2,
    deliveries: [],
    discussion: [],
    codingMessages: [
      msg(
        'o1',
        1,
        'user',
        'Build the three onboarding screens from the Figma export in docs/onboarding.',
        null,
        300,
      ),
      msg(
        'o2',
        2,
        'assistant',
        'The three screens are in `src/screens/onboarding/` with a pager and the copy from the export. Snapshot tests added.',
        'שלושת המסכים נמצאים ב‑`src/screens/onboarding/` עם pager והטקסטים מהייצוא. נוספו בדיקות snapshot.',
        290,
      ),
    ],
  },
};

const B = '\x1b[1m',
  D = '\x1b[2m',
  R = '\x1b[0m',
  G = '\x1b[32m',
  C = '\x1b[36m';
export const checkoutScreen = [
  `${B}${C}✳ Claude Code${R} ${D}v2.1.300 · ~/Projects/shop-api · main${R}`,
  '',
  `${D}> Two customers can both buy the last unit of an item. Find the race in checkout and fix it without changing the API.${R}`,
  '',
  `${G}●${R} Found it. ${B}reserveStock${R} in src/checkout/reserve.ts reads the quantity and writes it back in two`,
  '  separate queries, so two requests that arrive together both see 1 and both succeed.',
  `${G}●${R} ${B}Edit${R}(src/checkout/reserve.ts) ${D}+6 -2${R}`,
  `${G}●${R} ${B}Write${R}(src/checkout/reserve.concurrent.test.ts)`,
  `${G}●${R} ${B}Bash${R}(npm test -- checkout) ${D}30 passed${R}`,
  `${G}●${R} I locked the row with SELECT … FOR UPDATE inside the existing transaction and added a test that`,
  '  fires two checkouts at once. The checkout suite passes: 30 tests.',
  '',
  `${B}>${R} `,
].join('\r\n');
export const onboardingScreen = [
  `${B}${C}✳ Claude Code${R} ${D}v2.1.300 · ~/Projects/mobile-app · main${R}`,
  '',
  `${G}●${R} The three screens are in src/screens/onboarding/ with a pager and the copy from the export.`,
  '  Snapshot tests added.',
  '',
  `${B}>${R} `,
].join('\r\n');

// A small file tree for the infra project, shown in the Files scene.
const planMd = `# Terraform module migration plan

Split the monolithic \`main.tf\` (1,840 lines, 212 resources) into three modules without recreating anything in production.

## Goals

- **network**: VPC, subnets, NAT gateways, route tables, security groups.
- **database**: Aurora cluster, parameter groups, subnet group, secrets.
- **app**: ECS cluster, services, task definitions, load balancer, autoscaling.
- \`terraform plan\` must show **0 to add, 0 to change, 0 to destroy** after every step.

## Steps

1. Create \`modules/network\` and move the 64 network resources, with a \`moved\` block for each address.
2. Run \`terraform plan\` in staging; expect no changes. Commit.
3. Repeat for \`modules/database\` (38 resources). Secrets stay in place; only their addresses move.
4. Repeat for \`modules/app\` (110 resources). Outputs from network and database become module inputs.
5. Delete the emptied sections of \`main.tf\` and keep only the module calls and providers.
6. Apply in staging, then production during the Tuesday window.

## Risks

| Risk | Mitigation |
|------|------------|
| A missed \`moved\` block destroys and recreates a resource | The plan gate in CI fails on any destroy |
| Circular references between app and database | Pass only IDs through outputs |
| State lock held during the production apply | Announce the window; apply from CI only |

## Rollback

Each step is one commit. Reverting the commit restores the previous addresses, and the \`moved\` blocks run in reverse.
`;
const reportHtml = `<!doctype html><html><head><style>
body{font:15px/1.5 -apple-system,Helvetica,Arial,sans-serif;margin:24px;color:#1d2330;background:#fff}
h1{font-size:22px;margin:0 0 4px}p.sub{color:#5b6475;margin:0 0 18px}
.cards{display:flex;gap:12px;margin-bottom:18px}.card{flex:1;border:1px solid #e3e6ec;border-radius:10px;padding:12px 14px}
.card b{display:block;font-size:24px}.ok b{color:#1a8f4a}.warn b{color:#b26a00}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #eceff4}th{color:#5b6475;font-weight:600}
.pill{font-size:12px;padding:2px 8px;border-radius:99px;background:#e8f6ee;color:#1a8f4a}
</style></head><body>
<h1>Plan report: network module</h1><p class="sub">staging · generated by Codex after step 2</p>
<div class="cards"><div class="card ok"><b>64</b>resources moved</div><div class="card ok"><b>0</b>to add / change / destroy</div><div class="card warn"><b>2</b>notes to review</div></div>
<table><tr><th>Resource</th><th>From</th><th>To</th><th></th></tr>
<tr><td>aws_vpc.main</td><td>aws_vpc.main</td><td>module.network.aws_vpc.main</td><td><span class="pill">moved</span></td></tr>
<tr><td>aws_subnet.private[0..2]</td><td>aws_subnet.private</td><td>module.network.aws_subnet.private</td><td><span class="pill">moved</span></td></tr>
<tr><td>aws_nat_gateway.az[0..2]</td><td>aws_nat_gateway.az</td><td>module.network.aws_nat_gateway.az</td><td><span class="pill">moved</span></td></tr>
<tr><td>aws_security_group.app</td><td>aws_security_group.app</td><td>module.network.aws_security_group.app</td><td><span class="pill">moved</span></td></tr>
</table></body></html>`;
export const demoFiles = {
  infra: {
    tree: {
      '': [
        { name: 'docs', relativePath: 'docs', kind: 'directory' },
        { name: 'modules', relativePath: 'modules', kind: 'directory' },
        { name: 'main.tf', relativePath: 'main.tf', kind: 'file' },
        { name: 'README.md', relativePath: 'README.md', kind: 'file' },
      ],
      docs: [
        { name: 'migration-plan.md', relativePath: 'docs/migration-plan.md', kind: 'file' },
        { name: 'plan-report.html', relativePath: 'docs/plan-report.html', kind: 'file' },
      ],
      modules: [
        { name: 'network', relativePath: 'modules/network', kind: 'directory' },
        { name: 'database', relativePath: 'modules/database', kind: 'directory' },
      ],
    },
    files: {
      'docs/migration-plan.md': planMd,
      'docs/plan-report.html': reportHtml,
      'main.tf': 'terraform {\n  required_version = ">= 1.9"\n}\n',
      'README.md': '# infra\n\nTerraform for shop-api.\n',
    },
    review: {
      'docs/migration-plan.md': {
        summary:
          '**בקצרה:** מפצלים את `main.tf` (212 משאבים) לשלושה מודולים: network, database ו‑app, בלי ליצור מחדש שום משאב בייצור.\n\n- כל שלב הוא commit אחד, עם בלוק `moved` לכל כתובת.\n- אחרי כל שלב `terraform plan` חייב להראות 0 שינויים, ו‑CI נכשל על כל destroy.\n- הפעלה ב‑staging ואז בייצור בחלון של יום שלישי. Rollback הוא revert של ה‑commit.',
        translation:
          '# תוכנית המעבר למודולים של Terraform\n\nלפצל את `main.tf` המונוליתי (1,840 שורות, 212 משאבים) לשלושה מודולים בלי ליצור מחדש שום דבר בייצור.\n\n## מטרות\n\n- **network**: VPC, subnets, NAT gateways, טבלאות ניתוב, security groups.\n- **database**: אשכול Aurora, parameter groups, subnet group, סודות.\n- **app**: אשכול ECS, שירותים, task definitions, load balancer, autoscaling.\n- `terraform plan` חייב להראות **0 להוספה, 0 לשינוי, 0 להשמדה** אחרי כל שלב.',
      },
    },
  },
};
