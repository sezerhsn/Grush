import { defineConfig, configVariable } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

/**
 * Env (önerilen):
 * - SEPOLIA_RPC_URL (veya RPC_URL)
 * - MAINNET_RPC_URL (veya RPC_URL)
 * - DEPLOYER_PRIVATE_KEY (veya PRIVATE_KEY)   // 0x prefiksli ya da prefikssiz olabilir
 * - ETHERSCAN_API_KEY (opsiyonel; verify için)
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

  // mainnet
  return envStr("MAINNET_RPC_URL") ?? rpc ?? configVariable("MAINNET_RPC_URL");
}

function etherscanApiKey(): string | undefined {
  return (
    envStr("ETHERSCAN_API_KEY") ??
    envStr("ETHERSCAN_KEY") ??
    envStr("ETHERSCAN_TOKEN") ??
    envStr("ETHERSCAN_API_KEY_MAINNET") ??
    envStr("ETHERSCAN_API_KEY_SEPOLIA")
  );
}

const accounts = deployerAccounts();
const etherscanKey = etherscanApiKey();

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],

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
    // Local node (npx hardhat node)
    localhost: {
      type: "http",
      chainType: "l1",
      url: envStr("LOCALHOST_RPC_URL") ?? "http://127.0.0.1:8545",
      // İstersen local node hesabını da bu env ile kullanırsın; yoksa boş kalsın.
      accounts,
    },

    // Ethereum Sepolia
    sepolia: {
      type: "http",
      chainType: "l1",
      chainId: 11155111,
      url: rpcUrlFor("sepolia"),
      accounts,
    },

    // Ethereum Mainnet
    mainnet: {
      type: "http",
      chainType: "l1",
      chainId: 1,
      url: rpcUrlFor("mainnet"),
      accounts,
    },
  },

  ...(etherscanKey
    ? {
        verify: {
          etherscan: {
            apiKey: etherscanKey,
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
