import fs from "node:fs";
import path from "node:path";
import {
  Contract,
  Interface,
  JsonRpcProvider,
  verifyTypedData,
  type TypedDataField,
} from "ethers";

import {
  fileKeccak256Hex,
  leafHash,
  nodeHash,
  assertBytes32Hex,
  normalizeAddress,
  reportIdToBytes32,
} from "../por/merkle/hash_utils.ts";

type JsonUint = number | string;

type ParsedArgs = Record<string, string | boolean>;
type TypedDataTypes = Record<string, TypedDataField[]>;

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
  bars_count: JsonUint;
  attested_fine_gold_grams: JsonUint;
  bar_list_hash: string;
  merkle_root: string;
};

type Attestation = {
  schema_version: "0.1";
  report_id: string;
  as_of_timestamp: number;
  attested_fine_gold_grams: JsonUint;
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
  registry?: string;
  chainId?: number;
  reportId?: string;
  report_id?: string;
  txHash?: string;
  blockNumber?: number;
  status?: number;
  mined?: boolean;
};

type OnchainAttestationRecord = {
  asOfTimestamp: string;
  publishedAt: string;
  attestedFineGoldGrams: string;
  merkleRoot: string;
  barListHash: string;
  signer: string;
};

type PublishedEventRecord = {
  reportId: string;
  asOfTimestamp: string;
  attestedFineGoldGrams: string;
  merkleRoot: string;
  barListHash: string;
  signer: string;
  publishedAt: string;
};

type VerifyOnchainResult = {
  ok: true;
  receipt_path: string;
  txHash: string;
  blockNumber: number;
  status: 1;
  event: PublishedEventRecord;
  record: OnchainAttestationRecord;
};

type RegistryContractLike = Contract & {
  exists: (reportId: string) => Promise<boolean>;
  getAttestation: (reportId: string) => Promise<unknown>;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const REGISTRY_ABI = [
  "function exists(bytes32 reportId) external view returns (bool)",
  "function getAttestation(bytes32 reportId) external view returns (tuple(uint64 asOfTimestamp,uint64 publishedAt,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash,address signer))",
  "event AttestationPublished(bytes32 indexed reportId,uint64 indexed asOfTimestamp,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash,address indexed signer,uint64 publishedAt)",
] as const;

function usageAndExit(code = 1): never {
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

Expected layout:
  <base>/barlists/<report_id>/bar_list.json
  <base>/reserve_reports/<report_id>/por_output.json
  <base>/attestations/<report_id>/attestation.json   (or attestation.sepolia.json / attestation.mainnet.json)

Exit codes:
  0 = OK
  1 = FAIL
`);
  process.exit(code);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  let positional: string | null = null;

  for (let i = 2; i < argv.length; i++) {
    const current = argv[i];
    if (!current) continue;

    if (!current.startsWith("--") && positional === null) {
      positional = current;
      continue;
    }

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

  if (positional && !args.report_id && !args.reportId && !args.id) {
    args.report_id = positional;
  }

  return args;
}

function assertIntNumber(n: unknown, name: string): asserts n is number {
  if (typeof n !== "number" || !Number.isInteger(n) || !Number.isSafeInteger(n)) {
    throw new Error(`${name} safe integer olmalı. Aldım: ${String(n)}`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} non-empty string olmalı.`);
  }
  return value;
}

function normalizeAddressStrict(value: string, label: string): string {
  const normalized = normalizeAddress(value);
  if (normalized.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    throw new Error(`${label} ZERO address olamaz.`);
  }
  return normalized;
}

function toBigIntStrict(v: unknown, name: string): bigint {
  if (typeof v === "bigint") return v;

  if (typeof v === "number") {
    if (!Number.isInteger(v)) {
      throw new Error(`${name} integer olmalı. Aldım: ${v}`);
    }
    if (!Number.isSafeInteger(v)) {
      throw new Error(
        `${name} MAX_SAFE_INTEGER üstünde. JSON'da decimal string kullan. Aldım: ${v}`
      );
    }
    if (v < 0) {
      throw new Error(`${name} negatif olamaz. Aldım: ${v}`);
    }
    return BigInt(v);
  }

  if (typeof v === "string") {
    const s = v.trim();
    if (!/^[0-9]+$/.test(s)) {
      throw new Error(`${name} decimal string olmalı. Aldım: ${v}`);
    }
    return BigInt(s);
  }

  throw new Error(`${name} number|string olmalı. Aldım: ${String(v)}`);
}

