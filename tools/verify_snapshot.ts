/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import * as ethers from "ethers";
import {
  assertBytes32Hex,
  fileKeccak256Hex,
  leafHash,
  nodeHash,
  normalizeAddress,
  reportIdToBytes32,
} from "../por/merkle/hash_utils";

type Attestation = {
  schema_version: "0.1";
  report_id: string;
  as_of_timestamp: number;
  attested_fine_gold_grams: number;
  merkle_root: string;
  bar_list_hash: string;
  chain_id: number;
  reserve_registry_address: string;
  signer_address: string;
  signature_scheme: "eip712";
  eip712_domain: {
    name: "GRUSH Reserve Attestation";
    version: "1";
    chainId: number;
    verifyingContract: string;
  };
  eip712_types_version: "0.1";
  signature: string;
};

type PublishReceipt = {
  txHash: string;
  chainId: number;
  registry: string;
  publishedReportId: string;
  blockNumber: number;
  status: number;
};

type BarList = {
  schema_version: "0.1";
  report_id: string;
  as_of_timestamp: number;
  bars: Array<{
    serial_no: string;
    refiner: string;
    fineness: string;
    fine_weight_g: number;
    vault_id: string;
  }>;
  totals?: { fine_gold_grams: number };
};

const REGISTRY_ABI = [
  "function getAttestation(bytes32 reportId) external view returns (tuple(uint64 asOfTimestamp,uint64 publishedAt,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash,address signer))",
  "function exists(bytes32 reportId) external view returns (bool)",
  "event AttestationPublished(bytes32 indexed reportId,uint64 indexed asOfTimestamp,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash,address indexed signer,uint64 publishedAt)",
];

function usageAndExit(code = 1): never {
  // eslint-disable-next-line no-console
  console.error(`
Usage:
  npm run verify:snapshot -- <report_id> [--rpc <RPC_URL>]

Env fallback:
  RPC_URL=<...> npm run verify:snapshot -- <report_id>

Exit codes:
  0 = OK
  1 = FAIL
`);
  process.exit(code);
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean | string[]> = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) args[key] = true;
      else {
        args[key] = val;
        i++;
      }
    } else {
      (args._ as string[]).push(a);
    }
  }
  return args;
}

function assertInteger(n: any, name: string) {
  if (typeof n !== "number" || !Number.isInteger(n)) throw new Error(`${name} integer olmalı. Aldım: ${n}`);
}

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function listJsonFilesRec(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith(".json")) out.push(p);
    }
  }
  return out;
}

function isAttestation(j: any): j is Attestation {
  return (
    j?.schema_version === "0.1" &&
    typeof j?.report_id === "string" &&
    j?.signature_scheme === "eip712" &&
    typeof j?.signature === "string" &&
    typeof j?.chain_id === "number" &&
    typeof j?.reserve_registry_address === "string" &&
    typeof j?.signer_address === "string" &&
    typeof j?.merkle_root === "string" &&
    typeof j?.bar_list_hash === "string"
  );
}

function isBarList(j: any): j is BarList {
  return (
    j?.schema_version === "0.1" &&
    typeof j?.report_id === "string" &&
    typeof j?.as_of_timestamp === "number" &&
    Array.isArray(j?.bars)
  );
}

function isReceipt(j: any): j is PublishReceipt {
  return (
    typeof j?.txHash === "string" &&
    typeof j?.chainId === "number" &&
    typeof j?.registry === "string" &&
    typeof j?.publishedReportId === "string" &&
    typeof j?.blockNumber === "number" &&
    typeof j?.status === "number"
  );
}

