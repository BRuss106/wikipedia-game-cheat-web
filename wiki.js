// Wikipedia Game cheat: the search engine, running entirely in the browser.
//
// It finds the shortest chain of clickable links between two articles using a
// bidirectional breadth-first search. One search grows forward from the start
// (following links), the other grows backward from the end ("what links here").
// When they touch, the two halves are stitched into a shortest path.
//
// It's a port of the Python version. The differences that matter in a browser:
//   - Requests go straight to Wikipedia with origin=* (CORS), so no server is needed.
//   - Browsers can't set User-Agent, so we send Wikipedia's Api-User-Agent header.
//   - A few requests run in parallel (capped by CONCURRENCY) instead of one by one.
//   - Every search can be stopped with an AbortSignal.

const API_URL = 'https://en.wikipedia.org/w/api.php';
const BATCH_SIZE = 50;    // the API allows up to 50 titles per request
const MAX_ROUNDS = 300;   // how many times we re-search after dropping non-body links
const CONCURRENCY = 3;    // requests in flight at once (stay polite to Wikipedia)
const MIN_GAP_MS = 120;   // fastest pace: time between starting two requests
const MAX_GAP_MS = 1500;  // slowest pace, after Wikipedia has asked us to slow down
const MAX_ATTEMPTS = 8;   // tries per request before giving up

// Wikipedia asks API users to identify themselves.
const API_USER_AGENT = 'WikiGameCheat-Web/1.0 (https://github.com/BRuss106/wikipedia-game-cheat-web)';


// ---------- small helpers ----------

const abortError = () => new DOMException('Search stopped.', 'AbortError');

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  });
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}


// ---------- talking to the API ----------
// A tiny scheduler: at most CONCURRENCY requests at once, started `gap` ms apart.
// When Wikipedia says "slow down" (429), EVERY request pauses and the gap grows;
// it shrinks back slowly while requests succeed.

let active = 0;
let nextStartAt = 0;
let pausedUntil = 0;
let gap = MIN_GAP_MS;
const waiting = [];

function slowDown(seconds) {
  pausedUntil = Math.max(pausedUntil, performance.now() + seconds * 1000);
  gap = Math.min(gap * 2, MAX_GAP_MS);
}

function speedUp() {
  gap = Math.max(MIN_GAP_MS, gap * 0.99);
}

async function acquireSlot(signal) {
  while (active >= CONCURRENCY) {
    await new Promise(resolve => waiting.push(resolve));
    if (signal?.aborted) throw abortError();
  }
  active++;
  const now = performance.now();
  const startAt = Math.max(now, nextStartAt, pausedUntil);
  const wait = startAt - now;
  nextStartAt = startAt + gap;
  if (wait) {
    try { await sleep(wait, signal); } catch (e) { releaseSlot(); throw e; }
  }
}

function releaseSlot() {
  active--;
  const next = waiting.shift();
  if (next) next();
}

/**
 * Ask the API and return the parsed JSON.
 * ctx = { signal, onEvent, requests } is shared by everything in one search.
 * If Wikipedia answers 429 ("too many requests") or a 5xx, wait and try again a few times.
 */
async function apiGet(params, ctx = {}) {
  const query = new URLSearchParams({ ...params, format: 'json', formatversion: '2', origin: '*' });
  const url = `${API_URL}?${query}`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await acquireSlot(ctx.signal);
    let response, data;
    try {
      response = await fetch(url, { headers: { 'Api-User-Agent': API_USER_AGENT }, signal: ctx.signal });
      if (response.ok) data = await response.json();
    } finally {
      releaseSlot();
    }

    if (response.status === 429 || response.status >= 500) {
      const hint = parseInt(response.headers.get('Retry-After') ?? '', 10);
      const wait = Math.min(Math.max(Number.isFinite(hint) ? hint : 2 ** attempt, 1), 30);
      slowDown(wait);   // the next acquireSlot waits out the pause, for every request
      ctx.onEvent?.({ type: 'wait', seconds: wait });
      continue;
    }
    if (!response.ok) throw new Error(`Wikipedia answered HTTP ${response.status}.`);
    if (data?.error) throw new Error(`Wikipedia API error: ${data.error.info || data.error.code}`);

    speedUp();
    ctx.requests = (ctx.requests || 0) + 1;
    ctx.onEvent?.({ type: 'requests', count: ctx.requests });
    return data;
  }
  throw new Error('Wikipedia keeps rate-limiting us (429). Wait a minute and try again.');
}


// ---------- titles ----------

/** Turn 'Albert_Einstein' (as copied from a URL) into 'Albert Einstein'. */
export function cleanTitle(raw) {
  return raw.replace(/_/g, ' ').trim();
}

