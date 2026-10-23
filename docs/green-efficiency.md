# Green Notes — production efficiency

Applied to the Cloudflare Pages build and document consumers after the October 2026 audit.

- Modern media: lossless full-resolution WebP globe; 64/128 px lossless logo variants with PNG fallback. Original assets remain for compatibility. [GSF: modern formats](https://patterns.greensoftware.foundation/development/media-and-code-efficiency/serve-images-in-modern-formats/). Extra stored variants trade a small amount of storage for less transfer.
- Single published template: preserve exact raw template in inert JSON, parse it once, skip the editor HTML refetch. Script addresses use content-derived versions so returning browsers cannot combine an old boot runtime with the new template. Build-only runtime transformation is guarded; source/editor behavior remains available. [GSF: reduce transmitted data](https://patterns.greensoftware.foundation/development/data-handling/reduce-transmitted-data/).
- Load policy/impact modules when the authenticated Policy screen opens; omit demo datasets and the optional local admin request from the hosted build. The first Policy visit pays a deferred module load.
- Respect inactive users, hidden tabs and market sessions before chart polling; retain the existing short polling interval during active market use.
- Pause decorative animation offscreen/hidden; honor reduced motion and release detached smooth-scroll instances. [GSF: minimize main thread work](https://patterns.greensoftware.foundation/development/web-performance/minimize-main-thread-work/).
- Skip unchanged persistent state on chart hover; force a final pagehide flush.
- Paginate document metadata (60 initially, 120 on demand); project typed financial fields without large evidence blobs and keyset-page the entire financial history. Raw evidence remains in storage and available through a separate detail method; original PDF links remain visible. No schema, RLS or retention changes.
- Load a lightweight analysis index, then the full body for the selected analysis. The first detail visit adds one request.
- Check deployed consumer compatibility using HEAD plus a build-bound SHA256 header, only for supported issuers. Missing/mismatched headers fail safely to the existing extractor. CDN cache coherence is required before enabling a new consumer hash.

These changes target the energy term E of SCI by reducing network, parsing and unnecessary execution. No measured energy or carbon reduction is claimed. CPU policy stays 4 LLM threads normally / 3 during graphical remote access; OCR remains unchanged. Live prices, financial evidence and security controls are preserved.

Validation: Node regression suite, production-template browser smoke checks, and public cold/warm desktop/mobile network measurements. Authenticated data loading has deterministic mocked tests; no real user account or financial records are modified by these checks. Build transforms deliberately fail if generated runtime anchors change.
