/* eslint-disable no-console */
import { ethers, network } from "hardhat";

function reqEnv(key: string): string {
  const v = process.env[key];
  if (!v || !v.trim()) throw new Error(`Missing env: ${key}`);
  return v.trim();
}

function optEnv(key: string): string | undefined {
  const v = process.env[key];
  if (!v || !v.trim()) return undefined;
  return v.trim();
}

function addr(label: string, v: string): string {
  if (!ethers.isAddress(v)) throw new Error(`${label} invalid address: ${v}`);
  return ethers.getAddress(v);
}

function parseCsvAddresses(csv?: string): string[] {
  if (!csv) return [];
  const out = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => addr("CSV address", s));
  return Array.from(new Set(out));
}

async function ensureGrant(
  contract: any,
  role: string,
  who: string,
  roleName: string
) {
  const has = await contract.hasRole(role, who);
  if (has) {
    console.log(`OK: ${roleName} already granted to ${who}`);
    return;
  }
  const tx = await contract.grantRole(role, who);
  const rc = await tx.wait();
  console.log(`GRANT: ${roleName} -> ${who} tx=${tx.hash} status=${rc?.status}`);
}

async function ensureRevoke(
  contract: any,
  role: string,
  who: string,
  roleName: string
) {
  const has = await contract.hasRole(role, who);
  if (!has) {
    console.log(`OK: ${roleName} already NOT present on ${who}`);
    return;
  }
  const tx = await contract.revokeRole(role, who);
  const rc = await tx.wait();
  console.log(`REVOKE: ${roleName} -/-> ${who} tx=${tx.hash} status=${rc?.status}`);
}