/** Return the article's official title (following redirects), or null if it doesn't exist. */
export async function resolveTitle(title, ctx = {}) {
  if (!title) return null;
  const data = await apiGet({ action: 'query', titles: title, redirects: 1 }, ctx);
  const page = data.query?.pages?.[0];
  if (!page || page.missing || page.invalid) return null;
  return page.title;
}

/** Map each title to its official name (normalized, redirects followed). */
async function officialTitles(titles, ctx) {
  const result = new Map(titles.map(t => [t, t]));
  for (const chunk of chunks([...new Set(titles)], BATCH_SIZE)) {
    const data = await apiGet({ action: 'query', titles: chunk.join('|'), redirects: 1 }, ctx);
    const renames = new Map();
    for (const e of data.query?.normalized ?? []) renames.set(e.from, e.to);
    for (const e of data.query?.redirects ?? []) renames.set(e.from, e.to);
    for (const t of chunk) {
      let name = renames.get(t) ?? t;
      name = renames.get(name) ?? name;
      result.set(t, name);
    }
  }
  return titles.map(t => result.get(t));
}

/** Up to `limit` article titles that start with `prefix`, for the autocomplete box. */
export async function suggest(prefix, signal) {
  if (!prefix.trim()) return [];
  const data = await apiGet({ action: 'opensearch', search: prefix, limit: 8, namespace: 0 }, { signal });
  return Array.isArray(data) ? data[1] : [];
}


// ---------- main-body links only ----------
// The Wikipedia Game only lets you click links inside the article itself, so links that
// appear only in the trailing sections below (or in citations and navboxes) don't count.

// A heading that EXACTLY matches one of these ends the article body.
const SKIP_SECTIONS = new Set([
  'references', 'notes', 'footnotes', 'citations', 'see also', 'sources', 'works cited',
  'notes and references', 'references and notes', 'explanatory notes', 'cited works',
  'cited sources', 'general references', 'inline citations', 'additional reading',
  'external sources', 'web links', 'weblinks', 'links', 'online resources',
]);
// A heading that CONTAINS one of these also ends the body ("External links and further reading").
const SKIP_SECTION_WORDS = ['external link', 'further reading', 'bibliograph', 'see also', 'footnote'];

// Templates that are citations or navigation, not article prose. Their contents are dropped.
const STRIP_TEMPLATES = [
  'cite', 'citation', 'sfn', 'harv', 'refn', 'reflist', 'refbegin', 'refend',
  'navbox', 'sidebar', 'authority control', 'portal bar', 'succession box',
];

// Link prefixes that are not normal articles ([[File:...]], [[Category:...]], [[fr:...]], ...).
const NAMESPACES = new Set([
  'file', 'image', 'media', 'category', 'template', 'wikipedia', 'wp', 'help', 'portal',
  'talk', 'user', 'user talk', 'special', 'draft', 'module', 'mediawiki', 'book',
  'wikt', 'wiktionary', 'commons', 'wikisource', 'wikiquote', 'wikibooks', 'wikidata',
  'w', 'd', 's', 'q', 'b', 'c', 'mw', 'project', 'topic', 'timedtext',
]);
const LANGUAGE_PREFIX = /^[a-z]{2,3}(-[a-z]+)*$/;