function toDecString(v: unknown, name: string): string {
  return toBigIntStrict(v, name).toString();
}

function readJsonFile<T>(filePath: string): T {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

  if (!fs.existsSync(abs)) {
    throw new Error(`Dosya bulunamadı: ${abs}`);
  }

  return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
}

function basicValidateBarList(input: unknown): BarList {
  if (!isRecord(input)) throw new Error("bar_list JSON object değil.");
  if (input.schema_version !== "0.1") throw new Error("bar_list.schema_version 0.1 değil.");

  const reportId = requireString(input.report_id, "bar_list.report_id");
  const asOfTimestamp = input.as_of_timestamp;
  assertIntNumber(asOfTimestamp, "bar_list.as_of_timestamp");

  if (!isRecord(input.custodian)) throw new Error("bar_list.custodian yok.");
  requireString(input.custodian.name, "bar_list.custodian.name");
  requireString(input.custodian.location, "bar_list.custodian.location");

  if (input.auditor !== undefined) {
    if (!isRecord(input.auditor)) throw new Error("bar_list.auditor object olmalı.");
    requireString(input.auditor.name, "bar_list.auditor.name");
    if (input.auditor.report_ref !== undefined) {
      requireString(input.auditor.report_ref, "bar_list.auditor.report_ref");
    }
  }

  if (!Array.isArray(input.bars) || input.bars.length < 1) {
    throw new Error("bar_list.bars[] boş.");
  }

  for (let i = 0; i < input.bars.length; i++) {
    const bar = input.bars[i];
    if (!isRecord(bar)) throw new Error(`bar_list.bars[${i}] object değil.`);

    requireString(bar.serial_no, `bar_list.bars[${i}].serial_no`);
    requireString(bar.refiner, `bar_list.bars[${i}].refiner`);
    requireString(bar.fineness, `bar_list.bars[${i}].fineness`);
    requireString(bar.vault_id, `bar_list.bars[${i}].vault_id`);
    assertIntNumber(bar.fine_weight_g, `bar_list.bars[${i}].fine_weight_g`);

    if (bar.gross_weight_g !== undefined) {
      assertIntNumber(bar.gross_weight_g, `bar_list.bars[${i}].gross_weight_g`);
    }

    if (bar.allocation_status !== "allocated") {
      throw new Error(`bar_list.bars[${i}].allocation_status allocated olmalı (v0.1).`);
    }
  }

  if (input.totals !== undefined) {
    if (!isRecord(input.totals)) throw new Error("bar_list.totals object değil.");

    if (input.totals.fine_gold_grams !== undefined) {
      toBigIntStrict(input.totals.fine_gold_grams, "bar_list.totals.fine_gold_grams");
    }

    if (input.totals.bars_count !== undefined) {
      toBigIntStrict(input.totals.bars_count, "bar_list.totals.bars_count");
    }
  }

  return {
    schema_version: "0.1",
    report_id: reportId,
    as_of_timestamp: asOfTimestamp,
    custodian: {
      name: requireString(input.custodian.name, "bar_list.custodian.name"),
      location: requireString(input.custodian.location, "bar_list.custodian.location"),
    },
    auditor:
      input.auditor && isRecord(input.auditor)
        ? {
            name: requireString(input.auditor.name, "bar_list.auditor.name"),
            ...(input.auditor.report_ref !== undefined
              ? {
                  report_ref: requireString(
                    input.auditor.report_ref,
                    "bar_list.auditor.report_ref"
                  ),
                }
              : {}),
          }
        : undefined,
    bars: input.bars as BarEntry[],
    totals: input.totals as BarList["totals"],
  };
}

