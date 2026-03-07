import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

function tryLoadEnvFile(): void {
  const explicit = (process.env.ENV_FILE || "").trim();
  const candidate = explicit
    ? (path.isAbsolute(explicit) ? explicit : path.join(process.cwd(), explicit))
    : path.join(process.cwd(), ".env");

  if (!fs.existsSync(candidate)) return;

  loadEnvFile(candidate);
}

tryLoadEnvFile();

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

const etherscanApiKey = envFirst([
  "ETHERSCAN_API_KEY",
  "ETHERSCAN_API_KEY_SEPOLIA",
  "ETHERSCAN_API_KEY_MAINNET",
]);

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

  ...(etherscanApiKey
    ? {
        verify: {
          etherscan: {
            apiKey: etherscanApiKey,
          },
        },
      }
    : {}),

  test: {
    mocha: {
      timeout: 120_000,
    },
  },
});