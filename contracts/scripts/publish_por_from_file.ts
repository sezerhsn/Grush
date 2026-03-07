import fs from "node:fs";
import path from "node:path";
import hre from "hardhat";
import type {
  ContractRunner,
  ContractTransactionResponse,
  TypedDataDomain,
  TypedDataField,
} from "ethers";
import {
  assertBytes32Hex,
  reportIdToBytes32,
  toUintBigInt,
  type JsonUint,
} from "../../por/merkle/hash_utils.ts";

const { ethers } = await hre.network.connect();

type ParsedArgs = Record<string, string | boolean>;
type TypedDataTypes = Record<string, TypedDataField[]>;

type AddressSigner = ContractRunner & {
  address: string;
  signTypedData: (
    domain: TypedDataDomain,
    types: TypedDataTypes,
    value: Record<string, unknown>
  ) => Promise<string>;
};

type ReserveAttestationRecord = {
  asOfTimestamp: bigint;
  publishedAt: bigint;
  attestedFineGoldGrams: bigint;
  merkleRoot: string;
  barListHash: string;
  signer: string;
};

type ReserveRegistryLike = {
  getAddress(): Promise<string>;
  waitForDeployment(): Promise<ReserveRegistryLike>;
  connect(runner: ContractRunner | null): ReserveRegistryLike;

  setAllowedSigner(
    signer: string,
    allowed: boolean
  ): Promise<ContractTransactionResponse>;

  publishAttestation(
    reportId: string,
    asOfTimestamp: bigint,
    attestedFineGoldGrams: bigint,
    merkleRoot: string,
    barListHash: string,
    signature: string
  ): Promise<ContractTransactionResponse>;

  latestReportId(): Promise<string>;
  latestAttestation(): Promise<[string, ReserveAttestationRecord]>;
  getReportIds(start: bigint | number, count: bigint | number): Promise<string[]>;
};

type PorOutput = {
  schema_version: "0.1";
  report_id: string;
  as_of_timestamp: JsonUint;
  bars_count: JsonUint;
  attested_fine_gold_grams: JsonUint;
  bar_list_hash: string;
  merkle_root: string;
};

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

