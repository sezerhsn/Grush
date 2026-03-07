import fs from "node:fs";
import path from "node:path";
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  getAddress,
  isAddress,
  parseUnits,
  type Log,
  type TransactionReceipt,
} from "ethers";
import {
  assertBytes32Hex,
  normalizeAddress,
  reportIdToBytes32,
} from "../merkle/hash_utils.ts";

type JsonUint = number | string;
type ParsedArgs = Record<string, string | boolean>;

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
  txHash: string;
  chainId: number;
  registry: string;
  reportId: string;
  report_id: string;
  publishedReportId: string;
  publisher: string;
  signer: string;
  blockNumber: number;
  status: number;
  mined: true;
  publishedAt: string;
};

type TxOverrides = {
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
};

type ContractTx = {
  hash: string;
  wait: (confirmations?: number) => Promise<TransactionReceipt | null>;
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

type RegistryContractLike = Contract & {
  isAllowedSigner: (signer: string) => Promise<boolean>;
  exists: (reportId: string) => Promise<boolean>;
  getAttestation: (reportId: string) => Promise<unknown>;
  publishAttestation: (
    reportId: string,
    asOfTimestamp: number,
    attestedFineGoldGrams: string,
    merkleRoot: string,
    barListHash: string,
    signature: string,
    overrides?: TxOverrides
  ) => Promise<ContractTx>;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const ABI = [
  "function publishAttestation(bytes32 reportId,uint64 asOfTimestamp,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash,bytes signature) external returns (address)",
  "function isAllowedSigner(address signer) external view returns (bool)",
  "function exists(bytes32 reportId) external view returns (bool)",
  "function getAttestation(bytes32 reportId) external view returns (tuple(uint64 asOfTimestamp,uint64 publishedAt,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash,address signer))",
  "event AttestationPublished(bytes32 indexed reportId,uint64 indexed asOfTimestamp,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash,address indexed signer,uint64 publishedAt)",
] as const;

function usageAndExit(code = 1): never {
  console.error(`
Usage:
  npx tsx por/attestation/publish_onchain.ts --in <attestation.json> --rpc <RPC_URL> --pk <PUBLISHER_PRIVATE_KEY> [--outReceipt <publish_receipt.json>] [--gasPriceGwei <n>] [--nonce <n>]
  npm run por:publish -- --in <attestation.json> --rpc <RPC_URL> --pk <PUBLISHER_PRIVATE_KEY>

Alternative (env):
  PUBLISHER_PRIVATE_KEY=0x... npx tsx por/attestation/publish_onchain.ts --in <attestation.json>

Legacy (env):
  PUBLISHER_PK=0x... npx tsx por/attestation/publish_onchain.ts --in <attestation.json>

RPC resolution:
  - chain_id=11155111 => SEPOLIA_RPC_URL, fallback RPC_URL
  - chain_id=1        => MAINNET_RPC_URL, fallback RPC_URL

Mainnet lock:
  - chain_id=1 ise CONFIRM_MAINNET_DEPLOY=true olmadan publish yok.

Validations:
  - attestation.chain_id == provider chainId
  - attestation.reserve_registry_address == domain.verifyingContract
  - signer signature format + bytes32 fields
  - isAllowedSigner(attestation.signer_address) == true
  - mined tx receipt status == 1
  - AttestationPublished event zorunlu cross-check
  - exists/getAttestation on-chain state zorunlu cross-check

Options:
  --outReceipt       output path for publish_receipt.json (default: alongside --in)
  --gasPriceGwei     legacy gas price override
  --maxFeeGwei       EIP-1559 max fee override
  --maxPriorityGwei  EIP-1559 priority fee override
  --nonce            manually set nonce
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

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} non-empty string olmalı.`);
  }
  return value;
}

function assertSafeInt(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new Error(`${name} safe integer olmalı. Aldım: ${String(value)}`);
  }

  if (value < 0) {
    throw new Error(`${name} negatif olamaz. Aldım: ${value}`);
  }
}

function envBool(key: string, def = false): boolean {
  const v = (process.env[key] || "").trim().toLowerCase();
  if (!v) return def;
  return v === "true" || v === "1" || v === "yes" || v === "y";
}

