/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import * as ethers from "ethers";

import {
  fileKeccak256Hex,
  leafHash,
  nodeHash,
  assertBytes32Hex,
  normalizeAddress,
  reportIdToBytes32,
} from "../por/merkle/hash_utils.ts";

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

type PorOutput = {
  schema_version: "0.1";
  report_id: string;
  as_of_timestamp: number;
  bars_count: number;
  attested_fine_gold_grams: number;
  bar_list_hash: string;
  merkle_root: string;
};

type Attestation = {
  schema_version: "0.1";
  report_id: string;
  as_of_timestamp: number;
  attested_fine_gold_grams: number;
  merkle_root: string; // bytes32
  bar_list_hash: string; // bytes32
  chain_id: number;
  reserve_registry_address: string;
  signer_address: string;
  signature_scheme: "eip712";
  eip712_domain: {
    name: "GRUSH Reserve Attestation";
    version: "1";
    chainId: number;
    verifyingContract: string;
  };
  eip712_types_version: "0.1";
  signature: string; // 65 bytes hex
};

type PublishReceipt = {
  registry?: string;
  chainId?: number;
  reportId?: string;
  report_id?: string;
  txHash?: string;
  blockNumber?: number;
  status?: number;
  mined?: boolean;
};

const REGISTRY_ABI = [
  "function exists(bytes32 reportId) external view returns (bool)",
  "function getAttestation(bytes32 reportId) external view returns (tuple(uint64 asOfTimestamp,uint64 publishedAt,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash,address signer))",
  "event AttestationPublished(bytes32 indexed reportId,uint64 indexed asOfTimestamp,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash,address indexed signer,uint64 publishedAt)",
];

