# UK Tenders Feed: new Find a Tender and Contracts Finder tenders by CPV, keyword and region (free CLI)

Get new **UK public sector tenders** from the government's two official portals, **Find a Tender** (higher-value contracts, all of the UK) and **Contracts Finder** (England, lower-value), merged into one CSV or JSON-lines feed. Filter by **CPV code, keyword, delivery region, minimum value and SME suitability**. Run it daily with `--new` and you get only the notices you have not seen before: a tender alert you can pipe into Slack, email, Google Sheets or your CRM.

`uk-tenders.mjs` is one file with no dependencies (Node 18+). Data comes from the official Find a Tender and Contracts Finder OCDS APIs (Open Government Licence v3). No login, no API key, no page scraping. Buyer contact details are not output.

## Who it's for
- **Small suppliers and agencies** bidding for UK public contracts who want a daily alert instead of checking the portal.
- **Bid writers and consultants** tracking open tenders, pipeline (planning) notices and who won what.
- **Market researchers** who want a CSV of UK public spend by sector and region.

## Quick start
```bash
curl -O https://raw.githubusercontent.com/datakit457/uk-tenders-feed/main/uk-tenders.mjs
node uk-tenders.mjs --cpv 72 --days 7 > it-tenders.csv           # IT services tenders from the last week
node uk-tenders.mjs --keywords "cyber,cloud" --region london --sme
node uk-tenders.mjs --stage award --cpv 45 --min-value 100000 --format jsonl   # who won construction contracts
```

## Options
| Option | Example | Notes |
|---|---|---|
| `--cpv` | `72,48` | CPV prefixes, 2-8 digits. 72 = IT services, 45 = construction, 71 = engineering, 79 = business services. |
| `--keywords` | `"cyber,cloud"` | Words in title or description; any match. |
| `--stage` | `tender` | `tender` = open to bid (default), `planning` = pipeline, `award` = who won. |
| `--region` | `scotland` | Delivery region, e.g. London, South West, Wales, Scotland, Northern Ireland (substring match; Find a Tender NUTS codes are converted to region names). |
| `--source` | `both` | `both` (default), `fts` (Find a Tender only) or `cf` (Contracts Finder only). |
| `--min-value`, `--sme` | `50000` | Value floor in GBP; SME-suitable notices only. |
| `--days`, `--max` | `7`, `100` | Window 1-60 days; cap on rows. |
| `--new`, `--state` | `--new` | Only notices not seen on a previous run; seen ids kept in `.uk-tenders-seen-<stage>.json`. |
| `--format` | `jsonl` | `csv` (default) or `jsonl` (all fields, incl. description, contract dates, awarded suppliers). |

## Example row (CSV)
```
noticeId,source,publishedDate,deadline,title,buyerName,cpv,cpvDescription,value,currency,regions,suitableForSme,procurementMethod,awardedTo,url
108199-2026,Find a Tender,2026-11-13,2026-12-15,Glasgow Business Growth Framework - Phase 4,Glasgow City Council,79400000,Business and management consultancy and related services,3800000,GBP,Scotland,,Open procedure,,https://www.find-tender.service.gov.uk/Notice/108199-2026
```

## Daily tender alert
```cron
0 7 * * * cd ~/tenders && node uk-tenders.mjs --cpv 72 --region london --new > today.csv
```
The first run outputs everything in the window and saves the seen ids; later runs output only new notices.

## FAQ
**Is the data free to reuse?** Yes, Open Government Licence v3.

**What is covered?** Both official UK portals. Since the Procurement Act 2023 took effect in February 2025, most tenders above the procurement thresholds are published on Find a Tender (about 50 new tender notices per working day in November 2026), while Contracts Finder carries lower-value English notices (tens per week). Use `--source` to pick one. For EU-wide tenders see [ted-tenders-feed](https://github.com/datakit457/ted-tenders-feed).

**Why can a large window take minutes?** Contracts Finder allows about 30 requests per 5 minutes and Find a Tender returns every notice type (awards, updates) which the script filters locally; it waits when throttled instead of failing.

**Is there a hosted version?** A hosted Apify Actor version is planned; until then this CLI is the way to run it. More tools: [datakit457.github.io](https://datakit457.github.io/).

Built by datakit457 (I wrote this tool). MIT licence.
