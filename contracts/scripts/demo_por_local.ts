import hre from "hardhat";
import type {
  ContractRunner,
  ContractTransactionResponse,
  TypedDataDomain,
  TypedDataField,
} from "ethers";
import { fileKeccak256Hex, leafHash, nodeHash } from "../../por/merkle/hash_utils.ts";

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

  latestReportId(): Promise<string>;
  getReportIds(start: bigint | number, count: bigint | number): Promise<string[]>;
};

type DemoBar = {
  as_of_timestamp: number;
  fineness: string;
  fine_weight_g: number;
  refiner: string;
  serial_no: string;
  vault_id: string;
};

function merkleRootFromLeaves(leaves: string[]): string {
  if (leaves.length === 0) {
    return ethers.ZeroHash;
  }

  let level = [...leaves];

  while (level.length > 1) {
    if (level.length % 2 === 1) {
      level.push(level[level.length - 1]);
    }

    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(nodeHash(level[i], level[i + 1]));
    }
    level = next;
  }

  return level[0];
}

async function main(): Promise<void> {
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

  const asOfNumber = Math.floor(Date.now() / 1000);
  const asOf = BigInt(asOfNumber);

  const bar: DemoBar = {
    as_of_timestamp: asOfNumber,
    fineness: "999.9",
    fine_weight_g: 1000,
    refiner: "ACME",
    serial_no: "ABCD-1234",
    vault_id: "IST-VAULT-01",
  };

  const leaf = leafHash(bar);
  const root = merkleRootFromLeaves([leaf]);

  // Demo amaçlı: gerçek akışta bar_list_hash dosya byte'larının keccak256'sıdır.
  // Burada tek-leaf canonical JSON byte'larını kullanıyoruz.
  const barListHash = fileKeccak256Hex(ethers.toUtf8Bytes(JSON.stringify(bar)));

  const reportId = ethers.keccak256(ethers.toUtf8Bytes("demo-report-1"));
  const attestedFineGoldGrams = 1000n;

  const chainId = Number((await ethers.provider.getNetwork()).chainId);

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
    asOfTimestamp: asOf,
    attestedFineGoldGrams,
    merkleRoot: root,
    barListHash,
  };

  const signature = await allowedSigner.signTypedData(domain, types, value);

  await registry
    .connect(publisher)
    .publishAttestation(reportId, asOf, attestedFineGoldGrams, root, barListHash, signature);

  const latest = await registry.latestReportId();
  const ids = await registry.getReportIds(999, 10);

  console.log("ReserveRegistry:", await registry.getAddress());
  console.log("reportId:", reportId);
  console.log("latestReportId:", latest);
  console.log("merkleRoot:", root);
  console.log("barListHash:", barListHash);
  console.log("getReportIds(999,10).length:", ids.length);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});