function basicValidatePorOutput(input: unknown): PorOutput {
  if (!isRecord(input)) throw new Error("por_output JSON object değil.");
  if (input.schema_version !== "0.1") throw new Error("por_output.schema_version 0.1 değil.");

  const reportId = requireString(input.report_id, "por_output.report_id");
  const asOfTimestamp = input.as_of_timestamp;
  assertIntNumber(asOfTimestamp, "por_output.as_of_timestamp");

  toBigIntStrict(input.bars_count, "por_output.bars_count");
  toBigIntStrict(input.attested_fine_gold_grams, "por_output.attested_fine_gold_grams");

  const barListHash = requireString(input.bar_list_hash, "por_output.bar_list_hash");
  const merkleRoot = requireString(input.merkle_root, "por_output.merkle_root");

  assertBytes32Hex(barListHash, "por_output.bar_list_hash");
  assertBytes32Hex(merkleRoot, "por_output.merkle_root");

  return {
    schema_version: "0.1",
    report_id: reportId,
    as_of_timestamp: asOfTimestamp,
    bars_count: input.bars_count as JsonUint,
    attested_fine_gold_grams: input.attested_fine_gold_grams as JsonUint,
    bar_list_hash: barListHash,
    merkle_root: merkleRoot,
  };
}

function assertSig65(signature: unknown): asserts signature is string {
  if (typeof signature !== "string") {
    throw new Error("signature string değil.");
  }

  if (!/^0x[a-fA-F0-9]{130}$/.test(signature)) {
    throw new Error("signature 65-byte hex değil (0x + 130 hex).");
  }
}

