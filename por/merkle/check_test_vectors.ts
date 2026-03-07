import fs from "node:fs";
import path from "node:path";
import {
  assertBytes32Hex,
  fileKeccak256Hex,
  leafHash,
  nodeHash,
  toUintBigInt,
} from "./hash_utils.ts";
import type { JsonUint, LeafInput } from "./hash_utils.ts";

type Position = "left" | "right";
type ParsedArgs = Record<string, string | boolean>;
type JsonRecord = Record<string, unknown>;

type ProofVector = {
  siblings: string[];
  positions: Position[] | boolean[];
};

type TestVector = {
  schema_version: string;
  report_id: string;
  as_of_timestamp: JsonUint;
  bar_list_path: string;
  expected: {
    bar_list_hash: string;
    merkle_root: string;
    leaf_hashes?: Record<string, string>;
    proofs?: Record<string, ProofVector>;
  };
};

type BarEntry = {
  serial_no: string;
  refiner: string;
  fineness: string;
  fine_weight_g: JsonUint;
  vault_id: string;
};

type BarList = {
  schema_version: string;
  report_id: string;
  as_of_timestamp: JsonUint;
  bars: BarEntry[];
};

type NormalizedProof = {
  siblings: string[];
  positions: Position[];
};

function usageAndExit(code = 1): never {
  // eslint-disable-next-line no-console
  console.error(`
Usage:
  tsx por/merkle/check_test_vectors.ts [vector.json]
  tsx por/merkle/check_test_vectors.ts --vector <vector.json>

Default:
  por/merkle/test_vectors/v0.1_demo.json

Checks:
  - vector parse + schema sanity
  - bar_list_hash
  - merkle_root
  - optional leaf_hashes
  - optional proofs
`);
  process.exit(code);
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  let positionalAssigned = false;

  for (let i = 2; i < argv.length; i++) {
    const current = argv[i];
    if (!current) {
      continue;
    }

    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }

    if (!current.startsWith("--")) {
      if (!positionalAssigned) {
        args.vector = current;
        positionalAssigned = true;
      }
      continue;
    }

    const key = current.slice(2);
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

function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as unknown;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} non-empty string olmalı.`);
  }
  return value;
}

function requireJsonUint(value: unknown, name: string): JsonUint {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${name} integer olmalı. Aldım: ${String(value)}`);
    }
    return value;
  }

  if (typeof value === "string") {
    return value;
  }

  throw new Error(
    `${name} integer number veya decimal uint string olmalı. Aldım: ${String(value)}`
  );
}

function hexEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function resolveInputPath(inputPath: string, baseDir: string): string {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  const cwdCandidate = path.resolve(process.cwd(), inputPath);
  if (fs.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }

  const baseCandidate = path.resolve(baseDir, inputPath);
  if (fs.existsSync(baseCandidate)) {
    return baseCandidate;
  }

  return cwdCandidate;
}

function canonicalSortBars(bars: readonly BarEntry[]): BarEntry[] {
  return [...bars].sort((a, b) => {
    if (a.serial_no !== b.serial_no) {
      return a.serial_no.localeCompare(b.serial_no);
    }
    if (a.refiner !== b.refiner) {
      return a.refiner.localeCompare(b.refiner);
    }
    return a.vault_id.localeCompare(b.vault_id);
  });
}

