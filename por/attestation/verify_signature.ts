import fs from "node:fs";
import path from "node:path";
import {
  Contract,
  JsonRpcProvider,
  getAddress,
  isAddress,
  verifyTypedData,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";
import {
  assertBytes32Hex,
  normalizeAddress,
  reportIdToBytes32,
  toUintBigInt,
} from "../merkle/hash_utils.ts";

const REGISTRY_ABI = [
  "function exists(bytes32 reportId) external view returns (bool)",
  "function getAttestation(bytes32 reportId) external view returns (tuple(uint64 asOfTimestamp,uint64 publishedAt,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash,address signer))",
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const UINT64_MAX = (1n << 64n) - 1n;
const DECIMAL_UINT_REGEX = /^(0|[1-9][0-9]*)$/;

type ParsedArgs = Record<string, string | boolean>;
type JsonRecord = Record<string, unknown>;
type TypedDataTypes = Record<string, TypedDataField[]>;

type PublishReceipt = {
  registry?: string;
  chainId?: string;
  reportId?: string;
  report_id?: string;
  publishedReportId?: string;
  txHash?: string;
  blockNumber?: string;
  status?: string;
};

type Attestation = {
  schema_version: "0.1";
  report_id: string;
  as_of_timestamp: string;
  attested_fine_gold_grams: string;
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

type OnchainAttestationRecord = {
  asOfTimestamp: string;
  publishedAt: string;
  attestedFineGoldGrams: string;
  merkleRoot: string;
  barListHash: string;
  signer: string;
};

type RegistryContractLike = Contract & {
  exists: (reportId: string) => Promise<boolean>;
  getAttestation: (reportId: string) => Promise<unknown>;
};

function usageAndExit(code = 1): never {
  // eslint-disable-next-line no-console
  console.error(`
Usage:
  npx tsx por/attestation/verify_signature.ts --in <attestation.json> [--expect <0xSigner>] [--receipt <publish_receipt.json>] [--rpc <RPC_URL>] [--quiet]
  npm run por:verify-signature -- --in <attestation.json> [--expect <0xSigner>] [--receipt <publish_receipt.json>] [--rpc <RPC_URL>] [--quiet]

Validates:
- schema_version == 0.1
- bytes32 fields are bytes32 hex
- signature is 65-byte hex
- EIP-712 domain matches reserve_registry_address + chain_id
- recovered address matches signer_address (and optionally --expect)
- OPTIONAL (if receipt exists or --receipt provided): receipt sanity + on-chain record matches attestation

RPC resolution:
- --rpc
- SEPOLIA_RPC_URL / MAINNET_RPC_URL by attestation.chain_id
- fallback RPC_URL

Exit codes:
  0 = OK
  1 = FAIL
`);
  process.exit(code);
  throw new Error("unreachable");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};

  for (let i = 2; i < argv.length; i++) {
    const current = argv[i];
    if (!current) continue;

    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }

    if (!current.startsWith("--")) continue;

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

function readJsonFile<T>(filePath: string): T {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Dosya bulunamadı: ${absolutePath}`);
  }

  return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as T;
}

function envStr(key: string): string {
  return (process.env[key] || "").trim();
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} non-empty string olmalı.`);
  }
  return value;
}

function toUintBigIntStrict(value: unknown, name: string): bigint {
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") {
    return toUintBigInt(value, name);
  }

  throw new Error(`${name} bigint|number|string olmalı. Aldım: ${String(value)}`);
}

function toDecimalString(value: unknown, name: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!DECIMAL_UINT_REGEX.test(trimmed)) {
      throw new Error(`${name} decimal uint string olmalı. Aldım: ${value}`);
    }
    return trimmed;
  }

  return toUintBigIntStrict(value, name).toString();
}

