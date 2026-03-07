/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import hre, { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";

type ContractEntry = {
  address: string;
  args: unknown[];
  contract?: string;
};

type AddressBook = Record<string, Record<string, ContractEntry>>;

type EthersLike = {
  isAddress: (value: string) => boolean;
  getAddress: (value: string) => string;
  provider: {
    getNetwork: () => Promise<{ chainId: bigint }>;
  };
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readJsonFile<T>(filePath: string): T {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`File not found: ${abs}`);
  }
  return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
}

function isZeroAddress(address: string): boolean {
  return address.trim().toLowerCase() === "0x0000000000000000000000000000000000000000";
}

function isHexStrict(value: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(value);
}

function normAddr(ethers: EthersLike, address: string, label: string): string {
  if (!ethers.isAddress(address)) {
    throw new Error(`${label} invalid address: ${address}`);
  }

  const checksummed = ethers.getAddress(address);
  if (isZeroAddress(checksummed)) {
    throw new Error(`${label} is ZERO address (placeholder): ${checksummed}`);
  }

  return checksummed;
}

function validateConstructorArgs(ethers: EthersLike, label: string, args: unknown[]): void {
  if (!Array.isArray(args)) {
    throw new Error(`${label}.args must be an array`);
  }

  for (let i = 0; i < args.length; i++) {
    const value = args[i];

    if (typeof value !== "string") {
      continue;
    }

    const s = value.trim();

    if (!s.startsWith("0x")) {
      continue;
    }

    if (!isHexStrict(s)) {
      throw new Error(`${label}.args[${i}] looks like a placeholder/non-hex value: "${s}"`);
    }

    if (s.length === 42) {
      if (!ethers.isAddress(s)) {
        throw new Error(`${label}.args[${i}] invalid address: "${s}"`);
      }

      const checksummed = ethers.getAddress(s);
      if (isZeroAddress(checksummed)) {
        throw new Error(`${label}.args[${i}] is ZERO address (placeholder): "${checksummed}"`);
      }

      continue;
    }

    if (s.length === 66) {
      continue;
    }

    throw new Error(
      `${label}.args[${i}] invalid 0x-value length (${s.length}). Likely placeholder: "${s}"`
    );
  }
}

function pickChainKey(): "sepolia" {
  return "sepolia";
}

async function assertSepolia(ethers: EthersLike): Promise<number> {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  if (chainId !== 11155111) {
    throw new Error(`Wrong network. Expected sepolia (11155111), got chainId=${chainId}`);
  }

  return chainId;
}

async function runVerifyTask(address: string, args: unknown[]): Promise<void> {
  await verifyContract(
    {
      address,
      constructorArgs: args,
      provider: "etherscan",
    },
    hre
  );
}

async function verifyOne(
  label: string,
  entry: ContractEntry,
  ethers: EthersLike
): Promise<void> {
  const address = normAddr(ethers, entry.address, `${label}.address`);
  const args = entry.args ?? [];
  validateConstructorArgs(ethers, label, args);

  console.log(
    JSON.stringify(
      {
        step: "verify",
        label,
        address,
        argsCount: args.length,
      },
      null,
      2
    )
  );

  try {
    await runVerifyTask(address, args);
    console.log(JSON.stringify({ ok: true, label, address }, null, 2));
  } catch (err: unknown) {
    const msg = errorMessage(err);
    const lower = msg.toLowerCase();

    const already =
      lower.includes("already verified") ||
      lower.includes("alreadyverified") ||
      lower.includes("source code already verified");

    if (already) {
      console.log(JSON.stringify({ ok: true, label, address, note: "already_verified" }, null, 2));
      return;
    }

    console.log(JSON.stringify({ ok: false, label, address, error: msg }, null, 2));
    throw err;
  }
}

async function main(): Promise<void> {
  const { ethers } = await network.connect();
  const chainId = await assertSepolia(ethers as EthersLike);

  const bookPath = process.env.ADDRESS_BOOK_PATH || "tools/addresses.json";
  const book = readJsonFile<AddressBook>(bookPath);

  const chainKey = pickChainKey();
  const chain = book[chainKey];

  if (!chain) {
    throw new Error(`addresses.json içinde "${chainKey}" bölümü yok. Path=${bookPath}`);
  }

  const token = chain.GRUSHToken;
  const registry = chain.ReserveRegistry;
  const gateway = chain.RedemptionGateway;

  if (!token || !registry || !gateway) {
    throw new Error(
      `addresses.json/${chainKey} içinde GRUSHToken, ReserveRegistry, RedemptionGateway eksik.`
    );
  }

  console.log(
    JSON.stringify(
      {
        action: "verify_sepolia",
        networkHint: process.env.HARDHAT_NETWORK ?? null,
        chainId,
        chainKey,
        addressBookPath: bookPath,
      },
      null,
      2
    )
  );

  await verifyOne("GRUSHToken", token, ethers);
  await verifyOne("ReserveRegistry", registry, ethers);
  await verifyOne("RedemptionGateway", gateway, ethers);

  console.log(JSON.stringify({ ok: true, chainId, chainKey }, null, 2));
}

main().catch((err: unknown) => {
  console.error("VERIFY FAIL:", errorMessage(err));
  process.exit(1);
});