function buildMerkleRootFromLeaves(leafHashes: readonly string[]): string {
  if (leafHashes.length === 0) {
    throw new Error("leaf list boş.");
  }

  for (let i = 0; i < leafHashes.length; i++) {
    assertBytes32Hex(leafHashes[i], `leafHashes[${i}]`);
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

function normalizePositions(value: unknown, expectedLength: number): Position[] {
  if (!Array.isArray(value)) {
    throw new Error("proof.positions array olmalı.");
  }

  if (value.length !== expectedLength) {
    throw new Error(
      `positions uzunluğu (${value.length}) siblings uzunluğuna (${expectedLength}) eşit olmalı.`
    );
  }

  if (value.length === 0) {
    return [];
  }

  const allBooleans = value.every((item) => typeof item === "boolean");
  if (allBooleans) {
    return value.map((item) => ((item as boolean) ? "left" : "right"));
  }

  return value.map((item, index) => {
    if (item !== "left" && item !== "right") {
      throw new Error(`positions[${index}] left/right olmalı. Aldım: ${String(item)}`);
    }
    return item;
  });
}

function normalizeProof(value: unknown, name: string): NormalizedProof {
  if (!isJsonRecord(value)) {
    throw new Error(`${name} object olmalı.`);
  }

  if (!Array.isArray(value.siblings)) {
    throw new Error(`${name}.siblings array olmalı.`);
  }

  const siblings = value.siblings.map((item, index) => {
    const sibling = requireString(item, `${name}.siblings[${index}]`);
    assertBytes32Hex(sibling, `${name}.siblings[${index}]`);
    return sibling;
  });

  if (value.positions === undefined) {
    throw new Error(`${name}.positions gerekli.`);
  }

  return {
    siblings,
    positions: normalizePositions(value.positions, siblings.length),
  };
}

function verifyProof(leafHashHex: string, proof: NormalizedProof, root: string): boolean {
  assertBytes32Hex(leafHashHex, "leaf_hash");
  assertBytes32Hex(root, "root");

  let currentHash = leafHashHex;

  for (let i = 0; i < proof.siblings.length; i++) {
    const sibling = proof.siblings[i];
    const position = proof.positions[i];

    currentHash =
      position === "left" ? nodeHash(sibling, currentHash) : nodeHash(currentHash, sibling);
  }

  return hexEquals(currentHash, root);
}

function parseBarEntry(value: unknown, index: number): BarEntry {
  if (!isJsonRecord(value)) {
    throw new Error(`bars[${index}] object değil.`);
  }

  return {
    serial_no: requireString(value.serial_no, `bars[${index}].serial_no`),
    refiner: requireString(value.refiner, `bars[${index}].refiner`),
    fineness: requireString(value.fineness, `bars[${index}].fineness`),
    fine_weight_g: requireJsonUint(value.fine_weight_g, `bars[${index}].fine_weight_g`),
    vault_id: requireString(value.vault_id, `bars[${index}].vault_id`),
  };
}

function parseBarList(value: unknown): BarList {
  if (!isJsonRecord(value)) {
    throw new Error("bar list JSON object değil.");
  }

  if (!Array.isArray(value.bars) || value.bars.length === 0) {
    throw new Error("bars[] boş veya array değil.");
  }

  return {
    schema_version: requireString(value.schema_version, "bar_list.schema_version"),
    report_id: requireString(value.report_id, "bar_list.report_id"),
    as_of_timestamp: requireJsonUint(value.as_of_timestamp, "bar_list.as_of_timestamp"),
    bars: value.bars.map((item, index) => parseBarEntry(item, index)),
  };
}

function parseTestVector(value: unknown): TestVector {
  if (!isJsonRecord(value)) {
    throw new Error("vector JSON object değil.");
  }

  if (!isJsonRecord(value.expected)) {
    throw new Error("vector.expected object değil.");
  }

  const bar_list_hash = requireString(value.expected.bar_list_hash, "expected.bar_list_hash");
  const merkle_root = requireString(value.expected.merkle_root, "expected.merkle_root");

  assertBytes32Hex(bar_list_hash, "expected.bar_list_hash");
  assertBytes32Hex(merkle_root, "expected.merkle_root");

  let leaf_hashes: Record<string, string> | undefined;
  if (value.expected.leaf_hashes !== undefined) {
    if (!isJsonRecord(value.expected.leaf_hashes)) {
      throw new Error("expected.leaf_hashes object olmalı.");
    }

    leaf_hashes = {};
    for (const [serial, hash] of Object.entries(value.expected.leaf_hashes)) {
      const hashHex = requireString(hash, `expected.leaf_hashes[${serial}]`);
      assertBytes32Hex(hashHex, `expected.leaf_hashes[${serial}]`);
      leaf_hashes[serial] = hashHex;
    }
  }

  let proofs: Record<string, ProofVector> | undefined;
  if (value.expected.proofs !== undefined) {
    if (!isJsonRecord(value.expected.proofs)) {
      throw new Error("expected.proofs object olmalı.");
    }

    proofs = {};
    for (const [serial, proof] of Object.entries(value.expected.proofs)) {
      const normalized = normalizeProof(proof, `expected.proofs[${serial}]`);
      proofs[serial] = {
        siblings: normalized.siblings,
        positions: normalized.positions,
      };
    }
  }

  return {
    schema_version: requireString(value.schema_version, "schema_version"),
    report_id: requireString(value.report_id, "report_id"),
    as_of_timestamp: requireJsonUint(value.as_of_timestamp, "as_of_timestamp"),
    bar_list_path: requireString(value.bar_list_path, "bar_list_path"),
    expected: {
      bar_list_hash,
      merkle_root,
      ...(leaf_hashes ? { leaf_hashes } : {}),
      ...(proofs ? { proofs } : {}),
    },
  };
}

function buildLeafHashes(barList: BarList): { leafHashes: string[]; leafBySerial: Record<string, string> } {
  const bars = canonicalSortBars(barList.bars);
  const leafHashes: string[] = [];
  const leafBySerial: Record<string, string> = {};

  for (const bar of bars) {
    const serialKey = String(bar.serial_no);
    if (leafBySerial[serialKey] !== undefined) {
      throw new Error(
        `duplicate serial_no bulundu: ${serialKey}. test vector leaf/proof map'i serial_no bazlı olduğu için belirsiz.`
      );
    }

    const leaf: LeafInput = {
      as_of_timestamp: barList.as_of_timestamp,
      fineness: bar.fineness,
      fine_weight_g: bar.fine_weight_g,
      refiner: bar.refiner,
      serial_no: bar.serial_no,
      vault_id: bar.vault_id,
    };

    const hash = leafHash(leaf);
    leafHashes.push(hash);
    leafBySerial[serialKey] = hash;
  }

  return { leafHashes, leafBySerial };
}

function main(): void {
  const args = parseArgs(process.argv);
  if (args.help) {
    usageAndExit(0);
  }

  const vectorInput =
    typeof args.vector === "string" ? args.vector : "por/merkle/test_vectors/v0.1_demo.json";

  const vectorPath = resolveInputPath(vectorInput, process.cwd());
  const vectorDir = path.dirname(vectorPath);

  const vector = parseTestVector(readJsonFile(vectorPath));
  const barListPath = resolveInputPath(vector.bar_list_path, vectorDir);

  const barListBytes = fs.readFileSync(barListPath);
  const barList = parseBarList(JSON.parse(barListBytes.toString("utf8")) as unknown);

  if (vector.schema_version !== "0.1") {
    throw new Error(`vector.schema_version 0.1 değil: ${vector.schema_version}`);
  }

  if (barList.schema_version !== "0.1") {
    throw new Error(`bar_list.schema_version 0.1 değil: ${barList.schema_version}`);
  }

  if (vector.report_id !== barList.report_id) {
    throw new Error(
      `report_id mismatch. vector=${vector.report_id}, bar_list=${barList.report_id}`
    );
  }

  if (
    toUintBigInt(vector.as_of_timestamp, "vector.as_of_timestamp") !==
    toUintBigInt(barList.as_of_timestamp, "bar_list.as_of_timestamp")
  ) {
    throw new Error(
      `as_of_timestamp mismatch. vector=${String(vector.as_of_timestamp)}, bar_list=${String(barList.as_of_timestamp)}`
    );
  }

  const bar_list_hash = fileKeccak256Hex(new Uint8Array(barListBytes));
  if (!hexEquals(bar_list_hash, vector.expected.bar_list_hash)) {
    throw new Error(
      `bar_list_hash mismatch\nexpected: ${vector.expected.bar_list_hash}\nactual:   ${bar_list_hash}`
    );
  }

  const { leafHashes, leafBySerial } = buildLeafHashes(barList);

  const merkle_root = buildMerkleRootFromLeaves(leafHashes);
  if (!hexEquals(merkle_root, vector.expected.merkle_root)) {
    throw new Error(
      `merkle_root mismatch\nexpected: ${vector.expected.merkle_root}\nactual:   ${merkle_root}`
    );
  }

  if (vector.expected.leaf_hashes) {
    for (const [serial, expectedHash] of Object.entries(vector.expected.leaf_hashes)) {
      const actualHash = leafBySerial[serial];
      if (!actualHash) {
        throw new Error(`leaf missing for serial_no=${serial}`);
      }

      if (!hexEquals(actualHash, expectedHash)) {
        throw new Error(
          `leaf_hash mismatch for ${serial}\nexpected: ${expectedHash}\nactual:   ${actualHash}`
        );
      }
    }
  }

  if (vector.expected.proofs) {
    for (const [serial, proofVector] of Object.entries(vector.expected.proofs)) {
      const leafHashHex = leafBySerial[serial];
      if (!leafHashHex) {
        throw new Error(`proof leaf missing for serial_no=${serial}`);
      }

      const proof = normalizeProof(proofVector, `expected.proofs[${serial}]`);
      const ok = verifyProof(leafHashHex, proof, vector.expected.merkle_root);

      if (!ok) {
        throw new Error(`proof verify FAIL for ${serial}`);
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log("OK: test vector matches (bar_list_hash, merkle_root, leaf_hashes, proofs)");
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`ERROR: ${message}`);
  process.exit(1);
}