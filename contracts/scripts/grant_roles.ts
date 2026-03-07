/* eslint-disable no-console */
import hre from "hardhat";
import {
  getAddress,
  id,
  isAddress,
  type ContractRunner,
  type ContractTransactionResponse,
} from "ethers";

type AddressSigner = ContractRunner & {
  getAddress(): Promise<string>;
};

type RoleManagedContractLike = {
  connect(runner: ContractRunner | null): RoleManagedContractLike;
  hasRole(role: string, account: string): Promise<boolean>;
  grantRole(role: string, account: string): Promise<ContractTransactionResponse>;
  revokeRole(role: string, account: string): Promise<ContractTransactionResponse>;
  renounceRole(role: string, account: string): Promise<ContractTransactionResponse>;
};

type ReserveRegistryLike = RoleManagedContractLike & {
  setAllowedSigners(
    signers: string[],
    allowed: boolean[]
  ): Promise<ContractTransactionResponse>;
};

type GRUSHTokenLike = RoleManagedContractLike;

function reqEnv(key: string): string {
  const value = process.env[key];
  if (!value || !value.trim()) {
    throw new Error(`Missing env: ${key}`);
  }
  return value.trim();
}

function optEnv(key: string): string | undefined {
  const value = process.env[key];
  if (!value || !value.trim()) {
    return undefined;
  }
  return value.trim();
}

function addr(label: string, value: string): string {
  if (!isAddress(value)) {
    throw new Error(`${label} invalid address: ${value}`);
  }
  return getAddress(value);
}

function parseCsvAddresses(csv?: string): string[] {
  if (!csv) {
    return [];
  }

  const out = csv
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => addr("CSV address", part));

  return Array.from(new Set(out));
}

function selectedNetworkName(): string {
  const byEnv = optEnv("HARDHAT_NETWORK");
  if (byEnv) {
    return byEnv;
  }

  return "unknown";
}

async function ensureGrant(
  contract: RoleManagedContractLike,
  role: string,
  who: string,
  roleName: string
): Promise<void> {
  const has = await contract.hasRole(role, who);
  if (has) {
    console.log(`OK: ${roleName} already granted to ${who}`);
    return;
  }

  const tx = await contract.grantRole(role, who);
  const receipt = await tx.wait();
  console.log(`GRANT: ${roleName} -> ${who} tx=${tx.hash} status=${receipt?.status}`);
}

async function ensureRenounce(
  contract: RoleManagedContractLike,
  role: string,
  who: string,
  roleName: string,
  signer: ContractRunner
): Promise<void> {
  const has = await contract.hasRole(role, who);
  if (!has) {
    console.log(`OK: ${roleName} already NOT present on ${who}`);
    return;
  }

  const tx = await contract.connect(signer).renounceRole(role, who);
  const receipt = await tx.wait();
  console.log(`RENOUNCE: ${roleName} by ${who} tx=${tx.hash} status=${receipt?.status}`);
}

