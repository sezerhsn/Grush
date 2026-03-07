import fs from "node:fs";
import path from "node:path";
import hre from "hardhat";
import type { ContractRunner, ContractTransactionResponse } from "ethers";
import {
  assertBytes32Hex,
  toUintBigInt,
  type JsonUint,
} from "../../por/merkle/hash_utils.ts";

const { ethers } = await hre.network.connect();

const UINT64_MAX = (1n << 64n) - 1n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type SignedAttestation = {
  schema_version: "0.1";
  report_id: string;
  reportId: string;
  as_of_timestamp: JsonUint;
  attested_fine_gold_grams: JsonUint;
  merkle_root: string;
  bar_list_hash: string;
  signer: string;
  signature: string;
  eip712_domain: {
    verifyingContract: string;
    chainId?: JsonUint;
    name?: string;
    version?: string;
  };
};

type JsonRecord = Record<string, unknown>;

type ReserveRegistryLike = {
  connect(runner: ContractRunner | null): ReserveRegistryLike;
  PUBLISHER_ROLE(): Promise<string>;
  hasRole(role: string, account: string): Promise<boolean>;
  publishAttestation(
    reportId: string,
    asOfTimestamp: bigint,
    attestedFineGoldGrams: bigint,
    merkleRoot: string,
    barListHash: string,
    signature: string
  ): Promise<ContractTransactionResponse>;
  latestReportId(): Promise<string>;
  getReportIds(start: bigint | number, count: bigint | number): Promise<string[]>;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} non-empty string olmalı.`);
  }
  return value.trim();
}

function readJson<T>(filePath: string): T {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
}

function writeJson(filePath: string, obj: unknown): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  const json = JSON.stringify(
    obj,
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    2
  );

  fs.writeFileSync(abs, `${json}\n`, "utf8");
  return abs;
}

function normalizePk(pk: string): string {
  const trimmed = pk.trim();
  const normalized = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;

  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error("PUBLISHER_PRIVATE_KEY invalid format.");
  }

  return normalized;
}

function normalizeAddressStrict(address: string, label: string): string {
  if (!ethers.isAddress(address)) {
    throw new Error(`${label} address değil: ${address}`);
  }

  const checksummed = ethers.getAddress(address);
  if (checksummed.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    throw new Error(`${label} ZERO address olamaz.`);
  }

  return checksummed;
}

function assertSignature65(signature: string): void {
  if (!/^0x[a-fA-F0-9]{130}$/.test(signature)) {
    throw new Error(`signature 65-byte hex değil: ${signature}`);
  }
}

function toUint64BigInt(value: JsonUint, name: string): bigint {
  const asBigInt = toUintBigInt(value, name);
  if (asBigInt > UINT64_MAX) {
    throw new Error(`${name} uint64 sınırını aşıyor. Aldım: ${asBigInt.toString()}`);
  }
  return asBigInt;
}

function validateSignedAttestation(input: unknown): SignedAttestation {
  if (!isRecord(input)) {
    throw new Error("Signed attestation JSON object değil.");
  }

  if (input.schema_version !== "0.1") {
    throw new Error(`schema_version 0.1 değil: ${String(input.schema_version)}`);
  }

  const report_id = requireString(input.report_id, "report_id");
  const reportId = requireString(input.reportId, "reportId");
  const merkle_root = requireString(input.merkle_root, "merkle_root");
  const bar_list_hash = requireString(input.bar_list_hash, "bar_list_hash");
  const signer = normalizeAddressStrict(requireString(input.signer, "signer"), "signer");
  const signature = requireString(input.signature, "signature");

  assertBytes32Hex(reportId, "reportId");
  assertBytes32Hex(merkle_root, "merkle_root");
  assertBytes32Hex(bar_list_hash, "bar_list_hash");
  assertSignature65(signature);

  const as_of_timestamp = input.as_of_timestamp as JsonUint;
  const attested_fine_gold_grams = input.attested_fine_gold_grams as JsonUint;

  toUint64BigInt(as_of_timestamp, "as_of_timestamp");
  toUintBigInt(attested_fine_gold_grams, "attested_fine_gold_grams");

  if (!isRecord(input.eip712_domain)) {
    throw new Error("eip712_domain object değil.");
  }

  const verifyingContract = normalizeAddressStrict(
    requireString(input.eip712_domain.verifyingContract, "eip712_domain.verifyingContract"),
    "eip712_domain.verifyingContract"
  );

  if (input.eip712_domain.chainId !== undefined) {
    toUintBigInt(input.eip712_domain.chainId as JsonUint, "eip712_domain.chainId");
  }

  if (input.eip712_domain.name !== undefined) {
    requireString(input.eip712_domain.name, "eip712_domain.name");
  }

  if (input.eip712_domain.version !== undefined) {
    requireString(input.eip712_domain.version, "eip712_domain.version");
  }

  return {
    schema_version: "0.1",
    report_id,
    reportId,
    as_of_timestamp,
    attested_fine_gold_grams,
    merkle_root,
    bar_list_hash,
    signer,
    signature,
    eip712_domain: {
      verifyingContract,
      ...(input.eip712_domain.chainId !== undefined
        ? { chainId: input.eip712_domain.chainId as JsonUint }
        : {}),
      ...(input.eip712_domain.name !== undefined
        ? { name: requireString(input.eip712_domain.name, "eip712_domain.name") }
        : {}),
      ...(input.eip712_domain.version !== undefined
        ? { version: requireString(input.eip712_domain.version, "eip712_domain.version") }
        : {}),
    },
  };
}

async function main(): Promise<void> {
  const inPath = (process.env.ATTEST_IN ?? "por/reports/attestation_signed.json").trim();
  const outPath = (process.env.PUBLISH_OUT ?? "por/reports/publish_receipt.json").trim();

  const publisherPkRaw = process.env.PUBLISHER_PRIVATE_KEY;
  if (!publisherPkRaw) {
    throw new Error(`PUBLISHER_PRIVATE_KEY env yok. Örnek: set "PUBLISHER_PRIVATE_KEY=0xabc..."`);
  }

  const signed = validateSignedAttestation(readJson<unknown>(inPath));

  const registryAddr = normalizeAddressStrict(
    (process.env.REGISTRY_ADDR ?? signed.eip712_domain.verifyingContract).trim(),
    "REGISTRY_ADDR/verifyingContract"
  );

  if (registryAddr !== signed.eip712_domain.verifyingContract) {
    throw new Error(
      `Registry mismatch. signed.eip712_domain.verifyingContract=${signed.eip712_domain.verifyingContract}, REGISTRY_ADDR=${registryAddr}`
    );
  }

  const publisherWallet = new ethers.Wallet(normalizePk(publisherPkRaw), ethers.provider);

  const registry = (await ethers.getContractAt(
    "ReserveRegistry",
    registryAddr
  )) as unknown as ReserveRegistryLike;

  const skipRoleCheck = (process.env.SKIP_PUBLISHER_ROLE_CHECK ?? "").trim() === "1";
  if (!skipRoleCheck) {
    const role = await registry.PUBLISHER_ROLE();
    const ok = await registry.hasRole(role, publisherWallet.address);
    if (!ok) {
      throw new Error(
        `Publisher role yok: ${publisherWallet.address}\n` +
          `Çözüm: doğru publisher PK kullan veya admin ile role ver.`
      );
    }
  }

  const asOfTimestamp = toUint64BigInt(signed.as_of_timestamp, "as_of_timestamp");
  const attestedFineGoldGrams = toUintBigInt(
    signed.attested_fine_gold_grams,
    "attested_fine_gold_grams"
  );

  const tx = await registry
    .connect(publisherWallet)
    .publishAttestation(
      signed.reportId,
      asOfTimestamp,
      attestedFineGoldGrams,
      signed.merkle_root,
      signed.bar_list_hash,
      signed.signature
    );

  const rc = await tx.wait();

  const latest = await registry.latestReportId();
  const ids0 = await registry.getReportIds(0, 10);

  const out = {
    registry: registryAddr,
    publisher: publisherWallet.address,
    txHash: rc?.hash ?? tx.hash,
    blockNumber: rc?.blockNumber ?? null,
    status: rc?.status ?? null,
    publishedReportId: signed.reportId,
    latestReportId: latest,
    reportIds_0_10: ids0,
  };

  const wrote = writeJson(outPath, out);

  console.log("OK: published");
  console.log("registry:", registryAddr);
  console.log("publisher:", publisherWallet.address);
  console.log("txHash:", out.txHash);
  console.log("latestReportId:", latest);
  console.log("WROTE:", wrote);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});