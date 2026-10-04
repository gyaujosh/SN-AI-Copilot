# Third-party notices

SN AI Copilot is released under the [MIT License](LICENSE). The built extension (`dist/`) also contains the following third-party components, each under its own license. The full license text of every production dependency is collected in [`public/THIRD_PARTY_LICENSES.txt`](public/THIRD_PARTY_LICENSES.txt), which the build copies into `dist/`; regenerate it with `npm run licenses` after changing dependencies.

| Component | Version | License | Used for |
| --- | --- | --- | --- |
| [React](https://react.dev/) and React DOM | 18.3 | MIT | Side panel UI |
| [Framer Motion](https://www.framer.com/motion/) | 11 | MIT | View transitions |
| [Lucide](https://lucide.dev/) (`lucide-react`) | 0.400 | ISC | Icons |
| [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) (`@anthropic-ai/sdk`) | 0.104 | MIT | Claude API client |
| [SheetJS Community Edition](https://sheetjs.com/) (`public/xlsx.mini.min.js`) | 0.20.3 | Apache-2.0 | Reading attached spreadsheets |
| [Plus Jakarta Sans](https://github.com/tokotype/PlusJakartaSans) via Fontsource | 5.3.0 | SIL Open Font License 1.1 | Interface font |
| [IBM Plex Mono](https://github.com/IBM/plex) via Fontsource | 5.3.0 | SIL Open Font License 1.1 | Code font |

`public/xlsx.mini.min.js` is the unmodified SheetJS CE "mini" build, © 2013-present SheetJS, redistributed under the Apache License 2.0; the license text ships beside it as `public/xlsx.LICENSE.txt` (and in `dist/`).

## Trademarks

The Claude mark (`src/sidepanel/assets/providers/claude-mark.svg`) and the OpenAI marks (`openai-black.svg`, `openai-white.svg`) are trademarks of Anthropic, PBC and OpenAI OpCo, LLC. They are used unmodified, only to identify each provider's models; see [the asset sources](src/sidepanel/assets/providers/SOURCES.md). ServiceNow is a trademark of ServiceNow, Inc. This project is not affiliated with or endorsed by any of these companies.
