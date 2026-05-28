# Impact Portal — Lexicon (source of truth for member-facing language)

The member is a faith / missional-community member, not a developer. Lead with the
**activity** and its **value**; keep the mechanism (passkey, smart account, registry,
delegation, chain) quiet. This lexicon is the canonical vocabulary — use it consistently
across onboarding, receipts, the home, nav, and consent. All of it is white-label config
(`src/whitelabel/`), never in packages (ADR-0021).

## The anchor

**Your home** — your own place in the missional community. Not "an account": a place you
*own*, that *only you can open*, and **from which you oversee, manage, and protect
everything you're entrusted with**. (The site, the on-chain account, and the identity are
all "your home" — one thing.)

## The three onboarding activities (member's voice)

> **Secure** a home with your name → **register** it so the missional community can find you
> → **give apps permission** to your resources.

| # | Activity (the member does) | Mechanism (quiet) | Receipt |
|---|---|---|---|
| ① | **Secure your home** — so only you can open it | passkey (your device) + the home is founded, locked to it | "✓ Your home is secured — only you can open it" |
| ② | **Register your name** — so the missional community can find you | claim the name in the community registry (rides with ①) | "✓ You're registered as *{name}* — the missional community can find you" |
| ③ | **Give {app} permission** — to your resources, on your terms | scoped, revocable delegation | "✓ Permission granted — {app} can do only what you allowed" |

## Term map (use these words; avoid the "avoid" column)

| Concept | Use | Means | Avoid |
|---|---|---|---|
| The account / site / identity | **your home** | the place you own + manage from | Portal, Smart Agent, wallet, account |
| The device biometric | **your passkey** (your device) | *how you secure and open* your home | "secure key", "credential" as a standalone milestone |
| Founding the home on-chain | **secure / found your home** | bring your home into being, yours alone | deploy, mint |
| The name (`x.demo.agent`) | **your name** (show just `x`) | your findable handle in the community | the `.demo.agent` suffix as a headline |
| Listing the name | **register** | so the missional community + apps find you | "claim", "set primary name" |
| The community + its apps | **the missional community** / **missional community apps** | the people + tools you steward with | "the platform", raw host names |
| Granting a delegation | **give {app} permission to your resources** | a scoped, revocable grant | "issue a delegation", "authorize a delegate" |
| The on-chain proof (`0x…`, network) | **Secured ✓** (address on the *You* page) | proof it's really yours; tamper-proof | raw `0x…` / "Base Sepolia" as a headline |

## The home is a stewardship hub

Your home is where you keep watch over everything you're entrusted with. The *"help"*
matters — you don't own these alone; you **help steward** them with the community.

- **Organizations** you help **oversee**
- **Treasuries** you help **manage**
- **Data sources** you help **protect**
- **Apps** you've **given permission**
- **Sign-in** — how you keep your home secure

Nav grouping: **You** · **What you steward** (Organizations / Treasuries / Data sources) ·
**Your home** (Connected apps / Security / Activity).

## Tone

Warm, direct, unhurried — a trusted guide in a community you already belong to. Stewardship
language (oversee, manage, protect, entrusted, steward) is welcome. Crypto/security jargon
is a tooltip or a "view details", never a headline.
