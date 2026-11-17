#!/usr/bin/env node
// uk-tenders: search UK public sector contract notices on Find a Tender and Contracts Finder (official OCDS APIs) by CPV code,
// keywords, region, value and SME suitability; optionally only notices not seen on the previous run.
// No dependencies, Node 18+. Built by datakit457 (https://github.com/datakit457/uk-tenders-feed).
// Usage: node uk-tenders.mjs [--cpv 72,48000000] [--keywords "software,cloud"] [--region london] [--min-value 50000]
//          [--sme] [--stage tender|planning|award] [--source both|fts|cf] [--days 7] [--max 100] [--new] [--state .uk-tenders-seen.json] [--format csv|jsonl]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const API = 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search';

const argv = process.argv.slice(2), opt = { format: 'csv', state: '.uk-tenders-seen.json' }, input = {};
const map = { '--cpv': 'cpvCodes', '--keywords': 'keywords', '--region': 'region', '--min-value': 'minValue', '--stage': 'stage', '--days': 'daysBack', '--max': 'maxResults', '--source': 'source' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--new') input.mode = 'newOnly';
  else if (a === '--sme') input.smeOnly = true;
  else if (map[a] && i + 1 < argv.length) input[map[a]] = argv[++i];
  else if ((a === '--state' || a === '--format') && i + 1 < argv.length) opt[a.slice(2)] = argv[++i];
  else { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 7).join('\n')); process.exit(a === '-h' || a === '--help' ? 0 : 2); }
}
const log = { info: (m) => console.error(m), warning: (m) => console.error('WARN ' + m) };
const fail = (m) => { console.error(m); process.exit(2); };
const list = (a) => (Array.isArray(a) ? a : String(a ?? '').split(/[,\s]+/)).map((s) => String(s).trim()).filter(Boolean);
const cpvs = list(input.cpvCodes);
const kws = list(input.keywords).map((k) => k.toLowerCase());
const stage = input.stage ?? 'tender';
const region = String(input.region ?? '').trim().toLowerCase();
const minValue = input.minValue != null && input.minValue !== '' ? Number(input.minValue) : null;
const smeOnly = !!input.smeOnly;
const daysBack = Math.min(Math.max(parseInt(input.daysBack ?? 7, 10) || 7, 1), 60);
const maxResults = Math.min(Math.max(parseInt(input.maxResults ?? 100, 10) || 100, 1), 5000);
const mode = input.mode === 'newOnly' ? 'newOnly' : 'all';
const source = input.source ?? 'both';

for (const c of cpvs) if (!/^\d{2,8}$/.test(c.replace(/-\d$/, ''))) fail(`Invalid CPV "${c}": use 2-8 digits, e.g. 72 or 72000000`);
if (!['tender', 'planning', 'award'].includes(stage)) fail(`Invalid stage "${stage}"`);
if (!['both', 'fts', 'cf'].includes(source)) fail(`Invalid source "${source}": use both, fts (Find a Tender) or cf (Contracts Finder)`);
const prefixes = cpvs.map((c) => c.replace(/-\d$/, '').replace(/0+$/, '') || c);

const from = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
const FTS = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const NUTS = { UKC: 'North East', UKD: 'North West', UKE: 'Yorkshire and the Humber', UKF: 'East Midlands', UKG: 'West Midlands', UKH: 'East of England', UKI: 'London', UKJ: 'South East', UKK: 'South West', UKL: 'Wales', UKM: 'Scotland', UKN: 'Northern Ireland' };
const regionName = (x) => (/^UK[C-N]/.test(x) ? NUTS[x.slice(0, 3)] : x);

async function fetchJson(u) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(u, { signal: AbortSignal.timeout(40000), headers: { Accept: 'application/json', 'user-agent': 'uk-tenders-cli/1.0 (+https://github.com/datakit457/uk-tenders-feed)' } });
    if (res.ok) return res.json();
    const text = (await res.text()).slice(0, 300);
    if (res.status === 429 && attempt < 5) {
      // The API allows ~30 requests per 5 minutes; wait as it asks.
      const secs = Math.min(parseInt(/after (\d+) seconds/.exec(text)?.[1] ?? res.headers.get('retry-after') ?? '300', 10) || 300, 310);
      log.warning(`Rate limited by ${new URL(u).host}, waiting ${secs}s`);
      await new Promise((r) => setTimeout(r, secs * 1000));
      continue;
    }
    if (res.status >= 500 && attempt < 4) { await new Promise((r) => setTimeout(r, 3000 * attempt)); continue; }
    throw new Error(`${new URL(u).host} API ${res.status}: ${text}`);
  }
}

const stateFile = opt.state.replace(/\.json$/, '') + `-${stage}.json`;
const seen = new Set(mode === 'newOnly' && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : []);
const rows = [];

