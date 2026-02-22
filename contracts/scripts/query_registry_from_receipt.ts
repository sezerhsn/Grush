import fs from "fs";
import path from "path";
import hre from "hardhat";

const { ethers } = await hre.network.connect();

type Receipt = {
  registry: string;
};

function readJson<T>(p: string): T {
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
}

async function main() {
  const rc = readJson<Receipt>("por/reports/publish_receipt_demo.json");
  const registryAddr = rc.registry;

  const registry = await ethers.getContractAt("ReserveRegistry", registryAddr);

  const latestId = await registry.latestReportId();
  const [rid, rec] = await registry.latestAttestation();

  console.log("registry:", registryAddr);
  console.log("latestReportId:", latestId);
  console.log("latestAttestation.reportId:", rid);
  console.log("record.asOfTimestamp:", rec.asOfTimestamp.toString());
  console.log("record.publishedAt:", rec.publishedAt.toString());
  console.log("record.attestedFineGoldGrams:", rec.attestedFineGoldGrams.toString());
  console.log("record.merkleRoot:", rec.merkleRoot);
  console.log("record.barListHash:", rec.barListHash);
  console.log("record.signer:", rec.signer);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
