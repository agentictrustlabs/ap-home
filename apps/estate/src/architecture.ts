// THE ESTATE'S ARCHITECTURE POSTS. Public, static, written here: `/architecture` lists them, `/architecture/<slug>` is one.
// A post is prose and a picture about how this estate works. It reads no heartbeat and needs no sign-in, so these pages load
// no script. Everything is authored in this file (no value from a request reaches markup); pictures are static assets under
// `assets/architecture/`.
//
// To add a post: add its picture to `assets/architecture/`, add an entry to POSTS (newest first), and give it a body.
import { shell } from './html.js';

export interface Post {
  slug: string;
  title: string;
  /** ISO date, shown as written. */
  date: string;
  /** One or two sentences: the listing, the page's standfirst and its link preview. */
  description: string;
  picture: { svg: string; png: string; alt: string; width: number; height: number };
  body: string;
}

const HARNESS_ALT =
  'A flow diagram. An ask goes from the asker through Admit, Playbook, Ground, Judge, Plan and Check the plan. Then, for every step, ' +
  'Authority, Execute and Receipt, and the Answer returns to the asker. Skills enter from the top: a SKILL.md is published to the skills ' +
  'registry, compiled with the domain ontology into an archetype, and assigned to the agent as its playbook. The judge reads each ' +
  "skill's card. The skill's body is read by its pinned digest when the step runs.";

const HARNESS_BODY = `
<h2>The path of an ask</h2>
<p>An ask is one sentence from a person to an agent. Every agent in this estate, a person's own or an organization's, answers it through the same harness, in this order.</p>
<ol class="steps">
<li><b>Admit.</b> Who is asking is settled first: a person signed in at their Home, an app holding a wire that person signed, or another agent sending an A2A message.</li>
<li><b>Playbook.</b> The agent's playbook is the archetype its custodian assigned. The harness recomputes the playbook's digest, and if it does not match, the agent runs with no playbook, never with a changed one.</li>
<li><b>Ground.</b> Before any model sees the request, code reads it against the domain's own terms: which things it names, and how the asker stands to the agent (themselves, a steward, a member, a stranger). A common request, such as a balance or a list of members, matches a known shape and is planned here with no model at all.</li>
<li><b>Judge.</b> One call to a small model asks one question: which one of the offered skills should handle this, or none of them? It answers with probabilities and nothing else. A rule in code accepts the top skill only above a floor and with a clear lead over the next.</li>
<li><b>Plan.</b> The plan is built around the chosen skill: that skill alone, or together with the skill that produces what it needs. If no skill fits, a planner model plans over the agent's other tools, with the skills taken out of its reach.</li>
<li><b>Check the plan.</b> Fixed rules, no model. A number the person never said, a party they never named, or a step that depends on nothing is caught here. The plan is refused, the person is asked, or the planner gets one more try.</li>
<li><b>Authority, for every step.</b> Each step that acts needs a mandate the person signed. Without one, the run stops and says exactly what it needs. The person signs at their Home and the same run resumes.</li>
<li><b>Execute.</b> The harness first checks that this exact act has not already happened, then runs it once. A step can be a skill, an act (a payment, a message, an invitation), a connector, or a question to another agent.</li>
<li><b>Receipt.</b> Every step leaves a receipt: the skill and its version, the mandate it ran under, and what was observed. The run's record and its provenance go to the agent's own vault.</li>
<li><b>Answer.</b> A skill's answer is given as the skill wrote it. Any other answer is composed from the steps' results and checked against them.</li>
</ol>

<h2>Where skills come in</h2>
<p>A skill is a document, a <code>SKILL.md</code>: what it does, when to use it, and how. It reaches an agent in four moves, the pink path in the picture.</p>
<ul>
<li><b>Published.</b> The author publishes the skill to the skills registry, which records a commitment to its exact content.</li>
<li><b>Described.</b> The domain's ontology says what each skill covers, what it produces and what it consumes. That is how one skill is told from its neighbour, and how a plan knows which skill feeds another.</li>
<li><b>Compiled.</b> An archetype gathers a set of skills into one definition, a tool for each skill, under one digest.</li>
<li><b>Assigned.</b> The agent's custodian assigns that archetype to the agent. From then on it is the agent's playbook.</li>
</ul>
<p>The harness uses a skill twice, and reads a different part each time.</p>
<ul>
<li><b>To choose.</b> The judge sees only each skill's card: one line of purpose, what it produces, and what it is not for.</li>
<li><b>To answer.</b> The skill's full body is read only when its step runs, by the digest the playbook pinned. If the registry's copy has moved since, the step is refused, never run under different words.</li>
</ul>

<h2>Three rules that hold it together</h2>
<ul>
<li><b>Intelligence may be probabilistic. Authority must not be.</b> The planner proposes, the mandate authorizes, the executor acts, the receipt proves.</li>
<li><b>The ontology proposes, a judge decides, a declared rule accepts.</b> Choosing a skill never permits anything. The chosen step still meets every gate after it.</li>
<li><b>An archetype changes what an agent knows how to do, never what it may do.</b></li>
</ul>`;

