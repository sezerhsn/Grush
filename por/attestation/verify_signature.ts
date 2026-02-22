/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import * as ethers from "ethers";
import {
  normalizeAddress,
  reportIdToBytes32,
  assertBytes32Hex,
} from "../merkle/hash_utils";

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
  // eslint-disable-next-line no-console
  console.error(`
Usage:
  ts-node por/attestation/verify_signature.ts --in <attestation.json> [--expect <0xSigner>] [--quiet]

Validates:
- schema_version == 0.1
- bytes32 fields are bytes32 hex
- signature is 65-byte hex
- EIP-712 domain matches reserve_registry_address + chain_id
- recovered address matches signer_address (and optionally --expect)

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

function assertInteger(n: any, name: string) {
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new Error(`${name} integer olmalı. Aldım: ${n}`);
  }
}

function assertAddress(addr: any, name: string) {
  if (typeof addr !== "string") throw new Error(`${name} string değil.`);
  normalizeAddress(addr); // will throw if invalid
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
  // ethers v6: verifyTypedData (top-level)
  const v6 = (ethers as any).verifyTypedData;
  if (typeof v6 === "function") return v6;

  // ethers v5: utils.verifyTypedData
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
  const quiet = Boolean(args.quiet);

  const absIn = path.isAbsolute(inPath) ? inPath : path.join(process.cwd(), inPath);
  const raw = fs.readFileSync(absIn, "utf8");
  const att = basicValidate(JSON.parse(raw));

  const registry = normalizeAddress(att.reserve_registry_address);
  const signer = normalizeAddress(att.signer_address);

  // Domain cross-checks
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

  if (!quiet) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      ok: true,
      recovered_signer: recovered,
      registry,
      chain_id: att.chain_id,
      report_id: att.report_id,
      report_id_bytes32: reportIdToBytes32(att.report_id),
      as_of_timestamp: att.as_of_timestamp,
      attested_fine_gold_grams: att.attested_fine_gold_grams,
      merkle_root: att.merkle_root,
      bar_list_hash: att.bar_list_hash
    }, null, 2));
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("FAIL:", e?.message ?? e);
  process.exit(1);
});
