// Draws the sign-in flow picture for /architecture/sign-in. The SVG in assets/architecture/ is this script's output:
//   node scripts/sign-in-flow.mjs assets/architecture/sign-in-flow.svg
// The PNG beside it (the link preview) is that SVG rendered at 2x in a browser.
// The numbered tiles are the steps the page lists beside the picture; their centres are repeated in src/architecture.ts (`at`).
// The row is the first sign-in, every step. The three arcs above it are the other ways in, each skipping what it does not need.
import { C, I, picture } from './picture-kit.mjs';
const W = 1460, H = 1020, ROW = 520, S = 64;
const { out, esc, tile, arrow, note, head, finish } = picture(W, H);
const SSO = '#34d399', BACK = '#60a5fa', PROPOSED = '#fbbf24';

// ── frame and titles
out.push(`<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>`);
out.push(`<text x="40" y="52" class="h">How sign-in works at a faithnet Home</text>`);
out.push(`<text x="40" y="78" class="s" text-anchor="start">One front door for every app. The Home proves who you are. A delegation you sign says what the app may do.</text>`);

// ── main row positions: the first sign-in, every step
const X = { app: 72, ask: 191, check: 309, rec: 428, prove: 547, home: 666, allow: 784, sign: 903, verify: 1022, record: 1140, token: 1259, back: 1378 };
const h = S / 2 + 8, TOP = ROW - h, IN = ROW - h - 4;
const hop = (a, b) => arrow(`M${X[a] + h} ${ROW}H${X[b] - h - 4}`);
const t = (x, y, color, icon, name, sub, o = {}) => tile(x, y, color, icon, name, sub, { size: S, ...o });

// what only a person with no Home session passes through
out.push(`<rect x="${X.prove - 66}" y="${ROW - 86}" width="${X.home - X.prove + 132}" height="196" rx="20" fill="none" stroke="${C.dash}" stroke-width="2" stroke-dasharray="7 7"/>`);
out.push(`<text x="${X.prove - 50}" y="${ROW - 62}" text-anchor="start" class="b">WITHOUT A SESSION</text>`);

for (const [a, b] of [['app', 'ask'], ['ask', 'check'], ['check', 'rec'], ['rec', 'prove'], ['prove', 'home'], ['home', 'allow'], ['allow', 'sign'], ['sign', 'verify'], ['verify', 'record'], ['record', 'token'], ['token', 'back']]) hop(a, b);
t(X.app, ROW, '#64748b', 'app', 'App', ['site or agent']);
t(X.ask, ROW, '#8b5cf6', 'door', 'Ask', ['a PKCE request'], { n: 1 });
t(X.check, ROW, '#3b82f6', 'search', 'Check', ['is it registered'], { n: 2 });
t(X.rec, ROW, '#14b8a6', 'target', 'Recognize', ['a session?'], { n: 3 });
t(X.prove, ROW, '#ef4444', 'key', 'Prove', ['your credential'], { n: 4 });
t(X.home, ROW, '#f59e0b', 'home', 'Make a Home', ['first time only'], { n: 5 });
t(X.allow, ROW, '#eab308', 'check', 'Allow', ['consent sheet'], { n: 6 });
t(X.sign, ROW, '#22c55e', 'pen', 'Sign', ['a delegation'], { n: 7 });
t(X.verify, ROW, '#0ea5e9', 'seal', 'Verify', ['on chain'], { n: 8 });
t(X.record, ROW, '#6366f1', 'receipt', 'Record', ['row and code'], { n: 9 });
t(X.token, ROW, '#3b82f6', 'id', 'Token', ['the id_token'], { n: 10 });
t(X.back, ROW, '#64748b', 'app', 'App', ['signed in']);

// ── the other ways in (above the row): each arc skips what that visit does not need
const arc = (x1, x2, y, o) => arrow(`M${x1} ${TOP}V${y + 16}Q${x1} ${y} ${x1 + 16} ${y}H${x2 - 16}Q${x2} ${y} ${x2} ${y + 16}V${IN}`, o);
const said = (x, y, title, lines, color, anchor = 'middle') => {
  out.push(`<text x="${x}" y="${y}" text-anchor="${anchor}" class="b" style="fill:${color}">${esc(title)}</text>`);
  note(x, y + 18, lines, { anchor, color });
};
// coming back to an app: straight to the token endpoint, no page
arc(X.app, X.token, 130, { color: BACK });
said((X.app + X.token) / 2, 152, 'COMING BACK TO AN APP', ['the app presents the delegation it holds, and the Home answers with a fresh id_token: no page and no prompt'], BACK);
// proposed: allowed before, so no sheet and nothing signed
arc(X.rec - 14, X.verify, 236, { color: PROPOSED, dash: true });
said((X.rec + X.verify) / 2, 258, 'PROPOSED, NOT BUILT', ['this app was allowed before and asks for nothing more:', 'no sheet, and the delegation stored at the last Allow is checked on chain again'], PROPOSED);
// a new app, already signed in: the session stands in for the credential
arc(X.rec + 14, X.allow, 356, { color: SSO });
said(X.rec + 32, 378, 'A NEW APP, ALREADY SIGNED IN', ['the Home session is found:', 'no credential, no new account'], SSO, 'start');

