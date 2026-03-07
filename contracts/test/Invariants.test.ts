import { expect } from "chai";
import hre from "hardhat";
import type {
  ContractRunner,
  ContractTransactionResponse,
  TypedDataDomain,
  TypedDataField,
} from "ethers";

const { ethers } = await hre.network.connect();

type TypedDataTypes = Record<string, TypedDataField[]>;

type AddressSigner = ContractRunner & {
  address: string;
  signTypedData?: (
    domain: TypedDataDomain,
    types: TypedDataTypes,
    value: Record<string, unknown>
  ) => Promise<string>;
  _signTypedData?: (
    domain: TypedDataDomain,
    types: TypedDataTypes,
    value: Record<string, unknown>
  ) => Promise<string>;
};

type ReserveAttestationRecord = {
  asOfTimestamp: bigint;
  publishedAt: bigint;
  attestedFineGoldGrams: bigint;
  merkleRoot: string;
  barListHash: string;
  signer: string;
};

type ReserveRegistryLike = {
  getAddress(): Promise<string>;
  waitForDeployment(): Promise<ReserveRegistryLike>;
  connect(runner: ContractRunner | null): ReserveRegistryLike;

  setAllowedSigner(
    signer: string,
    allowed: boolean
  ): Promise<ContractTransactionResponse>;

  publishAttestation(
    reportId: string,
    asOfTimestamp: bigint,
    attestedFineGoldGrams: bigint,
    merkleRoot: string,
    barListHash: string,
    signature: string
  ): Promise<ContractTransactionResponse>;

  latestAttestation(): Promise<[string, ReserveAttestationRecord]>;
};

type GRUSHTokenLike = {
  getAddress(): Promise<string>;
  waitForDeployment(): Promise<GRUSHTokenLike>;
  connect(runner: ContractRunner | null): GRUSHTokenLike;

  mint(to: string, amount: bigint): Promise<ContractTransactionResponse>;
  totalSupply(): Promise<bigint>;
};

type DeployFixtureResult = {
  registry: ReserveRegistryLike;
  token: GRUSHTokenLike;
  admin: AddressSigner;
  publisher: AddressSigner;
  pauser: AddressSigner;
  auditor: AddressSigner;
  minter: AddressSigner;
  user: AddressSigner;
  domain: TypedDataDomain;
  types: TypedDataTypes;
};

function gramsFromSupplyWei(totalSupply: bigint): bigint {
  const DECIMALS = 10n ** 18n;
  return totalSupply / DECIMALS;
}

async function signTypedDataCompat(
  signer: AddressSigner,
  domain: TypedDataDomain,
  types: TypedDataTypes,
  value: Record<string, unknown>
): Promise<string> {
  if (typeof signer.signTypedData === "function") {
    return signer.signTypedData(domain, types, value);
  }

  if (typeof signer._signTypedData === "function") {
    return signer._signTypedData(domain, types, value);
  }

  throw new Error("Auditor typed-data signing fonksiyonu yok.");
}

describe("Policy Invariants (Supply vs Reserves)", function () {
  async function deployFixture(): Promise<DeployFixtureResult> {
    const [admin, publisher, pauser, auditor, minter, burner, tokenPauser, user] =
      (await ethers.getSigners()) as AddressSigner[];

    const ReserveRegistry = await ethers.getContractFactory("ReserveRegistry");
    const deployedRegistry = await ReserveRegistry.deploy(
      admin.address,
      publisher.address,
      pauser.address
    );
    const registry = deployedRegistry as unknown as ReserveRegistryLike;
    await registry.waitForDeployment();

    await registry.connect(admin).setAllowedSigner(auditor.address, true);

    const GRUSHToken = await ethers.getContractFactory("GRUSHToken");
    const deployedToken = await GRUSHToken.deploy(
      admin.address,
      minter.address,
      burner.address,
      tokenPauser.address
    );
    const token = deployedToken as unknown as GRUSHTokenLike;
    await token.waitForDeployment();

    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const registryAddr = await registry.getAddress();

    const domain: TypedDataDomain = {
      name: "GRUSH Reserve Attestation",
      version: "1",
      chainId,
      verifyingContract: registryAddr,
    };

    const types: TypedDataTypes = {
      ReserveAttestation: [
        { name: "reportId", type: "bytes32" },
        { name: "asOfTimestamp", type: "uint64" },
        { name: "attestedFineGoldGrams", type: "uint256" },
        { name: "merkleRoot", type: "bytes32" },
        { name: "barListHash", type: "bytes32" },
      ],
    };

    return {
      registry,
      token,
      admin,
      publisher,
      pauser,
      auditor,
      minter,
      user,
      domain,
      types,
    };
  }

  async function signAttestation(params: {
    auditor: AddressSigner;
    domain: TypedDataDomain;
    types: TypedDataTypes;
    reportId: string;
    asOfTimestamp: bigint;
    attestedFineGoldGrams: bigint;
    merkleRoot: string;
    barListHash: string;
  }): Promise<string> {
    const {
      auditor,
      domain,
      types,
      reportId,
      asOfTimestamp,
      attestedFineGoldGrams,
      merkleRoot,
      barListHash,
    } = params;

    const message: Record<string, unknown> = {
      reportId,
      asOfTimestamp,
      attestedFineGoldGrams,
      merkleRoot,
      barListHash,
    };

    return signTypedDataCompat(auditor, domain, types, message);
  }

  it("OK when totalSupply (grams) <= latest attested grams", async function () {
    const { registry, token, publisher, auditor, minter, user, domain, types } =
      await deployFixture();

    const reportId = ethers.keccak256(ethers.toUtf8Bytes("R-INV-OK"));
    const asOfTimestamp = 1000n;
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

    const mintAmount = ethers.parseUnits("900", 18);
    await token.connect(minter).mint(user.address, mintAmount);

    const supplyWei = await token.totalSupply();
    const supplyGrams = gramsFromSupplyWei(supplyWei);

    const [, rec] = await registry.latestAttestation();
    const reserveGrams = rec.attestedFineGoldGrams;

    expect(supplyGrams).to.be.lte(reserveGrams);
  });

  it("detects a violation scenario (supply > reserve) without failing CI", async function () {
    const { registry, token, publisher, auditor, minter, user, domain, types } =
      await deployFixture();

    const reportId = ethers.keccak256(ethers.toUtf8Bytes("R-INV-DETECT"));
    const asOfTimestamp = 1000n;
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

    const supplyWei = await token.totalSupply();
    const supplyGrams = gramsFromSupplyWei(supplyWei);

    const [, rec] = await registry.latestAttestation();
    const reserveGrams = rec.attestedFineGoldGrams;

    expect(supplyGrams).to.be.gt(reserveGrams);
  });

  if (process.env.RUN_ALARM_TESTS === "1") {
    it("ALARM when totalSupply (grams) > latest attested grams (would fail CI)", async function () {
      const { registry, token, publisher, auditor, minter, user, domain, types } =
        await deployFixture();

      const reportId = ethers.keccak256(ethers.toUtf8Bytes("R-INV-FAIL"));
      const asOfTimestamp = 1000n;
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

      const supplyWei = await token.totalSupply();
      const supplyGrams = gramsFromSupplyWei(supplyWei);

      const [, rec] = await registry.latestAttestation();
      const reserveGrams = rec.attestedFineGoldGrams;

      expect(
        supplyGrams,
        `POLICY VIOLATION: supplyGrams(${supplyGrams}) > reserveGrams(${reserveGrams}). This must never happen in production.`
      ).to.be.lte(reserveGrams);
    });
  }
});