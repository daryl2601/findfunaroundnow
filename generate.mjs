// Picks trending stories from RSS feeds, writes original articles with Gemini (free tier),
// adds a Pixabay photo (Openverse fallback) + optional YouTube video, saves content/posts/<slug>.json
import fs from "node:fs";
import path from "node:path";

const env = process.env;
const GEMINI_API_KEY = (env.GEMINI_API_KEY || "").trim();
const PIXABAY_API_KEY = (env.PIXABAY_API_KEY || "").trim();
const YOUTUBE_API_KEY = (env.YOUTUBE_API_KEY || "").trim();
const PER_RUN = Number(env.POSTS_PER_RUN) || 6;
const GAP_MS = env.GAP_MS !== undefined ? Number(env.GAP_MS) : 6000; // pause between posts (free-tier rate limit)
const MODELS = [...new Set([(env.GEMINI_MODEL || "").trim(), "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"].filter(Boolean))];
const dir = "content/posts";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; findfunaround-bot/1.0)" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!GEMINI_API_KEY) { console.error("ERROR: GEMINI_API_KEY secret is missing or empty. Add it in GitHub > Settings > Secrets and variables > Actions."); process.exit(1); }
const sources = JSON.parse(fs.readFileSync("sources.json", "utf8"));

const decode = (s = "") => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#8217;|&#39;|&apos;/g, "'").replace(/&#?\w+;/g, " ").replace(/\s+/g, " ").trim();
const tag = (x, t) => (x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")) || [])[1] || "";
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "post";

async function readFeed(url) {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const xml = await r.text();
    const items = [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)].slice(0, 12).map(m => ({
      title: decode(tag(m[0], "title")), url: decode(tag(m[0], "link")),
      summary: decode(tag(m[0], "description")).slice(0, 600),
    })).filter(i => i.title && i.url.startsWith("http"));
    console.log(`Feed OK (${items.length} items): ${url}`);
    return items;
  } catch (e) { console.log(`Feed FAILED: ${url} -> ${e.message}`); return []; }
}
async function readPage(url) {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
    const html = await r.text();
    const ps = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => decode(m[1])).filter(t => t.length > 60);
    return ps.join("\n").slice(0, 5000);
  } catch { return ""; }
}

async function gemini(prompt) {
  let lastErr = "";
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let r, j;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.7 } }),
          signal: AbortSignal.timeout(90000),
        });
        j = await r.json();
      } catch (e) { lastErr = `${model}: ${e.message}`; await sleep(3000); continue; }
      if (r.ok) {
        const parts = j?.candidates?.[0]?.content?.parts || [];
        const text = parts.filter(p => !p.thought).map(p => p.text || "").join("").trim();
        if (text) return text;
        lastErr = `${model}: empty reply (${j?.candidates?.[0]?.finishReason || j?.promptFeedback?.blockReason || "unknown"})`;
        break;
      }
      lastErr = `${model}: HTTP ${r.status} ${j?.error?.message || ""}`.trim();
      if (r.status === 429 || r.status >= 500) { await sleep(attempt * 15000); continue; }
      break; // 400/403/404 -> try the next model name
    }
    if (/API key|PERMISSION_DENIED|HTTP 40[13]/i.test(lastErr)) break; // key problem: other models won't help
  }
  throw new Error("Gemini failed -> " + lastErr);
}

function parseArticle(text) {
  let a;
  const clean = text.replace(/```json|```/g, "").trim();
  try { a = JSON.parse(clean); } catch { a = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)); }
  if (Array.isArray(a.body)) a.body = a.body.join("\n\n");
  if (typeof a.title !== "string" || typeof a.body !== "string" || a.body.length < 300) throw new Error("article too short or malformed");
  a.excerpt = String(a.excerpt || a.body.slice(0, 140)).slice(0, 220);
  return a;
}
async function writeArticle(story, research) {
  const prompt = `You are a writer for a fun, friendly news blog called "Find Fun Around".
Write an ORIGINAL article of 450-700 words about the story below, in your own words. Never copy sentences.
Use ONLY facts found in the source material. Do not invent quotes, numbers or names. If details are thin, stay general.
Mention the source publication by name inside the article. Use a clear headline, a conversational tone, and 2-3 "## " subheadings.
Return ONLY JSON: {"title": string, "excerpt": string (max 30 words), "body": string (paragraphs separated by blank lines, subheadings start with "## "), "image_query": string (2-4 words describing a generic photo that fits), "video_query": string or ""}
SOURCE HEADLINE: ${story.title}
SOURCE SUMMARY: ${story.summary}
SOURCE TEXT: ${research}`;
  return parseArticle(await gemini(prompt));
}