// what happens today, said where the eye lands first
out.push(`<text x="104" y="262" text-anchor="start" class="b">TODAY</text>`);
note(104, 282, ['Every trip to the Home ends at the', 'Allow sheet. The Home does not', 'look up whether you allowed', 'this app before.'], { anchor: 'start' });

// ── below the row: what each step reads and leaves
const LOW = ROW + 198, D = ROW + 94;
const store = (x, color, icon, name, sub, o = {}) => {
  t(x, LOW, color, icon, name, sub, { outline: true, size: 56 });
  arrow(`M${x} ${D + 22}V${LOW - 36}`, { dash: true, both: o.both });
};
store(X.check, '#3b82f6', 'books', 'Registry', ['who may ask'], { both: true });
store(X.rec, '#14b8a6', 'cookie', 'Home session', ['a token, one hour'], { both: true });
store(X.sign, '#22c55e', 'link', 'The chain', ['approved, then checked']);
arrow(`M${X.sign + 36} ${LOW}H${X.verify - 16}Q${X.verify} ${LOW} ${X.verify} ${LOW - 16}V${D}`, { dash: true });
store(X.record, '#6366f1', 'stack', 'Home records', ['a row for each Allow,', 'not read at sign-in']);
store(X.back, '#64748b', 'vault', 'The app keeps', ['id_token, delegation']);

// prove → what a credential can be
const TY = ROW + 380, G = 104, creds = [[X.prove - 1.5 * G, 'person', 'Social'], [X.prove - 0.5 * G, 'mail', 'Email or phone'], [X.prove + 0.5 * G, 'finger', 'Passkey'], [X.prove + 1.5 * G, 'wallet', 'Wallet']];
out.push(`<path d="M${X.prove} ${D}V${TY - 62}" fill="none" stroke="${C.line}" stroke-width="2"/>`);
out.push(`<path d="M${X.prove - 1.5 * G} ${TY - 34}V${TY - 46}Q${X.prove - 1.5 * G} ${TY - 62} ${X.prove - 1.5 * G + 16} ${TY - 62}H${X.prove + 1.5 * G - 16}Q${X.prove + 1.5 * G} ${TY - 62} ${X.prove + 1.5 * G} ${TY - 46}V${TY - 34}M${X.prove - 0.5 * G} ${TY - 62}V${TY - 34}M${X.prove + 0.5 * G} ${TY - 62}V${TY - 34}" fill="none" stroke="${C.line}" stroke-width="2"/>`);
for (const [x, icon, name] of creds) {
  out.push(`<rect x="${x - 24}" y="${TY - 30}" width="48" height="48" rx="13" fill="${C.panel}" stroke="#ef4444" stroke-width="2"/>`);
  out.push(`<g transform="translate(${x - 12},${TY - 18})" fill="none" stroke="#ef4444" stroke-width="1.700" stroke-linecap="round" stroke-linejoin="round">${I[icon]}</g>`);
  out.push(`<text x="${x}" y="${TY + 40}" text-anchor="middle" class="t">${esc(name)}</text>`);
}
note(X.prove, TY + 62, ['what proves it is you', 'Social, email and phone sign at the Home. A passkey or a wallet signs on your device.'], {});

// ── legend: one line for each way in
const LX = 860, LY = 858;
const key = (i, color, dash, text) => out.push(`<path d="M${LX} ${LY + i * 26}h44" stroke="${color}" stroke-width="2"${dash ? ' stroke-dasharray="6 6"' : ''} marker-end="url(#${head(color)})"/><text x="${LX + 58}" y="${LY + i * 26 + 4}" class="s" text-anchor="start">${esc(text)}</text>`);
key(0, C.line, false, 'first time in: every step');
key(1, SSO, false, 'a new app, already signed in: skips 4 and 5');
key(2, BACK, false, 'coming back to an app: step 10 alone, or no trip at all');
key(3, PROPOSED, true, 'proposed, not built: would skip 6 and 7');
key(4, C.line, true, 'only when needed');
out.push(`<text x="${W - 40}" y="${H - 26}" class="s" text-anchor="end">faithnet.estate/architecture</text>`);

finish(process.argv[2],
  'How sign-in works at a faithnet Home: the first time, a new app while signed in, and coming back',
  'An app asks the Home to sign a person in. The Home checks the app against its registry and looks for a Home session. Without one the person proves a credential and, the first time, a Home is made for them. Then the Allow sheet, a delegation signed by the person, its check on chain, a record and a single-use code, and the code exchanged for an id_token. A new app for a person already signed in skips the credential and the new account. An app that still holds its delegation goes straight to the token step. A proposed path, not built, would skip the sheet and the signature for an app allowed before.');
