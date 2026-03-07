/* eslint-disable no-console */
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

type StepKey = "token" | "registry" | "gateway" | "handover" | "verify";

type Step = {
  key: StepKey;
  label: string;
  script: string;
};

type AddressBookEntry = {
  address: string;
  args: unknown[];
  contract?: string;
};

type AddressBook = Record<string, Record<string, AddressBookEntry>>;

type ParsedArgs = Record<string, string | boolean>;

type AddressBookCheckReport = {
  issues?: unknown[];
};

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--help" || a === "-h") {
      args.help = true;
      continue;
    }

    if (!a.startsWith("--")) continue;

    const raw = a.slice(2);
    const eq = raw.indexOf("=");

    if (eq >= 0) {
      const key = raw.slice(0, eq);
      const value = raw.slice(eq + 1);
      args[key] = value.length > 0 ? value : true;
      continue;
    }

    const key = raw;
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }

  return args;
}

function usageAndExit(code = 0): never {
  console.log(`
Usage:
  npm run contracts:pipeline -- --network sepolia
  npm run contracts:pipeline -- --network mainnet
  npx tsx contracts/scripts/run_pipeline.ts --network sepolia

Optional:
  --from token|registry|gateway|handover|verify
  --to   token|registry|gateway|handover|verify
  --skip token,registry,...   (comma-separated)
  --noVerify                  (skip verify step)
  --noPreflight               (skip fail-fast checks)

Mainnet lock:
- If --network mainnet AND any tx-producing step is included (token/registry/gateway/handover),
  you MUST set: CONFIRM_MAINNET_DEPLOY=true
- If you run only verify, lock is not required.

Preflight checks (fail-fast):
- Handover included -> MULTISIG_ADDRESS must be set
- SET_SIGNERS=true -> REGISTRY_ALLOWED_SIGNERS must be non-empty
- Verify included -> Etherscan key policy check (env-based)
- Address book sanity is validated by calling: tools/check_address_book.ts
  (Just-in-time: before gateway/handover/verify where needed)

Etherscan key policy overrides:
- SKIP_ETHERSCAN_KEY_CHECK=true        -> skip key check
- PREFLIGHT_REQUIRE_ETHERSCAN_KEY=true -> fail if key not found (even on sepolia)

Notes:
- This runner shells out to: npx hardhat run <script> --network <network>
- It relies on your existing env vars used by deploy/verify/handover scripts.
`);
  process.exit(code);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function envBool(key: string, def = false): boolean {
  const v = (process.env[key] || "").trim().toLowerCase();
  if (!v) return def;
  return v === "true" || v === "1" || v === "yes" || v === "y";
}

function envStr(key: string): string | undefined {
  const v = (process.env[key] || "").trim();
  return v ? v : undefined;
}

function isWin(): boolean {
  return process.platform === "win32";
}

function npxCmd(): string {
  return isWin() ? "npx.cmd" : "npx";
}

function hardhatRun(networkName: string, scriptPath: string): void {
  const cmd = npxCmd();
  const args = ["hardhat", "run", scriptPath, "--network", networkName];

  console.log(`\n> ${cmd} ${args.join(" ")}`);

  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: false,
    env: process.env,
  });

  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`Command failed (exit ${res.status}): ${cmd} ${args.join(" ")}`);
  }
}

function normalizeStepKey(x: string): StepKey {
  const v = x.trim().toLowerCase();

  if (v === "token") return "token";
  if (v === "registry") return "registry";
  if (v === "gateway") return "gateway";
  if (v === "handover") return "handover";
  if (v === "verify") return "verify";

  throw new Error(`Unknown step: ${x}`);
}

function pickVerifyScript(networkName: string): string {
  const n = networkName.trim().toLowerCase();

  if (n === "sepolia") return "contracts/scripts/verify_sepolia.ts";
  if (n === "mainnet") return "contracts/scripts/verify_mainnet.ts";

  throw new Error(
    `No verify script mapping for network="${networkName}". Use --noVerify or add mapping.`
  );
}

