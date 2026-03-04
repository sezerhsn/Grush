/* eslint-disable no-console */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

type Args = Record<string, string | boolean>;

function isWin(): boolean {
  return process.platform === "win32";
}

function npxCmd(): string {
  return isWin() ? "npx.cmd" : "npx";
}

function abs(p: string): string {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  let positional: string | null = null;

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;

    if (!a.startsWith("--") && positional == null) {
      positional = a;
      continue;
    }

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

  if (positional && !args.report_id && !args.reportId) args.report_id = positional;
  return args;
}

function usageAndExit(code = 0): never {
  console.error(`
Usage:
  npm run por:pipeline -- --network sepolia --report_id <report_id>
  npm run por:pipeline -- <report_id> --network sepolia

Inputs (expected):
  transparency/barlists/<report_id>/bar_list.json

Outputs (standard, M2):
  transparency/attestations/<report_id>/por_output.json
  transparency/attestations/<report_id>/attestation.json (+ sepolia: attestation.sepolia.json)
  transparency/attestations/<report_id>/publish_receipt.json (unless --noPublish)
  transparency/attestations/<report_id>/verification_report.json

Compatibility (M1 verifier expects):
  transparency/reserve_reports/<report_id>/por_output.json
  transparency/attestations/<report_id>/attestation*.json

Options:
  --base <path>        default: transparency
  --barlist <path>     override bar_list.json path
  --registry <0x..>    override ReserveRegistry address (default: tools/addresses.json)
  --rpc <url>          optional; forwarded to publish/verify
  --noPublish          create attestation but do not publish on-chain
  --skipVerify         skip verify step (not recommended)
  --force              allow overwriting existing files (breaks immutability; avoid)

Env (required for signing/publishing):
  SIGNER_PRIVATE_KEY=0x...
  PUBLISHER_PRIVATE_KEY=0x...
  SEPOLIA_RPC_URL=...  (or --rpc)
`);
  process.exit(code);
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJsonFile(p: string, obj: unknown) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function runStep(label: string, cmd: string, cmdArgs: string[], captureStdout = false) {
  console.log(`\n> ${label}\n  ${cmd} ${cmdArgs.join(" ")}`);
  const res = spawnSync(cmd, cmdArgs, {
    stdio: captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: false,
    env: process.env,
    encoding: "utf8"
  });

  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`Step failed (exit ${res.status}): ${label}`);
  }

  return (res.stdout || "").toString();
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function readAddressesJson(): any {
  const p = abs("tools/addresses.json");
  if (!fileExists(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function resolveRegistry(network: string, override?: string): string {
  const o = (override || "").trim();
  if (o) return o;

  const j = readAddressesJson();
  const entry = j?.[network]?.ReserveRegistry?.address;
  if (typeof entry === "string" && entry.trim()) return entry.trim();

  throw new Error(`Registry address not found. Provide --registry or fill tools/addresses.json (${network}.ReserveRegistry.address).`);
}

function resolveChainId(network: string): number {
  const n = network.trim().toLowerCase();
  if (n === "sepolia") return 11155111;
  if (n === "mainnet") return 1;
  throw new Error(`Unknown network: ${network} (supported: sepolia, mainnet)`);
}

function guardImmutability(paths: string[], force: boolean) {
  if (force) return;
  const existing = paths.filter((p) => fileExists(p));
  if (existing.length > 0) {
    throw new Error(
      `Immutability guard: output already exists:\n- ${existing.join("\n- ")}\nUse a NEW report_id (recommended). --force is available but breaks the "immutable archive" rule.`
    );
  }
}

function copyFile(src: string, dst: string) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const reportId = String(args.report_id || args.reportId || "").trim();
  if (!reportId) usageAndExit(1);

  const base = String(args.base || "transparency").trim();
  const network = String(args.network || "sepolia").trim().toLowerCase();
  const chainId = resolveChainId(network);

  const baseAbs = abs(base);
  const reportDir = path.join(baseAbs, "attestations", reportId);

  const barListPath = abs(String(args.barlist || path.join(baseAbs, "barlists", reportId, "bar_list.json")));
  const porOutPath = path.join(reportDir, "por_output.json");

  const attSepoliaPath = path.join(reportDir, "attestation.sepolia.json");
  const attMainPath = path.join(reportDir, "attestation.json");
  const receiptPath = path.join(reportDir, "publish_receipt.json");
  const verifyOutPath = path.join(reportDir, "verification_report.json");

  const registry = resolveRegistry(network, typeof args.registry === "string" ? args.registry : undefined);

  const noPublish = Boolean(args.noPublish);
  const skipVerify = Boolean(args.skipVerify);
  const force = Boolean(args.force);
  const rpc = typeof args.rpc === "string" ? args.rpc.trim() : "";

  // Immutability guard
  const guardPaths = [porOutPath, attMainPath, attSepoliaPath, receiptPath, verifyOutPath];
  guardImmutability(guardPaths, force);

  if (!fileExists(barListPath)) {
    throw new Error(`Missing bar list: ${barListPath}`);
  }

  ensureDir(reportDir);

  const cmd = npxCmd();

  // 1) Build por_output from bar_list
  runStep(
    "build merkle + por_output",
    cmd,
    ["tsx", "por/merkle/build_merkle_root.ts", "--barlist", barListPath, "--out", porOutPath]
  );

  // 2) Sign attestation
  const attOut = network === "sepolia" ? attSepoliaPath : attMainPath;
  runStep(
    "sign attestation (EIP-712)",
    cmd,
    [
      "tsx",
      "por/attestation/sign_attestation.ts",
      "--in",
      porOutPath,
      "--registry",
      registry,
      "--chainId",
      String(chainId),
      "--out",
      attOut
    ]
  );

  // For sepolia: keep both attestation.sepolia.json and attestation.json identical (verifier preference)
  if (network === "sepolia") {
    copyFile(attSepoliaPath, attMainPath);
  }

  // 3) Publish on-chain (optional)
  if (!noPublish) {
    const publishArgs = ["tsx", "por/attestation/publish_onchain.ts", "--in", attOut, "--outReceipt", receiptPath];
    if (rpc) publishArgs.push("--rpc", rpc);

    runStep("publish attestation on-chain", cmd, publishArgs);
  } else {
    console.log("\n> publish skipped (--noPublish)");
  }

  // 4) Compatibility: copy por_output to M1 path for existing verifier layout
  const m1PorOutPath = path.join(baseAbs, "reserve_reports", reportId, "por_output.json");
  copyFile(porOutPath, m1PorOutPath);

  // 5) Verify snapshot (+ on-chain if receipt exists)
  if (!skipVerify) {
    const verifyArgs = ["tsx", "tools/verify_transparency_snapshot.ts", "--report_id", reportId, "--base", baseAbs];
    if (rpc) verifyArgs.push("--rpc", rpc);
    if (!noPublish) verifyArgs.push("--receipt", receiptPath);

    const stdout = runStep("verify snapshot", cmd, verifyArgs, true).trim();
    const parsed = JSON.parse(stdout);

    const now = Math.floor(Date.now() / 1000);
    const verificationReport = { generated_at: now, network, ...parsed };
    writeJsonFile(verifyOutPath, verificationReport);
  } else {
    console.log("\n> verify skipped (--skipVerify)");
  }

  // 6) Update latest pointer
  const now = Math.floor(Date.now() / 1000);
  const latest = {
    schema_version: "0.1",
    report_id: reportId,
    network,
    updated_at: now,
    paths: {
      bar_list: path.relative(process.cwd(), path.join(baseAbs, "barlists", reportId, "bar_list.json")),
      por_output: path.relative(process.cwd(), porOutPath),
      attestation: path.relative(process.cwd(), attMainPath),
      publish_receipt: path.relative(process.cwd(), receiptPath),
      verification_report: path.relative(process.cwd(), verifyOutPath)
    }
  };

  const latestPath = path.join(baseAbs, "attestations", "latest.json");
  writeJsonFile(latestPath, latest);

  console.log("\nOK:");
  console.log(`- report_dir: ${path.relative(process.cwd(), reportDir)}`);
  console.log(`- latest:     ${path.relative(process.cwd(), latestPath)}`);
}

main().catch((e) => {
  console.error("FAIL:", e?.message ?? e);
  process.exit(1);
});