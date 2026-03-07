import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

function envStr(key: string): string {
  return (process.env[key] ?? "").trim();
}

function envFirst(keys: string[]): string {
  for (const key of keys) {
    const value = envStr(key);
    if (value) return value;
  }
  return "";
}

function normalizePrivateKey(pk: string): string {
  const v = pk.trim();
  if (!v) return "";
  return v.startsWith("0x") ? v : `0x${v}`;
}

const sepoliaUrl = envFirst(["SEPOLIA_RPC_URL", "RPC_URL"]);
const sepoliaPk = normalizePrivateKey(envFirst(["PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY"]));

const mainnetUrl = envFirst(["MAINNET_RPC_URL", "RPC_URL"]);
const mainnetPk = normalizePrivateKey(
  envFirst(["MAINNET_PRIVATE_KEY", "PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY"])
);

// URL yoksa network'ü hiç tanımlama.
// Böylece local compile/test, RPC URL zorunluluğu olmadan ayağa kalkar.
const networks = {
  ...(sepoliaUrl
    ? {
        sepolia: {
          type: "http" as const,
          chainType: "l1" as const,
          chainId: 11155111,
          url: sepoliaUrl,
          accounts: sepoliaPk ? [sepoliaPk] : [],
        },
      }
    : {}),
  ...(mainnetUrl
    ? {
        mainnet: {
          type: "http" as const,
          chainType: "l1" as const,
          chainId: 1,
          url: mainnetUrl,
          accounts: mainnetPk ? [mainnetPk] : [],
        },
      }
    : {}),
};

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

  ...(Object.keys(networks).length > 0 ? { networks } : {}),

  test: {
    mocha: {
      timeout: 120_000,
    },
  },
});