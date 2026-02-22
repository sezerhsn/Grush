/* eslint-disable no-console */
import fs from "fs";
import path from "path";
import { network, run, ethers } from "hardhat";

type ContractEntry = {
  address: string;
  args: any[];
  contract?: string;
};

type AddressBook = Record<string, Record<string, ContractEntry>>;

function readJson(p: string): any {
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function isZeroAddress(a: string): boolean {
  return a.trim().toLowerCase() === "0x0000000000000000000000000000000000000000";
}

function isHexStrict(s: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(s);
}

function normAddr(a: string, label: string): string {
  if (!ethers.isAddress(a)) throw new Error(`${label} invalid address: ${a}`);
  const cs = ethers.getAddress(a);
  if (isZeroAddress(cs)) throw new Error(`${label} is ZERO address (placeholder): ${cs}`);
  return cs;
}

function validateConstructorArgs(label: string, args: any[]) {
  if (!Array.isArray(args)) throw new Error(`${label}.args must be an array`);

  for (let i = 0; i < args.length; i++) {
    const v = args[i];

    if (typeof v !== "string") continue;

    const s = v.trim();

    if (s.startsWith("0x")) {
      if (!isHexStrict(s)) {
        throw new Error(`${label}.args[${i}] looks like a placeholder/non-hex value: "${s}"`);
      }

      if (s.length === 42) {
        if (!ethers.isAddress(s)) throw new Error(`${label}.args[${i}] invalid address: "${s}"`);
        const cs = ethers.getAddress(s);
        if (isZeroAddress(cs)) throw new Error(`${label}.args[${i}] is ZERO address (placeholder): "${cs}"`);
      } else if (s.length === 66) {
        // bytes32-like ok
      } else {
        throw new Error(
          `${label}.args[${i}] invalid 0x-value length (${s.length}). Likely placeholder: "${s}"`
        );
      }
    }
  }
}

function pickChainKey(): "mainnet" {
  return "mainnet";
}

async function assertMainnet() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== 1) {
    throw new Error(
      `Wrong network. Expected mainnet (1), got chainId=${chainId} network=${network.name}`
    );
  }
}

async function verifyOne(label: string, entry: ContractEntry, defaultFqn: string) {
  const address = normAddr(entry.address, `${label}.address`);
  const args = entry.args ?? [];
  validateConstructorArgs(label, args);

  const contract = entry.contract ?? defaultFqn;

  console.log(JSON.stringify({ step: "verify", label, address, contract, argsCount: args.length }, null, 2));

  try {
    await run("verify:verify", {
      address,
      constructorArguments: args,
      contract,
    });
    console.log(JSON.stringify({ ok: true, label, address }, null, 2));
  } catch (e: any) {
    const msg = (e?.message ?? String(e)) as string;
    const already =
      msg.toLowerCase().includes("already verified") ||
      msg.toLowerCase().includes("alreadyverified") ||
      msg.toLowerCase().includes("source code already verified");
    if (already) {
      console.log(JSON.stringify({ ok: true, label, address, note: "already_verified" }, null, 2));
      return;
    }
    console.log(JSON.stringify({ ok: false, label, address, error: msg }, null, 2));
    throw e;
  }
}

async function main() {
  await assertMainnet();

  const bookPath = process.env.ADDRESS_BOOK_PATH || "tools/addresses.json";
  const book = readJson(bookPath) as AddressBook;

  const chainKey = pickChainKey();
  const chain = book[chainKey];
  if (!chain) {
    throw new Error(`addresses.json içinde "${chainKey}" bölümü yok. Path=${bookPath}`);
  }

  const token = chain.GRUSHToken;
  const registry = chain.ReserveRegistry;
  const gateway = chain.RedemptionGateway;

  if (!token || !registry || !gateway) {
    throw new Error(`addresses.json/${chainKey} içinde GRUSHToken, ReserveRegistry, RedemptionGateway eksik.`);
  }

  await verifyOne("GRUSHToken", token, "contracts/src/GRUSHToken.sol:GRUSHToken");
  await verifyOne("ReserveRegistry", registry, "contracts/src/ReserveRegistry.sol:ReserveRegistry");
  await verifyOne("RedemptionGateway", gateway, "contracts/src/RedemptionGateway.sol:RedemptionGateway");

  console.log(JSON.stringify({ ok: true, network: network.name, chainKey }, null, 2));
}

main().catch((e) => {
  console.error("VERIFY FAIL:", e?.message ?? e);
  process.exit(1);
});
