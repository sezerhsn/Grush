\# Transparency / Reserve Reports



This folder stores the minimal "report manifest" that binds together:

\- as\_of\_timestamp

\- total attested fine gold grams

\- bar\_list\_hash

\- merkle\_root



\## What lives here (MUST)

\- `transparency/reserve\_reports/<report\_id>/por\_output.json`



Rules:

\- Once published, files MUST NOT be edited. If something changes, create a new report\_id.



\## Directory layout



\### M1 layout (MUST)

\- `transparency/reserve\_reports/<report\_id>/por\_output.json`



\### Future layout (MAY)

\- `transparency/reserve\_reports/<network>/<YYYY>/<report\_id>/por\_output.json`



\## Minimum fields (v0.1)

`por\_output.json` MUST include:

\- schema\_version

\- report\_id

\- as\_of\_timestamp

\- bars\_count

\- attested\_fine\_gold\_grams

\- bar\_list\_hash

\- merkle\_root



\## Verification

Recompute the output from the stored bar list and compare:



```bat

set REPORT\_ID=<report\_id>

npx tsx por/merkle/build\_merkle\_root.ts --barlist transparency/barlists/%REPORT\_ID%/bar\_list.json --out por/reports/\_tmp\_from\_barlist.json

type por\\reports\\\_tmp\_from\_barlist.json

type transparency\\reserve\_reports\\%REPORT\_ID%\\por\_output.json

---

## Verify the full snapshot
See `transparency/README.md` or run:
```bash
npx tsx tools/verify_transparency_snapshot.ts --report_id <report_id>

