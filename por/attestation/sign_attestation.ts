import fs from "node:fs";
import path from "node:path";
import {
  Wallet,
  getAddress,
  isAddress,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";
import {
  assertBytes32Hex,
  normalizeAddress,
  reportIdToBytes32,
  toSafeJsonInteger,
  toUintBigInt,
  type JsonUint,
} from "../merkle/hash_utils.ts";

type ParsedArgs = Record<string, string | boolean>;
type JsonRecord = Record<string, unknown>;
type TypedDataTypes = Record<string, TypedDataField[]>;
type TypedDataMessage = Record<string, unknown>;

type AttestationInput = {
  schema_version: "0.1";
  report_id: string;
  as_of_timestamp: JsonUint;
  attested_fine_gold_grams: JsonUint;
  merkle_root: string;
  bar_list_hash: string;
};

type ResolveSignerPkResult = {
  pk: string;
  used: "arg" | "SIGNER_PRIVATE_KEY" | "ATTESTATION_SIGNER_PK" | "none";
};

type TypedDataSignerLike = {
  signTypedData?: (
    domain: TypedDataDomain,
    types: TypedDataTypes,
    value: TypedDataMessage
  ) => Promise<string>;
  _signTypedData?: (
    domain: TypedDataDomain,
    types: TypedDataTypes,
    value: TypedDataMessage
  ) => Promise<string>;
};

type AttestationOutput = {
  schema_version: "0.1";
  report_id: string;
  as_of_timestamp: number;
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

function usageAndExit(code = 1): never {
  // eslint-disable-next-line no-console
  console.error(`
Usage:
  npx tsx por/attestation/sign_attestation.ts --in <por-output.json> --registry <0x..> --chainId 1 --pk <0x..> [--out <attestation.json>]
  npm run por:sign -- --in <por-output.json> --registry <0x..> --chainId 1 [--out <attestation.json>]

Alternative (env):
  SIGNER_PRIVATE_KEY=<hex private key> npx tsx por/attestation/sign_attestation.ts --in <por-output.json> --registry <0x..> --chainId 1

Legacy (env):
  ATTESTATION_SIGNER_PK=<hex private key> npx tsx por/attestation/sign_attestation.ts --in <por-output.json> --registry <0x..> --chainId 1

Notes:
- Large integers MUST be represented as decimal strings in JSON to avoid IEEE-754 precision loss.
- report_id typed field is bytes32. If report_id is not a bytes32 hex, it will be mapped as:
  reportIdBytes32 = keccak256(utf8(report_id))
`);
  process.exit(code);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};

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

function readJsonFile<T>(filePath: string): T {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Dosya bulunamadı: ${absolutePath}`);
  }

  return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as T;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} non-empty string olmalı.`);
  }
  return value.trim();
}

function normalizePrivateKey(pk: string): string {
  const trimmed = pk.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
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
  if (checksummed.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    throw new Error(`${label} ZERO address olamaz.`);
  }

  return checksummed;
}

function toPositiveSafeChainId(value: string): number {
  const asBigInt = toUintBigInt(value, "chainId");

  if (asBigInt < 1n) {
    throw new Error(`chainId >= 1 olmalı. Aldım: ${asBigInt.toString()}`);
  }

  if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`chainId MAX_SAFE_INTEGER üstünde olamaz. Aldım: ${asBigInt.toString()}`);
  }

  return Number(asBigInt);
}

function basicValidateInput(input: unknown): AttestationInput {
  if (!isRecord(input)) {
    throw new Error("Input JSON object değil.");
  }

  if (input.schema_version !== "0.1") {
    throw new Error("schema_version 0.1 değil.");
  }

  const report_id = requireString(input.report_id, "report_id");
  const as_of_timestamp = input.as_of_timestamp;
  const attested_fine_gold_grams = input.attested_fine_gold_grams;
  const merkle_root = requireString(input.merkle_root, "merkle_root");
  const bar_list_hash = requireString(input.bar_list_hash, "bar_list_hash");

  toSafeJsonInteger(as_of_timestamp as JsonUint, "as_of_timestamp");
  toUintBigInt(attested_fine_gold_grams as JsonUint, "attested_fine_gold_grams");

  assertBytes32Hex(merkle_root, "merkle_root");
  assertBytes32Hex(bar_list_hash, "bar_list_hash");

  return {
    schema_version: "0.1",
    report_id,
    as_of_timestamp: as_of_timestamp as JsonUint,
    attested_fine_gold_grams: attested_fine_gold_grams as JsonUint,
    merkle_root,
    bar_list_hash,
  };
}

