#!/usr/bin/env node
// uk-tenders: search UK public sector contract notices on Contracts Finder (official OCDS API) by CPV code,
// keywords, region, value and SME suitability; optionally only notices not seen on the previous run.
// No dependencies, Node 18+. Built by datakit457 (https://github.com/datakit457/uk-tenders-feed).
// Usage: node uk-tenders.mjs [--cpv 72,48000000] [--keywords "software,cloud"] [--region london] [--min-value 50000]
//          [--sme] [--stage tender|planning|award] [--days 7] [--max 100] [--new] [--state .uk-tenders-seen.json] [--format csv|jsonl]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const API = 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search';

const argv = process.argv.slice(2), opt = { format: 'csv', state: '.uk-tenders-seen.json' }, input = {};
const map = { '--cpv': 'cpvCodes', '--keywords': 'keywords', '--region': 'region', '--min-value': 'minValue', '--stage': 'stage', '--days': 'daysBack', '--max': 'maxResults' };
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

for (const c of cpvs) if (!/^\d{2,8}$/.test(c.replace(/-\d$/, ''))) fail(`Invalid CPV "${c}": use 2-8 digits, e.g. 72 or 72000000`);
if (!['tender', 'planning', 'award'].includes(stage)) fail(`Invalid stage "${stage}"`);
const prefixes = cpvs.map((c) => c.replace(/-\d$/, '').replace(/0+$/, '') || c);

const from = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
let url = `${API}?publishedFrom=${from}&limit=100&stages=${stage}`;
log.info(`Contracts Finder: ${url}`);

async function fetchJson(u) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(u, { headers: { Accept: 'application/json', 'user-agent': 'uk-tenders-cli/1.0 (+https://github.com/datakit457/uk-tenders-feed)' } });
    if (res.ok) return res.json();
    const text = (await res.text()).slice(0, 300);
    if (res.status === 429 && attempt < 5) {
      // The API allows ~30 requests per 5 minutes; wait as it asks.
      const secs = Math.min(parseInt(/after (\d+) seconds/.exec(text)?.[1] ?? res.headers.get('retry-after') ?? '300', 10) || 300, 310);
      log.warning(`Rate limited by Contracts Finder, waiting ${secs}s`);
      await new Promise((r) => setTimeout(r, secs * 1000));
      continue;
    }
    if (res.status >= 500 && attempt < 4) { await new Promise((r) => setTimeout(r, 3000 * attempt)); continue; }
    throw new Error(`Contracts Finder API ${res.status}: ${text}`);
  }
}

const stateFile = opt.state.replace(/\.json$/, '') + `-${stage}.json`;
const seen = new Set(mode === 'newOnly' && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : []);
const rows = [];

const dec = (s) => (s == null ? s : String(s).replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
const day = (s) => (s ? String(s).slice(0, 10) : null);
let scanned = 0; let emitted = 0; let pages = 0;
while (url && emitted < maxResults && pages < 200) {
  const data = await fetchJson(url); pages++;
  const batch = [];
  for (const r of data.releases ?? []) {
    scanned++;
    const t = r.tender ?? {};
    const cpv = t.classification?.id ?? null;
    if (prefixes.length && !(cpv && prefixes.some((p) => cpv.startsWith(p)))) continue;
    const text = `${t.title ?? ''} ${t.description ?? ''}`.toLowerCase();
    if (kws.length && !kws.some((k) => text.includes(k))) continue;
    const regions = [...new Set((t.items ?? []).flatMap((i) => (i.deliveryAddresses ?? []).map((a) => a.region).filter(Boolean)))];
    if (region && !regions.some((x) => x.toLowerCase().includes(region))) continue;
    const award = (r.awards ?? [])[0];
    const value = t.value?.amount ?? award?.value?.amount ?? null;
    if (minValue != null && !(value != null && value >= minValue)) continue;
    if (smeOnly && !t.suitability?.sme) continue;
    if (mode === 'newOnly' && seen.has(r.id)) continue;
    seen.add(r.id);
    const buyer = (r.parties ?? []).find((p) => (p.roles ?? []).includes('buyer'));
    const noticeUrl = (t.documents ?? []).concat(award?.documents ?? []).find((d) => d.url)?.url
      ?? `https://www.contractsfinder.service.gov.uk/Notice/${String(r.id).slice(0, 36)}`;
    batch.push({
      noticeId: r.id,
      ocid: r.ocid,
      stage,
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
      suitableForSme: t.suitability?.sme ?? null,
      suitableForVcse: t.suitability?.vcse ?? null,
      contractStart: day(t.contractPeriod?.startDate),
      contractEnd: day(t.contractPeriod?.endDate),
      awardedTo: (award?.suppliers ?? []).map((s) => s.name),
      url: noticeUrl,
    });
    if (emitted + batch.length >= maxResults) break;
  }
  rows.push(...batch);
  emitted += batch.length;
  url = data.links?.next ?? null;
}

if (mode === 'newOnly') writeFileSync(stateFile, JSON.stringify([...seen].slice(-50000)));
log.info(`Scanned ${scanned} notices, output ${emitted} (${mode}).`);
if (opt.format === 'jsonl') { for (const r of rows) console.log(JSON.stringify(r)); }
else {
  const cols = ['noticeId', 'publishedDate', 'deadline', 'title', 'buyerName', 'cpv', 'cpvDescription', 'value', 'currency', 'regions', 'suitableForSme', 'procurementMethod', 'awardedTo', 'url'];
  const q = (v) => { const t = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  console.log(cols.join(','));
  for (const r of rows) console.log(cols.map((c) => q(r[c])).join(','));
}