function usageAndExit(code = 1): never {
  // eslint-disable-next-line no-console
  console.error(`
Usage:
  npm run verify:snapshot -- <report_id> [--base <path>] [--rpc <RPC_URL>] [--receipt <path>] [--quiet]

Defaults:
  --base transparency
  --rpc: RPC_URL env -> SEPOLIA_RPC_URL env -> MAINNET_RPC_URL env

Checks (local):
  1) bar_list.json exists and is schema_version 0.1
  2) por_output.json matches recomputed bar_list_hash + merkle_root (+ totals rule)
  3) attestation*.json matches por_output fields and EIP-712 signature verifies

Optional (on-chain):
  - If publish_receipt.json exists (auto) or --receipt provided:
    - tx receipt fetched and status=1
    - AttestationPublished event cross-check
    - contract state getAttestation cross-check

Expected M1 layout:
  <base>/barlists/<report_id>/bar_list.json
  <base>/reserve_reports/<report_id>/por_output.json
  <base>/attestations/<report_id>/attestation.json   (or attestation.sepolia.json)

Exit codes:
  0 = OK
  1 = FAIL
`);
  process.exit(code);
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  // positional support: first non-flag after script path
  let positional: string | null = null;

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;

    if (!a.startsWith("--") && positional == null) {
      positional = a;
      continue;
    }

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

  if (positional && !args.report_id && !args.reportId && !args.id) {
    args.report_id = positional;
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
  if (j.schema_version !== "0.1") throw new Error("bar_list.schema_version 0.1 değil.");
  if (typeof j.report_id !== "string" || !j.report_id) throw new Error("bar_list.report_id invalid.");
  assertInteger(j.as_of_timestamp, "bar_list.as_of_timestamp");
  if (!j.custodian || typeof j.custodian !== "object") throw new Error("bar_list.custodian yok.");
  if (typeof j.custodian.name !== "string") throw new Error("bar_list.custodian.name yok.");
  if (typeof j.custodian.location !== "string") throw new Error("bar_list.custodian.location yok.");
  if (!Array.isArray(j.bars) || j.bars.length < 1) throw new Error("bar_list.bars[] boş.");

  for (const b of j.bars) {
    if (typeof b.serial_no !== "string") throw new Error("bar.serial_no yok.");
    if (typeof b.refiner !== "string") throw new Error("bar.refiner yok.");
    if (typeof b.fineness !== "string") throw new Error("bar.fineness yok.");
    assertInteger(b.fine_weight_g, "bar.fine_weight_g");
    if (typeof b.vault_id !== "string") throw new Error("bar.vault_id yok.");
    if (b.allocation_status !== "allocated") throw new Error("bar.allocation_status allocated olmalı (v0.1).");
  }

  if (j.totals != null) {
    if (typeof j.totals !== "object") throw new Error("bar_list.totals object değil.");
    if (j.totals.fine_gold_grams != null) assertInteger(j.totals.fine_gold_grams, "totals.fine_gold_grams");
    if (j.totals.bars_count != null) assertInteger(j.totals.bars_count, "totals.bars_count");
  }

  return j as BarList;
}

function basicValidatePorOutput(j: any): PorOutput {
  if (!j || typeof j !== "object") throw new Error("por_output JSON object değil.");
  if (j.schema_version !== "0.1") throw new Error("por_output.schema_version 0.1 değil.");
  if (typeof j.report_id !== "string" || !j.report_id) throw new Error("por_output.report_id invalid.");
  assertInteger(j.as_of_timestamp, "por_output.as_of_timestamp");
  assertInteger(j.bars_count, "por_output.bars_count");
  assertInteger(j.attested_fine_gold_grams, "por_output.attested_fine_gold_grams");
  if (typeof j.bar_list_hash !== "string") throw new Error("por_output.bar_list_hash invalid.");
  if (typeof j.merkle_root !== "string") throw new Error("por_output.merkle_root invalid.");
  assertBytes32Hex(j.bar_list_hash, "por_output.bar_list_hash");
  assertBytes32Hex(j.merkle_root, "por_output.merkle_root");
  return j as PorOutput;
}

function assertSig65(sig: string) {
  if (typeof sig !== "string") throw new Error("signature string değil.");
  if (!/^0x[a-fA-F0-9]{130}$/.test(sig)) {
    throw new Error("signature 65-byte hex değil (0x + 130 hex).");
  }
}

function basicValidateAttestation(j: any): Attestation {
  if (!j || typeof j !== "object") throw new Error("attestation JSON object değil.");
  if (j.schema_version !== "0.1") throw new Error("attestation.schema_version 0.1 değil.");
  if (j.signature_scheme !== "eip712") throw new Error("attestation.signature_scheme eip712 değil.");
  if (j.eip712_types_version !== "0.1") throw new Error("attestation.eip712_types_version 0.1 değil.");

  if (typeof j.report_id !== "string" || !j.report_id) throw new Error("attestation.report_id invalid.");
  assertInteger(j.as_of_timestamp, "attestation.as_of_timestamp");
  assertInteger(j.attested_fine_gold_grams, "attestation.attested_fine_gold_grams");
  assertInteger(j.chain_id, "attestation.chain_id");

  if (typeof j.merkle_root !== "string") throw new Error("attestation.merkle_root invalid.");
  if (typeof j.bar_list_hash !== "string") throw new Error("attestation.bar_list_hash invalid.");
  assertBytes32Hex(j.merkle_root, "attestation.merkle_root");
  assertBytes32Hex(j.bar_list_hash, "attestation.bar_list_hash");

  if (typeof j.reserve_registry_address !== "string") throw new Error("attestation.reserve_registry_address invalid.");
  if (typeof j.signer_address !== "string") throw new Error("attestation.signer_address invalid.");
  normalizeAddress(j.reserve_registry_address);
  normalizeAddress(j.signer_address);
  assertSig65(j.signature);

  if (!j.eip712_domain || typeof j.eip712_domain !== "object") throw new Error("attestation.eip712_domain missing.");
  if (j.eip712_domain.name !== "GRUSH Reserve Attestation") throw new Error("attestation.domain.name mismatch.");
  if (j.eip712_domain.version !== "1") throw new Error("attestation.domain.version mismatch.");
  assertInteger(j.eip712_domain.chainId, "attestation.domain.chainId");
  normalizeAddress(j.eip712_domain.verifyingContract);

  return j as Attestation;
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
    for (let i = 0; i < level.length; i += 2) next.push(nodeHash(level[i], level[i + 1]));
    level = next;
  }
  return level[0];
}

function sumFineGoldGrams(bars: BarEntry[]): number {
  let sum = 0;
  for (const b of bars) sum += b.fine_weight_g;
  return sum;
}