function toPositiveSafeInteger(value: unknown, name: string): number {
  const asBigInt = toUintBigIntStrict(value, name);

  if (asBigInt < 1n) {
    throw new Error(`${name} >= 1 olmalı. Aldım: ${asBigInt.toString()}`);
  }

  if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${name} MAX_SAFE_INTEGER üstünde olamaz. Aldım: ${asBigInt.toString()}`);
  }

  return Number(asBigInt);
}

function toUint64String(value: unknown, name: string): string {
  const asBigInt = toUintBigIntStrict(value, name);

  if (asBigInt > UINT64_MAX) {
    throw new Error(`${name} uint64 sınırını aşıyor. Aldım: ${asBigInt.toString()}`);
  }

  return asBigInt.toString();
}

function normalizeAddressStrict(address: string, name: string): string {
  const normalized = normalizeAddress(address);

  if (!isAddress(normalized)) {
    throw new Error(`${name} invalid address: ${address}`);
  }

  const checksummed = getAddress(normalized);
  if (checksummed.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    throw new Error(`${name} ZERO address olamaz.`);
  }

  return checksummed;
}

function assertSig65(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new Error("signature string değil.");
  }

  if (!/^0x[a-fA-F0-9]{130}$/.test(value)) {
    throw new Error("signature 65-byte hex değil (0x + 130 hex).");
  }
}

function basicValidate(value: unknown): Attestation {
  if (!isRecord(value)) {
    throw new Error("Attestation JSON object değil.");
  }

  if (value.schema_version !== "0.1") {
    throw new Error("schema_version 0.1 değil.");
  }

  if (value.signature_scheme !== "eip712") {
    throw new Error("signature_scheme eip712 değil.");
  }

  if (value.eip712_types_version !== "0.1") {
    throw new Error("eip712_types_version 0.1 değil.");
  }

  const report_id = requireString(value.report_id, "report_id");
  const as_of_timestamp = toUint64String(value.as_of_timestamp, "as_of_timestamp");
  const attested_fine_gold_grams = toDecimalString(
    value.attested_fine_gold_grams,
    "attested_fine_gold_grams"
  );

  const merkle_root = requireString(value.merkle_root, "merkle_root");
  const bar_list_hash = requireString(value.bar_list_hash, "bar_list_hash");

  assertBytes32Hex(merkle_root, "merkle_root");
  assertBytes32Hex(bar_list_hash, "bar_list_hash");

  const chain_id = toPositiveSafeInteger(value.chain_id, "chain_id");

  const reserve_registry_address = normalizeAddressStrict(
    requireString(value.reserve_registry_address, "reserve_registry_address"),
    "reserve_registry_address"
  );

  const signer_address = normalizeAddressStrict(
    requireString(value.signer_address, "signer_address"),
    "signer_address"
  );

  assertSig65(value.signature);

  if (!isRecord(value.eip712_domain)) {
    throw new Error("eip712_domain missing.");
  }

  if (value.eip712_domain.name !== "GRUSH Reserve Attestation") {
    throw new Error("domain.name mismatch.");
  }

  if (value.eip712_domain.version !== "1") {
    throw new Error("domain.version mismatch.");
  }

  const domainChainId = toPositiveSafeInteger(value.eip712_domain.chainId, "domain.chainId");

  const verifyingContract = normalizeAddressStrict(
    requireString(value.eip712_domain.verifyingContract, "domain.verifyingContract"),
    "domain.verifyingContract"
  );

  return {
    schema_version: "0.1",
    report_id,
    as_of_timestamp,
    attested_fine_gold_grams,
    merkle_root,
    bar_list_hash,
    chain_id,
    reserve_registry_address,
    signer_address,
    signature_scheme: "eip712",
    eip712_domain: {
      name: "GRUSH Reserve Attestation",
      version: "1",
      chainId: domainChainId,
      verifyingContract,
    },
    eip712_types_version: "0.1",
    signature: value.signature,
  };
}

function tryFindReceiptPath(attestationPath: string): string | null {
  const reportIdDir = path.dirname(attestationPath);
  const reportId = path.basename(reportIdDir);

  const candidates = [
    path.join(reportIdDir, "publish_receipt.json"),
    path.join(process.cwd(), "transparency", "attestations", reportId, "publish_receipt.json"),
    path.join(process.cwd(), "por", "reports", "publish_receipt.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveRpc(chainId: number, explicitRpc: string): { rpc: string; source: string } {
  const byArg = explicitRpc.trim();
  if (byArg) {
    return { rpc: byArg, source: "--rpc" };
  }

  if (chainId === 11155111) {
    const sepolia = envStr("SEPOLIA_RPC_URL");
    if (sepolia) {
      return { rpc: sepolia, source: "SEPOLIA_RPC_URL" };
    }
  }

  if (chainId === 1) {
    const mainnet = envStr("MAINNET_RPC_URL");
    if (mainnet) {
      return { rpc: mainnet, source: "MAINNET_RPC_URL" };
    }
  }

  const fallback = envStr("RPC_URL");
  if (fallback) {
    return { rpc: fallback, source: "RPC_URL" };
  }

  return { rpc: "", source: "none" };
}

function parsePublishReceipt(value: unknown): PublishReceipt {
  if (!isRecord(value)) {
    throw new Error("publish_receipt JSON object değil.");
  }

  return {
    ...(value.registry !== undefined
      ? { registry: requireString(value.registry, "receipt.registry") }
      : {}),
    ...(value.chainId !== undefined
      ? { chainId: toDecimalString(value.chainId, "receipt.chainId") }
      : {}),
    ...(value.reportId !== undefined
      ? { reportId: requireString(value.reportId, "receipt.reportId") }
      : {}),
    ...(value.report_id !== undefined
      ? { report_id: requireString(value.report_id, "receipt.report_id") }
      : {}),
    ...(value.publishedReportId !== undefined
      ? {
          publishedReportId: requireString(
            value.publishedReportId,
            "receipt.publishedReportId"
          ),
        }
      : {}),
    ...(value.txHash !== undefined
      ? { txHash: requireString(value.txHash, "receipt.txHash") }
      : {}),
    ...(value.blockNumber !== undefined
      ? { blockNumber: toDecimalString(value.blockNumber, "receipt.blockNumber") }
      : {}),
    ...(value.status !== undefined
      ? { status: toDecimalString(value.status, "receipt.status") }
      : {}),
  };
}

function getTupleField(record: unknown, key: string, index: number): unknown {
  if (isRecord(record) && key in record) {
    return record[key];
  }

  if (Array.isArray(record)) {
    return record[index];
  }

  return undefined;
}

function coerceTupleValueToString(value: unknown, name: string): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }

  if (isRecord(value) && "toString" in value && typeof value.toString === "function") {
    return value.toString();
  }

  throw new Error(`${name} tuple field parse edilemedi.`);
}

function coerceAttestationRecord(record: unknown): OnchainAttestationRecord {
  const asOfTimestamp = coerceTupleValueToString(
    getTupleField(record, "asOfTimestamp", 0),
    "record.asOfTimestamp"
  );
  const publishedAt = coerceTupleValueToString(
    getTupleField(record, "publishedAt", 1),
    "record.publishedAt"
  );
  const attestedFineGoldGrams = coerceTupleValueToString(
    getTupleField(record, "attestedFineGoldGrams", 2),
    "record.attestedFineGoldGrams"
  );
  const merkleRoot = coerceTupleValueToString(
    getTupleField(record, "merkleRoot", 3),
    "record.merkleRoot"
  );
  const barListHash = coerceTupleValueToString(
    getTupleField(record, "barListHash", 4),
    "record.barListHash"
  );
  const signer = coerceTupleValueToString(getTupleField(record, "signer", 5), "record.signer");

  assertBytes32Hex(merkleRoot, "record.merkleRoot");
  assertBytes32Hex(barListHash, "record.barListHash");

  return {
    asOfTimestamp,
    publishedAt,
    attestedFineGoldGrams,
    merkleRoot,
    barListHash,
    signer: normalizeAddressStrict(signer, "record.signer"),
  };
}

function hexEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) {
    usageAndExit(0);
  }

  const inPath = typeof args.in === "string" ? args.in : "";
  if (!inPath) {
    usageAndExit(1);
  }

  const expect = typeof args.expect === "string" ? args.expect : "";
  const receiptArg = typeof args.receipt === "string" ? args.receipt : "";
  const rpcArg = typeof args.rpc === "string" ? args.rpc : "";
  const quiet = Boolean(args.quiet);

  const absoluteInputPath = path.isAbsolute(inPath) ? inPath : path.join(process.cwd(), inPath);
  const attestation = basicValidate(readJsonFile<unknown>(absoluteInputPath));

  const registry = normalizeAddressStrict(
    attestation.reserve_registry_address,
    "reserve_registry_address"
  );
  const signer = normalizeAddressStrict(attestation.signer_address, "signer_address");
  const reportIdBytes32 = reportIdToBytes32(attestation.report_id);

  if (attestation.chain_id !== attestation.eip712_domain.chainId) {
    throw new Error(
      `chain_id (${attestation.chain_id}) != domain.chainId (${attestation.eip712_domain.chainId})`
    );
  }

  if (
    normalizeAddressStrict(
      attestation.eip712_domain.verifyingContract,
      "domain.verifyingContract"
    ) !== registry
  ) {
    throw new Error("domain.verifyingContract reserve_registry_address ile uyuşmuyor.");
  }

  const domain: TypedDataDomain = {
    name: "GRUSH Reserve Attestation",
    version: "1",
    chainId: attestation.chain_id,
    verifyingContract: registry,
  };

  const types: TypedDataTypes = {
    ReserveAttestation: [
      { name: "reportId", type: "bytes32" },
      { name: "asOfTimestamp", type: "uint64" },
      { name: "attestedFineGoldGrams", type: "uint256" },
      { name: "merkleRoot", type: "bytes32" },
      { name: "barListHash", type: "bytes32" },
    ],
  };

  const message: Record<string, unknown> = {
    reportId: reportIdBytes32,
    asOfTimestamp: attestation.as_of_timestamp,
    attestedFineGoldGrams: attestation.attested_fine_gold_grams,
    merkleRoot: attestation.merkle_root,
    barListHash: attestation.bar_list_hash,
  };

  const recovered = normalizeAddressStrict(
    verifyTypedData(domain, types, message, attestation.signature),
    "recovered_signer"
  );

  if (recovered !== signer) {
    throw new Error(
      `Recovered signer mismatch. recovered=${recovered}, attestation.signer_address=${signer}`
    );
  }

  if (expect) {
    const expectedSigner = normalizeAddressStrict(expect, "--expect");
    if (recovered !== expectedSigner) {
      throw new Error(
        `Expected signer mismatch. recovered=${recovered}, expected=${expectedSigner}`
      );
    }
  }

  let onchainOutput:
    | {
        ok: true;
        rpc_source: string;
        receipt_path: string;
        receipt: {
          registry: string | null;
          chainId: string | null;
          txHash: string | null;
          blockNumber: string | null;
          status: string | null;
        };
        record: OnchainAttestationRecord;
      }
    | undefined;

  const autoReceiptPath = receiptArg ? null : tryFindReceiptPath(absoluteInputPath);
  const receiptPath = (receiptArg || autoReceiptPath || "").trim();

  if (receiptPath) {
    const receipt = parsePublishReceipt(readJsonFile<unknown>(receiptPath));

    if (receipt.registry) {
      const receiptRegistry = normalizeAddressStrict(receipt.registry, "receipt.registry");
      if (receiptRegistry !== registry) {
        throw new Error(
          `Receipt registry mismatch. receipt=${receiptRegistry}, attestation=${registry}`
        );
      }
    }

    if (receipt.chainId !== undefined) {
      const receiptChainId = toPositiveSafeInteger(receipt.chainId, "receipt.chainId");
      if (receiptChainId !== attestation.chain_id) {
        throw new Error(
          `Receipt chainId mismatch. receipt=${receiptChainId}, attestation.chain_id=${attestation.chain_id}`
        );
      }
    }

    if (receipt.report_id !== undefined && receipt.report_id !== attestation.report_id) {
      throw new Error(
        `Receipt report_id mismatch. receipt=${receipt.report_id}, attestation=${attestation.report_id}`
      );
    }

    if (receipt.reportId !== undefined) {
      assertBytes32Hex(receipt.reportId, "receipt.reportId");
      if (!hexEquals(receipt.reportId, reportIdBytes32)) {
        throw new Error(
          `Receipt reportId mismatch. receipt=${receipt.reportId}, computed=${reportIdBytes32}`
        );
      }
    }

    if (receipt.publishedReportId !== undefined) {
      assertBytes32Hex(receipt.publishedReportId, "receipt.publishedReportId");
      if (!hexEquals(receipt.publishedReportId, reportIdBytes32)) {
        throw new Error(
          `Receipt publishedReportId mismatch. receipt=${receipt.publishedReportId}, computed=${reportIdBytes32}`
        );
      }
    }

    if (receipt.status !== undefined && receipt.status !== "1") {
      throw new Error(`Receipt status != 1. Aldım: ${receipt.status}`);
    }

    const { rpc, source } = resolveRpc(attestation.chain_id, rpcArg);
    if (!rpc) {
      throw new Error(
        `Receipt bulundu ama RPC yok. --rpc ver veya uygun env set et (SEPOLIA_RPC_URL / MAINNET_RPC_URL / RPC_URL). receipt=${receiptPath}`
      );
    }

    const provider = new JsonRpcProvider(rpc);
    const network = await provider.getNetwork();
    const providerChainId = Number(network.chainId);

    if (providerChainId !== attestation.chain_id) {
      throw new Error(
        `RPC chainId mismatch. rpc=${providerChainId}, attestation.chain_id=${attestation.chain_id}`
      );
    }

    const registryContract = new Contract(
      registry,
      REGISTRY_ABI,
      provider
    ) as RegistryContractLike;

    const exists = await registryContract.exists(reportIdBytes32);
    if (!exists) {
      throw new Error(`On-chain attestation bulunamadı: reportId=${reportIdBytes32}`);
    }

    const record = coerceAttestationRecord(await registryContract.getAttestation(reportIdBytes32));

    if (record.asOfTimestamp !== attestation.as_of_timestamp) {
      throw new Error(
        `On-chain asOfTimestamp mismatch. onchain=${record.asOfTimestamp}, attestation=${attestation.as_of_timestamp}`
      );
    }

    if (record.attestedFineGoldGrams !== attestation.attested_fine_gold_grams) {
      throw new Error(
        `On-chain attestedFineGoldGrams mismatch. onchain=${record.attestedFineGoldGrams}, attestation=${attestation.attested_fine_gold_grams}`
      );
    }

    if (!hexEquals(record.merkleRoot, attestation.merkle_root)) {
      throw new Error("On-chain merkleRoot mismatch.");
    }

    if (!hexEquals(record.barListHash, attestation.bar_list_hash)) {
      throw new Error("On-chain barListHash mismatch.");
    }

    if (record.signer !== recovered) {
      throw new Error(`On-chain signer mismatch. onchain=${record.signer}, recovered=${recovered}`);
    }

    onchainOutput = {
      ok: true,
      rpc_source: source,
      receipt_path: receiptPath,
      receipt: {
        registry: receipt.registry ?? null,
        chainId: receipt.chainId ?? null,
        txHash: receipt.txHash ?? null,
        blockNumber: receipt.blockNumber ?? null,
        status: receipt.status ?? null,
      },
      record,
    };
  }

  if (!quiet) {
    const out = {
      ok: true,
      recovered_signer: recovered,
      registry,
      chain_id: attestation.chain_id,
      report_id: attestation.report_id,
      report_id_bytes32: reportIdBytes32,
      as_of_timestamp: attestation.as_of_timestamp,
      attested_fine_gold_grams: attestation.attested_fine_gold_grams,
      merkle_root: attestation.merkle_root,
      bar_list_hash: attestation.bar_list_hash,
      ...(onchainOutput ? { onchain: onchainOutput } : {}),
    };

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out, null, 2));
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`FAIL: ${errorMessage(error)}`);
  process.exit(1);
});