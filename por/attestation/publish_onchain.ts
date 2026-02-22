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
  signature: string; // 65-byte hex
};

const ABI = [
  "function publishAttestation(bytes32 reportId,uint64 asOfTimestamp,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash,bytes signature) external returns (address)",
  "function isAllowedSigner(address signer) external view returns (bool)",
];

function usageAndExit(code = 1): never {
  // eslint-disable-next-line no-console
  console.error(`
Usage:
  ts-node por/attestation/publish_onchain.ts --in <attestation.json> --rpc <RPC_URL> --pk <PUBLISHER_PK> [--gasPriceGwei <n>] [--nonce <n>] [--wait]

Alternative (env):
  PUBLISHER_PK=0x... RPC_URL=https://... ts-node por/attestation/publish_onchain.ts --in <attestation.json> --wait

Validations:
- attestation.chain_id matches provider network chainId
- attestation.reserve_registry_address matches JSON domain/verifyingContract
- signature length, bytes32 formats
- isAllowedSigner(attestation.signer_address) is true on-chain (best-effort)

Options:
  --wait        waits for tx receipt (recommended)
  --gasPriceGwei (legacy) forces gas price (if network supports)
  --nonce       manually set nonce
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

function assertSig65(sig: string) {
  if (typeof sig !== "string") throw new Error("signature string değil.");
  if (!/^0x[a-fA-F0-9]{130}$/.test(sig)) {
    throw new Error("signature 65-byte hex değil (0x + 130 hex).");
  }
}

function loadAttestation(j: any): Attestation {
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

  j.reserve_registry_address = normalizeAddress(j.reserve_registry_address);
  j.signer_address = normalizeAddress(j.signer_address);

  if (!j.eip712_domain || typeof j.eip712_domain !== "object") throw new Error("eip712_domain missing.");
  if (j.eip712_domain.name !== "GRUSH Reserve Attestation") throw new Error("domain.name mismatch.");
  if (j.eip712_domain.version !== "1") throw new Error("domain.version mismatch.");
  assertInteger(j.eip712_domain.chainId, "domain.chainId");
  j.eip712_domain.verifyingContract = normalizeAddress(j.eip712_domain.verifyingContract);

  // Cross-check verifying contract with reserve_registry_address
  if (j.eip712_domain.verifyingContract !== j.reserve_registry_address) {
    throw new Error("eip712_domain.verifyingContract reserve_registry_address ile uyuşmuyor.");
  }
  if (j.eip712_domain.chainId !== j.chain_id) {
    throw new Error("eip712_domain.chainId chain_id ile uyuşmuyor.");
  }

  assertSig65(j.signature);

  return j as Attestation;
}

function getProvider(rpcUrl: string) {
  // v6 JsonRpcProvider exists; v5 providers.JsonRpcProvider exists
  const v6 = (ethers as any).JsonRpcProvider;
  if (typeof v6 === "function") return new v6(rpcUrl);

  const v5 = (ethers as any).providers?.JsonRpcProvider;
  if (typeof v5 === "function") return new v5(rpcUrl);

  throw new Error("ethers JsonRpcProvider bulunamadı (ethers v5/v6 uyumsuz?).");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const inPath = (args.in as string) || "";
  if (!inPath) usageAndExit(1);

  const rpc = (args.rpc as string) || process.env.RPC_URL || "";
  if (!rpc) throw new Error("RPC URL yok. --rpc ver veya RPC_URL env set et.");

  const pk = (args.pk as string) || process.env.PUBLISHER_PK || "";
  if (!pk) throw new Error("Publisher private key yok. --pk ver veya PUBLISHER_PK env set et.");

  const wait = Boolean(args.wait);

  const gasPriceGweiStr = (args.gasPriceGwei as string) || "";
  const nonceStr = (args.nonce as string) || "";

  const absIn = path.isAbsolute(inPath) ? inPath : path.join(process.cwd(), inPath);
  const raw = fs.readFileSync(absIn, "utf8");
  const att = loadAttestation(JSON.parse(raw));

  const provider = getProvider(rpc);
  const network = await provider.getNetwork();
  const chainId = Number((network as any).chainId ?? (network as any).chainId?.toString?.());
  if (!Number.isInteger(chainId) || chainId < 1) throw new Error("Provider chainId invalid.");

  if (chainId !== att.chain_id) {
    throw new Error(`ChainId mismatch. provider=${chainId}, attestation.chain_id=${att.chain_id}`);
  }

  const wallet = new (ethers as any).Wallet(pk, provider);
  const publisher = normalizeAddress(await wallet.getAddress());

  const registryAddress = normalizeAddress(att.reserve_registry_address);
  const registry = new (ethers as any).Contract(registryAddress, ABI, wallet);

  // Best-effort signer allowlist check (will revert anyway if not allowed)
  const allowed = await registry.isAllowedSigner(att.signer_address);
  if (!allowed) {
    throw new Error(`Signer not allowed on-chain: ${att.signer_address}. Önce setAllowedSigner(true) yap.`);
  }

  const reportIdBytes32 = reportIdToBytes32(att.report_id);

  // Build tx overrides
  const overrides: any = {};
  if (gasPriceGweiStr) {
    const gwei = Number(gasPriceGweiStr);
    if (!Number.isFinite(gwei) || gwei <= 0) throw new Error("gasPriceGwei invalid.");
    // v6 parseUnits or v5 utils.parseUnits
    const parseUnits =
      (ethers as any).parseUnits ?? (ethers as any).utils?.parseUnits;
    overrides.gasPrice = parseUnits(String(gwei), "gwei");
  }
  if (nonceStr) {
    const n = Number(nonceStr);
    if (!Number.isInteger(n) || n < 0) throw new Error("nonce invalid.");
    overrides.nonce = n;
  }

  // Send tx
  const tx = await registry.publishAttestation(
    reportIdBytes32,
    att.as_of_timestamp,
    att.attested_fine_gold_grams,
    att.merkle_root,
    att.bar_list_hash,
    att.signature,
    overrides
  );

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    publisher,
    chain_id: chainId,
    reserve_registry: registryAddress,
    report_id: att.report_id,
    report_id_bytes32: reportIdBytes32,
    tx_hash: tx.hash
  }, null, 2));

  if (wait) {
    const receipt = await tx.wait();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      mined: true,
      blockNumber: receipt.blockNumber,
      status: receipt.status,
      gasUsed: receipt.gasUsed?.toString?.() ?? receipt.gasUsed
    }, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.log("NOTE: --wait verilmedi. Tx mined olana kadar takip et.");
  }

  // Extra safety note: publisher != signer
  if (publisher === normalizeAddress(att.signer_address)) {
    // eslint-disable-next-line no-console
    console.warn("WARN: Publisher address attestation signer ile aynı. Ayrı anahtarlar kullanmanız önerilir.");
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("FAIL:", e?.message ?? e);
  process.exit(1);
});
