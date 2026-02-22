/* eslint-disable no-console */
import fs from "fs";
import path from "path";

type Args = Record<string, string | boolean>;

type BarEntry = {
  bar_id?: string;
  serial_no: string;
  refiner: string;
  gross_weight_g?: number;
  fineness: string; // "999.9"
  fine_weight_g: number; // integer grams
  vault_id: string;
  location_code?: string;
  allocation_status: "allocated";
  assay_reference?: string;
  notes?: string;
};

type BarList = {
  schema_version: "0.1";
  report_id: string;
  as_of_timestamp: number;
  custodian: { name: string; location: string };
  auditor?: { name: string; report_ref?: string };
  vaults?: { vault_id: string; description: string }[];
  bars: BarEntry[];
  totals: { fine_gold_grams: number; bars_count: number };
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) args[key] = true;
      else {
        args[key] = val;
        i++;
      }
    }
  }
  return args;
}

function usageAndExit(code = 0): never {
  console.log(`
Usage:
  npx ts-node tools/format_barlist.ts --in <bars.csv|bars.json> --custodianName "..." --custodianLocation "..." [--out <bar_list.json>]
Optional:
  --reportId <id>            (default: auto-YYYY-MM-DD-<epoch>)
  --asOf <epochSeconds>      (default: now)
  --auditorName "..."        (optional)
  --auditorRef "..."         (optional)
  --delimiter ","|";"|"\\t"  (CSV only; auto-detect if omitted)
  --emitVaults true|false    (default: false)  // vault_id unique list + description placeholder
  --json                     (stdout only JSON; default behavior already JSON)

Input expectations (minimum columns):
  serial_no, refiner, fine_weight_g, vault_id
Optional columns:
  gross_weight_g, fineness, allocation_status, bar_id, location_code, assay_reference, notes

Notes:
- allocation_status v0.1 MUST be "allocated" (if missing, set to "allocated").
- fine_weight_g MUST be integer grams.
- Bars are canonical-sorted: serial_no, then refiner, then vault_id.
`);
  process.exit(code);
}

function envBoolVal(v: string | boolean | undefined, def = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return def;
  const s = v.trim().toLowerCase();
  if (!s) return def;
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function absPath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function readText(p: string): string {
  const abs = absPath(p);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  return fs.readFileSync(abs, "utf8");
}

function writeText(p: string, s: string) {
  const abs = absPath(p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, s, "utf8");
}

function normalizeHeaderKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s\-_]/g, "")
    .replace(/\./g, "");
}

