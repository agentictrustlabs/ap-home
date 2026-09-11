---
title: Your Home agent inside Claude
subtitle: A guide to the Home MCP connector — what it is, how to set it up, and what you can ask
---

# Your Home agent, inside Claude

You already have an agent of your own at your Home (on Faithnet, that is **www.faithnet.me**). It knows your
records, the organizations you belong to, and the way you like things done. The **Home MCP connector** lets you
reach that agent from inside Claude — in a normal Claude conversation, on the web or in the desktop app — so
Claude can ask it things *as you*, find and talk to other agents *through* it, and show you what it did.

Three things stay true the whole time:

1. **Claude never holds your keys or your sign-in.** You give the connector one narrow permission — "ask my agent as
   me" — by signing it at your Home. That is all it holds.
2. **Anything that would *change* something waits for you.** Sending money, inviting someone, publishing — your
   agent pauses and gives you a link to your Home, where you sign. Claude cannot sign for you.
3. **Every answer is your agent's answer, with its evidence.** Claude reports it and says where it came from. Every
   run leaves a record you can read later, in Claude or at your Home.

---

## 1. Before you start

- **A Home account** at www.faithnet.me with a passkey (or wallet) that you can use in your browser. If you can sign
  in there, you are ready.
- **A Claude plan that allows custom connectors** (Claude Pro, Max, Team or Enterprise). On Team and Enterprise
  plans an administrator may need to add the connector for the organization first.
- The connector address:

  ```
  https://home-mcp-faithnet.richardpedersen3.workers.dev/mcp
  ```

---

## 2. Set up (about two minutes)

1. In Claude, open **Settings → Connectors**.
2. Choose **Add custom connector**.
3. Give it a name you will recognize — for example **My Home agent** — and paste the connector address above.
4. Click **Add**, then **Connect**.
5. Your browser opens **www.faithnet.me**. Sign in the way you always do (passkey or wallet).
6. Your Home shows what you are about to allow: *let this assistant ask your agent as you*. Read it, then approve.
   This writes a signed permission for this connector only. It does not let it move money, change records or act
   for you — those still need your signature each time.
7. You are sent back to Claude. The connector shows as connected.
8. In a new chat, open the tools menu (the **+** or **Search and tools** control under the message box) and make sure
   **My Home agent** is switched on.

**Check it works.** Type:

> What have I asked my agent for recently?

Claude should come back with your recent runs (or say there are none yet) and name your agent — something like
*alice.me* — as the one that answered.

**Claude Desktop** works the same way: the connector you add on the web is available in the desktop app once you sign
in to the same Claude account.

---

## 3. What Claude can do through the connector

Claude gets a small, fixed set of abilities. In plain words:

| Ability | What it does | Changes anything? |
| --- | --- | --- |
| **Ask** | Puts your words to your own agent — about your records, your organizations, your household, your treasury — or to an organization you belong to, by name (for example *missio-nexus.org*). | Reads answer at once. Acts pause for your signature. |
| **Find agents** | Searches the public registry, through your agent, for agents that do what you want — a ministry with a study on a topic, a service that offers a capability. | No |
| **Inspect an agent** | Looks at one agent's public card before you talk to it: who it says it is, what it offers, whether the card it serves still matches its records. | No |
| **Engage an agent** | Sends your words, as you, to another agent and brings back *its* answer — a study plan, what it offers, an answer from its own records. Your agent sends the message and keeps the record; the other agent sees only your message. | No (the other agent decides what to do with its own things) |
| **My runs** | Lists what you have asked your agent recently — from Claude, from your Home, from anywhere — and which runs are waiting on you. | No |
| **Run details** | One run in full: what you asked, the plan, each step's outcome, the receipts (with the transaction when a step left one), and where its provenance record is. | No |
| **Where to sign** | For a run that paused for your authority: the link to the page at your Home where you sign, and nothing else. | No — you do, at your Home |

There is deliberately **no** payment tool, no "read the vault" tool and no "grant permission" tool. What your agent
can do is whatever its playbook says it can do; Claude only sees the door.

---

## 4. Things to try

Type these as you would say them. Claude decides which ability to use; you do not have to name it.

### Your own records and organizations

> Which organizations do I belong to, and what is my role in each?

> Ask Missio Nexus's agent who its members are.

> What does my household record say? Who is in it?

> What is the balance of my treasury?

