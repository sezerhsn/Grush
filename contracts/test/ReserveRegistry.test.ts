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
  signTypedData: (
    domain: TypedDataDomain,
    types: TypedDataTypes,
    value: Record<string, unknown>
  ) => Promise<string>;
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

  exists(reportId: string): Promise<boolean>;
  latestReportId(): Promise<string>;
  getReportIds(start: bigint | number, count: bigint | number): Promise<string[]>;
};

describe("ReserveRegistry", function () {
  it("publishes an attestation and returns empty array when start >= n", async function () {
    const [admin, publisher, pauser, allowedSigner] =
      (await ethers.getSigners()) as AddressSigner[];

    const deployed = await ethers.deployContract("ReserveRegistry", [
      admin.address,
      publisher.address,
      pauser.address,
    ]);

    const registry = deployed as unknown as ReserveRegistryLike;
    await registry.waitForDeployment();

    await registry.connect(admin).setAllowedSigner(allowedSigner.address, true);

    const reportId = ethers.keccak256(ethers.toUtf8Bytes("report-1"));
    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes("root-1"));
    const barListHash = ethers.keccak256(ethers.toUtf8Bytes("barlist-1"));

    const latestBlock = await ethers.provider.getBlock("latest");
    const asOfTimestamp = BigInt(latestBlock?.timestamp ?? 0);
    const attestedFineGoldGrams = 123456789n;

    const network = await ethers.provider.getNetwork();
    const chainId = Number(network.chainId);

    const domain: TypedDataDomain = {
      name: "GRUSH Reserve Attestation",
      version: "1",
      chainId,
      verifyingContract: await registry.getAddress(),
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

    const value: Record<string, unknown> = {
      reportId,
      asOfTimestamp,
      attestedFineGoldGrams,
      merkleRoot,
      barListHash,
    };

    const signature = await allowedSigner.signTypedData(domain, types, value);

    await registry
      .connect(publisher)
      .publishAttestation(
        reportId,
        asOfTimestamp,
        attestedFineGoldGrams,
        merkleRoot,
        barListHash,
        signature
      );

    expect(await registry.exists(reportId)).to.equal(true);
    expect(await registry.latestReportId()).to.equal(reportId);

    const ids = await registry.getReportIds(999, 10);
    expect(ids.length).to.equal(0);
  });
});