function resolveSignerPk(argsPk: string): ResolveSignerPkResult {
  const arg = normalizePrivateKey(argsPk || "");
  if (arg) {
    return { pk: assertPrivateKey(arg, "--pk"), used: "arg" };
  }

  const preferred = normalizePrivateKey(process.env.SIGNER_PRIVATE_KEY || "");
  if (preferred) {
    return {
      pk: assertPrivateKey(preferred, "SIGNER_PRIVATE_KEY"),
      used: "SIGNER_PRIVATE_KEY",
    };
  }

  const legacy = normalizePrivateKey(process.env.ATTESTATION_SIGNER_PK || "");
  if (legacy) {
    return {
      pk: assertPrivateKey(legacy, "ATTESTATION_SIGNER_PK"),
      used: "ATTESTATION_SIGNER_PK",
    };
  }

  return { pk: "", used: "none" };
}

async function signTypedDataCompat(
  signer: TypedDataSignerLike,
  domain: TypedDataDomain,
  types: TypedDataTypes,
  message: TypedDataMessage
): Promise<string> {
  if (typeof signer.signTypedData === "function") {
    return signer.signTypedData(domain, types, message);
  }

  if (typeof signer._signTypedData === "function") {
    return signer._signTypedData(domain, types, message);
  }

  throw new Error("Wallet typed-data signing fonksiyonu yok.");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) {
    usageAndExit(0);
  }

  const inPath = typeof args.in === "string" ? args.in : "";
  const registryArg = typeof args.registry === "string" ? args.registry : "";
  const chainIdStr = typeof args.chainId === "string" ? args.chainId : "1";
  const outPath = typeof args.out === "string" ? args.out : "";

  if (!inPath || !registryArg) {
    usageAndExit(1);
  }

  const { pk, used } = resolveSignerPk(typeof args.pk === "string" ? args.pk : "");
  if (!pk) {
    throw new Error(
      "Signer private key yok. --pk ver veya SIGNER_PRIVATE_KEY (legacy: ATTESTATION_SIGNER_PK) env set et."
    );
  }

  if (used === "ATTESTATION_SIGNER_PK") {
    // eslint-disable-next-line no-console
    console.warn("WARN: ATTESTATION_SIGNER_PK (legacy) kullanılıyor. SIGNER_PRIVATE_KEY'e geç.");
  }

  const chainId = toPositiveSafeChainId(chainIdStr);
  const input = basicValidateInput(readJsonFile<unknown>(inPath));
  const reserveRegistryAddress = normalizeAddressStrict(registryArg, "registry");

  const wallet = new Wallet(pk);
  const signerAddress = normalizeAddressStrict(await wallet.getAddress(), "signer_address");

  const reportIdBytes32 = reportIdToBytes32(input.report_id);
  const asOfTimestamp = toSafeJsonInteger(input.as_of_timestamp, "as_of_timestamp");
  const attestedFineGoldGrams = toUintBigInt(
    input.attested_fine_gold_grams,
    "attested_fine_gold_grams"
  ).toString();

  const domain: TypedDataDomain = {
    name: "GRUSH Reserve Attestation",
    version: "1",
    chainId,
    verifyingContract: reserveRegistryAddress,
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

  const message: TypedDataMessage = {
    reportId: reportIdBytes32,
    asOfTimestamp,
    attestedFineGoldGrams,
    merkleRoot: input.merkle_root,
    barListHash: input.bar_list_hash,
  };

  const signature = await signTypedDataCompat(wallet, domain, types, message);

  const out: AttestationOutput = {
    schema_version: "0.1",
    report_id: input.report_id,
    as_of_timestamp: asOfTimestamp,
    attested_fine_gold_grams: attestedFineGoldGrams,
    merkle_root: input.merkle_root,
    bar_list_hash: input.bar_list_hash,
    chain_id: chainId,
    reserve_registry_address: reserveRegistryAddress,
    signer_address: signerAddress,
    signature_scheme: "eip712",
    eip712_domain: {
      name: "GRUSH Reserve Attestation",
      version: "1",
      chainId,
      verifyingContract: reserveRegistryAddress,
    },
    eip712_types_version: "0.1",
    signature,
  };

  const outJson = `${JSON.stringify(out, null, 2)}\n`;

  if (outPath) {
    const absoluteOutPath = path.isAbsolute(outPath)
      ? outPath
      : path.join(process.cwd(), outPath);
    fs.mkdirSync(path.dirname(absoluteOutPath), { recursive: true });
    fs.writeFileSync(absoluteOutPath, outJson, { encoding: "utf8" });
    // eslint-disable-next-line no-console
    console.log(`OK: wrote ${absoluteOutPath}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(outJson);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("ERROR:", errorMessage(err));
  process.exit(1);
});