async function main(): Promise<void> {
  const { ethers } = await hre.network.connect();

  const [deployer] = (await ethers.getSigners()) as AddressSigner[];
  const deployerAddr = getAddress(await deployer.getAddress());

  const providerNetwork = await ethers.provider.getNetwork();
  const chainId = Number(providerNetwork.chainId);

  const RESERVE_REGISTRY_ADDRESS = addr(
    "RESERVE_REGISTRY_ADDRESS",
    reqEnv("RESERVE_REGISTRY_ADDRESS")
  );
  const MULTISIG_ADDRESS = addr("MULTISIG_ADDRESS", reqEnv("MULTISIG_ADDRESS"));

  const TIMELOCK_ADDRESS = optEnv("TIMELOCK_ADDRESS")
    ? addr("TIMELOCK_ADDRESS", optEnv("TIMELOCK_ADDRESS") as string)
    : undefined;

  const GRUSH_TOKEN_ADDRESS = optEnv("GRUSH_TOKEN_ADDRESS")
    ? addr("GRUSH_TOKEN_ADDRESS", optEnv("GRUSH_TOKEN_ADDRESS") as string)
    : undefined;

  const ALLOWLIST_SIGNERS = parseCsvAddresses(optEnv("REGISTRY_ALLOWED_SIGNERS"));
  const SET_SIGNERS = (optEnv("SET_SIGNERS") || "").toLowerCase() === "true";

  const CLEANUP_DEPLOYER = (optEnv("CLEANUP_DEPLOYER") || "true").toLowerCase() === "true";
  const DRY_RUN = (optEnv("DRY_RUN") || "").toLowerCase() === "true";

  console.log(
    JSON.stringify(
      {
        action: "grant_roles",
        network: selectedNetworkName(),
        chainId,
        deployer: deployerAddr,
        reserveRegistry: RESERVE_REGISTRY_ADDRESS,
        grushToken: GRUSH_TOKEN_ADDRESS ?? null,
        multisig: MULTISIG_ADDRESS,
        timelock: TIMELOCK_ADDRESS ?? null,
        setSigners: SET_SIGNERS,
        allowlistSignersCount: ALLOWLIST_SIGNERS.length,
        cleanupDeployer: CLEANUP_DEPLOYER,
        dryRun: DRY_RUN,
      },
      null,
      2
    )
  );

  if (DRY_RUN) {
    console.log("DRY_RUN=true => tx gönderilmeyecek. Çıkıyorum.");
    return;
  }

  const registry = (await ethers.getContractAt(
    "ReserveRegistry",
    RESERVE_REGISTRY_ADDRESS
  )) as unknown as ReserveRegistryLike;

  const DEFAULT_ADMIN_ROLE =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  const PUBLISHER_ROLE = id("PUBLISHER_ROLE");
  const PAUSER_ROLE = id("PAUSER_ROLE");
  const SIGNER_ADMIN_ROLE = id("SIGNER_ADMIN_ROLE");

  const targetAdmin = TIMELOCK_ADDRESS ?? MULTISIG_ADDRESS;

  await ensureGrant(registry, DEFAULT_ADMIN_ROLE, targetAdmin, "DEFAULT_ADMIN_ROLE");
  await ensureGrant(registry, SIGNER_ADMIN_ROLE, targetAdmin, "SIGNER_ADMIN_ROLE");
  await ensureGrant(registry, PUBLISHER_ROLE, MULTISIG_ADDRESS, "PUBLISHER_ROLE");
  await ensureGrant(registry, PAUSER_ROLE, MULTISIG_ADDRESS, "PAUSER_ROLE");

  if (SET_SIGNERS) {
    if (ALLOWLIST_SIGNERS.length === 0) {
      console.log("SET_SIGNERS=true ama REGISTRY_ALLOWED_SIGNERS boş. Skip.");
    } else {
      const allowed = ALLOWLIST_SIGNERS.map(() => true);
      const tx = await registry.setAllowedSigners(ALLOWLIST_SIGNERS, allowed);
      const receipt = await tx.wait();
      console.log(`ALLOWLIST: setAllowedSigners tx=${tx.hash} status=${receipt?.status}`);
    }
  }

  if (CLEANUP_DEPLOYER) {
    await ensureRenounce(registry, PUBLISHER_ROLE, deployerAddr, "PUBLISHER_ROLE", deployer);
    await ensureRenounce(registry, PAUSER_ROLE, deployerAddr, "PAUSER_ROLE", deployer);
    await ensureRenounce(
      registry,
      SIGNER_ADMIN_ROLE,
      deployerAddr,
      "SIGNER_ADMIN_ROLE",
      deployer
    );
    await ensureRenounce(
      registry,
      DEFAULT_ADMIN_ROLE,
      deployerAddr,
      "DEFAULT_ADMIN_ROLE",
      deployer
    );
  } else {
    console.log("CLEANUP_DEPLOYER=false => deployer role cleanup yapılmadı.");
  }

  if (GRUSH_TOKEN_ADDRESS) {
    console.log("GRUSHToken handover starting...");

    const token = (await ethers.getContractAt(
      "GRUSHToken",
      GRUSH_TOKEN_ADDRESS
    )) as unknown as GRUSHTokenLike;

    const MINTER_ROLE = id("MINTER_ROLE");
    const BURNER_ROLE = id("BURNER_ROLE");
    const TOKEN_PAUSER_ROLE = id("PAUSER_ROLE");

    const tokenAdminTarget = TIMELOCK_ADDRESS ?? MULTISIG_ADDRESS;

    await ensureGrant(token, DEFAULT_ADMIN_ROLE, tokenAdminTarget, "TOKEN.DEFAULT_ADMIN_ROLE");
    await ensureGrant(token, MINTER_ROLE, MULTISIG_ADDRESS, "TOKEN.MINTER_ROLE");
    await ensureGrant(token, BURNER_ROLE, MULTISIG_ADDRESS, "TOKEN.BURNER_ROLE");
    await ensureGrant(token, TOKEN_PAUSER_ROLE, MULTISIG_ADDRESS, "TOKEN.PAUSER_ROLE");

    if (CLEANUP_DEPLOYER) {
      await ensureRenounce(token, MINTER_ROLE, deployerAddr, "TOKEN.MINTER_ROLE", deployer);
      await ensureRenounce(token, BURNER_ROLE, deployerAddr, "TOKEN.BURNER_ROLE", deployer);
      await ensureRenounce(
        token,
        TOKEN_PAUSER_ROLE,
        deployerAddr,
        "TOKEN.PAUSER_ROLE",
        deployer
      );
      await ensureRenounce(
        token,
        DEFAULT_ADMIN_ROLE,
        deployerAddr,
        "TOKEN.DEFAULT_ADMIN_ROLE",
        deployer
      );
    }
  } else {
    console.log("GRUSH_TOKEN_ADDRESS yok => token handover skip.");
  }

  console.log("DONE.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("FAIL:", message);
  process.exit(1);
});