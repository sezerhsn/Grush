import { expect } from "chai";
import hre from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs";
import type {
  ContractRunner,
  ContractTransactionResponse,
  Interface,
  TransactionReceipt,
} from "ethers";

const { ethers } = await hre.network.connect();

type AddressSigner = ContractRunner & {
  address: string;
};

type GRUSHTokenLike = {
  getAddress(): Promise<string>;
  waitForDeployment(): Promise<GRUSHTokenLike>;
  connect(runner: ContractRunner | null): GRUSHTokenLike;

  BURNER_ROLE(): Promise<string>;
  grantRole(role: string, account: string): Promise<ContractTransactionResponse>;
  mint(to: string, amount: bigint): Promise<ContractTransactionResponse>;
  approve(spender: string, amount: bigint): Promise<ContractTransactionResponse>;
  balanceOf(account: string): Promise<bigint>;
  totalSupply(): Promise<bigint>;
};

type RedemptionRequest = {
  requester: string;
  amount: bigint;
  destinationHash: string;
  status: bigint;
  decisionRef: string;
  decidedBy: string;
};

type RedemptionGatewayLike = {
  interface: Interface;
  getAddress(): Promise<string>;
  waitForDeployment(): Promise<RedemptionGatewayLike>;
  connect(runner: ContractRunner | null): RedemptionGatewayLike;

  requestRedemption(
    amount: bigint,
    destinationHash: string
  ): Promise<ContractTransactionResponse>;
  cancelRedemption(requestId: string): Promise<ContractTransactionResponse>;
  rejectRedemption(
    requestId: string,
    reasonHash: string
  ): Promise<ContractTransactionResponse>;
  fulfillRedemption(
    requestId: string,
    fulfillmentRef: string
  ): Promise<ContractTransactionResponse>;
  getRequest(requestId: string): Promise<RedemptionRequest>;
  paused(): Promise<boolean>;
  pause(): Promise<ContractTransactionResponse>;
  unpause(): Promise<ContractTransactionResponse>;
};

type RedemptionFixture = {
  token: GRUSHTokenLike;
  gateway: RedemptionGatewayLike;
  admin: AddressSigner;
  operator: AddressSigner;
  pauser: AddressSigner;
  minter: AddressSigner;
  user: AddressSigner;
  other: AddressSigner;
};

type ParseableLog = {
  topics: readonly string[];
  data: string;
};

function b32(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

function isParseableLog(value: unknown): value is ParseableLog {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { topics?: unknown; data?: unknown };
  return (
    Array.isArray(candidate.topics) &&
    candidate.topics.every((topic) => typeof topic === "string") &&
    typeof candidate.data === "string"
  );
}

function requireReceipt(receipt: TransactionReceipt | null): TransactionReceipt {
  if (!receipt) {
    throw new Error("Transaction receipt bulunamadı.");
  }
  return receipt;
}

function getRequestIdFromReceipt(
  gateway: RedemptionGatewayLike,
  receipt: TransactionReceipt
): string {
  for (const log of receipt.logs) {
    if (!isParseableLog(log)) {
      continue;
    }

    try {
      const parsed = gateway.interface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });

      if (!parsed || parsed.name !== "RedemptionRequested") {
        continue;
      }

      const namedRequestId = Reflect.get(parsed.args, "requestId");
      if (typeof namedRequestId === "string") {
        return namedRequestId;
      }

      const positionalRequestId = parsed.args[0];
      if (typeof positionalRequestId === "string") {
        return positionalRequestId;
      }
    } catch {
      continue;
    }
  }

  throw new Error("RedemptionRequested event not found");
}

