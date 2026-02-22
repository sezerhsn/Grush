/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ethers, network } from "hardhat";
import {
  loadAddressBook,
  resolveChainKey,
  getContract,
  normAddress,
  getBookPath,
} from "../../tools/address_book";

const ZERO_ROLE =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

type TxOverrides = {
  nonce?: number;
  gasLimit?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

class NonceManager {
  private next?: number;
  constructor(start?: number) {
    this.next = start;
  }
  public with(overrides: TxOverrides): TxOverrides {
    if (this.next === undefined) return overrides;
    const o: TxOverrides = { ...overrides, nonce: this.next };
    this.next += 1;
    return o;
  }
}

function envBool(key: string, def: boolean): boolean {
  const v = (process.env[key] || "").trim().toLowerCase();
  if (!v) return def;
  return v === "true" || v === "1" || v === "yes" || v === "y";
}

function envNum(key: string): number | undefined {
  const v = (process.env[key] || "").trim();
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} invalid number: ${v}`);
  return n;
}

function envGwei(key: string): bigint | undefined {
  const v = (process.env[key] || "").trim();
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} invalid gwei: ${v}`);
  return ethers.parseUnits(v, "gwei");
}

function buildBaseTxOverrides(): TxOverrides {
  const gasLimitNum = envNum("GAS_LIMIT");
  const gasLimit = gasLimitNum !== undefined ? BigInt(gasLimitNum) : undefined;

  const gasPrice = envGwei("GAS_PRICE_GWEI");
  const maxFeePerGas = envGwei("MAX_FEE_GWEI");
  const maxPriorityFeePerGas = envGwei("MAX_PRIORITY_GWEI");

  if (gasPrice && (maxFeePerGas || maxPriorityFeePerGas)) {
    throw new Error("Fee config invalid: GAS_PRICE_GWEI ile MAX_FEE_GWEI/MAX_PRIORITY_GWEI aynı anda set edilmez.");
  }
  if ((maxFeePerGas && !maxPriorityFeePerGas) || (!maxFeePerGas && maxPriorityFeePerGas)) {
    throw new Error("Fee config invalid: EIP-1559 için MAX_FEE_GWEI ve MAX_PRIORITY_GWEI birlikte set edilmeli.");
  }

  const o: TxOverrides = {};
  if (gasLimit !== undefined) o.gasLimit = gasLimit;
  if (gasPrice) o.gasPrice = gasPrice;
  if (maxFeePerGas) o.maxFeePerGas = maxFeePerGas;
  if (maxPriorityFeePerGas) o.maxPriorityFeePerGas = maxPriorityFeePerGas;
  return o;
}

function assertMainnetConfirmed(chainId: number) {
  if (chainId !== 1) return;
  const ok = envBool("CONFIRM_MAINNET_DEPLOY", false);
  if (!ok) {
    throw new Error("MAINNET LOCK: chainId=1 için CONFIRM_MAINNET_DEPLOY=true set etmeden işlem yok.");
  }
}

function envAddr(key: string): string | undefined {
  const v = (process.env[key] || "").trim();
  if (!v) return undefined;
  return normAddress(v, key);
}

function envAddrOr(key: string, fallback: string): string {
  const v = envAddr(key);
  return v ?? fallback;
}

function parseCsvAddresses(csv?: string): string[] {
  if (!csv) return [];
  const parts = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => normAddress(s, "CSV item"));
  return Array.from(new Set(parts));
}

async function hasRole(ac: any, role: string, who: string): Promise<boolean> {
  return await ac.hasRole(role, who);
}

async function ensureGrant(
  ac: any,
  role: string,
  who: string,
  label: string,
  dryRun: boolean,
  txo: TxOverrides,
  nm: NonceManager,
  confirmations: number
) {
  const ok = await hasRole(ac, role, who);
  if (ok) {
    console.log(`OK: ${label} already granted -> ${who}`);
    return;
  }
  if (dryRun) {
    console.log(`DRY_RUN: would grant ${label} -> ${who}`);
    return;
  }
  const tx = await ac.grantRole(role, who, nm.with(txo));
  const rc = await tx.wait(confirmations);
  console.log(`GRANT: ${label} -> ${who} tx=${tx.hash} status=${rc?.status}`);
}

