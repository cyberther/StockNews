# Vendored libraries

Loaded by the web and mobile templates (and packed into the export bundles), so the apps
need no CDN or build step. Source maps were stripped.

| File | Package | Licence |
|---|---|---|
| `gsap.min.js` | [gsap](https://gsap.com) 3.15.0, `dist/gsap.min.js` | GSAP Standard "no charge" licence (https://gsap.com/standard-license) |
| `lenis.min.js` | [lenis](https://github.com/darkroomengineering/lenis) 1.3.26, `dist/lenis.min.js` | MIT |

To update: `npm pack gsap lenis`, copy the same files, and drop the `sourceMappingURL` line.
