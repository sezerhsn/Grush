import fs from "node:fs";
import path from "node:path";
import { fileKeccak256Hex, leafHash, nodeHash } from "./hash_utils.ts";
import type { LeafInput } from "./hash_utils.ts";

type JsonUint = number | string;
type ParsedArgs = Record<string, string | boolean>;

type BarEntry = {
  serial_no: string;
  refiner: string;
  gross_weight_g?: number;
  fineness: string;
  fine_weight_g: number;
  vault_id: string;
  allocation_status: "allocated";
};

type BarList = {
  schema_version: "0.1";
  report_id: string;
  as_of_timestamp: number;
  custodian: { name: string; location: string };
  auditor?: { name: string; report_ref?: string };
  bars: BarEntry[];
  totals?: { fine_gold_grams: JsonUint; bars_count?: JsonUint };
};

type PorOutput = {
  schema_version: "0.1";
  report_id: string;
  as_of_timestamp: number;
  bars_count: string;
  attested_fine_gold_grams: string;
  bar_list_hash: string;
  merkle_root: string;
};

function usageAndExit(code = 1): never {
  console.error(`
Usage:
  npx tsx por/merkle/build_merkle_root.ts --barlist <path> [--out <path>]
  npm run por:merkle -- --barlist <path> [--out <path>]

Output:
  {
    "schema_version": "0.1",
    "report_id": string,
    "as_of_timestamp": number,
    "bars_count": "decimal-string",
    "attested_fine_gold_grams": "decimal-string",
    "bar_list_hash": "0x...bytes32",
    "merkle_root": "0x...bytes32"
  }
`);
  process.exit(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;

    if (a === "--help" || a === "-h") {
      args.help = true;
      continue;
    }

    if (!a.startsWith("--")) continue;

    const key = a.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i++;
  }

  return args;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} non-empty string olmalı.`);
  }
  return value;
}

function assertSafeInt(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new Error(`${name} safe integer olmalı. Aldım: ${String(value)}`);
  }

  if (value < 0) {
    throw new Error(`${name} negatif olamaz. Aldım: ${value}`);
  }
}

function toBigIntStrict(value: unknown, name: string): bigint {
  if (typeof value === "bigint") return value;

  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${name} integer olmalı. Aldım: ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${name} MAX_SAFE_INTEGER üstünde. JSON'da decimal string kullan. Aldım: ${value}`);
    }
    if (value < 0) {
      throw new Error(`${name} negatif olamaz. Aldım: ${value}`);
    }
    return BigInt(value);
  }

  if (typeof value === "string") {
    const s = value.trim();
    if (!/^[0-9]+$/.test(s)) {
      throw new Error(`${name} decimal string olmalı. Aldım: ${value}`);
    }
    return BigInt(s);
  }

  throw new Error(`${name} number|string olmalı. Aldım: ${String(value)}`);
}

function basicValidateBarList(input: unknown): BarList {
  if (!isRecord(input)) {
    throw new Error("Bar list JSON object değil.");
  }

  if (input.schema_version !== "0.1") {
    throw new Error("schema_version 0.1 değil.");
  }

  const reportId = requireString(input.report_id, "report_id");
  const asOfTimestamp = input.as_of_timestamp;
  assertSafeInt(asOfTimestamp, "as_of_timestamp");

  if (!isRecord(input.custodian)) {
    throw new Error("custodian yok.");
  }

  const custodian = {
    name: requireString(input.custodian.name, "custodian.name"),
    location: requireString(input.custodian.location, "custodian.location"),
  };

  let auditor: BarList["auditor"];
  if (input.auditor !== undefined) {
    if (!isRecord(input.auditor)) {
      throw new Error("auditor object olmalı.");
    }

    auditor = {
      name: requireString(input.auditor.name, "auditor.name"),
      ...(input.auditor.report_ref !== undefined
        ? { report_ref: requireString(input.auditor.report_ref, "auditor.report_ref") }
        : {}),
    };
  }

  if (!Array.isArray(input.bars) || input.bars.length < 1) {
    throw new Error("bars[] boş.");
  }

  const bars: BarEntry[] = input.bars.map((rawBar, i) => {
    if (!isRecord(rawBar)) {
      throw new Error(`bars[${i}] object değil.`);
    }

    const serial_no = requireString(rawBar.serial_no, `bars[${i}].serial_no`);
    const refiner = requireString(rawBar.refiner, `bars[${i}].refiner`);
    const fineness = requireString(rawBar.fineness, `bars[${i}].fineness`);
    const vault_id = requireString(rawBar.vault_id, `bars[${i}].vault_id`);

    const fine_weight_g = rawBar.fine_weight_g;
    assertSafeInt(fine_weight_g, `bars[${i}].fine_weight_g`);

    let gross_weight_g: number | undefined;
    if (rawBar.gross_weight_g !== undefined) {
      assertSafeInt(rawBar.gross_weight_g, `bars[${i}].gross_weight_g`);
      gross_weight_g = rawBar.gross_weight_g;
    }

    if (rawBar.allocation_status !== "allocated") {
      throw new Error(`bars[${i}].allocation_status allocated olmalı (v0.1).`);
    }

    return {
      serial_no,
      refiner,
      ...(gross_weight_g !== undefined ? { gross_weight_g } : {}),
      fineness,
      fine_weight_g,
      vault_id,
      allocation_status: "allocated",
    };
  });

  let totals: BarList["totals"];
  if (input.totals !== undefined) {
    if (!isRecord(input.totals)) {
      throw new Error("totals object değil.");
    }

    if (input.totals.fine_gold_grams === undefined) {
      throw new Error("totals.fine_gold_grams yok.");
    }

    const fine_gold_grams = input.totals.fine_gold_grams;
    toBigIntStrict(fine_gold_grams, "totals.fine_gold_grams");

    let bars_count: JsonUint | undefined;
    if (input.totals.bars_count !== undefined) {
      toBigIntStrict(input.totals.bars_count, "totals.bars_count");
      bars_count = input.totals.bars_count as JsonUint;
    }

    totals = {
      fine_gold_grams: fine_gold_grams as JsonUint,
      ...(bars_count !== undefined ? { bars_count } : {}),
    };
  }

  return {
    schema_version: "0.1",
    report_id: reportId,
    as_of_timestamp: asOfTimestamp,
    custodian,
    ...(auditor ? { auditor } : {}),
    bars,
    ...(totals ? { totals } : {}),
  };
}

