/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as ethers from "ethers";

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) args[key] = true;
      else {
        args[key] = val;
        i++;
      }
    }
  }
  return args;
}

function usageAndExit(code = 1): never {
  console.error(`
Usage:
  ts-node tools/check_invariants.ts --rpc <RPC_URL> --token <GRUSH_TOKEN> --registry <RESERVE_REGISTRY> [--json]

Env alternative:
  RPC_URL=...
  GRUSH_TOKEN_ADDRESS=0x...
  RESERVE_REGISTRY_ADDRESS=0x...
  ts-node tools/check_invariants.ts

Exit codes:
  0 = OK (supply <= reserves)
  1 = VIOLATION (supply > reserves) OR critical missing state
`);
  process.exit(code);
}

function getProvider(rpcUrl: string) {
  const v6 = (ethers as any).JsonRpcProvider;
  if (typeof v6 === "function") return new v6(rpcUrl);
  const v5 = (ethers as any).providers?.JsonRpcProvider;
  if (typeof v5 === "function") return new v5(rpcUrl);
  throw new Error("ethers JsonRpcProvider bulunamadı (ethers v5/v6 uyumsuz?).");
}

function normAddress(a: string, label: string): string {
  const getAddress = (ethers as any).getAddress ?? (ethers as any).utils?.getAddress;
  if (!getAddress) throw new Error("ethers getAddress bulunamadı.");
  try {
    return getAddress(a);
  } catch {
    throw new Error(`${label} invalid address: ${a}`);
  }
}

function pow10(n: bigint): bigint {
  let x = 1n;
  for (let i = 0n; i < n; i++) x *= 10n;
  return x;
}

const TOKEN_ABI = [
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const REGISTRY_ABI = [
  "function latestReportId() view returns (bytes32)",
  "function latestAttestation() view returns (bytes32 reportId, (uint64 asOfTimestamp,uint64 publishedAt,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash,address signer) rec)",
];

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const rpc = (args.rpc as string) || (process.env.RPC_URL || "");
  const tokenAddr = (args.token as string) || (process.env.GRUSH_TOKEN_ADDRESS || "");
  const registryAddr = (args.registry as string) || (process.env.RESERVE_REGISTRY_ADDRESS || "");

  if (!rpc || !tokenAddr || !registryAddr) usageAndExit(1);

  const provider = getProvider(rpc);
  const net = await provider.getNetwork();
  const chainId = Number((net as any).chainId);

  const token = new (ethers as any).Contract(normAddress(tokenAddr, "token"), TOKEN_ABI, provider);
  const registry = new (ethers as any).Contract(normAddress(registryAddr, "registry"), REGISTRY_ABI, provider);

  const [symbol, totalSupplyRaw, decimalsRaw] = await Promise.all([
    token.symbol().catch(() => "GRUSH"),
    token.totalSupply(),
    token.decimals().catch(() => 18),
  ]);

  const decimals = BigInt(Number(decimalsRaw));
  const scale = pow10(decimals);

  const totalSupply: bigint = BigInt(totalSupplyRaw.toString());
  const supplyGrams = totalSupply / scale;
  const remainder = totalSupply % scale;

  const latestReportId: string = await registry.latestReportId();
  const [rid, rec] = await registry.latestAttestation();

  const reserveGrams: bigint = BigInt(rec.attestedFineGoldGrams.toString());

  const hasAttestation = latestReportId !== "0x" + "0".repeat(64) && rid !== "0x" + "0".repeat(64);

  let ok: boolean;
  let reason = "ok";

  if (!hasAttestation) {
    // No attestation: if supply > 0 => critical
    ok = supplyGrams === 0n;
    reason = ok ? "no_attestation_but_zero_supply" : "no_attestation_with_nonzero_supply";
  } else {
    ok = supplyGrams <= reserveGrams;
    reason = ok ? "ok" : "supply_exceeds_reserve";
  }

  const out = {
    ok,
    reason,
    chainId,
    token: {
      address: await token.getAddress(),
      symbol,
      decimals: Number(decimals),
      totalSupplyWei: totalSupply.toString(),
      supplyGrams: supplyGrams.toString(),
      supplyRemainderWei: remainder.toString(),
    },
    registry: {
      address: await registry.getAddress(),
      latestReportId: latestReportId,
      latestAsOfTimestamp: Number(rec.asOfTimestamp),
      attestedFineGoldGrams: reserveGrams.toString(),
      merkleRoot: rec.merkleRoot,
      barListHash: rec.barListHash,
      signer: rec.signer,
    },
  };

  console.log(JSON.stringify(out, null, 2));

  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error("FAIL:", e?.message ?? e);
  process.exit(1);
});