async function ensureRenounce(
  ac: any,
  role: string,
  who: string,
  label: string,
  signer: any,
  dryRun: boolean,
  txo: TxOverrides,
  nm: NonceManager,
  confirmations: number
) {
  const ok = await hasRole(ac, role, who);
  if (!ok) {
    console.log(`OK: ${label} not present on ${who}`);
    return;
  }
  if (dryRun) {
    console.log(`DRY_RUN: would renounce ${label} by ${who}`);
    return;
  }
  const tx = await ac.connect(signer).renounceRole(role, who, nm.with(txo));
  const rc = await tx.wait(confirmations);
  console.log(`RENOUNCE: ${label} by ${who} tx=${tx.hash} status=${rc?.status}`);
}

async function ensureAllowedSigners(
  registry: any,
  signers: string[],
  dryRun: boolean,
  txo: TxOverrides,
  nm: NonceManager,
  confirmations: number
) {
  if (signers.length === 0) {
    console.log("NOTE: REGISTRY_ALLOWED_SIGNERS empty; skip allowlist.");
    return;
  }

  const toEnable: string[] = [];
  for (const s of signers) {
    const allowed = await registry.isAllowedSigner(s);
    if (!allowed) toEnable.push(s);
  }

  if (toEnable.length === 0) {
    console.log("OK: all REGISTRY_ALLOWED_SIGNERS already enabled.");
    return;
  }

  if (dryRun) {
    console.log(`DRY_RUN: would setAllowedSigners(true) for ${toEnable.length} signer(s)`);
    return;
  }

  const bools = toEnable.map(() => true);
  const tx = await registry.setAllowedSigners(toEnable, bools, nm.with(txo));
  const rc = await tx.wait(confirmations);
  console.log(`ALLOWLIST: enabled ${toEnable.length} signer(s) tx=${tx.hash} status=${rc?.status}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = normAddress(await deployer.getAddress(), "deployer");

  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const chainKey = resolveChainKey(chainId);

  assertMainnetConfirmed(chainId);

  const dryRun = envBool("DRY_RUN", false);
  const cleanupDeployer = envBool("CLEANUP_DEPLOYER", true);

  const multisig = envAddr("MULTISIG_ADDRESS");
  if (!multisig) throw new Error("Missing env: MULTISIG_ADDRESS");

  const timelock = envAddr("TIMELOCK_ADDRESS");
  const adminTarget = timelock ?? multisig;

  const setRegistrySigners = envBool("SET_SIGNERS", false);
  const registrySigners = parseCsvAddresses(process.env.REGISTRY_ALLOWED_SIGNERS);
  const ensureGatewayBurner = envBool("ENSURE_GATEWAY_BURNER", true);

  const baseOverrides = buildBaseTxOverrides();
  const startNonce = envNum("NONCE");
  const nonceManager = new NonceManager(startNonce);
  const confirmations = envNum("TX_CONFIRMATIONS") ?? 1;

  // Ops overrides (default multisig)
  const tokenMinterTarget = envAddrOr("TOKEN_MINTER_TARGET", multisig);
  const tokenBurnerTarget = envAddrOr("TOKEN_BURNER_TARGET", multisig);
  const tokenPauserTarget = envAddrOr("TOKEN_PAUSER_TARGET", multisig);

  const registryPublisherTarget = envAddrOr("REGISTRY_PUBLISHER_TARGET", multisig);
  const registryPauserTarget = envAddrOr("REGISTRY_PAUSER_TARGET", multisig);

  const gatewayOperatorTarget = envAddrOr("GATEWAY_OPERATOR_TARGET", multisig);
  const gatewayPauserTarget = envAddrOr("GATEWAY_PAUSER_TARGET", multisig);

  const bookPath = getBookPath();
  const book = loadAddressBook(bookPath);

  const tokenEntry = getContract(book, chainKey, "GRUSHToken");
  const registryEntry = getContract(book, chainKey, "ReserveRegistry");
  const gatewayEntry = getContract(book, chainKey, "RedemptionGateway");

  console.log(
    JSON.stringify(
      {
        action: "post_deploy_handover",
        network: network.name,
        chainId,
        chainKey,
        addressBookPath: bookPath,
        deployer: deployerAddr,
        multisig,
        timelock: timelock ?? null,
        adminTarget,
        dryRun,
        cleanupDeployer,
        setRegistrySigners,
        registrySignersCount: registrySigners.length,
        ensureGatewayBurner,
        tx: {
          nonceStart: startNonce ?? null,
          confirmations,
          gasLimit: baseOverrides.gasLimit?.toString() ?? null,
          gasPriceWei: baseOverrides.gasPrice?.toString() ?? null,
          maxFeePerGasWei: baseOverrides.maxFeePerGas?.toString() ?? null,
          maxPriorityFeePerGasWei: baseOverrides.maxPriorityFeePerGas?.toString() ?? null,
        },
        confirmMainnetDeploy: chainId === 1 ? true : null,
        contractsFound: {
          GRUSHToken: !!tokenEntry?.address,
          ReserveRegistry: !!registryEntry?.address,
          RedemptionGateway: !!gatewayEntry?.address,
        },
      },
      null,
      2
    )
  );

  // -------------------------
  // GRUSHToken handover
  // -------------------------
  if (tokenEntry?.address && ethers.isAddress(tokenEntry.address) && tokenEntry.address !== ethers.ZeroAddress) {
    const tokenAddr = normAddress(tokenEntry.address, "GRUSHToken.address");
    console.log(`\n=== GRUSHToken @ ${tokenAddr} ===`);

    const token = await ethers.getContractAt("GRUSHToken", tokenAddr);

    const MINTER_ROLE = await token.MINTER_ROLE();
    const BURNER_ROLE = await token.BURNER_ROLE();
    const PAUSER_ROLE = await token.PAUSER_ROLE();

    await ensureGrant(token, ZERO_ROLE, adminTarget, "TOKEN.DEFAULT_ADMIN_ROLE", dryRun, baseOverrides, nonceManager, confirmations);
    await ensureGrant(token, MINTER_ROLE, tokenMinterTarget, "TOKEN.MINTER_ROLE", dryRun, baseOverrides, nonceManager, confirmations);
    await ensureGrant(token, BURNER_ROLE, tokenBurnerTarget, "TOKEN.BURNER_ROLE", dryRun, baseOverrides, nonceManager, confirmations);
    await ensureGrant(token, PAUSER_ROLE, tokenPauserTarget, "TOKEN.PAUSER_ROLE", dryRun, baseOverrides, nonceManager, confirmations);

    // Optional: ensure gateway has burner role
    if (ensureGatewayBurner && gatewayEntry?.address && ethers.isAddress(gatewayEntry.address) && gatewayEntry.address !== ethers.ZeroAddress) {
      const gwAddr = normAddress(gatewayEntry.address, "RedemptionGateway.address");
      const has = await token.hasRole(BURNER_ROLE, gwAddr);
      if (!has) {
        console.log(`NOTE: gateway missing TOKEN.BURNER_ROLE -> ${gwAddr}`);
        await ensureGrant(token, BURNER_ROLE, gwAddr, "TOKEN.BURNER_ROLE (gateway)", dryRun, baseOverrides, nonceManager, confirmations);
      } else {
        console.log("OK: gateway already has TOKEN.BURNER_ROLE");
      }
    }

    if (cleanupDeployer) {
      await ensureRenounce(token, MINTER_ROLE, deployerAddr, "TOKEN.MINTER_ROLE", deployer, dryRun, baseOverrides, nonceManager, confirmations);
      await ensureRenounce(token, BURNER_ROLE, deployerAddr, "TOKEN.BURNER_ROLE", deployer, dryRun, baseOverrides, nonceManager, confirmations);
      await ensureRenounce(token, PAUSER_ROLE, deployerAddr, "TOKEN.PAUSER_ROLE", deployer, dryRun, baseOverrides, nonceManager, confirmations);
      await ensureRenounce(token, ZERO_ROLE, deployerAddr, "TOKEN.DEFAULT_ADMIN_ROLE", deployer, dryRun, baseOverrides, nonceManager, confirmations);
    }
  } else {
    console.log("\nSKIP: GRUSHToken not found in address book for this chain.");
  }

  // -------------------------
  // ReserveRegistry handover
  // -------------------------
  if (registryEntry?.address && ethers.isAddress(registryEntry.address) && registryEntry.address !== ethers.ZeroAddress) {
    const registryAddr = normAddress(registryEntry.address, "ReserveRegistry.address");
    console.log(`\n=== ReserveRegistry @ ${registryAddr} ===`);

    const registry = await ethers.getContractAt("ReserveRegistry", registryAddr);

    const PUBLISHER_ROLE = ethers.id("PUBLISHER_ROLE");
    const PAUSER_ROLE = ethers.id("PAUSER_ROLE");
    const SIGNER_ADMIN_ROLE = ethers.id("SIGNER_ADMIN_ROLE");

    await ensureGrant(registry, ZERO_ROLE, adminTarget, "REGISTRY.DEFAULT_ADMIN_ROLE", dryRun, baseOverrides, nonceManager, confirmations);
    await ensureGrant(registry, SIGNER_ADMIN_ROLE, adminTarget, "REGISTRY.SIGNER_ADMIN_ROLE", dryRun, baseOverrides, nonceManager, confirmations);

    await ensureGrant(registry, PUBLISHER_ROLE, registryPublisherTarget, "REGISTRY.PUBLISHER_ROLE", dryRun, baseOverrides, nonceManager, confirmations);
    await ensureGrant(registry, PAUSER_ROLE, registryPauserTarget, "REGISTRY.PAUSER_ROLE", dryRun, baseOverrides, nonceManager, confirmations);

    if (setRegistrySigners) {
      try {
        await ensureAllowedSigners(registry, registrySigners, dryRun, baseOverrides, nonceManager, confirmations);
      } catch (e: any) {
        console.log(
          `WARN: setAllowedSigners failed (non-fatal). Muhtemelen deployer SIGNER_ADMIN_ROLE değil. Error: ${e?.message ?? e}`
        );
        console.log("NOTE: Bu adımı timelock/multisig üzerinden yapmalısın.");
      }
    }

    if (cleanupDeployer) {
      await ensureRenounce(registry, PUBLISHER_ROLE, deployerAddr, "REGISTRY.PUBLISHER_ROLE", deployer, dryRun, baseOverrides, nonceManager, confirmations);
      await ensureRenounce(registry, PAUSER_ROLE, deployerAddr, "REGISTRY.PAUSER_ROLE", deployer, dryRun, baseOverrides, nonceManager, confirmations);
      await ensureRenounce(registry, SIGNER_ADMIN_ROLE, deployerAddr, "REGISTRY.SIGNER_ADMIN_ROLE", deployer, dryRun, baseOverrides, nonceManager, confirmations);
      await ensureRenounce(registry, ZERO_ROLE, deployerAddr, "REGISTRY.DEFAULT_ADMIN_ROLE", deployer, dryRun, baseOverrides, nonceManager, confirmations);
    }
  } else {
    console.log("\nSKIP: ReserveRegistry not found in address book for this chain.");
  }

  // -------------------------
  // RedemptionGateway handover
  // -------------------------
  if (gatewayEntry?.address && ethers.isAddress(gatewayEntry.address) && gatewayEntry.address !== ethers.ZeroAddress) {
    const gatewayAddr = normAddress(gatewayEntry.address, "RedemptionGateway.address");
    console.log(`\n=== RedemptionGateway @ ${gatewayAddr} ===`);

    const gateway = await ethers.getContractAt("RedemptionGateway", gatewayAddr);

    const OPERATOR_ROLE = ethers.id("OPERATOR_ROLE");
    const PAUSER_ROLE = ethers.id("PAUSER_ROLE");

    await ensureGrant(gateway, ZERO_ROLE, adminTarget, "GATEWAY.DEFAULT_ADMIN_ROLE", dryRun, baseOverrides, nonceManager, confirmations);
    await ensureGrant(gateway, OPERATOR_ROLE, gatewayOperatorTarget, "GATEWAY.OPERATOR_ROLE", dryRun, baseOverrides, nonceManager, confirmations);
    await ensureGrant(gateway, PAUSER_ROLE, gatewayPauserTarget, "GATEWAY.PAUSER_ROLE", dryRun, baseOverrides, nonceManager, confirmations);

    if (cleanupDeployer) {
      await ensureRenounce(gateway, OPERATOR_ROLE, deployerAddr, "GATEWAY.OPERATOR_ROLE", deployer, dryRun, baseOverrides, nonceManager, confirmations);
      await ensureRenounce(gateway, PAUSER_ROLE, deployerAddr, "GATEWAY.PAUSER_ROLE", deployer, dryRun, baseOverrides, nonceManager, confirmations);
      await ensureRenounce(gateway, ZERO_ROLE, deployerAddr, "GATEWAY.DEFAULT_ADMIN_ROLE", deployer, dryRun, baseOverrides, nonceManager, confirmations);
    }
  } else {
    console.log("\nSKIP: RedemptionGateway not found in address book for this chain.");
  }

  console.log("\nDONE: post_deploy_handover");
}

main().catch((e) => {
  console.error("HANDOVER FAIL:", e?.message ?? e);
  process.exit(1);
});