/** Index just after the }} that closes the {{ at `start`, or -1 if unbalanced. */
function templateEnd(text, start) {
  let depth = 0, i = start;
  while (i < text.length) {
    const opener = text.indexOf('{{', i);
    const closer = text.indexOf('}}', i);
    if (closer === -1) return -1;
    if (opener !== -1 && opener < closer) {
      depth++;
      i = opener + 2;
    } else {
      depth--;
      i = closer + 2;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Remove citation and navigation templates (including nested braces). */
function stripTemplates(text) {
  const out = [];
  let i = 0;
  while (true) {
    const j = text.indexOf('{{', i);
    if (j === -1) { out.push(text.slice(i)); break; }
    out.push(text.slice(i, j));
    const end = templateEnd(text, j);
    if (end === -1) { out.push('{{'); i = j + 2; continue; }   // unbalanced: leave the text alone
    const name = text.slice(j + 2, end - 2).split(/[|}\n]/, 1)[0].trim().toLowerCase();
    if (!STRIP_TEMPLATES.some(p => name.startsWith(p))) out.push(text.slice(j, end));   // keep infoboxes etc.
    i = end;
  }
  return out.join('');
}

function isSkippedHeading(heading) {
  const h = heading.replace(/[\[\]']/g, '').trim().toLowerCase();
  return SKIP_SECTIONS.has(h) || SKIP_SECTION_WORDS.some(w => h.includes(w));
}

/** Return the article titles linked from the main body of this article's source text. */
export function extractBodyLinks(wikitext) {
  let text = wikitext
    .replace(/<!--[\s\S]*?-->/g, '')                 // hidden comments
    .replace(/<ref\b[^>]*\/>/gi, '')                 // <ref name=x />
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '');   // <ref>citation</ref>
  text = stripTemplates(text);                       // {{cite web}}, navboxes, ...

  // Cut everything from the first References / External links / See also / ... heading on.
  for (const m of text.matchAll(/^=+\s*(.+?)\s*=+\s*$/gm)) {
    if (isSkippedHeading(m[1])) { text = text.slice(0, m.index); break; }
  }

  const links = [], seen = new Set();
  for (const m of text.matchAll(/\[\[([^\[\]|#\n]+)/g)) {     // the part of [[Target|label]] before | or #
    let title = m[1].replace(/_/g, ' ').replace(/^[: ]+/, '').split(/\s+/).filter(Boolean).join(' ');
    if (!title) continue;
    const colon = title.indexOf(':');
    if (colon !== -1) {
      const prefix = title.slice(0, colon).trim();
      if (NAMESPACES.has(prefix.toLowerCase()) || LANGUAGE_PREFIX.test(prefix)) continue;   // File:, Category:, fr:
    }
    title = title.charAt(0).toUpperCase() + title.slice(1);   // Wikipedia titles start with a capital
    if (!seen.has(title)) { seen.add(title); links.push(title); }
  }
  return links;
}


// ---------- getting neighbors (batched, both directions, cached) ----------

// direction -> (title -> neighbors). Lives as long as the tab, so repeat searches are fast.
const cache = { forward: new Map(), backward: new Map() };

/**
 * For each title, return its neighbors as a Map {title -> [neighbor, ...]}.
 *   forward:  links in this article's MAIN BODY (what you can click).
 *   backward: pages that link to this page anywhere (a superset; see verifyEdge).
 */
async function fetchNeighbors(titles, direction, ctx, onProgress) {
  const store = cache[direction];
  const todo = [...new Set(titles.filter(t => !store.has(t)))];
  const total = titles.length;
  let done = total - todo.length;
  if (onProgress && todo.length) onProgress(done, total);

  await Promise.all(chunks(todo, BATCH_SIZE).map(async chunk => {
    const found = await fetchFromApi(chunk, direction, ctx);
    for (const [t, links] of found) store.set(t, links);
    done += chunk.length;
    onProgress?.(done, total);
  }));

  return new Map(titles.map(t => [t, store.get(t) ?? []]));
}

async function fetchFromApi(titles, direction, ctx) {
  const params = direction === 'forward'
    // Read each article's source text, then pull the main-body links out of it.
    ? { prop: 'revisions', rvprop: 'content', rvslots: 'main' }
    : { prop: 'linkshere', lhlimit: 'max', lhnamespace: 0, lhprop: 'title' };
  Object.assign(params, { action: 'query', titles: titles.join('|'), redirects: 1 });

  const byTitle = new Map();   // official title -> neighbors
  const renames = new Map();   // title we asked about -> official title

  while (true) {
    const data = await apiGet(params, ctx);
    const query = data.query ?? {};
    for (const e of query.normalized ?? []) renames.set(e.from, e.to);
    for (const e of query.redirects ?? []) renames.set(e.from, e.to);

    for (const page of query.pages ?? []) {
      if (direction === 'forward') {
        const content = page.revisions?.[0]?.slots?.main?.content;
        if (content != null) byTitle.set(page.title, extractBodyLinks(content));
        else if (!byTitle.has(page.title)) byTitle.set(page.title, []);
      } else {
        if (!byTitle.has(page.title)) byTitle.set(page.title, []);
        for (const item of page.linkshere ?? []) byTitle.get(page.title).push(item.title);
      }
    }

    if (!data.continue) break;
    Object.assign(params, data.continue);   // more results: ask again from where it left off
  }

  // Map every title we asked about to its neighbors, even if it got renamed.
  const result = new Map();
  for (const t of titles) {
    let official = renames.get(t) ?? t;
    official = renames.get(official) ?? official;
    result.set(t, byTitle.get(official) ?? []);
  }
  return result;
}

/**
 * The backward search only knows "a links to b somewhere on the page"
 * (navigation boxes and references count too). Confirm the link is in a's main body.
 */
async function verifyEdge(a, b, ctx) {
  return (await fetchNeighbors([a], 'forward', ctx)).get(a).includes(b);
}


// ---------- bidirectional breadth-first search ----------

const edgeKey = (a, b) => `${a}\u0000${b}`;

/**
 * Explore one full ring of the search.
 * Returns { next, meetings }: the newly discovered articles, and any of them
 * that the OTHER search had already reached.
 */
async function expandLevel(frontier, myDepth, myParent, otherDepth, direction, ctx, onProgress, banned) {
  const neighbors = await fetchNeighbors(frontier, direction, ctx, onProgress);
  const next = [], meetings = [];

  for (const node of frontier) {
    for (const n of neighbors.get(node)) {
      if (myParent.has(n)) continue;                                           // already discovered
      if (direction === 'backward' && banned.has(edgeKey(n, node))) continue;  // only in a reference
      myParent.set(n, node);
      myDepth.set(n, myDepth.get(node) + 1);
      next.push(n);
      if (otherDepth.has(n)) meetings.push(n);                                 // the searches touched!
    }
  }
  return { next, meetings };
}

/** Stitch the forward and backward halves together at the meeting article. */
function buildPath(meet, fParent, bParent) {
  const firstHalf = [];
  for (let node = meet; node != null; node = fParent.get(node)) firstHalf.push(node);
  firstHalf.reverse();

  const secondHalf = [];
  for (let node = bParent.get(meet); node != null; node = bParent.get(node)) secondHalf.push(node);

  return { path: [...firstHalf, ...secondHalf], meetIndex: firstHalf.length - 1 };
}

/**
 * One bidirectional search. Returns candidate { path, meetIndex } routes that are all
 * tied for shortest, or [] if the two articles aren't connected.
 */
async function search(start, end, ctx, banned) {
  const emit = ctx.onEvent ?? (() => {});
  if (start === end) return [{ path: [start], meetIndex: 0 }];

  const fParent = new Map([[start, null]]), fDepth = new Map([[start, 0]]);
  const bParent = new Map([[end, null]]), bDepth = new Map([[end, 0]]);
  let fFrontier = [start], bFrontier = [end];
  const levels = { forward: 0, backward: 0 };

  while (fFrontier.length && bFrontier.length) {
    // Always grow the smaller ring: fewer API calls.
    const side = fFrontier.length <= bFrontier.length ? 'forward' : 'backward';
    const scanned = side === 'forward' ? fFrontier.length : bFrontier.length;
    emit({ type: 'scan', side, scanned });
    const progress = (done, total) => emit({ type: 'progress', side, done, total });

    let result;
    if (side === 'forward') {
      result = await expandLevel(fFrontier, fDepth, fParent, bDepth, 'forward', ctx, progress, banned);
      fFrontier = result.next;
    } else {
      result = await expandLevel(bFrontier, bDepth, bParent, fDepth, 'backward', ctx, progress, banned);
      bFrontier = result.next;
    }

    levels[side]++;
    emit({
      type: 'level', side, depth: levels[side], scanned,
      found: result.next.length, discovered: fParent.size + bParent.size,
    });

    if (result.meetings.length) {
      // Several articles may have been hit on this ring. Keep the ones with the shortest total.
      const total = n => fDepth.get(n) + bDepth.get(n);
      const best = result.meetings.reduce((m, n) => Math.min(m, total(n)), Infinity);
      const tied = result.meetings.filter(n => total(n) === best);
      emit({ type: 'meeting', title: tied[0] });
      return tied.slice(0, 100).map(n => buildPath(n, fParent, bParent));
    }
  }
  return [];   // one side ran out of articles: no connection
}

/**
 * Return the shortest path from start to end as a list of titles, or null.
 * options = { onEvent(event), signal }   (both optional)
 */
export async function findPath(start, end, options = {}) {
  const ctx = options.ctx ?? { signal: options.signal, onEvent: options.onEvent, requests: 0 };
  const emit = ctx.onEvent ?? (() => {});
  const banned = new Set();   // links the backward search suggested that aren't in the article body

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const candidates = await search(start, end, ctx, banned);
    if (!candidates.length) return null;

    // All candidates are tied for shortest. Read the articles we need to check
    // (batched, 50 per request), then see whether any candidate is fully real.
    const sources = new Set();
    for (const { path, meetIndex } of candidates) path.slice(meetIndex, -1).forEach(a => sources.add(a));
    if (sources.size) await fetchNeighbors([...sources], 'forward', ctx);

    const bad = new Set();
    for (const { path, meetIndex } of candidates) {
      const pathBad = [];
      for (let i = meetIndex; i < path.length - 1; i++) {
        if (!(await verifyEdge(path[i], path[i + 1], ctx))) pathBad.push(edgeKey(path[i], path[i + 1]));
      }
      if (!pathBad.length) return displayPath(path, ctx);
      pathBad.forEach(k => bad.add(k));
    }

    emit({ type: 'retry', count: bad.size });
    bad.forEach(k => banned.add(k));   // never trust those links again, then search again (cheap: cached)
  }
  throw new Error('Gave up: too many suggested links turned out to be reference-only. Try a different pair of articles.');
}

/** Show official titles (a link to "USA" is shown as "United States"). Falls back to the raw path. */
async function displayPath(path, ctx) {
  try { return await officialTitles(path, ctx); }
  catch (e) { if (e.name === 'AbortError') throw e; return path; }
}
