import fs from "fs";
import path from "path";
import { assertBytes32Hex, leafHash, nodeHash } from "./hash_utils.ts";
import type { LeafInput } from "./hash_utils.ts";

type Position = "left" | "right";
type ParsedArgs = Record<string, string | boolean>;
type JsonRecord = Record<string, unknown>;

type NormalizedProofFile = {
  siblings: string[];
  positions: Position[];
};

function usageAndExit(code = 1): never {
  // eslint-disable-next-line no-console
  console.error(`
Usage:
  tsx por/merkle/verify_proof.ts --leaf <leaf.json> --proof <proof.json> --root <0xBytes32>

leaf.json:
  Must contain at least:
    as_of_timestamp (safe JSON integer or decimal uint string)
    fineness (decimal string, örn. "999.9")
    fine_weight_g (safe JSON integer or decimal uint string)
    refiner (string)
    serial_no (string)
    vault_id (string)
  Extra fields are ignored.

proof.json:
  {
    "siblings": ["0x..bytes32", ...],
    "positions": ["left"|"right", ...]
  }

Alternative positions format:
  "positions": [true,false,...]
  where true means sibling is on the LEFT.

Exit codes:
  0 = proof valid
  1 = invalid or input error
`);
  process.exit(code);
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};

  for (let i = 2; i < argv.length; i++) {
    const current = argv[i];

    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }

    if (!current.startsWith("--")) {
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
  const absolutePath = path.resolve(filePath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  return JSON.parse(raw) as unknown;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} string olmalı. Aldım: ${String(value)}`);
  }
  return value;
}

function requireJsonUint(value: unknown, name: string): LeafInput["as_of_timestamp"] {
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

function loadLeafInput(value: unknown): LeafInput {
  if (!isJsonRecord(value)) {
    throw new Error("leaf.json object değil.");
  }

  return {
    as_of_timestamp: requireJsonUint(value.as_of_timestamp, "as_of_timestamp"),
    fineness: requireString(value.fineness, "fineness"),
    fine_weight_g: requireJsonUint(value.fine_weight_g, "fine_weight_g"),
    refiner: requireString(value.refiner, "refiner"),
    serial_no: requireString(value.serial_no, "serial_no"),
    vault_id: requireString(value.vault_id, "vault_id"),
  };
}

function loadProofFile(value: unknown): NormalizedProofFile {
  if (!isJsonRecord(value)) {
    throw new Error("proof.json object değil.");
  }

  const siblingsRaw = value.siblings;
  if (!Array.isArray(siblingsRaw)) {
    throw new Error("proof.siblings array değil.");
  }

  const siblings = siblingsRaw.map((item, index) => {
    const sibling = requireString(item, `proof.siblings[${index}]`);
    assertBytes32Hex(sibling, `proof.siblings[${index}]`);
    return sibling;
  });

  if (siblings.length === 0) {
    const positions = value.positions === undefined ? [] : normalizePositions(value.positions, 0);
    return { siblings, positions };
  }

  if (value.positions === undefined) {
    throw new Error("proof.positions gerekli (left/right).");
  }

  return {
    siblings,
    positions: normalizePositions(value.positions, siblings.length),
  };
}

function hexEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function verifyProof(leafHashHex: string, proof: NormalizedProofFile, root: string): boolean {
  assertBytes32Hex(root, "root");
  assertBytes32Hex(leafHashHex, "leaf_hash");

  let currentHash = leafHashHex;

  for (let i = 0; i < proof.siblings.length; i++) {
    const sibling = proof.siblings[i];
    const position = proof.positions[i];

    currentHash =
      position === "left" ? nodeHash(sibling, currentHash) : nodeHash(currentHash, sibling);
  }

  return hexEquals(currentHash, root);
}

function main(): number {
  const args = parseArgs(process.argv);
  if (args.help) {
    usageAndExit(0);
  }

  const leafPath = typeof args.leaf === "string" ? args.leaf : undefined;
  const proofPath = typeof args.proof === "string" ? args.proof : undefined;
  const root = typeof args.root === "string" ? args.root : undefined;

  if (!leafPath || !proofPath || !root) {
    usageAndExit(1);
  }

  const leafInput = loadLeafInput(readJsonFile(leafPath));
  const proof = loadProofFile(readJsonFile(proofPath));
  const ok = verifyProof(leafHash(leafInput), proof, root);

  // eslint-disable-next-line no-console
  console.log(ok ? "OK: proof valid" : "FAIL: proof invalid");

  return ok ? 0 : 1;
}

try {
  process.exit(main());
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`ERROR: ${message}`);
  process.exit(1);
}