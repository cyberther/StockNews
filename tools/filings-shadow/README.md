# Filings observation release observe-v5-20261023-1

Only observes. Does not load/call an LLM, modify LM Studio threads, or call any database RPC.
The main extraction captures an eligible downloaded PDF, its existing first-eight-page text,
and its production outcome; observer errors are caught and do not replace filings_save data.
Historical audit and validation replay origins are explicitly distinguished from pending filings.

Runtime: outputs/filings-shadow/runtime (dedicated venv, dependencies pinned in requirements.lock).
A separate user systemd timer checks for idle time. One document per run, 30-second child limit,
45-second service limit, 768 MiB service memory limit, low CPU/IO priority, no Internet sockets.
The worker uses native PDF geometry and captured OCR text only. It does not run additional OCR,
page discovery beyond page eight, or AGA LLM selection. AGA output remains an unexecuted draft.

State: /home/yoda/Documents/Codex/2026-10-22/inst/outputs/filings-shadow
config.json enabled=false stops capturing and processing. Retained reports/status are local only.
Maximum 50 pending jobs, capture quota ~200 MiB, max age 14 days; older completed records may be
removed earlier under space pressure. Pending sources are never removed to reclaim space.
This is bounded observation, not guaranteed observation of every document. Quota skips are counted.

Inspect: node tools/filings-shadow-report.mjs
Stop: systemctl --user disable --now market-pulse-filings-shadow.timer
Also set enabled=false in config.json for immediate capture opt-out.
Do not turn on automatic promotion without a separate reviewed release and migration plan.
