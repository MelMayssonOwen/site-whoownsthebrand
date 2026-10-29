// Pulls newly published TimeToPost AutoSEO posts into this static site.
// Each new post becomes /<slug>/index.html, rendered inside an existing page's
// layout, and is appended to sitemap.xml. Existing folders are never touched.
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.TTP_PUBLIC_TOKEN;
if (!TOKEN) { console.log('TTP_PUBLIC_TOKEN not set; nothing to do.'); process.exit(0); }
const API = (process.env.TTP_API || 'https://api.timetopost.co').replace(/\/$/, '');
const ROOT = process.cwd();
const domain = fs.readFileSync(path.join(ROOT, 'CNAME'), 'utf8').trim();
const SITE = `https://${domain}`;

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// The token must never reach the public site: rewrite TTP hosted URLs to ours.
const hostedPrefix = new RegExp(`https?://(?:www\\.)?timetopost\\.co/hosted/${TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`, 'g');
const scrub = s => String(s ?? '').replace(hostedPrefix, `${SITE}/`).split(TOKEN).join('');

function pickTemplate() {
  if (process.env.TEMPLATE) return fs.readFileSync(path.join(ROOT, process.env.TEMPLATE), 'utf8');
  // Prefer an existing article page (og:type article) as the layout.
  const ok = [];
  for (const d of fs.readdirSync(ROOT).sort()) {
    const f = path.join(ROOT, d, 'index.html');
    if (!d.startsWith('.') && fs.existsSync(f)) {
      const h = fs.readFileSync(f, 'utf8');
      if (/<main[\s>]/i.test(h) && /<\/main>/i.test(h) && /<title>/i.test(h)) ok.push(h);
    }
  }
  const pick = ok.find(h => /og:type"\s+content="article"/i.test(h)) || ok[0];
  if (!pick) throw new Error('No template page with <main> found');
  return pick;
}

async function get(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.replace(TOKEN, '<token>')}`);
  return r.json();
}

function render(tpl, post) {
  const url = `${SITE}/${post.slug}/`;
  const title = scrub(post.title), desc = scrub(post.excerpt || '');
  const body = scrub(post.bodyHtml || '');
  const date = post.publishedAt ? new Date(post.publishedAt) : new Date();
  const ld = {
    '@context': 'https://schema.org', '@type': 'Article', headline: title, description: desc,
    datePublished: date.toISOString(), dateModified: date.toISOString(), mainEntityOfPage: url,
    author: { '@type': 'Organization', name: SITE_NAME, url: `${SITE}/` },
    publisher: { '@type': 'Organization', name: SITE_NAME, url: `${SITE}/` },
    ...(post.coverImageUrl ? { image: scrub(post.coverImageUrl) } : {}),
  };
  const crumb = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
    { '@type': 'ListItem', position: 2, name: title, item: url } ] };
  const jsonLd = s => `<script type="application/ld+json">${JSON.stringify(s).replace(/</g, '\\u003c')}</script>`;
  const h1 = /^\s*<h1[\s>]/i.test(body) ? '' : `<h1>${esc(title)}</h1>\n`;
  const cover = post.coverImageUrl ? `<p><img src="${esc(scrub(post.coverImageUrl))}" alt="${esc(post.coverImageAlt || '')}" loading="lazy" style="max-width:100%;height:auto"></p>\n` : '';
  // Keep the template's own <main ...> tag so the site's CSS applies.
  const mainOpen = (tpl.match(/<main(?:\s[^>]*)?>/i) || ['<main>'])[0];
  const hasWrap = /class="[^"]*\bwrap\b/i.test(mainOpen);
  const inner = `<div class="crumb"><a href="/">Home</a> / ${esc(title)}</div>\n<article>\n${h1}<p class="updated">Published ${date.toISOString().slice(0, 10)}</p>\n${cover}${body}\n</article>`;
  const main = `${mainOpen}\n${hasWrap ? inner : `<div class="wrap">\n${inner}\n</div>`}\n</main>`;
  let h = tpl;
  h = h.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>\s*/gi, '');
  h = h.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
  h = h.replace(/(<meta\s+name="description"\s+content=")[^"]*(")/i, `$1${esc(desc)}$2`);
  h = h.replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/i, `$1${url}$2`);
  h = h.replace(/(<meta\s+property="og:title"\s+content=")[^"]*(")/i, `$1${esc(title)}$2`);
  h = h.replace(/(<meta\s+property="og:description"\s+content=")[^"]*(")/i, `$1${esc(desc)}$2`);
  h = h.replace(/(<meta\s+property="og:url"\s+content=")[^"]*(")/i, `$1${url}$2`);
  h = h.replace(/(<meta\s+name="twitter:title"\s+content=")[^"]*(")/i, `$1${esc(title)}$2`);
  h = h.replace(/(<meta\s+name="twitter:description"\s+content=")[^"]*(")/i, `$1${esc(desc)}$2`);
  if (!/rel="canonical"/i.test(h)) h = h.replace(/<\/head>/i, `<link rel="canonical" href="${url}">\n</head>`);
  h = h.replace(/<\/head>/i, `${jsonLd(crumb)}\n${jsonLd(ld)}\n</head>`);
  h = h.replace(/<main[\s>][\s\S]*<\/main>/i, () => main);
  if (h.includes(TOKEN)) throw new Error('token leaked into rendered page');
  return h;
}

function addToSitemap(slug, date) {
  const f = path.join(ROOT, 'sitemap.xml');
  if (!fs.existsSync(f)) return;
  const loc = `${SITE}/${slug}/`;
  let x = fs.readFileSync(f, 'utf8');
  if (x.includes(`<loc>${loc}</loc>`)) return;
  x = x.replace(/<\/urlset>/, `<url><loc>${loc}</loc><lastmod>${date}</lastmod><changefreq>monthly</changefreq></url>\n</urlset>`);
  fs.writeFileSync(f, x);
}

const tpl = pickTemplate();
const SITE_NAME = process.env.SITE_NAME || (tpl.match(/property="og:site_name"\s+content="([^"]+)"/i) || [])[1] || domain;
const added = [];
for (let offset = 0; ; offset += 50) {
  const list = await get(`${API}/api/autoseo/public/${TOKEN}/posts?limit=50&offset=${offset}`);
  const posts = list.posts || [];
  for (const s of posts) {
    const slug = String(s.slug || '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,150}$/.test(slug)) continue;
    const dir = path.join(ROOT, slug);
    if (fs.existsSync(dir)) continue;
    const { post } = await get(`${API}/api/autoseo/public/${TOKEN}/posts/${encodeURIComponent(slug)}`);
    if (!post?.bodyHtml) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), render(tpl, { ...post, slug }));
    addToSitemap(slug, (post.publishedAt ? new Date(post.publishedAt) : new Date()).toISOString().slice(0, 10));
    added.push(slug);
  }
  if (posts.length < 50) break;
}
console.log(added.length ? `Added: ${added.join(', ')}` : 'No new posts.');