describe("RedemptionGateway", function () {
  async function deployFixture(): Promise<RedemptionFixture> {
    const [admin, operator, pauser, minter, burnerEOA, tokenPauser, user, other] =
      (await ethers.getSigners()) as AddressSigner[];

    const GRUSHToken = await ethers.getContractFactory("GRUSHToken");
    const deployedToken = await GRUSHToken.deploy(
      admin.address,
      minter.address,
      burnerEOA.address,
      tokenPauser.address
    );
    const token = deployedToken as unknown as GRUSHTokenLike;
    await token.waitForDeployment();

    const RedemptionGateway = await ethers.getContractFactory("RedemptionGateway");
    const deployedGateway = await RedemptionGateway.deploy(
      admin.address,
      await token.getAddress(),
      operator.address,
      pauser.address
    );
    const gateway = deployedGateway as unknown as RedemptionGatewayLike;
    await gateway.waitForDeployment();

    const burnerRole = await token.BURNER_ROLE();
    await token.connect(admin).grantRole(burnerRole, await gateway.getAddress());

    const mintAmount = ethers.parseUnits("100", 18);
    await token.connect(minter).mint(user.address, mintAmount);

    return {
      token,
      gateway,
      admin,
      operator,
      pauser,
      minter,
      user,
      other,
    };
  }

  it("creates a request by escrowing tokens (requestRedemption)", async function () {
    const { token, gateway, user } = await deployFixture();

    const amount = ethers.parseUnits("10", 18);
    const destinationHash = b32("dest-1");

    await token.connect(user).approve(await gateway.getAddress(), amount);

    const tx = await gateway.connect(user).requestRedemption(amount, destinationHash);
    const receipt = requireReceipt(await tx.wait());

    await expect(tx).to.emit(gateway, "RedemptionRequested");

    const requestId = getRequestIdFromReceipt(gateway, receipt);
    const req = await gateway.getRequest(requestId);

    expect(req.requester).to.equal(user.address);
    expect(req.amount).to.equal(amount);
    expect(req.destinationHash).to.equal(destinationHash);
    expect(req.status).to.equal(1n);

    expect(await token.balanceOf(await gateway.getAddress())).to.equal(amount);
  });

  it("allows requester to cancel and returns escrowed tokens", async function () {
    const { token, gateway, user } = await deployFixture();

    const amount = ethers.parseUnits("7", 18);
    const destinationHash = b32("dest-cancel");
    const before = await token.balanceOf(user.address);

    await token.connect(user).approve(await gateway.getAddress(), amount);

    const tx = await gateway.connect(user).requestRedemption(amount, destinationHash);
    const receipt = requireReceipt(await tx.wait());
    const requestId = getRequestIdFromReceipt(gateway, receipt);

    await expect(gateway.connect(user).cancelRedemption(requestId))
      .to.emit(gateway, "RedemptionCancelled")
      .withArgs(requestId, user.address, amount, anyValue);

    const after = await token.balanceOf(user.address);
    expect(after).to.equal(before);

    const req = await gateway.getRequest(requestId);
    expect(req.status).to.equal(2n);
  });

  it("operator can reject and tokens return to requester", async function () {
    const { token, gateway, user, operator } = await deployFixture();

    const amount = ethers.parseUnits("11", 18);
    const destinationHash = b32("dest-reject");
    const reasonHash = b32("kyc-fail");
    const before = await token.balanceOf(user.address);

    await token.connect(user).approve(await gateway.getAddress(), amount);

    const tx = await gateway.connect(user).requestRedemption(amount, destinationHash);
    const receipt = requireReceipt(await tx.wait());
    const requestId = getRequestIdFromReceipt(gateway, receipt);

    await expect(gateway.connect(operator).rejectRedemption(requestId, reasonHash))
      .to.emit(gateway, "RedemptionRejected");

    const after = await token.balanceOf(user.address);
    expect(after).to.equal(before);

    const req = await gateway.getRequest(requestId);
    expect(req.status).to.equal(3n);
    expect(req.decisionRef).to.equal(reasonHash);
    expect(req.decidedBy).to.equal(operator.address);
  });

  it("operator can fulfill and escrowed tokens are burned", async function () {
    const { token, gateway, user, operator } = await deployFixture();

    const amount = ethers.parseUnits("9", 18);
    const destinationHash = b32("dest-fulfill");
    const fulfillmentRef = b32("ship-123");
    const supplyBefore = await token.totalSupply();

    await token.connect(user).approve(await gateway.getAddress(), amount);

    const tx = await gateway.connect(user).requestRedemption(amount, destinationHash);
    const receipt = requireReceipt(await tx.wait());
    const requestId = getRequestIdFromReceipt(gateway, receipt);

    await expect(gateway.connect(operator).fulfillRedemption(requestId, fulfillmentRef))
      .to.emit(gateway, "RedemptionFulfilled");

    const supplyAfter = await token.totalSupply();
    expect(supplyAfter).to.equal(supplyBefore - amount);

    expect(await token.balanceOf(await gateway.getAddress())).to.equal(0n);

    const req = await gateway.getRequest(requestId);
    expect(req.status).to.equal(4n);
    expect(req.decisionRef).to.equal(fulfillmentRef);
  });

  it("only operator can reject/fulfill", async function () {
    const { token, gateway, user, other } = await deployFixture();

    const amount = ethers.parseUnits("5", 18);
    const destinationHash = b32("dest-auth");
    const reasonHash = b32("nope");
    const fulfillmentRef = b32("nope2");

    await token.connect(user).approve(await gateway.getAddress(), amount);

    const tx = await gateway.connect(user).requestRedemption(amount, destinationHash);
    const receipt = requireReceipt(await tx.wait());
    const requestId = getRequestIdFromReceipt(gateway, receipt);

    await expect(gateway.connect(other).rejectRedemption(requestId, reasonHash)).to.revert(
      ethers
    );
    await expect(
      gateway.connect(other).fulfillRedemption(requestId, fulfillmentRef)
    ).to.revert(ethers);
  });

  it("pause blocks request/cancel/reject/fulfill", async function () {
    const { token, gateway, user, operator, pauser } = await deployFixture();

    const amount = ethers.parseUnits("4", 18);
    const destinationHash = b32("dest-paused");
    const reasonHash = b32("paused");
    const fulfillmentRef = b32("paused2");

    await token.connect(user).approve(await gateway.getAddress(), amount);

    await gateway.connect(pauser).pause();
    expect(await gateway.paused()).to.equal(true);

    await expect(gateway.connect(user).requestRedemption(amount, destinationHash)).to.revert(
      ethers
    );

    await gateway.connect(pauser).unpause();

    const tx = await gateway.connect(user).requestRedemption(amount, destinationHash);
    const receipt = requireReceipt(await tx.wait());
    const requestId = getRequestIdFromReceipt(gateway, receipt);

    await gateway.connect(pauser).pause();

    await expect(gateway.connect(user).cancelRedemption(requestId)).to.revert(ethers);
    await expect(gateway.connect(operator).rejectRedemption(requestId, reasonHash)).to.revert(
      ethers
    );
    await expect(
      gateway.connect(operator).fulfillRedemption(requestId, fulfillmentRef)
    ).to.revert(ethers);
  });

  it("cannot cancel if not requester; cannot cancel/reject/fulfill in wrong status", async function () {
    const { token, gateway, user, other, operator } = await deployFixture();

    const amount = ethers.parseUnits("6", 18);
    const destinationHash = b32("dest-status");
    const reasonHash = b32("reason");
    const fulfillmentRef = b32("fulfill");

    await token.connect(user).approve(await gateway.getAddress(), amount);

    const tx = await gateway.connect(user).requestRedemption(amount, destinationHash);
    const receipt = requireReceipt(await tx.wait());
    const requestId = getRequestIdFromReceipt(gateway, receipt);

    await expect(gateway.connect(other).cancelRedemption(requestId)).to.revert(ethers);

    await gateway.connect(operator).rejectRedemption(requestId, reasonHash);

    await expect(gateway.connect(user).cancelRedemption(requestId)).to.revert(ethers);
    await expect(
      gateway.connect(operator).fulfillRedemption(requestId, fulfillmentRef)
    ).to.revert(ethers);
  });
});