function pickDelimiter(headerLine: string): string {
  const counts: Array<[string, number]> = [
    [",", (headerLine.match(/,/g) || []).length],
    [";", (headerLine.match(/;/g) || []).length],
    ["\t", (headerLine.match(/\t/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = line[i + 1];
        if (next === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === delimiter) {
      out.push(cur);
      cur = "";
      continue;
    }

    cur += ch;
  }

  out.push(cur);
  return out.map((x) => x.trim());
}

function parseIntegerGrams(v: unknown, label: string): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isInteger(v)) throw new Error(`${label} must be integer grams, got: ${v}`);
    if (v <= 0) throw new Error(`${label} must be > 0, got: ${v}`);
    return v;
  }

  if (typeof v !== "string") throw new Error(`${label} must be number|string, got: ${typeof v}`);

  const s0 = v.trim();
  if (!s0) throw new Error(`${label} is empty`);

  // allow thousands separators: 1,000 or 1'000 or 1 000
  const s = s0.replace(/[\s_]/g, "").replace(/'/g, "");
  if (/^\d{1,3}(,\d{3})+$/.test(s)) {
    const n = Number(s.replace(/,/g, ""));
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} invalid: ${v}`);
    return n;
  }

  // allow 1000.0 / 1000.00 (but not 1000.5)
  if (/^\d+\.\d+$/.test(s)) {
    const [a, b] = s.split(".");
    if (!b || !/^[0]+$/.test(b)) throw new Error(`${label} must be integer grams (no decimals), got: ${v}`);
    const n = Number(a);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} invalid: ${v}`);
    return n;
  }

  if (!/^\d+$/.test(s)) throw new Error(`${label} must be integer grams, got: ${v}`);

  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} invalid: ${v}`);
  return n;
}

function normalizeFineness(v: unknown): string {
  if (v == null) return "999.9";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`fineness invalid: ${v}`);
    // format to one decimal
    const s = v.toFixed(1);
    if (!/^\d{3}\.\d$/.test(s)) throw new Error(`fineness invalid format: ${s}`);
    return s;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return "999.9";
    // normalize "9999" -> "999.9" (common input)
    if (/^\d{4}$/.test(s)) {
      const t = `${s.slice(0, 3)}.${s.slice(3)}`;
      if (!/^\d{3}\.\d$/.test(t)) throw new Error(`fineness invalid: ${s}`);
      return t;
    }
    if (!/^\d{3}\.\d$/.test(s)) throw new Error(`fineness must match NNN.N (e.g. 999.9), got: ${s}`);
    return s;
  }
  throw new Error(`fineness invalid type: ${typeof v}`);
}

function canonicalSortBars(bars: BarEntry[]): BarEntry[] {
  return [...bars].sort((a, b) => {
    if (a.serial_no !== b.serial_no) return a.serial_no.localeCompare(b.serial_no);
    if (a.refiner !== b.refiner) return a.refiner.localeCompare(b.refiner);
    return a.vault_id.localeCompare(b.vault_id);
  });
}

function sumFine(bars: BarEntry[]): number {
  let s = 0;
  for (const b of bars) s += b.fine_weight_g;
  return s;
}

function ensureNonEmptyString(x: unknown, label: string): string {
  if (typeof x !== "string") throw new Error(`${label} must be string`);
  const s = x.trim();
  if (!s) throw new Error(`${label} is empty`);
  return s;
}

function parseCsvToBars(csvText: string, delimiterArg?: string): BarEntry[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) throw new Error("CSV must have header + at least 1 data line");

  const delimiter = delimiterArg ?? pickDelimiter(lines[0]);
  const headersRaw = parseCsvLine(lines[0], delimiter);
  const headers = headersRaw.map(normalizeHeaderKey);

  const idx = (aliases: string[]) => {
    for (const a of aliases) {
      const k = normalizeHeaderKey(a);
      const i = headers.indexOf(k);
      if (i >= 0) return i;
    }
    return -1;
  };

  const iSerial = idx(["serial_no", "serial", "serialnumber", "serialno"]);
  const iRefiner = idx(["refiner", "refinery", "brand", "manufacturer"]);
  const iFine = idx(["fine_weight_g", "fineg", "fineweight", "fineweightg", "finegrams"]);
  const iVault = idx(["vault_id", "vault", "vaultid", "storage", "storageid", "vaultcode"]);

  if (iSerial < 0) throw new Error("CSV missing required column: serial_no");
  if (iRefiner < 0) throw new Error("CSV missing required column: refiner");
  if (iFine < 0) throw new Error("CSV missing required column: fine_weight_g");
  if (iVault < 0) throw new Error("CSV missing required column: vault_id");

  const iGross = idx(["gross_weight_g", "grossweightg", "grossweight", "grossg", "grossgrams"]);
  const iFineness = idx(["fineness", "purity"]);
  const iStatus = idx(["allocation_status", "allocationstatus", "status"]);
  const iBarId = idx(["bar_id", "barid", "id"]);
  const iLocCode = idx(["location_code", "locationcode", "branch", "branchcode"]);
  const iAssay = idx(["assay_reference", "assayreference", "assay", "certificate"]);
  const iNotes = idx(["notes", "note", "comment", "remarks"]);

  const bars: BarEntry[] = [];

  for (let li = 1; li < lines.length; li++) {
    const row = parseCsvLine(lines[li], delimiter);
    if (row.length === 1 && row[0] === "") continue;

    const serial_no = ensureNonEmptyString(row[iSerial], `row ${li}: serial_no`);
    const refiner = ensureNonEmptyString(row[iRefiner], `row ${li}: refiner`);
    const vault_id = ensureNonEmptyString(row[iVault], `row ${li}: vault_id`);

    const fine_weight_g = parseIntegerGrams(row[iFine], `row ${li}: fine_weight_g`);

    const fineness = normalizeFineness(iFineness >= 0 ? row[iFineness] : undefined);

    let allocation_status: "allocated" = "allocated";
    if (iStatus >= 0) {
      const s = (row[iStatus] || "").trim().toLowerCase();
      if (s && s !== "allocated") throw new Error(`row ${li}: allocation_status must be "allocated" (v0.1), got: ${row[iStatus]}`);
    }

    const b: BarEntry = {
      serial_no,
      refiner,
      vault_id,
      fine_weight_g,
      fineness,
      allocation_status,
    };

    if (iGross >= 0) {
      const gv = (row[iGross] || "").trim();
      if (gv) b.gross_weight_g = parseIntegerGrams(gv, `row ${li}: gross_weight_g`);
    }
    if (iBarId >= 0) {
      const v = (row[iBarId] || "").trim();
      if (v) b.bar_id = v;
    }
    if (iLocCode >= 0) {
      const v = (row[iLocCode] || "").trim();
      if (v) b.location_code = v;
    }
    if (iAssay >= 0) {
      const v = (row[iAssay] || "").trim();
      if (v) b.assay_reference = v;
    }
    if (iNotes >= 0) {
      const v = (row[iNotes] || "").trim();
      if (v) b.notes = v;
    }

    bars.push(b);
  }

  if (bars.length < 1) throw new Error("No bar rows parsed from CSV");
  return bars;
}

function parseJsonToBars(json: any): { bars: BarEntry[]; meta?: Partial<Omit<BarList, "bars" | "totals">> } {
  // Accept:
  // 1) Array<BarEntry>
  // 2) { bars: Array<BarEntry>, ...meta }
  if (Array.isArray(json)) return { bars: json as BarEntry[] };

  if (json && typeof json === "object" && Array.isArray(json.bars)) {
    const { bars, ...rest } = json;
    return { bars: bars as BarEntry[], meta: rest as any };
  }

  throw new Error("JSON input must be an array of bars[] or an object with bars[]");
}

function validateAndNormalizeBars(barsRaw: any[]): BarEntry[] {
  if (!Array.isArray(barsRaw) || barsRaw.length < 1) throw new Error("bars[] must be non-empty array");

  const bars: BarEntry[] = [];
  for (let i = 0; i < barsRaw.length; i++) {
    const b = barsRaw[i];
    const label = `bars[${i}]`;

    const serial_no = ensureNonEmptyString(b?.serial_no, `${label}.serial_no`);
    const refiner = ensureNonEmptyString(b?.refiner, `${label}.refiner`);
    const vault_id = ensureNonEmptyString(b?.vault_id, `${label}.vault_id`);
    const fine_weight_g = parseIntegerGrams(b?.fine_weight_g, `${label}.fine_weight_g`);
    const fineness = normalizeFineness(b?.fineness);

    const statusRaw = (b?.allocation_status ?? "allocated") as any;
    const status = typeof statusRaw === "string" ? statusRaw.trim().toLowerCase() : "allocated";
    if (status !== "allocated") throw new Error(`${label}.allocation_status must be "allocated" (v0.1)`);

    const out: BarEntry = {
      serial_no,
      refiner,
      vault_id,
      fine_weight_g,
      fineness,
      allocation_status: "allocated",
    };

    if (b?.gross_weight_g != null) out.gross_weight_g = parseIntegerGrams(b.gross_weight_g, `${label}.gross_weight_g`);
    if (typeof b?.bar_id === "string" && b.bar_id.trim()) out.bar_id = b.bar_id.trim();
    if (typeof b?.location_code === "string" && b.location_code.trim()) out.location_code = b.location_code.trim();
    if (typeof b?.assay_reference === "string" && b.assay_reference.trim()) out.assay_reference = b.assay_reference.trim();
    if (typeof b?.notes === "string" && b.notes.trim()) out.notes = b.notes.trim();

    bars.push(out);
  }

  // serial_no uniqueness (schema says MUST be unique within report)
  const seen = new Set<string>();
  for (const b of bars) {
    const k = b.serial_no;
    if (seen.has(k)) throw new Error(`Duplicate serial_no in bars[]: ${k}`);
    seen.add(k);
  }

  return canonicalSortBars(bars);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const inPath = (args.in as string) || (args.input as string) || "";
  if (!inPath) usageAndExit(1);

  const custodianName = (args.custodianName as string) || (args.custodian as string) || "";
  const custodianLocation = (args.custodianLocation as string) || (args.location as string) || "";
  if (!custodianName || !custodianLocation) {
    throw new Error("custodianName and custodianLocation are required");
  }

  const asOfRaw = (args.asOf as string) || (args.as_of_timestamp as string) || (args.timestamp as string) || "";
  const as_of_timestamp = asOfRaw ? parseIntegerGrams(asOfRaw, "as_of_timestamp") : Math.floor(Date.now() / 1000);

  const reportId =
    ((args.reportId as string) || (args.report_id as string) || "").trim() ||
    `auto-${new Date().toISOString().slice(0, 10)}-${as_of_timestamp}`;

  const auditorName = ((args.auditorName as string) || "").trim();
  const auditorRef = ((args.auditorRef as string) || "").trim();

  const outPath = ((args.out as string) || (args.output as string) || "").trim();
  const delimiterArg = (args.delimiter as string) ? String(args.delimiter) : undefined;
  const emitVaults = envBoolVal(args.emitVaults, false);

  const ext = path.extname(inPath).toLowerCase();
  const rawText = readText(inPath);

  let barsRaw: any[] = [];
  let metaFromJson: any | undefined;

  if (ext === ".csv" || ext === ".tsv" || ext === ".txt") {
    const delim = delimiterArg || (ext === ".tsv" ? "\t" : undefined);
    barsRaw = parseCsvToBars(rawText, delim);
  } else if (ext === ".json") {
    const parsed = JSON.parse(rawText);
    const { bars, meta } = parseJsonToBars(parsed);
    barsRaw = bars;
    metaFromJson = meta;
  } else {
    throw new Error(`Unsupported input extension: ${ext} (use .csv or .json)`);
  }

  const bars = validateAndNormalizeBars(barsRaw);

  const totals = {
    fine_gold_grams: sumFine(bars),
    bars_count: bars.length,
  };

  const out: BarList = {
    schema_version: "0.1",
    report_id: reportId,
    as_of_timestamp,
    custodian: { name: custodianName, location: custodianLocation },
    bars,
    totals,
  };

  if (auditorName) out.auditor = { name: auditorName, ...(auditorRef ? { report_ref: auditorRef } : {}) };

  if (emitVaults) {
    const uniq = Array.from(new Set(bars.map((b) => b.vault_id)));
    out.vaults = uniq.map((v) => ({ vault_id: v, description: `TODO: describe ${v}` }));
  }

  // If JSON input had extra meta and user didn't provide overrides, we do NOT auto-merge to avoid surprises.
  // (Keep deterministic / explicit.)
  if (metaFromJson && typeof metaFromJson === "object") {
    // no-op by design
  }

  const outJson = JSON.stringify(out, null, 2) + "\n";

  if (outPath) {
    writeText(outPath, outJson);
    console.log(`OK: wrote ${absPath(outPath)}`);
  } else {
    console.log(outJson);
  }
}

try {
  main();
} catch (e: any) {
  console.error("FORMAT_BARLIST FAIL:", e?.message ?? e);
  process.exit(1);
}
