/* eslint-disable no-console */
import fs from "fs";
import path from "path";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
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

function usageAndExit(code = 0): never {
  console.log(`
Usage:
  ts-node tools/env_guard.ts
  ts-node tools/env_guard.ts --task deploy --network sepolia
  ts-node tools/env_guard.ts --task handover --network mainnet
  ts-node tools/env_guard.ts --task invariants --network sepolia
  ts-node tools/env_guard.ts --json

Tasks:
  deploy       Deploy scriptleri için env kontrolleri (00/01/02)
  handover     99_post_deploy_handover için env kontrolleri
  invariants   tools/check_invariants.ts için env kontrolleri

Network:
  --network sepolia|mainnet|localhost|hardhat
  Env fallback: HARDHAT_NETWORK / NETWORK

Common env:
  ADDRESS_BOOK_PATH (default: tools/addresses.json)
  VERIFY=true|false

RPC env (seçim):
  sepolia: SEPOLIA_RPC_URL or RPC_URL
  mainnet: MAINNET_RPC_URL or RPC_URL

Key env (deploy için, public networklerde):
  DEPLOYER_PRIVATE_KEY or PRIVATE_KEY

Mainnet lock:
  CONFIRM_MAINNET_DEPLOY=true olmadan mainnet task=deploy/handover geçmez.

Handover env:
  MULTISIG_ADDRESS (required)
  TIMELOCK_ADDRESS (optional)

Invariants env:
  RPC_URL (or SEPOLIA_RPC_URL/MAINNET_RPC_URL)
  GRUSH_TOKEN_ADDRESS
  RESERVE_REGISTRY_ADDRESS

Exit codes:
  0 = OK
  1 = FAIL
`);
  process.exit(code);
}

function envStr(key: string): string {
  return (process.env[key] || "").trim();
}

function envBool(key: string, def = false): boolean {
  const v = envStr(key).toLowerCase();
  if (!v) return def;
  return v === "true" || v === "1" || v === "yes" || v === "y";
}

function isHexStrict(s: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(s);
}

function isHexAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

function isZeroAddress(s: string): boolean {
  return s.toLowerCase() === "0x0000000000000000000000000000000000000000";
}

function looksLikePlaceholderHex(s: string): boolean {
  // 0xADMIN, 0xPUBLISHER, 0xGRUSH_TOKEN_ADDRESS gibi
  return s.startsWith("0x") && !isHexStrict(s);
}

function requireNonEmpty(key: string, errors: string[]) {
  if (!envStr(key)) errors.push(`Missing env: ${key}`);
}

function requireAddress(key: string, errors: string[]) {
  const v = envStr(key);
  if (!v) {
    errors.push(`Missing env: ${key}`);
    return;
  }
  if (looksLikePlaceholderHex(v)) {
    errors.push(`Env ${key} looks like placeholder/non-hex: "${v}"`);
    return;
  }
  if (!isHexAddress(v)) {
    errors.push(`Env ${key} invalid address: "${v}"`);
    return;
  }
  if (isZeroAddress(v)) {
    errors.push(`Env ${key} is ZERO address: "${v}"`);
  }
}

function requireRpcFor(network: string, errors: string[]): { rpcKeyUsed: string | null; rpcValue: string | null } {
  const n = network.toLowerCase();
  let rpcKey = "RPC_URL";
  let rpc = envStr("RPC_URL");

  if (n === "sepolia") {
    if (envStr("SEPOLIA_RPC_URL")) {
      rpcKey = "SEPOLIA_RPC_URL";
      rpc = envStr("SEPOLIA_RPC_URL");
    }
  } else if (n === "mainnet") {
    if (envStr("MAINNET_RPC_URL")) {
      rpcKey = "MAINNET_RPC_URL";
      rpc = envStr("MAINNET_RPC_URL");
    }
  }

  if (!rpc) {
    errors.push(`Missing RPC for network=${n}: set ${rpcKey} (or RPC_URL)`);
    return { rpcKeyUsed: rpcKey, rpcValue: null };
  }

  const ok =
    rpc.startsWith("http://") ||
    rpc.startsWith("https://") ||
    rpc.startsWith("ws://") ||
    rpc.startsWith("wss://");

  if (!ok) errors.push(`RPC URL does not look valid (${rpcKey}): "${rpc}"`);

  if (/your[_-]?rpc|infura_key|alchemy_key|api_key/i.test(rpc)) {
    errors.push(`RPC URL looks like placeholder (${rpcKey}): "${rpc}"`);
  }

  return { rpcKeyUsed: rpcKey, rpcValue: rpc };
}

function getNetwork(args: Args): string {
  const a = (args.network ? String(args.network) : "").trim();
  const e = envStr("HARDHAT_NETWORK") || envStr("NETWORK");
  const n = (a || e || "hardhat").toLowerCase();
  return n;
}

function getTask(args: Args): string {
  const t = (args.task ? String(args.task) : "").trim().toLowerCase();
  return t || "deploy";
}