function recomputeFromBarList(barList: BarList, barListFileBytes: Uint8Array) {
  const bars = canonicalSortBars(barList.bars);
  const leaves: string[] = [];
  for (const b of bars) {
    leaves.push(
      leafHash({
        as_of_timestamp: barList.as_of_timestamp,
        fineness: b.fineness,
        fine_weight_g: b.fine_weight_g,
        refiner: b.refiner,
        serial_no: b.serial_no,
        vault_id: b.vault_id,
      })
    );
  }

  const merkle_root = buildMerkleRootFromLeaves(leaves);
  const attested_fine_gold_grams = barList.totals?.fine_gold_grams ?? sumFineGoldGrams(bars);
  const bar_list_hash = fileKeccak256Hex(barListFileBytes);

  return {
    report_id: barList.report_id,
    as_of_timestamp: barList.as_of_timestamp,
    bars_count: bars.length,
    attested_fine_gold_grams,
    bar_list_hash,
    merkle_root,
  } as const;
}

function getVerifyTypedDataFn() {
  const v6 = (ethers as any).verifyTypedData;
  if (typeof v6 === "function") return v6;
  const v5 = (ethers as any).utils?.verifyTypedData;
  if (typeof v5 === "function") return v5;
  throw new Error("ethers verifyTypedData bulunamadı (ethers v5/v6 uyumsuz?).");
}

function verifyAttestationSignature(att: Attestation): string {
  const registry = normalizeAddress(att.reserve_registry_address);
  const signer = normalizeAddress(att.signer_address);

  if (att.chain_id !== att.eip712_domain.chainId) {
    throw new Error(`attestation.chain_id (${att.chain_id}) != domain.chainId (${att.eip712_domain.chainId})`);
  }
  if (normalizeAddress(att.eip712_domain.verifyingContract) !== registry) {
    throw new Error("attestation.domain.verifyingContract reserve_registry_address ile uyuşmuyor.");
  }

  const domain = {
    name: "GRUSH Reserve Attestation",
    version: "1",
    chainId: att.chain_id,
    verifyingContract: registry,
  };

  const types = {
    ReserveAttestation: [
      { name: "reportId", type: "bytes32" },
      { name: "asOfTimestamp", type: "uint64" },
      { name: "attestedFineGoldGrams", type: "uint256" },
      { name: "merkleRoot", type: "bytes32" },
      { name: "barListHash", type: "bytes32" },
    ],
  };

  const message = {
    reportId: reportIdToBytes32(att.report_id),
    asOfTimestamp: att.as_of_timestamp,
    attestedFineGoldGrams: att.attested_fine_gold_grams,
    merkleRoot: att.merkle_root,
    barListHash: att.bar_list_hash,
  };

  const verifyTypedData = getVerifyTypedDataFn();
  const recovered = normalizeAddress(verifyTypedData(domain, types, message, att.signature));
  if (recovered !== signer) {
    throw new Error(`Recovered signer mismatch. recovered=${recovered}, attestation.signer_address=${signer}`);
  }
  return recovered;
}

function getProvider(rpcUrl: string) {
  const v6 = (ethers as any).JsonRpcProvider;
  if (typeof v6 === "function") return new v6(rpcUrl);

  const v5 = (ethers as any).providers?.JsonRpcProvider;
  if (typeof v5 === "function") return new v5(rpcUrl);

  throw new Error("ethers JsonRpcProvider bulunamadı (ethers v5/v6 uyumsuz?).");
}

function getInterface() {
  const I = (ethers as any).Interface ?? (ethers as any).utils?.Interface;
  if (!I) throw new Error("ethers Interface bulunamadı (ethers v5/v6 uyumsuz?).");
  return new I(REGISTRY_ABI);
}

function getContract(addr: string, provider: any) {
  const C = (ethers as any).Contract ?? (ethers as any).contracts?.Contract;
  if (!C) throw new Error("ethers Contract bulunamadı (ethers v5/v6 uyumsuz?).");
  return new C(addr, REGISTRY_ABI, provider);
}

