/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { getBookPath, getContract, loadAddressBook, normAddress } from "./address_book.ts";

type ParsedArgs = Record<string, string | boolean>;

type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | { [key: string]: JsonLike };

type LatestPointer = {
  schema_version: "0.1";
  report_id: string;
  network: "sepolia" | "mainnet";
  updated_at: number;
  paths: {
    bar_list: string;
    por_output: string;
    attestation: string;
    publish_receipt?: string;
    verification_report?: string;
  };
};

function isWin(): boolean {
  return process.platform === "win32";
}

function npxCmd(): string {
  return isWin() ? "npx.cmd" : "npx";
}

function abs(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.join(process.cwd(), inputPath);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  let positional: string | null = null;

  for (let i = 2; i < argv.length; i++) {
    const current = argv[i];
    if (!current) continue;

    if (!current.startsWith("--") && positional === null) {
      positional = current;
      continue;
    }

    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }

    if (!current.startsWith("--")) continue;

    const key = current.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i++;
  }

  if (positional && !args.report_id && !args.reportId) {
    args.report_id = positional;
  }

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
  transparency/attestations/<report_id>/attestation.json
  transparency/attestations/<report_id>/publish_receipt.json   (unless --noPublish)
  transparency/attestations/<report_id>/verification_report.json (unless --skipVerify)

Compatibility (M1 verifier expects):
  transparency/reserve_reports/<report_id>/por_output.json
  transparency/attestations/<report_id>/attestation*.json

Options:
  --base <path>        default: transparency
  --barlist <path>     override bar_list.json path
  --registry <0x..>    override ReserveRegistry address (default: tools/addresses.json)
  --rpc <url>          optional; forwarded to publish/verify
  --network <name>     sepolia | mainnet (default: sepolia)
  --noPublish          create attestation but do not publish on-chain
  --skipVerify         skip verify step (not recommended)
  --force              allow overwriting existing files (breaks immutability; avoid)

Env (signing / publish):
  SIGNER_PRIVATE_KEY=0x...        (legacy: ATTESTATION_SIGNER_PK)
  PUBLISHER_PRIVATE_KEY=0x...     (legacy: PUBLISHER_PK)
  SEPOLIA_RPC_URL=... / MAINNET_RPC_URL=... / RPC_URL=...
  CONFIRM_MAINNET_DEPLOY=true     (required when publishing to mainnet)
