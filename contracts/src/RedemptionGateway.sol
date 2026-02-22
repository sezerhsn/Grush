// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/**
 * @title RedemptionGateway
 * @notice Minimal on-chain audit log for redemption requests.
 *
 * Design (v0.1):
 * - User escrows GRUSH into this contract (transferFrom).
 * - User can cancel while status == Requested (tokens returned).
 * - Operator can fulfill: escrowed tokens are burned (requires GRUSHToken BURNER_ROLE granted to this gateway).
 * - Operator can reject: escrowed tokens returned to user.
 *
 * PII is never stored on-chain. Off-chain destination/KYC info is referenced via a bytes32 hash (destinationHash).
 */
contract RedemptionGateway is AccessControl, Pausable, ReentrancyGuard {
    // -----------------------------
    // Roles
    // -----------------------------
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // -----------------------------
    // Errors
    // -----------------------------
    error ZeroAddress();
    error ZeroAmount();
    error NotFound(bytes32 requestId);
    error InvalidStatus(bytes32 requestId, uint8 have, uint8 want);
    error NotRequester(bytes32 requestId);
    error InvalidBytes32();
    error TransferFailed();
    error PermitNotSupported();

    // -----------------------------
    // Types
    // -----------------------------
    enum Status {
        None,
        Requested,
        Cancelled,
        Rejected,
        Fulfilled
    }

    struct RedemptionRequest {
        address requester;
        uint256 amount;          // token units (18 decimals)
        uint64 createdAt;        // block timestamp
        Status status;
        bytes32 destinationHash; // hash(pointer to off-chain destination/KYC)
        bytes32 decisionRef;     // reject reason hash OR fulfillment reference hash
        uint64 decidedAt;        // timestamp of reject/fulfill
        address decidedBy;       // operator address
    }

    // -----------------------------
    // Storage
    // -----------------------------
    IERC20 public immutable grush;
    // Optional interface for permit (same address, but call may revert if unsupported)
    IERC20Permit public immutable grushPermit;

    mapping(bytes32 => RedemptionRequest) private _requests;
    mapping(address => uint256) public userNonce;

    uint256 public totalEscrowed; // total GRUSH held for active Requested requests (best-effort accounting)

    // -----------------------------
    // Events
    // -----------------------------
    event RedemptionRequested(
        bytes32 indexed requestId,
        address indexed requester,
        uint256 amount,
        bytes32 indexed destinationHash,
        uint64 createdAt
    );

    event RedemptionCancelled(
        bytes32 indexed requestId,
        address indexed requester,
        uint256 amount,
        uint64 cancelledAt
    );

    event RedemptionRejected(
        bytes32 indexed requestId,
        address indexed requester,
        uint256 amount,
        bytes32 indexed reasonHash,
        address decidedBy,
        uint64 decidedAt
    );

    event RedemptionFulfilled(
        bytes32 indexed requestId,
        address indexed requester,
        uint256 amount,
        bytes32 indexed fulfillmentRef,
        address decidedBy,
        uint64 decidedAt
    );

    // -----------------------------
    // Constructor
    // -----------------------------
    /**
     * @param admin    DEFAULT_ADMIN_ROLE holder (recommended: timelock)
     * @param token    GRUSH token address
     * @param operator Ops/multisig that will call fulfill/reject
     * @param pauser   Entity allowed to pause (recommended: multisig)
     */
    constructor(address admin, address token, address operator, address pauser) {
        if (admin == address(0) || token == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        address op = operator == address(0) ? admin : operator;
        address ps = pauser == address(0) ? admin : pauser;

        _grantRole(OPERATOR_ROLE, op);
        _grantRole(PAUSER_ROLE, ps);

        grush = IERC20(token);
        grushPermit = IERC20Permit(token);
    }

    // -----------------------------
    // Pause
    // -----------------------------
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // -----------------------------
    // Core: Request
    // -----------------------------
    /**
     * @notice Create a redemption request by escrowing tokens into the gateway.
     * @dev User must approve this gateway beforehand (ERC20 approve).
     * @param amount token units (18 decimals)
     * @param destinationHash keccak256(pointer/commitment to off-chain delivery+KYC data)
     */
    function requestRedemption(uint256 amount, bytes32 destinationHash)
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 requestId)
    {
        if (amount == 0) revert ZeroAmount();
        if (destinationHash == bytes32(0)) revert InvalidBytes32();

        requestId = _computeRequestId(msg.sender, amount, destinationHash);

        // escrow tokens
        bool ok = grush.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        // store
        _requests[requestId] = RedemptionRequest({
            requester: msg.sender,
            amount: amount,
            createdAt: uint64(block.timestamp),
            status: Status.Requested,
            destinationHash: destinationHash,
            decisionRef: bytes32(0),
            decidedAt: 0,
            decidedBy: address(0)
        });

        totalEscrowed += amount;

        emit RedemptionRequested(requestId, msg.sender, amount, destinationHash, uint64(block.timestamp));
    }

    /**
     * @notice Create a request using ERC-2612 permit to set allowance in the same tx.
     * @dev If token does not support permit, this call will revert.
     */
    function requestRedemptionWithPermit(
        uint256 amount,
        bytes32 destinationHash,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused nonReentrant returns (bytes32 requestId) {
        if (amount == 0) revert ZeroAmount();
        if (destinationHash == bytes32(0)) revert InvalidBytes32();

        // best-effort: some tokens may not implement permit correctly
        try grushPermit.permit(msg.sender, address(this), amount, deadline, v, r, s) {
            // ok
        } catch {
            revert PermitNotSupported();
        }

        requestId = _computeRequestId(msg.sender, amount, destinationHash);

        bool ok = grush.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        _requests[requestId] = RedemptionRequest({
            requester: msg.sender,
            amount: amount,
            createdAt: uint64(block.timestamp),
            status: Status.Requested,
            destinationHash: destinationHash,
            decisionRef: bytes32(0),
            decidedAt: 0,
            decidedBy: address(0)
        });

        totalEscrowed += amount;

        emit RedemptionRequested(requestId, msg.sender, amount, destinationHash, uint64(block.timestamp));
    }

    /**
     * @notice Cancel an active request and return escrowed tokens to requester.
     */
    function cancelRedemption(bytes32 requestId) external whenNotPaused nonReentrant {
        RedemptionRequest storage req = _requests[requestId];
        if (req.status == Status.None) revert NotFound(requestId);
        if (req.requester != msg.sender) revert NotRequester(requestId);
        if (req.status != Status.Requested) revert InvalidStatus(requestId, uint8(req.status), uint8(Status.Requested));

        req.status = Status.Cancelled;
        req.decidedAt = uint64(block.timestamp);
        req.decidedBy = msg.sender;

        totalEscrowed -= req.amount;

        bool ok = grush.transfer(req.requester, req.amount);
        if (!ok) revert TransferFailed();

        emit RedemptionCancelled(requestId, req.requester, req.amount, uint64(block.timestamp));
    }

    // -----------------------------
    // Operator actions
    // -----------------------------
    /**
     * @notice Reject a request and return escrowed tokens to requester.
     * @param reasonHash keccak256(reason string / internal case id / policy code)
     */
    function rejectRedemption(bytes32 requestId, bytes32 reasonHash)
        external
        whenNotPaused
        nonReentrant
        onlyRole(OPERATOR_ROLE)
    {
        if (reasonHash == bytes32(0)) revert InvalidBytes32();

        RedemptionRequest storage req = _requests[requestId];
        if (req.status == Status.None) revert NotFound(requestId);
        if (req.status != Status.Requested) revert InvalidStatus(requestId, uint8(req.status), uint8(Status.Requested));

        req.status = Status.Rejected;
        req.decisionRef = reasonHash;
        req.decidedAt = uint64(block.timestamp);
        req.decidedBy = msg.sender;

        totalEscrowed -= req.amount;

        bool ok = grush.transfer(req.requester, req.amount);
        if (!ok) revert TransferFailed();

        emit RedemptionRejected(requestId, req.requester, req.amount, reasonHash, msg.sender, uint64(block.timestamp));
    }

    /**
     * @notice Fulfill a request: burn escrowed tokens and emit fulfillment reference.
     * @dev Requires this gateway to have BURNER_ROLE on GRUSHToken.
     * @param fulfillmentRef keccak256(shipping receipt / internal fulfillment id / vault ticket id)
     */
    function fulfillRedemption(bytes32 requestId, bytes32 fulfillmentRef)
        external
        whenNotPaused
        nonReentrant
        onlyRole(OPERATOR_ROLE)
    {
        if (fulfillmentRef == bytes32(0)) revert InvalidBytes32();

        RedemptionRequest storage req = _requests[requestId];
        if (req.status == Status.None) revert NotFound(requestId);
        if (req.status != Status.Requested) revert InvalidStatus(requestId, uint8(req.status), uint8(Status.Requested));

        // Update state first (checks-effects-interactions)
        req.status = Status.Fulfilled;
        req.decisionRef = fulfillmentRef;
        req.decidedAt = uint64(block.timestamp);
        req.decidedBy = msg.sender;

        totalEscrowed -= req.amount;

        // Burn escrowed tokens held by this contract.
        // We call GRUSHToken.burn(amount) via low-level interface:
        // - burn() is restricted by BURNER_ROLE
        // - burn() burns from msg.sender (= this contract)
        (bool ok, bytes memory data) = address(grush).call(
            abi.encodeWithSignature("burn(uint256)", req.amount)
        );
        if (!ok) {
            // bubble revert reason if present
            if (data.length > 0) {
                assembly {
                    revert(add(data, 0x20), mload(data))
                }
            }
            revert TransferFailed();
        }

        emit RedemptionFulfilled(requestId, req.requester, req.amount, fulfillmentRef, msg.sender, uint64(block.timestamp));
    }

    // -----------------------------
    // Views
    // -----------------------------
    function getRequest(bytes32 requestId) external view returns (RedemptionRequest memory) {
        RedemptionRequest memory req = _requests[requestId];
        if (req.status == Status.None) revert NotFound(requestId);
        return req;
    }

    function statusOf(bytes32 requestId) external view returns (Status) {
        return _requests[requestId].status;
    }

    function escrowBalance() external view returns (uint256) {
        return grush.balanceOf(address(this));
    }

    // -----------------------------
    // Internals
    // -----------------------------
    function _computeRequestId(address requester, uint256 amount, bytes32 destinationHash)
        internal
        returns (bytes32 requestId)
    {
        uint256 nonce = userNonce[requester];
        userNonce[requester] = nonce + 1;

        // requestId binds this contract + chain + requester + nonce + amount + destinationHash
        requestId = keccak256(
            abi.encodePacked(address(this), block.chainid, requester, nonce, amount, destinationHash)
        );
    }
}