function sliceSteps(all: Step[], from?: StepKey, to?: StepKey): Step[] {
  const idx = (k: StepKey) => all.findIndex((s) => s.key === k);

  const start = from ? idx(from) : 0;
  const end = to ? idx(to) : all.length - 1;

  if (start < 0) throw new Error(`--from step not found: ${from}`);
  if (end < 0) throw new Error(`--to step not found: ${to}`);
  if (start > end) throw new Error(`Invalid range: from=${from} is after to=${to}`);

  return all.slice(start, end + 1);
}

function isMainnetNetworkName(networkName: string): boolean {
  return networkName.trim().toLowerCase() === "mainnet";
}

function chainKeyFromNetworkName(networkName: string): string | undefined {
  const n = networkName.trim().toLowerCase();
  if (n === "mainnet") return "mainnet";
  if (n === "sepolia") return "sepolia";
  return undefined;
}

function enforceMainnetLockIfNeeded(networkName: string, plan: Step[]): void {
  if (!isMainnetNetworkName(networkName)) return;

  const hasTxStep = plan.some((s) => s.key !== "verify");
  if (!hasTxStep) return;

  const confirmed = envBool("CONFIRM_MAINNET_DEPLOY", false);
  if (!confirmed) {
    throw new Error(
      "MAINNET LOCK: --network mainnet ile tx üreten adımlar çalıştırmak için CONFIRM_MAINNET_DEPLOY=true set etmelisin."
    );
  }
}

function getAddressBookPath(): string {
  return envStr("ADDRESS_BOOK_PATH") || "tools/addresses.json";
}

function absPath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function readAddressBook(): AddressBook {
  const p = absPath(getAddressBookPath());

  if (!fs.existsSync(p)) {
    throw new Error(`Address book file not found: ${p}`);
  }

  return JSON.parse(fs.readFileSync(p, "utf8")) as AddressBook;
}

function isHexAddress(a: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(a);
}

function isZeroAddress(a: string): boolean {
  return /^0x0{40}$/.test(a.toLowerCase());
}

function getEntry(book: AddressBook, chainKey: string, name: string): AddressBookEntry | undefined {
  return book?.[chainKey]?.[name];
}

function runAddressBookCheck(chainKey: string, strict: boolean): void {
  const scriptRel = "tools/check_address_book.ts";
  const script = absPath(scriptRel);

  if (!fs.existsSync(script)) {
    throw new Error(`Missing file: ${scriptRel} (expected at ${script})`);
  }

  const cmd = npxCmd();
  const args = ["tsx", scriptRel, "--network", chainKey, "--json"];
  if (strict) args.push("--strict");

  const res = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: process.env,
    encoding: "utf8",
  });

  const out = (res.stdout || "").trim();
  const err = (res.stderr || "").trim();

  if (res.error) throw res.error;

  if (res.status !== 0) {
    let msg = `Address book sanity check failed (exit ${res.status}).`;
    if (out) msg += `\nstdout:\n${out}`;
    if (err) msg += `\nstderr:\n${err}`;
    throw new Error(msg);
  }

  try {
    const report = (out ? JSON.parse(out) : null) as AddressBookCheckReport | null;
    const issuesCount = Array.isArray(report?.issues) ? report.issues.length : undefined;

    console.log(
      `PRECHECK: address book OK (chain=${chainKey}, strict=${strict}, issues=${issuesCount ?? "?"})`
    );
  } catch {
    console.log(`PRECHECK: address book OK (chain=${chainKey}, strict=${strict})`);
    if (out) console.log(out);
  }
}

