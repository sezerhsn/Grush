import fs from "fs";
import path from "path";
import hre from "hardhat";

const { ethers } = await hre.network.connect();

type SignedAttestation = {
  schema_version: string;
  report_id: string;
  reportId: string;
  as_of_timestamp: number;
  attested_fine_gold_grams: number;
  merkle_root: string;
  bar_list_hash: string;
  signer: string;
  signature: string;
  eip712_domain: { verifyingContract: string };
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
  const inPath = (process.env.ATTEST_IN ?? "por/reports/attestation_signed.json").trim();
  const outPath = (process.env.PUBLISH_OUT ?? "por/reports/publish_receipt.json").trim();

  const publisherPkRaw = process.env.PUBLISHER_PRIVATE_KEY;
  if (!publisherPkRaw) {
    throw new Error(`PUBLISHER_PRIVATE_KEY env yok. Örnek: set "PUBLISHER_PRIVATE_KEY=0xabc..."`);
  }

  const signed = readJson<SignedAttestation>(inPath);

  if (signed.schema_version !== "0.1") throw new Error(`schema_version 0.1 değil: ${signed.schema_version}`);
  assertBytes32Hex(signed.reportId, "reportId");
  assertBytes32Hex(signed.merkle_root, "merkle_root");
  assertBytes32Hex(signed.bar_list_hash, "bar_list_hash");

  const registryAddr = (process.env.REGISTRY_ADDR ?? signed.eip712_domain.verifyingContract).trim();
  if (!ethers.isAddress(registryAddr)) {
  throw new Error(`REGISTRY_ADDR/verifyingContract address değil: ${registryAddr}`);
}

  const publisherWallet = new ethers.Wallet(normalizePk(publisherPkRaw), ethers.provider);

  const registry = await ethers.getContractAt("ReserveRegistry", registryAddr);

  // (Opsiyonel ama faydalı) publisher role check
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

  const tx = await registry
    .connect(publisherWallet)
    .publishAttestation(
      signed.reportId,
      signed.as_of_timestamp,
      BigInt(signed.attested_fine_gold_grams),
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
