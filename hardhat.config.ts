import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

function envStr(key: string): string {
  return (process.env[key] || "").trim();
}

function envFirst(keys: string[]): { key: string | null; value: string } {
  for (const k of keys) {
    const v = envStr(k);
    if (v) return { key: k, value: v };
  }
  return { key: null, value: "" };
}

function normalizePrivateKey(pk: string): string {
  const v = pk.trim();
  if (!v) return "";
  return v.startsWith("0x") ? v : `0x${v}`;
}

// Not: config dosyası yüklenirken hard fail olmasın diye env'ler optional.
// Sepolia/mainnet çalıştırmadan önce tools/env_guard.ts ile strict kontrol et.
const sepoliaUrl = envFirst(["SEPOLIA_RPC_URL", "RPC_URL"]).value;
const sepoliaPk = normalizePrivateKey(envFirst(["PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY"]).value);

const mainnetUrl = envFirst(["MAINNET_RPC_URL", "RPC_URL"]).value;
const mainnetPk = normalizePrivateKey(
  envFirst(["MAINNET_PRIVATE_KEY", "PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY"]).value
);

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],

  paths: {
    sources: "./contracts/src",
    tests: { mocha: "./contracts/test" },
    cache: "./contracts/cache",
    artifacts: "./contracts/artifacts",
  },

  solidity: {
    version: "0.8.25",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },

  networks: {
    sepolia: {
      type: "http",
      chainType: "l1",
      chainId: 11155111,
      url: sepoliaUrl,
      accounts: sepoliaPk ? [sepoliaPk] : [],
    },
    // Sadece config valid kalsın diye tanımlı; kullanmak zorunda değilsin.
    mainnet: {
      type: "http",
      chainType: "l1",
      chainId: 1,
      url: mainnetUrl,
      accounts: mainnetPk ? [mainnetPk] : [],
    },
  },

  test: { mocha: { timeout: 120_000 } },
});