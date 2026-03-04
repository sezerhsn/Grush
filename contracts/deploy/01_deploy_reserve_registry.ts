/* eslint-disable no-console */
import hre from "hardhat";
import { network } from "hardhat";

import {
  getBookPath,
  loadAddressBook,
  saveAddressBook,
  resolveChainKey,
  upsertContract,
  normAddress,
} from "../../tools/address_book";

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

function envBool(key: string, def = false): boolean {
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

function buildBaseTxOverrides(ethers: any): TxOverrides {
  const gasLimitNum = envNum("GAS_LIMIT");
  const gasLimit = gasLimitNum !== undefined ? BigInt(gasLimitNum) : undefined;

  const gasPriceGwei = (process.env.GAS_PRICE_GWEI || "").trim();
  const maxFeeGwei = (process.env.MAX_FEE_GWEI || "").trim();
  const maxPrioGwei = (process.env.MAX_PRIORITY_GWEI || "").trim();

  const gasPrice = gasPriceGwei ? ethers.parseUnits(gasPriceGwei, "gwei") : undefined;
  const maxFeePerGas = maxFeeGwei ? ethers.parseUnits(maxFeeGwei, "gwei") : undefined;
  const maxPriorityFeePerGas = maxPrioGwei ? ethers.parseUnits(maxPrioGwei, "gwei") : undefined;

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
  if (!ok) throw new Error("MAINNET LOCK: chainId=1 için CONFIRM_MAINNET_DEPLOY=true olmadan deploy yok.");
}

function envAddress(ethers: any, key: string, fallback: string, label: string): string {
  const v = process.env[key];
  const a = v && v.trim().length > 0 ? v.trim() : fallback;
  if (!ethers.isAddress(a)) throw new Error(`${label} invalid address: ${a}`);
  return ethers.getAddress(a);
}

function parseCsvAddresses(ethers: any, csv: string | undefined): string[] {
  if (!csv) return [];
  const parts = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const out = parts.map((p) => {
    if (!ethers.isAddress(p)) throw new Error(`REGISTRY_ALLOWED_SIGNERS invalid: ${p}`);
    return ethers.getAddress(p);
  });

  return Array.from(new Set(out));
}

async function maybeVerify(chainId: number, address: string, args: any[]) {
  const verify = (process.env.VERIFY || "").toLowerCase() === "true";
  if (!verify) return;

  // local'lerde boşver
  if (chainId === 31337 || chainId === 1337) return;

  try {
    await hre.run("verify:verify", { address, constructorArguments: args });
    console.log(`Verified: ${address}`);
  } catch (e: any) {
    console.log(`Verify skipped/failed (non-fatal): ${e?.message ?? e}`);
  }
}

async function main() {
  // Hardhat 3 + hardhat-ethers: ethers instance network.connect() ile gelir
  const { ethers } = await network.connect(); // seçilen network: --network sepolia
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();

  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const chainKey = resolveChainKey(chainId);

  assertMainnetConfirmed(chainId);

  const baseOverrides = buildBaseTxOverrides(ethers);
  const startNonce = envNum("NONCE");
  const nonceManager = new NonceManager(startNonce);
  const confirmations = envNum("TX_CONFIRMATIONS") ?? 1;

  const admin = envAddress(ethers, "REGISTRY_ADMIN", deployerAddr, "REGISTRY_ADMIN");
  const publisher = envAddress(ethers, "REGISTRY_PUBLISHER", deployerAddr, "REGISTRY_PUBLISHER");
  const pauser = envAddress(ethers, "REGISTRY_PAUSER", deployerAddr, "REGISTRY_PAUSER");

  const allowedSigners = parseCsvAddresses(ethers, process.env.REGISTRY_ALLOWED_SIGNERS);

  console.log(
    JSON.stringify(
      {
        action: "deploy_reserve_registry",
        networkHint: process.env.HARDHAT_NETWORK ?? null,
        chainId,
        chainKey,
        deployer: deployerAddr,
        admin,
        publisher,
        pauser,
        allowedSignersCount: allowedSigners.length,
        addressBookPath: getBookPath(),
        tx: {
          nonceStart: startNonce ?? null,
          confirmations,
          gasLimit: baseOverrides.gasLimit?.toString() ?? null,
          gasPriceWei: baseOverrides.gasPrice?.toString() ?? null,
          maxFeePerGasWei: baseOverrides.maxFeePerGas?.toString() ?? null,
          maxPriorityFeePerGasWei: baseOverrides.maxPriorityFeePerGas?.toString() ?? null,
        },
      },
      null,
      2
    )
  );

  const ReserveRegistry = await ethers.getContractFactory("ReserveRegistry");
  const registry = await ReserveRegistry.deploy(admin, publisher, pauser, nonceManager.with(baseOverrides));
  await registry.waitForDeployment();

  const registryAddr = await registry.getAddress();
  console.log(`ReserveRegistry deployed: ${registryAddr}`);

  if (allowedSigners.length > 0) {
    const bools = allowedSigners.map(() => true);
    const tx = await registry
      .connect(deployer)
      .setAllowedSigners(allowedSigners, bools, nonceManager.with(baseOverrides));
    const receipt = await tx.wait(confirmations);
    console.log(
      JSON.stringify(
        {
          action: "set_allowed_signers",
          txHash: tx.hash,
          status: receipt?.status,
          signers: allowedSigners,
        },
        null,
        2
      )
    );
  } else {
    console.log("NOTE: REGISTRY_ALLOWED_SIGNERS boş. publishAttestation çalışmaz; önce setAllowedSigner(true) yapmalısın.");
  }

  const book = loadAddressBook();
  upsertContract(book, chainKey, "ReserveRegistry", {
    address: normAddress(registryAddr, "ReserveRegistry address"),
    args: [admin, publisher, pauser],
    contract: "contracts/src/ReserveRegistry.sol:ReserveRegistry",
  });
  saveAddressBook(book);
  console.log(`Updated ${getBookPath()} -> ${chainKey}.ReserveRegistry`);

  await maybeVerify(chainId, registryAddr, [admin, publisher, pauser]);

  console.log(JSON.stringify({ ok: true, reserveRegistry: registryAddr, chainId, chainKey }, null, 2));
}

main().catch((err) => {
  console.error("DEPLOY FAIL:", err?.message ?? err);
  process.exit(1);
});