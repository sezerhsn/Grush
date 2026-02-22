/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import * as ethers from "ethers";
import { normalizeAddress, reportIdToBytes32, assertBytes32Hex } from "../merkle/hash_utils";

type AttestationInput = {
  schema_version: "0.1";
  report_id: string;
  as_of_timestamp: number;
  attested_fine_gold_grams: number;
  merkle_root: string;      // bytes32 hex
  bar_list_hash: string;    // bytes32 hex
};

function usageAndExit(code = 1): never {
  // eslint-disable-next-line no-console
  console.error(`
Usage:
  ts-node por/attestation/sign_attestation.ts --in <por-output.json> --registry <0x..> --chainId 1 --pk <0x..> [--out <attestation.json>]

Alternative (env):
  ATTESTATION_SIGNER_PK=<hex private key> ts-node por/attestation/sign_attestation.ts --in <por-output.json> --registry <0x..> --chainId 1

Notes:
- report_id typed field is bytes32. If report_id is not a bytes32 hex, it will be mapped as:
  reportIdBytes32 = keccak256(utf8(report_id))

Output conforms to por/schemas/attestation.schema.json (additionalProperties=false).
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

function assertInteger(n: any, name: string) {
  if (typeof n !== "number" || !Number.isInteger(n)) throw new Error(`${name} integer olmalı. Aldım: ${n}`);
}

function basicValidateInput(j: any): AttestationInput {
  if (!j || typeof j !== "object") throw new Error("Input JSON object değil.");
  if (j.schema_version !== "0.1") throw new Error("schema_version 0.1 değil.");
  if (typeof j.report_id !== "string" || !j.report_id) throw new Error("report_id string olmalı.");
  assertInteger(j.as_of_timestamp, "as_of_timestamp");
  assertInteger(j.attested_fine_gold_grams, "attested_fine_gold_grams");

  if (typeof j.merkle_root !== "string") throw new Error("merkle_root string olmalı.");
  if (typeof j.bar_list_hash !== "string") throw new Error("bar_list_hash string olmalı.");

  assertBytes32Hex(j.merkle_root, "merkle_root");
  assertBytes32Hex(j.bar_list_hash, "bar_list_hash");

  return j as AttestationInput;
}

async function signTypedDataCompat(wallet: any, domain: any, types: any, message: any): Promise<string> {
  // ethers v6: wallet.signTypedData
  if (typeof wallet.signTypedData === "function") {
    return await wallet.signTypedData(domain, types, message);
  }
  // ethers v5: wallet._signTypedData
  if (typeof wallet._signTypedData === "function") {
    return await wallet._signTypedData(domain, types, message);
  }
  throw new Error("Wallet typed-data signing fonksiyonu yok (ethers v5/v6 uyumsuz?).");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const inPath = (args.in as string) || "";
  const registry = (args.registry as string) || "";
  const chainIdStr = (args.chainId as string) || "1";
  const outPath = (args.out as string) || "";

  if (!inPath || !registry) usageAndExit(1);

  const pk = (args.pk as string) || process.env.ATTESTATION_SIGNER_PK || "";
  if (!pk) throw new Error("Signer private key yok. --pk ver veya ATTESTATION_SIGNER_PK env set et.");

  const chainId = Number(chainIdStr);
  if (!Number.isInteger(chainId) || chainId < 1) throw new Error("chainId invalid.");

  const absIn = path.isAbsolute(inPath) ? inPath : path.join(process.cwd(), inPath);
  const raw = fs.readFileSync(absIn, "utf8");
  const input = basicValidateInput(JSON.parse(raw));

  const reserveRegistryAddress = normalizeAddress(registry);

  const wallet = new (ethers as any).Wallet(pk);
  const signerAddress = normalizeAddress(await wallet.getAddress());

  const reportIdBytes32 = reportIdToBytes32(input.report_id);

  const domain = {
    name: "GRUSH Reserve Attestation",
    version: "1",
    chainId,
    verifyingContract: reserveRegistryAddress,
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
    reportId: reportIdBytes32,
    asOfTimestamp: input.as_of_timestamp,
    attestedFineGoldGrams: input.attested_fine_gold_grams,
    merkleRoot: input.merkle_root,
    barListHash: input.bar_list_hash,
  };

  const signature = await signTypedDataCompat(wallet, domain, types, message);

  // Output: must match attestation.schema.json (additionalProperties=false)
  const out = {
    schema_version: "0.1",
    report_id: input.report_id,
    as_of_timestamp: input.as_of_timestamp,
    attested_fine_gold_grams: input.attested_fine_gold_grams,
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
  } as const;

  const outJson = JSON.stringify(out, null, 2);

  if (outPath) {
    const absOut = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, outJson, { encoding: "utf8" });
  } else {
    // eslint-disable-next-line no-console
    console.log(outJson);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("ERROR:", e?.message ?? e);
  process.exit(1);
});
