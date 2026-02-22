/* eslint-disable no-console */
import fs from "fs";
import path from "path";

type ContractEntry = {
  address: string;
  args: any[];
  contract?: string;
};

type AddressBook = Record<string, Record<string, ContractEntry>>;

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

function usageAndExit(code = 0): never {
  console.log(`
Usage:
  ts-node tools/check_address_book.ts
  ts-node tools/check_address_book.ts --network sepolia
  ts-node tools/check_address_book.ts --network mainnet --strict
  ts-node tools/check_address_book.ts --json

Env:
  ADDRESS_BOOK_PATH=tools/addresses.json (default)

Options:
  --network sepolia|mainnet   Check only one chain section
  --strict                   Require GRUSHToken + ReserveRegistry + RedemptionGateway to exist
  --json                     Output only JSON
  --help                     Show this help

Exit codes:
  0 = OK
  1 = Issues found (or missing file/parse error)
`);
  process.exit(code);
}

function getBookPath(): string {
  return (process.env.ADDRESS_BOOK_PATH || "tools/addresses.json").trim();
}

function readJsonFile(p: string): any {
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  if (!fs.existsSync(abs)) throw new Error(`Address book file not found: ${abs}`);
  const raw = fs.readFileSync(abs, "utf8");
  return JSON.parse(raw);
}

function isHexStrict(s: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(s);
}

function isHexAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

function isZeroAddress(s: string): boolean {
  return s.trim().toLowerCase() === "0x0000000000000000000000000000000000000000";
}

function validateEntry(chainKey: string, name: string, entry: ContractEntry, issues: string[]) {
  const label = `${chainKey}.${name}`;

  if (!entry) {
    issues.push(`${label} missing`);
    return;
  }

  if (!entry.address || typeof entry.address !== "string") {
    issues.push(`${label}.address missing or not a string`);
  } else {
    const a = entry.address.trim();
    if (!isHexAddress(a)) issues.push(`${label}.address invalid: ${a}`);
    else if (isZeroAddress(a)) issues.push(`${label}.address is ZERO placeholder`);
  }

  if (!Array.isArray(entry.args)) {
    issues.push(`${label}.args missing or not an array`);
  } else {
    for (let i = 0; i < entry.args.length; i++) {
      const v = entry.args[i];
      if (typeof v === "string") {
        const s = v.trim();

        // Catch non-hex placeholders like 0xADMIN, 0xPUBLISHER, 0xGRUSH_TOKEN_ADDRESS
        if (s.startsWith("0x") && !isHexStrict(s)) {
          issues.push(`${label}.args[${i}] looks like placeholder/non-hex: "${s}"`);
          continue;
        }

        if (s.startsWith("0x")) {
          // If it looks like address length, enforce address rules
          if (s.length === 42) {
            if (!isHexAddress(s)) issues.push(`${label}.args[${i}] invalid address: "${s}"`);
            else if (isZeroAddress(s)) issues.push(`${label}.args[${i}] is ZERO address placeholder`);
          } else if (s.length === 66) {
            // bytes32 ok (already hex-checked if startsWith 0x)
          } else {
            // Any other hex length is suspicious for constructor args in our project
            issues.push(`${label}.args[${i}] invalid 0x length (${s.length}): "${s}"`);
          }
        }
      }
    }
  }

  if (entry.contract !== undefined && typeof entry.contract !== "string") {
    issues.push(`${label}.contract must be a string if present`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const onlyJson = Boolean(args.json);
  const strict = Boolean(args.strict);
  const networkFilter = args.network ? String(args.network).trim().toLowerCase() : undefined;

  if (networkFilter && networkFilter !== "sepolia" && networkFilter !== "mainnet") {
    throw new Error(`--network must be sepolia|mainnet (got "${networkFilter}")`);
  }

  const bookPath = getBookPath();
  const book = readJsonFile(bookPath) as AddressBook;

  const chainKeys = networkFilter ? [networkFilter] : Object.keys(book);

  const issues: string[] = [];
  const checked: any[] = [];

  for (const chainKey of chainKeys) {
    const chain = book[chainKey];
    if (!chain) {
      issues.push(`${chainKey} section missing in address book`);
      continue;
    }

    const must = ["GRUSHToken", "ReserveRegistry", "RedemptionGateway"] as const;

    if (strict) {
      for (const c of must) {
        if (!chain[c]) issues.push(`${chainKey}.${c} missing (strict mode)`);
      }
    }

    for (const [name, entry] of Object.entries(chain)) {
      validateEntry(chainKey, name, entry as ContractEntry, issues);
    }

    checked.push({
      chainKey,
      contracts: Object.keys(chain),
      strictRequired: strict ? must : [],
    });
  }

  const result = {
    ok: issues.length === 0,
    addressBookPath: bookPath,
    networkFilter: networkFilter ?? null,
    strict,
    checked,
    issues,
  };

  if (onlyJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify({ ...result, issuesCount: issues.length }, null, 2));
    if (issues.length > 0) {
      console.log("\nIssues:");
      for (const i of issues) console.log(`- ${i}`);
    }
  }

  process.exit(result.ok ? 0 : 1);
}

main().catch((e: any) => {
  const msg = e?.message ?? String(e);
  console.error(JSON.stringify({ ok: false, error: msg }, null, 2));
  process.exit(1);
});
