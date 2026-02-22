// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title GRUSHToken
 * @notice ERC-20 token representing 1 GRUSH = 1 gram fine gold (999.9 Au), backed by allocated physical reserves.
 *
 * Core controls:
 * - MINTER_ROLE can mint
 * - BURNER_ROLE can burn (either own balance via burn(), or burnFrom() with allowance)
 * - PAUSER_ROLE can pause transfers/mint/burn via _update hook
 *
 * Notes:
 * - No hard cap on-chain (cap is enforced operationally via PoR + ReserveRegistry).
 * - ERC20 Permit enabled for gasless approvals (useful for redemption flows).
 */
contract GRUSHToken is ERC20, ERC20Permit, AccessControl, Pausable {
    // -----------------------------
    // Roles
    // -----------------------------
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // -----------------------------
    // Errors
    // -----------------------------
    error ZeroAddress();
    error ZeroAmount();

    // -----------------------------
    // Events (optional, Transfer already covers mint/burn)
    // -----------------------------
    event Minted(address indexed to, uint256 amount);
    event Burned(address indexed from, uint256 amount);
    event BurnedFrom(address indexed from, address indexed by, uint256 amount);

    /**
     * @param admin   DEFAULT_ADMIN_ROLE holder (recommended: timelock)
     * @param minter  MINTER_ROLE holder (recommended: multisig / issuance ops)
     * @param burner  BURNER_ROLE holder (recommended: multisig and/or RedemptionGateway)
     * @param pauser  PAUSER_ROLE holder (recommended: multisig)
     */
    constructor(
        address admin,
        address minter,
        address burner,
        address pauser
    ) ERC20("Goldenrush", "GRUSH") ERC20Permit("Goldenrush") {
        if (admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        // default to admin if zero
        address m = minter == address(0) ? admin : minter;
        address b = burner == address(0) ? admin : burner;
        address p = pauser == address(0) ? admin : pauser;

        _grantRole(MINTER_ROLE, m);
        _grantRole(BURNER_ROLE, b);
        _grantRole(PAUSER_ROLE, p);
    }

    // -----------------------------
    // Pause controls
    // -----------------------------
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // -----------------------------
    // Mint / Burn
    // -----------------------------
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _mint(to, amount);
        emit Minted(to, amount);
    }

    /**
     * @notice Burns tokens from msg.sender balance.
     * @dev Designed for contracts/wallets that hold GRUSH and have BURNER_ROLE (e.g., RedemptionGateway).
     */
    function burn(uint256 amount) external onlyRole(BURNER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        _burn(_msgSender(), amount);
        emit Burned(_msgSender(), amount);
    }

    /**
     * @notice Burns tokens from `from`, consuming allowance granted to msg.sender.
     * @dev Useful for redemption flows (user can permit/approve, then burner burns).
     */
    function burnFrom(address from, uint256 amount) external onlyRole(BURNER_ROLE) {
        if (from == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _spendAllowance(from, _msgSender(), amount);
        _burn(from, amount);
        emit BurnedFrom(from, _msgSender(), amount);
    }

    // -----------------------------
    // ERC20 hook: enforce pause
    // -----------------------------
    /**
     * @dev OZ v5 uses _update for transfer/mint/burn.
     * When paused: blocks transfers, mint and burn.
     */
    function _update(address from, address to, uint256 value) internal override whenNotPaused {
        super._update(from, to, value);
    }

    // -----------------------------
    // AccessControl: supportsInterface
    // -----------------------------
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