async function ensureRenounce(
  contract: any,
  role: string,
  who: string,
  roleName: string,
  signer: any
) {
  const has = await contract.hasRole(role, who);
  if (!has) {
    console.log(`OK: ${roleName} already NOT present on ${who}`);
    return;
  }
  const tx = await contract.connect(signer).renounceRole(role, who);
  const rc = await tx.wait();
  console.log(`RENOUNCE: ${roleName} by ${who} tx=${tx.hash} status=${rc?.status}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = ethers.getAddress(await deployer.getAddress());
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  // --- Required envs for registry handover ---
  const RESERVE_REGISTRY_ADDRESS = addr("RESERVE_REGISTRY_ADDRESS", reqEnv("RESERVE_REGISTRY_ADDRESS"));
  const MULTISIG_ADDRESS = addr("MULTISIG_ADDRESS", reqEnv("MULTISIG_ADDRESS"));

  // --- Optional: timelock (recommended) ---
  const TIMELOCK_ADDRESS = optEnv("TIMELOCK_ADDRESS") ? addr("TIMELOCK_ADDRESS", optEnv("TIMELOCK_ADDRESS")!) : undefined;

  // --- Optional: token role handover if token exists ---
  const GRUSH_TOKEN_ADDRESS = optEnv("GRUSH_TOKEN_ADDRESS") ? addr("GRUSH_TOKEN_ADDRESS", optEnv("GRUSH_TOKEN_ADDRESS")!) : undefined;

  // --- Optional: allowlist signers on registry ---
  const ALLOWLIST_SIGNERS = parseCsvAddresses(optEnv("REGISTRY_ALLOWED_SIGNERS"));
  const SET_SIGNERS = (optEnv("SET_SIGNERS") || "").toLowerCase() === "true";

  // --- Safety toggles ---
  const CLEANUP_DEPLOYER = (optEnv("CLEANUP_DEPLOYER") || "true").toLowerCase() === "true";
  const DRY_RUN = (optEnv("DRY_RUN") || "").toLowerCase() === "true";

  console.log(JSON.stringify({
    action: "grant_roles",
    network: network.name,
    chainId,
    deployer: deployerAddr,
    reserveRegistry: RESERVE_REGISTRY_ADDRESS,
    grushToken: GRUSH_TOKEN_ADDRESS ?? null,
    multisig: MULTISIG_ADDRESS,
    timelock: TIMELOCK_ADDRESS ?? null,
    setSigners: SET_SIGNERS,
    allowlistSignersCount: ALLOWLIST_SIGNERS.length,
    cleanupDeployer: CLEANUP_DEPLOYER,
    dryRun: DRY_RUN
  }, null, 2));

  if (DRY_RUN) {
    console.log("DRY_RUN=true => tx gönderilmeyecek. Çıkıyorum.");
    return;
  }

  // ----------------------------
  // ReserveRegistry handover
  // ----------------------------
  const registry = await ethers.getContractAt("ReserveRegistry", RESERVE_REGISTRY_ADDRESS);

  const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const PUBLISHER_ROLE = ethers.id("PUBLISHER_ROLE");
  const PAUSER_ROLE = ethers.id("PAUSER_ROLE");
  const SIGNER_ADMIN_ROLE = ethers.id("SIGNER_ADMIN_ROLE");

  const targetAdmin = TIMELOCK_ADDRESS ?? MULTISIG_ADDRESS;

  // 1) Grant admin + signer-admin to target (timelock preferred)
  await ensureGrant(registry, DEFAULT_ADMIN_ROLE, targetAdmin, "DEFAULT_ADMIN_ROLE");
  await ensureGrant(registry, SIGNER_ADMIN_ROLE, targetAdmin, "SIGNER_ADMIN_ROLE");

  // 2) Grant publisher/pauser to multisig (ops)
  await ensureGrant(registry, PUBLISHER_ROLE, MULTISIG_ADDRESS, "PUBLISHER_ROLE");
  await ensureGrant(registry, PAUSER_ROLE, MULTISIG_ADDRESS, "PAUSER_ROLE");

  // 3) Optionally set allowlist signers (auditor/custodian signer addresses)
  if (SET_SIGNERS) {
    if (ALLOWLIST_SIGNERS.length === 0) {
      console.log("SET_SIGNERS=true ama REGISTRY_ALLOWED_SIGNERS boş. Skip.");
    } else {
      // NOTE: setAllowedSigners is restricted to SIGNER_ADMIN_ROLE
      // If deployer is still admin, it can call; otherwise ensure deployer has role or call via timelock/multisig outside this script.
      const bools = ALLOWLIST_SIGNERS.map(() => true);
      const tx = await registry.setAllowedSigners(ALLOWLIST_SIGNERS, bools);
      const rc = await tx.wait();
      console.log(`ALLOWLIST: setAllowedSigners tx=${tx.hash} status=${rc?.status}`);
    }
  }

  // 4) Cleanup deployer roles (recommended)
  if (CLEANUP_DEPLOYER) {
    // If deployer has DEFAULT_ADMIN_ROLE, it can revoke others; but we only remove deployer from roles.
    // Safer to RENOUNCE from deployer where possible.
    await ensureRenounce(registry, PUBLISHER_ROLE, deployerAddr, "PUBLISHER_ROLE", deployer);
    await ensureRenounce(registry, PAUSER_ROLE, deployerAddr, "PAUSER_ROLE", deployer);
    await ensureRenounce(registry, SIGNER_ADMIN_ROLE, deployerAddr, "SIGNER_ADMIN_ROLE", deployer);
    await ensureRenounce(registry, DEFAULT_ADMIN_ROLE, deployerAddr, "DEFAULT_ADMIN_ROLE", deployer);
  } else {
    console.log("CLEANUP_DEPLOYER=false => deployer role cleanup yapılmadı.");
  }

  // ----------------------------
  // Optional: GRUSHToken handover (if deployed)
  // ----------------------------
  if (GRUSH_TOKEN_ADDRESS) {
    console.log("GRUSHToken handover starting...");

    // Token contract name must match compiled artifact "GRUSHToken"
    // If token isn't implemented yet, just skip by not setting GRUSH_TOKEN_ADDRESS.
    const token = await ethers.getContractAt("GRUSHToken", GRUSH_TOKEN_ADDRESS);

    const MINTER_ROLE = ethers.id("MINTER_ROLE");
    const BURNER_ROLE = ethers.id("BURNER_ROLE");
    const TOKEN_PAUSER_ROLE = ethers.id("PAUSER_ROLE");

    const tokenAdminTarget = TIMELOCK_ADDRESS ?? MULTISIG_ADDRESS;

    await ensureGrant(token, DEFAULT_ADMIN_ROLE, tokenAdminTarget, "TOKEN.DEFAULT_ADMIN_ROLE");
    await ensureGrant(token, MINTER_ROLE, MULTISIG_ADDRESS, "TOKEN.MINTER_ROLE");
    await ensureGrant(token, BURNER_ROLE, MULTISIG_ADDRESS, "TOKEN.BURNER_ROLE");
    await ensureGrant(token, TOKEN_PAUSER_ROLE, MULTISIG_ADDRESS, "TOKEN.PAUSER_ROLE");

    if (CLEANUP_DEPLOYER) {
      await ensureRenounce(token, MINTER_ROLE, deployerAddr, "TOKEN.MINTER_ROLE", deployer);
      await ensureRenounce(token, BURNER_ROLE, deployerAddr, "TOKEN.BURNER_ROLE", deployer);
      await ensureRenounce(token, TOKEN_PAUSER_ROLE, deployerAddr, "TOKEN.PAUSER_ROLE", deployer);
      await ensureRenounce(token, DEFAULT_ADMIN_ROLE, deployerAddr, "TOKEN.DEFAULT_ADMIN_ROLE", deployer);
    }
  } else {
    console.log("GRUSH_TOKEN_ADDRESS yok => token handover skip.");
  }

  console.log("DONE.");
}

main().catch((e) => {
  console.error("FAIL:", e?.message ?? e);
  process.exit(1);
});
