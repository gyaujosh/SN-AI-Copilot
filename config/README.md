# Instance presets (optional)

By default the extension ships with no ServiceNow instances: each user adds their own under **Settings → Instances**. A team that builds the extension for its own people can pre-configure its instances instead.

1. Copy the example:

   ```bash
   cp config/instances.example.json config/instances.local.json
   ```

2. Edit `config/instances.local.json` — one entry per instance:

   | Field | Meaning |
   | --- | --- |
   | `host` | The instance's hostname, e.g. `acmedev.service-now.com`. Only `*.service-now.com` hosts are accepted. |
   | `label` | The short name shown in the header. Optional; defaults to the first part of the host. |
   | `role` | `sand`, `dev`, `test`, `stage` or `prod`. Every role except `prod` allows the agent to make changes, each one approved. A missing or unknown role means `prod`: read-only. |

3. Build as usual (`npm run build`).

The presets fill a user's instance list the first time the extension starts. After that the list is theirs: they can rename instances, change environments or remove them, and later preset changes don't overwrite their edits.

## Keep it private

- `config/*.local.json` is in `.gitignore`, so your instance names never reach the repository.
- The presets are **compiled into `dist/`**. Share a build made with a local preset file only with the people it is meant for, and never publish it.
- Presets hold hostnames and environments only. Never put API keys or credentials here: keys are entered in the extension and stay in each user's browser.