function findSnapshotFiles(reportId: string) {
  const roots = [path.join(process.cwd(), "transparency"), path.join(process.cwd(), "por", "reports")];
  const files = roots.flatMap(listJsonFilesRec);

  let attPath: string | null = null;
  let barPath: string | null = null;

  for (const p of files) {
    let j: any;
    try {
      j = readJson(p);
    } catch {
      continue;
    }
    if (j?.report_id !== reportId) continue;
    if (!attPath && isAttestation(j)) attPath = p;
    if (!barPath && isBarList(j) && j?.bars?.[0]?.serial_no != null) barPath = p;
    if (attPath && barPath) break;
  }

  if (!attPath) throw new Error(`Attestation JSON bulunamadı. report_id=${reportId}`);
  if (!barPath) throw new Error(`Bar list JSON bulunamadı. report_id=${reportId}`);

  const receiptAlongside = path.join(path.dirname(attPath), "publish_receipt.json");
  const receiptPath = fs.existsSync(receiptAlongside) ? receiptAlongside : null;

  return { attPath, barPath, receiptPath };
}

function verifySignature(att: Attestation) {
  if (!/^0x[a-fA-F0-9]{130}$/.test(att.signature)) throw new Error("signature 65-byte hex değil.");
  assertInteger(att.as_of_timestamp, "as_of_timestamp");
  assertInteger(att.attested_fine_gold_grams, "attested_fine_gold_grams");
  assertInteger(att.chain_id, "chain_id");
  assertBytes32Hex(att.merkle_root, "merkle_root");
  assertBytes32Hex(att.bar_list_hash, "bar_list_hash");

  const registry = normalizeAddress(att.reserve_registry_address);
  const signer = normalizeAddress(att.signer_address);

  if (att.chain_id !== att.eip712_domain.chainId) throw new Error("chain_id != domain.chainId");
  if (normalizeAddress(att.eip712_domain.verifyingContract) !== registry) {
    throw new Error("domain.verifyingContract reserve_registry_address ile uyuşmuyor.");
  }

  const verifyTypedData =
    (ethers as any).verifyTypedData ??
    (ethers as any).utils?.verifyTypedData;
  if (typeof verifyTypedData !== "function") throw new Error("ethers verifyTypedData bulunamadı.");

  const domain = { name: "GRUSH Reserve Attestation", version: "1", chainId: att.chain_id, verifyingContract: registry };
  const types = {
    ReserveAttestation: [
      { name: "reportId", type: "bytes32" },
      { name: "asOfTimestamp", type: "uint64" },
      { name: "attestedFineGoldGrams", type: "uint256" },
      { name: "merkleRoot", type: "bytes32" },
      { name: "barListHash", type: "bytes32" },
    ],
  };
  const message = {
    reportId: reportIdToBytes32(att.report_id),
    asOfTimestamp: att.as_of_timestamp,
    attestedFineGoldGrams: att.attested_fine_gold_grams,
    merkleRoot: att.merkle_root,
    barListHash: att.bar_list_hash,
  };

  const recovered = normalizeAddress(verifyTypedData(domain, types, message, att.signature));
  if (recovered !== signer) throw new Error(`Recovered signer mismatch. recovered=${recovered} signer=${signer}`);
  return recovered;
}

