import hre from "hardhat";

const { ethers } = await hre.network.connect();

function canonicalLeafJson(bar: {
  as_of_timestamp: number;
  fineness: string;
  fine_weight_g: number;
  refiner: string;
  serial_no: string;
  vault_id: string;
}) {
  // Key order: as_of_timestamp, fineness, fine_weight_g, refiner, serial_no, vault_id
  return JSON.stringify({
    as_of_timestamp: bar.as_of_timestamp,
    fineness: bar.fineness,
    fine_weight_g: bar.fine_weight_g,
    refiner: bar.refiner,
    serial_no: bar.serial_no,
    vault_id: bar.vault_id,
  });
}

function leafHash(canonicalJson: string) {
  const preimage = ethers.toUtf8Bytes(canonicalJson);
  return ethers.keccak256(ethers.concat(["0x00", preimage]));
}

function nodeHash(left: string, right: string) {
  return ethers.keccak256(ethers.concat(["0x01", left, right]));
}

function merkleRootFromLeaves(leaves: string[]) {
  if (leaves.length === 0) return ethers.ZeroHash;
  let level = [...leaves];
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]); // duplicate-last
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(nodeHash(level[i], level[i + 1]));
    }
    level = next;
  }
  return level[0];
}

async function main() {
  const [admin, publisher, pauser, allowedSigner] = await ethers.getSigners();

  const registry = await ethers.deployContract("ReserveRegistry", [
    admin.address,
    publisher.address,
    pauser.address,
  ]);
  await registry.waitForDeployment();

  // allow signer
  await (await registry.connect(admin).setAllowedSigner(allowedSigner.address, true)).wait();

  // demo bar list (1 bar)
  const asOf = Math.floor(Date.now() / 1000);

  const bar = {
    as_of_timestamp: asOf,
    fineness: "999.9",
    fine_weight_g: 1000,
    refiner: "ACME",
    serial_no: "ABCD-1234",
    vault_id: "IST-VAULT-01",
  };

  const canonical = canonicalLeafJson(bar);
  const leaf = leafHash(canonical);
  const root = merkleRootFromLeaves([leaf]);

  // In real flow, barListHash = keccak256(fileBytes). Here: keccak256(canonical bytes) as demo.
  const barListHash = ethers.keccak256(ethers.toUtf8Bytes(canonical));

  const reportId = ethers.keccak256(ethers.toUtf8Bytes("demo-report-1"));
  const attestedFineGoldGrams = 1000n;

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
    asOfTimestamp: asOf,
    attestedFineGoldGrams,
    merkleRoot: root,
    barListHash,
  };

  const signature = await allowedSigner.signTypedData(domain, types, value);

  await (
    await registry
      .connect(publisher)
      .publishAttestation(reportId, asOf, attestedFineGoldGrams, root, barListHash, signature)
  ).wait();

  const latest = await registry.latestReportId();
  const ids = await registry.getReportIds(999, 10);

  console.log("ReserveRegistry:", await registry.getAddress());
  console.log("reportId:", reportId);
  console.log("latestReportId:", latest);
  console.log("merkleRoot:", root);
  console.log("barListHash:", barListHash);
  console.log("getReportIds(999,10).length:", ids.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
