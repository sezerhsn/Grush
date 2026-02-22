import { expect } from "chai";
import hre from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs";

const { ethers } = await hre.network.connect();

function b32(label: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

describe("RedemptionGateway", function () {
  async function deployFixture() {
    const [admin, operator, pauser, minter, burnerEOA, tokenPauser, user, other] =
      await ethers.getSigners();

    // Deploy GRUSHToken
    const GRUSHToken = await ethers.getContractFactory("GRUSHToken");
    const token = await GRUSHToken.deploy(
      admin.address,
      minter.address,
      burnerEOA.address,
      tokenPauser.address
    );
    await token.waitForDeployment();

    // Deploy RedemptionGateway
    const RedemptionGateway = await ethers.getContractFactory("RedemptionGateway");
    const gateway = await RedemptionGateway.deploy(
      admin.address,
      await token.getAddress(),
      operator.address,
      pauser.address
    );
    await gateway.waitForDeployment();

    // Grant BURNER_ROLE to gateway so it can burn escrow on fulfill
    const BURNER_ROLE = await token.BURNER_ROLE();
    await token.connect(admin).grantRole(BURNER_ROLE, await gateway.getAddress());

    // Mint some tokens to user
    const mintAmount = ethers.parseUnits("100", 18);
    await token.connect(minter).mint(user.address, mintAmount);

    return { token, gateway, admin, operator, pauser, minter, user, other };
  }

  it("creates a request by escrowing tokens (requestRedemption)", async function () {
    const { token, gateway, user } = await deployFixture();

    const amount = ethers.parseUnits("10", 18);
    const destinationHash = b32("dest-1");

    await token.connect(user).approve(await gateway.getAddress(), amount);

    const tx = await gateway.connect(user).requestRedemption(amount, destinationHash);
    const rc = await tx.wait();

    // event check
    await expect(tx).to.emit(gateway, "RedemptionRequested");

    // Parse requestId from event (safer than recompute)
    const evt = rc!.logs.map((l: any) => {
      try {
        return gateway.interface.parseLog(l);
      } catch {
        return null;
      }
    }).find((x: any) => x && x.name === "RedemptionRequested");

    expect(evt).to.not.equal(undefined);
    const requestId = evt!.args.requestId as string;

    const req = await gateway.getRequest(requestId);
    expect(req.requester).to.equal(user.address);
    expect(req.amount).to.equal(amount);
    expect(req.destinationHash).to.equal(destinationHash);
    expect(req.status).to.equal(1); // Requested

    // escrowed token moved to gateway
    expect(await token.balanceOf(await gateway.getAddress())).to.equal(amount);
  });

  it("allows requester to cancel and returns escrowed tokens", async function () {
    const { token, gateway, user } = await deployFixture();

    const amount = ethers.parseUnits("7", 18);
    const destinationHash = b32("dest-cancel");

    const before = await token.balanceOf(user.address);

    await token.connect(user).approve(await gateway.getAddress(), amount);
    const tx = await gateway.connect(user).requestRedemption(amount, destinationHash);
    const rc = await tx.wait();

    const evt = rc!.logs.map((l: any) => {
      try { return gateway.interface.parseLog(l); } catch { return null; }
    }).find((x: any) => x && x.name === "RedemptionRequested");
    const requestId = evt!.args.requestId as string;

    await expect(gateway.connect(user).cancelRedemption(requestId))
      .to.emit(gateway, "RedemptionCancelled")
      .withArgs(requestId, user.address, amount, anyValue);

    const after = await token.balanceOf(user.address);
    expect(after).to.equal(before);

    const req = await gateway.getRequest(requestId);
    expect(req.status).to.equal(2); // Cancelled
  });

  it("operator can reject and tokens return to requester", async function () {
    const { token, gateway, user, operator } = await deployFixture();

    const amount = ethers.parseUnits("11", 18);
    const destinationHash = b32("dest-reject");
    const reasonHash = b32("kyc-fail");

    const before = await token.balanceOf(user.address);

    await token.connect(user).approve(await gateway.getAddress(), amount);
    const tx = await gateway.connect(user).requestRedemption(amount, destinationHash);
    const rc = await tx.wait();

    const requestId = getRequestIdFromReceipt(gateway, rc!);

    await expect(gateway.connect(operator).rejectRedemption(requestId, reasonHash))
      .to.emit(gateway, "RedemptionRejected");

    const after = await token.balanceOf(user.address);
    expect(after).to.equal(before);

    const req = await gateway.getRequest(requestId);
    expect(req.status).to.equal(3); // Rejected
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
    const rc = await tx.wait();

    const requestId = getRequestIdFromReceipt(gateway, rc!);

    await expect(gateway.connect(operator).fulfillRedemption(requestId, fulfillmentRef))
      .to.emit(gateway, "RedemptionFulfilled");

    // burned: totalSupply decreases by amount
    const supplyAfter = await token.totalSupply();
    expect(supplyAfter).to.equal(supplyBefore - amount);

    // gateway should not hold the escrow anymore
    expect(await token.balanceOf(await gateway.getAddress())).to.equal(0n);

    const req = await gateway.getRequest(requestId);
    expect(req.status).to.equal(4); // Fulfilled
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
    const rc = await tx.wait();

    const requestId = getRequestIdFromReceipt(gateway, rc!);

    await expect(gateway.connect(other).rejectRedemption(requestId, reasonHash)).to.revert(ethers);
    await expect(gateway.connect(other).fulfillRedemption(requestId, fulfillmentRef)).to.revert(ethers);
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

    await expect(gateway.connect(user).requestRedemption(amount, destinationHash)).to.revert(ethers);

    // unpause, create request, then pause and block cancel/operator actions
    await gateway.connect(pauser).unpause();
    const tx = await gateway.connect(user).requestRedemption(amount, destinationHash);
    const rc = await tx.wait();
    const requestId = getRequestIdFromReceipt(gateway, rc!);

    await gateway.connect(pauser).pause();

    await expect(gateway.connect(user).cancelRedemption(requestId)).to.revert(ethers);
    await expect(gateway.connect(operator).rejectRedemption(requestId, reasonHash)).to.revert(ethers);
    await expect(gateway.connect(operator).fulfillRedemption(requestId, fulfillmentRef)).to.revert(ethers);
  });

  it("cannot cancel if not requester; cannot cancel/reject/fulfill in wrong status", async function () {
    const { token, gateway, user, other, operator } = await deployFixture();

    const amount = ethers.parseUnits("6", 18);
    const destinationHash = b32("dest-status");
    const reasonHash = b32("reason");
    const fulfillmentRef = b32("fulfill");

    await token.connect(user).approve(await gateway.getAddress(), amount);
    const tx = await gateway.connect(user).requestRedemption(amount, destinationHash);
    const rc = await tx.wait();
    const requestId = getRequestIdFromReceipt(gateway, rc!);

    // other cannot cancel
    await expect(gateway.connect(other).cancelRedemption(requestId)).to.revert(ethers);

    // operator rejects
    await gateway.connect(operator).rejectRedemption(requestId, reasonHash);

    // now cannot cancel / fulfill again
    await expect(gateway.connect(user).cancelRedemption(requestId)).to.revert(ethers);
    await expect(gateway.connect(operator).fulfillRedemption(requestId, fulfillmentRef)).to.revert(ethers);
  });
});

function getRequestIdFromReceipt(gateway: any, rc: any): string {
  const evt = rc.logs
    .map((l: any) => {
      try { return gateway.interface.parseLog(l); } catch { return null; }
    })
    .find((x: any) => x && x.name === "RedemptionRequested");
  if (!evt) throw new Error("RedemptionRequested event not found");
  return evt.args.requestId as string;
}

async function getLatestTimestamp(): Promise<number> {
  const b = await ethers.provider.getBlock("latest");
  return Number(b?.timestamp ?? 0);
}
