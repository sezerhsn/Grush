import { getAddress, getBytes, hexlify, keccak256, toUtf8Bytes } from "ethers";

const SAFE_JSON_INTEGER_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const HEX_BYTES_REGEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const BYTES32_REGEX = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_UINT_REGEX = /^(0|[1-9][0-9]*)$/;
const FINENESS_REGEX = /^(0|[1-9][0-9]*)\.[0-9]+$/;

export type JsonUint = number | string | bigint;

/**
 * v0.1 leaf canonicalization notu:
 * - as_of_timestamp ve fine_weight_g canonical JSON içinde number olarak yazılır.
 * - Bu yüzden bu iki alan silent precision loss yaşamaması için
 *   Number.MAX_SAFE_INTEGER sınırında zorunlu olarak tutulur.
 * - Daha büyük integer'lar leaf preimage içine sokulmaz; üst katmanlarda
 *   decimal string / bigint olarak taşınmalıdır.
 */
export type LeafInput = {
  as_of_timestamp: JsonUint;
  fineness: string;
  fine_weight_g: JsonUint;
  refiner: string;
  serial_no: string;
  vault_id: string;
};

type NormalizedLeafInput = {
  as_of_timestamp: number;
  fineness: string;
  fine_weight_g: number;
  refiner: string;
  serial_no: string;
  vault_id: string;
};

function requireNonEmptyString(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} non-empty string olmalı.`);
  }
  return value;
}

export function isHexString(value: string): boolean {
  return typeof value === "string" && HEX_BYTES_REGEX.test(value);
}

export function isBytes32Hex(value: string): boolean {
  return typeof value === "string" && BYTES32_REGEX.test(value);
}

export function assertBytes32Hex(value: string, name: string): void {
  if (!isBytes32Hex(value)) {
    throw new Error(`${name} bytes32 hex değil: ${value}`);
  }
}

export function toUintBigInt(value: JsonUint, name: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new Error(`${name} negatif olamaz. Aldım: ${value.toString()}`);
    }
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${name} integer olmalı. Aldım: ${String(value)}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `${name} MAX_SAFE_INTEGER üstünde. Decimal string kullan. Aldım: ${String(value)}`
      );
    }
    if (value < 0) {
      throw new Error(`${name} negatif olamaz. Aldım: ${String(value)}`);
    }
    return BigInt(value);
  }

  if (typeof value === "string") {
    if (!DECIMAL_UINT_REGEX.test(value)) {
      throw new Error(`${name} decimal uint string olmalı. Aldım: ${value}`);
    }
    return BigInt(value);
  }

  throw new Error(`${name} bigint|number|string olmalı. Aldım: ${String(value)}`);
}

export function toSafeJsonInteger(value: JsonUint, name: string): number {
  const asBigInt = toUintBigInt(value, name);

  if (asBigInt > SAFE_JSON_INTEGER_MAX) {
    throw new Error(
      `${name} canonical JSON number olarak güvenle temsil edilemez. ` +
        `Limit=${SAFE_JSON_INTEGER_MAX.toString()}, aldım=${asBigInt.toString()}`
    );
  }

  return Number(asBigInt);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalLength);

  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!isHexString(hex)) {
    throw new Error(`Hex string değil: ${hex}`);
  }
  return getBytes(hex);
}

export function utf8Bytes(value: string): Uint8Array {
  if (typeof value !== "string") {
    throw new Error(`utf8Bytes string bekler. Aldım: ${String(value)}`);
  }
  return toUtf8Bytes(value);
}

export function keccak256Hex(data: Uint8Array): string {
  return keccak256(data);
}

export function reportIdToBytes32(report_id: string): string {
  const value = requireNonEmptyString(report_id, "report_id");

  if (isBytes32Hex(value)) {
    return hexlify(getBytes(value));
  }

  return keccak256(utf8Bytes(value));
}

function normalizeLeafInput(leaf: LeafInput): NormalizedLeafInput {
  const as_of_timestamp = toSafeJsonInteger(leaf.as_of_timestamp, "leaf.as_of_timestamp");
  const fine_weight_g = toSafeJsonInteger(leaf.fine_weight_g, "leaf.fine_weight_g");
  const fineness = requireNonEmptyString(leaf.fineness, "leaf.fineness");
  const refiner = requireNonEmptyString(leaf.refiner, "leaf.refiner");
  const serial_no = requireNonEmptyString(leaf.serial_no, "leaf.serial_no");
  const vault_id = requireNonEmptyString(leaf.vault_id, "leaf.vault_id");

  if (!FINENESS_REGEX.test(fineness)) {
    throw new Error(`leaf.fineness decimal string formatında olmalı. Aldım: ${fineness}`);
  }

  return {
    as_of_timestamp,
    fineness,
    fine_weight_g,
    refiner,
    serial_no,
    vault_id,
  };
}

/**
 * Canonical JSON:
 * - whitespace yok
 * - key order sabit:
 *   ["as_of_timestamp","fineness","fine_weight_g","refiner","serial_no","vault_id"]
 */
export function canonicalLeafJsonString(leaf: LeafInput): string {
  const normalized = normalizeLeafInput(leaf);

  return JSON.stringify({
    as_of_timestamp: normalized.as_of_timestamp,
    fineness: normalized.fineness,
    fine_weight_g: normalized.fine_weight_g,
    refiner: normalized.refiner,
    serial_no: normalized.serial_no,
    vault_id: normalized.vault_id,
  });
}

/**
 * Leaf hash: keccak256(0x00 || utf8(canonical_json))
 */
export function leafHash(leaf: LeafInput): string {
  const prefix = new Uint8Array([0x00]);
  const preimage = utf8Bytes(canonicalLeafJsonString(leaf));
  return keccak256(concatBytes(prefix, preimage));
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

  return keccak256(concatBytes(prefix, left, right));
}

export function fileKeccak256Hex(fileBytes: Uint8Array): string {
  return keccak256(fileBytes);
}

export function normalizeAddress(addr: string): string {
  return getAddress(addr);
}

export function hexlifyBytes(data: Uint8Array): string {
  return hexlify(data);
}