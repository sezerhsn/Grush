/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import * as ethers from "ethers";
import {
  normalizeAddress,
  reportIdToBytes32,
  assertBytes32Hex,
} from "../merkle/hash_utils";

const REGISTRY_ABI = [
  "function exists(bytes32 reportId) external view returns (bool)",
  "function getAttestation(bytes32 reportId) external view returns (tuple(uint64 asOfTimestamp,uint64 publishedAt,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash,address signer))",
];

type PublishReceipt = {
  registry?: string;
  chainId?: number;
  reportId?: string;
  report_id?: string;
  txHash?: string;
  blockNumber?: number;
  status?: number;
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

function usageAndExit(code = 1): never {
  console.error(`
Usage:
  ts-node por/attestation/verify_signature.ts --in <attestation.json> [--expect <0xSigner>] [--receipt <publish_receipt.json>] [--rpc <RPC_URL>] [--quiet]

Validates:
- schema_version == 0.1
- bytes32 fields are bytes32 hex
- signature is 65-byte hex
- EIP-712 domain matches reserve_registry_address + chain_id
- recovered address matches signer_address (and optionally --expect)
- OPTIONAL (if receipt exists or --receipt provided): on-chain record matches attestation (requires --rpc or RPC_URL)

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

function getProvider(rpcUrl: string) {
  const v6 = (ethers as any).JsonRpcProvider;
  if (typeof v6 === "function") return new v6(rpcUrl);

  const v5 = (ethers as any).providers?.JsonRpcProvider;
  if (typeof v5 === "function") return new v5(rpcUrl);

  throw new Error("ethers JsonRpcProvider bulunamadı (ethers v5/v6 uyumsuz?).");
}

function readJson<T>(p: string): T {
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
}

function tryFindReceiptPath(attAbsPath: string): string | null {
  const candidates = [
    path.join(path.dirname(attAbsPath), "publish_receipt.json"),
    path.join(process.cwd(), "por/reports/publish_receipt.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
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

function assertInteger(n: any, name: string) {
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new Error(`${name} integer olmalı. Aldım: ${n}`);
  }
}

function assertAddress(addr: any, name: string) {
  if (typeof addr !== "string") throw new Error(`${name} string değil.`);
  normalizeAddress(addr);
}

function assertSig65(sig: string) {
  if (typeof sig !== "string") throw new Error("signature string değil.");
  if (!/^0x[a-fA-F0-9]{130}$/.test(sig)) {
    throw new Error("signature 65-byte hex değil (0x + 130 hex).");
  }
}

function basicValidate(j: any): Attestation {
  if (!j || typeof j !== "object") throw new Error("Attestation JSON object değil.");
  if (j.schema_version !== "0.1") throw new Error("schema_version 0.1 değil.");
  if (j.signature_scheme !== "eip712") throw new Error("signature_scheme eip712 değil.");
  if (j.eip712_types_version !== "0.1") throw new Error("eip712_types_version 0.1 değil.");

  if (typeof j.report_id !== "string" || !j.report_id) throw new Error("report_id invalid.");
  assertInteger(j.as_of_timestamp, "as_of_timestamp");
  assertInteger(j.attested_fine_gold_grams, "attested_fine_gold_grams");
  assertInteger(j.chain_id, "chain_id");

  if (typeof j.merkle_root !== "string") throw new Error("merkle_root invalid.");
  if (typeof j.bar_list_hash !== "string") throw new Error("bar_list_hash invalid.");
  assertBytes32Hex(j.merkle_root, "merkle_root");
  assertBytes32Hex(j.bar_list_hash, "bar_list_hash");

  assertAddress(j.reserve_registry_address, "reserve_registry_address");
  assertAddress(j.signer_address, "signer_address");
  assertSig65(j.signature);

  if (!j.eip712_domain || typeof j.eip712_domain !== "object") throw new Error("eip712_domain missing.");
  if (j.eip712_domain.name !== "GRUSH Reserve Attestation") throw new Error("domain.name mismatch.");
  if (j.eip712_domain.version !== "1") throw new Error("domain.version mismatch.");
  assertInteger(j.eip712_domain.chainId, "domain.chainId");
  assertAddress(j.eip712_domain.verifyingContract, "domain.verifyingContract");

  return j as Attestation;
}

function getVerifyTypedDataFn() {
  const v6 = (ethers as any).verifyTypedData;
  if (typeof v6 === "function") return v6;

  const v5 = (ethers as any).utils?.verifyTypedData;
  if (typeof v5 === "function") return v5;

  throw new Error("ethers verifyTypedData bulunamadı (ethers v5/v6 uyumsuz?).");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const inPath = (args.in as string) || "";
  if (!inPath) usageAndExit(1);

  const expect = (args.expect as string) || "";
  const receiptArg = (args.receipt as string) || "";
  const rpc = (args.rpc as string) || process.env.RPC_URL || "";
  const quiet = Boolean(args.quiet);

  const absIn = path.isAbsolute(inPath) ? inPath : path.join(process.cwd(), inPath);
  const raw = fs.readFileSync(absIn, "utf8");
  const att = basicValidate(JSON.parse(raw));

  const registry = normalizeAddress(att.reserve_registry_address);
  const signer = normalizeAddress(att.signer_address);

  if (att.chain_id !== att.eip712_domain.chainId) {
    throw new Error(`chain_id (${att.chain_id}) != domain.chainId (${att.eip712_domain.chainId})`);
  }
  if (normalizeAddress(att.eip712_domain.verifyingContract) !== registry) {
    throw new Error("domain.verifyingContract reserve_registry_address ile uyuşmuyor.");
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

  if (expect) {
    const exp = normalizeAddress(expect);
    if (recovered !== exp) {
      throw new Error(`Expected signer mismatch. recovered=${recovered}, expected=${exp}`);
    }
  }

  let onchainOut: any = null;
  const autoReceipt = receiptArg ? null : tryFindReceiptPath(absIn);
  const receiptPath = (receiptArg || autoReceipt || "").trim();
  if (receiptPath) {
    if (!rpc) {
      throw new Error(`Receipt bulundu ama RPC yok. --rpc ver veya RPC_URL env set et. receipt=${receiptPath}`);
    }

    const rc = readJson<PublishReceipt>(receiptPath);
    const rcRegistry = rc.registry ? normalizeAddress(rc.registry) : "";
    const rcChainId = rc.chainId;
    const rcReportId = rc.reportId;

    if (rcRegistry && rcRegistry !== registry) {
      throw new Error(`Receipt registry mismatch. receipt=${rcRegistry}, attestation=${registry}`);
    }
    if (typeof rcChainId === "number" && rcChainId !== att.chain_id) {
      throw new Error(`Receipt chainId mismatch. receipt=${rcChainId}, attestation.chain_id=${att.chain_id}`);
    }
    if (typeof rcReportId === "string" && rcReportId.toLowerCase() !== reportIdToBytes32(att.report_id).toLowerCase()) {
      throw new Error(`Receipt reportId mismatch. receipt=${rcReportId}, computed=${reportIdToBytes32(att.report_id)}`);
    }

    const provider = getProvider(rpc);
    const net = await provider.getNetwork();
    const chainId = Number((net as any).chainId ?? (net as any).chainId?.toString?.());
    if (chainId !== att.chain_id) {
      throw new Error(`RPC chainId mismatch. rpc=${chainId}, attestation.chain_id=${att.chain_id}`);
    }

    const onchainRegistry = new (ethers as any).Contract(registry, REGISTRY_ABI, provider);
    const rid = reportIdToBytes32(att.report_id);
    const exists = await onchainRegistry.exists(rid);
    if (!exists) throw new Error(`On-chain attestation bulunamadı: reportId=${rid}`);

    const rec = await onchainRegistry.getAttestation(rid);
    const norm = coerceAttestationRecord(rec);

    if (String(norm.asOfTimestamp) !== String(att.as_of_timestamp)) throw new Error(`On-chain asOfTimestamp mismatch.`);
    if (String(norm.attestedFineGoldGrams) !== String(att.attested_fine_gold_grams)) throw new Error(`On-chain attestedFineGoldGrams mismatch.`);
    if (String(norm.merkleRoot).toLowerCase() !== String(att.merkle_root).toLowerCase()) throw new Error(`On-chain merkleRoot mismatch.`);
    if (String(norm.barListHash).toLowerCase() !== String(att.bar_list_hash).toLowerCase()) throw new Error(`On-chain barListHash mismatch.`);
    if (normalizeAddress(norm.signer) !== recovered) throw new Error(`On-chain signer mismatch.`);

    onchainOut = {
      ok: true,
      receipt_path: receiptPath,
      receipt: {
        registry: rc.registry ?? null,
        chainId: rc.chainId ?? null,
        txHash: rc.txHash ?? null,
        blockNumber: rc.blockNumber ?? null,
        status: rc.status ?? null,
      },
      record: norm,
    };
  }

  if (!quiet) {
    const out: any = {
      ok: true,
      recovered_signer: recovered,
      registry,
      chain_id: att.chain_id,
      report_id: att.report_id,
      report_id_bytes32: reportIdToBytes32(att.report_id),
      as_of_timestamp: att.as_of_timestamp,
      attested_fine_gold_grams: att.attested_fine_gold_grams,
      merkle_root: att.merkle_root,
      bar_list_hash: att.bar_list_hash,
    };
    if (onchainOut) out.onchain = onchainOut;
    console.log(JSON.stringify(out, null, 2));
  }
}

main().catch((e) => {
  console.error("FAIL:", e?.message ?? e);
  process.exit(1);
});