function detectEtherscanKey(): { found: boolean; keys: string[] } {
  const candidates = [
    "ETHERSCAN_API_KEY",
    "ETHERSCAN_KEY",
    "ETHERSCAN_TOKEN",
    "ETHERSCAN_API_KEY_SEPOLIA",
    "ETHERSCAN_API_KEY_MAINNET",
  ];

  const foundKeys = candidates.filter((k) => !!envStr(k));
  return { found: foundKeys.length > 0, keys: foundKeys };
}

function preflight(networkName: string, plan: Step[]): void {
  const noPreflightEnv = envBool("NO_PREFLIGHT", false);
  if (noPreflightEnv) return;

  const errors: string[] = [];
  const warns: string[] = [];

  const hasVerify = plan.some((s) => s.key === "verify");
  const hasGateway = plan.some((s) => s.key === "gateway");
  const hasHandover = plan.some((s) => s.key === "handover");

  if (hasHandover) {
    if (!envStr("MULTISIG_ADDRESS")) {
      errors.push("Missing env: MULTISIG_ADDRESS (required for handover step)");
    }

    const setSigners = envBool("SET_SIGNERS", false);
    if (setSigners && !envStr("REGISTRY_ALLOWED_SIGNERS")) {
      errors.push("SET_SIGNERS=true but REGISTRY_ALLOWED_SIGNERS is empty");
    }
  }

  const grushTokenEnvMissing = !envStr("GRUSH_TOKEN_ADDRESS");
  const tokenWillBeDeployedInThisRun = plan.some((s) => s.key === "token");

  if (hasGateway && grushTokenEnvMissing && !tokenWillBeDeployedInThisRun) {
    warns.push(
      "GRUSH_TOKEN_ADDRESS not set. Gateway step will require GRUSHToken in address book (will be checked before gateway)."
    );
  }

  if (hasVerify && !envBool("SKIP_ETHERSCAN_KEY_CHECK", false)) {
    const { found, keys } = detectEtherscanKey();
    const requireKey =
      envBool("PREFLIGHT_REQUIRE_ETHERSCAN_KEY", false) || isMainnetNetworkName(networkName);

    if (!found && requireKey) {
      errors.push(
        "Etherscan API key not detected in env (ETHERSCAN_API_KEY / ETHERSCAN_API_KEY_SEPOLIA / etc). " +
          "Set one, or set SKIP_ETHERSCAN_KEY_CHECK=true."
      );
    } else if (!found) {
      warns.push(
        "Etherscan API key not detected in env. Verify may still work if hardhat.config.ts contains a key; otherwise it will fail."
      );
    } else {
      console.log(`PRECHECK: Etherscan key detected in env: ${keys.join(", ")}`);
    }
  }

  if (warns.length > 0) {
    console.log("\nPRECHECK WARNINGS:");
    for (const w of warns) console.log(`- ${w}`);
  }

  if (errors.length > 0) {
    console.log("\nPRECHECK ERRORS:");
    for (const e of errors) console.log(`- ${e}`);
    throw new Error("Preflight failed. Fix errors above (or use --noPreflight / NO_PREFLIGHT=true).");
  }

  console.log("PRECHECK: OK");
}

function ensureTokenInAddressBook(chainKey: string): void {
  const book = readAddressBook();
  const token = getEntry(book, chainKey, "GRUSHToken");

  if (!token?.address) throw new Error(`${chainKey}.GRUSHToken missing in address book`);
  if (!isHexAddress(token.address)) {
    throw new Error(`${chainKey}.GRUSHToken.address invalid: ${token.address}`);
  }
  if (isZeroAddress(token.address)) {
    throw new Error(`${chainKey}.GRUSHToken.address is ZERO placeholder`);
  }
}