function toBigIntStrict(value: unknown, name: string): bigint {
  if (typeof value === "bigint") return value;

  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${name} integer olmalı. Aldım: ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${name} MAX_SAFE_INTEGER üstünde. JSON'da decimal string kullan. Aldım: ${value}`);
    }
    if (value < 0) {
      throw new Error(`${name} negatif olamaz. Aldım: ${value}`);
    }
    return BigInt(value);
  }

  if (typeof value === "string") {
    const s = value.trim();
    if (!/^[0-9]+$/.test(s)) {
      throw new Error(`${name} decimal string olmalı. Aldım: ${value}`);
    }
    return BigInt(s);
  }

  throw new Error(`${name} number|string olmalı. Aldım: ${String(value)}`);
}

function normalizePrivateKey(pk: string): string {
  const v = pk.trim();
  if (!v) return "";
  return v.startsWith("0x") ? v : `0x${v}`;
}

function assertPrivateKey(pk: string, label: string): string {
  const normalized = normalizePrivateKey(pk);

  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} invalid private key format.`);
  }

  return normalized;
}

function normalizeAddressStrict(address: string, label: string): string {
  const normalized = normalizeAddress(address);

  if (!isAddress(normalized)) {
    throw new Error(`${label} invalid address: ${address}`);
  }

  const checksummed = getAddress(normalized);
  if (checksummed.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    throw new Error(`${label} ZERO address olamaz.`);
  }

  return checksummed;
}

function assertSig65(sig: unknown): asserts sig is string {
  if (typeof sig !== "string") {
    throw new Error("signature string değil.");
  }

  if (!/^0x[a-fA-F0-9]{130}$/.test(sig)) {
    throw new Error("signature 65-byte hex değil (0x + 130 hex).");
  }
}

function readJsonFile<T>(filePath: string): T {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

  if (!fs.existsSync(abs)) {
    throw new Error(`Dosya bulunamadı: ${abs}`);
  }

  return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
}

function loadAttestation(input: unknown): Attestation {
  if (!isRecord(input)) throw new Error("Attestation JSON object değil.");
  if (input.schema_version !== "0.1") throw new Error("schema_version 0.1 değil.");
  if (input.signature_scheme !== "eip712") throw new Error("signature_scheme eip712 değil.");
  if (input.eip712_types_version !== "0.1") throw new Error("eip712_types_version 0.1 değil.");

  const report_id = requireString(input.report_id, "report_id");

  const as_of_timestamp = input.as_of_timestamp;
  assertSafeInt(as_of_timestamp, "as_of_timestamp");

  const attested_fine_gold_grams = toBigIntStrict(
    input.attested_fine_gold_grams,
    "attested_fine_gold_grams"
  ).toString();

  const chain_id = input.chain_id;
  assertSafeInt(chain_id, "chain_id");

  const merkle_root = requireString(input.merkle_root, "merkle_root");
  const bar_list_hash = requireString(input.bar_list_hash, "bar_list_hash");
  assertBytes32Hex(merkle_root, "merkle_root");
  assertBytes32Hex(bar_list_hash, "bar_list_hash");

  const reserve_registry_address = normalizeAddressStrict(
    requireString(input.reserve_registry_address, "reserve_registry_address"),
    "reserve_registry_address"
  );
  const signer_address = normalizeAddressStrict(
    requireString(input.signer_address, "signer_address"),
    "signer_address"
  );

  if (!isRecord(input.eip712_domain)) {
    throw new Error("eip712_domain missing.");
  }

  if (input.eip712_domain.name !== "GRUSH Reserve Attestation") {
    throw new Error("domain.name mismatch.");
  }
  if (input.eip712_domain.version !== "1") {
    throw new Error("domain.version mismatch.");
  }

  const domainChainId = input.eip712_domain.chainId;
  assertSafeInt(domainChainId, "domain.chainId");

  const verifyingContract = normalizeAddressStrict(
    requireString(input.eip712_domain.verifyingContract, "domain.verifyingContract"),
    "domain.verifyingContract"
  );

  if (verifyingContract !== reserve_registry_address) {
    throw new Error("eip712_domain.verifyingContract reserve_registry_address ile uyuşmuyor.");
  }

  if (domainChainId !== chain_id) {
    throw new Error("eip712_domain.chainId chain_id ile uyuşmuyor.");
  }

  assertSig65(input.signature);

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
    signature: input.signature,
  };
}

function resolvePublisherPk(
  argsPk: string
): { pk: string; used: "arg" | "PUBLISHER_PRIVATE_KEY" | "PUBLISHER_PK" | "none" } {
  const arg = normalizePrivateKey(argsPk || "");
  if (arg) return { pk: assertPrivateKey(arg, "--pk"), used: "arg" };

  const preferred = normalizePrivateKey(process.env.PUBLISHER_PRIVATE_KEY || "");
  if (preferred) {
    return {
      pk: assertPrivateKey(preferred, "PUBLISHER_PRIVATE_KEY"),
      used: "PUBLISHER_PRIVATE_KEY",
    };
  }

  const legacy = normalizePrivateKey(process.env.PUBLISHER_PK || "");
  if (legacy) {
    return {
      pk: assertPrivateKey(legacy, "PUBLISHER_PK"),
      used: "PUBLISHER_PK",
    };
  }

  return { pk: "", used: "none" };
}

function resolveRpc(argsRpc: string, chainId: number): { rpc: string; used: string } {
  const arg = (argsRpc || "").trim();
  if (arg) return { rpc: arg, used: "--rpc" };

  if (chainId === 11155111) {
    const sepolia = (process.env.SEPOLIA_RPC_URL || "").trim();
    if (sepolia) return { rpc: sepolia, used: "SEPOLIA_RPC_URL" };
  }

  if (chainId === 1) {
    const mainnet = (process.env.MAINNET_RPC_URL || "").trim();
    if (mainnet) return { rpc: mainnet, used: "MAINNET_RPC_URL" };
  }

  const fallback = (process.env.RPC_URL || "").trim();
  if (fallback) return { rpc: fallback, used: "RPC_URL" };

  return { rpc: "", used: "none" };
}

function assertMainnetConfirmed(chainId: number): void {
  if (chainId !== 1) return;

  const ok = envBool("CONFIRM_MAINNET_DEPLOY", false);
  if (!ok) {
    throw new Error("MAINNET LOCK: chainId=1 için CONFIRM_MAINNET_DEPLOY=true set etmeden publish yok.");
  }
}

function parsePositiveGwei(value: string, label: string): bigint {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} invalid gwei.`);
  }
  return parseUnits(String(n), "gwei");
}

