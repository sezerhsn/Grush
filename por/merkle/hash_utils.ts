/* eslint-disable @typescript-eslint/no-explicit-any */
import * as ethers from "ethers";

/**
 * Ethers v5/v6 uyum katmanı (best-effort).
 */
const keccak256Fn: (data: any) => string =
  (ethers as any).keccak256 ?? (ethers as any).utils?.keccak256;

const toUtf8BytesFn: (s: string) => Uint8Array =
  (ethers as any).toUtf8Bytes ?? (ethers as any).utils?.toUtf8Bytes;

const getBytesFn: (data: any) => Uint8Array =
  (ethers as any).getBytes ?? (ethers as any).utils?.arrayify;

const hexlifyFn: (data: any) => string =
  (ethers as any).hexlify ?? (ethers as any).utils?.hexlify;

if (!keccak256Fn || !toUtf8BytesFn || !getBytesFn || !hexlifyFn) {
  throw new Error(
    "ethers keccak256/toUtf8Bytes/getBytes/hexlify bulunamadı. ethers v5 veya v6 kurulu olmalı."
  );
}

export function isHexString(value: string): boolean {
  return /^0x[0-9a-fA-F]*$/.test(value);
}

export function isBytes32Hex(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function assertBytes32Hex(value: string, name: string): void {
  if (!isBytes32Hex(value)) throw new Error(`${name} bytes32 hex değil: ${value}`);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!isHexString(hex)) throw new Error(`Hex string değil: ${hex}`);
  return getBytesFn(hex);
}

export function utf8Bytes(s: string): Uint8Array {
  return toUtf8BytesFn(s);
}

export function keccak256Hex(data: Uint8Array): string {
  return keccak256Fn(data);
}

/**
 * report_id string'ini EIP-712 bytes32 reportId'ye map eder.
 * - Eğer report_id zaten bytes32 hex ise aynen kullanılır.
 * - Değilse: keccak256(utf8(report_id))
 */
export function reportIdToBytes32(report_id: string): string {
  if (isBytes32Hex(report_id)) return report_id;
  return keccak256Fn(utf8Bytes(report_id));
}

/**
 * Canonical JSON: key order sabit, whitespace yok.
 * JSON.stringify insertion order'a saygı duyduğu için objeyi doğru sırayla kuruyoruz.
 */
export type LeafInput = {
  as_of_timestamp: number;
  fineness: string; // "999.9"
  fine_weight_g: number; // integer
  refiner: string;
  serial_no: string;
  vault_id: string;
};

export function canonicalLeafJsonString(leaf: LeafInput): string {
  // Key order: ["as_of_timestamp","fineness","fine_weight_g","refiner","serial_no","vault_id"]
  const obj: any = {};
  obj.as_of_timestamp = leaf.as_of_timestamp;
  obj.fineness = leaf.fineness;
  obj.fine_weight_g = leaf.fine_weight_g;
  obj.refiner = leaf.refiner;
  obj.serial_no = leaf.serial_no;
  obj.vault_id = leaf.vault_id;

  return JSON.stringify(obj);
}

/**
 * Leaf hash: keccak256(0x00 || utf8(canonical_json))
 */
export function leafHash(leaf: LeafInput): string {
  const prefix = new Uint8Array([0x00]);
  const preimage = utf8Bytes(canonicalLeafJsonString(leaf));
  return keccak256Fn(concatBytes(prefix, preimage));
}

/**
 * Node hash: keccak256(0x01 || left || right)
 */
export function nodeHash(leftBytes32: string, rightBytes32: string): string {
  assertBytes32Hex(leftBytes32, "left");
  assertBytes32Hex(rightBytes32, "right");
  const prefix = new Uint8Array([0x01]);
  const left = hexToBytes(leftBytes32);
  const right = hexToBytes(rightBytes32);
  return keccak256Fn(concatBytes(prefix, left, right));
}

export function fileKeccak256Hex(fileBytes: Uint8Array): string {
  return keccak256Fn(fileBytes);
}

export function normalizeAddress(addr: string): string {
  // v5: getAddress utils; v6: getAddress top-level
  const getAddress =
    (ethers as any).getAddress ?? (ethers as any).utils?.getAddress;
  if (!getAddress) throw new Error("ethers getAddress bulunamadı.");
  return getAddress(addr);
}

export function hexlifyBytes(data: Uint8Array): string {
  return hexlifyFn(data);
}