Your agent answers from your records (or the organization's) and tells Claude which records it read. Nothing here
needs a signature.

### Finding and talking to other agents

> Find agents that offer study plans about justification.

Claude asks your agent to search the registry. You get a short list — name, what each offers, how relevant it is.

> Before we contact Ligonier, check who ligonier.svc says it is.

Claude fetches the agent's public card through your agent and tells you whether it still matches its records.

> Ask Ligonier for a four-week study plan on justification, one session a week, with links.

Your agent sends your words to Ligonier's agent *as you*. The reply is Ligonier's own — made from its own catalog
under its own rules — and Claude presents it as such, keeping every link it gave. Your agent records that the hop
happened.

> Ask Missio Nexus's agent to find a Somali-language discipleship resource for our team.

You can ask *at* an organization you belong to; the organization's agent answers under your standing there.

### Things that need your signature

> Send 20 USDC to Alice from my treasury.

> Invite Nathan to Missio Nexus.

> Charter a team called Outreach under Missio Nexus.

Your agent prepares the act and stops: Claude will tell you it needs your authority and give you a link to your
Home. Open it, review what will happen (who, how much, to whom, until when), and sign. Then say:

> Done — finish that run.

Claude picks the run back up and your agent completes it under the permission you just signed. The receipt names
your signature; Claude never had it.

### Looking back

> What did my agent do for me this week?

> Show me the details and receipts for the payment run.

> Which of my runs are still waiting on me?

### Teaching your agent how you like things

> From now on, when I ask about my treasury, always show amounts in USD too.

That becomes a standing instruction of *your agent's* — not Claude's — so it applies at your Home and everywhere
else too, and you can remove it at your Home whenever you like.

---

## 5. What the replies mean

Your agent answers in a few well-defined ways. Claude will explain them, but here is the key:

| You see | It means | What to do |
| --- | --- | --- |
| **An answer** | A read: your agent looked at the records and told you what they say, and which ones it read. | Nothing. |
| **Done** | An act finished, under a permission you signed. There is a receipt. | Ask for the details if you like. |
| **A question** | Your agent needs a detail — which Alice, which account. | Answer in the chat; Claude passes it on. |
| **Authority required** | The act needs your signature. | Follow the link to your Home, sign, then tell Claude to finish the run. |
| **Refused** | Your agent will not do it — you do not have standing for it, it is outside your agent's playbook, or the request was ambiguous. The reason is stated. | Rephrase, or ask at your Home. A refusal is your agent protecting you; Claude cannot argue it out of one. |
| **Please reconnect** | The permission this connector held was revoked or has expired. | Reconnect from Settings → Connectors; you will sign in at your Home again. |

Two things you will never see: a reply that pretends to be Claude's own knowledge (it is always your agent's, with
its source), and an act that happened without a signature of yours behind it.

---

## 6. Staying in control

- **See what is connected.** At your Home, open **Connected apps → Connected assistants**. Each entry is a
  permission you signed; this connector is one of them.
- **Revoke at any time.** Click **Revoke** there. The permission is disabled on chain immediately. Claude's next
  request is refused and Claude asks you to reconnect. Nothing that already happened is undone — receipts stay.
- **Nothing is hidden in Claude.** Every run made through Claude appears in your Home's **Activities** exactly like a
  run you made there, marked as having come through this connector.
- **Other people's things stay theirs.** Your agent holds your records. Another person's household, another
  organization's roster — your agent will tell you *whose* agent holds that, not read it for you.
- **Up to 25 connectors.** You can connect several assistants or devices; each gets its own permission and can be
  revoked on its own.

---

## 7. If something does not work

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Connect button opens your Home but you cannot sign in | No passkey on this browser or device | Sign in at www.faithnet.me directly first, add a passkey for this device under **Security**, then connect again. |
| Claude says the connector needs to reconnect | You revoked it, or the permission expired | Settings → Connectors → your connector → **Connect**. |
| "No agent is registered as …" | The organization name is not its registry name | Use the name as it appears at your Home (for example *missio-nexus.org*), or ask "which organizations do I belong to" first. |
| An act is stuck "waiting" | You have not signed yet | Ask Claude for the link ("where do I sign for that run?"), sign at your Home, then "finish that run". |
| "Refused — no standing" | You are not a member or steward of that organization | Ask your own agent instead, or ask the organization's steward to invite you. |
| Too many requests | Rate limit | Wait a minute and try again. |

---

## 8. Questions people ask

**Does Claude see my private records?** Claude sees what your agent *replies* — the answer to your question — not
your vault. Your agent decides what a reply may contain, the same as it would at your Home.

**Can Claude spend my money or invite people without me?** No. Those acts pause at your agent until you sign at your
Home with your own credential. The connector's permission is "ask as me", not "act as me".

**What if someone gets into my Claude account?** They could ask your agent questions as you. They could not sign
anything. Revoke the connector at your Home (**Connected apps → Connected assistants**) and it stops at once.

**Is this the same as Claude's own memory?** No. Standing instructions and remembered choices live with *your agent*
and apply everywhere you use it. You manage them at your Home.

**Where is the record of what happened?** On your agent. Ask Claude for a run's details, or open **Activities** at
your Home. Each run has a provenance record — a formal, checkable account of what was read, what was done and under
which permission — that anyone you share it with can verify independently.

---

*Home MCP · Faithnet deployment · connector address `https://home-mcp-faithnet.richardpedersen3.workers.dev/mcp` ·
your Home: www.faithnet.me · September 2026*