function basicValidateAttestation(input: unknown): Attestation {
  if (!isRecord(input)) throw new Error("attestation JSON object değil.");
  if (input.schema_version !== "0.1") throw new Error("attestation.schema_version 0.1 değil.");
  if (input.signature_scheme !== "eip712") {
    throw new Error("attestation.signature_scheme eip712 değil.");
  }
  if (input.eip712_types_version !== "0.1") {
    throw new Error("attestation.eip712_types_version 0.1 değil.");
  }

  const reportId = requireString(input.report_id, "attestation.report_id");
  const asOfTimestamp = input.as_of_timestamp;
  assertIntNumber(asOfTimestamp, "attestation.as_of_timestamp");

  toBigIntStrict(input.attested_fine_gold_grams, "attestation.attested_fine_gold_grams");

  const chainId = input.chain_id;
  assertIntNumber(chainId, "attestation.chain_id");

  const merkleRoot = requireString(input.merkle_root, "attestation.merkle_root");
  const barListHash = requireString(input.bar_list_hash, "attestation.bar_list_hash");
  assertBytes32Hex(merkleRoot, "attestation.merkle_root");
  assertBytes32Hex(barListHash, "attestation.bar_list_hash");

  const reserveRegistryAddress = normalizeAddressStrict(
    requireString(input.reserve_registry_address, "attestation.reserve_registry_address"),
    "attestation.reserve_registry_address"
  );
  const signerAddress = normalizeAddressStrict(
    requireString(input.signer_address, "attestation.signer_address"),
    "attestation.signer_address"
  );

  assertSig65(input.signature);

  if (!isRecord(input.eip712_domain)) {
    throw new Error("attestation.eip712_domain missing.");
  }
  if (input.eip712_domain.name !== "GRUSH Reserve Attestation") {
    throw new Error("attestation.domain.name mismatch.");
  }
  if (input.eip712_domain.version !== "1") {
    throw new Error("attestation.domain.version mismatch.");
  }

  const domainChainId = input.eip712_domain.chainId;
  assertIntNumber(domainChainId, "attestation.domain.chainId");

  const verifyingContract = normalizeAddressStrict(
    requireString(
      input.eip712_domain.verifyingContract,
      "attestation.domain.verifyingContract"
    ),
    "attestation.domain.verifyingContract"
  );

  return {
    schema_version: "0.1",
    report_id: reportId,
    as_of_timestamp: asOfTimestamp,
    attested_fine_gold_grams: input.attested_fine_gold_grams as JsonUint,
    merkle_root: merkleRoot,
    bar_list_hash: barListHash,
    chain_id: chainId,
    reserve_registry_address: reserveRegistryAddress,
    signer_address: signerAddress,
    signature_scheme: "eip712",
    eip712_domain: {
      name: "GRUSH Reserve Attestation",
      version: "1",
      chainId: domainChainId,
      verifyingContract,
    },
    eip712_types_version: "0.1",
    signature: input.signature,
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
  if (leafHashes.length === 0) throw new Error("leaf list boş.");

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
  let total = 0n;
  for (const bar of bars) {
    total += BigInt(bar.fine_weight_g);
  }
  return total;
}

function recomputeFromBarList(barList: BarList, barListFileBytes: Uint8Array) {
  const bars = canonicalSortBars(barList.bars);
  const leafHashes = bars.map((bar) =>
    leafHash({
      as_of_timestamp: barList.as_of_timestamp,
      fineness: bar.fineness,
      fine_weight_g: bar.fine_weight_g,
      refiner: bar.refiner,
      serial_no: bar.serial_no,
      vault_id: bar.vault_id,
    })
  );

  const derivedBarsCount = BigInt(bars.length);
  const derivedFineGoldGrams = sumFineGoldGrams(bars);

  if (barList.totals?.bars_count !== undefined) {
    const declaredBarsCount = toBigIntStrict(
      barList.totals.bars_count,
      "bar_list.totals.bars_count"
    );
    if (declaredBarsCount !== derivedBarsCount) {
      throw new Error(
        `bar_list.totals.bars_count mismatch. declared=${declaredBarsCount.toString()}, derived=${derivedBarsCount.toString()}`
      );
    }
  }

  if (barList.totals?.fine_gold_grams !== undefined) {
    const declaredFineGoldGrams = toBigIntStrict(
      barList.totals.fine_gold_grams,
      "bar_list.totals.fine_gold_grams"
    );
    if (declaredFineGoldGrams !== derivedFineGoldGrams) {
      throw new Error(
        `bar_list.totals.fine_gold_grams mismatch. declared=${declaredFineGoldGrams.toString()}, derived=${derivedFineGoldGrams.toString()}`
      );
    }
  }

  return {
    report_id: barList.report_id,
    as_of_timestamp: barList.as_of_timestamp,
    bars_count: bars.length,
    attested_fine_gold_grams: derivedFineGoldGrams,
    bar_list_hash: fileKeccak256Hex(barListFileBytes),
    merkle_root: buildMerkleRootFromLeaves(leafHashes),
  } as const;
}

function verifyAttestationSignature(att: Attestation): string {
  const registry = normalizeAddressStrict(
    att.reserve_registry_address,
    "attestation.reserve_registry_address"
  );
  const signer = normalizeAddressStrict(att.signer_address, "attestation.signer_address");
  const grams = toBigIntStrict(
    att.attested_fine_gold_grams,
    "attestation.attested_fine_gold_grams"
  );

  if (att.chain_id !== att.eip712_domain.chainId) {
    throw new Error(
      `attestation.chain_id (${att.chain_id}) != domain.chainId (${att.eip712_domain.chainId})`
    );
  }

  if (
    normalizeAddressStrict(
      att.eip712_domain.verifyingContract,
      "attestation.eip712_domain.verifyingContract"
    ) !== registry
  ) {
    throw new Error(
      "attestation.domain.verifyingContract reserve_registry_address ile uyuşmuyor."
    );
  }

  const domain = {
    name: "GRUSH Reserve Attestation",
    version: "1",
    chainId: att.chain_id,
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
    reportId: reportIdToBytes32(att.report_id),
    asOfTimestamp: att.as_of_timestamp,
    attestedFineGoldGrams: grams.toString(),
    merkleRoot: att.merkle_root,
    barListHash: att.bar_list_hash,
  };

  const recovered = normalizeAddressStrict(
    verifyTypedData(domain, types, message, att.signature),
    "recovered signer"
  );

  if (recovered !== signer) {
    throw new Error(
      `Recovered signer mismatch. recovered=${recovered}, attestation.signer_address=${signer}`
    );
  }

  return recovered;
}

function getContract(address: string, provider: JsonRpcProvider): RegistryContractLike {
  return new Contract(address, REGISTRY_ABI, provider) as RegistryContractLike;
}

function toTupleLike(
  value: unknown,
  label: string
): Record<string, unknown> & { [index: number]: unknown } {
  if (value === null || value === undefined || typeof value !== "object") {
    throw new Error(`${label} tuple/object değil.`);
  }

  return value as Record<string, unknown> & { [index: number]: unknown };
}

function coerceAttestationRecord(rec: unknown): OnchainAttestationRecord {
  const tuple = toTupleLike(rec, "on-chain attestation record");

  const asOfTimestamp = toBigIntStrict(
    tuple.asOfTimestamp ?? tuple[0],
    "record.asOfTimestamp"
  ).toString();
  const publishedAt = toBigIntStrict(tuple.publishedAt ?? tuple[1], "record.publishedAt").toString();
  const attestedFineGoldGrams = toBigIntStrict(
    tuple.attestedFineGoldGrams ?? tuple[2],
    "record.attestedFineGoldGrams"
  ).toString();

  const merkleRoot = requireString(tuple.merkleRoot ?? tuple[3], "record.merkleRoot");
  const barListHash = requireString(tuple.barListHash ?? tuple[4], "record.barListHash");
  const signer = normalizeAddressStrict(
    requireString(tuple.signer ?? tuple[5], "record.signer"),
    "record.signer"
  );

  assertBytes32Hex(merkleRoot, "record.merkleRoot");
  assertBytes32Hex(barListHash, "record.barListHash");

  return {
    asOfTimestamp,
    publishedAt,
    attestedFineGoldGrams,
    merkleRoot,
    barListHash,
    signer,
  };
}

function coercePublishedEventArgs(args: unknown): PublishedEventRecord {
  const tuple = toTupleLike(args, "AttestationPublished.args");

  const reportId = requireString(tuple.reportId ?? tuple[0], "event.reportId");
  const asOfTimestamp = toBigIntStrict(
    tuple.asOfTimestamp ?? tuple[1],
    "event.asOfTimestamp"
  ).toString();
  const attestedFineGoldGrams = toBigIntStrict(
    tuple.attestedFineGoldGrams ?? tuple[2],
    "event.attestedFineGoldGrams"
  ).toString();
  const merkleRoot = requireString(tuple.merkleRoot ?? tuple[3], "event.merkleRoot");
  const barListHash = requireString(tuple.barListHash ?? tuple[4], "event.barListHash");
  const signer = normalizeAddressStrict(
    requireString(tuple.signer ?? tuple[5], "event.signer"),
    "event.signer"
  );
  const publishedAt = toBigIntStrict(tuple.publishedAt ?? tuple[6], "event.publishedAt").toString();

  assertBytes32Hex(reportId, "event.reportId");
  assertBytes32Hex(merkleRoot, "event.merkleRoot");
  assertBytes32Hex(barListHash, "event.barListHash");

  return {
    reportId,
    asOfTimestamp,
    attestedFineGoldGrams,
    merkleRoot,
    barListHash,
    signer,
    publishedAt,
  };
}

function tryFindReceiptPath(attDirAbs: string): string | null {
  const candidates = [
    path.join(attDirAbs, "publish_receipt.json"),
    path.join(attDirAbs, "publish_receipt.sepolia.json"),
    path.join(attDirAbs, "publish_receipt.mainnet.json"),
    path.join(process.cwd(), "por", "reports", "publish_receipt.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function pickAttestationPath(attDirAbs: string, wantChainId?: number): string {
  const candidates: Array<{ path: string; chainIdHint?: number }> = [
    { path: path.join(attDirAbs, "attestation.sepolia.json"), chainIdHint: 11155111 },
    { path: path.join(attDirAbs, "attestation.mainnet.json"), chainIdHint: 1 },
    { path: path.join(attDirAbs, "attestation.json"), chainIdHint: undefined },
  ].filter((entry) => fs.existsSync(entry.path));

  if (candidates.length === 0) {
    throw new Error(`Attestation bulunamadı: ${attDirAbs}`);
  }

  if (wantChainId !== undefined) {
    for (const candidate of candidates) {
      if (candidate.chainIdHint === wantChainId) {
        return candidate.path;
      }

      try {
        const candidateJson: Record<string, unknown> =
          readJsonFile<Record<string, unknown>>(candidate.path);
        if (typeof candidateJson.chain_id === "number" && candidateJson.chain_id === wantChainId) {
          return candidate.path;
        }
      } catch {
        // ignore malformed candidate here; normal validation later zaten patlatacak
      }
    }
  }

  const preferredSepolia = candidates.find((c) => c.chainIdHint === 11155111);
  if (preferredSepolia) return preferredSepolia.path;

  return candidates[0].path;
}

async function verifyOnchain(
  att: Attestation,
  receiptPath: string,
  rpcUrl: string
): Promise<VerifyOnchainResult> {
  const receipt = readJsonFile<PublishReceipt>(receiptPath);

  const registry = normalizeAddressStrict(
    att.reserve_registry_address,
    "attestation.reserve_registry_address"
  );
  const reportIdBytes32 = reportIdToBytes32(att.report_id);
  const expectedGramsStr = toBigIntStrict(
    att.attested_fine_gold_grams,
    "attestation.attested_fine_gold_grams"
  ).toString();

  if (receipt.registry !== undefined) {
    const receiptRegistry = normalizeAddressStrict(receipt.registry, "receipt.registry");
    if (receiptRegistry !== registry) {
      throw new Error(
        `Receipt registry mismatch. receipt=${receiptRegistry}, attestation=${registry}`
      );
    }
  }

  if (receipt.chainId !== undefined && receipt.chainId !== att.chain_id) {
    throw new Error(
      `Receipt chainId mismatch. receipt=${receipt.chainId}, attestation.chain_id=${att.chain_id}`
    );
  }

  const receiptReportId = receipt.reportId ?? receipt.report_id;
  if (receiptReportId !== undefined && receiptReportId !== att.report_id) {
    throw new Error(
      `Receipt report_id mismatch. receipt=${receiptReportId}, attestation=${att.report_id}`
    );
  }

  if (receipt.status !== undefined && Number(receipt.status) !== 1) {
    throw new Error(`Receipt status != 1. status=${receipt.status}`);
  }

  if (receipt.mined !== undefined && receipt.mined !== true) {
    throw new Error("Receipt mined=false.");
  }

  const txHash = requireString(receipt.txHash, "receipt.txHash");
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new Error(`Receipt txHash invalid: ${txHash}`);
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const net = await provider.getNetwork();
  const rpcChainId = Number(net.chainId);

  if (rpcChainId !== att.chain_id) {
    throw new Error(
      `RPC chainId mismatch. rpc=${rpcChainId}, attestation.chain_id=${att.chain_id}`
    );
  }

  const txReceipt = await provider.getTransactionReceipt(txHash);
  if (!txReceipt) {
    throw new Error(`Tx receipt bulunamadı: ${txHash}`);
  }

  const status = Number(txReceipt.status ?? -1);
  if (status !== 1) {
    throw new Error(`Tx status != 1. status=${status} tx=${txHash}`);
  }

  if (receipt.blockNumber !== undefined && txReceipt.blockNumber !== Number(receipt.blockNumber)) {
    throw new Error(
      `blockNumber mismatch. receipt=${receipt.blockNumber}, rpc=${txReceipt.blockNumber}`
    );
  }

  const iface = new Interface(REGISTRY_ABI);

  let publishedEvent: PublishedEventRecord | null = null;

  for (const log of txReceipt.logs) {
    const logAddress = normalizeAddressStrict(log.address, "log.address");
    if (logAddress !== registry) continue;

    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "AttestationPublished") {
        publishedEvent = coercePublishedEventArgs(parsed.args);
        break;
      }
    } catch {
      // registry üzerindeki başka log olabilir; görmezden gel
    }
  }

  if (!publishedEvent) {
    throw new Error("AttestationPublished event bulunamadı.");
  }

  if (publishedEvent.reportId.toLowerCase() !== reportIdBytes32.toLowerCase()) {
    throw new Error("Event reportId mismatch.");
  }
  if (publishedEvent.asOfTimestamp !== String(att.as_of_timestamp)) {
    throw new Error("Event asOfTimestamp mismatch.");
  }
  if (publishedEvent.attestedFineGoldGrams !== expectedGramsStr) {
    throw new Error("Event attestedFineGoldGrams mismatch.");
  }
  if (publishedEvent.merkleRoot.toLowerCase() !== att.merkle_root.toLowerCase()) {
    throw new Error("Event merkleRoot mismatch.");
  }
  if (publishedEvent.barListHash.toLowerCase() !== att.bar_list_hash.toLowerCase()) {
    throw new Error("Event barListHash mismatch.");
  }
  if (
    normalizeAddressStrict(publishedEvent.signer, "event.signer") !==
    normalizeAddressStrict(att.signer_address, "attestation.signer_address")
  ) {
    throw new Error("Event signer mismatch.");
  }

  const contract = getContract(registry, provider);
  const exists = await contract.exists(reportIdBytes32);

  if (!exists) {
    throw new Error(`On-chain attestation yok: ${reportIdBytes32}`);
  }

  const rawRecord = await contract.getAttestation(reportIdBytes32);
  const record = coerceAttestationRecord(rawRecord);

  if (record.asOfTimestamp !== String(att.as_of_timestamp)) {
    throw new Error("On-chain asOfTimestamp mismatch.");
  }
  if (record.attestedFineGoldGrams !== expectedGramsStr) {
    throw new Error("On-chain attestedFineGoldGrams mismatch.");
  }
  if (record.merkleRoot.toLowerCase() !== att.merkle_root.toLowerCase()) {
    throw new Error("On-chain merkleRoot mismatch.");
  }
  if (record.barListHash.toLowerCase() !== att.bar_list_hash.toLowerCase()) {
    throw new Error("On-chain barListHash mismatch.");
  }
  if (
    normalizeAddressStrict(record.signer, "record.signer") !==
    normalizeAddressStrict(att.signer_address, "attestation.signer_address")
  ) {
    throw new Error("On-chain signer mismatch.");
  }
  if (record.publishedAt !== publishedEvent.publishedAt) {
    throw new Error("On-chain publishedAt mismatch.");
  }

  return {
    ok: true,
    receipt_path: path.relative(process.cwd(), receiptPath),
    txHash,
    blockNumber: txReceipt.blockNumber,
    status: 1,
    event: publishedEvent,
    record,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const reportId =
    (typeof args.report_id === "string" && args.report_id) ||
    (typeof args.reportId === "string" && args.reportId) ||
    (typeof args.id === "string" && args.id) ||
    "";

  if (!reportId) usageAndExit(1);

  const base =
    typeof args.base === "string" && args.base.trim().length > 0 ? args.base.trim() : "transparency";

  const quiet = args.quiet === true;

  const rpc =
    (typeof args.rpc === "string" && args.rpc.trim()) ||
    process.env.RPC_URL ||
    process.env.SEPOLIA_RPC_URL ||
    process.env.MAINNET_RPC_URL ||
    "";

  const baseAbs = path.isAbsolute(base) ? base : path.join(process.cwd(), base);

  const barListPath = path.join(baseAbs, "barlists", reportId, "bar_list.json");
  const porOutputPath = path.join(baseAbs, "reserve_reports", reportId, "por_output.json");
  const attestationDir = path.join(baseAbs, "attestations", reportId);

  const barListBytes = fs.readFileSync(barListPath);
  const barList = basicValidateBarList(JSON.parse(barListBytes.toString("utf8")));

  if (barList.report_id !== reportId) {
    throw new Error(`bar_list.report_id mismatch. file=${barList.report_id}, arg=${reportId}`);
  }

  const recomputed = recomputeFromBarList(barList, new Uint8Array(barListBytes));

  const porOutput = basicValidatePorOutput(readJsonFile<unknown>(porOutputPath));

  if (porOutput.report_id !== reportId) {
    throw new Error(`por_output.report_id mismatch. file=${porOutput.report_id}, arg=${reportId}`);
  }

  if (porOutput.as_of_timestamp !== recomputed.as_of_timestamp) {
    throw new Error(
      `as_of_timestamp mismatch. por_output=${porOutput.as_of_timestamp}, recomputed=${recomputed.as_of_timestamp}`
    );
  }

  const porBarsCount = toBigIntStrict(porOutput.bars_count, "por_output.bars_count");
  const recomputedBarsCount = BigInt(recomputed.bars_count);

  if (porBarsCount !== recomputedBarsCount) {
    throw new Error(
      `bars_count mismatch. por_output=${toDecString(porOutput.bars_count, "por_output.bars_count")}, recomputed=${recomputedBarsCount.toString()}`
    );
  }

  const porGrams = toBigIntStrict(
    porOutput.attested_fine_gold_grams,
    "por_output.attested_fine_gold_grams"
  );

  if (porGrams !== recomputed.attested_fine_gold_grams) {
    throw new Error(
      `attested_fine_gold_grams mismatch. por_output=${toDecString(
        porOutput.attested_fine_gold_grams,
        "por_output.attested_fine_gold_grams"
      )}, recomputed=${recomputed.attested_fine_gold_grams.toString()}`
    );
  }

  if (porOutput.bar_list_hash !== recomputed.bar_list_hash) {
    throw new Error(
      `bar_list_hash mismatch. por_output=${porOutput.bar_list_hash}, recomputed=${recomputed.bar_list_hash}`
    );
  }

  if (porOutput.merkle_root !== recomputed.merkle_root) {
    throw new Error(
      `merkle_root mismatch. por_output=${porOutput.merkle_root}, recomputed=${recomputed.merkle_root}`
    );
  }

  const receiptArg =
    typeof args.receipt === "string" && args.receipt.trim().length > 0 ? args.receipt.trim() : "";
  const autoReceipt = receiptArg ? null : tryFindReceiptPath(attestationDir);
  const receiptPath = (receiptArg || autoReceipt || "").trim();

  let wantChainId: number | undefined;
  if (receiptPath) {
    try {
      const receipt = readJsonFile<PublishReceipt>(receiptPath);
      if (typeof receipt.chainId === "number") {
        wantChainId = receipt.chainId;
      }
    } catch {
      // gerçek hata normal akışta verifyOnchain içinde patlayacak
    }
  }

  const attestationPath = pickAttestationPath(attestationDir, wantChainId);
  const attestation = basicValidateAttestation(readJsonFile<unknown>(attestationPath));

  if (attestation.report_id !== reportId) {
    throw new Error(
      `attestation.report_id mismatch. file=${attestation.report_id}, arg=${reportId}`
    );
  }

  const attGrams = toBigIntStrict(
    attestation.attested_fine_gold_grams,
    "attestation.attested_fine_gold_grams"
  );

  if (attestation.as_of_timestamp !== porOutput.as_of_timestamp) {
    throw new Error("attestation.as_of_timestamp != por_output.as_of_timestamp");
  }
  if (attGrams !== porGrams) {
    throw new Error("attestation.attested_fine_gold_grams != por_output.attested_fine_gold_grams");
  }
  if (attestation.merkle_root !== porOutput.merkle_root) {
    throw new Error("attestation.merkle_root != por_output.merkle_root");
  }
  if (attestation.bar_list_hash !== porOutput.bar_list_hash) {
    throw new Error("attestation.bar_list_hash != por_output.bar_list_hash");
  }

  const recoveredSigner = verifyAttestationSignature(attestation);

  let onchain: VerifyOnchainResult | null = null;
  if (receiptPath) {
    if (!rpc) {
      throw new Error(
        `publish_receipt bulundu ama RPC yok. --rpc ver veya RPC_URL/SEPOLIA_RPC_URL env set et. receipt=${receiptPath}`
      );
    }

    onchain = await verifyOnchain(attestation, receiptPath, rpc);
  }

  if (!quiet) {
    const out: {
      ok: true;
      report_id: string;
      recovered_signer: string;
      chain_id: number;
      registry: string;
      paths: {
        bar_list: string;
        por_output: string;
        attestation: string;
        receipt?: string;
      };
      onchain?: VerifyOnchainResult;
    } = {
      ok: true,
      report_id: reportId,
      recovered_signer: recoveredSigner,
      chain_id: attestation.chain_id,
      registry: normalizeAddressStrict(
        attestation.reserve_registry_address,
        "attestation.reserve_registry_address"
      ),
      paths: {
        bar_list: path.relative(process.cwd(), barListPath),
        por_output: path.relative(process.cwd(), porOutputPath),
        attestation: path.relative(process.cwd(), attestationPath),
      },
    };

    if (receiptPath) {
      out.paths.receipt = path.relative(process.cwd(), receiptPath);
    }

    if (onchain) {
      out.onchain = onchain;
    }

    console.log(JSON.stringify(out, null, 2));
  }
}

main().catch((err: unknown) => {
  console.error(`FAIL: ${errorMessage(err)}`);
  process.exit(1);
});