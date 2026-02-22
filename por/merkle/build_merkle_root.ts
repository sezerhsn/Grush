/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import { fileKeccak256Hex, leafHash, nodeHash } from "./hash_utils.ts";
import type { LeafInput } from "./hash_utils.ts";

type BarEntry = {
  serial_no: string;
  refiner: string;
  gross_weight_g?: number;
  fineness: string; // "999.9"
  fine_weight_g: number; // integer grams
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
  totals?: { fine_gold_grams: number; bars_count?: number };
};

function usageAndExit(code = 1): never {
  // eslint-disable-next-line no-console
  console.error(`
Usage:
  ts-node por/merkle/build_merkle_root.ts --barlist <path> [--out <path>]

Outputs (JSON):
  {
    schema_version: "0.1",
    report_id: string,
    as_of_timestamp: number,
    bars_count: number,
    attested_fine_gold_grams: number,
    bar_list_hash: "0x..bytes32",
    merkle_root: "0x..bytes32"
  }
`);
  process.exit(code);
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
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

function assertInteger(n: any, name: string) {
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new Error(`${name} integer olmalı. Aldım: ${n}`);
  }
}

function basicValidateBarList(j: any): BarList {
  if (!j || typeof j !== "object") throw new Error("Bar list JSON object değil.");
  if (j.schema_version !== "0.1") throw new Error("schema_version 0.1 değil.");

  if (typeof j.report_id !== "string" || j.report_id.length < 1) {
    throw new Error("report_id string olmalı.");
  }

  assertInteger(j.as_of_timestamp, "as_of_timestamp");

  if (!j.custodian || typeof j.custodian !== "object") throw new Error("custodian yok.");
  if (typeof j.custodian.name !== "string") throw new Error("custodian.name yok.");
  if (typeof j.custodian.location !== "string") throw new Error("custodian.location yok.");

  if (!Array.isArray(j.bars) || j.bars.length < 1) throw new Error("bars[] boş.");

  for (const b of j.bars) {
    if (typeof b.serial_no !== "string") throw new Error("bar.serial_no yok.");
    if (typeof b.refiner !== "string") throw new Error("bar.refiner yok.");
    if (typeof b.fineness !== "string") throw new Error("bar.fineness yok.");
    assertInteger(b.fine_weight_g, "bar.fine_weight_g");
    if (typeof b.vault_id !== "string") throw new Error("bar.vault_id yok.");
    if (b.allocation_status !== "allocated") throw new Error("allocation_status allocated olmalı (v0.1).");
  }

  return j as BarList;
}

function canonicalSortBars(bars: BarEntry[]): BarEntry[] {
  return [...bars].sort((a, b) => {
    if (a.serial_no !== b.serial_no) return a.serial_no.localeCompare(b.serial_no);
    if (a.refiner !== b.refiner) return a.refiner.localeCompare(b.refiner);
    return a.vault_id.localeCompare(b.vault_id);
  });
}

function buildMerkleRootFromLeaves(leafHashes: string[]): string {
  if (leafHashes.length === 0) throw new Error("leaf list boş.");
  let level = [...leafHashes];

  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]); // duplicate-last
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(nodeHash(level[i], level[i + 1]));
    }
    level = next;
  }
  return level[0];
}

function sumFineGoldGrams(bars: BarEntry[]): number {
  let sum = 0;
  for (const b of bars) sum += b.fine_weight_g;
  return sum;
}

function computePorFromBarList(barList: BarList, barListFileBytes: Uint8Array) {
  const bars = canonicalSortBars(barList.bars);
  const leaves: string[] = [];

  for (const b of bars) {
    const leaf: LeafInput = {
      as_of_timestamp: barList.as_of_timestamp,
      fineness: b.fineness,
      fine_weight_g: b.fine_weight_g,
      refiner: b.refiner,
      serial_no: b.serial_no,
      vault_id: b.vault_id,
    };
    leaves.push(leafHash(leaf));
  }

  const merkle_root = buildMerkleRootFromLeaves(leaves);
  const attested_fine_gold_grams =
    barList.totals?.fine_gold_grams ?? sumFineGoldGrams(bars);

  // BURASI KRİTİK: hash, dosya YOLU değil DOSYA BAYTI ile alınır
  const bar_list_hash = fileKeccak256Hex(barListFileBytes);

  if (barList.totals?.fine_gold_grams != null && barList.totals.fine_gold_grams !== attested_fine_gold_grams) {
    // eslint-disable-next-line no-console
    console.warn(
      `WARN: totals.fine_gold_grams (${barList.totals.fine_gold_grams}) != sum(bars[].fine_weight_g) (${attested_fine_gold_grams})`
    );
  }

  return {
    schema_version: "0.1",
    report_id: barList.report_id,
    as_of_timestamp: barList.as_of_timestamp,
    bars_count: bars.length,
    attested_fine_gold_grams,
    bar_list_hash,
    merkle_root,
  } as const;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const barlistPath = (args.barlist as string) || (args.barList as string) || "";
  if (!barlistPath) usageAndExit(1);

  const abs = path.isAbsolute(barlistPath) ? barlistPath : path.join(process.cwd(), barlistPath);

  const fileBytes = fs.readFileSync(abs);
  const json = JSON.parse(fileBytes.toString("utf8"));
  const barList = basicValidateBarList(json);

  const out = computePorFromBarList(barList, new Uint8Array(fileBytes));

  const outPath = (args.out as string) || "";
  const outJson = JSON.stringify(out, null, 2) + "\n";

  if (outPath) {
    const absOut = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, outJson, { encoding: "utf8" });
    // eslint-disable-next-line no-console
    console.log(`OK: wrote ${absOut}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(outJson);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
