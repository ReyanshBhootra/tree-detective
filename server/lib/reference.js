// Finds one real, freely licensed photo of a place on Wikimedia Commons.
// One request per search (search + image details together) so Wikimedia
// doesn't rate limit us, and only JPEG photos, never logos or maps.
const UA = { 'User-Agent': 'TreeDetective/1.0 (https://github.com/ReyanshBhootra/tree-detective)' };
const strip = (html) => String(html ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url, fetchImpl = fetch, tries = 3) {
  for (let i = 0; ; i++) {
    const res = await fetchImpl(url, { headers: UA });
    if (res.status === 429 && i < tries - 1) {
      await wait((Number(res.headers.get?.('retry-after')) || 5 * (i + 1)) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    return res.json();
  }
}

const BAD = /logo|seal|\bmap\b|diagram|floor ?plan|svg|icon|flag/i;

// Turns a Commons API "pages" object into usable photos, best first.
export function photosFrom(pages, keywords = []) {
  const kw = keywords.map((k) => k.toLowerCase());
  return Object.values(pages ?? {})
    .map((p) => ({ title: p.title ?? '', index: p.index ?? 99, info: p.imageinfo?.[0] }))
    .filter((p) => p.info && p.info.mime === 'image/jpeg' && !BAD.test(p.title))
    .map((p) => {
      const meta = p.info.extmetadata ?? {};
      // Match on the title, the description and the Commons categories, so
      // "Central High School 1.jpg" only counts if it says Newark somewhere.
      const text = [p.title, strip(meta.ImageDescription?.value), strip(meta.Categories?.value)].join(' ').toLowerCase();
      const matches = kw.filter((k) => text.includes(k)).length;
      return {
        title: p.title,
        matches,
        score: matches * 100 - p.index,
        url: p.info.thumburl ?? p.info.url,
        page: p.info.descriptionurl,
        author: strip(meta.Artist?.value) || 'Unknown author',
        license: strip(meta.LicenseShortName?.value) || 'see source',
      };
    })
    .sort((a, b) => b.score - a.score);
}

export async function searchCommons(query, keywords, fetchImpl = fetch) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search' +
    `&gsrnamespace=6&gsrlimit=15&gsrsearch=${encodeURIComponent(query)}` +
    '&prop=imageinfo&iiprop=url|extmetadata|mime&iiurlwidth=1280';
  const json = await getJson(url, fetchImpl);
  return photosFrom(json.query?.pages, keywords);
}

// Tries each search in order and returns the first good photo, plus what it tried.
export async function findPhoto({ searches = [], keywords = [] }, fetchImpl = fetch, pause = 1500) {
  const tried = [];
  for (const q of searches) {
    const found = await searchCommons(q, keywords, fetchImpl);
    tried.push(`"${q}": ${found.length} photos`);
    const best = keywords.length ? found.find((f) => f.matches > 0) : found[0];
    if (best) return { photo: best, tried };
    await wait(pause);
  }
  return { photo: null, tried };
}
