import { defineConfig, configVariable } from "hardhat/config";

import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatMocha from "@nomicfoundation/hardhat-mocha";
import hardhatEthersChaiMatchers from "@nomicfoundation/hardhat-ethers-chai-matchers";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";

/**
 * Env (önerilen):
 * - SEPOLIA_RPC_URL (veya RPC_URL)
 * - MAINNET_RPC_URL (veya RPC_URL)
 * - DEPLOYER_PRIVATE_KEY (veya PRIVATE_KEY)   // 0x prefiksli ya da prefikssiz olabilir
 */

function envStr(key: string): string | undefined {
  const v = (process.env[key] || "").trim();
  return v ? v : undefined;
}

function normalizePk(pk: string): string {
  const t = pk.trim();
  return t.startsWith("0x") ? t : `0x${t}`;
}

function deployerAccounts(): string[] {
  const pk = envStr("DEPLOYER_PRIVATE_KEY") ?? envStr("PRIVATE_KEY");
  return pk ? [normalizePk(pk)] : [];
}

function rpcUrlFor(network: "sepolia" | "mainnet"): string | ReturnType<typeof configVariable> {
  const rpc = envStr("RPC_URL");

  if (network === "sepolia") {
    return envStr("SEPOLIA_RPC_URL") ?? rpc ?? configVariable("SEPOLIA_RPC_URL");
  }

  return envStr("MAINNET_RPC_URL") ?? rpc ?? configVariable("MAINNET_RPC_URL");
}

const accounts = deployerAccounts();

export default defineConfig({
  plugins: [hardhatEthers, hardhatMocha, hardhatEthersChaiMatchers, hardhatNetworkHelpers],

  paths: {
    sources: "./contracts/src",
    tests: {
      mocha: "./contracts/test",
    },
    cache: "./contracts/cache",
    artifacts: "./contracts/artifacts",
  },

  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },

  networks: {
    localhost: {
      type: "http",
      chainType: "l1",
      url: envStr("LOCALHOST_RPC_URL") ?? "http://127.0.0.1:8545",
      accounts,
    },

    sepolia: {
      type: "http",
      chainType: "l1",
      chainId: 11155111,
      url: rpcUrlFor("sepolia"),
      accounts,
    },

    mainnet: {
      type: "http",
      chainType: "l1",
      chainId: 1,
      url: rpcUrlFor("mainnet"),
      accounts,
    },
  },

  test: {
    mocha: {
      timeout: 120_000,
    },
  },
});