function canonicalSortBars(bars: readonly BarEntry[]): BarEntry[] {
  return [...bars].sort((a, b) => {
    if (a.serial_no !== b.serial_no) return a.serial_no.localeCompare(b.serial_no);
    if (a.refiner !== b.refiner) return a.refiner.localeCompare(b.refiner);
    return a.vault_id.localeCompare(b.vault_id);
  });
}

function buildMerkleRootFromLeaves(leafHashes: readonly string[]): string {
  if (leafHashes.length === 0) {
    throw new Error("leaf list boş.");
  }

  let level = [...leafHashes];

  while (level.length > 1) {
    if (level.length % 2 === 1) {
      level.push(level[level.length - 1]);
    }

    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(nodeHash(level[i], level[i + 1]));
    }
    level = next;
  }

  return level[0];
}

function sumFineGoldGrams(bars: readonly BarEntry[]): bigint {
  let sum = 0n;
  for (const bar of bars) {
    sum += BigInt(bar.fine_weight_g);
  }
  return sum;
}

function computePorFromBarList(barList: BarList, barListFileBytes: Uint8Array): PorOutput {
  const bars = canonicalSortBars(barList.bars);

  const leaves = bars.map((bar) => {
    const leaf: LeafInput = {
      as_of_timestamp: barList.as_of_timestamp,
      fineness: bar.fineness,
      fine_weight_g: bar.fine_weight_g,
      refiner: bar.refiner,
      serial_no: bar.serial_no,
      vault_id: bar.vault_id,
    };
    return leafHash(leaf);
  });

  const derivedBarsCount = BigInt(bars.length);
  const derivedFineGoldGrams = sumFineGoldGrams(bars);

  if (barList.totals?.bars_count !== undefined) {
    const declaredBarsCount = toBigIntStrict(barList.totals.bars_count, "totals.bars_count");
    if (declaredBarsCount !== derivedBarsCount) {
      throw new Error(
        `totals.bars_count mismatch. declared=${declaredBarsCount.toString()}, derived=${derivedBarsCount.toString()}`
      );
    }
  }

  let attestedFineGoldGrams = derivedFineGoldGrams;
  if (barList.totals?.fine_gold_grams !== undefined) {
    const declaredFineGoldGrams = toBigIntStrict(
      barList.totals.fine_gold_grams,
      "totals.fine_gold_grams"
    );

    if (declaredFineGoldGrams !== derivedFineGoldGrams) {
      throw new Error(
        `totals.fine_gold_grams mismatch. declared=${declaredFineGoldGrams.toString()}, derived=${derivedFineGoldGrams.toString()}`
      );
    }

    attestedFineGoldGrams = declaredFineGoldGrams;
  }

  const merkle_root = buildMerkleRootFromLeaves(leaves);
  const bar_list_hash = fileKeccak256Hex(barListFileBytes);

  return {
    schema_version: "0.1",
    report_id: barList.report_id,
    as_of_timestamp: barList.as_of_timestamp,
    bars_count: derivedBarsCount.toString(),
    attested_fine_gold_grams: attestedFineGoldGrams.toString(),
    bar_list_hash,
    merkle_root,
  };
}

function main(): void {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const barlistPath =
    (typeof args.barlist === "string" && args.barlist) ||
    (typeof args.barList === "string" && args.barList) ||
    "";

  if (!barlistPath) {
    usageAndExit(1);
  }

  const absIn = path.isAbsolute(barlistPath)
    ? barlistPath
    : path.join(process.cwd(), barlistPath);

  const fileBytes = fs.readFileSync(absIn);
  const json = JSON.parse(fileBytes.toString("utf8")) as unknown;
  const barList = basicValidateBarList(json);
  const out = computePorFromBarList(barList, new Uint8Array(fileBytes));

  const outPath = typeof args.out === "string" ? args.out : "";
  const outJson = `${JSON.stringify(out, null, 2)}\n`;

  if (outPath) {
    const absOut = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, outJson, { encoding: "utf8" });
    console.log(`OK: wrote ${absOut}`);
    return;
  }

  console.log(outJson);
}

try {
  main();
} catch (err: unknown) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}