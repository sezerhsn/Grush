// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReserveRegistry {
    struct AttestationRecord {
        uint64 asOfTimestamp;
        uint64 publishedAt;
        uint256 attestedFineGoldGrams;
        bytes32 merkleRoot;
        bytes32 barListHash;
        address signer;
    }

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

    function isAllowedSigner(address signer) external view returns (bool);

    function publishAttestation(
        bytes32 reportId,
        uint64 asOfTimestamp,
        uint256 attestedFineGoldGrams,
        bytes32 merkleRoot,
        bytes32 barListHash,
        bytes calldata signature
    ) external returns (address recoveredSigner);

    function exists(bytes32 reportId) external view returns (bool);

    function getAttestation(bytes32 reportId) external view returns (AttestationRecord memory);

    function latestReportId() external view returns (bytes32);

    function latestAsOfTimestamp() external view returns (uint64);

    function latestAttestation() external view returns (bytes32 reportId, AttestationRecord memory rec);

    function reportIdsCount() external view returns (uint256);

    function getReportIds(uint256 start, uint256 count) external view returns (bytes32[] memory out);
}
