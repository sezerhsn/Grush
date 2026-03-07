/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import * as ethers from "ethers";
import {
  assertBytes32Hex,
  normalizeAddress,
  reportIdToBytes32,
} from "../merkle/hash_utils";

type Attestation = {
  schema_version: "0.1";
  report_id: string;
  as_of_timestamp: number;
  attested_fine_gold_grams: string; // uint256 decimal string
  merkle_root: string;
  bar_list_hash: string;
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
  signature: string;
};

type PublishReceipt = {
  txHash: string;
  chainId: number;
  registry: string;
  publishedReportId: string;
  blockNumber: number;
  status: number;
};

const ABI = [
  "function getAttestation(bytes32 reportId) external view returns (tuple(uint64 asOfTimestamp,uint64 publishedAt,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash,address signer))",
  "function exists(bytes32 reportId) external view returns (bool)",
  "event AttestationPublished(bytes32 indexed reportId,uint64 indexed asOfTimestamp,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash,address indexed signer,uint64 publishedAt)",
];

function usageAndExit(code = 1): never {
  // eslint-disable-next-line no-console
  console.error(`
Usage:
  ts-node --esm por/attestation/verify_onchain.ts --attestation <attestation.json> --receipt <publish_receipt.json> --rpc <RPC_URL>

What it checks (hard fail on mismatch):
- provider chainId == receipt.chainId == attestation.chain_id
- receipt.status == 1
- tx receipt blockNumber matches receipt.blockNumber
- tx emits AttestationPublished with fields exactly matching attestation
- registry.getAttestation(reportId) matches attestation fields

Exit codes:
  0 = OK
  1 = FAIL
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

const MAX_SAFE_INTEGER = 9007199254740991;

function assertInteger(n: any, name: string) {
  if (typeof n !== "number" || !Number.isSafeInteger(n)) {
    throw new Error(`${name} integer olmalı (safe). Aldım: ${n}`);
  }
}

function coerceUint256DecimalString(v: any, name: string): string {
  if (typeof v === "string") {
    const s = v.trim();
    if (/^[1-9][0-9]*$/.test(s)) return s;
    throw new Error(`${name} uint256 decimal string olmalı (>=1). Aldım: ${v}`);
  }
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 1) {
      throw new Error(`${name} integer olmalı ve <= MAX_SAFE_INTEGER (${MAX_SAFE_INTEGER}). Aldım: ${v}`);
    }
    return String(v);
  }
  throw new Error(`${name} uint256 decimal string olmalı. Aldım: ${typeof v}`);
}

function assertHexBytes32(s: any, name: string) {
  if (typeof s !== "string") throw new Error(`${name} string değil.`);
  assertBytes32Hex(s, name);
}

function readJson<T>(p: string): T {
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
}

function loadAttestation(j: any): Attestation {
  if (!j || typeof j !== "object") throw new Error("Attestation JSON object değil.");
  if (j.schema_version !== "0.1") throw new Error("schema_version 0.1 değil.");
  if (j.signature_scheme !== "eip712") throw new Error("signature_scheme eip712 değil.");
  if (j.eip712_types_version !== "0.1") throw new Error("eip712_types_version 0.1 değil.");

  if (typeof j.report_id !== "string" || !j.report_id) throw new Error("report_id invalid.");
  assertInteger(j.as_of_timestamp, "as_of_timestamp");
  j.attested_fine_gold_grams = coerceUint256DecimalString(j.attested_fine_gold_grams, "attested_fine_gold_grams");
  assertInteger(j.chain_id, "chain_id");

  assertHexBytes32(j.merkle_root, "merkle_root");
  assertHexBytes32(j.bar_list_hash, "bar_list_hash");

  j.reserve_registry_address = normalizeAddress(j.reserve_registry_address);
  j.signer_address = normalizeAddress(j.signer_address);

  if (!j.eip712_domain || typeof j.eip712_domain !== "object") throw new Error("eip712_domain missing.");
  if (j.eip712_domain.name !== "GRUSH Reserve Attestation") throw new Error("domain.name mismatch.");
  if (j.eip712_domain.version !== "1") throw new Error("domain.version mismatch.");
  assertInteger(j.eip712_domain.chainId, "domain.chainId");
  j.eip712_domain.verifyingContract = normalizeAddress(j.eip712_domain.verifyingContract);

  if (j.eip712_domain.verifyingContract !== j.reserve_registry_address) {
    throw new Error("eip712_domain.verifyingContract reserve_registry_address ile uyuşmuyor.");
  }
  if (j.eip712_domain.chainId !== j.chain_id) {
    throw new Error("eip712_domain.chainId chain_id ile uyuşmuyor.");
  }

  return j as Attestation;
}

function loadReceipt(j: any): PublishReceipt {
  if (!j || typeof j !== "object") throw new Error("Receipt JSON object değil.");

  if (typeof j.txHash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(j.txHash)) {
    throw new Error("receipt.txHash invalid.");
  }
  assertInteger(j.chainId, "receipt.chainId");
  j.registry = normalizeAddress(j.registry);
  assertHexBytes32(j.publishedReportId, "receipt.publishedReportId");
  assertInteger(j.blockNumber, "receipt.blockNumber");
  assertInteger(j.status, "receipt.status");

  return {
    txHash: j.txHash,
    chainId: j.chainId,
    registry: j.registry,
    publishedReportId: j.publishedReportId,
    blockNumber: j.blockNumber,
    status: j.status,
  };
}

function getProvider(rpcUrl: string) {
  const v6 = (ethers as any).JsonRpcProvider;
  if (typeof v6 === "function") return new v6(rpcUrl);

  const v5 = (ethers as any).providers?.JsonRpcProvider;
  if (typeof v5 === "function") return new v5(rpcUrl);

  throw new Error("ethers JsonRpcProvider bulunamadı (ethers v5/v6 uyumsuz?).");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const attPath = (args.attestation as string) || "";
  const receiptPath = (args.receipt as string) || "";
  const rpc = (args.rpc as string) || process.env.RPC_URL || "";

  if (!attPath || !receiptPath || !rpc) usageAndExit(1);

  const att = loadAttestation(readJson<any>(attPath));
  const rc = loadReceipt(readJson<any>(receiptPath));

  const expectedReportId = reportIdToBytes32(att.report_id);
  if (expectedReportId.toLowerCase() !== rc.publishedReportId.toLowerCase()) {
    throw new Error(`publishedReportId mismatch. receipt=${rc.publishedReportId} expected=${expectedReportId}`);
  }

  if (normalizeAddress(att.reserve_registry_address) !== normalizeAddress(rc.registry)) {
    throw new Error(`registry mismatch. receipt=${rc.registry} attestation=${att.reserve_registry_address}`);
  }

  const provider = getProvider(rpc);
  const net = await provider.getNetwork();
  const providerChainId = Number((net as any).chainId ?? (net as any).chainId?.toString?.());
  if (providerChainId !== att.chain_id || providerChainId !== rc.chainId) {
    throw new Error(`chainId mismatch. provider=${providerChainId} attestation=${att.chain_id} receipt=${rc.chainId}`);
  }

  const txReceipt = await provider.getTransactionReceipt(rc.txHash);
  if (!txReceipt) throw new Error(`Tx receipt not found for txHash=${rc.txHash}`);

  const txBlockNumber = Number((txReceipt as any).blockNumber ?? 0);
  const txStatus = Number((txReceipt as any).status ?? 0);
  if (txBlockNumber !== rc.blockNumber) {
    throw new Error(`blockNumber mismatch. chain=${txBlockNumber} receipt=${rc.blockNumber}`);
  }
  if (txStatus !== rc.status) {
    throw new Error(`status mismatch. chain=${txStatus} receipt=${rc.status}`);
  }
  if (txStatus !== 1) {
    throw new Error(`tx status != 1. status=${txStatus}`);
  }

  const registry = new (ethers as any).Contract(rc.registry, ABI, provider);

  const exists = await registry.exists(rc.publishedReportId);
  if (!exists) throw new Error("registry.exists(reportId) false (state mismatch).");

  // 1) Event cross-check
  const InterfaceCtor = (ethers as any).Interface ?? (ethers as any).utils?.Interface;
  if (!InterfaceCtor) throw new Error("ethers Interface bulunamadı (ethers v5/v6 uyumsuz?).");
  const iface = new InterfaceCtor(ABI);
  const eventTopic = iface.getEvent("AttestationPublished").topicHash;
  const logs = (txReceipt as any).logs ?? [];

  const matchingLogs = logs.filter((lg: any) =>
    lg?.address && normalizeAddress(lg.address) === normalizeAddress(rc.registry) && lg?.topics?.[0] === eventTopic
  );
  if (matchingLogs.length !== 1) {
    throw new Error(`Expected exactly 1 AttestationPublished log. got=${matchingLogs.length}`);
  }

  const parsed = iface.parseLog(matchingLogs[0]);
  const ev = parsed.args;

  const evReportId = String(ev.reportId);
  const evAsOf = (ev.asOfTimestamp as any)?.toString?.() ?? String(ev.asOfTimestamp);
  const evGrams = (ev.attestedFineGoldGrams as any)?.toString?.() ?? String(ev.attestedFineGoldGrams);
  const evMerkleRoot = String(ev.merkleRoot);
  const evBarListHash = String(ev.barListHash);
  const evSigner = normalizeAddress(String(ev.signer));

  if (evReportId.toLowerCase() !== rc.publishedReportId.toLowerCase()) {
    throw new Error(`event.reportId mismatch. event=${evReportId} receipt=${rc.publishedReportId}`);
  }
  if (String(evAsOf) !== String(att.as_of_timestamp)) {
    throw new Error(`event.asOfTimestamp mismatch. event=${evAsOf} attestation=${att.as_of_timestamp}`);
  }
  if (evGrams !== att.attested_fine_gold_grams) {
    throw new Error(`event.attestedFineGoldGrams mismatch. event=${evGrams} attestation=${att.attested_fine_gold_grams}`);
  }
  if (evMerkleRoot.toLowerCase() !== att.merkle_root.toLowerCase()) {
    throw new Error(`event.merkleRoot mismatch. event=${evMerkleRoot} attestation=${att.merkle_root}`);
  }
  if (evBarListHash.toLowerCase() !== att.bar_list_hash.toLowerCase()) {
    throw new Error(`event.barListHash mismatch. event=${evBarListHash} attestation=${att.bar_list_hash}`);
  }
  if (evSigner !== normalizeAddress(att.signer_address)) {
    throw new Error(`event.signer mismatch. event=${evSigner} attestation=${att.signer_address}`);
  }

  // 2) Contract-state cross-check
  const rec = await registry.getAttestation(rc.publishedReportId);
  const stAsOf = (rec.asOfTimestamp as any)?.toString?.() ?? String(rec.asOfTimestamp);
  const stPublishedAt = Number(rec.publishedAt);
  const stGrams = rec.attestedFineGoldGrams?.toString?.() ?? String(rec.attestedFineGoldGrams);
  const stMerkleRoot = String(rec.merkleRoot);
  const stBarListHash = String(rec.barListHash);
  const stSigner = normalizeAddress(String(rec.signer));

  if (String(stAsOf) !== String(att.as_of_timestamp)) {
    throw new Error(`state.asOfTimestamp mismatch. state=${stAsOf} attestation=${att.as_of_timestamp}`);
  }
  if (stGrams !== att.attested_fine_gold_grams) {
    throw new Error(`state.attestedFineGoldGrams mismatch. state=${stGrams} attestation=${att.attested_fine_gold_grams}`);
  }
  if (stMerkleRoot.toLowerCase() !== att.merkle_root.toLowerCase()) {
    throw new Error(`state.merkleRoot mismatch. state=${stMerkleRoot} attestation=${att.merkle_root}`);
  }
  if (stBarListHash.toLowerCase() !== att.bar_list_hash.toLowerCase()) {
    throw new Error(`state.barListHash mismatch. state=${stBarListHash} attestation=${att.bar_list_hash}`);
  }
  if (stSigner !== normalizeAddress(att.signer_address)) {
    throw new Error(`state.signer mismatch. state=${stSigner} attestation=${att.signer_address}`);
  }
  if (!Number.isInteger(stPublishedAt) || stPublishedAt <= 0) {
    throw new Error(`state.publishedAt invalid. publishedAt=${stPublishedAt}`);
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    chainId: providerChainId,
    registry: normalizeAddress(rc.registry),
    txHash: rc.txHash,
    blockNumber: rc.blockNumber,
    reportId: rc.publishedReportId,
    signer: normalizeAddress(att.signer_address),
    publishedAt: stPublishedAt,
  }, null, 2));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("FAIL:", e?.message ?? e);
  process.exit(1);
});