function ensureAtLeastOneContractInAddressBook(chainKey: string): void {
  const book = readAddressBook();
  const chain = book?.[chainKey];

  if (!chain) {
    throw new Error(`${chainKey} section missing in address book`);
  }

  const names = ["GRUSHToken", "ReserveRegistry", "RedemptionGateway"] as const;

  const present = names.reduce((count, name) => {
    const address = chain[name]?.address;
    const ok =
      typeof address === "string" && isHexAddress(address) && !isZeroAddress(address);
    return ok ? count + 1 : count;
  }, 0);

  if (present === 0) {
    throw new Error(
      `Address book "${chainKey}" has no non-zero contract addresses (handover step would do nothing).`
    );
  }
}

function buildSteps(networkName: string, includeVerify: boolean): Step[] {
  const steps: Step[] = [
    {
      key: "token",
      label: "Deploy GRUSHToken",
      script: "contracts/deploy/00_deploy_grush_token.ts",
    },
    {
      key: "registry",
      label: "Deploy ReserveRegistry",
      script: "contracts/deploy/01_deploy_reserve_registry.ts",
    },
    {
      key: "gateway",
      label: "Deploy RedemptionGateway",
      script: "contracts/deploy/02_deploy_redemption_gateway.ts",
    },
    {
      key: "handover",
      label: "Post-deploy handover (roles)",
      script: "contracts/deploy/99_post_deploy_handover.ts",
    },
  ];

  if (includeVerify) {
    steps.push({
      key: "verify",
      label: "Verify contracts",
      script: pickVerifyScript(networkName),
    });
  }

  return steps;
}

function main(): void {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const networkName = typeof args.network === "string" ? args.network : "";
  if (!networkName) usageAndExit(1);

  const noVerify = args.noVerify === true;
  const noPreflight = args.noPreflight === true;

  const from =
    typeof args.from === "string" ? normalizeStepKey(args.from) : undefined;
  const to =
    typeof args.to === "string" ? normalizeStepKey(args.to) : undefined;

  const skipRaw = typeof args.skip === "string" ? args.skip : "";
  const skip = new Set<StepKey>(
    skipRaw ? skipRaw.split(",").map((s) => normalizeStepKey(s)) : []
  );

  const steps = buildSteps(networkName, !noVerify);
  const finalPlan = sliceSteps(steps, from, to).filter((s) => !skip.has(s.key));

  enforceMainnetLockIfNeeded(networkName, finalPlan);

  const chainKey = chainKeyFromNetworkName(networkName);

  if (!noPreflight) {
    preflight(networkName, finalPlan);
  }

  console.log(
    JSON.stringify(
      {
        action: "run_pipeline",
        network: networkName,
        chainKey: chainKey ?? null,
        from: from ?? null,
        to: to ?? null,
        skip: Array.from(skip),
        noVerify,
        noPreflight,
        addressBookPath: getAddressBookPath(),
        confirmMainnetDeploy: isMainnetNetworkName(networkName)
          ? envBool("CONFIRM_MAINNET_DEPLOY", false)
          : null,
        steps: finalPlan.map((s) => ({
          key: s.key,
          label: s.label,
          script: s.script,
        })),
        cwd: process.cwd(),
      },
      null,
      2
    )
  );

  for (const step of finalPlan) {
    if (!noPreflight && chainKey) {
      if (step.key === "gateway") {
        if (!envStr("GRUSH_TOKEN_ADDRESS")) {
          runAddressBookCheck(chainKey, false);
          ensureTokenInAddressBook(chainKey);
        }
      }

      if (step.key === "handover") {
        runAddressBookCheck(chainKey, false);
        ensureAtLeastOneContractInAddressBook(chainKey);
      }

      if (step.key === "verify") {
        runAddressBookCheck(chainKey, true);
      }
    }

    console.log(`\n=== STEP: ${step.key} :: ${step.label} ===`);
    const scriptPath = step.script.split("/").join(path.sep);
    hardhatRun(networkName, scriptPath);
  }

  console.log("\n✅ Pipeline finished.");
}

try {
  main();
} catch (err: unknown) {
  console.error("\n❌ Pipeline failed:", errorMessage(err));
  process.exit(1);
}