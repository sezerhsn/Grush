import { expect } from "chai";
import hre from "hardhat";

describe("ReserveRegistry", function () {
  it("publishes an attestation and returns empty array when start >= n", async function () {
    // Hardhat 3: ethers'ı buradan alıyoruz (hardhat'tan named export yok)
    const { ethers } = await hre.network.connect();

    const [admin, publisher, pauser, allowedSigner] = await ethers.getSigners();

    const registry = await ethers.deployContract("ReserveRegistry", [
      admin.address,
      publisher.address,
      pauser.address,
    ]);
    await registry.waitForDeployment();

    // allow the signer
    await (await registry.connect(admin).setAllowedSigner(allowedSigner.address, true)).wait();

    const reportId = ethers.keccak256(ethers.toUtf8Bytes("report-1"));
    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes("root-1"));
    const barListHash = ethers.keccak256(ethers.toUtf8Bytes("barlist-1"));

    const asOfTimestamp = Math.floor(Date.now() / 1000);
    const attestedFineGoldGrams = 123456789n;

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

    // publish from publisher (has role via constructor)
    await (
      await registry
        .connect(publisher)
        .publishAttestation(reportId, asOfTimestamp, attestedFineGoldGrams, merkleRoot, barListHash, signature)
    ).wait();

    expect(await registry.exists(reportId)).to.eq(true);
    expect(await registry.latestReportId()).to.eq(reportId);

    // Bugfix assert: start >= n => empty array
    const ids = await registry.getReportIds(999, 10);
    expect(ids.length).to.eq(0);
  });
});
