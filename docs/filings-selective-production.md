# Selective filing extraction

The local summary job can resolve dividend and financial-result values directly from validated PDF source facts. It falls back to the existing LLM extraction for other issuers, conflicts, incomplete pages, parser failures and disabled rollout settings. AGM extraction remains on the existing LLM flow; the shadow observer records separate candidates without changing saved values.

The worker uses the first eight pages. The dedicated Python dependencies are pinned in `tools/filings-shadow/requirements.lock`. The running installation keeps its virtual environment, rollout configuration, captured documents and rollback snapshots outside the repository, under the workspace `outputs/` directory referenced by the tools. Never commit those captures, user documents, credentials or runtime state.

`tools/filings-selective.mjs` reads `outputs/filings-selective/config.json` from the configured workspace. `enabled` is the kill switch. `issuers.dividend` and `issuers.results` are explicit allowlists. `multiYear` and `typedRevenue` additionally require `consumerSha256` to match both the published homepage and canonical document page. Compatibility checks are cached for up to 60 seconds per extractor instance; failures retain the legacy path. To change the frontend deliberately, validate and deploy it first, then update the expected SHA-256 in the local configuration.

Public filing JSON keeps the original scalar fields. Dividends add `fiscal_years`; `fiscal_year` is null for multiple years. Financial results add `revenue_metric`, `revenue_prev_metric` and `metric_records`. The web consumer preserves explicit year lists, labels revenue metrics and suppresses growth comparisons across different explicit revenue types. No SQL migration is needed for the existing JSONB column.

The historical-audit wrapper still intercepts save calls locally. Do not use an audit run as authorization to replace historical database records. Deterministic production saves identify their extraction version separately from the LLM model name.

Validation:

```sh
npm test
PYTHONDONTWRITEBYTECODE=1 /path/to/ocr-runtime/bin/python -m unittest discover -s test -p 'test_filings*shadow.py'
CF_PAGES=1 npm run build
```

The build requires the existing public Supabase and VAPID settings for the hosted application. Keep Cloudflare dashboard environment settings; do not introduce a Wrangler configuration that overwrites them. Local processing retains four LLM threads normally and three when a graphical remote session is detected. The shadow timer yields while the summary service is running.

Deploy `main` to production and `staging` to preview through the existing Cloudflare Pages project. Preserve staging-specific environment values, authentication redirect URLs and domain bindings even when both branches point to identical source commits. Check public configuration and the new consumer on both domains after deployment; custom-domain caches may require targeted invalidation.
