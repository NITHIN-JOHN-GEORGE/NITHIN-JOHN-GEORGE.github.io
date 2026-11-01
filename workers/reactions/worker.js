// Reactions for blog posts on nithinjohngeorge.com: no sign-in, one reaction per emoji per visitor.
// Runs as a Cloudflare Worker with one KV namespace bound as REACTIONS and a secret SALT.
//
//   GET  /reactions?post=<slug>                 -> {"clap": 42, "love": 17, ...}
//   POST /reactions  {"post": "<slug>", "emoji": "clap"}  -> the updated counts
//
// Privacy: visitors' IP addresses are never stored. Each reaction stores only a salted hash
// of (IP, post, emoji), kept for 30 days, so the same visitor can't add the same emoji twice.

const EMOJIS = ['clap', 'love', 'idea', 'mindblown', 'fire', 'bookmark'];
const ORIGINS = ['https://nithinjohngeorge.com', 'https://www.nithinjohngeorge.com', 'http://localhost:8080'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (url.pathname !== '/reactions') return json({ error: 'not found' }, 404);

    if (request.method === 'GET') {
      const post = url.searchParams.get('post') || '';
      if (!SLUG.test(post)) return json({ error: 'bad post' }, 400);
      return json(await counts(env, post));
    }

    if (request.method === 'POST') {
      if (!ORIGINS.includes(origin)) return json({ error: 'forbidden' }, 403);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad body' }, 400); }
      const { post, emoji } = body || {};
      if (!SLUG.test(post || '') || !EMOJIS.includes(emoji)) return json({ error: 'bad reaction' }, 400);

      const ip = request.headers.get('CF-Connecting-IP') || '';
      const seenKey = `seen:${await sha256(`${env.SALT}|${ip}|${post}|${emoji}`)}`;
      const current = await counts(env, post);
      if (await env.REACTIONS.get(seenKey)) return json(current); // already reacted: no change

      current[emoji] += 1;
      await env.REACTIONS.put(`count:${post}`, JSON.stringify(current));
      await env.REACTIONS.put(seenKey, '1', { expirationTtl: 60 * 60 * 24 * 30 });
      return json(current);
    }

    return json({ error: 'method not allowed' }, 405);
  },
};

async function counts(env, post) {
  const stored = JSON.parse((await env.REACTIONS.get(`count:${post}`)) || '{}');
  return Object.fromEntries(EMOJIS.map((e) => [e, Number(stored[e]) || 0]));
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
