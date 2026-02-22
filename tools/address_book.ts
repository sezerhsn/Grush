/* eslint-disable no-console */
import fs from "fs";
import path from "path";
import { ethers } from "hardhat";

export type ContractEntry = {
  address: string;
  args: any[];
  contract?: string; // optional fully qualified name
};

export type AddressBook = Record<string, Record<string, ContractEntry>>;

export function resolveChainKey(chainId: number): string {
  if (chainId === 1) return "mainnet";
  if (chainId === 11155111) return "sepolia";
  return String(chainId);
}

export function getBookPath(): string {
  return process.env.ADDRESS_BOOK_PATH || "tools/addresses.json";
}

export function loadAddressBook(bookPath = getBookPath()): AddressBook {
  const abs = path.isAbsolute(bookPath) ? bookPath : path.join(process.cwd(), bookPath);
  if (!fs.existsSync(abs)) {
    // initialize minimal structure
    return { sepolia: {}, mainnet: {} };
  }
  return JSON.parse(fs.readFileSync(abs, "utf8")) as AddressBook;
}

export function saveAddressBook(book: AddressBook, bookPath = getBookPath()): void {
  const abs = path.isAbsolute(bookPath) ? bookPath : path.join(process.cwd(), bookPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(book, null, 2), "utf8");
}

export function normAddress(a: string, label: string): string {
  if (!ethers.isAddress(a)) throw new Error(`${label} invalid address: ${a}`);
  return ethers.getAddress(a);
}

export function upsertContract(
  book: AddressBook,
  chainKey: string,
  name: string,
  entry: ContractEntry
): AddressBook {
  if (!book[chainKey]) book[chainKey] = {};
  book[chainKey][name] = entry;
  return book;
}

export function getContract(book: AddressBook, chainKey: string, name: string): ContractEntry | undefined {
  return book?.[chainKey]?.[name];
}