export const POSTS: Post[] = [
  {
    slug: 'agent-harness',
    title: 'How an ask runs at an agent',
    date: '2026-11-05',
    description:
      'The path one sentence takes through the agent harness, from the person who asked to the receipt that proves what was done, and where skills enter it.',
    picture: { svg: '/architecture/agent-harness-flow.svg', png: '/architecture/agent-harness-flow.png', alt: HARNESS_ALT, width: 1920, height: 1040 },
    body: HARNESS_BODY,
  },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso: string): string => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m! - 1]} ${y}`; };
const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export interface ArchitectureInput { name: string; origin: string }

export function architectureIndex(p: ArchitectureInput): string {
  const cards = POSTS.map((post) => `<article class="post-card">
<a class="thumb" href="/architecture/${post.slug}"><img src="${post.picture.svg}" alt="" width="${post.picture.width}" height="${post.picture.height}" loading="lazy"></a>
<h2><a href="/architecture/${post.slug}">${post.title}</a></h2>
<p class="quiet"><time datetime="${post.date}">${longDate(post.date)}</time></p>
<p>${post.description}</p>
<p><a href="/architecture/${post.slug}">Read the post →</a></p>
</article>`).join('\n');
  return shell({
    name: p.name, current: 'architecture', title: `Architecture · ${p.name}`,
    description: `How ${p.name} works: the agent harness, skills, authority and records, in pictures.`,
    canonical: `${p.origin}/architecture`,
    main: `<h1>Architecture</h1>\n<p class="quiet">How this estate works, in pictures.</p>\n${cards}`,
  });
}

export function architecturePost(p: ArchitectureInput, slug: string): string | null {
  const post = POSTS.find((x) => x.slug === slug);
  if (!post) return null;
  const pic = post.picture;
  return shell({
    name: p.name, current: 'architecture', title: `${post.title} · ${p.name}`, description: post.description,
    canonical: `${p.origin}/architecture/${post.slug}`, image: `${p.origin}${pic.png}`, article: true,
    main: `<article class="post">
<p class="quiet"><a href="/architecture">Architecture</a> · <time datetime="${post.date}">${longDate(post.date)}</time></p>
<h1>${post.title}</h1>
<p class="lede">${post.description}</p>
<figure class="picture">
<div class="scroll"><img src="${pic.svg}" alt="${attr(pic.alt)}" width="${pic.width}" height="${pic.height}"></div>
<figcaption>Grey arrows are the ask. Pink arrows are a skill on its way in. Dashed arrows happen only when needed. <a href="${pic.svg}">Open the picture</a> · <a href="${pic.png}">PNG</a></figcaption>
</figure>
${post.body}
</article>`,
  });
}