`);
  process.exit(code);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonFile(filePath: string, obj: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

function assertNoUnsafeIntegers(value: unknown, where = "root"): void {
  if (value === null || value === undefined) return;

  if (typeof value === "number") {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`Unsafe integer in JSON at ${where}: ${value}. Use decimal string.`);
    }
    return;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoUnsafeIntegers(value[i], `${where}[${i}]`);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertNoUnsafeIntegers(child, `${where}.${key}`);
    }
  }
}

function runStep(
  label: string,
  cmd: string,
  cmdArgs: string[],
  captureStdout = false
): string {
  console.log(`\n> ${label}\n  ${cmd} ${cmdArgs.join(" ")}`);

  const res = spawnSync(cmd, cmdArgs, {
    stdio: captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: false,
    env: process.env,
    encoding: "utf8",
  });

  if (res.error) {
    throw res.error;
  }

  if (res.status !== 0) {
    throw new Error(`Step failed (exit ${res.status}): ${label}`);
  }

  return (res.stdout || "").toString();
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function envStr(key: string): string {
  return (process.env[key] || "").trim();
}

function resolveChainId(network: string): 11155111 | 1 {
  const normalized = network.trim().toLowerCase();

  if (normalized === "sepolia") return 11155111;
  if (normalized === "mainnet") return 1;

  throw new Error(`Unknown network: ${network} (supported: sepolia, mainnet)`);
}

function resolveRegistry(network: "sepolia" | "mainnet", override?: string): string {
  const provided = (override || "").trim();
  if (provided) {
    return normAddress(provided, "--registry");
  }

  const book = loadAddressBook(getBookPath());
  const entry = getContract(book, network, "ReserveRegistry");

  if (!entry?.address) {
    throw new Error(
      `Registry address not found. Provide --registry or fill ${getBookPath()} (${network}.ReserveRegistry.address).`
    );
  }

  return normAddress(entry.address, `${network}.ReserveRegistry.address`);
}

function guardImmutability(paths: string[], force: boolean): void {
  if (force) return;

  const existing = paths.filter((filePath) => fileExists(filePath));
  if (existing.length > 0) {
    throw new Error(
      `Immutability guard: output already exists:\n- ${existing.join(
        "\n- "
      )}\nUse a NEW report_id (recommended). --force is available but breaks the "immutable archive" rule.`
    );
  }
}

function copyFile(src: string, dst: string): void {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function ensureNonEmptyEnvOneOf(keys: readonly string[], label: string): void {
  for (const key of keys) {
    if (envStr(key)) return;
  }
  throw new Error(`Missing secret/env: ${label}`);
}

function resolveRpcForNetwork(
  network: "sepolia" | "mainnet",
  explicitRpc: string
): { rpc: string; source: string } {
  const byArg = explicitRpc.trim();
  if (byArg) {
    return { rpc: byArg, source: "--rpc" };
  }

  if (network === "sepolia") {
    const sepolia = envStr("SEPOLIA_RPC_URL");
    if (sepolia) return { rpc: sepolia, source: "SEPOLIA_RPC_URL" };
  }

  if (network === "mainnet") {
    const mainnet = envStr("MAINNET_RPC_URL");
    if (mainnet) return { rpc: mainnet, source: "MAINNET_RPC_URL" };
  }

  const fallback = envStr("RPC_URL");
  if (fallback) {
    return { rpc: fallback, source: "RPC_URL" };
  }

  return { rpc: "", source: "none" };
}

function assertMainnetConfirmed(network: "sepolia" | "mainnet", noPublish: boolean): void {
  if (network !== "mainnet") return;
  if (noPublish) return;

  const confirmed = envStr("CONFIRM_MAINNET_DEPLOY").toLowerCase();
  if (!(confirmed === "true" || confirmed === "1" || confirmed === "yes" || confirmed === "y")) {
    throw new Error(
      "MAINNET LOCK: mainnet publish için CONFIRM_MAINNET_DEPLOY=true set etmeden devam yok."
    );
  }
}

function preflight(params: {
  network: "sepolia" | "mainnet";
  noPublish: boolean;
  skipVerify: boolean;
  rpc: string;
}): void {
  ensureNonEmptyEnvOneOf(
    ["SIGNER_PRIVATE_KEY", "ATTESTATION_SIGNER_PK"],
    "SIGNER_PRIVATE_KEY (legacy: ATTESTATION_SIGNER_PK)"
  );

  if (!params.noPublish) {
    ensureNonEmptyEnvOneOf(
      ["PUBLISHER_PRIVATE_KEY", "PUBLISHER_PK"],
      "PUBLISHER_PRIVATE_KEY (legacy: PUBLISHER_PK)"
    );
  }

  if (!params.noPublish) {
    if (!params.rpc) {
      throw new Error(
        `RPC URL yok. --rpc ver veya ${
          params.network === "sepolia" ? "SEPOLIA_RPC_URL" : "MAINNET_RPC_URL"
        } / RPC_URL set et.`
      );
    }
  }

  assertMainnetConfirmed(params.network, params.noPublish);

  if (params.skipVerify) {
    console.log("PRECHECK: verify skip requested.");
  } else if (!params.noPublish && params.rpc) {
    console.log("PRECHECK: verify on-chain cross-check için RPC hazır.");
  } else {
    console.log("PRECHECK: local verify mode.");
  }
}

function parseJsonStdout<T>(stdout: string, label: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`${label} stdout boş döndü.`);
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch (err: unknown) {
    throw new Error(`${label} stdout geçerli JSON değil: ${errorMessage(err)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const reportId =
    (typeof args.report_id === "string" ? args.report_id : "") ||
    (typeof args.reportId === "string" ? args.reportId : "");

  if (!reportId.trim()) {
    usageAndExit(1);
  }

  const base = typeof args.base === "string" ? args.base.trim() : "transparency";
  const networkRaw = typeof args.network === "string" ? args.network.trim().toLowerCase() : "sepolia";
  if (networkRaw !== "sepolia" && networkRaw !== "mainnet") {
    throw new Error(`Unknown network: ${networkRaw} (supported: sepolia, mainnet)`);
  }

  const network: "sepolia" | "mainnet" = networkRaw;
  const chainId = resolveChainId(network);

  const noPublish = args.noPublish === true;
  const skipVerify = args.skipVerify === true;
  const force = args.force === true;
  const rpc = typeof args.rpc === "string" ? args.rpc.trim() : "";

  const resolvedRpc = resolveRpcForNetwork(network, rpc);
  preflight({
    network,
    noPublish,
    skipVerify,
    rpc: resolvedRpc.rpc,
  });

  const baseAbs = abs(base);
  const reportDir = path.join(baseAbs, "attestations", reportId);
  const barListPath =
    typeof args.barlist === "string"
      ? abs(args.barlist)
      : path.join(baseAbs, "barlists", reportId, "bar_list.json");

  const porOutPath = path.join(reportDir, "por_output.json");
  const attSepoliaPath = path.join(reportDir, "attestation.sepolia.json");
  const attMainPath = path.join(reportDir, "attestation.json");
  const receiptPath = path.join(reportDir, "publish_receipt.json");
  const verifyOutPath = path.join(reportDir, "verification_report.json");
  const m1PorOutPath = path.join(baseAbs, "reserve_reports", reportId, "por_output.json");

  const registry = resolveRegistry(
    network,
    typeof args.registry === "string" ? args.registry : undefined
  );

  guardImmutability(
    [porOutPath, attMainPath, attSepoliaPath, receiptPath, verifyOutPath],
    force
  );

  if (!fileExists(barListPath)) {
    throw new Error(`Missing bar list: ${barListPath}`);
  }

  ensureDir(reportDir);

  const cmd = npxCmd();

  runStep("build merkle + por_output", cmd, [
    "tsx",
    "por/merkle/build_merkle_root.ts",
    "--barlist",
    barListPath,
    "--out",
    porOutPath,
  ]);

  const attOut = network === "sepolia" ? attSepoliaPath : attMainPath;

  runStep("sign attestation (EIP-712)", cmd, [
    "tsx",
    "por/attestation/sign_attestation.ts",
    "--in",
    porOutPath,
    "--registry",
    registry,
    "--chainId",
    String(chainId),
    "--out",
    attOut,
  ]);

  if (network === "sepolia") {
    copyFile(attSepoliaPath, attMainPath);
  }

  if (!noPublish) {
    const publishArgs = [
      "tsx",
      "por/attestation/publish_onchain.ts",
      "--in",
      attOut,
      "--outReceipt",
      receiptPath,
    ];

    if (resolvedRpc.rpc) {
      publishArgs.push("--rpc", resolvedRpc.rpc);
    }

    runStep("publish attestation on-chain", cmd, publishArgs);
  } else {
    console.log("\n> publish skipped (--noPublish)");
  }

  copyFile(porOutPath, m1PorOutPath);

  if (!skipVerify) {
    const verifyArgs = [
      "tsx",
      "tools/verify_transparency_snapshot.ts",
      "--report_id",
      reportId,
      "--base",
      baseAbs,
    ];

    if (resolvedRpc.rpc) {
      verifyArgs.push("--rpc", resolvedRpc.rpc);
    }

    if (!noPublish) {
      verifyArgs.push("--receipt", receiptPath);
    }

    const stdout = runStep("verify snapshot", cmd, verifyArgs, true);
    const parsed = parseJsonStdout<JsonLike>(stdout, "verify snapshot");

    assertNoUnsafeIntegers(parsed, "verification_output");

    const verificationReport = {
      generated_at: Math.floor(Date.now() / 1000),
      network,
      ...((parsed as object) || {}),
    };

    writeJsonFile(verifyOutPath, verificationReport);
  } else {
    console.log("\n> verify skipped (--skipVerify)");
  }

  const latest: LatestPointer = {
    schema_version: "0.1",
    report_id: reportId,
    network,
    updated_at: Math.floor(Date.now() / 1000),
    paths: {
      bar_list: path.relative(process.cwd(), path.join(baseAbs, "barlists", reportId, "bar_list.json")),
      por_output: path.relative(process.cwd(), porOutPath),
      attestation: path.relative(process.cwd(), attMainPath),
      ...(fileExists(receiptPath)
        ? { publish_receipt: path.relative(process.cwd(), receiptPath) }
        : {}),
      ...(fileExists(verifyOutPath)
        ? { verification_report: path.relative(process.cwd(), verifyOutPath) }
        : {}),
    },
  };

  const latestPath = path.join(baseAbs, "attestations", "latest.json");
  writeJsonFile(latestPath, latest);

  console.log("\nOK:");
  console.log(`- report_dir: ${path.relative(process.cwd(), reportDir)}`);
  console.log(`- latest:     ${path.relative(process.cwd(), latestPath)}`);
}

main().catch((err: unknown) => {
  console.error("FAIL:", errorMessage(err));
  process.exit(1);
});