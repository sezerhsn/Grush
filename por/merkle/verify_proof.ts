/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import { leafHash, nodeHash, assertBytes32Hex } from "./hash_utils.ts";
import type { LeafInput } from "./hash_utils.ts";

type ProofFile = {
  // REQUIRED:
  siblings: string[]; // bytes32[]
  // OPTIONAL but strongly recommended:
  // - positions[i] says where the sibling sits relative to the running hash at step i.
  //   "left"  => parent = H(sibling, hash)
  //   "right" => parent = H(hash, sibling)
  positions?: Array<"left" | "right"> | boolean[];
};

function usageAndExit(code = 1): never {
  // eslint-disable-next-line no-console
  console.error(`
Usage:
  ts-node por/merkle/verify_proof.ts --leaf <leaf.json> --proof <proof.json> --root <0xBytes32>

leaf.json:
  Must contain at least:
    as_of_timestamp (int)
    fineness (string)
    fine_weight_g (int)
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
  1 = invalid
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

function readJson(p: string): any {
  const abs = path.resolve(p);
  const raw = fs.readFileSync(abs, "utf8");
  return JSON.parse(raw);
}

function normalizePositions(pos: any, n: number): Array<"left" | "right"> {
  if (pos == null) {
    throw new Error("proof.positions gerekli (left/right).");
  }
  if (!Array.isArray(pos)) throw new Error("proof.positions array olmalı.");

  if (pos.length !== n) {
    throw new Error(
      `positions uzunluğu (${pos.length}) siblings uzunluğuna (${n}) eşit olmalı.`
    );
  }

  // boolean[] format: true=left, false=right
  if (typeof pos[0] === "boolean") {
    return (pos as boolean[]).map((b) => (b ? "left" : "right"));
  }

  return (pos as any[]).map((x) => {
    if (x !== "left" && x !== "right") {
      throw new Error(`positions elemanı left/right olmalı. Aldım: ${x}`);
    }
    return x;
  });
}

function loadLeafInput(leafObj: any): LeafInput {
  assertInteger(leafObj.as_of_timestamp, "as_of_timestamp");
  assertInteger(leafObj.fine_weight_g, "fine_weight_g");

  const fineness = String(leafObj.fineness);
  const refiner = String(leafObj.refiner);
  const serial_no = String(leafObj.serial_no);
  const vault_id = String(leafObj.vault_id);

  return {
    as_of_timestamp: leafObj.as_of_timestamp,
    fineness,
    fine_weight_g: leafObj.fine_weight_g,
    refiner,
    serial_no,
    vault_id,
  };
}

function verifyProof(leafHashHex: string, proof: ProofFile, root: string): boolean {
  assertBytes32Hex(root, "root");

  let h = leafHashHex;
  assertBytes32Hex(h, "leaf_hash");

  const siblings = proof.siblings ?? [];
  if (!Array.isArray(siblings) || siblings.length === 0) {
    // no siblings: tree must have been single leaf
    return h.toLowerCase() === root.toLowerCase();
  }

  const positions = normalizePositions(proof.positions, siblings.length);

  for (let i = 0; i < siblings.length; i++) {
    const s = siblings[i];
    assertBytes32Hex(s, `siblings[${i}]`);
    const pos = positions[i];

    if (pos === "left") {
      h = nodeHash(s, h);
    } else {
      h = nodeHash(h, s);
    }
  }

  return h.toLowerCase() === root.toLowerCase();
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const leafPath = args.leaf as string | undefined;
  const proofPath = args.proof as string | undefined;
  const root = args.root as string | undefined;

  if (!leafPath || !proofPath || !root) usageAndExit(1);

  const leafObj = readJson(leafPath);
  const proofObj = readJson(proofPath) as ProofFile;

  if (!proofObj || typeof proofObj !== "object") throw new Error("proof.json object değil.");
  if (!Array.isArray(proofObj.siblings)) throw new Error("proof.siblings array değil.");

  const leafInput = loadLeafInput(leafObj);

  // FIX: leafHash LeafInput ister (string değil)
  const lh = leafHash(leafInput);

  const ok = verifyProof(lh, proofObj, root);

  // eslint-disable-next-line no-console
  console.log(ok ? "OK: proof valid" : "FAIL: proof invalid");

  process.exit(ok ? 0 : 1);
}

main();
