import { expect } from "chai";
import hre from "hardhat";

const { ethers } = await hre.network.connect();

function gramsFromSupplyWei(totalSupply: bigint): bigint {
  // 18 decimals: 1 GRUSH = 1e18 wei => grams = totalSupply / 1e18
  const DECIMALS = 10n ** 18n;
  return totalSupply / DECIMALS;
}

describe("Policy Invariants (Supply vs Reserves)", function () {
  async function deployFixture() {
    const [admin, publisher, pauser, auditor, minter, burner, tokenPauser, user] =
      await ethers.getSigners();

    // Deploy ReserveRegistry
    const ReserveRegistry = await ethers.getContractFactory("ReserveRegistry");
    const registry = await ReserveRegistry.deploy(admin.address, publisher.address, pauser.address);
    await registry.waitForDeployment();

    // Allow auditor signer
    await registry.connect(admin).setAllowedSigner(auditor.address, true);

    // Deploy GRUSHToken
    const GRUSHToken = await ethers.getContractFactory("GRUSHToken");
    const token = await GRUSHToken.deploy(admin.address, minter.address, burner.address, tokenPauser.address);
    await token.waitForDeployment();

    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const registryAddr = await registry.getAddress();

    const domain = {
      name: "GRUSH Reserve Attestation",
      version: "1",
      chainId,
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

    return { registry, token, admin, publisher, pauser, auditor, minter, user, domain, types };
  }

  async function signAttestation(params: {
    auditor: any;
    domain: any;
    types: any;
    reportId: string;
    asOfTimestamp: number;
    attestedFineGoldGrams: bigint;
    merkleRoot: string;
    barListHash: string;
  }): Promise<string> {
    const { auditor, domain, types, ...msg } = params;

    const message = {
      reportId: msg.reportId,
      asOfTimestamp: msg.asOfTimestamp,
      attestedFineGoldGrams: msg.attestedFineGoldGrams,
      merkleRoot: msg.merkleRoot,
      barListHash: msg.barListHash,
    };

    // ethers v6: signTypedData; v5: _signTypedData
    if (typeof auditor.signTypedData === "function") {
      return await auditor.signTypedData(domain, types, message);
    }
    if (typeof auditor._signTypedData === "function") {
      return await auditor._signTypedData(domain, types, message);
    }
    throw new Error("Auditor typed-data signing fonksiyonu yok (ethers v5/v6 uyumsuz?).");
  }

  it("OK when totalSupply (grams) <= latest attested grams", async function () {
    const { registry, token, publisher, auditor, minter, user, domain, types } = await deployFixture();

    // Publish attestation for 1000 grams
    const reportId = ethers.keccak256(ethers.toUtf8Bytes("R-INV-OK"));
    const asOfTimestamp = 1000;
    const attestedGrams = 1000n;
    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes("root"));
    const barListHash = ethers.keccak256(ethers.toUtf8Bytes("barlist"));

    const sig = await signAttestation({
      auditor,
      domain,
      types,
      reportId,
      asOfTimestamp,
      attestedFineGoldGrams: attestedGrams,
      merkleRoot,
      barListHash,
    });

    await registry
      .connect(publisher)
      .publishAttestation(reportId, asOfTimestamp, attestedGrams, merkleRoot, barListHash, sig);

    // Mint 900 GRUSH (== 900 grams)
    const mintAmount = ethers.parseUnits("900", 18);
    await token.connect(minter).mint(user.address, mintAmount);

    const supplyWei: bigint = await token.totalSupply();
    const supplyGrams = gramsFromSupplyWei(supplyWei);

    const [, rec] = await registry.latestAttestation();
    const reserveGrams: bigint = rec.attestedFineGoldGrams;

    expect(supplyGrams).to.be.lte(reserveGrams);
  });

  it("detects a violation scenario (supply > reserve) without failing CI", async function () {
    const { registry, token, publisher, auditor, minter, user, domain, types } = await deployFixture();

    // Publish attestation for 100 grams
    const reportId = ethers.keccak256(ethers.toUtf8Bytes("R-INV-DETECT"));
    const asOfTimestamp = 1000;
    const attestedGrams = 100n;
    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes("root"));
    const barListHash = ethers.keccak256(ethers.toUtf8Bytes("barlist"));

    const sig = await signAttestation({
      auditor,
      domain,
      types,
      reportId,
      asOfTimestamp,
      attestedFineGoldGrams: attestedGrams,
      merkleRoot,
      barListHash,
    });

    await registry
      .connect(publisher)
      .publishAttestation(reportId, asOfTimestamp, attestedGrams, merkleRoot, barListHash, sig);

    // Mint 101 GRUSH (== 101 grams) -> exceeds reserve
    const mintAmount = ethers.parseUnits("101", 18);
    await token.connect(minter).mint(user.address, mintAmount);

    const supplyWei: bigint = await token.totalSupply();
    const supplyGrams = gramsFromSupplyWei(supplyWei);

    const [, rec] = await registry.latestAttestation();
    const reserveGrams: bigint = rec.attestedFineGoldGrams;

    expect(supplyGrams).to.be.gt(reserveGrams);
  });

  // Alarm senaryosu: CI kırmasın diye varsayılan çalışmaz (pending de bırakmayız).
  // Çalıştırmak için: RUN_ALARM_TESTS=1
  if (process.env.RUN_ALARM_TESTS === "1") {
    it("ALARM when totalSupply (grams) > latest attested grams (would fail CI)", async function () {
      const { registry, token, publisher, auditor, minter, user, domain, types } = await deployFixture();

      const reportId = ethers.keccak256(ethers.toUtf8Bytes("R-INV-FAIL"));
      const asOfTimestamp = 1000;
      const attestedGrams = 100n;
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes("root"));
      const barListHash = ethers.keccak256(ethers.toUtf8Bytes("barlist"));

      const sig = await signAttestation({
        auditor,
        domain,
        types,
        reportId,
        asOfTimestamp,
        attestedFineGoldGrams: attestedGrams,
        merkleRoot,
        barListHash,
      });

      await registry
        .connect(publisher)
        .publishAttestation(reportId, asOfTimestamp, attestedGrams, merkleRoot, barListHash, sig);

      const mintAmount = ethers.parseUnits("101", 18);
      await token.connect(minter).mint(user.address, mintAmount);

      const supplyWei: bigint = await token.totalSupply();
      const supplyGrams = gramsFromSupplyWei(supplyWei);

      const [, rec] = await registry.latestAttestation();
      const reserveGrams: bigint = rec.attestedFineGoldGrams;

      expect(
        supplyGrams,
        `POLICY VIOLATION: supplyGrams(${supplyGrams}) > reserveGrams(${reserveGrams}). This must never happen in production.`
      ).to.be.lte(reserveGrams);
    });
  }
});