async function save(url, slug) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("download failed " + r.status);
  fs.mkdirSync("content/images", { recursive: true });
  fs.writeFileSync(`content/images/${slug}.jpg`, Buffer.from(await r.arrayBuffer()));
  return `/images/${slug}.jpg`;
}
async function photo(q, slug) {
  if (!q) return null;
  if (PIXABAY_API_KEY) {
    try {
      const j = await (await fetch(`https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${encodeURIComponent(q)}&image_type=photo&orientation=horizontal&safesearch=true&per_page=5`)).json();
      const p = j.hits?.[0];
      if (p) return { url: await save(p.largeImageURL, slug), alt: q, credit: p.user, creditUrl: p.pageURL, source: "Pixabay" };
    } catch (e) { console.log("Pixabay failed:", e.message); }
  }
  try {
    const j = await (await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license_type=commercial&mature=false&page_size=5`, { headers: UA })).json();
    const p = j.results?.find(x => x.thumbnail);
    if (p) return { url: await save(p.thumbnail, slug), alt: p.title || q, credit: `${p.creator || "Unknown"} (CC ${String(p.license).toUpperCase()})`, creditUrl: p.foreign_landing_url, source: "Openverse" };
  } catch (e) { console.log("Openverse failed:", e.message); }
  return null;
}
async function video(q) {
  if (!YOUTUBE_API_KEY || !q) return null;
  try {
    const j = await (await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=1&q=${encodeURIComponent(q)}&key=${YOUTUBE_API_KEY}`)).json();
    const v = j.items?.[0]; return v ? { id: v.id.videoId, title: v.snippet.title } : null;
  } catch { return null; }
}

// ---------- main ----------
fs.mkdirSync(dir, { recursive: true });
const seen = new Set();
for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
  try { seen.add(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).sources?.[0]?.url); } catch {}
}
console.log(`Models to try: ${MODELS.join(", ")} | Posts wanted: ${PER_RUN} | Pixabay key: ${PIXABAY_API_KEY ? "yes" : "no"}`);

const queues = {};
for (const cat of Object.keys(sources)) {
  const items = (await Promise.all(sources[cat].map(readFeed))).flat().filter(i => !seen.has(i.url));
  queues[cat] = items.sort(() => Math.random() - 0.5).slice(0, 8);
}
const cats = Object.keys(queues).sort(() => Math.random() - 0.5);
let made = 0, failures = 0, fatal = false;
const errors = [];

for (let round = 0; round < 4 && made < PER_RUN && !fatal; round++) {
  for (const cat of cats) {
    if (made >= PER_RUN || fatal) break;
    const story = queues[cat].shift();
    if (!story) continue;
    try {
      const research = await readPage(story.url);
      const a = await writeArticle(story, research);
      let slug = slugify(a.title);
      if (fs.existsSync(path.join(dir, `${slug}.json`))) slug += "-" + Date.now().toString(36);
      const [image, vid] = await Promise.all([photo(a.image_query, slug), video(a.video_query)]);
      const post = { title: a.title, slug, date: new Date().toISOString(), category: cat, excerpt: a.excerpt, body: a.body, image, video: vid,
        sources: [{ title: story.title, url: story.url }] };
      fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(post, null, 2));
      seen.add(story.url); made++;
      console.log(`CREATED (${made}/${PER_RUN}) [${cat}]: ${a.title}`);
      if (made < PER_RUN) await sleep(GAP_MS);
    } catch (e) {
      failures++; errors.push(e.message);
      console.log(`SKIPPED [${cat}] ${story.title.slice(0, 60)} -> ${e.message}`);
      if (/API key|PERMISSION_DENIED|HTTP 40[13]/i.test(e.message)) fatal = true;
    }
  }
}
console.log(`Done. Created ${made} post(s), ${failures} failure(s).`);
if (made === 0) {
  console.error("ERROR: no posts were created. First error: " + (errors[0] || "no stories found (all feeds failed?)"));
  process.exit(1);
}
