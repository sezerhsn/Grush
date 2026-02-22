// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title ReserveRegistry
 * @notice On-chain attestation registry for GRUSH Proof-of-Reserves.
 *
 * Attestation typed data (EIP-712):
 *  ReserveAttestation(
 *    bytes32 reportId,
 *    uint64  asOfTimestamp,
 *    uint256 attestedFineGoldGrams,
 *    bytes32 merkleRoot,
 *    bytes32 barListHash
 *  )
 *
 * Domain:
 *  name    = "GRUSH Reserve Attestation"
 *  version = "1"
 *  chainId = current chain id
 *  verifyingContract = this
 */
contract ReserveRegistry is AccessControl, Pausable, EIP712 {
    // -----------------------------
    // Roles
    // -----------------------------
    bytes32 public constant PUBLISHER_ROLE = keccak256("PUBLISHER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant SIGNER_ADMIN_ROLE = keccak256("SIGNER_ADMIN_ROLE");

    // -----------------------------
    // Errors (cheaper than strings)
    // -----------------------------
    error ZeroAddress();
    error DuplicateReport(bytes32 reportId);
    error SignerNotAllowed(address signer);
    error InvalidSignature();
    error InvalidBytes32();
    error NotFound(bytes32 reportId);

    // -----------------------------
    // EIP-712
    // -----------------------------
    bytes32 public constant RESERVE_ATTESTATION_TYPEHASH =
        keccak256(
            "ReserveAttestation(bytes32 reportId,uint64 asOfTimestamp,uint256 attestedFineGoldGrams,bytes32 merkleRoot,bytes32 barListHash)"
        );

    // -----------------------------
    // Data model
    // -----------------------------
    struct AttestationRecord {
        uint64 asOfTimestamp; // snapshot timestamp (unix seconds)
        uint64 publishedAt; // publish time (unix seconds)
        uint256 attestedFineGoldGrams; // total fine gold grams
        bytes32 merkleRoot; // merkle root of bar list leaves
        bytes32 barListHash; // keccak256(bar_list_file_bytes)
        address signer; // recovered signer
    }

    // reportId => record
    mapping(bytes32 => AttestationRecord) private _attestations;
    mapping(bytes32 => bool) private _exists;
    bytes32[] private _reportIds;

    // signer allowlist
    mapping(address => bool) public isAllowedSigner;

    // latest by asOfTimestamp
    bytes32 public latestReportId;
    uint64 public latestAsOfTimestamp;

    // -----------------------------
    // Events
    // -----------------------------
    event AttestationPublished(
        bytes32 indexed reportId,
        uint64 indexed asOfTimestamp,
        uint256 attestedFineGoldGrams,
        bytes32 merkleRoot,
        bytes32 barListHash,
        address indexed signer,
        uint64 publishedAt
    );

    event AllowedSignerUpdated(address indexed signer, bool allowed);

    // -----------------------------
    // Constructor
    // -----------------------------
    constructor(address admin, address publisher, address pauser) EIP712("GRUSH Reserve Attestation", "1") {
        if (admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SIGNER_ADMIN_ROLE, admin);

        // If not provided, default these roles to admin.
        address pub = publisher == address(0) ? admin : publisher;
        address pau = pauser == address(0) ? admin : pauser;

        _grantRole(PUBLISHER_ROLE, pub);
        _grantRole(PAUSER_ROLE, pau);
    }

    // -----------------------------
    // Admin / Ops controls
    // -----------------------------
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function setAllowedSigner(address signer, bool allowed) external onlyRole(SIGNER_ADMIN_ROLE) {
        if (signer == address(0)) revert ZeroAddress();
        isAllowedSigner[signer] = allowed;
        emit AllowedSignerUpdated(signer, allowed);
    }

    function setAllowedSigners(address[] calldata signers, bool[] calldata allowed) external onlyRole(SIGNER_ADMIN_ROLE) {
        if (signers.length != allowed.length) revert InvalidSignature(); // reuse
        for (uint256 i = 0; i < signers.length; i++) {
            address s = signers[i];
            if (s == address(0)) revert ZeroAddress();
            isAllowedSigner[s] = allowed[i];
            emit AllowedSignerUpdated(s, allowed[i]);
        }
    }

    // -----------------------------
    // Publishing (core)
    // -----------------------------
    /**
     * @notice Publish a signed reserve attestation.
     * @dev Only PUBLISHER_ROLE can submit to avoid spam/state bloat.
     */
    function publishAttestation(
        bytes32 reportId,
        uint64 asOfTimestamp,
        uint256 attestedFineGoldGrams,
        bytes32 merkleRoot,
        bytes32 barListHash,
        bytes calldata signature
    ) external whenNotPaused onlyRole(PUBLISHER_ROLE) returns (address recoveredSigner) {
        if (_exists[reportId]) revert DuplicateReport(reportId);
        if (signature.length != 65) revert InvalidSignature();

        // Defensive: avoid accidental zeros. (Not strictly required, but prevents garbage records.)
        if (reportId == bytes32(0) || merkleRoot == bytes32(0) || barListHash == bytes32(0)) revert InvalidBytes32();

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(RESERVE_ATTESTATION_TYPEHASH, reportId, asOfTimestamp, attestedFineGoldGrams, merkleRoot, barListHash))
        );

        recoveredSigner = ECDSA.recover(digest, signature);
        if (!isAllowedSigner[recoveredSigner]) revert SignerNotAllowed(recoveredSigner);

        uint64 publishedAt = uint64(block.timestamp);

        _exists[reportId] = true;
        _reportIds.push(reportId);

        _attestations[reportId] = AttestationRecord({
            asOfTimestamp: asOfTimestamp,
            publishedAt: publishedAt,
            attestedFineGoldGrams: attestedFineGoldGrams,
            merkleRoot: merkleRoot,
            barListHash: barListHash,
            signer: recoveredSigner
        });

        // latest by asOfTimestamp
        if (asOfTimestamp > latestAsOfTimestamp) {
            latestAsOfTimestamp = asOfTimestamp;
            latestReportId = reportId;
        }

        emit AttestationPublished(reportId, asOfTimestamp, attestedFineGoldGrams, merkleRoot, barListHash, recoveredSigner, publishedAt);
    }

    // -----------------------------
    // Views
    // -----------------------------
    function exists(bytes32 reportId) external view returns (bool) {
        return _exists[reportId];
    }

    function getAttestation(bytes32 reportId) external view returns (AttestationRecord memory) {
        if (!_exists[reportId]) revert NotFound(reportId);
        return _attestations[reportId];
    }

    function latestAttestation() external view returns (bytes32 reportId, AttestationRecord memory rec) {
        reportId = latestReportId;
        if (reportId == bytes32(0)) {
            // empty
            rec = AttestationRecord({
                asOfTimestamp: 0,
                publishedAt: 0,
                attestedFineGoldGrams: 0,
                merkleRoot: bytes32(0),
                barListHash: bytes32(0),
                signer: address(0)
            });
        } else {
            rec = _attestations[reportId];
        }
    }

    function reportIdsCount() external view returns (uint256) {
        return _reportIds.length;
    }

    /**
     * @notice Paginated report id listing.
     * @param start inclusive index
     * @param count max items
     */
    function getReportIds(uint256 start, uint256 count) external view returns (bytes32[] memory out) {
        uint256 n = _reportIds.length;
        if (start >= n) return new bytes32[](0);
        uint256 end = start + count;
        if (end > n) end = n;

        out = new bytes32[](end - start);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = _reportIds[start + i];
        }
    }
}
