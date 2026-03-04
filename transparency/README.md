# Transparency (published snapshots)

This directory is the public, immutable archive for Proof-of-Reserves snapshots.

## M1 layout (MUST)
For each `report_id`, we store three files:

- `transparency/barlists/<report_id>/bar_list.json`
- `transparency/reserve_reports/<report_id>/por_output.json`
- `transparency/attestations/<report_id>/attestation.json`

Rule:
- Once published, files MUST NOT be edited. If anything changes, create a new `report_id`.

## Verify a published snapshot (one command)
```bash
npx tsx tools/verify_transparency_snapshot.ts --report_id <report_id>