function computeMerkle(barListPath: string, reportId: string, att: Attestation) {
  const fileBytes = fs.readFileSync(barListPath);
  const bar = readJson(barListPath) as any;
  if (!isBarList(bar)) throw new Error("Bar list schema invalid.");
  if (bar.report_id !== reportId) throw new Error("Bar list report_id mismatch.");
  if (bar.as_of_timestamp !== att.as_of_timestamp) throw new Error("as_of_timestamp mismatch (bar list vs attestation).");

  const bars = [...bar.bars].sort((a, b) => {
    if (a.serial_no !== b.serial_no) return a.serial_no.localeCompare(b.serial_no);
    if (a.refiner !== b.refiner) return a.refiner.localeCompare(b.refiner);
    return a.vault_id.localeCompare(b.vault_id);
  });
  if (bars.length < 1) throw new Error("bars[] boş.");

  const leaves = bars.map((b) =>
    leafHash({
      as_of_timestamp: bar.as_of_timestamp,
      fineness: String(b.fineness),
      fine_weight_g: Number(b.fine_weight_g),
      refiner: String(b.refiner),
      serial_no: String(b.serial_no),
      vault_id: String(b.vault_id),
    })
  );

  let level = leaves;
  while (level.length > 1) {
    if (level.length % 2 === 1) level = [...level, level[level.length - 1]];
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(nodeHash(level[i], level[i + 1]));
    level = next;
  }
  const merkleRoot = level[0];
  const barListHash = fileKeccak256Hex(new Uint8Array(fileBytes));
  const fineGold = bar.totals?.fine_gold_grams ?? bars.reduce((s: number, b: any) => s + Number(b.fine_weight_g), 0);

  if (merkleRoot.toLowerCase() !== att.merkle_root.toLowerCase()) {
    throw new Error(`merkle_root mismatch. computed=${merkleRoot} attestation=${att.merkle_root}`);
  }
  if (barListHash.toLowerCase() !== att.bar_list_hash.toLowerCase()) {
    throw new Error(`bar_list_hash mismatch. computed=${barListHash} attestation=${att.bar_list_hash}`);
  }
  if (fineGold !== att.attested_fine_gold_grams) {
    throw new Error(`attested_fine_gold_grams mismatch. computed=${fineGold} attestation=${att.attested_fine_gold_grams}`);
  }

  return { barsCount: bars.length };
}

function getProvider(rpcUrl: string) {
  const v6 = (ethers as any).JsonRpcProvider;
  if (typeof v6 === "function") return new v6(rpcUrl);
  const v5 = (ethers as any).providers?.JsonRpcProvider;
  if (typeof v5 === "function") return new v5(rpcUrl);
  throw new Error("ethers JsonRpcProvider bulunamadı.");
}