function buildTxOverrides(args: ParsedArgs): TxOverrides {
  const gasPriceGweiStr = typeof args.gasPriceGwei === "string" ? args.gasPriceGwei : "";
  const maxFeeGweiStr = typeof args.maxFeeGwei === "string" ? args.maxFeeGwei : "";
  const maxPriorityGweiStr =
    typeof args.maxPriorityGwei === "string" ? args.maxPriorityGwei : "";
  const nonceStr = typeof args.nonce === "string" ? args.nonce : "";

  const overrides: TxOverrides = {};

  if (gasPriceGweiStr && (maxFeeGweiStr || maxPriorityGweiStr)) {
    throw new Error("Fee config invalid: gasPriceGwei ile maxFeeGwei/maxPriorityGwei aynı anda set edilmez.");
  }

  if ((maxFeeGweiStr && !maxPriorityGweiStr) || (!maxFeeGweiStr && maxPriorityGweiStr)) {
    throw new Error("Fee config invalid: EIP-1559 için maxFeeGwei ve maxPriorityGwei birlikte set edilmeli.");
  }

  if (gasPriceGweiStr) {
    overrides.gasPrice = parsePositiveGwei(gasPriceGweiStr, "gasPriceGwei");
  }

  if (maxFeeGweiStr) {
    overrides.maxFeePerGas = parsePositiveGwei(maxFeeGweiStr, "maxFeeGwei");
    overrides.maxPriorityFeePerGas = parsePositiveGwei(
      maxPriorityGweiStr,
      "maxPriorityGwei"
    );
  }

  if (nonceStr) {
    const nonce = Number(nonceStr);
    if (!Number.isInteger(nonce) || nonce < 0) {
      throw new Error("nonce invalid.");
    }
    overrides.nonce = nonce;
  }

  return overrides;
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
  const publishedAt = toBigIntStrict(
    tuple.publishedAt ?? tuple[6],
    "event.publishedAt"
  ).toString();

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

function coerceAttestationRecord(rec: unknown): OnchainAttestationRecord {
  const tuple = toTupleLike(rec, "on-chain attestation record");

  const asOfTimestamp = toBigIntStrict(
    tuple.asOfTimestamp ?? tuple[0],
    "record.asOfTimestamp"
  ).toString();
  const publishedAt = toBigIntStrict(
    tuple.publishedAt ?? tuple[1],
    "record.publishedAt"
  ).toString();
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

function findPublishedEvent(
  receipt: TransactionReceipt,
  registryAddress: string
): PublishedEventRecord {
  const iface = new Interface(ABI);

  for (const log of receipt.logs as readonly Log[]) {
    const logAddress = normalizeAddressStrict(log.address, "log.address");
    if (logAddress !== registryAddress) continue;

    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "AttestationPublished") {
        return coercePublishedEventArgs(parsed.args);
      }
    } catch {
      // registry üzerinde başka log olabilir
    }
  }

  throw new Error("AttestationPublished event bulunamadı.");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const inPath = typeof args.in === "string" ? args.in : "";
  if (!inPath) usageAndExit(1);

  const outReceiptArg = typeof args.outReceipt === "string" ? args.outReceipt : "";

  const absIn = path.isAbsolute(inPath) ? inPath : path.join(process.cwd(), inPath);
  const att = loadAttestation(readJsonFile<unknown>(absIn));

  const { rpc, used: rpcUsed } = resolveRpc(
    typeof args.rpc === "string" ? args.rpc : "",
    att.chain_id
  );
  if (!rpc) {
    throw new Error(
      `RPC URL yok. --rpc ver veya env set et (chain_id=${att.chain_id} için uygun RPC).`
    );
  }

  const { pk, used: pkUsed } = resolvePublisherPk(
    typeof args.pk === "string" ? args.pk : ""
  );
  if (!pk) {
    throw new Error("Publisher private key yok. --pk ver veya PUBLISHER_PRIVATE_KEY (legacy: PUBLISHER_PK) env set et.");
  }
  if (pkUsed === "PUBLISHER_PK") {
    console.warn("WARN: PUBLISHER_PK (legacy) kullanılıyor. PUBLISHER_PRIVATE_KEY'e geç.");
  }

  assertMainnetConfirmed(att.chain_id);

  const absOutReceipt = outReceiptArg
    ? path.isAbsolute(outReceiptArg)
      ? outReceiptArg
      : path.join(process.cwd(), outReceiptArg)
    : path.join(path.dirname(absIn), "publish_receipt.json");

  const provider = new JsonRpcProvider(rpc);
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  if (!Number.isInteger(chainId) || chainId < 1) {
    throw new Error("Provider chainId invalid.");
  }

  if (chainId !== att.chain_id) {
    throw new Error(
      `ChainId mismatch. provider=${chainId}, attestation.chain_id=${att.chain_id} (RPC source: ${rpcUsed}, pk source: ${pkUsed})`
    );
  }

  const wallet = new Wallet(pk, provider);
  const publisher = normalizeAddressStrict(await wallet.getAddress(), "publisher");
  const registryAddress = normalizeAddressStrict(
    att.reserve_registry_address,
    "reserve_registry_address"
  );

  const registry = new Contract(registryAddress, ABI, wallet) as unknown as RegistryContractLike;

  const allowed = await registry.isAllowedSigner(att.signer_address);
  if (!allowed) {
    throw new Error(
      `Signer not allowed on-chain: ${att.signer_address}. Önce setAllowedSigner(true) yap.`
    );
  }

  const reportIdBytes32 = reportIdToBytes32(att.report_id);
  const expectedGrams = toBigIntStrict(
    att.attested_fine_gold_grams,
    "attested_fine_gold_grams"
  ).toString();

  const overrides = buildTxOverrides(args);

  const tx = await registry.publishAttestation(
    reportIdBytes32,
    att.as_of_timestamp,
    expectedGrams,
    att.merkle_root,
    att.bar_list_hash,
    att.signature,
    overrides
  );

  console.log(
    JSON.stringify(
      {
        submitted: true,
        publisher,
        chain_id: chainId,
        reserve_registry: registryAddress,
        report_id: att.report_id,
        report_id_bytes32: reportIdBytes32,
        tx_hash: tx.hash,
        rpc_source: rpcUsed,
        pk_source: pkUsed,
      },
      null,
      2
    )
  );

  const mined = await tx.wait();
  if (!mined) {
    throw new Error("Tx receipt null döndü.");
  }

  const statusNum = Number(mined.status ?? 0);
  const blockNumberNum = Number(mined.blockNumber ?? 0);

  if (statusNum !== 1) {
    throw new Error(`Tx status != 1. status=${statusNum}`);
  }

  if (!Number.isInteger(blockNumberNum) || blockNumberNum <= 0) {
    throw new Error("Tx receipt blockNumber invalid.");
  }

  const event = findPublishedEvent(mined, registryAddress);

  if (event.reportId.toLowerCase() !== reportIdBytes32.toLowerCase()) {
    throw new Error(`Event reportId mismatch. event=${event.reportId}, expected=${reportIdBytes32}`);
  }
  if (event.asOfTimestamp !== String(att.as_of_timestamp)) {
    throw new Error("Event asOfTimestamp mismatch.");
  }
  if (event.attestedFineGoldGrams !== expectedGrams) {
    throw new Error("Event attestedFineGoldGrams mismatch.");
  }
  if (event.merkleRoot.toLowerCase() !== att.merkle_root.toLowerCase()) {
    throw new Error("Event merkleRoot mismatch.");
  }
  if (event.barListHash.toLowerCase() !== att.bar_list_hash.toLowerCase()) {
    throw new Error("Event barListHash mismatch.");
  }
  if (
    normalizeAddressStrict(event.signer, "event.signer") !==
    normalizeAddressStrict(att.signer_address, "att.signer_address")
  ) {
    throw new Error("Event signer mismatch.");
  }

  const exists = await registry.exists(reportIdBytes32);
  if (!exists) {
    throw new Error(`On-chain attestation yok: ${reportIdBytes32}`);
  }

  const rawRecord = await registry.getAttestation(reportIdBytes32);
  const record = coerceAttestationRecord(rawRecord);

  if (record.asOfTimestamp !== String(att.as_of_timestamp)) {
    throw new Error("On-chain asOfTimestamp mismatch.");
  }
  if (record.attestedFineGoldGrams !== expectedGrams) {
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
    normalizeAddressStrict(att.signer_address, "att.signer_address")
  ) {
    throw new Error("On-chain signer mismatch.");
  }
  if (record.publishedAt !== event.publishedAt) {
    throw new Error("On-chain publishedAt mismatch.");
  }

  const outReceipt: PublishReceipt = {
    txHash: tx.hash,
    chainId,
    registry: registryAddress,
    reportId: att.report_id,
    report_id: att.report_id,
    publishedReportId: reportIdBytes32,
    publisher,
    signer: normalizeAddressStrict(att.signer_address, "att.signer_address"),
    blockNumber: blockNumberNum,
    status: statusNum,
    mined: true,
    publishedAt: event.publishedAt,
  };

  fs.mkdirSync(path.dirname(absOutReceipt), { recursive: true });
  fs.writeFileSync(absOutReceipt, `${JSON.stringify(outReceipt, null, 2)}\n`, {
    encoding: "utf8",
  });

  console.log(
    JSON.stringify(
      {
        mined: true,
        receipt_written: absOutReceipt,
        blockNumber: blockNumberNum,
        status: statusNum,
        publishedAt: event.publishedAt,
      },
      null,
      2
    )
  );

  if (publisher === normalizeAddressStrict(att.signer_address, "att.signer_address")) {
    console.warn("WARN: Publisher address attestation signer ile aynı. Ayrı anahtarlar kullanmanız önerilir.");
  }
}

main().catch((err: unknown) => {
  console.error("FAIL:", errorMessage(err));
  process.exit(1);
});