function coerceAttestationRecord(rec: any) {
  if (!rec) return null;
  const asOfTimestamp = (rec.asOfTimestamp ?? rec[0]) as any;
  const publishedAt = (rec.publishedAt ?? rec[1]) as any;
  const attestedFineGoldGrams = (rec.attestedFineGoldGrams ?? rec[2]) as any;
  const merkleRoot = (rec.merkleRoot ?? rec[3]) as any;
  const barListHash = (rec.barListHash ?? rec[4]) as any;
  const signer = (rec.signer ?? rec[5]) as any;

  return {
    asOfTimestamp: asOfTimestamp?.toString?.() ?? asOfTimestamp,
    publishedAt: publishedAt?.toString?.() ?? publishedAt,
    attestedFineGoldGrams: attestedFineGoldGrams?.toString?.() ?? attestedFineGoldGrams,
    merkleRoot,
    barListHash,
    signer,
  };
}

function tryFindReceiptPath(attDirAbs: string): string | null {
  const candidates = [
    path.join(attDirAbs, "publish_receipt.json"),
    path.join(process.cwd(), "por", "reports", "publish_receipt.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function readJson<T>(p: string): T {
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
}

function pickAttestationPath(attDirAbs: string, wantChainId?: number): string {
  const cands = [
    path.join(attDirAbs, "attestation.sepolia.json"),
    path.join(attDirAbs, "attestation.json"),
  ].filter((p) => fs.existsSync(p));

  if (cands.length === 0) throw new Error(`Attestation bulunamadı: ${attDirAbs}`);

  if (wantChainId != null) {
    for (const p of cands) {
      try {
        const j = readJson<any>(p);
        if (typeof j?.chain_id === "number" && j.chain_id === wantChainId) return p;
      } catch {}
    }
  }

  // prefer sepolia variant if exists
  const sepolia = path.join(attDirAbs, "attestation.sepolia.json");
  if (fs.existsSync(sepolia)) return sepolia;

  return cands[0];
}

async function verifyOnchain(att: Attestation, receiptPath: string, rpc: string) {
  const rc = readJson<PublishReceipt>(receiptPath);

  const registry = normalizeAddress(att.reserve_registry_address);
  const rid = reportIdToBytes32(att.report_id);

  if (rc.registry) {
    const rcr = normalizeAddress(rc.registry);
    if (rcr !== registry) throw new Error(`Receipt registry mismatch. receipt=${rcr}, attestation=${registry}`);
  }
  if (typeof rc.chainId === "number" && rc.chainId !== att.chain_id) {
    throw new Error(`Receipt chainId mismatch. receipt=${rc.chainId}, attestation.chain_id=${att.chain_id}`);
  }

  const txHash = (rc.txHash || "").trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error(`Receipt txHash invalid: ${rc.txHash}`);

  const provider = getProvider(rpc);
  const net = await provider.getNetwork();
  const chainId = Number((net as any).chainId ?? (net as any).chainId?.toString?.());
  if (chainId !== att.chain_id) throw new Error(`RPC chainId mismatch. rpc=${chainId}, attestation.chain_id=${att.chain_id}`);

  const txr = await provider.getTransactionReceipt(txHash);
  if (!txr) throw new Error(`Tx receipt bulunamadı (mined değil olabilir): ${txHash}`);
  const status = Number((txr as any).status ?? -1);
  if (status !== 1) throw new Error(`Tx status != 1. status=${status} tx=${txHash}`);

  if (rc.blockNumber != null) {
    const bn = Number((txr as any).blockNumber ?? -1);
    if (bn !== Number(rc.blockNumber)) throw new Error(`blockNumber mismatch. receipt=${rc.blockNumber}, rpc=${bn}`);
  }

  // event parse
  const iface = getInterface();
  let ev: any = null;

  const logs = (txr as any).logs ?? [];
  for (const lg of logs) {
    const addr = normalizeAddress((lg as any).address);
    if (addr !== registry) continue;

    try {
      const parsed = iface.parseLog(lg);
      if (parsed && parsed.name === "AttestationPublished") {
        ev = parsed;
        break;
      }
    } catch {
      // ignore non-matching logs
    }
  }

  if (!ev) throw new Error("AttestationPublished event bulunamadı (log parse).");

  const a = ev.args;
  const evReportId = (a.reportId ?? a[0]) as string;
  const evAsOf = (a.asOfTimestamp ?? a[1]) as any;
  const evGrams = (a.attestedFineGoldGrams ?? a[2]) as any;
  const evMerkle = (a.merkleRoot ?? a[3]) as string;
  const evBarHash = (a.barListHash ?? a[4]) as string;
  const evSigner = (a.signer ?? a[5]) as string;
  const evPublishedAt = (a.publishedAt ?? a[6]) as any;

  if (String(evReportId).toLowerCase() !== String(rid).toLowerCase()) throw new Error("Event reportId mismatch.");
  if (String(evAsOf?.toString?.() ?? evAsOf) !== String(att.as_of_timestamp)) throw new Error("Event asOfTimestamp mismatch.");
  if (String(evGrams?.toString?.() ?? evGrams) !== String(att.attested_fine_gold_grams)) throw new Error("Event attestedFineGoldGrams mismatch.");
  if (String(evMerkle).toLowerCase() !== String(att.merkle_root).toLowerCase()) throw new Error("Event merkleRoot mismatch.");
  if (String(evBarHash).toLowerCase() !== String(att.bar_list_hash).toLowerCase()) throw new Error("Event barListHash mismatch.");
  if (normalizeAddress(evSigner) !== normalizeAddress(att.signer_address)) throw new Error("Event signer mismatch.");

  // state cross-check
  const c = getContract(registry, provider);
  const exists = await c.exists(rid);
  if (!exists) throw new Error(`On-chain attestation yok: ${rid}`);

  const rec = await c.getAttestation(rid);
  const norm = coerceAttestationRecord(rec);

  if (String(norm.asOfTimestamp) !== String(att.as_of_timestamp)) throw new Error("On-chain asOfTimestamp mismatch.");
  if (String(norm.attestedFineGoldGrams) !== String(att.attested_fine_gold_grams)) throw new Error("On-chain attestedFineGoldGrams mismatch.");
  if (String(norm.merkleRoot).toLowerCase() !== String(att.merkle_root).toLowerCase()) throw new Error("On-chain merkleRoot mismatch.");
  if (String(norm.barListHash).toLowerCase() !== String(att.bar_list_hash).toLowerCase()) throw new Error("On-chain barListHash mismatch.");
  if (normalizeAddress(norm.signer) !== normalizeAddress(att.signer_address)) throw new Error("On-chain signer mismatch.");

  const publishedAtStr = evPublishedAt?.toString?.() ?? evPublishedAt;
  const statusBn = Number((txr as any).blockNumber ?? null);

  return {
    ok: true,
    receipt_path: path.relative(process.cwd(), receiptPath),
    txHash,
    blockNumber: statusBn,
    status: 1,
    event: {
      reportId: evReportId,
      asOfTimestamp: evAsOf?.toString?.() ?? evAsOf,
      attestedFineGoldGrams: evGrams?.toString?.() ?? evGrams,
      merkleRoot: evMerkle,
      barListHash: evBarHash,
      signer: evSigner,
      publishedAt: publishedAtStr,
    },
    record: norm,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const report_id = (args.report_id as string) || (args.reportId as string) || (args.id as string) || "";
  if (!report_id) usageAndExit(1);

  const base = (args.base as string) || "transparency";
  const quiet = Boolean(args.quiet);

  const rpc =
    (args.rpc as string) ||
    process.env.RPC_URL ||
    process.env.SEPOLIA_RPC_URL ||
    process.env.MAINNET_RPC_URL ||
    "";

  const baseAbs = path.isAbsolute(base) ? base : path.join(process.cwd(), base);

  const barListPath = path.join(baseAbs, "barlists", report_id, "bar_list.json");
  const porOutPath = path.join(baseAbs, "reserve_reports", report_id, "por_output.json");
  const attDirAbs = path.join(baseAbs, "attestations", report_id);

  // 1) bar list
  const barListBytes = fs.readFileSync(barListPath);
  const barListJson = JSON.parse(barListBytes.toString("utf8"));
  const barList = basicValidateBarList(barListJson);
  if (barList.report_id !== report_id) {
    throw new Error(`bar_list.report_id mismatch. file=${barList.report_id}, arg=${report_id}`);
  }

  const recomputed = recomputeFromBarList(barList, new Uint8Array(barListBytes));

  // 2) por_output
  const porOutRaw = fs.readFileSync(porOutPath, "utf8");
  const porOut = basicValidatePorOutput(JSON.parse(porOutRaw));
  if (porOut.report_id !== report_id) throw new Error(`por_output.report_id mismatch. file=${porOut.report_id}, arg=${report_id}`);

  if (porOut.as_of_timestamp !== recomputed.as_of_timestamp) {
    throw new Error(`as_of_timestamp mismatch. por_output=${porOut.as_of_timestamp}, recomputed=${recomputed.as_of_timestamp}`);
  }
  if (porOut.bars_count !== recomputed.bars_count) {
    throw new Error(`bars_count mismatch. por_output=${porOut.bars_count}, recomputed=${recomputed.bars_count}`);
  }
  if (porOut.attested_fine_gold_grams !== recomputed.attested_fine_gold_grams) {
    throw new Error(`attested_fine_gold_grams mismatch. por_output=${porOut.attested_fine_gold_grams}, recomputed=${recomputed.attested_fine_gold_grams}`);
  }
  if (porOut.bar_list_hash !== recomputed.bar_list_hash) {
    throw new Error(`bar_list_hash mismatch. por_output=${porOut.bar_list_hash}, recomputed=${recomputed.bar_list_hash}`);
  }
  if (porOut.merkle_root !== recomputed.merkle_root) {
    throw new Error(`merkle_root mismatch. por_output=${porOut.merkle_root}, recomputed=${recomputed.merkle_root}`);
  }

  // 3) attestation (auto-pick)
  const receiptArg = (args.receipt as string) || "";
  const autoReceipt = receiptArg ? null : tryFindReceiptPath(attDirAbs);
  const receiptPathAbs = (receiptArg || autoReceipt || "").trim();

  let wantChain: number | undefined = undefined;
  if (receiptPathAbs) {
    try {
      const rc = readJson<PublishReceipt>(receiptPathAbs);
      if (typeof rc.chainId === "number") wantChain = rc.chainId;
    } catch {}
  }

  const attPath = pickAttestationPath(attDirAbs, wantChain);
  const attRaw = fs.readFileSync(attPath, "utf8");
  const att = basicValidateAttestation(JSON.parse(attRaw));
  if (att.report_id !== report_id) throw new Error(`attestation.report_id mismatch. file=${att.report_id}, arg=${report_id}`);

  // field-level binding
  if (att.as_of_timestamp !== porOut.as_of_timestamp) throw new Error("attestation.as_of_timestamp != por_output.as_of_timestamp");
  if (att.attested_fine_gold_grams !== porOut.attested_fine_gold_grams) throw new Error("attestation.attested_fine_gold_grams != por_output.attested_fine_gold_grams");
  if (att.merkle_root !== porOut.merkle_root) throw new Error("attestation.merkle_root != por_output.merkle_root");
  if (att.bar_list_hash !== porOut.bar_list_hash) throw new Error("attestation.bar_list_hash != por_output.bar_list_hash");

  const recovered = verifyAttestationSignature(att);

  // 4) optional on-chain
  let onchain: any = null;
  if (receiptPathAbs) {
    if (!rpc) throw new Error(`publish_receipt.json bulundu ama RPC yok. --rpc ver veya RPC_URL/SEPOLIA_RPC_URL env set et. receipt=${receiptPathAbs}`);
    onchain = await verifyOnchain(att, receiptPathAbs, rpc);
  }

  if (!quiet) {
    const out: any = {
      ok: true,
      report_id,
      recovered_signer: recovered,
      chain_id: att.chain_id,
      registry: normalizeAddress(att.reserve_registry_address),
      paths: {
        bar_list: path.relative(process.cwd(), barListPath),
        por_output: path.relative(process.cwd(), porOutPath),
        attestation: path.relative(process.cwd(), attPath),
      },
    };
    if (receiptPathAbs) out.paths.receipt = path.relative(process.cwd(), receiptPathAbs);
    if (onchain) out.onchain = onchain;

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out, null, 2));
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`FAIL: ${e?.message ?? String(e)}`);
  process.exit(1);
});