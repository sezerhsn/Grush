/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";

type ContractEntry = {
  address: string;
  args: unknown[];
  contract?: string;
};

type AddressBook = Record<string, Record<string, ContractEntry>>;

type ParsedArgs = Record<string, string | boolean>;

type CheckedChain = {
  chainKey: string;
  contracts: string[];
  strictRequired: readonly string[];
};

type CheckResult = {
  ok: boolean;
  addressBookPath: string;
  networkFilter: string | null;
  strict: boolean;
  checked: CheckedChain[];
  issues: string[];
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
  npx tsx tools/check_address_book.ts
  npx tsx tools/check_address_book.ts --network sepolia
  npx tsx tools/check_address_book.ts --network mainnet --strict
  npx tsx tools/check_address_book.ts --json

Env:
  ADDRESS_BOOK_PATH=tools/addresses.json (default)

Options:
  --network sepolia|mainnet   Check only one chain section
  --strict                    Require GRUSHToken + ReserveRegistry + RedemptionGateway to exist
  --json                      Output only JSON
  --help                      Show this help

Exit codes:
  0 = OK
  1 = Issues found (or missing file/parse error)
`);
  process.exit(code);
}

function getBookPath(): string {
  const v = (process.env.ADDRESS_BOOK_PATH || "tools/addresses.json").trim();
  return v || "tools/addresses.json";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile<T>(filePath: string): T {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

  if (!fs.existsSync(abs)) {
    throw new Error(`Address book file not found: ${abs}`);
  }

  const raw = fs.readFileSync(abs, "utf8");
  return JSON.parse(raw) as T;
}

function isHexStrict(value: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(value);
}

function isHexAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isZeroAddress(value: string): boolean {
  return value.trim().toLowerCase() === "0x0000000000000000000000000000000000000000";
}

function validateEntry(
  chainKey: string,
  name: string,
  entryRaw: unknown,
  issues: string[]
): void {
  const label = `${chainKey}.${name}`;

  if (!isPlainObject(entryRaw)) {
    issues.push(`${label} must be an object`);
    return;
  }

  const entry = entryRaw as Partial<ContractEntry>;

  if (typeof entry.address !== "string" || entry.address.trim().length === 0) {
    issues.push(`${label}.address missing or not a string`);
  } else {
    const a = entry.address.trim();
    if (!isHexAddress(a)) {
      issues.push(`${label}.address invalid: ${a}`);
    } else if (isZeroAddress(a)) {
      issues.push(`${label}.address is ZERO placeholder`);
    }
  }

  if (!Array.isArray(entry.args)) {
    issues.push(`${label}.args missing or not an array`);
  } else {
    for (let i = 0; i < entry.args.length; i++) {
      const value = entry.args[i];

      if (typeof value !== "string") {
        continue;
      }

      const s = value.trim();

      if (!s.startsWith("0x")) {
        continue;
      }

      if (!isHexStrict(s)) {
        issues.push(`${label}.args[${i}] looks like placeholder/non-hex: "${s}"`);
        continue;
      }

      if (s.length === 42) {
        if (!isHexAddress(s)) {
          issues.push(`${label}.args[${i}] invalid address: "${s}"`);
        } else if (isZeroAddress(s)) {
          issues.push(`${label}.args[${i}] is ZERO address placeholder`);
        }
        continue;
      }

      if (s.length === 66) {
        continue;
      }

      issues.push(`${label}.args[${i}] invalid 0x length (${s.length}): "${s}"`);
    }
  }

  if (entry.contract !== undefined && typeof entry.contract !== "string") {
    issues.push(`${label}.contract must be a string if present`);
  }
}

function main(): void {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const onlyJson = args.json === true;
  const strict = args.strict === true;
  const networkFilter =
    typeof args.network === "string" ? args.network.trim().toLowerCase() : undefined;

  if (networkFilter && networkFilter !== "sepolia" && networkFilter !== "mainnet") {
    throw new Error(`--network must be sepolia|mainnet (got "${networkFilter}")`);
  }

  const bookPath = getBookPath();
  const book = readJsonFile<AddressBook>(bookPath);

  if (!isPlainObject(book)) {
    throw new Error(`Address book root must be an object. Path=${bookPath}`);
  }

  const chainKeys = networkFilter ? [networkFilter] : Object.keys(book).sort();
  const requiredContracts = ["GRUSHToken", "ReserveRegistry", "RedemptionGateway"] as const;

  const issues: string[] = [];
  const checked: CheckedChain[] = [];

  for (const chainKey of chainKeys) {
    const chainRaw = book[chainKey];

    if (!isPlainObject(chainRaw)) {
      issues.push(`${chainKey} section missing in address book`);
      continue;
    }

    const chain = chainRaw as Record<string, unknown>;

    if (strict) {
      for (const contractName of requiredContracts) {
        if (!(contractName in chain)) {
          issues.push(`${chainKey}.${contractName} missing (strict mode)`);
        }
      }
    }

    const contractNames = Object.keys(chain).sort();

    for (const contractName of contractNames) {
      validateEntry(chainKey, contractName, chain[contractName], issues);
    }

    checked.push({
      chainKey,
      contracts: contractNames,
      strictRequired: strict ? requiredContracts : [],
    });
  }

  const result: CheckResult = {
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
    console.log(
      JSON.stringify(
        {
          ...result,
          issuesCount: issues.length,
        },
        null,
        2
      )
    );

    if (issues.length > 0) {
      console.log("\nIssues:");
      for (const issue of issues) {
        console.log(`- ${issue}`);
      }
    }
  }

  process.exit(result.ok ? 0 : 1);
}

try {
  main();
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ ok: false, error: msg }, null, 2));
  process.exit(1);
}