function isLocalNet(n: string): boolean {
  const x = n.toLowerCase();
  return x === "hardhat" || x === "localhost";
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const task = getTask(args);
  const network = getNetwork(args);
  const onlyJson = Boolean(args.json);

  const errors: string[] = [];
  const warnings: string[] = [];

  if (!["deploy", "handover", "invariants"].includes(task)) {
    errors.push(`Unknown --task: ${task}`);
  }

  if (!["sepolia", "mainnet", "hardhat", "localhost"].includes(network)) {
    warnings.push(`Unknown --network: ${network} (guard will treat as non-local)`);
  }

  // Mainnet lock
  if (network === "mainnet" && (task === "deploy" || task === "handover")) {
    const ok = envBool("CONFIRM_MAINNET_DEPLOY", false);
    if (!ok) errors.push("MAINNET LOCK: set CONFIRM_MAINNET_DEPLOY=true to proceed.");
  }

  // Address book sanity (fail only if file exists but broken)
  const bookPath = envStr("ADDRESS_BOOK_PATH") || "tools/addresses.json";
  const absBookPath = path.isAbsolute(bookPath) ? bookPath : path.join(process.cwd(), bookPath);
  if (fs.existsSync(absBookPath)) {
    try {
      JSON.parse(fs.readFileSync(absBookPath, "utf8"));
    } catch {
      errors.push(`ADDRESS_BOOK_PATH JSON parse failed: ${absBookPath}`);
    }
  } else {
    warnings.push(`Address book file not found yet (ok): ${absBookPath}`);
  }

  const local = isLocalNet(network);

  // VERIFY guard
  const verify = envBool("VERIFY", false);
  if (verify && !local) {
    const keys = [
      "ETHERSCAN_API_KEY",
      network === "sepolia" ? "ETHERSCAN_API_KEY_SEPOLIA" : "",
      network === "mainnet" ? "ETHERSCAN_API_KEY_MAINNET" : "",
      network === "sepolia" ? "SEPOLIA_ETHERSCAN_API_KEY" : "",
      network === "mainnet" ? "MAINNET_ETHERSCAN_API_KEY" : "",
    ].filter(Boolean);

    const hasAny = keys.some((k) => envStr(k));
    if (!hasAny) warnings.push(`VERIFY=true but no Etherscan key found (checked: ${keys.join(", ")})`);
  }

  if (task === "deploy" || task === "handover" || task === "invariants") {
    if (!local) {
      requireRpcFor(network, errors);
    }
  }

  if (task === "deploy") {
    if (!local) {
      const pk = envStr("DEPLOYER_PRIVATE_KEY") || envStr("PRIVATE_KEY");
      if (!pk) errors.push("Missing deployer key: set DEPLOYER_PRIVATE_KEY or PRIVATE_KEY");
      else {
        const p = pk.startsWith("0x") ? pk : `0x${pk}`;
        if (!/^0x[0-9a-fA-F]{64}$/.test(p)) warnings.push("Deployer private key does not look like 32-byte hex.");
      }
    }

    // Optional address envs: if set, validate strictly (avoid 0xADMIN placeholders)
    const maybeAddrKeys = [
      "TOKEN_ADMIN",
      "TOKEN_MINTER",
      "TOKEN_BURNER",
      "TOKEN_PAUSER",
      "REGISTRY_ADMIN",
      "REGISTRY_PUBLISHER",
      "REGISTRY_PAUSER",
      "GATEWAY_ADMIN",
      "GATEWAY_OPERATOR",
      "GATEWAY_PAUSER",
      "GRUSH_TOKEN_ADDRESS",
    ];

    for (const k of maybeAddrKeys) {
      const v = envStr(k);
      if (!v) continue;
      if (looksLikePlaceholderHex(v)) {
        errors.push(`Env ${k} placeholder/non-hex: "${v}"`);
        continue;
      }
      if (!isHexAddress(v)) errors.push(`Env ${k} invalid address: "${v}"`);
      else if (isZeroAddress(v)) warnings.push(`Env ${k} is ZERO address (suspicious): "${v}"`);
    }
  }

  if (task === "handover") {
    requireAddress("MULTISIG_ADDRESS", errors);
    const tl = envStr("TIMELOCK_ADDRESS");
    if (tl) {
      if (looksLikePlaceholderHex(tl)) errors.push(`Env TIMELOCK_ADDRESS placeholder/non-hex: "${tl}"`);
      else if (!isHexAddress(tl)) errors.push(`Env TIMELOCK_ADDRESS invalid address: "${tl}"`);
      else if (isZeroAddress(tl)) warnings.push("Env TIMELOCK_ADDRESS is ZERO address (suspicious).");
    }
  }

  if (task === "invariants") {
    // Prefer RPC_URL but accept network-specific as well
    const { rpcValue } = requireRpcFor(network, errors);
    if (!rpcValue && !local) {
      // already errored
    }
    requireAddress("GRUSH_TOKEN_ADDRESS", errors);
    requireAddress("RESERVE_REGISTRY_ADDRESS", errors);
  }

  const ok = errors.length === 0;

  const out = {
    ok,
    task,
    network,
    local,
    addressBookPath: bookPath,
    verify,
    errors,
    warnings,
  };

  if (onlyJson) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(JSON.stringify({ ...out, errorsCount: errors.length, warningsCount: warnings.length }, null, 2));
    if (warnings.length) {
      console.log("\nWarnings:");
      for (const w of warnings) console.log(`- ${w}`);
    }
    if (errors.length) {
      console.log("\nErrors:");
      for (const e of errors) console.log(`- ${e}`);
    }
  }

  process.exit(ok ? 0 : 1);
}

main();