const dec = (s) => (s == null ? s : String(s).replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
const day = (s) => (s ? String(s).slice(0, 10) : null);
let scanned = 0; let emitted = 0; let pages = 0;
const toRow = (r, src) => {
  const t = r.tender ?? {};
  const itemCpvs = (t.items ?? []).flatMap((i) => (i.additionalClassifications ?? []).map((c) => c.id));
  const cpv = t.classification?.id ?? itemCpvs[0] ?? null;
  const allCpv = [cpv, ...itemCpvs].filter(Boolean);
  if (prefixes.length && !allCpv.some((c) => prefixes.some((p) => c.startsWith(p)))) return null;
  const text = `${t.title ?? ''} ${t.description ?? ''}`.toLowerCase();
  if (kws.length && !kws.some((k) => text.includes(k))) return null;
  const regions = [...new Set((t.items ?? []).flatMap((i) => (i.deliveryAddresses ?? []).map((x) => x.region).filter(Boolean)).map(regionName).filter(Boolean))];
  if (region && !regions.some((x) => x.toLowerCase().includes(region))) return null;
  const award = (r.awards ?? [])[0];
  const value = t.value?.amount ?? award?.value?.amount ?? null;
  if (minValue != null && !(value != null && value >= minValue)) return null;
  const sme = t.suitability?.sme ?? ((t.lots ?? []).some((l) => l.suitability?.sme) || null);
  if (smeOnly && !sme) return null;
  const buyer = (r.parties ?? []).find((x) => (x.roles ?? []).includes('buyer'));
  const url = src === 'fts' ? `https://www.find-tender.service.gov.uk/Notice/${r.id}`
    : (t.documents ?? []).concat(award?.documents ?? []).find((d) => d.url)?.url ?? `https://www.contractsfinder.service.gov.uk/Notice/${String(r.id).slice(0, 36)}`;
  return {
    noticeId: r.id, ocid: r.ocid, source: src === 'fts' ? 'Find a Tender' : 'Contracts Finder', stage,
    title: dec(t.title) ?? null,
    description: t.description ? dec(t.description).slice(0, 2000) : null,
    publishedDate: day(r.date),
    deadline: day(t.tenderPeriod?.endDate),
    buyerName: buyer?.name ?? r.buyer?.name ?? null,
    buyerLocality: buyer?.address?.locality ?? null,
    cpv,
    cpvDescription: t.classification?.description ?? null,
    category: t.mainProcurementCategory ?? null,
    procurementMethod: t.procurementMethodDetails ?? t.procurementMethod ?? null,
    value,
    currency: t.value?.currency ?? award?.value?.currency ?? null,
    regions,
    suitableForSme: sme,
    suitableForVcse: t.suitability?.vcse ?? null,
    contractStart: day(t.contractPeriod?.startDate),
    contractEnd: day(t.contractPeriod?.endDate),
    awardedTo: (award?.suppliers ?? []).map((x) => x.name),
    url,
  };
};
const take = (r, src) => {
  scanned++;
  if (emitted >= maxResults || seen.has(r.id)) return;
  const row = toRow(r, src);
  if (!row) return;
  seen.add(r.id); rows.push(row); emitted++;
};
const sources = source === 'both' ? ['fts', 'cf'] : [source];
for (const src of sources) {
  // Contracts Finder filters by stage server-side; Find a Tender returns every release type, so filter on the OCDS tag.
  let url = src === 'cf' ? `${API}?publishedFrom=${from}&limit=100&stages=${stage}` : `${FTS}?updatedFrom=${from}T00:00:00&limit=100`;
  log.info(`${src === 'cf' ? 'Contracts Finder' : 'Find a Tender'}: ${url}`);
  let n = 0;
  while (url && emitted < maxResults && n < 200) {
    let data;
    try { data = await fetchJson(url); } catch (e) {
      if (source === 'both') { log.warning(`${src} unreachable (${e.message}); skipping it`); break; }
      throw e;
    }
    pages++; n++;
    for (const r of data.releases ?? []) {
      if (src === 'fts' && !(r.tag ?? []).includes(stage)) continue;
      take(r, src);
    }
    url = data.links?.next ?? null;
    if (url && src === 'fts') await new Promise((res) => setTimeout(res, 300));
  }
}

if (mode === 'newOnly') writeFileSync(stateFile, JSON.stringify([...seen].slice(-50000)));
log.info(`Scanned ${scanned} notices, output ${emitted} (${mode}).`);
if (opt.format === 'jsonl') { for (const r of rows) console.log(JSON.stringify(r)); }
else {
  const cols = ['noticeId', 'source', 'publishedDate', 'deadline', 'title', 'buyerName', 'cpv', 'cpvDescription', 'value', 'currency', 'regions', 'suitableForSme', 'procurementMethod', 'awardedTo', 'url'];
  const q = (v) => { const t = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  console.log(cols.join(','));
  for (const r of rows) console.log(cols.map((c) => q(r[c])).join(','));
}