async function verifyOnchain(att: Attestation, rc: PublishReceipt, rpcUrl: string) {
  const provider = getProvider(rpcUrl);
  const net = await provider.getNetwork();
  const providerChainId = Number((net as any).chainId);

  if (providerChainId !== att.chain_id || providerChainId !== rc.chainId) {
    throw new Error(`chainId mismatch. provider=${providerChainId} attestation=${att.chain_id} receipt=${rc.chainId}`);
  }

  const expectedReportId = reportIdToBytes32(att.report_id);
  if (expectedReportId.toLowerCase() !== rc.publishedReportId.toLowerCase()) {
    throw new Error("publishedReportId mismatch.");
  }

  const txReceipt = await provider.getTransactionReceipt(rc.txHash);
  if (!txReceipt) throw new Error(`Tx receipt not found: ${rc.txHash}`);

  const txBlockNumber = Number((txReceipt as any).blockNumber);
  const txStatus = Number((txReceipt as any).status);

  if (txBlockNumber !== rc.blockNumber) throw new Error("blockNumber mismatch.");
  if (txStatus !== rc.status) throw new Error("status mismatch.");
  if (txStatus !== 1) throw new Error("tx status != 1");

  const registryAddr = normalizeAddress(rc.registry);
  if (registryAddr !== normalizeAddress(att.reserve_registry_address)) throw new Error("registry mismatch.");

  const registry = new (ethers as any).Contract(registryAddr, REGISTRY_ABI, provider);
  const exists = await registry.exists(rc.publishedReportId);
  if (!exists) throw new Error("registry.exists(reportId) false.");

  const InterfaceCtor = (ethers as any).Interface ?? (ethers as any).utils?.Interface;
  if (!InterfaceCtor) throw new Error("ethers Interface bulunamadı.");
  const iface = new InterfaceCtor(REGISTRY_ABI);
  const evTopic = iface.getEvent("AttestationPublished").topicHash;
  const logs = (txReceipt as any).logs ?? [];
  const matching = logs.filter((lg: any) => lg?.address && normalizeAddress(lg.address) === registryAddr && lg?.topics?.[0] === evTopic);
  if (matching.length !== 1) throw new Error(`Expected 1 AttestationPublished log. got=${matching.length}`);

  const ev = iface.parseLog(matching[0]).args;
  if (String(ev.reportId).toLowerCase() !== rc.publishedReportId.toLowerCase()) throw new Error("event.reportId mismatch");
  if (Number(ev.asOfTimestamp) !== att.as_of_timestamp) throw new Error("event.asOfTimestamp mismatch");
  if (((ev.attestedFineGoldGrams as any).toString?.() ?? String(ev.attestedFineGoldGrams)) !== String(att.attested_fine_gold_grams)) {
    throw new Error("event.attestedFineGoldGrams mismatch");
  }
  if (String(ev.merkleRoot).toLowerCase() !== att.merkle_root.toLowerCase()) throw new Error("event.merkleRoot mismatch");
  if (String(ev.barListHash).toLowerCase() !== att.bar_list_hash.toLowerCase()) throw new Error("event.barListHash mismatch");
  if (normalizeAddress(String(ev.signer)) !== normalizeAddress(att.signer_address)) throw new Error("event.signer mismatch");

  const st = await registry.getAttestation(rc.publishedReportId);
  if (Number(st.asOfTimestamp) !== att.as_of_timestamp) throw new Error("state.asOfTimestamp mismatch");
  if (((st.attestedFineGoldGrams as any).toString?.() ?? String(st.attestedFineGoldGrams)) !== String(att.attested_fine_gold_grams)) {
    throw new Error("state.attestedFineGoldGrams mismatch");
  }
  if (String(st.merkleRoot).toLowerCase() !== att.merkle_root.toLowerCase()) throw new Error("state.merkleRoot mismatch");
  if (String(st.barListHash).toLowerCase() !== att.bar_list_hash.toLowerCase()) throw new Error("state.barListHash mismatch");
  if (normalizeAddress(String(st.signer)) !== normalizeAddress(att.signer_address)) throw new Error("state.signer mismatch");

  return { ok: true };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) usageAndExit(0);

  const reportId = String((args._ as string[])[0] ?? "");
  if (!reportId) usageAndExit(1);

  const { attPath, barPath, receiptPath } = findSnapshotFiles(reportId);
  const attRaw = readJson(attPath);
  if (!isAttestation(attRaw)) throw new Error("Attestation file invalid.");

  const att: Attestation = {
    ...attRaw,
    reserve_registry_address: normalizeAddress(attRaw.reserve_registry_address),
    signer_address: normalizeAddress(attRaw.signer_address),
    eip712_domain: {
      ...attRaw.eip712_domain,
      chainId: Number(attRaw.eip712_domain.chainId),
      verifyingContract: normalizeAddress(attRaw.eip712_domain.verifyingContract),
    },
  };

  const recovered = verifySignature(att);
  const merkle = computeMerkle(barPath, reportId, att);

  let onchain: any = { skipped: true };
  if (receiptPath) {
    const rcRaw = readJson(receiptPath);
    if (!isReceipt(rcRaw)) throw new Error("publish_receipt.json invalid.");

    const rc: PublishReceipt = {
      ...rcRaw,
      registry: normalizeAddress(rcRaw.registry),
      publishedReportId: String(rcRaw.publishedReportId),
    };
    assertBytes32Hex(rc.publishedReportId, "receipt.publishedReportId");

    const rpc = (args.rpc as string) || process.env.RPC_URL || process.env.SEPOLIA_RPC_URL || "";
    if (!rpc) throw new Error("Receipt var ama RPC_URL/--rpc yok. On-chain verify için RPC şart.");

    onchain = await verifyOnchain(att, rc, rpc);
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: true,
        report_id: reportId,
        files: {
          attestation: path.relative(process.cwd(), attPath),
          bar_list: path.relative(process.cwd(), barPath),
          receipt: receiptPath ? path.relative(process.cwd(), receiptPath) : null,
        },
        signature: { recovered_signer: recovered },
        merkle,
        onchain,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("FAIL:", e?.message ?? e);
  process.exit(1);
});
