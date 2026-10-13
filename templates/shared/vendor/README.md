# Vendored libraries

Loaded by the web and mobile templates (and packed into the export bundles), so the apps
need no CDN or build step. Source maps were stripped.

| File | Package | Licence |
|---|---|---|
| `gsap.min.js` | [gsap](https://gsap.com) 3.15.0, `dist/gsap.min.js` | GSAP Standard "no charge" licence (https://gsap.com/standard-license) |
| `lenis.min.js` | [lenis](https://github.com/darkroomengineering/lenis) 1.3.26, `dist/lenis.min.js` | MIT |
| `react.production.min.js` | [react](https://react.dev) 18.3.1, `umd/react.production.min.js` | MIT |
| `react-dom.production.min.js` | [react-dom](https://react.dev) 18.3.1, `umd/react-dom.production.min.js` | MIT |

To update: `npm pack gsap lenis`, copy the same files, and drop the `sourceMappingURL` line.

React and React DOM are loaded by the pages before `support.js`, with the same SRI hashes the
runtime uses (`REACT_SRI`, `REACT_DOM_SRI` in `support.js`), so the runtime finds them and
fetches nothing from unpkg. They must stay byte-identical to the 18.3.1 UMD builds:
`npm pack react@18.3.1 react-dom@18.3.1` and check
`openssl dgst -sha384 -binary FILE | openssl base64 -A` against those hashes.
