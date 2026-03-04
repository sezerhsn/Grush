# Transparency / Barlists

This folder stores the immutable bar list snapshots used for Proof-of-Reserves.

## What lives here (MUST)
- The exact bar list snapshot file for a report:
  - `transparency/barlists/<report_id>/bar_list.json`

Rules:
- Once published, snapshots MUST NOT be edited. If something changes, create a new report_id.

## Directory layout

### M1 layout (MUST)
- `transparency/barlists/<report_id>/bar_list.json`

### Future layout (MAY)
- `transparency/barlists/<network>/<YYYY>/<report_id>/bar_list.json`
  - network examples: `sepolia`, `mainnet`

## Verification
Given a report output (por_output.json), the following MUST match:
- `bar_list_hash` == byte-level keccak256(bar_list.json)
- `merkle_root` == merkle root computed from bar_list.json using `por/merkle/leaf_format.md`

Commands (Windows/CMD):
```bat
set REPORT_ID=<report_id>
npx tsx por/merkle/build_merkle_root.ts --barlist transparency/barlists/%REPORT_ID%/bar_list.json --out por/reports/_tmp_from_transparency.json
type por\reports\_tmp_from_transparency.json

---

## Verify the full snapshot
See `transparency/README.md` or run:
```bash
npx tsx tools/verify_transparency_snapshot.ts --report_id <report_id>