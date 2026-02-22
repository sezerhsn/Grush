/* eslint-disable no-console */
import { ethers, network, run } from "hardhat";
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
    throw new Error("MAINNET LOCK: chainId=1 için CONFIRM_MAINNET_DEPLOY=true set etmeden deploy yok.");
  }
}

function envAddress(key: string, fallback: string, label: string): string {
  const v = process.env[key];
  return v && v.trim().length > 0 ? normAddress(v.trim(), label) : fallback;
}

async function maybeVerify(address: string, args: any[]) {
  const verify = (process.env.VERIFY || "").toLowerCase() === "true";
  if (!verify) return;
  const name = network.name?.toLowerCase?.() ?? "";
  if (name === "hardhat" || name === "localhost") return;

  try {
    await run("verify:verify", { address, constructorArguments: args });
    console.log(`Verified: ${address}`);
  } catch (e: any) {
    console.log(`Verify skipped/failed (non-fatal): ${e?.message ?? e}`);
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();

  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const chainKey = resolveChainKey(chainId);

  assertMainnetConfirmed(chainId);

  const baseOverrides = buildBaseTxOverrides();
  const startNonce = envNum("NONCE");
  const nonceManager = new NonceManager(startNonce);

  const admin = envAddress("TOKEN_ADMIN", deployerAddr, "TOKEN_ADMIN");
  const minter = envAddress("TOKEN_MINTER", deployerAddr, "TOKEN_MINTER");
  const burner = envAddress("TOKEN_BURNER", deployerAddr, "TOKEN_BURNER");
  const pauser = envAddress("TOKEN_PAUSER", deployerAddr, "TOKEN_PAUSER");

  console.log(
    JSON.stringify(
      {
        action: "deploy_grush_token",
        network: network.name,
        chainId,
        chainKey,
        deployer: deployerAddr,
        admin,
        minter,
        burner,
        pauser,
        addressBookPath: getBookPath(),
        tx: {
          nonceStart: startNonce ?? null,
          gasLimit: baseOverrides.gasLimit?.toString() ?? null,
          gasPriceWei: baseOverrides.gasPrice?.toString() ?? null,
          maxFeePerGasWei: baseOverrides.maxFeePerGas?.toString() ?? null,
          maxPriorityFeePerGasWei: baseOverrides.maxPriorityFeePerGas?.toString() ?? null,
        },
        confirmMainnetDeploy: chainId === 1 ? true : null,
      },
      null,
      2
    )
  );

  const GRUSHToken = await ethers.getContractFactory("GRUSHToken");
  const token = await GRUSHToken.deploy(admin, minter, burner, pauser, nonceManager.with(baseOverrides));
  await token.waitForDeployment();

  const tokenAddr = await token.getAddress();
  console.log(`GRUSHToken deployed: ${tokenAddr}`);

  // write address book
  const book = loadAddressBook();
  upsertContract(book, chainKey, "GRUSHToken", {
    address: tokenAddr,
    args: [admin, minter, burner, pauser],
    contract: "contracts/src/GRUSHToken.sol:GRUSHToken",
  });
  saveAddressBook(book);
  console.log(`Updated ${getBookPath()} -> ${chainKey}.GRUSHToken`);

  await maybeVerify(tokenAddr, [admin, minter, burner, pauser]);

  console.log(JSON.stringify({ ok: true, token: tokenAddr, chainId, chainKey }, null, 2));
}

main().catch((err) => {
  console.error("DEPLOY FAIL:", err?.message ?? err);
  process.exit(1);
});
