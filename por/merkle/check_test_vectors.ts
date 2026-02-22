/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import { fileKeccak256Hex, leafHash, nodeHash } from "./hash_utils.ts";
import type { LeafInput } from "./hash_utils.ts";

type Vector = {
  schema_version: string;
  report_id: string;
  as_of_timestamp: number;
  bar_list_path: string;
  expected: {
    bar_list_hash: string;
    merkle_root: string;
    leaf_hashes?: Record<string, string>; // serial_no -> bytes32
    proofs?: Record<
      string,
      { siblings: string[]; positions: Array<"left" | "right"> | boolean[] }
    >;
  };
};

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(path.resolve(p), "utf8"));
}

function bytesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function canonicalSortBars(bars: any[]) {
  return [...bars].sort((a, b) => {
    if (a.serial_no !== b.serial_no) return String(a.serial_no).localeCompare(String(b.serial_no));
    if (a.refiner !== b.refiner) return String(a.refiner).localeCompare(String(b.refiner));
    return String(a.vault_id).localeCompare(String(b.vault_id));
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

function normalizePositions(pos: any, n: number): Array<"left" | "right"> {
  if (!Array.isArray(pos) || pos.length !== n) throw new Error("positions format hatalı.");
  if (typeof pos[0] === "boolean") return (pos as boolean[]).map((b) => (b ? "left" : "right"));
  return (pos as any[]).map((x) => (x === "left" ? "left" : x === "right" ? "right" : (() => { throw new Error("positions left/right olmalı."); })()));
}

function verifyProof(leafHashHex: string, siblings: string[], positions: any, root: string): boolean {
  let h = leafHashHex;
  const pos = normalizePositions(positions, siblings.length);
  for (let i = 0; i < siblings.length; i++) {
    h = pos[i] === "left" ? nodeHash(siblings[i], h) : nodeHash(h, siblings[i]);
  }
  return bytesEqual(h, root);
}

function main() {
  const vectorPath = process.argv[2] ?? "por/merkle/test_vectors/v0.1_demo.json";
  const v = readJson(vectorPath) as Vector;

  const barListAbs = path.resolve(v.bar_list_path);
  const barListBytes = fs.readFileSync(barListAbs);
  const barList = JSON.parse(barListBytes.toString("utf8"));

  const bar_list_hash = fileKeccak256Hex(barListBytes);
  if (!bytesEqual(bar_list_hash, v.expected.bar_list_hash)) {
    throw new Error(`bar_list_hash mismatch\nexpected: ${v.expected.bar_list_hash}\nactual:   ${bar_list_hash}`);
  }

  const bars = canonicalSortBars(barList.bars);
  const leafHashes: string[] = [];
  const leafBySerial: Record<string, string> = {};

  for (const b of bars) {
    const leaf: LeafInput = {
      as_of_timestamp: barList.as_of_timestamp,
      fineness: b.fineness,
      fine_weight_g: b.fine_weight_g,
      refiner: b.refiner,
      serial_no: b.serial_no,
      vault_id: b.vault_id,
    };
    const lh = leafHash(leaf);
    leafHashes.push(lh);
    leafBySerial[String(b.serial_no)] = lh;
  }

  const merkle_root = buildMerkleRootFromLeaves(leafHashes);
  if (!bytesEqual(merkle_root, v.expected.merkle_root)) {
    throw new Error(`merkle_root mismatch\nexpected: ${v.expected.merkle_root}\nactual:   ${merkle_root}`);
  }

  if (v.expected.leaf_hashes) {
    for (const [serial, expected] of Object.entries(v.expected.leaf_hashes)) {
      const actual = leafBySerial[serial];
      if (!actual) throw new Error(`leaf missing for serial_no=${serial}`);
      if (!bytesEqual(actual, expected)) {
        throw new Error(`leaf_hash mismatch for ${serial}\nexpected: ${expected}\nactual:   ${actual}`);
      }
    }
  }

  if (v.expected.proofs) {
    for (const [serial, p] of Object.entries(v.expected.proofs)) {
      const lh = leafBySerial[serial];
      if (!lh) throw new Error(`proof leaf missing for serial_no=${serial}`);
      const ok = verifyProof(lh, p.siblings, p.positions, v.expected.merkle_root);
      if (!ok) throw new Error(`proof verify FAIL for ${serial}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log("OK: test vector matches (bar_list_hash, merkle_root, leaf_hashes, proofs)");
}

main();