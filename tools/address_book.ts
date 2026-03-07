/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

export type ContractEntry = {
  address: string;
  args: unknown[];
  contract?: string;
};

export type AddressBook = Record<string, Record<string, ContractEntry>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absBookPath(bookPath = getBookPath()): string {
  return path.isAbsolute(bookPath) ? bookPath : path.join(process.cwd(), bookPath);
}

function isZeroAddress(value: string): boolean {
  return value.trim().toLowerCase() === "0x0000000000000000000000000000000000000000";
}

function normalizeArgs(args: unknown, label: string): unknown[] {
  if (!Array.isArray(args)) {
    throw new Error(`${label}.args must be an array`);
  }
  return [...args];
}

function normalizeContractEntry(label: string, entryRaw: unknown): ContractEntry {
  if (!isPlainObject(entryRaw)) {
    throw new Error(`${label} must be an object`);
  }

  const addressRaw = entryRaw.address;
  if (typeof addressRaw !== "string" || addressRaw.trim().length === 0) {
    throw new Error(`${label}.address missing or not a string`);
  }

  const address = normAddress(addressRaw, `${label}.address`);
  const args = normalizeArgs(entryRaw.args, label);

  const contractRaw = entryRaw.contract;
  let contract: string | undefined;

  if (contractRaw !== undefined) {
    if (typeof contractRaw !== "string" || contractRaw.trim().length === 0) {
      throw new Error(`${label}.contract must be a non-empty string if present`);
    }
    contract = contractRaw.trim();
  }

  return contract ? { address, args, contract } : { address, args };
}

function normalizeAddressBook(bookRaw: unknown): AddressBook {
  if (!isPlainObject(bookRaw)) {
    throw new Error("Address book root must be an object");
  }

  const out: AddressBook = {
    sepolia: {},
    mainnet: {},
  };

  for (const [chainKey, chainRaw] of Object.entries(bookRaw)) {
    if (!isPlainObject(chainRaw)) {
      throw new Error(`${chainKey} section must be an object`);
    }

    const chain: Record<string, ContractEntry> = {};
    for (const [name, entryRaw] of Object.entries(chainRaw)) {
      chain[name] = normalizeContractEntry(`${chainKey}.${name}`, entryRaw);
    }

    out[chainKey] = chain;
  }

  if (!out.sepolia) out.sepolia = {};
  if (!out.mainnet) out.mainnet = {};

  return out;
}

export function resolveChainKey(chainId: number): string {
  if (chainId === 1) return "mainnet";
  if (chainId === 11155111) return "sepolia";
  return String(chainId);
}

export function getBookPath(): string {
  const v = (process.env.ADDRESS_BOOK_PATH || "tools/addresses.json").trim();
  return v || "tools/addresses.json";
}

export function loadAddressBook(bookPath = getBookPath()): AddressBook {
  const abs = absBookPath(bookPath);

  if (!fs.existsSync(abs)) {
    return { sepolia: {}, mainnet: {} };
  }

  const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as unknown;
  return normalizeAddressBook(raw);
}

export function saveAddressBook(book: AddressBook, bookPath = getBookPath()): void {
  const abs = absBookPath(bookPath);
  const normalized = normalizeAddressBook(book);

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export function normAddress(a: string, label: string): string {
  const v = a.trim();

  if (!ethers.isAddress(v)) {
    throw new Error(`${label} invalid address: ${a}`);
  }

  const checksummed = ethers.getAddress(v);

  if (isZeroAddress(checksummed)) {
    throw new Error(`${label} is ZERO address`);
  }

  return checksummed;
}

export function upsertContract(
  book: AddressBook,
  chainKey: string,
  name: string,
  entry: ContractEntry
): AddressBook {
  if (!book[chainKey]) {
    book[chainKey] = {};
  }

  book[chainKey][name] = normalizeContractEntry(`${chainKey}.${name}`, entry);
  return book;
}

export function getContract(
  book: AddressBook,
  chainKey: string,
  name: string
): ContractEntry | undefined {
  const entry = book?.[chainKey]?.[name];
  if (entry === undefined) return undefined;
  return normalizeContractEntry(`${chainKey}.${name}`, entry);
}