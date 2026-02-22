import { expect } from "chai";
import hre from "hardhat";

const { ethers } = await hre.network.connect();

async function getChainId(): Promise<number> {
  const net = await ethers.provider.getNetwork();
  return Number(net.chainId);
}

function sigToVRS(sig: string): { v: number; r: string; s: string } {
  // ethers v6
  const Sig = (ethers as any).Signature;
  if (Sig?.from) {
    const s = Sig.from(sig);
    return { v: s.v, r: s.r, s: s.s };
  }
  // ethers v5 fallback
  const split = (ethers as any).utils?.splitSignature;
  if (split) return split(sig);
  throw new Error("Signature parsing not supported (ethers v5/v6 uyumsuz?).");
}

async function buildPermitSignature(params: {
  token: any;
  owner: any;
  spender: string;
  value: bigint;
  deadline: bigint;
}) {
  const { token, owner, spender, value, deadline } = params;

  const name: string = await token.name();
  const version = "1";
  const chainId = await getChainId();
  const verifyingContract = await token.getAddress();

  const nonce = await token.nonces(owner.address);

  const domain = {
    name,
    version,
    chainId,
    verifyingContract,
  };

  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const message = {
    owner: owner.address,
    spender,
    value,
    nonce,
    deadline,
  };

  // ethers v6 Signer: signTypedData; v5: _signTypedData
  let sig: string;
  if (typeof owner.signTypedData === "function") {
    sig = await owner.signTypedData(domain, types, message);
  } else if (typeof owner._signTypedData === "function") {
    sig = await owner._signTypedData(domain, types, message);
  } else {
    throw new Error("Signer typed-data signing fonksiyonu yok (ethers v5/v6 uyumsuz?).");
  }

  return { sig, ...sigToVRS(sig) };
}

describe("GRUSHToken", function () {
  async function deployFixture() {
    const [admin, minter, burner, pauser, user, other] = await ethers.getSigners();

    const GRUSHToken = await ethers.getContractFactory("GRUSHToken");
    const token = await GRUSHToken.deploy(
      admin.address,
      minter.address,
      burner.address,
      pauser.address
    );
    await token.waitForDeployment();

    return { token, admin, minter, burner, pauser, user, other };
  }

  it("sets roles correctly on deploy", async function () {
    const { token, admin, minter, burner, pauser } = await deployFixture();

    const DEFAULT_ADMIN_ROLE =
      "0x0000000000000000000000000000000000000000000000000000000000000000";

    const MINTER_ROLE = await token.MINTER_ROLE();
    const BURNER_ROLE = await token.BURNER_ROLE();
    const PAUSER_ROLE = await token.PAUSER_ROLE();

    expect(await token.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
    expect(await token.hasRole(MINTER_ROLE, minter.address)).to.equal(true);
    expect(await token.hasRole(BURNER_ROLE, burner.address)).to.equal(true);
    expect(await token.hasRole(PAUSER_ROLE, pauser.address)).to.equal(true);
  });

  it("minter can mint; non-minter cannot", async function () {
    const { token, minter, user, other } = await deployFixture();

    const amount = ethers.parseUnits("100", 18);
    await expect(token.connect(minter).mint(user.address, amount))
      .to.emit(token, "Minted")
      .withArgs(user.address, amount);

    expect(await token.balanceOf(user.address)).to.equal(amount);

    await expect(token.connect(other).mint(user.address, 1n)).to.revert(ethers);
  });

  it("burner can burn own balance; non-burner cannot burn()", async function () {
    const { token, minter, burner, user } = await deployFixture();

    const mintAmount = ethers.parseUnits("50", 18);
    await token.connect(minter).mint(burner.address, mintAmount);

    const burnAmount = ethers.parseUnits("10", 18);
    await expect(token.connect(burner).burn(burnAmount))
      .to.emit(token, "Burned")
      .withArgs(burner.address, burnAmount);

    expect(await token.balanceOf(burner.address)).to.equal(mintAmount - burnAmount);

    // user is not burner
    await token.connect(minter).mint(user.address, mintAmount);
    await expect(token.connect(user).burn(1n)).to.revert(ethers);
  });

  it("burner can burnFrom with allowance; allowance decreases", async function () {
    const { token, minter, burner, user } = await deployFixture();

    const mintAmount = ethers.parseUnits("25", 18);
    await token.connect(minter).mint(user.address, mintAmount);

    const allowance = ethers.parseUnits("7", 18);
    await token.connect(user).approve(burner.address, allowance);

    const burnAmount = ethers.parseUnits("5", 18);
    await expect(token.connect(burner).burnFrom(user.address, burnAmount))
      .to.emit(token, "BurnedFrom")
      .withArgs(user.address, burner.address, burnAmount);

    expect(await token.balanceOf(user.address)).to.equal(mintAmount - burnAmount);
    expect(await token.allowance(user.address, burner.address)).to.equal(allowance - burnAmount);
  });

  it("permit sets allowance (gasless) and burner can burnFrom", async function () {
    const { token, minter, burner, user } = await deployFixture();

    const mintAmount = ethers.parseUnits("30", 18);
    await token.connect(minter).mint(user.address, mintAmount);

    const latestBlock = await ethers.provider.getBlock("latest");
    const deadline = BigInt((latestBlock?.timestamp ?? 0) + 3600);

    const value = ethers.parseUnits("9", 18);
    const { v, r, s } = await buildPermitSignature({
      token,
      owner: user,
      spender: burner.address,
      value,
      deadline,
    });

    // permit(owner, spender, value, deadline, v, r, s)
    await token
      .connect(burner) // anyone can submit permit; spender is fine
      .permit(user.address, burner.address, value, deadline, v, r, s);

    expect(await token.allowance(user.address, burner.address)).to.equal(value);

    const burnAmount = ethers.parseUnits("9", 18);
    await token.connect(burner).burnFrom(user.address, burnAmount);

    expect(await token.balanceOf(user.address)).to.equal(mintAmount - burnAmount);
    expect(await token.allowance(user.address, burner.address)).to.equal(0n);
  });

  it("pause blocks transfers, mint, burn; unpause restores", async function () {
    const { token, minter, burner, pauser, user, other } = await deployFixture();

    const amt = ethers.parseUnits("10", 18);
    await token.connect(minter).mint(user.address, amt);
    await token.connect(minter).mint(burner.address, amt);

    // pause
    await token.connect(pauser).pause();
    expect(await token.paused()).to.equal(true);

    // transfers blocked
    await expect(token.connect(user).transfer(other.address, 1n)).to.revert(ethers);

    // mint blocked (reverts due to _update whenNotPaused)
    await expect(token.connect(minter).mint(user.address, 1n)).to.revert(ethers);

    // burn blocked (reverts due to _update whenNotPaused)
    await expect(token.connect(burner).burn(1n)).to.revert(ethers);

    // unpause
    await token.connect(pauser).unpause();
    expect(await token.paused()).to.equal(false);

    // now transfer works
    await token.connect(user).transfer(other.address, 1n);
    expect(await token.balanceOf(other.address)).to.equal(1n);
  });

  it("burnFrom fails without allowance", async function () {
    const { token, minter, burner, user } = await deployFixture();

    const amt = ethers.parseUnits("3", 18);
    await token.connect(minter).mint(user.address, amt);

    await expect(token.connect(burner).burnFrom(user.address, 1n)).to.revert(ethers);
  });
});
