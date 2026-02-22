import fs from "fs";
import path from "path";
import hre from "hardhat";

const { ethers } = await hre.network.connect();

type PorOutput = {
  schema_version: string;
  report_id: string;
  as_of_timestamp: number;
  bars_count: number;
  attested_fine_gold_grams: number;
  bar_list_hash: string; // 0x bytes32
  merkle_root: string; // 0x bytes32
};

function assertBytes32Hex(x: string, name: string) {
  if (typeof x !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(x)) {
    throw new Error(`${name} bytes32 hex değil: ${x}`);
  }
}

function readJson<T>(p: string): T {
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
}

function writeJson(p: string, obj: any) {
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const json = JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  fs.writeFileSync(abs, json + "\n", "utf8");
  return abs;
}

function normalizePk(pk: string): string {
  const t = pk.trim();
  return t.startsWith("0x") ? t : `0x${t}`;
}

async function main() {
  // Hardhat run arg forward etmiyor; ENV kullanıyoruz
  const porIn = (process.env.POR_IN ?? "por/reports/por_output_demo.json").trim();
  const outPath = (process.env.ATTEST_OUT ?? "por/reports/attestation_signed.json").trim();

  const receiptPath = (process.env.RECEIPT_IN ?? "por/reports/publish_receipt_demo.json").trim();
  const receipt = readJson<{ registry: string }>(receiptPath);

  const registryAddr = (process.env.REGISTRY_ADDR ?? receipt.registry).trim();

  const signerPkRaw = process.env.SIGNER_PRIVATE_KEY;
  if (!signerPkRaw) {
    throw new Error(`SIGNER_PRIVATE_KEY env yok. Örnek: set "SIGNER_PRIVATE_KEY=0xabc..."`);
  }
  const signerPk = normalizePk(signerPkRaw);
  const signerWallet = new ethers.Wallet(signerPk); // provider gerekmez (sadece imza)

  const por = readJson<PorOutput>(porIn);

  if (por.schema_version !== "0.1") throw new Error(`schema_version 0.1 değil: ${por.schema_version}`);
  assertBytes32Hex(por.bar_list_hash, "bar_list_hash");
  assertBytes32Hex(por.merkle_root, "merkle_root");
  if (!ethers.isAddress(registryAddr)) {
  throw new Error(`REGISTRY_ADDR/receipt.registry address değil: ${registryAddr}`);
}

  // Zincirden chainId al (localhost gibi)
  const chainId = (await ethers.provider.getNetwork()).chainId;

  // (Opsiyonel ama faydalı) allowlist check
  const skipCheck = (process.env.SKIP_ALLOWLIST_CHECK ?? "").trim() === "1";
  if (!skipCheck) {
    const registry = await ethers.getContractAt("ReserveRegistry", registryAddr);
    const ok = await registry.isAllowedSigner(signerWallet.address);
    if (!ok) {
      throw new Error(
        `Signer allowlist'te değil: ${signerWallet.address}\n` +
        `Çözüm: Admin ile setAllowedSigner(...) çağır veya doğru signer PK kullan.`
      );
    }
  }

  const reportId = ethers.keccak256(ethers.toUtf8Bytes(por.report_id));
  const asOfTimestamp = por.as_of_timestamp;
  const attestedFineGoldGrams = BigInt(por.attested_fine_gold_grams);

  const domain = {
    name: "GRUSH Reserve Attestation",
    version: "1",
    chainId, // bigint
    verifyingContract: registryAddr,
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

  const value = {
    reportId,
    asOfTimestamp,
    attestedFineGoldGrams,
    merkleRoot: por.merkle_root,
    barListHash: por.bar_list_hash,
  };

  const signature = await signerWallet.signTypedData(domain, types, value);

  const out = {
    schema_version: "0.1",
    report_id: por.report_id,
    reportId,
    as_of_timestamp: asOfTimestamp,
    attested_fine_gold_grams: por.attested_fine_gold_grams,
    merkle_root: por.merkle_root,
    bar_list_hash: por.bar_list_hash,
    signer: signerWallet.address,
    signature,
    eip712_domain: {
      ...domain,
      chainId: domain.chainId.toString(),
    },
  };

  const wrote = writeJson(outPath, out);

  console.log("OK: signed");
  console.log("registry:", registryAddr);
  console.log("signer:", signerWallet.address);
  console.log("reportId:", reportId);
  console.log("WROTE:", wrote);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
