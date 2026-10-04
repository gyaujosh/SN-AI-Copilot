/// <reference types="vite/client" />
// Team presets: instances compiled in from config/instances.local.json, when
// that file exists. It is gitignored, so a public build ships with none and a
// team can pre-configure its own environments without committing them. The
// glob matches nothing when the file is absent — no build error, no presets.
// See config/README.md.

const files = import.meta.glob<unknown>("../../config/instances.local.json", { eager: true, import: "default" });

/** Raw preset entries; settings.ts validates them exactly like saved instances. */
export function presetInstances(): unknown {
  return Object.values(files)[0] ?? [];
}