function usageAndExit(code = 1): never {
  // eslint-disable-next-line no-console
  console.error(`
Usage:
  npx hardhat run contracts/scripts/publish_por_from_file.ts --in <por_output.json>

Defaults:
  --in por/reports/por_output_demo.json

Outputs:
  por/reports/attestation_demo_signed.json
  por/reports/publish_receipt_demo.json
`);
  process.exit(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson<T>(filePath: string): T {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  return JSON.parse(raw) as T;
}

function writeJson(filePath: string, obj: unknown): string {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  const json = JSON.stringify(
    obj,
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    2
  );

  fs.writeFileSync(absolutePath, `${json}\n`, "utf8");
  return absolutePath;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} non-empty string olmalı.`);
  }
  return value.trim();
}

function toUint64BigInt(value: JsonUint, name: string): bigint {
  const asBigInt = toUintBigInt(value, name);
  const UINT64_MAX = (1n << 64n) - 1n;

  if (asBigInt > UINT64_MAX) {
    throw new Error(`${name} uint64 sınırını aşıyor. Aldım: ${asBigInt.toString()}`);
  }

  return asBigInt;
}

function validatePorOutput(input: unknown): PorOutput {
  if (!isRecord(input)) {
    throw new Error("PoR output JSON object değil.");
  }

  if (input.schema_version !== "0.1") {
    throw new Error(`schema_version beklenen 0.1, aldım: ${String(input.schema_version)}`);
  }

  const report_id = requireString(input.report_id, "report_id");
  const as_of_timestamp = input.as_of_timestamp as JsonUint;
  const bars_count = input.bars_count as JsonUint;
  const attested_fine_gold_grams = input.attested_fine_gold_grams as JsonUint;
  const bar_list_hash = requireString(input.bar_list_hash, "bar_list_hash");
  const merkle_root = requireString(input.merkle_root, "merkle_root");

  toUint64BigInt(as_of_timestamp, "as_of_timestamp");
  toUintBigInt(bars_count, "bars_count");
  toUintBigInt(attested_fine_gold_grams, "attested_fine_gold_grams");
  assertBytes32Hex(bar_list_hash, "bar_list_hash");
  assertBytes32Hex(merkle_root, "merkle_root");

  return {
    schema_version: "0.1",
    report_id,
    as_of_timestamp,
    bars_count,
    attested_fine_gold_grams,
    bar_list_hash,
    merkle_root,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) {
    usageAndExit(0);
  }

  const inPath = typeof args.in === "string" ? args.in : "por/reports/por_output_demo.json";
  const por = validatePorOutput(readJson<unknown>(inPath));

  const [admin, publisher, pauser, allowedSigner] =
    (await ethers.getSigners()) as AddressSigner[];

  const deployed = await ethers.deployContract("ReserveRegistry", [
    admin.address,
    publisher.address,
    pauser.address,
  ]);

  const registry = deployed as unknown as ReserveRegistryLike;
  await registry.waitForDeployment();

  await registry.connect(admin).setAllowedSigner(allowedSigner.address, true);

  const reportId = reportIdToBytes32(por.report_id);
  const asOfTimestamp = toUint64BigInt(por.as_of_timestamp, "as_of_timestamp");
  const attestedFineGoldGrams = toUintBigInt(
    por.attested_fine_gold_grams,
    "attested_fine_gold_grams"
  );
  const merkleRoot = por.merkle_root;
  const barListHash = por.bar_list_hash;

  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const domain: TypedDataDomain = {
    name: "GRUSH Reserve Attestation",
    version: "1",
    chainId,
    verifyingContract: await registry.getAddress(),
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

  const value: Record<string, unknown> = {
    reportId,
    asOfTimestamp,
    attestedFineGoldGrams,
    merkleRoot,
    barListHash,
  };

  const signature = await allowedSigner.signTypedData(domain, types, value);

  const tx = await registry
    .connect(publisher)
    .publishAttestation(
      reportId,
      asOfTimestamp,
      attestedFineGoldGrams,
      merkleRoot,
      barListHash,
      signature
    );

  const receipt = await tx.wait();

  const latest = await registry.latestReportId();
  const latestTuple = await registry.latestAttestation();
  const ids = await registry.getReportIds(999, 10);

  const signedOut = writeJson("por/reports/attestation_demo_signed.json", {
    schema_version: "0.1",
    report_id: por.report_id,
    reportId,
    as_of_timestamp: asOfTimestamp,
    attested_fine_gold_grams: attestedFineGoldGrams,
    merkle_root: merkleRoot,
    bar_list_hash: barListHash,
    signer: allowedSigner.address,
    signature,
    eip712_domain: domain,
  });

  const receiptOut = writeJson("por/reports/publish_receipt_demo.json", {
    registry: await registry.getAddress(),
    txHash: receipt?.hash ?? tx.hash,
    blockNumber: receipt?.blockNumber ?? null,
    reportId,
    latestReportId: latest,
    latestAttestation: {
      reportId: latestTuple[0],
      record: latestTuple[1],
    },
    getReportIds_999_10_length: ids.length,
  });

  // eslint-disable-next-line no-console
  console.log("OK");
  // eslint-disable-next-line no-console
  console.log("ReserveRegistry:", await registry.getAddress());
  // eslint-disable-next-line no-console
  console.log("reportId:", reportId);
  // eslint-disable-next-line no-console
  console.log("latestReportId:", latest);
  // eslint-disable-next-line no-console
  console.log("getReportIds(999,10).length:", ids.length);
  // eslint-disable-next-line no-console
  console.log("WROTE:", signedOut);
  // eslint-disable-next-line no-console
  console.log("WROTE:", receiptOut);
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});