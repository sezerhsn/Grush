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

function usageAndExit(code = 1): never {
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

function assertBytes32Hex(x: string, name: string) {
  if (typeof x !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(x)) {
    throw new Error(`${name} bytes32 hex değil: ${x}`);
  }
}

function readJson<T>(p: string): T {
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  const raw = fs.readFileSync(abs, "utf8");
  return JSON.parse(raw) as T;
}

function writeJson(p: string, obj: any) {
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  const json = JSON.stringify(
    obj,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2
  );

  fs.writeFileSync(abs, json + "\n", "utf8");
  return abs;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const inPath = (args.in as string) || "por/reports/por_output_demo.json";
  const por = readJson<PorOutput>(inPath);

  if (por.schema_version !== "0.1") {
    throw new Error(`schema_version beklenen 0.1, aldım: ${por.schema_version}`);
  }

  assertBytes32Hex(por.bar_list_hash, "bar_list_hash");
  assertBytes32Hex(por.merkle_root, "merkle_root");

  const [admin, publisher, pauser, allowedSigner] = await ethers.getSigners();

  // 1) Deploy ReserveRegistry (local ephemeral network)
  const registry = await ethers.deployContract("ReserveRegistry", [
    admin.address,
    publisher.address,
    pauser.address,
  ]);
  await registry.waitForDeployment();

  // 2) Allow signer
  await (await registry.connect(admin).setAllowedSigner(allowedSigner.address, true)).wait();

  // 3) reportId mapping (string -> bytes32)
  // v0.1: reportId = keccak256(utf8(report_id))
  const reportId = ethers.keccak256(ethers.toUtf8Bytes(por.report_id));

  const asOfTimestamp = por.as_of_timestamp; // uint64
  const attestedFineGoldGrams = BigInt(por.attested_fine_gold_grams);
  const merkleRoot = por.merkle_root;
  const barListHash = por.bar_list_hash;

  // 4) EIP-712 signature
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = {
    name: "GRUSH Reserve Attestation",
    version: "1",
    chainId,
    verifyingContract: await registry.getAddress(),
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
    merkleRoot,
    barListHash,
  };

  const signature = await allowedSigner.signTypedData(domain, types, value);

  // 5) Publish on-chain
  const tx = await registry
    .connect(publisher)
    .publishAttestation(reportId, asOfTimestamp, attestedFineGoldGrams, merkleRoot, barListHash, signature);
  const rc = await tx.wait();

  // 6) Quick verification
  const latest = await registry.latestReportId();
  const latestTuple = await registry.latestAttestation(); // (reportId, rec)
  const ids = await registry.getReportIds(999, 10);

  // 7) Write artifacts
  const signedOut = writeJson("por/reports/attestation_demo_signed.json", {
    schema_version: "0.1",
    report_id: por.report_id,
    reportId,
    as_of_timestamp: asOfTimestamp,
    attested_fine_gold_grams: por.attested_fine_gold_grams,
    merkle_root: merkleRoot,
    bar_list_hash: barListHash,
    signer: allowedSigner.address,
    signature,
    eip712_domain: domain,
  });

  const receiptOut = writeJson("por/reports/publish_receipt_demo.json", {
    registry: await registry.getAddress(),
    txHash: rc?.hash ?? tx.hash,
    blockNumber: rc?.blockNumber ?? null,
    reportId,
    latestReportId: latest,
    latestAttestation: {
      reportId: latestTuple[0],
      record: latestTuple[1],
    },
    getReportIds_999_10_length: ids.length,
  });

  console.log("OK");
  console.log("ReserveRegistry:", await registry.getAddress());
  console.log("reportId:", reportId);
  console.log("latestReportId:", latest);
  console.log("getReportIds(999,10).length:", ids.length);
  console.log("WROTE:", signedOut);
  console.log("WROTE:", receiptOut);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
