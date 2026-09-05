# workflows/

One JSON file per n8n workflow. This directory is the source of truth for
`n8n.districtangels.com`.

Files are written by `node tools/n8n.mjs pull` and deployed by
`node tools/n8n.mjs push`. They are normalized on pull: keys sorted, instance ids
stripped, credentials referenced by name so the same file deploys to any instance.

The `"active"` flag is the desired state. A deploy turns the workflow on or off on the
instance to match it.

This directory is empty until the first import. Run the **Import n8n workflows from an
instance** action, or `node tools/n8n.mjs pull --from cloud` locally.
